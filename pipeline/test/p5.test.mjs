#!/usr/bin/env node
/**
 * p5.test.mjs — deterministic unit tests for the verification engine (NO LLM, no
 * network). Covers the verdict rules (status/variance), the integrity rule, variance
 * maths, the credibility formula + banding, aggregates, and the fiscal/period helpers.
 *
 *   node pipeline/test/p5.test.mjs
 */
import { statusVariance } from "../lib/status-variance.mjs";
import { directionFor, numericDirection, parseTarget, actualNumber } from "../lib/metric-direction.mjs";
import { periodIndex, maxPeriodIndex } from "../lib/fiscal.mjs";
import { verificationWindow, isNotYetTestable } from "../lib/verification-window.mjs";
import { aggregate, credibility, gradeFromScore } from "../lib/aggregate.mjs";

let fails = 0;
const ok = (cond, label) => { if (!cond) fails++; console.log(`  ${cond ? "✓" : "✗"} ${label}`); };
const CTX = { latestReportedDate: "2026-04-29", partialTol: 0.05, timelineGraceQtrs: 1 };
const sv = (p, a, ctx = CTX) => statusVariance(p, a, ctx);

// ---- 1) generic direction + target parsing ---------------------------------
console.log("direction + parseTarget:");
ok(directionFor("ebitda") === "higher" && directionFor("cost") === "lower" && directionFor("timeline") === "timeline", "category→direction map");
ok(numericDirection("capex") === "higher" && numericDirection("leverage") === "lower", "target→higher, leverage→lower");
ok(parseTarget({ value: 95, value_high: 100 }).op === "range", "range target");
ok(parseTarget({ text: "< 1x", value: 1 }).op === "<=", "'< 1x' → <=");
ok((() => { const t = parseTarget({ text: "12 to 14%" }); return t.lo === 12 && t.hi === 14; })(), "parses '12 to 14%' from text");

// ---- 2) fiscal period maths ------------------------------------------------
console.log("\nfiscal periods:");
ok(periodIndex("Q2FY26") === 106 && periodIndex("FY26") === 108 && periodIndex("2HFY26") === 108, "QnFY / FY / nHFY indices");
ok(periodIndex("1HFY27") === 110 && periodIndex("Q4FY26") === 108, "half-year + quarter indices");
ok(maxPeriodIndex("Q2 82%; Q3 ~90%, re-set to 1HFY27") === 110, "maxPeriodIndex picks the latest named period");
ok(periodIndex("by Mar 2026") === 108, "calendar 'Mar 2026' → FY26 year-end");

// ---- 3) verification window + NYT ------------------------------------------
console.log("\nverification window:");
const vw = verificationWindow({ documents: [{ quarter: "Q1FY26", date: "2025-07-31" }, { quarter: "Q3FY26", date: "2026-01-29" }] });
ok(vw.latest_reported === "Q3FY26" && vw.latest_reported_date === "2026-01-29", "latest reported = newest doc");
ok(isNotYetTestable("2026-05-15", "2026-01-29") === true && isNotYetTestable("2025-12-01", "2026-01-29") === false, "NYT iff test_date after latest reported");

// ---- 4) numeric verdicts (higher / lower / range / >X) ---------------------
console.log("\nnumeric verdicts:");
const due = (cat, target, val, conf = "H") => ({ p: { category: cat, target, test_date: "2026-03-31", confidence: conf, revisions: [] }, a: { value: val } });
ok(sv(...Object.values(due("ebitda", { value: 6 }, 6.3))).status === "MET", "higher >X met");
ok(sv(...Object.values(due("ebitda", { value: 6 }, 5.8))).status === "PARTIAL", "higher >X partial (within 5%)");
ok(sv(...Object.values(due("ebitda", { value: 6 }, 5.0))).status === "MISSED", "higher >X missed");
ok(sv(...Object.values(due("leverage", { text: "< 1x", value: 1 }, 0.9))).status === "MET", "lower <X met");
ok(sv(...Object.values(due("leverage", { text: "< 1x", value: 1 }, 1.04))).status === "PARTIAL", "lower <X partial");
ok(sv(...Object.values(due("leverage", { text: "< 1x", value: 1 }, 1.3))).status === "MISSED", "lower <X missed");
ok(sv(...Object.values(due("volume", { value: 95, value_high: 100 }, 97))).status === "MET", "higher range met (≥ low end)");
ok(sv(...Object.values(due("volume", { value: 95, value_high: 100 }, 85))).status === "MISSED", "higher range missed");

// ---- 5) NYT cases ----------------------------------------------------------
console.log("\nNYT:");
ok(sv({ category: "ebitda", target: { value: 6 }, test_date: "2027-03-31", confidence: "H" }, { value: 4 }).status === "NYT", "future test_date → NYT (interim)");
ok(sv({ category: "ebitda", target: { value: 6 }, test_date: "2026-03-31", confidence: "H" }, null).status === "NYT", "no actual → NYT");

// ---- 6) variance maths -----------------------------------------------------
console.log("\nvariance:");
const vEb = sv(...Object.values(due("ebitda", { value: 6, unit: "USD_bn" }, 5.4))).variance;
ok(vEb.absolute === -0.6 && vEb.pct === -10, "abs + pct computed (5.4 vs 6 → -0.6 / -10%)");
const vMar = sv(...Object.values(due("margin", { value: 18, unit: "%" }, 19))).variance;
ok(vMar.bps === 100, "bps computed for margin (19 vs 18 → +100 bps)");

