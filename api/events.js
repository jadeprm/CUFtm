import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser, canEditTasks } from '../lib/auth.js';
import { isDepartment } from '../lib/departments.js';
import { accessSet, seesEverything, EVENT_COLOURS, isColour } from '../lib/scope.js';
import { withNode } from '../lib/http.js';
import { isSecretary } from '../lib/approval.js';
import {
  assembleMeetings, createMeeting, updateMeeting, removeMeeting,
  addAgendaItem, editAgendaItem, removeAgendaItem, replyToInvitation, canSeeMeeting,
  addAttachment, removeAttachment, downloadAttachment,
} from '../lib/meetingstore.js';
import { circleSummary } from '../lib/circles.js';
import { applyPrecedence, clearPrecedence, precedenceOver } from '../lib/availstore.js';

/**
 * Events: dates people need to know about.
 *
 *   GET    /api/events        the ones I should see
 *   POST   /api/events        create
 *   PATCH  /api/events        update
 *   DELETE /api/events?id=…   remove
 *
 * An event is not a task. Nothing is owed on it, there is no status to move
 * and nothing to tick off — it exists so that it turns up on the calendar and
 * reminds the right people beforehand. Keeping the two apart is the whole
 * point: a rehearsal should never sit in a to-do list waiting to be finished.
 */

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
const cleanTime = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? '')) ? String(v) : null);
const NOTIFY_KINDS = ['7d', '3d', '24h', 'due'];

/** See lib/db.js — reading a DATE through a timezone would shift it by a day. */
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

export async function assembledEvents(sql) {
  const rows = await sql`
    SELECT * FROM events ORDER BY starts_on, starts_at NULLS FIRST, created_at`;
  // What somebody decided takes precedence over each of these. One small query
  // on a table that only ever holds contested bookings.
  const beaten = await precedenceOver(sql, 'event');
  const people = await sql`SELECT * FROM event_people`;
  const depts = await sql`SELECT * FROM event_departments`;

  const by = new Map();
  for (const e of rows) by.set(e.id, { people: [], departments: [], replies: [] });
  for (const p of people) {
    const got = by.get(p.event_id);
    if (!got) continue;
    got.people.push(p.username);
    // What each of them said, so a card can show who is actually coming.
    got.replies.push({ username: p.username, reply: p.reply || 'invited', repliedAt: p.replied_at });
  }
  for (const d of depts) by.get(d.event_id)?.departments.push(d.department);

  return rows.map((e) => ({
    id: e.id,
    outrankedBy: beaten[e.id] || [],
    code: e.code || null,
    title: e.title,
    description: e.description,
    startsOn: toIsoDate(e.starts_on),
    startsAt: e.starts_at || null,
    endsOn: toIsoDate(e.ends_on),
    endsAt: e.ends_at || null,
    allDay: e.all_day,
    place: e.place,
    department: e.department || null,
    colour: e.colour || 'plum',
    notify: String(e.notify || '').split(',').filter(Boolean),
    createdBy: e.created_by,
    people: by.get(e.id)?.people ?? [],
    replies: by.get(e.id)?.replies ?? [],
    departments: by.get(e.id)?.departments ?? [],
  }));
}

/**
 * Who an event is for.
 *
 * An event with nobody named on it is committee-wide — that is the common
 * case and it should not need anyone to tick 200 boxes. Naming people or
 * departments narrows it.
 */
export function canSeeEvent(user, event) {
  if (seesEverything(user)) return true;
  if (!user || !event) return false;
  if (event.createdBy === user.username) return true;

  const named = (event.people || []).length + (event.departments || []).length;
  if (named === 0) return true;

  if ((event.people || []).includes(user.username)) return true;
  const mine = accessSet(user);
  if (event.department && mine.has(event.department)) return true;
  return (event.departments || []).some((d) => mine.has(d));
}

/** Editing an event follows the same rule as a task: its creator, or an admin. */
export const canEditEvent = (user, event) => {
  if (!user || !event) return false;
  if (user.access === 'admin' || user.access === 'coadmin') return true;
  return event.createdBy === user.username;
};

