import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { withNode } from '../lib/http.js';
import { buildIcs } from '../lib/ics.js';
import { assembledEvents, canSeeEvent } from './events.js';
import { accessSet } from '../lib/scope.js';

/**
 * The calendar feed: GET /api/calendar?token=…
 *
 * Deliberately NOT cookie-authenticated. Google's calendar fetcher is a robot
 * with no session, so the feed has to identify its owner some other way — an
 * unguessable token in the URL, which is how every calendar subscription on the
 * internet works.
 *
 * That means the URL is a secret. Anyone holding it can read that person's
 * tasks (not change them, and not sign in as them). The profile page says so,
 * and offers a button to issue a fresh token if a link gets loose.
 */
async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const url = requestUrl(request);
  const token = String(url.searchParams.get('token') || '').trim();

  /**
   * Four feeds rather than one.
   *
   * Google gives a subscribed calendar a single colour, so the only way to
   * have the committee's dates in one colour and your own work in another is
   * to subscribe to them separately. Each of these is its own calendar in
   * Google, named so it is obvious which is which.
   */
  const SCOPES = ['mine', 'dept', 'events', 'all'];
  const asked = url.searchParams.get('scope') || 'mine';
  const scope = SCOPES.includes(asked) ? asked : 'mine';

  if (!token || token.length < 20) return json({ error: 'BAD_TOKEN' }, 401);

  const [owner] = await sql`
    SELECT * FROM users
    WHERE calendar_token = ${token} AND active = true AND suspended = false`;
  if (!owner) return json({ error: 'BAD_TOKEN' }, 401);

  owner.departments = (
    await sql`SELECT department FROM user_departments WHERE username = ${owner.username}`
  ).map((r) => r.department);
  const mine = [...accessSet(owner)];

  const rows =
    scope === 'events'
      ? []
      : scope === 'all'
        ? await sql`SELECT * FROM tasks WHERE due_date IS NOT NULL ORDER BY due_date`
        : scope === 'dept'
          ? (mine.length
              ? await sql`
                  SELECT DISTINCT t.* FROM tasks t
                  LEFT JOIN task_departments d ON d.task_id = t.id
                  WHERE t.due_date IS NOT NULL
                    AND (t.department = ANY(${mine}) OR d.department = ANY(${mine}))
                  ORDER BY t.due_date`
              : [])
          : await sql`
              SELECT t.* FROM tasks t
              JOIN task_people p ON p.task_id = t.id
              WHERE p.username = ${owner.username} AND t.due_date IS NOT NULL
              ORDER BY t.due_date`;

  const ids = rows.map((r) => r.id);
  const people = ids.length
    ? await sql`SELECT task_id, username FROM task_people WHERE task_id = ANY(${ids})`
    : [];
  const everyone = await sql`SELECT username, display_name, sheet_name FROM users`;

  const nameOf = (username) => {
    const u = everyone.find((x) => x.username === username);
    return u ? u.display_name || u.sheet_name || username : username;
  };

  const byTask = new Map(ids.map((id) => [id, []]));
  for (const p of people) byTask.get(p.task_id)?.push(p.username);

  /** Same timezone care as everywhere else — a DATE must not cross a zone. */
  const toIso = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    if (!(value instanceof Date)) return null;
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  };

  const tasks = rows.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    dueDate: toIso(t.due_date),
    dueTime: t.due_time || null,
    status: t.status,
    assignees: byTask.get(t.id) ?? [],
  }));

  /**
   * Events ride along with the "mine" and "all" feeds, and have a feed of
   * their own. Somebody who only wants to know when things happen subscribes
   * to that one and gets no deadlines at all.
   */
  const events = ['events', 'mine', 'all'].includes(scope)
    ? (await assembledEvents(sql)).filter((e) => canSeeEvent(owner, e))
    : [];

  const who = owner.display_name || owner.sheet_name || owner.username;
  const NAMES = {
    mine: `จุฬาฯแฟร์ · งานของ ${who}`,
    dept: 'จุฬาฯแฟร์ · งานของฝ่าย',
    events: 'จุฬาฯแฟร์ · กิจกรรม',
    all: 'จุฬาฯแฟร์ · ทั้งหมด',
  };

  return new Response(buildIcs(tasks, NAMES[scope], nameOf, events), {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="fair-tasks.ics"',
      // Short cache: Google re-fetches on its own schedule anyway.
      'cache-control': 'public, max-age=600',
    },
  });
}

export default withNode(handler);
