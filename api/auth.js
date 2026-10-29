import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import {
  googleConfigured, originOf, startLink, finishLink, startDriveLink, finishDriveLink,
} from '../lib/googlecal.js';
import {
  currentUser, departmentsOf, hashPassword, verifyPassword, passwordProblem,
  newToken, sessionCookie, sessionExpiry,
} from '../lib/auth.js';
import { emailEnforced, mailConfigured } from '../lib/mail.js';
import {
  issueCode, checkCode, bindEmail, cleanEmail, EMAIL_SHAPE, startRegistration,
  resendRegistrationCode, verifyRegistration, approversFor,
} from '../lib/signup.js';
import { DEPARTMENTS, unitsOf } from '../lib/departments.js';
import { renameUser, USERNAME_SHAPE } from '../lib/rename.js';
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
  fullName: u.full_name || null,
  position: u.position,
  access: u.access,
  department: u.department,
  // The section they run, which is what scopes a unit editor.
  unit: u.unit || null,
  departments: u.departments || [],
  allDepartments: Boolean(u.all_departments),
  isHead: u.is_head,
  avatar: u.avatar || null,
  lang: u.lang || 'th',
  theme: u.theme || 'system',
  // Only ever built for the signed-in person, so this is their own token.
  calendarToken: u.calendar_token || null,
  // When a calendar last fetched their feed — the guide's "linked" signal.
  calendarSeenAt: u.calendar_seen_at || null,
  // Their own address only; never part of the shared directory.
  email: u.email || null,
  emailVerified: Boolean(u.email_verified_at),
  // True while the rule applies and they have not yet proved an address.
  emailRequired: emailEnforced() && !u.email_verified_at,
});

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const url = requestUrl(request);
  const action = url.searchParams.get('do');

  /**
   * Connecting a person's own Google Calendar — see lib/googlecal.js.
   *
   * Both halves are plain page loads, because Google sends the person back
   * with a redirect: start sends them to Google's consent screen, callback
   * is where Google returns them, and either way they end up on the
   * Schedule page with a word in the address saying how it went.
   */
  /**
   * The committee's Drive archive, connected once by an admin.
   *
   * Shares the one callback with the Calendar link because Google wants
   * every redirect URI registered by hand, and a second one is a second
   * thing to get wrong when the domain moves. `purpose` on the state row
   * is what tells the two apart — see lib/googlecal.js.
   */
  if (request.method === 'GET' && action === 'drive-start') {
    const go = (where) => new Response(null, { status: 302, headers: { location: where, 'cache-control': 'no-store' } });
    const user = await currentUser(request, sql);
    if (!user) return go('/#/admin?drive=signin');
    if (user.access !== 'admin' && user.access !== 'coadmin') return go('/#/admin?drive=notallowed');
    if (!googleConfigured()) return go('/#/admin?drive=off');
    return go(await startDriveLink(sql, user.username, originOf(request)));
  }

  if (request.method === 'GET' && (action === 'google-start' || action === 'google-callback')) {
    const go = (where) => new Response(null, { status: 302, headers: { location: where, 'cache-control': 'no-store' } });
    const user = await currentUser(request, sql);
    if (!user) return go('/#/schedule?google=signin');
    if (!googleConfigured()) return go('/#/schedule?google=off');
    const origin = originOf(request);
    if (action === 'google-start') return go(await startLink(sql, user.username, origin));

    /**
     * Which flow came back. Read from the state row rather than guessed
     * from the scope, so a cancelled consent still lands on the page the
     * person started from instead of somewhere they have never been.
     */
    const state = url.searchParams.get('state') || '';
    const [pending] = await sql`SELECT purpose FROM oauth_states WHERE state = ${state}`;
    const forDrive = pending?.purpose === 'drive';
    const page = forDrive ? '/#/admin?drive=' : '/#/schedule?google=';

    if (url.searchParams.get('error')) return go(page + 'cancelled');
    const done = forDrive
      ? await finishDriveLink(sql, user, { code: url.searchParams.get('code'), state, origin })
      : await finishLink(sql, user, { code: url.searchParams.get('code'), state, origin });
    return go(page + (done.ok ? 'ok' : encodeURIComponent(done.error)));
  }

  /**
   * What the registration form offers: the chart, and whether the system can
   * email a code at all. Public on purpose — it is the same chart every
   * signed-in person sees, and a stranger needs it to apply.
   */
  if (request.method === 'GET' && action === 'register-options') {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM users`;
    return json({
      mailReady: mailConfigured(),
      firstRun: n === 0,
      departments: await Promise.all(DEPARTMENTS.map(async (d) => ({
        key: d.key, th: d.th, en: d.en, units: unitsOf(d.key),
        // Names only, so the applicant can see who will be asked.
        approvers: (await approversFor(sql, d.key)).map((r) => ({
          name: r.nickname || r.display_name, head: Boolean(r.is_head), position: r.position || '',
        })),
      }))),
    });
  }

  if (request.method === 'GET') {
    const user = await currentUser(request, sql, { allowUnverified: true });
    return json({ user: user ? publicUser(user) : null });
  }

  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const body = await request.json().catch(() => ({}));
  const username = String(body.username ?? '').trim();

  // ---- forgotten password: a code to the verified email, then a new password ----
  /**
   * Nobody sets anybody's password. A person who has forgotten theirs asks for
   * a code to the address they proved, and chooses the new password
   * themselves. The answer to "send" is the same whether or not the account
   * exists, so this cannot be used to find out who has one.
   */
  const findForReset = async (who) => {
    const q = String(who ?? '').trim().toLowerCase();
    if (!q) return null;
    const [u] = await sql`
      SELECT * FROM users
      WHERE active = true AND suspended = false AND email_verified_at IS NOT NULL
        AND (lower(username) = ${q} OR lower(email) = ${q})
      LIMIT 1`;
    return u || null;
  };
  if (action === 'forgot-send') {
    if (!mailConfigured()) return json({ error: 'MAIL_NOT_CONFIGURED' }, 503);
    const u = await findForReset(body.identifier);
    if (u) await issueCode(sql, { purpose: 'reset', subject: u.username, email: u.email });
    return json({ ok: true });
  }
  if (action === 'forgot-verify') {
    const problem = passwordProblem(String(body.password ?? ''));
    if (problem) return json({ error: problem }, 400);
    const u = await findForReset(body.identifier);
    if (!u) return json({ error: 'CODE_EXPIRED' }, 400);
    const res = await checkCode(sql, { purpose: 'reset', subject: u.username, email: u.email, code: body.code });
    if (!res.ok) return json({ error: res.error }, 400);
    const { hash, salt } = await hashPassword(String(body.password));
    await sql`UPDATE users SET password_hash = ${hash}, password_salt = ${salt},
                reset_allowed = false, reset_allowed_by = NULL, updated_at = now()
              WHERE username = ${u.username}`;
    await sql`DELETE FROM sessions WHERE username = ${u.username}`;
    const token = newToken();
    await sql`INSERT INTO sessions (token, username, expires_at) VALUES (${token}, ${u.username}, ${sessionExpiry()})`;
    const [fresh] = await sql`SELECT * FROM users WHERE username = ${u.username}`;
    fresh.departments = await departmentsOf(sql, fresh.username);
    return json({ user: publicUser(fresh) }, 200, { 'set-cookie': sessionCookie(token) });
  }

  // ---- things a signed-in person manages themselves --------------------------
  if (action === 'password-change' || action === 'rename-send' || action === 'rename-verify') {
    const me = await currentUser(request, sql);
    if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

    if (action === 'password-change') {
      const problem = passwordProblem(String(body.password ?? ''));
      if (problem) return json({ error: problem }, 400);
      if (!await verifyPassword(String(body.current ?? ''), me.password_hash, me.password_salt)) {
        return json({ error: 'BAD_CREDENTIALS' }, 401);
      }
      const { hash, salt } = await hashPassword(String(body.password));
      await sql`UPDATE users SET password_hash = ${hash}, password_salt = ${salt}, updated_at = now()
                WHERE username = ${me.username}`;
      // Every other device is signed out; this one stays.
      const token = (request.headers.get('cookie') || '').match(/fair_session=([^;]+)/)?.[1] || '';
      await sql`DELETE FROM sessions WHERE username = ${me.username} AND token <> ${token}`;
      return json({ ok: true });
    }

    // A new username: proved with a code to the address already on the account.
    if (!me.email || !me.email_verified_at) return json({ error: 'EMAIL_REQUIRED_FIRST' }, 400);
    if (action === 'rename-send') {
      const sent = await issueCode(sql, { purpose: 'rename', subject: me.username, email: me.email });
      if (!sent.ok) return json({ error: sent.error, wait: sent.wait }, sent.error === 'MAIL_NOT_CONFIGURED' ? 503 : 429);
      return json({ ok: true });
    }
    const to = String(body.newUsername ?? '').trim();
    if (!USERNAME_SHAPE.test(to)) return json({ error: 'BAD_USERNAME' }, 400);
    if (to === me.username) return json({ error: 'NOTHING_TO_DO' }, 400);
    const [clash] = await sql`SELECT 1 AS x FROM users WHERE lower(username) = ${to.toLowerCase()} AND username <> ${me.username}`;
    if (clash) return json({ error: 'USERNAME_TAKEN' }, 409);
    const res = await checkCode(sql, { purpose: 'rename', subject: me.username, email: me.email, code: body.code });
    if (!res.ok) return json({ error: res.error }, 400);
    await renameUser(sql, me.username, to);
    const [fresh] = await sql`SELECT * FROM users WHERE username = ${to}`;
    fresh.departments = await departmentsOf(sql, to);
    return json({ user: publicUser(fresh) });
  }

  // ---- joining, without an admin creating the account --------------------
  if (action === 'register') {
    const r = await startRegistration(sql, body);
    const { status, ...rest } = r;
    return json(rest, status);
  }
  if (action === 'register-resend') {
    const { status, ...rest } = await resendRegistrationCode(sql, String(body.id ?? ''));
    return json(rest, status);
  }
  if (action === 'register-verify') {
    const { status, ...rest } = await verifyRegistration(sql, String(body.id ?? ''), body.code);
    return json(rest, status);
  }

  // ---- an existing person proving their own email --------------------------
  if (action === 'email-send' || action === 'email-verify') {
    const me = await currentUser(request, sql, { allowUnverified: true });
    if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);
    const email = cleanEmail(body.email);
    if (!EMAIL_SHAPE.test(email)) return json({ error: 'BAD_EMAIL' }, 400);
    const [taken] = await sql`
      SELECT 1 AS x FROM users WHERE lower(email) = ${email}
        AND email_verified_at IS NOT NULL AND username <> ${me.username}`;
    if (taken) return json({ error: 'EMAIL_TAKEN' }, 409);

    if (action === 'email-send') {
      const sent = await issueCode(sql, { purpose: 'bind', subject: me.username, email });
      if (!sent.ok) {
        return json({ error: sent.error, wait: sent.wait }, sent.error === 'MAIL_NOT_CONFIGURED' ? 503 : 429);
      }
      return json({ ok: true });
    }
    const res = await checkCode(sql, { purpose: 'bind', subject: me.username, email, code: body.code });
    if (!res.ok) return json({ error: res.error }, 400);
    const bound = await bindEmail(sql, me.username, email);
    if (!bound.ok) return json({ error: bound.error }, 409);
    const [fresh] = await sql`SELECT * FROM users WHERE username = ${me.username}`;
    fresh.departments = await departmentsOf(sql, me.username);
    return json({ user: publicUser(fresh) });
  }

  if (action === 'check') {
    const [u] = await sql`
      SELECT username, display_name, sheet_name, avatar, password_hash, reset_allowed
      FROM users WHERE lower(username) = ${username.toLowerCase()}
        AND active = true AND suspended = false`;

    // Deliberately explicit: this is an internal roster from a shared sheet,
    // so "no such user" is not secret, and saying so prevents a lot of
    // confused messages to the admin about typos.
    if (!u) {
      const [wait] = await sql`
        SELECT 1 AS x FROM registrations
        WHERE lower(username) = ${username.toLowerCase()} AND status = 'pending'`;
      return json({ known: false, pending: Boolean(wait) });
    }

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
    const user = await currentUser(request, sql, { allowUnverified: true });
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
