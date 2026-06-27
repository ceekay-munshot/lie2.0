/**
 * ui.js — Lie Detector shared design system.
 *
 * The single source of truth for colour, formatting and data access on the
 * client. Loaded as an ES module by every page; also mirrored onto `window.LD`
 * for convenience in later, non-module contexts (e.g. inline chart callbacks).
 *
 * Exports: tokens, statusColor, confColor, gradeColor, gradeFromScore,
 * fmtINRcr, fmtPct, fmtSigned, echartsTheme, loadCompany, loadIndex, hideBoot.
 */

/* ----------------------------------------------------------------------------
 * Design tokens — keep in lock-step with the :root CSS variables in index.html.
 * ------------------------------------------------------------------------- */
export const tokens = {
  // Promise outcome
  status: {
    MET: "#22C55E",
    PARTIAL: "#F59E0B",
    MISSED: "#FB3B53",
    NYT: "#7C8BB0",
  },
  // Extraction confidence
  confidence: {
    H: "#FF4D5E",
    M: "#FFB020",
    L: "#7C8BB0",
  },
  // Accent ramp (charts, highlights)
  accent: {
    red: "#FF4D5E",
    gold: "#FFB020",
    violet: "#8B7BFF",
    teal: "#2DD4BF",
    cyan: "#38BDF8",
  },
  // Dark theme surfaces
  dark: {
    ink: "#0A0E1A",
    ink2: "#0F1626",
    card: "#161F33",
    line: "#27324D",
    muted: "#93A4C7",
    text: "#E8EEF9",
  },
  // Light theme surfaces
  light: {
    bg: "#F4F6FB",
    text: "#0C1426",
    card: "#FFFFFF",
    line: "#E4E8F2",
  },
  // Credibility grade ramp (A best → E worst)
  grade: {
    A: "#22C55E",
    B: "#2DD4BF",
    C: "#FFB020",
    D: "#FB3B53",
    E: "#FF4D5E",
  },
};

/* ----------------------------------------------------------------------------
 * Colour helpers
 * ------------------------------------------------------------------------- */

/** Colour for a promise status (MET | PARTIAL | MISSED | NYT). */
export function statusColor(status) {
  return tokens.status[status] || tokens.dark.muted;
}

/** Colour for an extraction confidence (H | M | L). */
export function confColor(conf) {
  return tokens.confidence[conf] || tokens.dark.muted;
}

/** Colour for a credibility grade (A–E, case-insensitive). */
export function gradeColor(grade) {
  return tokens.grade[String(grade || "").toUpperCase()] || tokens.dark.muted;
}

/**
 * Map a 0–100 credibility score to a letter grade.
 * Bands (documented in CLAUDE.md; computed for real in Prompt 6):
 *   A ≥ 75 · B ≥ 60 · C ≥ 45 · D ≥ 30 · E < 30
 */
export function gradeFromScore(score) {
  if (score == null || Number.isNaN(Number(score))) return null;
  const s = Number(score);
  if (s >= 75) return "A";
  if (s >= 60) return "B";
  if (s >= 45) return "C";
  if (s >= 30) return "D";
  return "E";
}

/* ----------------------------------------------------------------------------
 * Provenance guard — the product's honesty rule: never present a mock or
 * quota-truncated ledger as a real verdict. Maps a ledger's `provenance` to a
 * badge descriptor; `disclaim:true` means the UI must dim/qualify the score.
 *   tone ∈ "live" (green) · "mock" (red) · "provisional" (amber) · "manual" (grey)
 *        · "unknown" (neutral). Pure + deterministic (unit-tested).
 * ------------------------------------------------------------------------- */
export function provenanceBadge(provenance) {
  const p = provenance && typeof provenance === "object" ? provenance : null;
  if (!p || !p.mode) {
    return { tone: "unknown", label: "Unverified", detail: "No provenance recorded for this ledger.", disclaim: false };
  }
  if (p.mode === "mock") {
    return { tone: "mock", label: "Mock data — not a real verdict", detail: "Built offline with canned actuals ($0); the score is illustrative only.", disclaim: true };
  }
  if (p.mode === "manual") {
    return { tone: "manual", label: "Curated", detail: "Hand-verified reference ledger.", disclaim: false };
  }
  // live
  if (p.complete) {
    const models = (Array.isArray(p.models_used) ? p.models_used : []).filter((m) => m && m !== "mock");
    return { tone: "live", label: "Live · complete", detail: models.length ? `Full retrieval · ${models.join(", ")}.` : "Full live retrieval.", disclaim: false };
  }
  const forced = Number(p.forced_nyt || 0);
  const errs = Number(p.retrieval_errors || 0);
  const bits = [];
  if (forced) bits.push(`${forced} due promise${forced === 1 ? "" : "s"} unverified`);
  if (errs) bits.push(`${errs} retrieval error${errs === 1 ? "" : "s"}`);
  return {
    tone: "provisional",
    label: "Provisional — incomplete retrieval",
    detail: `${bits.join(" · ") || "Run did not complete"}. The score will move once retrieval finishes — treat it as indicative.`,
    disclaim: true,
  };
}

