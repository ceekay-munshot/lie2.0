/**
 * test-date.mjs — derive when a promise becomes checkable from its target period.
 * Results are reported ~45 days after a period closes, so that's when an outcome
 * can first be verified. This overwrites any model-guessed date.
 *
 *   QnFYyy            → quarter-end + ~45d   (e.g. Q2FY26 → 2025-09-30 +45d)
 *   FYyy / end of FYyy → FY-end (Mar) + ~45d
 *   "by <Month YYYY>" / "<Month DD, YYYY>" → that date
 *   "2030" / "medium term" / "near term"  → the year / phrase (long-dated)
 */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addDays(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar end-date of fiscal quarter `qn` in FY ending year `fyYear`. */
function quarterEnd(qn, fyYear, fyEndMonth = 3) {
  const rawMonth = fyEndMonth - 3 * (4 - qn); // Q4→fyEndMonth, Q3→-3, …
  const m = ((rawMonth - 1 + 24) % 12) + 1;
  const y = m <= fyEndMonth ? fyYear : fyYear - 1;
  return iso(y, m, lastDom(y, m));
}

const fyEnd = (fyYear, fyEndMonth = 3) => iso(fyYear, fyEndMonth, lastDom(fyYear, fyEndMonth));

/**
 * @param {string|null} period  target.period
 * @param {number} fyEndMonth   fiscal year-end month (India = 3)
 * @returns {string|null} ISO date, a year, a phrase, or null
 */
export function deriveTestDate(period, fyEndMonth = 3) {
  if (!period) return null;
  const p = String(period).replace(/[‘’']/g, "").trim();
  let m;

  if ((m = p.match(/\bQ\s*([1-4])\s*FY\s*(\d{2})\b/i))) {
    return addDays(quarterEnd(Number(m[1]), 2000 + Number(m[2]), fyEndMonth), 45);
  }
  if ((m = p.match(/\b([1-4])\s*Q\s*FY\s*(\d{2})\b/i))) {
    return addDays(quarterEnd(Number(m[1]), 2000 + Number(m[2]), fyEndMonth), 45);
  }
  if ((m = p.match(/\bend of FY\s*(\d{2})\b/i)) || (m = p.match(/^FY\s*(\d{2})$/i))) {
    return addDays(fyEnd(2000 + Number(m[1]), fyEndMonth), 45);
  }
  if ((m = p.match(/\bFY\s*(20\d{2})\b/i))) {
    return addDays(fyEnd(Number(m[1]), fyEndMonth), 45);
  }
  // explicit dates: "by March 2026" / "March 31, 2026" / "31 March 2026"
  if ((m = p.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)) && MONTHS[m[1].toLowerCase()]) {
    return iso(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  }
  if ((m = p.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)) && MONTHS[m[2].toLowerCase()]) {
    return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  }
  if ((m = p.match(/(?:by\s+)?([A-Za-z]+)\s+(\d{4})/)) && MONTHS[m[1].toLowerCase()]) {
    const mo = MONTHS[m[1].toLowerCase()];
    const y = Number(m[2]);
    return iso(y, mo, lastDom(y, mo));
  }
  // long-dated aspiration: a bare year, or "medium/near/long term"
  if ((m = p.match(/\b(20\d{2})\b/))) return m[1];
  if ((m = p.match(/\b(medium|near|long)[-\s]?term\b/i))) return `${m[1].toLowerCase()} term`;
  return null;
}
