import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TURN_DETECTION,
  buildSessionUpdate,
  createFunctionCallRouter,
  field,
  functionCallFromArgsDone,
  functionCallsFromResponseDone,
  readTranscript,
  subscribeSafely,
} from "./realtime.js";

const TOOLS = [{ type: "function", name: "saveLead" }];

test("buildSessionUpdate uses the GA session shape", () => {
  const update = buildSessionUpdate({ instructions: "PRIVATE", voice: "marin", tools: TOOLS });
  assert.equal(update.session.type, "realtime");
  assert.equal(update.session.instructions, "PRIVATE");
  assert.deepEqual(update.session.output_modalities, ["audio"]);
  assert.deepEqual(update.session.audio.output, { voice: "marin" });
  assert.deepEqual(update.session.audio.input.noise_reduction, { type: "near_field" });
  assert.equal(update.session.tools, TOOLS);
  assert.equal(update.session.tool_choice, "auto");
});

test("buildSessionUpdate turns on server VAD with interruptions", () => {
  const { turn_detection } = buildSessionUpdate({ instructions: "", voice: "cedar", tools: [] }).session.audio.input;
  assert.deepEqual(turn_detection, {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 600,
    create_response: true,
    interrupt_response: true,
  });
});

test("buildSessionUpdate pins the transcription language only when given", () => {
  const pinned = buildSessionUpdate({ instructions: "", voice: "v", tools: [], language: "en" });
  assert.deepEqual(pinned.session.audio.input.transcription, { model: "gpt-4o-transcribe", language: "en" });

  const open = buildSessionUpdate({ instructions: "", voice: "v", tools: [] });
  assert.deepEqual(open.session.audio.input.transcription, { model: "gpt-4o-transcribe" });
});

test("buildSessionUpdate gives each session its own copy of the VAD config", () => {
  const update = buildSessionUpdate({ instructions: "", voice: "v", tools: [] });
  const turnDetection = /** @type {{ threshold: number }} */ (update.session.audio.input.turn_detection);
  turnDetection.threshold = 0.9;
  assert.equal(TURN_DETECTION.threshold, 0.5);
  assert.ok(Object.isFrozen(TURN_DETECTION));
});

test("field looks on the event, then event.data, then event.data.payload", () => {
  assert.equal(field({ transcript: "top" }, "transcript"), "top");
  assert.equal(field({ data: { transcript: "data" } }, "transcript"), "data");
  assert.equal(field({ data: { payload: { transcript: "payload" } } }, "transcript"), "payload");
  assert.equal(
    field({ transcript: null, data: { transcript: undefined, payload: { transcript: "deep" } } }, "transcript"),
    "deep",
  );
  assert.equal(field({ data: {} }, "transcript"), undefined);
  assert.equal(field(undefined, "transcript"), undefined);
});

test("readTranscript trims text and ignores non-strings", () => {
  assert.equal(readTranscript({ data: { transcript: "  Hello there \n" } }), "Hello there");
  assert.equal(readTranscript({ data: { transcript: 42 } }), "");
  assert.equal(readTranscript({}), "");
});

test("functionCallFromArgsDone reads the fields from event.data.payload", () => {
  const event = {
    name: "OpenAI.RealtimeAPIEvents.ResponseFunctionCallArgumentsDone",
    data: { payload: { name: "saveLead", arguments: '{"client_name":"Anna"}', call_id: "call_1" } },
  };
  // event.name is the event type, never the function name.
  assert.deepEqual(functionCallFromArgsDone(event), {
    name: "saveLead",
    args: '{"client_name":"Anna"}',
    callId: "call_1",
  });
});

test("functionCallFromArgsDone falls back to event.data and survives an empty event", () => {
  assert.deepEqual(functionCallFromArgsDone({ data: { name: "endCall", arguments: "{}", call_id: "c2" } }), {
    name: "endCall",
    args: "{}",
    callId: "c2",
  });
  assert.deepEqual(functionCallFromArgsDone(undefined), { name: undefined, args: undefined, callId: undefined });
});

test("functionCallsFromResponseDone returns only function_call items", () => {
  const event = {
    data: {
      response: {
        output: [
          { type: "message", content: [] },
          { type: "function_call", name: "saveLead", arguments: "{}", call_id: "a" },
          null,
          { type: "function_call", name: "endCall", arguments: '{"reason":"lead_saved"}', call_id: "b" },
        ],
      },
    },
  };
  assert.deepEqual(functionCallsFromResponseDone(event), [
    { name: "saveLead", args: "{}", callId: "a" },
    { name: "endCall", args: '{"reason":"lead_saved"}', callId: "b" },
  ]);
  assert.deepEqual(functionCallsFromResponseDone({ data: { response: {} } }), []);
  assert.deepEqual(functionCallsFromResponseDone({}), []);
});

