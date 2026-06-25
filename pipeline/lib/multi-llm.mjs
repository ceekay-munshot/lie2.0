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
export const EXTRACTION_PROVIDERS = ["gemini", "groq", "mistral"];

/** Build the (doc, provider) task list for a strategy. */
export function planTasks(docs, providers, strategy = "ensemble") {
  const tasks = [];
  if (providers.length === 0) return tasks;
  if (strategy === "single") {
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
export async function runExtraction({ docs, providers, extractOne, strategy = "ensemble", concurrency = 2, debug = false }) {
  const tasks = planTasks(docs, providers, strategy);

  // Group by provider so each provider gets its own concurrency-capped pool.
  const byProvider = new Map();
  tasks.forEach((t) => {
    const k = t.provider.provider;
    if (!byProvider.has(k)) byProvider.set(k, []);
    byProvider.get(k).push(t);
  });

  const stats = {
    docs: docs.length,
    strategy,
    raw_candidates: 0,
    llm_calls: 0,
    cache_hits: 0,
    by_model: {},
    errors: [],
  };
  const promises = [];

  await Promise.all(
    [...byProvider.entries()].map(([providerName, provTasks]) =>
      runPool(provTasks, concurrency, async ({ doc, provider }) => {
        try {
          const res = await extractOne(provider, doc);
          const got = Array.isArray(res?.promises) ? res.promises : [];
          if (res?.cached) stats.cache_hits += 1;
          else stats.llm_calls += res?.calls ?? 1;
          // Partial failures (e.g. one segment of a multi-segment doc) are not
          // thrown — record them so a degraded result is never silent.
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
