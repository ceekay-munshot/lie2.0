#!/usr/bin/env node
/**
 * p4.test.mjs — deterministic unit tests for the extraction engine using a MOCK
 * LLM (no API keys, no network). Covers: management-only text building, the
 * multi-provider ensemble + graceful degradation, cross-model merge (found_by),
 * quote grounding (drops fabrications), reaffirmed_on + revisions, deriveTestDate,
 * the reject-vague rubric, and the recall eval.
 *
 *   node pipeline/test/p4.test.mjs
 */
import { runExtraction } from "../lib/multi-llm.mjs";
import { buildDocText, assemblePromises, segmentText } from "../extract.mjs";
import { deriveTestDate } from "../lib/test-date.mjs";
import { SYSTEM_PROMPT } from "../lib/extract-prompt.mjs";
import { evalExtraction } from "../eval-extraction.mjs";
import { isDailyLimit } from "../lib/llm.mjs";

let fails = 0;
const ok = (cond, label) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
};

// ---- tiny corpus -----------------------------------------------------------
const d1 = {
  id: "q2fy26-transcript",
  quarter: "Q2FY26",
  type: "transcript",
  date: "2025-10-31",
  sections: [
    { kind: "prepared_remarks", role: "moderator", speaker: "Moderator", page: 1, text: "Welcome to the call." },
    { kind: "prepared_remarks", role: "management", speaker: "Ajay Goel", page: 1, text: "We are confident in achieving an annual EBITDA of more than $6 billion in FY26. We are well on track to achieve capex of between $1.7 to $1.9 billion." },
    { kind: "qa", role: "analyst", speaker: "Amit Kumar", page: 2, text: "What about your alumina cost? ANALYSTQUESTIONMARKER" },
    { kind: "qa", role: "management", speaker: "Arun Misra", page: 2, text: "Alumina cost will be sub $750 per ton by Q1FY27." },
    { kind: "qa", role: "analyst", speaker: "Lone Analyst", page: 3, text: "DROPPEDANALYSTONLY no management reply follows" },
  ],
};
d1.text = buildDocText(d1);
const d2 = {
  id: "q3fy26-transcript",
  quarter: "Q3FY26",
  type: "transcript",
  date: "2026-01-29",
  sections: [
    { kind: "qa", role: "management", speaker: "Ajay Goel", page: 1, text: "We reaffirm our annual EBITDA of more than $6 billion in FY26." },
    { kind: "qa", role: "management", speaker: "Ajay Goel", page: 1, text: "FY26 capex now narrowed to about $1.7 billion." },
  ],
};
d2.text = buildDocText(d2);

// ---- 1) management-only text building --------------------------------------
console.log("management-only text:");
ok(!d1.text.includes("DROPPEDANALYSTONLY"), "standalone analyst turn (no mgmt reply) is dropped");
ok(!/\bAmit Kumar:/.test(d1.text), "analyst is not emitted as a speaker turn");
ok(d1.text.includes("[Analyst context:") && d1.text.includes("ANALYSTQUESTIONMARKER"), "preceding analyst Q kept inline as [context]");
ok(d1.text.includes("Ajay Goel:") && d1.text.includes("Arun Misra:"), "management turns kept");
ok(/\n\n/.test(d1.text), "turns separated by blank lines so segmentText can split on boundaries");

