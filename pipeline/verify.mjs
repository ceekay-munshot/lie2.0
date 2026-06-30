#!/usr/bin/env node
/**
 * verify.mjs — Prompt 5 orchestrator. promises.json + corpus.json → the final
 * schema-valid per-company ledger (public/data/companies/<ticker>.json):
 *   1 verification window · 2 retrieve each actual (LLM — the ONLY LLM step) ·
 *   3 deterministic status/variance · 4 financial trend · 5 aggregate + credibility.
 * The model never decides pass/fail. Idempotent; caches make re-runs cheap.
 *
 *   TICKER=vedl node pipeline/verify.mjs                  # live (Mistral-first pool)
 *   PROVIDER=mock TICKER=vedl node pipeline/verify.mjs    # $0 full extract→verify
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { verificationWindow } from "./lib/verification-window.mjs";
import { statusVariance, isFuture, isWithinWindow } from "./lib/status-variance.mjs";
import { directionFor } from "./lib/metric-direction.mjs";
import { findActuals } from "./lib/find-actual.mjs";
import { financialTrend } from "./lib/financial-trend.mjs";
import { aggregate, credibility } from "./lib/aggregate.mjs";
import { outputDir } from "./lib/manifest.mjs";
import { providerConfig } from "./lib/llm.mjs";
import { EXTRACTION_PROVIDERS } from "./lib/multi-llm.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const TICKER = (process.env.TICKER || process.argv.slice(2).find((a) => !a.startsWith("-")) || "").trim();
const MOCK = process.env.PROVIDER === "mock" || (!!process.env.MOCK && process.env.MOCK !== "0");
const PARTIAL_TOL = Number(process.env.PARTIAL_TOL || 0.05);
const TIMELINE_GRACE_QTRS = Number(process.env.TIMELINE_GRACE_QTRS || 1);
// A due promise the company never re-reported is a legitimate NYT, not a pipeline failure,
// so forced_nyt alone must not mark a run "provisional". But if MOST due promises go
// unresolved that's a retrieval pathology (not just sparse disclosure) → still incomplete.
// This caps the share of due promises that may be unresolved before a clean run is flagged.
const FORCED_NYT_MAX_RATIO = Number(process.env.FORCED_NYT_MAX_RATIO ?? 0.5);

/**
 * Decide whether a LIVE run counts as "complete" (a real, shippable verdict).
 * Pure + exported for unit testing. A run is complete when retrieval did its job:
 *   - retrievalErrors === 0   (a quota/network failure means the run is truly truncated), AND
 *   - the share of DUE promises left unresolved (forcedNyt / (testable + forcedNyt)) is within
 *     `maxRatio` — a few due promises the company never re-reported are legitimate NYTs, but if
 *     MOST went unresolved that's a retrieval pathology, not sparse disclosure.
 * @returns {{complete: boolean, ratio: number, due: number}}
 */
export function runCompleteness({ retrievalErrors, forcedNyt, testable, maxRatio = 0.5 }) {
  const due = (Number(testable) || 0) + (Number(forcedNyt) || 0);
  const ratio = due > 0 ? forcedNyt / due : 0;
  return { complete: (Number(retrievalErrors) || 0) === 0 && ratio <= maxRatio, ratio, due };
}
const LIMIT = Number(process.env.LIMIT || Infinity);
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";
const EVAL = process.env.EVAL ? process.env.EVAL !== "0" : true;
const CONCURRENCY = Number(process.env.LLM_CONCURRENCY || 2);

const die = (m) => { console.error(`verify: ${m}`); process.exit(1); };
const resolveIn = (v) => (v ? (v.startsWith("/") ? v : join(REPO, v)) : null);
const loadJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
const str = (v) => (v == null ? "" : String(v));

