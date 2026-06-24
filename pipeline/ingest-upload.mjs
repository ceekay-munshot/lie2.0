#!/usr/bin/env node
/**
 * ingest-upload.mjs — manual-upload acquisition backend (the fallback for when
 * Screener is unreachable or a document must be supplied by hand). Produces the
 * EXACT same manifest as the scraper, so the rest of the pipeline can't tell the
 * difference.
 *
 * Input: pipeline/input/<ticker>/
 *   - PDFs named by convention:  Q2FY26-transcript.pdf, Q2FY26-ppt.pdf,
 *     Q1FY26-presentation.pdf, FY25-annual_report.pdf, …   (<QUARTER>-<type>.pdf)
 *   - …or an index.csv mapping:  file,quarter,type,date
 *
 * Output: pipeline/output/<ticker>/raw/<id>.pdf + manifest.json
 *
 * Env: TICKER (required) · SOURCE=upload · DRY_RUN · DEBUG.
 *
 * No network, no LLM.
 */
import { existsSync, readFileSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
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

const TICKER = (process.env.TICKER || process.argv[2] || "").trim();
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "0";
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";

function die(msg) {
  console.error(`upload: ${msg}`);
  process.exit(1);
}

/** Resolve an upload "type word" (from filename or csv) to a document type. */
function resolveType(word) {
  const norm = String(word || "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (norm === "ar" || norm === "annual report") return "annual_report";
  if (norm === "call") return "transcript"; // tolerate "call" as transcript
  return typeFromLabel(norm);
}

/** Minimal CSV → array of {file,quarter,type,date}. Supports header or positional. */
function parseIndexCsv(text) {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(",").map((c) => c.trim()));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  const hasHeader = header.includes("quarter") || header.includes("type") || header.includes("file");
  const cols = hasHeader ? header : ["file", "quarter", "type", "date"];
  const body = hasHeader ? rows.slice(1) : rows;
  return body.map((r) => {
    const rec = {};
    cols.forEach((c, i) => (rec[c] = r[i] ?? ""));
    return { file: rec.file, quarter: rec.quarter, type: rec.type, date: rec.date || null };
  });
}

/** Discover upload entries from index.csv, else from the *.pdf filename convention. */
function discoverEntries(dir) {
  const csvPath = join(dir, "index.csv");
  if (existsSync(csvPath)) {
    if (DEBUG) console.error(`upload: using ${csvPath}`);
    return parseIndexCsv(readFileSync(csvPath, "utf8")).map((e) => ({
      file: e.file,
      quarter: String(e.quarter || "").toUpperCase(),
      type: resolveType(e.type),
      rawType: e.type,
      date: e.date,
    }));
  }
  const pdfs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  return pdfs.map((file) => {
    const m = basename(file, ".pdf").match(/^(Q[1-4]FY\d{2}|FY\d{2})[-_](.+)$/i);
    if (!m) return { file, quarter: null, type: null, rawType: null, date: null };
    // "FY25-annual_report.pdf" → quarter FY25 isn't QnFYyy; only annual reports use it.
    const q = m[1].toUpperCase();
    return { file, quarter: q, type: resolveType(m[2]), rawType: m[2], date: null };
  });
}

function main() {
  if (!TICKER) die("TICKER is required (e.g. TICKER=test SOURCE=upload node pipeline/ingest-upload.mjs)");

  const inDir = inputDir(TICKER);
  if (!existsSync(inDir)) {
    die(`input directory not found: ${inDir}\n  Place PDFs as <QUARTER>-<type>.pdf (e.g. Q2FY26-transcript.pdf) or add an index.csv.`);
  }

  const entries = discoverEntries(inDir);
  if (entries.length === 0) die(`no PDFs or index.csv found in ${inDir}`);

  const manifest = emptyManifest({
    ticker: TICKER,
    company: { name: null, screener_url: null, fiscal_year_end: null },
    source: "upload",
  });

  const dest = rawDir(TICKER);
  if (!DRY_RUN) ensureDir(dest);

  const seen = new Set();
  for (const e of entries) {
    const label = e.file || `${e.quarter}-${e.rawType}`;
    if (!e.type || !DOC_TYPES.includes(e.type)) {
      manifest.skipped.push({ label, reason: `unrecognized type ${JSON.stringify(e.rawType)}` });
      continue;
    }
    // Annual reports may be keyed by FYyy; everything else must be QnFYyy.
    const isAnnual = e.type === "annual_report";
    if (!isAnnual && !QUARTER_RE.test(e.quarter || "")) {
      manifest.skipped.push({ label, reason: `bad quarter ${JSON.stringify(e.quarter)}` });
      continue;
    }
    const src = join(inDir, e.file);
    if (!existsSync(src)) {
      manifest.errors.push({ url: src, reason: "file not found" });
      continue;
    }
    const buf = readFileSync(src);
    if (!isPdfBuffer(buf)) {
      manifest.errors.push({ url: src, reason: "not a real PDF (%PDF magic absent)" });
      continue;
    }
    // For annual reports lacking a QnFYyy, fall back to a Q4 id so ids stay uniform.
    const quarter = QUARTER_RE.test(e.quarter) ? e.quarter : `Q4FY${String(e.quarter).replace(/\D/g, "").slice(-2)}`;
    const id = docId(quarter, e.type);
    if (seen.has(id)) {
      manifest.skipped.push({ label, reason: `duplicate id ${id}` });
      continue;
    }
    seen.add(id);

    const rel = join("raw", `${id}.pdf`);
    const abs = join(outputDir(TICKER), rel);
    if (!DRY_RUN) copyFileSync(src, abs);

    manifest.documents.push({
      id,
      type: e.type,
      quarter,
      date: e.date || null,
      title: `${quarter} ${e.type.replace("_", " ")}`,
      source_url: null,
      local_path: rel,
      bytes: buf.length,
      sha256: sha256(buf),
      source: "Upload",
    });
    console.log(`  + ${id}  (${buf.length} bytes)${DRY_RUN ? "  [dry-run]" : ""}`);
  }

  manifest.documents.sort((a, b) => a.id.localeCompare(b.id));

  if (manifest.documents.length === 0) {
    die(`no valid documents ingested from ${inDir} (skipped ${manifest.skipped.length}, errors ${manifest.errors.length})`);
  }

  if (!DRY_RUN) writeManifest(TICKER, manifest);

  const byType = manifest.documents.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + 1), m), {});
  console.log(
    `\nupload: ${TICKER.toUpperCase()} — ${manifest.documents.length} documents ` +
      `(${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ")}), ` +
      `${manifest.skipped.length} skipped, ${manifest.errors.length} errors` +
      `${DRY_RUN ? "  [dry-run, manifest not written]" : `\n  manifest → ${manifestPath(TICKER)}`}`,
  );
}

main();
