/**
 * screener.mjs — Screener.in specifics for document acquisition: company
 * resolution, authenticated login (session persisted + reused), and Concalls
 * scraping with a heading-anchored fallback that survives markup drift.
 *
 * This module is browser-agnostic about *driving* — it receives a Playwright
 * `page`/`context` from the orchestrator (pipeline/scrape-screener.mjs) and never
 * launches a browser itself. Network egress must allow www.screener.in (and the
 * IR/exchange hosts that transcript links redirect to).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, debugDir, typeFromLabel } from "./manifest.mjs";

// Origin is overridable for staging/testing; defaults to the live site.
export const SCREENER_ORIGIN = process.env.SCREENER_ORIGIN || "https://www.screener.in";
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ----------------------------------------------------------------------------
 * Company resolution
 * ------------------------------------------------------------------------- */

/** A query that looks like a Screener ticker/symbol: all-caps or numeric, no
 *  spaces (e.g. VEDL, RELIANCE, M&M, 500325). Mixed-case → treat as a name. */
function looksLikeTicker(q) {
  return /^[A-Z0-9][A-Z0-9&._-]{0,14}$/.test(q);
}

function tickerFromPath(path) {
  const m = String(path || "").match(/\/company\/([^/]+)\//);
  return m ? m[1].toUpperCase() : null;
}

/** Default HTTP getter (Node fetch). The orchestrator passes a browser-context
 *  getter so requests carry the logged-in session + browser UA (anti-bot). */
async function defaultRequest(url) {
  const r = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json, text/html;q=0.9" },
  });
  return {
    ok: r.ok,
    status: r.status,
    json: () => r.json(),
    text: () => r.text(),
  };
}

/**
 * Resolve a query (ticker or company name) to a Screener company URL.
 * Tickers map directly to /company/<TICKER>/; names go through the search API.
 * Prefers the /consolidated/ view unless `consolidated` is false.
 *
 * @returns {{ticker:string|null, name:string|null, url:string, via:string}}
 */
export async function resolveCompany(query, { consolidated = true, request = defaultRequest, asTicker } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("resolveCompany: empty query");

  const withView = (base) => (consolidated ? base.replace(/\/?$/, "/") + "consolidated/" : base.replace(/\/?$/, "/"));

  // Explicit hint (TICKER vs COMPANY env) wins; otherwise sniff from the string.
  const useTicker = asTicker === undefined ? looksLikeTicker(q) : asTicker;
  if (useTicker) {
    const base = `${SCREENER_ORIGIN}/company/${encodeURIComponent(q.toUpperCase())}/`;
    return { ticker: q.toUpperCase(), name: null, url: withView(base), via: "ticker" };
  }

  const res = await request(`${SCREENER_ORIGIN}/api/company/search/?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Screener search failed (HTTP ${res.status}) for ${JSON.stringify(q)}`);
  let list = await res.json().catch(() => null);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`No Screener match for ${JSON.stringify(q)}`);
  }
  // The API returns [{id, name, url}], best match first.
  const best = list[0];
  const path = best.url || `/company/${best.id}/`;
  return {
    ticker: tickerFromPath(path),
    name: best.name || null,
    url: withView(`${SCREENER_ORIGIN}${path}`),
    via: "search",
  };
}

/* ----------------------------------------------------------------------------
 * Authentication (Django login form + persisted session)
 * ------------------------------------------------------------------------- */

/** Heuristic: are we authenticated on the current Screener page? */
export async function isLoggedIn(page) {
  // Authenticated pages expose a logout link / account menu.
  const logout = await page
    .locator('a[href*="logout" i]')
    .count()
    .then((c) => c > 0)
    .catch(() => false);
  if (logout) return true;
  // Otherwise: authenticated pages have no visible password field.
  const loginField = await page
    .locator('input[name="password"], #id_password')
    .count()
    .then((c) => c > 0)
    .catch(() => false);
  return !loginField;
}

/**
 * Log in via the Django form at /login/. Playwright submits the real form, so the
 * hidden csrfmiddlewaretoken is posted automatically; we only fill the visible
 * username/password fields. Throws on failure (caller saves a debug dump).
 */
export async function login(page, { email, password }) {
  if (!email || !password) {
    throw new Error("Missing SCREENER_EMAIL / SCREENER_PASSWORD");
  }
  await page.goto(`${SCREENER_ORIGIN}/login/`, { waitUntil: "domcontentloaded" });

  // Confirm the CSRF hidden input is present (Django form integrity check).
  const hasCsrf = await page.locator('input[name="csrfmiddlewaretoken"]').count().then((c) => c > 0);
  if (!hasCsrf) {
    throw new Error("Login page has no CSRF token — Screener markup changed (run EXPLORE=1).");
  }

  await page.fill('input[name="username"], input[type="email"], #id_username', email);
  await page.fill('input[name="password"], #id_password', password);

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.click('button[type="submit"], input[type="submit"], button:has-text("Login")'),
  ]);
  await page.waitForLoadState("networkidle").catch(() => {});

  // Django re-renders the login form with errors on bad credentials.
  const errorText = await page
    .locator(".errorlist, .alert-error, [class*='error']")
    .first()
    .innerText()
    .catch(() => "");
  if (!(await isLoggedIn(page))) {
    throw new Error(
      `Screener login failed${errorText ? ` (${errorText.trim().slice(0, 120)})` : ""} — check credentials.`,
    );
  }
  return true;
}

