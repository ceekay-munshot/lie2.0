/**
 * filter-bar.js — the shared filter state for the track-record cards + master table.
 * `createFilterStore(promises)` is a tiny pub/sub store; `mountFilterBar` renders the
 * controls (status chips · category · quarter · confidence · free-text) and removable
 * "active filter" chips with a clear-all. Both the cards and the table subscribe to the
 * same store, so filtering one filters the other. Company-agnostic — options are derived
 * from the promises themselves.
 */
import { statusColor, confColor, escapeHTML } from "../ui.js";
import { periodIndex } from "../lib/fiscal.js";

const STATUS = ["MET", "PARTIAL", "MISSED", "NYT"];
const STATUS_LABEL = { MET: "Met", PARTIAL: "Partial", MISSED: "Missed", NYT: "NYT" };
const CONF_LABEL = { H: "High", M: "Medium", L: "Low" };
const titleCase = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** A pub/sub filter store over a promise list. */
export function createFilterStore(promises) {
  const all = Array.isArray(promises) ? promises : [];
  const state = { statuses: new Set(), category: "", quarter: "", confidence: "", q: "" };
  const subs = new Set();

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return all.filter((p) => {
      if (state.statuses.size && !state.statuses.has(p.status)) return false;
      if (state.category && p.category !== state.category) return false;
      if (state.quarter && (p.quarter_context || "") !== state.quarter) return false;
      if (state.confidence && p.confidence !== state.confidence) return false;
      if (q) {
        const hay = `${p.promise || ""} ${p.metric || ""} ${p.quote || ""} ${p.target?.text || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  const emit = () => { const f = filtered(); for (const cb of subs) cb(f, state); };

  return {
    all,
    state,
    filtered,
    active() {
      return state.statuses.size > 0 || !!state.category || !!state.quarter || !!state.confidence || !!state.q.trim();
    },
    set(patch) { Object.assign(state, patch); emit(); },
    toggleStatus(s) { state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s); emit(); },
    clear() { state.statuses.clear(); state.category = ""; state.quarter = ""; state.confidence = ""; state.q = ""; emit(); },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    emit,
  };
}

/** Render the filter controls into `host`, wired to `store`. */
export function mountFilterBar(host, store) {
  const cats = [...new Set(store.all.map((p) => p.category).filter(Boolean))].sort();
  const quarters = [...new Set(store.all.map((p) => p.quarter_context).filter(Boolean))]
    .sort((a, b) => (periodIndex(a) ?? 0) - (periodIndex(b) ?? 0));
  const confs = ["H", "M", "L"].filter((c) => store.all.some((p) => p.confidence === c));

  host.innerHTML = `
    <div class="fb">
      <div class="fb-search">
        <i data-lucide="search" aria-hidden="true"></i>
        <input type="search" class="fb-q" autocomplete="off" spellcheck="false" placeholder="Search promise, metric or quote…" aria-label="Search promises" />
      </div>
      <div class="fb-statuses" role="group" aria-label="Filter by status">
        ${STATUS.map((s) => `<button type="button" class="fb-chip" data-status="${s}" style="--c:${statusColor(s)}" aria-pressed="false">${STATUS_LABEL[s]}</button>`).join("")}
      </div>
      <select class="fb-select fb-cat" aria-label="Filter by category">
        <option value="">All categories</option>
        ${cats.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(titleCase(c))}</option>`).join("")}
      </select>
      <select class="fb-select fb-qtr" aria-label="Filter by quarter">
        <option value="">All quarters</option>
        ${quarters.map((q) => `<option value="${escapeHTML(q)}">${escapeHTML(q)}</option>`).join("")}
      </select>
      <select class="fb-select fb-conf" aria-label="Filter by confidence">
        <option value="">Any confidence</option>
        ${confs.map((c) => `<option value="${c}">${CONF_LABEL[c]}</option>`).join("")}
      </select>
      <button type="button" class="fb-clear" hidden><i data-lucide="x" aria-hidden="true"></i> Clear all</button>
      <div class="fb-active" aria-live="polite"></div>
    </div>`;
  if (window.lucide?.createIcons) window.lucide.createIcons();

  const $ = (sel) => host.querySelector(sel);
  const qInput = $(".fb-q");
  const catSel = $(".fb-cat");
  const qtrSel = $(".fb-qtr");
  const confSel = $(".fb-conf");
  const clearBtn = $(".fb-clear");
  const activeWrap = $(".fb-active");

  // controls → store
  qInput.addEventListener("input", () => store.set({ q: qInput.value }));
  catSel.addEventListener("change", () => store.set({ category: catSel.value }));
  qtrSel.addEventListener("change", () => store.set({ quarter: qtrSel.value }));
  confSel.addEventListener("change", () => store.set({ confidence: confSel.value }));
  host.querySelector(".fb-statuses").addEventListener("click", (e) => {
    const b = e.target.closest(".fb-chip"); if (b) store.toggleStatus(b.dataset.status);
  });
  clearBtn.addEventListener("click", () => store.clear());

  // active-filter chips (removable) — click × to drop a single filter
  activeWrap.addEventListener("click", (e) => {
    const x = e.target.closest("[data-drop]"); if (!x) return;
    const [kind, val] = x.dataset.drop.split(":");
    if (kind === "status") store.toggleStatus(val);
    else if (kind === "category") store.set({ category: "" });
    else if (kind === "quarter") store.set({ quarter: "" });
    else if (kind === "confidence") store.set({ confidence: "" });
    else if (kind === "q") store.set({ q: "" });
  });

  // store → controls (sync DOM, render active chips)
  store.subscribe((_filtered, s) => {
    host.querySelectorAll(".fb-chip").forEach((b) => {
      const on = s.statuses.has(b.dataset.status);
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (catSel.value !== s.category) catSel.value = s.category;
    if (qtrSel.value !== s.quarter) qtrSel.value = s.quarter;
    if (confSel.value !== s.confidence) confSel.value = s.confidence;
    if (qInput.value !== s.q) qInput.value = s.q;

    const chips = [];
    for (const st of s.statuses) chips.push(`<span class="fb-active-chip" style="--c:${statusColor(st)}">${STATUS_LABEL[st]}<button type="button" data-drop="status:${st}" aria-label="Remove ${STATUS_LABEL[st]} filter">×</button></span>`);
    if (s.category) chips.push(`<span class="fb-active-chip">${escapeHTML(titleCase(s.category))}<button type="button" data-drop="category:" aria-label="Remove category filter">×</button></span>`);
    if (s.quarter) chips.push(`<span class="fb-active-chip">${escapeHTML(s.quarter)}<button type="button" data-drop="quarter:" aria-label="Remove quarter filter">×</button></span>`);
    if (s.confidence) chips.push(`<span class="fb-active-chip" style="--c:${confColor(s.confidence)}">Conf ${s.confidence}<button type="button" data-drop="confidence:" aria-label="Remove confidence filter">×</button></span>`);
    if (s.q.trim()) chips.push(`<span class="fb-active-chip">“${escapeHTML(s.q.trim())}”<button type="button" data-drop="q:" aria-label="Remove search">×</button></span>`);
    activeWrap.innerHTML = chips.join("");
    clearBtn.hidden = !store.active();
  });
}
