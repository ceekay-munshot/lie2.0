#!/usr/bin/env node
/**
 * run-pipeline.mjs — Prompt 10. The one-command, end-to-end pipeline for ANY ticker.
 * Runs each stage as a child process (whole env forwarded), in order:
 *
 *   acquire (Screener scrape | SOURCE=upload) → ingest → extract → verify → build-report → commit
 *
 * acquire…verify are REQUIRED (a failure aborts and reports which stage broke); build-report
 * is non-fatal (a ledger without a PDF still ships). The final commit goes through the P10
 * honesty guard (lib/commit.mjs) — a mock/incomplete run never replaces a good ledger.
 *
 * Idempotent + monotonic: a stage whose output already exists is skipped (set REFRESH=1 to
 * redo acquisition); the extraction/verification caches make a re-run cheap and byte-identical.
 *
 *   TICKER=infy node pipeline/run-pipeline.mjs                       # full live run + guarded commit
 *   SOURCE=upload TICKER=test node pipeline/run-pipeline.mjs         # manual-upload acquisition
 *   CORPUS=pipeline/fixtures/vedl.corpus.json PROVIDER=mock \
 *     DRY_RUN=1 TICKER=vedl node pipeline/run-pipeline.mjs           # $0 offline dry run (no push)
 *
 * Env: TICKER (req) · SOURCE (screener|upload) · CORPUS=<path> · PROVIDER=mock · REFRESH=1 ·
 *      FORCE=1 · DRY_RUN=1 (stages run; commit decides but never pushes) · SKIP_COMMIT=1 · DEBUG=1
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { outputDir } from "./lib/manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const TICKER = (process.env.TICKER || process.argv.slice(2).find((a) => !a.startsWith("-")) || "").trim();
const SOURCE = (process.env.SOURCE || "screener").toLowerCase();
const REFRESH = !!process.env.REFRESH && process.env.REFRESH !== "0";
const DRY = !!process.env.DRY_RUN && process.env.DRY_RUN !== "0";
const SKIP_COMMIT = !!process.env.SKIP_COMMIT && process.env.SKIP_COMMIT !== "0";
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";
const die = (m) => { console.error(`run-pipeline: ${m}`); process.exit(1); };

if (!TICKER) die("set TICKER=<ticker>.");
const lc = TICKER.toLowerCase();
const out = outputDir(TICKER);
const corpusEnv = process.env.CORPUS ? (process.env.CORPUS.startsWith("/") ? process.env.CORPUS : join(REPO, process.env.CORPUS)) : null;
const corpusPath = corpusEnv || join(out, "corpus.json");
const haveCorpus = () => existsSync(corpusPath);
const P = (rel) => join(REPO, "pipeline", rel);

// Each stage: an output that marks it done (skip when present unless REFRESH), and whether a
// failure is fatal. acquire/ingest are skipped entirely when a corpus is already provided.
const STAGES = [
  {
    name: "acquire", fatal: true,
    skip: () => haveCorpus() || (!REFRESH && existsSync(join(out, "manifest.json"))),
    run: () => node(SOURCE === "upload" ? "ingest-upload.mjs" : "scrape-screener.mjs", { SOURCE }),
  },
  { name: "ingest", fatal: true, skip: () => haveCorpus(), run: () => node("ingest.mjs") },
  { name: "extract", fatal: true, skip: () => false, run: () => node("extract.mjs", { CORPUS: corpusPath }) },
  { name: "verify", fatal: true, skip: () => false, run: () => node("verify.mjs", { CORPUS: corpusPath }) },
  { name: "build-report", fatal: false, skip: () => false, run: () => node("build-report.mjs") },
];

function node(script, extraEnv = {}) {
  // DRY_RUN here means "the final commit decides but never pushes" — it must NOT leak into a
  // stage (e.g. extract.mjs has its own DRY_RUN estimate-only mode that writes no promises.json).
  const env = { ...process.env, TICKER, ...extraEnv };
  delete env.DRY_RUN;
  // Stream the child's output LIVE — a long stage (verify makes many rate-limited LLM calls) must be
  // visible as it runs, not buffered until it finishes (or gets killed by a job timeout).
  return spawnSync("node", [P(script)], { cwd: REPO, env, stdio: "inherit" });
}

const t0 = Date.now();
for (const stage of STAGES) {
  if (stage.skip()) { console.log(`▸ ${stage.name}: skipped (cached)`); continue; }
  console.log(`\n▸ ${stage.name}: running…`);
  const r = stage.run(); // streams live (stdio: inherit)
  if (r.status !== 0) {
    if (stage.fatal) die(`stage '${stage.name}' FAILED (exit ${r.status}). Pipeline aborted — earlier stages are cached, so fix this stage and re-run.`);
    console.log(`⚠ ${stage.name}: failed (exit ${r.status}) — non-fatal, continuing without it.`);
  } else {
    console.log(`✓ ${stage.name}: done`);
  }
}

// ---- summary (from the committed ledger) ----
const ledgerPath = join(REPO, "public", "data", "companies", `${lc}.json`);
if (!existsSync(ledgerPath)) die("no ledger produced — verify stage did not write a ledger.");
const L = JSON.parse(readFileSync(ledgerPath, "utf8"));
const cred = L.credibility || {}, agg = L.aggregates || {}, prov = L.provenance || {};
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log("\n════════ pipeline summary ════════");
console.log(`  company    : ${L.company?.name} (${L.company?.ticker})  ·  ${L.company?.sector || "—"}`);
console.log(`  coverage   : ${L.coverage?.from || "?"}–${L.coverage?.to || "?"}  ·  window through ${L.verification_window?.latest_reported || "?"}`);
console.log(`  promises   : ${agg.total ?? (L.promises || []).length}  (testable ${agg.testable ?? "?"})`);
console.log(`  credibility: ${cred.score ?? "—"} (${cred.grade ?? "—"})  ·  delivery ${cred.delivery_score ?? "—"} / timeline ${cred.timeline_score ?? "—"}`);
console.log(`  provenance : ${prov.mode || "?"}${prov.complete === true ? " · complete" : prov.complete === false ? ` · INCOMPLETE (forced_nyt ${prov.forced_nyt ?? "?"}, retrieval_errors ${prov.retrieval_errors ?? "?"})` : ""}`);
console.log(`  report     : ${existsSync(join(REPO, "public", "reports", `${lc}.pdf`)) ? `public/reports/${lc}.pdf` : "— (not built)"}`);
console.log(`  elapsed    : ${elapsed}s`);

// ---- guarded commit ----
if (SKIP_COMMIT) { console.log("\ncommit: skipped (SKIP_COMMIT=1)."); process.exit(0); }
console.log("");
const c = spawnSync("node", [P("lib/commit.mjs")], { cwd: REPO, env: { ...process.env, TICKER }, stdio: "inherit" });

// ---- publish to KV (instant-live) — non-fatal, no-op unless CF_* are set ----
// Mirrors the commit guard (publishes only a real verdict). A KV hiccup never fails the run —
// the committed JSON still ships on the next redeploy.
console.log("");
spawnSync("node", [P("publish-kv.mjs")], { cwd: REPO, env: { ...process.env, TICKER }, stdio: "inherit" });

process.exit(c.status || 0);
