/**
 * promise-drill.js — the evidence modal for one promise (the integrity layer: a lie
 * detector's claims must be auditable). Shows the verbatim, quote-grounded receipt +
 * source doc/date, the metric/target, the retrieved actual + source, the variance, the
 * mgmt explanation, root-cause, any guidance revisions, and provenance chips. Focus-trap
 * + ESC + focus-restore + scroll-lock (no leak). Null-safe — NYT promises just show less.
 */
import { statusColor, confColor, escapeHTML } from "../ui.js";
import { onRoute } from "../lib/router.js";

const LABEL = { MET: "Met", PARTIAL: "Partial", MISSED: "Missed", NYT: "NYT" };
const TIER_LABEL = { 1: "Tier 1 · binary", 2: "Tier 2 · guidance", 3: "Tier 3 · soft" };
const TIER_TITLE = { 1: "Binary physical/financial outcome — hardest to fudge", 2: "Financial guidance — scoreable", 3: "Soft / medium-term or undated — lowest signal" };
let current = null; // { overlay, trigger, onKey, prevOverflow }

// A route change (navigate() or browser Back/Forward) swaps #app underneath the modal,
// which lives on document.body — close it so no stale receipt or scroll-lock survives.
onRoute(() => closeDrill());

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
  const hasActual = !!(p.actual?.what_happened || p.actual?.text);
  const actualSrc = [p.actual?.source_id, p.actual?.source_date].filter(Boolean).join(" · ");
  const overlay = document.createElement("div");
  overlay.className = "drill-overlay";
  // Two source-backed sections make the audit trail explicit: (1) WHERE the promise was made —
  // the verbatim quote + the document/date it was said in; (2) HOW it was verified — the reported
  // actual + the later document/date it was reported in. Every claim points at a checkable source.
  overlay.innerHTML = `
    <div class="drill card" role="dialog" aria-modal="true" aria-labelledby="drill-title">
      <button type="button" class="drill-close" aria-label="Close">&times;</button>
      <div class="drill-head">
        <span class="status-pill" style="--c:${color}">${LABEL[p.status] || escapeHTML(p.status || "")}</span>
        ${p.tier ? `<span class="drill-tier tier-${p.tier}" title="${TIER_TITLE[p.tier] || ""}">${TIER_LABEL[p.tier] || `Tier ${p.tier}`}</span>` : ""}
        <span class="drill-cat">${escapeHTML(p.category || "")}${p.quarter_context ? ` · ${escapeHTML(p.quarter_context)}` : ""}</span>
      </div>
      <h3 id="drill-title" class="drill-title">${escapeHTML(p.promise || p.metric || p.id)}</h3>
      ${p.dropped ? `<div class="drill-drop"><i data-lucide="triangle-alert" aria-hidden="true"></i> <b>Quietly dropped.</b> Reaffirmed across ${p.mentions || 2} quarters, then went silent once it came due and was never reported — the strongest credibility red flag.</div>` : ""}
      ${Array.isArray(p.slippage_path) && p.slippage_path.length > 1 ? `<div class="drill-slip"><i data-lucide="move-right" aria-hidden="true"></i> <b>Deadline drifted:</b> ${p.slippage_path.map(escapeHTML).join(" → ")}</div>` : ""}

      <section class="drill-section">
        <div class="drill-sec-h"><i data-lucide="megaphone" aria-hidden="true"></i> Where the promise was made</div>
        ${quote ? `
          <figure class="drill-quote">
            <i data-lucide="quote" aria-hidden="true"></i>
            <blockquote>${escapeHTML(quote)}</blockquote>
            <figcaption><span class="drill-src-doc"><i data-lucide="file-text" aria-hidden="true"></i> ${escapeHTML(p.source_label || p.source_id || "source")}</span>${p.date ? ` · ${escapeHTML(p.date)}` : ""}
              <button type="button" class="drill-copy" aria-label="Copy quote">Copy</button>
            </figcaption>
          </figure>` : `<p class="drill-note">No verbatim quote was captured for this commitment.</p>`}
        <dl class="drill-rows">
          ${row("Metric + target", [p.metric, p.target?.text].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · "), "wide")}
          ${row("Test date", p.test_date)}
        </dl>
      </section>

      <section class="drill-section">
        <div class="drill-sec-h"><i data-lucide="badge-check" aria-hidden="true"></i> How it was verified</div>
        ${hasActual ? `<dl class="drill-rows">
          ${row("What happened", p.actual?.what_happened || p.actual?.text, "wide")}
          ${actualSrc ? `<div class="drill-row"><dt>Reported in</dt><dd><span class="drill-src-doc"><i data-lucide="file-check" aria-hidden="true"></i> ${escapeHTML(actualSrc)}</span></dd></div>` : ""}
          ${row("Variance", varianceText(p.variance), "wide")}
          ${p.mgmt_explanation ? row("Mgmt explanation", `“${p.mgmt_explanation}”`, "wide") : ""}
          ${p.root_cause ? `<div class="drill-row"><dt>Root cause</dt><dd><span class="tag-chip">${escapeHTML(p.root_cause)}</span></dd></div>` : ""}
        </dl>` : `<p class="drill-note">Not yet testable — no actual has been reported within the verification window${p.test_date ? ` (test date ${escapeHTML(p.test_date)})` : ""}.</p>`}
      </section>

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
