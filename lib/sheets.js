import { createSign } from 'node:crypto';
import { SHEET_ID } from './sheet.js';

/**
 * Writing back to the roster sheet.
 *
 * Reading the roster only needs the published CSV, but changing somebody's
 * access on the admin page has to reach the sheet itself — otherwise the next
 * sync reads the old value and silently undoes the change. That has been the
 * behaviour until now: the web edit held until the hourly job ran, then
 * vanished, which is worse than not offering the edit at all.
 *
 * This authenticates as a SERVICE ACCOUNT — a robot identity with its own
 * key, which the sheet is shared with as an editor. Deliberately not an OAuth
 * user: there is no consent screen to publish, no verification, no refresh
 * token that expires, and nobody's personal Google account to lose when they
 * graduate.
 *
 * The security rule from the start still holds. Sharing the sheet with one
 * robot address is not the same as making it publicly editable: the link
 * everyone has stays view-only, so nobody can still promote themselves to
 * Admin by opening it.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export const sheetWriteConfigured = () =>
  Boolean(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY);

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The private key arrives from an environment variable, where real newlines
 * rarely survive. Both forms are accepted so pasting the key either way works.
 */
const readKey = () =>
  String(process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

let cachedToken = null;

/** A short-lived access token, signed with the service account's own key. */
async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: process.env.GOOGLE_SA_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(readKey()).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google refused the service account: HTTP ${res.status} — ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function callSheets(path, init = {}) {
  const token = await accessToken();
  const res = await fetch(`${SHEETS}/${path}`, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`Sheets API refused: HTTP ${res.status} — ${detail.slice(0, 200)}`);
    error.statusCode = res.status;
    throw error;
  }
  return res.json();
}

const columnLetter = (index) => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const normalise = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Finds one person's row and the columns worth writing to.
 *
 * The sheet is edited by people, so nothing about its shape is assumed: the
 * header row is found by looking for a Username column rather than trusting
 * row 1, and a missing Department column simply means that part is skipped
 * instead of writing into whatever happens to sit there.
 */
async function locate(sheetId, username) {
  const data = await callSheets(`${encodeURIComponent(sheetId)}/values/A1:Z2000`);
  const rows = data.values || [];

  let headerAt = -1;
  let userCol = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const found = (rows[i] || []).findIndex((c) => ['username', 'ชื่อผู้ใช้'].includes(normalise(c)));
    if (found !== -1) { headerAt = i; userCol = found; break; }
  }
  if (headerAt === -1) return { error: 'NO_USERNAME_COLUMN' };

  const header = rows[headerAt].map(normalise);
  const accessCol = header.findIndex((c) => ['access', 'สิทธิ์', 'สิทธิ'].includes(c));
  const deptCol = header.findIndex((c) => ['department', 'ฝ่าย'].includes(c));

  const rowAt = rows.findIndex((r, i) =>
    i > headerAt && normalise((r || [])[userCol]) === normalise(username));
  if (rowAt === -1) return { error: 'NO_SUCH_ROW' };

  return { rowNumber: rowAt + 1, accessCol, deptCol };
}

const ACCESS_LABEL = { admin: 'Admin', coadmin: 'Co-Admin', editor: 'Editor' };

/**
 * Writes a person's access level, and optionally their departments, back.
 *
 * Only those cells. The sheet holds names, nicknames and positions that people
 * maintain by hand, and an integration that rewrote a whole row would sooner
 * or later overwrite something nobody asked it to touch.
 *
 * Returns a plain description of what happened rather than throwing: an admin
 * changing somebody's access should see the change take effect in the app even
 * if Google is unreachable, with an honest note that the sheet did not get it.
 */
export async function writeAccess(username, access, departments, sheetId = SHEET_ID) {
  if (!sheetWriteConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!sheetId) return { ok: false, reason: 'NO_SHEET' };

  try {
    const where = await locate(sheetId, username);
    if (where.error) return { ok: false, reason: where.error };

    const updates = [];
    if (where.accessCol !== -1 && ACCESS_LABEL[access]) {
      updates.push({
        range: `${columnLetter(where.accessCol)}${where.rowNumber}`,
        values: [[ACCESS_LABEL[access]]],
      });
    }
    if (where.deptCol !== -1 && Array.isArray(departments) && departments.length) {
      updates.push({
        range: `${columnLetter(where.deptCol)}${where.rowNumber}`,
        values: [[departments.join(', ')]],
      });
    }
    if (!updates.length) return { ok: false, reason: 'NOTHING_TO_WRITE' };

    await callSheets(`${encodeURIComponent(sheetId)}/values:batchUpdate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
    });
    return { ok: true, cells: updates.map((u) => u.range) };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    console.error('[sheets] write failed:', message);
    return { ok: false, reason: 'GOOGLE_REFUSED', message };
  }
}

export { columnLetter, locate };
