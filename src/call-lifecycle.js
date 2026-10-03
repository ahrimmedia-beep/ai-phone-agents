// The life of one phone call: start parameters, the greeting, barge-in,
// silence and length limits, and the single end of the call.

/**
 * @typedef {(message: string) => void} Log
 * @typedef {(ms: number) => Promise<void>} Sleep
 * @typedef {"timeout" | "silence"} TimerReason
 * @typedef {{ duration: number, reason?: string }} CallEnd
 * @typedef {Record<string, unknown>} Payload
 */

/** @type {Sleep} */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** End the call after this long with no speech from either side. */
export const SILENCE_MS = 15_000;
/** Hard limit for one call. */
export const MAX_CALL_MS = 120_000;
/** How often the watchdog checks the timers. */
export const WATCHDOG_INTERVAL_MS = 3_000;

/**
 * Parse the customData string that the n8n dialer sends when it starts an
 * outbound call. The error texts go to the webhook as they are.
 *
 * @param {string | null | undefined} raw
 * @param {{ defaultCallerId?: string }} [options]
 * @returns {{ ok: true, phone: string, name: string, callerId: string, data: Record<string, any> }
 *         | { ok: false, error: "Invalid customData" | "Missing phone" }}
 */
export function parseCustomData(raw, { defaultCallerId = "" } = {}) {
  /** @type {any} */
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Invalid customData" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Invalid customData" };
    }
  }

  const phone = String(data.phone || data.number || "");
  if (!phone) return { ok: false, error: "Missing phone" };

  return {
    ok: true,
    phone,
    name: String(data.name || data.contact_name || ""),
    callerId: data.callerID ? String(data.callerID) : defaultCallerId,
    data,
  };
}

/**
 * Pure timer check for a call in progress.
 * Silence counts only after the greeting, while the line is two-way.
 *
 * @param {{
 *   now: number, startedAt: number, lastVoiceAt: number, greetingDone: boolean,
 *   silenceMs?: number, maxMs?: number,
 * }} state
 * @returns {TimerReason | null}
 */
export function checkCallTimers({
  now,
  startedAt,
  lastVoiceAt,
  greetingDone,
  silenceMs = SILENCE_MS,
  maxMs = MAX_CALL_MS,
}) {
  if (now - startedAt > maxMs) return "timeout";
  if (greetingDone && now - lastVoiceAt > silenceMs) return "silence";
  return null;
}

/**
 * State of one call and its two exits, each of which runs at most once:
 * - abort(): the conversation never happened (no answer, dial error,
 *   OpenAI did not connect). No transcript is sent.
 * - finalize(): the conversation took place. Whatever comes first wins:
 *   the Disconnected event, the endCall tool or a timer. An early version
 *   sent "call_disconnected" twice, from endCall and from Disconnected.
 *
 * @param {{
 *   onFinalize: (end: CallEnd) => Promise<void> | void,
 *   onAbort: (hangup: boolean) => void,
 *   now?: () => number,
 * }} options
 */
export function createCallSession({ onFinalize, onAbort, now = Date.now }) {
  const startedAt = now();
  let lastVoiceAt = startedAt;
  let greetingDone = false;
  let aborted = false;
  let finalizing = false;
  /** @type {string | undefined} */
  let endReason;

  return {
    get done() {
      return aborted || finalizing;
    },
    get greetingDone() {
      return greetingDone;
    },

    markGreetingDone() {
      greetingDone = true;
    },

    /** Someone spoke: the caller started talking, or a turn was transcribed. */
    markVoice() {
      lastVoiceAt = now();
    },

    /**
     * Remember why the model ended the call. Our hangup fires Disconnected,
     * which then finalizes with the real duration and still keeps this reason.
     * @param {string} reason
     */
    setEndReason(reason) {
      endReason = reason;
    },

    /** @returns {TimerReason | null} */
    checkTimers() {
      return checkCallTimers({ now: now(), startedAt, lastVoiceAt, greetingDone });
    },

    /**
     * @param {number} [duration] seconds, from the Disconnected event; 0 when unknown.
     * @param {string} [reason]
     * @returns {Promise<boolean>} false when the call was already closed.
     */
    async finalize(duration = 0, reason) {
      if (aborted || finalizing) return false;
      finalizing = true;
      await onFinalize({ duration: duration || 0, reason: reason || endReason });
      return true;
    },

    /**
     * @param {boolean} hangup also hang up the phone line.
     * @returns {boolean} false when the call was already closed.
     */
    abort(hangup) {
      if (aborted || finalizing) return false;
      aborted = true;
      onAbort(hangup);
      return true;
    },
  };
}

