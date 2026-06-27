/**
 * fiscal.mjs — Indian fiscal-quarter math (FY ends 31 Mar). Pure & deterministic.
 *   periodIndex("Q2FY26") = 26*4+2 = 106 ; "FY26"/"2HFY26"/"by Mar 2026" → year-end (Q4).
 * Returns a monotonically increasing integer so deadlines/outcomes compare directly,
 * or null when no fiscal/calendar period can be read. No hardcoded companies.
 */
const MON = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec".split("|");

/** Fiscal index (FYyy*4 + quarter 1-4) from a period/deadline string, else null. */
export function periodIndex(s) {
  const raw = String(s ?? "").toLowerCase();
  let t = raw.replace(/[.\s]/g, ""); // keep apostrophes — they mark a year shorthand (1Q'27)
  if (!t) return null;
  let fy = null;
  const fym = t.match(/fy'?(\d{2,4})/);
  if (fym) { fy = Number(fym[1].slice(-2)); t = t.replace(/fy'?\d{2,4}/, " "); }
  else {
    // apostrophe shorthand: 1Q'27 / Q1'27 / 2H'26 / '27 → fiscal year, no "FY"
    const apos = t.match(/['’](\d{2,4})/);
    if (apos) { fy = Number(apos[1].slice(-2)); t = t.replace(/['’]\d{2,4}/, " "); }
  }
  // quarter / half-year (the year is already removed, so an adjacent year digit
  // like the "27" in "1q'27" can't be misread as the quarter).
  let q = null;
  const qm = t.match(/q([1-4])/) || t.match(/([1-4])q/);
  if (qm) q = Number(qm[1]);
  if (q == null) {
    const hm = t.match(/h([12])/) || t.match(/([12])h/);
    if (hm) q = hm[1] === "1" ? 2 : 4; // half-year → its closing quarter
  }
  if (fy == null) {
    // calendar year ("2030", "by mar 2026", "dec 2026") → the FY it falls in.
    const ym = raw.match(/(?:19|20)\d{2}/);
    if (!ym) return null;
    const cy = Number(ym[0]);
    const monIdx = MON.findIndex((m) => raw.includes(m)); // 0=jan … 11=dec; -1 if none
    const monNum = monIdx >= 0 ? monIdx + 1 : 3; // bare year → treat as FY-end (Mar)
    fy = (monNum <= 3 ? cy : cy + 1) % 100; // Jan-Mar belong to the FY ending that Mar
    if (q == null) q = monNum <= 3 ? 4 : monNum <= 6 ? 1 : monNum <= 9 ? 2 : 3;
  }
  return fy * 4 + (q ?? 4);
}

// Whole fiscal/calendar period tokens, longest-form first.
const PERIOD_RE = new RegExp(
  [
    "(?:[1-4]\\s*q|q\\s*[1-4]|[12]\\s*h|h\\s*[12])\\s*fy\\s*'?\\d{2,4}", // Q2FY26, 1QFY26, 2HFY26
    "fy\\s*'?\\d{2,4}", // FY26 / FY2026
    "(?:[1-4]q|q[1-4]|[12]h|h[12])\\s*'\\s*\\d{2}", // 1Q'27, 2H'26
    "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\w*\\s+(?:19|20)\\d{2}", // Mar 2026
    "(?:19|20)\\d{2}", // 2030
  ].join("|"),
  "gi",
);

/** The LATEST fiscal period named anywhere in a string (e.g. an outcome that
 *  re-guides "…now 1HFY27"), as a comparable index — else null. */
export function maxPeriodIndex(s) {
  const matches = String(s ?? "").match(PERIOD_RE);
  if (!matches) return null;
  let max = null;
  for (const m of matches) {
    const idx = periodIndex(m);
    if (idx != null && (max == null || idx > max)) max = idx;
  }
  return max;
}

/** Difference in quarters between two period strings (b − a), or null. */
export function quartersBetween(a, b) {
  const ia = periodIndex(a), ib = periodIndex(b);
  return ia == null || ib == null ? null : ib - ia;
}

/** Inverse of periodIndex — a comparable index back to a "QnFYyy" label. */
export function quarterLabel(idx) {
  if (idx == null || Number.isNaN(Number(idx))) return "";
  const i = Math.round(Number(idx));
  const fy = Math.floor((i - 1) / 4);
  const q = i - fy * 4;
  if (q < 1 || q > 4) return "";
  return `Q${q}FY${String(fy).padStart(2, "0")}`;
}
