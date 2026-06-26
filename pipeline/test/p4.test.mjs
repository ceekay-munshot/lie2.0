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
import { buildDocText, assemblePromises, segmentText, qaTurnIsGuidance, mockExtract } from "../extract.mjs";
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

// ---- 1b) Q&A guidance pre-filter -------------------------------------------
console.log("\nQ&A guidance pre-filter:");
const qaDoc = {
  id: "qfilter", quarter: "Q1FY26", type: "transcript", date: "2025-07-31",
  sections: [
    { kind: "prepared_remarks", role: "management", speaker: "CEO", page: 1, text: "Thank you all for joining; it has been a solid start to the year." },
    { kind: "qa", role: "analyst", speaker: "A1", page: 2, text: "Congrats. How is the weather at the plant?" },
    { kind: "qa", role: "management", speaker: "CFO", page: 2, text: "Thank you, the weather has been pleasant and the team is doing great work." },
    { kind: "qa", role: "analyst", speaker: "A2", page: 3, text: "And on guidance?" },
    { kind: "qa", role: "management", speaker: "CFO", page: 3, text: "We target FY26 EBITDA margin of 18 to 20 percent." },
  ],
};
const qaText = buildDocText(qaDoc);
ok(qaText.includes("solid start to the year"), "prepared remarks always kept (even with no number)");
ok(qaText.includes("FY26 EBITDA margin of 18 to 20"), "guidance-bearing Q&A answer kept");
ok(!qaText.includes("weather has been pleasant"), "non-guidance Q&A chatter dropped");
ok(buildDocText(qaDoc, "all").includes("weather has been pleasant"), "EXTRACT_SCOPE=all keeps all turns (filter off)");
// Codex #1: spelled-out quarters + question-aware classification
ok(qaTurnIsGuidance("It will be $50 per ton in Quarter 3 and $50 per ton in Quarter 4.") === true, "spelled-out 'Quarter 3/4' + number is kept");
ok(qaTurnIsGuidance("Just about 25 of them.", "What is the capex guidance for next year?") === true, "terse numeric answer to a guidance question kept via context");
ok(qaTurnIsGuidance("We felt good about the team's effort overall.") === false, "no number / period / keyword → dropped");
// Codex #3: a dropped handoff turn must not strip the analyst context from the real answer
const handoffDoc = {
  id: "handoff", quarter: "Q2FY26", type: "transcript", date: "2025-10-31",
  sections: [
    { kind: "qa", role: "analyst", speaker: "An", page: 1, text: "On the aluminium cost of production, where do you see it landing?" },
    { kind: "qa", role: "management", speaker: "CEO", page: 1, text: "Rajiv, I will go straight to you." },
    { kind: "qa", role: "management", speaker: "Rajiv", page: 1, text: "It will be about $1,750 per ton." },
  ],
};
const ht = buildDocText(handoffDoc);
ok(!ht.includes("go straight to you"), "courtesy/handoff turn dropped");
ok(ht.includes("$1,750 per ton"), "the substantive follow-up answer kept");
ok(ht.includes("[Analyst context:") && ht.includes("cost of production"), "analyst context preserved across the dropped handoff");
// Codex round 2 #1: "plan" must not match "plant"/"plants" (industrial chatter)
ok(qaTurnIsGuidance("the plant is running well at high utilisation") === false, "'plant' chatter is NOT kept (plan≠plant)");
ok(qaTurnIsGuidance("we plan to get there") === true, "'plan' (planning word) is kept");
// Codex round 2 #3: relative targets without a digit are kept (directly or via context)
ok(qaTurnIsGuidance("we will halve net debt over time") === true, "relative target 'halve net debt' kept");
ok(qaTurnIsGuidance("we should bring it down by half", "what about net debt?") === true, "digit-less relative answer to a guidance question kept via context");
ok(qaTurnIsGuidance("we should bring it down meaningfully", "what about net debt?") === false, "no number / quantity word → still dropped");
// Codex round 3 #1: a plain affirmation of a measurable target stated in the question
ok(qaTurnIsGuidance("Yes, Rashi, that is right.", "Your captive alumina target for 1Q'27 is 80%, right?") === true, "affirmation of a measurable target in the question is kept");
ok(qaTurnIsGuidance("Yes, absolutely.", "Did you enjoy the conference this year?") === false, "affirmation to a NON-measurable question is dropped");
// Codex round 3 #2: date-only timeline milestones (forward period + milestone verb, no digit)
ok(qaTurnIsGuidance("The expansion will complete next quarter.") === true, "date-only milestone 'complete next quarter' is kept");
ok(qaTurnIsGuidance("We should get approval this fiscal.") === true, "date-only milestone 'approval this fiscal' is kept");
ok(qaTurnIsGuidance("It looks good for next quarter.") === false, "forward period with no number/milestone verb → dropped");
// Codex round 4 #4: Indian call notation (1Q'27, 2HFY26)
ok(qaTurnIsGuidance("we will do 80% in 1Q'27") === true, "leading-digit quarter notation 1Q'27 recognised");
ok(qaTurnIsGuidance("it finishes in 2HFY26") === true, "half-year notation 2HFY26 + milestone recognised");
// Codex round 4 #1: a relative target stated in the question (no digit) is measurable
ok(qaTurnIsGuidance("Yes, correct.", "You still intend to halve net debt, right?") === true, "affirmation of a digit-less relative target in the question is kept");
// Codex round 4 #3: context must NOT bleed into the next (unrelated) management turn
const bleedDoc = {
  id: "bleed", quarter: "Q3FY26", type: "transcript", date: "2026-01-29",
  sections: [
    { kind: "qa", role: "analyst", speaker: "An", page: 1, text: "Is your captive alumina target 80% for 1Q'27?" },
    { kind: "qa", role: "management", speaker: "CFO", page: 1, text: "Yes, that is right." },
    { kind: "qa", role: "management", speaker: "CEO", page: 1, text: "On a separate note, our EBITDA outlook stays strong." },
  ],
};
const bt = buildDocText(bleedDoc);
ok(bt.split("captive alumina").length - 1 === 1, "analyst question attaches to its answer only, not the next unrelated turn");
ok(bt.includes("CEO: On a separate note"), "the unrelated management turn is still kept (on its own merit)");

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

