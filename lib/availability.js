/**
 * When somebody is free, and whose claim on their time wins.
 *
 * Two separate questions that arrive together whenever one person puts work on
 * another, and they are kept apart here on purpose:
 *
 *   Is this person available at all? — their own stated hours, and the days
 *   they have said they are away. Nobody outranks this. A head who books an
 *   exam week does not make the exam go away.
 *
 *   Is this person already spoken for? — a task, an event or a meeting they
 *   are already on at that hour. This one CAN be outranked, because two people
 *   competing for the same person's Tuesday is exactly the thing a committee
 *   has a hierarchy to settle.
 *
 * Nothing here ever refuses to save anything. A clash is something the person
 * doing the appointing is told about before they decide — Jade asked for a
 * warning, and a hard block would only teach people to book around the system.
 */
import { ACCESS, rankOfAccess } from './auth.js';

/** Monday first, because that is how a Thai week is written and read. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const isWeekday = (v) => WEEKDAYS.includes(v);

/**
 * Minutes since midnight, or null.
 *
 * Everything in here compares times as numbers rather than strings, because
 * '9:00' and '09:00' are the same hour and sort differently.
 */
export function minutesOf(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(raw)) return null;
  const [h, m] = raw.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export const clockOf = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * One window of free time in a normal week.
 *
 * `to` must come after `from`. A window that ends before it starts is somebody
 * typing 17:00–09:00 meaning overnight, and rather than guess at that it is
 * refused — an overnight window is two windows, and saying so is clearer than
 * silently inventing one.
 */
export function readWindow(raw = {}) {
  const day = String(raw.day ?? raw.weekday ?? '').trim().toLowerCase();
  if (!isWeekday(day)) return { error: 'BAD_DAY' };
  const from = minutesOf(raw.from ?? raw.from_at);
  const to = minutesOf(raw.to ?? raw.to_at);
  if (from === null || to === null) return { error: 'BAD_TIME' };
  if (to <= from) return { error: 'ENDS_BEFORE_IT_STARTS' };
  return { window: { day, from: clockOf(from), to: clockOf(to) } };
}

/**
 * A stretch of days somebody is away — exams, a trip, a family thing.
 *
 * Whole days by default, because that is what people mean by "I am away from
 * the 3rd to the 7th". Times are optional, for the afternoon somebody has a
 * class.
 */
export function readBlock(raw = {}) {
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
  const fromOn = String(raw.fromOn ?? raw.from_on ?? '').slice(0, 10);
  if (!isDate(fromOn)) return { error: 'BAD_DATE' };
  const toOn = isDate(raw.toOn ?? raw.to_on) ? String(raw.toOn ?? raw.to_on).slice(0, 10) : fromOn;
  if (toOn < fromOn) return { error: 'ENDS_BEFORE_IT_STARTS' };

  const from = raw.fromAt === undefined && raw.from_at === undefined
    ? null : minutesOf(raw.fromAt ?? raw.from_at);
  const to = raw.toAt === undefined && raw.to_at === undefined
    ? null : minutesOf(raw.toAt ?? raw.to_at);
  // Half a time range is a typo rather than a half-day, so both or neither.
  if ((from === null) !== (to === null)) return { error: 'NEEDS_BOTH_TIMES' };
  if (from !== null && to <= from) return { error: 'ENDS_BEFORE_IT_STARTS' };

  return {
    block: {
      fromOn,
      toOn,
      fromAt: from === null ? null : clockOf(from),
      toAt: to === null ? null : clockOf(to),
      reason: String(raw.reason ?? '').trim().slice(0, 200),
    },
  };
}

/** A DATE column arrives as a Date from the driver and a string from the page. */
export function isoDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')].join('-');
  }
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** Which day of the week a date falls on, as one of WEEKDAYS. */
export function weekdayOf(iso) {
  const day = isoDay(iso);
  if (!day) return null;
  // Noon UTC, so no timezone can push the date onto the day either side.
  const at = new Date(`${day}T12:00:00Z`);
  return WEEKDAYS[(at.getUTCDay() + 6) % 7];
}

/**
 * Do two stretches of a day touch?
 *
 * Touching at the edges is not a clash: a meeting that ends at 15:00 and one
 * that starts at 15:00 are back to back, which is tiring but not impossible,
 * and calling it a conflict would make the warning cry wolf.
 */
export const overlaps = (aFrom, aTo, bFrom, bTo) => aFrom < bTo && bFrom < aTo;

/**
 * A piece of work as a stretch of time, or null when it has no time at all.
 *
 * An all-day event and a task with a date but no hour are real commitments,
 * but they do not clash with a 10 a.m. meeting — somebody can do both. Only
 * things with actual hours are compared.
 */
export function spanOf(item) {
  const day = isoDay(item.on ?? item.date);
  if (!day) return null;
  const from = minutesOf(item.at ?? item.from);
  if (from === null) return { day, allDay: true, from: null, to: null };
  // Half an hour is the floor: a task due at 14:00 blocks 14:00–14:30 rather
  // than an instant that nothing could ever overlap.
  const to = minutesOf(item.to);
  return { day, allDay: false, from, to: to !== null && to > from ? to : from + 30 };
}

