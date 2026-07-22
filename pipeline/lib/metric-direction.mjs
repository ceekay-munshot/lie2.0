/**
 * metric-direction.mjs — GENERIC, category-keyed rules for which way a metric is
 * "good", plus parsing a target/actual/period into comparable numbers. NO company,
 * sector, ticker, or metric-name hardcoding: the only inputs are the schema
 * `category` and the target text/values. Pure & deterministic (unit-tested).
 */

// higher = bigger is better · lower = smaller is better · timeline = a dated
// milestone · target = delivered-vs-planned (treated like "higher": delivering at
// or beyond the planned figure is the win, under-delivery is the miss).
export const DIRECTION = {
  revenue: "higher", ebitda: "higher", margin: "higher", pat: "higher",
  roce: "higher", volume: "higher", orderbook: "higher",
  cost: "lower", leverage: "lower", working_capital: "lower",
  timeline: "timeline",
  capex: "target", capacity: "target", capital_allocation: "target", other: "target",
};
export const directionFor = (category) => DIRECTION[category] || "target";
/** Collapse to the comparison direction used by the numeric rules. */
export const numericDirection = (category) => (directionFor(category) === "lower" ? "lower" : "higher");

/** All signed decimals in a string (commas stripped), as numbers. */
export function nums(s) {
  const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g);
  return m ? m.map(Number).filter((n) => !Number.isNaN(n)) : [];
}

/**
 * Interpret a promise target into {lo, hi, op, unit}.
 * Prefers structured value/value_high; falls back to parsing target.text.
 * op ∈ '>=' | '<=' | 'range' | '~' | '='.
 */
export function parseTarget(target = {}) {
  const unit = target.unit ?? null;
  const text = String(target.text ?? "");
  let lo = target.value ?? null;
  let hi = target.value_high ?? null;
  if (lo == null && hi == null) {
    // allow thousands separators inside each bound ("1,700-1,750/t"); commas are stripped below
    const range = text.match(/(-?\d[\d.,]*)\s*(?:to|-|–|—)\s*(-?\d[\d.,]*)/);
    if (range) {
      lo = Number(range[1].replace(/,/g, ""));
      hi = Number(range[2].replace(/,/g, ""));
    } else {
      const ns = nums(text);
      if (ns.length) lo = ns[0];
    }
  }
  let op = "=";
  if (hi != null && hi !== lo) op = "range";
  else if (/>=|>|≥|at least|minimum|\bmin\b|no less|above|exceed|over|north of|\+\s*$|plus/i.test(text)) op = ">=";
  else if (/<=|<|≤|below|under|less than|\bmax\b|no more|sub[-\s]/i.test(text)) op = "<=";
  else if (/~|about|around|approx|circa/i.test(text)) op = "~";
  return { lo, hi, op, unit };
}

// Leading period/horizon labels whose digits must NOT be read as the metric value
// ("Q3 $1,674/t" → 1674, not 3). Only the unambiguous period forms (Q1-4, H1-2,
// 3M/6M/9M/12M year-to-date, FYnn/CYnn) — NOT bare "5m" magnitudes.
const PERIOD_LABEL_RE = /\b(?:q[1-4]|[1-4]q|h[12]|[12]h|(?:3|6|9|12)m|fy'?\d{2,4}|cy'?\d{2,4})\b/gi;

const isPow10 = (r) => { if (!(r > 1) || !Number.isFinite(r)) return false; const l = Math.log10(r); return Math.abs(l - Math.round(l)) < 1e-9 && Math.round(l) >= 1; };

/** Best single number from a retrieved actual (structured value, else parsed text). */
export function actualNumber(actual = {}) {
  const text = String(actual?.text ?? actual?.what_happened ?? "").replace(PERIOD_LABEL_RE, " ");
  const textNums = nums(text);
  const v = actual?.value;
  if (v != null && !Number.isNaN(Number(v))) {
    // Guard against the LLM scale-stripping a structured value (returning 89 for "89,000",
    // 1.5 for "1.5 lakh"): if the verbatim text carries a number that is `value` scaled by a
    // power of 10 AND shares its leading digits, trust the fuller text figure.
    const vi = String(Math.trunc(Math.abs(Number(v))));
    const scaled = textNums.find((t) => t > Number(v) && String(Math.trunc(Math.abs(t))).startsWith(vi) && isPow10(t / Number(v)));
    return scaled != null ? scaled : Number(v);
  }
  return textNums.length ? textNums[0] : null;
}

/** Group a number for display (Indian digit grouping): 89000 → "89,000", 150000 → "1,50,000". */
export function fmtNum(n) {
  const x = Number(n);
  if (n == null || !Number.isFinite(x)) return String(n);
  return x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** Coarse physical dimension of a unit string, for comparability checks. null = unknown. */
export function unitDimension(u) {
  const s = String(u ?? "").toLowerCase();
  if (!s) return null;
  if (/%|percent|\bpct\b|bps|basis point/.test(s)) return "percent";
  if (/(^|[^a-z])x($|[^a-z])|\btimes\b|ratio/.test(s)) return "ratio";
  const inr = /inr|rupee|\brs\b|\bcr\b|crore|lakh|₹/.test(s);
  const usd = /usd|dollar|\$/.test(s);
  if (inr && !usd) return "money_inr";
  if (usd && !inr) return "money_usd";
  if (/bpd|boepd|bopd|barrel|kbpd|kboepd/.test(s)) return "oil";
  if (/tonne|\bton\b|\bmt\b|\bkt\b|mtpa|mmt|\/t\b/.test(s)) return "mass";
  if (/\bgw\b|\bmw\b|\bkw\b|mwh|gwh/.test(s)) return "power";
  return null; // bare "bn"/"mn"/"entities"/unknown — treat as unknown, never block on it
}

/** True only when BOTH units are known AND belong to different dimensions (a metric mismatch
 *  the verifier should never score, e.g. an INR-crore target vs a USD-billion actual). */
export function unitsIncomparable(a, b) {
  const da = unitDimension(a), db = unitDimension(b);
  return da != null && db != null && da !== db;
}
