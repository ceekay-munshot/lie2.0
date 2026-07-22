/**
 * financial-trend.mjs — pull the reported quarterly headline financials from each
 * presentation's "financial snapshot" pages → financial_trend[]. LLM-assisted
 * retrieval (one cached call per quarter), mock-aware ($0 → nulls). Generic: any
 * unreported field is null; no company/sector assumptions.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { completeJSON, providerConfig } from "./llm.mjs";
import { EXTRACTION_PROVIDERS } from "./multi-llm.mjs";

export const FIN_TREND_VERSION = "p5-2026-07b";
const FIN_RE = /revenue|ebitda|\bpat\b|profit|margin|net debt|roce|turnover|free cash/i;
const numRuns = (s) => (String(s).match(/\d[\d,.]*/g) || []).length;

const FIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ebitda: { type: ["number", "null"] },
    ebitda_margin: { type: ["number", "null"], description: "percent, e.g. 35" },
    revenue: { type: ["number", "null"] },
    pat: { type: ["number", "null"] },
    net_debt_ebitda: { type: ["number", "null"], description: "ratio, e.g. 1.3" },
    roce: { type: ["number", "null"], description: "percent" },
    unit: { type: ["string", "null"], description: "currency unit for ebitda/revenue/pat, e.g. INR_cr" },
  },
};

const SYSTEM = `You read one quarter's financial-snapshot text — from the investor presentation, or from the earnings-call transcript when there is no deck — and report the headline REPORTED financials for THAT SINGLE QUARTER.

STRICT rules:
- Report ONLY the single-quarter figure. NEVER an annual, full-year, YTD, 9M/6M/H1 or cumulative number. If a field is available only as a cumulative/annual total (common in call transcripts), return null for it — do not divide or estimate.
- Any field not reported for the quarter → null. Retrieval only; never estimate or infer.
- ebitda_margin and roce are PERCENTAGES as plain numbers (e.g. 21.1, not 0.211 and not 1). If you cannot find a clean quarterly margin percent, return null — do not output a placeholder like 1.
- ebitda, revenue and pat are absolute amounts in ONE consistent currency unit; set "unit" to that unit (e.g. INR_cr, USD_mn). Do not mix units across those fields.
- net_debt_ebitda is a ratio (e.g. 1.3).`;

