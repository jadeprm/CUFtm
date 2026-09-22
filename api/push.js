import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser, canManageAccounts } from '../lib/auth.js';
import { isDepartment, expandAccess } from '../lib/departments.js';
import { publicKey, sendToUser, sendToMany, unreadCount } from '../lib/push.js';
import { withNode } from '../lib/http.js';

/**
 * Notifications that reach a phone.
 *
 *   GET   /api/push?do=key           the public key the browser needs to subscribe
 *   POST  /api/push?do=subscribe     store this browser's subscription
 *   POST  /api/push?do=unsubscribe   forget it
 *   POST  /api/push?do=test          send myself one, to prove it works
 *   PATCH /api/push?do=prefs         turn my own notifications on or off
 *   POST  /api/push?do=announce      admin / co-admin: send a message to people
 *   GET   /api/push?do=sent          admin / co-admin: what was sent, and who read it
 */

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Turns the audience an admin picked into a list of usernames.
 *
 * Suspended and inactive people are never included: someone who has been
 * removed from the roster should not keep getting committee announcements on
 * their phone.
 */
async function resolveAudience(sql, audience) {
  const kind = audience?.kind || 'everyone';

  if (kind === 'people') {
    const names = (Array.isArray(audience.people) ? audience.people : [])
      .map((n) => clean(n, 64))
      .filter(Boolean);
    if (!names.length) return [];
    const rows = await sql`
      SELECT username FROM users
      WHERE username = ANY(${names}) AND active = true AND suspended = false`;
    return rows.map((r) => r.username);
  }

  if (kind === 'departments') {
    const keys = expandAccess(
      (Array.isArray(audience.departments) ? audience.departments : []).filter(isDepartment),
    );
    if (!keys.length) return [];
    // all_departments people are included here on purpose: an announcement to
    // Content is committee business the directors should see, unlike a task
    // tag, which would just be noise to them.
    const rows = await sql`
      SELECT DISTINCT u.username FROM users u
      LEFT JOIN user_departments d ON d.username = u.username
      WHERE u.active = true AND u.suspended = false
        AND (d.department = ANY(${keys}) OR u.all_departments = true)`;
    return rows.map((r) => r.username);
  }

  const rows = await sql`
    SELECT username FROM users WHERE active = true AND suspended = false`;
  return rows.map((r) => r.username);
}

