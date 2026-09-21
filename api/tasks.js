import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { isDepartment } from '../lib/departments.js';

export const config = {
  runtime: 'edge',
};

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

const STATUSES = ['todo', 'doing', 'done'];
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
    ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
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
    const rows =
      scope === 'heads'
        ? await sql`SELECT username FROM users WHERE department = ${key} AND is_head = true AND active = true`
        : scope === 'members'
          ? await sql`SELECT username FROM users WHERE department = ${key} AND is_head = false AND active = true`
          : await sql`SELECT username FROM users WHERE department = ${key} AND active = true`;
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
  for (const username of usernames) {
    if (username === actor) continue; // no need to tell someone what they just did
    const id = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO notifications (id, username, task_id, kind, title, body)
      VALUES (${id}, ${username}, ${task.id}, ${kind}, ${title}, ${body})`;
  }
}

export default async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);

  try {
    if (request.method === 'GET') {
      return json({ tasks: await assembled(sql) });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const title = clean(body.title, 200);
      if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

      const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const notify = (Array.isArray(body.notify) ? body.notify : NOTIFY_KINDS)
        .filter((k) => NOTIFY_KINDS.includes(k))
        .join(',');

      await sql`
        INSERT INTO tasks (id, title, description, due_date, due_time, status, created_by, notify)
        VALUES (${id}, ${title}, ${clean(body.description, 4000)},
                ${cleanDate(body.dueDate)}, ${cleanTime(body.dueTime)},
                ${STATUSES.includes(body.status) ? body.status : 'todo'}, ${me.username}, ${notify})`;

      const { assignees, departments } = readTags(body);
      const expanded = await writeTags(sql, id, assignees, departments);

      if (notify.includes('created')) {
        await notifyAssigned(sql, { id }, expanded, me.username, 'created',
          title, `${me.display_name || me.username} added you to this task.`);
      }

      const all = await assembled(sql);
      return json({ task: all.find((t) => t.id === id), tasks: all }, 201);
    }

    if (request.method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const id = clean(body.id, 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);

      const [existing] = await sql`SELECT * FROM tasks WHERE id = ${id}`;
      if (!existing) return json({ error: 'NO_SUCH_TASK' }, 404);

      // COALESCE keeps every field the caller left out, so two people editing
      // different fields of one task cannot overwrite each other.
      await sql`
        UPDATE tasks SET
          title       = COALESCE(${body.title === undefined ? null : clean(body.title, 200)}, title),
          description = COALESCE(${body.description === undefined ? null : clean(body.description, 4000)}, description),
          due_date    = CASE WHEN ${body.dueDate === undefined} THEN due_date ELSE ${cleanDate(body.dueDate)}::date END,
          due_time    = CASE WHEN ${body.dueTime === undefined} THEN due_time ELSE ${cleanTime(body.dueTime)} END,
          status      = COALESCE(${STATUSES.includes(body.status) ? body.status : null}, status),
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
      return json({ task: all.find((t) => t.id === id), tasks: all });
    }

    if (request.method === 'DELETE') {
      const id = clean(url.searchParams.get('id'), 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);
      await sql`DELETE FROM tasks WHERE id = ${id}`;
      await sql`DELETE FROM reminders_sent WHERE task_id = ${id}`;
      return json({ ok: true, tasks: await assembled(sql) });
    }

    return json({ error: 'METHOD' }, 405);
  } catch (error) {
    console.error('[tasks]', error);
    return json({ error: 'SERVER', message: 'The database did not respond. Please try again.' }, 500);
  }
}