/**
 * find-actual.mjs — the ONLY LLM step in verification, and it RETRIEVES, never judges.
 * For each promise it gathers evidence from LATER documents (dated after the promise),
 * makes one structured call, and returns the reported actual + (for a shortfall) the
 * management explanation and a root-cause suggestion. Status/variance are decided by
 * the deterministic rules, never here.
 *
 * Mock-aware (PROVIDER=mock / no keys → canned actuals, $0) and cached per promise.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { completeJSON, providerConfig } from "./llm.mjs";
import { EXTRACTION_PROVIDERS } from "./multi-llm.mjs";
import { subjectTokens } from "./dedup.mjs";

export const ROOT_CAUSES = ["Demand slowdown", "Pricing / mix", "Cost inflation", "Supply chain", "Execution", "Capacity delay", "Regulatory", "Working capital", "Capital allocation", "Other"];
export const FIND_ACTUAL_VERSION = "p5-2026-06a";

const ACTUAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actual_text", "what_happened"],
  properties: {
    actual_text: { type: ["string", "null"], description: "the reported figure/outcome, verbatim-ish; null if not reported" },
    actual_value: { type: ["number", "null"] },
    actual_unit: { type: ["string", "null"] },
    source_id: { type: ["string", "null"] },
    source_date: { type: ["string", "null"] },
    what_happened: { type: ["string", "null"], description: "<=25 words: what the company actually reported / where the milestone stands" },
    mgmt_explanation: { type: ["string", "null"], description: "<=25 words; only if management explains a shortfall, else null" },
    root_cause_suggestion: { enum: [...ROOT_CAUSES, null] },
  },
};

const SYSTEM = `You RETRIEVE the reported ACTUAL outcome for a single management promise from later earnings documents (transcripts/presentations). Return ONLY what the documents report: the figure or milestone status reached, which document, and — if a shortfall is explained — management's stated reason plus the closest root-cause label.

You do NOT decide whether the promise was met or missed — a separate deterministic step does that. Just report the actual.

Rules:
- If the evidence does not report this metric's outcome, set actual_text and what_happened to null.
- what_happened and mgmt_explanation are <= 25 words each. mgmt_explanation is null unless management actually explains a miss.
- root_cause_suggestion must be one of the allowed labels or null.
- For a timeline/milestone, what_happened should say whether it was commissioned/completed, or re-guided to a new period (state the new period verbatim, e.g. "re-set to 1HFY27").`;

const norm = (s) => String(s || "").toLowerCase();

/** Later-document sections that mention the promise's subject, best overlap first. */
export function buildEvidence(promise, corpus, maxSections = 8) {
  const subj = subjectTokens(`${promise.metric || ""} ${promise.promise || ""}`);
  if (subj.size === 0) return [];
  const out = [];
  for (const doc of corpus.documents || []) {
    if (!doc.date || !promise.date || String(doc.date) <= String(promise.date)) continue; // strictly later
    for (const s of doc.sections || []) {
      const toks = subjectTokens(s.text || "");
      let ov = 0;
      for (const t of subj) if (toks.has(t)) ov += 1;
      if (ov > 0) out.push({ doc_id: doc.id, date: doc.date, quarter: doc.quarter, overlap: ov, text: s.text || "" });
    }
  }
  out.sort((a, b) => b.overlap - a.overlap || String(b.date).localeCompare(String(a.date)));
  return out.slice(0, maxSections);
}

function buildMessages(promise, evidence) {
  const ev = evidence.map((e) => `[${e.quarter} · ${e.doc_id} · ${e.date}] ${e.text.slice(0, 600)}`).join("\n---\n");
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `PROMISE (made in ${promise.quarter_context}): ${promise.promise}\n` +
        `METRIC / TARGET: ${promise.metric}${promise.target?.text ? ` | ${promise.target.text}` : ""}\n` +
        `CATEGORY: ${promise.category}\n\nLATER-DOCUMENT EVIDENCE:\n${ev}\n\n` +
        `Retrieve the reported actual for THIS metric. Retrieval only — do not judge pass/fail.`,
    },
  ];
}

