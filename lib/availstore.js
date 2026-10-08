/**
 * Availability and clashes, against the database.
 *
 * Beside the rules rather than inside the endpoint for the usual reason: Vercel
 * makes every file under api/ its own Serverless Function and the Hobby plan
 * allows twelve, all spoken for. This rides on /api/users?do=… and the rules it
 * applies live in lib/availability.js, where they are checked without a
 * database at all.
 */
import {
  readWindow, readBlock, clashesFor, isoDay, WEEKDAYS,
} from './availability.js';

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * One person's own account of their time.
 *
 * Anybody may read anybody's — the whole point is that the person handing out
 * work can see it before they hand it out, and a committee where you cannot
 * tell whether somebody is in an exam is the committee this is meant to fix.
 * What is NOT shared is the reason attached to a block: "ไปงานศพ" is nobody
 * else's business, so the reason comes back only to its owner and to nobody
 * else, while the dates themselves are visible to all.
 */
export async function availabilityOf(sql, username, { forSelf = false } = {}) {
  const windows = await sql`
    SELECT weekday, from_at, to_at FROM user_availability
    WHERE username = ${username} ORDER BY weekday, from_at`;
  const blocks = await sql`
    SELECT id, from_on, to_on, from_at, to_at, reason FROM user_blocks
    WHERE username = ${username} ORDER BY from_on, from_at NULLS FIRST`;

  return {
    username,
    windows: windows
      .map((w) => ({ day: w.weekday, from: w.from_at, to: w.to_at }))
      // Monday first rather than alphabetically, which would start on Friday.
      .sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day) ||
        a.from.localeCompare(b.from)),
    blocks: blocks.map((b) => ({
      id: b.id,
      fromOn: isoDay(b.from_on),
      toOn: isoDay(b.to_on),
      fromAt: b.from_at || null,
      toAt: b.to_at || null,
      reason: forSelf ? (b.reason || '') : '',
    })),
  };
}

/**
 * Replacing somebody's weekly hours in one go.
 *
 * Sent in full and written in full, so adding, removing and clearing are the
 * same call and there is no way to end up with a leftover window nobody asked
 * for. Only the person themselves, or an admin — a head cannot quietly widen
 * somebody else's stated free evenings to fit a meeting in.
 */
export async function setAvailability(sql, me, body, { json }) {
  const username = clean(body.username, 64) || me.username;
  if (username !== me.username && me.access !== 'admin' && me.access !== 'coadmin') {
    return json({ error: 'NOT_YOUR_AVAILABILITY' }, 403);
  }

  const wanted = [];
  for (const raw of (Array.isArray(body.windows) ? body.windows : [])) {
    const got = readWindow(raw);
    // Named rather than dropped: a week that quietly lost Tuesday is worse
    // than one that says which row it could not read.
    if (got.error) return json({ error: got.error, at: raw }, 400);
    wanted.push(got.window);
  }
  if (wanted.length > 40) return json({ error: 'TOO_MANY_WINDOWS' }, 400);

  await sql`DELETE FROM user_availability WHERE username = ${username}`;
  for (const w of wanted) {
    await sql`
      INSERT INTO user_availability (username, weekday, from_at, to_at)
      VALUES (${username}, ${w.day}, ${w.from}, ${w.to})
      ON CONFLICT DO NOTHING`;
  }
  return json(await availabilityOf(sql, username, { forSelf: username === me.username }));
}

