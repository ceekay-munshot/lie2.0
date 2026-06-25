#!/usr/bin/env node
/**
 * llm.mjs — provider-agnostic, OpenAI-compatible LLM client for the Lie Detector
 * pipeline. Every supported provider exposes an OpenAI-style `/chat/completions`
 * endpoint, so a single client drives all of them; only base URL, model and key
 * differ.
 *
 * Configuration (env / secrets only — never hard-code keys):
 *   LLM_PROVIDER    primary provider key (default "gemini")
 *   LLM_API_KEY     API key for the primary provider
 *   LLM_BASE_URL    override base URL for the primary provider (else preset)
 *   LLM_MODEL       override model for the primary provider (else preset)
 *   LLM_FALLBACKS   comma-separated provider keys to fail over to, in order
 *                   (each uses its preset + its own <PROVIDER>_API_KEY)
 *
 * Per-provider keys (used for fallbacks, and as an alternative for the primary):
 *   GEMINI_API_KEY · GROQ_API_KEY · CEREBRAS_API_KEY · MISTRAL_API_KEY · NVIDIA_API_KEY
 *
 * Public API:
 *   PROVIDER_PRESETS                         provider -> { baseURL, model, structured }
 *   resolveConfig(env?)                      resolved primary { provider, baseURL, model, apiKey, structured }
 *   resolveChain(env?)                       [primary, ...fallbacks] resolved configs
 *   chat(messages, opts?)                    -> { content, raw, provider, model }
 *   completeJSON(messages, jsonSchema, opts?) -> { data, provider, model }
 *
 * CLI:
 *   node pipeline/lib/llm.mjs --selftest     print resolved config + "config OK".
 *                                            Makes a 1-token ping ONLY if a key is set.
 *
 * No LLM calls happen on import or during normal build/validate — only when you
 * call chat()/completeJSON(), or run --selftest with a key present.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

/* ----------------------------------------------------------------------------
 * Provider presets
 *
 * `structured` = how the provider expresses structured output:
 *   "json_schema"  -> response_format: { type: "json_schema", json_schema: {...} }
 *   "json_object"  -> response_format: { type: "json_object" } + schema in the prompt
 * These defaults are best-effort and are reconfirmed against live model/limit docs
 * in Prompt 4; completeJSON() degrades gracefully regardless.
 * ------------------------------------------------------------------------- */
export const PROVIDER_PRESETS = {
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-2.5-flash",
    // The OpenAI-compat endpoint is reliable with json_object but flaky with
    // json_schema response_format — use json_object (schema goes in the prompt;
    // ajv + repair still enforce it).
    structured: "json_object",
    keyEnv: "GEMINI_API_KEY",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    structured: "json_schema",
    keyEnv: "GROQ_API_KEY",
    // Free tier ≈ 12K tokens/min (input+output). Keep each request well under
    // that so it's a valid call (transient 429s recover on backoff) rather than
    // one that can never fit. Callers segment input to this budget.
    maxInputTokens: 7500,
    maxOutputTokens: 3500,
  },
  cerebras: {
    baseURL: "https://api.cerebras.ai/v1",
    model: "llama-3.3-70b",
    structured: "json_schema",
    keyEnv: "CEREBRAS_API_KEY",
  },
  mistral: {
    baseURL: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    structured: "json_schema",
    keyEnv: "MISTRAL_API_KEY",
  },
  nvidia: {
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    structured: "json_object",
    keyEnv: "NVIDIA_API_KEY",
  },
};

const DEFAULT_PROVIDER = "gemini";

/* ----------------------------------------------------------------------------
 * Config resolution
 * ------------------------------------------------------------------------- */

/** Resolve one provider's config. The primary may be overridden via LLM_* env. */
function configFor(provider, env, { isPrimary } = {}) {
  const preset = PROVIDER_PRESETS[provider] || {};
  const baseURL = (isPrimary && env.LLM_BASE_URL) || preset.baseURL || null;
  const model = (isPrimary && env.LLM_MODEL) || preset.model || null;
  const apiKey =
    (preset.keyEnv && env[preset.keyEnv]) ||
    (isPrimary && env.LLM_API_KEY) ||
    null;
  return {
    provider,
    baseURL,
    model,
    apiKey: apiKey || null,
    structured: preset.structured || "json_object",
    isPrimary: Boolean(isPrimary),
  };
}

/** Resolve the primary provider config. */
export function resolveConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  return configFor(provider, env, { isPrimary: true });
}

/**
 * Resolve a SPECIFIC provider's config (for multi-provider ensembles where each
 * provider is a first-class worker, not a fallback). Honours per-provider env
 * overrides <PROVIDER>_MODEL / <PROVIDER>_BASE_URL and the preset key env.
 */
