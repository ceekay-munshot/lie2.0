#!/usr/bin/env node
/**
 * p5.test.mjs — deterministic unit tests for the verification engine (NO LLM, no
 * network). Covers the verdict rules (status/variance), the integrity rule, variance
 * maths, the credibility formula + banding, aggregates, and the fiscal/period helpers.
 *
 *   node pipeline/test/p5.test.mjs
 */
import { statusVariance } from "../lib/status-variance.mjs";
import { directionFor, numericDirection, parseTarget, actualNumber, fmtNum, unitsIncomparable, reconcileScale } from "../lib/metric-direction.mjs";
import { periodIndex, maxPeriodIndex } from "../lib/fiscal.mjs";
import { verificationWindow, isNotYetTestable } from "../lib/verification-window.mjs";
import { aggregate, credibility, gradeFromScore } from "../lib/aggregate.mjs";
import { tierFor, hasDeadline, attributionOf, linkGroups, isDebtServicing } from "../lib/promise-analysis.mjs";
import { runCompleteness } from "../verify.mjs";

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
// testable = 1 MET(H) + 1 MISSED(H): the raw rate 0.5 equals the neutral prior, so
// shrinkage leaves it exactly at 50 → C.
ok(credibility(set).score === 50 && credibility(set).grade === "C", "1 MET + 1 MISSED (both H) → 50 / C (rate == prior, unmoved by shrinkage)");
// PARTIAL counts as 0.5 — a lone PARTIAL(H) also sits at the prior → 50
ok(credibility([P("PARTIAL", "H")]).score === 50, "a lone PARTIAL (H) → 50 (rate == prior)");
// coverage-aware shrinkage — the fix for the INFY "15/15 MET → 100" bogus score:
ok(credibility([P("MET", "H")]).score < 90, "a thin all-MET base no longer earns a perfect 100 (shrunk below 90)");
ok(credibility(Array.from({ length: 50 }, () => P("MET", "H"))).score >= 90, "a large all-MET base still reads high (~100) — shrinkage fades with evidence");
ok(credibility([P("MISSED", "H")]).score > 30 && credibility([P("MISSED", "H")]).score < 50, "a lone MISSED is pulled UP off rock-bottom 0 toward the prior");
ok(credibility(Array.from({ length: 40 }, () => P("MISSED", "H"))).grade === "E", "40 misses → grade E (thin-sample shrinkage negligible at scale)");
// forced-NYT shrinkage — unresolved DUE promises (came due, retrieval couldn't confirm an actual)
// fold in as neutral pseudo-observations, so a thinly-verified one-sided ledger can't read as a
// confident grade (the INFY grade-A artifact: 15/15 MET but 7 due-yet-unverified).
const infy15 = Array.from({ length: 15 }, () => P("MET", "H"));
ok(credibility(infy15).grade === "A", "15/15 MET, nothing unresolved → grade A (deserved)");
ok(credibility(infy15, null, { forcedNyt: 7 }).grade === "B", "15/15 MET but 7 due-unverified → pulled to grade B (not a confident A)");
ok(credibility(infy15, null, { forcedNyt: 7 }).score < credibility(infy15).score, "unresolved-due promises lower the score");
ok(credibility(infy15, null, { forcedNyt: 0 }).score === credibility(infy15).score, "forcedNyt:0 leaves the score unchanged (backward compatible)");
ok(credibility(infy15, null, { forcedNyt: 20 }).score < credibility(infy15, null, { forcedNyt: 7 }).score, "more unresolved-due promises → lower score (monotonic)");
const big90 = Array.from({ length: 90 }, () => P("MET", "H"));
ok(credibility(big90, null, { forcedNyt: 4 }).grade === "A", "a large all-MET base with few unresolved stays A (penalty is coverage-aware, negligible at scale)");

