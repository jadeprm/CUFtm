import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser, canEditTasks, cannotAssign } from '../lib/auth.js';
import { applyPrecedence, clearPrecedence, precedenceOver } from '../lib/availstore.js';
import { isDepartment, matchUnit } from '../lib/departments.js';
import {
  isStatus, isPriority, seesEverything, canSeeTask, canPostTo, accessSet,
  canEditTask, canSetStatus, canDeleteTask,
  canManageParts, canCompletePart, canAttach, canRemoveLink,
  linkKind, safeUrl,
} from '../lib/scope.js';
import { sendToMany } from '../lib/push.js';
import { sortRecipients } from '../lib/notifyprefs.js';
import { withNode } from '../lib/http.js';
import { handleSpaces, spaceIdsFor } from '../lib/spaces.js';

/**
 * Tasks.
 *
 *   GET    /api/tasks            every task, with the people and departments on it
 *   POST   /api/tasks            create
 *   PATCH  /api/tasks            update (send id plus only what changed)
 *   DELETE /api/tasks?id=...     remove
 *
 * Every signed-in person may edit any task, including ones they did not
 * create — that is the brief. Account management is the only thing gated by
 * access level.
 */

const SCOPES = ['all', 'heads', 'members'];
const NOTIFY_KINDS = ['created', '7d', '3d', '24h', 'due'];
const STATUS_TH = { todo: 'ยังไม่เริ่ม', doing: 'กำลังทำ', review: 'รอตรวจ', feedback: 'ตรวจแล้ว', done: 'เสร็จแล้ว' };

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
const cleanTime = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? '')) ? String(v) : null);

/** See lib/db.js — crossing a timezone here would shift every due date by a day. */
function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Every task, with everything hanging off it, in ONE round trip.
 *
 * This used to be five separate queries — tasks, people, department tags,
 * sub-tasks, attachments — stitched together in JavaScript. Against a
 * serverless database that is five HTTPS calls every time anybody saves
 * anything. Postgres can assemble the same shape itself, and does it faster
 * than the network can carry five questions.
 */
export async function assembled(sql) {
  const rows = await sql`
    SELECT
      t.*,
      COALESCE((SELECT json_agg(p.username ORDER BY p.username)
                FROM task_people p WHERE p.task_id = t.id), '[]') AS people,
      COALESCE((SELECT json_agg(json_build_object(
                  'username', p.username, 'reply', p.reply, 'repliedAt', p.replied_at)
                  ORDER BY p.username)
                FROM task_people p WHERE p.task_id = t.id), '[]') AS replies,
      COALESCE((SELECT json_agg(json_build_object('key', d.department, 'scope', d.scope))
                FROM task_departments d WHERE d.task_id = t.id), '[]') AS depts,
      COALESCE((SELECT json_agg(json_build_object(
                  'id', x.id, 'title', x.title, 'assignee', x.assignee,
                  'done', x.done, 'doneAt', x.done_at, 'doneBy', x.done_by)
                  ORDER BY x.position, x.created_at)
                FROM task_parts x WHERE x.task_id = t.id), '[]') AS parts,
      COALESCE((SELECT json_agg(json_build_object(
                  'id', l.id, 'partId', l.part_id, 'url', l.url, 'label', l.label,
                  'kind', l.kind, 'addedBy', l.added_by, 'createdAt', l.created_at)
                  ORDER BY l.created_at)
                FROM task_links l WHERE l.task_id = t.id), '[]') AS links,
      COALESCE((SELECT json_agg(v.username ORDER BY v.username)
                FROM task_viewers v WHERE v.task_id = t.id), '[]') AS watchers,
      COALESCE((SELECT json_object_agg(p.username, p.via)
                FROM task_people p WHERE p.task_id = t.id), '{}') AS roles
    FROM tasks t
    ORDER BY
      CASE t.status WHEN 'doing' THEN 0 WHEN 'review' THEN 1 WHEN 'feedback' THEN 2
                    WHEN 'todo' THEN 3 ELSE 4 END,
      CASE t.priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      t.due_date NULLS LAST, t.due_time NULLS LAST, t.created_at`;

  // json_agg returns parsed JSON through the driver, but a string through some
  // configurations — accept either rather than trusting one.
  const asArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { return []; } }
    return [];
  };
  const asObject = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
    return {};
  };

  /**
   * What has been declared more important than each of these.
   *
   * One small query rather than a join every page load pays for: the table
   * only ever holds contested bookings, so it is empty for most committees and
   * tiny for the rest. Asked without an id list for the same reason — the whole
   * table is smaller than the list of ids would be.
   */
  const beaten = await precedenceOver(sql, 'task');

  return rows.map((t) => ({
    id: t.id,
    // What somebody decided takes precedence over this, so the person who is
    // on both can see which one to turn up to.
    outrankedBy: beaten[t.id] || [],
    // The short code people quote to each other: T0042.
    code: t.code || null,
    title: t.title,
    description: t.description,
    dueDate: toIsoDate(t.due_date),
    dueTime: t.due_time || null,
    // Where the Gantt bar begins, when somebody set one.
    startDate: toIsoDate(t.start_date),
    doneAt: t.done_at || null,
    spaceId: t.space_id || null,
    status: t.status,
    priority: t.priority || 'medium',
    department: t.department || null,
    unit: t.unit || null,
    createdBy: t.created_by,
    notify: String(t.notify || '').split(',').filter(Boolean),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    assignees: asArray(t.people),
    // Named is not the same as agreed. The card shows both.
    replies: asArray(t.replies),
    departments: asArray(t.depts),
    parts: asArray(t.parts),
    links: asArray(t.links),
    // Following it, not doing it — see task_viewers in lib/db.js.
    viewers: asArray(t.watchers),
    /**
     * How each person on it got there: 'named', 'dept' or 'part'. `named` is
     * the list the form edits — the department tags and the pieces put the
     * others on, and saving the form must not turn them into names.
     */
    roles: asObject(t.roles),
    named: asArray(t.people).filter((u) => (asObject(t.roles)[u] || 'named') === 'named'),
  }));
}


