#!/usr/bin/env node
/**
 * scrape-screener.mjs — Screener.in document-acquisition orchestrator.
 *
 *   TICKER=VEDL node pipeline/scrape-screener.mjs
 *
 * Logs into Screener (reusing a saved session when possible), resolves the
 * company, scrapes its Concalls, downloads transcript + presentation PDFs for the
 * latest LIMIT quarters inside the browser context (cookies/UA, follows
 * redirects), verifies %PDF + sha256, and writes pipeline/output/<ticker>/
 * manifest.json (+ PDFs under raw/). Acquisition only — no parsing, no LLM.
 *
 * Env knobs:
 *   SCREENER_EMAIL, SCREENER_PASSWORD   credentials (secrets)
 *   TICKER | COMPANY                    what to acquire (ticker or name)
 *   LIMIT=8                             how many latest quarters to keep
 *   CONSOLIDATED=1                      prefer the /consolidated/ view
 *   FY_END_MONTH=3                      fiscal year-end month (India = March)
 *   DRY_RUN                             list concalls + URLs, download nothing
 *   EXPLORE                             dump rendered HTML + screenshot + selectors
 *   HEADFUL                             run a headed browser
 *   DEBUG                               extra logging
 *
 * Exit non-zero (with a debug dump under output/<ticker>/debug/) on login failure,
 * a missing Concalls block, or an unreachable/un-allowlisted host.
 */
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  emptyManifest,
  writeManifest,
  ensureDir,
  rawDir,
  debugDir,
  outputDir,
  manifestPath,
  docId,
  sha256,
  isPdfBuffer,
  toFiscalQuarter,
  sleep,
  politeDelay,
} from "./lib/manifest.mjs";
import {
  resolveCompany,
  login,
  isLoggedIn,
  scrapeConcalls,
  explore,
  SCREENER_ORIGIN,
  USER_AGENT,
} from "./lib/screener.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STATE_PATH = join(REPO_ROOT, "scratchpad", "screener-state.json");

// ---- env ----
const EMAIL = process.env.SCREENER_EMAIL || "";
const PASSWORD = process.env.SCREENER_PASSWORD || "";
const TICKER = (process.env.TICKER || "").trim();
const COMPANY = (process.env.COMPANY || "").trim();
const QUERY = TICKER || COMPANY;
const LIMIT = Number(process.env.LIMIT || 8);
const CONSOLIDATED = process.env.CONSOLIDATED !== "0";
const FY_END_MONTH = Number(process.env.FY_END_MONTH || 3);
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "0";
const EXPLORE = !!process.env.EXPLORE && process.env.EXPLORE !== "0";
const HEADFUL = !!process.env.HEADFUL && process.env.HEADFUL !== "0";
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";

// Hosts the acquisition needs to reach (documented in README + CI egress policy).
const EGRESS_ALLOWLIST = [
  "www.screener.in",
  "www.bseindia.com",
  "nsearchives.nseindia.com",
  "www.nseindia.com",
];

const OUT = TICKER || COMPANY.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";

const log = (...a) => console.log(...a);
const dbg = (...a) => DEBUG && console.error(...a);

function die(msg, code = 1) {
  console.error(`\nscrape: ${msg}`);
  process.exit(code);
}

async function dumpDebug(page, name = "error") {
  try {
    const dir = ensureDir(debugDir(OUT));
    if (page) {
      const html = await page.content().catch(() => "");
      writeFileSync(join(dir, `${name}.html`), html);
      await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true }).catch(() => {});
      console.error(`scrape: wrote debug dump → ${join(dir, name)}.{html,png}`);
    }
  } catch (e) {
    dbg("dumpDebug failed:", e.message);
  }
}

