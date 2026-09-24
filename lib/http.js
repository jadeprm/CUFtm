/**
 * The bridge between Vercel's Node runtime and the Web-standard handlers in
 * api/.
 *
 * The whole API is written against the Web platform: a `Request` in, a
 * `Response` out. Vercel's Node runtime does not hand you those. It hands you
 * Node's own `(req, res)` pair, where `req.url` is a bare path, `req.headers`
 * is a plain object, there is no `req.json()`, and returning a `Response` does
 * nothing at all.
 *
 * Two production outages came from that single mismatch — first `new URL()`
 * throwing on the path, then `request.json is not a function`. Patching each
 * symptom as it appeared was treating the rash, not the illness. This module is
 * the actual cure: one adapter, applied once per route.
 *
 * It deliberately supports BOTH shapes. Called with a single `Request` (local
 * tests, the Edge runtime, any future Web-standard runtime) it passes straight
 * through; called with `(req, res)` it translates in both directions. So the
 * test suite exercises the same code the deployment runs.
 *
 * Why not just switch to the Edge runtime, which is Web-standard already?
 * Because Edge provides only a handful of Node modules — async_hooks, events,
 * buffer, assert, util — and `node:crypto` is not one of them. Password hashing
 * here uses scrypt, randomBytes and timingSafeEqual from it, so Edge would
 * break authentication at import time.
 */

function headersFrom(nodeReq) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeReq.headers || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, String(v)));
    else headers.set(key, String(value));
  }
  return headers;
}

/**
 * Vercel usually parses a JSON body onto `req.body` before the handler runs,
 * but not always — it depends on content type and configuration. Handle every
 * form, and fall back to reading the stream.
 */
async function readRawBody(nodeReq) {
  const body = nodeReq.body;

  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) return body.toString('utf8');
    if (typeof body === 'string') return body;
    /**
     * Already parsed into an object by the runtime, so the bytes are gone.
     * Re-serialising is the best that can be done, and for the compact JSON
     * these webhooks send it is usually byte-identical — but "usually" is why
     * the signature check tries both forms rather than trusting this one.
     */
    try { return JSON.stringify(body); } catch { return ''; }
  }

  let raw = '';
  try {
    for await (const chunk of nodeReq) raw += chunk;
  } catch { return ''; }
  return raw;
}

async function readJsonBody(nodeReq) {
  const body = nodeReq.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const raw = await readRawBody(nodeReq);
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

/** Wraps Node's req in just enough of the Request surface for our handlers. */
export function toWebRequest(nodeReq) {
  let raw;
  const body = async () => {
    if (raw === undefined) raw = await readRawBody(nodeReq);
    return raw;
  };
  return {
    url: nodeReq.url || '/',
    method: (nodeReq.method || 'GET').toUpperCase(),
    headers: headersFrom(nodeReq),
    async json() {
      const parsedObject = nodeReq.body;
      if (parsedObject && typeof parsedObject === 'object' && !Buffer.isBuffer(parsedObject)) {
        return parsedObject;
      }
      const text = await body();
      try { return text ? JSON.parse(text) : {}; } catch { return {}; }
    },
    /**
     * The body exactly as it arrived.
     *
     * A signed webhook — LINE's, and anyone else's — hashes the bytes on the
     * wire, so handing back a re-serialised object would fail every signature
     * check. Kept separate from json() so nothing else has to care.
     */
    text: body,
  };
}

/** Writes a Web Response out through Node's res. */
export async function sendWebResponse(nodeRes, response) {
  if (!response || typeof response.text !== 'function') {
    nodeRes.statusCode = 500;
    nodeRes.setHeader('content-type', 'application/json; charset=utf-8');
    nodeRes.end(JSON.stringify({ error: 'NO_RESPONSE' }));
    return;
  }

  const body = await response.text();

  /**
   * set-cookie is the one header that can legitimately repeat, and the plain
   * iterator folds repeats into one comma-joined string — which browsers then
   * reject. getSetCookie() keeps them separate.
   */
  const cookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    nodeRes.setHeader(key, value);
  });

  if (cookies.length) nodeRes.setHeader('set-cookie', cookies);
  else {
    const single = response.headers.get('set-cookie');
    if (single) nodeRes.setHeader('set-cookie', single);
  }

  nodeRes.statusCode = response.status;
  nodeRes.end(body);
}

/**
 * Wrap a Web-standard handler so it runs on either runtime.
 *
 *   export default withNode(async function handler(request) { ... })
 */
export function withNode(handler) {
  return async function adapted(first, second) {
    // Node style is the only case where a second argument can write a response.
    const isNode = second && typeof second.setHeader === 'function';
    if (!isNode) return handler(first);

    try {
      const response = await handler(toWebRequest(first));
      await sendWebResponse(second, response);
    } catch (error) {
      console.error('[handler]', error);
      if (!second.headersSent) {
        second.statusCode = 500;
        second.setHeader('content-type', 'application/json; charset=utf-8');
        second.end(JSON.stringify({ error: 'SERVER', message: String(error?.message || error) }));
      }
    }
    return undefined;
  };
}
