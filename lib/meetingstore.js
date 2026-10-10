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
  canReply, replyCounts, readGuests,
  canAttach, canRemoveAttachment, readAttachType, ATTACH_TYPES,
} from './meeting.js';
import { expandPeople, isCircle, describeCircle } from './circles.js';
import { googleCalendarUrlForMeeting } from './ics.js';
import { archiveFile, driveConfigured } from './drive.js';
import { applyPrecedence, clearPrecedence, precedenceOver } from './availstore.js';

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
  const guests = await sql`SELECT * FROM meeting_guests ORDER BY added_at`;
  // What somebody decided takes precedence over each meeting.
  const beaten = await precedenceOver(sql, 'meeting');
  /**
   * Everything about the papers except the papers.
   *
   * `bytes` is deliberately left out of this query. It is the only BYTEA column
   * anything here reads in bulk, and pulling a meeting's attachments into every
   * listing would move megabytes out of Neon each time somebody opened the work
   * page — which is both slow and, on a plan billed for data transfer, paid for.
   * The download route fetches one row's bytes when somebody actually asks.
   */
  const files = await sql`
    SELECT id, meeting_id, name, mime, byte_size, drive_url, link_url, added_by, added_at,
           (bytes IS NOT NULL) AS stored_here
    FROM meeting_files ORDER BY added_at`;

  const by = new Map();
  for (const m of rows) by.set(m.id, { people: [], agenda: [], guests: [], files: [] });
  for (const p of invited) by.get(p.meeting_id)?.people.push(p);
  for (const a of agenda) by.get(a.meeting_id)?.agenda.push(a);
  for (const g of guests) by.get(g.meeting_id)?.guests.push(g);
  for (const f of files) by.get(f.meeting_id)?.files.push(f);

  return rows.map((m) => {
    const mine = by.get(m.id) || { people: [], agenda: [], guests: [], files: [] };
    const items = inOrder(mine.agenda);
    const meetsAt = m.meets_at || null;
    return {
      id: m.id,
      outrankedBy: beaten[m.id] || [],
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
      spaceId: m.space_id || null,
      seriesId: m.series_id || null,
      repeatRule: m.repeat_rule || null,
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
        id: a.id, slot: a.slot, number: a.number, depth: a.depth || 0,
        parentId: a.parentId || null, hasChildren: Boolean(a.hasChildren),
        title: a.title, detail: a.detail || '',
        minutes: Number(a.minutes) || 0, priority: a.priority || 'medium',
        kind: a.kind || 'item', proposedBy: a.proposed_by,
      })),
      length: agendaLength(items, meetsAt),
      // People with no account here, invited by email through Google.
      guests: mine.guests.map((g) => ({ email: g.email, name: g.name || '', addedBy: g.added_by })),
      /**
       * The papers. `where` is what the page needs to decide what to show:
       * a Drive copy and a pasted link both open in a new tab, a file still in
       * the database is fetched back through this app.
       */
      files: mine.files.map((f) => ({
        id: f.id,
        name: f.name,
        mime: f.mime || '',
        kind: ATTACH_TYPES[f.mime] || (f.link_url ? 'link' : 'file'),
        size: Number(f.byte_size) || 0,
        url: f.link_url || f.drive_url || null,
        where: f.link_url ? 'link' : (f.drive_url ? 'drive' : (f.stored_here ? 'here' : 'gone')),
        addedBy: f.added_by,
        addedAt: f.added_at,
      })),
    };
  }).map((m) => ({
    // Built here rather than on the page so the one-click link and the
    // subscribed feed can never describe the same meeting differently.
    ...m,
    googleUrl: googleCalendarUrlForMeeting(m),
  }));
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

/**
 * Guests, written as given.
 *
 * Returns what was refused so the page can say which address it could not
 * read — a guest list that quietly lost a name is how somebody turns up to a
 * meeting their อาจารย์ was never told about.
 */