// ---- 2) mock ensemble + grounding + merge + reaffirm/revision --------------
const mock = async (cfg, doc) => {
  const p = cfg.provider;
  if (doc.id === "q2fy26-transcript") {
    const out = [];
    if (p === "gemini" || p === "groq") {
      out.push({ quarter_context: "Q2FY26", category: "ebitda", promise: "FY26 EBITDA > $6bn",
        quote: "confident in achieving an annual EBITDA of more than $6 billion in FY26",
        metric: "FY26 EBITDA > $6 billion", target: { text: "FY26 EBITDA > $6bn", value: 6, value_high: null, unit: "USD_bn", period: "FY26" }, confidence: "H" });
    }
    if (p === "gemini") {
      out.push({ quarter_context: "Q2FY26", category: "capex", promise: "FY26 capex $1.7-1.9bn",
        quote: "capex of between $1.7 to $1.9 billion",
        metric: "FY26 capex $1.7-1.9bn", target: { text: "capex 1.7-1.9bn", value: 1.7, value_high: 1.9, unit: "USD_bn", period: "FY26" }, confidence: "H" });
    }
    if (p === "mistral") {
      out.push({ quarter_context: "Q2FY26", category: "pat", promise: "PAT will double",
        quote: "our profit after tax will absolutely double next year guaranteed and certain",
        metric: "PAT doubles", target: { text: "PAT x2", value: 2, value_high: null, unit: "x", period: "FY26" }, confidence: "M" });
    }
    return { promises: out };
  }
  if (doc.id === "q3fy26-transcript") {
    return { promises: [
      { quarter_context: "Q3FY26", category: "ebitda", promise: "FY26 EBITDA > $6bn reaffirmed",
        quote: "reaffirm our annual EBITDA of more than $6 billion in FY26",
        metric: "EBITDA over $6 billion FY26", target: { text: "FY26 EBITDA > $6bn", value: 6, value_high: null, unit: "USD_bn", period: "FY26" }, confidence: "H" },
      { quarter_context: "Q3FY26", category: "capex", promise: "FY26 capex narrowed to $1.7bn",
        quote: "FY26 capex now narrowed to about $1.7 billion",
        metric: "FY26 capex narrowed to $1.7bn", target: { text: "capex 1.7bn", value: 1.7, value_high: null, unit: "USD_bn", period: "FY26" }, confidence: "H" },
    ] };
  }
  return { promises: [] };
};

const providers = [{ provider: "gemini", model: "g" }, { provider: "groq", model: "q" }, { provider: "mistral", model: "m" }];
const { promises: raw, stats } = await runExtraction({ docs: [d1, d2], providers, extractOne: mock, strategy: "ensemble", concurrency: 2 });

console.log("\nensemble + assemble:");
ok(stats.raw_candidates === raw.length && raw.length === 4 + 6, `ensemble ran all docs×providers (raw ${raw.length})`);

const docTextById = new Map([[d1.id, d1.text], [d2.id, d2.text]]);
const sectionsById = new Map([[d1.id, d1.sections], [d2.id, d2.sections]]);
const { promises, rejected_ungrounded } = assemblePromises(raw, { docTextById, sectionsById });

const ebitda = promises.find((p) => p.category === "ebitda");
const capex = promises.find((p) => p.category === "capex");
ok(rejected_ungrounded === 1 && !promises.some((p) => p.category === "pat"), "fabricated quote dropped (ungrounded)");
ok(promises.length === 2, `2 canonical promises after dedup (got ${promises.length})`);
ok(ebitda && ebitda.found_by.length === 2 && ebitda.found_by.includes("gemini") && ebitda.found_by.includes("groq"), "cross-model merge: ebitda found_by=[gemini,groq]");
ok(capex && capex.found_by.length === 1, "single-model promise kept (capex found_by=1)");
ok(ebitda && ebitda.reaffirmed_on.includes("2026-01-29"), "reaffirmed_on records the Q3 repeat (same target)");
ok(capex && capex.revisions.length === 1 && capex.revisions[0].date === "2026-01-29", "revisions records the Q3 capex change");
ok(ebitda && ebitda.quote_grounded === true && ebitda.speaker === "Ajay Goel", "grounded quote + speaker attributed");
ok(ebitda && ebitda.test_date === "2026-05-15", `deriveTestDate FY26 → 2026-05-15 (got ${ebitda && ebitda.test_date})`);
ok(promises.every((p) => /^p\d{3}$/.test(p.id)), "ids p001… assigned");

// ---- 3) graceful degradation -----------------------------------------------
console.log("\ngraceful degradation:");
const flaky = async (cfg, doc) => {
  if (cfg.provider === "groq") throw new Error("429 throttled");
  return { promises: [{ quarter_context: doc.quarter, category: "revenue", promise: "x", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }] };
};
const deg = await runExtraction({ docs: [d1], providers, extractOne: flaky, strategy: "ensemble", concurrency: 2 });
ok(deg.stats.errors.length === 1 && deg.stats.errors[0].provider === "groq", "throttled provider recorded as error");
ok(deg.contributors.includes("gemini") && deg.contributors.includes("mistral") && !deg.contributors.includes("groq"), "run continues on the other providers");

