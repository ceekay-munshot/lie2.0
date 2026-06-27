/**
 * company.js — the ?c=<ticker> view. Composes: a compact header search · the
 * credibility hero · the KPI strip · anchored placeholder sections that P7–P9 fill.
 * Handles loading + error (unknown ticker → "no ledger — request it") states.
 * Generic: renders whatever ledger loadCompany returns.
 */
import { loadCompany, escapeHTML } from "../ui.js";
import { toHome } from "../lib/router.js";
import { mountSearch } from "../components/search.js";
import { credibilityHeroHTML } from "../components/credibility-hero.js";
import { kpiStripHTML } from "../components/kpi-strip.js";
import { disposeCharts } from "../lib/echarts.js";
import { slippageTimeline } from "../components/charts/slippage-timeline.js";
import { statusDonut } from "../components/charts/status-donut.js";
import { byQuarter } from "../components/charts/by-quarter.js";
import { momentum } from "../components/charts/momentum.js";
import { rootCause } from "../components/charts/root-cause.js";
import { createFilterStore, mountFilterBar } from "../components/filter-bar.js";
import { mountTrackRecord } from "../components/track-record-cards.js";
import { mountTable } from "../components/promise-table.js";
import { openDrill } from "../components/promise-drill.js";

const drawIcons = () => { if (window.lucide?.createIcons) window.lucide.createIcons(); };

// The #charts section (P7). Each panel renders only when its data is present; the
// chart components own their own loading / empty / offline-degrade states.
const CHART_PANELS = [
  { id: "chart-slippage", title: "Slippage timeline", sub: "Promised → re-set", icon: "calendar-clock", wide: true, mount: slippageTimeline, show: (l) => (l.promises || []).some((p) => p.category === "timeline") },
  { id: "chart-donut", title: "Promise status mix", icon: "chart-pie", mount: statusDonut, show: (l) => !!l.aggregates?.status_counts },
  { id: "chart-quarter", title: "By quarter", icon: "chart-column-big", mount: byQuarter, show: (l) => Object.keys(l.aggregates?.by_quarter || {}).length > 0 },
  { id: "chart-momentum", title: "Financial momentum", sub: "EBITDA · margin · leverage · ROCE", icon: "trending-up", wide: true, mount: momentum, show: (l) => (l.financial_trend || []).length > 0 },
  { id: "chart-root", title: "Why promises slipped", icon: "list-tree", wide: true, mount: rootCause, show: (l) => Object.keys(l.aggregates?.root_causes || {}).length > 0 },
];

function chartsHTML(ledger) {
  const panels = CHART_PANELS.filter((p) => p.show(ledger));
  if (!panels.length) return `<section id="charts"></section>`;
  return `
    <section id="charts" class="charts-section" aria-label="Charts">
      <div class="charts-grid">
        ${panels.map((p) => `
          <section class="chart-panel card${p.wide ? " wide" : ""}">
            <div class="chart-head">
              <i data-lucide="${p.icon}" aria-hidden="true"></i>
              <h3>${escapeHTML(p.title)}</h3>
              ${p.sub ? `<span class="chart-sub">${escapeHTML(p.sub)}</span>` : ""}
            </div>
            <div class="chart-canvas" id="${p.id}-canvas"></div>
          </section>`).join("")}
      </div>
    </section>`;
}

/** Mount each visible panel's chart (fire-and-forget; each manages its own states). */
function mountCharts(ledger) {
  disposeCharts();
  for (const p of CHART_PANELS) {
    if (!p.show(ledger)) continue;
    const el = document.getElementById(`${p.id}-canvas`);
    if (el) p.mount(el, ledger);
  }
}

// The #track-record + #table sections (P8) share one filter store. The filter bar sits
// above both; cards and table subscribe to the same filtered list, and both open the
// shared drill modal.
function ledgerDetailHTML() {
  return `
    <section class="ledger-detail" aria-label="Promise ledger">
      <div id="filter-bar" class="filter-bar-host"></div>
      <section id="track-record" class="track-record"></section>
      <section id="table" class="promise-table-section"></section>
    </section>`;
}

function mountLedgerDetail(ledger) {
  const store = createFilterStore(ledger.promises || []);
  const fbHost = document.getElementById("filter-bar");
  const trHost = document.getElementById("track-record");
  const tblHost = document.getElementById("table");
  const onDrill = (p, el) => openDrill(p, el);
  if (fbHost) mountFilterBar(fbHost, store);
  if (trHost) mountTrackRecord(trHost, store, { onDrill });
  if (tblHost) mountTable(tblHost, store, { onDrill });
}

