/**
 * Meetings, against the database.
 *
 * Lives beside the endpoint rather than inside it for a blunt reason: Vercel
 * makes every file under api/ its own Serverless Function and the Hobby plan
 * allows twelve, which are all spoken for. Meetings ride along on
 * /api/events?do=… and the code that does the work sits here, where it can be
 * read without scrolling past the calendar.
 *
 * Everything to do with rules — who may do what, the standard agenda, the
 * running order — is in lib/meeting.js and tested without a database.
 */
import {
  MEETING_STATUS, isMeetingStatus, isReply, startingAgenda, inOrder, agendaLength,
  canCreateMeeting, canEditMeeting, canSeeMeeting, canProposeItem, canRemoveItem,
  canReply, replyCounts,
} from './meeting.js';
import { expandPeople, isCircle, describeCircle } from './circles.js';

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
const cleanTime = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? '')) ? String(v) : null);
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * A link somebody typed, or nothing.
 *
 * Only http and https: a `javascript:` link in a meeting invitation would run
 * in the browser of everybody who was invited, which is as bad as it sounds.
 */
function cleanUrl(value) {
  const raw = clean(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}

const toIsoDate = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')].join('-');
};

/** Every meeting, with its people and its agenda, shaped for the page. */
export async function assembleMeetings(sql, people = []) {
  const rows = await sql`SELECT * FROM meetings ORDER BY meets_on DESC, meets_at NULLS FIRST`;
  if (!rows.length) return [];

  const invited = await sql`SELECT * FROM meeting_people`;
  const agenda = await sql`SELECT * FROM meeting_agenda`;

  const by = new Map();
  for (const m of rows) by.set(m.id, { people: [], agenda: [] });
  for (const p of invited) by.get(p.meeting_id)?.people.push(p);
  for (const a of agenda) by.get(a.meeting_id)?.agenda.push(a);

  return rows.map((m) => {
    const mine = by.get(m.id) || { people: [], agenda: [] };
    const items = inOrder(mine.agenda);
    const meetsAt = m.meets_at || null;
    return {
      id: m.id,
      code: m.code || null,
      title: m.title,
      note: m.note || '',
      meetsOn: toIsoDate(m.meets_on),
      meetsAt,
      endsAt: m.ends_at || null,
      place: m.place || '',
      joinUrl: m.join_url || '',
      agendaUrl: m.agenda_url || '',
      minutesUrl: m.minutes_url || '',
      department: m.department || null,
      status: m.status,
      createdBy: m.created_by,
      createdAt: m.created_at,
      people: mine.people.map((p) => ({
        username: p.username,
        reply: isReply(p.reply) ? p.reply : 'invited',
        repliedAt: p.replied_at,
      })),
      // The label the invitation was actually sent under, when the guest list
      // happens to be exactly one of the committee's circles.
      circle: describeCircle(mine.people.map((p) => p.username), people),
      counts: replyCounts(mine.people),
      agenda: items.map((a) => ({
        id: a.id, slot: a.slot, title: a.title, detail: a.detail || '',
        minutes: Number(a.minutes) || 0, priority: a.priority || 'medium',
        kind: a.kind || 'item', proposedBy: a.proposed_by,
      })),
      length: agendaLength(items, meetsAt),
    };
  });
}

/** Write the guest list, keeping the answers of everybody still on it. */
async function writeInvites(sql, meetingId, usernames, organiser) {
  const wanted = [...new Set([organiser, ...usernames].filter(Boolean))];
  await sql`DELETE FROM meeting_people
            WHERE meeting_id = ${meetingId} AND username <> ALL(${wanted})`;
  if (wanted.length) {
    await sql`
      INSERT INTO meeting_people (meeting_id, username)
      SELECT ${meetingId}, u FROM unnest(${wanted}::text[]) AS u
      ON CONFLICT DO NOTHING`;
  }
  // Calling a meeting is itself an acceptance; nobody invites themselves and
  // then wonders whether they are going.
  await sql`UPDATE meeting_people SET reply = 'accepted', replied_at = now()
            WHERE meeting_id = ${meetingId} AND username = ${organiser} AND reply = 'invited'`;
  return wanted;
}