async function writeGuests(sql, meetingId, value, by) {
  const { emails, rejected } = readGuests(value);
  await sql`DELETE FROM meeting_guests WHERE meeting_id = ${meetingId}
            AND email <> ALL(${emails})`;
  for (const email of emails) {
    await sql`
      INSERT INTO meeting_guests (meeting_id, email, added_by)
      VALUES (${meetingId}, ${email}, ${by})
      ON CONFLICT (meeting_id, email) DO NOTHING`;
  }
  return { emails, rejected };
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

  /**
   * One meeting, or a series of them.
   *
   * A repeating meeting is written out as one row per occurrence, each with
   * its own agenda and replies, sharing a series_id. That is what lets the
   * committee move next Tuesday's without touching the rest, and it keeps
   * every other part of the app — the calendar, LINE, reminders — reading
   * ordinary meetings.
   */
  const repeat = readRepeat(body.repeat, meetsOn);
  if (repeat.error) return json({ error: repeat.error }, 400);
  const spaceId = clean(body.spaceId, 64) || null;
  const dates = repeat.dates;
  const seriesId = dates.length > 1 ? newId('ms') : null;
  const made = await insertOneMeeting(sql, me, body, { title, meetsOn, people, seriesId,
    rule: seriesId ? repeat.rule : null, spaceId });
  const ids = [made.id];
  if (dates.length > 1) ids.push(...await copyMeeting(sql, made.id, dates.slice(1)));
  return json({ ok: true, id: made.id, ids, seriesId, guestsRejected: made.guestResult.rejected }, 201);
}

/**
 * The rest of a series, copied from its first meeting in four statements.
 *
 * Writing each occurrence the long way is a dozen round trips apiece — over
 * fifty-odd weeks that is long enough for the request to time out. So the
 * first one is written properly and the others are copied from it set-wise:
 * the meetings, the invitations (with the organiser's acceptance), the agenda
 * with its headings re-pointed, and the email guests.
 */
async function copyMeeting(sql, firstId, dates) {
  const ids = dates.map(() => newId('mt'));
  await sql`
    INSERT INTO meetings (id, code, title, note, meets_on, meets_at, ends_at, place, join_url,
                          agenda_url, minutes_url, department, created_by, series_id, repeat_rule, space_id)
    SELECT x.id, 'M' || lpad(nextval('meeting_code_seq')::text, 4, '0'), m.title, m.note, x.d::date,
           m.meets_at, m.ends_at, m.place, m.join_url, m.agenda_url, '', m.department, m.created_by,
           m.series_id, m.repeat_rule, m.space_id
    FROM unnest(${ids}::text[], ${dates}::text[]) WITH ORDINALITY AS x(id, d, n)
    CROSS JOIN meetings m WHERE m.id = ${firstId}
    ORDER BY x.n`;
  await sql`
    INSERT INTO meeting_people (meeting_id, username, reply, replied_at)
    SELECT x.id, p.username, CASE WHEN p.reply = 'accepted' AND p.username = m.created_by THEN 'accepted' ELSE 'invited' END,
           CASE WHEN p.username = m.created_by THEN p.replied_at ELSE NULL END
    FROM unnest(${ids}::text[]) AS x(id)
    CROSS JOIN meeting_people p JOIN meetings m ON m.id = p.meeting_id
    WHERE p.meeting_id = ${firstId}`;
  await sql`
    INSERT INTO meeting_agenda (id, meeting_id, slot, title, detail, minutes, priority, kind, proposed_by, parent_id)
    SELECT a.id || '_' || substr(x.id, 4), x.id, a.slot, a.title, a.detail, a.minutes, a.priority, a.kind,
           a.proposed_by, CASE WHEN a.parent_id IS NULL THEN NULL ELSE a.parent_id || '_' || substr(x.id, 4) END
    FROM unnest(${ids}::text[]) AS x(id)
    CROSS JOIN meeting_agenda a WHERE a.meeting_id = ${firstId}`;
  await sql`
    INSERT INTO meeting_guests (meeting_id, email, name, added_by)
    SELECT x.id, g.email, g.name, g.added_by
    FROM unnest(${ids}::text[]) AS x(id)
    CROSS JOIN meeting_guests g WHERE g.meeting_id = ${firstId}`;
  return ids;
}

/**
 * The dates a repeat rule produces, starting from (and including) the first.
 *
 *   { freq: 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly',
 *     count?: 2–52, until?: 'YYYY-MM-DD' }
 *
 * Capped at 52 occurrences and a year ahead — beyond that it is a standing
 * arrangement, not a meeting, and a typo in `until` should not write a
 * thousand rows. Monthly keeps the day of the month, landing on the last day
 * for months that are too short (31 January → 28 February → 31 March).
 */
