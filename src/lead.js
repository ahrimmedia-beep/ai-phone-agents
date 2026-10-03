// The call transcript and the lead built from it.
//
// The normal path: the model calls the saveLead tool and leadFromToolArgs maps
// its arguments. The backup path: the model never called saveLead, so the lead
// is recovered from the transcript after the call. An LLM extraction runs first,
// and a regex guess fills the gaps when the extraction fails.

/**
 * @typedef {"assistant" | "user"} Role
 * @typedef {{ role: Role, text: string, timestamp: string }} Turn
 * @typedef {{
 *   name: string, contact: string, budget: string, area: string, beds: string,
 *   status: string, timeline: string, temperature: string, comment: string,
 * }} Lead
 * @typedef {{ name: string, area: string, beds: string, comment: string }} LeadGuess
 * @typedef {{ phone: string, contactName?: string }} CallContext
 * @typedef {{ code: number, text?: string }} HttpResponse
 */

const DEFAULT_TEMPERATURE = "warm";

/** Same falsy rules as `value || ""` in the scenarios, but always a string. */
const str = (/** @type {unknown} */ value) => (value ? String(value) : "");

/** A value that is not blank after trimming. */
const hasText = (/** @type {unknown} */ value) => !!value && String(value).trim() !== "";

/**
 * Collect the finished turns of both sides of the call.
 *
 * @param {{ assistantLabel: string, userLabel: string, now?: () => Date }} options
 */
export function createTranscript({ assistantLabel, userLabel, now = () => new Date() }) {
  /** @type {Turn[]} */
  const turns = [];

  return {
    /** @returns {readonly Turn[]} */
    get turns() {
      return turns;
    },

    /**
     * Add a turn. Empty or whitespace-only text is skipped.
     * @param {Role} role
     * @param {unknown} text
     * @returns {boolean} true when the turn was added.
     */
    add(role, text) {
      const clean = typeof text === "string" ? text.trim() : "";
      if (!clean) return false;
      turns.push({ role, text: clean, timestamp: now().toISOString() });
      return true;
    },

    /** The caller said something, so there was a real conversation. */
    hasUserTurns() {
      return turns.some((turn) => turn.role === "user");
    },

    /** One "[Label] text" line per turn. This goes to the CRM as the call summary. */
    toText() {
      return turns
        .map((turn) => `[${turn.role === "assistant" ? assistantLabel : userLabel}] ${turn.text}`)
        .join("\n");
    },
  };
}

/**
 * Map the saveLead tool arguments to a lead. The phone number of the call is
 * the default contact.
 *
 * @param {Record<string, unknown>} args
 * @param {CallContext} context
 * @returns {Lead}
 */
export function leadFromToolArgs(args, { phone, contactName = "" }) {
  return {
    name: str(args.client_name) || contactName,
    contact: str(args.contact) || phone,
    budget: str(args.budget),
    area: str(args.area),
    beds: str(args.beds),
    status: str(args.status),
    timeline: str(args.timeline),
    temperature: str(args.temperature) || DEFAULT_TEMPERATURE,
    comment: str(args.comment),
  };
}

const NAME_PATTERN =
  /\b(?:my name is|i am|i'?m|this is|it'?s|name is|name'?s|speaking with)\s+([A-Za-z][a-z]{1,20})/i;
// "studio" stands alone; a number needs "bed", "bedroom" or "BR" after it.
const BEDS_PATTERN = /\b(?:(studio)|([1-5])\s*-?\s*(?:bed|bedroom|br))\b/i;

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rough lead fields from the transcript, with no network call.
 * It returns clean fields and a short comment, never the raw dialogue.
 * The name pattern is a heuristic and can catch a wrong word after "I'm",
 * so the LLM result always wins when it has a value.
 *
 * @param {readonly Turn[]} turns
 * @param {{ areas?: readonly string[], aliases?: Readonly<Record<string, string>> }} [options]
 *   areas: names to look for, in priority order. aliases: short name -> full name.
 * @returns {LeadGuess}
 */
export function guessLead(turns, { areas = [], aliases = {} } = {}) {
  const userText = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("  ");
  const allText = turns.map((turn) => turn.text).join("  ");

  const nameMatch = userText.match(NAME_PATTERN);
  const bedsMatch = allText.match(BEDS_PATTERN);

  let area = "";
  for (const candidate of areas) {
    const pattern = new RegExp(`\\b${escapeRegExp(candidate).replace(/ /g, "\\s*")}\\b`, "i");
    if (pattern.test(allText)) {
      area = Object.hasOwn(aliases, candidate) ? aliases[candidate] : candidate;
      break;
    }
  }

  const beds = bedsMatch ? (bedsMatch[1] ? "studio" : bedsMatch[2]) : "";
  const name = nameMatch ? nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1) : "";

  const parts = [];
  if (beds) parts.push(beds === "studio" ? "studio" : `${beds}BR`);
  if (area) parts.push(`in ${area}`);

  return { name, area, beds, comment: parts.length ? `Wants ${parts.join(" ")}` : "" };
}

/**
 * Merge the LLM extraction with the regex guess. Extracted values win; the
 * guess and the call context fill what is missing.
 *
 * @param {Record<string, unknown>} extracted
 * @param {LeadGuess} guess
 * @param {CallContext} context
 * @returns {Lead}
 */
export function mergeRecoveredLead(extracted, guess, { phone, contactName = "" }) {
  return {
    name: hasText(extracted.client_name) ? String(extracted.client_name).trim() : guess.name || contactName,
    contact: hasText(extracted.contact) ? String(extracted.contact).trim() : phone,
    budget: str(extracted.budget),
    area: str(extracted.area) || guess.area,
    beds: str(extracted.beds) || guess.beds,
    status: str(extracted.status),
    timeline: str(extracted.timeline),
    temperature: str(extracted.temperature) || DEFAULT_TEMPERATURE,
    comment: hasText(extracted.comment) ? String(extracted.comment).trim() : guess.comment,
  };
}

/**
 * Chat Completions request in JSON mode for the lead extraction.
 * The system prompt is passed in: it lives in a private module.
 *
 * @param {string} systemPrompt
 * @param {string} transcriptText
 * @param {{ model?: string }} [options]
 */
export function buildExtractionRequest(systemPrompt, transcriptText, { model = "gpt-4o-mini" } = {}) {
  return {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: transcriptText },
    ],
  };
}

/**
 * Read the extracted lead from a Chat Completions response.
 * Any failure (HTTP error, bad JSON, empty content) gives null.
 *
 * @param {HttpResponse | null | undefined} res
 * @returns {Record<string, unknown> | null}
 */
export function parseExtractionResponse(res) {
  if (!res || res.code < 200 || res.code >= 300) return null;
  try {
    const body = JSON.parse(res.text ?? "");
    const content = body?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The backup path in one call: extract with the LLM, guess with regex, merge.
 * The lead is always produced, even when the extraction fails.
 *
 * @param {{ turns: readonly Turn[], toText: () => string }} transcript
 * @param {CallContext & {
 *   extract: (transcriptText: string) => Promise<Record<string, unknown> | null>,
 *   areas?: readonly string[],
 *   aliases?: Readonly<Record<string, string>>,
 * }} options
 * @returns {Promise<Lead>}
 */
export async function recoverLead(transcript, { extract, areas, aliases, phone, contactName }) {
  const extracted = (await extract(transcript.toText()).catch(() => null)) || {};
  const guess = guessLead(transcript.turns, { areas, aliases });
  return mergeRecoveredLead(extracted, guess, { phone, contactName });
}