// partial-segment failure must surface (not silently drop a segment's commitments)
const partial = async (cfg, doc) => ({
  promises: [{ quarter_context: doc.quarter, category: "revenue", promise: "x", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }],
  calls: 2,
  errors: ["segment 2/2 failed: 429 throttled"],
});
const par = await runExtraction({ docs: [d1], providers: [{ provider: "groq", model: "g" }], extractOne: partial, strategy: "single" });
ok(par.stats.errors.length === 1 && /segment 2\/2/.test(par.stats.errors[0].reason), "partial-segment failure recorded in stats.errors");
ok(par.promises.length === 1, "partial success still keeps the segment that succeeded");

// ---- 4) reject-vague rubric + vague→none -----------------------------------
console.log("\nreject-vague:");
ok(/REJECT/i.test(SYSTEM_PROMPT) && /confiden|grow strongly|well positioned/i.test(SYSTEM_PROMPT), "system prompt instructs rejecting vague statements");
const vagueDoc = { id: "vague", quarter: "Q1FY26", type: "transcript", date: "2025-07-31",
  sections: [{ kind: "prepared_remarks", role: "management", speaker: "CEO", page: 1, text: "We are very optimistic and confident about strong growth." }] };
vagueDoc.text = buildDocText(vagueDoc);
const vagueRun = await runExtraction({ docs: [vagueDoc], providers: [{ provider: "gemini", model: "g" }], extractOne: async () => ({ promises: [] }), strategy: "single" });
ok(vagueRun.promises.length === 0, "vague document yields no promises");

// ---- 5) deriveTestDate spot checks -----------------------------------------
console.log("\nderiveTestDate:");
ok(deriveTestDate("Q3FY26") === "2026-02-14", `Q3FY26 → 2026-02-14 (Dec 31 +45), got ${deriveTestDate("Q3FY26")}`);
ok(deriveTestDate("2030") === "2030", "2030 → 2030");

// ---- 6) recall eval --------------------------------------------------------
console.log("\nrecall eval:");
const fixture = { company: { ticker: "TEST" }, promises: [
  { id: "p1", category: "ebitda", metric: "FY26 EBITDA > $6.0 bn", target: { period: "FY26" } },
  { id: "p2", category: "capex", metric: "FY26 capex $1.7-1.9 bn", target: { period: "FY26" } },
  { id: "p3", category: "leverage", metric: "Net debt/EBITDA < 1x", target: { period: "FY26" } },
] };
const ev = evalExtraction(promises, fixture);
ok(ev.known === 3 && ev.found === 2 && ev.recall > 0.6, `recall 2/3 (ebitda+capex matched, leverage missed) got ${ev.found}/${ev.known}`);
ok(ev.missed.some((m) => m.category === "leverage"), "missed[] lists the leverage promise");

// ---- 7) input segmentation (Groq TPM) --------------------------------------
console.log("\nsegmentation:");
const big = Array.from({ length: 20 }, (_, i) => `Speaker ${i}: ${"word ".repeat(400)}`).join("\n\n"); // ~40k chars
const segs = segmentText(big, 12000);
ok(segs.length >= 3 && segs.every((s) => s.length <= 12000), `splits oversized text into ≤cap segments (${segs.length})`);
ok(segmentText(big, Infinity).length === 1, "no cap → single segment");
ok(segmentText("short text", 12000).length === 1, "text under cap → single segment");
ok(segs.join("").includes("Speaker 19:"), "segmentation preserves all turns");

// ---- 8) rubric: forward-looking only ---------------------------------------
console.log("\nrubric (reject reported actuals):");
ok(/FORWARD-LOOKING/i.test(SYSTEM_PROMPT) && /REPORTED ACTUALS|already happened/i.test(SYSTEM_PROMPT), "prompt rejects reported actuals, keeps forward guidance");
ok(/each distinct commitment ONCE|do not split|quality over quantity/i.test(SYSTEM_PROMPT), "prompt discourages over-splitting / padding");

// ---- 9) daily vs per-minute rate-limit classification ----------------------
console.log("\nrate-limit classification:");
ok(isDailyLimit(429, 6226, "Rate limit reached ... on tokens per day (TPD): Limit 100000") === true, "TPD 429 (long Retry-After + 'per day') → daily, fail fast");
ok(isDailyLimit(429, 0, "tokens per day (TPD): Limit 100000, Used 91594") === true, "TPD 429 by body marker → daily");
ok(isDailyLimit(429, 30, "Rate limit reached: tokens per minute") === false, "per-minute 429 → transient, retry");
ok(isDailyLimit(500, 9999, "") === false, "non-429 → not a daily limit");

console.log(fails === 0 ? "\nALL P4 UNIT TESTS PASSED" : `\n${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