export function providerConfig(provider, env = process.env) {
  const p = String(provider).toLowerCase();
  const preset = PROVIDER_PRESETS[p] || {};
  const up = p.toUpperCase();
  return {
    provider: p,
    baseURL: env[`${up}_BASE_URL`] || preset.baseURL || null,
    model: env[`${up}_MODEL`] || preset.model || null,
    apiKey: (preset.keyEnv && env[preset.keyEnv]) || env[`${up}_API_KEY`] || null,
    structured: preset.structured || "json_object",
    maxInputTokens: env[`${up}_MAX_INPUT_TOKENS`] ? Number(env[`${up}_MAX_INPUT_TOKENS`]) : preset.maxInputTokens ?? null,
    maxOutputTokens: preset.maxOutputTokens ?? null,
    isPrimary: false,
  };
}

/** Resolve [primary, ...fallbacks] as an ordered, de-duplicated list of configs. */
export function resolveChain(env = process.env) {
  const primary = (env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  const fallbacks = (env.LLM_FALLBACKS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const order = [primary, ...fallbacks].filter((p, i, a) => a.indexOf(p) === i);
  return order.map((p, i) => configFor(p, env, { isPrimary: i === 0 }));
}

/* ----------------------------------------------------------------------------
 * HTTP helpers
 * ------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function joinURL(base, path) {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/** Exponential backoff with jitter; honour Retry-After when the server sends it. */
function backoffMs(attempt, res) {
  const retryAfter = res && res.headers && res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 30_000);
  }
  const base = Math.min(1000 * 2 ** attempt, 16_000);
  return base + Math.floor(Math.random() * 250);
}

class LLMError extends Error {
  constructor(message, { status, provider } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.provider = provider;
  }
}

/**
 * POST one chat completion to a single resolved provider, retrying transient
 * 429/5xx responses with backoff. Throws LLMError on give-up.
 */
async function callChat(cfg, messages, opts = {}) {
  if (!cfg.baseURL) throw new LLMError(`No base URL for provider "${cfg.provider}"`, { provider: cfg.provider });
  if (!cfg.apiKey) throw new LLMError(`No API key for provider "${cfg.provider}"`, { provider: cfg.provider });

  const url = joinURL(cfg.baseURL, "chat/completions");
  const body = {
    model: opts.model || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.response_format) body.response_format = opts.response_format;
  if (opts.extraBody) Object.assign(body, opts.extraBody);

  const maxRetries = opts.maxRetries ?? 4;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (networkErr) {
      // Network-level failure: retry a few times, then give up on this provider.
      if (attempt >= maxRetries) {
        throw new LLMError(`Network error calling ${cfg.provider}: ${networkErr.message}`, {
          provider: cfg.provider,
        });
      }
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? "";
      return { content, raw: data, provider: cfg.provider, model: body.model };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const text = await res.text().catch(() => "");
      throw new LLMError(
        `${cfg.provider} HTTP ${res.status}: ${text.slice(0, 300)}`,
        { status: res.status, provider: cfg.provider },
      );
    }
    await sleep(backoffMs(attempt, res));
  }
}

/* ----------------------------------------------------------------------------
 * Public: chat()
 * ------------------------------------------------------------------------- */

/**
 * Run a chat completion, failing over across the resolved provider chain.
 * Providers with no key are skipped. Returns { content, raw, provider, model }.
 *
 * opts: { env, chain, model, temperature, maxTokens, maxRetries, response_format, signal }
 */
export async function chat(messages, opts = {}) {
  const chain = opts.chain || resolveChain(opts.env || process.env);
  let lastErr = null;
  for (const cfg of chain) {
    if (!cfg.apiKey) {
      lastErr = new LLMError(`Skipped ${cfg.provider} (no key)`, { provider: cfg.provider });
      continue;
    }
    try {
      return await callChat(cfg, messages, opts);
    } catch (err) {
      lastErr = err;
      // fall through to the next provider in the chain
    }
  }
  throw lastErr || new LLMError("No providers available (empty chain / no keys).");
}

/* ----------------------------------------------------------------------------
 * Public: completeJSON()
 * ------------------------------------------------------------------------- */

let _ajv = null;
/** Lazily build an ajv (draft 2020-12) instance; only needed by completeJSON. */
async function getAjv() {
  if (_ajv) return _ajv;
  let Ajv2020;
  let addFormats;
  try {
    ({ default: Ajv2020 } = await import("ajv/dist/2020.js"));
    ({ default: addFormats } = await import("ajv-formats"));
  } catch {
    throw new LLMError(
      "completeJSON needs ajv — run: npm install --no-save ajv ajv-formats",
    );
  }
  _ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(_ajv);
  return _ajv;
}

function tryParseJSON(text) {
  if (typeof text !== "string") return undefined;
  // Strip ```json fences some providers add despite response_format.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: grab the outermost {...} or [...] span.
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }
}

function ajvErrorsText(errors) {
  return (errors || [])
    .slice(0, 8)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
}

