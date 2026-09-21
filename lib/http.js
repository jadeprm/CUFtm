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
async function readJsonBody(nodeReq) {
  const body = nodeReq.body;

  if (body !== undefined && body !== null) {
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  let raw = '';
  try {
    for await (const chunk of nodeReq) raw += chunk;
  } catch { return {}; }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

/** Wraps Node's req in just enough of the Request surface for our handlers. */
export function toWebRequest(nodeReq) {
  let parsed;
  return {
    url: nodeReq.url || '/',
    method: (nodeReq.method || 'GET').toUpperCase(),
    headers: headersFrom(nodeReq),
    async json() {
      if (parsed === undefined) parsed = await readJsonBody(nodeReq);
      return parsed;
    },
    async text() {
      if (parsed === undefined) parsed = await readJsonBody(nodeReq);
      return JSON.stringify(parsed);
    },
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
