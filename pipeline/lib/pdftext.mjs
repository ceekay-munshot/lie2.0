/**
 * pdftext.mjs — deterministic PDF → per-page text extraction (no OCR, no LLM).
 *
 * Uses unpdf (a serverless-friendly pdf.js wrapper; pure JS, no native deps —
 * installed --no-save). Returns text per page so downstream tagging can cite
 * page numbers. Detects PDFs with no text layer (scanned images) and flags
 * `needs_ocr` instead of crashing — OCR is out of scope for this stage, and the
 * raw `local_path` is preserved so Prompt 4 can optionally feed the PDF to a
 * vision model.
 */
import { readFile } from "node:fs/promises";

// pdf.js prints noisy font warnings ("TT: undefined function") to the console;
// silence them so ingest output stays clean. Restored after each extract.
async function quietPdfWarnings(fn) {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

/**
 * Extract per-page text from a PDF on disk.
 * @param {string} localPath
 * @returns {Promise<{pages:string[], pageCount:number, chars:number, needs_ocr:boolean, local_path:string}>}
 */
export async function extractPdf(localPath) {
  let extractText;
  let getDocumentProxy;
  try {
    ({ extractText, getDocumentProxy } = await import("unpdf"));
  } catch {
    throw new Error("PDF extraction needs unpdf — run: npm install --no-save unpdf");
  }
  const data = new Uint8Array(await readFile(localPath));
  return quietPdfWarnings(async () => {
    try {
      const pdf = await getDocumentProxy(data);
      const { text, totalPages } = await extractText(pdf, { mergePages: false });
      const pages = (Array.isArray(text) ? text : [text]).map((t) => t || "");
      const chars = pages.reduce((s, p) => s + p.length, 0);
      // ~0 chars/page ⇒ no extractable text layer ⇒ scanned image ⇒ needs OCR.
      const needs_ocr = chars < Math.max(40, totalPages * 5);
      return { pages, pageCount: totalPages, chars, needs_ocr, local_path: localPath };
    } catch (err) {
      // A corrupt or image-only PDF must not crash ingestion — flag for OCR.
      return { pages: [], pageCount: 0, chars: 0, needs_ocr: true, local_path: localPath, error: err.message };
    }
  });
}

/** Convenience: extract just page 1's text (used by upload content-detection). */
export async function extractFirstPage(localPath) {
  const { pages } = await extractPdf(localPath);
  return pages[0] || "";
}
