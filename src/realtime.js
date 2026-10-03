// Glue between the call and the OpenAI Realtime client inside VoxEngine:
// the session config, reading event payloads, and routing function calls.

/**
 * @typedef {(message: string) => void} Log
 * @typedef {{ name?: string, args?: string, callId?: string }} FunctionCall
 * @typedef {(args: Record<string, unknown>) => unknown} FunctionHandler
 * @typedef {{ addEventListener: (event: unknown, handler: (event: any) => void) => void }} EventTarget
 */

/** Server-side voice activity detection. The caller can interrupt the agent. */
export const TURN_DETECTION = Object.freeze({
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 600,
  create_response: true,
  interrupt_response: true,
});

/**
 * Build the session.update payload in the Realtime GA format
 * (a nested `session` with `audio.input` and `audio.output`).
 * The persona instructions and the tool schemas are passed in: they live in
 * a private module.
 *
 * @param {object} options
 * @param {string} options.instructions
 * @param {string} options.voice
 * @param {unknown[]} options.tools
 * @param {string} [options.transcribeModel]
 * @param {string} [options.language] Pin it for a one-language agent. Without it,
 *   short replies were sometimes transcribed as a different language.
 */
export function buildSessionUpdate({
  instructions,
  voice,
  tools,
  transcribeModel = "gpt-4o-transcribe",
  language,
}) {
  /** @type {{ model: string, language?: string }} */
  const transcription = { model: transcribeModel };
  if (language) transcription.language = language;

  return {
    session: {
      type: "realtime",
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription,
          noise_reduction: { type: "near_field" },
          turn_detection: { ...TURN_DETECTION },
        },
        output: { voice },
      },
      tools,
      tool_choice: "auto",
    },
  };
}

/**
 * Read a field from a Realtime event. Depending on the SDK version, it sits
 * on the event, on `event.data` or on `event.data.payload`.
 * Do not use it for the function name: `event.name` is the event type.
 *
 * @param {any} event
 * @param {string} name
 * @returns {any}
 */
export function field(event, name) {
  if (!event) return undefined;
  if (event[name] !== undefined && event[name] !== null) return event[name];
  const data = event.data;
  if (data) {
    if (data[name] !== undefined && data[name] !== null) return data[name];
    const payload = data.payload;
    if (payload && payload[name] !== undefined && payload[name] !== null) return payload[name];
  }
  return undefined;
}

/**
 * Text of a finished transcript event (agent or caller), trimmed.
 * @param {any} event
 */
export function readTranscript(event) {
  const text = field(event, "transcript");
  return typeof text === "string" ? text.trim() : "";
}

/**
 * Function call from the "arguments done" event. Real call logs showed the
 * fields in `event.data.payload`, not in `event.data`.
 *
 * @param {any} event
 * @returns {FunctionCall}
 */
export function functionCallFromArgsDone(event) {
  const data = (event && event.data && event.data.payload) || (event && event.data) || {};
  return { name: data.name, args: data.arguments, callId: data.call_id };
}

/**
 * Every function call in a finished response. This is the fallback path for
 * calls that the "arguments done" event missed.
 *
 * @param {any} event
 * @returns {FunctionCall[]}
 */
export function functionCallsFromResponseDone(event) {
  const response = field(event, "response") || {};
  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .filter((/** @type {any} */ item) => item && item.type === "function_call")
    .map((/** @type {any} */ item) => ({ name: item.name, args: item.arguments, callId: item.call_id }));
}

/**
 * One entry point for both function-call paths. A call_id is handled once, so a
 * lead is never sent twice. Bad JSON, an unknown name or a handler that throws
 * is logged and does not break the call.
 *
 * @param {Record<string, FunctionHandler>} handlers
 * @param {{ log?: Log }} [options]
 * @returns {(call: FunctionCall) => Promise<boolean>} resolves true when a handler ran to the end.
 */
export function createFunctionCallRouter(handlers, { log = () => {} } = {}) {
  const seen = new Set();

  return async function route({ name, args, callId }) {
    if (callId) {
      if (seen.has(callId)) return false;
      seen.add(callId);
    }
    log(`function: name=${name} call_id=${callId} args=${args}`);
    try {
      const parsed = JSON.parse(args || "{}");
      if (!name || !Object.hasOwn(handlers, name)) return false;
      await handlers[name](parsed);
      return true;
    } catch (err) {
      log(`function error: ${err}`);
      return false;
    }
  };
}

/**
 * Subscribe without trusting that the event constant exists. Event names
 * differ between VoxEngine versions. A missing one is logged and skipped,
 * so the scenario keeps running.
 *
 * @param {EventTarget} target
 * @param {() => unknown} getEvent
 * @param {string} label
 * @param {(event: any) => void} handler
 * @param {Log} [log]
 * @returns {boolean} true when the listener was added.
 */
export function subscribeSafely(target, getEvent, label, handler, log = () => {}) {
  let event;
  try {
    event = getEvent();
  } catch (err) {
    log(`WARN: no namespace for event ${label}: ${err}`);
    return false;
  }
  if (event === undefined || event === null) {
    log(`WARN: event is undefined: ${label}`);
    return false;
  }
  try {
    target.addEventListener(event, handler);
    return true;
  } catch (err) {
    log(`WARN: addEventListener failed for ${label}: ${err}`);
    return false;
  }
}