// ---- 7) timeline verdicts (incl re-guided-date = MISSED) -------------------
console.log("\ntimeline:");
const tl = (metric, what, td = "2026-03-31") => sv({ category: "timeline", metric, target: { text: metric }, test_date: td, revisions: [] }, { what_happened: what });
ok(tl("Meenakshi U4 by Q2FY26", "Commissioned in H1FY26", "2025-10-31").status === "MET", "delivered on time → MET");
ok(tl("Gamsberg by 2HFY26", "re-set to 1HFY27").status === "MISSED", "re-guided past window → MISSED (even if test_date future)");
ok(tl("X by Q2FY26", "commissioned in Q3FY26").status === "PARTIAL", "delivered 1 qtr late → PARTIAL (within grace)");
ok(tl("X by Q2FY26", "now expected Q1FY27").status === "MISSED", "slipped >1 qtr → MISSED");
const vDays = tl("Gamsberg by 2HFY26", "re-set to 1HFY27").variance;
ok(vDays.days != null && vDays.days > 0 && /slipped/.test(vDays.text), "timeline variance carries days + text");

// ---- 8) integrity rule (judge vs ORIGINAL target) --------------------------
console.log("\nintegrity rule:");
const rv = sv({ category: "ebitda", target: { value: 6 }, test_date: "2026-03-31", confidence: "H", revisions: [{ date: "2026-01-29", target: { value: 5 } }] }, { value: 5.2 });
ok(rv.status === "MISSED" && rv.was_revised === true, "a cut-then-'met' guidance is judged vs the ORIGINAL 6 (5.2 → MISSED), was_revised=true");

// ---- 9) aggregate + credibility formula + banding --------------------------
console.log("\naggregate + credibility:");
ok(gradeFromScore(80) === "A" && gradeFromScore(60) === "B" && gradeFromScore(45) === "C" && gradeFromScore(30) === "D" && gradeFromScore(10) === "E", "grade bands A/B/C/D/E");
const P = (status, confidence, category = "ebitda") => ({ status, confidence, category, quarter_context: "Q1FY26" });
const set = [P("MET", "H"), P("MISSED", "H"), P("NYT", "M")];
const agg = aggregate(set);
ok(agg.total === 3 && agg.testable === 2 && agg.status_counts.NYT === 1, "aggregate counts + testable excludes NYT");
// hand-fed credibility: testable = 1×MET(H,w1) + 1×MISSED(H,w1) → 100×(1×1+1×0)/(1+1)=50 → C
ok(credibility(set).score === 50 && credibility(set).grade === "C", "credibility = conf-weighted delivery (1 MET + 1 MISSED, both H → 50 / C)");
// all-MISSED testable → 0 / E ; banding reproduced
ok(credibility([P("MISSED", "H"), P("MISSED", "M")]).score === 0 && credibility([P("MISSED", "H")]).grade === "E", "all-missed → 0 / grade E");
// PARTIAL counts as 0.5
ok(credibility([P("PARTIAL", "H")]).score === 50, "a lone PARTIAL (H) → 50");

// ---- 10) Codex review regressions (hardening generic parsing/verdicts) ------
console.log("\nCodex-review regressions:");
// fiscal apostrophe shorthand (1Q'27 / 2H'26) — previously returned null
ok(periodIndex("1Q'27") === 109 && periodIndex("Q1'27") === 109, "apostrophe shorthand 1Q'27 / Q1'27 → FY27 Q1 (109)");
ok(periodIndex("2H'26") === 108, "apostrophe half-year 2H'26 → FY26 year-end (108)");
ok(maxPeriodIndex("commissioned Q4FY26 milestone now expected 1Q'27") === 109, "maxPeriodIndex reads 1Q'27 as the latest period");
// range targets with thousands separators
ok((() => { const t = parseTarget({ text: "$1,700-1,750/t" }); return t.lo === 1700 && t.hi === 1750 && t.op === "range"; })(), "range target keeps commas: $1,700-1,750/t → 1700-1750");
// actualNumber must ignore leading period labels (Q3, 9M FY26, …)
ok(actualNumber({ text: "Q3 $1,674/t" }) === 1674, "actualNumber ignores period label: 'Q3 $1,674/t' → 1674");
ok(actualNumber({ what_happened: "9M FY26 revenue 12,345" }) === 12345, "actualNumber strips '9M FY26' → 12345");
// negated milestone outcome must NOT read as delivered/MET
ok(tl("X by Q2FY26", "not commissioned").status === "MISSED", "negated milestone 'not commissioned' → MISSED (not MET)");
ok(tl("Plant by Q2FY26", "yet to be commissioned").status === "MISSED", "‘yet to be commissioned’ → MISSED");
ok(tl("X by Q2FY26", "commissioned in Q2FY26").status === "MET", "positive milestone still MET (negation guard doesn't over-trigger)");
// non-ISO future horizon (2030, FY30) stays NYT even with an interim actual
const CTXP = { ...CTX, latestReportedPeriod: "Q4FY26" };
ok(sv({ category: "ebitda", target: { value: 6 }, test_date: "2030", confidence: "H", revisions: [] }, { value: 4 }, CTXP).status === "NYT", "non-ISO 2030 target + interim actual → NYT (not scored in 2026)");
ok(sv({ category: "capacity", target: { value: 20, unit: "GW" }, test_date: "FY30", confidence: "H", revisions: [] }, { value: 5 }, CTXP).status === "NYT", "FY30 capacity target stays NYT vs Q4FY26 window");

console.log(fails === 0 ? "\nALL P5 UNIT TESTS PASSED" : `\n${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
