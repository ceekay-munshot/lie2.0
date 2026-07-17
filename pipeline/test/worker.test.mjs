#!/usr/bin/env node
/**
 * worker.test.mjs — offline tests for the Cloudflare Worker (no network, no CF runtime).
 * Imports the Worker's default export and drives fetch() with a mocked env:
 *   - LEDGERS KV serving (index + ledger) takes precedence over committed ASSETS;
 *   - graceful fallback to ASSETS when KV is unbound or the key is absent;
 *   - /api coverage (request idempotency) reads the KV-first index;
 *   - the no-token request path still mock-queues so the dashboard flow works.
 *
 *   node pipeline/test/worker.test.mjs
 */
import worker from "../../worker/index.js";

let fails = 0;
const ok = (cond, label) => { if (!cond) fails++; console.log(`  ${cond ? "✓" : "✗"} ${label}`); };

/** Build a mock env. kv=null → LEDGERS unbound; otherwise a map of key→string. */
function makeEnv({ kv = null, assets = {} } = {}) {
  return {
    LEDGERS: kv ? { get: async (k) => (k in kv ? kv[k] : null) } : undefined,
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(req.url).pathname;
        return p in assets
          ? new Response(assets[p], { status: 200, headers: { "content-type": "application/json" } })
          : new Response("not found", { status: 404 });
      },
    },
  };
}

const req = (path, init = {}) => new Request(`https://lie-detector.app${path}`, init);
const call = (path, env, init) => worker.fetch(req(path, init), env);

console.log("worker — health + static fallthrough:");
{
  const env = makeEnv();
  const r = await call("/api/health", env);
  ok(r.status === 200 && (await r.json()).ok === true, "GET /api/health → { ok: true }");
}

console.log("\nworker — KV-first data serving:");
{
  // KV has the fresh index/ledger; ASSETS has the older committed copy → KV wins.
  const env = makeEnv({
    kv: { index: JSON.stringify([{ ticker: "INFY" }]), "ledger:INFY": JSON.stringify({ company: { ticker: "INFY" }, fresh: true }) },
    assets: { "/data/companies/index.json": JSON.stringify([{ ticker: "VEDL" }]) },
  });
  const idx = await (await call("/data/companies/index.json", env)).json();
  ok(idx.some((c) => c.ticker === "INFY"), "index served from KV (fresh), not the committed ASSETS copy");
  const led = await (await call("/data/companies/infy.json", env)).json();
  ok(led.fresh === true && led.company.ticker === "INFY", "ledger /data/companies/infy.json served from KV (ledger:INFY)");
}

console.log("\nworker — graceful fallback to ASSETS:");
{
  // KV bound but key absent → fall through to committed ASSETS.
  const env = makeEnv({ kv: {}, assets: { "/data/companies/vedl.json": JSON.stringify({ committed: true }) } });
  const led = await (await call("/data/companies/vedl.json", env)).json();
  ok(led.committed === true, "KV miss → committed ledger served from ASSETS");

  // No KV binding at all → unchanged behaviour (ASSETS).
  const env2 = makeEnv({ kv: null, assets: { "/data/companies/index.json": JSON.stringify([{ ticker: "VEDL" }]) } });
  const idx = await (await call("/data/companies/index.json", env2)).json();
  ok(Array.isArray(idx) && idx[0].ticker === "VEDL", "no KV binding → ASSETS index served (no regression)");
}

console.log("\nworker — coverage + request flow read KV-first index:");
{
  // A KV-published company reads as already covered → /api/request returns ready, no dispatch.
  const env = makeEnv({ kv: { index: JSON.stringify([{ ticker: "INFY" }]) } });
  const r = await call("/api/request/INFY", env, { method: "POST", headers: { "cf-connecting-ip": "1.1.1.1" }, body: "{}" });
  const body = await r.json();
  ok(body.status === "ready" && body.queued === false, "POST /api/request/INFY (in KV index) → already covered (ready)");

  const st = await (await call("/api/status/INFY", env)).json();
  ok(st.status === "ready", "GET /api/status/INFY → ready (KV index)");
}

console.log("\nworker — uncovered request with no token mock-queues:");
{
  const env = makeEnv({ kv: { index: JSON.stringify([]) } }); // empty coverage, no GH_DISPATCH_TOKEN
  const r = await call("/api/request/NEWCO", env, { method: "POST", headers: { "cf-connecting-ip": "2.2.2.2" }, body: "{}" });
  const body = await r.json();
  ok(body.queued === true && body.status === "processing" && body.mock === true, "uncovered + no token → mock-queued (flow still works)");
}

console.log(fails === 0 ? "\nALL WORKER TESTS PASSED" : `\n${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
