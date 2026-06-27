/**
 * app.js — Lie Detector shell + router. Owns the persistent chrome (header/footer)
 * and swaps the <main id="app"> between the HOME view (hero search + a grid of
 * covered companies from index.json) and the COMPANY view (?c=<ticker>). The
 * company view, hero, search and provenance guard live in their own modules.
 */
import { loadIndex, gradeColor, gradeFromScore, escapeHTML, hideBoot } from "./ui.js";
import { currentTicker, navigate, onRoute } from "./lib/router.js";
import { mountSearch } from "./components/search.js";
import { renderCompany } from "./views/company.js";

const drawIcons = () => { if (window.lucide?.createIcons) window.lucide.createIcons(); };
const $app = () => document.getElementById("app");
const $headerTools = () => document.getElementById("header-tools");

let _index = null;
function getIndex() {
  if (!_index) _index = loadIndex();
  return _index;
}

/** A covered-company card for the home grid. Click / Enter → company view. */
function companyCardHTML(c) {
  const score = c.credibility_score;
  const hasScore = score != null && !Number.isNaN(Number(score));
  const grade = c.grade || gradeFromScore(score) || "—";
  const color = gradeColor(grade);
  const pct = hasScore ? Math.max(0, Math.min(100, Number(score))) : 0;
  return `
    <article class="card company-card" data-ticker="${escapeHTML(c.ticker)}" tabindex="0" role="button"
             aria-label="${escapeHTML(c.name)} — credibility ${hasScore ? score : "n/a"} of 100, grade ${escapeHTML(grade)}">
      <div class="cc-head">
        <div class="cc-id">
          <span class="cc-ticker">${escapeHTML(c.ticker)}</span>
          <span class="cc-name">${escapeHTML(c.name)}</span>
        </div>
        <span class="cc-grade" style="--grade-color:${color}">${escapeHTML(grade)}</span>
      </div>
      <div class="cc-meta">
        ${c.sector ? `<span class="chip">${escapeHTML(c.sector)}</span>` : ""}
        ${c.coverage ? `<span class="chip chip-quiet">${escapeHTML(c.coverage)}</span>` : ""}
      </div>
      <div class="cc-score">
        <div class="cc-score-line">
          <span class="cc-score-num">${hasScore ? score : "—"}</span>
          <span class="cc-score-den">/100</span>
          <span class="cc-score-label">Credibility</span>
        </div>
        <div class="cc-bar" role="presentation"><span style="width:${pct}%; background:${color}"></span></div>
      </div>
      <div class="cc-cta"><span>View dashboard</span><i data-lucide="arrow-right"></i></div>
    </article>`;
}

async function renderHome(app) {
  document.body.classList.remove("view-company");
  document.body.classList.add("view-home");
  $headerTools().innerHTML = "";

  app.innerHTML = `
    <section class="wrap hero-home">
      <span class="eyebrow">Earnings-call accountability</span>
      <h1>Do management teams<br />actually <span class="accent">keep their promises?</span></h1>
      <p class="lede">
        Lie Detector extracts every <strong>measurable</strong> commitment from a company's earnings
        calls and investor decks, verifies each against what was later reported, and scores delivery
        reliability — promise by promise.
      </p>
      <div class="home-search" id="home-search"></div>
      <div class="count" id="company-count">Loading…</div>
    </section>
    <section class="wrap">
      <div class="grid" id="company-grid"><div class="empty">Loading company ledgers…</div></div>
    </section>`;
  drawIcons();

  mountSearch(document.getElementById("home-search"), { autofocus: true });

  const grid = document.getElementById("company-grid");
  const count = document.getElementById("company-count");
  try {
    const list = await getIndex();
    grid.innerHTML = list.length
      ? list.map(companyCardHTML).join("")
      : `<div class="empty">No companies tracked yet.</div>`;
    if (count) count.textContent = `${list.length} compan${list.length === 1 ? "y" : "ies"} tracked`;
    drawIcons();
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<div class="empty">Couldn't load the company index. Is the dev server running?</div>`;
    if (count) count.textContent = "";
  }
}

function bindGridNavigation(app) {
  const go = (e) => {
    const card = e.target.closest(".company-card[data-ticker]");
    if (!card) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    navigate(card.dataset.ticker);
  };
  app.addEventListener("click", go);
  app.addEventListener("keydown", go);
}

/** Render the route; returns the (async) render promise so boot can await it. */
function route(ticker) {
  const app = $app();
  if (ticker) {
    document.body.classList.remove("view-home");
    document.body.classList.add("view-company");
    return renderCompany(app, ticker, { headerHost: $headerTools() });
  }
  return renderHome(app);
}

async function boot() {
  drawIcons();

  // Brand → home (SPA nav, no reload).
  const brand = document.getElementById("brand");
  if (brand) brand.addEventListener("click", (e) => { e.preventDefault(); navigate(null); });

  bindGridNavigation($app());
  onRoute(route);                          // subsequent navigations + back/forward
  try { await route(currentTicker()); }    // initial render — keep the boot loader up until it's ready
  finally { hideBoot(); }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
