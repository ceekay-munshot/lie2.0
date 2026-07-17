/**
 * search.js — company search autocomplete. Merges TWO sources:
 *   1. the committed index (covered companies) — fuzzy-matched, shown first with a grade;
 *   2. the muns stock-search API via the Worker's /api/search proxy — every Indian listing,
 *      shown as "Generate" rows that fire the request→pipeline flow on select.
 * Full keyboard nav (↑ ↓ Enter Esc). A covered pick opens the dashboard; an uncovered pick
 * fires /api/request/:ticker, shows a processing state, polls index.json, then opens it.
 * Degrades gracefully: if /api/search is unconfigured or down, only the local index shows.
 *
 *   mountSearch(hostEl, { compact, autofocus, onRequest });
 */
import { loadIndex, gradeFromScore, gradeColor, escapeHTML } from "../ui.js";
import { navigate } from "../lib/router.js";

/** Best-effort ticker from a free-text query (Screener resolves names server-side anyway). */
const sanitizeTicker = (q) => String(q ?? "").trim().toUpperCase().replace(/[^A-Z0-9.&-]+/g, "").slice(0, 24);
/** Re-render a result row as a status line (request progress). */
function setReqState(li, title, meta) {
  if (!li) return;
  li.innerHTML = `<span class="ld-result-id"><span class="ld-result-name">${escapeHTML(title)}</span>${meta ? `<span class="ld-result-meta">${escapeHTML(meta)}</span>` : ""}</span>`;
}

let mountSeq = 0; // unique listbox id per mounted search (header + error view can coexist)
let _indexPromise = null;
/** Module-cached index load (shared across every mounted search). */
function getIndex() {
  if (!_indexPromise) _indexPromise = loadIndex().catch((err) => { _indexPromise = null; throw err; });
  return _indexPromise;
}

const norm = (s) => String(s ?? "").toLowerCase().trim();

/** Rank + filter the committed index for a query (lower rank = better match). */
function filterCompanies(list, q) {
  const query = norm(q);
  if (!query) return list.slice(0, 6);
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
  return scored.slice(0, 6).map((x) => x.c);
}

const toCovered = (c) => ({ ticker: c.ticker, name: c.name, sector: c.sector, coverage: c.coverage, covered: true, grade: c.grade || gradeFromScore(c.credibility_score) || "—" });
const toExternal = (x) => ({ ticker: x.ticker, name: x.name, sector: x.sector, covered: false });

/** One dropdown row — a covered company (grade + open) or an external one (generate). */
function resultRowHTML(item, i, activeIdx, listId) {
  const active = i === activeIdx;
  const base = `class="ld-result${item.covered ? "" : " is-external"}${active ? " is-active" : ""}" role="option" id="${listId}-opt-${i}" aria-selected="${active}" data-ticker="${escapeHTML(item.ticker)}" data-covered="${item.covered ? "1" : "0"}"`;
  if (item.covered) {
    const color = gradeColor(item.grade);
    const meta = [item.sector, item.coverage].filter(Boolean).map(escapeHTML).join(" · ");
    return `
      <li ${base}>
        <span class="ld-result-id">
          <span class="ld-result-ticker">${escapeHTML(item.ticker)}</span>
          <span class="ld-result-name">${escapeHTML(item.name)}</span>
          ${meta ? `<span class="ld-result-meta">${meta}</span>` : ""}
        </span>
        <span class="ld-result-grade" style="--grade-color:${color}">${escapeHTML(item.grade)}</span>
      </li>`;
  }
  const meta = escapeHTML(item.sector || "");
  return `
    <li ${base}>
      <span class="ld-result-id">
        <span class="ld-result-ticker">${escapeHTML(item.ticker)}</span>
        <span class="ld-result-name">${escapeHTML(item.name)}</span>
        ${meta ? `<span class="ld-result-meta">${meta}</span>` : ""}
      </span>
      <span class="ld-result-gen" title="Not covered yet — generate a report"><i data-lucide="sparkles" aria-hidden="true"></i>Generate</span>
    </li>`;
}

