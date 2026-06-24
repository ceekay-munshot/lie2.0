/**
 * Lie Detector — Cloudflare Worker entry point.
 *
 * Responsibilities (Prompt 1 / foundation):
 *   - Serve the static dashboard from ./public via the ASSETS binding.
 *   - Reserve the /api/* namespace for server-side endpoints wired in later prompts.
 *
 * Routing model:
 *   /api/health            -> { ok: true }            (liveness)
 *   /api/company/:ticker   -> 501 not_implemented     (company promise ledger; later)
 *   /api/report/:ticker    -> 501 not_implemented     (full PDF-ready report; later)
 *   everything else        -> static asset, falling through to index.html
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** Build a JSON Response. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** Handle the reserved /api/* namespace. */
function handleApi(request, env, url) {
  const { pathname } = url;

  // Liveness probe.
  if (pathname === "/api/health") {
    return json({ ok: true });
  }

  // Company promise ledger — served from committed JSON (wired in a later prompt).
  const company = pathname.match(/^\/api\/company\/([A-Za-z0-9._-]+)\/?$/);
  if (company) {
    return json(
      {
        ok: false,
        error: "not_implemented",
        endpoint: "company",
        ticker: company[1].toUpperCase(),
        hint: "Static fixtures live at /data/companies/<ticker>.json until this endpoint is wired up.",
      },
      501,
    );
  }

  // Full report payload (dashboard + PDF export source) — wired in a later prompt.
  const report = pathname.match(/^\/api\/report\/([A-Za-z0-9._-]+)\/?$/);
  if (report) {
    return json(
      {
        ok: false,
        error: "not_implemented",
        endpoint: "report",
        ticker: report[1].toUpperCase(),
      },
      501,
    );
  }

  return json({ ok: false, error: "not_found", path: pathname }, 404);
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (req: Request) => Promise<Response> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // Static assets (HTML, JS, committed data JSON). SPA fallback -> index.html.
    return env.ASSETS.fetch(request);
  },
};