export const REPEAT_FREQS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
export function readRepeat(raw, first) {
  if (!raw || !raw.freq || raw.freq === 'none') return { dates: [first], rule: null };
  const freq = String(raw.freq);
  if (!REPEAT_FREQS.includes(freq)) return { error: 'BAD_REPEAT' };
  const MAX = 52;
  const count = raw.count ? Math.max(1, Math.min(MAX, Math.round(Number(raw.count) || 0))) : null;
  const until = cleanDate(raw.until);
  if (!count && !until) return { error: 'REPEAT_NEEDS_END' };
  if (until && until < first) return { error: 'REPEAT_ENDS_BEFORE_IT_STARTS' };
  const yearOut = shiftDays(first, 366);
  const stop = until && until < yearOut ? until : yearOut;

  const out = [];
  const start = new Date(first + 'T00:00:00Z');
  const day = start.getUTCDate();
  for (let i = 0; out.length < (count || MAX) && i < 800; i += 1) {
    let d;
    if (freq === 'monthly') {
      const y = start.getUTCFullYear();
      const m = start.getUTCMonth() + i;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      d = new Date(Date.UTC(y, m, Math.min(day, last)));
    } else {
      const step = freq === 'weekly' ? 7 : freq === 'biweekly' ? 14 : 1;
      d = new Date(start.getTime() + i * step * 86400000);
      if (freq === 'weekdays' && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) continue;
    }
    const iso = d.toISOString().slice(0, 10);
    if (iso > stop) break;
    out.push(iso);
  }
  if (!out.length) out.push(first);
  return { dates: out, rule: freq };
}
function shiftDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

async function insertOneMeeting(sql, me, body, { title, meetsOn, people, seriesId, rule, spaceId }) {
  const id = newId('mt');
  await sql`
    INSERT INTO meetings (id, code, title, note, meets_on, meets_at, ends_at, place,
                          join_url, agenda_url, minutes_url, department, created_by,
                          series_id, repeat_rule, space_id)
    VALUES (${id}, 'M' || lpad(nextval('meeting_code_seq')::text, 4, '0'),
            ${title}, ${clean(body.note, 4000)}, ${meetsOn},
            ${cleanTime(body.meetsAt)}, ${cleanTime(body.endsAt)},
            ${clean(body.place, 200)}, ${cleanUrl(body.joinUrl)},
            ${cleanUrl(body.agendaUrl)}, ${''},
            ${clean(body.department, 32) || me.department || null}, ${me.username},
            ${seriesId}, ${rule}, ${spaceId})`;

  await writeInvites(sql, id, guestsFrom(body, people), me.username);
  const guestResult = body.guests === undefined
    ? { emails: [], rejected: [] }
    : await writeGuests(sql, id, body.guests, me.username);

  /**
   * The committee's five วาระ, when asked for.
   *
   * Offered rather than imposed — a working session of three people does not
   * need เรื่องสืบเนื่อง — so a blank agenda is equally valid and is what any
   * value other than 'standard' produces.
   */
  /**
   * The agenda the organiser actually typed, or the template they picked.
   *
   * A hand-built list wins, because deciding what a meeting is FOR happens at
   * the same moment as deciding when it is — the page lets the five standard
   * วาระ be loaded and then edited before anything is saved, and what arrives
   * here is the result of that rather than a template name.
   */
  const typed = Array.isArray(body.agenda)
    ? body.agenda
      .map((x, i) => ({
        slot: i + 1,
        title: clean(x && x.title, 300),
        minutes: Math.max(0, Math.min(600, Math.round(Number(x && x.minutes) || 0))),
        kind: clean(x && x.kind, 20) || 'item',
        // Which of the five headings this sits under, by its position in the
        // list the page sent. Headings themselves carry nothing.
        under: Number.isFinite(Number(x && x.under)) ? Number(x.under) : null,
        heading: Boolean(x && x.heading),
      }))
      .filter((x) => x.title)
    : [];
  const agenda = typed.length
    ? typed
    : startingAgenda(body.template, body.lang).map((x) => ({ ...x, heading: true, under: null }));

  /**
   * Headings first, so a sub-item has something to point at.
   *
   * `under` is an index into the heading list rather than an id, because the
   * page is describing an agenda that does not exist yet and has no ids to
   * refer to.
   */
  const headingIds = [];
  for (const item of agenda.filter((x) => x.heading)) {
    const agId = newId('ag');
    await sql`
      INSERT INTO meeting_agenda (id, meeting_id, slot, title, minutes, kind, proposed_by)
      VALUES (${agId}, ${id}, ${item.slot}, ${item.title},
              ${0}, ${item.kind}, ${me.username})`;
    headingIds.push(agId);
  }
  let loose = headingIds.length;
  for (const item of agenda.filter((x) => !x.heading)) {
    const parent = item.under !== null && headingIds[item.under] ? headingIds[item.under] : null;
    loose += parent ? 0 : 1;
    await sql`
      INSERT INTO meeting_agenda (id, meeting_id, slot, title, minutes, kind, proposed_by, parent_id)
      VALUES (${newId('ag')}, ${id}, ${parent ? item.slot : loose}, ${item.title},
              ${item.minutes}, ${item.kind}, ${me.username}, ${parent})`;
  }

  /**
   * "I know it clashes, and this meeting is the one that counts."
   *
   * Whose booking the organiser may outrank is worked out here rather than
   * taken from the request — the page computed it to draw the warning, and
   * letting the browser decide it would let anybody walk over the director's
   * calendar by posting a flag.
   */
  if (body.prioritise && cleanTime(body.meetsAt)) {
    const invited = await sql`SELECT username FROM meeting_people WHERE meeting_id = ${id}`;
    await applyPrecedence(sql, me, {
      kind: 'meeting', itemId: id, roster: people,
      when: { on: meetsOn, at: cleanTime(body.meetsAt), to: cleanTime(body.endsAt) },
      people: invited.map((r) => r.username),
    });
  }

  return { id, guestResult };
}

