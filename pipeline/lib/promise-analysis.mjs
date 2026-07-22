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

/* ---------------- tier (materiality) ---------------- */
// Tier 1 — binary physical/financial outcomes, hardest to fudge. Tier 2 — financial guidance.
// Tier 3 — medium-term/soft, or ANYTHING without a concrete deadline (an undated "promise" can't
// be a hard commitment). Env-tunable weights; Tier-1 dominates, Tier-3 is discounted.
const TIER1 = new Set(["timeline", "capacity", "capex", "leverage", "capital_allocation"]);
const TIER2 = new Set(["revenue", "ebitda", "margin", "pat", "volume", "orderbook", "cost", "roce"]);
const VAGUE_PERIOD = /medium[-\s]?term|near[-\s]?term|long[-\s]?term|next few|coming years|later years|over the (?:years|medium|coming)|in due course|going forward|steady[-\s]?state|over time|subsequent years|in time/i;
const _num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const TIER_W = { 1: _num(process.env.TIER1_W, 1.4), 2: _num(process.env.TIER2_W, 1.0), 3: _num(process.env.TIER3_W, 0.6) };
export const tierWeight = (t) => TIER_W[t] ?? 1.0;

/** Does the promise carry a concrete, checkable deadline (not "medium term" / null)? */
export function hasDeadline(p) {
  const period = String(p.target?.period ?? p.test_date ?? "");
  if (!period || VAGUE_PERIOD.test(period)) {
    // still allow a dated milestone embedded in the wording ("commission by FY27")
    return maxPeriodIndex([p.target?.text, p.metric, p.promise].filter(Boolean).join(" ")) != null;
  }
  if (periodIndex(period) != null) return true;
  return maxPeriodIndex([p.target?.text, p.metric, p.promise].filter(Boolean).join(" ")) != null;
}

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

/* ---------------- the analysis pass ---------------- */
const DROP_GAP = _num(process.env.DROP_GAP_QTRS, 2);   // quarters of silence before a prominent target reads as dropped
const SANDBAG_PCT = _num(process.env.SANDBAG_PCT, 20);  // a MET beating its target by ≥ this % is a "wide beat"
const SANDBAG_SHARE = _num(process.env.SANDBAG_SHARE, 0.5);

/**
 * Enrich each promise with { tier, link_id, mentions, dropped?, slippage_path? } and return a
 * ledger-level `signals` summary. Non-mutating (returns fresh promise objects).
 */
export function analyzeLedger(ledger = {}) {
  const promises = (ledger.promises || []).map((p) => ({ ...p }));
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
    for (const r of rows) { r.link_id = gi + 1; r.mentions = mentions; }

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