// ---- 2b) promise_key + figure_in_quote -------------------------------------
console.log("\npromise_key + figure_in_quote:");
ok(promises.every((p) => typeof p.promise_key === "string" && p.promise_key.split("|").length === 3), "every row carries a promise_key (category|period|subject)");
ok(ebitda.promise_key.startsWith("ebitda|"), "promise_key starts with the category");
ok(promises.every((p) => p.figure_in_quote === true), "numeric targets here all have their figure in the grounded quote");
// numeric target whose quote has NO figure → flagged false, but kept (never dropped)
const noFig = assemblePromises(
  [{ model: "gemini", source_id: "x", source_label: "X", date: "2025-07-31", quarter_context: "Q1FY26",
     category: "margin", promise: "margin up", quote: "margins will expand meaningfully going forward",
     metric: "margin expansion", target: { text: "to 20%", value: 20, value_high: null, unit: "%", period: "FY26" }, confidence: "M" }],
  { docTextById: new Map([["x", "margins will expand meaningfully going forward"]]) },
);
ok(noFig.promises.length === 1 && noFig.promises[0].figure_in_quote === false, "numeric target with a digit-less quote → figure_in_quote=false (flagged, not dropped)");
// Codex #2: a fiscal-period digit (FY26) must not count as the target figure
const periodOnly = assemblePromises(
  [{ model: "gemini", source_id: "z", source_label: "Z", date: "2025-07-31", quarter_context: "Q1FY26",
     category: "margin", promise: "margin up", quote: "margins will expand in FY26",
     metric: "margin", target: { text: "to 20%", value: 20, value_high: null, unit: "%", period: "FY26" }, confidence: "M" }],
  { docTextById: new Map([["z", "margins will expand in FY26"]]) },
);
ok(periodOnly.promises[0].figure_in_quote === false, "period digit (FY26) alone → figure_in_quote=false");
// Codex round 2 #2: a numeric target.text with null value still triggers the check
const textNumeric = assemblePromises(
  [{ model: "gemini", source_id: "w", source_label: "W", date: "2025-07-31", quarter_context: "Q1FY26",
     category: "margin", promise: "margin up", quote: "margins will expand meaningfully",
     metric: "margin", target: { text: "to 20%", value: null, value_high: null, unit: "%", period: "FY26" }, confidence: "M" }],
  { docTextById: new Map([["w", "margins will expand meaningfully"]]) },
);
ok(textNumeric.promises[0].figure_in_quote === false, "numeric target.text ('to 20%') with null value still flags a digit-less quote");
// Codex round 4 #2: a real 1900–2099 figure must survive the period strip
const bigFig = assemblePromises(
  [{ model: "gemini", source_id: "b", source_label: "B", date: "2025-07-31", quarter_context: "Q1FY26",
     category: "capacity", promise: "add capacity", quote: "we will add capacity of 2000 MW",
     metric: "capacity", target: { text: "2000 MW", value: 2000, value_high: null, unit: "MW", period: "FY28" }, confidence: "M" }],
  { docTextById: new Map([["b", "we will add capacity of 2000 MW"]]) },
);
ok(bigFig.promises[0].figure_in_quote === true, "a real 1900–2099 figure (2000 MW) survives the period strip");
// relative target ("double") with no digit → counts via the quantity word
const relFig = assemblePromises(
  [{ model: "gemini", source_id: "y", source_label: "Y", date: "2025-07-31", quarter_context: "Q1FY26",
     category: "capacity", promise: "double capacity", quote: "we will double our aluminium capacity going forward",
     metric: "capacity doubles", target: { text: "2x", value: 2, value_high: null, unit: "x", period: "FY28" }, confidence: "M" }],
  { docTextById: new Map([["y", "we will double our aluminium capacity going forward"]]) },
);
ok(relFig.promises[0].figure_in_quote === true, "relative target ('double') counts as figure-in-quote via a quantity word");

