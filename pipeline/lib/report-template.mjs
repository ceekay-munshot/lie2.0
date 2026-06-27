/**
 * report-template.mjs — ledger → a self-contained, multi-page A4-landscape HTML report
 * (no external assets/CDN, print-color-adjust:exact, inline-SVG charts). A Node port of
 * the approved Python reference, parametrized entirely from public/data/companies/<ticker>.json
 * — NO company/ticker/sector/number is hardcoded. Null-safe (a panel hides when its data
 * is absent). The provenance honesty rule is enforced here: a mock/incomplete ledger gets a
 * diagonal watermark + cover banner so a shareable PDF can never pass as a real verdict.
 *
 *   import { reportHTML } from "./lib/report-template.mjs";
 *   const html = reportHTML(ledger);
 */
import { maxPeriodIndex, periodIndex, quarterLabel } from "./fiscal.mjs";

/* ---------- palette (mirrors ui.js tokens + the reference) ---------- */
const T = {
  INK: "#0A0E1A", INK2: "#0F1626", CARD: "#161F33", CARD2: "#1B2740", LINE: "#27324d",
  MUT: "#93A4C7", TXT: "#E8EEF9", MET: "#22C55E", PARTIAL: "#F59E0B", MISSED: "#FB3B53",
  NYT: "#7C8BB0", RED: "#FF4D5E", GOLD: "#FFB020", VIOLET: "#8B7BFF", TEAL: "#2DD4BF", CYAN: "#38BDF8",
};
const STC = { MET: T.MET, PARTIAL: T.PARTIAL, MISSED: T.MISSED, NYT: T.NYT };
const ORDER = ["MET", "PARTIAL", "MISSED", "NYT"];
const STATUS_LEG = { MET: "Met / delivered", PARTIAL: "Partial", MISSED: "Missed", NYT: "Not yet testable" };
const gradeColor = (g) => ({ A: T.MET, B: T.TEAL, C: T.GOLD, D: T.MISSED, E: T.RED }[String(g || "").toUpperCase()] || T.NYT);

/* ---------- small utils ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null);
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const fmtINRcr = (n) => (n == null ? "—" : `₹${Number(n).toLocaleString("en-IN")} cr`);
// financial_trend carries a per-row unit; don't assume ₹ crore. Label + format from the ledger's unit.
const isCrUnit = (u) => { const s = String(u || "").toLowerCase().replace(/[^a-z]/g, ""); return s === "" || s === "cr" || s === "crore" || s === "crores" || s === "inrcr" || s === "inrcrore"; };
const trendUnitLabel = (ft) => { const u = (ft.find((q) => q && q.unit)?.unit) || ""; return isCrUnit(u) ? "₹ cr" : String(u).replace(/_/g, " "); };
const fmtTrendVal = (v, label) => (v == null ? "—" : label === "₹ cr" ? fmtINRcr(v) : `${Number(v).toLocaleString("en-IN")} ${label}`);
const DOC_TYPE = { transcript: "Call", presentation: "Presn", press_release: "PR", annual_report: "AR", other: "Doc" };
const shortQ = (q) => String(q || "").replace(/\s*FY\s*\d+/i, "").trim() || q;

/* ---------- SVG charts (ported from the reference) ---------- */
function donut(segs, size = 230, th = 40) {
  const total = segs.reduce((s, x) => s + x[1], 0) || 1;
  const r = (size - th) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let off = 0, arcs = "";
  for (const [, v, c] of segs) {
    if (!v) continue;
    const dash = (v / total) * C;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="${th}" stroke-dasharray="${dash.toFixed(3)} ${(C - dash).toFixed(3)}" stroke-dashoffset="${(-off).toFixed(3)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += dash;
  }
  return `<svg viewBox="0 0 ${size} ${size}" class="donut">${arcs}<text x="${cx}" y="${cy - 2}" class="dn-num">${total}</text><text x="${cx}" y="${cy + 20}" class="dn-lab">COMMITMENTS</text></svg>`;
}

function vbars(groups, w = 300, h = 190) {
  const totals = groups.map(([, c]) => ORDER.reduce((s, k) => s + (c[k] || 0), 0));
  const maxTotal = Math.max(1, ...totals);
  const step = Math.max(1, Math.ceil(maxTotal / 3));
  const maxv = step * 3;
  const pad = 28, gw = (w - pad) / groups.length, bw = gw * 0.52, base = h - 26, top = 10;
  const s = [`<svg viewBox="0 0 ${w} ${h}" class="vb">`];
  for (const gv of [step, step * 2, step * 3]) {
    const y = base - (gv / maxv) * (base - top);
    s.push(`<line x1="${pad}" y1="${y}" x2="${w}" y2="${y}" stroke="${T.LINE}" stroke-width="1"/>`);
    s.push(`<text x="${pad - 6}" y="${y + 3}" class="vb-ax">${gv}</text>`);
  }
  groups.forEach(([lab, cnt], i) => {
    let x = pad + gw * i + (gw - bw) / 2, y = base;
    for (const st of ORDER) {
      const v = cnt[st] || 0; if (!v) continue;
      const bh = (v / maxv) * (base - top); y -= bh;
      s.push(`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${STC[st]}" rx="2"/>`);
    }
    s.push(`<text x="${x + bw / 2}" y="${base + 16}" class="vb-lab">${esc(shortQ(lab))}</text>`);
  });
  s.push("</svg>");
  return s.join("");
}

function hbars(items, w = 300, rh = 30) {
  const maxv = Math.max(1, ...items.map(([, v]) => v));
  const lw = 132, bw = w - lw - 30, h = rh * items.length + 8;
  const s = [`<svg viewBox="0 0 ${w} ${h}" class="hb">`];
  items.forEach(([lab, v, c], i) => {
    const y = 8 + i * rh, fw = Math.max(8, (bw * v) / maxv);
    s.push(`<text x="0" y="${y + rh * 0.45}" class="hb-lab">${esc(lab)}</text>`);
    s.push(`<rect x="${lw}" y="${y}" width="${bw}" height="${rh * 0.58}" rx="6" fill="#1b2740"/>`);
    s.push(`<rect x="${lw}" y="${y}" width="${fw}" height="${rh * 0.58}" rx="6" fill="${c}"/>`);
    s.push(`<text x="${lw + fw + 9}" y="${y + rh * 0.45}" class="hb-val">${v}</text>`);
  });
  s.push("</svg>");
  return s.join("");
}

