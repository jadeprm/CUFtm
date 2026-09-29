import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * Passwords and sessions.
 *
 * Scope note, stated plainly: this is sensible authentication for an internal
 * club tool — salted scrypt, no plaintext anywhere, HttpOnly cookies. It is not
 * bank-grade, and there is no two-factor or rate limiting beyond what Vercel
 * does. Nobody should reuse a password here that protects anything important.
 */

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 30;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  // Lengths must match before timingSafeEqual, which throws otherwise.
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
}

/** Rejects the passwords people actually pick when nothing stops them. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < 8) return 'TOO_SHORT';
  if (!/[a-zA-Z฀-๿]/.test(value)) return 'NEEDS_LETTER';
  if (!/[0-9]/.test(value)) return 'NEEDS_NUMBER';
  if (/^(password|12345678|11111111|qwertyui)/i.test(value)) return 'TOO_COMMON';
  return null;
}

export const newToken = () => randomBytes(32).toString('hex');

export function sessionCookie(token, { clear = false } = {}) {
  const parts = [
    `fair_session=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  return parts.join('; ');
}

export const sessionExpiry = () =>
  new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Resolves the signed-in user, or null.
 *
 * Joins straight through to `users` so a suspended or removed account stops
 * working immediately, rather than staying valid until its cookie expires.
 */
export async function currentUser(request, sql) {
  const token = readCookie(request, 'fair_session');
  if (!token) return null;

  /**
   * One query, not two. This runs on every single request, so the department
   * grants are gathered in the same round trip rather than in a follow-up —
   * the difference is small per request and constant across all of them.
   */
  const [row] = await sql`
    SELECT u.*,
           COALESCE((SELECT json_agg(d.department)
                     FROM user_departments d WHERE d.username = u.username), '[]') AS depts
    FROM sessions s
    JOIN users u ON u.username = s.username
    WHERE s.token = ${token}
      AND s.expires_at > now()
      AND u.active = true
      AND u.suspended = false
  `;
  if (!row) return null;

  row.departments = Array.isArray(row.depts)
    ? row.depts
    : (() => { try { return JSON.parse(row.depts); } catch { return []; } })();
  delete row.depts;
  return row;
}

/** The departments one person has been granted, as plain keys. */
export async function departmentsOf(sql, username) {
  const rows = await sql`
    SELECT department FROM user_departments WHERE username = ${username}`;
  return rows.map((r) => r.department);
}

/** The same thing for everybody at once: { username: [keys] }. */
export async function departmentsByUser(sql) {
  const rows = await sql`SELECT username, department FROM user_departments`;
  const out = {};
  for (const r of rows) (out[r.username] ||= []).push(r.department);
  return out;
}

/**
 * Replaces a person's department grants.
 *
 * Written as delete-then-insert so the caller sends the list it wants and gets
 * exactly that — adding, removing and clearing are all the same call, and
 * there is no way to end up with a leftover grant nobody asked for.
 */
