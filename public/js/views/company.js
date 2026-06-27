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

const drawIcons = () => { if (window.lucide?.createIcons) window.lucide.createIcons(); };

// Anchored stubs the later prompts fill in (P7 charts, P8 cards/table, P9 export).
const PLACEHOLDERS = [
  { id: "charts", title: "Charts", icon: "chart-pie", note: "Status donut, slippage timeline & financial-trend — arrives in P7." },
  { id: "track-record", title: "Track record", icon: "layout-grid", note: "Per-promise cards with filter / sort / drill — arrives in P8." },
  { id: "table", title: "Master promise table", icon: "table", note: "Every measurable commitment, sortable & filterable — arrives in P8." },
  { id: "export", title: "Export report", icon: "file-down", note: "Polished multi-page PDF — arrives in P9." },
];

function placeholdersHTML() {
  return `
    <div class="ph-grid">
      ${PLACEHOLDERS.map((p) => `
        <section id="${p.id}" class="ph card" aria-label="${escapeHTML(p.title)} (coming soon)">
          <div class="ph-head"><i data-lucide="${p.icon}" aria-hidden="true"></i><h2>${escapeHTML(p.title)}</h2><span class="ph-soon">Soon</span></div>
          <p class="ph-note">${escapeHTML(p.note)}</p>
        </section>`).join("")}
    </div>`;
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
      ${placeholdersHTML()}
    </div>`;
  drawIcons();
  window.scrollTo({ top: 0, behavior: "auto" });
}
