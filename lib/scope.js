import { expandAccess, DEPARTMENT_KEYS } from './departments.js';

/**
 * Task vocabulary and who is allowed to see what.
 *
 * Kept in one file because the rules are shared by several endpoints and by
 * the browser, and a visibility rule that is written twice is a visibility
 * rule that will disagree with itself eventually.
 */

/**
 * The status ladder, in the order work actually moves.
 *
 * `review` and `feedback` were added on the committee's request: a task that is
 * finished by its owner but not yet checked is genuinely not "done", and
 * pretending otherwise is how things get missed.
 */
export const STATUSES = ['todo', 'doing', 'review', 'feedback', 'done'];

export const STATUS_ORDER = Object.fromEntries(STATUSES.map((s, i) => [s, i]));

export const PRIORITIES = ['low', 'medium', 'high', 'highest'];

/**
 * The palette an event can be given.
 *
 * A fixed set rather than a colour picker: eight distinguishable colours that
 * work on both themes are more useful than a million, and a calendar where
 * everyone invents their own shade stops meaning anything.
 */
export const EVENT_COLOURS = [
  { key: 'plum',   hex: '#b51e64' },
  { key: 'blue',   hex: '#1a73e8' },
  { key: 'green',  hex: '#188038' },
  { key: 'amber',  hex: '#ea8600' },
  { key: 'red',    hex: '#d93025' },
  { key: 'purple', hex: '#7b1fa2' },
  { key: 'teal',   hex: '#00796b' },
  { key: 'slate',  hex: '#5f6368' },
];
export const COLOUR_KEYS = EVENT_COLOURS.map((c) => c.key);
export const isColour = (key) => COLOUR_KEYS.includes(key);
export const colourHex = (key) =>
  (EVENT_COLOURS.find((c) => c.key === key) || EVENT_COLOURS[0]).hex;
export const PRIORITY_ORDER = { highest: 0, high: 1, medium: 2, low: 3 };

export const isStatus = (v) => STATUSES.includes(v);
export const isPriority = (v) => PRIORITIES.includes(v);

/**
 * A person arrives here in two shapes — a database row (snake_case) on the
 * server, and a JSON object (camelCase) in the browser. Reading both keeps one
 * copy of the rules instead of two that drift.
 */
const hasAll = (user) =>
  Boolean(user && (user.allDepartments ?? user.all_departments));

/** Every department this person may work in, with umbrellas expanded. */
export function accessSet(user) {
  if (!user) return new Set();
  if (hasAll(user)) return new Set(DEPARTMENT_KEYS);
  return new Set(expandAccess(user.departments || []));
}

/**
 * Can this person see everything?
 *
 * Admins and co-admins run the fair and are expected to look across all of it.
 * So is anyone whose sheet row says "All" — the assistant directors are
 * Editors by access level but work across every department.
 */
export const seesEverything = (user) =>
  user?.access === 'admin' || user?.access === 'coadmin' || hasAll(user);

/** May this person file a task into that teamspace? */
export const canPostTo = (user, key) =>
  !key || seesEverything(user) || accessSet(user).has(key);

/**
 * Who may change a task.
 *
 * The person who created it, the people it was given to, and the admins who
 * run the fair. The people doing the work were left out at first and it was
 * wrong: they are the ones who find out that the deadline has moved, that the
 * description is missing half of what was agreed, or that a step needs adding
 * — and sending all of that back through whoever typed the task is how a
 * tracker stops matching what is happening.
 *
 * Watchers are NOT in this circle. Being asked to follow something is the
 * opposite of being asked to do it, and a whole department can watch a task
 * without anybody being able to quietly move its deadline.
 *
 * Note this deliberately does not use seesEverything. Someone whose sheet row
 * says "All" sees every task, and an Editor now sees every task too, but that
 * is visibility, not authority — only a real Admin or Co-Admin may rewrite
 * work that is neither theirs nor given to them.
 */
export const canEditTask = (user, task) => {
  if (!user || !task) return false;
  if (user.access === 'admin' || user.access === 'coadmin') return true;
  if (task.createdBy === user.username) return true;
  return (task.assignees || []).includes(user.username);
};

/**
 * Who may move a task along the ladder.
 *
 * Everyone who may edit it, plus anyone actually tagged to do the work. A
 * member who has finished something should be able to say so without going
 * through their head — but that is all they may change.
 */
export const canSetStatus = (user, task) => {
  if (canEditTask(user, task)) return true;
  if (!user || !task) return false;
  return (task.assignees || []).includes(user.username);
};

