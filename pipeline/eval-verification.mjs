/**
 * eval-verification.mjs — THE DATA-VERIFIER. Aligns the engine-built ledger to the
 * golden fixture in two passes: (a) the fast PR#9 lexical fuzzy matcher, then (b) an
 * LLM-judged semantic match for the goldens lexical missed → the AUTHORITATIVE recall.
 * The LLM judges MATCHING only, never the verdict. Mock-aware ($0 → judge = lexical),
 * cached. Reports recall, status-agreement, status confusion, credibility delta, and
 * the expected newly_resolved[] (golden-NYT closed by a later doc) + extra[] (engine
 * over-extraction with no golden counterpart).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { evalExtraction } from "./eval-extraction.mjs";
import { subjectTokens, normPeriod } from "./lib/dedup.mjs";
import { directionFor } from "./lib/metric-direction.mjs";
import { completeJSON, providerConfig } from "./lib/llm.mjs";
import { EXTRACTION_PROVIDERS } from "./lib/multi-llm.mjs";

const CAT_GROUPS = [["ebitda", "margin", "pat"], ["capacity", "volume"], ["leverage", "working_capital"], ["revenue", "orderbook"]];
const catCompat = (a, b) => a === b || a === "other" || b === "other" || CAT_GROUPS.some((g) => g.includes(a) && g.includes(b));
function jaccard(a, b) { if (!a.size && !b.size) return 0; let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i); }
function containment(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const t of a) if (b.has(t)) i++; return i / Math.min(a.size, b.size); }

/** Best engine promise (with its index) for each golden promise, lexically; map[gid]={e,i}|null. */
function lexicalAlign(golden, engine) {
  const ex = engine.map((p, i) => ({ p, i, sub: subjectTokens(p.metric) }));
  const used = new Set();
  const map = {};
  for (const g of golden) {
    const gsub = subjectTokens(g.metric);
    let best = null, bestScore = 0;
    for (const e of ex) {
      if (used.has(e.i)) continue;
      if (!catCompat(g.category, e.p.category)) continue;
      const s = Math.max(jaccard(gsub, e.sub), containment(gsub, e.sub));
      if (s >= 0.25 && s > bestScore) { bestScore = s; best = e; }
    }
    if (best) { used.add(best.i); map[g.id] = { e: best.p, i: best.i }; }
    else map[g.id] = null;
  }
  return map;
}

const JUDGE_SCHEMA = { type: "object", additionalProperties: false, required: ["matched"], properties: { matched: { type: "boolean" }, engine_index: { type: ["integer", "null"] } } };
const JUDGE_SYS = `You decide whether any candidate ENGINE promise states the SAME measurable commitment as a GOLDEN promise (same metric/subject and intent — wording, units, and period phrasing may differ). You judge MATCHING only; never any pass/fail verdict. Return {matched, engine_index} where engine_index is the 0-based candidate index, or matched:false / engine_index:null if none match.`;

async function llmJudgeUnmatched(golden, engine, map, { chain, cacheDir, debug }) {
  let recovered = 0;
  const usedIdx = new Set(Object.values(map).filter(Boolean).map((m) => m.i));
  for (const g of golden) {
    if (map[g.id]) continue; // already matched lexically
    // candidate engine promises in a compatible category, not yet used
    const cands = engine.map((p, i) => ({ p, i })).filter(({ p, i }) => !usedIdx.has(i) && catCompat(g.category, p.category));
    if (!cands.length) continue;
    const key = createHash("sha256").update(`judge|${g.id}|${cands.map((c) => c.i).join(",")}|${g.metric}`).digest("hex");
    const cp = cacheDir ? join(cacheDir, `judge-${String(g.id).replace(/[^\w-]/g, "_")}.json`) : null;
    let data = null;
    if (cp && existsSync(cp)) { try { const c = JSON.parse(readFileSync(cp, "utf8")); if (c.key === key) data = c.data; } catch { /* re-ask */ } }
    if (!data) {
      const list = cands.map((c, k) => `[${k}] (${c.p.category}) ${c.p.metric}`).join("\n");
      try {
        const r = await completeJSON(
          [{ role: "system", content: JUDGE_SYS }, { role: "user", content: `GOLDEN (${g.category}): ${g.metric}\n\nCANDIDATES:\n${list}\n\nWhich candidate states the same commitment?` }],
          JUDGE_SCHEMA, { chain, temperature: 0, maxTokens: 120, maxRetries: 4, schemaName: "judge", env: process.env },
        );
        data = r.data;
        if (cp) { mkdirSync(dirname(cp), { recursive: true }); writeFileSync(cp, JSON.stringify({ key, data }, null, 2)); }
      } catch (err) { if (debug) console.error(`  ! judge ${g.id}: ${err.message}`); continue; }
    }
    if (data?.matched && data.engine_index != null && cands[data.engine_index]) {
      const chosen = cands[data.engine_index];
      map[g.id] = { e: chosen.p, i: chosen.i, judged: true };
      usedIdx.add(chosen.i);
      recovered += 1;
    }
  }
  return recovered;
}

