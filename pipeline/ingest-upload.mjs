#!/usr/bin/env node
/**
 * ingest-upload.mjs — manual-upload acquisition backend, now FILENAME-AGNOSTIC.
 *
 * Real Screener/BSE downloads have arbitrary names (often a bare hash), so we
 * never trust the filename: each PDF's page-1 text is read and its {type,
 * quarter, date} are detected (pipeline/lib/detect.mjs). An optional
 * pipeline/input/<ticker>/index.csv (file,quarter,type,date) OVERRIDES detection
 * per file. Produces the SAME manifest shape as the Screener scraper.
 *
 * Input:  pipeline/input/<ticker>/*.pdf  (+ optional index.csv)
 * Output: pipeline/output/<ticker>/raw/<id>.pdf + manifest.json
 *
 * Env: TICKER (required) · SOURCE=upload · DRY_RUN · DEBUG.  No network, no LLM.
 */
import { existsSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyManifest,
  writeManifest,
  ensureDir,
  rawDir,
  inputDir,
  outputDir,
  manifestPath,
  docId,
  sha256,
  isPdfBuffer,
  typeFromLabel,
  QUARTER_RE,
  DOC_TYPES,
} from "./lib/manifest.mjs";
import { extractFirstPage } from "./lib/pdftext.mjs";
import { detectDocMeta } from "./lib/detect.mjs";

const TICKER = (process.env.TICKER || process.argv[2] || "").trim();
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "0";
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";

function die(msg) {
  console.error(`upload: ${msg}`);
  process.exit(1);
}

/** Resolve a CSV "type word" → document type. */
function resolveType(word) {
  const norm = String(word || "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (norm === "ar" || norm === "annual report") return "annual_report";
  if (norm === "call") return "transcript";
  return typeFromLabel(norm);
}

/** Optional index.csv → { filename: {quarter,type,date} }. */
function readIndexCsv(dir) {
  const p = join(dir, "index.csv");
  if (!existsSync(p)) return null;
  const rows = readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(",").map((c) => c.trim()));
  if (!rows.length) return null;
  const header = rows[0].map((h) => h.toLowerCase());
  const hasHeader = header.includes("file") || header.includes("quarter") || header.includes("type");
  const cols = hasHeader ? header : ["file", "quarter", "type", "date"];
  const body = hasHeader ? rows.slice(1) : rows;
  const map = {};
  for (const r of body) {
    const rec = {};
    cols.forEach((c, i) => (rec[c] = r[i] ?? ""));
    if (rec.file) map[rec.file] = { quarter: rec.quarter, type: rec.type, date: rec.date || null };
  }
  return map;
}

async function main() {
  if (!TICKER) die("TICKER is required (e.g. SOURCE=upload TICKER=vedl node pipeline/ingest-upload.mjs)");

  const inDir = inputDir(TICKER);
  if (!existsSync(inDir)) die(`input directory not found: ${inDir}`);

  const pdfs = readdirSync(inDir).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  if (!pdfs.length) die(`no PDFs found in ${inDir}`);

  const csv = readIndexCsv(inDir);
  const manifest = emptyManifest({
    ticker: TICKER,
    company: { name: null, screener_url: null, fiscal_year_end: "03" },
    source: "upload",
  });

  if (!DRY_RUN) ensureDir(rawDir(TICKER));
  const seen = new Set();

  for (const file of pdfs) {
    const src = join(inDir, file);
    const buf = readFileSync(src);
    if (!isPdfBuffer(buf)) {
      manifest.errors.push({ url: src, reason: "not a real PDF (%PDF magic absent)" });
      continue;
    }

    // index.csv overrides; otherwise detect from the document's own text.
    let type;
    let quarter;
    let date;
    let how;
    const ov = csv && csv[file];
    if (ov) {
      type = resolveType(ov.type);
      quarter = String(ov.quarter || "").toUpperCase();
      date = ov.date;
      how = "csv";
    } else {
      const page1 = await extractFirstPage(src);
      if (!page1.trim()) {
        manifest.skipped.push({ label: file, reason: "no extractable text on page 1 (needs OCR?)" });
        continue;
      }
      ({ type, quarter, date } = detectDocMeta(page1));
      how = "detected";
    }

    if (!type || !DOC_TYPES.includes(type)) {
      manifest.skipped.push({ label: file, reason: `could not classify type (${how})` });
      continue;
    }
    if (!QUARTER_RE.test(quarter || "")) {
      manifest.skipped.push({ label: file, reason: `could not resolve quarter (${how})` });
      continue;
    }

    const id = docId(quarter, type);
    if (seen.has(id)) {
      manifest.skipped.push({ label: file, reason: `duplicate id ${id} (already have one)` });
      continue;
    }
    seen.add(id);

    const rel = join("raw", `${id}.pdf`);
    if (!DRY_RUN) copyFileSync(src, join(outputDir(TICKER), rel));

    manifest.documents.push({
      id,
      type,
      quarter,
      date: date || null,
      title: `${quarter} ${type.replace("_", " ")}`,
      source_url: null,
      local_path: rel,
      bytes: buf.length,
      sha256: sha256(buf),
      source: "Upload",
    });
    console.log(`  + ${id.padEnd(22)} ← ${file}  (${how}, ${date || "no date"})${DRY_RUN ? "  [dry-run]" : ""}`);
  }

  manifest.documents.sort((a, b) => a.id.localeCompare(b.id));
  if (!manifest.documents.length) die(`no valid documents from ${inDir} (skipped ${manifest.skipped.length}, errors ${manifest.errors.length})`);

  if (!DRY_RUN) writeManifest(TICKER, manifest);

  const byType = manifest.documents.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + 1), m), {});
  console.log(
    `\nupload: ${TICKER.toUpperCase()} — ${manifest.documents.length} documents ` +
      `(${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ")}), ` +
      `${manifest.skipped.length} skipped, ${manifest.errors.length} errors` +
      `${DRY_RUN ? "  [dry-run, manifest not written]" : `\n  manifest → ${manifestPath(TICKER)}`}`,
  );
}

main().catch((e) => die(e.stack || e.message));
