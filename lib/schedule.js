/**
 * Personal schedules: appointments, office hours, bookings, and finding a
 * time that suits everybody.
 *
 *   GET    /api/calendar?do=schedule&from=&to=     my appointments, office hours, Google events
 *   POST   /api/calendar?do=appt                    a personal appointment or focus block
 *   DELETE /api/calendar?do=appt&id=…               cancel one (a booking: both sides)
 *   GET    /api/calendar?do=office&user=            someone's weekly office hours
 *   PUT    /api/calendar?do=office                  replace my office hours
 *   GET    /api/calendar?do=hosts                   who has office hours at all
 *   GET    /api/calendar?do=slots&host=&from=&to=   that person's open slots
 *   POST   /api/calendar?do=book                    take one
 *   POST   /api/calendar?do=find                    times when all of these people are free
 *   GET    /api/calendar?do=google                  is my Google Calendar connected
 *   POST   /api/calendar?do=google-sync             send my meetings and events to Google
 *   PATCH  /api/calendar?do=google                  settings (send meetings too?)
 *   DELETE /api/calendar?do=google                  disconnect
 *
 * Everything works in Bangkok wall time — a date and an HH:MM — because that
 * is what people type and read. Stored stamps carry +07:00 explicitly;
 * Thailand has no daylight saving, so the offset never changes.
 *
 * What other people see of your time is "busy" and nothing else. Titles,
 * places and notes stay with their owner.
 */
import { minutesOf, clockOf, isWeekday, weekdayOf, WEEKDAYS } from './availability.js';
import {
  googleEvents, putEvent, dropEvent, linkStatus, unlink, linkedAmong, isLinked, googleConfigured,
} from './googlecal.js';
import { sendToMany } from './push.js';
import { sortRecipients } from './notifyprefs.js';

