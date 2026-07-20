/**
 * request-progress.js — the "Generate report" experience for an uncovered company.
 *
 * Fires /api/request, shows a full-screen progress overlay with ESTIMATED stages, and
 * polls the committed index.json for the REAL completion signal. It survives a tab
 * switch / bad network / a full reload via localStorage — the client can leave and come
 * back to a finished report. Success → a "Report ready → View" modal; failure/timeout →
 * "Retry". The pipeline runs server-side (GitHub Actions) and the provenance guard never
 * ships a partial ledger, so a failed run simply never appears — we never show a half
 * report.
 */
import { escapeHTML } from "../ui.js";
import { navigate } from "../lib/router.js";

const LS_KEY = "ld_pending_requests";
const DEADLINE_MS = 8 * 60 * 1000; // allow a run up to ~8 minutes
const POLL_MS = 8000;

// estimated stages (seconds since start → label). Purely cosmetic — the real completion
// signal is the ledger appearing in index.json.
const STAGES = [
  { t: 0, label: "Locating the company's filings…" },
  { t: 12, label: "Pulling earnings-call transcripts & investor decks…" },
  { t: 40, label: "Reading management commentary…" },
  { t: 78, label: "Extracting every measurable promise…" },
  { t: 125, label: "Verifying each promise against reported actuals…" },
  { t: 170, label: "Scoring credibility & building your report…" },
];

const drawIcons = () => { if (window.lucide?.createIcons) window.lucide.createIcons(); };
const cleanTicker = (t) => String(t || "").trim().toUpperCase().replace(/[^A-Z0-9.&-]+/g, "").slice(0, 24);

// ---- localStorage pending tracking -----------------------------------------
function readPending() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch { return {}; } }
function writePending(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* quota/denied — non-fatal */ } }
function addPending(t) { const p = readPending(); p[t] = { startedAt: Date.now() }; writePending(p); }
function removePending(t) { const p = readPending(); delete p[t]; writePending(p); }

// ---- overlay ----------------------------------------------------------------
let overlayEl = null;
let timers = [];
let onKey = null;
const clearTimers = () => { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers = []; };

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "gen-overlay";
  overlayEl.setAttribute("role", "dialog");
  overlayEl.setAttribute("aria-modal", "true");
  document.body.appendChild(overlayEl);
  document.body.style.overflow = "hidden";
  onKey = (e) => { if (e.key === "Escape") closeOverlay(); };
  document.addEventListener("keydown", onKey);
  return overlayEl;
}
function closeOverlay() {
  clearTimers();
  if (onKey) { document.removeEventListener("keydown", onKey); onKey = null; }
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  document.body.style.overflow = "";
}

function progressView(ticker, startedAt) {
  const el = ensureOverlay();
  const started = startedAt || Date.now();
  el.innerHTML = `
    <div class="gen-card" role="document">
      <div class="gen-spark"><i data-lucide="sparkles" aria-hidden="true"></i></div>
      <h2 class="gen-title">Generating report for <b>${escapeHTML(ticker)}</b></h2>
      <div class="gen-bar" role="progressbar" aria-label="Generating"><span class="gen-bar-fill"></span></div>
      <p class="gen-stage" id="gen-stage">Starting…</p>
      <p class="gen-note"><i data-lucide="info" aria-hidden="true"></i> This runs on our servers and takes a few minutes. You can switch tabs or even close this — your report will be waiting when you return.</p>
      <button type="button" class="gen-dismiss" data-gen-dismiss>Continue browsing</button>
    </div>`;
  drawIcons();
  const stageEl = el.querySelector("#gen-stage");
  const fill = el.querySelector(".gen-bar-fill");
  const tick = () => {
    const secs = (Date.now() - started) / 1000;
    let cur = STAGES[0];
    for (const s of STAGES) if (secs >= s.t) cur = s;
    if (stageEl) stageEl.textContent = cur.label;
    const pct = Math.min(92, (secs / (DEADLINE_MS / 1000)) * 100); // approach ~92%; completion snaps to 100
    if (fill) fill.style.width = `${pct}%`;
  };
  tick();
  timers.push(setInterval(tick, 1000));
  el.querySelector("[data-gen-dismiss]")?.addEventListener("click", () => closeOverlay());
}

