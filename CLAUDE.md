# CLAUDE.md — Lie Detector

Guidance for any AI/code agent working in this repository. Read this first.

## What this is

**Lie Detector** is a static dashboard that, for any Indian listed company,
extracts every **measurable** management commitment from its earnings-call
transcripts and investor presentations, verifies each against later reported
actuals, scores delivery reliability, and exports a polished multi-page PDF.

User flow: **search a company → dashboard** (credibility score, status donut,
slippage timeline, track-record cards, master promise table) **→ Export PDF**.

The product's whole premise is *measurability and verifiability*: a "promise" is
only worth tracking if it has a number/date you can later check, and a verdict is
only credible if it cites the actual that confirmed or broke it.

## Architecture

```
wrangler.jsonc            Cloudflare Worker config (name: lie-detector)
worker/index.js           Worker: serves ./public via ASSETS; reserves /api/*
schema/
  lie-detector.schema.json  THE DATA CONTRACT — JSON Schema (draft 2020-12)
public/                   Static site (zero build step; CDN libs only)
  index.html              Shell + design-system <style> + boot loader
  js/ui.js                Design system: tokens, colour helpers, formatters,
                          ECharts dark theme, data loaders (loadCompany/loadIndex)
  js/app.js               Home page: render company cards from index.json
  data/companies/
    <ticker>.json         One ledger per company (validated against the schema)
    index.json            Generated card-sized summaries for the home page
pipeline/                 Node ESM (.mjs) build/verify scripts (run locally)
  lib/llm.mjs             Provider-agnostic, OpenAI-compatible LLM client
  lib/manifest.mjs        Acquisition contract: fiscal-quarter, sha256, %PDF, paths
  lib/screener.mjs        Screener resolve/login/scrape (+ drift-resilient selectors)
  scrape-screener.mjs     Screener acquisition orchestrator (Playwright + session reuse)
  ingest-upload.mjs       Manual-upload acquisition backend (same manifest)
  validate.mjs            ajv validation of every company ledger vs the schema
  validate-manifest.mjs   Validate an acquisition manifest (keys, bytes, sha256, %PDF)
  gen-index.mjs           Regenerate index.json from committed ledgers
pipeline/output/<ticker>/ Acquisition artifacts (gitignored): manifest.json + raw/*.pdf
```

## Document acquisition (Prompt 2)

Two interchangeable backends fetch transcripts + presentations and write the
**same** `pipeline/output/<ticker>/manifest.json` (mirrors the company schema's
`documents[]`) so downstream stages are source-agnostic:

- **Screener scraper** (`scrape-screener.mjs` + `lib/screener.mjs`): Playwright
  logs in (Django form + persisted `scratchpad/screener-state.json`, reused →
  idempotent), resolves the company, scrapes Concalls with primary selectors and
  a **heading-anchored fallback** (find the "Concalls" heading → its link list)
  so markup drift only needs `lib/screener.mjs` retouched via `EXPLORE=1`.
- **Manual upload** (`ingest-upload.mjs`): reads `pipeline/input/<ticker>/` PDFs
  (`<QUARTER>-<type>.pdf` or an `index.csv`).

Acquisition is **bytes + metadata only** — no PDF→text, no LLM, nothing under
`public/data/`. Quarters use `toFiscalQuarter(date)` = the most-recently-completed
fiscal quarter (an earnings doc dated 31 Jul 2025 reports **Q1FY26**); doc id =
`<quarter-lower>-<type>` (e.g. `q2fy26-transcript`). Failures save a debug
HTML+screenshot under `output/<ticker>/debug/` and exit non-zero. Env knobs and
the egress allowlist live in the README.

- **Datastore = committed JSON** under `public/data/`. No database.
- **Frontend = zero build step.** Libraries load from CDN only: Tailwind Play,
  Google Fonts, Lucide, ECharts 5. No bundler, no frontend npm packages.
- **Worker** serves static assets through the `ASSETS` binding; non-`/api`
  routes fall through to `index.html`. `/api/*` is reserved:
  - `GET /api/health` → `{ ok: true }`
  - `GET /api/company/:ticker` → 501 (served from static JSON until wired up)
  - `GET /api/report/:ticker` → 501 (wired up in a later prompt)
