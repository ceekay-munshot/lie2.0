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
// Coverage-aware shrinkage — a thin testable base must not earn a confident extreme
// score (INFY was 15/15 MET → a bogus 100). Blend the observed confidence-weighted rate
// with a neutral PRIOR, weighted by K pseudo-observations: a large sample barely moves,
// a thin one pulls toward the prior and firms up as more promises come due. Env-tunable.
const _num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const PRIOR_RATE = Math.min(1, Math.max(0, _num(process.env.CRED_PRIOR_RATE, 0.5)));
const PRIOR_K = Math.max(0, _num(process.env.CRED_PRIOR_K, 10));
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

/**
 * Confidence-weighted delivery rate over a subset, shrunk toward the neutral prior;
 * rounded 0-100, or null if the subset is empty (nothing testable → score pending).
 * Shrinkage: score = 100 × (Σ(conf×outcome) + K·prior) / (Σconf + K). At Σconf ≫ K the
 * observed rate dominates; at a thin Σconf it pulls toward the prior — so neither a
 * perfect nor a rock-bottom score is handed out on a handful of promises.
 *
 * `extraPrior` adds pseudo-observations at the neutral prior on TOP of K — used to fold in
 * unresolved-due promises (see credibility): each one is a genuine unknown, so it widens the
 * shrinkage and pulls a thinly-verified, one-sided ledger back toward neutral.
 */
function weightedScore(subset, extraPrior = 0) {
  let num = 0, den = 0;
  for (const p of subset) {
    const w = CONF_W[p.confidence] ?? 0.8;
    num += w * (OUTCOME_W[p.status] ?? 0);
    den += w;
  }
  if (!den) return null;
  const K = PRIOR_K + Math.max(0, Number(extraPrior) || 0);
  return Math.round((100 * (num + K * PRIOR_RATE)) / (den + K));
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

export function credibility(promises = [], aggregates = null, opts = {}) {
  const agg = aggregates || aggregate(promises);
  const testable = promises.filter((p) => p.status && p.status !== "NYT");
  // Unresolved-due promises — those that came due WITHIN the verification window but for which
  // retrieval could not confirm an actual (provenance.forced_nyt) — are genuine unknowns, not
  // clean passes. Fold each in as ONE neutral pseudo-observation so a thinly-verified, one-sided
  // ledger (e.g. INFY: 15/15 MET but 7 due-yet-unverified → a spurious grade A that outranks
  // better-documented companies) is pulled back toward the prior until those promises are actually
  // verified. This makes the score coverage-aware in the VERIFICATION dimension, complementing the
  // sample-size shrinkage. The penalty is apportioned to the delivery/timeline sub-scores by their
  // testable share so the split stays consistent with the headline.
  const forcedNyt = Math.max(0, Number(opts.forcedNyt) || 0);
  const tl = testable.filter((p) => directionFor(p.category) === "timeline");
  const dl = testable.filter((p) => directionFor(p.category) !== "timeline");
  const tlShare = testable.length ? tl.length / testable.length : 0;
  const score = weightedScore(testable, forcedNyt);
  const timeline_score = weightedScore(tl, forcedNyt * tlShare);
  const delivery_score = weightedScore(dl, forcedNyt * (1 - tlShare));
  return {
    score,
    grade: gradeFromScore(score),
    timeline_score,
    delivery_score,
    method: `Confidence-weighted delivery rate over testable promises (MET=1, PARTIAL=0.5, MISSED=0; H=1.0,M=0.8,L=0.6), shrunk toward a neutral ${Math.round(PRIOR_RATE * 100)} prior by ${PRIOR_K} pseudo-observations (plus one per due-but-unverified promise) so neither a thin testable base nor a one-sided, thinly-retrieved ledger earns a confident extreme score. Bands A>=75 B>=60 C>=45 D>=30 E<30.`,
    headline: buildHeadline(agg),
  };
}
