import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSender, httpPostJson, isSuccess, postEvent } from "./webhook.js";

/**
 * A stand-in for the VoxEngine `Net` module that records every request.
 * @param {(url: string) => Promise<{ code: number, text?: string }>} respond
 */
function fakeNet(respond) {
  /** @type {{ url: string, options: { method?: string, headers?: string[], postData?: string } }[]} */
  const requests = [];
  const net = {
    HttpRequestOptions: class {
      /** @type {string | undefined} */ method;
      /** @type {string[] | undefined} */ headers;
      /** @type {string | undefined} */ postData;
    },
    /**
     * @param {string} url
     * @param {{ method?: string, headers?: string[], postData?: string }} options
     */
    httpRequestAsync(url, options) {
      requests.push({ url, options });
      return respond(url);
    },
  };
  return { net, requests };
}

const URL = "https://example.test/webhook";

test("httpPostJson sends a JSON POST", async () => {
  const { net, requests } = fakeNet(async () => ({ code: 200 }));
  await httpPostJson(net, URL, { event: "call_started", lead: { name: "Anna" } });

  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(url, URL);
  assert.equal(options.method, "POST");
  assert.deepEqual(options.headers, ["Content-Type: application/json"]);
  assert.deepEqual(JSON.parse(options.postData ?? ""), { event: "call_started", lead: { name: "Anna" } });
});

test("httpPostJson adds extra header lines after the content type", async () => {
  const { net, requests } = fakeNet(async () => ({ code: 200 }));
  await httpPostJson(net, URL, {}, ["Authorization: Bearer test"]);
  assert.deepEqual(requests[0].options.headers, ["Content-Type: application/json", "Authorization: Bearer test"]);
});

test("isSuccess accepts only 2xx codes", () => {
  for (const code of [200, 201, 204, 299]) assert.equal(isSuccess({ code }), true, `code ${code}`);
  for (const code of [0, 199, 300, 404, 500]) assert.equal(isSuccess({ code }), false, `code ${code}`);
  assert.equal(isSuccess(null), false);
  assert.equal(isSuccess(undefined), false);
});

test("isSuccess reads res.code, not statusCode", () => {
  // VoxEngine responses have `code`. A check on `statusCode` would always fail.
  const voxResponse = /** @type {any} */ ({ statusCode: 200 });
  assert.equal(isSuccess(voxResponse), false);
});

test("postEvent returns true on 2xx and logs the event", async () => {
  const { net } = fakeNet(async () => ({ code: 200 }));
  /** @type {string[]} */
  const logs = [];
  const ok = await postEvent(net, URL, { event: "call_started" }, { log: (m) => logs.push(m) });
  assert.equal(ok, true);
  assert.deepEqual(logs, ["webhook call_started -> 200"]);
});

test("postEvent sends the shared secret header only when it is set", async () => {
  const withSecret = fakeNet(async () => ({ code: 200 }));
  await postEvent(withSecret.net, URL, { event: "x" }, { secret: "s3cret" });
  assert.deepEqual(withSecret.requests[0].options.headers, [
    "Content-Type: application/json",
    "X-Webhook-Secret: s3cret",
  ]);

  const without = fakeNet(async () => ({ code: 200 }));
  await postEvent(without.net, URL, { event: "x" });
  assert.deepEqual(without.requests[0].options.headers, ["Content-Type: application/json"]);
});

test("postEvent returns false on an HTTP error", async () => {
  const { net } = fakeNet(async () => ({ code: 500 }));
  assert.equal(await postEvent(net, URL, { event: "lead_captured" }), false);
});

test("postEvent never throws on a network error", async () => {
  const { net } = fakeNet(async () => {
    throw new Error("connection reset");
  });
  /** @type {string[]} */
  const logs = [];
  const ok = await postEvent(net, URL, { event: "call_disconnected" }, { log: (m) => logs.push(m) });
  assert.equal(ok, false);
  assert.deepEqual(logs, ["webhook error (call_disconnected): Error: connection reset"]);
});

test("createEventSender merges the base fields, and extra fields win", async () => {
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  const send = createEventSender(
    async (payload) => {
      sent.push(payload);
      return true;
    },
    () => ({ scenario: "outbound", phone: "+15555550100", summary: "" }),
  );

  await send({ event: "call_disconnected", summary: "[Agent] Hi" });
  assert.deepEqual(sent[0], {
    scenario: "outbound",
    phone: "+15555550100",
    summary: "[Agent] Hi",
    event: "call_disconnected",
  });
});

test("createEventSender reads the base on every send", async () => {
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  /** @type {Record<string, unknown>} */
  let lead = {};
  const send = createEventSender(
    async (payload) => {
      sent.push(payload);
      return true;
    },
    () => ({ lead }),
  );

  await send({ event: "call_started" });
  lead = { name: "Anna" };
  await send({ event: "call_disconnected" });

  assert.deepEqual(sent[0].lead, {});
  assert.deepEqual(sent[1].lead, { name: "Anna" });
});
