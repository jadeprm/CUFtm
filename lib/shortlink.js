import { safeUrl } from './scope.js';

/**
 * Short links on the fair's own address — cu-ftm.vercel.app/s/ABC123.
 *
 * Built because a committee spends its year handing out addresses: a Google
 * Form on a poster, a Drive folder in a LINE message, a registration page read
 * out at a meeting. A forty-character Google URL cannot be typed off a poster
 * and cannot be said aloud, and the usual answer — bit.ly — puts somebody
 * else's domain on the fair's printed material and takes the click figures
 * with it when the free tier changes.
 *
 * Everything here is pure: making a code, checking one, deciding whether a
 * target is acceptable. The endpoint does the storing and redirecting, so all
 * the rules below can be tested without a database or a browser.
 */

/**
 * The alphabet, minus everything that gets misread.
 *
 * No 0/O, no 1/I/l: these codes are read off printed posters, typed on phone
 * keyboards, and said out loud across a room. Lower case is left out entirely
 * so a code can be written in capitals on a poster and typed in either case.
 */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/**
 * Codes are random rather than sequential.
 *
 * A counter would let anybody walk the whole list by trying 001, 002, 003 —
 * and some of these links will be internal before they are public.
 */
export function makeCode(length = CODE_LENGTH, random = Math.random) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return out;
}

/**
 * Names nobody may claim.
 *
 * `/s/api` or `/s/admin` would not actually collide with anything — the
 * rewrite keeps short links in their own corner — but a link that LOOKS like
 * part of the system is exactly what somebody would use to make a fake page
 * seem official.
 */
export const RESERVED = [
  'api', 'admin', 'login', 'signin', 'signup', 'password', 'reset',
  'account', 'settings', 'pay', 'payment', 'verify', 'secure', 'update',
  's', 'www', 'static', 'assets', 'null', 'undefined',
];

/**
 * Tidies a code somebody typed, or explains why it cannot be used.
 *
 * Case is folded UP, because the alphabet is upper case and a poster saying
 * "cufair" should reach the same place as one saying "CUFAIR".
 */
export function readCode(input) {
  const raw = String(input ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return { error: 'CODE_REQUIRED' };
  if (raw.length < 3) return { error: 'CODE_TOO_SHORT' };
  if (raw.length > 32) return { error: 'CODE_TOO_LONG' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw)) return { error: 'CODE_BAD_CHARACTERS' };
  if (RESERVED.includes(raw.toLowerCase())) return { error: 'CODE_RESERVED' };
  return { code: raw.toUpperCase() };
}

/**
 * Whether a target is one this app is willing to point at.
 *
 * `safeUrl` already refuses anything that is not http or https, which is what
 * keeps `javascript:` out of a link the whole committee is about to print.
 * Two more rules on top of it:
 *
 * A short link may not point at another short link on this same site. That is
 * not tidiness — a pair of links pointing at each other is a redirect loop
 * that every visitor's browser has to give up on.
 *
 * And it may not point at a bare IP address. A domain can be recognised by
 * whoever is about to click it; 203.0.113.7 tells nobody anything, and no
 * legitimate thing the committee shares lives at one.
 */
export function readTarget(input, { siteUrl = '' } = {}) {
  const url = safeUrl(input);
  if (!url) return { error: 'BAD_URL' };

  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'BAD_URL' }; }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.includes(':')) {
    return { error: 'NO_RAW_IP' };
  }

  const here = siteUrl ? safeUrl(siteUrl) : null;
  if (here) {
    try {
      const mine = new URL(here);
      if (parsed.hostname === mine.hostname && /^\/s\//i.test(parsed.pathname)) {
        return { error: 'POINTS_AT_ITSELF' };
      }
    } catch { /* an unreadable site address is not the link's problem */ }
  }

  return { url };
}

/** The address people will actually print, given the site's own address. */
export const shortUrl = (siteUrl, code) =>
  siteUrl ? `${String(siteUrl).replace(/\/+$/, '')}/s/${code}` : `/s/${code}`;

export { safeUrl };
