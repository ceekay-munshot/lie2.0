/**
 * verification-window.mjs (deterministic) — the latest period the corpus can verify
 * against is the NEWEST document. A promise is NYT when its test_date falls after that
 * date (you can't fail a test that hasn't happened within what we can see).
 */

/** {latest_reported, latest_reported_date, note} from the newest dated corpus doc. */
export function verificationWindow(corpus = {}) {
  let latest = null;
  for (const d of corpus.documents || []) {
    if (!d?.date) continue;
    if (!latest || String(d.date) > String(latest.date)) latest = d;
  }
  return {
    latest_reported: latest?.quarter ?? null,
    latest_reported_date: latest?.date ?? null,
    note: latest
      ? "Outcomes verifiable only through the latest reported period; later targets are NYT."
      : "No dated documents in the corpus.",
  };
}

/** ISO test_date strictly after the latest reported date ⇒ not yet testable. */
export function isNotYetTestable(testDate, latestReportedDate) {
  if (!testDate || !latestReportedDate) return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(testDate)) return false; // non-ISO → let the verdict rules decide
  return testDate.slice(0, 10) > String(latestReportedDate).slice(0, 10);
}
