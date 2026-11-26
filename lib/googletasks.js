/**
 * Two-way sync between CUFTM tasks and Google Tasks (the backend Gemini's
 * Google Tasks / Google Workspace extension reads and updates).
 *
 * Reuses the per-user Google OAuth link in `google_links` (`lib/googlecal.js`)
 * once the user has granted the `https://www.googleapis.com/auth/tasks` scope
 * and switched on `push_tasks`.
 */
import { accessToken } from './googlecal.js';
import { siteUrl } from './line.js';

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const LIST_TITLE = 'CUFTM · งานจุฬาฯแฟร์';
const TASKS_SCOPE_MARK = '/auth/tasks';

async function gcall(sql, username, path, { method = 'GET', body } = {}) {
  const token = await accessToken(sql, username);
  if (!token) return { ok: false, status: 401, data: {} };
  const res = await fetch(`${TASKS_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Finds or creates the dedicated CUFTM list inside the user's Google Tasks. */
export async function ensureTaskList(sql, username) {
  const [link] = await sql`
    SELECT tasks_list_id, scope FROM google_links WHERE username = ${username}`;
  if (!link) return { ok: false, error: 'GOOGLE_NOT_LINKED' };
  if (!String(link.scope || '').includes(TASKS_SCOPE_MARK)) {
    return { ok: false, error: 'GOOGLE_TASKS_SCOPE_MISSING' };
  }

  if (link.tasks_list_id) {
    const check = await gcall(sql, username, `/users/@me/lists/${encodeURIComponent(link.tasks_list_id)}`);
    if (check.ok && check.data?.id) return { ok: true, listId: check.data.id };
    if (check.status === 401 || check.status === 403) {
      return { ok: false, error: 'GOOGLE_TASKS_SCOPE_MISSING' };
    }
  }

  const lists = await gcall(sql, username, '/users/@me/lists?maxResults=100');
  if (!lists.ok) {
    return { ok: false, error: lists.status === 403 ? 'GOOGLE_TASKS_SCOPE_MISSING' : 'GOOGLE_TASKS_ERROR' };
  }
  const existing = (lists.data.items || []).find((l) => l.title === LIST_TITLE);
  let listId = existing?.id || null;

  if (!listId) {
    const made = await gcall(sql, username, '/users/@me/lists', {
      method: 'POST',
      body: { title: LIST_TITLE },
    });
    if (!made.ok || !made.data?.id) return { ok: false, error: 'GOOGLE_TASKS_ERROR' };
    listId = made.data.id;
  }

  await sql`UPDATE google_links SET tasks_list_id = ${listId} WHERE username = ${username}`;
  return { ok: true, listId };
}

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

function buildPayload(task) {
  const code = task.code ? `[${task.code}] ` : '';
  const due = toIsoDate(task.dueDate ?? task.due_date);
  const dueTime = task.dueTime ?? task.due_time;
  const baseUrl = siteUrl();
  const link = baseUrl ? `${baseUrl}/#/t/${encodeURIComponent(task.id)}` : null;
  const meta = [
    task.code ? `Code: ${task.code}` : null,
    task.priority ? `Priority: ${task.priority}` : null,
    task.status ? `Status: ${task.status}` : null,
    dueTime ? `Time: ${dueTime} (Asia/Bangkok)` : null,
    link ? `CUFTM: ${link}` : null,
  ].filter(Boolean).join('\n');

  const body = {
    title: `${code}${task.title || ''}`.slice(0, 1024),
    notes: [String(task.description || '').trim(), meta].filter(Boolean).join('\n\n').slice(0, 8000),
    status: task.status === 'done' ? 'completed' : 'needsAction',
  };
  if (due) body.due = `${due}T00:00:00.000Z`;
  else body.due = null;
  if (body.status === 'needsAction') body.completed = null;
  return body;
}

/** Creates or updates one CUFTM task in the user's Google Tasks list. */
export async function upsertGoogleTask(sql, username, task, listId = null) {
  let lid = listId;
  if (!lid) {
    const ensured = await ensureTaskList(sql, username);
    if (!ensured.ok) return ensured;
    lid = ensured.listId;
  }

  const [mapped] = await sql`
    SELECT google_list_id, google_task_id FROM google_task_sync
    WHERE username = ${username} AND task_id = ${task.id}`;
  const payload = buildPayload(task);

  if (mapped && mapped.google_list_id === lid) {
    const patch = await gcall(
      sql,
      username,
      `/lists/${encodeURIComponent(lid)}/tasks/${encodeURIComponent(mapped.google_task_id)}`,
      { method: 'PATCH', body: payload },
    );
    if (patch.ok) {
      await sql`
        UPDATE google_task_sync SET synced_at = now()
        WHERE username = ${username} AND task_id = ${task.id}`;
      return { ok: true, id: mapped.google_task_id };
    }
    if (patch.status !== 404) return { ok: false, status: patch.status };
  }

  const created = await gcall(sql, username, `/lists/${encodeURIComponent(lid)}/tasks`, {
    method: 'POST',
    body: payload,
  });
  if (!created.ok || !created.data?.id) return { ok: false, status: created.status };

  await sql`
    INSERT INTO google_task_sync (username, task_id, google_list_id, google_task_id, synced_at)
    VALUES (${username}, ${task.id}, ${lid}, ${created.data.id}, now())
    ON CONFLICT (username, task_id) DO UPDATE
      SET google_list_id = EXCLUDED.google_list_id,
          google_task_id = EXCLUDED.google_task_id,
          synced_at = now()`;
  return { ok: true, id: created.data.id };
}

/** Removes a CUFTM task from the user's Google Tasks list if it was synced. */
export async function deleteGoogleTask(sql, username, taskId) {
  const [mapped] = await sql`
    DELETE FROM google_task_sync
    WHERE username = ${username} AND task_id = ${taskId}
    RETURNING google_list_id, google_task_id`;
  if (!mapped) return { ok: true };
  await gcall(
    sql,
    username,
    `/lists/${encodeURIComponent(mapped.google_list_id)}/tasks/${encodeURIComponent(mapped.google_task_id)}`,
    { method: 'DELETE' },
  );
  return { ok: true };
}

/**
 * Propagates a task create/edit/delete to every linked assignee who enabled
 * Google Tasks sync (so Gemini sees changes immediately).
 */
export async function syncTaskForLinkedAssignees(sql, task, { previousAssignees = [], deleted = false } = {}) {
  const current = deleted ? [] : (task?.assignees || []);
  const touched = [...new Set([...current, ...previousAssignees])];
  if (!touched.length) return;

  const links = await sql`
    SELECT username, scope FROM google_links
    WHERE username = ANY(${touched}) AND push_tasks = true`;
  for (const link of links) {
    if (!String(link.scope || '').includes(TASKS_SCOPE_MARK)) continue;
    try {
      if (deleted || !current.includes(link.username)) {
        await deleteGoogleTask(sql, link.username, task.id);
      } else {
        await upsertGoogleTask(sql, link.username, task);
      }
    } catch {
      /* never break a CUFTM task write if Google Tasks is temporarily unreachable */
    }
  }
}

/**
 * Full two-way sync for one user:
 *   1. Pulls completion changes made in Gemini / Google Tasks back into CUFTM.
 *   2. Pushes open (and recently synced) CUFTM tasks assigned to this user up
 *      to their `"CUFTM · งานจุฬาฯแฟร์"` Google Tasks list.
 */
export async function syncUserTasks(sql, username) {
  const ensured = await ensureTaskList(sql, username);
  if (!ensured.ok) return ensured;
  const { listId } = ensured;

  let pulled = 0;
  let pushed = 0;
  let failed = 0;

  // 1. Pull completion updates from Google Tasks (e.g. checked off via Gemini)
  const remoteRes = await gcall(
    sql,
    username,
    `/lists/${encodeURIComponent(listId)}/tasks?showCompleted=true&showHidden=true&maxResults=100`,
  );
  const remoteById = new Map();
  if (remoteRes.ok) {
    for (const item of remoteRes.data.items || []) remoteById.set(item.id, item);
  }

  const mappings = await sql`
    SELECT g.task_id, g.google_task_id, g.synced_at, t.status, t.updated_at
    FROM google_task_sync g
    JOIN tasks t ON t.id = g.task_id
    WHERE g.username = ${username} AND g.google_list_id = ${listId}`;

  for (const m of mappings) {
    const remote = remoteById.get(m.google_task_id);
    if (!remote) continue;
    const remoteUpdated = remote.updated ? new Date(remote.updated).getTime() : 0;
    const localUpdated = m.updated_at ? new Date(m.updated_at).getTime() : 0;
    const syncedAt = m.synced_at ? new Date(m.synced_at).getTime() : 0;
    // Only pull when Google Tasks was modified AFTER our last push and AFTER local edit.
    if (remoteUpdated <= Math.max(syncedAt, localUpdated)) continue;

    if (remote.status === 'completed' && m.status !== 'done') {
      await sql`
        UPDATE tasks SET status = 'done', done_at = COALESCE(done_at, now()), updated_at = now()
        WHERE id = ${m.task_id}`;
      await sql`
        UPDATE google_task_sync SET synced_at = now()
        WHERE username = ${username} AND task_id = ${m.task_id}`;
      pulled += 1;
    } else if (remote.status === 'needsAction' && m.status === 'done') {
      await sql`
        UPDATE tasks SET status = 'doing', done_at = NULL, updated_at = now()
        WHERE id = ${m.task_id}`;
      await sql`
        UPDATE google_task_sync SET synced_at = now()
        WHERE username = ${username} AND task_id = ${m.task_id}`;
      pulled += 1;
    }
  }

  // 2. Push open tasks (plus already-synced tasks) assigned to this user
  const myTasks = await sql`
    SELECT DISTINCT t.id, t.code, t.title, t.description, t.due_date, t.due_time, t.status, t.priority
    FROM tasks t
    JOIN task_people p ON p.task_id = t.id
    LEFT JOIN google_task_sync g ON g.task_id = t.id AND g.username = ${username}
    WHERE p.username = ${username}
      AND (t.status <> 'done' OR g.google_task_id IS NOT NULL)
    ORDER BY t.due_date NULLS LAST, t.created_at
    LIMIT 100`;

  for (const t of myTasks) {
    const r = await upsertGoogleTask(sql, username, t, listId);
    if (r.ok) pushed += 1;
    else failed += 1;
  }

  return { ok: true, listId, pushed, pulled, failed };
}

/** Hourly cron sweep: keeps Google Tasks / Gemini completions in sync with CUFTM. */
export async function syncAllGoogleTasks(sql) {
  const links = await sql`
    SELECT username, scope FROM google_links WHERE push_tasks = true`;
  let users = 0;
  let pushed = 0;
  let pulled = 0;
  for (const link of links) {
    if (!String(link.scope || '').includes(TASKS_SCOPE_MARK)) continue;
    try {
      const res = await syncUserTasks(sql, link.username);
      if (res.ok) {
        users += 1;
        pushed += res.pushed || 0;
        pulled += res.pulled || 0;
      }
    } catch {
      /* isolate per-user failures */
    }
  }
  return { users, pushed, pulled };
}