function gantt(rows, qs, w = 580, rh = 34) {
  const lw = 188, right = 14, plot = w - lw - right, n = qs.length || 1, cw = plot / n;
  const h = rh * rows.length + 42;
  // truncate names to what the label gutter actually fits (≈6.4px/char at 11px semibold,
  // leaving a 12px gap before the first quarter line) so a long name never bleeds into the plot.
  const maxChars = Math.max(8, Math.floor((lw - 12) / 6.4));
  const s = [`<svg viewBox="0 0 ${w} ${h}" class="gt">`];
  qs.forEach((q, j) => {
    const x = lw + cw * j;
    s.push(`<line x1="${x}" y1="22" x2="${x}" y2="${h - 12}" stroke="${T.LINE}" stroke-width="1"/>`);
    s.push(`<text x="${x + cw / 2}" y="14" class="gt-q">${esc(q)}</text>`);
  });
  rows.forEach((r, i) => {
    const y = 30 + i * rh;
    const nm = r.name.length > maxChars ? `${r.name.slice(0, maxChars - 1)}…` : r.name;
    s.push(`<text x="0" y="${y + rh * 0.5}" class="gt-name">${esc(nm)}</text>`);
    const px = lw + cw * r.prom + cw / 2, rx = lw + cw * r.rev + cw / 2, cy = y + rh * 0.45;
    s.push(`<line x1="${px}" y1="${cy}" x2="${rx}" y2="${cy}" stroke="#3a4a6b" stroke-width="3" stroke-dasharray="2 4"/>`);
    s.push(`<circle cx="${px}" cy="${cy}" r="7" fill="${T.GOLD}" stroke="${T.INK}" stroke-width="2"/>`);
    s.push(`<circle cx="${rx}" cy="${cy}" r="7" fill="${STC[r.status] || T.MISSED}" stroke="${T.INK}" stroke-width="2"/>`);
    if (r.note) {
      // flip the note to the left of the marker when placing it right would overflow the plot
      const noteW = r.note.length * 5.4;
      if (rx + 12 + noteW > w - 2) s.push(`<text x="${px - 12}" y="${cy + 4}" class="gt-note" text-anchor="end">${esc(r.note)}</text>`);
      else s.push(`<text x="${rx + 12}" y="${cy + 4}" class="gt-note">${esc(r.note)}</text>`);
    }
  });
  s.push("</svg>");
  return s.join("");
}

function momentumChart(ft, w = 360, h = 170) {
  // keep any quarter that reports EITHER absolute EBITDA or a margin (the schema allows
  // ebitda:null) — a margin-only ledger still renders its line series instead of an empty page.
  const vals = ft.map((q) => [q.quarter, num(q.ebitda), num(q.ebitda_margin)]).filter((x) => x[1] != null || x[2] != null);
  if (!vals.length) return "";
  // guard against all-zero (NaN) and loss-making/negative EBITDA (negative bar heights):
  // scale off the largest non-negative value (floored to 1) and clamp every bar at ≥0.
  const maxv = Math.max(1, ...vals.map((x) => Math.max(0, x[1] ?? 0))) * 1.12;
  const pad = 30, gw = (w - pad - 12) / vals.length, bw = gw * 0.46, base = h - 24, top = 14;
  const s = [`<svg viewBox="0 0 ${w} ${h}" class="eb">`];
  const pts = [];
  vals.forEach(([lab, v, m], i) => {
    const x = pad + gw * i + (gw - bw) / 2;
    if (v != null) { // a bar only when this quarter reports an absolute EBITDA
      const bh = Math.max(0, (v / maxv) * (base - top)), y = base - bh;
      s.push(`<defs><linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.GOLD}"/><stop offset="1" stop-color="${T.RED}"/></linearGradient></defs>`);
      s.push(`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="4" fill="url(#g${i})"/>`);
      s.push(`<text x="${x + bw / 2}" y="${y - 6}" class="eb-v">${v.toLocaleString("en-IN")}</text>`);
    }
    s.push(`<text x="${x + bw / 2}" y="${base + 16}" class="eb-x">${esc(shortQ(lab))}</text>`);
    if (m != null) pts.push([x + bw / 2, base - (m / 50) * (base - top), m]);
  });
  if (pts.length > 1) s.push(`<polyline points="${pts.map((p) => `${p[0]},${p[1]}`).join(" ")}" fill="none" stroke="${T.TEAL}" stroke-width="2.5"/>`);
  for (const [x, y, m] of pts) {
    s.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${T.TEAL}"/>`);
    s.push(`<text x="${x}" y="${y - 8}" class="eb-m">${m}%</text>`);
  }
  s.push("</svg>");
  return s.join("");
}

