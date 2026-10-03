import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractionRequest,
  createTranscript,
  guessLead,
  leadFromToolArgs,
  mergeRecoveredLead,
  parseExtractionResponse,
  recoverLead,
} from "./lead.js";

// Fictional number from the 555-01xx range.
const PHONE = "+15555550100";
const AREAS = ["Dubai Marina", "Business Bay", "Downtown", "JVC", "Marina"];
const ALIASES = { Marina: "Dubai Marina" };

/** @param {[ "assistant" | "user", string ][]} lines */
function transcriptOf(lines) {
  const transcript = createTranscript({
    assistantLabel: "Agent",
    userLabel: "Caller",
    now: () => new Date("2026-01-01T10:00:00Z"),
  });
  for (const [role, text] of lines) transcript.add(role, text);
  return transcript;
}

test("transcript trims turns and skips empty ones", () => {
  const transcript = createTranscript({
    assistantLabel: "Agent",
    userLabel: "Caller",
    now: () => new Date("2026-01-01T10:00:00Z"),
  });
  assert.equal(transcript.add("assistant", "  Hello!  "), true);
  assert.equal(transcript.add("user", "   "), false);
  assert.equal(transcript.add("user", ""), false);
  assert.equal(transcript.add("user", undefined), false);
  assert.deepEqual(transcript.turns, [{ role: "assistant", text: "Hello!", timestamp: "2026-01-01T10:00:00.000Z" }]);
});

test("transcript renders one labelled line per turn", () => {
  const transcript = transcriptOf([
    ["assistant", "Hi, is now a good time?"],
    ["user", "Yes, go ahead."],
  ]);
  assert.equal(transcript.toText(), "[Agent] Hi, is now a good time?\n[Caller] Yes, go ahead.");
  assert.equal(transcriptOf([]).toText(), "");
});

test("transcript knows whether the caller spoke", () => {
  assert.equal(transcriptOf([["assistant", "Hello?"]]).hasUserTurns(), false);
  assert.equal(transcriptOf([["assistant", "Hello?"], ["user", "Hi"]]).hasUserTurns(), true);
});

test("leadFromToolArgs maps every saveLead field", () => {
  const lead = leadFromToolArgs(
    {
      client_name: "Anna",
      contact: "@anna",
      budget: "2M AED",
      area: "Business Bay",
      beds: "2",
      status: "off-plan",
      timeline: "this quarter",
      temperature: "hot",
      comment: "wants floor plans",
    },
    { phone: PHONE },
  );
  assert.deepEqual(lead, {
    name: "Anna",
    contact: "@anna",
    budget: "2M AED",
    area: "Business Bay",
    beds: "2",
    status: "off-plan",
    timeline: "this quarter",
    temperature: "hot",
    comment: "wants floor plans",
  });
});

test("leadFromToolArgs fills defaults from the call", () => {
  const lead = leadFromToolArgs({}, { phone: PHONE, contactName: "Name from CRM" });
  assert.deepEqual(lead, {
    name: "Name from CRM",
    contact: PHONE,
    budget: "",
    area: "",
    beds: "",
    status: "",
    timeline: "",
    temperature: "warm",
    comment: "",
  });
});

test("leadFromToolArgs turns non-string values into strings", () => {
  const lead = leadFromToolArgs({ client_name: "Omar", beds: 3 }, { phone: PHONE });
  assert.equal(lead.beds, "3");
});

test("guessLead takes the name from the caller's words only", () => {
  const guess = guessLead(
    transcriptOf([
      ["assistant", "Hi, this is Alex from the agency."],
      ["user", "Hello, my name is omar."],
    ]).turns,
  );
  assert.equal(guess.name, "Omar");

  const agentOnly = guessLead(transcriptOf([["assistant", "Hi, this is Alex."]]).turns);
  assert.equal(agentOnly.name, "");
});

test("guessLead finds bedrooms in several spoken forms", () => {
  /** @param {string} text */
  const beds = (text) => guessLead(transcriptOf([["user", text]]).turns).beds;
  assert.equal(beds("Looking for a 2-bed"), "2");
  assert.equal(beds("a 3BR would work"), "3");
  assert.equal(beds("maybe 1 bedroom"), "1");
  assert.equal(beds("just a Studio please"), "studio");
  assert.equal(beds("something big"), "");
});

test("guessLead uses the first area from the list and maps aliases", () => {
  /** @param {string} text */
  const area = (text) => guessLead(transcriptOf([["user", text]]).turns, { areas: AREAS, aliases: ALIASES }).area;
  assert.equal(area("Somewhere in business  bay"), "Business Bay");
  assert.equal(area("near the Marina"), "Dubai Marina");
  assert.equal(area("JVC or Downtown"), "Downtown");
  assert.equal(area("anywhere quiet"), "");
});

test("guessLead also reads the agent's lines for bedrooms and area", () => {
  const guess = guessLead(
    transcriptOf([
      ["assistant", "So a 2-bed in Dubai Marina, right?"],
      ["user", "Yes, exactly."],
    ]).turns,
    { areas: AREAS },
  );
  assert.equal(guess.beds, "2");
  assert.equal(guess.area, "Dubai Marina");
});

