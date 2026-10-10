/**
 * A person's own Google Calendar, both ways.
 *
 * Each person connects their own calendar by signing in to Google from the
 * Schedule page. After that:
 *
 *   reading  — their Google events show on their schedule, and their busy
 *              times count when somebody looks for a meeting slot or books
 *              their office hours (others see only "busy", never the title);
 *   writing  — appointments, office-hour bookings and focus blocks made here
 *              are added to their Google Calendar, and removed again when
 *              cancelled. Meetings and events can be sent too, for people who
 *              have not subscribed to the calendar feed.
 *
 * Environment (set in Vercel by Jade — this code never prints or returns any
 * of it):
 *
 *   GOOGLE_SIGNIN_CLIENT_ID / GOOGLE_SIGNIN_CLIENT_SECRET
 *       A "Web application" OAuth client. Optional: when missing, the client
 *       already used for Drive (GOOGLE_OAUTH_CLIENT_ID / _SECRET) is used,
 *       which works if that client is a Web application one.
 *   GOOGLE_TOKEN_KEY
 *       Any long random string. Encrypts the stored refresh tokens. Optional:
 *       when missing a key is derived from the client secret, which means
 *       rotating the secret signs everybody out of Google — harmless, they
 *       connect again.
 *
 * The redirect URI to register on the client is
 *   https://<your domain>/api/auth?do=google-callback
 *
 * Scope is deliberately narrow: calendar.events (read and write events) plus
 * the address the person signed in with. Nothing here can read their email,
 * their Drive or their contacts.
 */
import crypto from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.events',
];
/** Marks the events this app wrote, so reading them back does not double them. */
const MARK = 'cuftm';

const clientId = () => process.env.GOOGLE_SIGNIN_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_SIGNIN_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
export const googleConfigured = () => Boolean(clientId() && clientSecret());

/* ---- the stored token, encrypted --------------------------------------- */

function key() {
  const base = process.env.GOOGLE_TOKEN_KEY || ('cuftm-token:' + clientSecret());
  return crypto.createHash('sha256').update(base).digest();
}
export function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}
export function unseal(sealed) {
  try {
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

/* ---- signing in -------------------------------------------------------- */

/** The address of this deployment, as Google will call it back. */
export function originOf(request) {
  const h = request.headers;
  const get = (k) => (typeof h.get === 'function' ? h.get(k) : h[k]) || '';
  let fromUrl = '';
  try { fromUrl = /^https?:/.test(request.url) ? new URL(request.url).host : ''; } catch { /* relative */ }
  const host = get('x-forwarded-host') || get('host') || fromUrl || 'localhost';
  if (!get('x-forwarded-proto') && /^https:/.test(request.url || '')) return `https://${host.split(',')[0]}`;
  const proto = get('x-forwarded-proto') || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  return `${proto.split(',')[0]}://${host.split(',')[0]}`;
}
export const redirectUri = (origin) => `${origin}/api/auth?do=google-callback`;

export async function startLink(sql, username, origin) {
  const state = crypto.randomBytes(24).toString('base64url');
  await sql`DELETE FROM oauth_states WHERE created_at < now() - interval '1 hour'`;
  await sql`INSERT INTO oauth_states (state, username) VALUES (${state}, ${username})`;
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Always ask, so Google always hands back a refresh token — without
    // this a second connection gets none and nothing can be read later.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${q}`;
}

/** The email inside an ID token. Read, not verified: it came straight from Google over TLS. */
function emailFrom(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return String(payload.email || '');
  } catch { return ''; }
}

/**
 * Google's answer, turned into a stored link.
 * Returns { ok } or { error } — the error is a code, never Google's text.
 */
export async function finishLink(sql, me, { code, state, origin }) {
  const [row] = await sql`
    DELETE FROM oauth_states WHERE state = ${String(state || '')}
    RETURNING username, created_at`;
  if (!row || row.username !== me.username) return { error: 'GOOGLE_STATE' };
  if (Date.now() - new Date(row.created_at).getTime() > 15 * 60 * 1000) return { error: 'GOOGLE_STATE' };

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(code || ''), client_id: clientId(), client_secret: clientSecret(),
      redirect_uri: redirectUri(origin), grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) return { error: 'GOOGLE_REFUSED' };
  const scope = String(data.scope || '');
  if (!scope.includes('calendar.events')) return { error: 'GOOGLE_NO_CALENDAR' };

  await sql`
    INSERT INTO google_links (username, email, refresh_enc, scope)
    VALUES (${me.username}, ${emailFrom(data.id_token)}, ${seal(data.refresh_token)}, ${scope})
    ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email, refresh_enc = EXCLUDED.refresh_enc,
      scope = EXCLUDED.scope, linked_at = now(), last_error = NULL`;
  cache.delete(me.username);
  if (data.access_token) cache.set(me.username, { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3000) * 1000 - 60000 });
  return { ok: true };
}