/** Shape an LLM/mock result into {actual, mgmt_explanation, root_cause}. */
function shape(data, evidence) {
  if (!data || !data.actual_text) return { actual: null, mgmt_explanation: null, root_cause: null };
  const top = evidence[0] || {};
  const actual = {
    text: data.actual_text ?? null,
    value: data.actual_value ?? null,
    unit: data.actual_unit ?? null,
    source_id: data.source_id || top.doc_id || null,
    source_date: data.source_date || top.date || null,
    what_happened: data.what_happened ?? null,
  };
  const root_cause = ROOT_CAUSES.includes(data.root_cause_suggestion) ? data.root_cause_suggestion : null;
  return { actual, mgmt_explanation: data.mgmt_explanation || null, root_cause };
}

/** Deterministic canned actual from the evidence — no API, for $0 runs. */
function mockResult(promise, evidence) {
  if (!evidence.length) return { actual: null, mgmt_explanation: null, root_cause: null };
  const top = evidence[0];
  const slip = /re-?set|re-?guid|push|defer|delay|slip|now expect/i.test(top.text);
  const done = /commission|complet|operational|started|achiev|delivered/i.test(top.text);
  const what = done ? `(mock) reported delivered per ${top.quarter}` : slip ? `(mock) ${top.quarter} re-guides timing` : `(mock) ${top.quarter} reports on ${promise.category}`;
  return shape(
    { actual_text: top.text.slice(0, 100), actual_value: null, actual_unit: null, source_id: top.doc_id, source_date: top.date, what_happened: what, mgmt_explanation: null, root_cause_suggestion: null },
    evidence,
  );
}

/**
 * @returns {Promise<{results: Array<{actual,mgmt_explanation,root_cause}|null>, stats}>}
 */
export async function findActuals({ promises, corpus, mock = false, providers = null, concurrency = 2, cacheDir = null, debug = false }) {
  const chain = providers || EXTRACTION_PROVIDERS.map((p) => providerConfig(p, process.env)).filter((c) => c.apiKey);
  const stats = { calls: 0, cache_hits: 0, no_evidence: 0, errors: [] };
  const results = new Array(promises.length).fill(null);

  const one = async (promise) => {
    const evidence = buildEvidence(promise, corpus);
    if (!evidence.length) { stats.no_evidence += 1; return { actual: null, mgmt_explanation: null, root_cause: null }; }
    if (mock || chain.length === 0) {
      if (!mock) return { actual: null, mgmt_explanation: null, root_cause: null }; // non-mock, no keys → leave NYT
      return mockResult(promise, evidence);
    }
    const key = createHash("sha256").update(`${FIND_ACTUAL_VERSION}|${promise.promise_key || promise.id}|${evidence.map((e) => e.doc_id + ":" + e.overlap).join(",")}`).digest("hex");
    const cp = cacheDir ? join(cacheDir, `${String(promise.id || promise.promise_key || "p").replace(/[^\w-]/g, "_")}.json`) : null;
    if (cp && existsSync(cp)) {
      try { const c = JSON.parse(readFileSync(cp, "utf8")); if (c.key === key) { stats.cache_hits += 1; return c.value; } } catch { /* re-fetch */ }
    }
    try {
      const { data } = await completeJSON(buildMessages(promise, evidence), ACTUAL_SCHEMA, { chain, temperature: 0, maxTokens: 700, maxRetries: 5, schemaName: "actual", env: process.env });
      stats.calls += 1;
      const value = shape(data, evidence);
      if (cp) { mkdirSync(dirname(cp), { recursive: true }); writeFileSync(cp, JSON.stringify({ key, value }, null, 2)); }
      return value;
    } catch (err) {
      stats.errors.push({ promise: promise.id, reason: err.message });
      if (debug) console.error(`  ! find-actual ${promise.id}: ${err.message}`);
      return { actual: null, mgmt_explanation: null, root_cause: null };
    }
  };

  let next = 0;
  const n = Math.max(1, Math.min(concurrency, promises.length || 1));
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < promises.length) {
      const i = next++;
      results[i] = await one(promises[i]);
    }
  }));
  return { results, stats };
}
