/**
 * eval-extraction.mjs — measure recall of extracted promises against a committed
 * golden fixture (public/data/companies/<ticker>.json).
 *
 * Matching is FUZZY/semantic (lexical, no API): a golden promise matches an
 * extracted one when the periods are compatible AND any of —
 *   • compatible category (synonym groups, e.g. capex≈capacity≈volume) with decent
 *     subject-token overlap (Jaccard) or containment, OR
 *   • the same target number under a compatible category & period, OR
 *   • very strong subject overlap (overrides category).
 * Reports recall + what was missed / extra.
 *
 * Used by extract.mjs (auto when a fixture exists) and runnable standalone:
 *   node pipeline/eval-extraction.mjs <promises.json> [ticker]   # no LLM, no API calls
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subjectTokens, normPeriod } from "./lib/dedup.mjs";

// Categories that commonly stand in for one another across the golden set vs. what
// a model labels. (schema categories only; "other" is treated as compatible-with-all.)
const CAT_GROUPS = [
  ["ebitda", "margin", "pat"],
  ["capex", "capacity", "volume"],
  ["leverage", "working_capital"],
  ["revenue", "orderbook"],
];
function catCompat(a, b) {
  if (a === b || a === "other" || b === "other") return true;
  return CAT_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Fraction of the SMALLER token set that is covered — catches "subset" paraphrases. */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}
const fyOf = (p) => {
  const m = String(p).match(/fy(\d{2,4})/);
  return m ? m[1].slice(-2) : null;
};
function periodCompat(kp, ep) {
  const k = normPeriod(kp), e = normPeriod(ep);
  if (!k || !e) return true; // an unspecified period can't disqualify a match
  if (k === e) return true;
  const kf = fyOf(k), ef = fyOf(e);
  return !!(kf && ef && kf === ef); // Q4FY26 ≈ FY26 (same fiscal year)
}
function numClose(kt, et) {
  const kv = kt?.value, ev = et?.value;
  if (kv == null || ev == null) return false;
  const rel = Math.abs(kv - ev) / Math.max(Math.abs(kv), Math.abs(ev), 1e-9);
  return rel <= 0.05;
}

/**
 * @param {Array} extracted  extracted promises ({category, metric, target})
 * @param {object} fixture    golden company ledger
 * @param {{minSubject?:number, minContain?:number}} opts
 */
export function evalExtraction(extracted, fixture, { minSubject = 0.25, minContain = 0.5 } = {}) {
  const known = fixture.promises || [];
  const ex = extracted.map((p) => ({
    category: p.category,
    metric: p.metric,
    target: p.target,
    _sub: subjectTokens(p.metric),
    _per: normPeriod(p.target?.period),
  }));
  const used = new Set();
  const missed = [];
  let found = 0;

  for (const k of known) {
    const ksub = subjectTokens(k.metric);
    const kper = normPeriod(k.target?.period);
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < ex.length; i++) {
      if (used.has(i)) continue;
      const e = ex[i];
      if (!periodCompat(kper, e._per)) continue;
      const subj = jaccard(ksub, e._sub);
      const cont = containment(ksub, e._sub);
      const cat = catCompat(k.category, e.category);
      let score = 0;
      if (cat && (subj >= minSubject || cont >= minContain)) score = Math.max(subj, cont);
      else if (cat && numClose(k.target, e.target)) score = 0.55; // same number, same kind
      else if (subj >= 0.5) score = subj; // strong topical overlap overrides category
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best != null) {
      used.add(best);
      found += 1;
    } else {
      missed.push({ id: k.id, category: k.category, metric: k.metric, period: k.target?.period ?? null });
    }
  }

  const extra = ex
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !used.has(i))
    .map(({ e }) => ({ category: e.category, metric: e.metric }));

  return {
    fixture: fixture.company?.ticker || null,
    known: known.length,
    found,
    recall: known.length ? Number((found / known.length).toFixed(3)) : 0,
    missed,
    extra,
  };
}

// ---- CLI: re-evaluate an existing promises.json with NO API calls ----------
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");
  const promisesPath = process.argv[2];
  const ticker = (process.argv[3] || process.env.TICKER || "vedl").toLowerCase();
  if (!promisesPath || !existsSync(promisesPath)) {
    console.error(`usage: node pipeline/eval-extraction.mjs <promises.json> [ticker]\n  (promises.json not found: ${promisesPath})`);
    process.exit(1);
  }
  const fixturePath = join(repoRoot, "public", "data", "companies", `${ticker}.json`);
  if (!existsSync(fixturePath)) {
    console.error(`no golden fixture for ${ticker}: ${fixturePath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(promisesPath, "utf8"));
  const promises = Array.isArray(raw) ? raw : raw.promises || [];
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const r = evalExtraction(promises, fixture);
  console.log(`\n──────── eval (fuzzy matcher, no API) — ${ticker.toUpperCase()} ────────`);
  console.log(`  extracted promises : ${promises.length}`);
  console.log(`  RECALL             : ${(r.recall * 100).toFixed(1)}%  (${r.found}/${r.known})`);
  console.log(`  extracted-but-extra: ${r.extra.length}`);
  console.log(`  MISSED (${r.missed.length}):`);
  for (const m of r.missed) console.log(`    - [${m.category}] ${m.metric}  (${m.period ?? "—"})`);
}
