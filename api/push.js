import { sortRecipients } from '../lib/notifyprefs.js';
import { getSql, json, noDatabase, hasDatabase, requestUrl, toBuffer } from '../lib/db.js';
import { currentUser, canManageAccounts } from '../lib/auth.js';
import { isDepartment, expandAccess } from '../lib/departments.js';
import { publicKey, sendToUser, sendToMany, unreadCount, SUBJECT_IN_USE } from '../lib/push.js';
import { safeUrl } from '../lib/scope.js';
import {
  REPEATS, MAX_IMAGE, MAX_LIVE, canManagePopups,
  readPopup, shapePopup, pickForViewer, addPopup, editPopup, statsFor, readImage,
} from '../lib/popup.js';
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
 *
 *   GET    /api/push?do=popup         the pop-up to show me now, if any
 *   GET    /api/push?do=popup-image   its picture
 *   POST   /api/push?do=popup-seen    I have seen it (and whether I followed the link)
 *   GET    /api/push?do=popups        admin / co-admin: all of them, with who saw each
 *   POST   /api/push?do=popup-save    make one or change one
 *   DELETE /api/push?do=popup-delete  remove one
 */

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const hostOf = (endpoint) => {
  try { return new URL(endpoint).host; } catch (e) { return 'unknown'; }
};
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
    /**
     * The people IN those departments — not everyone who can SEE them.
     *
     * This used to add everybody with "ทุกฝ่าย" access as well, on the theory
     * that an announcement to one ฝ่าย is committee business the directors
     * should see. In practice it meant every notice a sub-department sent went
     * to the whole board: ต๊อดติ sent one to อำนวยการ 1–3 and it reached the
     * project director, both deputies, two assistants and the secretaries.
     * Access is about what you may read; it is not a standing subscription to
     * everything. Whoever wants the board as well now ticks the box for it,
     * which is `includeAll` below.
     */
    const includeAll = Boolean(audience.includeAll);
    const rows = await sql`
      SELECT DISTINCT u.username FROM users u
      LEFT JOIN user_departments d ON d.username = u.username
      WHERE u.active = true AND u.suspended = false
        AND (d.department = ANY(${keys})
             OR (${includeAll} AND u.all_departments = true))`;
    return rows.map((r) => r.username);
  }

  /**
   * Everybody whose access is "ทุกฝ่าย" — the board and the secretaries.
   *
   * Their own kind of audience, because they belong to no department and so
   * cannot be reached by ticking departments at all: the roster gives them
   * "All" instead of a ฝ่าย, which leaves them with no grants to match.
   */
  if (kind === 'board') {
    const rows = await sql`
      SELECT username FROM users
      WHERE active = true AND suspended = false AND all_departments = true`;
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
  if (kind === 'board') return 'board';
  if (kind === 'departments') {
    return `departments:${(audience.departments || []).join('+')}` +
      (audience.includeAll ? '+board' : '');
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

    /**
     * When a test fails, the reason matters more than the failure. Apple and
     * Google say exactly what was wrong with the request, and that sentence is
     * handed straight back to the person rather than flattened into
     * "something went wrong".
     */
    if (!result.sent) {
      const registered = await sql`
        SELECT count(*)::int AS n FROM push_subscriptions WHERE username = ${me.username}`;
      return json({
        error: registered[0].n ? 'PUSH_REFUSED' : 'NO_DEVICE',
        devices: registered[0].n,
        pushEnabled: me.push_enabled !== false,
        errors: result.errors || [],
        subject: SUBJECT_IN_USE,
      }, 409);
    }
    return json({ ok: true, ...result });
  }

  // ---- what is actually going on with this person's devices ---------------
  if (request.method === 'GET' && action === 'diagnose') {
    const subs = await sql`
      SELECT endpoint, user_agent, created_at, last_ok_at, fail_count, last_error
      FROM push_subscriptions WHERE username = ${me.username} ORDER BY created_at`;
    return json({
      pushEnabled: me.push_enabled !== false,
      subject: SUBJECT_IN_USE,
      devices: subs.map((s) => ({
        service: hostOf(s.endpoint),
        userAgent: s.user_agent,
        registeredAt: s.created_at,
        lastDeliveredAt: s.last_ok_at,
        failures: s.fail_count,
        lastError: s.last_error,
      })),
    });
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

    /**
     * Each person's announcement setting — except for an urgent one, which
     * reaches everybody out loud: that is what urgent is for, and the people
     * who may send one are few.
     */
    const heard = await sortRecipients(sql, names, { category: 'announce', force: level === 'urgent' });
    const reachable = heard.loud.concat(heard.quiet);

    // Written to the bell first, so the message survives even for people whose
    // phone never receives the push.
    for (const username of reachable) {
      await sql`
        INSERT INTO notifications (id, username, task_id, kind, title, body, level, announcement_id)
        VALUES (${newId('n')}, ${username}, ${null}, ${'announce'}, ${title}, ${text},
                ${level}, ${id})`;
    }

    const rows = await sql`
      SELECT username, id FROM notifications WHERE announcement_id = ${id}`;
    const idFor = Object.fromEntries(rows.map((r) => [r.username, r.id]));

    const from = me.display_name || me.username;
    const result = await sendToMany(sql, heard.loud, (username) => ({
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


  // -------------------------------------------------------------------------
  // The pop-up that greets people when they open the app
  // -------------------------------------------------------------------------

  /**
   * What to show me right now, if anything.
   *
   * Called on every app load, so it is deliberately cheap: one query for the
   * live pop-ups, one for what I have already seen, and no image bytes — the
   * picture is fetched separately only once a box is actually going to be
   * drawn.
   */
  if (request.method === 'GET' && action === 'popup') {
    const live = await sql`
      SELECT id, title, body, image_mime, image_w, image_h, link_url, link_label,
             audience, repeat_mode, starts_at, ends_at, active, created_by, created_at
        FROM popups
       WHERE active = true
         AND (starts_at IS NULL OR starts_at <= now())
         AND (ends_at IS NULL OR ends_at > now())
       ORDER BY created_at DESC
       LIMIT ${MAX_LIVE * 2}`;

    if (!live.length) return json({ popup: null });

    /**
     * The audience is checked per pop-up rather than in SQL, because
     * resolveAudience already knows how to expand a department umbrella and
     * a circle, and having two implementations of "who does this reach" is
     * how the announcement bug of 11 October happened.
     */
    const mine = [];
    for (const row of live) {
      let audience;
      try { audience = JSON.parse(row.audience); } catch { audience = { kind: 'everyone' }; }
      if ((audience?.kind || 'everyone') === 'everyone') { mine.push(row); continue; }
      const names = await resolveAudience(sql, audience);
      if (names.includes(me.username)) mine.push(row);
    }
    if (!mine.length) return json({ popup: null });

    const seenRows = await sql`
      SELECT popup_id, on_day FROM popup_seen
       WHERE username = ${me.username} AND popup_id = ANY(${mine.map((r) => r.id)})`;
    const seen = {};
    for (const r of seenRows) seen[r.popup_id] = r;

    const [{ today }] = await sql`SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS today`;
    const pick = pickForViewer(mine, seen, today);
    return json({ popup: pick ? shapePopup(pick) : null });
  }

  /** The poster. Signed-in only, and never cached by anything in between. */
  if (request.method === 'GET' && action === 'popup-image') {
    const [row] = await sql`
      SELECT image, image_mime FROM popups WHERE id = ${clean(url.searchParams.get('id'), 64)}`;
    if (!row || !row.image_mime) return json({ error: 'NO_IMAGE' }, 404);
    const bytes = toBuffer(row.image);
    return new Response(bytes, {
      headers: {
        'content-type': row.image_mime,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=600',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  /**
   * "I have seen it."
   *
   * Written when the box is dismissed rather than when it is drawn, so a
   * pop-up that appeared for half a second while somebody was navigating
   * away is not counted as read — and, more importantly, is shown again next
   * time, which is what the author intended.
   */
  if (request.method === 'POST' && action === 'popup-seen') {
    const body = await request.json().catch(() => ({}));
    const id = clean(body.id, 64);
    if (!id) return json({ error: 'ID_REQUIRED' }, 400);

    await sql`
      INSERT INTO popup_seen (popup_id, username, clicked)
      VALUES (${id}, ${me.username}, ${Boolean(body.clicked)})
      ON CONFLICT (popup_id, username) DO UPDATE
        SET at = now(),
            on_day = (now() AT TIME ZONE 'Asia/Bangkok')::date,
            -- Once somebody has followed the link, that stays true: a second
            -- dismissal without clicking does not un-click the first.
            clicked = popup_seen.clicked OR EXCLUDED.clicked`;
    return json({ ok: true });
  }

  // ---- managing them ------------------------------------------------------
  if (action === 'popups' || action === 'popup-save' || action === 'popup-delete') {
    if (!canManagePopups(me)) return json({ error: 'EDITORS_CANNOT_ANNOUNCE' }, 403);

    if (request.method === 'GET' && action === 'popups') {
      const rows = await sql`
        SELECT id, title, body, image_mime, image_w, image_h, link_url, link_label,
               audience, repeat_mode, starts_at, ends_at, active, created_by, created_at
          FROM popups ORDER BY created_at DESC LIMIT 100`;
      const out = [];
      for (const row of rows) {
        out.push(shapePopup(row, { forAdmin: true, stats: await statsFor(sql, row.id) }));
      }
      const [{ live }] = await sql`
        SELECT count(*)::int AS live FROM popups
         WHERE active = true AND (ends_at IS NULL OR ends_at > now())`;
      return json({
        popups: out,
        repeats: REPEATS,
        maxLive: MAX_LIVE,
        maxImage: MAX_IMAGE,
        liveNow: Number(live),
        // How many people could see it at all, so the shown/total figure means something.
        people: (await sql`
          SELECT count(*)::int AS n FROM users WHERE active = true AND suspended = false`)[0].n,
      });
    }

    if (request.method === 'POST' && action === 'popup-save') {
      const body = await request.json().catch(() => ({}));
      const id = clean(body.id, 64);

      const existing = id
        ? (await sql`SELECT * FROM popups WHERE id = ${id}`)[0]
        : null;
      if (id && !existing) return json({ error: 'NO_SUCH_POPUP' }, 404);

      const read = readPopup(body, { existing, safeUrl });
      if (read.error) return json({ error: read.error }, 400);
      if (!read.popup.body && body.image === undefined && !existing?.image_mime) {
        // A heading with nothing under it is worse than no pop-up at all.
        return json({ error: 'NEEDS_WORDS_OR_PICTURE' }, 400);
      }

      /** `image: null` removes the poster; omitting it leaves the existing one. */
      let image;
      if (body.image === null) image = null;
      else if (body.image !== undefined) {
        const got = readImage(body.image);
        if (got.error) return json({ error: got.error, limit: MAX_IMAGE }, 400);
        image = got;
      }

      const audience = body.audience === undefined ? null : (body.audience || { kind: 'everyone' });
      if (audience) {
        // Refused now rather than discovered later by an admin wondering why
        // their notice reached nobody.
        const names = await resolveAudience(sql, audience);
        if (!names.length) return json({ error: 'NO_RECIPIENTS' }, 400);
      }

      const done = existing
        ? await editPopup(sql, existing, read.popup, audience, image)
        : await addPopup(sql, me, read.popup, audience || { kind: 'everyone' }, image);
      if (done.error) return json({ error: done.error, limit: MAX_LIVE }, 400);

      /**
       * Editing the WORDS of a notice people have already seen does not show
       * it to them again — but changing it into a different notice should, so
       * `resetSeen` clears the record on request. Deliberately a choice the
       * admin makes rather than something inferred from what changed: only
       * they know whether a correction is worth interrupting people twice.
       */
      if (existing && body.resetSeen) {
        await sql`DELETE FROM popup_seen WHERE popup_id = ${existing.id}`;
      }

      return json({
        popup: shapePopup(done.popup, { forAdmin: true, stats: await statsFor(sql, done.popup.id) }),
      }, existing ? 200 : 201);
    }

    if (request.method === 'DELETE' && action === 'popup-delete') {
      const id = clean(url.searchParams.get('id'), 64);
      const [row] = await sql`SELECT id FROM popups WHERE id = ${id}`;
      if (!row) return json({ error: 'NO_SUCH_POPUP' }, 404);
      await sql`DELETE FROM popups WHERE id = ${id}`;
      return json({ ok: true, deleted: id });
    }
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
