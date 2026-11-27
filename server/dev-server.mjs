/**
 * Local development server with explicit Front-End / Back-End separation.
 *
 * Modes (via MODE env var):
 *   full     (default) — serves both /api/* (backend) and public/* (frontend) on PORT (4700)
 *   backend            — serves ONLY backend API routes (/api/*, /s/:code) on PORT (4701)
 *   frontend           — serves ONLY static frontend (public/*) on PORT (4700),
 *                        proxying /api/* and /s/* to API_ORIGIN (http://127.0.0.1:4701)
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_URL = new URL('../', import.meta.url);
const ROOT_DIR = fileURLToPath(ROOT_URL);
const PUBLIC_DIR = join(ROOT_DIR, 'public');

const MODE = (process.env.MODE || 'full').toLowerCase();
const PORT = Number(process.env.PORT || (MODE === 'backend' ? 4701 : 4700));
const API_ORIGIN = (process.env.API_ORIGIN || 'http://127.0.0.1:4701').replace(/\/+$/, '');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

const API_ROUTE_MAP = {
  '/api/auth': 'auth',
  '/api/calendar': 'calendar',
  '/api/cron': 'cron',
  '/api/documents': 'documents',
  '/api/events': 'events',
  '/api/import': 'import',
  '/api/line': 'line',
  '/api/meta': 'meta',
  '/api/notifications': 'notifications',
  '/api/push': 'push',
  '/api/tasks': 'tasks',
  '/api/users': 'users',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function loadBackendRoutes() {
  if (process.env.DATABASE_URL && /127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    const localShim = new URL('../dev-tests/neon-local.mjs', import.meta.url);
    if (existsSync(localShim)) await import(localShim.href);
  }
  const handlers = {};
  for (const [route, file] of Object.entries(API_ROUTE_MAP)) {
    const mod = await import(new URL(`api/${file}.js`, ROOT_URL).href);
    handlers[route] = mod.default;
  }
  return handlers;
}

function applyCors(req, res) {
  if (!CORS_ORIGIN) return;
  res.setHeader('access-control-allow-origin', CORS_ORIGIN);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
}

async function handleBackend(req, res, handlers) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  let pathname = (req.url || '/').split('?')[0];
  const shortMatch = pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
  if (shortMatch) {
    req.url = '/api/meta?go=' + encodeURIComponent(shortMatch[1]);
    pathname = '/api/meta';
  }

  const handler = handlers[pathname];
  if (!handler) return false;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (raw.length && (req.headers['content-type'] || '').includes('application/json')) {
    try { req.body = JSON.parse(raw.toString('utf8')); } catch {}
  } else if (raw.length) {
    req.body = raw;
  }
  await handler(req, res);
  return true;
}

function serveFrontendStatic(req, res) {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const isSignRoute = /^\/sign\/[A-Za-z0-9_-]+\/?$/.test(pathname);
  const rel = (pathname === '/' || isSignRoute) ? '/index.html' : pathname;
  const candidate = normalize(join(PUBLIC_DIR, rel));

  // Prevent directory traversal outside public/
  if (!candidate.startsWith(PUBLIC_DIR) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const mime = MIME_TYPES[extname(candidate).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': mime,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  res.end(readFileSync(candidate));
}

async function proxyToBackend(req, res) {
  const target = new URL(req.url || '/', API_ORIGIN);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v || k.toLowerCase() === 'host') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    redirect: 'manual',
  });

  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'transfer-encoding') outHeaders[key] = value;
  });
  const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  if (setCookies.length) outHeaders['set-cookie'] = setCookies;

  res.writeHead(upstream.status, outHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

const handlers = MODE === 'frontend' ? null : await loadBackendRoutes();

http.createServer(async (req, res) => {
  try {
    const pathname = (req.url || '/').split('?')[0];
    const isApiRequest = pathname.startsWith('/api/') || /^\/s\/[A-Za-z0-9_-]+$/.test(pathname);

    if (MODE === 'backend') {
      const handled = await handleBackend(req, res, handlers);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      }
      return;
    }

    if (MODE === 'frontend') {
      if (isApiRequest) {
        await proxyToBackend(req, res);
        return;
      }
      serveFrontendStatic(req, res);
      return;
    }

    // MODE === 'full'
    if (isApiRequest) {
      const handled = await handleBackend(req, res, handlers);
      if (handled) return;
    }
    serveFrontendStatic(req, res);
  } catch (err) {
    console.error('[dev-server]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'SERVER_ERROR' }));
    }
  }
}).listen(PORT, () => {
  console.log(`[cuftm] ${MODE} server listening on http://127.0.0.1:${PORT}` +
    (MODE === 'frontend' ? ` (proxying /api/* -> ${API_ORIGIN})` : ''));
});