// ---- 9b) number scale/format + metric-mismatch guard (the Vedanta-review fixes) ------
console.log("\nnumber scale + unit-mismatch guard:");
ok(actualNumber({ value: 89, text: "Production was 89,000 barrels per day" }) === 89000, "LLM scale-strip 89 + text '89,000' → 89000 (fixed)");
ok(actualNumber({ value: 21.1, text: "operating margin 21.1%" }) === 21.1, "21.1 not falsely rescaled");
ok(actualNumber({ value: 150000 }) === 150000, "clean structured value passes through");
ok(fmtNum(89000) === "89,000" && fmtNum(150000) === "1,50,000", "variance numbers get Indian digit grouping");
ok(unitsIncomparable("INR_cr", "USD_bn") === true && unitsIncomparable("USD_bn", "USD_bn") === false, "cross-currency incomparable; same-unit comparable");
ok(unitsIncomparable("USD_mn", null) === false, "unknown actual unit never blocks a comparison");
// the QIP false-miss: ₹1,100cr interest-savings target vs a $1bn deleveraging actual → NYT, not MISSED
const qip = { category: "capital_allocation", target: { value: 1100, unit: "INR_cr" }, test_date: "Q4FY25", revisions: [] };
ok(sv(qip, { value: 1, unit: "USD_bn", what_happened: "debt down by ~$1bn" }).status === "NYT", "INR-cr target vs USD-bn actual → NYT (not a false MISS)");
// same metric, same unit still scores normally
const cap = { category: "capacity", target: { value: 3.1, unit: "Mtpa" }, test_date: "Q3FY26", revisions: [] };
ok(sv(cap, { value: 3.1, unit: "Mtpa", what_happened: "reached 3.1 Mtpa" }).status === "MET", "same-unit actual still scores (MET)");

// ---- 9b) forward-target-as-actual · settlement gate · rate periods · undated → NYT ----
// A restated FUTURE target grabbed as the "actual" must NOT be scored against itself, BUT a real
// reported outcome (delivered / settled vs target) must never be hidden. These separate the two.
console.log("\nforward-target / settlement / undated rules:");
const fwd = { category: "capacity", target: { value: 3, unit: "GW", period: "by FY28", text: "3 GW by FY28" }, test_date: "Q4FY26", confidence: "H", promise: "commission 3 GW hybrid", metric: "3 GW capacity", revisions: [] };
ok(sv(fwd, { value: 3.2, unit: "GW", text: "Target to fully commission 3,200 MW by Mar-2029", what_happened: "target to fully commission by 2029" }).status === "NYT", "restated future target as 'actual' (no delivery/settlement) → NYT, not a false MET");
ok(sv(fwd, { value: 950, unit: "MW", text: "increased by 950 MW", what_happened: "increased 950 MW, exceeding the 700 MW target for H1FY26" }).status !== "NYT", "a real delivered+settled outcome ('increased 950 MW, exceeding target') is NOT hidden by the guard");
// undated multi-year capex, interim spend so far → NYT (Vipool's '$8bn over next few years' case)
const capex = { category: "capex", target: { value: 8, unit: "USD_bn", period: "next few years", text: "$8 bn over next few years" }, test_date: null, confidence: "H", promise: "execute $8bn capex over next few years", metric: "$8bn growth capex", revisions: [] };
ok(sv(capex, { value: 1.3, unit: "USD_bn", what_happened: "growth capex spent $1.3 billion as of Q3FY26" }).status === "NYT", "undated multi-year capex, $1.3bn spent so far → NYT (in progress, not a mid-flight miss)");
// undated BUT the reporter settled it vs target → respect the miss (don't hide it)
const div = { category: "capital_allocation", target: { value: 6, unit: "%", period: "ongoing", text: "~6% dividend yield" }, test_date: null, confidence: "H", promise: "maintain 6% dividend yield", metric: "dividend yield 6%", revisions: [] };
ok(sv(div, { value: 4, unit: "%", what_happened: "dividend yield lowered to ~4%, below the 6% target" }).status === "MISSED", "undated target the reporter settled ('4%, below the 6% target') stays MISSED");
// a YoY/QoQ RATE is checkable each quarter — a reported shortfall stays a miss even without settlement words
const yoy = { category: "revenue", target: { value: 14.5, unit: "%", period: "YoY", text: "14.5% YoY growth" }, test_date: null, confidence: "H", promise: "grow revenue 14.5% YoY", metric: "revenue growth 14.5% YoY", revisions: [] };
ok(sv(yoy, { value: 11.2, unit: "%", what_happened: "revenue grew 11.2% YoY in Q4FY26" }).status === "MISSED", "a YoY rate at 11.2% vs 14.5% stays MISSED (rate is testable each quarter, not interim)");
// routine debt-servicing is a non-promise; a real deleveraging target is kept
ok(isDebtServicing({ promise: "Repay $417 million ICL debt as scheduled in Jan and May 2026", quote: "the entire ICL 350 million will be paid on time", metric: "ICL debt paid" }) === true, "routine debt-servicing ('repay ICL debt as scheduled') → flagged a non-promise (dropped)");
ok(isDebtServicing({ promise: "Reduce Vedanta Resources debt from $4.4 billion to $3 billion", quote: "from current $4.4 billion will go down to $3 billion over two years", metric: "VRL debt $3bn" }) === false, "a real deleveraging TARGET ('reduce debt to $3bn') is NOT flagged (kept)");

