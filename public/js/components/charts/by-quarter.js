/**
 * by-quarter.js — stacked bars of promise status per quarter, from aggregates.by_quarter.
 * Quarters ordered by fiscal index; segments status-coloured.
 */
import { statusColor, tokens } from "../../ui.js";
import { mountChart } from "../../lib/echarts.js";
import { periodIndex } from "../../lib/fiscal.js";

const LABEL = { MET: "Met", PARTIAL: "Partial", MISSED: "Missed", NYT: "Not yet tested" };
const ORDER = ["MET", "PARTIAL", "MISSED", "NYT"];

export function byQuarter(el, ledger) {
  const bq = ledger.aggregates?.by_quarter || {};
  return mountChart(el, () => {
    const quarters = Object.keys(bq).sort((a, b) => (periodIndex(a) ?? 0) - (periodIndex(b) ?? 0));
    if (!quarters.length) return null;
    const series = ORDER.map((k) => ({
      name: LABEL[k], type: "bar", stack: "s", itemStyle: { color: statusColor(k) },
      emphasis: { focus: "series" }, data: quarters.map((q) => (bq[q]?.[k]) || 0),
    }));
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { bottom: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: tokens.dark.muted } },
      grid: { left: 8, right: 12, top: 14, bottom: 38, containLabel: true },
      xAxis: { type: "category", data: quarters },
      yAxis: { type: "value", minInterval: 1 },
      series,
    };
  }, { empty: "No per-quarter data", height: "290px", ariaLabel: "Promises by quarter" });
}