- **Pipeline** scripts are Node ESM `.mjs`. Dependencies are installed
  `--no-save` (e.g. `npm install --no-save ajv ajv-formats`); `node_modules/` is
  gitignored and never committed. Generated ledgers are written under
  `public/data/`, not `pipeline/output/`.

## The data contract (source of truth)

`schema/lie-detector.schema.json` is **the** contract. Every later prompt
reads and writes JSON that conforms to it; if behaviour and schema disagree, the
schema wins (or the schema is changed deliberately, with `npm run validate`
re-run). One object per company. Top-level keys:

- `schema_version`, `company` (`ticker`, `name`, `sector`, `screener_url`,
  `fiscal_year_end`), `generated_at`, `coverage` (`from`/`to`/`as_of`),
  `verification_window`.
- `documents[]` — source docs (`transcript` | `presentation` | `press_release`
  | `annual_report` | `other`), each with `quarter`, `date`, `source`, `role`
  (`guidance` | `actuals` | `both`).
- `promises[]` — the heart of the product. Each promise:
  - `id`, `date`, `quarter_context`, `source_id`, `source_label`
  - `category` (revenue, ebitda, margin, pat, capex, capacity, working_capital,
    leverage, roce, volume, orderbook, timeline, cost, capital_allocation, other)
  - `promise`, `quote` (**≤25 words, verbatim**), `metric`
  - `target` (`text`, `value`, `value_high`, `unit`, `period`)
  - `test_date`, `confidence` (`H` | `M` | `L`)
  - `actual` (`text`, `value`, `unit`, `source_id`, `source_date`, `what_happened`)
  - `status` (`MET` | `PARTIAL` | `MISSED` | `NYT`)
  - `variance` (`absolute`, `pct`, `bps`, `days`, `text`)
  - `mgmt_explanation` (**≤25 words**), `root_cause` (fixed enum)
- `financial_trend[]` — per-quarter `ebitda`, `ebitda_margin`, `revenue`, `pat`,
  `net_debt_ebitda`, `roce`, `unit`.
- `aggregates` — `total`, `status_counts`, `testable`, `by_quarter`,
  `root_causes`, `confidence_mix`, `timeline_commitments`.
- `credibility` — `score`, `grade`, `timeline_score`, `delivery_score`,
  `method`, `headline`.

**NYT = "not yet tested"**: a promise whose `test_date` hasn't passed within the
verification window. NYT promises are *excluded* from scoring — you cannot fail a
test that hasn't happened yet.

### Credibility formula (documented now; implemented for real in Prompt 6)

Confidence-weighted delivery rate over **testable** (non-NYT) promises:

- Outcome weights: `MET = 1`, `PARTIAL = 0.5`, `MISSED = 0`.
- Confidence weights: `H = 1.0`, `M = 0.8`, `L = 0.6`.
- `score = 100 × Σ(conf_weight × outcome) / Σ(conf_weight)` over testable promises.
- Grade bands: **A ≥ 75 · B ≥ 60 · C ≥ 45 · D ≥ 30 · E < 30**.

`public/js/ui.js#gradeFromScore` already encodes these bands for the UI.

## Reference fixture

`public/data/companies/vedl.json` is the **golden fixture** — real Vedanta Ltd
data covering Q1–Q3 FY26 (42 promises: 2 MET / 2 PARTIAL / 8 MISSED / 30 NYT;
credibility 26 / grade E). It already validates against the schema and is the
canonical example of a fully-populated ledger. Treat it as the shape every
generated ledger should match. `index.json` is generated from it via
`node pipeline/gen-index.mjs`.

## Palette (use these exact values)

Mirrored in `ui.js#tokens` and the `:root` CSS variables in `index.html`.

| Group | Tokens |
| --- | --- |
| **Status** | MET `#22C55E` · PARTIAL `#F59E0B` · MISSED `#FB3B53` · NYT `#7C8BB0` |
| **Confidence** | H `#FF4D5E` · M `#FFB020` · L `#7C8BB0` |
| **Accents** | red `#FF4D5E` · gold `#FFB020` · violet `#8B7BFF` · teal `#2DD4BF` · cyan `#38BDF8` |
| **Dark** | ink `#0A0E1A` · ink2 `#0F1626` · card `#161F33` · line `#27324D` · muted `#93A4C7` · text `#E8EEF9` |
| **Light** | bg `#F4F6FB` · text `#0C1426` · card `#FFFFFF` · line `#E4E8F2` |