/**
 * Who RUNS the task, as opposed to who works on it.
 *
 * The person who set it and the admins. This is the narrower circle that was
 * once the same thing as editing, and the things left in it are the ones that
 * reach past the task's own fields: deleting it, carving it into pieces, and
 * touching what somebody else put on it.
 */
const runsTask = (user, task) => {
  if (!user || !task) return false;
  if (user.access === 'admin' || user.access === 'coadmin') return true;
  return task.createdBy === user.username;
};

/**
 * Deleting does NOT follow editing.
 *
 * Whoever the work was given to may rewrite the task, because they are doing
 * it. Removing it altogether is a different thing — it takes the work off
 * everybody else's list too, and there is no undo — so it stays with the
 * person who set it and the admins.
 */
export const canDeleteTask = runsTask;

/**
 * Who may break a task into parts, and hand those parts out.
 *
 * Dividing the work is deciding what the work is, so it stays with the person
 * who set it — not with everybody it was handed to. Somebody given one piece
 * of a task should not be able to re-cut the other pieces.
 */
export const canManageParts = runsTask;

/**
 * Who may tick a part off.
 *
 * Whoever it was given to, or whoever runs the task. Nobody else — marking
 * someone else's piece finished is how a task looks done when it is not.
 */
export const canCompletePart = (user, task, part) => {
  if (runsTask(user, task)) return true;
  if (!user || !part) return false;
  return part.assignee === user.username;
};

/**
 * Who may hand work in.
 *
 * Anyone actually on the task, which is a wider circle than editing on
 * purpose: the whole point is that the people doing the work attach it
 * themselves rather than sending it to the head to upload.
 */
export const canAttach = canSetStatus;

/** Removing an attachment: the person who added it, or whoever runs the task. */
export const canRemoveLink = (user, task, link) => {
  if (runsTask(user, task)) return true;
  if (!user || !link) return false;
  return link.addedBy === user.username;
};

/**
 * Recognises where a link points, so the list can show what it is at a glance.
 *
 * Only for display. Nothing is fetched and nothing is trusted — a link is a
 * string someone typed, and it is treated as one.
 */
export function linkKind(url) {
  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch (e) {
    return 'link';
  }

  if (host === 'docs.google.com') {
    if (path.startsWith('/document')) return 'doc';
    if (path.startsWith('/spreadsheets')) return 'sheet';
    if (path.startsWith('/presentation')) return 'slide';
    if (path.startsWith('/forms')) return 'form';
    return 'drive';
  }
  if (host === 'drive.google.com') return 'drive';
  if (host.endsWith('figma.com')) return 'figma';
  if (host.endsWith('canva.com')) return 'canva';
  if (host.endsWith('youtube.com') || host === 'youtu.be') return 'video';
  return 'link';
}

/**
 * Accepts a link only if it is one a browser can safely open.
 *
 * http and https and nothing else: javascript: and data: URLs in a list
 * everyone clicks would be a way to attack the whole committee.
 */
export function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.toString().slice(0, 1000);
  } catch (e) {
    return null;
  }
}

/**
 * Who may see a task.
 *
 * Any one of these is enough:
 *   0. they are an Editor or above, who see the whole fair, or
 *   1. it lives in a department they have access to, or
 *   2. it is tagged to a department they have access to, or
 *   3. they are personally tagged in it, or
 *   4. they created it, or
 *   5. whoever set it asked them to follow it (a viewer).
 *
 * Rules 3 and 4 are what keep cross-department work possible. Without them,
 * asking PR to do something would make the request invisible to the person who
 * asked for it — the kind of "secure" that quietly breaks a committee.
 */
export function canSeeTask(user, task) {
  if (seesEverything(user)) return true;
  if (!user || !task) return false;
  /**
   * An Editor sees the whole fair.
   *
   * Jade asked for this directly, and the reason is the shape of the work:
   * a ประธานฝ่าย needs to know what the other ฝ่าย are doing to the same
   * deadline, and the old rule — your own departments only — meant asking in
   * LINE for something the tracker already knew. It is visibility and nothing
   * more: editing still follows canEditTask, so seeing somebody else's task
   * does not come with the power to change it.
   */
  if (user.access === 'editor') return true;
  if (task.createdBy === user.username) return true;
  if ((task.assignees || []).includes(user.username)) return true;
  if ((task.viewers || []).includes(user.username)) return true;
  // Filed into a space this person is in — see lib/spaces.js. The ids are
  // put on the user by whichever endpoint is about to filter tasks.
  if (task.spaceId && (user.spaceIds || []).includes(task.spaceId)) return true;

  const mine = accessSet(user);
  if (!mine.size) return false;
  if (task.department && mine.has(task.department)) return true;
  return (task.departments || []).some((d) => mine.has(d.key));
}