/* ----------------------------------------------------------------------------
 * Formatters
 * ------------------------------------------------------------------------- */

const EM_DASH = "—";

/**
 * Indian-grouped rupee-crore amount, e.g. 137529 → "₹1,37,529 cr".
 * Integers render with no decimals; fractional values keep one.
 */
export function fmtINRcr(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return EM_DASH;
  const v = Number(n);
  const fmt = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: Number.isInteger(v) ? 0 : 1,
    minimumFractionDigits: 0,
  });
  return `₹${fmt.format(v)} cr`;
}

/** Percentage, e.g. 41 → "41%". */
export function fmtPct(n, digits = 0) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return EM_DASH;
  return `${Number(n).toFixed(digits)}%`;
}

/** Signed number, e.g. 11 → "+11", -4 → "-4", 0 → "0". */
export function fmtSigned(n, digits = 0) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return EM_DASH;
  const v = Number(n);
  const body = v.toFixed(digits);
  return v > 0 ? `+${body}` : body;
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escape a value for safe interpolation into innerHTML. */
export function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/* ----------------------------------------------------------------------------
 * ECharts dark theme
 * ------------------------------------------------------------------------- */

const FONT_STACK =
  "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const echartsTheme = {
  color: [
    tokens.accent.cyan,
    tokens.accent.violet,
    tokens.accent.teal,
    tokens.accent.gold,
    tokens.accent.red,
  ],
  backgroundColor: "transparent",
  textStyle: { color: tokens.dark.text, fontFamily: FONT_STACK },
  title: {
    textStyle: { color: tokens.dark.text, fontFamily: FONT_STACK, fontWeight: 600 },
    subtextStyle: { color: tokens.dark.muted },
  },
  legend: { textStyle: { color: tokens.dark.muted } },
  tooltip: {
    backgroundColor: tokens.dark.card,
    borderColor: tokens.dark.line,
    borderWidth: 1,
    textStyle: { color: tokens.dark.text },
  },
  grid: { borderColor: tokens.dark.line, containLabel: true },
  categoryAxis: {
    axisLine: { lineStyle: { color: tokens.dark.line } },
    axisTick: { lineStyle: { color: tokens.dark.line } },
    axisLabel: { color: tokens.dark.muted },
    splitLine: { show: false, lineStyle: { color: tokens.dark.line } },
  },
  valueAxis: {
    axisLine: { show: false, lineStyle: { color: tokens.dark.line } },
    axisTick: { lineStyle: { color: tokens.dark.line } },
    axisLabel: { color: tokens.dark.muted },
    splitLine: { lineStyle: { color: tokens.dark.line, type: "dashed" } },
  },
};

/** Register the theme with a global ECharts if present (no-op otherwise). */
export function registerEchartsTheme(name = "lie") {
  if (typeof window !== "undefined" && window.echarts) {
    window.echarts.registerTheme(name, echartsTheme);
    return true;
  }
  return false;
}

/* ----------------------------------------------------------------------------
 * Data access — companies live as committed JSON under /data/companies/.
 * ------------------------------------------------------------------------- */

/** Load the lightweight company index (array of card-sized summaries). */
export async function loadIndex() {
  const res = await fetch("/data/companies/index.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load company index (HTTP ${res.status})`);
  return res.json();
}

/** Load a full company ledger by ticker (case-insensitive). */
export async function loadCompany(ticker) {
  const slug = String(ticker || "").toLowerCase();
  const res = await fetch(`/data/companies/${slug}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load company "${ticker}" (HTTP ${res.status})`);
  return res.json();
}

/* ----------------------------------------------------------------------------
 * Boot loader
 * ------------------------------------------------------------------------- */

/** Fade out and remove the full-screen boot loader, if present. */
export function hideBoot() {
  if (typeof document === "undefined") return;
  const boot = document.getElementById("boot");
  if (!boot) return;
  boot.classList.add("is-hidden");
  // Remove from the a11y tree after the CSS transition completes.
  window.setTimeout(() => boot.remove(), 600);
}

/* ----------------------------------------------------------------------------
 * Convenience mirror for non-module callers.
 * ------------------------------------------------------------------------- */
if (typeof window !== "undefined") {
  window.LD = {
    tokens,
    statusColor,
    confColor,
    gradeColor,
    gradeFromScore,
    provenanceBadge,
    escapeHTML,
    fmtINRcr,
    fmtPct,
    fmtSigned,
    echartsTheme,
    registerEchartsTheme,
    loadIndex,
    loadCompany,
    hideBoot,
  };
  registerEchartsTheme();
}