export async function addBlock(sql, me, body, { json }) {
  const username = clean(body.username, 64) || me.username;
  if (username !== me.username && me.access !== 'admin' && me.access !== 'coadmin') {
    return json({ error: 'NOT_YOUR_AVAILABILITY' }, 403);
  }
  const got = readBlock(body);
  if (got.error) return json({ error: got.error }, 400);

  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM user_blocks WHERE username = ${username}`;
  if (n >= 100) return json({ error: 'TOO_MANY_BLOCKS' }, 400);

  const b = got.block;
  await sql`
    INSERT INTO user_blocks (id, username, from_on, to_on, from_at, to_at, reason)
    VALUES (${newId('ub')}, ${username}, ${b.fromOn}::date, ${b.toOn}::date,
            ${b.fromAt}, ${b.toAt}, ${b.reason})`;
  return json(await availabilityOf(sql, username, { forSelf: username === me.username }));
}

export async function removeBlock(sql, me, id, { json }) {
  const [row] = await sql`SELECT * FROM user_blocks WHERE id = ${clean(id, 64)}`;
  if (!row) return json({ error: 'NO_SUCH_BLOCK' }, 404);
  if (row.username !== me.username && me.access !== 'admin' && me.access !== 'coadmin') {
    return json({ error: 'NOT_YOUR_AVAILABILITY' }, 403);
  }
  await sql`DELETE FROM user_blocks WHERE id = ${row.id}`;
  return json(await availabilityOf(sql, row.username,
    { forSelf: row.username === me.username }));
}

/**
 * Everything a set of people are already committed to on one day.
 *
 * One day, not a range, because a clash check is always about one appointment —
 * and asking for a whole roster's whole calendar to answer a question about
 * next Tuesday is how a page gets slow enough that people stop waiting for it.
 *
 * Tasks are included because a deadline at 14:00 is a claim on somebody's
 * afternoon, even though nothing is "booked". Only items with an actual hour
 * can clash; see spanOf in lib/availability.js for why.
 */
export async function commitmentsOn(sql, usernames, day) {
  const out = {};
  for (const name of usernames) out[name] = { windows: [], blocks: [], booked: [] };
  if (!usernames.length || !day) return out;

  const windows = await sql`
    SELECT username, weekday, from_at, to_at FROM user_availability
    WHERE username = ANY(${usernames})`;
  for (const w of windows) {
    out[w.username]?.windows.push({ day: w.weekday, from: w.from_at, to: w.to_at });
  }

  const blocks = await sql`
    SELECT username, from_on, to_on, from_at, to_at, reason FROM user_blocks
    WHERE username = ANY(${usernames}) AND from_on <= ${day}::date AND to_on >= ${day}::date`;
  for (const b of blocks) {
    out[b.username]?.blocks.push({
      fromOn: isoDay(b.from_on), toOn: isoDay(b.to_on),
      fromAt: b.from_at, toAt: b.to_at, reason: b.reason,
    });
  }

  const tasks = await sql`
    SELECT t.id, t.code, t.title, t.due_time, t.created_by, p.username
    FROM tasks t JOIN task_people p ON p.task_id = t.id
    WHERE t.due_date = ${day}::date AND t.status <> 'done' AND p.username = ANY(${usernames})`;
  for (const t of tasks) {
    out[t.username]?.booked.push({
      kind: 'task', id: t.id, code: t.code, title: t.title,
      on: day, at: t.due_time, createdBy: t.created_by,
    });
  }

  const events = await sql`
    SELECT e.id, e.code, e.title, e.starts_at, e.ends_at, e.all_day, e.created_by, p.username
    FROM events e JOIN event_people p ON p.event_id = e.id
    WHERE ${day}::date BETWEEN e.starts_on AND COALESCE(e.ends_on, e.starts_on)
      AND p.username = ANY(${usernames})`;
  for (const e of events) {
    out[e.username]?.booked.push({
      kind: 'event', id: e.id, code: e.code, title: e.title,
      on: day, at: e.all_day ? null : e.starts_at, to: e.all_day ? null : e.ends_at,
      createdBy: e.created_by,
    });
  }

  const meetings = await sql`
    SELECT m.id, m.code, m.title, m.meets_at, m.ends_at, m.created_by, p.username, p.reply
    FROM meetings m JOIN meeting_people p ON p.meeting_id = m.id
    WHERE m.meets_on = ${day}::date AND m.status = 'planned'
      AND p.username = ANY(${usernames})`;
  for (const m of meetings) {
    // Somebody who has already declined is not busy with it.
    if (m.reply === 'declined') continue;
    out[m.username]?.booked.push({
      kind: 'meeting', id: m.id, code: m.code, title: m.title,
      on: day, at: m.meets_at, to: m.ends_at, createdBy: m.created_by,
    });
  }

  return out;
}

/**
 * The question the forms ask before saving: who is not free for this?
 *
 * Always an answer, never a refusal. Jade asked for the person handing out the
 * work to be TOLD, and a hard block would only teach people to put the wrong
 * time in to get past it.
 */
export async function checkClashes(sql, me, body, { json, people = [] }) {
  const day = isoDay(body.on ?? body.date ?? body.dueDate ?? body.startsOn ?? body.meetsOn);
  const names = [...new Set((Array.isArray(body.people) ? body.people : [])
    .map((p) => clean(p, 64)).filter(Boolean))];
  if (!day || !names.length) return json({ clashes: [] });

  const commitments = await commitmentsOn(sql, names, day);
  const when = {
    on: day,
    at: body.at ?? body.dueTime ?? body.startsAt ?? body.meetsAt ?? null,
    to: body.to ?? body.endsAt ?? null,
    // The thing being edited is not in its own way.
    ignoreId: clean(body.ignoreId, 64) || null,
  };

  return json({ on: day, clashes: clashesFor(me, when, names, people, commitments) });
}

/**
 * Recording that a booking was made knowing it clashed, and declared to win.
 *
 * Nothing is deleted or moved. The loser keeps its place and gains a note, so
 * the person who is on both can see which one the committee expects them at —
 * which is the actual problem being solved. Silently cancelling somebody's
 * other commitment would be a far bigger thing than Jade asked for.
 *
 * The clashes are worked out again HERE rather than taken from the request.
 * The page already computed them to draw the warning, and sending that list
 * back would mean the browser deciding whose booking it outranks — a member
 * could post `mayPrioritise: true` and walk over the director's calendar. The
 * page's copy is for showing; this one is for deciding.
 */
export async function applyPrecedence(sql, me, { kind, itemId, when, people = [], roster = [] }) {
  const day = isoDay(when && (when.on ?? when.date));
  const names = [...new Set(people.filter(Boolean))];
  if (!day || !names.length) return [];

  const commitments = await commitmentsOn(sql, names, day);
  const found = clashesFor(me, { ...when, on: day, ignoreId: itemId }, names, roster, commitments);

  const written = [];
  for (const person of found) {
    for (const clash of person.clashes) {
      if (clash.kind !== 'booked' || !clash.mayPrioritise || !clash.id) continue;
      await sql`
        INSERT INTO precedence (id, kind, item_id, over_kind, over_id, username, decided_by)
        VALUES (${newId('pr')}, ${kind}, ${itemId}, ${clash.what}, ${clash.id},
                ${person.username}, ${me.username})`;
      written.push({ over: clash.id, overKind: clash.what, username: person.username });
    }
  }
  return written;
}

/**
 * Anything this item once outranked stops being outranked when it moves.
 *
 * A decision about a Tuesday afternoon means nothing once the thing has been
 * shifted to Thursday, and leaving the note behind would tell somebody to skip
 * a meeting for a deadline that is no longer on the same day.
 */
export const clearPrecedence = (sql, kind, itemId) =>
  sql`DELETE FROM precedence WHERE kind = ${kind} AND item_id = ${itemId}`;

/**
 * What has been declared more important than these things, for the pages.
 *
 * Reads the whole table for one kind rather than taking a list of ids. The
 * table only ever holds bookings somebody actually contested, so it stays in
 * the dozens where the id list would be in the hundreds — and a query whose
 * text does not change is one Postgres can keep a plan for.
 */
export async function precedenceOver(sql, kind) {
  const rows = await sql`
    SELECT over_id, kind, item_id, username, decided_by
    FROM precedence WHERE over_kind = ${kind}`;
  const out = {};
  for (const r of rows) {
    (out[r.over_id] ||= []).push({
      kind: r.kind, id: r.item_id, username: r.username, decidedBy: r.decided_by,
    });
  }
  return out;
}