// #export (P9) — the pipeline pre-builds public/reports/<ticker>.pdf; this button
// downloads it when present, or shows a graceful "not generated yet" state.
function exportHTML() {
  return `
    <section id="export" class="export-section card" aria-label="Export report">
      <div class="export-head"><i data-lucide="file-down" aria-hidden="true"></i><h2>Export report</h2></div>
      <div class="export-body" id="export-body"><span class="export-status">Checking for a report…</span></div>
    </section>`;
}

async function mountExport(ledger) {
  const body = document.getElementById("export-body");
  if (!body) return;
  const ticker = String(ledger.company?.ticker || "").toLowerCase();
  const url = `/reports/${ticker}.pdf`;
  let ok = false;
  try { const r = await fetch(url, { method: "HEAD", cache: "no-cache" }); ok = r.ok; } catch { ok = false; }
  if (ok) {
    body.innerHTML = `
      <p class="export-note">A polished multi-page PDF — cover · executive dashboard · slippage &amp; momentum · track record · master table · methodology.</p>
      <a class="btn-primary" href="${url}" download="${escapeHTML(ticker)}-lie-detector.pdf"><i data-lucide="download" aria-hidden="true"></i> Download PDF report</a>`;
  } else {
    body.innerHTML = `<p class="export-note">No PDF report has been generated for this company yet. Run <code>TICKER=${escapeHTML(ticker)} npm run report</code> (or the build-report workflow) to create one.</p>`;
  }
  drawIcons();
}

function placeholdersHTML() {
  return exportHTML();
}

function skeletonHTML(ticker) {
  return `
    <div class="company-view wrap">
      <section class="hero-card card is-loading" aria-busy="true">
        <div class="hero-top"><div class="hero-id"><span class="hero-eyebrow">Loading ledger…</span><h1 class="hero-name skel skel-line"> </h1></div></div>
        <div class="hero-body">
          <div class="ring-wrap"><div class="skel skel-ring"></div></div>
          <div class="hero-readout"><div class="skel skel-line"></div><div class="skel skel-line short"></div><div class="skel skel-block"></div></div>
        </div>
        <p class="visually-hidden">Loading ${escapeHTML(String(ticker).toUpperCase())}…</p>
      </section>
    </div>`;
}

function errorHTML(ticker) {
  return `
    <div class="company-view wrap">
      <section class="hero-card card tone-unknown" role="alert">
        <div class="empty-state">
          <i data-lucide="search-x" aria-hidden="true"></i>
          <h1>No ledger for “${escapeHTML(String(ticker).toUpperCase())}”</h1>
          <p>This company isn't covered yet. Search for another, or request it below.</p>
          <div class="empty-search" id="error-search"></div>
          <button type="button" class="btn-ghost" id="back-home"><i data-lucide="arrow-left" aria-hidden="true"></i> All companies</button>
        </div>
      </section>
    </div>`;
}

/**
 * Render the company view.
 * @param {HTMLElement} app          main render target
 * @param {string} ticker            ticker from the route
 * @param {HTMLElement} headerHost   the header slot to mount the compact search into
 */
export async function renderCompany(app, ticker, { headerHost } = {}) {
  // compact search lives in the header on the company view
  if (headerHost) {
    headerHost.innerHTML = "";
    mountSearch(headerHost, { compact: true });
  }

  app.innerHTML = skeletonHTML(ticker);
  drawIcons();

  let ledger;
  try {
    ledger = await loadCompany(ticker);
  } catch (err) {
    console.warn(`No ledger for "${ticker}":`, err.message);
    app.innerHTML = errorHTML(ticker);
    drawIcons();
    const host = app.querySelector("#error-search");
    if (host) mountSearch(host, { autofocus: true });
    const back = app.querySelector("#back-home");
    if (back) back.addEventListener("click", () => toHome());
    return;
  }

  app.innerHTML = `
    <div class="company-view wrap">
      ${credibilityHeroHTML(ledger)}
      ${kpiStripHTML(ledger)}
      ${chartsHTML(ledger)}
      ${ledgerDetailHTML()}
      ${placeholdersHTML()}
    </div>`;
  drawIcons();
  mountCharts(ledger);              // async; each panel renders into its canvas
  mountLedgerDetail(ledger);        // filter bar + cards + table (shared store) + drill
  mountExport(ledger);              // async; wires the Export PDF download (#export)
  window.scrollTo({ top: 0, behavior: "auto" });
}
