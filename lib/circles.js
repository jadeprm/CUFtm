/**
 * Circles: the committee's own words for groups of people.
 *
 * Every page that tags somebody — a task, an event, a meeting — had the same
 * two choices: name people one at a time, or pick a whole ฝ่าย. Neither says
 * "the core team", which is how the committee actually talks about itself, and
 * naming eleven heads by hand before every meeting is how people stop using a
 * system.
 *
 * These are DERIVED, never stored. A circle is a question asked of the roster
 * at the moment it is used — "who is at least an editor right now" — so
 * somebody promoted in November is in the core team in November without anyone
 * remembering to add them, and somebody who leaves is out of it the moment
 * their account is closed. A stored list would be wrong within a week.
 *
 * The four of them nest: each one contains the one before it.
 */
import { ACCESS, ACCESS_ORDER } from './auth.js';

/**
 * The four circles, widest last.
 *
 * `floor` is the lowest access level that belongs. หัวหน้าฝ่ายย่อย is the unit
 * lead level, which is why All Heads reaches one step further down than Core
 * Team: a unit head runs something, even if they do not sit on the board.
 */
export const CIRCLES = [
  {
    key: 'board',
    th: 'คณะกรรมการบริหาร',
    en: 'Board Committee',
    floor: ACCESS.COADMIN,
    note: 'ประธานโครงการ รองประธาน และผู้ช่วย',
  },
  {
    key: 'core',
    th: 'คณะทำงานหลัก',
    en: 'Core Team',
    floor: ACCESS.EDITOR,
    note: 'คณะกรรมการบริหาร และประธานฝ่าย',
  },
  {
    key: 'heads',
    th: 'หัวหน้าทั้งหมด',
    en: 'All Heads',
    floor: ACCESS.UNITLEAD,
    note: 'คณะทำงานหลัก และหัวหน้าฝ่ายย่อย',
  },
  {
    key: 'everyone',
    th: 'ทุกคน',
    en: 'All Members',
    floor: ACCESS.INNER,
    note: 'ทุกคนในระบบ',
  },
];

export const CIRCLE_KEYS = CIRCLES.map((c) => c.key);
export const isCircle = (key) => CIRCLE_KEYS.includes(key);
export const circleByKey = (key) => CIRCLES.find((c) => c.key === key) || null;

/**
 * Whether one person is inside a circle.
 *
 * Suspended and closed accounts are outside every circle: a circle is a way of
 * reaching people, and there is no sense in inviting somebody who cannot sign
 * in. An access level the roster does not recognise is treated as outside
 * rather than inside — being unsure about somebody is not a reason to send
 * them the committee's business.
 */
export function inCircle(person, key) {
  const circle = circleByKey(key);
  if (!circle || !person) return false;
  if (person.active === false || person.suspended) return false;

  const mine = ACCESS_ORDER.indexOf(person.access);
  const floor = ACCESS_ORDER.indexOf(circle.floor);
  if (mine < 0 || floor < 0) return false;
  return mine >= floor;
}

/** Everybody in a circle, as usernames, in roster order. */
export function membersOf(key, people = []) {
  return people.filter((p) => inCircle(p, key)).map((p) => p.username);
}

/**
 * Turn a mixed selection into one list of usernames.
 *
 * Pages send whatever the person picked: some names, some circles, in any
 * order, quite possibly overlapping — "the core team, and also Ploy". The
 * result is the union, without duplicates, in roster order rather than in the
 * order things happened to be clicked.
 */
export function expandPeople({ usernames = [], circles = [], people = [] }) {
  const wanted = new Set();
  for (const key of circles) {
    for (const username of membersOf(key, people)) wanted.add(username);
  }
  const known = new Set(people.map((p) => p.username));
  for (const username of usernames) {
    // A name nobody recognises is dropped rather than carried through into an
    // invitation that can never be accepted.
    if (known.has(username)) wanted.add(username);
  }
  return people.map((p) => p.username).filter((u) => wanted.has(u));
}

/**
 * The smallest circle that exactly covers a set of people, or null.
 *
 * Used for describing a selection back to whoever made it: "คณะทำงานหลัก" is a
 * better label on a card than eleven names, but only when it is actually true.
 * Anything less than an exact match returns null, because a card that says
 * "core team" when one person is missing is worse than a list.
 */
export function describeCircle(usernames = [], people = []) {
  const got = new Set(usernames);
  for (const circle of CIRCLES) {
    const members = membersOf(circle.key, people);
    if (members.length !== got.size) continue;
    if (members.every((u) => got.has(u))) return circle.key;
  }
  return null;
}

/** The circles, with their current size, for a picker to show. */
export const circleSummary = (people = []) => CIRCLES.map((c) => ({
  key: c.key, th: c.th, en: c.en, note: c.note,
  count: membersOf(c.key, people).length,
}));