/**
 * Mount a search box into `host`.
 * @returns {{el:HTMLElement, focus:Function, destroy:Function}}
 */
export function mountSearch(host, { compact = false, autofocus = false, onRequest = null } = {}) {
  const root = document.createElement("div");
  root.className = `ld-search${compact ? " is-compact" : ""}`;
  const listId = `ld-listbox-${++mountSeq}`;
  root.innerHTML = `
    <div class="ld-search-box">
      <i data-lucide="search" aria-hidden="true"></i>
      <input class="ld-search-input" type="search" autocomplete="off" spellcheck="false"
             role="combobox" aria-expanded="false" aria-controls="${listId}" aria-autocomplete="list"
             aria-activedescendant=""
             placeholder="${compact ? "Search…" : "Search any Indian company (e.g. Reliance, TCS)…"}"
             aria-label="Search companies" />
    </div>
    <ul class="ld-search-panel" id="${listId}" role="listbox" aria-label="Company results" hidden></ul>`;
  host.appendChild(root);
  if (window.lucide?.createIcons) window.lucide.createIcons();

  const input = root.querySelector(".ld-search-input");
  const panel = root.querySelector(".ld-search-panel");

  let companies = [];
  let results = [];       // merged [{...covered|external}]
  let activeIdx = -1;
  let open = false;
  // external (API) search state
  let externalResults = [];
  let externalQuery = "";
  let searchTimer = null;
  let searchSeq = 0;

  getIndex().then((list) => { companies = list; renderMerged(); }).catch((err) => console.error("search index:", err));

  const syncActive = () => {
    input.setAttribute("aria-activedescendant", activeIdx >= 0 && results.length ? `${listId}-opt-${activeIdx}` : "");
  };
  const setOpen = (v) => {
    open = v;
    panel.hidden = !v;
    input.setAttribute("aria-expanded", String(v));
    if (!v) input.setAttribute("aria-activedescendant", "");
  };

  function render() {
    const q = input.value;
    if (results.length) {
      panel.innerHTML = results.map((c, i) => resultRowHTML(c, i, activeIdx, listId)).join("");
    } else if (norm(q)) {
      panel.innerHTML = `
        <li class="ld-result is-empty">
          <span class="ld-result-id">
            <span class="ld-result-name">No match for “${escapeHTML(q.trim())}”.</span>
            <span class="ld-result-meta">Enter its stock symbol to generate a report.</span>
          </span>
          <button type="button" class="ld-request" data-q="${escapeHTML(q.trim())}">Generate</button>
        </li>`;
    } else {
      panel.innerHTML = "";
    }
    syncActive();
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  /** Merge covered (index) + external (API) results and paint. */
  function renderMerged() {
    const q = input.value;
    const local = filterCompanies(companies, q).map(toCovered);
    const seen = new Set(local.map((x) => x.ticker.toUpperCase()));
    const ext = (norm(q) === norm(externalQuery) ? externalResults : [])
      .filter((x) => !seen.has(String(x.ticker).toUpperCase()))
      .map(toExternal);
    results = [...local, ...ext].slice(0, 8);
    if (activeIdx >= results.length) activeIdx = results.length ? 0 : -1;
    render();
    setOpen(panel.innerHTML.trim().length > 0);
  }

  /** Debounced call to the Worker /api/search proxy; degrades silently on any failure. */
  function scheduleExternal() {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { externalResults = []; externalQuery = ""; return; }
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      let data = {};
      try {
        const r = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
        data = await r.json().catch(() => ({}));
      } catch { data = {}; }
      if (seq !== searchSeq) return; // a newer keystroke superseded this fetch
      externalResults = Array.isArray(data.results) ? data.results : [];
      externalQuery = q;
      renderMerged();
    }, 220);
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

  /** Select a merged item: covered → open; external → generate a report. */
  function selectItem(item, li) {
    if (!item) return;
    if (item.covered) return choose(item.ticker);
    runRequest(item.ticker, li);
  }

  /** POST /api/request/:ticker then poll the index until the ledger appears. */
  async function runRequest(ticker, li) {
    const T = sanitizeTicker(ticker);
    if (!T) { setReqState(li, "Enter a valid stock symbol", "e.g. INFY, RELIANCE"); return; }
    if (typeof onRequest === "function") onRequest(T);
    setReqState(li, `Requesting “${T}”…`, "");
    let data = {};
    try {
      const r = await fetch(`/api/request/${encodeURIComponent(T)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      data = await r.json().catch(() => ({}));
      if (r.status === 429) { setReqState(li, "Too many requests", "Please try again in a few minutes."); return; }
      if (!r.ok) { setReqState(li, "Couldn’t queue that company", "Please try again later."); return; }
    } catch { setReqState(li, "Network error", "Couldn’t reach the request service."); return; }
    if (data.status === "ready") { choose(T); return; } // already covered → just open it
    setReqState(li, `Processing “${T}” — pulling filings & scoring`, "This takes a few minutes; we’ll open it automatically when it’s ready.");
    pollUntilReady(T, li);
  }

  /** The typed no-match fallback (API returned nothing) — require a symbol, then request. */
  function requestTyped(q, btn) {
    const li = btn.closest(".ld-result");
    const raw = String(q ?? "").trim();
    const ticker = sanitizeTicker(raw);
    const isSymbol = ticker.length > 0 && !/\s/.test(raw) && ticker === raw.toUpperCase();
    if (!isSymbol) { setReqState(li, "Enter the stock symbol to generate a report", `e.g. INFY for Infosys — “${raw}” isn’t a symbol.`); return; }
    runRequest(ticker, li);
  }

  // Poll the committed index (the ground truth) until the requested ledger appears, then route.
  function pollUntilReady(ticker, li) {
    const T = ticker.toUpperCase();
    const deadline = Date.now() + 6 * 60 * 1000;
    const tick = async () => {
      try {
        const res = await fetch(`/data/companies/index.json?t=${Date.now()}`, { cache: "no-store" });
        if (res.ok) {
          const idx = await res.json();
          if (Array.isArray(idx) && idx.some((c) => String(c.ticker).toUpperCase() === T)) { choose(ticker); return; }
        }
      } catch { /* transient — keep polling */ }
      if (Date.now() < deadline) setTimeout(tick, 8000);
      else setReqState(li, `Still processing “${ticker}”`, "Check back shortly — it’ll appear in search once scored.");
    };
    setTimeout(tick, 8000);
  }

  const onInput = () => { activeIdx = 0; renderMerged(); scheduleExternal(); };
  input.addEventListener("focus", onInput);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) onInput(); else move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      const item = (open && results[activeIdx]) ? results[activeIdx] : results[0];
      if (item) { e.preventDefault(); selectItem(item, panel.querySelector(".ld-result.is-active") || panel.querySelector(".ld-result[data-ticker]")); }
    } else if (e.key === "Escape") { setOpen(false); input.blur(); }
  });

  panel.addEventListener("mousedown", (e) => {
    // mousedown (not click) so it fires before input blur closes the panel
    const req = e.target.closest(".ld-request");
    if (req) { e.preventDefault(); requestTyped(req.dataset.q || "", req); return; }
    const row = e.target.closest(".ld-result[data-ticker]");
    if (row) {
      e.preventDefault();
      const i = results.findIndex((c) => String(c.ticker) === row.dataset.ticker);
      if (i >= 0) selectItem(results[i], row);
    }
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
    destroy: () => { document.removeEventListener("click", onDocClick); clearTimeout(searchTimer); root.remove(); },
  };
}
