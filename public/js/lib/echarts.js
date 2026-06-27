/**
 * echarts.js — lazy-load ECharts 5 from the CDN and register the dark theme from the
 * P1 tokens (ui.js#echartsTheme). Every chart goes through `mountChart`, which shows a
 * loading state, an empty state (when the builder returns null), or a graceful
 * "charts unavailable offline" note if the CDN is blocked — it never throws (consistent
 * with the Tailwind-config guard in the shell). Charts reflow on container resize.
 */
import { registerEchartsTheme } from "../ui.js";

const CDN = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";
const drawIcons = () => { if (window.lucide?.createIcons) window.lucide.createIcons(); };

let _promise = null;
/** Resolve window.echarts (already loaded, or injected on demand). Rejects if blocked. */
export function loadECharts() {
  if (_promise) return _promise;
  _promise = new Promise((resolve, reject) => {
    if (window.echarts) return resolve(window.echarts);
    const s = document.createElement("script");
    s.src = CDN;
    s.async = true;
    // don't let a hung/blocked CDN spin the chart forever — degrade after a timeout
    const timer = setTimeout(() => reject(new Error("echarts load timed out")), 8000);
    s.onload = () => { clearTimeout(timer); window.echarts ? resolve(window.echarts) : reject(new Error("echarts unavailable")); };
    s.onerror = () => { clearTimeout(timer); reject(new Error("echarts CDN blocked")); };
    document.head.appendChild(s);
  }).then((ec) => { registerEchartsTheme("lie"); return ec; });
  return _promise;
}

const active = new Set();
/** Dispose all live charts (call before re-rendering a view). */
export function disposeCharts() {
  for (const c of active) { try { c.dispose(); } catch { /* already gone */ } }
  active.clear();
}

const degradeHTML = (msg) => `<div class="chart-degrade"><i data-lucide="cloud-off" aria-hidden="true"></i><span>${msg}</span></div>`;

/**
 * Mount an ECharts instance into `el`.
 * @param {HTMLElement} el
 * @param {(echarts)=>object|null} buildOption  option object, or null/false → empty state
 * @param {{empty?:string, height?:string, ariaLabel?:string}} opts
 * @returns {Promise<object|null>} the chart instance, or null if empty/degraded
 */
export async function mountChart(el, buildOption, { empty = "No data to chart", height = "280px", ariaLabel = "chart" } = {}) {
  if (!el) return null;
  el.style.height = height;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", ariaLabel);
  el.innerHTML = `<div class="chart-loading"><span class="chart-spinner" aria-hidden="true"></span><span class="visually-hidden">Loading chart…</span></div>`;

  let ec;
  try {
    ec = await loadECharts();
  } catch {
    el.innerHTML = degradeHTML("Charts unavailable offline");
    drawIcons();
    return null;
  }

  let option;
  try {
    option = buildOption(ec);
  } catch (err) {
    console.error("chart build failed:", err);
    el.innerHTML = `<div class="chart-empty">Couldn't render this chart.</div>`;
    return null;
  }
  if (!option) {
    el.innerHTML = `<div class="chart-empty">${empty}</div>`;
    return null;
  }

  el.innerHTML = "";
  const chart = ec.init(el, "lie", { renderer: "canvas" });
  chart.setOption(option);
  active.add(chart);

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    chart.on("dispose", () => ro.disconnect());
  }
  return chart;
}
