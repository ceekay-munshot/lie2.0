/**
 * momentum.js — reported financial trend: EBITDA columns + EBITDA-margin line, with a
 * small stat trio (net debt/EBITDA, ROCE, latest revenue). Null-safe: renders only the
 * metrics present; the caller hides the whole panel when financial_trend is empty.
 */
import { tokens, fmtINRcr, fmtPct } from "../../ui.js";
import { mountChart } from "../../lib/echarts.js";
import { periodIndex } from "../../lib/fiscal.js";

const num = (v) => (v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null);
const latest = (arr, key) => {
  for (let i = arr.length - 1; i >= 0; i--) { const v = num(arr[i][key]); if (v != null) return { v, q: arr[i].quarter }; }
  return null;
};
const statHTML = (label, val, q) => (val == null ? "" :
  `<div class="mom-stat"><span class="mom-stat-val">${val}</span><span class="mom-stat-label">${label}${q ? ` · ${q}` : ""}</span></div>`);

export function momentum(el, ledger) {
  const ft = (ledger.financial_trend || []).filter((q) => q && q.quarter);
  if (!ft.length) { el.innerHTML = `<div class="chart-empty">No financial trend reported</div>`; return Promise.resolve(null); }
  const sorted = ft.slice().sort((a, b) => (periodIndex(a.quarter) ?? 0) - (periodIndex(b.quarter) ?? 0));

  const lev = latest(sorted, "net_debt_ebitda");
  const roce = latest(sorted, "roce");
  const rev = latest(sorted, "revenue");
  const stats = [
    lev ? statHTML("Net debt / EBITDA", `${lev.v.toFixed(2)}×`, lev.q) : "",
    roce ? statHTML("ROCE", fmtPct(roce.v), roce.q) : "",
    rev ? statHTML("Revenue", fmtINRcr(rev.v), rev.q) : "",
  ].filter(Boolean).join("");

  el.innerHTML = `${stats ? `<div class="mom-stats">${stats}</div>` : ""}<div class="mom-chart"></div>`;
  const chartEl = el.querySelector(".mom-chart");

  return mountChart(chartEl, () => {
    // only plot quarters that actually report a figure — a null quarter would leave a
    // confusing blank gap in the middle of the chart.
    const plot = sorted.filter((q) => num(q.ebitda) != null || num(q.ebitda_margin) != null);
    const quarters = plot.map((q) => q.quarter);
    const hasEbitda = plot.some((q) => num(q.ebitda) != null);
    const hasMargin = plot.some((q) => num(q.ebitda_margin) != null);
    if (!hasEbitda && !hasMargin) return null;
    const series = [];
    if (hasEbitda) series.push({
      name: "EBITDA", type: "bar", yAxisIndex: 0, barWidth: "42%",
      itemStyle: { color: tokens.accent.cyan, borderRadius: [4, 4, 0, 0] }, data: plot.map((q) => num(q.ebitda)),
    });
    if (hasMargin) series.push({
      name: "EBITDA margin", type: "line", yAxisIndex: 1, smooth: true, symbol: "circle", symbolSize: 7,
      lineStyle: { width: 3 }, itemStyle: { color: tokens.accent.gold }, connectNulls: true, data: plot.map((q) => num(q.ebitda_margin)),
    });
    return {
      tooltip: {
        trigger: "axis", axisPointer: { type: "cross" },
        formatter: (ps) => {
          const head = ps[0]?.axisValue ?? "";
          const lines = ps.map((p) => `${p.marker}${p.seriesName}: <b>${p.seriesName === "EBITDA margin" ? fmtPct(p.value) : fmtINRcr(p.value)}</b>`);
          return [head, ...lines].join("<br/>");
        },
      },
      legend: { bottom: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: tokens.ui.muted } },
      grid: { left: 10, right: 14, top: 34, bottom: 44, containLabel: true },
      xAxis: { type: "category", data: quarters, axisLabel: { interval: 0, rotate: quarters.length > 6 ? 30 : 0, fontSize: 10.5 } },
      yAxis: [
        { type: "value", name: "₹ cr", nameGap: 14, nameTextStyle: { fontSize: 10.5 }, axisLabel: { fontSize: 10.5, formatter: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v) } },
        { type: "value", name: "%", position: "right", nameGap: 14, nameTextStyle: { fontSize: 10.5 }, axisLabel: { fontSize: 10.5, formatter: "{value}%" }, splitLine: { show: false } },
      ],
      series,
    };
  }, { empty: "No EBITDA / margin reported", height: "250px", ariaLabel: "Financial momentum" });
}
