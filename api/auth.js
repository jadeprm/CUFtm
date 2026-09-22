import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import {
  currentUser, departmentsOf, hashPassword, verifyPassword, passwordProblem,
  newToken, sessionCookie, sessionExpiry,
} from '../lib/auth.js';
import { fetchPeople, syncPeople } from '../lib/sheet.js';
import { withNode } from '../lib/http.js';

/**
 * Sign in, first-time password setup, password reset, sign out.
 *
 *   GET  /api/auth               who am I (and does this username need a password yet)
 *   POST /api/auth?do=login      { username, password }
 *   POST /api/auth?do=setup      { username, password } — first time, or after a reset
 *   POST /api/auth?do=check      { username } — does this account need setup
 *   POST /api/auth?do=logout
 */

const publicUser = (u) => ({
  username: u.username,
  nickname: u.nickname,
  displayName: u.display_name || u.sheet_name || u.username,
  position: u.position,
  access: u.access,
  department: u.department,
  departments: u.departments || [],
  allDepartments: Boolean(u.all_departments),
  isHead: u.is_head,
  avatar: u.avatar || null,
  lang: u.lang || 'th',
  theme: u.theme || 'system',
  // Only ever built for the signed-in person, so this is their own token.
  calendarToken: u.calendar_token || null,
});

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const url = requestUrl(request);
  const action = url.searchParams.get('do');

  // On a completely empty database, pull the roster so the first person can sign in.
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
  if (count === 0) {
    try {
      await syncPeople(sql, await fetchPeople());
    } catch (error) {
      return json({ error: 'SHEET_UNREADABLE', message: error.message }, 503);
    }
  }

  if (request.method === 'GET') {
    const user = await currentUser(request, sql);
    return json({ user: user ? publicUser(user) : null });
  }

  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const body = await request.json().catch(() => ({}));
  const username = String(body.username ?? '').trim();

  if (action === 'check') {
    const [u] = await sql`
      SELECT username, display_name, sheet_name, avatar, password_hash, reset_allowed
      FROM users WHERE lower(username) = ${username.toLowerCase()}
        AND active = true AND suspended = false`;

    // Deliberately explicit: this is an internal roster from a shared sheet,
    // so "no such user" is not secret, and saying so prevents a lot of
    // confused messages to the admin about typos.
    if (!u) return json({ known: false });

    return json({
      known: true,
      displayName: u.display_name || u.sheet_name,
      avatar: u.avatar || null,
      needsSetup: !u.password_hash || u.reset_allowed,
    });
  }

  if (action === 'setup') {
    const password = String(body.password ?? '');
    const problem = passwordProblem(password);
    if (problem) return json({ error: problem }, 400);

    const [u] = await sql`
      SELECT * FROM users WHERE lower(username) = ${username.toLowerCase()}
        AND active = true AND suspended = false`;
    if (!u) return json({ error: 'NO_SUCH_USER' }, 404);

    // Setting a password is only allowed when there isn't one, or when an
    // admin has explicitly unlocked a reset. Otherwise anyone who knew a
    // username could simply overwrite that person's password.
    if (u.password_hash && !u.reset_allowed) {
      return json({ error: 'RESET_NOT_AUTHORISED' }, 403);
    }

    const { hash, salt } = await hashPassword(password);
    await sql`
      UPDATE users SET password_hash = ${hash}, password_salt = ${salt},
                       reset_allowed = false, reset_allowed_by = NULL, updated_at = now()
      WHERE username = ${u.username}`;

    // Any older session elsewhere is invalidated by a password change.
    await sql`DELETE FROM sessions WHERE username = ${u.username}`;

    const token = newToken();
    await sql`INSERT INTO sessions (token, username, expires_at)
              VALUES (${token}, ${u.username}, ${sessionExpiry()})`;

    const [fresh] = await sql`SELECT * FROM users WHERE username = ${u.username}`;
    fresh.departments = await departmentsOf(sql, fresh.username);
    return json({ user: publicUser(fresh) }, 200, { 'set-cookie': sessionCookie(token) });
  }

  if (action === 'login') {
    const password = String(body.password ?? '');
    const [u] = await sql`
      SELECT * FROM users WHERE lower(username) = ${username.toLowerCase()}
        AND active = true AND suspended = false`;

    if (!u || !u.password_hash) return json({ error: 'BAD_CREDENTIALS' }, 401);
    if (u.reset_allowed) return json({ error: 'RESET_PENDING' }, 403);

    const ok = await verifyPassword(password, u.password_hash, u.password_salt);
    if (!ok) return json({ error: 'BAD_CREDENTIALS' }, 401);

    const token = newToken();
    await sql`INSERT INTO sessions (token, username, expires_at)
              VALUES (${token}, ${u.username}, ${sessionExpiry()})`;
    await sql`DELETE FROM sessions WHERE username = ${u.username} AND expires_at < now()`;

    u.departments = await departmentsOf(sql, u.username);
    return json({ user: publicUser(u) }, 200, { 'set-cookie': sessionCookie(token) });
  }

  if (action === 'logout') {
    const user = await currentUser(request, sql);
    if (user) {
      const cookie = request.headers.get('cookie') || '';
      const token = (cookie.match(/fair_session=([^;]+)/) || [])[1];
      if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
    }
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', { clear: true }) });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
