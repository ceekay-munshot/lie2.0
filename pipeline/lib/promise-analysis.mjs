/**
 * promise-analysis.mjs — deterministic, post-verification ANALYSIS that turns a flat list of
 * scored promises into the credibility signals that actually matter (the "where credibility shows"
 * layer). Pure & unit-tested; runs on ANY ledger (no LLM), so it also backfills existing ones.
 *
 * Three things the single-shot verifier can't see on its own:
 *   1. TIER (materiality) — a binary physical/financial outcome (commissioning, capex, deleverage)
 *      is far higher-signal than a soft medium-term aspiration. Weight the score by it.
 *   2. TRAJECTORY — link the SAME target across quarters (the extractor's dedup is imperfect, so a
 *      repeated target shows up as several rows; we re-link them here by subject) and read the arc:
 *      reiterated, drifted (Q2→H2→next-year), or QUIETLY DROPPED — a loud target that just vanishes
 *      is the single strongest red flag.
 *   3. SIGNALS — sandbagging (chronic wide beats = a soft bar), and miss attribution (owned vs
 *      repeated vague-external blame).
 */
import { periodIndex, maxPeriodIndex } from "./fiscal.mjs";
import { isWithinWindow } from "./status-variance.mjs";
import { hasDeadline } from "./metric-direction.mjs";
export { hasDeadline };

/* ---------------- tier (materiality) ---------------- */
// Tier 1 — binary physical/financial outcomes, hardest to fudge. Tier 2 — financial guidance.
// Tier 3 — medium-term/soft, or ANYTHING without a concrete deadline (an undated "promise" can't
// be a hard commitment). Env-tunable weights; Tier-1 dominates, Tier-3 is discounted.
const TIER1 = new Set(["timeline", "capacity", "capex", "leverage", "capital_allocation"]);
const TIER2 = new Set(["revenue", "ebitda", "margin", "pat", "volume", "orderbook", "cost", "roce"]);
const _num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const TIER_W = { 1: _num(process.env.TIER1_W, 1.4), 2: _num(process.env.TIER2_W, 1.0), 3: _num(process.env.TIER3_W, 0.6) };
export const tierWeight = (t) => TIER_W[t] ?? 1.0;

/** Materiality tier 1/2/3 for a promise (deterministic from category + deadline concreteness). */
export function tierFor(p) {
  if (!hasDeadline(p)) return 3;             // undated → soft, regardless of category
  if (TIER1.has(p.category)) return 1;
  if (TIER2.has(p.category)) return 2;
  return 3;
}

/* ---------------- miss attribution ---------------- */
const EXTERNAL = new Set(["Demand slowdown", "Pricing / mix", "Cost inflation", "Supply chain", "Regulatory"]);
const OWNED = new Set(["Execution", "Capacity delay", "Working capital", "Capital allocation"]);
/** Classify a root-cause as owned (management's own execution) vs external (blamed on the world). */
export const attributionOf = (rootCause) => (EXTERNAL.has(rootCause) ? "external" : OWNED.has(rootCause) ? "owned" : null);

/* ---------------- subject linking (same target across quarters) ---------------- */
// Grammar + metric BOILERPLATE that is shared by unrelated targets ("achieve X production of Y")
// — excluded from the signature so the DISTINCTIVE nouns (alumina, silver, Ghogharpalli) drive the
// match and two different products don't fuse just because both say "production ... million tonnes".
const STOP = new Set((
  "the a an of to in on for and or by with our we will be at is are from as into over about within this that these those " +
  "company management year quarter their its per approximately around under achieve achieving deliver delivering reach reaching " +
  "target targets guidance guide commit committed commitment production produce output volume capacity capex spend invest investment " +
  "million billion thousand lakh crore tonne tonnes tons mtpa mt kt bn mn cr rs inr usd percent margin growth rate about approx expected " +
  "fy25 fy26 fy27 fy28 fy29 fy30 q1 q2 q3 q4 h1 h2 near term medium long next few coming later plan plans planned"
).split(/\s+/));
/** Content-token signature of a promise's SUBJECT (metric + paraphrase), for cross-quarter linking. */
export function subjectSig(p) {
  const text = `${p.metric || ""} ${p.promise || ""}`.toLowerCase();
  const toks = text.replace(/[^a-z0-9%$/ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w));
  return new Set(toks);
}
function jaccard(a, b) { let inter = 0; for (const x of a) if (b.has(x)) inter++; const uni = a.size + b.size - inter; return uni ? inter / uni : 0; }
function sharedCount(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return n; }
// two mentions of the SAME target carry compatible target NUMBERS; distinct targets (2.3 Mt alumina
// vs 5.5 Mt iron ore) do not. Unknown/absent numbers don't block a match.
function numCompatible(a, b) {
  const va = Number(a.target?.value), vb = Number(b.target?.value);
  if (!Number.isFinite(va) || !Number.isFinite(vb) || va === 0 || vb === 0) return true;
  return Math.max(Math.abs(va), Math.abs(vb)) / Math.min(Math.abs(va), Math.abs(vb)) <= 1.5;
}

