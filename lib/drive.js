/**
 * The long-term home for finished documents: Google Drive.
 *
 * A document lives in the database only while it is moving — a handful are ever
 * open at once. Once it has been signed by everyone and sent to its recipient
 * it stops being work in progress and becomes a record the committee keeps, and
 * a record belongs somewhere people can open next year without this app.
 *
 * Why a refresh token and not a service account, which everything else here
 * uses: a service account has no Drive storage of its own. It can edit a
 * spreadsheet somebody shares with it, but an upload to a personal Drive fails
 * with storageQuotaExceeded, because there is no personal Drive to put it in.
 * So the archive acts as a real Google account — one owned by the committee,
 * not by whoever happens to be president — and this holds a refresh token for
 * it.
 *
 * The scope is drive.file, which is the narrowest one that can upload: it gives
 * access to files this app itself created and to nothing else in that account.
 * Even with the token, this code cannot read a single other document in that
 * Drive.
 *
 * Environment:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_DRIVE_REFRESH_TOKEN
 *   GOOGLE_DRIVE_FOLDER_ID   (optional — the folder to file everything under)
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

export const driveConfigured = () =>
  Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN);

let cachedToken = null;

/**
 * A fresh access token from the stored refresh token.
 *
 * Google's refresh tokens do not expire on their own once the consent screen is
 * published — an app left in "Testing" hands out tokens that die after seven
 * days, which is a quiet failure a week later rather than a loud one now, so
 * the setup notes say to publish it.
 */
async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google refused the archive account: HTTP ${res.status} — ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/** Filenames that survive Windows, macOS and Drive's own search alike. */
const safeName = (text) =>
  String(text ?? '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';

/**
 * Puts one PDF in the archive.
 *
 * Multipart rather than resumable: these are at most three megabytes, and a
 * resumable upload costs an extra round trip to save nothing at this size.
 *
 * Returns `{ ok, id, url }`, or `{ ok: false, reason }`. Never throws — an
 * archive that cannot be reached must not take the document with it. The next
 * hourly run tries again.
 */
export async function archivePdf(bytes, { name, description = '' } = {}) {
  if (!driveConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!bytes || !bytes.length) return { ok: false, reason: 'NO_FILE' };

  try {
    const token = await accessToken();
    const folder = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const metadata = {
      name: `${safeName(name)}.pdf`,
      mimeType: 'application/pdf',
      description: description.slice(0, 500),
      ...(folder ? { parents: [folder] } : {}),
    };

    const boundary = `fair${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: 'DRIVE_REFUSED', message: detail.slice(0, 200) };
    }
    const data = await res.json();
    return {
      ok: true,
      id: data.id,
      url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    };
  } catch (error) {
    return { ok: false, reason: 'DRIVE_UNREACHABLE', message: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * Confirms a file is really in the archive and is the size it should be.
 *
 * The database copy is deleted three days after archiving, and "deleted the
 * only copy because an upload half-succeeded" is not a mistake this app gets to
 * make. So the purge asks Drive first, and a file that cannot be confirmed is
 * kept.
 */
export async function archiveHolds(fileId, expectedSize = 0) {
  if (!driveConfigured() || !fileId) return { ok: false, reason: 'NOT_CONFIGURED' };
  try {
    const token = await accessToken();
    const res = await fetch(
      `${FILES_URL}/${encodeURIComponent(fileId)}?fields=id,size,trashed&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, reason: 'NOT_FOUND' };
    const data = await res.json();
    if (data.trashed) return { ok: false, reason: 'IN_TRASH' };
    const size = Number(data.size || 0);
    if (expectedSize && size && size < expectedSize) return { ok: false, reason: 'SHORT_FILE', size };
    return { ok: true, size };
  } catch (error) {
    return { ok: false, reason: 'DRIVE_UNREACHABLE', message: String(error?.message || error).slice(0, 200) };
  }
}

export { safeName };
