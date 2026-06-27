/**
 * promise-table.js — the #table section: ALL (filtered) promises in the strict 13-column
 * order, with status pills + confidence badges, a frozen Promise column, sortable headers
 * (date · quarter · confidence · status-severity · variance), and pagination for long
 * ledgers. Subscribes to the shared filter store; row click → drill. Null-safe.
 */
import { statusColor, confColor, escapeHTML } from "../ui.js";
import { periodIndex } from "../lib/fiscal.js";

const PAGE = 25;
const LABEL = { MET: "Met", PARTIAL: "Partial", MISSED: "Missed", NYT: "NYT" };
const STATUS_SEV = { MISSED: 4, PARTIAL: 3, MET: 2, NYT: 1 };
const CONF_SEV = { H: 3, M: 2, L: 1 };

const txt = (p) => (p == null ? "" : String(p));
const metricTarget = (p) => [p.metric, p.target?.text].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ");
const whatHappened = (p) => p.actual?.what_happened || p.actual?.text || "";

// strict column order (matches the PDF). `sort` keys map to comparators below.
const COLS = [
  { key: "date", label: "Date", cls: "nowrap", sort: "date", get: (p) => txt(p.date) },
  { key: "quarter", label: "Qtr / FY", cls: "nowrap", sort: "quarter", get: (p) => txt(p.quarter_context) },
  { key: "source", label: "Source", get: (p) => txt(p.source_label || p.source_id) },
  { key: "promise", label: "Promise", cls: "col-promise", get: (p) => txt(p.promise) },
  { key: "quote", label: "Quote", cls: "col-quote", get: (p) => txt(p.quote) },
  { key: "metric", label: "Metric + Target", get: metricTarget },
  { key: "test_date", label: "Test Date", cls: "nowrap", get: (p) => txt(p.test_date) },
  { key: "conf", label: "Conf", cls: "ctr", sort: "conf", badge: "conf" },
  { key: "actual", label: "What Happened", get: whatHappened },
  { key: "status", label: "Status", cls: "ctr", sort: "status", badge: "status" },
  { key: "variance", label: "Variance", cls: "nowrap-soft", sort: "variance", get: (p) => txt(p.variance?.text) },
  { key: "mgmt", label: "Mgmt Explanation", get: (p) => txt(p.mgmt_explanation) },
  { key: "root", label: "Root-Cause", get: (p) => txt(p.root_cause) },
];

const absNums = (s) => (String(s || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) || []).map((n) => Math.abs(Number(n)));
// magnitude of the variance for sorting. Many ledgers (incl. the curated golden) carry
// only `variance.text` with the numeric fields null, so fall back to the largest number
// in the text; -1 marks rows with no variance at all so they group distinctly.
const varMag = (p) => {
  const v = p.variance || {};
  if (v.pct != null) return Math.abs(v.pct);
  if (v.bps != null) return Math.abs(v.bps);
  if (v.days != null) return Math.abs(v.days);
  if (v.absolute != null) return Math.abs(v.absolute);
  const ns = absNums(v.text);
  return ns.length ? Math.max(...ns) : -1;
};
const COMPARE = {
  date: (a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0),
  quarter: (a, b) => (periodIndex(a.quarter_context) ?? 0) - (periodIndex(b.quarter_context) ?? 0),
  conf: (a, b) => (CONF_SEV[a.confidence] ?? 0) - (CONF_SEV[b.confidence] ?? 0),
  status: (a, b) => (STATUS_SEV[a.status] ?? 0) - (STATUS_SEV[b.status] ?? 0),
  variance: (a, b) => varMag(a) - varMag(b),
};

function cell(col, p) {
  if (col.badge === "status") return `<td class="ctr"><span class="status-pill sm" style="--c:${statusColor(p.status)}">${LABEL[p.status] || escapeHTML(p.status || "")}</span></td>`;
  if (col.badge === "conf") return p.confidence ? `<td class="ctr"><span class="conf-badge" style="--c:${confColor(p.confidence)}" title="${p.confidence} confidence">${p.confidence}</span></td>` : `<td class="ctr"></td>`;
  const v = col.get(p);
  return `<td class="${col.cls || ""}"${v ? "" : ""}>${escapeHTML(v)}</td>`;
}

export function mountTable(host, store, { onDrill }) {
  const sort = { key: "status", dir: -1 }; // default worst-first
  let page = 1;

  function rows() {
    const list = store.filtered().slice();
    const cmp = COMPARE[sort.key];
    if (cmp) list.sort((a, b) => cmp(a, b) * sort.dir);
    return list;
  }

  function render() {
    const all = rows();
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    if (page > pages) page = pages;
    const slice = all.slice((page - 1) * PAGE, page * PAGE);

    const head = `
      <div class="section-head">
        <div class="section-title"><i data-lucide="table" aria-hidden="true"></i><h2>Master promise table</h2></div>
        <span class="section-count">${all.length} promise${all.length === 1 ? "" : "s"}${store.active() ? " · filtered" : ""}</span>
      </div>`;

    if (!all.length) {
      host.innerHTML = `${head}<div class="tr-empty card">No promises match the current filter.</div>`;
      if (window.lucide?.createIcons) window.lucide.createIcons();
      return;
    }

    const ths = COLS.map((c) => {
      const sortable = !!c.sort;
      const active = sortable && sort.key === c.sort;
      const arrow = active ? (sort.dir === 1 ? " ▲" : " ▼") : "";
      return `<th class="${c.cls || ""}${sortable ? " sortable" : ""}${active ? " is-sorted" : ""}"${sortable ? ` data-sort="${c.sort}" role="button" tabindex="0" aria-sort="${active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}"` : ""}>${escapeHTML(c.label)}${arrow}</th>`;
    }).join("");

    const body = slice.map((p) => `<tr data-id="${escapeHTML(p.id)}" tabindex="0">${COLS.map((c) => cell(c, p)).join("")}</tr>`).join("");

    const pager = pages > 1 ? `
      <div class="tbl-pager">
        <button type="button" class="btn-ghost sm" data-pg="prev" ${page === 1 ? "disabled" : ""}>Prev</button>
        <span>Page ${page} of ${pages}</span>
        <button type="button" class="btn-ghost sm" data-pg="next" ${page === pages ? "disabled" : ""}>Next</button>
      </div>` : "";

    host.innerHTML = `${head}
      <div class="table-wrap"><table class="promise-table"><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table></div>
      ${pager}`;
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  // sort
  host.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (th) { const k = th.dataset.sort; if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = (k === "status" || k === "variance") ? -1 : 1; } page = 1; render(); return; }
    const pg = e.target.closest("[data-pg]");
    if (pg) { page += pg.dataset.pg === "next" ? 1 : -1; render(); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) { const p = store.all.find((x) => String(x.id) === tr.dataset.id); if (p) onDrill(p, tr); }
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const th = e.target.closest("th.sortable");
    if (th) { e.preventDefault(); th.click(); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) { e.preventDefault(); const p = store.all.find((x) => String(x.id) === tr.dataset.id); if (p) onDrill(p, tr); }
  });

  store.subscribe(() => { page = 1; render(); });
  render();
}
