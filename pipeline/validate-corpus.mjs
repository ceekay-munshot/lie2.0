#!/usr/bin/env node
/**
 * validate-corpus.mjs — assert a corpus.json is well-formed and clean.
 *
 * Checks:
 *   - every manifest document is present in the corpus;
 *   - each corpus doc has sections[] and chunks[] (unless needs_ocr);
 *   - chunk approx_tokens ≤ CHUNK_TOKENS (+10% tolerance);
 *   - no boilerplate survives ("Sensitivity: …" / "Page \d+ of \d+") in any
 *     section or chunk text;
 *   - section roles ∈ {management, analyst, moderator, null};
 *   - chunk metadata is complete and chunk_ids are unique.
 *
 * Usage:
 *   TICKER=vedl node pipeline/validate-corpus.mjs
 *   node pipeline/validate-corpus.mjs vedl
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestPath, outputDir } from "./lib/manifest.mjs";

const TICKER = (process.env.TICKER || process.argv.slice(2).find((a) => !a.startsWith("-")) || "").trim();
if (!TICKER) {
  console.error("Set TICKER=<ticker> (e.g. TICKER=vedl).");
  process.exit(1);
}

const corpusPath = join(outputDir(TICKER), "corpus.json");
if (!existsSync(corpusPath)) {
  console.error(`corpus not found: ${corpusPath}. Run: TICKER=${TICKER} node pipeline/ingest.mjs`);
  process.exit(1);
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const manifest = existsSync(manifestPath(TICKER)) ? JSON.parse(readFileSync(manifestPath(TICKER), "utf8")) : null;

const VALID_ROLES = new Set(["management", "analyst", "moderator", null]);
const CHUNK_TOKENS = corpus.stats?.chunk_tokens || Number(process.env.CHUNK_TOKENS || 1500);
const MAX_TOKENS = Math.ceil(CHUNK_TOKENS * 1.1);
const BOILERPLATE = [/Sensitivity\s*:/i, /\bPage\s+\d+\s+of\s+\d+\b/i];
const REQUIRED_CHUNK_KEYS = ["chunk_id", "doc_id", "quarter", "page_start", "page_end", "kind", "approx_tokens", "text"];

const errors = [];
const docsById = new Map(corpus.documents.map((d) => [d.id, d]));

// 1) every manifest doc present
if (manifest) {
  for (const md of manifest.documents || []) {
    if (!docsById.has(md.id)) errors.push(`manifest doc "${md.id}" missing from corpus`);
  }
}

const seenChunkIds = new Set();
for (const d of corpus.documents) {
  const at = `doc ${d.id}`;
  if (!Array.isArray(d.sections)) errors.push(`${at}: sections is not an array`);
  if (!Array.isArray(d.chunks)) errors.push(`${at}: chunks is not an array`);

  if (!d.needs_ocr) {
    if (!d.sections?.length) errors.push(`${at}: no sections (and not needs_ocr)`);
    if (!d.chunks?.length) errors.push(`${at}: no chunks (and not needs_ocr)`);
  }

  for (const s of d.sections || []) {
    if (!VALID_ROLES.has(s.role ?? null)) errors.push(`${at}: invalid role ${JSON.stringify(s.role)}`);
    for (const re of BOILERPLATE) {
      if (re.test(s.text || "")) errors.push(`${at}: boilerplate survived in section p${s.page} (${re})`);
    }
  }

  for (const c of d.chunks || []) {
    for (const k of REQUIRED_CHUNK_KEYS) {
      if (!(k in c)) errors.push(`${at}: chunk missing key "${k}"`);
    }
    if (seenChunkIds.has(c.chunk_id)) errors.push(`${at}: duplicate chunk_id ${c.chunk_id}`);
    seenChunkIds.add(c.chunk_id);
    if (c.approx_tokens > MAX_TOKENS) {
      errors.push(`${at}: chunk ${c.chunk_id} = ${c.approx_tokens} tokens > ${MAX_TOKENS} (CHUNK_TOKENS+10%)`);
    }
    for (const re of BOILERPLATE) {
      if (re.test(c.text || "")) errors.push(`${at}: boilerplate survived in chunk ${c.chunk_id} (${re})`);
    }
  }
}

if (errors.length) {
  console.error(`  ✗ ${TICKER.toUpperCase()} corpus invalid:`);
  for (const e of errors.slice(0, 40)) console.error(`      ${e}`);
  if (errors.length > 40) console.error(`      … and ${errors.length - 40} more`);
  process.exit(1);
}

console.log(
  `  ✓ ${TICKER.toUpperCase()} corpus valid: ${corpus.documents.length} docs, ` +
    `${corpus.stats.total_chunks} chunks ≤ ${MAX_TOKENS} tok, no boilerplate, roles OK` +
    `${corpus.stats.needs_ocr?.length ? ` (needs_ocr: ${corpus.stats.needs_ocr.join(", ")})` : ""}`,
);
