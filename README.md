# Lie Detector

> Do Indian management teams keep their promises?

A static dashboard that, for any Indian listed company, extracts every
**measurable** management commitment from its earnings-call transcripts and
investor presentations, verifies each against later reported actuals, scores
delivery reliability, and exports a polished multi-page PDF.

**Search a company → dashboard** (credibility score, status donut, slippage
timeline, track-record cards, master promise table) **→ Export PDF.**

This repo is being built in ~12 prompts. **Status: Prompts 1–9 complete** — the
foundation, document acquisition, ingestion & normalization, the extraction
engine, **verification & credibility** (promises scored into the final ledger, the
LLM retrieving while deterministic rules decide), the **dashboard** (search → a
credibility hero with a provenance guard, five ledger-driven charts incl. the
signature promised→re-set **slippage timeline**), the **track-record cards +
13-column master table + per-promise drill modal** — every verdict auditable down to
its verbatim, quote-grounded receipt — and now **one-click PDF export**: a polished,
multi-page A4 report pre-built by the pipeline (headless Chromium) and committed to
`public/reports/`, where the dashboard's Export button serves it. Multi-company
automation lands in later prompts. See [`CLAUDE.md`](./CLAUDE.md) for architecture,
the data contract and the roadmap.

## Stack

- **Static site, zero build step.** `public/` loads everything from CDN
  (Tailwind Play, Google Fonts, Lucide, ECharts 5) — no bundler, no frontend npm.
- **Cloudflare Worker** (`worker/index.js`) serves assets via the `ASSETS`
  binding and reserves `/api/*` for later.
- **Datastore = committed JSON** under `public/data/`. No database.
- **Pipeline** = Node ESM `.mjs` under `pipeline/`; deps installed `--no-save`,
  `node_modules/` gitignored.
- **LLM layer** is provider-agnostic (OpenAI-compatible): primary Gemini, with
  Groq / Cerebras / Mistral / NVIDIA failover. Keys via env/secrets only.

## Quickstart

```bash
# 1. Run the site + Worker locally
npx wrangler dev            # → http://127.0.0.1:8787

# 2. Validate every company ledger against the JSON Schema
npm run validate            # auto-installs ajv + ajv-formats --no-save

# 3. Check the LLM layer config (no API key required)
npm run llm:selftest        # prints resolved provider/model/baseURL + "config OK"
```

A `GET /api/health` returns `{ "ok": true }`. The home page lists one company —
Vedanta Limited, credibility **26 / E** — loaded from
`public/data/companies/index.json`.

## Configuration (LLM)

Set via environment / Wrangler secrets — never commit keys.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `gemini` | Primary provider key |
| `LLM_API_KEY` | — | Primary provider API key (or `<PROVIDER>_API_KEY`) |
| `LLM_BASE_URL` | preset | Override base URL for the primary provider |
| `LLM_MODEL` | preset | Override model for the primary provider |
| `LLM_FALLBACKS` | — | Comma-separated failover providers, in order |

Presets (reconfirmed in Prompt 4): `gemini`, `groq`, `cerebras`, `mistral`,
`nvidia`. See [`pipeline/lib/llm.mjs`](./pipeline/lib/llm.mjs).

## Document acquisition (Prompt 2)

Given a company, fetch its earnings-call transcripts + investor presentations and
write a manifest the rest of the pipeline consumes. **Acquire bytes + metadata
only** — no PDF→text, no LLM, nothing written to `public/data/`. Two
interchangeable backends produce the **same** `pipeline/output/<ticker>/manifest.json`:

### Screener scraper (Playwright + login)

```bash
npm i -D playwright --no-save && npx playwright install chromium   # one-time
export SCREENER_EMAIL=… SCREENER_PASSWORD=…                        # secrets only

TICKER=VEDL npm run scrape             # → pipeline/output/vedl/{manifest.json, raw/*.pdf}
TICKER=VEDL DRY_RUN=1 npm run scrape   # log in + list concalls & URLs, download nothing
TICKER=VEDL EXPLORE=1 npm run scrape   # dump rendered HTML + screenshot + candidate selectors
npm run validate:manifest VEDL         # assert manifest keys + bytes/sha256/%PDF
```