test("guessLead writes a short comment, never the raw dialogue", () => {
  const turns = transcriptOf([["user", "I'm Lena, I want a 2 bed in JVC"]]).turns;
  assert.deepEqual(guessLead(turns, { areas: AREAS }), {
    name: "Lena",
    area: "JVC",
    beds: "2",
    comment: "Wants 2BR in JVC",
  });
  const studio = guessLead(transcriptOf([["user", "a studio"]]).turns);
  assert.equal(studio.comment, "Wants studio");
  assert.equal(guessLead(transcriptOf([["user", "hello"]]).turns).comment, "");
});

test("guessLead treats area names as plain text, not as regex", () => {
  const areas = ["J.L.T"];
  assert.equal(guessLead(transcriptOf([["user", "near J.L.T please"]]).turns, { areas }).area, "J.L.T");
  assert.equal(guessLead(transcriptOf([["user", "near JxLxT please"]]).turns, { areas }).area, "");
});

test("mergeRecoveredLead prefers the extraction and trims it", () => {
  const lead = mergeRecoveredLead(
    { client_name: "  Anna ", contact: " @anna ", budget: "1.5M", area: "Downtown", temperature: "hot", comment: " cash buyer " },
    { name: "Wrong", area: "JVC", beds: "2", comment: "Wants 2BR in JVC" },
    { phone: PHONE },
  );
  assert.equal(lead.name, "Anna");
  assert.equal(lead.contact, "@anna");
  assert.equal(lead.area, "Downtown");
  assert.equal(lead.beds, "2"); // the extraction had no beds, the guess fills it
  assert.equal(lead.temperature, "hot");
  assert.equal(lead.comment, "cash buyer");
});

test("mergeRecoveredLead falls back to the guess, then to the call", () => {
  const guess = { name: "", area: "JVC", beds: "studio", comment: "Wants studio in JVC" };
  const lead = mergeRecoveredLead({ client_name: "   ", comment: "" }, guess, { phone: PHONE, contactName: "From dialer" });
  assert.deepEqual(lead, {
    name: "From dialer",
    contact: PHONE,
    budget: "",
    area: "JVC",
    beds: "studio",
    status: "",
    timeline: "",
    temperature: "warm",
    comment: "Wants studio in JVC",
  });
});

test("buildExtractionRequest asks for JSON with temperature 0", () => {
  const body = buildExtractionRequest("SYSTEM PROMPT", "[Agent] Hi\n[Caller] Hello");
  assert.deepEqual(body, {
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "[Agent] Hi\n[Caller] Hello" },
    ],
  });
  assert.equal(buildExtractionRequest("p", "t", { model: "other" }).model, "other");
});

test("parseExtractionResponse reads the JSON content", () => {
  const res = {
    code: 200,
    text: JSON.stringify({ choices: [{ message: { content: '{"client_name":"Anna","temperature":"warm"}' } }] }),
  };
  assert.deepEqual(parseExtractionResponse(res), { client_name: "Anna", temperature: "warm" });
});

test("parseExtractionResponse returns null for every failure", () => {
  /** @param {unknown} content */
  const ok = (content) => ({ code: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) });
  assert.equal(parseExtractionResponse({ code: 403, text: "Forbidden" }), null);
  assert.equal(parseExtractionResponse({ code: 200, text: "<html>" }), null);
  assert.equal(parseExtractionResponse({ code: 200 }), null);
  assert.equal(parseExtractionResponse(ok("")), null);
  assert.equal(parseExtractionResponse(ok("not json")), null);
  assert.equal(parseExtractionResponse(ok("[1,2]")), null);
  assert.equal(parseExtractionResponse(null), null);
});

test("recoverLead sends the transcript text to the extractor", async () => {
  const transcript = transcriptOf([["user", "My name is Anna, a 1 bed in Downtown"]]);
  /** @type {string[]} */
  const inputs = [];
  const lead = await recoverLead(transcript, {
    extract: async (text) => {
      inputs.push(text);
      return { client_name: "Anna", temperature: "hot" };
    },
    areas: AREAS,
    phone: PHONE,
  });
  assert.deepEqual(inputs, ["[Caller] My name is Anna, a 1 bed in Downtown"]);
  assert.equal(lead.name, "Anna");
  assert.equal(lead.temperature, "hot");
  assert.equal(lead.area, "Downtown");
  assert.equal(lead.beds, "1");
});

test("recoverLead still builds a lead when the extraction fails", async () => {
  const transcript = transcriptOf([["user", "I'm Omar, looking for a 2 bed in JVC"]]);
  const expected = {
    name: "Omar",
    contact: PHONE,
    budget: "",
    area: "JVC",
    beds: "2",
    status: "",
    timeline: "",
    temperature: "warm",
    comment: "Wants 2BR in JVC",
  };

  const fromNull = await recoverLead(transcript, { extract: async () => null, areas: AREAS, phone: PHONE });
  assert.deepEqual(fromNull, expected);

  const fromError = await recoverLead(transcript, {
    extract: async () => {
      throw new Error("HTTP 403");
    },
    areas: AREAS,
    phone: PHONE,
  });
  assert.deepEqual(fromError, expected);
});
