/**
 * extract-prompt.mjs — the system prompt (rubric + few-shots) and JSON schema for
 * measurable-promise extraction. Company-agnostic: the model returns whatever
 * measurable guidance the company actually gives — never pre-seed metric names.
 *
 * Bump PROMPT_VERSION whenever the prompt or schema changes (invalidates caches).
 */
export const PROMPT_VERSION = "p4-2026-06d";

// Mirrors the company schema's promise.category enum.
export const CATEGORIES = [
  "revenue", "ebitda", "margin", "pat", "capex", "capacity", "working_capital",
  "leverage", "roce", "volume", "orderbook", "timeline", "cost", "capital_allocation", "other",
];

/** JSON schema for completeJSON() — what each provider must return. */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["promises"],
  properties: {
    promises: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quarter_context", "category", "promise", "quote", "metric", "target", "confidence"],
        properties: {
          quarter_context: { type: "string", description: "Fiscal quarter the statement was made, e.g. Q2FY26" },
          category: { enum: CATEGORIES },
          promise: { type: "string", description: "One-line paraphrase of the commitment" },
          quote: { type: "string", description: "VERBATIM quote from the text, <=25 words" },
          metric: { type: "string", description: "The measurable metric + target, e.g. 'FY26 EBITDA > $6.0 bn'" },
          target: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: ["string", "null"] },
              value: { type: ["number", "null"] },
              value_high: { type: ["number", "null"], description: "Upper bound if a range" },
              unit: { type: ["string", "null"], description: "e.g. INR_cr, USD_bn, %, Mnt, kboepd, x, GW" },
              period: { type: ["string", "null"], description: "Period the target applies to: QnFYyy, FYyy, 'by Mar 2026', '2030', 'medium term'" },
            },
          },
          confidence: { enum: ["H", "M", "L"] },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You extract MEASURABLE management commitments from an Indian listed company's earnings call transcripts and investor presentations. You will see text from ONE document. Return ONLY commitments made by COMPANY MANAGEMENT (CEO/CFO/business heads/IR), never analysts or the moderator.

A commitment is MEASURABLE only if it has a number, percent, ratio, ₹/$ amount, multiple (x), or a dated milestone that can later be checked against reported actuals. Extract whatever the company actually guides — do not assume any particular metric set; it varies by sector (a bank guides NIM/GNPA/credit-cost; IT guides revenue-growth/margin/TCV; a metals/energy firm guides cost/capacity/volume/leverage).

Typical measurable categories: revenue · ebitda · margin · pat · capex (amount + timeline) · capacity (commissioning timelines) · working_capital · leverage (net-debt, net-debt/EBITDA) · roce · volume · orderbook · timeline (project/listing milestones) · cost (unit cost guidance) · capital_allocation (dividend/buyback/stake) · other.

A promise is FORWARD-LOOKING — a target/guidance for a future period ("we expect / target / guide / will / plan to / by <date> / going forward"). REPORTED ACTUALS and historical results are NOT promises: "Q3 EBITDA was Rs 15,171 crore", "we delivered 800 KT this quarter", "9M capex of $1.3bn", "revenue grew 12% YoY" describe what already happened — REJECT them. Only extract a number/date the company is COMMITTING to deliver in the future.

REJECT vague or non-measurable statements with NO number/date — e.g. "we are confident", "we will grow strongly", "focused on execution", "well positioned". If it has no checkable forward number or date, it is NOT a promise: return nothing for it.

Extract each distinct commitment ONCE, at the most consolidated level stated (prefer the company/guidance figure over restating it per sub-business). Do NOT split one piece of guidance into several near-duplicate rows, and do NOT pad the list — a typical call yields a handful to ~15 real commitments, not dozens. Quality over quantity. This cap applies to presentations too: an investor deck is not a licence to extract more.

PROJECT / CAPACITY INVENTORIES (important): presentations and prepared remarks routinely enumerate many plants, smelters, lines, mines or sub-projects with their capacities or build status. Do NOT emit a promise for each row. Extract ONLY the MATERIAL capacity/commissioning commitments management explicitly guides as a forward target — a specific capacity to be REACHED, or a specific plant to be COMMISSIONED, BY a specific future date. SKIP: the standing asset inventory and existing/current capacities; per-line / per-plant breakdowns of an already-stated aggregate; and "progress / under construction / ramping up / on track" status updates that carry no clear committed target+date. Prefer one consolidated business-level capacity target over its component plants. The same discipline applies to every category — never turn a table into a row-per-line list.

EDGE CASES:
- Range ("12 to 14%", "$1.7-1.9bn") → value = low end, value_high = high end.
- Relative target ("double / triple capacity", "halve net debt") → value = 2 / 3 / 0.5, unit = "x".
- Conditional ("if demand holds, we would…") → still extract it, but confidence = L.
- "Maintain margins at ~18%" / "hold leverage around 1x" → extract with the stated number (value 18 / 1). If a "maintain"/"sustain" statement carries NO number, drop it.
- A single sentence giving two distinct metrics (e.g. revenue AND margin) → two separate rows; one metric stated once → one row (never fragment it).