The login session is persisted to `scratchpad/screener-state.json` (gitignored)
and reused, so re-runs skip login and are **idempotent** (same files, same
manifest). Concall links that bounce to BSE/NSE are fetched inside the browser
context (cookies/UA, follow redirects); per-link failures are logged in the
manifest's `errors[]` rather than aborting the run.

**Env knobs:** `TICKER` | `COMPANY` · `LIMIT` (8) · `CONSOLIDATED` (1) ·
`FY_END_MONTH` (3) · `SOURCE` (`screener` | `upload`) · `DRY_RUN` · `EXPLORE` ·
`HEADFUL` · `DEBUG` · `CHROMIUM_EXECUTABLE` (use a preinstalled browser) ·
`SCREENER_ORIGIN` (staging/testing).

### Manual-upload fallback

```bash
mkdir -p pipeline/input/<ticker>       # drop Q2FY26-transcript.pdf, Q2FY26-ppt.pdf, …
SOURCE=upload TICKER=<ticker> npm run ingest:upload
npm run validate:manifest <ticker>
```

Files are named `<QUARTER>-<type>.pdf` (`transcript` | `ppt`/`presentation` |
`annual_report`) — or supply an `index.csv` with columns `file,quarter,type,date`.

### Egress allowlist

Acquisition reaches only these hosts — configure your environment's network
policy / CI egress to allow them. Without the host allowlisted the scraper fails
cleanly (clear message + debug dump) rather than hanging:

- `www.screener.in` — company pages, search API, login
- `www.bseindia.com`, `nsearchives.nseindia.com`, `www.nseindia.com` — where
  transcript/PPT links redirect
