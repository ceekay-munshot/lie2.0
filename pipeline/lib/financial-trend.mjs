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

export const FIN_TREND_VERSION = "p5-2026-07a";
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

const SYSTEM = `You read one quarter's financial-snapshot text — from the investor presentation, or from the earnings-call transcript when there is no deck — and report the headline REPORTED quarterly financials. Return numbers exactly as reported (consolidated, the quarter — not 9M/full-year). Any field not reported in the text → null. ebitda_margin and roce are percentages (number only). net_debt_ebitda is a ratio. unit is the currency unit for the absolute figures (e.g. INR_cr). Retrieval only; never estimate.`;

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
  return { trend, stats };
}
