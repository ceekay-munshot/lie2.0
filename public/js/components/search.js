/**
 * search.js — company search autocomplete. Loads the committed index, fuzzy-filters
 * by ticker / name / sector, supports full keyboard nav (↑ ↓ Enter Esc), and routes
 * to the company view on select. No match → a "Request this company" CTA (stubbed
 * here; P10 wires the actual dispatch). Company-agnostic — purely index-driven.
 *
 *   mountSearch(hostEl, { compact, autofocus, onRequest });
 */
import { loadIndex, gradeFromScore, gradeColor, escapeHTML } from "../ui.js";
import { navigate } from "../lib/router.js";

let _indexPromise = null;
/** Module-cached index load (shared across every mounted search). */
function getIndex() {
  if (!_indexPromise) _indexPromise = loadIndex().catch((err) => { _indexPromise = null; throw err; });
  return _indexPromise;
}

const norm = (s) => String(s ?? "").toLowerCase().trim();

/** Rank + filter the index for a query (lower rank = better match). */
function filterCompanies(list, q) {
  const query = norm(q);
  if (!query) return list.slice(0, 8);
  const scored = [];
  for (const c of list) {
    const t = norm(c.ticker), n = norm(c.name), s = norm(c.sector);
    let rank = Infinity;
    if (t === query) rank = 0;
    else if (t.startsWith(query)) rank = 1;
    else if (n.startsWith(query)) rank = 2;
    else if (n.includes(query) || t.includes(query)) rank = 3;
    else if (s.includes(query)) rank = 4;
    if (rank < Infinity) scored.push({ c, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || norm(a.c.name).localeCompare(norm(b.c.name)));
  return scored.slice(0, 8).map((x) => x.c);
}

function resultRowHTML(c, i, activeIdx) {
  const grade = c.grade || gradeFromScore(c.credibility_score) || "—";
  const color = gradeColor(grade);
  const meta = [c.sector, c.coverage].filter(Boolean).map(escapeHTML).join(" · ");
  return `
    <li class="ld-result${i === activeIdx ? " is-active" : ""}" role="option" id="ld-opt-${i}"
        aria-selected="${i === activeIdx}" data-ticker="${escapeHTML(c.ticker)}">
      <span class="ld-result-id">
        <span class="ld-result-ticker">${escapeHTML(c.ticker)}</span>
        <span class="ld-result-name">${escapeHTML(c.name)}</span>
        ${meta ? `<span class="ld-result-meta">${meta}</span>` : ""}
      </span>
      <span class="ld-result-grade" style="--grade-color:${color}">${escapeHTML(grade)}</span>
    </li>`;
}

/**
 * Mount a search box into `host`.
 * @returns {{el:HTMLElement, focus:Function, destroy:Function}}
 */
export function mountSearch(host, { compact = false, autofocus = false, onRequest = null } = {}) {
  const root = document.createElement("div");
  root.className = `ld-search${compact ? " is-compact" : ""}`;
  root.innerHTML = `
    <div class="ld-search-box" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-owns="ld-listbox">
      <i data-lucide="search" aria-hidden="true"></i>
      <input class="ld-search-input" type="search" autocomplete="off" spellcheck="false"
             role="searchbox" aria-controls="ld-listbox" aria-autocomplete="list"
             placeholder="${compact ? "Search…" : "Search a company (e.g. Vedanta, VEDL)…"}"
             aria-label="Search companies" />
    </div>
    <ul class="ld-search-panel" id="ld-listbox" role="listbox" hidden></ul>`;
  host.appendChild(root);
  if (window.lucide?.createIcons) window.lucide.createIcons();

  const box = root.querySelector(".ld-search-box");
  const input = root.querySelector(".ld-search-input");
  const panel = root.querySelector(".ld-search-panel");

  let companies = [];
  let results = [];
  let activeIdx = -1;
  let open = false;

  getIndex().then((list) => { companies = list; }).catch((err) => console.error("search index:", err));

  const setOpen = (v) => {
    open = v;
    panel.hidden = !v;
    box.setAttribute("aria-expanded", String(v));
  };

  function render() {
    const q = input.value;
    if (results.length) {
      panel.innerHTML = results.map((c, i) => resultRowHTML(c, i, activeIdx)).join("");
    } else if (norm(q)) {
      panel.innerHTML = `
        <li class="ld-result is-empty" role="option" aria-selected="false">
          <span class="ld-result-id">
            <span class="ld-result-name">No company matches “${escapeHTML(q.trim())}”.</span>
            <span class="ld-result-meta">It may not be covered yet.</span>
          </span>
          <button type="button" class="ld-request" data-q="${escapeHTML(q.trim())}">Request this company</button>
        </li>`;
    } else {
      panel.innerHTML = "";
    }
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function update() {
    results = filterCompanies(companies, input.value);
    activeIdx = results.length ? 0 : -1;
    render();
    setOpen(panel.innerHTML.trim().length > 0);
  }

  function move(delta) {
    if (!results.length) return;
    activeIdx = (activeIdx + delta + results.length) % results.length;
    render();
    const el = panel.querySelector(".ld-result.is-active");
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function choose(ticker) {
    if (!ticker) return;
    setOpen(false);
    input.blur();
    navigate(ticker);
  }

  function requestCompany(q, btn) {
    if (typeof onRequest === "function") onRequest(q);
    const li = btn.closest(".ld-result");
    if (li) li.innerHTML = `<span class="ld-result-id"><span class="ld-result-name">Thanks — noted “${escapeHTML(q)}”.</span><span class="ld-result-meta">Company requests go live in a later build.</span></span>`;
  }

  input.addEventListener("focus", update);
  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) update(); else move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      if (open && results[activeIdx]) { e.preventDefault(); choose(results[activeIdx].ticker); }
      else if (results[0]) { e.preventDefault(); choose(results[0].ticker); }
    } else if (e.key === "Escape") { setOpen(false); input.blur(); }
  });

  panel.addEventListener("mousedown", (e) => {
    // mousedown (not click) so it fires before input blur closes the panel
    const req = e.target.closest(".ld-request");
    if (req) { e.preventDefault(); requestCompany(req.dataset.q || "", req); return; }
    const row = e.target.closest(".ld-result[data-ticker]");
    if (row) { e.preventDefault(); choose(row.dataset.ticker); }
  });
  panel.addEventListener("mousemove", (e) => {
    const row = e.target.closest(".ld-result[data-ticker]");
    if (!row) return;
    const i = results.findIndex((c) => String(c.ticker) === row.dataset.ticker);
    if (i >= 0 && i !== activeIdx) { activeIdx = i; render(); }
  });

  const onDocClick = (e) => { if (!root.contains(e.target)) setOpen(false); };
  document.addEventListener("click", onDocClick);

  if (autofocus) window.requestAnimationFrame(() => input.focus());

  return {
    el: root,
    focus: () => input.focus(),
    destroy: () => { document.removeEventListener("click", onDocClick); root.remove(); },
  };
}
