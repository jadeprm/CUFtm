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

  const [row] = await sql`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.username = s.username
    WHERE s.token = ${token}
      AND s.expires_at > now()
      AND u.active = true
      AND u.suspended = false
  `;
  return row || null;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const ACCESS = { ADMIN: 'admin', COADMIN: 'coadmin', EDITOR: 'editor' };

export const normaliseAccess = (value) => {
  const v = String(value || '').toLowerCase().replace(/[\s_-]/g, '');
  if (v === 'admin') return ACCESS.ADMIN;
  if (v === 'coadmin') return ACCESS.COADMIN;
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

/** Everyone signed in may create and edit any task — including other people's. */
export const canEditTasks = (user) => Boolean(user);
