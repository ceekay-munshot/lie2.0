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
    const range = text.match(/(-?\d[\d.]*)\s*(?:to|-|–|—)\s*(-?\d[\d.]*)/);
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

/** Best single number from a retrieved actual (structured value, else parsed text). */
export function actualNumber(actual = {}) {
  if (actual && actual.value != null) return actual.value;
  const ns = nums(actual?.text ?? actual?.what_happened ?? "");
  return ns.length ? ns[0] : null;
}
