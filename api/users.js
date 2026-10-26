import { getSql, json, noDatabase, hasDatabase, requestUrl, forgetOrg } from '../lib/db.js';
import {
  currentUser, canManageAccounts, cannotActOn, ACCESS, newToken,
  departmentsByUser, departmentsOf, setDepartments, normaliseAccess, ACCESS_ORDER,
} from '../lib/auth.js';
import {
  isDepartment, expandAccess, departmentByKey, matchUnit, DEPARTMENT_KEYS,
  DEPARTMENTS, unitsOf, makeDepartmentKey,
} from '../lib/departments.js';
import {
  CIRCLES, CIRCLE_KEYS, isCircle, inCircle, circleByKey, isMadeGroup,
  makeCircleKey, pinnedState,
} from '../lib/circles.js';
import { renameUser, USERNAME_SHAPE } from '../lib/rename.js';
import { unlinkDrive } from '../lib/googlecal.js';
import { driveStatus } from '../lib/drive.js';
import {
  availabilityOf, setAvailability, addBlock, removeBlock, checkClashes,
} from '../lib/availstore.js';
import { accessSet } from '../lib/scope.js';
import { withNode } from '../lib/http.js';
import { APPROVER_ACCESS, approveRegistration, rejectRegistration } from '../lib/signup.js';
import { prefsOf, setPref } from '../lib/notifyprefs.js';

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
const MAX_TAGS = 20;        // a filter row of forty labels is not a filter row

/**
 * How a set of department grants should read in the sheet's Department column.
 *
 * Thai labels, because that is what the column already contains and what Jade
 * reads — and every one of them is a spelling `parseDepartmentList` knows, so
 * what this writes comes back meaning the same thing on the next sync.
 */
const sheetDepartments = (keys, all) =>
  all ? ['All'] : keys.map((key) => departmentByKey(key)?.th || key);

/**
 * Which circles somebody is in, worked out once here.
 *
 * The page used to recompute this from the access ladder, which was right
 * while a circle was nothing but the ladder. It no longer is: an admin can
 * put somebody in or keep them out, and a group the committee invented
 * derives nothing at all. One answer, from the side that owns the rule.
 */
const circlesOf = (u) => CIRCLE_KEYS.filter((key) => inCircle({
  username: u.username, access: u.access, active: u.active, suspended: u.suspended,
}, key));

/**
 * Who may read a member's email: admins and co-admins for everybody, and an
 * editor for the people in the departments they look after. Everyone else
 * gets the verified flag only.
 */
const mayReadEmail = (viewer, u, grants) => {
  if (!viewer) return false;
  if (viewer.access === 'admin' || viewer.access === 'coadmin') return true;
  if (viewer.access !== 'editor') return false;
  const mine = accessSet(viewer);
  const theirs = (grants[u.username] || u.departments || []).concat(u.department ? [u.department] : []);
  return theirs.some((d) => mine.has(d));
};

