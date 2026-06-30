/**
 * search.js — company search autocomplete. Loads the committed index, fuzzy-filters
 * by ticker / name / sector, supports full keyboard nav (↑ ↓ Enter Esc), and routes
 * to the company view on select. No match → a "Request this company" CTA that fires the
 * Worker's /api/request/:ticker (P10), shows a processing state, then polls index.json and
 * opens the company once its ledger is scored. Company-agnostic — purely index-driven.
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

function resultRowHTML(c, i, activeIdx, listId) {
  const grade = c.grade || gradeFromScore(c.credibility_score) || "—";
  const color = gradeColor(grade);
  const meta = [c.sector, c.coverage].filter(Boolean).map(escapeHTML).join(" · ");
  return `
    <li class="ld-result${i === activeIdx ? " is-active" : ""}" role="option" id="${listId}-opt-${i}"
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
  // ARIA 1.2 combobox pattern: the role + state live on the INPUT itself (the older
  // shape — role=combobox on a wrapper around a separate input — is broken in modern
  // screen readers). `aria-activedescendant` follows the highlighted option so arrow-key
  // nav is announced. Each mounted search gets a unique listbox id (multiple coexist).
  const listId = `ld-listbox-${++mountSeq}`;
  root.innerHTML = `
    <div class="ld-search-box">
      <i data-lucide="search" aria-hidden="true"></i>
      <input class="ld-search-input" type="search" autocomplete="off" spellcheck="false"
             role="combobox" aria-expanded="false" aria-controls="${listId}" aria-autocomplete="list"
             aria-activedescendant=""
             placeholder="${compact ? "Search…" : "Search a company (e.g. Vedanta, VEDL)…"}"
             aria-label="Search companies" />
    </div>
    <ul class="ld-search-panel" id="${listId}" role="listbox" aria-label="Company results" hidden></ul>`;
  host.appendChild(root);
  if (window.lucide?.createIcons) window.lucide.createIcons();

  const input = root.querySelector(".ld-search-input");
  const panel = root.querySelector(".ld-search-panel");

  let companies = [];
  let results = [];
  let activeIdx = -1;
  let open = false;

  getIndex().then((list) => { companies = list; }).catch((err) => console.error("search index:", err));

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
      // Not a selectable option (it holds a button) — keep it out of the listbox's
      // option set so it never becomes the active descendant.
      panel.innerHTML = `
        <li class="ld-result is-empty">
          <span class="ld-result-id">
            <span class="ld-result-name">No company matches “${escapeHTML(q.trim())}”.</span>
            <span class="ld-result-meta">It may not be covered yet.</span>
          </span>
          <button type="button" class="ld-request" data-q="${escapeHTML(q.trim())}">Request this company</button>
        </li>`;
    } else {
      panel.innerHTML = "";
    }
    syncActive();
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

  async function requestCompany(q, btn) {
    if (typeof onRequest === "function") onRequest(q);
    const li = btn.closest(".ld-result");
    const raw = String(q ?? "").trim();
    const ticker = sanitizeTicker(raw);
    // The request flow is keyed on the stock SYMBOL (the produced ledger and the index poll both use
    // it). A free-text company name would be mangled — "Infosys Limited" → "INFOSYSLIMITED" → the wrong
    // Screener URL — so require a symbol rather than silently dispatching the wrong company.
    const isSymbol = ticker.length > 0 && !/\s/.test(raw) && ticker === raw.toUpperCase();
    if (!isSymbol) { setReqState(li, "Enter the stock symbol to request a company", `e.g. INFY for Infosys — “${raw}” isn’t a symbol.`); return; }
    setReqState(li, `Requesting “${ticker}”…`, "");
    let data = {};
    try {
      const r = await fetch(`/api/request/${encodeURIComponent(ticker)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      data = await r.json().catch(() => ({}));
      if (r.status === 429) { setReqState(li, "Too many requests", "Please try again in a few minutes."); return; }
      if (!r.ok) { setReqState(li, "Couldn’t queue that company", "Please try again later."); return; }
    } catch { setReqState(li, "Network error", "Couldn’t reach the request service."); return; }
    if (data.status === "ready") { choose(ticker); return; } // already covered → just open it
    setReqState(li, `Processing “${ticker}” — pulling filings & scoring`, "This takes a few minutes; we’ll open it automatically when it’s ready.");
    pollUntilReady(ticker, li);
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
