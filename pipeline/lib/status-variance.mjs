/**
 * status-variance.mjs — THE VERDICT. Deterministic, reproducible, unit-testable
 * rules that turn (promise, retrieved actual) into {status, variance, was_revised}.
 * The LLM never decides pass/fail; it only retrieves the actual + explanation. Rules
 * are generic (keyed on category direction) — no company/metric hardcoding.
 *
 *   NYT     — no usable actual, OR test_date still in the future (interim only).
 *   MET     — meets/beats the target on its favourable side.
 *   PARTIAL — just on the wrong side (within PARTIAL_TOL), or a milestone late ≤ grace.
 *   MISSED  — clearly on the wrong side, or a milestone slipped beyond grace —
 *             INCLUDING when the company's own later disclosure re-guides past window.
 *   Integrity rule: when revisions[] exist, judge vs the ORIGINAL target (the canonical
 *   promise.target the extractor keeps), and flag was_revised:true.
 */
import { directionFor, numericDirection, parseTarget, actualNumber, fmtNum, unitsIncomparable, hasDeadline, reconcileScale } from "./metric-direction.mjs";
import { maxPeriodIndex, periodIndex } from "./fiscal.mjs";

const DELIVERED_RE = /\b(commission\w*|complet\w*|\blive\b|operational|on stream|started?|begun|began|achiev\w*|delivered|first oil|first production|ramp(?:ed|ing|-?up)?|in operation|done)\b/i;
const SLIPPED_RE = /\b(re-?set\w*|re-?guid\w*|push\w*|defer\w*|delay\w*|slip\w*|moved? to|now expect\w*|re-?schedul\w*|postpon\w*|behind schedule)\b/i;
// Negated delivery ("not commissioned", "yet to be completed", "failed to deliver"):
// a delivery verb within a short span of a negator — must NOT read as delivered.
const NEG_DELIVERY_RE = /\b(?:not|yet to|unable to|failed to|behind schedule|no longer|won'?t|will not|did\s?n'?t|have\s?n'?t|has\s?n'?t)\b[\s\w-]{0,18}?(?:commission|complet|operational|deliver|achiev|start|\blive\b|on\s?stream|done|ramp|first oil|first production)/i;
// Forward-target-as-actual: the retriever sometimes grabs a RE-STATED FUTURE TARGET or an IN-PROGRESS
// project ("Target to fully commission 3,200 MW by Mar-2029", "300 MW under construction, expected COD
// Mar-2026", "facility expected to be commissioned within 3 years as planned") as the "actual". That is
// not a reported outcome — comparing it to the promise scores a target against itself. Four signals:
//   FORWARD_TARGET — the text restates a goal ("target to/for", "on track to", "reiterated", "remains set").
//   IN_PROGRESS    — the project is under way / future-dated ("under construction", "to be commissioned",
//                    "expected COD", "as planned", "within 3 years"); NOT done, so a figure == target is a restatement.
//   DELIVERED_PAST — an UNAMBIGUOUS past outcome ("grew/rose/fell/increased/reached/was/added 950 MW");
//                    a real result even if a future phase is also mentioned.
//   SETTLEMENT     — the reporter explicitly settled it vs the target ("below/above/exceeding/short of").
// A stray delivery verb that can be future-passive ("to be commissioned") counts as delivered ONLY when
// the text is not also in-progress. The guard fires on a bare restated/in-progress target with no real
// delivery, that is either unsettled OR still physically in progress.
const FORWARD_TARGET_RE = /\b(?:target(?:ing|s|ed)?\s+(?:to|of|for|by)|targeting\b|aim(?:ing|s)?\s+to|plan(?:ning|s)?\s+to|intend(?:ing|s)?\s+to|expect(?:ing|s)?\s+to|on\s+track\s+to|guidance\s+(?:of|for)|will\s+(?:commission|complete|deliver|achieve|reach|start|begin|ramp|be)|remains?\s+(?:set|targeted|on\s+track|unchanged)|reiterat\w*|target\s+remains)\b/i;
const IN_PROGRESS_RE = /\b(?:under\s+(?:construction|implementation|development|execution)|to\s+be\s+(?:commission|complet|deliver|built|install|set\s?up|operational)|expect\w*\s+(?:to|commissioning|cod|completion|by|within|in|around)|yet\s+to\s+be|as\s+planned|within\s+(?:the\s+)?(?:next\s+)?\d+\s*(?:year|month|quarter|week)|over\s+(?:the\s+)?next|scheduled\s+(?:for|to|commissioning)|planned\s+(?:cod|commissioning|for)|\bepc\s+mode|on\s+track\s+to|will\s+be\b|remains?\s+(?:set|targeted|on\s+track|planned))\b/i;
const DELIVERED_PAST_RE = /\b(?:grew|grown|rose|risen|increased|decreased|declined|fell|fallen|added|reached|attained|achieved|stood\s+at|came\s+in|reported|recorded|posted|clocked|hit\b|touched|spent|was\s|were\s|has\s+been|have\s+been|commissioned|completed|delivered|connected|installed|operational|\blive\b|on\s?stream|ramped)\b/i;
// Future-passive ("expected to be commissioned", "will be delivered"): a delivery verb here describes a
// FUTURE action, not an achievement — stripped before the delivered-check so it can't spare the guard.
// (An active infinitive like "on track to deliver" is NOT stripped, so a real "10 plants operational …
// on track to deliver 55" keeps its genuine "operational" delivery and still scores as a miss.)
const FUTURE_PASSIVE_RE = /\b(?:to\s+be|will\s+be|would\s+be|shall\s+be|expected\s+to\s+be|be\s+fully|being)\s+(?:commission|complet|deliver|built|install|operational|set\s?up|ramp|live|on\s?stream)\w*/gi;
// The reporter explicitly settled the metric against its target — respect the deterministic verdict
// even for an undated target (a stated "below/exceeding the X target" is a decided outcome, not interim).
const SETTLEMENT_RE = /\b(?:below|above|short\s+of|shortfall|exceed\w*|surpass\w*|beat(?:s|en)?|miss\w*|\bmet\b|in\s+line\s+with|ahead\s+of|\bbehind\b|contrary\s+to|fell\s+short|falls?\s+short|outperform\w*|underperform\w*|lower\s+than|higher\s+than)\b/i;
// A per-period RATE target ("grow 15% YoY", "2.4x QoQ") is checkable EVERY quarter it is reported —
// it is not an open-ended horizon, so a reported shortfall is a real miss, not "interim". Exclude such
// targets from the undated→NYT rule even when the period label ("YoY") carries no fiscal deadline.
const RATE_PERIOD_RE = /\b(?:yoy|qoq|y-o-y|q-o-q|year[-\s]?on[-\s]?year|quarter[-\s]?on[-\s]?quarter)\b/i;

