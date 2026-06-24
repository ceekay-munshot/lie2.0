/**
 * manifest.mjs — the document-acquisition contract shared by every acquisition
 * backend (Screener scraper, manual upload). Both write the SAME manifest shape
 * so the rest of the pipeline (Prompt 3 ingestion onward) is source-agnostic.
 *
 * Manifest (pipeline/output/<ticker>/manifest.json) mirrors the company schema's
 * documents[]:
 *   {
 *     ticker, company: { name, screener_url, fiscal_year_end },
 *     source: "screener" | "upload",
 *     fetched_at: ISO,
 *     documents: [{ id, type, quarter, date, title, source_url, local_path,
 *                   bytes, sha256, source }],
 *     skipped:   [{ label, reason }],
 *     errors:    [{ url, reason }]
 *   }
 *
 * No network, no LLM, no browser — pure local helpers + path conventions.
 */
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PIPELINE_DIR = join(__dirname, "..");
export const OUTPUT_ROOT = join(PIPELINE_DIR, "output");
export const INPUT_ROOT = join(PIPELINE_DIR, "input");

/** Document types this stage emits (subset of the company schema's enum). */
export const DOC_TYPES = ["transcript", "presentation", "annual_report"];

/** Map a Screener Concalls row label to one of our document types (or null = skip). */
export function typeFromLabel(label) {
  const s = String(label || "").toLowerCase();
  if (s.includes("transcript")) return "transcript";
  if (s.includes("ppt") || s.includes("present")) return "presentation";
  if (s.includes("annual report")) return "annual_report";
  // "Notes", "REC" (recording), "Add Missing", etc. are not measurable documents.
  return null;
}

/** Canonical quarter shape, e.g. Q2FY26. */
export const QUARTER_RE = /^Q[1-4]FY\d{2}$/;

/* ----------------------------------------------------------------------------
 * Fiscal quarter derivation
 * ------------------------------------------------------------------------- */

/** Parse a YYYY-MM-DD (or YYYY-MM, or YYYY/MM/DD) string to {y,m,d}. Day → 1 if absent. */
export function parseYMD(dateISO) {
  const m = String(dateISO || "").match(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (!m) throw new Error(`Unparseable date: ${JSON.stringify(dateISO)}`);
  return { y: Number(m[1]), m: Number(m[2]), d: m[3] ? Number(m[3]) : 1 };
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based; day 0 of next month
}

function cmpYMD(ay, am, ad, by, bm, bd) {
  return ay - by || am - bm || ad - bd;
}

/** Which fiscal quarter ENDS at (qeYear, qeMonth)? → { quarter, fyYear }. */
function fiscalQuarterOfEnd(qeYear, qeMonth, fyEndMonth) {
  const startMonth = (fyEndMonth % 12) + 1; // month the FY begins
  const monthsFromStart = (qeMonth - startMonth + 12) % 12;
  const quarter = Math.floor(monthsFromStart / 3) + 1;
  const fyYear = qeMonth <= fyEndMonth ? qeYear : qeYear + 1;
  return { quarter, fyYear };
}

/**
 * Map an earnings document's publication date to the fiscal quarter it REPORTS —
 * the most-recently-completed fiscal quarter on/before `dateISO`. Results are
 * always announced after the quarter closes, so a 31 Jul 2025 concall reports
 * Q1 FY26 (quarter ended 30 Jun 2025), a 29 Jan 2026 call reports Q3 FY26, etc.
 *
 * @param {string} dateISO   ISO-ish date string
 * @param {number} fyEndMonth calendar month the fiscal year ends (India = 3/March)
 * @returns {string} e.g. "Q1FY26"
 */
export function toFiscalQuarter(dateISO, fyEndMonth = 3) {
  const { y, m, d } = parseYMD(dateISO);
  const endMonths = [0, 1, 2, 3].map((k) => (((fyEndMonth - 1 + 3 * k) % 12) + 1));
  let best = null;
  for (const yr of [y - 1, y, y + 1]) {
    for (const em of endMonths) {
      const ed = lastDayOfMonth(yr, em);
      if (cmpYMD(yr, em, ed, y, m, d) <= 0) {
        if (!best || cmpYMD(yr, em, ed, best.y, best.m, best.d) > 0) {
          best = { y: yr, m: em, d: ed };
        }
      }
    }
  }
  const { quarter, fyYear } = fiscalQuarterOfEnd(best.y, best.m, fyEndMonth);
  return `Q${quarter}FY${String(fyYear).slice(-2)}`;
}

/** Stable document id, e.g. ("Q2FY26","transcript") → "q2fy26-transcript". */
export function docId(quarter, type) {
  return `${String(quarter).toLowerCase()}-${type}`;
}

/* ----------------------------------------------------------------------------
 * Bytes: hashing + PDF sniffing
 * ------------------------------------------------------------------------- */

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

/** True if the buffer looks like a real PDF ("%PDF-" within the first bytes). */
export function isPdfBuffer(buf) {
  if (!buf || buf.length < 5) return false;
  // Tolerate a UTF-8 BOM / leading whitespace before the signature.
  const head = buf.subarray(0, 1024).toString("latin1");
  return /%PDF-\d/.test(head);
}

/* ----------------------------------------------------------------------------
 * Paths + manifest construction
 * ------------------------------------------------------------------------- */

export const tickerSlug = (ticker) => String(ticker || "").trim().toLowerCase();

export function outputDir(ticker) {
  return join(OUTPUT_ROOT, tickerSlug(ticker));
}
export function rawDir(ticker) {
  return join(outputDir(ticker), "raw");
}
export function debugDir(ticker) {
  return join(outputDir(ticker), "debug");
}
export function manifestPath(ticker) {
  return join(outputDir(ticker), "manifest.json");
}
export function inputDir(ticker) {
  return join(INPUT_ROOT, tickerSlug(ticker));
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

/** A fresh, empty manifest skeleton. */
export function emptyManifest({ ticker, company = {}, source, fetched_at }) {
  return {
    ticker: String(ticker || "").toUpperCase(),
    company: {
      name: company.name ?? null,
      screener_url: company.screener_url ?? null,
      fiscal_year_end: company.fiscal_year_end ?? null,
    },
    source,
    fetched_at: fetched_at || new Date().toISOString(),
    documents: [],
    skipped: [],
    errors: [],
  };
}

/** Write the manifest (pretty, trailing newline) and return its path. */
export function writeManifest(ticker, manifest) {
  ensureDir(outputDir(ticker));
  const path = manifestPath(ticker);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polite randomized delay between requests (default 1–2s). */
export function politeDelay(minMs = 1000, maxMs = 2000) {
  return sleep(minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs)));
}