// ---- 2c) offline mock extractor (PROVIDER=mock, $0) ------------------------
console.log("\nmock extractor (offline, no API):");
const mres = mockExtract(d1);
ok(Array.isArray(mres.promises) && mres.calls === 0, "mockExtract returns promises with calls=0 (no API call)");
ok(mres.promises.length >= 1, "mockExtract surfaces ≥1 guidance sentence from the corpus");
ok(mres.promises.every((p) => d1.text.includes(p.quote)), "every mock quote is a verbatim substring (so it grounds)");
ok(mres.promises.every((p) => p.quote.split(/\s+/).length <= 25), "mock quotes are ≤25 words");
const masm = assemblePromises(mres.promises.map((p) => ({ ...p, model: "mock", source_id: d1.id, source_label: d1.label, date: d1.date })), { docTextById: new Map([[d1.id, d1.text]]) });
ok(masm.promises.length >= 1 && masm.promises.every((p) => p.promise_key && typeof p.figure_in_quote === "boolean" && /^p\d{3}$/.test(p.id)), "mock rows pass through the full pipeline with the canonical shape");

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

// failover: one combined quota pool, used in priority order; a daily-limited
// provider is dropped for the remaining docs; each doc extracted exactly once.
console.log("\nfailover (sequential quota pool):");
const fdocs = [d1, d2, { id: "d3", quarter: "Q4FY26", type: "transcript", date: "2026-04-29", text: "x", sections: [] }];
let geminiTries = 0;
const failMock = async (cfg, doc) => {
  if (cfg.provider === "gemini") {
    geminiTries++;
    const e = new Error("gemini HTTP 429 (daily/quota limit — not retrying)");
    e.daily = true;
    throw e;
  }
  return { promises: [{ quarter_context: doc.quarter, category: "revenue", promise: "x", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }], calls: 1 };
};
const fo = await runExtraction({
  docs: fdocs,
  providers: [{ provider: "gemini", model: "g" }, { provider: "groq", model: "q" }, { provider: "mistral", model: "m" }],
  extractOne: failMock,
  strategy: "failover",
  concurrency: 1,
});
ok(geminiTries === 1, "daily-limited gemini dropped after its first failure (not retried per-doc)");
ok(fo.stats.by_model.groq === fdocs.length && !fo.stats.by_model.mistral, "groq picks up every remaining doc; mistral never touched");
ok(fo.contributors.length === 1 && fo.contributors[0] === "groq", "only one provider does the work per doc (no redundant extraction)");

// failover, MID-DOC daily limit: a provider that does some segments then 429s
// returns a PARTIAL result carrying `daily`. It must still be dropped, and the
// next provider must cover that doc's remainder (else those commitments vanish).
console.log("\nfailover (mid-doc daily limit → partial, drop + cover remainder):");
let midGemini = 0, midGroq = 0;
const midMock = async (cfg, doc) => {
  if (cfg.provider === "gemini") {
    midGemini++;
    return { promises: [{ quarter_context: doc.quarter, category: "revenue", promise: "g", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }], calls: 2, errors: ["part 2/2: 429 daily/quota limit"], daily: true };
  }
  if (cfg.provider === "groq") midGroq++;
  return { promises: [{ quarter_context: doc.quarter, category: "capex", promise: "k", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }], calls: 1 };
};
const mid = await runExtraction({
  docs: [d1, d2],
  providers: [{ provider: "gemini", model: "g" }, { provider: "groq", model: "q" }, { provider: "mistral", model: "m" }],
  extractOne: midMock,
  strategy: "failover",
  concurrency: 1,
});
ok(midGemini === 1, "mid-doc daily: gemini tried once then dropped for the remaining doc");
ok(midGroq === 2, "mid-doc daily: groq covers the partial doc's remainder AND the next doc");
ok(mid.stats.by_model.gemini === 1 && mid.stats.by_model.groq === 2, "partial gemini promises kept AND the groq fallback recorded");
ok(mid.stats.errors.some((e) => /daily\/quota/i.test(e.reason)), "the mid-doc daily error is surfaced in stats.errors");

