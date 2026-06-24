#!/usr/bin/env node
/**
 * ingest.mjs — turn an acquisition manifest's PDFs into a normalized, tagged,
 * chunked corpus the extraction engine (Prompt 4) reads. Deterministic & offline
 * — NO LLM calls here.
 *
 *   TICKER=vedl node pipeline/ingest.mjs      (or: node pipeline/ingest.mjs TICKER=vedl)
 *
 * Per document: extract per-page text → de-boilerplate + tag structure (speaker
 * turns / slides) → chunk with citable metadata → pipeline/output/<ticker>/
 * corpus.json (gitignored). A PDF with no text layer is flagged needs_ocr and
 * skipped without crashing.
 *
 * Env: TICKER · CHUNK_TOKENS (1500) · CHUNK_OVERLAP (150) · LIMIT · INGEST_MODE
 * (text default; "gemini" is a documented Prompt-4 hook — no LLM here) · DEBUG.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { manifestPath, outputDir, ensureDir } from "./lib/manifest.mjs";
import { extractPdf } from "./lib/pdftext.mjs";
import { normalizeDocument } from "./lib/normalize-text.mjs";
import { chunkSections } from "./lib/chunk.mjs";

const argTicker = process.argv.slice(2).map((a) => a.replace(/^TICKER=/i, "")).find((a) => a && !a.startsWith("-"));
const TICKER = (process.env.TICKER || argTicker || "").trim();
const CHUNK_TOKENS = Number(process.env.CHUNK_TOKENS || 1500);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 150);
const LIMIT = Number(process.env.LIMIT || Infinity);
const INGEST_MODE = process.env.INGEST_MODE || "text";
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";

function die(msg) {
  console.error(`ingest: ${msg}`);
  process.exit(1);
}

async function main() {
  if (!TICKER) die("set TICKER=<ticker> (e.g. TICKER=vedl).");
  if (INGEST_MODE !== "text") {
    console.warn(`ingest: INGEST_MODE='${INGEST_MODE}' is a Prompt-4 hook; this stage stays text-only (no LLM).`);
  }
  const mpath = manifestPath(TICKER);
  if (!existsSync(mpath)) die(`manifest not found: ${mpath}. Run acquisition first (scrape / ingest:upload).`);

  const manifest = JSON.parse(readFileSync(mpath, "utf8"));
  const docs = (manifest.documents || []).slice(0, LIMIT);
  if (!docs.length) die("manifest has no documents.");

  const corpusDocs = [];
  const needsOcr = [];
  let totalChars = 0;
  let totalChunks = 0;
  const speakers = new Set();

  for (const d of docs) {
    const abs = join(outputDir(TICKER), d.local_path);
    if (!existsSync(abs)) {
      console.error(`  ✗ ${d.id}: file missing (${d.local_path})`);
      continue;
    }
    const { pages, pageCount, chars, needs_ocr } = await extractPdf(abs);

    let sections = [];
    let chunks = [];
    if (needs_ocr) {
      needsOcr.push(d.id);
    } else {
      const norm = normalizeDocument(d.type, pages, { threshold: 0.4 });
      sections = norm.sections;
      chunks = chunkSections(sections, {
        docId: d.id,
        quarter: d.quarter,
        chunkTokens: CHUNK_TOKENS,
        overlap: CHUNK_OVERLAP,
      });
      for (const s of sections) if (s.speaker) speakers.add(s.speaker);
    }

    totalChars += chars;
    totalChunks += chunks.length;
    corpusDocs.push({
      id: d.id,
      type: d.type,
      quarter: d.quarter,
      date: d.date ?? null,
      source_url: d.source_url ?? null,
      local_path: d.local_path,
      pages: pageCount,
      chars,
      needs_ocr,
      sections,
      chunks,
    });
    const turnInfo = d.type === "transcript" ? `${sections.length} turns` : `${sections.length} slides`;
    console.log(`  ✓ ${d.id.padEnd(22)} ${pageCount}p ${chars}c → ${turnInfo}, ${chunks.length} chunks${needs_ocr ? "  [needs_ocr]" : ""}`);
  }

  const byType = corpusDocs.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + 1), m), {});
  const corpus = {
    ticker: (manifest.ticker || TICKER).toUpperCase(),
    company: {
      name: manifest.company?.name ?? null,
      fiscal_year_end: manifest.company?.fiscal_year_end ?? null,
    },
    generated_at: new Date().toISOString(),
    documents: corpusDocs,
    stats: {
      docs: corpusDocs.length,
      total_chars: totalChars,
      total_chunks: totalChunks,
      by_type: byType,
      chunk_tokens: CHUNK_TOKENS,
      chunk_overlap: CHUNK_OVERLAP,
      needs_ocr: needsOcr,
    },
  };

  ensureDir(outputDir(TICKER));
  const out = join(outputDir(TICKER), "corpus.json");
  writeFileSync(out, JSON.stringify(corpus, null, 2) + "\n");

  console.log("\n──────── ingest summary ────────");
  console.log(`  docs       : ${corpus.stats.docs} (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ")})`);
  console.log(`  pages      : ${corpusDocs.reduce((s, d) => s + d.pages, 0)}`);
  console.log(`  chars      : ${totalChars}`);
  console.log(`  chunks     : ${totalChunks}`);
  console.log(`  speakers   : ${speakers.size}`);
  console.log(`  needs_ocr  : ${needsOcr.length ? needsOcr.join(", ") : "none"}`);
  console.log(`  corpus     : ${out}`);
}

main().catch((e) => die(e.stack || e.message));