/* ---------- provenance honesty ---------- */
function provInfo(prov) {
  const p = prov && typeof prov === "object" ? prov : null;
  if (!p || !p.mode) return { tone: "unknown", label: "Unverified" };
  if (p.mode === "mock") return { tone: "mock", label: "Mock data — not a real verdict", watermark: { text: "MOCK — NOT A REAL VERDICT", color: T.MISSED }, banner: "Generated from MOCK data ($0 offline run) — the figures are illustrative only, NOT a real verdict." };
  if (p.mode === "manual") return { tone: "manual", label: "Curated", note: "Hand-verified reference ledger." };
  if (p.complete) { const m = (Array.isArray(p.models_used) ? p.models_used : []).filter((x) => x && x !== "mock"); return { tone: "live", label: "Live · complete", note: m.length ? `Full retrieval · ${m.join(", ")}.` : "Full live retrieval." }; }
  const forced = Number(p.forced_nyt || 0), errs = Number(p.retrieval_errors || 0);
  const bits = [forced ? `${forced} forced-NYT` : "", errs ? `${errs} retrieval error${errs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  return { tone: "provisional", label: "Provisional — incomplete retrieval", watermark: { text: `PROVISIONAL — INCOMPLETE RETRIEVAL${forced ? ` (${forced} FORCED-NYT)` : ""}`, color: T.GOLD }, banner: `PROVISIONAL — retrieval did not complete${bits ? ` (${bits})` : ""}. Treat the score as indicative, not a final verdict.` };
}
const watermarkHTML = (info) => (info.watermark ? `<div class="wmark" style="--wc:${info.watermark.color}"><span>${esc(info.watermark.text)}</span></div>` : "");
// The master table auto-paginates (one flowing block, not discrete .slide pages), so it can't carry a
// per-page .wmark. Tile a diagonal warning as a repeating background instead, so EVERY printed table page
// still shows the mock/provisional provenance overlay — a downloaded PDF can't be split free of it.
function tableWatermark(info) {
  const wm = info && info.watermark;
  if (!wm) return "";
  // opacity is high enough to read through the dense table cells (zebra rows are near-opaque),
  // so no table page can be extracted free of the mock/provisional warning.
  const txt = esc(wm.text);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='250'><text x='180' y='125' transform='rotate(-25 180 125)' text-anchor='middle' font-family='Inter,Arial,sans-serif' font-size='25' font-weight='800' fill='${wm.color}' fill-opacity='0.22'>${txt}</text></svg>`;
  // base64 (not percent-encoding): the SVG's rotate(...) parens and quotes would otherwise
  // terminate an unquoted CSS url() early, so the watermark would silently fail to load.
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return `background-image:url(${uri});background-repeat:repeat;`;
}

/* ---------- the report ---------- */
export function reportHTML(ledger) {
  const co = ledger.company || {};
  const name = (co.name || co.ticker || "Company").toString();
  const ticker = (co.ticker || name).toString().toUpperCase();
  const agg = ledger.aggregates || {};
  const sc = agg.status_counts || {};
  const total = agg.total ?? (ledger.promises || []).length;
  const testableN = agg.testable ?? ((sc.MET || 0) + (sc.PARTIAL || 0) + (sc.MISSED || 0));
  const cred = ledger.credibility || {};
  const grade = cred.grade || "—";
  const cov = ledger.coverage || {};
  const vw = ledger.verification_window || {};
  const docs = (ledger.documents || []).filter((d) => d && d.quarter).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const promises = ledger.promises || [];
  const ft = (ledger.financial_trend || []).filter((q) => q && q.quarter).sort((a, b) => (periodIndex(a.quarter) ?? 0) - (periodIndex(b.quarter) ?? 0));
  const tlc = agg.timeline_commitments || {};
  const info = provInfo(ledger.provenance);
  const footId = `${ticker} · LIE DETECTOR`;
  let pageNo = 0;
  const foot = () => { pageNo += 1; return `<div class="pgnum">${esc(footId)}</div><div class="watermark">${String(pageNo).padStart(2, "0")}</div>`; };

  /* derived chart inputs */
  const donutSegs = ORDER.map((k) => [STATUS_LEG[k], sc[k] || 0, STC[k]]);
  const byQuarter = Object.keys(agg.by_quarter || {}).length
    ? Object.entries(agg.by_quarter).sort((a, b) => (periodIndex(a[0]) ?? 0) - (periodIndex(b[0]) ?? 0))
    : [];
  const rootItems = Object.entries(agg.root_causes || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([k, v], i) => [k, v, [T.RED, T.GOLD, T.VIOLET, T.CYAN, T.TEAL][i % 5]]);
  const confMix = agg.confidence_mix || {};
  const confItems = [["H — hard numeric", confMix.H || 0, T.RED], ["M — directional", confMix.M || 0, T.GOLD], ["L — aspirational", confMix.L || 0, T.NYT]].filter((x) => x[1] > 0);

  /* timeline → gantt rows on a shared quarter axis */
  const tlRaw = [];
  for (const p of promises) {
    if (p.category !== "timeline") continue;
    const prom = maxPeriodIndex([p.target?.text, p.metric, p.promise].filter(Boolean).join(" ")) ?? periodIndex(p.test_date);
    if (prom == null) continue;
    const rev = maxPeriodIndex(p.actual?.what_happened || p.actual?.text || "") ?? prom;
    if (rev === prom && p.status !== "MET") continue;
    tlRaw.push({ name: p.promise || p.metric || p.id, prom, rev, status: p.status || "NYT" });
  }
  const slipped = tlRaw.filter((r) => r.rev > r.prom);
  let ganttSVG = "", ganttQs = [];
  if (slipped.length) {
    tlRaw.sort((a, b) => (a.rev - a.prom) - (b.rev - b.prom) || a.prom - b.prom);
    const idxs = tlRaw.flatMap((r) => [r.prom, r.rev]);
    const minI = Math.min(...idxs), maxI = Math.max(...idxs);
    ganttQs = []; for (let i = minI; i <= maxI; i++) ganttQs.push(quarterLabel(i));
    const rows = tlRaw.map((r) => ({ name: r.name, status: r.status, prom: r.prom - minI, rev: r.rev - minI, note: r.rev > r.prom ? `${quarterLabel(r.prom)} → ${quarterLabel(r.rev)}` : "on time" }));
    ganttSVG = gantt(rows, ganttQs);
  }

  /* track-record cards: testable, worst-first, paginated 6/page (no clipping) */
  const SEV = { MISSED: 0, PARTIAL: 1, MET: 2 };
  const testable = promises.filter((p) => p.status && p.status !== "NYT").sort((a, b) => (SEV[a.status] ?? 9) - (SEV[b.status] ?? 9));
  const cardPages = chunk(testable, 6);

  /* ---------- assemble ---------- */
  const H = [];
  H.push(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS(info)}</style></head><body>`);

  /* PAGE 1 — COVER */
  const splitBar = (label, v) => {
    const has = v != null && !Number.isNaN(Number(v));
    const pct = Math.max(0, Math.min(100, Number(v) || 0));
    return `<div class="sp-row"><span class="sp-l">${label}</span><div class="sp-tr"><span style="width:${has ? pct : 0}%;background:${has ? gradeColor(gradeFromScore(v)) : T.NYT}"></span></div><b>${has ? Math.round(v) : "—"}</b></div>`;
  };
  const badges = docs.slice(0, 8).map((d) => `<span class="bdg">${esc(d.quarter)} ${esc(DOC_TYPE[d.type] || "Doc")} · ${esc(d.date)}</span>`).join("");
  H.push(`<div class="slide">${watermarkHTML(info)}<div class="bg"></div><div class="grid"></div>
    <div class="pad">
      <div class="kicker"><span class="dot"></span> Management Guidance &nbsp;·&nbsp; Promise vs Delivery</div>
      <div class="bar" style="margin-top:14px"></div>
      <h1>${esc(name.toUpperCase())}<br><span class="grad">Lie Detector</span></h1>
      <div class="sub">Every <b>measurable</b> management commitment${co.sector ? ` for this ${esc(co.sector)} company` : ""} — extracted from the earnings calls and investor decks, then verified against reported actuals${cov.from && cov.to ? ` across <b>${esc(cov.from)}–${esc(cov.to)}</b>` : ""}.</div>
      <div class="cover-cred">
        <div class="cc-ring" style="--gc:${gradeColor(grade)};--p:${num(cred.score) ?? 0}"><div class="cc-grade">${esc(grade)}</div><div class="cc-score">${cred.score ?? "—"}<small>/100</small></div></div>
        <div class="cc-split"><div class="cc-split-h">Delivery vs. deadlines</div>${splitBar("Delivery", cred.delivery_score)}${splitBar("Timelines", cred.timeline_score)}</div>
        <div class="cc-prov prov-${info.tone}">${esc(info.label)}</div>
      </div>
    </div>
    <div class="hero-kpis">
      <div class="hk"><div class="n" style="color:${T.GOLD}">${total}</div><div class="l">Measurable commitments tracked</div></div>
      <div class="hk"><div class="n" style="color:${T.TXT}">${testableN}</div><div class="l">Testable now · ${(sc.MET || 0) + (sc.PARTIAL || 0)} delivered / partial</div></div>
      <div class="hk"><div class="n" style="color:${T.MISSED}">${sc.MISSED || 0}</div><div class="l">Missed — incl. slipped deadlines</div></div>
      <div class="hk"><div class="n" style="color:${T.NYT}">${sc.NYT || 0}</div><div class="l">Not yet testable (later periods)</div></div>
    </div>
    <div class="foot">
      <div class="badges">${badges}</div>
      <div>${vw.latest_reported ? `Verification window: through ${esc(vw.latest_reported)}${vw.latest_reported_date ? ` (reported ${esc(vw.latest_reported_date)})` : ""}` : "Verified against the supplied disclosures"}</div>
    </div></div>`);

  if (info.banner) {
    // a cover banner is layered into the cover via the watermark; add an explicit banner strip too
    H[H.length - 1] = H[H.length - 1].replace('<div class="pad">', `<div class="prov-banner prov-${info.tone}">${esc(info.banner)}</div><div class="pad">`);
  }

  /* PAGE 2 — EXECUTIVE DASHBOARD */
  const leg = ORDER.map((s) => `<div class="lg"><span class="sw" style="background:${STC[s]}"></span>${STATUS_LEG[s]}<b>${sc[s] || 0}</b></div>`).join("");
  H.push(`<div class="slide">${watermarkHTML(info)}<div class="pad">
    <div class="sec-h"><span class="ix">01</span><h2>Executive Dashboard</h2><span class="tl"></span></div>
    ${cred.headline ? `<div class="lead">${esc(cred.headline)}</div>` : ""}
    <div class="row2">
      <div class="panel" style="width:300px"><h3>Status of all ${total} commitments</h3><div style="display:flex;align-items:center;gap:14px">${donut(donutSegs)}<div class="legend" style="flex:1">${leg}</div></div></div>
      ${byQuarter.length ? `<div class="panel" style="flex:1"><h3>Commitments by reporting quarter</h3>${vbars(byQuarter)}</div>` : ""}
      ${rootItems.length ? `<div class="panel" style="width:300px"><h3>Root cause of misses &amp; shortfalls</h3>${hbars(rootItems)}</div>` : ""}
    </div>
    <div class="row2" style="margin-top:16px">
      <div class="callout" style="flex:1.2"><div class="big">${esc(cred.headline || `${testableN} of ${total} promises are testable so far.`)}</div>
        ${tlc.due ? `<p>Of the ${tlc.due} dated commitment${tlc.due === 1 ? "" : "s"} that came due, ${tlc.on_time || 0} landed on time and ${tlc.slipped || 0} slipped right. The slippage timeline is overleaf.</p>` : ""}</div>
      ${confItems.length ? `<div class="panel" style="flex:1"><h3>Confidence mix of the promises</h3>${hbars(confItems)}</div>` : ""}
    </div>
    ${foot()}</div></div>`);

  /* PAGE 3 — SLIPPAGE + MOMENTUM (only if there's something to show) */
  const momoSVG = momentumChart(ft);
  if (ganttSVG || momoSVG) {
    const latest = (key) => { for (let i = ft.length - 1; i >= 0; i--) { const v = num(ft[i][key]); if (v != null) return { v, q: ft[i].quarter }; } return null; };
    const lev = latest("net_debt_ebitda"), roce = latest("roce"), rev = latest("revenue");
    const unitLabel = trendUnitLabel(ft);
    const stat = (val, lab, color) => (val == null ? "" : `<div class="kpi" style="flex:1;padding:11px 13px"><div class="kpi-n" style="font-size:24px;color:${color}">${val}</div><div class="kpi-l">${lab}</div></div>`);
    H.push(`<div class="slide light">${watermarkHTML(info)}<div class="pad">
      <div class="sec-h"><span class="ix">02</span><h2>Deadline Slippage &amp; Execution Momentum</h2><span class="tl"></span></div>
      <div class="lead">Left: where each promised date <b>started</b> (amber) versus where management <b>re-set it</b> (red). Right: the reported financials.</div>
      <div class="row2">
        <div class="panel" style="flex:1.55"><h3>Timeline commitments — promised → revised</h3>${ganttSVG || `<div class="empty-pan">No slipped timelines — deadlines held.</div>`}
          <div style="display:flex;gap:18px;margin-top:6px;font-size:11px;color:#5b677f"><span><span class="legdot" style="background:${T.GOLD}"></span> Promised window</span><span><span class="legdot" style="background:${T.MISSED}"></span> Re-set / actual window</span></div></div>
        ${momoSVG ? `<div class="panel" style="flex:1"><h3>EBITDA (${esc(unitLabel)}) &amp; margin</h3>${momoSVG}<div style="display:flex;gap:10px;margin-top:10px">${stat(lev ? `${lev.v.toFixed(2)}×` : null, `Net debt / EBITDA${lev ? ` · ${shortQ(lev.q)}` : ""}`, "#2563eb")}${stat(roce ? `${roce.v}%` : null, `ROCE${roce ? ` · ${shortQ(roce.q)}` : ""}`, "#7c3aed")}${stat(rev ? fmtTrendVal(rev.v, unitLabel) : null, `Revenue${rev ? ` · ${shortQ(rev.q)}` : ""}`, "#16a34a")}</div></div>` : ""}
      </div>
      ${foot()}</div></div>`);
  }

  /* PAGES 4..n — TRACK RECORD (cards, worst-first, 6/page) */
  if (cardPages.length) {
    cardPages.forEach((page, i) => {
      const part = cardPages.length > 1 ? ` <span style="color:#9aa6bd;font-weight:700;font-size:18px">/ part ${i + 1} of ${cardPages.length}</span>` : "";
      H.push(`<div class="slide light">${watermarkHTML(info)}<div class="pad">
        <div class="sec-h"><span class="ix">03</span><h2>The Track Record — ${testable.length} Testable Promise${testable.length === 1 ? "" : "s"}${part}</h2><span class="tl"></span></div>
        <div class="lead">Commitments whose verdict is already in the documents, ordered <b>worst to best</b>. The other ${sc.NYT || 0} promise${(sc.NYT || 0) === 1 ? " is" : "s are"} forward-dated and remain Not Yet Testable.</div>
        <div class="trgrid">${page.map(card).join("")}</div>
        ${foot()}</div></div>`);
    });
  } else {
    H.push(`<div class="slide light">${watermarkHTML(info)}<div class="pad">
      <div class="sec-h"><span class="ix">03</span><h2>The Track Record</h2><span class="tl"></span></div>
      <div class="lead">No testable promises yet — ${sc.NYT || 0} commitment${(sc.NYT || 0) === 1 ? "" : "s"} awaiting their test date within the verification window.</div>
      ${foot()}</div></div>`);
  }

  /* MASTER TABLE (auto-paginates; header repeats) */
  H.push(masterTable(promises, total, info));

  /* METHODOLOGY & SOURCES */
  H.push(methodology(vw, docs, info));

  H.push("</body></html>");
  return H.join("");
}

/* ---------- cards / table / methodology ---------- */
function card(p) {
  const c = STC[p.status] || T.NYT;
  const meta = [p.quarter_context, p.source_label || p.source_id].filter(Boolean).map(esc).join(" · ");
  const why = p.mgmt_explanation ? `<b>Why:</b> ${esc(p.mgmt_explanation)} ` : "";
  const tag = p.root_cause ? `<span class="tag">${esc(p.root_cause)}</span>` : "";
  return `<div class="trc" style="border-left:5px solid ${c}">
    <div class="trc-top"><span class="pill" style="background:${c}">${esc(p.status)}</span><span class="trc-meta">${meta}</span></div>
    <div class="trc-title">${esc(p.promise || p.metric || p.id)}</div>
    <div class="trc-row"><span class="trc-k">Target</span><span>${esc(p.target?.text || p.metric || "—")}</span></div>
    <div class="trc-row"><span class="trc-k">Actual</span><span>${esc(p.actual?.what_happened || p.actual?.text || "—")}</span></div>
    <div class="trc-row"><span class="trc-k">Variance</span><span class="trc-var" style="color:${c}">${esc(p.variance?.text || "—")}</span></div>
    ${(why || tag) ? `<div class="trc-why">${why}${tag}</div>` : ""}</div>`;
}

const TBL_COLS = ["Date", "Qtr/FY", "Source", "Promise", "Exact Quote", "Metric + Target", "Test Date", "Conf.", "What Happened", "Status", "Variance", "Mgmt Explanation", "Root-Cause"];
function masterTable(promises, total, info) {
  const rows = promises.slice().sort((a, b) => (periodIndex(a.quarter_context) ?? 0) - (periodIndex(b.quarter_context) ?? 0) || String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const confBadge = (c) => (c ? `<span class="cf" style="background:${{ H: T.RED, M: T.GOLD, L: T.NYT }[c] || T.NYT}">${esc(c)}</span>` : "");
  const metricTarget = (p) => [p.metric, p.target?.text].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ");
  const tr = rows.map((p, i) => {
    const c = STC[p.status] || T.NYT;
    const cells = [
      `<td>${esc(p.date)}</td>`,
      `<td>${esc(p.quarter_context)}</td>`,
      `<td>${esc(p.source_label || p.source_id || "")}</td>`,
      `<td class="strong">${esc(p.promise)}</td>`,
      `<td class="q">${esc(p.quote)}</td>`,
      `<td>${esc(metricTarget(p))}</td>`,
      `<td>${esc(p.test_date)}</td>`,
      `<td style="text-align:center">${confBadge(p.confidence)}</td>`,
      `<td>${esc(p.actual?.what_happened || p.actual?.text || "")}</td>`,
      `<td><span class="pill" style="background:${c}">${esc(p.status)}</span></td>`,
      `<td>${esc(p.variance?.text || "")}</td>`,
      `<td>${esc(p.mgmt_explanation || "")}</td>`,
      `<td>${esc(p.root_cause || "")}</td>`,
    ].join("");
    return `<tr class="${i % 2 ? "zz" : ""}">${cells}</tr>`;
  }).join("");
  const colgroup = `<colgroup><col class="c-date"><col class="c-qtr"><col class="c-src"><col class="c-prom"><col class="c-quote"><col class="c-metric"><col class="c-test"><col class="c-conf"><col class="c-act"><col class="c-stat"><col class="c-var"><col class="c-mgmt"><col class="c-tag"></colgroup>`;
  const thead = `<thead><tr>${TBL_COLS.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>`;
  return `<div class="table-wrap" style="${tableWatermark(info)}"><div class="tbl-head"><h2>Master Table — all ${total} measurable commitments</h2><span>Chronological · oldest first · colour = delivery status</span></div><table>${colgroup}${thead}<tbody>${tr}</tbody></table></div>`;
}

function methodology(vw, docs, info) {
  const src = docs.map((d) => `<div class="scard"><div class="t">${esc(d.quarter)} ${esc(DOC_TYPE[d.type] || "Document")}</div><div class="d">${esc(d.date)}${d.role ? ` · ${esc(d.role)}` : ""}</div></div>`).join("");
  return `<div class="slide">${watermarkHTML(info)}<div class="bg" style="opacity:.55"></div><div class="pad">
    <div class="sec-h"><span class="ix">04</span><h2 style="color:#fff">Methodology &amp; Sources</h2><span class="tl"></span></div>
    <div class="mlist">
      <div class="mbox"><h4>What qualifies as a commitment</h4><p>Only <b>measurable</b> statements — a number, %, ratio, ₹/$ figure or a dated milestone. Generic or aspirational commentary is rejected. One promise per row, with a verbatim ≤25-word quote.</p></div>
      <div class="mbox"><h4>How status is judged (deterministic rules — the model only retrieves)</h4><ul>
        <li><b style="color:${T.MET}">MET</b> — delivered or exceeded the target</li>
        <li><b style="color:${T.PARTIAL}">PARTIAL</b> — close but below target / a milestone slipped within grace</li>
        <li><b style="color:${T.MISSED}">MISSED</b> — failed, incl. a date the company later pushed past the promised window</li>
        <li><b style="color:${T.NYT}">NYT</b> — outcome not yet reported within the verification window (excluded from scoring)</li></ul></div>
      <div class="mbox"><h4>Confidence &amp; the credibility score</h4><p><b style="color:${T.RED}">H</b> = hard numeric · <b style="color:${T.GOLD}">M</b> = directional · <b style="color:${T.NYT}">L</b> = aspirational. Credibility = confidence-weighted delivery over testable promises (MET=1, PARTIAL=0.5, MISSED=0; H=1.0, M=0.8, L=0.6); bands A≥75 B≥60 C≥45 D≥30 E&lt;30.</p></div>
      <div class="mbox"><h4>The verification window</h4><p>Outcomes are verifiable only through <b>${esc(vw.latest_reported || "the latest reported period")}</b>${vw.latest_reported_date ? ` (reported ${esc(vw.latest_reported_date)})` : ""}. Later targets are therefore <b>NYT</b>.${info.note ? ` <i>${esc(info.note)}</i>` : ""}</p></div>
    </div>
    <div style="margin-top:16px"><div class="mbox"><h4>Source documents</h4><div class="srcrow">${src || '<div class="scard"><div class="t">—</div></div>'}</div></div></div>
    <div class="pgnum">Generated from primary disclosures · not investment advice</div><div class="watermark">${esc(info.label)}</div>
    </div></div>`;
}

/* gradeFromScore mirror (avoid importing the browser ui.js here) */
function gradeFromScore(score) {
  if (score == null || Number.isNaN(Number(score))) return null;
  const s = Number(score);
  return s >= 75 ? "A" : s >= 60 ? "B" : s >= 45 ? "C" : s >= 30 ? "D" : "E";
}

/* ---------- CSS (the reference, verbatim, token-replaced) + P9 additions ---------- */
function CSS(info) {
  let css = REFERENCE_CSS;
  const map = { TXT: T.TXT, INK: T.INK, INK2: T.INK2, CARD: T.CARD, CARD2: T.CARD2, LINE: T.LINE, MUT: T.MUT, RED: T.RED, GOLD: T.GOLD, VIOLET: T.VIOLET, TEAL: T.TEAL, MISSED: T.MISSED };
  for (const [k, v] of Object.entries(map)) css = css.replaceAll(`__${k}__`, v);
  return css + EXTRA_CSS;
}

const REFERENCE_CSS = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:A4 landscape;margin:0}
@page tablepage{size:A4 landscape;margin:10mm 8mm 11mm 8mm}
html{font-family:'Inter','DejaVu Sans','Liberation Sans',Arial,sans-serif;color:__TXT__}
.mono{font-family:'DejaVu Sans Mono',monospace}
.slide{width:297mm;height:210mm;position:relative;overflow:hidden;page-break-after:always;background:__INK__}
.light{background:#F4F6FB;color:#0c1426}
.bg{position:absolute;inset:0;background:
 radial-gradient(900px 520px at 82% 8%, rgba(255,77,94,.30), transparent 60%),
 radial-gradient(760px 520px at 8% 96%, rgba(139,123,255,.28), transparent 60%),
 radial-gradient(620px 420px at 60% 60%, rgba(45,212,191,.12), transparent 60%),
 linear-gradient(135deg,#0A0E1A 0%,#0d1424 55%,#120c1f 100%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(180deg,transparent,#000 30%,#000 70%,transparent)}
.pad{position:relative;padding:20mm 22mm}
.kicker{display:flex;align-items:center;gap:12px;font-size:11px;letter-spacing:4px;color:__MUT__;text-transform:uppercase;font-weight:700}
.kicker .dot{width:9px;height:9px;border-radius:50%;background:__RED__;box-shadow:0 0 14px __RED__}
.bar{height:5px;width:120px;border-radius:9px;background:linear-gradient(90deg,__GOLD__,__RED__,__VIOLET__)}
h1{font-size:58px;line-height:.98;font-weight:800;letter-spacing:-1.5px;margin-top:20px}
h1 .grad{background:linear-gradient(90deg,#FFD27A,__RED__ 55%,__VIOLET__);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:16px;font-size:15px;color:#C7D2EA;max-width:620px;line-height:1.5}
.hero-kpis{position:absolute;left:22mm;right:22mm;bottom:40mm;display:flex;gap:14px}
.hk{flex:1;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border:1px solid __LINE__;border-radius:16px;padding:16px 16px}
.hk .n{font-size:36px;font-weight:800;letter-spacing:-1px}
.hk .l{font-size:11px;color:__MUT__;margin-top:4px;letter-spacing:.3px;line-height:1.3}
.foot{position:absolute;left:22mm;right:22mm;bottom:13mm;display:flex;justify-content:space-between;align-items:center;color:__MUT__;font-size:11px;border-top:1px solid __LINE__;padding-top:10px}
.badges{display:flex;gap:7px;flex-wrap:wrap}
.bdg{font-size:9.5px;background:rgba(255,255,255,.06);border:1px solid __LINE__;border-radius:7px;padding:4px 8px;color:#cfe}
.sec-h{display:flex;align-items:center;gap:13px;margin-bottom:14px}
.sec-h .ix{font-family:'DejaVu Sans Mono';font-size:12px;color:__INK__;background:linear-gradient(135deg,__GOLD__,__RED__);padding:5px 9px;border-radius:8px;font-weight:700}
.sec-h h2{font-size:26px;font-weight:800;letter-spacing:-.5px}
.sec-h .tl{flex:1;height:1px;background:__LINE__}
.lead{color:__MUT__;font-size:13px;margin:-6px 0 16px;max-width:1010px;line-height:1.5}
.light .lead{color:#475569}
.kpi{flex:1;background:__CARD__;border:1px solid __LINE__;border-radius:16px;padding:16px 18px}
.light .kpi{background:#fff;border-color:#e4e8f2;box-shadow:0 6px 18px rgba(20,30,60,.06)}
.kpi-n{font-size:34px;font-weight:800;letter-spacing:-1px}
.kpi-l{font-size:11px;color:__MUT__;margin-top:2px;font-weight:600}
.light .kpi-l{color:#586}
.panel{background:__CARD__;border:1px solid __LINE__;border-radius:18px;padding:18px 20px}
.light .panel{background:#fff;border-color:#e4e8f2;box-shadow:0 6px 18px rgba(20,30,60,.06)}
.panel h3{font-size:13px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:__MUT__;margin-bottom:12px}
.light .panel h3{color:#67748f}
.row2{display:flex;gap:16px}
.legend{display:flex;flex-direction:column;gap:9px;margin-top:6px}
.lg{display:flex;align-items:center;gap:9px;font-size:12.5px}
.lg .sw{width:13px;height:13px;border-radius:4px}
.lg b{font-family:'DejaVu Sans Mono';margin-left:auto}
.callout{background:linear-gradient(135deg,rgba(251,59,83,.14),rgba(139,123,255,.10));border:1px solid __LINE__;border-radius:16px;padding:16px 18px}
.light .callout{background:linear-gradient(135deg,rgba(37,99,235,.08),rgba(34,197,94,.08));border-color:#dbe2f0}
.callout .big{font-size:18px;font-weight:800;line-height:1.3}
.light .callout .big{color:#14213d}
.callout p{font-size:11.5px;color:__MUT__;margin-top:8px;line-height:1.5}
.light .callout p{color:#5b677f}
.donut{width:200px;height:200px}.dn-num{font-size:50px;font-weight:800;fill:__TXT__;text-anchor:middle;font-family:'DejaVu Sans'}
.dn-lab{font-size:11px;fill:__MUT__;text-anchor:middle;letter-spacing:2px}
.vb{width:100%;height:auto}.vb-ax{fill:__MUT__;font-size:10px;text-anchor:end}.vb-lab{fill:__TXT__;font-size:11px;text-anchor:middle;font-weight:700}
.hb{width:100%;height:auto}.hb-lab{fill:__TXT__;font-size:12px;dominant-baseline:middle}.hb-val{fill:__MUT__;font-size:11px;font-weight:700;dominant-baseline:middle;font-family:'DejaVu Sans Mono'}
.light .hb-lab{fill:#26324d}
.gt{width:100%;height:auto}.gt-q{fill:__MUT__;font-size:10px;text-anchor:middle;letter-spacing:.3px}.gt-name{fill:#26324d;font-size:11px;dominant-baseline:middle;font-weight:600}
.gt-note{fill:__MISSED__;font-size:10px;dominant-baseline:middle;font-weight:700}
.eb{width:100%;height:auto}.eb-v{fill:#26324d;font-size:11px;text-anchor:middle;font-weight:700;font-family:'DejaVu Sans Mono'}.eb-x{fill:#67748f;font-size:11px;text-anchor:middle;font-weight:700}.eb-m{fill:__TEAL__;font-size:10px;text-anchor:middle;font-weight:700;font-family:'DejaVu Sans Mono'}
.trgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:6px}
.trc{background:#fff;border:1px solid #e4e8f2;border-radius:15px;padding:16px 18px;box-shadow:0 6px 16px rgba(20,30,60,.06)}
.trc-top{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.trc-meta{font-size:9.5px;color:#8893a8;margin-left:auto;font-weight:600}
.trc-title{font-size:15px;font-weight:700;color:#172036;line-height:1.22;margin-bottom:12px;min-height:38px}
.trc-row{display:flex;gap:10px;font-size:11.5px;color:#3a465f;margin-bottom:6px}
.trc-k{color:#94a0b6;font-weight:700;width:60px;flex:none;text-transform:uppercase;font-size:9.5px;padding-top:1px}
.trc-var{font-weight:700}
.trc-why{font-size:11px;color:#55617a;margin-top:11px;line-height:1.45;border-top:1px dashed #e4e8f2;padding-top:10px}
.tag{display:inline-block;background:#eef0f6;color:#475569;border-radius:5px;padding:1px 6px;font-weight:700;font-size:8.5px;margin-left:3px}
.pill{display:inline-block;color:#fff;font-weight:800;font-size:9px;letter-spacing:.4px;padding:3px 8px;border-radius:999px}
.cf{display:inline-block;color:#10141f;font-weight:800;font-size:9px;width:16px;height:16px;line-height:16px;text-align:center;border-radius:5px}
.table-wrap{page:tablepage;background:#fff;color:#1f2840}
.tbl-head{display:flex;align-items:baseline;gap:12px;margin-bottom:8px}
.tbl-head h2{font-size:19px;font-weight:800;color:#101828}
.tbl-head span{font-size:11px;color:#67748f}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:6.6px;line-height:1.28}
thead{display:table-header-group}
th{background:linear-gradient(135deg,#1B2740,#0F1626);color:#dbe6fb;font-size:6.6px;text-align:left;padding:6px 5px;font-weight:700;letter-spacing:.2px;border:1px solid #0c1322;text-transform:uppercase}
td{padding:5px 5px;border:1px solid #e6e9f1;vertical-align:top;color:#1f2840;word-wrap:break-word;overflow-wrap:anywhere}
tr.zz td{background:#f7f9fd}
td.q{font-style:italic;color:#3b4660}
td.strong{font-weight:700;color:#16203a}
tr{page-break-inside:avoid}
col.c-date{width:5%}col.c-qtr{width:4.2%}col.c-src{width:6.5%}col.c-prom{width:10.5%}col.c-quote{width:16.5%}
col.c-metric{width:10.5%}col.c-test{width:6.5%}col.c-conf{width:3.2%}col.c-act{width:12.5%}col.c-stat{width:5.2%}
col.c-var{width:7%}col.c-mgmt{width:9.5%}col.c-tag{width:6%}
.mlist{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.mbox{background:__CARD__;border:1px solid __LINE__;border-radius:14px;padding:16px 18px}
.mbox h4{font-size:13px;color:__GOLD__;margin-bottom:8px;letter-spacing:.3px}
.mbox p,.mbox li{font-size:11px;color:#C7D2EA;line-height:1.5}
.mbox ul{margin-left:16px}
.srcrow{display:flex;gap:9px;margin-top:8px;flex-wrap:wrap}
.scard{flex:1;min-width:140px;background:rgba(255,255,255,.04);border:1px solid __LINE__;border-radius:11px;padding:11px 13px}
.scard .t{font-size:12px;font-weight:700}.scard .d{font-size:10px;color:__MUT__;margin-top:3px}
.watermark{position:absolute;right:18mm;bottom:11mm;font-size:10px;color:__MUT__}
.pgnum{position:absolute;left:18mm;bottom:11mm;font-size:10px;color:__MUT__;font-family:'DejaVu Sans Mono'}
.light .pgnum,.light .watermark{color:#9aa6bd}
`;

const EXTRA_CSS = `
.table-wrap .pill{white-space:nowrap;font-size:8px;padding:2px 6px;letter-spacing:0}
.legdot{display:inline-block;width:11px;height:11px;border-radius:50%;vertical-align:middle}
.empty-pan{padding:40px;text-align:center;color:#8893a8;font-size:13px}
/* cover credibility ring + split */
.cover-cred{display:flex;align-items:center;gap:22px;margin-top:24px}
.cc-ring{width:104px;height:104px;border-radius:50%;display:grid;place-items:center;box-shadow:0 0 0 1px ${T.LINE} inset;position:relative;background:radial-gradient(circle at center, ${T.INK2} 56%, transparent 57%), conic-gradient(var(--gc) calc(1%*var(--p,0)), rgba(255,255,255,.10) 0)}
.cc-grade{font-size:40px;font-weight:800;color:var(--gc);line-height:1}
.cc-score{position:absolute;bottom:14px;font-size:11px;color:${T.MUT};font-weight:700}
.cc-score small{opacity:.7}
.cc-split{display:flex;flex-direction:column;gap:7px;min-width:230px}
.cc-split-h{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:${T.MUT};font-weight:700}
.sp-row{display:flex;align-items:center;gap:10px;font-size:12px;color:#C7D2EA}
.sp-l{width:62px;color:${T.MUT}}
.sp-tr{flex:1;height:8px;border-radius:99px;background:${T.INK2};overflow:hidden}
.sp-tr>span{display:block;height:100%;border-radius:99px}
.sp-row b{width:26px;text-align:right;font-family:'DejaVu Sans Mono'}
.cc-prov{align-self:flex-start;font-size:11px;font-weight:700;padding:6px 12px;border-radius:999px;border:1px solid var(--pc,${T.LINE});color:var(--pc,${T.MUT});background:rgba(255,255,255,.04)}
.prov-live{--pc:${T.MET}}.prov-mock{--pc:${T.MISSED}}.prov-provisional{--pc:${T.GOLD}}.prov-manual{--pc:${T.NYT}}.prov-unknown{--pc:${T.MUT}}
/* provisional/mock cover banner */
.prov-banner{position:relative;z-index:6;margin:0;padding:9px 22mm;font-size:12px;font-weight:700;letter-spacing:.3px;color:#fff;background:var(--pc,${T.MISSED});--pc:${T.MISSED}}
.prov-banner.prov-provisional{--pc:${T.GOLD};color:#1b1300}
/* diagonal watermark across a page */
.wmark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:40}
.wmark span{font-size:48px;font-weight:800;letter-spacing:3px;transform:rotate(-26deg);color:var(--wc);opacity:.12;border:5px solid var(--wc);padding:14px 34px;border-radius:14px;text-align:center;white-space:nowrap}
`;