/**
 * Backstop for a call that does not end by itself: the model may never call
 * endCall. Checks the timers on an interval and finalizes the call on silence
 * or at the time limit.
 *
 * @param {{ done: boolean, checkTimers: () => TimerReason | null,
 *           finalize: (duration?: number, reason?: string) => Promise<boolean> }} session
 * @param {{ sleep?: Sleep, intervalMs?: number, log?: Log }} [options]
 * @returns {Promise<TimerReason | null>} what ended the call, or null if it ended another way.
 */
export async function runWatchdog(session, { sleep: wait = sleep, intervalMs = WATCHDOG_INTERVAL_MS, log = () => {} } = {}) {
  while (!session.done) {
    await wait(intervalMs);
    if (session.done) break;
    const reason = session.checkTimers();
    if (reason) {
      log(`${reason}: finalizing the call`);
      await session.finalize(0, reason);
      return reason;
    }
  }
  return null;
}

/**
 * Poll until `isReady()` is true or the time is up. After a hangup the final
 * recording URL arrives a little later, so the last event waits for it.
 *
 * @param {() => boolean} isReady
 * @param {{ timeoutMs?: number, stepMs?: number, sleep?: Sleep }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitUntil(isReady, { timeoutMs = 5_000, stepMs = 500, sleep: wait = sleep } = {}) {
  let waited = 0;
  while (!isReady() && waited < timeoutMs) {
    await wait(stepMs);
    waited += stepMs;
  }
  return isReady();
}

/**
 * Audio routing between the phone call and the OpenAI client.
 *
 * During the greeting, audio goes one way only: OpenAI to the call. When the
 * greeting audio ends, the caller's audio is connected too, and the input
 * buffer is cleared to drop echo. Later, when the caller starts talking over
 * the agent, the buffer is cleared again so the agent stops at once (barge-in).
 *
 * @param {{
 *   call: { sendMediaTo: (target: unknown) => void },
 *   client: { clearMediaBuffer: () => void },
 *   onOpen?: () => void,
 *   delaysMs?: readonly [number, number],
 *   sleep?: Sleep,
 *   log?: Log,
 * }} options
 */
export function createMediaBridge({ call, client, onOpen = () => {}, delaysMs = [100, 100], sleep: wait = sleep, log = () => {} }) {
  let open = false;

  return {
    get isOpen() {
      return open;
    },

    /**
     * Open the caller -> OpenAI direction. Runs once, even when both the
     * "media ended" event and a fallback timer fire.
     * @param {string} [via] what triggered it, for the log.
     * @returns {Promise<boolean>}
     */
    async openTwoWay(via = "media-ended") {
      if (open) return false;
      open = true;
      onOpen();
      log(`two-way audio via ${via}`);
      await wait(delaysMs[0]);
      try {
        call.sendMediaTo(client);
      } catch (err) {
        log(`sendMediaTo error: ${err}`);
      }
      await wait(delaysMs[1]);
      try {
        client.clearMediaBuffer();
      } catch (err) {
        log(`clearMediaBuffer error: ${err}`);
      }
      return true;
    },

    /** The caller started talking: drop the audio the agent has queued. */
    bargeIn() {
      try {
        client.clearMediaBuffer();
      } catch (err) {
        log(`clearMediaBuffer error: ${err}`);
      }
    },
  };
}

/**
 * The end of a conversation, in a fixed order:
 * 1. wait for the final recording URL, when recording is on;
 * 2. if the model never saved a lead but the caller spoke, recover the lead
 *    from the transcript and send it, so a real conversation is never lost;
 * 3. send one "call_disconnected" event with the transcript;
 * 4. close the OpenAI client, hang up and end the session.
 *
 * @param {CallEnd} end
 * @param {{
 *   transcript: { toText: () => string, hasUserTurns: () => boolean },
 *   getLead: () => { name?: string } | null | undefined,
 *   setLead: (lead: any) => void,
 *   send: (payload: Payload) => Promise<boolean>,
 *   close: () => void,
 *   recoverLead?: () => Promise<object>,
 *   waitForRecording?: () => Promise<unknown>,
 *   log?: Log,
 * }} deps
 */
export async function finalizeCall({ duration, reason }, deps) {
  const { transcript, getLead, setLead, send, close, recoverLead, waitForRecording, log = () => {} } = deps;

  if (waitForRecording) await waitForRecording();

  const summary = transcript.toText();
  const current = getLead();

  if (recoverLead && !(current && current.name) && transcript.hasUserTurns()) {
    log("no lead from the tool: recovering it from the transcript");
    const lead = await recoverLead();
    setLead(lead);
    await send({ event: "lead_captured", lead });
  }

  /** @type {Payload} */
  const payload = { event: "call_disconnected", duration: duration || 0, summary };
  if (reason) payload.reason = reason;
  await send(payload);

  close();
}