/**
 * The space a task is being filed into, checked: it must exist, not be
 * archived, and be one this person is in (admins may file anywhere).
 * Returns { id } — null meaning "no space" — or { error }.
 */
async function readSpace(sql, me, value) {
  if (value === null || value === '' || value === undefined) return { id: null };
  const id = clean(value, 64);
  const [row] = await sql`SELECT id FROM spaces WHERE id = ${id} AND archived = false`;
  if (!row) return { error: 'NO_SUCH_SPACE' };
  if (!seesEverything(me) && !(me.spaceIds || []).includes(id)) return { error: 'NOT_IN_SPACE' };
  return { id };
}

/** Stamps each task with what this person is allowed to do to it. */
const withRights = (me, tasks) =>
  tasks.map((task) => ({
    ...task,
    mayEdit: canEditTask(me, task),
    maySetStatus: canSetStatus(me, task),
    mayAttach: canAttach(me, task),
    // The piece of this task that is this person's own, if any — what the
    // card shows them instead of making them open it to find out.
    myPart: (task.parts || []).find((p) => p.assignee === me?.username) || null,
    // Here because somebody asked them to keep an eye on it, not to do it.
    watching: Boolean(me) && (task.viewers || []).includes(me.username) &&
      !(task.assignees || []).includes(me.username),
    // What this task is to this person — the label on their card.
    myRole: !me ? null
      : (task.assignees || []).includes(me.username) ? ((task.roles || {})[me.username] || 'named')
        : (task.viewers || []).includes(me.username) ? 'watch' : null,
  }));

/**
 * Turns department tags into the actual list of people to notify.
 * `heads` means everyone flagged as a head of that department; `members`
 * everyone else in it; `all` both.
 */
async function expandPeople(sql, assignees, departments) {
  const set = new Set(assignees);

  /**
   * Membership comes from the grants table, so someone who works across two
   * departments is reached by a tag on either of them. People whose access is
   * "all departments" are deliberately not swept in: tagging Content should
   * not notify the project director.
   *
   * All the tags are resolved in one query rather than one per tag — three
   * department tags used to mean three round trips before anything was saved.
   */
  if (departments.length) {
    const keys = departments.map((d) => d.key);
    const rows = await sql`
      SELECT DISTINCT u.username, u.is_head, d.department
      FROM users u JOIN user_departments d ON d.username = u.username
      WHERE d.department = ANY(${keys}) AND u.active = true`;

    for (const { key, scope } of departments) {
      for (const row of rows) {
        if (row.department !== key) continue;
        if (scope === 'heads' && !row.is_head) continue;
        if (scope === 'members' && row.is_head) continue;
        set.add(row.username);
      }
    }
  }
  return [...set];
}

