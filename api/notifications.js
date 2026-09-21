import { getSql, json, noDatabase, hasDatabase } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';

/**
 * The bell: a person's own notifications.
 *
 *   GET   /api/notifications            my notifications, newest first
 *   PATCH /api/notifications            { ids: [...] } or { all: true } to mark read
 */
export default async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  if (request.method === 'GET') {
    const rows = await sql`
      SELECT * FROM notifications
      WHERE username = ${me.username}
      ORDER BY created_at DESC
      LIMIT 100`;
    const unread = rows.filter((r) => !r.read_at).length;
    return json({
      unread,
      notifications: rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        createdAt: r.created_at,
        read: Boolean(r.read_at),
      })),
    });
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    if (body.all) {
      await sql`UPDATE notifications SET read_at = now()
                WHERE username = ${me.username} AND read_at IS NULL`;
    } else if (Array.isArray(body.ids) && body.ids.length) {
      const ids = body.ids.map((i) => String(i).slice(0, 64));
      await sql`UPDATE notifications SET read_at = now()
                WHERE username = ${me.username} AND id = ANY(${ids})`;
    }
    const [{ unread }] = await sql`
      SELECT count(*)::int AS unread FROM notifications
      WHERE username = ${me.username} AND read_at IS NULL`;
    return json({ ok: true, unread });
  }

  return json({ error: 'METHOD' }, 405);
}
