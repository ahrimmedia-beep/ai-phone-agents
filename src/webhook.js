// Call events from a VoxEngine scenario to an n8n webhook.
//
// VoxEngine has no fetch: HTTP goes through its `Net` module. The module is
// passed in as an argument, so the scenario passes the global `Net` and the
// tests pass a fake.

/**
 * @typedef {{ code: number, text?: string, error?: string }} HttpResponse
 * @typedef {{ method?: string, headers?: string[], postData?: string }} HttpRequestOptions
 * @typedef {{
 *   HttpRequestOptions: new () => HttpRequestOptions,
 *   httpRequestAsync: (url: string, options: HttpRequestOptions) => Promise<HttpResponse>,
 * }} NetLike
 * @typedef {(message: string) => void} Log
 * @typedef {Record<string, unknown>} Payload
 */

/**
 * POST a JSON body with the VoxEngine HTTP client.
 * Resolves with the raw response and rejects on a network error.
 *
 * @param {NetLike} net
 * @param {string} url
 * @param {unknown} body
 * @param {string[]} [extraHeaders] VoxEngine takes headers as "Name: value" lines.
 * @returns {Promise<HttpResponse>}
 */
export function httpPostJson(net, url, body, extraHeaders = []) {
  const options = new net.HttpRequestOptions();
  options.method = "POST";
  options.headers = ["Content-Type: application/json", ...extraHeaders];
  options.postData = JSON.stringify(body);
  return net.httpRequestAsync(url, options);
}

/**
 * VoxEngine puts the HTTP status in `res.code`. The first scenarios read
 * `res.statusCode`, which is undefined there, so every check failed.
 *
 * @param {HttpResponse | null | undefined} res
 */
export function isSuccess(res) {
  return !!res && typeof res.code === "number" && res.code >= 200 && res.code < 300;
}

/**
 * Send one call event. It never throws: a webhook problem must not break a
 * live phone call. The result is only logged.
 *
 * @param {NetLike} net
 * @param {string} url
 * @param {Payload} payload
 * @param {{ secret?: string, log?: Log }} [options]
 * @returns {Promise<boolean>} true on a 2xx response.
 */
export async function postEvent(net, url, payload, { secret, log = () => {} } = {}) {
  const headers = secret ? [`X-Webhook-Secret: ${secret}`] : [];
  const event = payload.event;
  try {
    const res = await httpPostJson(net, url, payload, headers);
    log(`webhook ${event} -> ${res.code}`);
    return isSuccess(res);
  } catch (err) {
    log(`webhook error (${event}): ${err}`);
    return false;
  }
}

/**
 * Bind the fields that every event of one call carries.
 * `base` runs on each send, so values that change during the call
 * (the lead, the recording URL) are always current. Fields in `extra` win.
 *
 * @param {(payload: Payload) => Promise<boolean>} post
 * @param {() => Payload} base
 * @returns {(extra: Payload) => Promise<boolean>}
 */
export function createEventSender(post, base) {
  return (extra) => post({ ...base(), ...extra });
}