function ensurePromises(corpusPath) {
  const pPath = resolveIn(process.env.PROMISES) || join(outputDir(TICKER), "promises.json");
  if (existsSync(pPath)) return pPath;
  if (DEBUG) console.log(`verify: promises.json missing → running extract (mock=${MOCK})…`);
  const r = spawnSync("node", [join(__dirname, "extract.mjs")], { stdio: DEBUG ? "inherit" : "pipe", env: { ...process.env, TICKER, CORPUS: corpusPath } });
  if (r.status !== 0) die(`extract failed (exit ${r.status}). ${r.stderr ? str(r.stderr).slice(-300) : ""}`);
  if (!existsSync(pPath)) die(`extract did not produce ${pPath}`);
  return pPath;
}

function companyBlock() {
  let m = {};
  try { m = loadJSON(join(outputDir(TICKER), "manifest.json")); } catch { /* minimal */ }
  const c = m.company || m;
  return {
    ticker: str(c.ticker || TICKER).toUpperCase(),
    name: c.name || TICKER.toUpperCase(),
    sector: c.sector ?? null,
    screener_url: c.screener_url ?? null,
    fiscal_year_end: c.fiscal_year_end || "03",
  };
}

function coverageBlock(corpus) {
  const docs = (corpus.documents || []).filter((d) => d.quarter).sort((a, b) => str(a.date).localeCompare(str(b.date)));
  return { from: docs[0]?.quarter ?? null, to: docs.at(-1)?.quarter ?? null, as_of: docs.at(-1)?.date ?? null };
}

const DOC_TYPES = new Set(["transcript", "presentation", "press_release", "annual_report", "other"]);
function documentsBlock(corpus) {
  return (corpus.documents || []).map((d) => ({
    id: str(d.id),
    type: DOC_TYPES.has(d.type) ? d.type : "other",
    quarter: str(d.quarter),
    date: str(d.date),
    title: d.title ?? d.label ?? null,
    url: d.url ?? null,
    source: ["Screener", "Upload", "BSE", "NSE", "Other"].includes(d.source) ? d.source : "Upload",
    role: ["guidance", "actuals", "both"].includes(d.role) ? d.role : "both",
  }));
}

function shapePromise(p, found, status, variance, was_revised) {
  const isMiss = status === "MISSED" || status === "PARTIAL";
  return {
    id: str(p.id),
    date: str(p.date || p.quarter_context),
    quarter_context: str(p.quarter_context || p.doc_quarter),
    source_id: p.source_id ?? null,
    source_label: p.source_label ?? null,
    category: p.category,
    promise: str(p.promise),
    quote: str(p.quote),
    metric: str(p.metric),
    target: p.target || { text: null, value: null, value_high: null, unit: null, period: null },
    test_date: p.test_date ?? null,
    confidence: ["H", "M", "L"].includes(p.confidence) ? p.confidence : "M",
    actual: found.actual ?? null,
    status,
    variance,
    mgmt_explanation: isMiss ? (found.mgmt_explanation || null) : null,
    root_cause: isMiss ? (found.root_cause || null) : null,
    was_revised,
  };
}

