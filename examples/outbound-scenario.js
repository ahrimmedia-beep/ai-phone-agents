// Excerpt: an outbound VoxEngine scenario rebuilt from the modules in src/.
// It follows the English outbound agent; call recording is on, as in the
// Russian outbound agents.
//
// In the deployed project each agent is one VoxEngine file, because VoxEngine has no
// module loader. The persona prompt, the greeting, the tool schemas, the lead
// extraction prompt and the area list live in a private module and are not
// published here. This file is not run in this repository: it needs the
// VoxEngine runtime (VoxEngine, Net, Logger, OpenAI and the event constants).
import { agent } from "./agent-config.js"; // private
import {
  createCallSession,
  createMediaBridge,
  finalizeCall,
  parseCustomData,
  runWatchdog,
  sleep,
  waitUntil,
} from "../src/call-lifecycle.js";
import { createTranscript, leadFromToolArgs, buildExtractionRequest, parseExtractionResponse, recoverLead } from "../src/lead.js";
import {
  buildSessionUpdate,
  createFunctionCallRouter,
  functionCallFromArgsDone,
  functionCallsFromResponseDone,
  readTranscript,
  subscribeSafely,
} from "../src/realtime.js";
import { createEventSender, httpPostJson, postEvent } from "../src/webhook.js";

require(Modules.OpenAI);

const OPENAI_API_KEY = "YOUR_OPENAI_API_KEY";
const WEBHOOK_URL = "YOUR_WEBHOOK_URL";
const WEBHOOK_SECRET = "YOUR_WEBHOOK_SECRET";
const DEFAULT_CALLER_ID = "YOUR_CALLER_ID";
const MODEL = "gpt-realtime-1.5";
const SCENARIO = "outbound";

const log = (message) => Logger.write(message);
const post = (payload) => postEvent(Net, WEBHOOK_URL, payload, { secret: WEBHOOK_SECRET, log });

// Backup lead extraction: one Chat Completions call in JSON mode.
async function extractLead(transcriptText) {
  try {
    const res = await httpPostJson(
      Net,
      "https://api.openai.com/v1/chat/completions",
      buildExtractionRequest(agent.extractionPrompt, transcriptText),
      [`Authorization: Bearer ${OPENAI_API_KEY}`],
    );
    return parseExtractionResponse(res);
  } catch (err) {
    log(`extract error: ${err}`);
    return null;
  }
}

