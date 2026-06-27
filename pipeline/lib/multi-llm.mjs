/**
 * multi-llm.mjs — run the extraction across a panel of providers. All providers
 * are FIRST-CLASS workers (not fallbacks): each catches commitments the others
 * miss, and their results are unioned (cross-model-merged later in dedup).
 *
 * Strategies:
 *   ensemble  (default) — every document by EVERY available provider (max recall)
 *   partition           — round-robin documents across providers (quota-friendly)
 *   single              — one provider (debug)
 *
 * Concurrency is capped per provider; a provider that errors/429s is skipped for
 * that task and the run continues on the others (graceful degradation). The
 * actual model call is injected as `extractOne` so this module is pure and
 * unit-testable with a mock.
 */
// Failover priority. Mistral-first by default: Gemini's free-tier key is currently
// quota-exhausted, so leading with the live provider avoids burning a fail-fast probe
// on it each run. Override with EXTRACTION_ORDER (e.g. "gemini,groq,mistral") once
// Gemini quota is healthy again.
export const EXTRACTION_PROVIDERS = (process.env.EXTRACTION_ORDER || "mistral,gemini,groq")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Build the (doc, provider) task list for a strategy. */
export function planTasks(docs, providers, strategy = "failover") {
  const tasks = [];
  if (providers.length === 0) return tasks;
  if (strategy === "single" || strategy === "failover") {
    // failover's best case (and single) = the primary provider does every doc;
    // failover only spills to the next provider when one's quota is exhausted.
    const p = providers[0];
    docs.forEach((doc) => tasks.push({ doc, provider: p }));
  } else if (strategy === "partition") {
    docs.forEach((doc, i) => tasks.push({ doc, provider: providers[i % providers.length] }));
  } else {
    // ensemble
    docs.forEach((doc) => providers.forEach((provider) => tasks.push({ doc, provider })));
  }
  return tasks;
}

/** Run an array of tasks through `worker` with at most `cap` concurrent. */
async function runPool(tasks, cap, worker) {
  const results = new Array(tasks.length);
  let next = 0;
  const n = Math.max(1, Math.min(cap, tasks.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await worker(tasks[i], i);
      }
    }),
  );
  return results;
}

/**
 * @param {object} o
 * @param {Array} o.docs       corpus documents (each {id, quarter, type, date, ...})
 * @param {Array} o.providers  [{provider, model}] available workers
 * @param {(provider, doc) => Promise<{promises:Array, cached?:boolean, calls?:number}>} o.extractOne
 * @param {string} o.strategy  ensemble | partition | single
 * @param {number} o.concurrency per-provider concurrency cap
 * @returns {Promise<{promises:Array, stats:object, contributors:string[]}>}
 */
const newStats = (strategy, docs) => ({
  docs: docs.length,
  strategy,
  raw_candidates: 0,
  llm_calls: 0,
  cache_hits: 0,
  by_model: {},
  errors: [],
});

/** Fold a successful extractOne result into the run's stats + tagged promises. */
function recordResult(stats, promises, providerName, doc, res, debug) {
  const got = Array.isArray(res?.promises) ? res.promises : [];
  if (res?.cached) stats.cache_hits += 1;
  else stats.llm_calls += res?.calls ?? 1;
  // Partial failures (e.g. one segment of a multi-segment doc) are not thrown —
  // record them so a degraded result is never silent.
  for (const reason of res?.errors || []) {
    stats.errors.push({ provider: providerName, doc: doc.id, reason });
    if (debug) console.error(`  ! ${providerName} ${doc.id} (partial): ${reason}`);
  }
  stats.by_model[providerName] = (stats.by_model[providerName] || 0) + got.length;
  stats.raw_candidates += got.length;
  for (const p of got) {
    promises.push({
      ...p,
      model: providerName,
      source_id: doc.id,
      source_label: doc.label || `${doc.quarter} ${doc.type}`,
      date: doc.date ?? null,
      doc_quarter: doc.quarter,
    });
  }
}

