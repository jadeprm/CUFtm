import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';

/**
 * The bell: a person's own notifications.
 *
 *   GET   /api/notifications            my notifications, newest first
 *   PATCH /api/notifications            { ids: [...] } or { all: true } to mark read
 *   PATCH /api/notifications?do=ack     { id } — acknowledge an urgent one
 */
async function handler(request) {
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
        level: r.level || 'normal',
        announcementId: r.announcement_id || null,
        createdAt: r.created_at,
        read: Boolean(r.read_at),
        acked: Boolean(r.acked_at),
      })),
      // Urgent messages nobody has acknowledged yet. The page shows these on
      // top of whatever else is open — the whole point of marking something
      // urgent is that it is not waiting politely behind the task list.
      pending: rows
        .filter((r) => r.level === 'urgent' && !r.acked_at)
        .map((r) => r.id),
    });
  }

  // ---- acknowledge an urgent message --------------------------------------
  if (request.method === 'PATCH' && requestUrl(request).searchParams.get('do') === 'ack') {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id ?? '').slice(0, 64);
    if (!id) return json({ error: 'ID_REQUIRED' }, 400);
    await sql`
      UPDATE notifications SET acked_at = now(), read_at = COALESCE(read_at, now())
      WHERE id = ${id} AND username = ${me.username}`;
    const [{ unread }] = await sql`
      SELECT count(*)::int AS unread FROM notifications
      WHERE username = ${me.username} AND read_at IS NULL`;
    return json({ ok: true, unread });
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

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