// ---- 9e) in-progress / future-passive project & unit-scale (Vipool transcript-2 findings) ----
console.log("\nin-progress projects + unit scale:");
const CTXW = { ...CTX, latestReportedPeriod: "Q4FY26" };
const hydro = { category: "capacity", target: { value: 10500, unit: "MT/annum", period: "by FY28", text: "10,500 MT/annum by FY28" }, test_date: "Q4FY28", confidence: "H", promise: "commission 10,500 MT/annum green hydrogen facility", metric: "green hydrogen 10,500 MT/annum", revisions: [] };
ok(sv(hydro, { value: 10500, unit: "MT/annum", what_happened: "Facility expected to be commissioned within 3 years as planned" }, CTXW).status === "NYT", "'expected to be commissioned within 3 years as planned' → NYT (not a self-comparison MET)");
const solar = { category: "capacity", target: { value: 300, unit: "MW", period: "Q4FY26", text: "300 MW solar" }, test_date: "Q4FY26", confidence: "H", promise: "commission 300 MW solar park", metric: "300 MW solar", revisions: [] };
ok(sv(solar, { value: 300, unit: "MW", what_happened: "300 MW solar park under construction, expected COD Q4 FY26" }, CTXW).status === "NYT", "'under construction, expected COD' → NYT (in progress, not delivered)");
const cbg = { category: "capacity", target: { value: 55, unit: "plants", period: "2025", text: "55 plants by 2025" }, test_date: "2025-12-31", confidence: "H", promise: "55 CBG plants operational by 2025", metric: "55 CBG plants", revisions: [] };
ok(sv(cbg, { value: 10, unit: "plants", what_happened: "10 CBG plants operational by Q4FY25; on track to deliver 55 plants" }, CTXW).status === "MISSED", "a real partial delivery ('10 operational … on track to 55') stays MISSED, never hidden");
const pvc = { category: "capacity", target: { value: 1.5, unit: "million tons", period: "Q3FY26", text: "1.5 mt PVC" }, test_date: "Q3FY26", confidence: "H", promise: "commission 1.5 mt PVC", metric: "1.5 mt PVC", revisions: [] };
ok(sv(pvc, { value: 1.5, unit: "million tons", what_happened: "1.5 million tons PVC capacity commissioned as planned" }, CTXW).status === "MET", "a genuinely 'commissioned' capacity stays MET (real delivery not hidden by 'as planned')");
ok(reconcileScale(1.5, "GW", "MW") === 1500 && reconcileScale(1500, "MW", "GW") === 1.5, "reconcileScale: 1.5 GW ↔ 1,500 MW");
const wind = { category: "capacity", target: { value: 1500, unit: "MW", period: "Q3FY26", text: "1500 MW wind" }, test_date: "Q3FY26", confidence: "H", promise: "commission 1500 MW wind", metric: "1500 MW wind", revisions: [] };
ok(sv(wind, { value: 1.5, unit: "GW", what_happened: "commissioned 1.5 GW wind, meeting the 1,500 MW target" }, CTXW).status === "MET", "1.5 GW actual vs 1,500 MW target → MET (unit scale reconciled, not '1.5 vs 1500')");

// ---- 9c) materiality by tier — binary outcomes weigh more --------------------
console.log("\nmateriality (tier weighting):");
const tierP = (status, tier) => ({ status, confidence: "H", category: "volume", quarter_context: "Q1FY26", tier });
// same MET + MISSED both times; the MISS at Tier-1 (weight 1.4) must drag more than at Tier-3 (0.6).
ok(credibility([tierP("MET", 3), tierP("MISSED", 1)]).score < credibility([tierP("MET", 3), tierP("MISSED", 3)]).score, "a Tier-1 (binary) miss drags the score more than a soft Tier-3 miss");
ok(credibility([tierP("MET", 1)]).score > credibility([tierP("MET", 3)]).score, "a Tier-1 hit lifts more than a Tier-3 hit");
ok(credibility([P("MET", "H")]).score === credibility([{ status: "MET", confidence: "H", category: "ebitda", quarter_context: "Q1FY26" }]).score, "a promise with no tier → neutral weight (tests unaffected)");