export async function unlink(sql, username) {
  const [row] = await sql`DELETE FROM google_links WHERE username = ${username} RETURNING refresh_enc`;
  cache.delete(username);
  const token = row && unseal(row.refresh_enc);
  // Tell Google too, so the app stops appearing in their account's list.
  if (token) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    } catch { /* gone from here either way */ }
  }
  return { ok: true };
}

export async function linkStatus(sql, username) {
  const [row] = await sql`SELECT email, push_events, linked_at, last_ok_at, last_error FROM google_links WHERE username = ${username}`;
  return {
    configured: googleConfigured(),
    linked: Boolean(row),
    email: row ? row.email : '',
    pushEvents: row ? Boolean(row.push_events) : false,
    linkedAt: row ? row.linked_at : null,
    lastOkAt: row ? row.last_ok_at : null,
    broken: Boolean(row && row.last_error),
  };
}

/* ---- calling the Calendar API ----------------------------------------- */

const cache = new Map(); // username -> { token, until }

async function accessToken(sql, username) {
  const hit = cache.get(username);
  if (hit && hit.until > Date.now()) return hit.token;
  const [row] = await sql`SELECT refresh_enc FROM google_links WHERE username = ${username}`;
  if (!row) return null;
  const refresh = unseal(row.refresh_enc);
  if (!refresh) return null;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(), client_secret: clientSecret(),
      refresh_token: refresh, grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Revoked in their Google account, or expired: say so on the page.
    await sql`UPDATE google_links SET last_error = ${'token ' + res.status} WHERE username = ${username}`;
    return null;
  }
  cache.set(username, { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3000) * 1000 - 60000 });
  return data.access_token;
}

