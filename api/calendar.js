import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { withNode } from '../lib/http.js';
import { buildIcs } from '../lib/ics.js';
import { assembledEvents, canSeeEvent } from './events.js';
import { assembleMeetings } from '../lib/meetingstore.js';
import { canSeeMeeting } from '../lib/meeting.js';
import { isSecretary } from '../lib/approval.js';
import { accessSet } from '../lib/scope.js';
import { currentUser } from '../lib/auth.js';
import {
  handleSchedule, publicHost, publicSlots, bookAsGuest, cancelAsGuest, tellOwner,
  officeHoursOf, nowLocal, addDays, GUEST_PURPOSE, GUEST_NAME_MAX,
} from '../lib/schedule.js';
import { issueCode, checkCode, cleanEmail, EMAIL_SHAPE } from '../lib/signup.js';
import { mailConfigured, sendMail } from '../lib/mail.js';
import { siteUrl } from '../lib/line.js';

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

  /**
   * The public office-hours page: /api/calendar?book=<token>
   *
   * Deliberately NOT signed in — the whole point is somebody outside the
   * committee. Everything it can answer is in lib/schedule.js, which also
   * explains what such a visitor is and is not allowed to know.
   */
  if (url.searchParams.get('book')) return publicBooking(request, url, sql);
  if (url.searchParams.get('unbook')) return publicCancel(request, url, sql);

  /**
   * The personal schedule, office hours and Google link — signed-in, cookie
   * authenticated, and nothing to do with the token feed below. They share
   * this function because the Hobby plan's twelve are all spoken for.
   */
  if (url.searchParams.get('do')) {
    const me = await currentUser(request, sql);
    if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);
    try {
      return await handleSchedule(sql, me, request, url, json);
    } catch (error) {
      console.error('[schedule]', error);
      return json({ error: 'SERVER' }, 500);
    }
  }

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

  /**
   * Noted, at most once an hour: somebody's calendar is subscribed. Awaited,
   * because a serverless function may be frozen the moment it returns and an
   * unawaited write would sometimes never happen — but a failure is ignored,
   * since the feed is what Google is waiting for and matters more.
   */
  try {
    await sql`UPDATE users SET calendar_seen_at = now()
              WHERE username = ${owner.username}
                AND (calendar_seen_at IS NULL OR calendar_seen_at < now() - interval '1 hour')`;
  } catch (e) { /* the feed still goes out */ }

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

  /**
   * Meetings ride with the same feeds as events.
   *
   * They were missing altogether, so somebody could subscribe the committee's
   * calendar into Google and still have no sign of the meeting they were
   * expected at. 'mine' carries only the ones this person was actually
   * invited to — a calendar full of other people's meetings is noise.
   */
  const meetings = ['events', 'mine', 'all'].includes(scope)
    ? (await assembleMeetings(sql, everyone))
      .filter((m) => canSeeMeeting(owner, m, m.people, { isSecretary: isSecretary(owner) }))
      .filter((m) => scope !== 'mine' ||
        (m.people || []).some((p) => p.username === owner.username))
    : [];

  const who = owner.display_name || owner.sheet_name || owner.username;
  const NAMES = {
    mine: `จุฬาฯแฟร์ · งานของ ${who}`,
    dept: 'จุฬาฯแฟร์ · งานของฝ่าย',
    events: 'จุฬาฯแฟร์ · กิจกรรม',
    all: 'จุฬาฯแฟร์ · ทั้งหมด',
  };

  return new Response(buildIcs(tasks, NAMES[scope], nameOf, events, meetings), {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="fair-tasks.ics"',
      // Short cache: Google re-fetches on its own schedule anyway.
      'cache-control': 'public, max-age=600',
    },
  });
}

// ---------------------------------------------------------------------------
// Booking somebody's office hours without an account
// ---------------------------------------------------------------------------

/**
 * How a stranger is kept honest without being made to sign up.
 *
 * The only claim a visitor makes that anybody later relies on is their email
 * address, so that is the one thing checked: a six-digit code, the same
 * machinery members verify their own address with (lib/signup.js). Until the
 * code comes back, nothing is written to anybody's calendar — which is what
 * stops a bored stranger filling a ประธานฝ่าย's week with appointments that
 * reach nobody.
 *
 * Nothing here is told whether a name exists, what any other booking is, or
 * anything about the host beyond the name they chose to publish and the
 * hours they chose to open.
 */