export const APPT_KINDS = ['personal', 'focus', 'booking'];
export const SLOT_SIZES = [15, 20, 30, 45, 60, 90];
const MAX_RANGE_DAYS = 62;

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
const cleanTime = (v) => { const m = minutesOf(v); return m === null ? null : clockOf(m); };
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const toStamp = (on, at) => `${on}T${at}:00+07:00`;
export function fromStamp(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const t = new Date(d.getTime() + 7 * 3600000).toISOString();
  return { on: t.slice(0, 10), at: t.slice(11, 16) };
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysIn(fromOn, toOn) {
  const out = [];
  for (let d = fromOn; d <= toOn && out.length <= MAX_RANGE_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}
const isoDay = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return [v.getFullYear(), String(v.getMonth() + 1).padStart(2, '0'), String(v.getDate()).padStart(2, '0')].join('-');
};
/** Bangkok's today, and its clock as minutes. */
export function nowLocal(now = new Date()) {
  const { on, at } = fromStamp(now);
  return { on, minutes: minutesOf(at) };
}

/** A from/to pair read from the query, bounded. */
function readRange(url, fallbackDays = 7) {
  const today = nowLocal().on;
  const fromOn = cleanDate(url.searchParams.get('from')) || today;
  let toOn = cleanDate(url.searchParams.get('to')) || addDays(fromOn, fallbackDays - 1);
  if (toOn < fromOn) toOn = fromOn;
  if (daysIn(fromOn, toOn).length > MAX_RANGE_DAYS) toOn = addDays(fromOn, MAX_RANGE_DAYS - 1);
  return { fromOn, toOn };
}

/* ---- appointments ------------------------------------------------------ */

function shapeAppt(r, viewer) {
  const s = fromStamp(r.starts_at);
  const e = fromStamp(r.ends_at);
  return {
    id: r.id, kind: r.kind, title: r.title, note: r.note || '', place: r.place || '',
    on: s.on, at: s.at, toOn: e.on, to: e.at,
    with: r.with_user || null, bookingId: r.booking_id || null,
    mine: r.owner === viewer, createdBy: r.created_by,
  };
}

export async function appointmentsOf(sql, username, fromOn, toOn) {
  const rows = await sql`
    SELECT * FROM appointments
    WHERE owner = ${username}
      AND starts_at < ${toStamp(addDays(toOn, 1), '00:00')}::timestamptz
      AND ends_at   > ${toStamp(fromOn, '00:00')}::timestamptz
    ORDER BY starts_at`;
  return rows.map((r) => shapeAppt(r, username));
}

/** Reads { on, at, to } and checks it makes sense. */
function readSpan(body) {
  const on = cleanDate(body.on);
  const at = cleanTime(body.at);
  const to = cleanTime(body.to);
  if (!on) return { error: 'DATE_REQUIRED' };
  if (!at || !to) return { error: 'BAD_TIME' };
  if (minutesOf(to) <= minutesOf(at)) return { error: 'ENDS_BEFORE_IT_STARTS' };
  return { on, at, to };
}

async function addAppointment(sql, me, body, json) {
  const kind = body.kind === 'focus' ? 'focus' : 'personal';
  const span = readSpan(body);
  if (span.error) return json({ error: span.error }, 400);
  const title = clean(body.title, 200) || (kind === 'focus' ? 'โฟกัส' : 'นัดส่วนตัว');
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM appointments WHERE owner = ${me.username} AND ends_at > now()`;
  if (n >= 500) return json({ error: 'TOO_MANY_APPOINTMENTS' }, 400);

  const id = newId('ap');
  await sql`
    INSERT INTO appointments (id, owner, kind, title, note, place, starts_at, ends_at, created_by)
    VALUES (${id}, ${me.username}, ${kind}, ${title}, ${clean(body.note, 2000)}, ${clean(body.place, 200)},
            ${toStamp(span.on, span.at)}::timestamptz, ${toStamp(span.on, span.to)}::timestamptz, ${me.username})`;
  if (await isLinked(sql, me.username)) {
    try { await putEvent(sql, me.username, { kind: 'appt', id, title, on: span.on, at: span.at, to: span.to,
      place: clean(body.place, 200), note: clean(body.note, 2000) }); } catch { /* the page still has it */ }
  }
  return json({ ok: true, id }, 201);
}

async function removeAppointment(sql, me, id, json) {
  const [row] = await sql`SELECT * FROM appointments WHERE id = ${clean(id, 64)}`;
  if (!row) return json({ error: 'NO_SUCH_APPOINTMENT' }, 404);
  if (row.owner !== me.username) return json({ error: 'NOT_YOUR_APPOINTMENT' }, 403);

  // A booking belongs to two people; cancelling it cancels it for both.
  const rows = row.booking_id
    ? await sql`DELETE FROM appointments WHERE booking_id = ${row.booking_id} RETURNING *`
    : await sql`DELETE FROM appointments WHERE id = ${row.id} RETURNING *`;
  for (const r of rows) {
    try { if (await isLinked(sql, r.owner)) await dropEvent(sql, r.owner, 'appt', r.id); } catch { /* best effort */ }
  }
  if (row.booking_id) {
    const other = rows.find((r) => r.owner !== me.username);
    if (other) {
      const when = fromStamp(row.starts_at);
      await tell(sql, other.owner, me, 'booking',
        `ยกเลิกนัดหมาย · ${when.on} ${when.at}`,
        `${me.display_name || me.username} ยกเลิกนัดหมายนี้แล้ว`);
    }
  }
  return json({ ok: true, removed: rows.map((r) => r.id) });
}

/** One notice in the bell, and out loud if their settings allow. */
async function tell(sql, username, actor, kind, title, body) {
  if (!username || username === actor.username) return;
  const { loud, quiet } = await sortRecipients(sql, [username], { category: 'event' });
  const to = loud.concat(quiet);
  if (!to.length) return;
  const id = newId('n');
  await sql`INSERT INTO notifications (id, username, kind, title, body) VALUES (${id}, ${username}, ${kind}, ${title}, ${body})`;
  if (loud.length) {
    try { await sendToMany(sql, loud, () => ({ id, title, body, level: 'normal', tag: `booking-${id}`, url: '/#/schedule' })); }
    catch { /* the bell still has it */ }
  }
}

/* ---- office hours ------------------------------------------------------ */

export async function officeHoursOf(sql, username) {
  const rows = await sql`SELECT * FROM office_hours WHERE owner = ${username}`;
  return rows
    .map((r) => ({ id: r.id, day: r.weekday, from: r.from_at, to: r.to_at, slot: Number(r.slot_min) || 30,
      place: r.place || '', note: r.note || '' }))
    .sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day) || a.from.localeCompare(b.from));
}

export function readOfficeWindow(raw = {}) {
  const day = clean(raw.day, 3).toLowerCase();
  if (!isWeekday(day)) return { error: 'BAD_DAY' };
  const from = cleanTime(raw.from);
  const to = cleanTime(raw.to);
  if (!from || !to) return { error: 'BAD_TIME' };
  if (minutesOf(to) <= minutesOf(from)) return { error: 'ENDS_BEFORE_IT_STARTS' };
  const slot = SLOT_SIZES.includes(Number(raw.slot)) ? Number(raw.slot) : 30;
  if (minutesOf(to) - minutesOf(from) < slot) return { error: 'WINDOW_TOO_SHORT' };
  return { window: { day, from, to, slot, place: clean(raw.place, 200), note: clean(raw.note, 300) } };
}

async function setOfficeHours(sql, me, body, json) {
  const list = Array.isArray(body.windows) ? body.windows : [];
  if (list.length > 30) return json({ error: 'TOO_MANY_WINDOWS' }, 400);
  const wanted = [];
  for (const raw of list) {
    const got = readOfficeWindow(raw);
    if (got.error) return json({ error: got.error, at: raw }, 400);
    wanted.push(got.window);
  }
  await sql`DELETE FROM office_hours WHERE owner = ${me.username}`;
  for (const w of wanted) {
    await sql`
      INSERT INTO office_hours (id, owner, weekday, from_at, to_at, slot_min, place, note)
      VALUES (${newId('oh')}, ${me.username}, ${w.day}, ${w.from}, ${w.to}, ${w.slot}, ${w.place}, ${w.note})`;
  }
  return json({ ok: true, windows: await officeHoursOf(sql, me.username) });
}

/** Office-hour windows laid onto actual dates. */
export function expandOffice(windows, fromOn, toOn) {
  const out = [];
  for (const on of daysIn(fromOn, toOn)) {
    const wd = weekdayOf(on);
    for (const w of windows) if (w.day === wd) out.push({ on, at: w.from, to: w.to, slot: w.slot, place: w.place, note: w.note });
  }
  return out;
}

/* ---- busy -------------------------------------------------------------- */

/**
 * When each of these people is taken, as minutes on each date:
 *   { username: [{ on, from, to, kind }] }
 *
 * Meetings they have not declined, timed events they are on, their own
 * appointments and bookings, days they marked themselves away, and — for
 * anybody who connected Google — their Google events. Deadlines are not
 * busy: a task due at 14:00 does not stop somebody meeting at 14:00.
 */
export async function busyOf(sql, usernames, fromOn, toOn, { google = true } = {}) {
  const out = {};
  for (const u of usernames) out[u] = [];
  if (!usernames.length) return out;
  const push = (u, on, from, to, kind) => {
    if (!out[u] || from === null || to === null || to <= from) return;
    if (on < fromOn || on > toOn) return;
    out[u].push({ on, from, to, kind });
  };

  const meetings = await sql`
    SELECT m.meets_on, m.meets_at, m.ends_at, p.username
    FROM meetings m JOIN meeting_people p ON p.meeting_id = m.id
    WHERE p.username = ANY(${usernames}) AND p.reply <> 'declined' AND m.status = 'planned'
      AND m.meets_at IS NOT NULL AND m.meets_on BETWEEN ${fromOn}::date AND ${toOn}::date`;
  for (const m of meetings) {
    const from = minutesOf(m.meets_at);
    const to = minutesOf(m.ends_at) ?? (from === null ? null : Math.min(1440, from + 60));
    push(m.username, isoDay(m.meets_on), from, to, 'meeting');
  }

  const events = await sql`
    SELECT e.starts_on, e.ends_on, e.starts_at, e.ends_at, p.username
    FROM events e JOIN event_people p ON p.event_id = e.id
    WHERE p.username = ANY(${usernames}) AND e.all_day = false AND e.starts_at IS NOT NULL
      AND e.starts_on <= ${toOn}::date AND COALESCE(e.ends_on, e.starts_on) >= ${fromOn}::date`;
  for (const e of events) {
    const a = isoDay(e.starts_on);
    const b = isoDay(e.ends_on) || a;
    const from = minutesOf(e.starts_at);
    const to = minutesOf(e.ends_at) ?? (from === null ? null : Math.min(1440, from + 60));
    if (a === b) { push(e.username, a, from, to, 'event'); continue; }
    for (const on of daysIn(a, b)) push(e.username, on, on === a ? from : 0, on === b ? (to ?? 1440) : 1440, 'event');
  }

  const appts = await sql`
    SELECT owner, kind, starts_at, ends_at FROM appointments
    WHERE owner = ANY(${usernames})
      AND starts_at < ${toStamp(addDays(toOn, 1), '00:00')}::timestamptz
      AND ends_at   > ${toStamp(fromOn, '00:00')}::timestamptz`;
  for (const r of appts) {
    const s = fromStamp(r.starts_at);
    const e = fromStamp(r.ends_at);
    if (s.on === e.on) push(r.owner, s.on, minutesOf(s.at), minutesOf(e.at), r.kind === 'booking' ? 'booking' : 'appt');
    else for (const on of daysIn(s.on, e.on)) push(r.owner, on, on === s.on ? minutesOf(s.at) : 0, on === e.on ? minutesOf(e.at) : 1440, 'appt');
  }

  const blocks = await sql`
    SELECT username, from_on, to_on, from_at, to_at FROM user_blocks
    WHERE username = ANY(${usernames}) AND from_on <= ${toOn}::date AND to_on >= ${fromOn}::date`;
  for (const b of blocks) {
    const a = isoDay(b.from_on);
    const z = isoDay(b.to_on);
    for (const on of daysIn(a, z)) {
      push(b.username, on, b.from_at && on === a ? minutesOf(b.from_at) : 0,
        b.to_at && on === z ? minutesOf(b.to_at) : 1440, 'away');
    }
  }

  if (google) {
    for (const u of await linkedAmong(sql, usernames)) {
      try {
        const got = await googleEvents(sql, u, fromOn, toOn, { titles: false });
        for (const ev of got.events) {
          if (!ev.at) continue; // all-day Google events read as notes, not busy
          if (ev.on === ev.toOn || !ev.toOn) push(u, ev.on, minutesOf(ev.at), minutesOf(ev.to) || 1440, 'google');
          else for (const on of daysIn(ev.on, ev.toOn)) push(u, on, on === ev.on ? minutesOf(ev.at) : 0, on === ev.toOn ? minutesOf(ev.to) : 1440, 'google');
        }
      } catch { /* their calendar being unreachable is not a reason to fail */ }
    }
  }
  for (const u of usernames) out[u].sort((x, y) => (x.on < y.on ? -1 : x.on > y.on ? 1 : x.from - y.from));
  return out;
}

const clashes = (list, on, from, to) => list.some((b) => b.on === on && b.from < to && from < b.to);

/* ---- booking office hours --------------------------------------------- */

export async function freeSlots(sql, host, fromOn, toOn, now = new Date()) {
  const windows = await officeHoursOf(sql, host);
  if (!windows.length) return [];
  const busy = (await busyOf(sql, [host], fromOn, toOn))[host];
  const here = nowLocal(now);
  const out = [];
  for (const w of expandOffice(windows, fromOn, toOn)) {
    const a = minutesOf(w.at);
    const z = minutesOf(w.to);
    for (let m = a; m + w.slot <= z; m += w.slot) {
      // Nothing that starts within the next half hour: nobody can get there.
      if (w.on < here.on || (w.on === here.on && m < here.minutes + 30)) continue;
      if (clashes(busy, w.on, m, m + w.slot)) continue;
      out.push({ on: w.on, at: clockOf(m), to: clockOf(m + w.slot), place: w.place });
    }
  }
  return out;
}

async function book(sql, me, body, json) {
  const host = clean(body.host, 64);
  if (!host) return json({ error: 'HOST_REQUIRED' }, 400);
  if (host === me.username) return json({ error: 'CANNOT_BOOK_YOURSELF' }, 400);
  const on = cleanDate(body.on);
  const at = cleanTime(body.at);
  if (!on || !at) return json({ error: 'BAD_TIME' }, 400);
  const [hostRow] = await sql`SELECT username, display_name FROM users WHERE username = ${host} AND active = true AND suspended = false`;
  if (!hostRow) return json({ error: 'NO_SUCH_USER' }, 404);

  const slot = (await freeSlots(sql, host, on, on)).find((s) => s.at === at);
  if (!slot) return json({ error: 'SLOT_TAKEN' }, 409);

  const bookingId = newId('bk');
  const note = clean(body.note, 1000);
  const guestName = me.display_name || me.username;
  const hostName = hostRow.display_name || host;
  const hostId = newId('ap');
  const guestId = newId('ap');
  await sql`
    INSERT INTO appointments (id, owner, kind, title, note, place, starts_at, ends_at, with_user, booking_id, created_by)
    VALUES (${hostId}, ${host}, 'booking', ${'นัดหมาย · ' + guestName}, ${note}, ${slot.place},
            ${toStamp(on, slot.at)}::timestamptz, ${toStamp(on, slot.to)}::timestamptz, ${me.username}, ${bookingId}, ${me.username}),
           (${guestId}, ${me.username}, 'booking', ${'นัดหมาย · ' + hostName}, ${note}, ${slot.place},
            ${toStamp(on, slot.at)}::timestamptz, ${toStamp(on, slot.to)}::timestamptz, ${host}, ${bookingId}, ${me.username})`;

  // Two people pressing the same slot at once: the later one gives way.
  const [{ n }] = await sql`
    SELECT count(DISTINCT booking_id)::int AS n FROM appointments
    WHERE owner = ${host} AND kind = 'booking'
      AND starts_at < ${toStamp(on, slot.to)}::timestamptz AND ends_at > ${toStamp(on, slot.at)}::timestamptz`;
  if (n > 1) {
    await sql`DELETE FROM appointments WHERE booking_id = ${bookingId}`;
    return json({ error: 'SLOT_TAKEN' }, 409);
  }

  await tell(sql, host, me, 'booking', `นัดหมายใหม่ · ${on} ${slot.at}–${slot.to}`,
    `${guestName} จองเวลา Office hour ของคุณ${note ? ' — ' + note : ''}`);
  for (const [owner, id, title] of [[host, hostId, 'นัดหมาย · ' + guestName], [me.username, guestId, 'นัดหมาย · ' + hostName]]) {
    try {
      if (await isLinked(sql, owner)) await putEvent(sql, owner, { kind: 'appt', id, title, on, at: slot.at, to: slot.to, place: slot.place, note });
    } catch { /* best effort */ }
  }
  return json({ ok: true, bookingId, slot: { on, at: slot.at, to: slot.to, place: slot.place } }, 201);
}

/* ---- finding a time ---------------------------------------------------- */

/**
 * Times when everybody asked is free, Outlook's scheduling assistant style.
 *
 * Walks the days in steps, skipping anything that would start in the past,
 * and returns the slots where nobody is busy — or, when there are none, the
 * ones where the fewest are. Stated weekly availability counts: a slot
 * outside someone's stated hours is "outside hours" rather than free.
 * Alongside, each person's busy blocks for the range, as bars to draw.
 */
export async function findTimes(sql, me, body, now = new Date()) {
  const people = [...new Set([me.username, ...(Array.isArray(body.people) ? body.people : [])
    .map((p) => clean(p, 64)).filter(Boolean)])].slice(0, 40);
  const fromOn = cleanDate(body.fromOn) || nowLocal(now).on;
  let toOn = cleanDate(body.toOn) || addDays(fromOn, 6);
  if (toOn < fromOn) toOn = fromOn;
  if (daysIn(fromOn, toOn).length > 21) toOn = addDays(fromOn, 20);
  const duration = Math.max(15, Math.min(480, Math.round(Number(body.duration) || 60)));
  const dayFrom = minutesOf(body.dayFrom) ?? 8 * 60;
  const dayTo = minutesOf(body.dayTo) ?? 20 * 60;
  const step = [15, 30, 60].includes(Number(body.step)) ? Number(body.step) : 30;
  const skipWeekends = body.weekends !== true;

  const busy = await busyOf(sql, people, fromOn, toOn);
  const windows = await sql`SELECT username, weekday, from_at, to_at FROM user_availability WHERE username = ANY(${people})`;
  const hours = {};
  for (const w of windows) (hours[w.username] ||= []).push({ day: w.weekday, from: minutesOf(w.from_at), to: minutesOf(w.to_at) });

  const here = nowLocal(now);
  const slots = [];
  for (const on of daysIn(fromOn, toOn)) {
    const wd = weekdayOf(on);
    if (skipWeekends && (wd === 'sat' || wd === 'sun')) continue;
    for (let m = dayFrom; m + duration <= dayTo; m += step) {
      if (on < here.on || (on === here.on && m < here.minutes + 15)) continue;
      const taken = [];
      const outside = [];
      for (const u of people) {
        if (clashes(busy[u], on, m, m + duration)) { taken.push(u); continue; }
        const mine = hours[u];
        if (mine && mine.length && !mine.some((w) => w.day === wd && w.from <= m && m + duration <= w.to)) outside.push(u);
      }
      slots.push({ on, at: clockOf(m), to: clockOf(m + duration), busy: taken, outside });
    }
  }
  const score = (s) => s.busy.length * 10 + s.outside.length;
  const free = slots.filter((s) => !s.busy.length && !s.outside.length);
  // Up to eight a day, so a week's answer shows the whole week, not Monday morning.
  const perDay = {};
  const spread = free.filter((x) => { perDay[x.on] = (perDay[x.on] || 0) + 1; return perDay[x.on] <= 8; }).slice(0, 60);
  const best = free.length ? spread
    : slots.slice().sort((a, b) => score(a) - score(b) || (a.on < b.on ? -1 : a.on > b.on ? 1 : a.at.localeCompare(b.at))).slice(0, 8);
  return {
    people, fromOn, toOn, duration,
    allFree: free.length > 0,
    slots: best,
    busy,
    google: await linkedAmong(sql, people),
  };
}

/* ---- the endpoint ------------------------------------------------------ */

export async function handleSchedule(sql, me, request, url, json) {
  const action = url.searchParams.get('do');
  const method = request.method;
  const body = method === 'GET' || method === 'DELETE' ? {} : await request.json().catch(() => ({}));

  if (action === 'schedule' && method === 'GET') {
    const { fromOn, toOn } = readRange(url, 7);
    const status = await linkStatus(sql, me.username);
    let google = [];
    let googleOk = null;
    if (status.linked && googleConfigured()) {
      const got = await googleEvents(sql, me.username, fromOn, toOn);
      google = got.events;
      googleOk = got.ok;
    }
    const office = await officeHoursOf(sql, me.username);
    return json({
      fromOn, toOn,
      appointments: await appointmentsOf(sql, me.username, fromOn, toOn),
      officeHours: office,
      officeDays: expandOffice(office, fromOn, toOn),
      google, googleOk, googleStatus: status,
    });
  }

  if (action === 'appt' && method === 'POST') return addAppointment(sql, me, body, json);
  if (action === 'appt' && method === 'DELETE') return removeAppointment(sql, me, url.searchParams.get('id'), json);

  if (action === 'office' && method === 'GET') {
    const who = clean(url.searchParams.get('user'), 64) || me.username;
    return json({ username: who, windows: await officeHoursOf(sql, who) });
  }
  if (action === 'office' && (method === 'PUT' || method === 'POST')) return setOfficeHours(sql, me, body, json);

  if (action === 'hosts' && method === 'GET') {
    const rows = await sql`
      SELECT o.owner AS username, count(*)::int AS windows FROM office_hours o
      JOIN users u ON u.username = o.owner AND u.active = true AND u.suspended = false
      GROUP BY o.owner ORDER BY o.owner`;
    return json({ hosts: rows.map((r) => ({ username: r.username, windows: r.windows })) });
  }
  if (action === 'slots' && method === 'GET') {
    const host = clean(url.searchParams.get('host'), 64);
    if (!host) return json({ error: 'HOST_REQUIRED' }, 400);
    const { fromOn, toOn } = readRange(url, 14);
    return json({ host, fromOn, toOn, windows: await officeHoursOf(sql, host),
      slots: await freeSlots(sql, host, fromOn, toOn) });
  }
  if (action === 'book' && method === 'POST') return book(sql, me, body, json);
  if (action === 'find' && method === 'POST') return json(await findTimes(sql, me, body));

  if (action === 'google' && method === 'GET') return json(await linkStatus(sql, me.username));
  if (action === 'google' && method === 'PATCH') {
    await sql`UPDATE google_links SET push_events = ${Boolean(body.pushEvents)} WHERE username = ${me.username}`;
    return json(await linkStatus(sql, me.username));
  }
  if (action === 'google' && method === 'DELETE') {
    await unlink(sql, me.username);
    return json(await linkStatus(sql, me.username));
  }
  if (action === 'google-sync' && method === 'POST') return json(await syncToGoogle(sql, me));

  return json({ error: 'METHOD' }, 405);
}

/**
 * Sends this person's coming meetings and timed events to their Google
 * Calendar — for people who would rather have them there than subscribe to
 * the feed. Ids are derived from what each thing is here, so pressing it
 * twice updates rather than duplicates. Only what is ahead, and at most
 * sixty days of it.
 */
export async function syncToGoogle(sql, me, now = new Date()) {
  if (!(await isLinked(sql, me.username))) return { ok: false, error: 'GOOGLE_NOT_LINKED' };
  const fromOn = nowLocal(now).on;
  const toOn = addDays(fromOn, 60);
  let sent = 0;
  let failed = 0;
  const meetings = await sql`
    SELECT m.* FROM meetings m JOIN meeting_people p ON p.meeting_id = m.id
    WHERE p.username = ${me.username} AND p.reply <> 'declined' AND m.status = 'planned'
      AND m.meets_on BETWEEN ${fromOn}::date AND ${toOn}::date`;
  for (const m of meetings) {
    const got = await putEvent(sql, me.username, { kind: 'meeting', id: m.id, title: m.title, on: isoDay(m.meets_on),
      at: m.meets_at, to: m.ends_at, place: m.place, note: m.note, link: m.join_url });
    if (got.ok) sent += 1; else failed += 1;
  }
  const events = await sql`
    SELECT e.* FROM events e JOIN event_people p ON p.event_id = e.id
    WHERE p.username = ${me.username} AND COALESCE(e.ends_on, e.starts_on) >= ${fromOn}::date
      AND e.starts_on <= ${toOn}::date`;
  for (const e of events) {
    const got = await putEvent(sql, me.username, { kind: 'event', id: e.id, title: e.title, on: isoDay(e.starts_on),
      toOn: isoDay(e.ends_on) || isoDay(e.starts_on), at: e.all_day ? null : e.starts_at, to: e.all_day ? null : e.ends_at,
      place: e.place, note: e.description });
    if (got.ok) sent += 1; else failed += 1;
  }
  return { ok: failed === 0, sent, failed };
}
