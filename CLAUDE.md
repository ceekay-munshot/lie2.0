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
  eval-extraction.mjs     Recall of extracted promises vs the golden fixture
  test/p4.test.mjs        Extraction unit tests (mock LLM)
fixtures/<ticker>.corpus.json  Committed corpus for CI extraction (recall eval; NOT gitignored)
pipeline/output/<ticker>/ Acquisition + corpus + promises artifacts (gitignored): manifest.json,
                          raw/*.pdf, corpus.json, promises.json, cache/extract/
```

## Extraction engine (Prompt 4)

`extract.mjs` is the first LLM step: it reads `corpus.json` and uses Gemini + Groq
+ Mistral (all free-tier) to pull **measurable management commitments** →
`pipeline/output/<ticker>/promises.json`. By default the three keys are a single
quota pool used in **failover** order (not all-three-on-every-doc), to conserve
free tiers.

Company-agnostic: never hardcode a metric set — models return whatever measurable
guidance the company gives (bank→NIM/GNPA, IT→margin/TCV, metals→cost/capacity).
Per doc the engine builds **management-only** text (prepared remarks + management
answers, the preceding analyst Q kept inline as `[context]`), calls each provider
with the same rubric+schema (`extract-prompt.mjs`), then: grounds every quote to a
verbatim substring (snap-or-drop — `ground-quote.mjs`), cross-model-merges +
dedups (`dedup.mjs`: `found_by` ≥2 = agreement, `reaffirmed_on`/`revisions` across
quarters), and derives `test_date` (`test-date.mjs`). `eval-extraction.mjs` scores
recall vs the fixture. **No verification/status/variance here — that's Prompt 5.**

Strategies (`LLM_STRATEGY`):
- **`failover` (default)** — treat the three free tiers as ONE combined quota pool,
  used in priority order (Gemini → Groq → Mistral). Each doc is extracted **once**,
  by the first provider with budget; a provider that hits its per-day quota is
  dropped for the remaining docs. A 6-doc corpus = ~6 calls, all Gemini (Groq/
  Mistral held in reserve) — no redundant work, no 3× quota burn.
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
- [ ] **P5 — Verification & credibility.** Match promises to actuals; assign
      `status`/`variance`/`root_cause`; compute `aggregates` and the real
      `credibility` score/grade.
- [ ] **P6 — Dashboard shell.** Company route, header, search, credibility hero.
- [ ] **P7 — Charts.** Status donut, slippage/timeline, financial-trend
      (ECharts, dark theme).
- [ ] **P8 — Track-record cards + master promise table.** Filter / sort / drill.
- [ ] **P9 — PDF export.** Polished, multi-page report.
- [ ] **P10 — Pipeline orchestration + multi-company.** Batch build, caching,
      `index.json` at scale.
- [ ] **P11 — Polish / QA / deploy.** A11y, performance, Cloudflare deploy.

## Do / Don't (P1)

- **Do** keep everything schema-valid (`npm run validate` must pass) and keep
  the home page minimal.
- **Don't** add scraping, PDF parsing, live LLM calls, charts, or PDF export yet
  — those are P2–P11. No LLM calls run during build/validate.
