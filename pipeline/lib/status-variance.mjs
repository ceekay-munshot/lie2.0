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
import { directionFor, numericDirection, parseTarget, actualNumber } from "./metric-direction.mjs";
import { maxPeriodIndex, periodIndex } from "./fiscal.mjs";

const DELIVERED_RE = /\b(commission\w*|complet\w*|\blive\b|operational|on stream|started?|begun|began|achiev\w*|delivered|first oil|first production|ramp(?:ed|ing|-?up)?|in operation|done)\b/i;
const SLIPPED_RE = /\b(re-?set\w*|re-?guid\w*|push\w*|defer\w*|delay\w*|slip\w*|moved? to|now expect\w*|re-?schedul\w*|postpon\w*|behind schedule)\b/i;
// Negated delivery ("not commissioned", "yet to be completed", "failed to deliver"):
// a delivery verb within a short span of a negator — must NOT read as delivered.
const NEG_DELIVERY_RE = /\b(?:not|yet to|unable to|failed to|behind schedule|no longer|won'?t|will not|did\s?n'?t|have\s?n'?t|has\s?n'?t)\b[\s\w-]{0,18}?(?:commission|complet|operational|deliver|achiev|start|\blive\b|on\s?stream|done|ramp|first oil|first production)/i;

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
  const refTxt = target.op === "range" && target.hi != null ? `${target.lo}-${target.hi}` : `${ref}`;
  return { status, variance: { absolute, pct, bps, days: null, text: `${a} vs ${refTxt}${target.unit ? " " + target.unit : ""}` } };
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
  const aVal = actual ? actualNumber(actual) : null;
  if (aVal == null) return { status: "NYT", variance: { ...blankVar(), text: actual?.what_happened ? actual.what_happened.slice(0, 60) : "no actual reported" }, was_revised };

  // Future test_date → the figure is interim (e.g. 9M of an annual target) → NYT.
  if (isFuture(promise.test_date, latestReportedDate, latestReportedPeriod)) {
    const ref = numericDirection(promise.category) === "lower" ? (target.hi ?? target.lo) : (target.lo ?? target.hi);
    const txt = ref != null ? `interim ${aVal} (target ${target.op === "range" ? `${target.lo}-${target.hi}` : ref})` : `interim ${aVal}`;
    return { status: "NYT", variance: { ...blankVar(), text: txt }, was_revised };
  }

  const v = compareNumeric(promise.category, target, aVal, partialTol);
  return { status: v.status, variance: v.variance, was_revised };
}
