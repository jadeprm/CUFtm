import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { isDepartment } from '../lib/departments.js';
import { isStatus, isPriority, seesEverything, canSeeTask, canPostTo, accessSet } from '../lib/scope.js';
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

  const byTask = new Map();
  for (const t of tasks) byTask.set(t.id, { people: [], departments: [] });
  for (const p of people) byTask.get(p.task_id)?.people.push(p.username);
  for (const d of depts) byTask.get(d.task_id)?.departments.push({ key: d.department, scope: d.scope });

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
  }));
}

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

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);

  try {
    if (request.method === 'GET') {
      const all = await assembled(sql);
      // Filtering here rather than in SQL keeps one definition of the rule,
      // in lib/scope.js, shared with the client's own display logic.
      return json({
        tasks: all.filter((task) => canSeeTask(me, task)),
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
      return json({ task: all.find((t) => t.id === id), tasks: all.filter((x) => canSeeTask(me, x)) }, 201);
    }

    if (request.method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const id = clean(body.id, 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);

      const [existing] = await sql`SELECT * FROM tasks WHERE id = ${id}`;
      if (!existing) return json({ error: 'NO_SUCH_TASK' }, 404);

      // Editing is open to everyone who can SEE the task — but not beyond.
      const visible = (await assembled(sql)).find((x) => x.id === id);
      if (!canSeeTask(me, visible)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);

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
      return json({ task: all.find((t) => t.id === id), tasks: all.filter((x) => canSeeTask(me, x)) });
    }

    if (request.method === 'DELETE') {
      const id = clean(url.searchParams.get('id'), 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);

      const target = (await assembled(sql)).find((x) => x.id === id);
      if (target && !canSeeTask(me, target)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);
      await sql`DELETE FROM tasks WHERE id = ${id}`;
      await sql`DELETE FROM reminders_sent WHERE task_id = ${id}`;
      return json({ ok: true, tasks: (await assembled(sql)).filter((x) => canSeeTask(me, x)) });
    }

    return json({ error: 'METHOD' }, 405);
  } catch (error) {
    console.error('[tasks]', error);
    return json({ error: 'SERVER', message: 'The database did not respond. Please try again.' }, 500);
  }
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