/** Build the response_format payload appropriate to a provider's capability. */
function responseFormatFor(cfg, jsonSchema, opts) {
  if (opts.response_format) return opts.response_format;
  if (cfg.structured === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName || "response",
        schema: jsonSchema,
        // Non-strict by default for cross-provider compatibility (Gemini/Groq/
        // Mistral OpenAI-compat vary on strict json_schema); ajv + the repair
        // retry still enforce the contract. Opt in with opts.strict.
        strict: opts.strict === true,
      },
    };
  }
  return { type: "json_object" };
}

/** Run one response_format mode for a provider: initial attempt + one repair retry. */
async function tryJSONMode(cfg, messages, jsonSchema, validate, rf, opts) {
  // For json_object mode, weaker providers need the schema + the word "json" in
  // the prompt to reliably emit a single JSON object.
  let baseMessages = messages;
  if (rf.type === "json_object") {
    baseMessages = [
      {
        role: "system",
        content:
          "Respond with a SINGLE valid JSON object (no prose, no code fences) " +
          "that conforms to this JSON Schema:\n" +
          JSON.stringify(jsonSchema),
      },
      ...messages,
    ];
  }

  let msgs = baseMessages;
  let lastDetail = "unknown error";
  for (let attempt = 0; attempt <= 1; attempt++) {
    const { content, model } = await callChat(cfg, msgs, { ...opts, response_format: rf });
    const parsed = tryParseJSON(content);
    if (parsed !== undefined && validate(parsed)) {
      return { data: parsed, provider: cfg.provider, model };
    }
    lastDetail =
      parsed === undefined ? "output was not valid JSON" : ajvErrorsText(validate.errors);
    msgs = [
      ...baseMessages,
      { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
      {
        role: "user",
        content:
          `Your previous response failed schema validation: ${lastDetail}. ` +
          "Return ONLY corrected JSON that conforms to the schema — no prose, no code fences.",
      },
    ];
  }
  throw new LLMError(
    `completeJSON failed for ${cfg.provider} after repair retry (${lastDetail})`,
    { provider: cfg.provider },
  );
}

/** Try a provider; if it rejects json_schema (4xx), fall back to json_object. */
async function completeJSONWith(cfg, messages, jsonSchema, validate, opts) {
  const rf = responseFormatFor(cfg, jsonSchema, opts);
  try {
    return await tryJSONMode(cfg, messages, jsonSchema, validate, rf, opts);
  } catch (err) {
    if (rf.type === "json_schema" && (err.status === 400 || err.status === 422)) {
      // The provider's OpenAI-compat layer rejected the json_schema payload —
      // retry the same provider with json_object (schema-in-prompt).
      return await tryJSONMode(cfg, messages, jsonSchema, validate, { type: "json_object" }, opts);
    }
    throw err;
  }
}

/**
 * Like chat(), but constrains and validates the response against `jsonSchema`.
 * Uses native structured output where the provider supports it, otherwise
 * json_object mode + a schema-in-prompt nudge. Validates with ajv and performs
 * exactly one repair retry per provider before failing over.
 *
 * Returns { data, provider, model }. Throws if every provider fails.
 *
 * opts: same as chat(), plus { schemaName }.
 */
export async function completeJSON(messages, jsonSchema, opts = {}) {
  const ajv = await getAjv();
  const validate = ajv.compile(jsonSchema);
  const chain = opts.chain || resolveChain(opts.env || process.env);

  let lastErr = null;
  for (const cfg of chain) {
    if (!cfg.apiKey) {
      lastErr = new LLMError(`Skipped ${cfg.provider} (no key)`, { provider: cfg.provider });
      continue;
    }
    try {
      return await completeJSONWith(cfg, messages, jsonSchema, validate, opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new LLMError("No providers available (empty chain / no keys).");
}

/* ----------------------------------------------------------------------------
 * CLI: --selftest
 * ------------------------------------------------------------------------- */

async function selftest(env = process.env) {
  const chain = resolveChain(env);
  const primary = chain[0];
  const fallbacks = chain.slice(1);

  console.log("Lie Detector — LLM config self-test");
  console.log("───────────────────────────────────");
  console.log(`  provider   : ${primary.provider}`);
  console.log(`  model      : ${primary.model ?? "(unset)"}`);
  console.log(`  baseURL    : ${primary.baseURL ?? "(unset)"}`);
  console.log(`  structured : ${primary.structured}`);
  console.log(`  apiKey     : ${primary.apiKey ? "set" : "(none)"}`);
  console.log(
    `  fallbacks  : ${
      fallbacks.length
        ? fallbacks.map((c) => `${c.provider}${c.apiKey ? "" : " (no key)"}`).join(", ")
        : "(none)"
    }`,
  );

  if (primary.apiKey) {
    process.stdout.write("  ping       : ");
    try {
      const r = await chat([{ role: "user", content: "ping" }], {
        chain: [primary],
        maxTokens: 1,
        temperature: 0,
      });
      console.log(`ok (${r.provider}/${r.model})`);
    } catch (err) {
      console.log(`failed — ${err.message}`);
    }
  } else {
    console.log("  ping       : skipped (no key set)");
  }

  console.log("\nconfig OK");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly && process.argv.includes("--selftest")) {
  selftest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
