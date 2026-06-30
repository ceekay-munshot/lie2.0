/**
 * normalize-text.mjs — deterministic cleanup + structural tagging of extracted
 * PDF text. No LLM. Two document shapes:
 *
 *   transcript   → speaker turns {kind, speaker, role, page, text}, roles tagged
 *                  from the MANAGEMENT roster; prepared_remarks vs qa segmented.
 *   presentation → one slide per page {kind:"slide", page, title, is_guidance, text}.
 *
 * De-boilerplate strips recurring header/footer lines (lines on ≥40% of pages),
 * "Page X of Y", "Sensitivity: …", and bare page numbers; de-hyphenates wrapped
 * words and collapses whitespace while keeping paragraph boundaries.
 */

const GUIDANCE_RE = /\b(guidance|outlook|target|deleverag|capex|guided|aspiration)\b/i;

const normLine = (l) => String(l).replace(/[ \t ]+/g, " ").trim();
const dehyphenate = (t) => t.replace(/([A-Za-z])-\n([a-z])/g, "$1$2");
const titleCase = (s) =>
  s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
const lastName = (n) => n.trim().split(/\s+/).pop().toLowerCase();

// Classification footers / page markers can appear mid-line (decks), so strip
// them globally — not just as whole lines.
const stripInline = (t) =>
  String(t || "")
    .replace(/Sensitivity\s*:\s*[A-Za-z]+(?:\s*\([A-Za-z]?\d\))?/gi, " ")
    .replace(/\bPage\s+\d+\s+of\s+\d+\b/gi, " ");

/** Is this line recurring boilerplate by pattern (page numbers, sensitivity)? */
function isBoilerplateLine(line) {
  const s = normLine(line);
  if (!s) return false;
  if (/^Page\s+\d+\s+of\s+\d+$/i.test(s)) return true;
  if (/^Sensitivity\s*:/i.test(s)) return true;
  if (/^\d{1,3}$/.test(s)) return true; // bare page / slide number
  return false;
}

/**
 * Remove boilerplate from per-page text.
 * @returns {{cleanedPages:string[], removed:string[]}}
 */
export function cleanPages(pages, { threshold = 0.4 } = {}) {
  const pageLines = pages.map((p) => stripInline(p).split(/\r?\n/));
  const nPages = pages.length;

  // Count distinct normalized lines once per page → header/footer detection.
  const freq = new Map();
  for (const lines of pageLines) {
    const seen = new Set();
    for (const l of lines) {
      const s = normLine(l);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      freq.set(s, (freq.get(s) || 0) + 1);
    }
  }
  const repeated = new Set();
  if (nPages >= 3) {
    for (const [s, c] of freq) {
      if (s.length <= 80 && c / nPages >= threshold) repeated.add(s);
    }
  }

  const removed = new Set();
  const cleanedPages = pageLines.map((lines) => {
    const kept = [];
    for (const l of lines) {
      const s = normLine(l);
      if (!s) {
        kept.push("");
        continue;
      }
      if (isBoilerplateLine(l) || repeated.has(s)) {
        removed.add(s);
        continue;
      }
      kept.push(s);
    }
    return dehyphenate(kept.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
  });

  return { cleanedPages, removed: [...removed] };
}

/* ----------------------------------------------------------------------------
 * Transcripts
 * ------------------------------------------------------------------------- */

/** Parse the MANAGEMENT roster → name lookup set (full + last names) + people. */
export function parseRoster(fullText) {
  const roster = new Set();
  const people = [];
  const block = (fullText.match(/MANAGEMENT\s*:([\s\S]{0,2000})/i) || [, ""])[1];
  // Each "MR./MS./DR. NAME – Title" entry. Name = caps tokens up to the dash;
  // title is bounded by a lookahead to the next honorific so names aren't eaten.
  const re = /\b(?:MR|MS|MRS|DR)\.?\s+([A-Z][A-Za-z'’.]+(?:\s+[A-Z][A-Za-z'’.]+){1,3})\s*[–-]\s*([^\n]*?)(?=\s+(?:MR|MS|MRS|DR)\.\s|\n|$)/g;
  let m;
  while ((m = re.exec(block))) {
    const name = m[1].replace(/\s+/g, " ").trim();
    if (name.split(/\s+/).length < 2) continue;
    roster.add(name.toLowerCase());
    roster.add(lastName(name));
    people.push({ name: titleCase(name), title: normLine(m[2]).replace(/[,;].*$/, "").trim() });
  }
  return { roster, people };
}

/** Classify a speaker name → management | analyst | moderator | null. */
export function classifyRole(name, roster) {
  const n = name.trim();
  if (/^(moderator|operator)$/i.test(n)) return "moderator";
  if (roster.has(n.toLowerCase()) || roster.has(lastName(n))) return "management";
  const tokens = n.split(/\s+/);
  if (tokens.length >= 2 && tokens.length <= 4 && tokens.every((t) => /^[A-Z]/.test(t))) {
    return "analyst"; // a named participant not on the management roster
  }
  return null;
}

const TURN_RE = /^([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){0,3})\s*:\s+(.+)$/;
// Some vendors put the speaker NAME on its own line (colon-terminated), with the
// utterance on the following lines — e.g. "Salil Parekh:\n<speech>". Require ≥2
// capitalised tokens so it reads as a person, not a heading like "Outlook:".
const SPEAKER_EOL_RE = /^([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,3})\s*:\s*$/;
const MOD_EOL_RE = /^(Moderator|Operator)\s*:\s*$/i;
const MIN_REAL_TURNS = 3; // below this the primary parse is presumed to have missed the format
const QA_START_RE = /(?:we will now begin the question|first question (?:is|comes|will be) from|question[-\s]and[-\s]answer session|begin the q\s*&\s*a)/i;