async function writeTags(sql, taskId, assignees, departments) {
  const expanded = await expandPeople(sql, assignees, departments);
  // People holding a piece of the task stay on it whatever the form sends —
  // they came through the piece, which the form does not list.
  const holders = (await sql`
    SELECT DISTINCT assignee FROM task_parts WHERE task_id = ${taskId} AND assignee IS NOT NULL`)
    .map((r) => r.assignee).filter((u) => !expanded.includes(u));
  const everyone = expanded.concat(holders);
  const viaOf = (u) => (assignees.includes(u) ? 'named' : holders.includes(u) ? 'part' : 'dept');

  /**
   * Whoever is still on the task keeps whatever they answered.
   *
   * These tags are rewritten in full on every save, so removing the rows and
   * re-adding them would wipe every accept and decline each time somebody
   * edited the due date. Only people genuinely taken off the task lose theirs.
   */
  await sql`DELETE FROM task_people WHERE task_id = ${taskId} AND username <> ALL(${everyone})`;
  await sql`DELETE FROM task_departments WHERE task_id = ${taskId}`;

  /**
   * One statement per table, however many people are on the task.
   *
   * UNNEST turns two arrays into rows, so twenty assignees cost one round trip
   * instead of twenty. With a serverless database every statement is its own
   * HTTPS call, and that is most of what "saving is slow" actually was.
   */
  if (everyone.length) {
    await sql`
      INSERT INTO task_people (task_id, username, via)
      SELECT ${taskId}, u, v FROM unnest(${everyone}::text[], ${everyone.map(viaOf)}::text[]) AS t(u, v)
      ON CONFLICT (task_id, username) DO UPDATE SET via = EXCLUDED.via`;
  }
  if (departments.length) {
    await sql`
      INSERT INTO task_departments (task_id, department, scope)
      SELECT ${taskId}, d, s
      FROM unnest(${departments.map((d) => d.key)}::text[],
                  ${departments.map((d) => d.scope)}::text[]) AS t(d, s)
      ON CONFLICT DO NOTHING`;
  }
  return expanded;
}

function readTags(body) {
  const assignees = Array.isArray(body.assignees)
    ? body.assignees.map((a) => clean(a, 64)).filter(Boolean)
    : [];
  const departments = Array.isArray(body.departments)
    ? body.departments
        .map((d) => ({ key: clean(d.key, 32), scope: SCOPES.includes(d.scope) ? d.scope : 'all' }))
        .filter((d) => isDepartment(d.key))
    : [];
  return { assignees, departments };
}

/**
 * Who should follow a task without working on it.
 *
 * Anybody active — the same open rule as assigning — except the people who
 * are already on it: they see it anyway, and being both would put them in two
 * lists that mean different things. Doing the work wins.
 */
function readViewers(body) {
  if (!Array.isArray(body.viewers)) return null;
  return [...new Set(body.viewers.map((v) => clean(v, 64)).filter(Boolean))].slice(0, 300);
}

async function writeViewers(sql, taskId, wanted, actor) {
  const onIt = (await sql`SELECT username FROM task_people WHERE task_id = ${taskId}`).map((r) => r.username);
  const asked = wanted.filter((u) => !onIt.includes(u));
  const real = asked.length
    ? (await sql`SELECT username FROM users WHERE active = true AND username = ANY(${asked})`).map((r) => r.username)
    : [];
  const before = (await sql`SELECT username FROM task_viewers WHERE task_id = ${taskId}`).map((r) => r.username);
  await sql`DELETE FROM task_viewers WHERE task_id = ${taskId} AND username <> ALL(${real})`;
  if (real.length) {
    await sql`
      INSERT INTO task_viewers (task_id, username, added_by)
      SELECT ${taskId}, u, ${actor} FROM unnest(${real}::text[]) AS u
      ON CONFLICT DO NOTHING`;
  }
  return real.filter((u) => !before.includes(u));
}

/** Somebody put on the task stops being a mere viewer of it. */
const promoteViewers = (sql, taskId) => sql`
  DELETE FROM task_viewers v USING task_people p
  WHERE v.task_id = ${taskId} AND p.task_id = v.task_id AND p.username = v.username`;

/** Which setting on the notifications page governs each kind of message. */
const CATEGORY_OF = {
  created: 'task_named', part: 'task_named', work: 'task_work', watch: 'task_watch', progress: 'task_watch',
};