/**
 * Changing a meeting that is part of a series.
 *
 * `scope: 'following'` applies the same change to this occurrence and every
 * later one. A new date moves them all by the same number of days, so
 * "every Tuesday" becomes "every Wednesday" rather than all landing on one
 * day. Everything else ('one', or no scope) changes just this occurrence —
 * which stays in the series, so it can still be cancelled with the rest.
 */
export async function updateMeeting(sql, me, body, kit) {
  const { json } = kit;
  const id = clean(body.id, 64);
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${id}`;
  if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);
  if (body.scope !== 'following' || !row.series_id) return updateOneMeeting(sql, me, body, kit, row);

  const from = toIsoDate(row.meets_on);
  const later = await sql`SELECT * FROM meetings WHERE series_id = ${row.series_id}
                          AND meets_on >= ${from} ORDER BY meets_on`;
  const shift = body.meetsOn !== undefined && cleanDate(body.meetsOn)
    ? daysBetween(from, cleanDate(body.meetsOn)) : 0;
  let last = null;
  for (const m of later) {
    const own = { ...body, id: m.id };
    if (body.meetsOn !== undefined) own.meetsOn = shiftDays(toIsoDate(m.meets_on), shift);
    last = await updateOneMeeting(sql, me, own, kit, m);
    if (last.status >= 400) return last;
  }
  return json({ ok: true, id, updated: later.length });
}

async function updateOneMeeting(sql, me, body, { people, isSecretary, json }, row) {
  const id = row.id;
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
      space_id    = ${body.spaceId === undefined ? row.space_id : (clean(body.spaceId, 64) || null)},
      updated_at  = now()
    WHERE id = ${id}`;

  if (body.people !== undefined || body.circles !== undefined) {
    await writeInvites(sql, id, guestsFrom(body, people), row.created_by);
  }
  const guestResult = body.guests === undefined
    ? { emails: [], rejected: [] }
    : await writeGuests(sql, id, body.guests, me.username);

  /**
   * A meeting that has moved no longer outranks what it used to.
   *
   * The decision was about one afternoon; once the meeting is on another day
   * the note would be telling somebody to skip the wrong thing.
   */
  const movedOn = meetsOn && meetsOn !== toIsoDate(row.meets_on);
  const movedAt = body.meetsAt !== undefined && cleanTime(body.meetsAt) !== row.meets_at;
  if (movedOn || movedAt || body.prioritise) await clearPrecedence(sql, 'meeting', id);

  if (body.prioritise) {
    const [fresh] = await sql`SELECT meets_on, meets_at, ends_at FROM meetings WHERE id = ${id}`;
    const invited = await sql`SELECT username FROM meeting_people WHERE meeting_id = ${id}`;
    if (fresh?.meets_at) {
      await applyPrecedence(sql, me, {
        kind: 'meeting', itemId: id, roster: people,
        when: { on: toIsoDate(fresh.meets_on), at: fresh.meets_at, to: fresh.ends_at },
        people: invited.map((r) => r.username),
      });
    }
  }

  return json({ ok: true, id, guestsRejected: guestResult.rejected });
}