/** Who was asked: a mix of names and circles, resolved to names. */
function guestsFrom(body, people) {
  const usernames = Array.isArray(body.people)
    ? body.people.map((p) => clean(p, 64)).filter(Boolean) : [];
  const circles = Array.isArray(body.circles)
    ? body.circles.map((c) => clean(c, 24)).filter(isCircle) : [];
  return expandPeople({ usernames, circles, people });
}

export async function createMeeting(sql, me, body, { people, isSecretary, json }) {
  if (!canCreateMeeting(me, { isSecretary })) {
    return json({ error: 'CANNOT_CALL_MEETING' }, 403);
  }
  const title = clean(body.title, 200);
  if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);
  const meetsOn = cleanDate(body.meetsOn);
  if (!meetsOn) return json({ error: 'DATE_REQUIRED' }, 400);

  const id = newId('mt');
  await sql`
    INSERT INTO meetings (id, code, title, note, meets_on, meets_at, ends_at, place,
                          join_url, agenda_url, minutes_url, department, created_by)
    VALUES (${id}, 'M' || lpad(nextval('meeting_code_seq')::text, 4, '0'),
            ${title}, ${clean(body.note, 4000)}, ${meetsOn},
            ${cleanTime(body.meetsAt)}, ${cleanTime(body.endsAt)},
            ${clean(body.place, 200)}, ${cleanUrl(body.joinUrl)},
            ${cleanUrl(body.agendaUrl)}, ${''},
            ${clean(body.department, 32) || me.department || null}, ${me.username})`;

  await writeInvites(sql, id, guestsFrom(body, people), me.username);

  /**
   * The committee's five วาระ, when asked for.
   *
   * Offered rather than imposed — a working session of three people does not
   * need เรื่องสืบเนื่อง — so a blank agenda is equally valid and is what any
   * value other than 'standard' produces.
   */
  for (const item of startingAgenda(body.template, body.lang)) {
    await sql`
      INSERT INTO meeting_agenda (id, meeting_id, slot, title, minutes, kind, proposed_by)
      VALUES (${newId('ag')}, ${id}, ${item.slot}, ${item.title},
              ${item.minutes}, ${item.kind}, ${me.username})`;
  }

  return json({ ok: true, id }, 201);
}

export async function updateMeeting(sql, me, body, { people, isSecretary, json }) {
  const id = clean(body.id, 64);
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${id}`;
  if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);
  if (!canEditMeeting(me, row, { isSecretary })) return json({ error: 'NOT_MY_MEETING' }, 403);

  const meetsOn = body.meetsOn === undefined ? null : cleanDate(body.meetsOn);
  if (body.meetsOn !== undefined && !meetsOn) return json({ error: 'DATE_REQUIRED' }, 400);

  const status = isMeetingStatus(body.status) ? body.status : null;

  await sql`
    UPDATE meetings SET
      title       = COALESCE(${body.title === undefined ? null : clean(body.title, 200)}, title),
      note        = COALESCE(${body.note === undefined ? null : clean(body.note, 4000)}, note),
      meets_on    = COALESCE(${meetsOn}::date, meets_on),
      meets_at    = ${body.meetsAt === undefined ? row.meets_at : cleanTime(body.meetsAt)},
      ends_at     = ${body.endsAt === undefined ? row.ends_at : cleanTime(body.endsAt)},
      place       = COALESCE(${body.place === undefined ? null : clean(body.place, 200)}, place),
      join_url    = ${body.joinUrl === undefined ? row.join_url : cleanUrl(body.joinUrl)},
      agenda_url  = ${body.agendaUrl === undefined ? row.agenda_url : cleanUrl(body.agendaUrl)},
      minutes_url = ${body.minutesUrl === undefined ? row.minutes_url : cleanUrl(body.minutesUrl)},
      status      = COALESCE(${status}, status),
      updated_at  = now()
    WHERE id = ${id}`;

  if (body.people !== undefined || body.circles !== undefined) {
    await writeInvites(sql, id, guestsFrom(body, people), row.created_by);
  }
  return json({ ok: true, id });
}

export async function removeMeeting(sql, me, id, { isSecretary, json }) {
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${clean(id, 64)}`;
  if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);
  if (!canEditMeeting(me, row, { isSecretary })) return json({ error: 'NOT_MY_MEETING' }, 403);
  await sql`DELETE FROM meetings WHERE id = ${row.id}`;
  return json({ ok: true, deleted: row.id });
}

