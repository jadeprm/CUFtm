import { getSql, json, noDatabase, hasDatabase, requestUrl, forgetOrg } from '../lib/db.js';
import {
  currentUser, canManageAccounts, cannotActOn, ACCESS, newToken,
  departmentsByUser, departmentsOf, setDepartments, normaliseAccess, ACCESS_ORDER,
} from '../lib/auth.js';
import { fetchPeople, syncPeople, SHEET_ID } from '../lib/sheet.js';
import { writeAccess, sheetWriteConfigured } from '../lib/sheets.js';
import {
  isDepartment, expandAccess, departmentByKey, matchUnit, DEPARTMENT_KEYS,
  DEPARTMENTS, unitsOf, makeDepartmentKey,
} from '../lib/departments.js';
import { driveStatus } from '../lib/drive.js';
import {
  availabilityOf, setAvailability, addBlock, removeBlock, checkClashes,
} from '../lib/availstore.js';
import { withNode } from '../lib/http.js';
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
  // The name that goes on a letter, as opposed to the one on a task board.
  fullName: u.full_name || null,
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
  if (request.method === 'GET' && action !== 'org') {
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
        sheetPlan.unit,
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
      users: rows.map((u) => directoryRow(u, grants)),
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
    return json({ ok: true, username, users: rows.map((u) => directoryRow(u, grants)) }, 201);
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

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