Formatters: `fmtINRcr(n)` (Indian grouping + " cr", e.g. `₹1,37,529 cr`),
`fmtPct(n)`, `fmtSigned(n)`. Helpers: `statusColor(s)`, `confColor(c)`,
`gradeColor(g)`, `gradeFromScore(score)`. Charts use the dark `echartsTheme`.

## Conventions

- **Dates in IST** (Asia/Kolkata). Quarters are Indian fiscal (FY ends March):
  `Q1FY26` = Apr–Jun 2025, etc.
- **LLM layer is provider-agnostic** (OpenAI-compatible `/chat/completions`).
  Primary provider Gemini; failover order Groq → Cerebras → Mistral → NVIDIA via
  `LLM_FALLBACKS`. Keys come from env/secrets only — never hard-coded, never
  committed. See `pipeline/lib/llm.mjs` (`node pipeline/lib/llm.mjs --selftest`).
- **Money** in ₹ crore unless a promise's `unit` says otherwise (e.g. USD/t,
  kboepd, GW). Don't silently convert units — carry `unit` through.
- **Quotes are verbatim and ≤25 words.** `mgmt_explanation` ≤25 words. If you
  can't quote it, it isn't a promise.
- Keep the home page minimal until the dashboard prompts; prove the contract.

## Commands

```bash
npm run dev           # wrangler dev — serve the site + worker locally
npm run validate      # ajv-validate every public/data/companies/*.json (auto-installs ajv --no-save)
npm run gen:index     # regenerate public/data/companies/index.json
npm run llm:selftest  # print resolved LLM provider/model/baseURL + "config OK" (no key needed)

# Document acquisition (Prompt 2) — needs Playwright + a browser
npm i -D playwright --no-save && npx playwright install chromium
TICKER=VEDL npm run scrape                 # scrape Screener → output/<ticker>/{manifest.json, raw/}
TICKER=VEDL DRY_RUN=1 npm run scrape       # list concalls + URLs, download nothing
TICKER=VEDL EXPLORE=1 npm run scrape       # dump HTML + screenshot + candidate selectors
SOURCE=upload TICKER=test npm run ingest:upload   # manual-upload fallback
npm run validate:manifest VEDL             # validate an acquisition manifest
```

## Roadmap (≈12 prompts)

- [x] **P1 — Foundation.** Scaffold, Worker + static shell, design system, the
      data contract (schema), provider-agnostic LLM client, golden Vedanta
      fixture + `index.json`, `npm run validate`. *(this prompt)*
- [x] **P2 — Document acquisition.** Screener.in lookup + login + Concalls
      scraping (Playwright, drift-resilient selectors, session reuse) and a manual
      upload fallback → `pipeline/output/<ticker>/manifest.json` + raw PDFs.
      Bytes + metadata only. *(this prompt)*
- [ ] **P3 — Parsing.** PDF / transcript text extraction, cleanup and chunking.
- [ ] **P4 — LLM hardening.** Confirm live provider models/limits, prompt
      scaffolding, structured-output plumbing on top of `completeJSON`.
- [ ] **P5 — Promise extraction.** Pull measurable commitments → `promises[]`
      (`promise`, `quote`, `metric`, `target`, `confidence`, `category`).
- [ ] **P6 — Verification & credibility.** Match promises to actuals; assign
      `status`/`variance`/`root_cause`; compute `aggregates` and the real
      `credibility` score/grade.
- [ ] **P7 — Dashboard shell.** Company route, header, search, credibility hero.
- [ ] **P8 — Charts.** Status donut, slippage/timeline, financial-trend
      (ECharts, dark theme).
- [ ] **P9 — Track-record cards + master promise table.** Filter / sort / drill.
- [ ] **P10 — PDF export.** Polished, multi-page report.
- [ ] **P11 — Pipeline orchestration + multi-company.** Batch build, caching,
      `index.json` at scale.
- [ ] **P12 — Polish / QA / deploy.** A11y, performance, Cloudflare deploy.

## Do / Don't (P1)

- **Do** keep everything schema-valid (`npm run validate` must pass) and keep
  the home page minimal.
- **Don't** add scraping, PDF parsing, live LLM calls, charts, or PDF export yet
  — those are P2–P11. No LLM calls run during build/validate.
