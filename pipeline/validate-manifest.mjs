#!/usr/bin/env node
/**
 * validate-manifest.mjs — assert that an acquisition manifest is well-formed and
 * its referenced bytes are real, regardless of which backend produced it.
 *
 * Checks, per manifest:
 *   - required top-level keys present (ticker, company, source, fetched_at,
 *     documents, skipped, errors);
 *   - each document has the required keys;
 *   - type ∈ {transcript, presentation, annual_report};
 *   - quarter matches /^Q[1-4]FY\d{2}$/;
 *   - local_path exists, its byte length matches `bytes`, its sha256 matches
 *     `sha256`, and the file is a real PDF (%PDF magic);
 *   - document ids are unique.
 *
 * Usage:
 *   TICKER=VEDL node pipeline/validate-manifest.mjs   # one manifest
 *   node pipeline/validate-manifest.mjs VEDL test      # explicit tickers
 *   node pipeline/validate-manifest.mjs                # every output/<t>/manifest.json
 */
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  OUTPUT_ROOT,
  manifestPath,
  outputDir,
  sha256File,
  isPdfBuffer,
  QUARTER_RE,
  DOC_TYPES,
} from "./lib/manifest.mjs";

const REQUIRED_TOP = ["ticker", "company", "source", "fetched_at", "documents", "skipped", "errors"];
const REQUIRED_DOC = ["id", "type", "quarter", "date", "title", "source_url", "local_path", "bytes", "sha256", "source"];

function tickersFromArgs() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (process.env.TICKER) args.push(process.env.TICKER);
  if (args.length) return [...new Set(args.map((t) => t.toLowerCase()))];
  // Default: every output/<ticker>/manifest.json
  if (!existsSync(OUTPUT_ROOT)) return [];
  return readdirSync(OUTPUT_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(manifestPath(e.name)))
    .map((e) => e.name);
}

function resolveLocalPath(ticker, localPath) {
  if (isAbsolute(localPath)) return localPath;
  // Stored relative to output/<ticker>/ (e.g. "raw/q2fy26-transcript.pdf").
  return join(outputDir(ticker), localPath);
}

function validateManifest(ticker) {
  const errors = [];
  const mpath = manifestPath(ticker);
  if (!existsSync(mpath)) return { ticker, ok: false, errors: [`manifest not found: ${mpath}`], docs: 0 };

  let m;
  try {
    m = JSON.parse(readFileSync(mpath, "utf8"));
  } catch (e) {
    return { ticker, ok: false, errors: [`manifest is not valid JSON: ${e.message}`], docs: 0 };
  }

  for (const k of REQUIRED_TOP) {
    if (!(k in m)) errors.push(`missing top-level key "${k}"`);
  }
  if (m.source && !["screener", "upload"].includes(m.source)) {
    errors.push(`source must be "screener" or "upload" (got ${JSON.stringify(m.source)})`);
  }
  if (!Array.isArray(m.documents)) {
    errors.push("documents must be an array");
    return { ticker, ok: errors.length === 0, errors, docs: 0 };
  }

  const seenIds = new Set();
  m.documents.forEach((doc, i) => {
    const at = `documents[${i}]${doc && doc.id ? ` (${doc.id})` : ""}`;
    for (const k of REQUIRED_DOC) {
      if (!(k in (doc || {}))) errors.push(`${at}: missing key "${k}"`);
    }
    if (!doc) return;
    if (seenIds.has(doc.id)) errors.push(`${at}: duplicate id "${doc.id}"`);
    seenIds.add(doc.id);
    if (!DOC_TYPES.includes(doc.type)) {
      errors.push(`${at}: type "${doc.type}" not in {${DOC_TYPES.join(", ")}}`);
    }
    if (!QUARTER_RE.test(doc.quarter || "")) {
      errors.push(`${at}: quarter "${doc.quarter}" does not match QnFYyy`);
    }
    if (doc.local_path) {
      const abs = resolveLocalPath(ticker, doc.local_path);
      if (!existsSync(abs)) {
        errors.push(`${at}: local_path missing on disk (${doc.local_path})`);
      } else {
        const buf = readFileSync(abs);
        if (typeof doc.bytes === "number" && buf.length !== doc.bytes) {
          errors.push(`${at}: bytes mismatch (manifest ${doc.bytes}, file ${buf.length})`);
        }
        if (doc.sha256 && sha256File(abs) !== doc.sha256) {
          errors.push(`${at}: sha256 mismatch`);
        }
        if (!isPdfBuffer(buf)) {
          errors.push(`${at}: not a real PDF (missing %PDF magic)`);
        }
      }
    }
  });

  return { ticker, ok: errors.length === 0, errors, docs: m.documents.length };
}

const tickers = tickersFromArgs();
if (tickers.length === 0) {
  console.error("No manifests to validate. Run an acquisition first, or pass a TICKER.");
  process.exit(1);
}

let failed = 0;
for (const t of tickers) {
  const r = validateManifest(t);
  if (r.ok) {
    console.log(`  ✓ ${t.toUpperCase()}  (${r.docs} documents)`);
  } else {
    failed += 1;
    console.error(`  ✗ ${t.toUpperCase()}`);
    for (const e of r.errors) console.error(`      ${e}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} manifest(s) failed validation.`);
  process.exit(1);
}
console.log(`\nAll ${tickers.length} manifest(s) valid.`);