/** Download a PDF inside the browser context (cookies/UA, follow redirects), with backoff. */
async function downloadPdf(context, url, { attempts = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await context.request.get(url, { timeout: 30000, maxRedirects: 6 });
      if (!resp.ok()) {
        lastErr = new Error(`HTTP ${resp.status()}`);
      } else {
        const buf = await resp.body();
        if (isPdfBuffer(buf)) return buf;
        const ct = resp.headers()["content-type"] || "?";
        lastErr = new Error(`not a PDF (content-type ${ct}, ${buf.length} bytes)`);
        // A non-PDF (e.g. an anti-bot interstitial) won't fix itself on retry.
        if (/text\/html/i.test(ct)) break;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(Math.min(1000 * 2 ** i, 8000) + Math.floor(Math.random() * 250));
  }
  throw lastErr || new Error("download failed");
}

async function getBrowser() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    die("Playwright not installed. Run:\n  npm i -D playwright --no-save && npx playwright install chromium");
  }
  // CHROMIUM_EXECUTABLE lets ops point at a preinstalled browser (CI images,
  // sandboxes) instead of Playwright's version-pinned download.
  const launchOpts = { headless: !HEADFUL };
  if (process.env.CHROMIUM_EXECUTABLE) launchOpts.executablePath = process.env.CHROMIUM_EXECUTABLE;
  try {
    return await chromium.launch(launchOpts);
  } catch (e) {
    die(
      `could not launch chromium (${e.message}).\n` +
        "  Install the browser: npx playwright install chromium\n" +
        "  In CI use a preinstalled browser or PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1.",
    );
  }
}

async function ensureSession(browser) {
  const hasState = existsSync(STATE_PATH);
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    ...(hasState ? { storageState: STATE_PATH } : {}),
  });
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(30000);
  const page = await context.newPage();

  let loggedIn = false;
  if (hasState) {
    try {
      await page.goto(`${SCREENER_ORIGIN}/`, { waitUntil: "domcontentloaded" });
      loggedIn = await isLoggedIn(page);
    } catch (e) {
      dbg("session restore navigation failed:", e.message);
    }
    if (loggedIn) log("session: reused saved login (no re-login).");
  }

  if (!loggedIn) {
    if (!EMAIL || !PASSWORD) {
      if (EXPLORE) {
        console.warn("scrape: no credentials — EXPLORE will recon the public page only.");
      } else {
        // Best-effort: show the login page in the debug dump (no-op if host blocked).
        await page.goto(`${SCREENER_ORIGIN}/login/`, { waitUntil: "domcontentloaded" }).catch(() => {});
        await dumpDebug(page, "login");
        throw new Error("not logged in and SCREENER_EMAIL/SCREENER_PASSWORD are unset — cannot acquire.");
      }
    } else {
      try {
        await login(page, { email: EMAIL, password: PASSWORD });
        ensureDir(dirname(STATE_PATH));
        await context.storageState({ path: STATE_PATH });
        log("session: logged in and saved session.");
      } catch (e) {
        await dumpDebug(page, "login");
        throw e;
      }
    }
  }
  return { context, page };
}