function readyView(ticker) {
  const el = ensureOverlay();
  const fill0 = el.querySelector(".gen-bar-fill");
  if (fill0) fill0.style.width = "100%";
  el.innerHTML = `
    <div class="gen-card is-ready" role="document">
      <div class="gen-check"><i data-lucide="circle-check-big" aria-hidden="true"></i></div>
      <h2 class="gen-title">Report ready for <b>${escapeHTML(ticker)}</b></h2>
      <p class="gen-note">Its earnings promises have been extracted, verified against actuals, and scored.</p>
      <div class="gen-actions">
        <button type="button" class="btn-primary" data-gen-view><i data-lucide="arrow-right" aria-hidden="true"></i> View report</button>
        <button type="button" class="gen-dismiss" data-gen-dismiss>Back to search</button>
      </div>
    </div>`;
  drawIcons();
  el.querySelector("[data-gen-view]")?.addEventListener("click", () => { const t = ticker; closeOverlay(); navigate(t); });
  el.querySelector("[data-gen-dismiss]")?.addEventListener("click", () => closeOverlay());
}

function failView(ticker, message) {
  const el = ensureOverlay();
  el.innerHTML = `
    <div class="gen-card is-fail" role="document">
      <div class="gen-x"><i data-lucide="triangle-alert" aria-hidden="true"></i></div>
      <h2 class="gen-title">Couldn't finish <b>${escapeHTML(ticker)}</b></h2>
      <p class="gen-note">${escapeHTML(message || "The filings may be unavailable, or it's taking longer than usual. No half report is ever shown — please try again in a bit.")}</p>
      <div class="gen-actions">
        <button type="button" class="btn-primary" data-gen-retry><i data-lucide="rotate-cw" aria-hidden="true"></i> Retry</button>
        <button type="button" class="gen-dismiss" data-gen-dismiss>Close</button>
      </div>
    </div>`;
  drawIcons();
  el.querySelector("[data-gen-retry]")?.addEventListener("click", () => beginGenerate(ticker));
  el.querySelector("[data-gen-dismiss]")?.addEventListener("click", () => closeOverlay());
}

// ---- completion signal ------------------------------------------------------
async function isCovered(ticker) {
  try {
    const res = await fetch(`/data/companies/index.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return false;
    const idx = await res.json();
    return Array.isArray(idx) && idx.some((c) => String(c.ticker).toUpperCase() === ticker);
  } catch { return false; }
}

function pollUntilReady(ticker, startedAt) {
  const step = async () => {
    if (!overlayEl) return; // dismissed — leave the pending record; boot/resume will pick it up
    if (await isCovered(ticker)) { removePending(ticker); readyView(ticker); return; }
    if (Date.now() - startedAt >= DEADLINE_MS) { removePending(ticker); failView(ticker); return; }
    timers.push(setTimeout(step, POLL_MS));
  };
  timers.push(setTimeout(step, POLL_MS));
}

// ---- public API -------------------------------------------------------------
export async function beginGenerate(ticker) {
  const T = cleanTicker(ticker);
  if (!T) return;
  addPending(T);
  const startedAt = Date.now();
  progressView(T, startedAt);
  try {
    const r = await fetch(`/api/request/${encodeURIComponent(T)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) { removePending(T); failView(T, "Too many requests right now — please try again in a few minutes."); return; }
    if (data.status === "ready" || (await isCovered(T))) { removePending(T); readyView(T); return; }
    if (!r.ok && !data.mock) { removePending(T); failView(T, "We couldn't queue this company. Please try again shortly."); return; }
  } catch { /* network hiccup — the run may still be going; fall through to polling */ }
  pollUntilReady(T, startedAt);
}

/** On app boot, resume the most recent pending generate the user left mid-flight. */
export async function resumePending() {
  const p = readPending();
  const tickers = Object.keys(p);
  if (!tickers.length) return;
  const T = tickers.sort((a, b) => (p[b].startedAt || 0) - (p[a].startedAt || 0))[0];
  const startedAt = p[T].startedAt || Date.now();
  if (await isCovered(T)) { removePending(T); readyView(T); return; }
  if (Date.now() - startedAt >= DEADLINE_MS) { removePending(T); return; } // stale → drop silently
  progressView(T, startedAt);
  pollUntilReady(T, startedAt);
}
