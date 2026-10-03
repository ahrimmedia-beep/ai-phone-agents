import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CALL_MS,
  SILENCE_MS,
  checkCallTimers,
  createCallSession,
  createMediaBridge,
  finalizeCall,
  parseCustomData,
  runWatchdog,
  waitUntil,
} from "./call-lifecycle.js";
import { createTranscript } from "./lead.js";

const PHONE = "+15555550100"; // fictional 555-01xx number

/** A manual clock plus a sleep that moves it, so timer tests run instantly. */
function fakeTime(start = 1_000_000) {
  const clock = { now: start };
  /** @type {number[]} */
  const sleeps = [];
  return {
    clock,
    sleeps,
    now: () => clock.now,
    sleep: async (/** @type {number} */ ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  };
}

// --- parseCustomData ---

test("parseCustomData reads phone, name and caller ID", () => {
  const parsed = parseCustomData(JSON.stringify({ phone: PHONE, name: "Anna", callerID: "CALLER", company: "Acme" }));
  assert.ok(parsed.ok);
  assert.equal(parsed.phone, PHONE);
  assert.equal(parsed.name, "Anna");
  assert.equal(parsed.callerId, "CALLER");
  assert.equal(parsed.data.company, "Acme"); // scenario-specific fields stay available
});

test("parseCustomData accepts the alternative keys and the default caller ID", () => {
  const parsed = parseCustomData(JSON.stringify({ number: 15555550100, contact_name: "Omar" }), {
    defaultCallerId: "DEFAULT",
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.phone, "15555550100");
  assert.equal(parsed.name, "Omar");
  assert.equal(parsed.callerId, "DEFAULT");
});

test("parseCustomData rejects input that is not a JSON object", () => {
  for (const raw of ["{broken", "null", "[1]", '"text"']) {
    assert.deepEqual(parseCustomData(raw), { ok: false, error: "Invalid customData" }, raw);
  }
});

test("parseCustomData requires a phone number", () => {
  assert.deepEqual(parseCustomData(JSON.stringify({ name: "Anna" })), { ok: false, error: "Missing phone" });
  assert.deepEqual(parseCustomData(""), { ok: false, error: "Missing phone" });
  assert.deepEqual(parseCustomData(undefined), { ok: false, error: "Missing phone" });
});

// --- checkCallTimers ---

test("checkCallTimers is quiet inside the limits", () => {
  assert.equal(checkCallTimers({ now: 10_000, startedAt: 0, lastVoiceAt: 5_000, greetingDone: true }), null);
});

test("checkCallTimers ends a call that is too long", () => {
  assert.equal(
    checkCallTimers({ now: MAX_CALL_MS + 1, startedAt: 0, lastVoiceAt: MAX_CALL_MS, greetingDone: true }),
    "timeout",
  );
});

test("checkCallTimers counts silence only after the greeting", () => {
  const state = { now: SILENCE_MS + 1, startedAt: 0, lastVoiceAt: 0 };
  assert.equal(checkCallTimers({ ...state, greetingDone: false }), null);
  assert.equal(checkCallTimers({ ...state, greetingDone: true }), "silence");
});

test("checkCallTimers reports the time limit before silence", () => {
  assert.equal(checkCallTimers({ now: MAX_CALL_MS + 1, startedAt: 0, lastVoiceAt: 0, greetingDone: true }), "timeout");
});

test("checkCallTimers takes custom limits", () => {
  const state = { now: 6_000, startedAt: 0, lastVoiceAt: 0, greetingDone: true };
  assert.equal(checkCallTimers({ ...state, silenceMs: 5_000 }), "silence");
  assert.equal(checkCallTimers({ ...state, maxMs: 5_000 }), "timeout");
});

// --- createCallSession ---

/** @param {ReturnType<typeof fakeTime>} [time] */
function sessionWithSpies(time = fakeTime()) {
  /** @type {{ duration: number, reason?: string }[]} */
  const finalized = [];
  /** @type {boolean[]} */
  const aborted = [];
  const session = createCallSession({
    now: time.now,
    onFinalize: async (end) => {
      await Promise.resolve();
      finalized.push(end);
    },
    onAbort: (hangup) => void aborted.push(hangup),
  });
  return { session, finalized, aborted, time };
}

test("finalize runs once when Disconnected, endCall and a timer race", async () => {
  const { session, finalized } = sessionWithSpies();
  const results = await Promise.all([session.finalize(42), session.finalize(0, "end_call"), session.finalize(0, "silence")]);
  assert.deepEqual(results, [true, false, false]);
  assert.deepEqual(finalized, [{ duration: 42, reason: undefined }]);
  assert.equal(session.done, true);
});

test("abort runs once and blocks a later finalize", async () => {
  const { session, finalized, aborted } = sessionWithSpies();
  assert.equal(session.abort(false), true);
  assert.equal(session.abort(true), false);
  assert.equal(await session.finalize(10), false);
  assert.deepEqual(aborted, [false]);
  assert.deepEqual(finalized, []);
});

test("abort does nothing after the conversation was finalized", async () => {
  const { session, aborted } = sessionWithSpies();
  await session.finalize(5);
  assert.equal(session.abort(true), false);
  assert.deepEqual(aborted, []);
});

test("the endCall reason survives when Disconnected finalizes first", async () => {
  const { session, finalized } = sessionWithSpies();
  session.setEndReason("lead_saved");
  await session.finalize(37); // Disconnected carries the duration but no reason
  assert.deepEqual(finalized, [{ duration: 37, reason: "lead_saved" }]);
});

test("an explicit finalize reason wins over the stored one", async () => {
  const { session, finalized } = sessionWithSpies();
  session.setEndReason("lead_saved");
  await session.finalize(0, "timeout");
  assert.equal(finalized[0].reason, "timeout");
});

test("session timers follow the greeting and the last voice", () => {
  const time = fakeTime();
  const { session } = sessionWithSpies(time);

  time.clock.now += SILENCE_MS + 1;
  assert.equal(session.checkTimers(), null); // greeting still playing

  session.markGreetingDone();
  assert.equal(session.greetingDone, true);
  assert.equal(session.checkTimers(), "silence");

  session.markVoice();
  assert.equal(session.checkTimers(), null);
});

// --- runWatchdog ---

test("watchdog finalizes a silent call with the reason 'silence'", async () => {
  const time = fakeTime();
  const { session, finalized } = sessionWithSpies(time);
  session.markGreetingDone();

  const reason = await runWatchdog(session, { sleep: time.sleep });

  assert.equal(reason, "silence");
  assert.deepEqual(finalized, [{ duration: 0, reason: "silence" }]);
  assert.ok(time.sleeps.every((ms) => ms === 3_000));
  assert.equal(time.sleeps.length, Math.ceil((SILENCE_MS + 1) / 3_000));
});

test("watchdog finalizes a long call with the reason 'timeout'", async () => {
  const time = fakeTime();
  const { session, finalized } = sessionWithSpies(time);
  session.markGreetingDone();
  // The conversation goes on: each check sees fresh speech.
  const talk = async (/** @type {number} */ ms) => {
    await time.sleep(ms);
    session.markVoice();
  };

  const reason = await runWatchdog(session, { sleep: talk });
  assert.equal(reason, "timeout");
  assert.deepEqual(finalized, [{ duration: 0, reason: "timeout" }]);
});

test("watchdog stops quietly when the call ended another way", async () => {
  const time = fakeTime();
  const { session, finalized } = sessionWithSpies(time);
  session.markGreetingDone();
  const hangUpDuringSleep = async (/** @type {number} */ ms) => {
    await time.sleep(ms);
    await session.finalize(12, "lead_saved");
  };

  assert.equal(await runWatchdog(session, { sleep: hangUpDuringSleep }), null);
  assert.deepEqual(finalized, [{ duration: 12, reason: "lead_saved" }]);
});

// --- waitUntil ---

test("waitUntil resolves as soon as the value arrives", async () => {
  const time = fakeTime();
  /** @type {string | null} */
  let recordUrl = null;
  const sleep = async (/** @type {number} */ ms) => {
    await time.sleep(ms);
    if (time.sleeps.length === 2) recordUrl = "https://records.example/final.mp3";
  };
  assert.equal(await waitUntil(() => recordUrl !== null, { sleep }), true);
  assert.deepEqual(time.sleeps, [500, 500]);
});

test("waitUntil gives up after the timeout", async () => {
  const time = fakeTime();
  assert.equal(await waitUntil(() => false, { sleep: time.sleep }), false);
  assert.equal(time.sleeps.length, 10); // 5 s in 500 ms steps
});

test("waitUntil does not sleep when the value is already there", async () => {
  const time = fakeTime();
  assert.equal(await waitUntil(() => true, { sleep: time.sleep }), true);
  assert.deepEqual(time.sleeps, []);
});

// --- createMediaBridge ---

function fakeMedia() {
  /** @type {string[]} */
  const steps = [];
  const client = { clearMediaBuffer: () => void steps.push("clearMediaBuffer") };
  const call = {
    sendMediaTo: (/** @type {unknown} */ target) => void steps.push(target === client ? "call->openai" : "call->?"),
  };
  return { steps, client, call };
}

test("two-way audio opens once, after the greeting, then clears echo", async () => {
  const { steps, client, call } = fakeMedia();
  const time = fakeTime();
  const bridge = createMediaBridge({
    call,
    client,
    sleep: time.sleep,
    onOpen: () => void steps.push("greeting done"),
  });

  assert.equal(bridge.isOpen, false);
  assert.equal(await bridge.openTwoWay("media-ended"), true);
  assert.equal(await bridge.openTwoWay("timeout-16s"), false); // the fallback timer fires later
  assert.equal(bridge.isOpen, true);
  assert.deepEqual(steps, ["greeting done", "call->openai", "clearMediaBuffer"]);
  assert.deepEqual(time.sleeps, [100, 100]);
});

test("barge-in clears the queued agent audio", () => {
  const { steps, client, call } = fakeMedia();
  const bridge = createMediaBridge({ call, client });
  bridge.bargeIn();
  bridge.bargeIn();
  assert.deepEqual(steps, ["clearMediaBuffer", "clearMediaBuffer"]);
});

test("media errors are logged and do not stop the call", async () => {
  /** @type {string[]} */
  const logs = [];
  const fail = () => {
    throw new Error("socket closed");
  };
  const bridge = createMediaBridge({
    call: { sendMediaTo: fail },
    client: { clearMediaBuffer: fail },
    sleep: async () => {},
    log: (m) => logs.push(m),
  });
  assert.equal(await bridge.openTwoWay(), true);
  bridge.bargeIn();
  assert.deepEqual(logs, [
    "two-way audio via media-ended",
    "sendMediaTo error: Error: socket closed",
    "clearMediaBuffer error: Error: socket closed",
    "clearMediaBuffer error: Error: socket closed",
  ]);
});

// --- finalizeCall ---

/**
 * @param {[ "assistant" | "user", string ][]} lines
 * @param {{ name?: string }} lead
 */
function finalizeDeps(lines, lead) {
  const transcript = createTranscript({ assistantLabel: "Agent", userLabel: "Caller" });
  for (const [role, text] of lines) transcript.add(role, text);
  /** @type {string[]} */
  const steps = [];
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  let current = lead;
  return {
    steps,
    sent,
    getCurrentLead: () => current,
    deps: {
      transcript,
      getLead: () => current,
      setLead: (/** @type {{ name?: string }} */ next) => {
        current = next;
      },
      send: async (/** @type {Record<string, unknown>} */ payload) => {
        steps.push(`send ${payload.event}`);
        sent.push(payload);
        return true;
      },
      close: () => void steps.push("close"),
      recoverLead: async () => {
        steps.push("recover");
        return { name: "Recovered" };
      },
    },
  };
}

test("finalizeCall recovers a missing lead before the last event", async () => {
  const { deps, steps, sent, getCurrentLead } = finalizeDeps(
    [
      ["assistant", "May I take your name?"],
      ["user", "It's Anna."],
    ],
    {},
  );
  await finalizeCall({ duration: 63, reason: "silence" }, deps);

  assert.deepEqual(steps, ["recover", "send lead_captured", "send call_disconnected", "close"]);
  assert.deepEqual(sent[0], { event: "lead_captured", lead: { name: "Recovered" } });
  assert.deepEqual(sent[1], {
    event: "call_disconnected",
    duration: 63,
    summary: "[Agent] May I take your name?\n[Caller] It's Anna.",
    reason: "silence",
  });
  assert.deepEqual(getCurrentLead(), { name: "Recovered" }); // later events carry it too
});

test("finalizeCall keeps a lead that the tool already saved", async () => {
  const { deps, steps } = finalizeDeps([["user", "Hi"]], { name: "Anna" });
  await finalizeCall({ duration: 10 }, deps);
  assert.deepEqual(steps, ["send call_disconnected", "close"]);
});

test("finalizeCall does not invent a lead when the caller never spoke", async () => {
  const { deps, steps, sent } = finalizeDeps([["assistant", "Hello? Are you there?"]], {});
  await finalizeCall({ duration: 0 }, deps);
  assert.deepEqual(steps, ["send call_disconnected", "close"]);
  assert.equal("reason" in sent[0], false);
});

test("finalizeCall skips recovery when the scenario has none", async () => {
  const { deps, steps } = finalizeDeps([["user", "Hi"]], {});
  await finalizeCall({ duration: 5 }, { ...deps, recoverLead: undefined });
  assert.deepEqual(steps, ["send call_disconnected", "close"]);
});

test("finalizeCall waits for the recording before it sends", async () => {
  const { deps, steps } = finalizeDeps([["user", "Hi"]], { name: "Anna" });
  await finalizeCall(
    { duration: 5 },
    {
      ...deps,
      waitForRecording: async () => void steps.push("recording ready"),
    },
  );
  assert.deepEqual(steps, ["recording ready", "send call_disconnected", "close"]);
});