function selectLatestQuarters(scrapedDocs, manifest) {
  const dated = [];
  for (const d of scrapedDocs) {
    if (!d.date) {
      manifest.skipped.push({ label: `${d.label} (${d.monthText || "no date"})`, reason: "unparseable date" });
      continue;
    }
    dated.push({ ...d, quarter: toFiscalQuarter(d.date, FY_END_MONTH) });
  }
  // Latest LIMIT distinct quarters (by representative date desc).
  const repDate = new Map();
  for (const d of dated) {
    if (!repDate.has(d.quarter) || d.date > repDate.get(d.quarter)) repDate.set(d.quarter, d.date);
  }
  const quarters = [...repDate.keys()].sort((a, b) => repDate.get(b).localeCompare(repDate.get(a)));
  const keep = new Set(quarters.slice(0, LIMIT));
  // Dedup by id (one transcript + one presentation per quarter).
  const byId = new Map();
  for (const d of dated) {
    if (!keep.has(d.quarter)) continue;
    const id = docId(d.quarter, d.type);
    if (!byId.has(id)) byId.set(id, { ...d, id });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const started = Date.now();
  if (!QUERY) die("set TICKER=<ticker> or COMPANY=<name> (e.g. TICKER=VEDL).");
  if (process.env.SOURCE === "upload") {
    die("SOURCE=upload uses the upload backend: TICKER=<t> node pipeline/ingest-upload.mjs");
  }

  log(`scrape: ${EXPLORE ? "EXPLORE " : ""}${DRY_RUN ? "DRY-RUN " : ""}acquiring "${QUERY}" (limit ${LIMIT} quarters)`);
  if (DEBUG) log(`scrape: egress allowlist = ${EGRESS_ALLOWLIST.join(", ")}`);

  const browser = await getBrowser();
  let page;
  try {
    const session = await ensureSession(browser);
    page = session.page;
    const { context } = session;

    // Resolve via the browser context (carries session + UA → fewer anti-bot blocks).
    const request = async (url) => {
      const resp = await context.request.get(url, { timeout: 30000 });
      return { ok: resp.ok(), status: resp.status(), json: () => resp.json(), text: () => resp.text() };
    };
    const company = await resolveCompany(QUERY, {
      consolidated: CONSOLIDATED,
      request,
      asTicker: TICKER ? true : COMPANY ? false : undefined,
    });
    log(`scrape: resolved → ${company.name || company.ticker || QUERY}  ${company.url}`);

    if (EXPLORE) {
      const { dir, candidates } = await explore(page, company.url, OUT);
      log(`scrape: EXPLORE dumped HTML + screenshot → ${dir}`);
      log(`scrape: ${candidates.length} candidate Concall element(s):`);
      for (const c of candidates) {
        log(`  · <${c.tag}> selector="${c.selector}"  links=[${c.sampleLinks.map((l) => l.text).filter(Boolean).join(", ")}]`);
      }
      await browser.close();
      return;
    }

    const { found, documents: scraped } = await scrapeConcalls(page, company.url);
    if (!found) {
      await dumpDebug(page, "no-concalls");
      throw new Error("Concalls block not found on the company page (run EXPLORE=1 to inspect).");
    }
    log(`scrape: found ${scraped.length} concall document link(s).`);

    const manifest = emptyManifest({
      ticker: company.ticker || TICKER || OUT,
      company: { name: company.name, screener_url: company.url, fiscal_year_end: String(FY_END_MONTH).padStart(2, "0") },
      source: "screener",
    });

    const selected = selectLatestQuarters(scraped, manifest);
    log(`scrape: selected ${selected.length} document(s) across the latest ${LIMIT} quarter(s).`);

    if (DRY_RUN) {
      log("\nscrape: DRY-RUN plan (no downloads):");
      for (const d of selected) {
        log(`  ${d.id.padEnd(24)} ${d.monthText.padEnd(10)} ${d.url}`);
      }
      log(`\nscrape: would download ${selected.length} file(s). Skipped ${manifest.skipped.length}.`);
      await browser.close();
      return;
    }

    ensureDir(rawDir(OUT));
    let first = true;
    for (const d of selected) {
      if (!first) await politeDelay(1000, 2000); // polite jitter between downloads
      first = false;
      const rel = join("raw", `${d.id}.pdf`);
      const abs = join(outputDir(OUT), rel);
      try {
        const buf = await downloadPdf(context, d.url);
        writeFileSync(abs, buf);
        manifest.documents.push({
          id: d.id,
          type: d.type,
          quarter: d.quarter,
          date: d.date,
          title: `${d.quarter} ${d.type} — ${d.monthText}`.trim(),
          source_url: d.url,
          local_path: rel,
          bytes: buf.length,
          sha256: sha256(buf),
          source: "Screener",
        });
        log(`  ✓ ${d.id}  (${buf.length} bytes)`);
      } catch (e) {
        manifest.errors.push({ url: d.url, reason: e.message });
        console.error(`  ✗ ${d.id}  ${e.message}`);
      }
    }

    manifest.documents.sort((a, b) => a.id.localeCompare(b.id));
    writeManifest(OUT, manifest);

    const byType = manifest.documents.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + 1), m), {});
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    log("\n──────── summary ────────");
    log(`  company    : ${manifest.company.name || manifest.ticker}`);
    log(`  concalls   : ${scraped.length} links → ${selected.length} selected`);
    log(`  downloaded : ${manifest.documents.length} (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})`);
    log(`  skipped    : ${manifest.skipped.length}`);
    log(`  errors     : ${manifest.errors.length}`);
    log(`  elapsed    : ${elapsed}s`);
    log(`  manifest   : ${manifestPath(OUT)}`);

    await browser.close();
    if (manifest.documents.length === 0) {
      die("no documents downloaded (see errors[] in the manifest).", 1);
    }
  } catch (e) {
    await dumpDebug(page, "error").catch(() => {});
    try {
      await browser.close();
    } catch {}
    die(e.message, 1);
  }
}

main().catch((e) => die(e.stack || e.message, 1));
