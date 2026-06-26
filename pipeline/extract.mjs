#!/usr/bin/env node
/**
 * extract.mjs — the extraction engine (first LLM step). Reads a corpus, runs an
 * ENSEMBLE of Gemini + Groq + Mistral to extract measurable MANAGEMENT promises,
 * grounds every quote, cross-model-merges + dedups, derives test dates, and
 * writes promises.json. Optionally evaluates recall against a golden fixture.
 *
 *   TICKER=vedl node pipeline/extract.mjs
 *   DRY_RUN=1 TICKER=vedl node pipeline/extract.mjs        # estimate calls/tokens, no API
 *   CORPUS=pipeline/fixtures/vedl.corpus.json TICKER=vedl node pipeline/extract.mjs
 *
 * NO verification/status/variance here (that's Prompt 5). Output: promises.json.
 * Keys come from env/secrets (GEMINI_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { completeJSON, providerConfig } from "./lib/llm.mjs";
import { buildMessages, EXTRACTION_SCHEMA, PROMPT_VERSION } from "./lib/extract-prompt.mjs";
import { EXTRACTION_PROVIDERS, runExtraction, planTasks } from "./lib/multi-llm.mjs";
import { groundQuote } from "./lib/ground-quote.mjs";
import { dedup, keyOf } from "./lib/dedup.mjs";
import { deriveTestDate } from "./lib/test-date.mjs";
import { evalExtraction } from "./eval-extraction.mjs";
import { outputDir, manifestPath } from "./lib/manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const TICKER = (process.env.TICKER || process.argv.slice(2).find((a) => !a.startsWith("-")) || "").trim();
const STRATEGY = (process.env.LLM_STRATEGY || "failover").toLowerCase();
const CONCURRENCY = Number(process.env.LLM_CONCURRENCY || 2);
const SCOPE = (process.env.EXTRACT_SCOPE || "management").toLowerCase();
const LIMIT = Number(process.env.LIMIT || Infinity);
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "0";
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";
const EVAL = process.env.EVAL ? process.env.EVAL !== "0" : true;
// Offline, $0 wiring/shape validation — no API call, no spend, no key needed.
const MOCK = process.env.PROVIDER === "mock" || (!!process.env.MOCK && process.env.MOCK !== "0");

function die(msg) {
  console.error(`extract: ${msg}`);
  process.exit(1);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// Chars the system prompt + few-shots + user template add to every request — must
// be reserved against a provider's token budget before sizing a segment.
const PROMPT_OVERHEAD_CHARS = buildMessages("", { quarter: "Q0FY00", type: "transcript", label: "" })
  .reduce((n, m) => n + (m.content?.length || 0), 0);

// Q&A management answers are pre-filtered to guidance-bearing turns (prepared
// remarks are always kept in full): a Q&A turn survives only if it shows a
// guidance signal, or pairs a forward-period token with a number. This cuts the
// operational Q&A chatter that inflates raw candidates without adding promises.
// Set QA_FILTER=0 to disable (or EXTRACT_SCOPE=all, which keeps everything).
const QA_FILTER = process.env.QA_FILTER ? process.env.QA_FILTER !== "0" : true;
// Quantity words for a relative target ("double"/"halve") — a guidance signal even
// without a digit. Shared by the Q&A filter and figure_in_quote.
const QTY_WORD_RE = /\b(doubl|tripl|quadrupl|halv|half|two[\s-]?fold|three[\s-]?fold|four[\s-]?fold|fold)\w*/i;
// NB: "plans?|planned|planning" (not plan\w*) so "plant"/"plants" don't match.
const GUIDANCE_RE =
  /\b(guidance|outlook|expect\w*|target\w*|aim\w*|guid\w*|plans?|planned|planning|intend\w*|going forward|next year|next fiscal|by fy|by q[1-4]|margin|ebitda|revenue|pat|profit|capex|capacity|commission\w*|ramp\w*|volume|order ?book|working capital|net debt|leverage|debt[\s/]*ebitda|roce|cost|dividend|payout|deleverag\w*|doubl\w*|tripl\w*|quadrupl\w*|halv\w*|fold)\b/i;
