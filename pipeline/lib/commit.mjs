#!/usr/bin/env node
/**
 * commit.mjs — Prompt 10. The single enforcement point for shipping company data.
 *
 * It stages a freshly-built ledger (public/data/companies/<ticker>.json), its PDF
 * (public/reports/<ticker>.pdf) and the regenerated index.json, then pushes with a
 * rebase-retry — but ONLY when the new ledger is a real, complete verdict.
 *
 * The honesty guard (the load-bearing rule, the "Vedanta 61/B lesson" enforced):
 *   - REFUSE a mock ledger, or a live ledger that isn't `complete` (a quota-truncated
 *     run that left due promises forced-NYT). A curated `manual` ledger is allowed.
 *   - NEVER downgrade an already-committed COMPLETE ledger to a provisional one — a
 *     truncated re-run keeps the prior good ledger on main.
 *   - The prior ledger is captured from git HEAD and RE-checked after every rebase,
 *     so a concurrent push can't sneak a better ledger out from under us.
 *   - FORCE=1 bypasses the guard (debugging only) — clearly logged.
 *
 *   TICKER=vedl node pipeline/lib/commit.mjs            # guarded stage + push
 *   TICKER=vedl DRY_RUN=1 node pipeline/lib/commit.mjs  # decide + stage, never push
 *   FORCE=1 TICKER=vedl node pipeline/lib/commit.mjs    # bypass the guard
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");

/**
 * Completeness rank — higher is a stronger verdict:
 *   2 = complete live run (a real, fully-retrieved verdict)
 *   1 = curated manual ledger (hand-verified reference)
 *   0 = mock, or a live run that isn't `complete` (quota-truncated / provisional)
 *  -1 = no ledger
 */
export function ledgerRank(prov) {
  if (!prov || typeof prov !== "object") return -1;
  if (prov.mode === "live" && prov.complete === true) return 2;
  if (prov.mode === "manual") return 1;
  return 0; // mock, live-incomplete, or unknown
}
/** A "real verdict" is shippable: a curated manual ledger, or a complete live run. */
export const isRealVerdict = (prov) => ledgerRank(prov) >= 1;

/**
 * Pure guard decision — unit-tested. Decides whether the next ledger may be committed.
 *   - REFUSE a provisional (mock / incomplete-live) ledger (rank 0): keep the prior good one.
 *   - REFUSE a downgrade: a lesser verdict must not replace a stronger committed one
 *     (e.g. a curated ledger can't overwrite a complete live one) — but the curated→live
 *     UPGRADE is allowed (DoD #1). Equal rank → a normal refresh.
 *   - FORCE bypasses everything (debugging only).
 * @returns {{commit:boolean, reason:string}}
 */
export function guardCommit({ nextProv, priorProv = null, force = false }) {
  const nr = ledgerRank(nextProv), pr = ledgerRank(priorProv);
  const mode = nextProv?.mode || "unknown";
  const provis = mode === "mock" ? "mock" : `${mode}/incomplete`;

  if (force) return { commit: true, reason: `FORCE override — committing a ${nr >= 1 ? "real" : provis} ledger (guard bypassed; debugging only)` };
  if (nr <= 0) return { commit: false, reason: `refused: ${provis} ledger is not a real verdict — keeping the prior committed ledger` };
  if (priorProv && nr < pr) return { commit: false, reason: `refused: would downgrade a stronger committed ledger (${priorProv.mode}${priorProv.complete ? "/complete" : ""}) to a lesser one (${mode}) — keeping the prior` };
  return { commit: true, reason: priorProv ? `ok: real verdict (rank ${nr} ≥ prior ${pr}) — refreshing the committed ledger` : "ok: real verdict — first commit for this ticker" };
}

/* ---------------- CLI ---------------- */
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", ...opts });
const git = (...args) => sh("git", args);
const die = (m) => { console.error(`commit: ${m}`); process.exit(1); };
const log = (m) => console.log(`commit: ${m}`);

/** Read a committed file's content at a git ref (or null if absent / not tracked). */
function showAt(ref, relPath) {
  const r = git("show", `${ref}:${relPath}`);
  return r.status === 0 ? r.stdout : null;
}
const showAtHead = (relPath) => showAt("HEAD", relPath);
const provOf = (jsonText) => { try { return JSON.parse(jsonText).provenance || null; } catch { return null; } };
/** Ledger text minus volatile fields, so a re-run that only re-stamps the time isn't a "change". */
function stripVolatile(jsonText) {
  try { const o = JSON.parse(jsonText); delete o.generated_at; if (o.provenance) o.provenance = { ...o.provenance, generated_at: undefined, run_id: undefined }; return JSON.stringify(o); }
  catch { return jsonText; }
}
const genIndex = () => sh("node", [join(REPO, "pipeline", "gen-index.mjs")]);

