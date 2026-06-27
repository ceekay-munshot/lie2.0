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
      legend: { bottom: 0, icon: "circle", itemWidth: 9, itemHeight: 9, textStyle: { color: tokens.dark.muted } },
      title: {
        text: String(total), subtext: "promises", left: "50%", top: "40%", textAlign: "center",
        textStyle: { fontSize: 30, fontWeight: 800, color: tokens.dark.text },
        subtextStyle: { fontSize: 12, color: tokens.dark.muted },
      },
      series: [{
        type: "pie", radius: ["56%", "80%"], center: ["50%", "47%"], avoidLabelOverlap: true,
        itemStyle: { borderColor: tokens.dark.card, borderWidth: 2 },
        label: { show: false }, labelLine: { show: false }, data,
      }],
    };
  }, { empty: "No promises to chart", height: "290px", ariaLabel: "Promise status donut" });
}
