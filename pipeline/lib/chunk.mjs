/**
 * chunk.mjs — split tagged sections into citable, overlapping chunks for the
 * extraction engine (Prompt 4). Packs whole sections (speaker turns / slides) up
 * to CHUNK_TOKENS so a turn is never split mid-thought unless a single turn is
 * itself larger than a chunk (then it's split on sentence boundaries). A small
 * trailing overlap is carried into the next chunk for retrieval continuity.
 *
 * approx_tokens ≈ ceil(chars / 4).
 */

const approxTokens = (s) => Math.ceil(s.length / 4);

/** Render a section to text (speaker-prefixed turn, or titled slide). */
function sectionText(s) {
  if (s.kind === "slide") return [s.title, s.text].filter(Boolean).join("\n");
  return s.speaker ? `${s.speaker}: ${s.text}` : s.text;
}

const mode = (arr) => {
  const m = new Map();
  let best = arr[0];
  let bc = 0;
  for (const x of arr) {
    const c = (m.get(x) || 0) + 1;
    m.set(x, c);
    if (c > bc) {
      bc = c;
      best = x;
    }
  }
  return best;
};

/** Split an over-long text into ≤ budgetChars pieces on sentence boundaries. */
function splitText(t, budgetChars) {
  const sents = t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [t];
  const out = [];
  let cur = "";
  for (const s of sents) {
    if (s.length > budgetChars) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      for (let i = 0; i < s.length; i += budgetChars) out.push(s.slice(i, i + budgetChars).trim());
      continue;
    }
    if (cur.length + s.length > budgetChars && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Chunk a document's sections.
 * @param {Array} sections  tagged sections from normalize-text
 * @param {{docId:string, quarter:string, chunkTokens?:number, overlap?:number}} opts
 * @returns {Array<{chunk_id,doc_id,quarter,page_start,page_end,kind,speaker,approx_tokens,text}>}
 */
export function chunkSections(sections, { docId: doc_id, quarter, chunkTokens = 1500, overlap = 150 } = {}) {
  const maxChars = chunkTokens * 4;
  const overlapChars = Math.min(overlap * 4, Math.floor(maxChars * 0.2));
  const bodyBudget = maxChars - overlapChars;
  const chunks = [];
  let carry = "";

  const push = (secs, body) => {
    const text = (carry ? carry.trim() + "\n\n" : "") + body.trim();
    const pages = secs.map((s) => s.page);
    const speakers = [...new Set(secs.map((s) => s.speaker).filter(Boolean))];
    chunks.push({
      chunk_id: `${doc_id}-c${String(chunks.length + 1).padStart(3, "0")}`,
      doc_id,
      quarter,
      page_start: Math.min(...pages),
      page_end: Math.max(...pages),
      kind: mode(secs.map((s) => s.kind)),
      speaker: speakers.length === 1 ? speakers[0] : null,
      approx_tokens: approxTokens(text),
      text,
    });
    carry = body.length > overlapChars ? body.slice(-overlapChars) : body;
  };

  let buf = [];
  let bufChars = 0;
  const flush = () => {
    if (!buf.length) return;
    push(buf, buf.map(sectionText).join("\n\n"));
    buf = [];
    bufChars = 0;
  };

  for (const s of sections) {
    const st = sectionText(s);
    if (st.length > bodyBudget) {
      flush();
      for (const piece of splitText(st, bodyBudget)) push([s], piece);
      continue;
    }
    if (bufChars + st.length + 2 > bodyBudget && buf.length) flush();
    buf.push(s);
    bufChars += st.length + 2;
  }
  flush();
  return chunks;
}