const FWD_PERIOD_RE = /\b(fy\s*'?\d{2,4}|q[1-4]\s*fy\s*'?\d{2,4}|q[1-4]\b|quarter\s*[1-4]|next\s+(?:year|quarter|fiscal)|this\s+(?:year|fiscal)|full[\s-]?year|h[12]\s*fy|by\s+(?:end\s+of\s+)?(?:\w+\s+)?\d{4}|by\s+(?:end\s+of\s+)?(?:fy|q[1-4]))/i;
// Milestone verbs that make a date-only timeline answer measurable (no digit needed).
const MILESTONE_RE = /\b(complet\w*|approv\w*|start\w*|begin\w*|finish\w*|launch\w*|go[\s-]?live|on[\s-]?stream|operational|deliver\w*|first\s+production|achiev\w*)\b/i;
// Plain affirmations — management confirming a target that was stated in the question.
const AFFIRM_RE = /\b(yes|yeah|yep|correct|absolutely|exactly|indeed|that'?s right|that is right|you'?re right|on[\s-]?track|on[\s-]?schedule|confirm\w*)\b/i;
/** Is an analyst question itself a MEASURABLE guidance prompt (target lives in the Q)? */
const isMeasurableQ = (q) => GUIDANCE_RE.test(q) && (/\d/.test(q) || FWD_PERIOD_RE.test(q));
/**
 * Does a management Q&A answer carry forward-looking guidance worth keeping?
 * Also weighs the analyst question, so the filter keeps: terse numeric/relative
 * answers to a guidance Q, date-only timeline milestones ("complete next quarter"),
 * and plain affirmations of a measurable target stated in the question.
 */
export function qaTurnIsGuidance(text, question = "") {
  const t = String(text || "");
  const q = String(question || "");
  if (GUIDANCE_RE.test(t)) return true;
  // a forward period + a number, OR a date-only milestone (complete/approval/start…)
  if (FWD_PERIOD_RE.test(t) && (/\d/.test(t) || MILESTONE_RE.test(t))) return true;
  // a numeric/relative answer to a guidance-bearing question
  if ((/\d/.test(t) || QTY_WORD_RE.test(t)) && GUIDANCE_RE.test(q)) return true;
  // a plain affirmation/on-track answer to a MEASURABLE question (target is in the Q)
  return AFFIRM_RE.test(t) && isMeasurableQ(q);
}

/** Build the text shown to the model for one document. */
export function buildDocText(doc, scope = "management") {
  if (doc.type !== "transcript") {
    return (doc.sections || [])
      .map((s) => {
        const head = s.kind === "slide" ? `Slide ${s.page}${s.is_guidance ? " [GUIDANCE]" : ""}: ${s.title || ""}` : "";
        return `${head}\n${s.text}`.trim();
      })
      .join("\n\n");
  }
  // One block per management turn (with the preceding analyst Q bundled in), so
  // turns are separated by blank lines and segmentText() can split on them.
  const blocks = [];
  let lastQ = null;
  for (const s of doc.sections || []) {
    if (scope !== "all" && s.role === "analyst") {
      lastQ = s.text; // a new question resets the context
      continue;
    }
    if (scope !== "all" && s.role !== "management") continue; // skip moderator/front_matter
    // Drop operational Q&A answers with no guidance signal (prepared remarks are
    // always kept). KEEP lastQ on a drop so a handoff/courtesy turn doesn't strip
    // the analyst context from the substantive answer that follows. Classification
    // also sees the question, so a terse numeric answer to a guidance Q survives.
    if (QA_FILTER && scope !== "all" && s.kind === "qa" && !qaTurnIsGuidance(s.text, lastQ)) {
      continue;
    }
    const ctx = lastQ ? `[Analyst context: ${clip(lastQ, 300)}]\n` : "";
    blocks.push(`${ctx}${s.speaker || "Management"}: ${s.text}`);
    // Keep lastQ across consecutive management turns (a handoff + the follow-up
    // answer in the same exchange both get context); the next analyst turn resets it.
  }
  return blocks.join("\n\n");
}

