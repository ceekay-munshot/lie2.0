/**
 * root-cause.js — horizontal bars of aggregates.root_causes (why promises missed),
 * largest at the top. Builder returns null when there are no root-causes (panel hidden
 * by the caller / empty state shown).
 */
import { tokens } from "../../ui.js";
import { mountChart } from "../../lib/echarts.js";

export function rootCause(el, ledger) {
  const rc = ledger.aggregates?.root_causes || {};
  return mountChart(el, () => {
    const entries = Object.entries(rc).filter(([, v]) => Number(v) > 0).sort((a, b) => a[1] - b[1]); // asc → largest on top
    if (!entries.length) return null;
    return {
      tooltip: { trigger: "item", formatter: "{b}: <b>{c}</b>" },
      grid: { left: 8, right: 28, top: 8, bottom: 8, containLabel: true },
      xAxis: { type: "value", minInterval: 1 },
      yAxis: { type: "category", data: entries.map((e) => e[0]), axisLabel: { color: tokens.dark.muted } },
      series: [{
        type: "bar", barWidth: "58%",
        itemStyle: { color: tokens.accent.red, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: tokens.dark.muted },
        data: entries.map((e) => e[1]),
      }],
    };
  }, { empty: "No root-causes recorded", height: "240px", ariaLabel: "Root causes of misses" });
}
