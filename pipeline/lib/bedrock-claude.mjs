#!/usr/bin/env node
/**
 * bedrock-claude.mjs — Claude-via-AWS-Bedrock path, parallel to the OpenAI-compatible
 * client in llm.mjs. Entirely opt-in and self-contained: nothing here runs unless a
 * caller resolves the "claude" provider (via LLM_PROVIDER / EXTRACTION_ORDER /
 * LLM_FALLBACKS — see llm.mjs's PROVIDER_PRESETS.claude), which no default in this
 * repo does. To remove the Claude path entirely: delete this file and the small
 * dispatch block at the top of llm.mjs#callChat that imports it — nothing else
 * references it, and the OpenAI-compatible path is untouched either way.
 *
 * Bedrock's `converse` API is NOT OpenAI-compatible (different auth, request and
 * response shape), so this module translates in both directions:
 *   - request:  OpenAI-style {role, content} messages -> Bedrock Converse {system, messages}
 *   - response: Bedrock's {output.message.content[]}  -> the SAME {content, raw, provider,
 *               model} shape llm.mjs#callChat returns for every OpenAI-compatible
 *               provider, so chat()/completeJSON() callers see an identical shape
 *               regardless of which provider actually served the request.
 *
 * Config (env):
 *   BEDROCK_API_KEY   Bedrock bearer API key (required — maps to the "temp_claude_token"
 *                     GitHub Actions secret in this repo's workflows)
 *   BEDROCK_REGION    AWS region (default "us-east-1")
 *   CLAUDE_MODEL      Bedrock model id (default "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
 *
 * NOTE: the default region/model id are an ASSUMPTION for this task — verify them
 * against the actual AWS account/Bedrock model access before relying on this in
 * production, and override via BEDROCK_REGION / CLAUDE_MODEL if they differ.
 */
import process from "node:process";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export class BedrockError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "BedrockError";
    this.status = opts.status;
    this.provider = "claude";
  }
}

/** Resolve region (not part of llm.mjs's generic per-provider env pattern). */
function resolveRegion(env = process.env) {
  return env.BEDROCK_REGION || DEFAULT_REGION;
}

/** OpenAI-style {role, content} messages -> Bedrock Converse {system, messages}. */
function toConverse(messages) {
  const system = [];
  const conv = [];
  for (const m of messages || []) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role === "system") system.push({ text });
    else conv.push({ role: m.role === "assistant" ? "assistant" : "user", content: [{ text }] });
  }
  return { system, messages: conv };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt, res) {
  const retryAfter = res && res.headers && res.headers.get && res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 16_000) + Math.floor(Math.random() * 250);
}

/**
 * Call Claude on Bedrock. Mirrors llm.mjs#callChat's signature and return shape
 * exactly: ({ content, raw, provider, model }), so it is a drop-in for any caller
 * of chat()/completeJSON() regardless of which provider actually served it.
 *
 * cfg: { apiKey, model } (as resolved by llm.mjs's configFor/providerConfig for
 *      the "claude" preset). opts: same shape callChat() receives (temperature,
 *      maxTokens, maxRetries, signal, env).
 */
export async function bedrockCallChat(cfg, messages, opts = {}) {
  const env = opts.env || process.env;
  const apiKey = cfg.apiKey || env.BEDROCK_API_KEY;
  if (!apiKey) throw new BedrockError('No Bedrock API key (set BEDROCK_API_KEY)');

  const region = resolveRegion(env);
  const model = opts.model || cfg.model || env.CLAUDE_MODEL || DEFAULT_MODEL;
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;

  const { system, messages: conv } = toConverse(messages);
  const body = {
    messages: conv,
    ...(system.length ? { system } : {}),
    inferenceConfig: {
      temperature: opts.temperature ?? 0.2,
      ...(opts.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
    },
  };

  const maxRetries = opts.maxRetries ?? 4;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (networkErr) {
      if (attempt >= maxRetries) {
        throw new BedrockError(`Network error calling Bedrock: ${networkErr.message}`);
      }
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const content = (data?.output?.message?.content || [])
        .map((c) => c?.text || "")
        .join("");
      // Same shape llm.mjs#callChat returns for the OpenAI-compatible providers.
      return { content, raw: data, provider: "claude", model };
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        const text = await res.text().catch(() => "");
        throw new BedrockError(`claude (bedrock) HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
      }
      await sleep(backoffMs(attempt, res));
      continue;
    }

    const text = await res.text().catch(() => "");
    throw new BedrockError(`claude (bedrock) HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
  }
}