/** Find which section a grounded quote came from → its speaker. */
function attributeSpeaker(quote, sections) {
  const nq = norm(quote);
  if (!nq) return null;
  for (const s of sections || []) {
    if (s.speaker && norm(s.text).includes(nq)) return s.speaker;
  }
  return null;
}

// Lenient anti-hallucination check: a numeric target should have its figure in the
// cited quote. Flags only the clear misses (numeric target, but the quote has no
// digit and no quantity word like "double"); never drops — formatting varies too
// much (₹1,700 vs "1,700 crores") to reject on. The downstream can weight on it.
// Fiscal-period tokens whose digits must NOT be mistaken for the target figure
// (e.g. "FY26", "Q4", "Quarter 3", "2030") when checking a quote for the number.
const PERIOD_TOK_RE = /\bq[1-4]\s*fy\s*'?\d{2,4}\b|\bq[1-4]\b|\bquarter\s*[1-4]\b|\bfy\s*'?\d{2,4}\b|\bh[12]\s*(?:fy)?\s*'?\d{0,4}\b|\b(?:19|20)\d{2}\b|'\d{2}\b/gi;
function figureInQuote(target, quote) {
  // A numeric target = a parsed value/range OR a figure/quantity word in target.text
  // (the schema permits text-only numeric targets with null value/value_high).
  const tText = String(target?.text || "").replace(PERIOD_TOK_RE, " ");
  const numericTarget = !!target && (target.value != null || target.value_high != null || /\d/.test(tText) || QTY_WORD_RE.test(tText));
  if (!numericTarget) return true; // nothing numeric to ground
  const q = String(quote || "").replace(PERIOD_TOK_RE, " "); // strip period digits first
  return /\d/.test(q) || QTY_WORD_RE.test(q);
}

/**
 * Ground → cross-model merge/dedup → derive test dates → shape rows. Pure given
 * the raw model-tagged promises and the source maps (exported for unit tests).
 * @returns {{promises:Array, rejected_ungrounded:number}}
 */
export function assemblePromises(raw, { docTextById = new Map(), sectionsById = new Map() } = {}) {
  let rejected_ungrounded = 0;
  const grounded = [];
  for (const p of raw) {
    const src = docTextById.get(p.source_id) || "";
    const g = groundQuote(p.quote, src);
    if (!g.grounded) {
      rejected_ungrounded += 1;
      continue;
    }
    grounded.push({
      ...p,
      quote: g.quote,
      quote_grounded: true,
      speaker: p.speaker || attributeSpeaker(g.quote, sectionsById.get(p.source_id)),
    });
  }

  const merged = dedup(grounded);
  for (const p of merged) p.test_date = deriveTestDate(p.target?.period);

  const promises = merged.map((p) => ({
    id: p.id,
    date: p.date ?? null,
    quarter_context: p.quarter_context || p.doc_quarter || null,
    source_id: p.source_id,
    source_label: p.source_label,
    speaker: p.speaker ?? null,
    category: p.category,
    promise: p.promise,
    quote: p.quote,
    quote_grounded: true,
    metric: p.metric,
    target: p.target,
    test_date: p.test_date ?? null,
    confidence: p.confidence,
    // Stable identity for the SAME commitment across re-runs / quarters — lets the
    // downstream verifier group restatements (category|period|metric-subject).
    promise_key: keyOf(p),
    figure_in_quote: figureInQuote(p.target, p.quote),
    found_by: p.found_by,
    reaffirmed_on: p.reaffirmed_on,
    revisions: p.revisions,
  }));

  return { promises, rejected_ungrounded };
}