const round = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(d)));
const isISO = (s) => /^\d{4}-\d{2}-\d{2}/.test(String(s || ""));
const blankVar = () => ({ absolute: null, pct: null, bps: null, days: null, text: null });
const tvar = (qtrs, text) => ({ absolute: null, pct: null, bps: null, days: qtrs == null ? null : round(qtrs * 91, 0), text });

/** test_date is in the future relative to the latest reported period. ISO dates compare
 *  directly; a non-ISO horizon ("2030", "FY30", "2HFY27") compares by fiscal period so a
 *  long-dated target stays NYT even after an interim actual shows up. */
export function isFuture(testDate, latestReportedDate, latestReportedPeriod = null) {
  if (!testDate) return false;
  if (isISO(testDate) && isISO(latestReportedDate)) return testDate.slice(0, 10) > latestReportedDate.slice(0, 10);
  const ti = periodIndex(testDate);
  const li = periodIndex(latestReportedPeriod) ?? periodIndex(latestReportedDate);
  if (ti != null && li != null) return ti > li;
  return false; // truly unparseable horizon ("medium term"): rules fall through to NYT on no actual
}

/** test_date provably WITHIN the window: parseable AND not in the future — i.e. a deadline we can
 *  show is due. An unparseable horizon ("medium term", null) returns false (we can't prove it's due),
 *  so it is never treated as a forced/incomplete signal. The exact mirror of isFuture(). */