/**
 * Sequential pool — treat the providers as ONE combined free-tier quota, used in
 * priority order. Each document is extracted ONCE, by the first provider with
 * budget; a provider that hits a per-DAY/quota limit is dropped for the remaining
 * documents (so we don't redundantly re-extract, and we don't waste a model's
 * budget on work another already did). Cross-model agreement is intentionally not
 * used here — accuracy is a separate, later verification step.
 *
 * A document falls through to the next provider whenever the current one did NOT
 * fully cover it:
 *   - thrown error            → that provider failed the whole doc (see catch);
 *   - partial result + daily  → quota ran out mid-doc; keep what we got, DROP the
 *                               provider for later docs, cover the remainder next;
 *   - partial result + errors → a segment failed for a non-daily reason; keep what
 *                               we got, but KEEP the provider (only this doc had
 *                               trouble) and let the next provider cover the rest.
 * Dedup later merges any overlap from a doc covered by more than one provider. If
 * no provider fully covers a doc (all errored/exhausted), a doc-level "(none)"
 * error is recorded so the run reads as INCOMPLETE, never silently short.
 *
 * Concurrency note: with concurrency > 1, up to (concurrency − 1) in-flight docs
 * may already have passed the `dead` check at the instant a provider exhausts its
 * quota, so they probe it once more. Those probes simply fail fast — a quota-spent
 * 429 is rejected, costing a round-trip, not token budget — and then fall through
 * to the next provider, so no document is ever lost. The drop is fully effective
 * for every doc that STARTS after the failure is observed.
 */
async function runFailover({ docs, providers, extractOne, concurrency, debug }) {
  const stats = newStats("failover", docs);
  const promises = [];
  const dead = new Set(); // providers whose daily quota is spent
  const dropProvider = (name, note) => {
    dead.add(name);
    if (debug) console.error(`  ⓧ ${name} daily/quota limit${note} — dropping for remaining docs`);
  };
  await runPool(docs, concurrency, async (doc) => {
    let triedAny = false; // did at least one non-dead provider get a turn at this doc?
    for (const provider of providers) {
      if (dead.has(provider.provider)) continue;
      triedAny = true;
      try {
        const res = await extractOne(provider, doc);
        recordResult(stats, promises, provider.provider, doc, res, debug);
        if (res?.daily) {
          // Quota ran out MID-document: keep the segments we got, drop the
          // provider, and fall through so the next one covers the remainder
          // (dedup merges any overlap with what this provider already returned).
          dropProvider(provider.provider, " (mid-doc)");
          continue;
        }
        if (res?.errors?.length) {
          // Partial NON-daily failure (a segment exhausted its retries): keep what
          // we got, but fall through so another provider can cover the failed
          // segment(s). The provider is healthy — do NOT drop it for other docs.
          if (debug) console.error(`  ! ${provider.provider} ${doc.id}: partial (${res.errors.length} segment error(s)) → next provider covers the rest`);
          continue;
        }
        return; // fully extracted — do not spend another provider on this doc
      } catch (err) {
        stats.errors.push({ provider: provider.provider, doc: doc.id, reason: err.message });
        if (err.daily) {
          dropProvider(provider.provider, "");
        } else if (debug) {
          console.error(`  ! ${provider.provider} ${doc.id}: ${err.message} → next provider`);
        }
        // fall through to the next provider for this doc
      }
    }
    // Reached here ⇒ no provider FULLY extracted this doc. Record a doc-level note
    // so it surfaces as incomplete/skipped rather than being silently absent from
    // promises.json (it may still carry partial promises from a fallen-through
    // provider; the note flags that the document was not fully covered).
    const reason = triedAny
      ? "no provider fully extracted this document (providers errored or exhausted mid-document)"
      : "skipped — every provider was already exhausted before this document";
    stats.errors.push({ provider: "(none)", doc: doc.id, reason });
    if (debug) console.error(`  ⓧ ${doc.id}: ${reason}`);
  });
  const contributors = Object.keys(stats.by_model).filter((m) => stats.by_model[m] > 0);
  return { promises, stats, contributors };
}

export async function runExtraction({ docs, providers, extractOne, strategy = "failover", concurrency = 2, debug = false }) {
  if (strategy === "failover") return runFailover({ docs, providers, extractOne, concurrency, debug });

  // ensemble / partition / single: a fixed (doc, provider) plan run per provider.
  const tasks = planTasks(docs, providers, strategy);
  const byProvider = new Map();
  tasks.forEach((t) => {
    const k = t.provider.provider;
    if (!byProvider.has(k)) byProvider.set(k, []);
    byProvider.get(k).push(t);
  });

  const stats = newStats(strategy, docs);
  const promises = [];
  await Promise.all(
    [...byProvider.entries()].map(([providerName, provTasks]) =>
      runPool(provTasks, concurrency, async ({ doc, provider }) => {
        try {
          recordResult(stats, promises, provider.provider, doc, await extractOne(provider, doc), debug);
        } catch (err) {
          stats.errors.push({ provider: providerName, doc: doc.id, reason: err.message });
          if (debug) console.error(`  ! ${providerName} ${doc.id}: ${err.message}`);
        }
      }),
    ),
  );

  const contributors = Object.keys(stats.by_model).filter((m) => stats.by_model[m] > 0);
  return { promises, stats, contributors };
}