VoxEngine.addEventListener(AppEvents.Started, async () => {
  const sessionStart = new Date().toISOString();

  // n8n starts the scenario with customData: phone, name, caller ID.
  const input = parseCustomData(VoxEngine.customData(), { defaultCallerId: DEFAULT_CALLER_ID });
  if (!input.ok) {
    post({ scenario: SCENARIO, event: "error", error: input.error, session_start: sessionStart });
    VoxEngine.terminate();
    return;
  }

  let client = null;
  let lead = {};
  let recordUrl = null;
  let finalRecordUrl = null;

  const transcript = createTranscript({ assistantLabel: agent.name, userLabel: "Lead" });
  const send = createEventSender(post, () => ({
    scenario: SCENARIO,
    phone: input.phone,
    contact_name: input.name,
    session_start: sessionStart,
    record_url: recordUrl,
    summary: "",
    lead,
  }));

  send({ event: "call_started" });

  // Connect to OpenAI while the phone rings, so the agent is ready on answer.
  const clientPromise = OpenAI.createRealtimeAPIClient({ apiKey: OPENAI_API_KEY, model: MODEL });
  const call = VoxEngine.callPSTN(input.phone, input.callerId);

  const session = createCallSession({
    onAbort: (hangup) => {
      try { client?.close(); } catch {}
      try { if (hangup) call.hangup(); } catch {}
      VoxEngine.terminate();
    },
    onFinalize: (end) =>
      finalizeCall(end, {
        transcript,
        getLead: () => lead,
        setLead: (next) => { lead = next; },
        send,
        log,
        waitForRecording: async () => {
          await waitUntil(() => finalRecordUrl !== null);
          recordUrl = finalRecordUrl || recordUrl;
        },
        recoverLead: () =>
          recoverLead(transcript, {
            extract: extractLead,
            areas: agent.areas,
            aliases: agent.areaAliases,
            phone: input.phone,
            contactName: input.name,
          }),
        close: () => {
          try { client?.close(); } catch {}
          try { call.hangup(); } catch {} // no-op when the line is already down
          VoxEngine.terminate();
        },
      }),
  });

  call.addEventListener(CallEvents.Failed, async (e) => {
    log(`Call failed: code=${e.code} reason=${e.reason}`);
    await send({ event: "call_failed", status: "failed", failure_code: e.code, failure_reason: e.reason });
    session.abort(false);
  });

  // The lead hung up, or our own hangup after endCall.
  call.addEventListener(CallEvents.Disconnected, (e) => session.finalize(e.duration || 0));

  call.addEventListener(CallEvents.RecordStarted, (e) => { recordUrl = e.url; });
  call.addEventListener(CallEvents.RecordStopped, (e) => { finalRecordUrl = e.url || recordUrl; });

  call.addEventListener(CallEvents.Connected, async () => {
    send({ event: "call_connected" });
    call.record({ stereo: true, hd_audio: false });
    await sleep(800); // let the line settle

    try {
      client = await clientPromise;
      client.sessionUpdate(
        buildSessionUpdate({ instructions: agent.instructions, voice: agent.voice, tools: agent.tools, language: "en" }),
      );

      // One way during the greeting: OpenAI -> call.
      client.sendMediaTo(call);
      client.responseCreate(agent.greetingRequest);

      const bridge = createMediaBridge({ call, client, onOpen: () => session.markGreetingDone(), log });
      const on = (getEvent, label, handler) => subscribeSafely(client, getEvent, label, handler, log);

      on(() => OpenAI.Events.WebSocketMediaEnded, "WebSocketMediaEnded", () => bridge.openTwoWay("media-ended"));
      // Backstop: if that event never comes, open the line anyway so the lead can be heard.
      sleep(16_000).then(() => bridge.openTwoWay("timeout-16s"));
      on(() => OpenAI.RealtimeAPIEvents.InputAudioBufferSpeechStarted, "InputAudioBufferSpeechStarted", () => {
        session.markVoice();
        bridge.bargeIn();
      });

      // The GA SDK renamed the agent transcript event. Listen to both names.
      const onAgentText = (event) => {
        if (transcript.add("assistant", readTranscript(event))) session.markVoice();
      };
      on(() => OpenAI.RealtimeAPIEvents.ResponseOutputAudioTranscriptDone, "ResponseOutputAudioTranscriptDone", onAgentText);
      on(() => OpenAI.RealtimeAPIEvents.ResponseAudioTranscriptDone, "ResponseAudioTranscriptDone", onAgentText);
      on(
        () => OpenAI.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted,
        "ConversationItemInputAudioTranscriptionCompleted",
        (event) => {
          if (transcript.add("user", readTranscript(event))) session.markVoice();
        },
      );
      on(() => OpenAI.RealtimeAPIEvents.Error, "Error", (event) => log(`OpenAI error: ${JSON.stringify(event?.data)}`));

      const route = createFunctionCallRouter(
        {
          saveLead: (args) => {
            lead = leadFromToolArgs(args, { phone: input.phone, contactName: input.name });
            // Not awaited: waiting for the webhook here left 2-4 s of silence on the line.
            send({ event: "lead_captured", lead });
            client.responseCreate({});
          },
          endCall: async (args) => {
            session.setEndReason(args.reason || "end_call");
            await sleep(2500); // let the goodbye finish playing
            try { call.hangup(); } catch {} // fires Disconnected -> finalize()
            await sleep(1500);
            await session.finalize(0); // backstop if Disconnected never comes
          },
        },
        { log },
      );

      // Primary path, plus a fallback that scans each finished response.
      on(
        () => OpenAI.RealtimeAPIEvents.ResponseFunctionCallArgumentsDone,
        "ResponseFunctionCallArgumentsDone",
        (event) => route(functionCallFromArgsDone(event)),
      );
      on(() => OpenAI.RealtimeAPIEvents.ResponseDone, "ResponseDone", (event) => {
        for (const functionCall of functionCallsFromResponseDone(event)) route(functionCall);
      });

      runWatchdog(session, { log });
    } catch (error) {
      log(`OpenAI init error: ${error}`);
      send({ event: "error", error: String(error) });
      session.abort(true);
    }
  });
});