/**
 * Proposing an agenda item.
 *
 * Open to anybody invited, which is the point of it — the people who have to
 * sit through the meeting are the ones who know what it needs to cover. The
 * slot they ask for is a preference, not a promise: the running order is
 * renumbered from one every time it is read, so an item asking for position 3
 * on a two-item agenda lands at the end rather than leaving a hole.
 */
export async function addAgendaItem(sql, me, body, { json }) {
  const meetingId = clean(body.meetingId, 64);
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${meetingId}`;
  if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);

  const invited = await sql`SELECT username FROM meeting_people WHERE meeting_id = ${meetingId}`;
  if (!canProposeItem(me, invited)) return json({ error: 'NOT_INVITED' }, 403);
  if (row.status !== 'planned') return json({ error: 'MEETING_IS_OVER' }, 400);

  const title = clean(body.title, 300);
  if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

  const [{ next }] = await sql`
    SELECT COALESCE(max(slot), 0) + 1 AS next FROM meeting_agenda WHERE meeting_id = ${meetingId}`;
  const slot = Number(body.slot) > 0 ? Math.round(Number(body.slot)) : Number(next);

  const id = newId('ag');
  await sql`
    INSERT INTO meeting_agenda (id, meeting_id, slot, title, detail, minutes, priority, proposed_by)
    VALUES (${id}, ${meetingId}, ${slot}, ${title}, ${clean(body.detail, 2000)},
            ${Math.max(0, Math.min(600, Math.round(Number(body.minutes) || 0)))},
            ${['low', 'medium', 'high', 'highest'].includes(body.priority) ? body.priority : 'medium'},
            ${me.username})`;
  return json({ ok: true, id }, 201);
}

export async function editAgendaItem(sql, me, body, { isSecretary, json }) {
  const [item] = await sql`SELECT * FROM meeting_agenda WHERE id = ${clean(body.id, 64)}`;
  if (!item) return json({ error: 'NO_SUCH_ITEM' }, 404);
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${item.meeting_id}`;

  /**
   * Your own item, or the organiser's to reorder.
   *
   * The organiser may move and drop items because somebody has to keep the
   * agenda to a length that fits the room booking — but they may not rewrite
   * the wording of somebody else's proposal into something it was not.
   */
  const mine = item.proposed_by === me.username;
  const runs = canEditMeeting(me, row, { isSecretary });
  if (!mine && !runs) return json({ error: 'NOT_YOUR_ITEM' }, 403);
  if (!mine && (body.title !== undefined || body.detail !== undefined)) {
    return json({ error: 'CANNOT_REWORD_OTHERS' }, 403);
  }

  /**
   * Moving an item lands it exactly where it was put.
   *
   * The running order breaks ties on age, which is right for a NEW proposal —
   * two people asking for slot 3 should not fight over it — but wrong for an
   * explicit move: dragging an item to position 2 and watching it settle at 3
   * is the kind of thing that makes people stop trusting a page. So everything
   * from the target position down is pushed along first, leaving the slot the
   * item was moved to genuinely empty.
   */
  if (body.slot !== undefined) {
    const want = Math.max(1, Math.round(Number(body.slot) || 1));
    await sql`
      UPDATE meeting_agenda SET slot = slot + 1
      WHERE meeting_id = ${item.meeting_id} AND id <> ${item.id} AND slot >= ${want}`;
  }

  await sql`
    UPDATE meeting_agenda SET
      title    = COALESCE(${body.title === undefined ? null : clean(body.title, 300)}, title),
      detail   = COALESCE(${body.detail === undefined ? null : clean(body.detail, 2000)}, detail),
      slot     = COALESCE(${body.slot === undefined ? null : Math.max(1, Math.round(Number(body.slot) || 1))}, slot),
      minutes  = COALESCE(${body.minutes === undefined ? null : Math.max(0, Math.min(600, Math.round(Number(body.minutes) || 0)))}, minutes),
      priority = COALESCE(${['low', 'medium', 'high', 'highest'].includes(body.priority) ? body.priority : null}, priority)
    WHERE id = ${item.id}`;
  return json({ ok: true, id: item.id });
}

