#!/usr/bin/env node
/**
 * p6.test.mjs — the PROVENANCE GUARD (the dashboard's honesty rule). Pure unit
 * tests for ui.js#provenanceBadge: a mock or quota-truncated ledger must never be
 * presented as a real verdict. ui.js is a browser ES module but its only side
 * effects are window-guarded, so it imports cleanly in Node.
 *
 *   node pipeline/test/p6.test.mjs
 */
import { provenanceBadge, gradeFromScore } from "../../public/js/ui.js";

let fails = 0;
const ok = (cond, label) => { if (!cond) fails++; console.log(`  ${cond ? "✓" : "✗"} ${label}`); };

console.log("provenance guard (badge):");
const none = provenanceBadge(null);
ok(none.tone === "unknown" && none.disclaim === false, "no provenance → neutral 'unknown', not disclaimed");

const mock = provenanceBadge({ mode: "mock", complete: false });
ok(mock.tone === "mock" && mock.disclaim === true && /not a real verdict/i.test(mock.label), "mock → red tone + disclaim + 'not a real verdict'");

const manual = provenanceBadge({ mode: "manual", complete: true });
ok(manual.tone === "manual" && manual.disclaim === false && /curated/i.test(manual.label), "manual → grey 'Curated', not disclaimed");

const liveComplete = provenanceBadge({ mode: "live", complete: true, retrieval_errors: 0, forced_nyt: 0, models_used: ["mistral", "gemini"] });
ok(liveComplete.tone === "live" && liveComplete.disclaim === false && /complete/i.test(liveComplete.label), "live + complete → green 'Live · complete', not disclaimed");
ok(/mistral/.test(liveComplete.detail), "complete-live detail names the models used");

const provisional = provenanceBadge({ mode: "live", complete: false, retrieval_errors: 19, forced_nyt: 21, models_used: ["mistral", "groq"] });
ok(provisional.tone === "provisional" && provisional.disclaim === true && /provisional/i.test(provisional.label), "incomplete live (forced_nyt>0) → amber 'Provisional' + disclaim");
ok(/21|unverified/i.test(provisional.detail) && /retrieval error/i.test(provisional.detail), "provisional detail surfaces forced-NYT + retrieval errors");

// the four warn/ok states are distinct and only mock/provisional disclaim
const tones = [none, mock, manual, liveComplete, provisional].map((b) => b.tone);
ok(new Set(tones).size === 5, "all five provenance states map to distinct tones");
ok([mock, provisional].every((b) => b.disclaim) && [none, manual, liveComplete].every((b) => !b.disclaim), "only mock + provisional disclaim the score");

// sanity: gradeFromScore bands still drive the ring colour the hero reads
console.log("\ngrade bands (hero ring):");
ok(gradeFromScore(80) === "A" && gradeFromScore(61) === "B" && gradeFromScore(26) === "E", "score → grade band (A/B/E)");

console.log(fails === 0 ? "\nALL P6 UNIT TESTS PASSED" : `\n${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