async function main() {
  const TICKER = (process.env.TICKER || process.argv.slice(2).find((a) => !a.startsWith("-")) || "").trim().toLowerCase();
  const FORCE = (!!process.env.FORCE && process.env.FORCE !== "0") || (!!process.env.PROVENANCE_FORCE && process.env.PROVENANCE_FORCE !== "0");
  const DRY = !!process.env.DRY_RUN && process.env.DRY_RUN !== "0";
  const BRANCH = process.env.COMMIT_BRANCH || process.env.GITHUB_REF_NAME || git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (!TICKER) die("set TICKER=<ticker>.");

  const ledgerRel = `public/data/companies/${TICKER}.json`;
  const reportRel = `public/reports/${TICKER}.pdf`;
  const indexRel = "public/data/companies/index.json";
  const ledgerAbs = join(REPO, ledgerRel);
  if (!existsSync(ledgerAbs)) die(`ledger not found: ${ledgerRel}. Run the pipeline first.`);

  const nextLedgerText = readFileSync(ledgerAbs, "utf8");
  const nextProv = provOf(nextLedgerText);
  const priorLedgerText = showAtHead(ledgerRel);
  const priorProv = provOf(priorLedgerText);

  const decision = guardCommit({ nextProv, priorProv, force: FORCE });
  log(`${TICKER.toUpperCase()} · next=${nextProv?.mode || "?"}${nextProv?.complete === true ? "/complete" : nextProv?.complete === false ? "/incomplete" : ""} · prior=${priorProv?.mode || "none"} → ${decision.reason}`);
  if (!decision.commit) {
    // Keep the prior good ledger: restore the working tree (or drop a brand-new refused ledger) so a
    // mock/incomplete run never leaves a clobbered ledger behind, even locally.
    if (priorLedgerText !== null) git("checkout", "--", ledgerRel);
    else rmSync(ledgerAbs, { force: true });
    genIndex();
    log("nothing committed (guard) — prior committed ledger kept.");
    return;
  }

  // Refresh the index from the new ledger (deterministic, offline).
  if (genIndex().status !== 0) die("gen-index failed.");

  // Shipped data must be schema-VALID too, not just provenance-complete — the guard is the single
  // point that protects main, so validate the working-tree ledgers BEFORE the commit lands.
  const val = sh("node", [join(REPO, "pipeline", "validate.mjs")]);
  if (val.status !== 0) {
    if (priorLedgerText !== null) git("checkout", "--", ledgerRel); else rmSync(ledgerAbs, { force: true });
    genIndex();
    die(`refusing to commit — ${TICKER} is schema-INVALID (prior ledger kept):\n${((val.stdout || "") + (val.stderr || "")).trim().slice(-700)}`);
  }

  // Idempotency: a re-run with identical inputs differs only by generated_at/run_id. Don't churn the
  // ledger/index on timestamps alone — BUT still ship a (re)generated or previously-missing report.
  if (priorLedgerText !== null && stripVolatile(priorLedgerText) === stripVolatile(nextLedgerText)) {
    git("checkout", "--", ledgerRel, indexRel); // never churn the ledger/index on timestamps only
    let reportChanged = false;
    if (existsSync(join(REPO, reportRel))) { git("add", "--", reportRel); reportChanged = git("diff", "--cached", "--quiet", "HEAD", "--", reportRel).status !== 0; }
    if (!reportChanged) {
      git("reset", "--quiet", "HEAD", "--", reportRel);
      log("no meaningful change vs the committed ledger (timestamps only) — nothing to commit (idempotent).");
      return;
    }
    log("ledger unchanged (timestamps only) but the report changed — committing the regenerated report.");
    // fall through: the report is staged; ledger/index sit at HEAD so they won't re-stage as a change.
  }

  // Stage exactly the shipped artifacts.
  const toStage = [ledgerRel, indexRel, ...(existsSync(join(REPO, reportRel)) ? [reportRel] : [])];
  git("add", "--", ...toStage);
  if (git("diff", "--cached", "--quiet").status === 0) { log("no change to ledger/report/index — nothing to commit."); return; }

  if (DRY) { log(`DRY_RUN — would commit ${toStage.join(", ")} and push to ${BRANCH}.`); git("reset", "--quiet", "HEAD", "--", ...toStage); return; }

  git("config", "user.name", process.env.GIT_AUTHOR_NAME || "github-actions[bot]");
  git("config", "user.email", process.env.GIT_AUTHOR_EMAIL || "41898282+github-actions[bot]@users.noreply.github.com");
  const sc = JSON.parse(readFileSync(ledgerAbs, "utf8")).credibility || {};
  const c = git("commit", "-m", `data: ${TICKER} ledger + report${sc.grade ? ` (${sc.grade} ${sc.score})` : ""}`);
  if (c.status !== 0) die(`git commit failed: ${c.stderr || c.stdout}`);

  // Push with rebase-retry; after each rebase RE-CHECK the guard against the (possibly new) prior.
  for (let i = 1; i <= 5; i++) {
    if (git("push", "origin", `HEAD:${BRANCH}`).status === 0) { log(`pushed to ${BRANCH}.`); return; }
    log(`push rejected — rebasing (attempt ${i})`);
    sh("sleep", [String(i * 2)]);
    git("fetch", "origin", BRANCH);
    if (git("rebase", `origin/${BRANCH}`).status !== 0) { git("rebase", "--abort"); die("rebase failed; not pushing."); }
    // Re-decide against the ledger that just LANDED on origin — NOT our own replayed commit (HEAD now
    // holds our ledger). Reading origin/<branch> is what makes the downgrade re-check meaningful.
    const rebasedPrior = provOf(showAt(`origin/${BRANCH}`, ledgerRel));
    const re = guardCommit({ nextProv, priorProv: rebasedPrior, force: FORCE });
    if (!re.commit) die(`after rebase: ${re.reason} (origin/${BRANCH} gained a stronger ledger during this run) — not pushing.`);
  }
  die("push failed after retries.");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => die(e.stack || e.message));