const PUBLIC_DAYS = 21;
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

async function publicBooking(request, url, sql) {
  const token = String(url.searchParams.get('book') || '');
  const host = await publicHost(sql, token);
  // One answer for "no such page" and "switched off", so a retired address
  // tells nobody whether it was ever real.
  if (!host) return json({ error: 'NO_SUCH_PAGE' }, 404);

  const who = {
    name: host.display_name || host.username,
    nickname: host.nickname || '',
    position: host.position || '',
  };
  const action = url.searchParams.get('do') || '';

  if (request.method === 'GET') {
    const fromOn = nowLocal().on;
    const toOn = addDays(fromOn, PUBLIC_DAYS - 1);
    return json({
      host: who, fromOn, toOn,
      windows: (await officeHoursOf(sql, host.username)).map((w) => ({ day: w.day, from: w.from, to: w.to, slot: w.slot, place: w.place })),
      slots: await publicSlots(sql, host.username, fromOn, toOn),
      // Without mail configured there is no way to check an address, so the
      // page says so rather than taking bookings it cannot stand behind.
      canBook: mailConfigured(),
    });
  }

  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);
  const body = await request.json().catch(() => ({}));
  const email = cleanEmail(body.email);
  const name = clean(body.name, GUEST_NAME_MAX);
  if (!EMAIL_SHAPE.test(email)) return json({ error: 'BAD_EMAIL' }, 400);
  if (!name) return json({ error: 'NAME_REQUIRED' }, 400);
  if (!mailConfigured()) return json({ error: 'MAIL_NOT_CONFIGURED' }, 503);

  // ---- the code ----------------------------------------------------------
  if (action === 'code') {
    const got = await issueCode(sql, { purpose: GUEST_PURPOSE, subject: `${token}:${email}`, email });
    if (!got.ok) return json({ error: got.error, wait: got.wait }, got.error === 'CODE_TOO_SOON' ? 429 : 400);
    return json({ ok: true });
  }

  // ---- the booking -------------------------------------------------------
  if (action === 'confirm') {
    const checked = await checkCode(sql, { purpose: GUEST_PURPOSE, subject: `${token}:${email}`, email, code: body.code });
    if (!checked.ok) return json({ error: checked.error }, 400);

    const on = /^\d{4}-\d{2}-\d{2}$/.test(String(body.on || '')) ? String(body.on) : null;
    const at = /^\d{2}:\d{2}$/.test(String(body.at || '')) ? String(body.at) : null;
    if (!on || !at) return json({ error: 'BAD_TIME' }, 400);

    const made = await bookAsGuest(sql, host, { name, email, on, at, note: clean(body.note, 1000) });
    if (!made.ok) return json({ error: made.error }, 409);

    // Advertised address first, else the one the visitor is standing on.
    const site = siteUrl() || url.origin;
    const cancelUrl = `${site}/#/unbook/${made.guestToken}`;
    const when = `${made.slot.on} ${made.slot.at}–${made.slot.to}`;
    await sendMail({
      to: email,
      subject: `ยืนยันนัดหมาย ${when} / Appointment confirmed`,
      text:
        `นัดหมายกับ ${who.name} เรียบร้อยแล้ว\n` +
        `วันเวลา: ${when} น.\n` +
        (made.slot.place ? `สถานที่: ${made.slot.place}\n` : '') +
        (cancelUrl ? `\nถ้าต้องการยกเลิก เปิดลิงก์นี้: ${cancelUrl}\n` : '') +
        `\nYour appointment with ${who.name} is confirmed.\n${when}\n` +
        (cancelUrl ? `To cancel, open: ${cancelUrl}\n` : ''),
    });
    await tellOwner(sql, host.username, `นัดหมายใหม่ · ${when}`,
      `${name} (${email}) จองเวลา Office hour ของคุณ` + (body.note ? ' — ' + clean(body.note, 200) : ''));

    return json({ ok: true, slot: made.slot, cancelUrl, host: who }, 201);
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** The link in the guest's confirmation email. */
async function publicCancel(request, url, sql) {
  const token = String(url.searchParams.get('unbook') || '');
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);
  const done = await cancelAsGuest(sql, token);
  if (!done.ok) return json({ error: done.error }, 404);
  return json({ ok: true, on: done.on, at: done.at });
}

export default withNode(handler);
