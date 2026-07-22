/**
 * credibility-signals.js — the "where credibility actually shows" panel. Surfaces the
 * promise-analysis signals (aggregates.signals + per-promise tier/dropped): the materiality
 * TIER MIX the score rests on, QUIET DROPS (the strongest red flag), SANDBAGGING, and miss
 * ATTRIBUTION (owned vs external). Null-safe — renders nothing if no signals are present.
 */
import { escapeHTML, tokens } from "../ui.js";

const TIER_META = {
  1: { label: "Tier 1 · binary outcomes", color: tokens.accent.teal, hint: "commissioning · capex · deleverage — hardest to fudge" },
  2: { label: "Tier 2 · financial guidance", color: tokens.accent.cyan, hint: "revenue · margin · volume · orderbook" },
  3: { label: "Tier 3 · soft / medium-term", color: tokens.status.NYT, hint: "aspirational or undated" },
};

function tierMixBar(mix) {
  const total = (mix[1] || 0) + (mix[2] || 0) + (mix[3] || 0);
  if (!total) return "";
  const seg = (t) => {
    const n = mix[t] || 0; if (!n) return "";
    const pct = (n / total) * 100;
    return `<span class="sig-seg" style="width:${pct}%;background:${TIER_META[t].color}" title="${TIER_META[t].label}: ${n}"></span>`;
  };
  const legend = [1, 2, 3].filter((t) => mix[t]).map((t) =>
    `<span class="sig-key"><i style="background:${TIER_META[t].color}"></i>${TIER_META[t].label.split(" · ")[0]} <b>${mix[t]}</b></span>`).join("");
  const t1pct = Math.round(((mix[1] || 0) / total) * 100);
  return `
    <div class="sig-card">
      <div class="sig-card-h"><i data-lucide="layers" aria-hidden="true"></i> What the score rests on</div>
      <div class="sig-bar">${seg(1)}${seg(2)}${seg(3)}</div>
      <div class="sig-keys">${legend}</div>
      <p class="sig-note">${t1pct}% of the verdict rests on <b>hard Tier-1 outcomes</b> — the kind a company can't talk its way around.</p>
    </div>`;
}

function droppedCard(promises) {
  const dropped = (promises || []).filter((p) => p.dropped);
  if (!dropped.length) return "";
  const items = dropped.slice(0, 6).map((p) =>
    `<li><span class="sig-flag">⚠ dropped</span> ${escapeHTML(p.promise || p.metric || p.id)}${p.quarter_context ? ` <span class="sig-q">${escapeHTML(p.quarter_context)}</span>` : ""}</li>`).join("");
  const more = dropped.length > 6 ? `<li class="sig-more">+${dropped.length - 6} more</li>` : "";
  return `
    <div class="sig-card sig-danger">
      <div class="sig-card-h"><i data-lucide="triangle-alert" aria-hidden="true"></i> Quietly dropped <b>${dropped.length}</b></div>
      <p class="sig-note">Targets management <b>reaffirmed, then went silent on</b> once they came due — the single strongest credibility red flag.</p>
      <ul class="sig-list">${items}${more}</ul>
    </div>`;
}

function sandbagCard(sb) {
  if (!sb) return "";
  return `
    <div class="sig-card">
      <div class="sig-card-h"><i data-lucide="shield-half" aria-hidden="true"></i> Possible sandbagging</div>
      <p class="sig-note">Beat guidance by a wide margin on <b>${sb.wide_beats} of ${sb.of_guided}</b> scoreable metrics — chronic wide beats usually mean a <b>conservative bar</b>, not out-performance.</p>
    </div>`;
}

function attributionCard(at) {
  if (!at || (at.owned + at.external) === 0) return "";
  const total = at.owned + at.external;
  const extPct = Math.round((at.external / total) * 100);
  const ownW = (at.owned / total) * 100;
  return `
    <div class="sig-card">
      <div class="sig-card-h"><i data-lucide="scale" aria-hidden="true"></i> Who gets the blame</div>
      <div class="sig-bar"><span class="sig-seg" style="width:${ownW}%;background:${tokens.accent.teal}"></span><span class="sig-seg" style="width:${100 - ownW}%;background:${tokens.accent.gold}"></span></div>
      <div class="sig-keys"><span class="sig-key"><i style="background:${tokens.accent.teal}"></i>Owned <b>${at.owned}</b></span><span class="sig-key"><i style="background:${tokens.accent.gold}"></i>External <b>${at.external}</b></span></div>
      <p class="sig-note">${extPct}% of explained misses are blamed on <b>external factors</b>${extPct >= 70 ? " — a repeated external-only tell." : "."}</p>
    </div>`;
}

export function credibilitySignalsHTML(ledger) {
  const sig = ledger?.aggregates?.signals;
  const promises = ledger?.promises || [];
  if (!sig) return "";
  const cards = [tierMixBar(sig.tier_mix || {}), droppedCard(promises), sandbagCard(sig.sandbagging), attributionCard(sig.attribution)].filter(Boolean);
  if (!cards.length) return "";
  return `
    <section id="signals" class="signals-section" aria-label="Credibility signals">
      <div class="section-head">
        <div class="section-title"><i data-lucide="radar" aria-hidden="true"></i><h2>Credibility signals</h2></div>
        <span class="section-count">where the record actually shows</span>
      </div>
      <div class="signals-grid">${cards.join("")}</div>
    </section>`;
}
