# Lie Detector

> Do Indian management teams keep their promises?

A static dashboard that, for any Indian listed company, extracts every
**measurable** management commitment from its earnings-call transcripts and
investor presentations, verifies each against later reported actuals, scores
delivery reliability, and exports a polished multi-page PDF.

**Search a company → dashboard** (credibility score, status donut, slippage
timeline, track-record cards, master promise table) **→ Export PDF.**

This repo is being built in ~12 prompts. **Status: Prompt 1 — Foundation** is
complete (scaffold, Worker + static shell, design system, the data contract,
a provider-agnostic LLM client, and a committed golden fixture). The dashboard,
charts, ingestion pipeline and PDF export land in later prompts. See
[`CLAUDE.md`](./CLAUDE.md) for architecture, the data contract and the roadmap.

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

## Layout

```
worker/index.js            Cloudflare Worker (ASSETS + /api/*)
schema/                    The data contract (JSON Schema, draft 2020-12)
public/                    Static dashboard (index.html, js/, data/)
pipeline/
  lib/llm.mjs              Provider-agnostic LLM client
  lib/manifest.mjs         Acquisition contract (fiscal-quarter, sha256, paths)
  lib/screener.mjs         Screener resolve/login/scrape + drift-resilient selectors
  lib/pdftext.mjs          PDF → per-page text (unpdf) + needs_ocr detection
  lib/detect.mjs           Filename-agnostic {type, quarter, date} from PDF text
  lib/normalize-text.mjs   De-boilerplate, speaker turns + roles, slides
  lib/chunk.mjs            Token-bounded, overlapping, no-mid-turn chunking
  scrape-screener.mjs      Screener acquisition orchestrator (Playwright)
  ingest-upload.mjs        Manual-upload backend (content-detected, filename-agnostic)
  ingest.mjs               Manifest PDFs → corpus.json
  validate.mjs             Ledger ↔ schema validation
  validate-manifest.mjs    Acquisition-manifest validation
  validate-corpus.mjs      Corpus validation (chunks, boilerplate, roles)
  gen-index.mjs            Home-page index.json generator
  test/p3.test.mjs         Ingestion unit tests
.github/workflows/         CI (acquire.yml — manual document acquisition)
wrangler.jsonc             Worker config
```

## Disclaimer

For research and education only — **not investment advice**. Figures are
point-in-time and derived from public company disclosures.
