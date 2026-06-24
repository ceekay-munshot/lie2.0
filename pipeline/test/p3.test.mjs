#!/usr/bin/env node
/**
 * p3.test.mjs — deterministic unit tests for the ingestion stage (no network,
 * no LLM). Covers normalizer (de-boilerplate, de-hyphenation, role tagging,
 * slide titles + is_guidance), chunker (token cap, metadata, no mid-turn split),
 * and the needs_ocr path on a text-layer-less PDF.
 *
 *   node pipeline/test/p3.test.mjs
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTranscript, normalizePresentation } from "../lib/normalize-text.mjs";
import { chunkSections } from "../lib/chunk.mjs";
import { extractPdf } from "../lib/pdftext.mjs";

let fails = 0;
const ok = (cond, label) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
};

/* ---- 3) Normalizer: transcript fixture --------------------------------- */
console.log("normalizer — transcript:");
const tPages = [
  'Sensitivity: Public (C4)\nAcme Corp\nJan 1, 2026\nPage 1 of 3\n' +
    '“Acme Q2 FY \'26 Earnings Conference Call”\nJanuary 1, 2026\n' +
    'MANAGEMENT: MR. JOHN DOE – CHIEF EXECUTIVE OFFICER, ACME\nMS. JANE ROE – CHIEF FINANCIAL OFFICER, ACME',
  'Sensitivity: Public (C4)\nAcme Corp\nJan 1, 2026\nPage 2 of 3\n' +
    'Moderator: Welcome. We will now begin the question-and-answer session.\n' +
    'John Doe: Our reve-\nnue grew strongly this quarter.\n' +
    'Amit Kumar: Thanks for taking my question.',
  'Sensitivity: Public (C4)\nAcme Corp\nJan 1, 2026\nPage 3 of 3\n' +
    'Jane Roe: Margins improved by 200 bps.\nModerator: That concludes the call.',
];
const tn = normalizeTranscript(tPages);
const allText = tn.sections.map((s) => s.text).join(" ");
ok(!/Sensitivity\s*:/i.test(allText), 'strips "Sensitivity:"');
ok(!/\bPage\s+\d+\s+of\s+\d+\b/i.test(allText), 'strips "Page X of Y"');
ok(tn.sections.every((s) => !/^Acme Corp$/.test(s.text)), "removes repeated company/date header line");
ok(/revenue grew strongly/i.test(allText), "de-hyphenates wrapped word (reve-\\nnue → revenue)");
const roleOf = (name) => (tn.sections.find((s) => s.speaker === name) || {}).role;
ok(roleOf("John Doe") === "management", "John Doe → management (roster)");
ok(roleOf("Jane Roe") === "management", "Jane Roe → management (roster)");
ok(roleOf("Amit Kumar") === "analyst", "Amit Kumar → analyst (not on roster)");
ok(tn.sections.some((s) => s.role === "moderator"), "Moderator → moderator");

/* ---- 3) Normalizer: presentation fixture ------------------------------- */
console.log("normalizer — presentation:");
const pPages = [
  "Title Slide\nAcme Q2 FY26 Results",
  "Revenue Outlook\nWe target 20% growth and capex of 100 cr next year",
  "Safety First\nZero harm remains our focus",
];
const pn = normalizePresentation(pPages);
ok(pn.sections[1].title === "Revenue Outlook", "slide gets its title");
ok(pn.sections[1].is_guidance === true, "guidance slide flagged (target/capex/outlook)");
ok(pn.sections[2].is_guidance === false, "non-guidance slide not flagged");

/* ---- 4) Chunker -------------------------------------------------------- */
console.log("chunker:");
const sections = [
  { kind: "qa", speaker: "John Doe", role: "management", page: 1, text: "A".repeat(220) },
  { kind: "qa", speaker: "Amit Kumar", role: "analyst", page: 1, text: "B".repeat(220) },
  { kind: "qa", speaker: "John Doe", role: "management", page: 2, text: "C".repeat(5000) },
];
const chunks = chunkSections(sections, { docId: "d1", quarter: "Q2FY26", chunkTokens: 100, overlap: 20 });
const cap = Math.ceil(100 * 1.1);
ok(chunks.every((c) => c.approx_tokens <= cap), `all chunks ≤ ${cap} tokens (CHUNK_TOKENS+10%)`);
ok(chunks.every((c) => c.doc_id === "d1" && c.quarter === "Q2FY26" && c.chunk_id && c.page_start && "kind" in c), "chunks carry full metadata");
ok(chunks.some((c) => c.text.includes("A".repeat(220))), "short turn kept intact (not split mid-turn)");
ok(!chunks.some((c) => c.text.includes("C".repeat(5000))), "over-long turn was split across chunks");
ok(new Set(chunks.map((c) => c.chunk_id)).size === chunks.length, "chunk_ids unique");

/* ---- 5) needs_ocr on a text-layer-less PDF ----------------------------- */
console.log("needs_ocr:");
const dir = mkdtempSync(join(tmpdir(), "p3-"));
const blank = join(dir, "blank.pdf");
// Valid one-page PDF with NO text content stream.
writeFileSync(
  blank,
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
let r;
let crashed = false;
try {
  r = await extractPdf(blank);
} catch {
  crashed = true;
}
ok(!crashed, "extractPdf does not crash on a text-layer-less PDF");
ok(r && r.needs_ocr === true, "text-layer-less PDF flagged needs_ocr:true");

console.log(fails === 0 ? "\nALL P3 UNIT TESTS PASSED" : `\n${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