async function main() {
  if (!TICKER) die("set TICKER=<ticker>.");
  // A live run with no provider keys would silently retrieve nothing and emit an all-NYT
  // ledger that still validates — making a missing-secrets run look successful. Fail fast.
  if (!MOCK && !EXTRACTION_PROVIDERS.map((p) => providerConfig(p, process.env)).some((c) => c.apiKey)) {
    die("live verify needs at least one provider key (GEMINI_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY). Set one, or run with PROVIDER=mock for a $0 offline pass.");
  }
  const corpusPath = resolveIn(process.env.CORPUS) || join(outputDir(TICKER), "corpus.json");
  if (!existsSync(corpusPath)) die(`corpus not found: ${corpusPath}. Run ingest first or set CORPUS=<path>.`);
  const corpus = loadJSON(corpusPath);
  const promisesPath = ensurePromises(corpusPath);
  const raw = loadJSON(promisesPath);
  const promises = (Array.isArray(raw) ? raw : raw.promises || []).slice(0, LIMIT);
  if (!promises.length) die(`no promises in ${promisesPath}`);

  const vw = verificationWindow(corpus);
  const cacheDir = join(outputDir(TICKER), "cache", "verify");
  console.log(`verify — ${TICKER.toUpperCase()} · ${promises.length} promises · latest_reported=${vw.latest_reported} (${vw.latest_reported_date}) · ${MOCK ? "MOCK" : "live"}`);

  // 2. retrieve actuals (the ONLY LLM step) — skip ONLY promises whose verdict is already fixed at
  // NYT no matter what an actual says: a NON-timeline whose test_date is in the future (an interim
  // figure can't settle an annual target → statusVariance returns NYT regardless). Timeline promises
  // are ALWAYS retrieved — a later doc can re-guide a still-future milestone into a MISS — and the
  // EXACT isFuture() the verdict uses is reused here (ISO by date, else fiscal period), so this filter
  // can never disagree with the rules. It just stops burning free-tier calls on un-scoreable targets.
  const fixedNYT = (p) => directionFor(p.category) !== "timeline" && isFuture(p.test_date, vw.latest_reported_date, vw.latest_reported);
  const toRetrieve = promises.filter((p) => !fixedNYT(p));
  if (DEBUG) console.log(`verify: retrieving actuals for ${toRetrieve.length}/${promises.length} promises (${promises.length - toRetrieve.length} non-timeline forward-dated → NYT regardless, no LLM call)`);
  const { results: retrieved, stats: faStats } = await findActuals({ promises: toRetrieve, corpus, mock: MOCK, concurrency: CONCURRENCY, cacheDir, debug: DEBUG });
  const found = new Array(promises.length).fill(null);
  for (let i = 0, k = 0; i < promises.length; i++) if (!fixedNYT(promises[i])) found[i] = retrieved[k++];

  // 3. deterministic verdicts
  const ctx = { latestReportedDate: vw.latest_reported_date, latestReportedPeriod: vw.latest_reported, partialTol: PARTIAL_TOL, timelineGraceQtrs: TIMELINE_GRACE_QTRS };
  const verified = promises.map((p, i) => {
    const f = found[i] || { actual: null, mgmt_explanation: null, root_cause: null };
    const { status, variance, was_revised } = statusVariance(p, f.actual, ctx);
    return shapePromise(p, f, status, variance, was_revised);
  });

  // 4. financial trend (LLM-assisted)
  const { trend, stats: ftStats } = await financialTrend({ corpus, mock: MOCK, cacheDir, debug: DEBUG });

  // 5. aggregates + credibility (deterministic)
  const aggregates = aggregate(verified);
  const cred = credibility(verified, aggregates);

  // 6. provenance — the honesty stamp the UI badges and the commit guard enforce.
  //   retrieval_errors = retrieval calls that FAILED (provider quota/network) — the pipeline
  //     didn't do its job, so the run is genuinely truncated. This is the HARD gate.
  //   forced_nyt = due promises (deadline provably WITHIN the window — parseable + not future)
  //     left NYT for want of a retrieved actual. Most of these are legitimate: the company
  //     simply never re-reported that metric, which is NOT a pipeline failure and must not, by
  //     itself, mark the verdict provisional (real filings never re-report everything). An
  //     unparseable long-dated horizon ("medium term", null) is not due, so it's never forced.
  // "complete" therefore gates on retrieval_errors === 0, plus a sanity cap on the forced_nyt
  // RATIO: if more than FORCED_NYT_MAX_RATIO of due promises went unresolved, that looks like a
  // retrieval pathology rather than sparse disclosure, so the run is still flagged incomplete.
  const forced_nyt = verified.filter((p) => p.status === "NYT" && isWithinWindow(p.test_date, vw.latest_reported_date, vw.latest_reported)).length;
  const retrieval_errors = (faStats.errors?.length || 0) + (ftStats.errors?.length || 0);
  const { complete, ratio: forced_nyt_ratio } = runCompleteness({
    retrievalErrors: retrieval_errors,
    forcedNyt: forced_nyt,
    testable: aggregates.testable,
    maxRatio: FORCED_NYT_MAX_RATIO,
  });
  const models_used = MOCK
    ? ["mock"]
    : EXTRACTION_PROVIDERS.filter((pr) => providerConfig(pr, process.env).apiKey);
  const generatedAt = new Date().toISOString();
  const provenance = {
    mode: MOCK ? "mock" : "live",
    complete,
    retrieval_errors,
    forced_nyt,
    models_used,
    generated_at: generatedAt,
    run_id: process.env.GITHUB_RUN_ID || null,
  };

  const out = {
    schema_version: "1.0",
    company: companyBlock(),
    generated_at: generatedAt,
    coverage: coverageBlock(corpus),
    verification_window: vw,
    documents: documentsBlock(corpus),
    promises: verified,
    financial_trend: trend,
    aggregates,
    credibility: cred,
    provenance,
  };

  const outPath = join(REPO, "public", "data", "companies", `${TICKER.toLowerCase()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  spawnSync("node", [join(__dirname, "gen-index.mjs")], { stdio: DEBUG ? "inherit" : "pipe", env: process.env });

  const sc = aggregates.status_counts;
  console.log("\n──────── verify summary ────────");
  console.log(`  promises   : ${verified.length}  (MET ${sc.MET} / PARTIAL ${sc.PARTIAL} / MISSED ${sc.MISSED} / NYT ${sc.NYT})`);
  console.log(`  testable   : ${aggregates.testable}  · credibility ${cred.score} (${cred.grade})  [timeline ${cred.timeline_score} · delivery ${cred.delivery_score}]`);
  console.log(`  actuals    : llm_calls ${faStats.calls} · cache ${faStats.cache_hits} · no_evidence ${faStats.no_evidence} · errors ${faStats.errors.length}  | fin_trend calls ${ftStats.calls}`);
  const completeNote = provenance.complete
    ? ` · complete${forced_nyt ? ` (${forced_nyt} due awaiting confirmation)` : ""}`
    : ` · INCOMPLETE (retrieval_errors ${retrieval_errors}, forced_nyt ${forced_nyt}, ratio ${(forced_nyt_ratio * 100).toFixed(0)}%/${(FORCED_NYT_MAX_RATIO * 100).toFixed(0)}%)`;
  console.log(`  provenance : ${provenance.mode}${completeNote}  [${provenance.mode === "live" ? "honesty: " + (provenance.complete ? "green/Live" : "amber/Provisional") : provenance.mode === "mock" ? "red/Mock — not a real verdict" : "grey/Curated"}]`);
  console.log(`  headline   : ${cred.headline}`);
  console.log(`  ledger     : ${outPath}`);

  if (EVAL) {
    const goldenPath = join(REPO, "pipeline", "fixtures", `${TICKER.toLowerCase()}.golden.json`);
    if (existsSync(goldenPath)) {
      const { evalVerification } = await import("./eval-verification.mjs");
      const golden = loadJSON(goldenPath);
      const ev = await evalVerification(out, golden, { mock: MOCK, cacheDir, debug: DEBUG });
      console.log("\n──────── eval vs golden (data-verifier) ────────");
      console.log(`  recall     : lexical ${(ev.lexical.recall * 100).toFixed(1)}% (${ev.lexical.found}/${ev.lexical.known})` + (ev.judged?.recovered != null ? ` · LLM-judged ${(ev.judged.recall * 100).toFixed(1)}% (${ev.judged.found}/${ev.judged.known}, +${ev.judged.recovered})` : ` · ${ev.judged?.note || "judge skipped"}`));
      console.log(`  status-agr : ${(ev.status_agreement * 100).toFixed(0)}% over ${ev.matched_in_window} matched-in-window  | confusion ${JSON.stringify(ev.confusion)}`);
      console.log(`  credibility: engine ${cred.score} vs golden ${golden.credibility?.score} (Δ ${ev.credibility_delta})`);
      console.log(`  newly_resolved: ${ev.newly_resolved.length}  · extra(over-extraction): ${ev.extra.length}`);
      if (DEBUG && ev.newly_resolved.length) console.log("    e.g.", ev.newly_resolved.slice(0, 3).map((n) => `${n.id}:${n.golden}→${n.engine}`).join(", "));
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => die(e.stack || e.message));

export { shapePromise, companyBlock, coverageBlock, documentsBlock };