// Gather each quarter's best "financial snapshot" text. Presentation slides are preferred (terse,
// number-dense), but FALL BACK to the earnings-call transcript when the quarter has no deck carrying
// financials — e.g. IT-services names that state the headline numbers only in the call, whose momentum
// panel was otherwise silently blank. Require a digit (a qualitative "margin focus" line is useless)
// and order sections most-number-dense first so the char-capped text keeps the actual figures.
function quartersWithFinancials(corpus) {
  const byQ = new Map();
  for (const doc of corpus.documents || []) {
    const isPresn = doc.type === "presentation";
    if (!isPresn && doc.type !== "transcript") continue;
    const secs = (doc.sections || [])
      .filter((s) => FIN_RE.test(s.text || "") && /\d/.test(s.text || ""))
      .map((s) => s.text || "")
      .sort((a, b) => numRuns(b) - numRuns(a));
    if (!secs.length) continue;
    const rank = isPresn ? 2 : 1; // a presentation outranks a transcript for the same quarter
    const prev = byQ.get(doc.quarter);
    if (!prev || rank > prev.rank || (rank === prev.rank && String(doc.date) > String(prev.date))) {
      byQ.set(doc.quarter, { quarter: doc.quarter, date: doc.date, doc_id: doc.id, slides: secs, rank });
    }
  }
  return [...byQ.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export async function financialTrend({ corpus, mock = false, providers = null, cacheDir = null, debug = false }) {
  const chain = providers || EXTRACTION_PROVIDERS.map((p) => providerConfig(p, process.env)).filter((c) => c.apiKey);
  // Resolved model chain → cache key, so a model / preset / order change invalidates persisted financials
  // instead of serving old-model figures across runs (mirror of find-actual.mjs). Stable across a
  // quota-truncation→resume cycle: derived from KEY presence, not runtime quota.
  const modelSig = chain.map((c) => `${c.provider}:${c.model}`).join(",");
  const quarters = quartersWithFinancials(corpus);
  const stats = { calls: 0, cache_hits: 0, errors: [] };
  const trend = [];

  for (const q of quarters) {
    const base = { quarter: q.quarter, ebitda: null, ebitda_margin: null, revenue: null, pat: null, net_debt_ebitda: null, roce: null, unit: null };
    if (mock || chain.length === 0) { trend.push(base); continue; }
    const text = q.slides.join("\n").slice(0, 4000);
    // Hash the actual snapshot TEXT, not just its length: a re-acquired filing or a parser change
    // can yield different financials at the same doc_id and identical length, and (with the cache now
    // persisted across CI runs) a length-only key would serve those stale quarterly figures.
    const key = createHash("sha256").update(`${FIN_TREND_VERSION}|${modelSig}|${q.doc_id}|${text}`).digest("hex");
    const cp = cacheDir ? join(cacheDir, `fin-${q.quarter}.json`) : null;
    if (cp && existsSync(cp)) {
      try { const c = JSON.parse(readFileSync(cp, "utf8")); if (c.key === key) { stats.cache_hits += 1; trend.push({ ...base, ...c.value }); continue; } } catch { /* re-fetch */ }
    }
    try {
      const { data } = await completeJSON(
        [{ role: "system", content: SYSTEM }, { role: "user", content: `Quarter: ${q.quarter}\n\nFINANCIAL SNAPSHOT TEXT:\n${text}` }],
        FIN_SCHEMA,
        { chain, temperature: 0, maxTokens: 400, maxRetries: 5, schemaName: "financials", env: process.env },
      );
      stats.calls += 1;
      const value = { quarter: q.quarter, ...data };
      if (cp) { mkdirSync(dirname(cp), { recursive: true }); writeFileSync(cp, JSON.stringify({ key, value: data }, null, 2)); }
      trend.push(value);
    } catch (err) {
      stats.errors.push({ quarter: q.quarter, reason: err.message });
      if (debug) console.error(`  ! financial-trend ${q.quarter}: ${err.message}`);
      trend.push(base);
    }
  }
  return { trend: sanitizeFinancialTrend(trend), stats };
}

const _median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
/**
 * Null a per-quarter figure that is a GROSS OUTLIER vs the other quarters — a full-year / cumulative
 * total the extractor mislabeled as a single quarter (e.g. CESC FY25 revenue 17,375 dropped into a
 * Q4FY25 slot next to ~4,000/qtr, which makes the momentum chart read as a cliff). Deterministic &
 * conservative: a stable business's quarters never differ by ≥ OUTLIER_MULT (2.5×), so this only trips
 * on annual-in-quarterly, never on genuine seasonality. Ratios (margin/roce/leverage) are left alone —
 * they read the same annual or quarterly. Pure; safe to re-run (idempotent).
 */
export function sanitizeFinancialTrend(trend = []) {
  const MULT = Number(process.env.FIN_OUTLIER_MULT) || 2.5;
  const rows = (trend || []).map((q) => ({ ...q }));
  for (const field of ["revenue", "ebitda", "pat"]) {
    const vals = rows.map((r) => { const v = Number(r[field]); return Number.isFinite(v) && v > 0 ? v : null; });
    for (let i = 0; i < rows.length; i++) {
      if (vals[i] == null) continue;
      const others = vals.filter((v, j) => v != null && j !== i);
      const med = _median(others);
      if (med != null && med > 0 && vals[i] > MULT * med) rows[i][field] = null; // drop the mislabeled annual figure
    }
  }
  return rows;
}