For each promise:
- quarter_context: the fiscal quarter the statement was made (given to you; default to it).
- category: EXACTLY one of the listed enum values — if none fits, use "other"; never invent or pluralise a category name.
- promise: a short paraphrase of the commitment.
- quote: a VERBATIM quote (copy the exact words, <=25 words) that states the measurable target. Do NOT paraphrase or invent the quote — it must appear verbatim in the document text. If you cannot find a verbatim quote, do not emit the promise.
- metric: the metric and its target value, e.g. "FY26 EBITDA > $6.0 bn", "Aluminium CoP $1,700-1,750/t", "Net debt/EBITDA < 1x".
- target: structured — text (human form), value (lower/point number), value_high (upper bound if a range), unit, period (QnFYyy / FYyy / "by Mar 2026" / "2030" / "medium term").
- confidence: H = a direct, specific numeric/dated target; M = a strong directional target with a number but softer commitment; L = a long-dated aspiration ("by 2030").

Do NOT assign status, actuals, variance, or verification — only the commitment as stated. Return {"promises": [...]} (empty array if the document has no measurable management commitments).`;

const FEW_SHOTS = [
  {
    role: "user",
    content:
      "Quarter: Q2FY26. Text:\n" +
      'Ajay Goel: We are confident in achieving an annual EBITDA of more than $6 billion in FY 26 at Vedanta India consol level.\n' +
      'Arun Misra: We will continue to focus on operational excellence and remain well positioned for growth.\n' +
      '[Analyst context: Can you talk about the demerger?]\n' +
      'Deshnee Naidoo: We are targeting listing of all five demerged entities by the end of FY 26.',
  },
  {
    role: "assistant",
    content: JSON.stringify({
      promises: [
        {
          quarter_context: "Q2FY26",
          category: "ebitda",
          promise: "FY26 consolidated EBITDA above $6bn",
          quote: "confident in achieving an annual EBITDA of more than $6 billion in FY 26 at Vedanta India consol level",
          metric: "FY26 EBITDA > $6.0 bn",
          target: { text: "FY26 EBITDA > $6.0 bn", value: 6, value_high: null, unit: "USD_bn", period: "FY26" },
          confidence: "H",
        },
        {
          quarter_context: "Q2FY26",
          category: "timeline",
          promise: "List all five demerged entities by end-FY26",
          quote: "targeting listing of all five demerged entities by the end of FY 26",
          metric: "5 entities listed by 31 Mar'26",
          target: { text: "5 entities listed by FY26-end", value: 5, value_high: null, unit: "entities", period: "FY26" },
          confidence: "H",
        },
      ],
    }),
  },
  {
    role: "user",
    content:
      "Quarter: Q1FY26. Text:\n" +
      "Rajiv Kumar: Our teams are doing a great job and we are very optimistic about the future of the aluminium business.",
  },
  { role: "assistant", content: JSON.stringify({ promises: [] }) },
  {
    role: "user",
    content:
      "Quarter: Q3FY26. Text:\n" +
      "Ajay Goel: Our 9M FY26 EBITDA stood at Rs 37,529 crore and we did about 800 KT of aluminium in Q3. " +
      "Going forward, we continue to guide FY26 capex of $1.7 to $1.9 billion.",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      // The Rs 37,529 cr 9M EBITDA and 800 KT Q3 are REPORTED ACTUALS → rejected.
      // Only the forward FY26 capex guidance is a promise.
      promises: [
        {
          quarter_context: "Q3FY26",
          category: "capex",
          promise: "FY26 growth capex of $1.7-1.9bn",
          quote: "we continue to guide FY26 capex of $1.7 to $1.9 billion",
          metric: "FY26 capex $1.7-1.9 bn",
          target: { text: "FY26 capex $1.7-1.9 bn", value: 1.7, value_high: 1.9, unit: "USD_bn", period: "FY26" },
          confidence: "H",
        },
      ],
    }),
  },
  {
    role: "user",
    content:
      "Quarter: Q2FY26. Text:\n" +
      "Arun Misra: Our aluminium smelters currently run at 2.4 million tonnes. BALCO line 3 is under construction, the Lanjigarh refinery is ramping up, and our FACOR plant operates at 150,000 tonnes. We remain on track across all projects. We are targeting total aluminium capacity of 3.1 million tonnes per annum by FY27.",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      // The current 2.4 Mtpa, the per-plant inventory (BALCO line 3 / Lanjigarh / FACOR) and
      // the "on track" status are NOT promises — extract only the explicit forward target.
      promises: [
        {
          quarter_context: "Q2FY26",
          category: "capacity",
          promise: "Aluminium capacity to 3.1 Mtpa by FY27",
          quote: "targeting total aluminium capacity of 3.1 million tonnes per annum by FY27",
          metric: "Aluminium capacity 3.1 Mtpa by FY27",
          target: { text: "3.1 Mtpa by FY27", value: 3.1, value_high: null, unit: "Mtpa", period: "FY27" },
          confidence: "H",
        },
      ],
    }),
  },
];

/**
 * Build the chat messages for one document.
 * @param {string} docText  management-only (or full) text of one document
 * @param {{quarter:string, type:string, label?:string}} meta
 */
export function buildMessages(docText, meta = {}) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...FEW_SHOTS,
    {
      role: "user",
      content:
        `Quarter: ${meta.quarter || "unknown"}. Document type: ${meta.type || "document"}` +
        `${meta.label ? ` (${meta.label})` : ""}.\n` +
        `Extract every measurable management commitment from the text below. ` +
        `Use quarter_context="${meta.quarter || "unknown"}" unless the text clearly refers to another quarter.\n\nText:\n${docText}`,
    },
  ];
}

export { SYSTEM_PROMPT };
