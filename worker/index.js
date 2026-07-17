/**
 * Lie Detector — Cloudflare Worker entry point.
 *
 * Responsibilities:
 *   - Serve the static dashboard from ./public via the ASSETS binding.
 *   - The /api/* namespace:
 *       GET  /api/health           -> { ok: true }
 *       GET  /api/company/:ticker  -> 501 (served from static /data/companies/<ticker>.json)
 *       GET  /api/report/:ticker   -> 501 (served from static /reports/<ticker>.pdf)
 *       POST /api/request/:ticker  -> queue an uncovered company (fires a GitHub
 *                                     repository_dispatch → process-company.yml) (P10)
 *       GET  /api/status/:ticker   -> { status: ready | processing | unknown } (P10)
 *
 * The request path lets any visitor pull a company into coverage: it dispatches the
 * pipeline workflow with the repo's GH_DISPATCH_TOKEN (a Worker secret set at deploy, P11;
 * until then the route safely reports a mock "queued" so the dashboard flow still works).
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const TICKER_RE = /^[A-Za-z0-9.&-]{1,24}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** Best-effort per-isolate rate-limit + de-dupe (durable KV-backed limiting lands at deploy, P11). */
const REQUEST_LOG = new Map(); // ip -> number[] (request timestamps, ms)
const QUEUED = new Map(); // ticker -> ms last queued
const RATE_MAX = 5; // requests
const RATE_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes
const QUEUE_TTL_MS = 30 * 60 * 1000; // treat a ticker as "processing" for 30 min after queueing

function rateLimited(ip, now) {
  const hits = (REQUEST_LOG.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  REQUEST_LOG.set(ip, hits);
  return hits.length > RATE_MAX;
}

/**
 * Read a value from the optional LEDGERS KV namespace. KV holds freshly-scored ledgers +
 * the index the moment a pipeline run finishes — BEFORE the slow git-commit→redeploy lands —
 * so a requested company goes live immediately. Returns null when KV isn't bound (no KV →
 * the Worker just serves the committed JSON via ASSETS, unchanged).
 */
async function kvGet(env, key) {
  if (!env || !env.LEDGERS) return null;
  try {
    return await env.LEDGERS.get(key);
  } catch {
    return null;
  }
}

/** The covered-company index, KV-first (fresh) then the committed ASSETS copy. Returns an array. */
async function readIndexArray(env, url) {
  const fromKv = await kvGet(env, "index");
  if (fromKv) {
    try {
      const arr = JSON.parse(fromKv);
      if (Array.isArray(arr)) return arr;
    } catch { /* fall through to ASSETS */ }
  }
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/data/companies/index.json", url)));
    if (res.ok) return await res.json();
  } catch { /* ignore */ }
  return [];
}

/** Is this ticker already covered? (KV-first index, then the committed copy). */
async function isCovered(env, url, ticker) {
  const index = await readIndexArray(env, url);
  const t = ticker.toUpperCase();
  return Array.isArray(index) && index.some((c) => String(c.ticker).toUpperCase() === t);
}

/** Fire a GitHub repository_dispatch to run process-company.yml for this ticker. */
async function dispatchProcessCompany(env, ticker, source) {
  const token = env.GH_DISPATCH_TOKEN;
  const repo = env.GH_REPO || "ceekay-munshot/lie2.0";
  if (!token) return { dispatched: false, mock: true }; // token wired at deploy (P11)
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `token ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "lie-detector-worker",
    },
    body: JSON.stringify({ event_type: "process-company", client_payload: { ticker, source: source || "screener" } }),
  });
  return { dispatched: res.ok, status: res.status };
}

async function handleApi(request, env, url) {
  const { pathname } = url;

  if (pathname === "/api/health") return json({ ok: true });

  const company = pathname.match(/^\/api\/company\/([A-Za-z0-9._-]+)\/?$/);
  if (company) {
    return json({ ok: false, error: "not_implemented", endpoint: "company", ticker: company[1].toUpperCase(),
      hint: "Static fixtures live at /data/companies/<ticker>.json until this endpoint is wired up." }, 501);
  }

  const report = pathname.match(/^\/api\/report\/([A-Za-z0-9._-]+)\/?$/);
  if (report) return json({ ok: false, error: "not_implemented", endpoint: "report", ticker: report[1].toUpperCase() }, 501);

  // POST /api/request/:ticker — queue an uncovered company.
  const reqMatch = pathname.match(/^\/api\/request\/([^/]+)\/?$/);
  if (reqMatch) {
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed", hint: "POST /api/request/:ticker" }, 405);
    const ticker = decodeURIComponent(reqMatch[1]).trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) return json({ ok: false, error: "invalid_ticker", ticker }, 400);

    const now = Date.now();
    const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
    if (rateLimited(ip, now)) return json({ ok: false, error: "rate_limited", retry_after_s: Math.ceil(RATE_WINDOW_MS / 1000) }, 429);

    // Idempotent: already covered, or already queued recently → don't re-dispatch.
    if (await isCovered(env, url, ticker)) return json({ ok: true, queued: false, status: "ready", ticker });
    const lastQueued = QUEUED.get(ticker);
    if (lastQueued && now - lastQueued < QUEUE_TTL_MS) return json({ ok: true, queued: true, status: "processing", ticker, deduped: true });

    let source = "screener";
    try { const body = await request.json(); if (body && typeof body.source === "string") source = body.source; } catch { /* no body */ }
    const result = await dispatchProcessCompany(env, ticker, source);
    // A real dispatch that GitHub rejected (bad token/scope/repo, throttling) started no workflow —
    // don't mark it queued or it would read as a stuck "processing" for the TTL. (No token → mock-queue.)
    if (!result.mock && !result.dispatched) return json({ ok: false, error: "dispatch_failed", ticker, status: result.status || 0 }, 502);
    QUEUED.set(ticker, now);
    return json({ ok: true, queued: true, status: "processing", ticker, mock: !!result.mock });
  }

  // GET /api/status/:ticker — covered? processing? unknown?
  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)\/?$/);
  if (statusMatch) {
    const ticker = decodeURIComponent(statusMatch[1]).trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) return json({ ok: false, error: "invalid_ticker", ticker }, 400);
    if (await isCovered(env, url, ticker)) return json({ ok: true, ticker, status: "ready" });
    const lastQueued = QUEUED.get(ticker);
    if (lastQueued && Date.now() - lastQueued < QUEUE_TTL_MS) return json({ ok: true, ticker, status: "processing" });
    return json({ ok: true, ticker, status: "unknown" });
  }

  return json({ ok: false, error: "not_found", path: pathname }, 404);
}

/**
 * Serve a company ledger / the index from KV when present (a just-scored company is live
 * before the redeploy), else fall through to the committed ASSETS copy. Only GETs, only the
 * data JSON paths, and only when KV is bound — everything else is untouched.
 */
async function serveDataFile(request, env, url) {
  if (!env.LEDGERS || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const m = url.pathname.match(/^\/data\/companies\/(index|[A-Za-z0-9.&_-]{1,24})\.json$/);
  if (!m) return null;
  const key = m[1] === "index" ? "index" : `ledger:${m[1].toUpperCase()}`;
  const val = await kvGet(env, key);
  if (val == null) return null; // not in KV → let ASSETS serve the committed copy
  // index changes whenever a company lands → don't edge-cache it; ledgers are immutable per run.
  const cache = m[1] === "index" ? "no-store" : "public, max-age=60";
  return new Response(request.method === "HEAD" ? null : val, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    const fresh = await serveDataFile(request, env, url);
    if (fresh) return fresh;
    return env.ASSETS.fetch(request);
  },
};