/** Everyone the reminder should reach. */
async function audienceOf(sql, event) {
  if (!(event.people || []).length && !(event.departments || []).length && !event.department) {
    const rows = await sql`
      SELECT username FROM users WHERE active = true AND suspended = false`;
    return rows.map((r) => r.username);
  }

  const set = new Set(event.people || []);
  const keys = [...new Set([...(event.departments || []), event.department].filter(Boolean))];
  if (keys.length) {
    const rows = await sql`
      SELECT DISTINCT u.username FROM users u
      JOIN user_departments d ON d.username = u.username
      WHERE d.department = ANY(${keys}) AND u.active = true AND u.suspended = false`;
    for (const r of rows) set.add(r.username);
  }
  return [...set];
}

function readTags(body) {
  const people = Array.isArray(body.people)
    ? [...new Set(body.people.map((p) => clean(p, 64)).filter(Boolean))]
    : [];
  const departments = Array.isArray(body.departments)
    ? [...new Set(body.departments.map((d) => clean(d, 32)).filter(isDepartment))]
    : [];
  return { people, departments };
}

async function writeTags(sql, id, people, departments) {
  /**
   * People who are still invited keep their answer.
   *
   * The tags are rewritten in full on every edit, so deleting the lot and
   * putting them back would quietly throw away every accept and decline the
   * moment somebody fixed a typo in the title. Only people actually removed
   * from the event lose their row.
   */
  await sql`DELETE FROM event_people WHERE event_id = ${id} AND username <> ALL(${people})`;
  await sql`DELETE FROM event_departments WHERE event_id = ${id}`;
  for (const username of people) {
    await sql`INSERT INTO event_people (event_id, username) VALUES (${id}, ${username})
              ON CONFLICT DO NOTHING`;
  }
  for (const key of departments) {
    await sql`INSERT INTO event_departments (event_id, department) VALUES (${id}, ${key})
              ON CONFLICT DO NOTHING`;
  }
}

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);
  const action = url.searchParams.get('do') || '';

  try {
    /**
     * Meetings ride along on this endpoint.
     *
     * Not because they belong to events — they have their own tables and their
     * own rules — but because Vercel counts every file under api/ as a
     * Serverless Function and the Hobby plan allows twelve, which are all
     * spoken for. The work itself is in lib/meetingstore.js.
     */
    if (action.startsWith('meeting') || action.startsWith('mtg') ||
        action === 'agenda' || action === 'reply') {
      const roster = await sql`SELECT * FROM users`;
      const secretary = isSecretary(me);
      const kit = { people: roster, isSecretary: secretary, json };

      if (action === 'meetings' && request.method === 'GET') {
        const all = await assembleMeetings(sql, roster);
        return json({
          meetings: all
            .filter((m) => canSeeMeeting(me, m, m.people, { isSecretary: secretary }))
            .map((m) => ({
              ...m,
              myReply: (m.people.find((p) => p.username === me.username) || {}).reply || null,
              mayEdit: m.createdBy === me.username || secretary ||
                me.access === 'admin' || me.access === 'coadmin',
            })),
          circles: circleSummary(roster),
        });
      }
      if (action === 'meeting' && request.method === 'POST') return createMeeting(sql, me, await request.json().catch(() => ({})), kit);
      if (action === 'meeting' && request.method === 'PATCH') return updateMeeting(sql, me, await request.json().catch(() => ({})), kit);
      if (action === 'meeting' && request.method === 'DELETE') return removeMeeting(sql, me, url.searchParams.get('id'), kit);
      if (action === 'agenda' && request.method === 'POST') return addAgendaItem(sql, me, await request.json().catch(() => ({})), kit);
      if (action === 'agenda' && request.method === 'PATCH') return editAgendaItem(sql, me, await request.json().catch(() => ({})), kit);
      if (action === 'agenda' && request.method === 'DELETE') return removeAgendaItem(sql, me, url.searchParams.get('id'), kit);
      if (action === 'reply' && request.method === 'POST') return replyToInvitation(sql, me, await request.json().catch(() => ({})), kit);

      // Papers attached to a meeting. `mtgfile` rather than another file under
      // api/ for the same twelve-function reason as everything else here.
      if (action === 'mtgfile' && request.method === 'POST') return addAttachment(sql, me, await request.json().catch(() => ({})), kit);
      if (action === 'mtgfile' && request.method === 'DELETE') return removeAttachment(sql, me, url.searchParams.get('id'), kit);
      if (action === 'mtgfile' && request.method === 'GET') return downloadAttachment(sql, me, url.searchParams.get('id'), kit);

      return json({ error: 'BAD_REQUEST' }, 400);
    }

    if (request.method === 'GET') {
      const all = await assembledEvents(sql);
      return json({
        events: all
          .filter((e) => canSeeEvent(me, e))
          .map((e) => ({ ...e, mayEdit: canEditEvent(me, e) })),
        colours: EVENT_COLOURS,
      });
    }

    if (request.method === 'POST') {
      // Same rule as tasks: a member attends events, they do not schedule them.
      if (!canEditTasks(me)) return json({ error: 'MEMBERS_CANNOT_CREATE' }, 403);

      const body = await request.json().catch(() => ({}));
      const title = clean(body.title, 200);
      if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

      const startsOn = cleanDate(body.startsOn);
      if (!startsOn) return json({ error: 'DATE_REQUIRED' }, 400);

      const allDay = body.allDay === undefined ? !body.startsAt : Boolean(body.allDay);
      const endsOn = cleanDate(body.endsOn);
      // A run of days that ends before it starts is a typo, not a date range.
      if (endsOn && endsOn < startsOn) return json({ error: 'ENDS_BEFORE_START' }, 400);

      const id = `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const notify = (Array.isArray(body.notify) ? body.notify : NOTIFY_KINDS)
        .filter((k) => NOTIFY_KINDS.includes(k)).join(',');

      await sql`
        INSERT INTO events (id, code, title, description, starts_on, starts_at, ends_on, ends_at,
                            all_day, place, department, colour, notify, created_by)
        VALUES (${id}, 'E' || lpad(nextval('event_code_seq')::text, 4, '0'),
                ${title}, ${clean(body.description, 4000)},
                ${startsOn}, ${allDay ? null : cleanTime(body.startsAt)},
                ${endsOn}, ${allDay ? null : cleanTime(body.endsAt)},
                ${allDay}, ${clean(body.place, 200)},
                ${isDepartment(body.department) ? body.department : (me.department || null)},
                ${isColour(body.colour) ? body.colour : 'plum'},
                ${notify}, ${me.username})`;

      const { people, departments } = readTags(body);
      await writeTags(sql, id, people, departments);

      // "I know it clashes, and mine is the one that counts." Whose booking
      // this person may outrank is settled on this side, never by the page.
      if (body.prioritise && !allDay) {
        const roster = (await sql`
          SELECT username, access, display_name FROM users WHERE active = true`)
          .map((p) => ({ ...p, displayName: p.display_name }));
        const on = await sql`SELECT username FROM event_people WHERE event_id = ${id}`;
        await applyPrecedence(sql, me, {
          kind: 'event', itemId: id, roster,
          when: { on: startsOn, at: cleanTime(body.startsAt), to: cleanTime(body.endsAt) },
          people: on.map((r) => r.username),
        });
      }

      const all = await assembledEvents(sql);
      return json({
        event: all.find((e) => e.id === id),
        events: all.filter((e) => canSeeEvent(me, e)).map((e) => ({ ...e, mayEdit: canEditEvent(me, e) })),
      }, 201);
    }

    if (request.method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const id = clean(body.id, 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);

      const existing = (await assembledEvents(sql)).find((e) => e.id === id);
      if (!existing) return json({ error: 'NO_SUCH_EVENT' }, 404);
      if (!canEditEvent(me, existing)) return json({ error: 'NOT_EVENT_OWNER' }, 403);

      const startsOn = body.startsOn === undefined ? existing.startsOn : cleanDate(body.startsOn);
      if (!startsOn) return json({ error: 'DATE_REQUIRED' }, 400);
      const endsOn = body.endsOn === undefined ? existing.endsOn : cleanDate(body.endsOn);
      if (endsOn && endsOn < startsOn) return json({ error: 'ENDS_BEFORE_START' }, 400);

      const allDay = body.allDay === undefined ? existing.allDay : Boolean(body.allDay);

      await sql`
        UPDATE events SET
          title       = COALESCE(${body.title === undefined ? null : clean(body.title, 200)}, title),
          description = COALESCE(${body.description === undefined ? null : clean(body.description, 4000)}, description),
          starts_on   = ${startsOn}::date,
          ends_on     = ${endsOn}::date,
          all_day     = ${allDay},
          starts_at   = ${allDay ? null : cleanTime(body.startsAt ?? existing.startsAt)},
          ends_at     = ${allDay ? null : cleanTime(body.endsAt ?? existing.endsAt)},
          place       = COALESCE(${body.place === undefined ? null : clean(body.place, 200)}, place),
          department  = CASE WHEN ${body.department === undefined} THEN department
                             ELSE ${isDepartment(body.department) ? body.department : null} END,
          colour      = COALESCE(${isColour(body.colour) ? body.colour : null}, colour),
          notify      = COALESCE(${
            Array.isArray(body.notify)
              ? body.notify.filter((k) => NOTIFY_KINDS.includes(k)).join(',')
              : null
          }, notify),
          updated_at  = now()
        WHERE id = ${id}`;

      if (body.people !== undefined || body.departments !== undefined) {
        const { people, departments } = readTags({
          people: body.people ?? existing.people,
          departments: body.departments ?? existing.departments,
        });
        await writeTags(sql, id, people, departments);
      }

      /**
       * A decision about a Tuesday afternoon means nothing once the event has
       * moved to Thursday, so moving it drops what it used to outrank rather
       * than leaving a note telling somebody to skip the wrong thing.
       */
      const moved = startsOn !== existing.startsOn ||
        (body.startsAt !== undefined && cleanTime(body.startsAt) !== existing.startsAt);
      if (moved || body.prioritise) await clearPrecedence(sql, 'event', id);

      if (body.prioritise && !allDay) {
        const roster = (await sql`
          SELECT username, access, display_name FROM users WHERE active = true`)
          .map((p) => ({ ...p, displayName: p.display_name }));
        const on = await sql`SELECT username FROM event_people WHERE event_id = ${id}`;
        await applyPrecedence(sql, me, {
          kind: 'event', itemId: id, roster,
          when: { on: startsOn, at: cleanTime(body.startsAt ?? existing.startsAt),
                  to: cleanTime(body.endsAt ?? existing.endsAt) },
          people: on.map((r) => r.username),
        });
      }

      const all = await assembledEvents(sql);
      return json({
        event: all.find((e) => e.id === id),
        events: all.filter((e) => canSeeEvent(me, e)).map((e) => ({ ...e, mayEdit: canEditEvent(me, e) })),
      });
    }

    if (request.method === 'DELETE') {
      const id = clean(url.searchParams.get('id'), 64);
      if (!id) return json({ error: 'ID_REQUIRED' }, 400);

      const existing = (await assembledEvents(sql)).find((e) => e.id === id);
      if (!existing) return json({ error: 'NO_SUCH_EVENT' }, 404);
      if (!canEditEvent(me, existing)) return json({ error: 'NOT_EVENT_OWNER' }, 403);

      await sql`DELETE FROM events WHERE id = ${id}`;
      await sql`DELETE FROM reminders_sent WHERE task_id = ${id}`;
      await clearPrecedence(sql, 'event', id);

      const all = await assembledEvents(sql);
      return json({
        ok: true,
        events: all.filter((e) => canSeeEvent(me, e)).map((e) => ({ ...e, mayEdit: canEditEvent(me, e) })),
      });
    }

    return json({ error: 'METHOD' }, 405);
  } catch (error) {
    console.error('[events]', error);
    return json({ error: 'SERVER', message: 'The database did not respond. Please try again.' }, 500);
  }
}

export { audienceOf };

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
