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
import { periodIndex } from "./lib/fiscal.mjs";
import { statusVariance } from "./lib/status-variance.mjs";
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

  // 2. retrieve actuals (the only LLM step)
  const { results: found, stats: faStats } = await findActuals({ promises, corpus, mock: MOCK, concurrency: CONCURRENCY, cacheDir, debug: DEBUG });

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

  // 6. provenance — the honesty stamp the UI badges. forced_nyt = promises whose deadline
  // is within the window yet were left NYT for want of a retrieved actual (a truncation
  // signal, e.g. a provider's daily quota cut retrieval short). The UI disclaims/warns when
  // the run isn't a complete live one. (Refuse-to-commit lands in P10; here we only stamp.)
  const lriIdx = periodIndex(vw.latest_reported);
  const forced_nyt = verified.filter((p) => {
    if (p.status !== "NYT") return false;
    const ti = periodIndex(p.test_date);
    return ti != null && lriIdx != null && ti <= lriIdx;
  }).length;
  const retrieval_errors = (faStats.errors?.length || 0) + (ftStats.errors?.length || 0);
  const models_used = MOCK
    ? ["mock"]
    : EXTRACTION_PROVIDERS.filter((pr) => providerConfig(pr, process.env).apiKey);
  const generatedAt = new Date().toISOString();
  const provenance = {
    mode: MOCK ? "mock" : "live",
    complete: retrieval_errors === 0 && forced_nyt === 0,
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
  console.log(`  provenance : ${provenance.mode}${provenance.complete ? " · complete" : ` · INCOMPLETE (retrieval_errors ${retrieval_errors}, forced_nyt ${forced_nyt})`}  [${provenance.mode === "live" ? "honesty: " + (provenance.complete ? "green/Live" : "amber/Provisional") : provenance.mode === "mock" ? "red/Mock — not a real verdict" : "grey/Curated"}]`);
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