export async function removeAgendaItem(sql, me, id, { isSecretary, json }) {
  const [item] = await sql`SELECT * FROM meeting_agenda WHERE id = ${clean(id, 64)}`;
  if (!item) return json({ error: 'NO_SUCH_ITEM' }, 404);
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${item.meeting_id}`;
  if (!canRemoveItem(me, row, item, { isSecretary })) return json({ error: 'NOT_YOUR_ITEM' }, 403);
  await sql`DELETE FROM meeting_agenda WHERE id = ${item.id}`;
  return json({ ok: true, deleted: item.id });
}

/**
 * Answering an invitation — to a meeting, a task, or an event.
 *
 * One function for all three because the rule is the same in each case and
 * writing it three times is how the three drift apart. A reply may be changed
 * as often as somebody likes right up until the meeting starts, because plans
 * change and a stale yes is worse than a late no.
 */
export async function replyToInvitation(sql, me, body, { json }) {
  const reply = clean(body.reply, 16);
  if (!isReply(reply) || reply === 'invited') return json({ error: 'BAD_REPLY' }, 400);

  const kind = clean(body.kind, 16);
  if (kind === 'meeting') {
    const [row] = await sql`SELECT * FROM meetings WHERE id = ${clean(body.id, 64)}`;
    if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);
    const [mine] = await sql`SELECT 1 FROM meeting_people
                             WHERE meeting_id = ${row.id} AND username = ${me.username}`;
    if (!mine) return json({ error: 'NOT_INVITED' }, 403);
    if (!canReply(row)) return json({ error: 'TOO_LATE_TO_REPLY' }, 400);

    await sql`UPDATE meeting_people SET reply = ${reply}, replied_at = now()
              WHERE meeting_id = ${row.id} AND username = ${me.username}`;
    return json({ ok: true, reply });
  }

  if (kind === 'task') {
    const [mine] = await sql`SELECT 1 FROM task_people
                             WHERE task_id = ${clean(body.id, 64)} AND username = ${me.username}`;
    if (!mine) return json({ error: 'NOT_INVITED' }, 403);
    await sql`UPDATE task_people SET reply = ${reply}, replied_at = now()
              WHERE task_id = ${clean(body.id, 64)} AND username = ${me.username}`;
    return json({ ok: true, reply });
  }

  if (kind === 'event') {
    const [mine] = await sql`SELECT 1 FROM event_people
                             WHERE event_id = ${clean(body.id, 64)} AND username = ${me.username}`;
    if (!mine) return json({ error: 'NOT_INVITED' }, 403);
    await sql`UPDATE event_people SET reply = ${reply}, replied_at = now()
              WHERE event_id = ${clean(body.id, 64)} AND username = ${me.username}`;
    return json({ ok: true, reply });
  }

  return json({ error: 'BAD_KIND' }, 400);
}

export { canSeeMeeting, MEETING_STATUS };
