/**
 * dedup.mjs — collapse the ensemble's raw promises into one canonical row per
 * commitment, and track how a commitment evolves across quarters.
 *
 *   key            = category + normalized(metric) + normalized(period)
 *   canonical      = the earliest-dated occurrence (where it was first promised)
 *   found_by       = the distinct models that produced this key in the canonical
 *                    document (≥2 ⇒ cross-model agreement)
 *   reaffirmed_on  = later documents that repeat the SAME target
 *   revisions      = later documents that CHANGE the target → {date, target}
 *
 * Union keeps single-model promises (quote grounding already filters
 * hallucinations). ids p001… assigned after dedup, ordered by date then category.
 */
const CONF_RANK = { H: 3, M: 2, L: 1 };

// Filler/comparison/scale words dropped from the metric to leave just the topic.
const FILLER = new Set(
  ("of to by the a an in at on for and or more than less greater above below about " +
    "approximately around over under roughly target guidance exit run rate runrate vs " +
    "versus range between usd inr rs bn mn billion million cr crore dollar dollars rupees " +
    "approx upto up down level levels reach reaching achieve achieving consol consolidated " +
    // descriptive words models add that aren't part of the commitment's subject
    "narrowed narrow enhanced revised updated raised lowered new annual full year half " +
    "total overall group company india indian near medium long term plan planned expected " +
    "likely guided guide remain remains continue close closing")
    .split(" "),
);

const normUnit = (s) =>
  String(s || "").toLowerCase().replace(/\bbillion\b/g, "bn").replace(/\bmillion\b/g, "mn").replace(/[^a-z0-9%]/g, "");

const normPeriod = (s) => String(s || "").toLowerCase().replace(/['’\s]/g, "");

/**
 * The commitment's SUBJECT: category + period + topic words (numbers, currency,
 * comparison/scale filler, and period tokens removed). Stable across phrasing
 * ("$6bn" vs "more than $6 billion") AND across target changes, so the same
 * commitment merges cross-model and can be tracked quarter-to-quarter.
 */
function metricSubject(metric) {
  return String(metric || "")
    .toLowerCase()
    .replace(/q[1-4]\s*fy\s*'?\d{2}/g, " ")
    .replace(/\bfy\s*'?\d{2,4}\b/g, " ")
    .replace(/[0-9][0-9,.\-/]*/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .sort()
    .join(" ");
}

const keyOf = (p) => `${p.category}|${normPeriod(p.target?.period)}|${metricSubject(p.metric)}`;

/** A signature for a target so "same vs changed" can be compared across quarters. */
function targetSig(t) {
  if (!t) return "";
  if (t.value != null || t.value_high != null) {
    return `${t.value ?? ""}|${t.value_high ?? ""}|${normUnit(t.unit)}`;
  }
  return String(t.text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function dateTs(d) {
  if (!d) return Infinity;
  const t = Date.parse(d);
  if (!Number.isNaN(t)) return t;
  // tolerate "31 Oct 2025"
  const m = String(d).match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (m) {
    const t2 = Date.parse(`${m[2]} ${m[1]}, ${m[3]}`);
    if (!Number.isNaN(t2)) return t2;
  }
  return Infinity;
}

/** Best representative among a set: prefer grounded quote, then confidence, then longer quote. */
function pickBest(arr) {
  return arr.slice().sort((a, b) => {
    const g = (b.quote_grounded ? 1 : 0) - (a.quote_grounded ? 1 : 0);
    if (g) return g;
    const c = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
    if (c) return c;
    return (b.quote || "").length - (a.quote || "").length;
  })[0];
}

const strip = ({ _ts, ...rest }) => rest;

/**
 * @param {Array} promises  grounded, model-tagged promises (each with source_id,
 *                          date, model, category, metric, target, quote, …)
 * @returns {Array} canonical promises with found_by / reaffirmed_on / revisions / id
 */
export function dedup(promises) {
  const items = promises.map((p) => ({ ...p, _ts: dateTs(p.date) }));
  const groups = new Map();
  for (const p of items) {
    const k = keyOf(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const out = [];
  for (const grp of groups.values()) {
    grp.sort((a, b) => a._ts - b._ts);
    const docOrder = [...new Set(grp.map((p) => p.source_id))]; // earliest doc first
    const canonicalDoc = docOrder[0];
    const canonGrp = grp.filter((p) => p.source_id === canonicalDoc);
    const canonical = pickBest(canonGrp);
    const found_by = [...new Set(canonGrp.map((p) => p.model).filter(Boolean))].sort();
    const canonSig = targetSig(canonical.target);

    const reaffirmed_on = [];
    const revisions = [];
    for (const docId of docOrder.slice(1)) {
      const rep = pickBest(grp.filter((p) => p.source_id === docId));
      const sig = targetSig(rep.target);
      if (sig && canonSig && sig === canonSig) reaffirmed_on.push(rep.date);
      else revisions.push({ date: rep.date, target: rep.target });
    }

    out.push({ ...strip(canonical), found_by, reaffirmed_on, revisions });
  }

  out.sort(
    (a, b) =>
      dateTs(a.date) - dateTs(b.date) ||
      String(a.category).localeCompare(String(b.category)) ||
      String(a.metric).localeCompare(String(b.metric)),
  );
  out.forEach((p, i) => (p.id = `p${String(i + 1).padStart(3, "0")}`));
  return out;
}

/** The set of topic tokens for a metric (used by the recall eval's fuzzy match). */
export function subjectTokens(metric) {
  return new Set(metricSubject(metric).split(" ").filter(Boolean));
}

export { keyOf, targetSig, metricSubject, normPeriod };