const directoryRow = (u, grants = {}, viewer = null) => ({
  email: mayReadEmail(viewer, u, grants) ? (u.email || null) : undefined,
  username: u.username,
  nickname: u.nickname,
  displayName: u.display_name || u.sheet_name || u.username,
  // The name that goes on a letter, as opposed to the one on a task board.
  fullName: u.full_name || null,
  position: u.position,
  access: u.access,
  department: u.department,
  departments: grants[u.username] || u.departments || [],
  circles: circlesOf(u),
  allDepartments: Boolean(u.all_departments),
  deptsPinned: Boolean(u.depts_pinned),
  accessPinned: Boolean(u.access_pinned),
  isHead: u.is_head,
  unit: u.unit || null,
  avatar: u.avatar || null,
  active: u.active,
  suspended: u.suspended,
  hasPassword: Boolean(u.password_hash),
  // Whether they have proved an email — never the address itself.
  emailVerified: Boolean(u.email_verified_at),
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

  /**
   * When people are free, and who is already spoken for.
   *
   * Rides on this endpoint rather than a file of its own because Vercel counts
   * every file under api/ as a Serverless Function and the Hobby plan allows
   * twelve, which are all in use. The work is in lib/availstore.js and the
   * rules it applies are in lib/availability.js.
   */
  if (action === 'free' || action === 'block' || action === 'clashes') {
    if (action === 'free' && request.method === 'GET') {
      const who = url.searchParams.get('username') || me.username;
      return json(await availabilityOf(sql, who, { forSelf: who === me.username }));
    }
    if (action === 'free' && request.method === 'PUT') {
      return setAvailability(sql, me, await request.json().catch(() => ({})), { json });
    }
    if (action === 'block' && request.method === 'POST') {
      return addBlock(sql, me, await request.json().catch(() => ({})), { json });
    }
    if (action === 'block' && request.method === 'DELETE') {
      return removeBlock(sql, me, url.searchParams.get('id'), { json });
    }
    if (action === 'clashes' && request.method === 'POST') {
      const roster = await sql`SELECT username, display_name, access FROM users`;
      return checkClashes(sql, me, await request.json().catch(() => ({})),
        { json, people: roster.map((p) => ({ ...p, displayName: p.display_name })) });
    }
  
  }

  /**
   * Why notifications are or are not arriving.
   *
   * Built because "notifications don't work" was impossible to answer from
   * inside the app. Three different failures look identical from a phone:
   * nothing is calling the hourly endpoint, nothing is due, or nobody has
   * switched notifications on. This says which.
   */
  /**
   * What this person wants to be told about — lib/notifyprefs.js.
   *
   *   GET  ?do=notify            every category, filled in, plus overrides
   *   POST ?do=notify  { scope, id?, level }   level null = back to default
   *
   * Only ever one's own: nobody sets another person's notifications.
   */
  if (action === 'notify') {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const problem = await setPref(sql, me.username, {
        scope: String(body.scope || ''), id: body.id, level: body.level ?? null,
      });
      if (problem) return json({ error: problem }, 400);
    }
    return json(await prefsOf(sql, me.username));
  }

  if (request.method === 'GET' && action === 'health') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);

    const [lastCron] = await sql`SELECT value FROM meta WHERE key = 'last_cron'`;
    const [{ subs }] = await sql`SELECT count(*)::int AS subs FROM push_subscriptions`;
    const [{ people }] = await sql`
      SELECT count(DISTINCT username)::int AS people FROM push_subscriptions`;
    const [{ lines }] = await sql`SELECT count(*)::int AS lines FROM line_links`;
    const [{ failing }] = await sql`
      SELECT count(*)::int AS failing FROM push_subscriptions WHERE last_error IS NOT NULL`;

    /**
     * What the next run would actually send. A list of deadlines with nothing
     * in the reminder window is the most common answer of all, and the least
     * obvious one.
     */
    const soon = await sql`
      SELECT t.id, t.title, t.due_date,
             (t.due_date - (now() AT TIME ZONE 'Asia/Bangkok')::date) AS days,
             (SELECT count(*)::int FROM task_people p WHERE p.task_id = t.id) AS people
      FROM tasks t
      WHERE t.due_date IS NOT NULL AND t.status <> 'done'
      ORDER BY t.due_date
      LIMIT 40`;

    const due = soon.map((row) => {
      const days = Number(row.days);
      const kind = days === 7 ? '7d' : days === 3 ? '3d' : days === 1 ? '24h'
        : days === 0 ? 'due' : days < 0 ? 'overdue' : null;
      return { id: row.id, title: row.title, days, people: row.people, remindsToday: kind };
    });

    /**
     * What LINE has cost this month.
     *
     * The plans are bought a month at a time and the limit is a hard stop, so
     * this has to be visible before it is reached rather than afterwards. The
     * free tier is about 300 a month and the Basic plan about 15,000 — the
     * page compares against whichever is configured.
     */
    /**
     * The start of the Bangkok month, as an actual instant.
     *
     * Truncating now() in Bangkok gives a timestamp with no zone attached, and
     * comparing one of those against a TIMESTAMPTZ makes Postgres read it in
     * the SERVER's zone, which is UTC. The boundary landed seven hours late, so
     * for the first seven hours of every Bangkok month this counter read zero
     * and messages sent in that window were never counted against the quota —
     * undercounting a hard limit, which is the dangerous direction. The second
     * AT TIME ZONE turns it back into an instant, so both sides of the
     * comparison mean the same thing.
     */
    const [charges] = await sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE kind = 'digest')::int AS digests,
             count(*) FILTER (WHERE kind = 'document')::int AS documents
      FROM line_charges
      WHERE sent_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok')
                        AT TIME ZONE 'Asia/Bangkok')`;
    const [{ optedIn }] = await sql`
      SELECT count(*)::int AS "optedIn" FROM line_links WHERE digest = true`;

    /**
     * Where the PDFs actually are.
     *
     * Every uploaded document sits in the database while it is being signed,
     * because that is the only place a half-finished document can safely live.
     * Google Drive is what empties it again: the nightly run copies a finished
     * document out, waits a few days, checks Drive still holds it, and only
     * then deletes the copy here. With Drive unconfigured that second half
     * never happens and the database grows forever — which is invisible until
     * a storage bill arrives, so it is stated here instead.
     */
    const drive = driveStatus();
    const [pdf] = await sql`
      SELECT coalesce(sum(byte_size), 0)::bigint AS bytes,
             count(*)::int AS files,
             count(DISTINCT doc_id)::int AS docs
      FROM doc_files`;
    /**
     * Meeting papers held here rather than in Drive.
     *
     * Same story as the documents above and worth its own line, because the
     * cause is different: a document sits here because it is mid-signature and
     * leaves on its own, whereas an attachment is only here because Drive was
     * unconfigured or refused it at the moment somebody uploaded it, and
     * nothing comes back later to move it. A number growing here means files
     * that will stay until somebody does something about them.
     */
    const [papers] = await sql`
      SELECT coalesce(sum(byte_size) FILTER (WHERE bytes IS NOT NULL), 0)::bigint AS bytes,
             count(*) FILTER (WHERE bytes IS NOT NULL)::int AS here,
             count(*) FILTER (WHERE drive_url IS NOT NULL)::int AS "inDrive",
             count(*) FILTER (WHERE link_url <> '')::int AS links
      FROM meeting_files`;

    const [flow] = await sql`
      SELECT count(*) FILTER (WHERE sent_at IS NOT NULL
                                AND drive_file_id IS NULL)::int AS waiting,
             count(*) FILTER (WHERE drive_file_id IS NOT NULL)::int AS archived,
             count(*) FILTER (WHERE drive_file_id IS NOT NULL
                                AND EXISTS (SELECT 1 FROM doc_files f
                                            WHERE f.doc_id = documents.id))::int AS notYetPurged
      FROM documents`;

    return json({
      driveConfigured: drive.configured,
      driveHasClient: drive.hasClient,
      driveHasRefreshToken: drive.hasRefreshToken,
      // Connected by the button rather than pinned in the environment, and
      // when — so the page can offer to connect, or to disconnect.
      driveByButton: drive.byButton,
      driveLinkedAt: (await sql`SELECT value FROM meta WHERE key = 'drive_linked_at'`)[0]?.value || null,
      driveMayConnect: canManageAccounts(me),
      driveFolder: drive.folder,
      drivePinnedFolder: drive.pinnedFolder,
      archiveGraceDays: Number(process.env.DOC_ARCHIVE_DAYS || 3),
      pdfBytes: Number(pdf?.bytes || 0),
      pdfFiles: Number(pdf?.files || 0),
      pdfDocs: Number(pdf?.docs || 0),
      paperBytes: Number(papers?.bytes || 0),
      papersHere: Number(papers?.here || 0),
      papersInDrive: Number(papers?.inDrive || 0),
      paperLinks: Number(papers?.links || 0),
      docsWaitingToArchive: Number(flow?.waiting || 0),
      docsArchived: Number(flow?.archived || 0),
      docsNotYetPurged: Number(flow?.notYetPurged || 0),
      lineCharged: charges,
      lineDigestOptIn: optedIn,
      lineQuota: Number(process.env.LINE_MONTHLY_QUOTA || 300),
      lastCron: lastCron?.value || null,
      cronSecured: Boolean(process.env.CRON_SECRET),
      pushSubscriptions: subs,
      pushPeople: people,
      pushFailing: failing,
      lineConfigured: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET),
      lineLinked: lines,
      dueSoon: due,
      remindingToday: due.filter((d) => d.remindsToday).length,
    });
  }

  // ---- directory ---------------------------------------------------------
  // `?do=org` is the one other GET on this endpoint, and it is answered
  // further down; without this it would be swallowed by the directory.
  if (request.method === 'GET' && !['org', 'groups', 'tags', 'registrations'].includes(action)) {
    const rows = await sql`SELECT * FROM users ORDER BY active DESC, display_name`;
    const grants = await departmentsByUser(sql);
    return json({
      users: rows.map((u) => directoryRow(u, grants, me)),
      canManage: canManageAccounts(me),
      canSetAccess: me.access === ACCESS.ADMIN,
    });
  }

  // ---- my own profile ----------------------------------------------------
  if (request.method === 'PATCH' && action === 'me') {
    const body = await request.json().catch(() => ({}));
    const patch = {};

    /**
     * Their own full name — firstname lastname, as it goes on a document.
     *
     * Theirs to set, not an admin's: a name is the one field nobody else
     * should be correcting on somebody's behalf.
     */
    if (body.fullName !== undefined) {
      const full = String(body.fullName ?? '').trim().slice(0, 120);
      await sql`UPDATE users SET full_name = ${full || null}, updated_at = now()
                WHERE username = ${me.username}`;
    }

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

    /**
     * The section inside a department.
     *
     * Only a name the org chart lists for one of the departments this person
     * has been granted is accepted. A free-text box would fill the roster with
     * three spellings of เวที within a week, and a unit editor's whole scope
     * hangs off this value matching the people in their section exactly.
     */
    if (body.unit !== undefined) {
      const unit = body.unit === null || body.unit === '' ? null : String(body.unit).slice(0, 80);

      if (unit !== null) {
        const granted = Boolean(target.all_departments)
          ? DEPARTMENT_KEYS
          : expandAccess(await departmentsOf(sql, target.username));
        const known = granted.some((key) => matchUnit(key, unit) === unit);
        if (!known) return json({ error: 'UNIT_NOT_IN_DEPARTMENT', unit }, 400);
      }

      await sql`UPDATE users SET unit = ${unit}, updated_at = now() WHERE username = ${target.username}`;
      sheetPlan = { ...(sheetPlan || {}), unit: unit || '' };
      sets.push(unit ? `unit: ${unit}` : 'unit cleared');
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
     * The member database is this app's own; nothing is written anywhere
     * else. What was set here is marked as set here, so the one-off sheet
     * import (lib/sheet.js) can never overwrite it.
     */
    const sheetResult = null;
    if (sheetPlan?.access !== undefined) {
      await sql`UPDATE users SET access_pinned = true WHERE username = ${target.username}`;
    }
    if (sheetPlan?.departments !== undefined) {
      await sql`UPDATE users SET depts_pinned = true WHERE username = ${target.username}`;
    }

    const [fresh] = await sql`SELECT * FROM users WHERE username = ${target.username}`;
    fresh.departments = await departmentsOf(sql, target.username);
    return json({ user: directoryRow(fresh, {}, me), did: sets, sheet: sheetResult });
  }

  /**
   * Removing an account for good.
   *
   * Only for somebody already out of the committee — off the sheet, or
   * suspended. Deleting a working account would be a mistake with no undo, and
   * an active member is removed by taking them off the sheet, which is where
   * membership is decided.
   *
   * What goes: the account, its password, its sessions, its notifications, its
   * LINE link, its devices, and its department grants. What stays: everything
   * the committee needs — the tasks and events they made, the documents they
   * sent and the signatures already on them. A record with a hole where a name
   * used to be is worse than one that mentions somebody who has left.
   */
  if (request.method === 'DELETE' && action === 'user') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);

    const name = url.searchParams.get('username') || '';
    const [target] = await sql`SELECT * FROM users WHERE lower(username) = ${name.toLowerCase()}`;

    const blocked = cannotActOn(me, target);
    if (blocked) return json({ error: blocked }, blocked === 'NO_SUCH_USER' ? 404 : 403);
    if (target.username === me.username) return json({ error: 'CANNOT_DELETE_YOURSELF' }, 400);
    if (target.active && !target.suspended) return json({ error: 'ONLY_INACTIVE_OR_SUSPENDED' }, 400);

    /**
     * Their work is handed to the person doing the removing rather than
     * deleted with them — a task cascade would take the committee's work with
     * the account, which is never what "remove this person" means.
     */
    const kept = { tasks: 0, events: 0, documents: 0 };
    const tasks = await sql`
      UPDATE tasks SET created_by = ${me.username}, updated_at = now()
      WHERE created_by = ${target.username} RETURNING id`;
    kept.tasks = tasks.length;
    const events = await sql`
      UPDATE events SET created_by = ${me.username}, updated_at = now()
      WHERE created_by = ${target.username} RETURNING id`;
    kept.events = events.length;
    const docs = await sql`
      SELECT count(*)::int AS n FROM documents WHERE created_by = ${target.username}`;
    kept.documents = docs[0].n;
    await sql`UPDATE documents SET created_by = ${me.username} WHERE created_by = ${target.username}`;

    // Everything that is only about them, gone before the row itself.
    await sql`DELETE FROM task_people WHERE username = ${target.username}`;
    await sql`DELETE FROM event_people WHERE username = ${target.username}`;
    await sql`DELETE FROM reminders_sent WHERE username = ${target.username}`;
    await sql`DELETE FROM notifications WHERE username = ${target.username}`;
    await sql`DELETE FROM users WHERE username = ${target.username}`;

    const rows = await sql`SELECT * FROM users ORDER BY active DESC, display_name`;
    const grants = await departmentsByUser(sql);
    return json({
      ok: true,
      removed: target.username,
      kept,
      users: rows.map((u) => directoryRow(u, grants, me)),
    });
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

  // ---- add somebody the sheet does not have yet --------------------------
  /**
   * Creating an account without going through the roster sheet.
   *
   * The sheet is still the roster of record, and the ordinary path is to add
   * a row there and sync. But a sheet round trip is minutes at best and a
   * conversation at worst, and the committee gains people in the middle of a
   * week — so an admin can put somebody in now and let the sheet catch up.
   *
   * No password is set here. The person claims the account the same way
   * everybody else does, which is what keeps the rule that no admin ever
   * knows or types somebody else's password.
   */
  if (request.method === 'POST' && action === 'add') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
    const body = await request.json().catch(() => ({}));

    const username = String(body.username ?? '').trim().slice(0, 64);
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) return json({ error: 'BAD_USERNAME' }, 400);
    const [clash] = await sql`SELECT username FROM users WHERE lower(username) = ${username.toLowerCase()}`;
    if (clash) return json({ error: 'USERNAME_TAKEN', username: clash.username }, 409);

    const nickname = String(body.nickname ?? '').trim().slice(0, 60);
    if (!nickname) return json({ error: 'NICKNAME_REQUIRED' }, 400);
    const displayName = String(body.displayName ?? '').trim().slice(0, 120) || nickname;
    const position = String(body.position ?? '').trim().slice(0, 120);

    /**
     * Only an admin hands out admin. The same rule the manage route applies
     * when changing somebody's level — creating a person at that level would
     * otherwise be the way round it.
     */
    const access = normaliseAccess(body.access);
    if (access === ACCESS.ADMIN && me.access !== ACCESS.ADMIN) {
      return json({ error: 'ONLY_ADMIN_SETS_ACCESS' }, 403);
    }
    if (ACCESS_ORDER.indexOf(access) >= ACCESS_ORDER.indexOf(ACCESS.COADMIN)
        && me.access !== ACCESS.ADMIN) {
      return json({ error: 'ONLY_ADMIN_SETS_ACCESS' }, 403);
    }

    const all = Boolean(body.allDepartments);
    const asked = Array.isArray(body.departments) ? body.departments.map(String) : [];
    const bad = asked.filter((key) => !isDepartment(key));
    if (bad.length) return json({ error: 'BAD_DEPARTMENT', departments: bad }, 400);
    const departments = all ? [] : expandAccess(asked);

    const home = String(body.department ?? '').trim() || departments[0] || null;
    if (home && !isDepartment(home)) return json({ error: 'BAD_DEPARTMENT', departments: [home] }, 400);
    // A home department somebody can work in — the same rule the manage route
    // applies, so the admin page cannot create what it would then refuse.
    if (home && !all && !departments.includes(home)) departments.push(home);

    const unit = body.unit ? matchUnit(home, body.unit) : null;
    if (body.unit && !unit) return json({ error: 'UNIT_NOT_IN_DEPARTMENT', unit: String(body.unit) }, 400);

    await sql`
      INSERT INTO users (username, nickname, sheet_name, display_name, position, access,
                         department, all_departments, unit, is_head, active, off_sheet,
                         access_pinned, depts_pinned)
      VALUES (${username}, ${nickname}, ${displayName}, ${displayName}, ${position}, ${access},
              ${home}, ${all}, ${unit}, ${Boolean(body.isHead)}, true, true, true, true)`;
    if (!all) await setDepartments(sql, username, departments);

    const rows = await sql`SELECT * FROM users ORDER BY active DESC, display_name`;
    const grants = await departmentsByUser(sql);
    return json({
      ok: true, username,
      users: rows.map((u) => directoryRow(u, grants, me)),
    }, 201);
  }

  // ---- people asking to join ------------------------------------------------
  /**
   * The queue a newcomer lands in once their email is proved. Whoever the
   * applicant named — and any admin or co-admin — can decide; the first
   * decision settles it, so it never needs more than one person.
   */
  if (action === 'registrations' || action === 'registration-decide') {
    if (!APPROVER_ACCESS.includes(me.access)) return json({ error: 'NOT_AN_APPROVER' }, 403);
    const rank = me.access === ACCESS.ADMIN || me.access === ACCESS.COADMIN;

    if (request.method === 'GET') {
      const rows = await sql`
        SELECT id, username, nickname, full_name, position, department, unit, email, approvers, created_at
        FROM registrations WHERE status = 'pending' ORDER BY created_at`;
      return json({
        requests: rows
          .filter((r) => rank || r.approvers.includes(me.username))
          .map((r) => ({
            id: r.id, username: r.username, nickname: r.nickname, fullName: r.full_name,
            position: r.position, department: r.department, unit: r.unit, email: r.email,
            approvers: r.approvers, createdAt: r.created_at,
          })),
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id ?? '');
      const [reg] = await sql`SELECT approvers FROM registrations WHERE id = ${id} AND status = 'pending'`;
      if (!reg) return json({ error: 'NO_SUCH_REGISTRATION' }, 404);
      if (!rank && !reg.approvers.includes(me.username)) return json({ error: 'NOT_AN_APPROVER' }, 403);
      const out = body.approve
        ? await approveRegistration(sql, id, { by: me.username, access: 'inner' })
        : await rejectRegistration(sql, id, { by: me.username, reason: body.reason });
      if (out.error) return json({ error: out.error }, out.error === 'USERNAME_TAKEN' ? 409 : 404);
      return json({ ok: true, username: out.username || null });
    }
  }

  // ---- the org chart -----------------------------------------------------
  /**
   * Departments and the หน่วย inside them, editable without a deployment.
   *
   * What the admin page may change is deliberately narrow: labels, which
   * ฝ่าย a new one sits under, the list of หน่วย, and whether something is
   * still in use. Keys are never editable and nothing is ever deleted,
   * because a key is written on tasks, grants, meetings and documents, and a
   * chart that can orphan those is worse than one that needs a deployment.
   */
  if (action === 'org') {
    if (request.method === 'GET') {
      return json({
        departments: DEPARTMENTS.map((d) => ({
          key: d.key, th: d.th, en: d.en, parent: d.parent || null,
          units: unitsOf(d.key), added: Boolean(d.added),
        })),
        hidden: (await sql`SELECT key FROM org_departments WHERE hidden ORDER BY key`)
          .map((r) => r.key),
        mayEdit: canManageAccounts(me),
      });
    }

    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
    const body = await request.json().catch(() => ({}));

    // --- a ฝ่าย ----------------------------------------------------------
    if (body.kind === 'department') {
      const th = String(body.th ?? '').trim().slice(0, 80);
      const en = String(body.en ?? '').trim().slice(0, 80);

      if (request.method === 'POST') {
        if (!th && !en) return json({ error: 'NAME_REQUIRED' }, 400);
        const parent = body.parent ? String(body.parent) : null;
        if (parent && !isDepartment(parent)) return json({ error: 'BAD_DEPARTMENT', departments: [parent] }, 400);
        /**
         * Keys of ฝ่าย that are put away count as taken. They are gone from
         * the live chart but still written on everything that ever pointed
         * at them, so handing the same key to a new one would quietly merge
         * the two.
         */
        const alreadyUsed = (await sql`SELECT key FROM org_departments`).map((r) => r.key);
        const key = makeDepartmentKey(en, th, alreadyUsed);
        await sql`
          INSERT INTO org_departments (key, th, en, parent, sort, added_by)
          VALUES (${key}, ${th || en}, ${en || th}, ${parent},
                  ${DEPARTMENTS.length}, ${me.username})`;
        forgetOrg();
        return json({ ok: true, key }, 201);
      }

      if (request.method === 'PATCH') {
        const key = String(body.key ?? '');
        if (!isDepartment(key) && !(await sql`SELECT 1 FROM org_departments WHERE key = ${key}`).length) {
          return json({ error: 'NO_SUCH_DEPARTMENT' }, 404);
        }
        const current = departmentByKey(key);
        const hidden = body.hidden === undefined ? null : Boolean(body.hidden);
        await sql`
          INSERT INTO org_departments (key, th, en, parent, hidden, added_by)
          VALUES (${key}, ${th || current?.th || key}, ${en || current?.en || key},
                  ${body.parent === undefined ? (current?.parent || null) : (body.parent || null)},
                  ${hidden ?? false}, ${me.username})
          ON CONFLICT (key) DO UPDATE SET
            th     = COALESCE(${th || null}, org_departments.th),
            en     = COALESCE(${en || null}, org_departments.en),
            parent = ${body.parent === undefined ? null : (body.parent || null)},
            hidden = COALESCE(${hidden}, org_departments.hidden),
            updated_at = now()`;
        forgetOrg();
        return json({ ok: true, key });
      }
    }

    // --- a หน่วย ---------------------------------------------------------
    if (body.kind === 'unit') {
      const department = String(body.department ?? '');
      if (!isDepartment(department)) return json({ error: 'BAD_DEPARTMENT', departments: [department] }, 400);
      const name = String(body.name ?? '').trim().slice(0, 80);
      if (!name) return json({ error: 'NAME_REQUIRED' }, 400);

      if (request.method === 'POST') {
        if (matchUnit(department, name)) return json({ error: 'UNIT_ALREADY_THERE', unit: name }, 409);
        await sql`
          INSERT INTO org_units (department, name, sort, added_by)
          VALUES (${department}, ${name}, ${unitsOf(department).length}, ${me.username})
          ON CONFLICT (department, name) DO UPDATE SET hidden = false`;
        forgetOrg();
        return json({ ok: true, department, name }, 201);
      }

      if (request.method === 'DELETE') {
        /**
         * Putting a หน่วย away, not deleting it. People already filed under
         * it keep the label — the admin page says so — because clearing it
         * would quietly lose the only record of which section they were in.
         */
        await sql`
          INSERT INTO org_units (department, name, hidden, added_by)
          VALUES (${department}, ${name}, true, ${me.username})
          ON CONFLICT (department, name) DO UPDATE SET hidden = true`;
        forgetOrg();
        const [{ n }] = await sql`SELECT count(*)::int AS n FROM users
                                  WHERE department = ${department} AND unit = ${name}`;
        return json({ ok: true, stillFiledHere: n });
      }
    }

    return json({ error: 'BAD_KIND' }, 400);
  }


  // ---- circles: the committee's groups, and who is in them ---------------
  /**
   * Four of these were born with the app and are questions asked of the
   * roster — "who is at least an editor right now". That is a good first
   * answer and was treated as the only one, which left two things
   * unsayable: the ผู้ช่วยประธาน who sits on the board without the access
   * level to match, and any group the committee invents that the ladder
   * knows nothing about. Both are answerable here now.
   */
  if (action === 'groups') {
    if (request.method === 'GET') {
      const rows = await sql`SELECT username, access, active, suspended FROM users
                             ORDER BY active DESC, display_name`;
      return json({
        circles: CIRCLES.map((c) => ({
          key: c.key, th: c.th, en: c.en, note: c.note, floor: c.floor || null,
          made: Boolean(c.made), selfJoin: c.made ? c.selfJoin !== false : false,
          members: rows.filter((u) => inCircle(u, c.key)).map((u) => u.username),
          // Who was put in or kept out by hand, so the admin page can show
          // which of its members are there by rule and which by decision.
          pinnedIn: rows.filter((u) => pinnedState(c.key, u.username) === 'in').map((u) => u.username),
          pinnedOut: rows.filter((u) => pinnedState(c.key, u.username) === 'out').map((u) => u.username),
        })),
        mayEdit: canManageAccounts(me),
      });
    }

    const body = await request.json().catch(() => ({}));

    // --- a group the committee invented -----------------------------------
    if (body.kind === 'group') {
      if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
      const th = String(body.th ?? '').trim().slice(0, 60);
      const en = String(body.en ?? '').trim().slice(0, 60);
      const note = String(body.note ?? '').trim().slice(0, 200);
      const selfJoin = body.selfJoin === undefined ? true : Boolean(body.selfJoin);

      if (request.method === 'POST') {
        if (!th && !en) return json({ error: 'NAME_REQUIRED' }, 400);
        const taken = (await sql`SELECT key FROM circle_groups`).map((r) => r.key);
        const key = makeCircleKey(en, th, taken);
        await sql`
          INSERT INTO circle_groups (key, th, en, note, self_join, sort, added_by)
          VALUES (${key}, ${th || en}, ${en || th}, ${note}, ${selfJoin},
                  ${CIRCLES.length}, ${me.username})`;
        forgetOrg();
        return json({ ok: true, key }, 201);
      }

      if (request.method === 'PATCH') {
        const key = String(body.key ?? '');
        /**
         * Only groups made here can be changed. The four built-in circles
         * are described in lib/circles.js and referred to by name all over
         * the app; renaming คณะทำงานหลัก from a form would leave the code
         * and the committee talking about different things.
         */
        if (!isMadeGroup(key)) return json({ error: 'NOT_A_MADE_GROUP' }, 400);
        const hidden = body.hidden === undefined ? null : Boolean(body.hidden);
        await sql`
          UPDATE circle_groups SET
            th        = COALESCE(${th || null}, th),
            en        = COALESCE(${en || null}, en),
            note      = COALESCE(${body.note === undefined ? null : note}, note),
            self_join = COALESCE(${body.selfJoin === undefined ? null : selfJoin}, self_join),
            hidden    = COALESCE(${hidden}, hidden)
          WHERE key = ${key}`;
        forgetOrg();
        return json({ ok: true, key });
      }
    }

    // --- who is in one ----------------------------------------------------
    if (body.kind === 'member') {
      const circle = String(body.circle ?? '');
      if (!isCircle(circle)) return json({ error: 'NO_SUCH_CIRCLE' }, 404);

      const asked = String(body.username ?? '').trim();
      const self = !asked || asked === me.username;
      const username = self ? me.username : asked;

      /**
       * Somebody may walk into a group that is open, and out of one they
       * walked into. Everything else — another person, a closed group, or
       * any of the four built-in circles — is an admin's to decide, because
       * คณะกรรมการบริหาร is not a thing one joins by saying so.
       */
      if (!canManageAccounts(me)) {
        if (!self) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
        const group = circleByKey(circle);
        if (!group?.made || group.selfJoin === false) return json({ error: 'GROUP_NOT_OPEN' }, 403);
      }

      if (request.method === 'POST') {
        const [target] = await sql`SELECT username FROM users WHERE username = ${username}`;
        if (!target) return json({ error: 'NO_SUCH_USER' }, 404);
        const state = body.state === 'out' ? 'out' : 'in';
        if (state === 'out' && isMadeGroup(circle)) {
          // Nothing derives membership of a made group, so "kept out" of one
          // would be a row that says exactly what no row already says.
          return json({ error: 'NOTHING_TO_KEEP_OUT_OF' }, 400);
        }
        await sql`
          INSERT INTO circle_people (circle, username, state, by_self, set_by)
          VALUES (${circle}, ${username}, ${state}, ${self && !canManageAccounts(me)}, ${me.username})
          ON CONFLICT (circle, username) DO UPDATE SET
            state = EXCLUDED.state, set_by = EXCLUDED.set_by, set_at = now()`;
        forgetOrg();
        return json({ ok: true, circle, username, state });
      }

      if (request.method === 'DELETE') {
        /**
         * Taking the decision away, not replacing it with the opposite one.
         * For a derived circle that hands the person back to the ladder; for
         * a made group it takes them out of it.
         */
        await sql`DELETE FROM circle_people WHERE circle = ${circle} AND username = ${username}`;
        forgetOrg();
        return json({ ok: true, circle, username });
      }
    }

    return json({ error: 'BAD_KIND' }, 400);
  }

  // ---- my own labels -----------------------------------------------------
  /**
   * Tags somebody keeps for their own work, seen by nobody else.
   *
   * Not a second department system and deliberately not shareable: a ฝ่าย
   * says who you answer to, "รอของ" says something only to the person who
   * wrote it. Shared labels would need agreeing on, which is the thing
   * people reach for a private label to avoid.
   */
  if (action === 'tags') {
    if (request.method === 'GET') {
      const tags = await sql`SELECT name, colour FROM user_tags
                             WHERE username = ${me.username} ORDER BY sort, name`;
      return json({ tags });
    }

    const body = await request.json().catch(() => ({}));

    if (request.method === 'POST') {
      const name = String(body.name ?? '').trim().slice(0, 40);
      if (!name) return json({ error: 'NAME_REQUIRED' }, 400);
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM user_tags WHERE username = ${me.username}`;
      // A cap, because a filter row of forty labels is not a filter row.
      if (n >= MAX_TAGS) return json({ error: 'TOO_MANY_TAGS', limit: MAX_TAGS }, 400);
      const colour = String(body.colour ?? '').trim().slice(0, 16);
      await sql`
        INSERT INTO user_tags (username, name, colour, sort)
        VALUES (${me.username}, ${name}, ${colour}, ${n})
        ON CONFLICT (username, name) DO UPDATE SET colour = EXCLUDED.colour`;
      const tags = await sql`SELECT name, colour FROM user_tags
                             WHERE username = ${me.username} ORDER BY sort, name`;
      return json({ ok: true, tags }, 201);
    }

    if (request.method === 'DELETE') {
      const name = url.searchParams.get('name') || '';
      // The rows on tasks go with it, by the foreign key — a label nobody
      // can see is not worth keeping on anybody's work.
      await sql`DELETE FROM user_tags WHERE username = ${me.username} AND name = ${name}`;
      const tags = await sql`SELECT name, colour FROM user_tags
                             WHERE username = ${me.username} ORDER BY sort, name`;
      return json({ ok: true, tags });
    }
  }


  // ---- disconnecting the Drive archive ----------------------------------
  /**
   * The files already in Drive stay there; this forgets the token and tells
   * Google to drop the grant, so the app stops appearing in that account's
   * list of connected apps.
   */
  if (request.method === 'POST' && action === 'drive-unlink') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
    await unlinkDrive(sql);
    forgetOrg();
    return json({ ok: true });
  }

  // ---- correcting a username --------------------------------------------
  /**
   * A username is the key about sixty columns hang off — every assignment,
   * signature, invitation and notification — so the only way to fix a typo
   * used to be to delete the account and make another, which throws all of
   * that away. "Mochi_HeadOrganizer" for somebody called Moji is not worth
   * losing a term of work over.
   *
   * The move itself is in lib/rename.js. What belongs here is who may ask
   * for it, what counts as a valid new name, and the one thing the server
   * cannot fix by itself: the roster sheet.
   */
  if (request.method === 'POST' && action === 'rename') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_MANAGE_ACCOUNTS' }, 403);
    const body = await request.json().catch(() => ({}));

    const from = String(body.username ?? '').trim();
    const to = String(body.newUsername ?? '').trim();
    const [target] = await sql`SELECT * FROM users WHERE username = ${from}`;

    const blocked = cannotActOn(me, target);
    if (blocked) return json({ error: blocked }, blocked === 'NO_SUCH_USER' ? 404 : 403);
    if (!USERNAME_SHAPE.test(to)) return json({ error: 'BAD_USERNAME' }, 400);
    if (to === from) return json({ error: 'NOTHING_TO_DO' }, 400);

    /**
     * Case-insensitively unique, except against themselves — correcting
     * `jade_pres` to `Jade_Pres` is a rename like any other and must not be
     * refused for clashing with the row it is renaming.
     */
    const [clash] = await sql`
      SELECT username FROM users
      WHERE lower(username) = ${to.toLowerCase()} AND username <> ${from}`;
    if (clash) return json({ error: 'USERNAME_TAKEN', username: clash.username }, 409);

    const result = await renameUser(sql, from, to);

    const rows = await sql`SELECT * FROM users ORDER BY active DESC, display_name`;
    const grants = await departmentsByUser(sql);
    return json({
      ok: true,
      from,
      to,
      // Which tables moved and how far, because a rename that silently
      // touched nothing looks exactly like one that worked.
      moved: result.moved,
      columnsChecked: result.columnsChecked,
      // Renaming yourself leaves the page holding the old name.
      itWasMe: from === me.username,
      users: rows.map((u) => directoryRow(u, grants, me)),
    });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