- company **IR domains** — some decks are hosted on investor-relations sites
- `cdn.playwright.dev` — only for the one-time browser download (or use a
  preinstalled browser + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`)

On login failure, a missing Concalls block, or an unreachable host the scraper
writes `pipeline/output/<ticker>/debug/*.{html,png}` and exits non-zero.

## Ingestion & normalization (Prompt 3)

Turn the acquired PDFs into a clean, tagged, chunked corpus the extraction
engine (Prompt 4) reads. **Deterministic & offline — no LLM, no OCR.**

```bash
npm i -D unpdf --no-save                       # one-time (PDF→text; pure JS)

# upload backend is now FILENAME-AGNOSTIC — drop arbitrarily-named PDFs, no CSV:
SOURCE=upload TICKER=vedl npm run ingest:upload  # detects {type,quarter,date} from page-1 text
npm run validate:manifest vedl

TICKER=vedl npm run ingest                       # manifest → pipeline/output/vedl/corpus.json
npm run validate:corpus vedl                     # chunks ≤ CHUNK_TOKENS, no boilerplate, roles OK
npm run test:ingest                              # normalizer/chunker/needs_ocr unit tests
```

Per document: extract per-page text (unpdf) → de-boilerplate (drop lines on ≥40%
of pages, "Page X of Y", "Sensitivity: …", bare page numbers; de-hyphenate
wrapped words) → tag structure → chunk with citable metadata.

- **Transcripts → speaker turns** `{kind, speaker, role, page, text}`, with roles
  (`management` | `analyst` | `moderator` | `null`) tagged from the MANAGEMENT
  roster, and prepared-remarks vs Q&A segmented.
- **Presentations → slides** (one page = one slide) with a title and an
  `is_guidance` flag (guidance / outlook / target / deleveraging / capex).
- **Chunks** `{chunk_id, doc_id, quarter, page_start, page_end, kind, speaker,
  approx_tokens, text}`, ≤ `CHUNK_TOKENS` (default 1500) with ~`CHUNK_OVERLAP`
  (150) overlap, never split mid-turn unless a single turn exceeds a chunk.
- A PDF with no text layer → `needs_ocr: true` (flagged, not crashed; OCR is out
  of scope here). The raw `local_path` is kept so Prompt 4 can feed table-heavy
  decks to a vision model.

**Env knobs:** `TICKER` · `CHUNK_TOKENS` (1500) · `CHUNK_OVERLAP` (150) · `LIMIT`
· `INGEST_MODE` (`text` default; `gemini` is a documented Prompt-4 hook — no LLM
here) · `DEBUG`. Output: `pipeline/output/<ticker>/corpus.json` (gitignored).

## Extraction engine (Prompt 4)

The first LLM step: read `corpus.json` and extract every **measurable management
commitment** → `pipeline/output/<ticker>/promises.json`. Company-agnostic (no
hardcoded metric set). **No verification/status/variance — that's Prompt 5.**

Gemini + Groq + Mistral (all free-tier) extract management-only text — prepared
remarks in full, Q&A answers pre-filtered to guidance-bearing turns (`QA_FILTER`,
~half the Q&A chatter dropped). By default (`LLM_STRATEGY=failover`) the three keys
are **one combined quota pool used in order** — each doc extracted once by the
first provider with budget; a provider that hits its daily quota is dropped for the
rest. (`ensemble` re-extracts every doc with all three for max recall — 3× the
quota; opt in when you can afford it.) Every quote is grounded to a verbatim
substring (snap-or-drop), deduped, and given a derived `test_date`, a stable
`promise_key` (groups restatements for the downstream verifier), and a lenient
`figure_in_quote` flag; recall is scored against the golden fixture. **Accuracy is
a separate, later data-verification step — not cross-model agreement.**

```bash
# In-session (no keys): estimate + mock-LLM unit tests
DRY_RUN=1 TICKER=vedl npm run extract        # planned calls/tokens (failover → ~docs calls)
npm run test:extract                         # mock-LLM unit tests

# Live 3-model run happens in CI (keys in GitHub Secrets) — see test-extract.yml
CORPUS=pipeline/fixtures/vedl.corpus.json TICKER=vedl npm run extract
```

**Env knobs:** `TICKER` · `CORPUS=<path>` · `LLM_STRATEGY` (`failover` default |
`ensemble` | `partition` | `single`) · `GEMINI_API_KEY`/`GROQ_API_KEY`/`MISTRAL_API_KEY`
(+ optional `<PROVIDER>_MODEL`) · `EXTRACTION_ORDER` (failover priority; default
`mistral,gemini,groq` while Gemini's free quota is exhausted) · `LLM_CONCURRENCY`
(2) · `EXTRACT_SCOPE` (`management` | `all`) · `QA_FILTER` (1; 0 keeps all Q&A) ·
`PROVIDER=mock`/`MOCK=1` ($0 offline run — no key, validates wiring + JSON shape) ·
`EVAL` · `LIMIT` · `DRY_RUN` · `DEBUG`. A throttled provider is skipped (graceful
degradation); per (doc×model) caching makes re-runs nearly free. Confirmed free-tier
models are documented in `CLAUDE.md`.

Recall uses a **fuzzy/semantic matcher** (compatible categories, subject overlap,
number+period agreement). To re-score an already-produced `promises.json` with **no
API calls**, run `node pipeline/eval-extraction.mjs <promises.json> [ticker]` — or in
CI, the **"Re-run eval (no API)"** workflow, which downloads a prior run's artifact
and re-evaluates it.

## Verification & credibility (Prompt 5)

Turn `promises.json` + `corpus.json` into the final schema-valid company ledger
(`public/data/companies/<ticker>.json`): the credibility score, status mix,
variances, financial trend and aggregates the dashboard renders.

**The architecture principle that makes a verdict trustworthy: the LLM only
*retrieves*; the *rules* decide.** For each promise the model reads later
documents and reports the *reported actual* + (for a shortfall) management's
stated reason — it never decides MET/MISSED. `status`, `variance` and the
credibility score are **deterministic, reproducible, unit-tested rules** keyed on
the metric's `category` direction (higher-is-better / lower-is-better / a dated
milestone), so the same inputs always produce the same verdict and nothing is a
black box. Generic by construction: no company, ticker, sector or metric names are
hardcoded.

The verdict rules in brief:

- **NYT** (not yet tested) — no usable actual, or the `test_date` is still in the
  future (an interim figure against an annual target). NYT is *excluded* from
  scoring; you can't fail a test that hasn't happened.
- **MET / PARTIAL / MISSED** — meets/beats the target on its favourable side; just
  on the wrong side (within `PARTIAL_TOL`) → PARTIAL; clearly short → MISSED. For a
  **milestone**, delivered on time → MET, slipped ≤ `TIMELINE_GRACE_QTRS` → PARTIAL,
  slipped further (**including when the company's own later disclosure re-guides the
  date past the window**) → MISSED.
- **Integrity rule** — when guidance was revised, the verdict is judged against the
  **original** target (the extractor preserves it) and flagged `was_revised`, so a
  quietly-cut-then-"met" number still reads as a miss.
- **Credibility** — confidence-weighted delivery over **testable** promises:
  `MET=1 / PARTIAL=0.5 / MISSED=0`, weighted `H=1.0 / M=0.8 / L=0.6`;
  `score = 100 × Σ(conf×outcome) / Σ(conf)`; bands **A ≥ 75 · B ≥ 60 · C ≥ 45 ·
  D ≥ 30 · E < 30**. The headline is a deterministic template — it never invents a
  figure.

```bash
# In-session (no keys): deterministic unit tests + a $0 mock end-to-end run
npm run test:verify                          # status/variance, integrity, credibility banding
PROVIDER=mock TICKER=vedl npm run verify     # full extract→verify on mock; writes a schema-valid ledger
npm run validate                             # the engine's ledger validates against the contract

# Live retrieval runs in CI (keys in GitHub Secrets) — see test-verify.yml
CORPUS=pipeline/fixtures/vedl.corpus.json TICKER=vedl npm run verify
```

`verify.mjs` is idempotent and caches every retrieval, so re-runs are nearly free;
if `promises.json` is missing it runs extraction first. It then evaluates the
engine's ledger against the golden fixture with **the data-verifier**
(`eval-verification.mjs`): lexical + LLM-judged *matching* (the judge aligns
promises, it never re-judges a verdict), status agreement, a status confusion
matrix, the credibility delta, and the expected `newly_resolved[]` (golden-NYTs a
later doc has since closed) and `extra[]` (over-extraction). The committed fixture
corpus extends one quarter past the golden's window, so several golden-NYTs are
resolved by the newer doc — reported separately, not counted as disagreements.

**Env knobs:** `TICKER` · `CORPUS=<path>` · `PROMISES=<path>` · `PARTIAL_TOL`
(0.05) · `TIMELINE_GRACE_QTRS` (1) · `PROVIDER=mock`/`MOCK=1` ($0 offline run) ·
`GEMINI_API_KEY`/`GROQ_API_KEY`/`MISTRAL_API_KEY` · `EXTRACTION_ORDER` (retrieval
provider priority; default `mistral,gemini,groq`) · `LLM_CONCURRENCY` (2) · `EVAL`
(1) · `LIMIT` · `DEBUG`. The model never assigns a status and never invents a
number — those are the rules' job.

## Dashboard (Prompt 6)

The first UI: it turns a committed `<ticker>.json` ledger into a screen.
Framework-free (vanilla ES modules + the P1 design system), zero build step.

```bash
npm run dev          # wrangler dev → http://127.0.0.1:8787
#   home  → search a company (autocomplete, ↑↓/Enter) + a grid of covered companies
#   ?c=<ticker>  → the company dashboard (credibility hero + KPI strip)
npm run test:ui      # the provenance-guard unit test (no browser, no keys)
```

- **`?c=<ticker>` route** (`js/lib/router.js`) — the company in view is a query param;
  URLs are shareable and back/forward work. No param = home.
- **Credibility hero** (`js/components/credibility-hero.js`) — a grade-banded score
  ring, the deterministic headline, and the **delivery-vs-timeline split** — the
  product's signature insight (*"hits its numbers, misses its deadlines"*) — plus a
  status-mix bar and a meta row. A **KPI strip** tallies MET/PARTIAL/MISSED/NYT.
- **Company-agnostic** — the UI renders any `<ticker>.json` and searches `index.json`;
  no company names, tickers or sectors live in the code.

### The provenance guard

The product's premise is *verifiability*, so the UI must never present a mock or
quota-truncated ledger as a real verdict. `verify.mjs` stamps each ledger with
`provenance` (`mode` · `complete` · `retrieval_errors` · `forced_nyt` · `models_used`),
and the hero badges it:

| Ledger | Badge | Score |
| --- | --- | --- |
| complete live run | 🟢 **Live · complete** | shown |
| `mode:"mock"` | 🔴 **Mock data — not a real verdict** | dimmed + disclaimed |
| incomplete live (`forced_nyt`>0) | 🟠 **Provisional — incomplete retrieval** | dimmed + disclaimed |
| hand-curated golden | ⚪ **Curated** | shown |

The committed `vedl.json` is the curated golden (grey). A real incomplete live run
— like the quota-truncated 61/B Vedanta pass — shows amber automatically, and flips
to green once the complete re-run is committed. `npm run test:ui` proves the mapping.

### Charts (Prompt 7)

The company view's `#charts` section renders five themed, responsive ECharts panels
straight from the ledger — **status donut**, the signature **slippage timeline**
(promised → re-set, parsed from each timeline promise's commitment text and its
retrieved actual), **by-quarter** stacked bars, **root-cause** bars, and **financial
momentum** (EBITDA + margin, with a net-debt/EBITDA · ROCE · revenue stat trio).
ECharts is lazy-loaded; if the CDN is blocked the panels show a graceful "charts
unavailable offline" note rather than throwing, and panels self-hide when their data
is absent (no `financial_trend` → no momentum; no slips → slippage empty state).
Charts are read-only — no schema change.

### Track record, master table & drill (Prompt 8)

Under the charts, `#track-record` shows the **testable** verdicts as worst-first
colour cards (MISSED → PARTIAL → MET) and `#table` shows the **full 13-column** promise
ledger (frozen Promise column, status pills + confidence badges, sortable headers,
pagination). A **shared filter bar** (status · category · quarter · confidence ·
free-text) filters both at once. Clicking any card or row opens the **drill modal** —
the integrity layer: the verbatim, quote-grounded **receipt** + source doc/date
(copyable), the actual, the variance, the explanation, and any guidance revisions, so
every verdict is auditable. Focus-trapped, ESC-to-close, focus-restored; null-safe on
NYT rows. Read-only — no schema change.

### PDF export (Prompt 9)

The `#export` section turns the ledger into a **polished, multi-page A4-landscape PDF** —
cover · executive dashboard · slippage & momentum · track-record cards · master table ·
methodology — pre-built by the pipeline (not the browser). `report-template.mjs` renders the
ledger to **one self-contained HTML string** (inline-SVG charts, no CDN), and
`build-report.mjs` prints it to `public/reports/<ticker>.pdf` with the repo's **headless
Chromium**; the Export button HEAD-checks that file and offers a download (or a graceful
"run `npm run report`" note). Company-agnostic — every figure comes from `<ticker>.json`.

```bash
npm i -D playwright --no-save && npx playwright install chromium
TICKER=vedl npm run report                   # ledger → public/reports/vedl.pdf
FORCE=1 TICKER=vedl npm run report           # watermarked mock/provisional copy (inspection only)
```

**Provenance honesty extends to paper.** A PDF travels further than the dashboard, so
`build-report.mjs` **refuses** a mock or incomplete-live ledger by default; `FORCE=1` produces
a **watermarked** copy ("MOCK — NOT A REAL VERDICT" / "PROVISIONAL — INCOMPLETE RETRIEVAL"
overlay + a cover banner). The `build-report.yml` workflow commits the PDF **only when the
ledger is a real verdict** — a forced watermarked copy is an artifact, never committed — so
`public/reports/` can only ever hold honest reports. No schema change.

## Layout

```
worker/index.js            Cloudflare Worker (ASSETS + /api/*)
schema/                    The data contract (JSON Schema, draft 2020-12)
public/                    Static dashboard (zero build step)
  index.html               Shell: design system <style>, boot loader, header, OG/favicon
  js/ui.js                 Design system + provenanceBadge (honesty guard) + data loaders
  js/app.js                Shell + router: home ↔ company view
  js/lib/                  router (?c=ticker) · fiscal (quarter math) · echarts (lazy-load + mountChart)
  js/components/           search · credibility-hero · kpi-strip · charts/ (5 panels) ·
                           filter-bar · track-record-cards · promise-table · promise-drill
  js/views/company.js      Company view (hero · KPI · #charts · #track-record · #table · #export)
  reports/<ticker>.pdf     Pre-built exportable PDF report (committed; served by the Export button)
pipeline/
  lib/llm.mjs              Provider-agnostic LLM client
  lib/manifest.mjs         Acquisition contract (fiscal-quarter, sha256, paths)
  lib/screener.mjs         Screener resolve/login/scrape + drift-resilient selectors
  lib/pdftext.mjs          PDF → per-page text (unpdf) + needs_ocr detection
  lib/detect.mjs           Filename-agnostic {type, quarter, date} from PDF text
  lib/normalize-text.mjs   De-boilerplate, speaker turns + roles, slides
  lib/chunk.mjs            Token-bounded, overlapping, no-mid-turn chunking
  lib/extract-prompt.mjs   Extraction system prompt + JSON schema
  lib/multi-llm.mjs        Ensemble/partition/single runner (concurrency, degrade)
  lib/ground-quote.mjs     Verbatim quote grounding (snap-or-drop)
  lib/dedup.mjs            Cross-model merge, reaffirmed_on, revisions
  lib/test-date.mjs        deriveTestDate from a target period
  lib/metric-direction.mjs Category→direction + target/actual parsing (generic)
  lib/fiscal.mjs           Fiscal period index (QnFY/FY/nHFY/calendar) + maths
  lib/status-variance.mjs  THE VERDICT — deterministic status/variance (rules, not LLM)
  lib/verification-window.mjs  Latest-reported window + NYT test
  lib/find-actual.mjs      Retrieve each reported actual from later docs (the only LLM step)
  lib/financial-trend.mjs  Per-quarter reported headline financials (LLM-assisted)
  lib/aggregate.mjs        Aggregates + the credibility score/grade/headline
  lib/report-template.mjs  Ledger → self-contained multi-page report HTML (inline-SVG charts)
  scrape-screener.mjs      Screener acquisition orchestrator (Playwright)
  ingest-upload.mjs        Manual-upload backend (content-detected, filename-agnostic)
  ingest.mjs               Manifest PDFs → corpus.json
  extract.mjs              Extraction engine: corpus → promises.json (first LLM step)
  verify.mjs               Verification orchestrator: promises → scored ledger (Prompt 5)
  build-report.mjs         Ledger → report HTML → public/reports/<ticker>.pdf (headless Chromium)
  eval-extraction.mjs      Recall vs the golden fixture
  eval-verification.mjs    The data-verifier: align engine ledger ↔ golden, status agreement
  validate.mjs             Ledger ↔ schema validation
  validate-manifest.mjs    Acquisition-manifest validation
  validate-corpus.mjs      Corpus validation (chunks, boilerplate, roles)
  gen-index.mjs            Home-page index.json generator
  test/p3 Ingestion · test/p4 Extraction · test/p5 Verification · test/p6 Provenance guard
  fixtures/<ticker>.corpus.json  Committed corpus for CI extract/verify
  fixtures/<ticker>.golden.json  Committed golden ledger (verification eval target)
.github/workflows/         CI (acquire.yml · test-extract.yml · test-verify.yml · build-report.yml)
wrangler.jsonc             Worker config
```

## Disclaimer

For research and education only — **not investment advice**. Figures are
point-in-time and derived from public company disclosures.