export function isWithinWindow(testDate, latestReportedDate, latestReportedPeriod = null) {
  if (!testDate) return false;
  if (isISO(testDate) && isISO(latestReportedDate)) return testDate.slice(0, 10) <= latestReportedDate.slice(0, 10);
  const ti = periodIndex(testDate);
  const li = periodIndex(latestReportedPeriod) ?? periodIndex(latestReportedDate);
  if (ti != null && li != null) return ti <= li;
  return false;
}

/** Numeric comparison on the favourable side of the (possibly ranged) target. */
function compareNumeric(category, target, a, tol) {
  const dir = numericDirection(category);
  const ref = dir === "lower" ? (target.hi ?? target.lo) : (target.lo ?? target.hi);
  if (ref == null) return { status: "NYT", variance: { ...blankVar(), text: "no numeric target" } };
  const met = dir === "lower" ? a <= ref : a >= ref;
  const partial = dir === "lower" ? a <= ref * (1 + tol) : a >= ref * (1 - tol);
  const status = met ? "MET" : partial ? "PARTIAL" : "MISSED";
  const absolute = round(a - ref, 3);
  const pct = ref !== 0 ? round(((a - ref) / Math.abs(ref)) * 100, 1) : null;
  const bps = category === "margin" ? round((a - ref) * 100, 0) : null;
  const refTxt = target.op === "range" && target.hi != null ? `${fmtNum(target.lo)}-${fmtNum(target.hi)}` : `${fmtNum(ref)}`;
  return { status, variance: { absolute, pct, bps, days: null, text: `${fmtNum(a)} vs ${refTxt}${target.unit ? " " + target.unit : ""}` } };
}

/** Milestone (timeline) verdict from delivered/slipped wording + named periods. */
function timelineStatus(promise, actual, grace) {
  const promisedIdx =
    maxPeriodIndex([promise.target?.text, promise.metric, promise.promise].filter(Boolean).join(" ")) ??
    periodIndex(promise.test_date);
  const what = String(actual?.what_happened || actual?.text || "");
  if (!actual || !what) return { status: "NYT", variance: { ...blankVar(), text: "no outcome reported" } };

  const negated = NEG_DELIVERY_RE.test(what);
  const delivered = DELIVERED_RE.test(what) && !negated;
  const slipped = SLIPPED_RE.test(what) || negated; // a negated milestone is a non-delivery → treat it as a slip
  const outcomeIdx = maxPeriodIndex(what);

  if (promisedIdx == null) {
    const status = slipped ? "MISSED" : delivered ? "MET" : "NYT";
    return { status, variance: { ...blankVar(), text: what.slice(0, 60) } };
  }
  if (delivered && !slipped) {
    const late = (outcomeIdx ?? promisedIdx) - promisedIdx;
    if (late <= 0) return { status: "MET", variance: tvar(0, "on time") };
    if (late <= grace) return { status: "PARTIAL", variance: tvar(late, `late ~${late} qtr${late > 1 ? "s" : ""}`) };
    return { status: "MISSED", variance: tvar(late, `slipped ~${late} qtrs`) };
  }
  if (slipped) {
    const slip = (outcomeIdx ?? promisedIdx + grace + 1) - promisedIdx;
    if (slip <= 0) return { status: "NYT", variance: { ...blankVar(), text: "re-guided within window" } };
    if (slip <= grace) return { status: "PARTIAL", variance: tvar(slip, `late ~${slip} qtr${slip > 1 ? "s" : ""}`) };
    return { status: "MISSED", variance: tvar(slip, `slipped ~${slip} qtrs`) };
  }
  return { status: "NYT", variance: { ...blankVar(), text: "in progress, not yet due" } };
}

/**
 * @param {object} promise  engine promise (category, target, test_date, revisions[], …)
 * @param {object|null} actual  retrieved actual {value, text, what_happened, source_date}
 * @param {object} ctx  {latestReportedDate, partialTol=0.05, timelineGraceQtrs=1}
 * @returns {{status, variance, was_revised}}
 */
