#!/usr/bin/env node
/**
 * p10.test.mjs — Prompt 10 unit tests for the provenance COMMIT GUARD (the enforcement
 * point). Pure, deterministic: no git, no network. Proves the "Vedanta 61/B lesson":
 * a mock/incomplete run is refused and never downgrades a good committed ledger; the
 * curated→live UPGRADE is allowed; FORCE bypasses.
 */
import { guardCommit, ledgerRank, isRealVerdict } from "../lib/commit.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ ${msg}`); } };

const mock = { mode: "mock", complete: false };
const liveOK = { mode: "live", complete: true };
const liveBad = { mode: "live", complete: false }; // quota-truncated
const liveUnknown = { mode: "live" }; // complete omitted/null
const manual = { mode: "manual" };

console.log("ledgerRank:");
ok(ledgerRank(liveOK) === 2, "complete live → rank 2");
ok(ledgerRank(manual) === 1, "manual (curated) → rank 1");
ok(ledgerRank(mock) === 0 && ledgerRank(liveBad) === 0 && ledgerRank(liveUnknown) === 0, "mock / live-incomplete / live-unknown → rank 0");
ok(ledgerRank(null) === -1, "no ledger → rank -1");
ok(isRealVerdict(liveOK) && isRealVerdict(manual) && !isRealVerdict(mock) && !isRealVerdict(liveBad), "isRealVerdict: manual + complete-live only");

console.log("\nguardCommit — honesty guard:");
ok(guardCommit({ nextProv: mock }).commit === false, "mock ledger (no prior) → REFUSED");
ok(guardCommit({ nextProv: liveBad }).commit === false, "incomplete live ledger → REFUSED");
ok(guardCommit({ nextProv: liveUnknown }).commit === false, "live with complete omitted → REFUSED");
ok(guardCommit({ nextProv: liveOK }).commit === true, "complete live ledger (no prior) → committed");
ok(guardCommit({ nextProv: manual }).commit === true, "curated manual ledger → committed");

console.log("\nguardCommit — never downgrade a good committed ledger (the lesson):");
ok(guardCommit({ nextProv: mock, priorProv: liveOK }).commit === false, "truncated mock re-run does NOT overwrite a complete live ledger");
ok(guardCommit({ nextProv: liveBad, priorProv: liveOK }).commit === false, "incomplete live re-run does NOT overwrite a complete live ledger");
ok(guardCommit({ nextProv: manual, priorProv: liveOK }).commit === false, "curated ledger does NOT downgrade a complete live ledger");
ok(guardCommit({ nextProv: liveOK, priorProv: liveOK }).commit === true, "complete live refresh over complete live → committed");

console.log("\nguardCommit — the curated→live UPGRADE (DoD #1) + FORCE:");
ok(guardCommit({ nextProv: liveOK, priorProv: manual }).commit === true, "complete live REPLACES the curated golden (upgrade)");
ok(guardCommit({ nextProv: mock, priorProv: liveOK, force: true }).commit === true, "FORCE bypasses the guard (debugging only)");
ok(guardCommit({ nextProv: liveBad, force: true }).commit === true, "FORCE commits an incomplete ledger");

console.log(`\n${fail === 0 ? "ALL P10 UNIT TESTS PASSED" : `P10 TESTS FAILED (${fail} failing)`}  [${pass}/${pass + fail}]`);
process.exit(fail === 0 ? 0 : 1);