async function call(sql, username, path, { method = 'GET', body } = {}) {
  const token = await accessToken(sql, username);
  if (!token) return { ok: false, status: 401 };
  const res = await fetch(CAL + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.ok) {
    await sql`UPDATE google_links SET last_ok_at = now(), last_error = NULL WHERE username = ${username}`;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Bangkok wall time from an RFC3339 stamp or a date. */
function local(stamp) {
  if (!stamp) return null;
  if (stamp.date) return { on: stamp.date, at: null };
  const d = new Date(stamp.dateTime);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date(d.getTime() + 7 * 3600000).toISOString();
  return { on: t.slice(0, 10), at: t.slice(11, 16) };
}

/**
 * Their Google events between two dates, as { on, at, toOn, to, title, ... }.
 * Events this app wrote are left out — they are already on the schedule.
 * `titles: false` keeps only the times, for showing somebody else's busy.
 */
export async function googleEvents(sql, username, fromOn, toOn, { titles = true } = {}) {
  const q = new URLSearchParams({
    timeMin: `${fromOn}T00:00:00+07:00`,
    timeMax: `${toOn}T23:59:59+07:00`,
    singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
  });
  const got = await call(sql, username, `/calendars/primary/events?${q}`);
  if (!got.ok) return { ok: false, events: [] };
  const events = [];
  for (const e of got.data.items || []) {
    if (e.status === 'cancelled') continue;
    if (e.extendedProperties?.private?.[MARK]) continue;
    // Free ("show as available") and declined events are not busy.
    if (e.transparency === 'transparent') continue;
    const mine = (e.attendees || []).find((a) => a.self);
    if (mine && mine.responseStatus === 'declined') continue;
    const s = local(e.start);
    const f = local(e.end);
    if (!s || !f) continue;
    // An all-day event's end date is exclusive in Google.
    let toOnDay = f.on;
    if (!s.at && f.on > s.on) {
      const d = new Date(f.on + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); toOnDay = d.toISOString().slice(0, 10);
    }
    events.push({
      id: titles ? e.id : undefined,
      on: s.on, at: s.at, toOn: toOnDay, to: f.at,
      title: titles ? (e.summary || '(ไม่มีชื่อ)') : '',
      link: titles ? (e.htmlLink || '') : '',
      place: titles ? (e.location || '') : '',
    });
  }
  return { ok: true, events };
}

/**
 * Google wants event ids in base32hex (0-9, a-v), 5–1024 characters. A hash
 * of what the thing is here gives the same id every time, so writing it again
 * updates rather than duplicates.
 */
export const eventIdFor = (kind, id) =>
  MARK + crypto.createHash('sha1').update(`${kind}:${id}`).digest('hex');

/**
 * Add or update one event. `item` is { kind, id, title, on, at, toOn, to,
 * place, note, link }; untimed items become all-day events.
 */
export async function putEvent(sql, username, item) {
  const gid = eventIdFor(item.kind, item.id);
  const timed = Boolean(item.at);
  const endOn = item.toOn || item.on;
  let end;
  if (timed) end = { dateTime: `${endOn}T${item.to || item.at}:00+07:00`, timeZone: 'Asia/Bangkok' };
  else {
    const d = new Date(endOn + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    end = { date: d.toISOString().slice(0, 10) };
  }
  if (timed && (!item.to || (endOn === item.on && item.to <= item.at))) {
    // No end given: an hour.
    const [h, m] = item.at.split(':').map(Number);
    const mins = Math.min(23 * 60 + 59, h * 60 + m + 60);
    end = { dateTime: `${item.on}T${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00+07:00`, timeZone: 'Asia/Bangkok' };
  }
  const body = {
    id: gid,
    summary: item.title,
    description: [item.note, item.link].filter(Boolean).join('\n\n'),
    location: item.place || '',
    start: timed ? { dateTime: `${item.on}T${item.at}:00+07:00`, timeZone: 'Asia/Bangkok' } : { date: item.on },
    end,
    extendedProperties: { private: { [MARK]: `${item.kind}:${item.id}` } },
  };
  let got = await call(sql, username, `/calendars/primary/events/${gid}`, { method: 'PUT', body });
  if (got.status === 404) got = await call(sql, username, '/calendars/primary/events', { method: 'POST', body });
  return { ok: got.ok, googleId: gid };
}

export async function dropEvent(sql, username, kind, id) {
  const gid = eventIdFor(kind, id);
  const got = await call(sql, username, `/calendars/primary/events/${gid}`, { method: 'DELETE' });
  return { ok: got.ok || got.status === 404 || got.status === 410 };
}

export async function isLinked(sql, username) {
  if (!googleConfigured()) return false;
  const [row] = await sql`SELECT 1 FROM google_links WHERE username = ${username}`;
  return Boolean(row);
}

/** Which of these people have connected a calendar. */
export async function linkedAmong(sql, usernames) {
  if (!googleConfigured() || !usernames.length) return [];
  const rows = await sql`SELECT username FROM google_links WHERE username = ANY(${usernames}) AND last_error IS NULL`;
  return rows.map((r) => r.username);
}

/** Exposed for tests. */
export const _cache = cache;
