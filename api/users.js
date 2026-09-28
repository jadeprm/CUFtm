import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import {
  currentUser, canManageAccounts, cannotActOn, ACCESS, newToken,
  departmentsByUser, departmentsOf, setDepartments,
} from '../lib/auth.js';
import { fetchPeople, syncPeople, SHEET_ID } from '../lib/sheet.js';
import { writeAccess, sheetWriteConfigured } from '../lib/sheets.js';
import { isDepartment, expandAccess, departmentByKey } from '../lib/departments.js';
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

/**
 * How a set of department grants should read in the sheet's Department column.
 *
 * Thai labels, because that is what the column already contains and what Jade
 * reads — and every one of them is a spelling `parseDepartmentList` knows, so
 * what this writes comes back meaning the same thing on the next sync.
 */
const sheetDepartments = (keys, all) =>
  all ? ['All'] : keys.map((key) => departmentByKey(key)?.th || key);

const directoryRow = (u, grants = {}) => ({
  username: u.username,
  nickname: u.nickname,
  displayName: u.display_name || u.sheet_name || u.username,
  position: u.position,
  access: u.access,
  department: u.department,
  departments: grants[u.username] || u.departments || [],
  allDepartments: Boolean(u.all_departments),
  deptsPinned: Boolean(u.depts_pinned),
  accessPinned: Boolean(u.access_pinned),
  isHead: u.is_head,
  unit: u.unit || null,
  avatar: u.avatar || null,
  active: u.active,
  suspended: u.suspended,
  hasPassword: Boolean(u.password_hash),
  resetAllowed: u.reset_allowed,
  resetAllowedBy: u.reset_allowed_by,
  // Deliberately no calendar_token here: this row is visible to every
  // signed-in person, and that token grants read access to someone's tasks.
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
    const grants = await departmentsByUser(sql);
    const [meta] = await sql`SELECT value FROM meta WHERE key = 'last_sync'`;
    return json({
      users: rows.map((u) => directoryRow(u, grants)),
      canManage: canManageAccounts(me),
      canSetAccess: me.access === ACCESS.ADMIN,
      // Whether an access change made here can reach the sheet. The page says
      // so up front rather than letting an admin find out afterwards.
      sheetWritable: sheetWriteConfigured(),
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

    if (body.theme !== undefined) {
      patch.theme = ['light', 'dark', 'system'].includes(body.theme) ? body.theme : 'system';
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
        theme        = COALESCE(${patch.theme ?? null}, theme),
        updated_at   = now()
      WHERE username = ${me.username}`;

    const [fresh] = await sql`SELECT * FROM users WHERE username = ${me.username}`;
    fresh.departments = await departmentsOf(sql, me.username);
    return json({
      user: { ...directoryRow(fresh), theme: fresh.theme, calendarToken: fresh.calendar_token || null },
    });
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

    /**
     * Department access — the whole set, replaced in one call.
     *
     * Adding, removing and clearing are all "send the list you want", which
     * means two admins editing the same person cannot end up with a half-
     * applied change, and there is no separate delete endpoint to get wrong.
     *
     * `allDepartments` is the "every department, including ones added later"
     * switch; it is stored as a flag rather than as a row per department so a
     * new department does not have to be granted to the directors by hand.
     */
    /**
     * Whichever of access level and departments this request changed is
     * written back to the sheet once, at the end, rather than twice here: one
     * call to Google instead of two, and no window where the sheet holds a
     * half-applied change.
     */
    let sheetPlan = null;

    if (body.departments !== undefined || body.allDepartments !== undefined) {
      const wanted = Array.isArray(body.departments)
        ? [...new Set(body.departments.map((d) => String(d)))]
        : await departmentsOf(sql, target.username);

      const bad = wanted.filter((d) => !isDepartment(d));
      if (bad.length) return json({ error: 'BAD_DEPARTMENT', departments: bad }, 400);

      const all =
        body.allDepartments === undefined
          ? Boolean(target.all_departments)
          : Boolean(body.allDepartments);

      await sql`UPDATE users SET all_departments = ${all}, updated_at = now()
                WHERE username = ${target.username}`;
      await setDepartments(sql, target.username, expandAccess(wanted));

      sheetPlan = { ...(sheetPlan || {}), departments: sheetDepartments(wanted, all) };
      sets.push(all ? 'access: all departments' : `access: ${wanted.length} department(s)`);
    }

    /**
     * Hands the person back to the sheet.
     *
     * The next sync then rewrites their departments from the Department
     * column. Offered because an override with no way out would mean one
     * mistaken click permanently detaches someone from the roster.
     */
    if (body.followSheet) {
      await sql`UPDATE users SET depts_pinned = false, access_pinned = false, updated_at = now()
                WHERE username = ${target.username}`;
      sets.push('following the sheet again');
    }

    /** The home teamspace — where this person's new tasks land by default. */
    if (body.department !== undefined) {
      const dept = body.department === null ? null : String(body.department);
      if (dept !== null && !isDepartment(dept)) return json({ error: 'BAD_DEPARTMENT' }, 400);

      // Read the grants back rather than trusting the ones this request came
      // in with: the block above may just have changed them.
      const [{ all_departments: nowAll }] =
        await sql`SELECT all_departments FROM users WHERE username = ${target.username}`;
      const allowed = expandAccess(await departmentsOf(sql, target.username));
      if (dept !== null && !allowed.includes(dept) && !nowAll) {
        return json({ error: 'HOME_NOT_GRANTED' }, 400);
      }
      await sql`UPDATE users SET department = ${dept}, updated_at = now()
                WHERE username = ${target.username}`;
      sets.push('home teamspace set');
    }

    if (body.unit !== undefined) {
      const unit = body.unit === null ? null : String(body.unit).slice(0, 80);
      await sql`UPDATE users SET unit = ${unit}, updated_at = now() WHERE username = ${target.username}`;
      sets.push('unit set');
    }

    if (body.isHead !== undefined) {
      await sql`UPDATE users SET is_head = ${Boolean(body.isHead)}, updated_at = now()
                WHERE username = ${target.username}`;
      sets.push('head flag set');
    }

    /**
     * Access level, changed here and pushed back to the Google Sheet.
     *
     * The sheet stays the master list — this writes to it rather than working
     * around it, so the next sync reads back the same answer instead of
     * quietly restoring the old one.
     */
    if (body.access !== undefined) {
      const wanted = String(body.access);
      if (!Object.values(ACCESS).includes(wanted)) return json({ error: 'BAD_ACCESS' }, 400);

      /**
       * Only a full admin may set access. A co-admin can act on editors, and
       * if that included the access level they could promote an editor to
       * admin and act through them — the exact power the co-admin rule exists
       * to withhold.
       */
      if (me.access !== ACCESS.ADMIN) return json({ error: 'ONLY_ADMIN_SETS_ACCESS' }, 403);

      /**
       * There must always be someone left who can manage accounts. Without
       * this, one careless demotion locks everybody out of the admin page with
       * no way back in from inside the app.
       */
      if (target.access === ACCESS.ADMIN && wanted !== ACCESS.ADMIN) {
        const [{ count }] = await sql`
          SELECT count(*)::int AS count FROM users
          WHERE access = 'admin' AND active = true AND suspended = false`;
        if (count <= 1) return json({ error: 'LAST_ADMIN' }, 400);
      }

      await sql`UPDATE users SET access = ${wanted}, updated_at = now()
                WHERE username = ${target.username}`;

      sheetPlan = { ...(sheetPlan || {}), access: wanted };
      sets.push(`access level: ${wanted}`);
    }

    if (!sets.length) return json({ error: 'NOTHING_TO_DO' }, 400);

    /**
     * The write back to the Google Sheet.
     *
     * Deliberately last and deliberately not fatal: the change has already
     * taken effect in the app, and an admin who has just moved somebody should
     * see that happen even when Google is having a bad morning. What they get
     * instead is an honest note that the sheet did not receive it.
     *
     * Whichever part did not get through is pinned so the hourly sync leaves
     * it alone; whichever part did is unpinned, because the sheet now says the
     * same thing and there is nothing left to protect the record from.
     */
    let sheetResult = null;
    if (sheetPlan) {
      /**
       * Only the cells this request actually changed. Rewriting the Department
       * cell during an access change would quietly restandardise somebody's
       * hand-written "Oper 1" into the app's own spelling — a change nobody
       * asked for, in a column people maintain themselves.
       */
      sheetResult = await writeAccess(
        target.username,
        sheetPlan.access ?? null,
        sheetPlan.departments ?? null,
      );

      const stuck = !sheetResult.ok;
      if (sheetPlan.access !== undefined) {
        await sql`UPDATE users SET access_pinned = ${stuck} WHERE username = ${target.username}`;
      }
      if (sheetPlan.departments !== undefined) {
        await sql`UPDATE users SET depts_pinned = ${stuck} WHERE username = ${target.username}`;
      }
      sets.push(sheetResult.ok ? 'sheet updated' : 'sheet not updated');
    }

    const [fresh] = await sql`SELECT * FROM users WHERE username = ${target.username}`;
    fresh.departments = await departmentsOf(sql, target.username);
    return json({ user: directoryRow(fresh), did: sets, sheet: sheetResult });
  }

  /**
   * Issues (or replaces) this person's calendar feed token.
   *
   * Calling it again invalidates the old URL, which is the fix if a feed link
   * ever gets shared further than intended.
   */
  if (request.method === 'POST' && action === 'calendar-token') {
    const token = newToken();
    await sql`UPDATE users SET calendar_token = ${token}, updated_at = now()
              WHERE username = ${me.username}`;
    return json({ calendarToken: token });
  }

  // ---- pull the sheet ----------------------------------------------------
  if (request.method === 'POST' && action === 'sync') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
    try {
      const result = await syncPeople(sql, await fetchPeople());
      const rows = await sql`SELECT * FROM users ORDER BY active DESC, display_name`;
      const grants = await departmentsByUser(sql);
      return json({ ...result, users: rows.map((u) => directoryRow(u, grants)) });
    } catch (error) {
      return json({ error: 'SHEET_UNREADABLE', message: error.message }, 502);
    }
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