const LINK_TOL = _num(process.env.LINK_JACCARD, 0.6);
/** Cluster promises that are the SAME underlying target restated across quarters (same category,
 *  ≥2 shared distinctive tokens, high overlap, compatible target numbers). Conservative — it
 *  errs toward keeping distinct targets separate rather than fusing them. */
export function linkGroups(promises) {
  const sigs = promises.map(subjectSig);
  const assigned = new Array(promises.length).fill(-1);
  const groups = [];
  for (let i = 0; i < promises.length; i++) {
    if (assigned[i] >= 0) continue;
    const idxs = [i];
    assigned[i] = groups.length;
    for (let j = i + 1; j < promises.length; j++) {
      if (assigned[j] >= 0 || promises[j].category !== promises[i].category) continue;
      if (sharedCount(sigs[i], sigs[j]) >= 2 && jaccard(sigs[i], sigs[j]) >= LINK_TOL && numCompatible(promises[i], promises[j])) {
        idxs.push(j); assigned[j] = groups.length;
      }
    }
    groups.push(idxs);
  }
  return groups;
}

/* ---------------- duplicate collapse (the SAME promise restated) ---------------- */
// The extractor emits one commitment several times — the identical target reaffirmed across quarters
// (CESC "300 MW solar by Q4FY26" in Q3FY25, Q4FY25, Q1FY26), or two near-identical rows for one promise
// — which inflates the ledger and gives a single promise several verdicts. Collapse a cluster to ONE
// row ONLY when it is unambiguously the SAME promise: same category, same subject (≥2 shared distinctive
// tokens + high overlap), the SAME target VALUE, and the SAME deadline PERIOD. Distinct look-alikes that
// differ in value or period — Project-2 (Q3FY27) vs Project-3 (Q4FY27), 300 MW vs 450 MW, Train-1 vs
// Train-2 — are ALWAYS kept separate, so real promises are never destroyed.
const sameValue = (a, b) => {
  const va = Number(a.target?.value), vb = Number(b.target?.value);
  if (!Number.isFinite(va) && !Number.isFinite(vb)) return true;   // both unspecified → same
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return false;  // one specified, one not → differ
  if (va === 0 || vb === 0) return va === vb;
  return Math.max(Math.abs(va), Math.abs(vb)) / Math.min(Math.abs(va), Math.abs(vb)) <= 1.02;
};
const samePeriod = (a, b) => {
  const pa = a.target?.period ?? a.test_date ?? "", pb = b.target?.period ?? b.test_date ?? "";
  const ia = periodIndex(pa), ib = periodIndex(pb);
  if (ia != null && ib != null) return ia === ib;                                 // same fiscal deadline
  return String(pa).trim().toLowerCase() === String(pb).trim().toLowerCase();     // else identical text
};
const STATUS_RANK = { MISSED: 4, PARTIAL: 3, MET: 2, NYT: 1 };
/** The representative of a true-duplicate cluster: most-resolved verdict, then the row carrying an
 *  actual, then the latest quarter — so no real outcome is lost when duplicates merge. */
