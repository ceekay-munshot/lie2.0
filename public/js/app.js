/**
 * app.js — Lie Detector home page.
 *
 * Prompt 1 scope: prove the shell + data contract stand up. Load the company
 * index, render one card per company (credibility score + derived grade), wire a
 * client-side search filter, then fade the boot loader. The full company
 * dashboard (charts, promise table, PDF export) arrives in later prompts.
 */
import { loadIndex, gradeColor, gradeFromScore, hideBoot } from "./ui.js";

/** Replace any <i data-lucide> placeholders currently in the DOM. */
function drawIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

const escapeHTML = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

/** One company card. Grade is derived from the score (bands documented in CLAUDE.md). */
function cardHTML(c) {
  const score = c.credibility_score;
  const hasScore = score != null && !Number.isNaN(Number(score));
  const grade = c.grade || gradeFromScore(score) || "—";
  const color = gradeColor(grade);
  const pct = hasScore ? Math.max(0, Math.min(100, Number(score))) : 0;

  return `
    <article class="card company-card" data-ticker="${escapeHTML(c.ticker)}"
             tabindex="0" role="button"
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
        <div class="cc-bar" role="presentation">
          <span style="width:${pct}%; background:${color}"></span>
        </div>
      </div>

      <div class="cc-cta">
        <span>View dashboard</span>
        <i data-lucide="arrow-right"></i>
      </div>
    </article>`;
}

function renderCards(grid, list) {
  if (!list.length) {
    grid.innerHTML = `<p class="empty">No companies match your search.</p>`;
    return;
  }
  grid.innerHTML = list.map(cardHTML).join("");
  drawIcons();
}

/** Brief inline note on a card — the full dashboard is built in later prompts. */
function flashComingSoon(card) {
  card.classList.remove("is-soon");
  // reflow so the animation restarts on rapid repeat clicks
  void card.offsetWidth;
  card.classList.add("is-soon");
  window.setTimeout(() => card.classList.remove("is-soon"), 1600);
}

async function boot() {
  const grid = document.getElementById("company-grid");
  const search = document.getElementById("search");
  const count = document.getElementById("company-count");
  let companies = [];

  // Header / search / boot-loader icons (card icons are drawn after render).
  drawIcons();

  try {
    companies = await loadIndex();
    renderCards(grid, companies);
    if (count) {
      count.textContent = `${companies.length} compan${companies.length === 1 ? "y" : "ies"} tracked`;
    }
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<p class="empty">Couldn't load the company index. Is the dev server running?</p>`;
  }

  // Client-side search filter.
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const filtered = !q
        ? companies
        : companies.filter((c) =>
            [c.ticker, c.name, c.sector].some((f) =>
              String(f ?? "").toLowerCase().includes(q),
            ),
          );
      renderCards(grid, filtered);
    });
  }

  // Card interaction — placeholder until the dashboard route exists.
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".company-card");
    if (card) flashComingSoon(card);
  });
  grid.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest(".company-card")) {
      e.preventDefault();
      flashComingSoon(e.target.closest(".company-card"));
    }
  });

  hideBoot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
