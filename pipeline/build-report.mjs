#!/usr/bin/env node
/**
 * build-report.mjs — Prompt 9. Reads a committed ledger
 * (public/data/companies/<ticker>.json), builds the self-contained report HTML
 * (report-template.mjs), and renders it to public/reports/<ticker>.pdf with the repo's
 * headless Chromium (Playwright). The dashboard's Export button downloads the result.
 *
 * Honesty guard: a PDF is shareable, so it must be as honest as the dashboard. A mock or
 * incomplete-live ledger is REFUSED by default (so a non-real verdict is never produced /
 * committed); FORCE=1 builds a watermarked copy for inspection.
 *
 *   TICKER=vedl node pipeline/build-report.mjs            # golden (manual) → clean report
 *   PROVENANCE_FORCE / FORCE=1 TICKER=x node …            # build a watermarked mock/provisional copy
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportHTML } from "./lib/report-template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const TICKER = (process.env.TICKER || process.argv.slice(2).find((a) => !a.startsWith("-")) || "").trim().toLowerCase();
const FORCE = (!!process.env.FORCE && process.env.FORCE !== "0") || (!!process.env.PROVENANCE_FORCE && process.env.PROVENANCE_FORCE !== "0");
const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";
const die = (m) => { console.error(`build-report: ${m}`); process.exit(1); };

function riskLabel(prov) {
  const mode = prov?.mode || "unknown";
  if (mode === "mock") return "MOCK";
  if (mode === "live" && prov.complete === false) return "PROVISIONAL (incomplete retrieval)";
  return null; // manual / complete-live / unknown → safe to build
}

async function main() {
  if (!TICKER) die("set TICKER=<ticker>.");
  const ledgerPath = join(REPO, "public", "data", "companies", `${TICKER}.json`);
  if (!existsSync(ledgerPath)) die(`ledger not found: ${ledgerPath}. Build it first (npm run verify).`);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const prov = ledger.provenance || {};

  const risk = riskLabel(prov);
  if (risk && !FORCE) {
    die(`refusing to build a ${risk} report — a shared PDF must not pass a non-real verdict as authoritative. ` +
      `Re-run with FORCE=1 to produce a watermarked copy (it still won't be committed by the workflow).`);
  }

  const html = reportHTML(ledger);
  const outDir = join(REPO, "public", "reports");
  mkdirSync(outDir, { recursive: true });
  if (DEBUG) writeFileSync(join(outDir, `${TICKER}.debug.html`), html);

  const { chromium } = await import("playwright");
  let browser;
  const exe = process.env.CHROMIUM_EXECUTABLE || "/opt/pw-browsers/chromium";
  try { browser = await chromium.launch(); }
  catch { browser = await chromium.launch({ executablePath: exe }); }
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ landscape: true, printBackground: true, preferCSSPageSize: true });
  await browser.close();

  const pdfPath = join(outDir, `${TICKER}.pdf`);
  writeFileSync(pdfPath, pdf);

  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length || "?";
  console.log(`build-report: ${TICKER.toUpperCase()} → public/reports/${TICKER}.pdf`);
  console.log(`  provenance : ${prov.mode || "unknown"}${prov.complete === false ? " · INCOMPLETE" : ""}${risk ? "  [watermarked — FORCE build]" : ""}`);
  console.log(`  pages      : ${pages}   ·   bytes: ${pdf.length.toLocaleString("en-IN")}`);
}

main().catch((e) => die(e.stack || e.message));
