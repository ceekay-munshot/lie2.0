/**
 * publish-kv.mjs — push a just-scored ledger + the index to the Worker's LEDGERS KV
 * namespace so a requested company goes LIVE immediately, without waiting for the
 * git-commit → Cloudflare redeploy. Runs after the guarded commit in run-pipeline.mjs.
 *
 * Honest by construction: it mirrors the commit guard — it publishes ONLY a real verdict
 * (a curated-manual or complete-live ledger), never a mock/incomplete one.
 *
 * No-op (exit 0) unless all three are set, so it's safe in every environment:
 *   CF_ACCOUNT_ID · CF_KV_NAMESPACE_ID · CF_API_TOKEN  (token: "Workers KV Storage: Edit")
 *
 *   TICKER=vedl node pipeline/publish-kv.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isRealVerdict } from "./lib/commit.mjs";

const TICKER = (process.env.TICKER || process.argv.slice(2).find((a) => !a.startsWith("-")) || "").trim().toLowerCase();
const REPO = process.cwd();
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const NS = process.env.CF_KV_NAMESPACE_ID;
const TOKEN = process.env.CF_API_TOKEN;

const log = (m) => console.log(`publish-kv: ${m}`);

async function kvPut(key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
    body: value,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`KV PUT ${key} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

async function main() {
  if (!TICKER) { log("no TICKER — skipped"); return; }
  if (!ACCOUNT || !NS || !TOKEN) {
    log("skipped (instant-live off) — set CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN to enable.");
    return;
  }

  const ledgerPath = join(REPO, "public", "data", "companies", `${TICKER}.json`);
  const indexPath = join(REPO, "public", "data", "companies", "index.json");
  if (!existsSync(ledgerPath)) { log(`no ledger at ${ledgerPath} — nothing to publish`); return; }

  const ledgerText = readFileSync(ledgerPath, "utf8");
  let prov;
  try { prov = JSON.parse(ledgerText).provenance; } catch { log("ledger is not valid JSON — refusing to publish"); return; }

  // Mirror the commit guard: only a real verdict is publishable. (After a refused/mock run the
  // working tree holds the prior real ledger, so this still publishes only honest data.)
  if (!isRealVerdict(prov)) {
    log(`refusing to publish a non-real verdict (mode=${prov?.mode || "?"}, complete=${prov?.complete}) — KV unchanged`);
    return;
  }

  await kvPut(`ledger:${TICKER.toUpperCase()}`, ledgerText);
  log(`PUT ledger:${TICKER.toUpperCase()} (${ledgerText.length} bytes)`);
  if (existsSync(indexPath)) {
    await kvPut("index", readFileSync(indexPath, "utf8"));
    log("PUT index (instant-live coverage updated)");
  }
  log("done — the company is live now, ahead of the redeploy.");
}

main().catch((err) => {
  // Non-fatal: a KV hiccup must never fail the pipeline — the committed JSON still ships on redeploy.
  console.error(`publish-kv: failed (non-fatal) — ${err.message}`);
  process.exit(0);
});
