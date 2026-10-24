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
const BUILTIN = [
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

/**
 * The circles as they stand: the four above, plus whatever the committee has
 * since invented, minus any that have been put away.
 *
 * Mutable and rebuilt IN PLACE by applyCircles(), for the same reason the
 * department chart is: every other module imports these once at load, and
 * handing out a fresh array would leave half the app looking at the set as
 * it was when the process started.
 */
export const CIRCLES = [];
export const CIRCLE_KEYS = [];
export const isCircle = (key) => CIRCLE_KEYS.includes(key);
export const circleByKey = (key) => CIRCLES.find((c) => c.key === key) || null;

/**
 * Who has been put into or kept out of a circle by hand.
 *
 * Keyed `circle|username`, holding 'in' or 'out'. A derived circle keeps
 * deriving and these are the exceptions to it; a group from circle_groups
 * has no derivation at all, so only 'in' rows mean anything there.
 */
const PINNED = new Map();
const pinKey = (circle, username) => `${circle}|${username}`;

/** What an admin has said about one person and one circle, or null. */
export const pinnedState = (circle, username) => PINNED.get(pinKey(circle, username)) || null;

/** Groups made in the app, which derive nothing. */
export const isMadeGroup = (key) => Boolean(circleByKey(key)?.made);

/**
 * Fold the committee's own groups and its by-hand memberships into the set.
 *
 * Called from lib/db.js on the same cached read as the org chart, so every
 * endpoint sees the current answer without a call site having to know these
 * exist.
 */
export function applyCircles({ groups = [], members = [] } = {}) {
  const live = BUILTIN.map((c) => ({ ...c }));
  for (const g of [...groups].sort((a, b) => (a.sort || 0) - (b.sort || 0))) {
    if (g.hidden) continue;
    live.push({
      key: g.key,
      th: g.th || g.key,
      en: g.en || g.th || g.key,
      // No floor: nothing about somebody's access level puts them in here.
      floor: null,
      note: g.note || '',
      made: true,
      selfJoin: g.self_join !== false,
    });
  }
  CIRCLES.length = 0;
  CIRCLES.push(...live);
  CIRCLE_KEYS.length = 0;
  CIRCLE_KEYS.push(...live.map((c) => c.key));

  PINNED.clear();
  for (const row of members) {
    PINNED.set(pinKey(row.circle, row.username), row.state === 'out' ? 'out' : 'in');
  }
}

/**
 * A key for a group somebody typed into the admin page. Same reasoning as a
 * department key: stable, ASCII, and never reused.
 */
export function makeCircleKey(en = '', th = '', taken = []) {
  const base = String(en || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20)
    || String(th || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  const used = new Set([...CIRCLE_KEYS, ...taken]);
  let key = base || 'group';
  if (!used.has(key)) return key;
  for (let n = 2; n < 500; n++) if (!used.has(key + n)) return key + n;
  return `group${Date.now().toString(36)}`;
}

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

  /**
   * What somebody said by hand beats what the access ladder works out.
   *
   * The ladder is a good first answer and never a complete one: ต๊อดติ is a
   * co-admin because he manages people, and the ผู้ช่วยประธาน who sits on
   * the board without that access level had no way of being on it at all.
   * Note the order — a closed or suspended account is outside every circle
   * whatever anybody pinned, because a circle is a way of reaching people.
   */
  const pinned = PINNED.get(pinKey(key, person.username));
  if (pinned === 'out') return false;
  if (pinned === 'in') return true;

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
  made: Boolean(c.made), selfJoin: c.made ? c.selfJoin !== false : false,
  count: membersOf(c.key, people).length,
}));

// The four as described above, until a request loads what the committee added.
applyCircles();
