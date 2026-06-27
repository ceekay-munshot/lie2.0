/**
 * kpi-strip.js — a compact row of headline counts under the hero: Promises ·
 * Testable · MET · PARTIAL · MISSED · NYT (status-coloured) + the credibility
 * score/grade. Reads aggregates + credibility; renders to an HTML string.
 */
import { statusColor, gradeColor, gradeFromScore, escapeHTML } from "../ui.js";

export function kpiStripHTML(ledger) {
  const a = ledger.aggregates || {};
  const sc = a.status_counts || {};
  const c = ledger.credibility || {};
  const grade = c.grade || gradeFromScore(c.score) || "—";

  const chips = [
    { label: "Promises", value: a.total ?? 0, color: "var(--text)" },
    { label: "Testable", value: a.testable ?? 0, color: "var(--accent-cyan)" },
    { label: "Met", value: sc.MET ?? 0, color: statusColor("MET") },
    { label: "Partial", value: sc.PARTIAL ?? 0, color: statusColor("PARTIAL") },
    { label: "Missed", value: sc.MISSED ?? 0, color: statusColor("MISSED") },
    { label: "Not yet tested", value: sc.NYT ?? 0, color: statusColor("NYT") },
  ];

  return `
    <div class="kpi-strip" role="list" aria-label="Promise tally">
      ${chips
        .map(
          (k) => `
        <div class="kpi" role="listitem">
          <span class="kpi-val" style="color:${k.color}">${escapeHTML(k.value)}</span>
          <span class="kpi-label">${escapeHTML(k.label)}</span>
        </div>`,
        )
        .join("")}
      <div class="kpi kpi-cred" role="listitem">
        <span class="kpi-val" style="color:${gradeColor(grade)}">${c.score ?? "—"}<span class="kpi-grade">${escapeHTML(grade)}</span></span>
        <span class="kpi-label">Credibility</span>
      </div>
    </div>`;
}