export function statusVariance(promise, actual, ctx = {}) {
  const { latestReportedDate = null, latestReportedPeriod = null, partialTol = 0.05, timelineGraceQtrs = 1 } = ctx;
  const was_revised = Array.isArray(promise.revisions) && promise.revisions.length > 0;

  if (directionFor(promise.category) === "timeline") {
    return { ...timelineStatus(promise, actual, timelineGraceQtrs), was_revised };
  }

  const target = parseTarget(promise.target); // ORIGINAL target (integrity rule)
  let aVal = actual ? actualNumber(actual) : null;
  if (aVal == null) return { status: "NYT", variance: { ...blankVar(), text: actual?.what_happened ? actual.what_happened.slice(0, 60) : "no actual reported" }, was_revised };
  // Reconcile a same-dimension unit-SCALE mismatch (1.5 GW actual vs a 1,500 MW target) before comparing.
  aVal = reconcileScale(aVal, actual?.unit, target.unit);

  // Metric-mismatch guard: if the retrieved actual is reported in a unit dimensionally different
  // from the target's (e.g. an INR-crore interest-savings target vs the USD-billion deleveraging
  // figure the retriever grabbed), the two numbers measure different things — do NOT manufacture a
  // MET/MISSED from an apples-to-oranges comparison. Leave it NYT (unverifiable as retrieved).
  if (unitsIncomparable(target.unit, actual?.unit)) {
    return { status: "NYT", variance: { ...blankVar(), text: `actual in ${actual.unit} not comparable to ${target.unit || "target"}` }, was_revised };
  }

  // Forward-target / in-progress guard: the "actual" is a bare RE-STATED future target or an
  // under-way project ("expected to be commissioned within 3 years as planned", "300 MW under
  // construction, expected COD Mar-2026") — not a reported outcome → NYT, never a self-comparison.
  // A genuine result ("increased 950 MW, exceeding the 700 MW target") carries an unambiguous
  // DELIVERED_PAST verb (or a SETTLEMENT when not in-progress) and is spared, so no hit/miss is hidden.
  const awh = `${actual?.text || ""} ${actual?.what_happened || ""}`;
  const settled = SETTLEMENT_RE.test(awh);
  const inProgress = IN_PROGRESS_RE.test(awh);
  const delivered = DELIVERED_PAST_RE.test(awh.replace(FUTURE_PASSIVE_RE, " ")); // strip future-passive first
  if ((FORWARD_TARGET_RE.test(awh) || inProgress) && !delivered && !(settled && !inProgress)) {
    return { status: "NYT", variance: { ...blankVar(), text: `target reaffirmed / in progress — not yet delivered (${fmtNum(aVal)}${target.unit ? " " + target.unit : ""})` }, was_revised };
  }

  // Future test_date → the figure is interim (e.g. 9M of an annual target) → NYT.
  if (isFuture(promise.test_date, latestReportedDate, latestReportedPeriod)) {
    const ref = numericDirection(promise.category) === "lower" ? (target.hi ?? target.lo) : (target.lo ?? target.hi);
    const txt = ref != null ? `interim ${aVal} (target ${target.op === "range" ? `${target.lo}-${target.hi}` : ref})` : `interim ${aVal}`;
    return { status: "NYT", variance: { ...blankVar(), text: txt }, was_revised };
  }

  const v = compareNumeric(promise.category, target, aVal, partialTol);
  // Undated target ("over the next few years", no concrete deadline) that is NOT already met: you
  // can HIT an undated target early, but you cannot MISS it mid-flight before its horizon arrives.
  // So an interim shortfall stays NYT (to be scored across future calls), never a one-quarter miss —
  // e.g. "$8bn growth capex over the next few years" with $1.3bn spent so far is in progress, not a miss.
  // EXCEPTION: if the reporter explicitly settled it vs the target ("grew 16%, BELOW the 18% target"),
  // OR the target is a per-period rate (YoY/QoQ growth) that is checkable this quarter, that IS a
  // decided outcome for a reported period — respect the verdict, don't hide it as interim.
  const ratePeriod = RATE_PERIOD_RE.test(`${promise.target?.period || ""} ${promise.target?.text || ""} ${promise.metric || ""} ${promise.promise || ""}`);
  if (v.status !== "MET" && !hasDeadline(promise) && !settled && !ratePeriod) {
    return { status: "NYT", variance: { ...blankVar(), text: `undated target — interim ${fmtNum(aVal)}${target.unit ? " " + target.unit : ""}` }, was_revised };
  }
  return { status: v.status, variance: v.variance, was_revised };
}