export async function evalVerification(engine, golden, { mock = false, cacheDir = null, debug = false, providers = null } = {}) {
  const eProms = engine.promises || [];
  const gProms = golden.promises || [];
  const lex = evalExtraction(eProms, golden); // {known, found, recall, missed, extra}
  const map = lexicalAlign(gProms, eProms);

  const chain = providers || EXTRACTION_PROVIDERS.map((p) => providerConfig(p, process.env)).filter((c) => c.apiKey);
  let recovered = 0;
  if (!mock && chain.length) recovered = await llmJudgeUnmatched(gProms, eProms, map, { chain, cacheDir, debug });
  const matchedCount = Object.values(map).filter(Boolean).length;
  const judged = !mock && chain.length
    ? { found: matchedCount, known: gProms.length, recall: gProms.length ? Number((matchedCount / gProms.length).toFixed(3)) : 0, recovered }
    : { found: lex.found, known: lex.known, recall: lex.recall, note: "mock/no-keys: judge = lexical" };

  // status agreement over matched goldens (golden-NYT-resolved is reported separately, not a disagreement)
  let agree = 0, total = 0;
  const confusion = {};
  const newly_resolved = [];
  for (const g of gProms) {
    const m = map[g.id];
    if (!m) continue;
    if (g.status === "NYT" && m.e.status !== "NYT") {
      newly_resolved.push({ id: g.id, metric: g.metric, golden: "NYT", engine: m.e.status });
      continue; // expected resolution, excluded from the agreement denominator
    }
    total += 1;
    confusion[`${g.status}->${m.e.status}`] = (confusion[`${g.status}->${m.e.status}`] || 0) + 1;
    if (g.status === m.e.status) agree += 1;
  }
  const usedIdx = new Set(Object.values(map).filter(Boolean).map((m) => m.i));
  const extra = eProms.map((p, i) => ({ p, i })).filter(({ i }) => !usedIdx.has(i)).map(({ p }) => ({ category: p.category, metric: p.metric, status: p.status }));

  const eScore = engine.credibility?.score ?? null;
  const gScore = golden.credibility?.score ?? null;
  return {
    lexical: { known: lex.known, found: lex.found, recall: lex.recall },
    judged,
    status_agreement: total ? Number((agree / total).toFixed(3)) : 0,
    matched_in_window: total,
    confusion,
    credibility_delta: eScore != null && gScore != null ? eScore - gScore : null,
    newly_resolved,
    extra,
  };
}

// CLI: node pipeline/eval-verification.mjs <engine.json> <golden.json>   (or TICKER=<t> for defaults)
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const T = (process.env.TICKER || "").trim().toLowerCase();
  const [enginePath = T ? `public/data/companies/${T}.json` : null, goldenPath = T ? `pipeline/fixtures/${T}.golden.json` : null] = process.argv.slice(2);
  if (!enginePath || !goldenPath) { console.error("usage: node pipeline/eval-verification.mjs <engine.json> <golden.json>   (or set TICKER=<ticker> to use public/data/companies/<ticker>.json + pipeline/fixtures/<ticker>.golden.json)"); process.exit(1); }
  const engine = JSON.parse(readFileSync(enginePath, "utf8"));
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  const r = await evalVerification(engine, golden, { mock: !!process.env.MOCK });
  console.log(JSON.stringify({ lexical: r.lexical, judged: r.judged, status_agreement: r.status_agreement, matched_in_window: r.matched_in_window, credibility_delta: r.credibility_delta, newly_resolved: r.newly_resolved.length, extra: r.extra.length, confusion: r.confusion }, null, 2));
}
