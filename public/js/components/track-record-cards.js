/**
 * track-record-cards.js — the #track-record section: TESTABLE promises (status ≠ NYT)
 * as worst-first colour cards (MISSED → PARTIAL → MET), each a coloured left-border +
 * status pill + title + Target/Actual/Variance + mgmt_explanation + root-cause chip.
 * Subscribes to the shared filter store; click → drill. Null-safe; company-agnostic.
 */
import { statusColor, escapeHTML } from "../ui.js";

const SEVERITY = { MISSED: 0, PARTIAL: 1, MET: 2 }; // worst first
const LABEL = { MET: "Met", PARTIAL: "Partial", MISSED: "Missed", NYT: "NYT" };

function cardHTML(p) {
  const color = statusColor(p.status);
  const target = p.target?.text || p.metric || "—";
  const actual = p.actual?.what_happened || p.actual?.text || "—";
  const variance = p.variance?.text || "—";
  return `
    <article class="tr-card" data-id="${escapeHTML(p.id)}" tabindex="0" role="button" style="--c:${color}"
             aria-label="${escapeHTML(LABEL[p.status] || p.status)}: ${escapeHTML(p.promise || p.metric || p.id)}">
      <div class="tr-card-top">
        <span class="status-pill" style="--c:${color}">${LABEL[p.status] || p.status}</span>
        ${p.quarter_context ? `<span class="tr-card-qtr">${escapeHTML(p.quarter_context)}</span>` : ""}
      </div>
      <h4 class="tr-card-title">${escapeHTML(p.promise || p.metric || p.id)}</h4>
      <dl class="tr-card-rows">
        <div><dt>Target</dt><dd>${escapeHTML(target)}</dd></div>
        <div><dt>Actual</dt><dd>${escapeHTML(actual)}</dd></div>
        <div><dt>Variance</dt><dd class="tr-var">${escapeHTML(variance)}</dd></div>
      </dl>
      ${p.mgmt_explanation ? `<p class="tr-why">“${escapeHTML(p.mgmt_explanation)}”</p>` : ""}
      ${p.root_cause ? `<span class="tag-chip">${escapeHTML(p.root_cause)}</span>` : ""}
    </article>`;
}

export function mountTrackRecord(host, store, { onDrill }) {
  const totalTestable = store.all.filter((p) => p.status && p.status !== "NYT").length;

  function render(filtered) {
    const testable = filtered.filter((p) => p.status && p.status !== "NYT");
    testable.sort((a, b) => (SEVERITY[a.status] ?? 9) - (SEVERITY[b.status] ?? 9));
    const head = `
      <div class="section-head">
        <div class="section-title"><i data-lucide="layout-grid" aria-hidden="true"></i><h2>Track record</h2></div>
        <span class="section-count">${testable.length} of ${totalTestable} testable${store.active() ? " · filtered" : ""}</span>
      </div>`;
    if (!testable.length) {
      const nyt = filtered.filter((p) => p.status === "NYT").length;
      const msg = store.active()
        ? "No testable promises match the current filter."
        : `No testable promises yet — ${nyt} awaiting their test date.`;
      host.innerHTML = `${head}<div class="tr-empty card">${escapeHTML(msg)}</div>`;
    } else {
      host.innerHTML = `${head}<div class="tr-grid">${testable.map(cardHTML).join("")}</div>`;
    }
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  const fire = (el) => { const p = store.all.find((x) => String(x.id) === el.dataset.id); if (p) onDrill(p, el); };
  host.addEventListener("click", (e) => { const c = e.target.closest(".tr-card[data-id]"); if (c) fire(c); });
  host.addEventListener("keydown", (e) => {
    const c = e.target.closest(".tr-card[data-id]");
    if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); fire(c); }
  });

  store.subscribe(render);
  render(store.filtered());
}
