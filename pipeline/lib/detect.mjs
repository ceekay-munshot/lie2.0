/**
 * detect.mjs — filename-agnostic document classification from PDF text.
 *
 * Real Screener/BSE downloads have arbitrary names (often a bare hash), so we
 * never trust the filename: we read the document's own text (typically page 1 —
 * a cover letter, title slide, or call header) and detect {type, quarter, date}.
 * Deterministic, offline. An optional index.csv overrides detection per file.
 */
import { toFiscalQuarter } from "./manifest.mjs";

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const WORD_Q = { first: 1, second: 2, third: 3, fourth: 4 };

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const squish = (s) => String(s || "").replace(/[‘’′]/g, "'").replace(/\s+/g, " ").trim();

/**
 * Classify the document type from its text.
 * @returns {"transcript"|"presentation"|"annual_report"|null}
 */
export function detectType(text) {
  const s = squish(text).toLowerCase();
  // Transcripts: earnings/conference call. (Decks never say "conference call".)
  if (/\b(earnings|conference|analyst|investor)\s+(call|conference call)\b/.test(s) ||
      /\bconference call\b/.test(s) ||
      /\bearnings call\b/.test(s) ||
      /\btranscript\b/.test(s)) {
    return "transcript";
  }
  if (/\bannual report\b/.test(s)) return "annual_report";
  // Decks: "investor/earnings/results presentation", or the filing cover's
  // "Press Release and Investor Presentation".
  if (/\b(investor|earnings|results|analyst)\s+presentation\b/.test(s) ||
      /\bpress release\b/.test(s) ||
      /\bpresentation\b/.test(s)) {
    return "presentation";
  }
  return null;
}

/**
 * Detect the fiscal quarter reported, e.g. "Q2FY26". Handles QnFYyy / nQFYyy /
 * "Qn FY 'yy" / "Qn Financial Year 'yy-yy" / "<word> Quarter … FYyy/yy", and
 * falls back to a "<period> ended <Month DD, YYYY>" date via toFiscalQuarter.
 */
export function detectQuarter(text) {
  const s = squish(text);
  let m;
  // Q2 FY '26 / Q2FY26 / Q2 FY 2026
  if ((m = s.match(/\bQ\s*([1-4])\s*[-/ ]?\s*FY\s*'?\s*(?:20)?(\d{2})\b/i))) return `Q${m[1]}FY${m[2]}`;
  // 1QFY26 / 1Q FY '26
  if ((m = s.match(/\b([1-4])\s*Q\s*[-/ ]?\s*FY\s*'?\s*(?:20)?(\d{2})\b/i))) return `Q${m[1]}FY${m[2]}`;
  // Q3 … Financial Year '25-26  (take the later year)
  if ((m = s.match(/\bQ\s*([1-4])\b[^.]{0,40}?Financial Year\s*'?\s*\d{2}\s*[-/]\s*(\d{2})\b/i))) {
    return `Q${m[1]}FY${m[2]}`;
  }
  // "<word> quarter" + an FYyy/yy or FYyy token nearby
  const wq = s.match(/\b(first|second|third|fourth)\s+quarter\b/i);
  if (wq) {
    const qn = WORD_Q[wq[1].toLowerCase()];
    let fm;
    if ((fm = s.match(/\bFY\s*'?\s*\d{2}\s*[-/]\s*(\d{2})\b/i))) return `Q${qn}FY${fm[1]}`;
    if ((fm = s.match(/\bFY\s*'?\s*(?:20)?(\d{2})\b/i))) return `Q${qn}FY${fm[1]}`;
    // else fall through to the period-end date below
  }
  // "… quarter [and …] ended September 30, 2025"
  const pe = s.match(/\b(?:quarter|period|months|year)\b[^.]{0,40}?ended\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (pe && MONTHS[pe[1].toLowerCase()]) {
    return toFiscalQuarter(iso(pe[3], MONTHS[pe[1].toLowerCase()], pe[2]));
  }
  return null;
}

/**
 * Detect the document's own date (call/filing/cover date). Falls back to a
 * representative announcement date derived from the quarter when the page shows
 * no date (e.g. a bare title slide).
 */
export function detectDate(text, quarter) {
  const s = squish(text);
  let m;
  // Month DD, YYYY
  if ((m = s.match(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/)) && MONTHS[m[1].toLowerCase()]) {
    return iso(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  }
  // DD(th) Month YYYY
  if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/)) && MONTHS[m[2].toLowerCase()]) {
    return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  }
  return quarter ? announceDateForQuarter(quarter) : null;
}

/** Representative results-announcement date for a quarter (≈1 month after close). */
export function announceDateForQuarter(quarter) {
  const m = String(quarter || "").match(/^Q([1-4])FY(\d{2})$/);
  if (!m) return null;
  const qn = Number(m[1]);
  const fyEnd = 2000 + Number(m[2]);
  const map = { 1: [fyEnd - 1, 7, 31], 2: [fyEnd - 1, 10, 31], 3: [fyEnd, 1, 31], 4: [fyEnd, 4, 30] };
  const [y, mo, d] = map[qn];
  return iso(y, mo, d);
}

/**
 * Detect {type, quarter, date} from a document's (page-1) text.
 * @returns {{type:string|null, quarter:string|null, date:string|null}}
 */
export function detectDocMeta(text) {
  const type = detectType(text);
  const quarter = detectQuarter(text);
  const date = detectDate(text, quarter);
  return { type, quarter, date };
}
