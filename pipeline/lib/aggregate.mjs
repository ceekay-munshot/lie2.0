/**
 * aggregate.mjs (deterministic) — roll the verified promises up into `aggregates`
 * and the `credibility` score/grade. Pure: reproducible from the promise statuses.
 *
 * Credibility = confidence-weighted delivery rate over TESTABLE (non-NYT) promises:
 *   outcome  MET=1, PARTIAL=0.5, MISSED=0   ·   confidence  H=1.0, M=0.8, L=0.6
 *   score = 100 × Σ(conf×outcome)/Σ(conf)   ·   bands  A≥75 B≥60 C≥45 D≥30 E<30
 */
import { directionFor } from "./metric-direction.mjs";

const CONF_W = { H: 1.0, M: 0.8, L: 0.6 };
const OUTCOME_W = { MET: 1, PARTIAL: 0.5, MISSED: 0 };
const BANDS = [[75, "A"], [60, "B"], [45, "C"], [30, "D"], [0, "E"]];
export const gradeFromScore = (s) => (s == null ? null : (BANDS.find(([t]) => s >= t) || [, "E"])[1]);

const zeroCounts = () => ({ MET: 0, PARTIAL: 0, MISSED: 0, NYT: 0 });

export function aggregate(promises = []) {
  const status_counts = zeroCounts();
  const by_quarter = {};
  const root_causes = {};
  const confidence_mix = { H: 0, M: 0, L: 0 };
  let due = 0, on_time = 0, slipped = 0;

  for (const p of promises) {
    const st = p.status || "NYT";
    status_counts[st] = (status_counts[st] || 0) + 1;
    const q = p.quarter_context || "?";
    (by_quarter[q] ||= zeroCounts())[st] += 1;
    if (p.root_cause) root_causes[p.root_cause] = (root_causes[p.root_cause] || 0) + 1;
    if (confidence_mix[p.confidence] != null) confidence_mix[p.confidence] += 1;
    if (directionFor(p.category) === "timeline" && st !== "NYT") {
      due += 1;
      if (st === "MET") on_time += 1;
      else slipped += 1;
    }
  }
  const testable = status_counts.MET + status_counts.PARTIAL + status_counts.MISSED;
  return {
    total: promises.length,
    status_counts,
    testable,
    by_quarter,
    root_causes,
    confidence_mix,
    timeline_commitments: { due, on_time, slipped },
  };
}

/** Confidence-weighted delivery rate over a subset; rounded 0-100 or null if empty. */
function weightedScore(subset) {
  let num = 0, den = 0;
  for (const p of subset) {
    const w = CONF_W[p.confidence] ?? 0.8;
    num += w * (OUTCOME_W[p.status] ?? 0);
    den += w;
  }
  return den ? Math.round((100 * num) / den) : null;
}

/** Deterministic headline from the numbers — never invents figures. */
function buildHeadline(agg) {
  const sc = agg.status_counts;
  const t = agg.testable;
  if (!t) return `No promises testable yet — ${sc.NYT} target${sc.NYT === 1 ? "" : "s"} still ahead.`;
  const rate = (sc.MET + 0.5 * sc.PARTIAL) / t;
  const lead = rate >= 0.6 ? "Mostly delivered on testable promises" : rate >= 0.4 ? "A mixed delivery record" : "Most already-testable promises missed";
  const topRoot = Object.entries(agg.root_causes).sort((a, b) => b[1] - a[1])[0];
  const cause = topRoot ? ` — chiefly ${topRoot[0].toLowerCase()}` : "";
  const nyt = sc.NYT ? `; ${sc.NYT} later target${sc.NYT === 1 ? "" : "s"} still not yet testable` : "";
  return `${lead}${cause}${nyt}.`;
}

export function credibility(promises = [], aggregates = null) {
  const agg = aggregates || aggregate(promises);
  const testable = promises.filter((p) => p.status && p.status !== "NYT");
  const score = weightedScore(testable);
  const timeline_score = weightedScore(testable.filter((p) => directionFor(p.category) === "timeline"));
  const delivery_score = weightedScore(testable.filter((p) => directionFor(p.category) !== "timeline"));
  return {
    score,
    grade: gradeFromScore(score),
    timeline_score,
    delivery_score,
    method: "Conf-weighted delivery rate over testable promises (MET=1, PARTIAL=0.5, MISSED=0; H=1.0,M=0.8,L=0.6). Bands A>=75 B>=60 C>=45 D>=30 E<30.",
    headline: buildHeadline(agg),
  };
}
