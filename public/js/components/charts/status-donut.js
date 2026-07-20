/**
 * status-donut.js — MET/PARTIAL/MISSED/NYT ring from aggregates.status_counts, with the
 * total promise count in the centre. Status-coloured; tooltip with count + %.
 */
import { statusColor, tokens } from "../../ui.js";
import { mountChart } from "../../lib/echarts.js";

const LABEL = { MET: "Met", PARTIAL: "Partial", MISSED: "Missed", NYT: "Not yet tested" };
const ORDER = ["MET", "PARTIAL", "MISSED", "NYT"];

export function statusDonut(el, ledger) {
  const sc = ledger.aggregates?.status_counts || {};
  return mountChart(el, () => {
    const total = ORDER.reduce((s, k) => s + (sc[k] || 0), 0);
    if (!total) return null;
    const data = ORDER.filter((k) => (sc[k] || 0) > 0).map((k) => ({
      value: sc[k], name: LABEL[k], itemStyle: { color: statusColor(k) },
    }));
    return {
      tooltip: { trigger: "item", formatter: "{b}<br/><b>{c}</b> ({d}%)" },
      legend: { bottom: 2, icon: "circle", itemWidth: 9, itemHeight: 9, textStyle: { color: tokens.ui.muted, fontSize: 11.5 } },
      title: {
        text: String(total), subtext: "promises", left: "50%", top: "42%", textAlign: "center",
        textStyle: { fontSize: 28, fontWeight: 800, color: tokens.ui.text },
        subtextStyle: { fontSize: 11.5, color: tokens.ui.muted },
      },
      series: [{
        type: "pie", radius: ["54%", "78%"], center: ["50%", "46%"], avoidLabelOverlap: true,
        itemStyle: { borderColor: tokens.ui.card, borderWidth: 3, borderRadius: 4 },
        label: { show: false }, labelLine: { show: false },
        emphasis: { scaleSize: 6, itemStyle: { shadowBlur: 10, shadowColor: "rgba(16,24,40,0.18)" } },
        data,
      }],
    };
  }, { empty: "No promises to chart", height: "300px", ariaLabel: "Promise status donut" });
}