test("router passes parsed arguments to the handler", async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = [];
  const route = createFunctionCallRouter({ saveLead: (args) => void seen.push(args) });
  const handled = await route({ name: "saveLead", args: '{"client_name":"Anna","temperature":"hot"}', callId: "c1" });
  assert.equal(handled, true);
  assert.deepEqual(seen, [{ client_name: "Anna", temperature: "hot" }]);
});

test("router handles a call_id once, even when both event paths deliver it", async () => {
  let calls = 0;
  const route = createFunctionCallRouter({ saveLead: () => void calls++ });

  const argsDone = functionCallFromArgsDone({
    data: { payload: { name: "saveLead", arguments: "{}", call_id: "same" } },
  });
  const [fromResponse] = functionCallsFromResponseDone({
    data: { response: { output: [{ type: "function_call", name: "saveLead", arguments: "{}", call_id: "same" }] } },
  });

  assert.equal(await route(argsDone), true);
  assert.equal(await route(fromResponse), false);
  assert.equal(calls, 1);
});

test("router does not dedupe calls that have no call_id", async () => {
  let calls = 0;
  const route = createFunctionCallRouter({ saveLead: () => void calls++ });
  await route({ name: "saveLead", args: "{}" });
  await route({ name: "saveLead", args: "{}" });
  assert.equal(calls, 2);
});

test("router treats missing arguments as an empty object", async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = [];
  const route = createFunctionCallRouter({ endCall: (args) => void seen.push(args) });
  await route({ name: "endCall", callId: "c1" });
  assert.deepEqual(seen, [{}]);
});

test("router logs bad JSON and does not call the handler", async () => {
  let calls = 0;
  /** @type {string[]} */
  const logs = [];
  const route = createFunctionCallRouter({ saveLead: () => void calls++ }, { log: (m) => logs.push(m) });
  assert.equal(await route({ name: "saveLead", args: "{not json", callId: "c1" }), false);
  assert.equal(calls, 0);
  assert.ok(logs.some((m) => m.startsWith("function error:")));
});

test("router ignores unknown names, including Object prototype keys", async () => {
  const route = createFunctionCallRouter({ saveLead: () => {} });
  assert.equal(await route({ name: "bookViewing", args: "{}" }), false);
  assert.equal(await route({ name: "constructor", args: "{}" }), false);
  assert.equal(await route({ name: "toString", args: "{}" }), false);
  assert.equal(await route({ args: "{}" }), false);
});

test("router keeps working after a handler throws", async () => {
  /** @type {string[]} */
  const logs = [];
  let ended = false;
  const route = createFunctionCallRouter(
    {
      saveLead: () => {
        throw new Error("boom");
      },
      endCall: () => {
        ended = true;
      },
    },
    { log: (m) => logs.push(m) },
  );

  assert.equal(await route({ name: "saveLead", args: "{}", callId: "c1" }), false);
  assert.ok(logs.includes("function error: Error: boom"));
  assert.equal(await route({ name: "endCall", args: "{}", callId: "c2" }), true);
  assert.equal(ended, true);
});

test("router waits for an async handler to finish", async () => {
  const order = /** @type {string[]} */ ([]);
  const route = createFunctionCallRouter({
    endCall: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("handler done");
    },
  });
  await route({ name: "endCall", args: "{}" });
  order.push("route resolved");
  assert.deepEqual(order, ["handler done", "route resolved"]);
});

test("subscribeSafely adds the listener when the event exists", () => {
  /** @type {unknown[]} */
  const added = [];
  const target = { addEventListener: (/** @type {unknown} */ evt) => void added.push(evt) };
  assert.equal(subscribeSafely(target, () => "SpeechStarted", "SpeechStarted", () => {}), true);
  assert.deepEqual(added, ["SpeechStarted"]);
});

test("subscribeSafely skips a missing event and logs it", () => {
  /** @type {string[]} */
  const logs = [];
  const log = (/** @type {string} */ m) => logs.push(m);
  const target = { addEventListener: () => assert.fail("must not subscribe") };
  /** @type {any} */
  const OpenAI = { RealtimeAPIEvents: {} };

  assert.equal(subscribeSafely(target, () => OpenAI.RealtimeAPIEvents.Renamed, "Renamed", () => {}, log), false);
  assert.equal(subscribeSafely(target, () => OpenAI.Missing.Events.X, "X", () => {}, log), false);
  assert.equal(logs[0], "WARN: event is undefined: Renamed");
  assert.match(logs[1], /^WARN: no namespace for event X: TypeError/);
});

test("subscribeSafely survives a throwing addEventListener", () => {
  /** @type {string[]} */
  const logs = [];
  const target = {
    addEventListener: () => {
      throw new Error("closed");
    },
  };
  assert.equal(subscribeSafely(target, () => "Error", "Error", () => {}, (m) => logs.push(m)), false);
  assert.deepEqual(logs, ["WARN: addEventListener failed for Error: Error: closed"]);
});
