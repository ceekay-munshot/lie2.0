/**
 * slippage-timeline.js — THE signature chart. For every timeline promise, a floating
 * bar from the PROMISED quarter (amber dot) to the RE-SET / actual quarter (red dot),
 * coloured by status — the visual that sells the product ("promised → re-set"). Promised
 * is parsed from the commitment text (metric/target.text), revised from the retrieved
 * actual's wording (e.g. "re-set to 1HFY27"). Empty state when nothing slipped. Generic.
 */
import { statusColor, tokens } from "../../ui.js";
import { mountChart } from "../../lib/echarts.js";
import { periodIndex, maxPeriodIndex, quarterLabel } from "../../lib/fiscal.js";

const AMBER = tokens.accent.gold; // promised
const RED = tokens.status.MISSED; // re-set / actual

/** One row per timeline promise that has an outcome (a slip, or an on-time delivery). */
function rowsFrom(ledger) {
  const out = [];
  for (const p of ledger.promises || []) {
    if (p.category !== "timeline") continue;
    const promised = maxPeriodIndex([p.target?.text, p.metric, p.promise].filter(Boolean).join(" ")) ?? periodIndex(p.test_date);
    if (promised == null) continue;
    const revised = maxPeriodIndex(p.actual?.what_happened || p.actual?.text || "") ?? promised;
    const row = { label: p.promise || p.metric || p.id, promised, revised, slip: revised - promised, status: p.status || "NYT" };
    if (row.slip !== 0 || row.status === "MET") out.push(row); // skip not-yet-due timelines with no outcome
  }
  return out;
}

export function slippageTimeline(el, ledger) {
  return mountChart(el, () => {
    const rows = rowsFrom(ledger);
    if (!rows.some((r) => r.slip > 0)) return null; // → "no slipped timelines" empty state
    rows.sort((a, b) => a.slip - b.slip || a.promised - b.promised); // biggest slip last → top of the y-axis
    const cats = rows.map((r) => r.label);
    const all = rows.flatMap((r) => [r.promised, r.revised]);
    const min = Math.min(...all), max = Math.max(...all);

    return {
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const r = rows[p.dataIndex];
          if (!r) return "";
          const when = r.slip > 0
            ? `Re-set to ${quarterLabel(r.revised)}<br/><b>Slipped ${r.slip} qtr${r.slip > 1 ? "s" : ""}</b>`
            : r.slip < 0 ? `Delivered early (${quarterLabel(r.revised)})` : "Delivered on the promised quarter";
          return `<b>${r.label}</b><br/>Promised: ${quarterLabel(r.promised)}<br/>${when}<br/>Status: ${r.status}`;
        },
      },
      legend: { top: 0, right: 0, data: ["Promised", "Re-set / actual"], icon: "circle", itemWidth: 9, itemHeight: 9, textStyle: { color: tokens.dark.muted } },
      grid: { left: 10, right: 18, top: 32, bottom: 22, containLabel: true },
      xAxis: { type: "value", min: min - 0.6, max: max + 0.6, interval: 1, axisLabel: { formatter: (v) => quarterLabel(v) } },
      yAxis: { type: "category", data: cats, axisLabel: { width: 160, overflow: "truncate", color: tokens.dark.muted } },
      series: [
        // transparent offset places the coloured span between promised and revised
        { name: "_offset", type: "bar", stack: "slip", silent: true, tooltip: { show: false }, itemStyle: { color: "transparent" }, barWidth: "46%", data: rows.map((r) => Math.min(r.promised, r.revised)) },
        { name: "_span", type: "bar", stack: "slip", barWidth: "46%", data: rows.map((r) => ({ value: Math.abs(r.revised - r.promised), itemStyle: { color: statusColor(r.status), borderRadius: 5 } })) },
        { name: "Promised", type: "scatter", symbol: "circle", symbolSize: 12, z: 6, itemStyle: { color: AMBER, borderColor: tokens.dark.card, borderWidth: 1.5 }, data: rows.map((r, i) => [r.promised, i]) },
        { name: "Re-set / actual", type: "scatter", symbol: "circle", symbolSize: 12, z: 7, itemStyle: { color: RED, borderColor: tokens.dark.card, borderWidth: 1.5 }, data: rows.map((r, i) => [r.revised, i]) },
      ],
    };
  }, { empty: "No slipped timelines — deadlines held", height: "340px", ariaLabel: "Slippage timeline: promised vs re-set" });
}