/**
 * Split text into segments each ≤ maxChars, breaking on turn/slide ("\n\n")
 * boundaries (never mid-turn unless a single turn exceeds the budget). Used to
 * keep each provider call within its token budget — e.g. Groq's free-tier TPM.
 * @returns {string[]} one segment if maxChars is null/Infinity or text fits.
 */
export function segmentText(text, maxChars) {
  if (!maxChars || !Number.isFinite(maxChars) || text.length <= maxChars) return [text];
  const blocks = text.split(/\n\n+/);
  const segs = [];
  let cur = "";
  for (const b of blocks) {
    if (b.length > maxChars) {
      if (cur) { segs.push(cur); cur = ""; }
      for (let i = 0; i < b.length; i += maxChars) segs.push(b.slice(i, i + maxChars));
      continue;
    }
    if (cur && cur.length + b.length + 2 > maxChars) { segs.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) segs.push(cur);
  return segs;
}

/** Rough category guess for the offline mock (real extraction uses the LLM). */
function guessCategory(s) {
  const t = s.toLowerCase();
  if (/ebitda/.test(t)) return "ebitda";
  if (/\bmargin/.test(t)) return "margin";
  if (/\bpat\b|profit after tax/.test(t)) return "pat";
  if (/capex|capital expenditure/.test(t)) return "capex";
  if (/capacit|mtpa|ktpa|commission|ramp[- ]?up|expansion/.test(t)) return "capacity";
  if (/net debt|leverage|debt[\s/]*ebitda|deleverag/.test(t)) return "leverage";
  if (/revenue|top[- ]?line|turnover/.test(t)) return "revenue";
  if (/roce|return on capital/.test(t)) return "roce";
  if (/order ?book/.test(t)) return "orderbook";
  if (/volume|\bkt\b|tonnes|tpa|production/.test(t)) return "volume";
  if (/\bcost\b|cop\b|per ton/.test(t)) return "cost";
  if (/dividend|buyback|payout|stake/.test(t)) return "capital_allocation";
  return "other";
}

/**
 * Offline mock extractor: derive plausibly-shaped promises straight from the
 * corpus text with NO API call (for $0 wiring/shape validation). Surfaces
 * guidance-bearing sentences with VERBATIM ≤25-word quotes so the full pipeline
 * (ground → dedup → test_date → promise_key → figure_in_quote) runs end-to-end.
 */
export function mockExtract(doc) {
  const promises = [];
  const seen = new Set();
  const sents = String(doc.text || "").split(/(?<=[.!?])\s+|\n+/);
  for (const raw of sents) {
    if (promises.length >= 8) break;
    const s = raw.replace(/^\[Analyst context:[^\]]*\]\s*/i, "").replace(/^[A-Z][\w .'-]*:\s*/, "").trim();
    if (s.length < 12 || !/\d/.test(s)) continue; // measurable → needs a number
    if (!qaTurnIsGuidance(s)) continue;
    const quote = s.split(/\s+/).slice(0, 25).join(" "); // ≤25-word verbatim prefix
    if (seen.has(quote)) continue;
    seen.add(quote);
    const range = s.match(/(\d[\d,.]*)\s*(?:to|-|–|—)\s*(\d[\d,.]*)/);
    const single = s.match(/-?\d[\d,]*\.?\d*/);
    const value = range ? Number(range[1].replace(/,/g, "")) : single ? Number(single[0].replace(/,/g, "")) : null;
    const value_high = range ? Number(range[2].replace(/,/g, "")) : null;
    const period = (s.match(/q[1-4]\s*fy\s*'?\d{2,4}|fy\s*'?\d{2,4}|quarter\s*[1-4]|by\s+[A-Za-z]+\s*\d{4}/i) || [doc.quarter])[0];
    promises.push({
      quarter_context: doc.quarter,
      category: guessCategory(s),
      promise: quote.length > 70 ? quote.slice(0, 67) + "…" : quote,
      quote,
      metric: quote,
      target: { text: quote.slice(0, 48), value, value_high, unit: /%/.test(s) ? "%" : "", period },
      confidence: "M",
    });
  }
  return { promises, calls: 0 };
}

function loadCorpus() {
  const path = process.env.CORPUS
    ? (process.env.CORPUS.startsWith("/") ? process.env.CORPUS : join(REPO_ROOT, process.env.CORPUS))
    : join(outputDir(TICKER), "corpus.json");
  if (!existsSync(path)) {
    die(`corpus not found: ${path}. Run ingest first or set CORPUS=<path>.`);
  }
  return { corpus: JSON.parse(readFileSync(path, "utf8")), path };
}

function loadFixture() {
  const p = join(REPO_ROOT, "public", "data", "companies", `${TICKER.toLowerCase()}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// ---- per (doc × model) cache -------------------------------------------------
function cachePath(docId, model) {
  return join(outputDir(TICKER), "cache", "extract", `${docId}.${model}.json`);
}
function docHash(text, model) {
  return createHash("sha256").update(`${PROMPT_VERSION} ${model} ${text}`).digest("hex");
}

async function main() {
  if (!TICKER) die("set TICKER=<ticker>.");
  const { corpus, path: corpusPath } = loadCorpus();

  const docs = (corpus.documents || [])
    .slice(0, LIMIT)
    .map((d) => ({
      id: d.id,
      quarter: d.quarter,
      type: d.type,
      date: d.date ?? null,
      label: `${d.quarter} ${d.type}`,
      sections: d.sections || [],
      text: buildDocText(d, SCOPE),
    }))
    .filter((d) => d.text.trim().length > 0);

  if (!docs.length) die(`no usable documents in corpus (${corpusPath}).`);

  // Resolve the provider panel (models from presets / <PROVIDER>_MODEL). PROVIDER=mock
  // (or MOCK=1) swaps in an offline mock provider so the whole pipeline runs for $0.
  const panel = MOCK
    ? [{ provider: "mock", model: "mock" }]
    : EXTRACTION_PROVIDERS.map((p) => providerConfig(p, process.env));
  const available = MOCK ? panel : panel.filter((c) => c.apiKey);
  const models = panel.map((c) => ({ provider: c.provider, model: c.model }));

  // ---- DRY RUN: estimate calls/tokens, no API ----
  if (DRY_RUN) {
    const tasks = planTasks(docs, panel, STRATEGY); // estimate over the full panel
    // Account for per-provider input segmentation (e.g. Groq's TPM budget).
    const segCount = (t) => segmentText(t.doc.text, t.provider.maxInputTokens ? t.provider.maxInputTokens * 4 : Infinity).length;
    const inputTokens = tasks.reduce((s, t) => s + Math.ceil(t.doc.text.length / 4) + segCount(t) * 1500, 0);
    const byProv = {};
    let totalCalls = 0;
    tasks.forEach((t) => {
      const n = segCount(t);
      totalCalls += n;
      byProv[t.provider.provider] = (byProv[t.provider.provider] || 0) + n;
    });
    console.log(`extract DRY-RUN — ${TICKER.toUpperCase()} · strategy=${STRATEGY}`);
    console.log(`  documents     : ${docs.length}`);
    console.log(`  providers     : ${models.map((m) => `${m.provider}=${m.model}`).join(", ")}`);
    console.log(`  keys present  : ${available.map((c) => c.provider).join(", ") || "(none — secrets live in CI)"}`);
    const planNote =
      STRATEGY === "failover"
        ? `  [${models[0].provider} does all docs; spills to ${models.slice(1).map((m) => m.provider).join("→")} only if a daily quota is exhausted]`
        : STRATEGY === "ensemble"
          ? "  [every doc × all 3 — uses 3× quota; groq segmented]"
          : "";
    console.log(`  planned calls : ${totalCalls}  (${Object.entries(byProv).map(([k, v]) => `${k}:${v}`).join(", ")})${planNote}`);
    console.log(`  est input tok : ~${inputTokens.toLocaleString()} (≈${Math.ceil(inputTokens / totalCalls)}/call)`);
    console.log(`  est output tok: ~${(totalCalls * 1500).toLocaleString()}`);
    console.log(`  cache dir     : ${cachePath("<doc>", "<model>")}`);
    return;
  }

  if (!available.length) {
    die("no provider API keys set (GEMINI_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY). Use DRY_RUN=1 to estimate, or run in CI.");
  }

  // ---- real extraction ----
  const docTextById = new Map(docs.map((d) => [d.id, d.text]));
  const sectionsById = new Map(docs.map((d) => [d.id, d.sections]));

  const extractOne = MOCK
    ? async (_cfg, doc) => mockExtract(doc)
    : async (cfg, doc) => {
    const hash = docHash(doc.text, cfg.provider);
    const cp = cachePath(doc.id, cfg.provider);
    if (existsSync(cp)) {
      try {
        const cached = JSON.parse(readFileSync(cp, "utf8"));
        if (cached.hash === hash) return { promises: cached.promises, cached: true };
      } catch {
        /* fall through to live call */
      }
    }

    // Keep each request within the provider's budget (e.g. Groq's 12K TPM, which
    // counts input+output): reserve the prompt overhead + the output budget, then
    // segment the document text to what's left. Large-context providers (no cap)
    // send it in one call.
    // Generous output cap so a long doc's JSON isn't truncated (Gemini 2.5-flash
    // supports far more; the rubric keeps outputs modest). Groq overrides this
    // low via its preset to fit the TPM/TPD budget.
    const maxTokens = cfg.maxOutputTokens || 16000;
    const segChars = cfg.maxInputTokens
      ? Math.max(4000, cfg.maxInputTokens * 4 - PROMPT_OVERHEAD_CHARS)
      : Infinity;
    const segments = segmentText(doc.text, segChars);

    const promises = [];
    const errors = [];
    let okSegments = 0;
    let daily = false;
    for (let i = 0; i < segments.length; i++) {
      const label = segments.length > 1 ? `${doc.label} [part ${i + 1}/${segments.length}]` : doc.label;
      const messages = buildMessages(segments[i], { quarter: doc.quarter, type: doc.type, label });
      try {
        const { data } = await completeJSON(messages, EXTRACTION_SCHEMA, {
          chain: [cfg],
          temperature: 0.1,
          maxTokens,
          maxRetries: 6, // ride out free-tier TPM token-bucket waits
          schemaName: "promises",
          env: process.env,
        });
        if (Array.isArray(data?.promises)) promises.push(...data.promises);
        okSegments += 1;
      } catch (err) {
        if (err.daily || /daily\/quota limit/i.test(err.message)) daily = true;
        const part = segments.length > 1 ? ` [part ${i + 1}/${segments.length}]` : "";
        errors.push(`${err.message}${part}`);
      }
    }
    // Nothing succeeded → throw so the whole task is counted as failed (carry the
    // daily-limit flag so a sequential runner drops this provider for later docs).
    if (okSegments === 0) {
      const e = new Error(errors[0] || "no segments succeeded");
      e.daily = daily;
      throw e;
    }

    // Cache only complete results so partial docs are retried on the next run.
    if (errors.length === 0) {
      mkdirSync(dirname(cp), { recursive: true });
      writeFileSync(cp, JSON.stringify({ hash, promises }, null, 2));
    }
    // Partial success: return what we got AND the per-segment errors so the run
    // surfaces them (never silently drop a segment's commitments). Carry `daily`
    // so a sequential runner can drop this provider for later docs and let the
    // next one cover the segments lost when the quota ran out MID-document.
    return { promises, calls: segments.length, errors, daily };
  };

  console.log(`extract — ${TICKER.toUpperCase()} · strategy=${STRATEGY} · providers=${available.map((c) => c.provider).join("+")}`);
  const { promises: raw, stats: runStats } = await runExtraction({
    docs,
    providers: available,
    extractOne,
    strategy: STRATEGY,
    concurrency: CONCURRENCY,
    debug: DEBUG,
  });

  // Ground quotes (drop hallucinations) → cross-model merge/dedup → test dates.
  const { promises, rejected_ungrounded: rejectedUngrounded } = assemblePromises(raw, { docTextById, sectionsById });

  const byCategory = promises.reduce((m, p) => ((m[p.category] = (m[p.category] || 0) + 1), m), {});
  const fixture = loadFixture();
  const evalResult = EVAL && fixture ? evalExtraction(promises, fixture) : null;

  const out = {
    ticker: TICKER.toUpperCase(),
    generated_at: new Date().toISOString(),
    strategy: STRATEGY,
    models,
    promises,
    stats: {
      docs: docs.length,
      raw_candidates: runStats.raw_candidates,
      after_dedup: promises.length,
      rejected_ungrounded: rejectedUngrounded,
      llm_calls: runStats.llm_calls,
      cache_hits: runStats.cache_hits,
      by_model: runStats.by_model,
      agreement_2plus: promises.filter((p) => (p.found_by || []).length >= 2).length,
      by_category: byCategory,
      provider_errors: runStats.errors,
    },
    eval: evalResult,
  };

  mkdirSync(outputDir(TICKER), { recursive: true });
  const outPath = join(outputDir(TICKER), "promises.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n──────── extract summary ────────");
  const bm = out.stats.by_model || {};
  const bmStr = Object.keys(bm).length ? Object.entries(bm).map(([k, v]) => `${k} ${v}`).join(" / ") : "none";
  console.log(`  raw candidates : ${out.stats.raw_candidates}  (${bmStr})`);
  console.log(`  ungrounded drop: ${rejectedUngrounded}`);
  console.log(`  after dedup    : ${promises.length}  (≥2-model agreement: ${out.stats.agreement_2plus})`);
  console.log(`  llm calls      : ${out.stats.llm_calls}  cache hits: ${out.stats.cache_hits}  provider errors: ${runStats.errors.length}`);
  if (evalResult) console.log(`  eval recall    : ${(evalResult.recall * 100).toFixed(0)}% (${evalResult.found}/${evalResult.known})  missed ${evalResult.missed.length}`);
  console.log(`  promises       : ${outPath}`);

  // Surface why providers failed (so a degraded ensemble is never silent).
  if (runStats.errors.length) {
    const grouped = {};
    for (const e of runStats.errors) {
      const k = `${e.provider}: ${e.reason.slice(0, 140)}`;
      grouped[k] = (grouped[k] || 0) + 1;
    }
    console.log("  provider errors:");
    for (const [k, n] of Object.entries(grouped)) console.log(`    [${n}×] ${k}`);
  }
  // In ensemble/partition every available provider is expected to contribute, so
  // a 0 means a degraded run. In failover/single, untouched providers are normal
  // (the work was done by an earlier provider with budget).
  if (STRATEGY === "ensemble" || STRATEGY === "partition") {
    const dead = ["gemini", "groq", "mistral"].filter(
      (m) => available.some((c) => c.provider === m) && (out.stats.by_model[m] || 0) === 0,
    );
    if (dead.length) console.log(`  ⚠ contributed 0 promises: ${dead.join(", ")} (ensemble degraded)`);
  } else {
    const used = Object.entries(out.stats.by_model).filter(([, n]) => n > 0).map(([m]) => m);
    console.log(`  providers used : ${used.join(", ") || "none"} (failover — others held in reserve)`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => die(e.stack || e.message));
