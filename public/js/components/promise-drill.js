/**
 * promise-drill.js — the evidence modal for one promise (the integrity layer: a lie
 * detector's claims must be auditable). Shows the verbatim, quote-grounded receipt +
 * source doc/date, the metric/target, the retrieved actual + source, the variance, the
 * mgmt explanation, root-cause, any guidance revisions, and provenance chips. Focus-trap
 * + ESC + focus-restore + scroll-lock (no leak). Null-safe — NYT promises just show less.
 */
import { statusColor, confColor, escapeHTML } from "../ui.js";

const LABEL = { MET: "Met", PARTIAL: "Partial", MISSED: "Missed", NYT: "NYT" };
let current = null; // { overlay, trigger, onKey, prevOverflow }

function row(label, value, cls = "") {
  if (value == null || value === "") return "";
  return `<div class="drill-row ${cls}"><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`;
}

function varianceText(v) {
  if (!v) return "";
  const parts = [];
  if (v.absolute != null) parts.push(`abs ${v.absolute}`);
  if (v.pct != null) parts.push(`${v.pct > 0 ? "+" : ""}${v.pct}%`);
  if (v.bps != null) parts.push(`${v.bps > 0 ? "+" : ""}${v.bps} bps`);
  if (v.days != null) parts.push(`${v.days} days`);
  const nums = parts.join(" · ");
  return v.text ? (nums ? `${v.text} (${nums})` : v.text) : nums;
}

// provenance/extras render ONLY when present (the curated golden has none of these)
function provChips(p) {
  const chips = [];
  if (p.confidence) chips.push(`<span class="drill-chip" style="--c:${confColor(p.confidence)}">Confidence ${p.confidence}</span>`);
  if (Array.isArray(p.found_by) && p.found_by.length) chips.push(`<span class="drill-chip">Found by ${escapeHTML(p.found_by.join(", "))}</span>`);
  if (p.figure_in_quote === false) chips.push(`<span class="drill-chip warn">No figure in quote</span>`);
  if (p.was_revised) chips.push(`<span class="drill-chip warn">Guidance revised</span>`);
  return chips.join("");
}

function historyHTML(p) {
  const revs = Array.isArray(p.revisions) ? p.revisions : [];
  const reaff = Array.isArray(p.reaffirmed_on) ? p.reaffirmed_on : [];
  const items = [];
  if (p.was_revised) items.push(`<li class="warn">Guidance was revised — the verdict is judged against the ORIGINAL target.</li>`);
  for (const r of revs) items.push(`<li>Revised ${escapeHTML(r.date || "")}: ${escapeHTML(r.target?.text || "")}</li>`);
  for (const q of reaff) items.push(`<li>Reaffirmed ${escapeHTML(typeof q === "string" ? q : (q?.quarter || ""))}</li>`);
  if (!items.length) return "";
  return `<div class="drill-block"><h4>Guidance history</h4><ul class="drill-revs">${items.join("")}</ul></div>`;
}

export function openDrill(p, trigger) {
  closeDrill();
  const color = statusColor(p.status);
  const quote = p.quote || "";
  const overlay = document.createElement("div");
  overlay.className = "drill-overlay";
  overlay.innerHTML = `
    <div class="drill card" role="dialog" aria-modal="true" aria-labelledby="drill-title">
      <button type="button" class="drill-close" aria-label="Close">&times;</button>
      <div class="drill-head">
        <span class="status-pill" style="--c:${color}">${LABEL[p.status] || escapeHTML(p.status || "")}</span>
        <span class="drill-cat">${escapeHTML(p.category || "")}${p.quarter_context ? ` · ${escapeHTML(p.quarter_context)}` : ""}</span>
      </div>
      <h3 id="drill-title" class="drill-title">${escapeHTML(p.promise || p.metric || p.id)}</h3>
      ${quote ? `
        <figure class="drill-quote">
          <i data-lucide="quote" aria-hidden="true"></i>
          <blockquote>${escapeHTML(quote)}</blockquote>
          <figcaption>${escapeHTML(p.source_label || p.source_id || "source")}${p.date ? ` · ${escapeHTML(p.date)}` : ""}
            <button type="button" class="drill-copy" aria-label="Copy quote">Copy</button>
          </figcaption>
        </figure>` : ""}
      <dl class="drill-rows">
        ${row("Metric + target", [p.metric, p.target?.text].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · "), "wide")}
        ${row("Test date", p.test_date)}
        ${row("What happened", p.actual?.what_happened || p.actual?.text, "wide")}
        ${row("Actual source", [p.actual?.source_id, p.actual?.source_date].filter(Boolean).join(" · "))}
        ${row("Variance", varianceText(p.variance), "wide")}
        ${p.mgmt_explanation ? row("Mgmt explanation", `“${p.mgmt_explanation}”`, "wide") : ""}
        ${p.root_cause ? `<div class="drill-row"><dt>Root cause</dt><dd><span class="tag-chip">${escapeHTML(p.root_cause)}</span></dd></div>` : ""}
      </dl>
      ${historyHTML(p)}
      ${provChips(p) ? `<div class="drill-prov">${provChips(p)}</div>` : ""}
    </div>`;
  document.body.appendChild(overlay);
  if (window.lucide?.createIcons) window.lucide.createIcons();

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const dialog = overlay.querySelector(".drill");
  const focusables = () => [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeDrill(); return; }
    if (e.key === "Tab") {
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeDrill(); });
  overlay.querySelector(".drill-close").addEventListener("click", closeDrill);
  const copyBtn = overlay.querySelector(".drill-copy");
  if (copyBtn) copyBtn.addEventListener("click", () => {
    navigator.clipboard?.writeText(quote).then(() => { copyBtn.textContent = "Copied ✓"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 1400); }).catch(() => {});
  });

  current = { overlay, trigger, onKey, prevOverflow };
  requestAnimationFrame(() => overlay.querySelector(".drill-close")?.focus());
}

export function closeDrill() {
  if (!current) return;
  const { overlay, trigger, onKey, prevOverflow } = current;
  document.removeEventListener("keydown", onKey, true);
  document.body.style.overflow = prevOverflow || "";
  overlay.remove();
  current = null;
  if (trigger && typeof trigger.focus === "function") trigger.focus();
}