export async function setDepartments(sql, username, keys) {
  await sql`DELETE FROM user_departments WHERE username = ${username}`;
  for (const key of keys) {
    await sql`INSERT INTO user_departments (username, department)
              VALUES (${username}, ${key}) ON CONFLICT DO NOTHING`;
  }
  // The home teamspace must stay one of the granted departments, otherwise a
  // person would keep filing tasks into a place they can no longer see.
  const [row] = await sql`SELECT department FROM users WHERE username = ${username}`;
  const home = keys.includes(row?.department) ? row.department : (keys[0] ?? null);
  await sql`UPDATE users SET department = ${home}, updated_at = now()
            WHERE username = ${username}`;
  return home;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * The five levels, from most to least.
 *
 *   admin      runs the fair; can do anything, including changing access
 *   coadmin    the same, except over admins and other co-admins
 *   editor     creates and edits work anywhere they have a department
 *   unitlead   a section head: creates and assigns inside their own unit,
 *              and sees their whole department
 *   inner      a member: sees their department, updates the work given to
 *              them, and creates nothing
 *
 * The bottom two were added because the committee is growing past heads-only.
 * A unit head answers to a department head and runs one section; a staff
 * member answers to a unit head and does the work. Giving both of them the
 * full Editor level meant anybody could assign anybody, which stops being
 * workable past about twenty people.
 */
export const ACCESS = {
  ADMIN: 'admin',
  COADMIN: 'coadmin',
  EDITOR: 'editor',
  UNITLEAD: 'unitlead',
  INNER: 'inner',
};

/** Weakest first, so one level can be compared with another. */
export const ACCESS_ORDER = [ACCESS.INNER, ACCESS.UNITLEAD, ACCESS.EDITOR, ACCESS.COADMIN, ACCESS.ADMIN];
export const rankOfAccess = (value) => ACCESS_ORDER.indexOf(value);

/**
 * The Access column is typed by people, so it is read forgivingly and in both
 * languages. Anything unrecognised becomes Editor, which is what the sheet
 * has always meant by a blank cell.
 */
export const normaliseAccess = (value) => {
  const v = String(value || '').toLowerCase().replace(/[\s_-]/g, '');
  if (v === 'admin') return ACCESS.ADMIN;
  if (v === 'coadmin') return ACCESS.COADMIN;
  if (['uniteditor', 'unitlead', 'unithead', 'หัวหน้าหน่วย', 'หัวหน้าหน่วยย่อย'].includes(v)) {
    return ACCESS.UNITLEAD;
  }
  if (['inner', 'member', 'staff', 'สมาชิก', 'สมาชิกฝ่าย'].includes(v)) return ACCESS.INNER;
  return ACCESS.EDITOR;
};

export const canManageAccounts = (user) =>
  user?.access === ACCESS.ADMIN || user?.access === ACCESS.COADMIN;

/**
 * The rule that makes co-admins meaningfully weaker than admins:
 * a co-admin may act on editors only. Admins and other co-admins are off
 * limits — they cannot promote, demote, suspend, or authorise a password reset
 * for them, and cannot act on themselves through this path either.
 *
 * Returns null when allowed, or a reason code when not.
 */
export function cannotActOn(actor, target) {
  if (!actor) return 'NOT_SIGNED_IN';
  if (!target) return 'NO_SUCH_USER';

  if (actor.access === ACCESS.ADMIN) return null;

  if (actor.access === ACCESS.COADMIN) {
    if (target.access === ACCESS.ADMIN) return 'COADMIN_CANNOT_TOUCH_ADMIN';
    if (target.access === ACCESS.COADMIN) return 'COADMIN_CANNOT_TOUCH_COADMIN';
    return null;
  }

  return 'EDITORS_CANNOT_MANAGE_ACCOUNTS';
}

/**
 * Who may create work at all.
 *
 * Everyone except a member, whose whole definition is that they do the work
 * rather than hand it out. A unit editor may create, but only inside their
 * own section — see canAssign below, which is where that is enforced.
 */
export const canEditTasks = (user) => Boolean(user) && user.access !== ACCESS.INNER;

/**
 * Whether this person may put THAT work on THOSE people.
 *
 * A unit editor runs one section: they may assign anyone in their own unit,
 * and themselves, and nobody else. Everybody above them may assign anybody.
 *
 * `people` is the roster, so the rule can ask which unit somebody is in
 * rather than trusting what the request claims about them.
 *
 * Returns null when allowed, or a reason code when not.
 */
export function cannotAssign(user, usernames, people = []) {
  if (!user) return 'NOT_SIGNED_IN';
  if (user.access === ACCESS.INNER) return 'MEMBERS_CANNOT_ASSIGN';
  if (user.access !== ACCESS.UNITLEAD) return null;

  const unit = user.unit || null;
  // A unit editor with no section recorded has no section to lead, so they may
  // only give work to themselves until somebody sets it on the admin page.
  const inMyUnit = (name) => {
    if (name === user.username) return true;
    if (!unit) return false;
    const person = people.find((p) => p.username === name);
    return Boolean(person && (person.unit || null) === unit);
  };

  const outside = (usernames || []).filter((name) => !inMyUnit(name));
  return outside.length ? 'OUTSIDE_YOUR_UNIT' : null;
}