async function notifyAssigned(sql, task, usernames, actor, kind, title, body, category) {
  const asked = usernames.filter((u) => u !== actor); // nobody needs telling what they just did
  if (!asked.length) return;

  // Their settings decide: out loud, the bell only, or not at all.
  const { loud, quiet } = await sortRecipients(sql, asked, {
    category: category || CATEGORY_OF[kind] || 'task_named', scope: 'task', id: task.id,
  });
  const targets = loud.concat(quiet);
  if (!targets.length) return;

  const idFor = {};
  for (const username of targets) {
    idFor[username] = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  // One insert for the whole list, for the same reason as the tags above.
  await sql`
    INSERT INTO notifications (id, username, task_id, kind, title, body)
    SELECT i, u, ${task.id}, ${kind}, ${title}, ${body}
    FROM unnest(${targets.map((u) => idFor[u])}::text[], ${targets}::text[]) AS t(i, u)`;

  /**
   * The bell row is written first and the push is attempted after, so a push
   * service being slow or unreachable costs a lock-screen alert and nothing
   * more — the notification is still waiting in the app either way.
   */
  {
    try {
      if (loud.length) await sendToMany(sql, loud, (username) => ({
        id: idFor[username],
        taskId: task.id,
        title,
        body,
        level: 'normal',
        tag: `task-${task.id}`,
      }));
    } catch (error) {
      console.error('[tasks] push failed', error);
    }
  }
}

/** The task a part or link belongs to, already assembled and scope-checked. */
async function ownerTask(sql, me, taskId) {
  const task = (await assembled(sql)).find((t) => t.id === taskId);
  if (!task) return { error: json({ error: 'NO_SUCH_TASK' }, 404) };
  if (!canSeeTask(me, task)) return { error: json({ error: 'NOT_YOUR_DEPARTMENT' }, 403) };
  return { task };
}

const reply = async (sql, me, id) => {
  const all = await assembled(sql);
  return json({
    task: withRights(me, all.filter((t) => t.id === id))[0],
    tasks: withRights(me, all.filter((x) => canSeeTask(me, x))),
  });
};

/**
 * Sub-tasks: the pieces of a task, each with a name on it.
 *
 *   POST   ?do=part   { taskId, title, assignee }
 *   PATCH  ?do=part   { id, title?, assignee?, done? }
 *   DELETE ?do=part&id=…
 */
async function handlePart(sql, me, request, url) {
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { task, error } = await ownerTask(sql, me, clean(body.taskId, 64));
    if (error) return error;
    if (!canManageParts(me, task)) return json({ error: 'NOT_TASK_OWNER' }, 403);

    const title = clean(body.title, 200);
    if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

    const assignee = body.assignee ? clean(body.assignee, 64) : null;
    if (assignee) {
      const [who] = await sql`SELECT 1 FROM users WHERE username = ${assignee} AND active = true`;
      if (!who) return json({ error: 'NO_SUCH_USER' }, 400);
    }

    const [{ next }] = await sql`
      SELECT COALESCE(max(position) + 1, 0) AS next FROM task_parts WHERE task_id = ${task.id}`;
    const id = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    await sql`
      INSERT INTO task_parts (id, task_id, title, assignee, position, created_by)
      VALUES (${id}, ${task.id}, ${title}, ${assignee}, ${next}, ${me.username})`;

    /**
     * Being handed a piece of work is worth knowing about. The person is also
     * added to the task itself, so it turns up under "my tasks" rather than
     * only inside a task they were never tagged in.
     */
    if (assignee && assignee !== me.username) {
      await sql`INSERT INTO task_people (task_id, username, via) VALUES (${task.id}, ${assignee}, 'part')
                ON CONFLICT DO NOTHING`;
      await promoteViewers(sql, task.id);
      await notifyAssigned(sql, { id: task.id }, [assignee], me.username, 'part',
        task.title, `${me.display_name || me.username}: ${title}`);
    }
    return reply(sql, me, task.id);
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const partId = clean(body.id, 64);
    const [row] = await sql`SELECT * FROM task_parts WHERE id = ${partId}`;
    if (!row) return json({ error: 'NO_SUCH_PART' }, 404);

    const { task, error } = await ownerTask(sql, me, row.task_id);
    if (error) return error;

    const part = { assignee: row.assignee };
    const renaming = body.title !== undefined || body.assignee !== undefined;

    // Ticking your own piece is a different right from rewriting it.
    if (renaming && !canManageParts(me, task)) return json({ error: 'NOT_TASK_OWNER' }, 403);
    if (body.done !== undefined && !canCompletePart(me, task, part)) {
      return json({ error: 'NOT_YOUR_PART' }, 403);
    }

    if (body.title !== undefined) {
      const title = clean(body.title, 200);
      if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);
      await sql`UPDATE task_parts SET title = ${title} WHERE id = ${partId}`;
    }

    if (body.assignee !== undefined) {
      const assignee = body.assignee ? clean(body.assignee, 64) : null;
      if (assignee) {
        const [who] = await sql`SELECT 1 FROM users WHERE username = ${assignee} AND active = true`;
        if (!who) return json({ error: 'NO_SUCH_USER' }, 400);
        await sql`INSERT INTO task_people (task_id, username, via) VALUES (${row.task_id}, ${assignee}, 'part')
                  ON CONFLICT DO NOTHING`;
        await promoteViewers(sql, row.task_id);
        if (assignee !== me.username && assignee !== row.assignee) {
          await notifyAssigned(sql, { id: row.task_id }, [assignee], me.username, 'part',
            task.title, `${me.display_name || me.username}: ${row.title}`);
        }
      }
      await sql`UPDATE task_parts SET assignee = ${assignee} WHERE id = ${partId}`;
    }

    if (body.done !== undefined) {
      const done = Boolean(body.done);
      await sql`
        UPDATE task_parts SET done = ${done},
                              done_at = ${done ? 'now()' : null}::timestamptz,
                              done_by = ${done ? me.username : null}
        WHERE id = ${partId}`;
    }

    return reply(sql, me, row.task_id);
  }

  if (request.method === 'DELETE') {
    const partId = clean(url.searchParams.get('id'), 64);
    const [row] = await sql`SELECT * FROM task_parts WHERE id = ${partId}`;
    if (!row) return json({ error: 'NO_SUCH_PART' }, 404);

    const { task, error } = await ownerTask(sql, me, row.task_id);
    if (error) return error;
    if (!canManageParts(me, task)) return json({ error: 'NOT_TASK_OWNER' }, 403);

    // Anything handed in against this piece loses its anchor, not its record:
    // it stays on the task rather than disappearing with the piece.
    await sql`UPDATE task_links SET part_id = NULL WHERE part_id = ${partId}`;
    await sql`DELETE FROM task_parts WHERE id = ${partId}`;
    return reply(sql, me, row.task_id);
  }

  return json({ error: 'METHOD' }, 405);
}

