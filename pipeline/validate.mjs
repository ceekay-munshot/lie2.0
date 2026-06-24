#!/usr/bin/env node
/**
 * validate.mjs — validate every committed company ledger against the JSON Schema
 * that defines the Lie Detector data contract (schema/lie-detector.schema.json).
 *
 * The schema is the single source of truth: any JSON written by the pipeline (or
 * by hand) must pass this before being committed under public/data/companies/.
 *
 * Deps (ajv, ajv-formats) are installed --no-save and gitignored. If they are
 * missing, this script installs them on first run so `npm run validate` works on
 * a fresh checkout with no manual setup.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCHEMA_PATH = join(ROOT, "schema", "lie-detector.schema.json");
const COMPANIES_DIR = join(ROOT, "public", "data", "companies");

/** Lazily import ajv (draft 2020-12) + formats, auto-installing --no-save if absent. */
async function loadAjv() {
  async function imports() {
    const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
      import("ajv/dist/2020.js"),
      import("ajv-formats"),
    ]);
    return { Ajv2020, addFormats };
  }
  try {
    return await imports();
  } catch {
    console.log("Installing validation deps (ajv, ajv-formats) --no-save …");
    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "npm",
      ["install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "ajv", "ajv-formats"],
      { stdio: "inherit", cwd: ROOT },
    );
    return await imports();
  }
}

const { Ajv2020, addFormats } = await loadAjv();

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const files = readdirSync(COMPANIES_DIR)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .sort();

if (files.length === 0) {
  console.error("No company ledgers found under public/data/companies/.");
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const data = JSON.parse(readFileSync(join(COMPANIES_DIR, file), "utf8"));
  const ok = validate(data);
  if (ok) {
    const n = Array.isArray(data.promises) ? data.promises.length : 0;
    console.log(`  ✓ ${basename(file)}  (${n} promises)`);
  } else {
    failures += 1;
    console.error(`  ✗ ${basename(file)}`);
    for (const err of validate.errors ?? []) {
      console.error(`      ${err.instancePath || "/"} ${err.message}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed validation against ${schema.$id}.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} ledger(s) valid against ${schema.$id}.`);