/** A human-readable note of who it went to, kept with the announcement. */
function describeAudience(audience, count) {
  const kind = audience?.kind || 'everyone';
  if (kind === 'people') return `people:${count}`;
  if (kind === 'departments') {
    return `departments:${(audience.departments || []).join('+')}`;
  }
  return 'everyone';
}

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);
  const action = url.searchParams.get('do');

  // ---- the key a browser needs before it can subscribe --------------------
  if (request.method === 'GET' && action === 'key') {
    const subs = await sql`
      SELECT endpoint, user_agent, created_at FROM push_subscriptions
      WHERE username = ${me.username} ORDER BY created_at`;
    return json({
      publicKey: await publicKey(sql),
      pushEnabled: me.push_enabled !== false,
      devices: subs.map((s) => ({
        endpoint: s.endpoint,
        userAgent: s.user_agent,
        createdAt: s.created_at,
      })),
    });
  }

  // ---- this browser now has permission ------------------------------------
  if (request.method === 'POST' && action === 'subscribe') {
    const body = await request.json().catch(() => ({}));
    const sub = body.subscription || {};
    const endpoint = clean(sub.endpoint, 1000);
    const p256dh = clean(sub.keys?.p256dh, 200);
    const auth = clean(sub.keys?.auth, 100);

    if (!endpoint || !p256dh || !auth) return json({ error: 'BAD_SUBSCRIPTION' }, 400);

    // The browser may have rotated the endpoint; drop the one it replaces so
    // the same phone does not end up counted twice and pushed to twice.
    if (body.replaces) {
      await sql`DELETE FROM push_subscriptions WHERE endpoint = ${clean(body.replaces, 1000)}`;
    }

    /**
     * An endpoint belongs to a browser, not to a person. If someone else signs
     * in on the same phone, the row is reassigned rather than duplicated —
     * otherwise the previous person would keep receiving pushes on a device
     * that is no longer theirs.
     */
    await sql`
      INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, user_agent, last_ok_at)
      VALUES (${endpoint}, ${me.username}, ${p256dh}, ${auth},
              ${clean(request.headers.get('user-agent'), 300)}, now())
      ON CONFLICT (endpoint) DO UPDATE SET
        username   = EXCLUDED.username,
        p256dh     = EXCLUDED.p256dh,
        auth       = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        fail_count = 0`;

    await sql`UPDATE users SET push_enabled = true WHERE username = ${me.username}`;
    return json({ ok: true });
  }

  if (request.method === 'POST' && action === 'unsubscribe') {
    const body = await request.json().catch(() => ({}));
    const endpoint = clean(body.endpoint, 1000);
    if (endpoint) {
      await sql`DELETE FROM push_subscriptions
                WHERE endpoint = ${endpoint} AND username = ${me.username}`;
    } else {
      await sql`DELETE FROM push_subscriptions WHERE username = ${me.username}`;
    }
    return json({ ok: true });
  }

  // ---- prove to someone that it works -------------------------------------
  if (request.method === 'POST' && action === 'test') {
    const result = await sendToUser(sql, me.username, {
      id: 'test',
      title: me.lang === 'en' ? 'Notifications are on' : 'เปิดการแจ้งเตือนแล้ว',
      body: me.lang === 'en'
        ? 'This is what a notification from Chula Fair Tasks looks like.'
        : 'นี่คือหน้าตาการแจ้งเตือนจากระบบงานจุฬาฯแฟร์',
      level: 'normal',
      lang: me.lang,
      unread: await unreadCount(sql, me.username),
    });
    if (!result.sent) return json({ error: 'NO_DEVICE', ...result }, 409);
    return json({ ok: true, ...result });
  }

  if (request.method === 'PATCH' && action === 'prefs') {
    const body = await request.json().catch(() => ({}));
    const on = Boolean(body.pushEnabled);
    await sql`UPDATE users SET push_enabled = ${on}, updated_at = now()
              WHERE username = ${me.username}`;
    return json({ ok: true, pushEnabled: on });
  }

  // ---- send a message to the committee ------------------------------------
  if (request.method === 'POST' && action === 'announce') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_ANNOUNCE' }, 403);

    const body = await request.json().catch(() => ({}));
    const title = clean(body.title, 120);
    const text = clean(body.body, 2000);
    if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

    const level = body.level === 'urgent' ? 'urgent' : 'normal';
    const link = body.link ? clean(body.link, 500) : null;
    const audience = body.audience || { kind: 'everyone' };

    let names = await resolveAudience(sql, audience);
    // Sending to yourself is almost never what is meant, and an urgent message
    // that makes the sender acknowledge their own announcement is silly.
    if (!body.includeSelf) names = names.filter((n) => n !== me.username);
    if (!names.length) return json({ error: 'NO_RECIPIENTS' }, 400);

    const id = newId('a');
    await sql`
      INSERT INTO announcements (id, sent_by, title, body, level, audience, link, recipients)
      VALUES (${id}, ${me.username}, ${title}, ${text}, ${level},
              ${describeAudience(audience, names.length)}, ${link}, ${names.length})`;

    // Written to the bell first, so the message survives even for people whose
    // phone never receives the push.
    for (const username of names) {
      await sql`
        INSERT INTO notifications (id, username, task_id, kind, title, body, level, announcement_id)
        VALUES (${newId('n')}, ${username}, ${null}, ${'announce'}, ${title}, ${text},
                ${level}, ${id})`;
    }

    const rows = await sql`
      SELECT username, id FROM notifications WHERE announcement_id = ${id}`;
    const idFor = Object.fromEntries(rows.map((r) => [r.username, r.id]));

    const from = me.display_name || me.username;
    const result = await sendToMany(sql, names, (username) => ({
      id: idFor[username],
      title,
      body: text,
      level,
      from,
      url: './',
    }));

    await sql`UPDATE announcements SET pushed = ${result.reached} WHERE id = ${id}`;

    return json({
      ok: true,
      id,
      recipients: names.length,
      reached: result.reached,
      delivered: result.sent,
      removed: result.removed,
    }, 201);
  }

  // ---- what has been sent, and who has seen it ----------------------------
  if (request.method === 'GET' && action === 'sent') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_ANNOUNCE' }, 403);

    const rows = await sql`
      SELECT a.*,
             (SELECT count(*)::int FROM notifications n
               WHERE n.announcement_id = a.id AND n.read_at IS NOT NULL) AS read_count,
             (SELECT count(*)::int FROM notifications n
               WHERE n.announcement_id = a.id AND n.acked_at IS NOT NULL) AS ack_count
      FROM announcements a
      ORDER BY a.created_at DESC
      LIMIT 30`;

    return json({
      announcements: rows.map((a) => ({
        id: a.id,
        sentBy: a.sent_by,
        title: a.title,
        body: a.body,
        level: a.level,
        audience: a.audience,
        recipients: a.recipients,
        pushed: a.pushed,
        readCount: a.read_count,
        ackCount: a.ack_count,
        createdAt: a.created_at,
      })),
    });
  }

  // ---- who has not acknowledged an urgent one -----------------------------
  if (request.method === 'GET' && action === 'who') {
    if (!canManageAccounts(me)) return json({ error: 'EDITORS_CANNOT_ANNOUNCE' }, 403);
    const id = clean(url.searchParams.get('id'), 64);
    const rows = await sql`
      SELECT n.username, n.read_at, n.acked_at, u.display_name
      FROM notifications n JOIN users u ON u.username = n.username
      WHERE n.announcement_id = ${id}
      ORDER BY u.display_name`;
    return json({
      people: rows.map((r) => ({
        username: r.username,
        displayName: r.display_name || r.username,
        read: Boolean(r.read_at),
        acked: Boolean(r.acked_at),
      })),
    });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