/**
 * Is this person free then, by their own account?
 *
 * Returns null when they are, or a reason when they are not. Somebody who has
 * filled nothing in is treated as always free — with four hundred people on
 * the committee most will never open the page, and a system that called all of
 * them unavailable would be shouting at every single appointment and would be
 * ignored within a week.
 */
export function unavailableReason(when, { windows = [], blocks = [] } = {}) {
  const span = spanOf(when);
  if (!span) return null;

  for (const raw of blocks) {
    const got = readBlock(raw);
    if (got.error) continue;
    const b = got.block;
    if (span.day < b.fromOn || span.day > b.toOn) continue;

    // A block with no hours is the whole day, every day it covers.
    if (!b.fromAt) return { kind: 'away', reason: b.reason, from: b.fromOn, to: b.toOn };
    // A block with hours only bites on the hours, and an all-day commitment
    // overlaps any of them.
    if (span.allDay) return { kind: 'away', reason: b.reason, from: b.fromOn, to: b.toOn };
    if (overlaps(span.from, span.to, minutesOf(b.fromAt), minutesOf(b.toAt))) {
      return { kind: 'away', reason: b.reason, from: b.fromOn, to: b.toOn };
    }
  }

  if (!windows.length) return null;

  const day = weekdayOf(span.day);
  const mine = windows
    .map((w) => readWindow(w))
    .filter((g) => !g.error && g.window.day === day)
    .map((g) => g.window);

  if (!mine.length) return { kind: 'offDay', day };
  // Nobody can say which hour an all-day thing will take, so having ANY free
  // window that day is enough.
  if (span.allDay) return null;

  const covered = mine.some((w) =>
    minutesOf(w.from) <= span.from && span.to <= minutesOf(w.to));
  if (covered) return null;

  return {
    kind: 'outsideHours',
    day,
    windows: mine.map((w) => `${w.from}–${w.to}`),
  };
}

/**
 * Whose booking may be pushed aside by whom.
 *
 * The committee's rule, as Jade settled it: an admin or a co-admin may take
 * precedence over ANY booking, including each other's and their own level's.
 * Nobody at the top of this committee is immune to anybody else at the top —
 * the two of them are running the fair together and are expected to sort it
 * out between themselves rather than have a permission do it for them.
 *
 * An editor may only outrank somebody below their own rank, so a head can
 * settle a clash inside their own department and cannot touch the people
 * running the fair.
 *
 * Unit heads and members do not get this at all. They can still see the clash
 * and still go ahead; what they cannot do is declare that their booking is the
 * one that counts.
 */
export function canPrioritiseOver(actor, owner) {
  if (!actor || !owner) return false;
  // Moving your own booking out of your own way needs no rank at all.
  if (owner.username && actor.username && owner.username === actor.username) return true;

  if (actor.access === ACCESS.ADMIN || actor.access === ACCESS.COADMIN) return true;
  if (actor.access !== ACCESS.EDITOR) return false;

  return rankOfAccess(actor.access) > rankOfAccess(owner.access);
}

/**
 * Everything standing in the way of putting this work on these people.
 *
 * `commitments` is what each person is already on, gathered by the caller —
 * this stays free of the database so the rules can be checked on their own.
 * The answer is per person and carries, for each clash, whether the person
 * doing the appointing may declare their own booking the more important one.
 */
export function clashesFor(actor, when, people = [], roster = [], commitments = {}) {
  const span = spanOf(when);
  if (!span) return [];
  const byName = new Map(roster.map((p) => [p.username, p]));
  const out = [];

  for (const username of people) {
    const person = byName.get(username) || { username };
    const mine = commitments[username] || {};
    const clashes = [];

    const away = unavailableReason(when, mine);
    // Their own stated availability. Nobody outranks it, so it carries no
    // prioritise option — which is the point of keeping the two kinds apart.
    if (away) clashes.push({ ...away, mayPrioritise: false });

    for (const booked of (mine.booked || [])) {
      // The thing being edited is not in its own way.
      if (when.ignoreId && booked.id === when.ignoreId) continue;
      const other = spanOf(booked);
      if (!other || other.day !== span.day) continue;
      // Two all-day things on one day is a busy day, not a double booking.
      if (span.allDay || other.allDay) continue;
      if (!overlaps(span.from, span.to, other.from, other.to)) continue;

      const ownedBy = byName.get(booked.createdBy) || { username: booked.createdBy };
      clashes.push({
        kind: 'booked',
        what: booked.kind,
        id: booked.id,
        code: booked.code || null,
        title: booked.title,
        at: clockOf(other.from),
        to: clockOf(other.to),
        createdBy: booked.createdBy,
        mayPrioritise: canPrioritiseOver(actor, ownedBy),
      });
    }

    if (clashes.length) {
      out.push({
        username,
        displayName: person.displayName || person.display_name || username,
        clashes,
        // One summary flag, because the button in the page is one button: it
        // may only say "mine takes precedence" if that is true of every clash.
        mayPrioritiseAll: clashes.every((c) => c.mayPrioritise),
      });
    }
  }

  return out;
}