// failover under the DEFAULT concurrency (>1): the daily-limited provider is still
// dropped and every doc still covered — the race only costs ≤(concurrency) extra
// fast-failing probes, never a lost or unhandled document.
console.log("\nfailover (concurrent drop at default concurrency=2):");
let cGemini = 0;
const cMock = async (cfg, doc) => {
  if (cfg.provider === "gemini") { cGemini++; const e = new Error("gemini HTTP 429 (daily/quota limit)"); e.daily = true; throw e; }
  return { promises: [{ quarter_context: doc.quarter, category: "revenue", promise: "x", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }], calls: 1 };
};
const cfo = await runExtraction({
  docs: fdocs,
  providers: [{ provider: "gemini", model: "g" }, { provider: "groq", model: "q" }, { provider: "mistral", model: "m" }],
  extractOne: cMock,
  strategy: "failover",
  concurrency: 2,
});
ok(cfo.stats.by_model.groq === fdocs.length && !cfo.stats.by_model.mistral, "concurrency=2: groq still covers every doc; no document lost");
ok(cGemini >= 1 && cGemini <= 2, `concurrency=2: gemini probed ≤ concurrency times then dropped (got ${cGemini})`);

// failover, PARTIAL non-daily failure (a segment exhausts its retries): keep what
// we got but still fall through so the next provider covers the failed segment(s).
// The provider is NOT dropped — only this one doc gave it trouble.
console.log("\nfailover (partial non-daily → fall through, provider kept):");
let ppGemini = 0, ppGroq = 0;
const ppMock = async (cfg, doc) => {
  if (cfg.provider === "gemini") {
    ppGemini++;
    if (doc.id === d1.id) // d1: one segment failed (non-daily) → partial
      return { promises: [{ quarter_context: doc.quarter, category: "revenue", promise: "g", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }], calls: 2, errors: ["part 2/2: 500 after retries"] };
    return { promises: [{ quarter_context: doc.quarter, category: "ebitda", promise: "e", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }], calls: 1 }; // d2 clean
  }
  if (cfg.provider === "groq") ppGroq++;
  return { promises: [{ quarter_context: doc.quarter, category: "capex", promise: "k", quote: "q", metric: "m", target: { period: "FY26" }, confidence: "M" }], calls: 1 };
};
const pp = await runExtraction({
  docs: [d1, d2],
  providers: [{ provider: "gemini", model: "g" }, { provider: "groq", model: "q" }, { provider: "mistral", model: "m" }],
  extractOne: ppMock,
  strategy: "failover",
  concurrency: 1,
});
ok(ppGemini === 2, "partial non-daily: gemini NOT dropped — it still extracts the clean d2");
ok(ppGroq === 1, "partial non-daily: groq covers ONLY the doc gemini couldn't finish (d1)");
ok(pp.stats.by_model.gemini === 2 && pp.stats.by_model.groq === 1, "partial promises kept AND the fallback's recorded");
ok(!pp.contributors.includes("mistral"), "mistral untouched (failover still conserves quota)");

// failover, ALL providers exhausted: remaining docs must be REPORTED (a doc-level
// "(none)" error), never silently absent from the output.
console.log("\nfailover (all providers exhausted → docs reported, not silent):");
const exDocs = [d1, d2, { id: "d3", quarter: "Q4FY26", type: "transcript", date: "2026-04-29", text: "x", sections: [] }];
const exMock = async (cfg) => { const e = new Error(`${cfg.provider} HTTP 429 (daily/quota limit)`); e.daily = true; throw e; };
const ex = await runExtraction({
  docs: exDocs,
  providers: [{ provider: "gemini", model: "g" }, { provider: "groq", model: "q" }, { provider: "mistral", model: "m" }],
  extractOne: exMock,
  strategy: "failover",
  concurrency: 1,
});
ok(ex.promises.length === 0, "all-exhausted: no promises produced");
const skipped = ex.stats.errors.filter((e) => e.provider === "(none)");
ok(skipped.length === exDocs.length, `every doc reported (got ${skipped.length}/${exDocs.length} doc-level notes)`);
ok(skipped.every((e) => /exhaust|incomplete|skip/i.test(e.reason)), "each doc-level note explains it was not extracted");

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
ok(isDailyLimit(429, 0, "Quota exceeded for quota metric 'GenerateRequestsPerMinute', limit per minute") === false, "per-minute message that says 'quota' → transient, NOT daily");
ok(isDailyLimit(429, 0, "Requests per day (RPD) limit reached") === true, "RPD body marker → daily");
ok(isDailyLimit(500, 9999, "") === false, "non-429 → not a daily limit");

console.log(fails === 0 ? "\nALL P4 UNIT TESTS PASSED" : `\n${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
