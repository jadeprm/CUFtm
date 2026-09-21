import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser, canManageAccounts, cannotActOn, ACCESS } from '../lib/auth.js';
import { fetchPeople, syncPeople, SHEET_ID } from '../lib/sheet.js';
import { isDepartment } from '../lib/departments.js';
import { withNode } from '../lib/http.js';

/**
 * People: the directory everyone can see, the profile each person owns, and
 * the account controls only admins and co-admins get.
 *
 *   GET   /api/users                   directory (everyone signed in)
 *   PATCH /api/users?do=me             my own profile
 *   PATCH /api/users?do=manage         admin / co-admin acting on someone
 *   POST  /api/users?do=sync           re-read the Google Sheet
 */

const MAX_AVATAR = 200_000; // ~200 KB of data URL; the page downsizes before sending

const directoryRow = (u) => ({
  username: u.username,
  nickname: u.nickname,
  displayName: u.display_name || u.sheet_name || u.username,
  position: u.position,
  access: u.access,
  department: u.department,
  isHead: u.is_head,
  avatar: u.avatar || null,
  active: u.active,
  suspended: u.suspended,
  hasPassword: Boolean(u.password_hash),
  resetAllowed: u.reset_allowed,
  resetAllowedBy: u.reset_allowed_by,
});

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);
  const action = url.searchParams.get('do');

  // ---- directory ---------------------------------------------------------
  if (request.method === 'GET') {
    const rows = await sql`SELECT * FROM users ORDER BY active DESC, display_name`;
    const [meta] = await sql`SELECT value FROM meta WHERE key = 'last_sync'`;
    return json({
      users: rows.map(directoryRow),
      canManage: canManageAccounts(me),
      lastSync: meta?.value || null,
      sheetId: SHEET_ID,
    });
  }

  // ---- my own profile ----------------------------------------------------
  if (request.method === 'PATCH' && action === 'me') {
    const body = await request.json().catch(() => ({}));
    const patch = {};

    if (body.displayName !== undefined) {
      const name = String(body.displayName).trim().slice(0, 80);
      if (!name) return json({ error: 'NAME_REQUIRED' }, 400);
      patch.displayName = name;
    }

    if (body.avatar !== undefined) {
      const avatar = body.avatar === null ? null : String(body.avatar);
      if (avatar && !avatar.startsWith('data:image/')) return json({ error: 'BAD_IMAGE' }, 400);
      if (avatar && avatar.length > MAX_AVATAR) return json({ error: 'IMAGE_TOO_BIG' }, 400);
      patch.avatar = avatar;
    }

    if (body.lang !== undefined) {
      patch.lang = body.lang === 'en' ? 'en' : 'th';
    }

    /**
     * Username is the key the sheet, sessions and every task assignment hang
     * off, so it is not editable here. The sheet owns it: change it there and
     * the sync follows. Saying so beats silently ignoring the field.
     */
    if (body.username !== undefined && body.username !== me.username) {
      return json({ error: 'USERNAME_FROM_SHEET' }, 400);
    }

    await sql`
      UPDATE users SET
        display_name = COALESCE(${patch.displayName ?? null}, display_name),
        avatar       = CASE WHEN ${patch.avatar !== undefined} THEN ${patch.avatar ?? null} ELSE avatar END,
        lang         = COALESCE(${patch.lang ?? null}, lang),
        updated_at   = now()
      WHERE username = ${me.username}`;

    const [fresh] = await sql`SELECT * FROM users WHERE username = ${me.username}`;
    return json({ user: directoryRow(fresh) });
  }

  // ---- account management ------------------------------------------------
  if (request.method === 'PATCH' && action === 'manage') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);

    const body = await request.json().catch(() => ({}));
    const targetName = String(body.username ?? '').trim();
    const [target] = await sql`SELECT * FROM users WHERE lower(username) = ${targetName.toLowerCase()}`;

    const blocked = cannotActOn(me, target);
    if (blocked) return json({ error: blocked }, blocked === 'NO_SUCH_USER' ? 404 : 403);

    const sets = [];

    // Authorise (or cancel) a password reset. The person then sets a new one
    // themselves — nobody, including an admin, ever sees or types their password.
    if (body.allowReset !== undefined) {
      const allow = Boolean(body.allowReset);
      await sql`
        UPDATE users SET reset_allowed = ${allow},
                         reset_allowed_by = ${allow ? me.username : null},
                         updated_at = now()
        WHERE username = ${target.username}`;
      if (allow) await sql`DELETE FROM sessions WHERE username = ${target.username}`;
      sets.push(allow ? 'reset authorised' : 'reset cancelled');
    }

    if (body.suspended !== undefined) {
      const suspended = Boolean(body.suspended);
      await sql`UPDATE users SET suspended = ${suspended}, updated_at = now()
                WHERE username = ${target.username}`;
      if (suspended) await sql`DELETE FROM sessions WHERE username = ${target.username}`;
      sets.push(suspended ? 'suspended' : 'restored');
    }

    if (body.department !== undefined) {
      const dept = body.department === null ? null : String(body.department);
      if (dept !== null && !isDepartment(dept)) return json({ error: 'BAD_DEPARTMENT' }, 400);
      await sql`UPDATE users SET department = ${dept}, updated_at = now()
                WHERE username = ${target.username}`;
      sets.push('department set');
    }

    if (body.isHead !== undefined) {
      await sql`UPDATE users SET is_head = ${Boolean(body.isHead)}, updated_at = now()
                WHERE username = ${target.username}`;
      sets.push('head flag set');
    }

    /**
     * Access level is not settable here on purpose: the Google Sheet is the
     * master for it. Editing it in the app would be silently undone by the
     * next sync, which is worse than refusing.
     */
    if (body.access !== undefined) {
      return json({ error: 'ACCESS_FROM_SHEET' }, 400);
    }

    if (!sets.length) return json({ error: 'NOTHING_TO_DO' }, 400);

    const [fresh] = await sql`SELECT * FROM users WHERE username = ${target.username}`;
    return json({ user: directoryRow(fresh), did: sets });
  }

  // ---- pull the sheet ----------------------------------------------------
  if (request.method === 'POST' && action === 'sync') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
    try {
      const result = await syncPeople(sql, await fetchPeople());
      const rows = await sql`SELECT * FROM users ORDER BY active DESC, display_name`;
      return json({ ...result, users: rows.map(directoryRow) });
    } catch (error) {
      return json({ error: 'SHEET_UNREADABLE', message: error.message }, 502);
    }
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