/**
 * Attachments: finished work, handed in as a link.
 *
 *   POST   ?do=link   { taskId, url, label?, partId? }
 *   DELETE ?do=link&id=…
 */
async function handleLink(sql, me, request, url) {
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { task, error } = await ownerTask(sql, me, clean(body.taskId, 64));
    if (error) return error;
    if (!canAttach(me, task)) return json({ error: 'NOT_ON_THIS_TASK' }, 403);

    const href = safeUrl(body.url);
    if (!href) return json({ error: 'BAD_LINK' }, 400);

    const partId = body.partId ? clean(body.partId, 64) : null;
    if (partId && !(task.parts || []).some((p) => p.id === partId)) {
      return json({ error: 'NO_SUCH_PART' }, 400);
    }

    const id = `l_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO task_links (id, task_id, part_id, url, label, kind, added_by)
      VALUES (${id}, ${task.id}, ${partId}, ${href}, ${clean(body.label, 120)},
              ${linkKind(href)}, ${me.username})`;

    // The person who set the task is the one waiting on the work, so they are
    // told it has arrived — everyone else on the task is not, or a five-person
    // task would notify four people about each other's uploads.
    if (task.createdBy !== me.username) {
      await notifyAssigned(sql, { id: task.id }, [task.createdBy], me.username, 'work',
        task.title, `${me.display_name || me.username} \u2192 ${clean(body.label, 120) || href}`);
    }
    return reply(sql, me, task.id);
  }

  if (request.method === 'DELETE') {
    const linkId = clean(url.searchParams.get('id'), 64);
    const [row] = await sql`SELECT * FROM task_links WHERE id = ${linkId}`;
    if (!row) return json({ error: 'NO_SUCH_LINK' }, 404);

    const { task, error } = await ownerTask(sql, me, row.task_id);
    if (error) return error;
    if (!canRemoveLink(me, task, { addedBy: row.added_by })) {
      return json({ error: 'NOT_YOUR_LINK' }, 403);
    }

    await sql`DELETE FROM task_links WHERE id = ${linkId}`;
    return reply(sql, me, row.task_id);
  }

  return json({ error: 'METHOD' }, 405);
}

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);
  const action = url.searchParams.get('do');

  try {
    // Which spaces this person is in, for canSeeTask. One small query.
    me.spaceIds = await spaceIdsFor(sql, me);
    if (action && action.startsWith('space')) return await handleSpaces(sql, me, request, url, json);

    // Sub-tasks and attachments hang off a task, so they live on this
    // endpoint rather than adding two more serverless functions.
    if (action === 'part') return await handlePart(sql, me, request, url);
    if (action === 'link') return await handleLink(sql, me, request, url);

    if (request.method === 'GET') {
      const all = await assembled(sql);
      // Filtering here rather than in SQL keeps one definition of the rule,
      // in lib/scope.js, shared with the client's own display logic.
      return json({
        tasks: withRights(me, all.filter((task) => canSeeTask(me, task))),
        seesEverything: seesEverything(me),
        myDepartments: [...accessSet(me)],
      });
    }

    if (request.method === 'POST') {
      /**
       * A member does not hand work out.
       *
       * That is the whole distinction between the two new levels: a unit
       * editor runs a section and gives work to the people in it, a member
       * does the work they are given. Refusing here rather than only hiding
       * the button is what makes it a rule instead of a suggestion.
       */
      if (!canEditTasks(me)) return json({ error: 'MEMBERS_CANNOT_CREATE' }, 403);

      const body = await request.json().catch(() => ({}));
      const title = clean(body.title, 200);
      if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

      const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const notify = (Array.isArray(body.notify) ? body.notify : NOTIFY_KINDS)
        .filter((k) => NOTIFY_KINDS.includes(k))
        .join(',');

      /**
       * A task's teamspace defaults to the creator's home department, so
       * nothing ever lands in a place nobody can see. Filing into a
       * department you have no access to is refused rather than quietly
       * redirected — a task that silently moved would be worse than an error.
       */
      const department = isDepartment(body.department) ? body.department : (me.department || null);
      if (department && !canPostTo(me, department)) {
        return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);
      }

      /**
       * The section inside that teamspace. Only a name the org chart lists for
       * this very department is kept — a section belonging to another
       * department, or one that does not exist, is dropped rather than stored,
       * so a task can never claim to live somewhere it does not.
       */
      const unit = department ? matchUnit(department, body.unit) : null;
      const space = await readSpace(sql, me, body.spaceId);
      if (space.error) return json({ error: space.error }, 403);
      const startStatus = isStatus(body.status) ? body.status : 'todo';
      // A start after the deadline is a typo; keep the deadline, drop the start.
      let startDate = cleanDate(body.startDate);
      if (startDate && cleanDate(body.dueDate) && startDate > cleanDate(body.dueDate)) startDate = null;

      await sql`
        INSERT INTO tasks (id, code, title, description, due_date, due_time, status, priority,
                           department, unit, created_by, notify, start_date, space_id, done_at)
        VALUES (${id}, 'T' || lpad(nextval('task_code_seq')::text, 4, '0'),
                ${title}, ${clean(body.description, 4000)},
                ${cleanDate(body.dueDate)}, ${cleanTime(body.dueTime)},
                ${startStatus},
                ${isPriority(body.priority) ? body.priority : 'medium'},
                ${department}, ${unit}, ${me.username}, ${notify},
                ${startDate}, ${space.id}, ${startStatus === 'done' ? new Date() : null})`;

      const { assignees, departments } = readTags(body);

      /**
       * Checked against the people the tags actually reach, not against the
       * names typed in the request. Tagging a whole department is a way of
       * assigning everybody in it, so a unit editor who tags ฝ่ายเนื้อหา is
       * refused for the same reason as one who names those people directly.
       */
      const willGetIt = await expandPeople(sql, assignees, departments);
      // access and the display name ride along: the same roster answers the
      // assign check and, below, whose booking this person may outrank.
      const fullRoster = await sql`
        SELECT username, unit, access, display_name FROM users WHERE active = true`;
      const roster = fullRoster.map((p) => ({ ...p, displayName: p.display_name }));
      const blocked = cannotAssign(me, willGetIt, roster);
      if (blocked) {
        await sql`DELETE FROM tasks WHERE id = ${id}`;
        return json({ error: blocked, unit: me.unit || null }, 403);
      }

      const expanded = await writeTags(sql, id, assignees, departments);

      /**
       * "I know it clashes, and mine is the one that counts."
       *
       * Only recorded when the person actually asked for it, and whose booking
       * they may outrank is worked out again on this side — the page's own
       * answer is for drawing the warning, never for deciding it.
       */
      if (body.prioritise) {
        await applyPrecedence(sql, me, {
          kind: 'task', itemId: id, roster,
          when: { on: cleanDate(body.dueDate), at: cleanTime(body.dueTime) },
          people: expanded,
        });
      }

      if (notify.includes('created')) {
        const named = expanded.filter((u) => assignees.includes(u));
        await notifyAssigned(sql, { id }, named, me.username, 'created',
          title, `${me.display_name || me.username} added you to this task.`, 'task_named');
        await notifyAssigned(sql, { id }, expanded.filter((u) => !named.includes(u)), me.username, 'created',
          title, `${me.display_name || me.username} tagged your department on this task.`, 'task_dept');
      }

      const viewers = readViewers(body);
      if (viewers && viewers.length) {
        const watching = await writeViewers(sql, id, viewers, me.username);
        await notifyAssigned(sql, { id }, watching, me.username, 'watch',
          title, `${me.display_name || me.username} ให้คุณติดตามความคืบหน้างานนี้ (ดูได้อย่างเดียว)`);
      }

      const all = await assembled(sql);
      return json({
        task: withRights(me, all.filter((t) => t.id === id))[0],
        tasks: withRights(me, all.filter((x) => canSeeTask(me, x))),
      }, 201);
    }

    if (request.method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const id = clean(body.id, 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);

      const [existing] = await sql`SELECT * FROM tasks WHERE id = ${id}`;
      if (!existing) return json({ error: 'NO_SUCH_TASK' }, 404);

      const visible = (await assembled(sql)).find((x) => x.id === id);
      if (!canSeeTask(me, visible)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);

      /**
       * Two levels of permission, checked here rather than only in the
       * interface — a hidden button is a suggestion, this is the rule.
       *
       * The creator and the admins may change anything. Anyone else who is
       * tagged in the task may change the status and nothing else, so a
       * member can report their own progress without being able to rewrite
       * the deadline or remove people from it.
       */
      const mayEdit = canEditTask(me, visible);
      if (!mayEdit) {
        const touched = Object.keys(body).filter((k) => k !== 'id' && body[k] !== undefined);
        const statusOnly = touched.length > 0 && touched.every((k) => k === 'status');

        if (!statusOnly) return json({ error: 'NOT_TASK_OWNER' }, 403);
        if (!canSetStatus(me, visible)) return json({ error: 'NOT_TASK_OWNER' }, 403);
      }

      if (body.department !== undefined && body.department !== null &&
          !canPostTo(me, body.department)) {
        return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);
      }

      /**
       * The section has to be re-checked whenever either half changes.
       *
       * Moving a task from อำนวยการ 2 to เนื้อหา would otherwise leave it
       * filed under สถานที่, a section เนื้อหา does not have — so a move that
       * invalidates the section clears it rather than carrying a lie forward.
       * `undefined` means leave it alone, which is why the check below is
       * against `undefined` and not against falsiness.
       */
      const nextDepartment = body.department === undefined
        ? existing.department
        : (isDepartment(body.department) ? body.department : null);
      let nextUnit;
      if (body.unit !== undefined) {
        nextUnit = nextDepartment ? matchUnit(nextDepartment, body.unit) : null;
      } else if (body.department !== undefined) {
        nextUnit = nextDepartment ? matchUnit(nextDepartment, existing.unit) : null;
      }

      let nextSpace;
      if (body.spaceId !== undefined) {
        const space = await readSpace(sql, me, body.spaceId);
        if (space.error) return json({ error: space.error }, 403);
        nextSpace = space.id;
      }
      const nextStatus = isStatus(body.status) ? body.status : null;
      // done_at follows the status: stamped on arrival at done, cleared on leaving it.
      const doneChange = nextStatus && nextStatus !== existing.status
        ? (nextStatus === 'done' ? 'set' : (existing.status === 'done' ? 'clear' : null)) : null;

      // COALESCE keeps every field the caller left out, so two people editing
      // different fields of one task cannot overwrite each other.
      await sql`
        UPDATE tasks SET
          title       = COALESCE(${body.title === undefined ? null : clean(body.title, 200)}, title),
          description = COALESCE(${body.description === undefined ? null : clean(body.description, 4000)}, description),
          due_date    = CASE WHEN ${body.dueDate === undefined} THEN due_date ELSE ${cleanDate(body.dueDate)}::date END,
          due_time    = CASE WHEN ${body.dueTime === undefined} THEN due_time ELSE ${cleanTime(body.dueTime)} END,
          status      = COALESCE(${isStatus(body.status) ? body.status : null}, status),
          priority    = COALESCE(${isPriority(body.priority) ? body.priority : null}, priority),
          department  = CASE WHEN ${body.department === undefined} THEN department
                             ELSE ${isDepartment(body.department) ? body.department : null} END,
          unit        = CASE WHEN ${nextUnit === undefined} THEN unit ELSE ${nextUnit ?? null} END,
          start_date  = CASE WHEN ${body.startDate === undefined} THEN start_date ELSE ${cleanDate(body.startDate)}::date END,
          space_id    = CASE WHEN ${nextSpace === undefined} THEN space_id ELSE ${nextSpace ?? null} END,
          done_at     = CASE WHEN ${doneChange === 'set'} THEN now() WHEN ${doneChange === 'clear'} THEN NULL ELSE done_at END,
          notify      = COALESCE(${
            Array.isArray(body.notify)
              ? body.notify.filter((k) => NOTIFY_KINDS.includes(k)).join(',')
              : null
          }, notify),
          updated_at  = now()
        WHERE id = ${id}`;

      /**
       * Whether this task still sits where the clash decision was taken.
       *
       * A decision about a Tuesday afternoon means nothing once the task has
       * moved to Thursday, and leaving the note behind would tell somebody to
       * skip a meeting for a deadline that is no longer on the same day.
       */
      const moved = (body.dueDate !== undefined && cleanDate(body.dueDate) !== existing.dueDate) ||
        (body.dueTime !== undefined && cleanTime(body.dueTime) !== existing.dueTime);
      if (moved) await clearPrecedence(sql, 'task', id);

      let nowOn = null;

      // Tags are replaced wholesale, but only when the caller sent them.
      if (body.assignees !== undefined || body.departments !== undefined) {
        const current = await sql`SELECT username, via FROM task_people WHERE task_id = ${id}`;
        const before = new Set(current.map((r) => r.username));

        const { assignees, departments } = readTags({
          // Left out of the request: keep the names, not everyone the tags reached.
          assignees: body.assignees ?? current.filter((r) => r.via === 'named').map((r) => r.username),
          departments: body.departments ?? [],
        });

        // The same rule as creating: a unit editor cannot widen a task they
        // own to reach people outside their section.
        const willGetIt = await expandPeople(sql, assignees, departments);
        const fullRoster = await sql`
          SELECT username, unit, access, display_name FROM users WHERE active = true`;
        const roster = fullRoster.map((p) => ({ ...p, displayName: p.display_name }));
        const blocked = cannotAssign(me, willGetIt, roster);
        if (blocked) return json({ error: blocked, unit: me.unit || null }, 403);

        const expanded = await writeTags(sql, id, assignees, departments);
        nowOn = expanded;

        const added = expanded.filter((u) => !before.has(u));
        if (added.length && String(existing.notify).includes('created')) {
          await notifyAssigned(sql, { id }, added.filter((u) => assignees.includes(u)), me.username, 'created',
            existing.title, `${me.display_name || me.username} added you to this task.`, 'task_named');
          await notifyAssigned(sql, { id }, added.filter((u) => !assignees.includes(u)), me.username, 'created',
            existing.title, `${me.display_name || me.username} tagged your department on this task.`, 'task_dept');
        }
        await promoteViewers(sql, id);
      }

      // Viewers are part of the task's set-up, so only someone who may edit
      // it reaches here — a status-only caller was turned away above.
      const viewers = readViewers(body);
      if (viewers) {
        const watching = await writeViewers(sql, id, viewers, me.username);
        await notifyAssigned(sql, { id }, watching, me.username, 'watch',
          existing.title, `${me.display_name || me.username} ให้คุณติดตามความคืบหน้างานนี้ (ดูได้อย่างเดียว)`);
      }

      /**
       * Telling the viewers it moved.
       *
       * Following progress is the whole reason somebody is a viewer, so a
       * status change is the one thing they hear about. Nobody else is told
       * here: the people on it are the ones moving it.
       */
      if (isStatus(body.status) && body.status !== existing.status) {
        const watchers = (await sql`SELECT username FROM task_viewers WHERE task_id = ${id}`).map((r) => r.username);
        if (watchers.length) {
          await notifyAssigned(sql, { id }, watchers, me.username, 'progress',
            existing.title, `${me.display_name || me.username}: ${STATUS_TH[existing.status] || existing.status} → ${STATUS_TH[body.status] || body.status}`);
        }
      }

      if (body.prioritise) {
        const [fresh] = await sql`SELECT due_date, due_time FROM tasks WHERE id = ${id}`;
        const on = toIsoDate(fresh?.due_date);
        const people = nowOn ||
          (await sql`SELECT username FROM task_people WHERE task_id = ${id}`).map((r) => r.username);
        const rank = (await sql`
          SELECT username, unit, access, display_name FROM users WHERE active = true`)
          .map((p) => ({ ...p, displayName: p.display_name }));
        // Taken afresh rather than added to: deciding again replaces the
        // earlier decision instead of stacking a second one on top of it.
        await clearPrecedence(sql, 'task', id);
        await applyPrecedence(sql, me, {
          kind: 'task', itemId: id, roster: rank,
          when: { on, at: fresh?.due_time || null }, people,
        });
      }

      const all = await assembled(sql);
      return json({
        task: withRights(me, all.filter((t) => t.id === id))[0],
        tasks: withRights(me, all.filter((x) => canSeeTask(me, x))),
      });
    }

    if (request.method === 'DELETE') {
      const id = clean(url.searchParams.get('id'), 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);

      const target = (await assembled(sql)).find((x) => x.id === id);
      if (target && !canSeeTask(me, target)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);
      // Deleting is permanent and has no undo, so it follows the same rule as
      // editing rather than the wider "can see it" one.
      if (target && !canDeleteTask(me, target)) return json({ error: 'NOT_TASK_OWNER' }, 403);
      await sql`DELETE FROM tasks WHERE id = ${id}`;
      await sql`DELETE FROM reminders_sent WHERE task_id = ${id}`;
      return json({ ok: true, tasks: withRights(me, (await assembled(sql)).filter((x) => canSeeTask(me, x))) });
    }

    return json({ error: 'METHOD' }, 405);
  } catch (error) {
    console.error('[tasks]', error);
    return json({ error: 'SERVER', message: 'The database did not respond. Please try again.' }, 500);
  }
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
