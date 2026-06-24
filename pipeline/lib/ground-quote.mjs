/**
 * ground-quote.mjs — keep extracted quotes honest. A quote must be a verbatim
 * substring of the source text (whitespace/smart-quote normalized). If it isn't
 * exactly present, try to snap it to the closest ≤25-word span in the source; if
 * nothing matches well enough, mark it ungrounded so the caller can DROP it
 * (hallucinated quotes never reach the ledger).
 */
const norm = (s) =>
  String(s || "")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const wordsOf = (s) => norm(s).split(/\s+/).filter(Boolean);
const clampWords = (s, n) => wordsOf(s).slice(0, n).join(" ");

/**
 * @param {string} quote      model-provided quote
 * @param {string} sourceText the exact text shown to the model (one document)
 * @param {{maxWords?:number, minOverlap?:number}} opts
 * @returns {{quote?:string, grounded:boolean, snapped?:boolean}}
 */
export function groundQuote(quote, sourceText, { maxWords = 25, minOverlap = 0.6 } = {}) {
  const nq = norm(quote);
  const ns = norm(sourceText);
  if (!nq || !ns) return { grounded: false };

  // Exact (normalized) substring → verbatim.
  if (ns.includes(nq)) {
    return { quote: clampWords(quote, maxWords), grounded: true, snapped: false };
  }

  // Snap: slide a window over the source, maximize token overlap with the quote.
  const qTokens = new Set(nq.toLowerCase().split(/\s+/).filter(Boolean));
  if (qTokens.size === 0) return { grounded: false };
  const sw = wordsOf(ns);
  const win = Math.min(maxWords, Math.max(qTokens.size, 6));
  let best = { score: 0, start: 0, len: 0 };
  for (let i = 0; i < sw.length; i++) {
    const len = Math.min(win, sw.length - i);
    let inter = 0;
    for (let j = i; j < i + len; j++) if (qTokens.has(sw[j].toLowerCase())) inter++;
    const score = inter / qTokens.size;
    if (score > best.score) best = { score, start: i, len };
    if (score >= 1) break;
  }
  if (best.score >= minOverlap) {
    const span = sw.slice(best.start, best.start + best.len).join(" ");
    return { quote: clampWords(span, maxWords), grounded: true, snapped: true };
  }
  return { grounded: false };
}
