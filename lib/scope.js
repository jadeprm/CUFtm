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
 * Who may see a task.
 *
 * Any one of these is enough:
 *   1. it lives in a department they have access to, or
 *   2. it is tagged to a department they have access to, or
 *   3. they are personally tagged in it, or
 *   4. they created it.
 *
 * Rules 3 and 4 are what keep cross-department work possible. Without them,
 * asking PR to do something would make the request invisible to the person who
 * asked for it — the kind of "secure" that quietly breaks a committee.
 */
export function canSeeTask(user, task) {
  if (seesEverything(user)) return true;
  if (!user || !task) return false;
  if (task.createdBy === user.username) return true;
  if ((task.assignees || []).includes(user.username)) return true;

  const mine = accessSet(user);
  if (!mine.size) return false;
  if (task.department && mine.has(task.department)) return true;
  return (task.departments || []).some((d) => mine.has(d.key));
}