export async function removeMeeting(sql, me, id, { isSecretary, json }, scope = 'one') {
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${clean(id, 64)}`;
  if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);
  if (!canEditMeeting(me, row, { isSecretary })) return json({ error: 'NOT_MY_MEETING' }, 403);
  const targets = scope === 'following' && row.series_id
    ? await sql`SELECT id FROM meetings WHERE series_id = ${row.series_id} AND meets_on >= ${toIsoDate(row.meets_on)}`
    : [{ id: row.id }];
  for (const t of targets) {
    await sql`DELETE FROM meetings WHERE id = ${t.id}`;
    await clearPrecedence(sql, 'meeting', t.id);
  }
  return json({ ok: true, deleted: row.id, removed: targets.map((t) => t.id) });
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

  /**
   * How long it will take, said by the person proposing it.
   *
   * No default. A made-up ten minutes against every item produces a total
   * nobody chose, which is worse than useless when the point of the total is
   * to show an agenda that will not fit in the meeting.
   */
  const minutes = Math.round(Number(body.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0) return json({ error: 'MINUTES_REQUIRED' }, 400);
  if (minutes > 600) return json({ error: 'MINUTES_TOO_LONG' }, 400);

  /**
   * Which standing วาระ it belongs under.
   *
   * Once a meeting uses the committee's five headings, a proposal is a item
   * beneath one of them — 4.2, not a sixth วาระ. Inventing วาระที่ 6 would be
   * wrong in the minutes, so an agenda that HAS headings requires one.
   */
  /**
   * A heading, not merely a top-level row.
   *
   * `kind` is what separates the committee's five standing วาระ from an
   * ordinary item: the headings come from the template and carry their own
   * kind, everything else is 'item'. Asking only whether a row sits at the top
   * would make the FIRST item somebody typed onto a blank agenda into a
   * heading that every later item had to be filed under.
   */
  const heads = await sql`
    SELECT id FROM meeting_agenda
    WHERE meeting_id = ${meetingId} AND parent_id IS NULL AND kind <> 'item'
    ORDER BY slot`;
  const parentId = clean(body.parentId, 64) || null;
  if (parentId && !heads.some((x) => x.id === parentId)) {
    return json({ error: 'NO_SUCH_AGENDA_HEADING' }, 400);
  }
  if (!parentId && heads.length) return json({ error: 'PICK_AN_AGENDA_HEADING' }, 400);

  const [{ next }] = await sql`
    SELECT COALESCE(max(slot), 0) + 1 AS next FROM meeting_agenda
    WHERE meeting_id = ${meetingId}
      AND parent_id IS NOT DISTINCT FROM ${parentId}`;
  const slot = Number(body.slot) > 0 ? Math.round(Number(body.slot)) : Number(next);

  const id = newId('ag');
  await sql`
    INSERT INTO meeting_agenda (id, meeting_id, slot, title, detail, minutes, priority, proposed_by, parent_id)
    VALUES (${id}, ${meetingId}, ${slot}, ${title}, ${clean(body.detail, 2000)},
            ${minutes},
            ${['low', 'medium', 'high', 'highest'].includes(body.priority) ? body.priority : 'medium'},
            ${me.username}, ${parentId})`;
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
  let movedTo = null;
  if (body.slot !== undefined) {
    /**
     * Moving an item lands it exactly where it was put.
     *
     * Nudging everything below the target along looks right and is not: the
     * item being moved is still in the list, so "move to 2" could leave it at
     * 1, and the nudge crossed into other headings because slots are numbered
     * within a วาระ, not across the agenda. So the item is taken out of its
     * siblings, put back at the position asked for, and the whole short list
     * renumbered from one.
     */
    const want = Math.max(1, Math.round(Number(body.slot) || 1));
    const siblings = await sql`
      SELECT id FROM meeting_agenda
      WHERE meeting_id = ${item.meeting_id}
        AND parent_id IS NOT DISTINCT FROM ${item.parent_id}
        AND id <> ${item.id}
      ORDER BY slot, created_at`;

    const order = siblings.map((x) => x.id);
    order.splice(Math.min(want - 1, order.length), 0, item.id);
    for (let i = 0; i < order.length; i += 1) {
      await sql`UPDATE meeting_agenda SET slot = ${i + 1} WHERE id = ${order[i]}`;
    }
    movedTo = order.indexOf(item.id) + 1;
  }

  await sql`
    UPDATE meeting_agenda SET
      title    = COALESCE(${body.title === undefined ? null : clean(body.title, 300)}, title),
      detail   = COALESCE(${body.detail === undefined ? null : clean(body.detail, 2000)}, detail),
      slot     = COALESCE(${movedTo}, slot),
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

// ---------------------------------------------------------------------------
// Papers attached to a meeting
// ---------------------------------------------------------------------------

/**
 * Three megabytes, for the same reason the documents side uses it.
 *
 * The file travels base64-encoded, which inflates it by a third, and the
 * platform refuses a request body over about 4.5 MB. Saying so here, with the
 * limit in the answer, beats a request that dies halfway with no explanation.
 */
const MAX_ATTACHMENT = 3 * 1024 * 1024;

function fromBase64(value, limit) {
  const raw = String(value || '').replace(/^data:[^,]*,/, '');
  if (!raw) return { error: 'EMPTY_FILE' };
  let buffer;
  try { buffer = Buffer.from(raw, 'base64'); } catch { return { error: 'BAD_FILE' }; }
  if (!buffer.length) return { error: 'EMPTY_FILE' };
  if (buffer.length > limit) return { error: 'FILE_TOO_BIG', size: buffer.length, limit };
  return { buffer };
}

/**
 * Attaching a paper to a meeting — a file, or a link to one.
 *
 * A link is written straight down and costs nothing, which is the right answer
 * whenever the document already lives in Drive or a shared folder. A file has
 * to be put somewhere, and where it goes depends on whether the archive account
 * is configured: Drive when it is, and the bytes are then dropped from the
 * database in the same breath rather than kept as a second copy nobody reads.
 * Neon is the fallback, because a committee that has not finished setting up
 * Drive should still be able to attach the agenda to its own meeting.
 */
export async function addAttachment(sql, me, body, { isSecretary, json }) {
  const meetingId = clean(body.meetingId, 64);
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${meetingId}`;
  if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);

  const invited = await sql`SELECT username FROM meeting_people WHERE meeting_id = ${meetingId}`;
  // The organiser counts even before the invitations are written, which is the
  // order a meeting is actually created in.
  if (!canAttach(me, invited) && !canEditMeeting(me, row, { isSecretary })) {
    return json({ error: 'NOT_INVITED' }, 403);
  }

  const id = newId('mf');
  const link = cleanUrl(body.linkUrl);

  if (link) {
    // A link's name is for reading, so it falls back to the host rather than to
    // the whole URL — "drive.google.com" in a list beats 180 characters of it.
    let host = '';
    try { host = new URL(link).hostname.replace(/^www\./, ''); } catch { host = ''; }
    const name = clean(body.name, 200) || host || link.slice(0, 80);
    await sql`
      INSERT INTO meeting_files (id, meeting_id, name, link_url, added_by)
      VALUES (${id}, ${meetingId}, ${name}, ${link}, ${me.username})`;
    return json({ ok: true, id, where: 'link' }, 201);
  }

  if (body.file === undefined) return json({ error: 'NOTHING_TO_ATTACH' }, 400);

  const got = fromBase64(body.file, MAX_ATTACHMENT);
  if (got.error) return json({ error: got.error, limit: got.limit, size: got.size }, 400);

  const name = clean(body.name, 200) || 'attachment';
  const mime = readAttachType(body.mime, name);
  if (!mime) return json({ error: 'FILE_TYPE_NOT_ALLOWED' }, 400);

  await sql`
    INSERT INTO meeting_files (id, meeting_id, name, mime, byte_size, bytes, added_by)
    VALUES (${id}, ${meetingId}, ${name}, ${mime}, ${got.buffer.length}, ${got.buffer}, ${me.username})`;

  /**
   * Straight on to Drive, if there is a Drive to go to.
   *
   * Done after the insert rather than instead of it, so a Drive that is down
   * loses nobody's file — the row exists either way, and a failed upload just
   * means the bytes stay here. An upload that succeeds clears them immediately:
   * unlike a document, which is still being signed and needs a local copy, a
   * meeting paper is finished the moment it arrives.
   */
  if (driveConfigured()) {
    const sent = await archiveFile(got.buffer, {
      name,
      mime,
      description: `${row.code || ''} ${row.title || ''}`.trim(),
    });
    if (sent.ok) {
      await sql`
        UPDATE meeting_files
        SET drive_file_id = ${sent.id}, drive_url = ${sent.url}, bytes = NULL
        WHERE id = ${id}`;
      return json({ ok: true, id, where: 'drive', url: sent.url }, 201);
    }
    // Named rather than swallowed: "the file is attached but the archive did
    // not take it" is a thing she would want to know while it is still true.
    return json({ ok: true, id, where: 'here', driveProblem: sent.reason }, 201);
  }

  return json({ ok: true, id, where: 'here' }, 201);
}

export async function removeAttachment(sql, me, id, { isSecretary, json }) {
  const [file] = await sql`SELECT * FROM meeting_files WHERE id = ${clean(id, 64)}`;
  if (!file) return json({ error: 'NO_SUCH_FILE' }, 404);
  const [row] = await sql`SELECT * FROM meetings WHERE id = ${file.meeting_id}`;
  if (!canRemoveAttachment(me, row, file, { isSecretary })) {
    return json({ error: 'NOT_YOUR_FILE' }, 403);
  }

  /**
   * The row goes; the copy in Drive stays.
   *
   * Deliberate. Detaching a paper from a meeting is a tidying-up action people
   * take without much thought, and it must not quietly destroy the committee's
   * only copy of a document. The archive is a record; this list is a pointer
   * into it.
   */
  await sql`DELETE FROM meeting_files WHERE id = ${file.id}`;
  return json({ ok: true, deleted: file.id, keptInDrive: Boolean(file.drive_url) });
}

/**
 * Handing one attachment back.
 *
 * Only for files still held here — a Drive copy and a pasted link are both
 * opened directly by the page. `content-disposition: attachment` and a
 * nosniff header are not decoration: these are bytes somebody else uploaded,
 * and the one thing that must never happen is the browser deciding to render
 * one as a page on this origin.
 */
export async function downloadAttachment(sql, me, id, { isSecretary, json }) {
  const [file] = await sql`SELECT * FROM meeting_files WHERE id = ${clean(id, 64)}`;
  if (!file) return json({ error: 'NO_SUCH_FILE' }, 404);

  const [row] = await sql`SELECT * FROM meetings WHERE id = ${file.meeting_id}`;
  if (!row) return json({ error: 'NO_SUCH_MEETING' }, 404);
  const invited = await sql`SELECT username FROM meeting_people WHERE meeting_id = ${row.id}`;
  if (!canSeeMeeting(me, row, invited, { isSecretary })) return json({ error: 'NOT_ALLOWED' }, 403);

  if (file.link_url) return json({ error: 'IS_A_LINK', url: file.link_url }, 400);
  if (!file.bytes && file.drive_url) return json({ error: 'IN_DRIVE', url: file.drive_url }, 410);

  const buffer = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes || []);
  if (!buffer.length) return json({ error: 'NO_FILE' }, 404);

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': file.mime || 'application/octet-stream',
      'content-length': String(buffer.length),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name || 'attachment')}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
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
