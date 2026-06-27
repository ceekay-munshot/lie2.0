/**
 * credibility-hero.js — the company view's headline. Renders the credibility ring,
 * the deterministic headline, the DELIVERY-vs-TIMELINE split (the product's core
 * insight — "hits its numbers, misses its deadlines"), a compact status-mix bar, a
 * meta row, and the PROVENANCE badge that disclaims a mock/incomplete ledger.
 * Pure render → HTML string; reads only the ledger. No company specifics.
 */
import {
  statusColor, gradeColor, gradeFromScore, provenanceBadge, escapeHTML,
} from "../ui.js";

const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

const BADGE_ICON = {
  live: "shield-check",
  mock: "flask-conical",
  provisional: "triangle-alert",
  manual: "pencil-ruler",
  unknown: "circle-help",
};

function fmtDate(iso) {
  const s = String(iso || "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s || "—";
  try {
    return new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return s.slice(0, 10); }
}

/** SVG progress ring (pathLength=100 → dasharray reads as a percentage directly). */
function ringSVG(pct, color) {
  return `
    <svg class="ring" viewBox="0 0 120 120" role="img" aria-hidden="true">
      <circle class="ring-track" cx="60" cy="60" r="52" pathLength="100" fill="none" stroke-width="11" />
      <circle class="ring-fill" cx="60" cy="60" r="52" pathLength="100" fill="none" stroke-width="11"
              stroke="${color}" stroke-linecap="round"
              stroke-dasharray="${pct} 100" transform="rotate(-90 60 60)" />
    </svg>`;
}

/** One labelled 0–100 mini-bar for the delivery/timeline split. */
function splitBar(label, score, hint) {
  const has = score != null && !Number.isNaN(Number(score));
  const pct = clampPct(score);
  const color = has ? gradeColor(gradeFromScore(score)) : "var(--status-nyt)";
  return `
    <div class="split-row${has ? "" : " is-empty"}">
      <div class="split-row-head">
        <span class="split-row-label">${escapeHTML(label)}</span>
        <span class="split-row-val" style="color:${color}">${has ? Math.round(score) : "—"}<small>/100</small></span>
      </div>
      <div class="split-track"><span class="split-fill" style="width:${has ? pct : 0}%;background:${color}"></span></div>
      ${has ? "" : `<span class="split-empty-note">${escapeHTML(hint || "Nothing testable yet")}</span>`}
    </div>`;
}

/** The signature one-liner contrasting delivery vs deadlines. */
function splitInsight(delivery, timeline) {
  const d = delivery, t = timeline;
  if (d == null && t == null) return "No testable promises yet — the score is pending.";
  if (d == null) return "Only deadline commitments are testable so far.";
  if (t == null) return "Only numeric targets are testable so far.";
  const gap = d - t;
  if (gap >= 20) return "Hits its numbers far better than its deadlines.";
  if (gap <= -20) return "Keeps its deadlines better than its numbers.";
  return "Delivery on numbers and deadlines track closely.";
}

/** Compact stacked MET/PARTIAL/MISSED/NYT bar + legend. */
function statusMix(sc, total) {
  const order = [["MET", "Met"], ["PARTIAL", "Partial"], ["MISSED", "Missed"], ["NYT", "Not yet tested"]];
  const t = total || order.reduce((s, [k]) => s + (sc[k] || 0), 0) || 1;
  const seg = order
    .filter(([k]) => (sc[k] || 0) > 0)
    .map(([k]) => `<span class="sm-seg" style="width:${((sc[k] || 0) / t) * 100}%;background:${statusColor(k)}" title="${k} ${sc[k]}"></span>`)
    .join("");
  const legend = order
    .map(([k, lbl]) => `<span class="sm-leg"><span class="sm-dot" style="background:${statusColor(k)}"></span>${escapeHTML(lbl)} <b>${sc[k] || 0}</b></span>`)
    .join("");
  return `
    <div class="statusmix">
      <div class="sm-bar" role="img" aria-label="Status mix">${seg}</div>
      <div class="sm-legend">${legend}</div>
    </div>`;
}

export function credibilityHeroHTML(ledger) {
  const co = ledger.company || {};
  const cred = ledger.credibility || {};
  const agg = ledger.aggregates || {};
  const sc = agg.status_counts || {};
  const cov = ledger.coverage || {};
  const vw = ledger.verification_window || {};

  const score = cred.score;
  const grade = cred.grade || gradeFromScore(score) || "—";
  const ringColor = gradeColor(grade);
  const badge = provenanceBadge(ledger.provenance);
  const disclaimed = badge.disclaim;

  const meta = [
    cov.from && cov.to ? `Coverage ${escapeHTML(cov.from)}–${escapeHTML(cov.to)}` : null,
    vw.latest_reported ? `Latest reported ${escapeHTML(vw.latest_reported)}` : null,
    `${agg.testable ?? 0} testable of ${agg.total ?? 0}`,
    ledger.generated_at ? `Updated ${escapeHTML(fmtDate(ledger.generated_at))}` : null,
  ].filter(Boolean);

  return `
    <section class="hero-card card tone-${badge.tone}${disclaimed ? " is-disclaimed" : ""}" aria-label="Credibility summary">
      <div class="hero-top">
        <div class="hero-id">
          <span class="hero-eyebrow">Credibility score</span>
          <h1 class="hero-name">${escapeHTML(co.name || co.ticker || "—")}</h1>
          <span class="hero-sub">${escapeHTML(co.ticker || "")}${co.sector ? ` · ${escapeHTML(co.sector)}` : ""}</span>
        </div>
        <div class="prov-badge prov-${badge.tone}" title="${escapeHTML(badge.detail)}">
          <i data-lucide="${BADGE_ICON[badge.tone] || "circle-help"}" aria-hidden="true"></i>
          <span>${escapeHTML(badge.label)}</span>
        </div>
      </div>

      <div class="hero-body">
        <div class="ring-wrap">
          ${ringSVG(clampPct(score), ringColor)}
          <div class="ring-center">
            <span class="ring-grade" style="color:${ringColor}">${escapeHTML(grade)}</span>
            <span class="ring-score">${score ?? "—"}<small>/100</small></span>
          </div>
          ${disclaimed ? `<span class="ring-flag">indicative</span>` : ""}
        </div>

        <div class="hero-readout">
          ${cred.headline ? `<p class="hero-headline">${escapeHTML(cred.headline)}</p>` : ""}
          <div class="split">
            <div class="split-head">
              <span>Delivery vs. deadlines</span>
              <span class="split-insight">${escapeHTML(splitInsight(cred.delivery_score, cred.timeline_score))}</span>
            </div>
            <div class="split-bars">
              ${splitBar("Delivery (numbers)", cred.delivery_score, "No numeric targets testable yet")}
              ${splitBar("Timelines (deadlines)", cred.timeline_score, "No deadlines testable yet")}
            </div>
          </div>
        </div>
      </div>

      ${statusMix(sc, agg.total)}

      <div class="hero-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>

      ${disclaimed
        ? `<div class="hero-disclaimer"><i data-lucide="${BADGE_ICON[badge.tone]}" aria-hidden="true"></i><span><b>${escapeHTML(badge.label)}.</b> ${escapeHTML(badge.detail)}</span></div>`
        : badge.tone === "manual"
          ? `<div class="hero-note"><i data-lucide="pencil-ruler" aria-hidden="true"></i><span>${escapeHTML(badge.detail)}</span></div>`
          : ""}
    </section>`;
}
