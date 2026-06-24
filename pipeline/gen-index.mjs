#!/usr/bin/env node
/**
 * gen-index.mjs — regenerate public/data/companies/index.json from every
 * committed company ledger. The index is the lightweight payload the home page
 * loads to render company cards; full ledgers are fetched on demand.
 *
 * Usage:
 *   node pipeline/gen-index.mjs          # write index.json
 *   node pipeline/gen-index.mjs --check  # fail if index.json is stale (CI-friendly)
 *
 * No network, no LLM — pure local transform over committed JSON.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPANIES_DIR = join(__dirname, "..", "public", "data", "companies");
const INDEX_PATH = join(COMPANIES_DIR, "index.json");

/** Turn coverage {from,to} like Q1FY26 / Q3FY26 into a compact label "Q1–Q3 FY26". */
function coverageLabel(coverage = {}) {
  const parse = (s) => (s || "").match(/^Q(\d)FY(\d{2,4})$/i);
  const a = parse(coverage.from);
  const b = parse(coverage.to);
  if (a && b) {
    if (a[2] === b[2]) {
      return a[1] === b[1] ? `Q${a[1]} FY${a[2]}` : `Q${a[1]}–Q${b[1]} FY${b[2]}`;
    }
    return `Q${a[1]} FY${a[2]}–Q${b[1]} FY${b[2]}`;
  }
  const { from, to } = coverage;
  if (!from && !to) return null;
  return from === to ? from : `${from ?? "?"}–${to ?? "?"}`;
}

function buildIndex() {
  const files = readdirSync(COMPANIES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort();

  const rows = files.map((file) => {
    const c = JSON.parse(readFileSync(join(COMPANIES_DIR, file), "utf8"));
    return {
      ticker: c.company?.ticker ?? null,
      name: c.company?.name ?? null,
      sector: c.company?.sector ?? null,
      credibility_score: c.credibility?.score ?? null,
      coverage: coverageLabel(c.coverage),
      updated_at: c.generated_at ?? null,
    };
  });

  // Worst credibility first (the point of the product); nulls last, then ticker.
  rows.sort((x, y) => {
    const sx = x.credibility_score ?? Infinity;
    const sy = y.credibility_score ?? Infinity;
    if (sx !== sy) return sx - sy;
    return String(x.ticker).localeCompare(String(y.ticker));
  });

  return rows;
}

const index = buildIndex();
const serialized = JSON.stringify(index, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = (() => {
    try {
      return readFileSync(INDEX_PATH, "utf8");
    } catch {
      return null;
    }
  })();
  if (current !== serialized) {
    console.error("index.json is stale — run `node pipeline/gen-index.mjs` and commit.");
    process.exit(1);
  }
  console.log(`index.json is up to date (${index.length} compan${index.length === 1 ? "y" : "ies"}).`);
} else {
  writeFileSync(INDEX_PATH, serialized);
  console.log(`Wrote ${INDEX_PATH} (${index.length} compan${index.length === 1 ? "y" : "ies"}).`);
}