// ---- 9d) promise-analysis: tier, deadline, attribution, linking, quiet-drop ----
console.log("\npromise-analysis (tiers + trajectory):");
ok(tierFor({ category: "capacity", target: { period: "FY27" } }) === 1, "dated capacity commissioning → Tier 1");
ok(tierFor({ category: "revenue", target: { period: "FY26" } }) === 2, "dated revenue guidance → Tier 2");
ok(tierFor({ category: "capacity", target: { period: "medium term" } }) === 3, "undated (medium term) → Tier 3 regardless of category");
ok(hasDeadline({ target: { period: "Q3FY26" } }) === true && hasDeadline({ target: { period: "near term" } }) === false, "hasDeadline: concrete period yes, 'near term' no");
ok(attributionOf("Demand slowdown") === "external" && attributionOf("Execution") === "owned", "attribution: demand=external, execution=owned");
// linking: two DISTINCT products (same wording, different number) must NOT merge; the SAME target across quarters must.
const distinct = [{ category: "capacity", metric: "alumina production 2.3 Mt", promise: "achieve alumina production of 2.3 Mt in FY25", quarter_context: "Q2FY25", target: { value: 2.3 } }, { category: "capacity", metric: "iron ore production 5.5 Mt", promise: "achieve iron ore production of 5.5 Mt in FY25", quarter_context: "Q2FY25", target: { value: 5.5 } }];
ok(linkGroups(distinct).length === 2, "distinct targets (2.3 Mt alumina vs 5.5 Mt iron) stay separate");
const same = [{ category: "leverage", metric: "net debt to EBITDA 1.2x", promise: "reduce net debt to EBITDA to 1.2x", quarter_context: "Q1FY25", target: { value: 1.2 } }, { category: "leverage", metric: "net debt to EBITDA 1.2x", promise: "reduce net debt to EBITDA to 1.2x", quarter_context: "Q3FY25", target: { value: 1.2 } }];
ok(linkGroups(same).length === 1, "same target restated across quarters → one link group");

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

// ---- 11) run completeness (Option B honesty rule) --------------------------
// "complete" gates on retrieval doing its job, NOT on every due promise being resolved.
console.log("\nrun completeness (provenance.complete):");
const rc = (o) => runCompleteness(o).complete;
ok(rc({ retrievalErrors: 0, forcedNyt: 0, testable: 90 }) === true, "0 errors, 0 forced → complete");
ok(rc({ retrievalErrors: 0, forcedNyt: 15, testable: 173 }) === true, "0 errors, a few due unconfirmed (8%) → complete (the VEDL case)");
ok(rc({ retrievalErrors: 5, forcedNyt: 0, testable: 90 }) === false, "any retrieval error → INCOMPLETE (hard gate)");
ok(rc({ retrievalErrors: 0, forcedNyt: 80, testable: 20 }) === false, "most due promises unresolved (80%) → INCOMPLETE (retrieval pathology)");
ok(rc({ retrievalErrors: 0, forcedNyt: 5, testable: 5 }) === true, "exactly at the 50% cap (5/10) → still complete (boundary)");
ok(rc({ retrievalErrors: 0, forcedNyt: 0, testable: 0 }) === false, "0 testable promises → INCOMPLETE (thin, nothing to score)");
ok(rc({ retrievalErrors: 0, forcedNyt: 0, testable: 1 }) === false, "1 testable promise → INCOMPLETE (thin — the INFY parse-failure case)");
ok(rc({ retrievalErrors: 0, forcedNyt: 0, testable: 3 }) === true, "3 testable → complete (at the MIN_TESTABLE floor)");
ok(runCompleteness({ retrievalErrors: 0, forcedNyt: 0, testable: 1 }).thin === true, "thin flag set when testable < minTestable");
ok(runCompleteness({ retrievalErrors: 0, forcedNyt: 15, testable: 173 }).ratio < 0.1, "ratio reported (15/188 ≈ 8%)");

console.log(fails === 0 ? "\nALL P5 UNIT TESTS PASSED" : `\n${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
