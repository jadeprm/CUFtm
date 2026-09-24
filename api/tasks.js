import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { isDepartment } from '../lib/departments.js';
import {
  isStatus, isPriority, seesEverything, canSeeTask, canPostTo, accessSet,
  canEditTask, canSetStatus, canDeleteTask,
  canManageParts, canCompletePart, canAttach, canRemoveLink,
  linkKind, safeUrl,
} from '../lib/scope.js';
import { sendToMany } from '../lib/push.js';
import { withNode } from '../lib/http.js';

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
const NOTIFY_KINDS = ['created', '7d', '24h', 'due'];

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

async function assembled(sql) {
  const tasks = await sql`
    SELECT * FROM tasks
    ORDER BY
      CASE status WHEN 'doing' THEN 0 WHEN 'review' THEN 1 WHEN 'feedback' THEN 2
                  WHEN 'todo' THEN 3 ELSE 4 END,
      CASE priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      due_date NULLS LAST, due_time NULLS LAST, created_at`;
  const people = await sql`SELECT * FROM task_people`;
  const depts = await sql`SELECT * FROM task_departments`;
  const parts = await sql`SELECT * FROM task_parts ORDER BY position, created_at`;
  const links = await sql`SELECT * FROM task_links ORDER BY created_at`;

  const byTask = new Map();
  for (const t of tasks) byTask.set(t.id, { people: [], departments: [], parts: [], links: [] });
  for (const p of people) byTask.get(p.task_id)?.people.push(p.username);
  for (const d of depts) byTask.get(d.task_id)?.departments.push({ key: d.department, scope: d.scope });
  for (const p of parts) {
    byTask.get(p.task_id)?.parts.push({
      id: p.id,
      title: p.title,
      assignee: p.assignee,
      done: p.done,
      doneAt: p.done_at,
      doneBy: p.done_by,
    });
  }
  for (const l of links) {
    byTask.get(l.task_id)?.links.push({
      id: l.id,
      partId: l.part_id,
      url: l.url,
      label: l.label,
      kind: l.kind,
      addedBy: l.added_by,
      createdAt: l.created_at,
    });
  }

  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    dueDate: toIsoDate(t.due_date),
    dueTime: t.due_time || null,
    status: t.status,
    priority: t.priority || 'medium',
    department: t.department || null,
    createdBy: t.created_by,
    notify: String(t.notify || '').split(',').filter(Boolean),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    assignees: byTask.get(t.id)?.people ?? [],
    departments: byTask.get(t.id)?.departments ?? [],
    parts: byTask.get(t.id)?.parts ?? [],
    links: byTask.get(t.id)?.links ?? [],
  }));
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
  }));

/**
 * Turns department tags into the actual list of people to notify.
 * `heads` means everyone flagged as a head of that department; `members`
 * everyone else in it; `all` both.
 */
async function expandPeople(sql, assignees, departments) {
  const set = new Set(assignees);

  for (const { key, scope } of departments) {
    // Membership comes from the grants table, so someone who works across two
    // departments is reached by a tag on either of them. People whose access
    // is "all departments" are deliberately not swept in: tagging Content
    // should not notify the project director.
    const rows =
      scope === 'heads'
        ? await sql`SELECT u.username FROM users u JOIN user_departments d ON d.username = u.username
                    WHERE d.department = ${key} AND u.is_head = true AND u.active = true`
        : scope === 'members'
          ? await sql`SELECT u.username FROM users u JOIN user_departments d ON d.username = u.username
                      WHERE d.department = ${key} AND u.is_head = false AND u.active = true`
          : await sql`SELECT u.username FROM users u JOIN user_departments d ON d.username = u.username
                      WHERE d.department = ${key} AND u.active = true`;
    for (const r of rows) set.add(r.username);
  }
  return [...set];
}

async function writeTags(sql, taskId, assignees, departments) {
  await sql`DELETE FROM task_people WHERE task_id = ${taskId}`;
  await sql`DELETE FROM task_departments WHERE task_id = ${taskId}`;

  const expanded = await expandPeople(sql, assignees, departments);
  for (const username of expanded) {
    await sql`INSERT INTO task_people (task_id, username) VALUES (${taskId}, ${username})
              ON CONFLICT DO NOTHING`;
  }
  for (const { key, scope } of departments) {
    await sql`INSERT INTO task_departments (task_id, department, scope)
              VALUES (${taskId}, ${key}, ${scope}) ON CONFLICT DO NOTHING`;
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

async function notifyAssigned(sql, task, usernames, actor, kind, title, body) {
  const targets = usernames.filter((u) => u !== actor); // nobody needs telling what they just did
  const idFor = {};

  for (const username of targets) {
    const id = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    idFor[username] = id;
    await sql`
      INSERT INTO notifications (id, username, task_id, kind, title, body)
      VALUES (${id}, ${username}, ${task.id}, ${kind}, ${title}, ${body})`;
  }

  /**
   * The bell row is written first and the push is attempted after, so a push
   * service being slow or unreachable costs a lock-screen alert and nothing
   * more — the notification is still waiting in the app either way.
   */
  if (targets.length) {
    try {
      await sendToMany(sql, targets, (username) => ({
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
      await sql`INSERT INTO task_people (task_id, username) VALUES (${task.id}, ${assignee})
                ON CONFLICT DO NOTHING`;
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
        await sql`INSERT INTO task_people (task_id, username) VALUES (${row.task_id}, ${assignee})
                  ON CONFLICT DO NOTHING`;
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

      await sql`
        INSERT INTO tasks (id, title, description, due_date, due_time, status, priority,
                           department, created_by, notify)
        VALUES (${id}, ${title}, ${clean(body.description, 4000)},
                ${cleanDate(body.dueDate)}, ${cleanTime(body.dueTime)},
                ${isStatus(body.status) ? body.status : 'todo'},
                ${isPriority(body.priority) ? body.priority : 'medium'},
                ${department}, ${me.username}, ${notify})`;

      const { assignees, departments } = readTags(body);
      const expanded = await writeTags(sql, id, assignees, departments);

      if (notify.includes('created')) {
        await notifyAssigned(sql, { id }, expanded, me.username, 'created',
          title, `${me.display_name || me.username} added you to this task.`);
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
          notify      = COALESCE(${
            Array.isArray(body.notify)
              ? body.notify.filter((k) => NOTIFY_KINDS.includes(k)).join(',')
              : null
          }, notify),
          updated_at  = now()
        WHERE id = ${id}`;

      // Tags are replaced wholesale, but only when the caller sent them.
      if (body.assignees !== undefined || body.departments !== undefined) {
        const current = await sql`SELECT username FROM task_people WHERE task_id = ${id}`;
        const before = new Set(current.map((r) => r.username));

        const { assignees, departments } = readTags({
          assignees: body.assignees ?? current.map((r) => r.username),
          departments: body.departments ?? [],
        });
        const expanded = await writeTags(sql, id, assignees, departments);

        const added = expanded.filter((u) => !before.has(u));
        if (added.length && String(existing.notify).includes('created')) {
          await notifyAssigned(sql, { id }, added, me.username, 'created',
            existing.title, `${me.display_name || me.username} added you to this task.`);
        }
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
