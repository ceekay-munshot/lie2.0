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

const rowHTML = (p) => `<tr data-id="${escapeHTML(p.id)}" tabindex="0">${COLS.map((c) => cell(c, p)).join("")}</tr>`;

const pagerHTML = (page, pages, scope) => (pages > 1 ? `
  <div class="tbl-pager">
    <button type="button" class="btn-ghost sm" data-pg="prev" data-scope="${scope}" ${page === 1 ? "disabled" : ""}>Prev</button>
    <span>Page ${page} of ${pages}</span>
    <button type="button" class="btn-ghost sm" data-pg="next" data-scope="${scope}" ${page === pages ? "disabled" : ""}>Next</button>
  </div>` : "");

/**
 * The master table leads with the TESTABLE verdicts (status ≠ NYT); the not-yet-due
 * promises — legitimately awaiting their test date and excluded from the score — are
 * folded into a labelled, collapsible block so a wide ledger (e.g. VEDL's 158 NYT)
 * doesn't bury the 149 rows that actually carry a verdict. NYT stay one click away.
 */
export function mountTable(host, store, { onDrill }) {
  const sort = { key: "status", dir: -1 }; // default worst-first
  let pageT = 1, pageN = 1, nytOpen = false;

  const sortList = (list) => {
    const out = list.slice();
    const cmp = COMPARE[sort.key];
    if (cmp) out.sort((a, b) => cmp(a, b) * sort.dir);
    return out;
  };

  const theadHTML = () => COLS.map((c) => {
    const sortable = !!c.sort;
    const active = sortable && sort.key === c.sort;
    const arrow = active ? (sort.dir === 1 ? " ▲" : " ▼") : "";
    return `<th class="${c.cls || ""}${sortable ? " sortable" : ""}${active ? " is-sorted" : ""}"${sortable ? ` data-sort="${c.sort}" role="button" tabindex="0" aria-sort="${active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}"` : ""}>${escapeHTML(c.label)}${arrow}</th>`;
  }).join("");

  const tableHTML = (list, page, scope) => {
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    const p = Math.min(page, pages);
    if (scope === "t") pageT = p; else pageN = p;
    const slice = list.slice((p - 1) * PAGE, p * PAGE);
    return `<div class="table-wrap"><table class="promise-table"><thead><tr>${theadHTML()}</tr></thead><tbody>${slice.map(rowHTML).join("")}</tbody></table></div>${pagerHTML(p, pages, scope)}`;
  };

  function render() {
    const filtered = store.filtered();
    const testable = sortList(filtered.filter((x) => x.status !== "NYT"));
    const nyt = sortList(filtered.filter((x) => x.status === "NYT"));
    // if a filter leaves nothing testable, auto-open NYT so the view isn't empty
    const nytExpanded = nyt.length > 0 && (nytOpen || testable.length === 0);

    const head = `
      <div class="section-head">
        <div class="section-title"><i data-lucide="table" aria-hidden="true"></i><h2>Master promise table</h2></div>
        <span class="section-count">${testable.length} testable${store.active() ? " · filtered" : ""}${nyt.length ? ` · ${nyt.length} not yet due` : ""}</span>
      </div>`;

    const main = testable.length
      ? tableHTML(testable, pageT, "t")
      : `<div class="tr-empty card">No testable promises match the current filter.</div>`;

    const nytBlock = nyt.length ? `
      <div class="nyt-section">
        <button type="button" class="nyt-toggle" data-nyt-toggle aria-expanded="${nytExpanded}">
          <i data-lucide="${nytExpanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></i>
          <span>Not yet due <b>${nyt.length}</b></span>
          <span class="nyt-note">awaiting their test date · excluded from the score</span>
        </button>
        ${nytExpanded ? tableHTML(nyt, pageN, "n") : ""}
      </div>` : "";

    host.innerHTML = `${head}${main}${nytBlock}`;
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  host.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (th) { const k = th.dataset.sort; if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = (k === "status" || k === "variance") ? -1 : 1; } pageT = 1; pageN = 1; render(); return; }
    const tog = e.target.closest("[data-nyt-toggle]");
    if (tog) { nytOpen = !nytOpen; render(); return; }
    const pg = e.target.closest("[data-pg]");
    if (pg) { const d = pg.dataset.pg === "next" ? 1 : -1; if (pg.dataset.scope === "n") pageN += d; else pageT += d; render(); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) { const p = store.all.find((x) => String(x.id) === tr.dataset.id); if (p) onDrill(p, tr); }
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const th = e.target.closest("th.sortable");
    if (th) { e.preventDefault(); th.click(); return; }
    const tog = e.target.closest("[data-nyt-toggle]");
    if (tog) { e.preventDefault(); tog.click(); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) { e.preventDefault(); const p = store.all.find((x) => String(x.id) === tr.dataset.id); if (p) onDrill(p, tr); }
  });

  store.subscribe(() => { pageT = 1; pageN = 1; render(); });
  render();
}