function pickRepresentative(rows) {
  return [...rows].sort((a, b) =>
    ((STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0)) ||
    ((b.actual ? 1 : 0) - (a.actual ? 1 : 0)) ||
    ((periodIndex(b.quarter_context) ?? 0) - (periodIndex(a.quarter_context) ?? 0)))[0];
}
/** Collapse exact-restatement duplicates to one row each (criteria above). Returns a fresh, shorter
 *  list; the survivor's `mentions` reflects how many distinct quarters the promise was raised in. */
export function collapseDuplicates(promises) {
  const sigs = promises.map(subjectSig);
  const used = new Array(promises.length).fill(false);
  const out = [];
  for (let i = 0; i < promises.length; i++) {
    if (used[i]) continue;
    const cluster = [promises[i]]; used[i] = true;
    for (let j = i + 1; j < promises.length; j++) {
      if (used[j] || promises[j].category !== promises[i].category) continue;
      if (sharedCount(sigs[i], sigs[j]) >= 2 && jaccard(sigs[i], sigs[j]) >= LINK_TOL && sameValue(promises[i], promises[j]) && samePeriod(promises[i], promises[j])) {
        cluster.push(promises[j]); used[j] = true;
      }
    }
    if (cluster.length === 1) { out.push(promises[i]); continue; }
    const rep = pickRepresentative(cluster);
    const quarters = new Set(cluster.map((r) => r.quarter_context).filter(Boolean));
    out.push({ ...rep, mentions: Math.max(rep.mentions || 1, quarters.size) });
  }
  return out;
}

/* ---------------- routine debt-servicing (a non-promise) ---------------- */
// Repaying a specific facility on its contractual due date ("pay the $417m Sumangal payment in
// December as scheduled", "the entire ICL 350m will be paid on time") is a CONTRACTUAL FACT, not a
// discretionary forward commitment — it should never have been extracted as a promise (the P4 rubric
// rejects it, but a mini-class model occasionally slips one through). This deterministic backstop
// drops it. It is deliberately CONSERVATIVE: it fires only on (servicing verb + debt instrument +
// an on-schedule/on-time marker) AND never when the row is a genuine DELEVERAGING TARGET (reduce /
// bring down / net-debt to a level) — so "reduce VRL debt from $4.4bn to $3bn" is always kept.
const DELEVERAGE = /\b(?:reduc\w*|cut\w*|lower\w*|bring\w*\s+(?:it\s+)?down|go(?:es|ing)?\s+down|come\s+down|deleverag\w*|de[-\s]?gear\w*|net[-\s]?debt|leverage)\b/i;
const DEBT_SERVICE = /\b(?:repay\w*|pay\w*|settl\w*|clear\w*|servic\w*|honou?r\w*|meet\w*)\b[\s\w,$.()\-]{0,40}?\b(?:debt|loan|borrowing|bond|ncd|icl|inter[-\s]?corporate|instal\w*|liabilit\w*|dues?|maturit\w*|payment|obligation|principal)\b/i;
const ON_SCHEDULE = /\b(?:as\s+scheduled|on\s+time|on\s+schedule|scheduled\s+payment|per\s+schedule|as\s+per|when\s+due|is\s+due|are\s+due|on\s+maturity|by\s+maturity|contractual|intend\s+to\s+pay)\b/i;
/** True when a row is a routine debt-servicing obligation (repaying a facility on its due date),
 *  not a discretionary commitment — so it can be dropped from the ledger. */
export function isDebtServicing(p) {
  const t = `${p.promise || ""} ${p.quote || ""} ${p.metric || ""}`;
  if (DELEVERAGE.test(t)) return false;               // a real deleveraging TARGET — keep
  return DEBT_SERVICE.test(t) && ON_SCHEDULE.test(t); // servicing a facility on schedule — drop
}

/* ---------------- the analysis pass ---------------- */
const DROP_GAP = _num(process.env.DROP_GAP_QTRS, 2);   // quarters of silence before a prominent target reads as dropped
const SANDBAG_PCT = _num(process.env.SANDBAG_PCT, 20);  // a MET beating its target by ≥ this % is a "wide beat"
const SANDBAG_SHARE = _num(process.env.SANDBAG_SHARE, 0.5);

/**
 * Enrich each promise with { tier, link_id, mentions, dropped?, slippage_path? } and return a
 * ledger-level `signals` summary. Non-mutating (returns fresh promise objects).
 */