/* ----------------------------------------------------------------------------
 * Concalls scraping
 * ------------------------------------------------------------------------- */

// Parse "Jul 2025" / "May 2024" → ISO-ish "YYYY-MM-01".
const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function monthYearToISO(text) {
  const m = String(text || "").match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i);
  if (!m) return null;
  return `${m[2]}-${MONTHS[m[1].toLowerCase()]}-01`;
}

/**
 * In-page extraction of Concall rows. Tries an explicit Concalls container first,
 * then a heading-anchored fallback ("Concalls" heading → following link list).
 * Returns [{ monthText, links:[{text, href}] }] — mapping/typing happens in Node.
 */
function extractConcallRowsInPage() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  function findContainer() {
    // 1) Explicit Screener container.
    let c = document.querySelector(
      '.concalls, .documents.concalls, [class*="concall" i], #concalls',
    );
    if (c) return c;
    // 2) Heading-anchored: a short element whose text is "Concalls".
    const heads = Array.from(
      document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,button,p,strong"),
    );
    const head = heads.find((el) => {
      const t = norm(el.textContent);
      return /^concall/i.test(t) && t.length <= 20;
    });
    if (head) {
      // Climb until we find an ancestor that holds a list of links.
      let p = head;
      for (let i = 0; i < 5 && p; i++) {
        if (p.querySelector && p.querySelector("li a, ul a, a[href]")) return p;
        p = p.parentElement;
      }
      // Or scan following siblings for a list.
      let sib = head.nextElementSibling;
      for (let i = 0; i < 5 && sib; i++) {
        if (sib.querySelector && sib.querySelector("a[href]")) return sib;
        sib = sib.nextElementSibling;
      }
    }
    return null;
  }

  const container = findContainer();
  if (!container) return { found: false, rows: [] };

  // Rows are usually <li>; fall back to the container's direct children.
  let rowEls = Array.from(container.querySelectorAll("li"));
  if (rowEls.length === 0) rowEls = Array.from(container.children);

  const rows = [];
  for (const row of rowEls) {
    const links = Array.from(row.querySelectorAll("a[href]"))
      .map((a) => ({ text: norm(a.textContent), href: a.href }))
      .filter((l) => l.href && !/^javascript:/i.test(l.href));
    if (links.length === 0) continue;
    // Month label: the row text with the link labels stripped out.
    let monthText = "";
    const dated = Array.from(row.querySelectorAll("div,span,td,th")).find((el) =>
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/i.test(norm(el.textContent)),
    );
    if (dated) monthText = norm(dated.textContent);
    else monthText = norm(row.textContent);
    rows.push({ monthText, links });
  }
  return { found: true, rows };
}

/**
 * Navigate to a company URL and return Concall documents.
 * @returns {{found:boolean, documents:Array<{date,monthText,label,type,url}>}}
 */
export async function scrapeConcalls(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Concalls are below the fold; nudge lazy content + give it a beat.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(600);

  const { found, rows } = await page.evaluate(extractConcallRowsInPage);

  const documents = [];
  for (const row of rows) {
    const date = monthYearToISO(row.monthText);
    for (const link of row.links) {
      const type = typeFromLabel(link.text);
      if (!type) continue; // skip Notes / REC / Add Missing / etc.
      documents.push({
        date,
        monthText: row.monthText,
        label: link.text,
        type,
        url: link.href,
      });
    }
  }
  return { found, documents };
}

/* ----------------------------------------------------------------------------
 * EXPLORE recon mode
 * ------------------------------------------------------------------------- */

/** Snapshot the rendered company page + candidate Concall selectors for debugging. */
export async function explore(page, url, ticker) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(600);

  const dir = ensureDir(debugDir(ticker));
  writeFileSync(join(dir, "company.html"), await page.content());
  await page.screenshot({ path: join(dir, "company.png"), fullPage: true }).catch(() => {});

  const candidates = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const out = [];
    const all = Array.from(document.querySelectorAll("*"));
    for (const el of all) {
      const t = norm(el.textContent);
      const cls = typeof el.className === "string" ? el.className : "";
      const mentionsConcall = /concall/i.test(cls) || (/^concall/i.test(t) && t.length <= 20);
      if (!mentionsConcall) continue;
      const links = Array.from(el.querySelectorAll("a[href]"))
        .slice(0, 8)
        .map((a) => ({ text: norm(a.textContent), href: a.href }));
      out.push({
        tag: el.tagName.toLowerCase(),
        class: cls,
        id: el.id || null,
        selector:
          el.tagName.toLowerCase() +
          (el.id ? `#${el.id}` : "") +
          (cls ? "." + cls.split(/\s+/).filter(Boolean).join(".") : ""),
        sampleLinks: links,
        htmlSnippet: el.outerHTML.slice(0, 400),
      });
      if (out.length >= 12) break;
    }
    return out;
  });
  writeFileSync(join(dir, "concall-candidates.json"), JSON.stringify(candidates, null, 2) + "\n");

  return { dir, candidates };
}
