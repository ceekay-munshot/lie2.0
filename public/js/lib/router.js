/**
 * router.js — the world's smallest router. The dashboard is a single page; the
 * company in view is the `?c=<ticker>` query param (no param = home). Uses the
 * History API so URLs are shareable and back/forward work. Framework-free.
 *
 *   import { currentTicker, navigate, onRoute } from "./lib/router.js";
 *   onRoute((ticker) => render(ticker));   // fired on navigate() + back/forward
 *   navigate("vedl");                        // → ?c=vedl
 *   navigate(null);                          // → home
 */
const PARAM = "c";
const listeners = new Set();

/** The ticker in the current URL, or null for the home view. */
export function currentTicker() {
  const v = new URLSearchParams(window.location.search).get(PARAM);
  const t = v ? v.trim() : "";
  return t ? t.toLowerCase() : null;
}

function emit() {
  const t = currentTicker();
  for (const cb of listeners) {
    try { cb(t); } catch (err) { console.error("route handler failed:", err); }
  }
}

/**
 * Push a new route and notify handlers. `ticker` falsy → home. No-op (no history
 * entry) when already on the requested route, so repeat clicks don't stack history.
 */
export function navigate(ticker) {
  const next = ticker ? String(ticker).toLowerCase() : null;
  if (next === currentTicker()) { emit(); return; }
  const url = new URL(window.location.href);
  if (next) url.searchParams.set(PARAM, next);
  else url.searchParams.delete(PARAM);
  window.history.pushState({}, "", url.pathname + url.search + url.hash);
  emit();
}

/** Convenience: go to the home view. */
export function toHome() { navigate(null); }

/** Register a route handler. Returns an unsubscribe fn. */
export function onRoute(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Fire the current route once (call after registering handlers, on boot). */
export function start() { emit(); }

// Browser back/forward.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", emit);
}
