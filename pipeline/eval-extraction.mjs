/**
 * eval-extraction.mjs — measure recall of extracted promises against a committed
 * golden fixture (public/data/companies/<ticker>.json). Matching is fuzzy:
 * category must match, the metric's topic tokens must overlap (Jaccard), and the
 * periods must be compatible. Reports recall + what was missed / extra.
 *
 * Used by extract.mjs (auto when a fixture exists) and runnable standalone.
 */
import { subjectTokens, normPeriod } from "./lib/dedup.mjs";

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * @param {Array} extracted  extracted promises ({category, metric, target})
 * @param {object} fixture    golden company ledger
 * @param {{minSubject?:number}} opts
 */
export function evalExtraction(extracted, fixture, { minSubject = 0.34 } = {}) {
  const known = fixture.promises || [];
  const ex = extracted.map((p) => ({
    category: p.category,
    metric: p.metric,
    _sub: subjectTokens(p.metric),
    _per: normPeriod(p.target?.period),
  }));
  const used = new Set();
  const missed = [];
  let found = 0;

  for (const k of known) {
    const ksub = subjectTokens(k.metric);
    const kper = normPeriod(k.target?.period);
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < ex.length; i++) {
      if (used.has(i)) continue;
      const e = ex[i];
      if (e.category !== k.category) continue;
      const s = jaccard(ksub, e._sub);
      const periodOk = !kper || !e._per || kper === e._per || s >= 0.5;
      if (s >= minSubject && periodOk && s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (best != null) {
      used.add(best);
      found += 1;
    } else {
      missed.push({ id: k.id, category: k.category, metric: k.metric, period: k.target?.period ?? null });
    }
  }

  const extra = ex
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !used.has(i))
    .map(({ e }) => ({ category: e.category, metric: e.metric }));

  return {
    fixture: fixture.company?.ticker || null,
    known: known.length,
    found,
    recall: known.length ? Number((found / known.length).toFixed(3)) : 0,
    missed,
    extra,
  };
}
