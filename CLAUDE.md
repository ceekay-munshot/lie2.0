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
  index.html              Shell: design-system <style>, boot loader, header, OG/favicon
  js/ui.js                Design system: tokens, colour helpers, formatters, escapeHTML,
                          provenanceBadge (honesty guard), ECharts theme, loadCompany/loadIndex
  js/app.js               Shell + router: home (hero search + company grid) ↔ company view
  js/lib/router.js        ?c=<ticker> query-param router (shareable URLs, back/fwd)
  js/lib/fiscal.js        Browser fiscal-quarter math (periodIndex/maxPeriodIndex/quarterLabel)
  js/lib/echarts.js       Lazy-load ECharts + dark theme; mountChart (loading/empty/offline states)
  js/components/search.js Company search autocomplete (fuzzy, keyboard nav, request CTA)
  js/components/credibility-hero.js  Score ring + delivery-vs-timeline split + status mix + provenance badge
  js/components/kpi-strip.js         Promises/testable/MET/PARTIAL/MISSED/NYT + credibility chips
  js/components/charts/   5 ECharts panels: status-donut · slippage-timeline · by-quarter · root-cause · momentum
  js/components/filter-bar.js        Shared filter store + controls (status/category/quarter/conf/search)
  js/components/track-record-cards.js  Worst-first testable verdict cards (#track-record)
  js/components/promise-table.js     13-column master ledger table (sortable/paginated, frozen Promise col)
  js/components/promise-drill.js     Per-promise evidence modal (verbatim quote receipt; focus-trap/ESC)
  js/views/company.js     Company view: header search · hero · KPI strip · #charts · #track-record · #table · #export
  data/companies/
    <ticker>.json         One ledger per company (validated against the schema)
    index.json            Generated card-sized summaries for the home page
  reports/<ticker>.pdf    Pre-built exportable PDF report (committed; the Export button serves it)
pipeline/                 Node ESM (.mjs) build/verify scripts (run locally)
  lib/llm.mjs             Provider-agnostic, OpenAI-compatible LLM client
  lib/manifest.mjs        Acquisition contract: fiscal-quarter, sha256, %PDF, paths
  lib/screener.mjs        Screener resolve/login/scrape (+ drift-resilient selectors)
  lib/pdftext.mjs         PDF → per-page text (unpdf); flags needs_ocr, never crashes
  lib/detect.mjs          Filename-agnostic {type,quarter,date} from PDF text
  lib/normalize-text.mjs  De-boilerplate, transcript turns + roles, presentation slides
  lib/chunk.mjs           Token-bounded, overlapping, no-mid-turn chunking
  scrape-screener.mjs     Screener acquisition orchestrator (Playwright + session reuse)
  ingest-upload.mjs       Manual-upload backend (content-detected, filename-agnostic)
  ingest.mjs              Manifest PDFs → corpus.json (extract→normalize→tag→chunk)
  validate.mjs            ajv validation of every company ledger vs the schema
  validate-manifest.mjs   Validate an acquisition manifest (keys, bytes, sha256, %PDF)
  validate-corpus.mjs     Validate a corpus (chunks ≤ cap, no boilerplate, roles)
  gen-index.mjs           Regenerate index.json from committed ledgers
  test/p3.test.mjs        Ingestion unit tests (normalizer / chunker / needs_ocr)
  lib/extract-prompt.mjs  Extraction system prompt + JSON schema (rubric, few-shots)
  lib/multi-llm.mjs       Ensemble/partition/single runner (per-provider concurrency, degrade)
  lib/ground-quote.mjs    Verbatim quote grounding (substring → snap → drop)
  lib/dedup.mjs           Cross-model merge (found_by), reaffirmed_on, revisions, ids
  lib/test-date.mjs       deriveTestDate from a target period
  extract.mjs             Extraction engine: corpus → promises.json (FIRST LLM step)
  eval-extraction.mjs     Recall vs the golden fixture (fuzzy/semantic matcher); also
                          a standalone CLI: node eval-extraction.mjs <promises.json> [ticker]
  test/p4.test.mjs        Extraction unit tests (mock LLM)
  lib/metric-direction.mjs Category→direction (higher/lower/timeline/target); target+actual parse
  lib/fiscal.mjs          Fiscal period index (QnFY/FY/nHFY/calendar→fy*4+q) + period maths
  lib/verification-window.mjs  Latest-reported window from newest doc; isNotYetTestable
  lib/status-variance.mjs THE VERDICT: deterministic status/variance + integrity rule (NO LLM)
  lib/find-actual.mjs     Retrieve the reported actual from later docs (the ONLY LLM verify step)
  lib/financial-trend.mjs Per-quarter reported headline financials (one cached LLM call/quarter)
  lib/aggregate.mjs       aggregates + credibility score/grade/headline (deterministic formula)
  verify.mjs              Verification orchestrator: promises.json → scored ledger (SECOND LLM step)
  eval-verification.mjs   Data-verifier: align engine↔golden, status agreement, newly_resolved/extra
  test/p5.test.mjs        Verification unit tests (status/variance, integrity, credibility banding)
  lib/report-template.mjs ledger → self-contained multi-page A4 report HTML (inline-SVG charts, no CDN)
  build-report.mjs        Render the report HTML → public/reports/<ticker>.pdf (headless Chromium)
fixtures/<ticker>.corpus.json  Committed corpus for CI extract+verify (recall eval; NOT gitignored)
fixtures/<ticker>.golden.json  Committed golden ledger — the verification eval target (NOT gitignored)
pipeline/output/<ticker>/ Acquisition + corpus + promises + ledger artifacts (gitignored): manifest.json,
                          raw/*.pdf, corpus.json, promises.json, cache/{extract,verify}/
```

## PDF export (Prompt 9)

One click turns a committed ledger into a **polished, multi-page A4-landscape PDF** — the
shareable artifact the whole product builds toward. The report is **pre-built by the
pipeline** (not rendered in the browser) and committed to `public/reports/<ticker>.pdf`; the
dashboard's Export button (`#export`) simply downloads it.

- **`lib/report-template.mjs`** (`reportHTML(ledger)`) — a Node port of the approved
  reference: **one self-contained HTML string** (no CDN/external assets,
  `print-color-adjust:exact`, **inline-SVG** donut/bars/gantt/momentum charts) laid out as
  cover · executive dashboard · slippage & momentum · track-record cards · master table ·
  methodology. Parametrised **entirely** from `<ticker>.json` — no company/ticker/sector/
  number is hardcoded — and null-safe (a panel hides when its data is absent). Reuses the
  dashboard's palette, 13-column order and worst-first cards, so screen and paper agree.
- **`build-report.mjs`** (`npm run report`) — reads the ledger, builds the HTML, renders it
  to `public/reports/<ticker>.pdf` with the repo's **headless Chromium** (Playwright
  `page.pdf`, landscape, `printBackground`, `preferCSSPageSize`); prints page count + provenance.
- **Export button** (`js/views/company.js#mountExport`) — HEAD-checks `/reports/<ticker>.pdf`:
  present → a "Download PDF report" button; absent → a graceful "not generated yet — run
  `TICKER=x npm run report`" note.

**The provenance honesty rule extends to paper (this prompt's safety goal): a PDF travels
further than the dashboard, so it must never pass a non-real verdict as authoritative.**
`build-report.mjs` **REFUSES** a `mode:mock` or incomplete-live ledger by default (exit 1);
`FORCE=1` builds a **watermarked** copy (diagonal "MOCK — NOT A REAL VERDICT" / "PROVISIONAL
— INCOMPLETE RETRIEVAL" overlay + a cover banner) for inspection only. `report-template.mjs`'s
`provInfo` mirrors `ui.js#provenanceBadge`: complete-live → clean · mock → red watermark +
banner · `!complete` → amber watermark + banner · manual → a grey "Curated" note. The CI
workflow (`build-report.yml`) goes further — it commits the PDF **only when the ledger is a
real verdict**; a force-built watermarked copy is uploaded as an artifact but never committed,
so `public/reports/` can only ever hold honest reports.

In-session: `TICKER=vedl npm run report` (the 9-page golden PDF) + the refuse-guard and both
watermark paths exercised; `npm run validate` is unaffected (no schema change).

## Track record + master table + drill (Prompt 8)

Fills `#track-record` and `#table` — the drill-down detail under the hero/charts. Cards,
table and a per-promise evidence modal all read `promises[]` of any `<ticker>.json`,
null-safe (NYT promises have no actual/variance/explanation). The on-screen dashboard
now has everything the PDF will (P9 reuses this exact layout + column order).

- **`filter-bar.js`** — one shared filter store (status chips · category · quarter ·
  confidence · free-text over promise/metric/quote), removable active chips + clear-all.
  Both the cards and the table subscribe, so filtering one filters the other.
- **`track-record-cards.js`** (`#track-record`) — TESTABLE promises (status ≠ NYT),
  **worst-first** (MISSED → PARTIAL → MET): a status-coloured left-border card with
  Target/Actual/Variance + mgmt_explanation + root-cause chip. All-NYT → "N awaiting
  their test date" empty state; "X of Y testable" header respects the filter.
- **`promise-table.js`** (`#table`) — ALL filtered promises in the strict 13-column order
  (Date · Qtr · Source · Promise · Quote · Metric+Target · Test Date · Conf · What
  Happened · Status · Variance · Mgmt Explanation · Root-Cause), status pills + conf
  badges, a **frozen Promise column**, sortable headers (date/quarter/confidence/
  status-severity/variance), and pagination for long ledgers.
- **`promise-drill.js`** — the integrity layer: a modal showing the **verbatim,
  quote-grounded receipt** + source doc/date (copyable), the actual + source, the
  variance, the explanation, any guidance revisions (`was_revised`), and provenance chips
  (`found_by`/`figure_in_quote`/confidence — rendered only when present). Focus-trap +
  ESC + focus-restore to the trigger; scroll-lock with no leak.

Read-only (no schema change). In-session: `npm run validate` + a Playwright pass (cards
worst-first · 13-col table · filter both + filter-to-zero · sort · drill open/ESC/restore
· all-NYT + null-safe NYT rows · zero console errors).

## Charts (Prompt 7)

Fills the company view's `#charts` anchor with **five ECharts panels driven entirely by
the ledger** (`js/components/charts/`), matching the PDF report's aesthetic. ECharts is
**lazy-loaded** on the company view (`js/lib/echarts.js`); every panel goes through
`mountChart`, which shows a loading state, an empty state (builder returns null), or a
graceful **"charts unavailable offline"** note if the CDN is blocked — it never throws.
Generic + null-safe: panels read `aggregates` / `financial_trend` / `promises` of any
`<ticker>.json` and self-hide when their data is absent.

- **slippage-timeline** (the signature) — a floating bar per timeline promise from the
  **PROMISED** quarter (amber dot, parsed from the commitment text via `lib/fiscal.js#maxPeriodIndex`)
  to the **RE-SET/actual** quarter (red dot, parsed from the retrieved actual's wording, e.g.
  "re-set to 1HFY27"), coloured by status. Empty state when nothing slipped.
- **status-donut** — MET/PARTIAL/MISSED/NYT from `status_counts`, total in the centre.
- **by-quarter** — stacked status bars from `aggregates.by_quarter`.
- **root-cause** — horizontal bars from `aggregates.root_causes` (hidden if empty).
- **momentum** — EBITDA columns + margin line from `financial_trend`, with a net-debt/EBITDA ·
  ROCE · revenue stat trio (panel hidden entirely if `financial_trend` is empty).

Charts are read-only (no schema change). Resize-aware (ResizeObserver). In-session: `npm
run validate` + a Playwright pass (render with ECharts served locally · offline-degrade ·
empty/hidden states · zero console errors).

## Dashboard shell (Prompt 6)

The **first UI**: it turns a committed `<ticker>.json` ledger into a screen.
Framework-free (vanilla ES modules + the P1 design system), zero build step.

- **Routing** (`js/lib/router.js`) — the company in view is the `?c=<ticker>` query
  param (no param = home). History API → shareable URLs + back/forward. `app.js` is
  the shell: it swaps `<main id="app">` between the home view (hero search + a grid
  of covered companies from `index.json`) and the company view.
- **Search** (`js/components/search.js`) — index-driven autocomplete: fuzzy match on
  ticker/name/sector, full keyboard nav (↑↓/Enter/Esc), grade chip per result, and a
  "Request this company" CTA on no-match (stub; P10 wires the dispatch).
- **Credibility hero** (`js/components/credibility-hero.js`) — score ring (grade-banded
  colour), the deterministic headline, the **DELIVERY-vs-TIMELINE split** (the product's
  signature insight — "hits its numbers, misses its deadlines" — two grade-coloured
  bars from `delivery_score`/`timeline_score`), a compact status-mix bar, and a meta row.
- **KPI strip** (`js/components/kpi-strip.js`) — Promises · Testable · MET · PARTIAL ·
  MISSED · NYT (status-coloured) + the credibility score/grade.
- **Company view** (`js/views/company.js`) — composes header search · hero · KPI strip ·
  anchored placeholders (`#charts` `#track-record` `#table` `#export`) that P7–P9 fill;
  loading skeleton + a graceful "no ledger — request it" on an unknown ticker.

**The provenance guard (this prompt's safety goal): never present a mock or
quota-truncated ledger as a real verdict.** `verify.mjs` stamps `provenance`
(`mode` live/mock/manual · `complete` · `retrieval_errors` · `forced_nyt` =
due-but-unverified promises · `models_used` · `run_id`); `ui.js#provenanceBadge`
(pure, unit-tested) maps it to a badge + a `disclaim` flag the hero honours:
**complete live → green "Live · complete"; `mode:mock` → red "Mock data — not a
real verdict" (ring dimmed + disclaimer); `!complete` → amber "Provisional —
incomplete retrieval"; manual → grey "Curated".** The committed `vedl.json` is the
curated golden (grey); a real incomplete live run shows amber automatically. No
company/ticker/sector is hardcoded — the UI renders any `<ticker>.json`.

In-session: `npm run test:ui` (provenance-guard unit test) + a Playwright pass
(home/company/badges/unknown-ticker, zero console errors) + `npm run validate`.

## Verification & credibility (Prompt 5)

`verify.mjs` is the second (and last) LLM step: it turns `promises.json` +
`corpus.json` into the **final schema-valid ledger**
(`public/data/companies/<ticker>.json`) the dashboard renders.

**The load-bearing principle: the LLM ONLY RETRIEVES; the RULES decide.** For each
promise, `find-actual.mjs` reads *later* documents and reports the *reported
actual* + (for a shortfall) management's stated reason and a root-cause label — it
**never** decides MET/MISSED. `status`, `variance`, the aggregates and the
credibility score are **deterministic, reproducible, unit-tested rules**
(`status-variance.mjs`, `aggregate.mjs`) keyed only on the schema `category`'s
direction. Same inputs → same verdict, every time; nothing is a black box. Generic
by construction — **no company/ticker/sector/metric is ever hardcoded**; the only
inputs are `category` + the target/actual numbers and wording.

Pipeline (all but step 2 is deterministic):
1. **verification window** (`verification-window.mjs`) — newest dated doc sets
   `latest_reported`; a `test_date` after it ⇒ NYT.
2. **retrieve actuals** (`find-actual.mjs`, the ONLY LLM call) — evidence = later
   docs whose sections overlap the promise subject; one structured, cached call
   per promise; mock-aware ($0 canned actuals from the evidence).
3. **verdict** (`status-variance.mjs`):
   - **NYT** — no usable actual, or `test_date` still future (interim figure vs an
     annual target). NYT is *excluded* from scoring.
   - **MET / PARTIAL / MISSED** — meets/beats target on its favourable side
     (direction from `metric-direction.mjs`: higher/lower/range); just on the wrong
     side within `PARTIAL_TOL` ⇒ PARTIAL; clearly short ⇒ MISSED. **Timeline**:
     delivered on time ⇒ MET, slipped ≤ `TIMELINE_GRACE_QTRS` ⇒ PARTIAL, slipped
     further — **including when the company's own later disclosure re-guides the date
     past the window** ⇒ MISSED (`fiscal.mjs` indexes QnFY/FY/nHFY periods).
   - **Integrity rule** — if `revisions[]` exist, judge vs the **original** target
     (the extractor preserves it) and flag `was_revised`, so a quietly-cut-then-
     "met" number still reads as a miss.
4. **financial trend** (`financial-trend.mjs`) — one cached LLM call per
   presentation pulls reported headline financials → `financial_trend[]`.
5. **aggregates + credibility** (`aggregate.mjs`) — confidence-weighted delivery
   over **testable** promises: `MET=1/PARTIAL=0.5/MISSED=0`, `H=1.0/M=0.8/L=0.6`;
   `score = 100 × Σ(conf×outcome)/Σ(conf)`; bands A≥75 B≥60 C≥45 D≥30 E<30. The
   headline is a deterministic template — it never invents a figure.

`eval-verification.mjs` is the **data-verifier**: it aligns the engine ledger to
the golden fixture (lexical fuzzy match, then an LLM that judges *matching* only —
never a verdict), and reports recall, status agreement, a confusion matrix, the
credibility delta, `newly_resolved[]` (golden-NYTs a later doc has since closed —
the committed corpus runs one quarter past the golden window, so this is expected,
not a disagreement) and `extra[]` (over-extraction). In-session: `npm run
test:verify` (deterministic) + `PROVIDER=mock npm run verify` ($0, writes a
schema-valid ledger; `npm run validate` passes). **Keys live only in GitHub
Secrets** → the live retrieval is CI-only (`test-verify.yml`, `workflow_dispatch`).

**Env knobs:** `TICKER` · `CORPUS=<path>` · `PROMISES=<path>` (else extract is run
first) · `PARTIAL_TOL` (0.05) · `TIMELINE_GRACE_QTRS` (1) · `PROVIDER=mock`/`MOCK=1`
· `EXTRACTION_ORDER` (retrieval provider priority) · `LLM_CONCURRENCY` (2) · `EVAL`
(1) · `LIMIT` · `DEBUG`.

## Extraction engine (Prompt 4)

`extract.mjs` is the first LLM step: it reads `corpus.json` and uses Gemini + Groq
+ Mistral (all free-tier) to pull **measurable management commitments** →
`pipeline/output/<ticker>/promises.json`. By default the three keys are a single
quota pool used in **failover** order (not all-three-on-every-doc), to conserve
free tiers.

Company-agnostic: never hardcode a metric set — models return whatever measurable
guidance the company gives (bank→NIM/GNPA, IT→margin/TCV, metals→cost/capacity).
Per doc the engine builds **management-only** text (prepared remarks in full +
the *guidance-bearing* management Q&A answers — operational Q&A chatter is
pre-filtered out via `QA_FILTER`, ~half the Q&A turns — with the preceding analyst
Q kept inline as `[context]`), calls each provider with the same rubric+schema
(`extract-prompt.mjs`), then: grounds every quote to a verbatim substring
(snap-or-drop — `ground-quote.mjs`), cross-model-merges + dedups (`dedup.mjs`:
`found_by` ≥2 = agreement, `reaffirmed_on`/`revisions` across quarters), and
derives `test_date` (`test-date.mjs`), a stable `promise_key` (`category|period|
metric-subject`, so the downstream verifier can group restatements), and a lenient
`figure_in_quote` flag (numeric target whose quote lacks any figure → flagged, not
dropped). `eval-extraction.mjs` scores recall vs the fixture. **No verification/
status/variance here — that's Prompt 5.**

Strategies (`LLM_STRATEGY`):
- **`failover` (default)** — treat the three free tiers as ONE combined quota pool,
  used in priority order (set by `EXTRACTION_ORDER`; **default Mistral → Gemini →
  Groq** while Gemini's free-tier key is quota-exhausted — flip back to
  `gemini,groq,mistral` once it's healthy). Each doc is extracted **once**, by the
  first provider with budget; a provider that hits its per-day quota is dropped for
  the remaining docs. A 6-doc corpus = ~6 calls, all on the lead provider (the rest
  held in reserve) — no redundant work, no 3× quota burn.
- `ensemble` — every doc × all 3 (≈ docs×3 calls) for max recall + cross-model
  agreement. Use only when you have quota to spare.
- `partition` — round-robin docs across providers (~1/3 each). `single` — one (debug).

Per (doc×model) caching makes re-runs ~free. **Accuracy is NOT pursued via
cross-model agreement** — that's deferred to a dedicated data-verification step
once the full dataset is wired; extraction just needs to surface the commitments
cheaply.

**Keys live only in GitHub Secrets** → the live run is CI-only
(`.github/workflows/test-extract.yml`, `workflow_dispatch`). In-session: build +
`DRY_RUN=1` (estimates calls/tokens) + mock-LLM unit tests.

### Confirmed free-tier models (June 2026)

| Provider | Default model (env override) | Free-tier limits |
| --- | --- | --- |
| Gemini | `gemini-2.5-flash` (`GEMINI_MODEL`) | 10 RPM · ~250K TPM · 1,500 RPD; free tier = Flash/Flash-Lite |
| Groq | `llama-3.3-70b-versatile` (`GROQ_MODEL`) | 30 RPM · 12K TPM · **100K tokens/day** · 1,000 RPD |
| Mistral | `mistral-large-latest` (`MISTRAL_MODEL`) | free "Experiment" tier, all models, RPS/TPM-limited, ~1B tok/mo |

**Provider quirks (handled in code):**
- **Gemini** uses `json_object` response_format (its OpenAI-compat endpoint is
  flaky with `json_schema`; `completeJSON` also auto-falls-back json_schema →
  json_object on a 4xx). Output cap is generous (16K) so a long doc's JSON isn't
  truncated; schema enforced by ajv + the repair retry regardless.
- **Groq** has two binding free-tier limits: **12K TPM** (so `extract.mjs`
  **segments** each doc to `maxInputTokens` − prompt overhead per call → ~2
  calls/doc) and **100K tokens/day**, which a ~70K-token corpus exhausts in about
  one ensemble pass. A per-MINUTE 429 backs off and retries; a per-DAY/quota 429
  (`isDailyLimit`) **fails fast** (no wasted retries) and the ensemble continues
  on Gemini+Mistral. For repeated runs the same day, use `partition` or unset
  `GROQ_API_KEY`; Groq's TPD resets at midnight UTC.

Default failover over a ~6-doc corpus ≈ 6 calls (all Gemini; Groq/Mistral held in
reserve). Ensemble (opt-in) ≈ 24 calls — 3× the quota. Under ensemble/partition a
provider that contributes 0 is flagged as a degraded run; under failover, untouched
providers are normal (reported as "held in reserve").

## Ingestion & normalization (Prompt 3)

`ingest.mjs` turns a manifest's PDFs into `pipeline/output/<ticker>/corpus.json`
— the clean, tagged, chunked input Prompt 4 mines for promises. **Deterministic
& offline: no LLM, no OCR.** Per doc: `pdftext` extracts per-page text →
`normalize-text` de-boilerplates (lines on ≥40% of pages, "Page X of Y",
"Sensitivity: …", de-hyphenation) and tags structure (transcript speaker turns
with roster-based roles + prepared_remarks/qa; presentation slides with titles +
`is_guidance`) → `chunk` emits ≤`CHUNK_TOKENS` (1500) overlapping chunks that
never split mid-turn. No-text PDFs → `needs_ocr:true` (flagged, run continues).

The **upload backend is filename-agnostic** (P3 upgrade): real downloads have
arbitrary names, so `ingest-upload.mjs` reads page-1 text and detects
`{type,quarter,date}` via `lib/detect.mjs` (an optional `index.csv` overrides).
`npm run validate:corpus` gates the result.

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
- `provenance` (optional) — `mode` (`live`|`mock`|`manual`), `complete`,
  `retrieval_errors`, `forced_nyt`, `models_used`, `generated_at`, `run_id`. The
  honesty stamp the dashboard badges (P6); `verify.mjs` populates it.

**NYT = "not yet tested"**: a promise whose `test_date` hasn't passed within the
verification window. NYT promises are *excluded* from scoring — you cannot fail a
test that hasn't happened yet.

### Credibility formula (implemented in Prompt 5 — `pipeline/lib/aggregate.mjs`)

Confidence-weighted delivery rate over **testable** (non-NYT) promises:

- Outcome weights: `MET = 1`, `PARTIAL = 0.5`, `MISSED = 0`.
- Confidence weights: `H = 1.0`, `M = 0.8`, `L = 0.6`.
- `score = 100 × Σ(conf_weight × outcome) / Σ(conf_weight)` over testable promises.
- Grade bands: **A ≥ 75 · B ≥ 60 · C ≥ 45 · D ≥ 30 · E < 30**.

`aggregate.mjs#credibility` computes it; `public/js/ui.js#gradeFromScore` encodes
the same bands for the UI. P5 unit tests reproduce the banding on hand-fed inputs.

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
npm run dev           # wrangler dev — serve the site + worker locally (home → ?c=<ticker> dashboard)
npm run validate      # ajv-validate every public/data/companies/*.json (auto-installs ajv --no-save)
npm run gen:index     # regenerate public/data/companies/index.json
npm run test:ui       # provenance-guard unit test (mock/incomplete never reads as a real verdict)
npm run llm:selftest  # print resolved LLM provider/model/baseURL + "config OK" (no key needed)

# Document acquisition (Prompt 2) — needs Playwright + a browser
npm i -D playwright --no-save && npx playwright install chromium
TICKER=VEDL npm run scrape                 # scrape Screener → output/<ticker>/{manifest.json, raw/}
TICKER=VEDL DRY_RUN=1 npm run scrape       # list concalls + URLs, download nothing
TICKER=VEDL EXPLORE=1 npm run scrape       # dump HTML + screenshot + candidate selectors
SOURCE=upload TICKER=test npm run ingest:upload   # manual-upload fallback
npm run validate:manifest VEDL             # validate an acquisition manifest

# Ingestion & normalization (Prompt 3) — needs unpdf
npm i -D unpdf --no-save
SOURCE=upload TICKER=vedl npm run ingest:upload   # filename-agnostic content detection
TICKER=vedl npm run ingest                  # manifest PDFs → output/<ticker>/corpus.json
npm run validate:corpus vedl                # chunks ≤ cap, no boilerplate, roles OK
npm run test:ingest                         # normalizer / chunker / needs_ocr unit tests

# Extraction engine (Prompt 4) — first LLM step; keys via env/secrets only
DRY_RUN=1 TICKER=vedl npm run extract        # estimate calls/tokens (ensemble → docs×3), no API
npm run test:extract                         # mock-LLM unit tests (merge/ground/dedup/test-date)
# live ensemble runs in CI (test-extract.yml) with GEMINI/GROQ/MISTRAL_API_KEY secrets:
CORPUS=pipeline/fixtures/vedl.corpus.json TICKER=vedl LLM_STRATEGY=ensemble npm run extract

# Verification & credibility (Prompt 5) — second LLM step (RETRIEVES; rules decide)
npm run test:verify                          # deterministic unit tests (status/variance/credibility)
PROVIDER=mock TICKER=vedl npm run verify     # $0 full extract→verify; writes a schema-valid ledger
npm run validate                             # the engine's ledger validates against the contract
# live retrieval runs in CI (test-verify.yml) with GEMINI/GROQ/MISTRAL_API_KEY secrets:
CORPUS=pipeline/fixtures/vedl.corpus.json TICKER=vedl npm run verify
npm run eval:verify public/data/companies/vedl.json pipeline/fixtures/vedl.golden.json  # data-verifier CLI

# PDF export (Prompt 9) — needs Playwright + a browser; no LLM, no secrets
npm i -D playwright --no-save && npx playwright install chromium
TICKER=vedl npm run report                   # ledger → public/reports/vedl.pdf (headless Chromium)
FORCE=1 TICKER=vedl npm run report           # watermarked copy of a mock/provisional ledger (inspection only)
# commit-on-real-verdict-only build runs in CI (build-report.yml, workflow_dispatch: ticker + force)
```

## Roadmap (≈12 prompts)

- [x] **P1 — Foundation.** Scaffold, Worker + static shell, design system, the
      data contract (schema), provider-agnostic LLM client, golden Vedanta
      fixture + `index.json`, `npm run validate`. *(this prompt)*
- [x] **P2 — Document acquisition.** Screener.in lookup + login + Concalls
      scraping (Playwright, drift-resilient selectors, session reuse) and a manual
      upload fallback → `pipeline/output/<ticker>/manifest.json` + raw PDFs.
      Bytes + metadata only. *(this prompt)*
- [x] **P3 — Ingestion & normalization.** PDF→text (unpdf), de-boilerplate,
      transcript speaker-turn + role tagging, presentation slides + guidance
      flags, citable chunking → `corpus.json`; upload backend made
      filename-agnostic via content detection. Deterministic & offline. *(this prompt)*
- [x] **P4 — Extraction engine.** Ensemble (Gemini+Groq+Mistral, all first-class)
      → measurable management promises in `promises.json`: rubric prompt +
      structured output on `completeJSON`, verbatim quote grounding, cross-model
      merge (`found_by`/`reaffirmed_on`/`revisions`), `deriveTestDate`, recall
      eval. Build + DRY_RUN + mock tests in-session; live run is CI-only. *(this prompt)*
- [x] **P5 — Verification & credibility.** Retrieve each reported actual from later
      docs (LLM retrieves only — `find-actual.mjs`); assign `status`/`variance`/
      `root_cause` and compute `aggregates` + the real `credibility` score/grade by
      **deterministic rules** (`status-variance.mjs`, `aggregate.mjs`) — the model
      never decides pass/fail. Data-verifier eval vs the golden, $0 mock + unit tests
      in-session, live run CI-only. *(this prompt)*
- [x] **P6 — Dashboard shell.** First UI: `?c=<ticker>` router, header + company
      search (autocomplete, keyboard nav), and the credibility hero (score ring,
      delivery-vs-timeline split, status mix) + KPI strip rendered from the ledger.
      **Provenance guard** stamps + badges mock/incomplete data so a truncated run
      never reads as a real verdict. Vanilla, schema-valid, browser-verified. *(this prompt)*
- [x] **P7 — Charts.** Five ledger-driven ECharts panels fill `#charts`: status donut,
      the **slippage timeline** (promised→re-set, the signature), by-quarter stacked bars,
      root-cause bars, financial momentum (EBITDA/margin + leverage/ROCE). Lazy-loaded with
      a graceful offline-degrade; null-safe + responsive. Browser-verified. *(this prompt)*
- [x] **P8 — Track-record cards + master promise table.** Worst-first verdict cards
      (`#track-record`), the 13-column sortable/paginated master table (`#table`, frozen
      Promise column), a shared filter bar (status/category/quarter/conf/search), and a
      per-promise **drill modal** (the verbatim-quote receipt — every verdict auditable;
      focus-trap/ESC/restore). Null-safe, browser-verified. *(this prompt)*
- [x] **P9 — PDF export.** One-click polished, **multi-page A4 PDF** pre-built by the
      pipeline (`report-template.mjs` → self-contained inline-SVG HTML → headless Chromium
      `build-report.mjs`) and committed to `public/reports/<ticker>.pdf`; the dashboard's
      Export button downloads it. Company-agnostic from the ledger; the **provenance honesty
      rule** extends to paper — mock/provisional reports are watermarked and never committed
      (CI commits only a real verdict). Browser-verified. *(this prompt)*
- [ ] **P10 — Pipeline orchestration + multi-company.** Batch build, caching,
      `index.json` at scale.
- [ ] **P11 — Polish / QA / deploy.** A11y, performance, Cloudflare deploy.

## Do / Don't (P1)

- **Do** keep everything schema-valid (`npm run validate` must pass) and keep
  the home page minimal.
- **Don't** add scraping, PDF parsing, live LLM calls, charts, or PDF export yet
  — those are P2–P11. No LLM calls run during build/validate.