export function analyzeLedger(ledger = {}) {
  // Clean the row set BEFORE scoring, so aggregates/credibility count each real commitment ONCE:
  //   1. drop routine debt-servicing non-promises (a contractual repayment on its due date), then
  //   2. collapse exact-restatement duplicates (the same target reaffirmed across quarters).
  const deduped = collapseDuplicates((ledger.promises || []).filter((p) => !isDebtServicing(p)));
  const promises = deduped.map((p) => ({ ...p }));
  const vw = ledger.verification_window || {};
  const windowIdx = periodIndex(vw.latest_reported);

  for (const p of promises) p.tier = tierFor(p);

  const groups = linkGroups(promises);
  const drift = [];
  let dropped = 0;
  groups.forEach((idxs, gi) => {
    const rows = idxs.map((i) => promises[i]).sort((a, b) => (periodIndex(a.quarter_context) ?? 0) - (periodIndex(b.quarter_context) ?? 0));
    const mentions = new Set(rows.map((r) => r.quarter_context).filter(Boolean)).size; // DISTINCT quarters raised in
    const lastMentionIdx = Math.max(...rows.map((r) => periodIndex(r.quarter_context) ?? -Infinity));
    for (const r of rows) { r.link_id = gi + 1; r.mentions = Math.max(mentions, r.mentions || 1); }

    // QUIET DROP — the single strongest red flag: a target management REAFFIRMED across ≥2 quarters
    // (it was "loud"), whose DEADLINE is provably DUE within the window, that they then went silent
    // on for ≥DROP_GAP quarters and never reported an outcome (all mentions still NYT). A one-off or
    // a future-dated target is NOT a quiet drop (the former was never loud; the latter isn't due).
    const prominent = mentions >= 2;
    const allNyt = rows.every((r) => (r.status || "NYT") === "NYT");
    const due = rows.some((r) => isWithinWindow(r.test_date, vw.latest_reported_date, vw.latest_reported));
    const gap = windowIdx != null && Number.isFinite(lastMentionIdx) ? windowIdx - lastMentionIdx : 0;
    if (prominent && allNyt && due && gap >= DROP_GAP) { rows[rows.length - 1].dropped = true; dropped += 1; }

    // SLIPPAGE VECTOR — the target's stated period drifted across mentions (Q2 → H2 → next year).
    const path = [...new Set(rows.map((r) => r.target?.period).filter(Boolean))];
    if (path.length > 1) { rows[rows.length - 1].slippage_path = path; drift.push({ subject: rows[0].promise, path }); }
  });

  // SANDBAGGING — chronic wide beats on guidance metrics = a conservative bar, not skill.
  const guided = promises.filter((p) => p.status === "MET" && p.variance?.pct != null && ["revenue", "margin", "ebitda", "volume", "pat"].includes(p.category));
  const wideBeats = guided.filter((p) => Math.abs(Number(p.variance.pct)) >= SANDBAG_PCT);
  const sandbagging = guided.length >= 4 && wideBeats.length / guided.length >= SANDBAG_SHARE;

  // MISS ATTRIBUTION — of the misses that carry a root cause, how many are blamed on the world.
  const withCause = promises.filter((p) => (p.status === "MISSED" || p.status === "PARTIAL") && p.root_cause);
  let owned = 0, external = 0;
  for (const p of withCause) { const a = attributionOf(p.root_cause); if (a === "owned") owned += 1; else if (a === "external") external += 1; }
  const externalShare = owned + external ? external / (owned + external) : null;

  // tier mix over testable promises
  const testable = promises.filter((p) => p.status && p.status !== "NYT");
  const tierMix = { 1: 0, 2: 0, 3: 0 };
  for (const p of testable) tierMix[p.tier] = (tierMix[p.tier] || 0) + 1;

  const signals = {
    tier_mix: tierMix,
    dropped,
    slippage_vectors: drift.length,
    sandbagging: sandbagging ? { wide_beats: wideBeats.length, of_guided: guided.length } : null,
    attribution: withCause.length ? { owned, external, external_share: externalShare != null ? Math.round(externalShare * 100) / 100 : null } : null,
  };
  return { promises, signals };
}