/** A speaker-header line → {speaker, rest}. `eol` also accepts a name-only colon line. */
function speakerHeader(l, eol) {
  const mi = l.match(TURN_RE);
  if (mi) return { speaker: mi[1].trim(), rest: mi[2] };
  if (eol) {
    const me = l.match(SPEAKER_EOL_RE) || l.match(MOD_EOL_RE);
    if (me) return { speaker: me[1].trim(), rest: "" };
  }
  return null;
}

/**
 * Derive a management roster when the document has no parseable MANAGEMENT block:
 * speakers in the PREPARED-REMARKS section (before the Q&A announcement) are management
 * — analysts only speak during Q&A. Falls back to all non-moderator speakers.
 */
function deriveRoster(lines) {
  let qaAt = lines.findIndex(({ l }) => QA_START_RE.test(l));
  if (qaAt < 0) qaAt = lines.length;
  const before = new Set();
  const all = new Set();
  lines.forEach(({ l }, i) => {
    const h = speakerHeader(l, true);
    if (!h || /^(moderator|operator)$/i.test(h.speaker)) return;
    for (const k of [h.speaker.toLowerCase(), lastName(h.speaker)]) {
      all.add(k);
      if (i < qaAt) before.add(k);
    }
  });
  return before.size ? before : all;
}

/** Core turn assembler. `roleOf` resolves a speaker's role; `eol`/`requireRole` tune detection. */
function assembleTurns(lines, roleOf, { eol, requireRole }) {
  const turns = [];
  let front = null;
  let cur = null;
  for (const { l, page } of lines) {
    const h = speakerHeader(l, eol);
    const role = h ? roleOf(h.speaker) : null;
    if (h && (!requireRole || role)) {
      if (cur) turns.push(cur);
      cur = { kind: "prepared_remarks", speaker: h.speaker, role, page, _lines: h.rest ? [h.rest] : [] };
    } else if (cur) {
      cur._lines.push(l);
    } else {
      (front ||= { kind: "front_matter", speaker: null, role: null, page, _lines: [] })._lines.push(l);
    }
  }
  if (cur) turns.push(cur);

  const finalize = (t) => ({
    kind: t.kind, speaker: t.speaker, role: t.role, page: t.page,
    text: dehyphenate(t._lines.join("\n")).replace(/\s+/g, " ").trim(),
  });

  let inQA = false;
  const out = [];
  if (front && front._lines.length) out.push(finalize(front));
  for (const t of turns) {
    if (!inQA && t.role === "moderator" && QA_START_RE.test(t._lines.join(" "))) inQA = true;
    t.kind = inQA ? "qa" : "prepared_remarks";
    out.push(finalize(t));
  }
  return out;
}

/**
 * Split cleaned transcript pages into speaker turns, tagging roles and segmenting
 * prepared_remarks vs qa.
 * @returns {Array<{kind,speaker,role,page,text}>}
 */
export function splitTurns(cleanedPages, roster) {
  // Flatten to {line, page}, dropping blank lines.
  const lines = [];
  cleanedPages.forEach((pg, i) => {
    for (const raw of pg.split(/\n/)) {
      const l = normLine(raw);
      if (l) lines.push({ l, page: i + 1 });
    }
  });

  // Primary: roster-driven, inline "Name: text" only (unchanged for transcripts that fit).
  const primary = assembleTurns(lines, (sp) => classifyRole(sp, roster), { eol: false, requireRole: true });
  const realTurns = primary.filter((s) => s.role === "management" || s.role === "analyst").length;
  if (realTurns >= MIN_REAL_TURNS) return primary;

  // Fallback: the transcript uses a layout the primary missed (speaker name on its own
  // line, and/or no MANAGEMENT roster block — e.g. Infosys). Derive the roster from the
  // prepared-remarks speakers and accept name-only colon lines as turns.
  const derived = deriveRoster(lines);
  const roleOf = (sp) => {
    if (/^(moderator|operator)$/i.test(sp)) return "moderator";
    if (classifyRole(sp, roster) === "management") return "management";
    if (derived.has(sp.toLowerCase()) || derived.has(lastName(sp))) return "management";
    return "analyst";
  };
  const fallback = assembleTurns(lines, roleOf, { eol: true, requireRole: false });
  const fbReal = fallback.filter((s) => s.role === "management" || s.role === "analyst").length;
  return fbReal > realTurns ? fallback : primary;
}

/** Normalize a transcript document → sections. */
export function normalizeTranscript(pages, opts = {}) {
  const { cleanedPages, removed } = cleanPages(pages, opts);
  const { roster, people } = parseRoster(pages.join("\n"));
  const sections = splitTurns(cleanedPages, roster);
  return { sections, roster: people, removed };
}

/* ----------------------------------------------------------------------------
 * Presentations
 * ------------------------------------------------------------------------- */

/** First non-empty line(s) of a slide → a short title. */
function slideTitle(text) {
  const line = text.split(/\n/).map(normLine).find(Boolean) || "";
  return line.slice(0, 90);
}

/** Normalize a presentation → one slide section per page. */
export function normalizePresentation(pages, opts = {}) {
  const { cleanedPages, removed } = cleanPages(pages, opts);
  const sections = cleanedPages.map((pg, i) => {
    const text = pg.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    return {
      kind: "slide",
      speaker: null,
      role: null,
      page: i + 1,
      title: slideTitle(text),
      is_guidance: GUIDANCE_RE.test(text),
      text,
    };
  });
  return { sections, removed };
}

/** Dispatch by document type. annual_report is treated like a presentation. */
export function normalizeDocument(type, pages, opts = {}) {
  if (type === "transcript") return normalizeTranscript(pages, opts);
  return normalizePresentation(pages, opts);
}
