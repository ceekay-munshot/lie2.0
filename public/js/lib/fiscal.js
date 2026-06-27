/**
 * fiscal.js — browser-side Indian fiscal-quarter math (mirror of pipeline/lib/fiscal.mjs).
 * Charts need to place a promise's promised/revised period on a quarter axis, so this
 * turns "Q2FY26" / "2HFY26" / "1Q'27" / "by Mar 2026" → a monotonic index, and back to a
 * label. Pure & deterministic; null on anything unparseable. No company specifics.
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
    const apos = t.match(/['’](\d{2,4})/); // 1Q'27 / Q1'27 / 2H'26 / '27
    if (apos) { fy = Number(apos[1].slice(-2)); t = t.replace(/['’]\d{2,4}/, " "); }
  }
  let q = null;
  const qm = t.match(/q([1-4])/) || t.match(/([1-4])q/);
  if (qm) q = Number(qm[1]);
  if (q == null) {
    const hm = t.match(/h([12])/) || t.match(/([12])h/);
    if (hm) q = hm[1] === "1" ? 2 : 4; // half-year → its closing quarter
  }
  if (fy == null) {
    const ym = raw.match(/(?:19|20)\d{2}/);
    if (!ym) return null;
    const cy = Number(ym[0]);
    const monIdx = MON.findIndex((m) => raw.includes(m));
    const monNum = monIdx >= 0 ? monIdx + 1 : 3;
    fy = (monNum <= 3 ? cy : cy + 1) % 100;
    if (q == null) q = monNum <= 3 ? 4 : monNum <= 6 ? 1 : monNum <= 9 ? 2 : 3;
  }
  return fy * 4 + (q ?? 4);
}

const PERIOD_RE = new RegExp(
  [
    "(?:[1-4]\\s*q|q\\s*[1-4]|[12]\\s*h|h\\s*[12])\\s*fy\\s*'?\\d{2,4}",
    "fy\\s*'?\\d{2,4}",
    "(?:[1-4]q|q[1-4]|[12]h|h[12])\\s*'\\s*\\d{2}",
    "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\w*\\s+(?:19|20)\\d{2}",
    "(?:19|20)\\d{2}",
  ].join("|"),
  "gi",
);

/** The LATEST fiscal period named anywhere in a string (e.g. a "re-set to 1HFY27"), else null. */
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

/** Inverse of periodIndex — a comparable index back to a "QnFYyy" label. */
export function quarterLabel(idx) {
  if (idx == null || Number.isNaN(Number(idx))) return "";
  const i = Math.round(Number(idx));
  const fy = Math.floor((i - 1) / 4);
  const q = i - fy * 4;
  if (q < 1 || q > 4) return "";
  return `Q${q}FY${String(fy).padStart(2, "0")}`;
}
