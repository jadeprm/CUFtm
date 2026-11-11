/**
 * Share links: one address that opens one task, meeting or event.
 *
 *   GET    /api/meta?do=share&t=…        open what a link points at
 *   GET    /api/meta?do=share&kind=&id=  the live link for this thing, if any
 *   POST   /api/meta?do=share            make one
 *   DELETE /api/meta?do=share&kind=&id=  stop it working
 *
 * What a link is FOR: somebody in another ฝ่าย asks "what is this งาน you
 * mentioned in the meeting?" and the honest answer used to be a screenshot,
 * because the task list only shows people what their own ฝ่าย is doing. A
 * link is the answer instead — and because a screenshot is the alternative,
 * read-only is not a limitation here, it is the whole point.
 *
 * Who may open one: anybody signed in to this app, and nobody else. A link
 * that leaked into a group chat is useless to an outsider, and a committee
 * member opening one is a person the committee already trusts with the app.
 * The committee's real secrets are the documents, which are not shareable
 * this way at all.
 *
 * Who may make one: whoever may change the thing. A link widens who can see
 * something, so it belongs to the people who run it rather than to everyone
 * who can see it.
 *
 * Opening a link grants SIGHT and nothing else. Every button on the page
 * still asks the same question it always did, so somebody who follows a link
 * to a task they are not on can read it and cannot touch it.
 */
import { randomBytes } from 'node:crypto';

export const SHARE_KINDS = ['task', 'meeting', 'event'];

/** 128 bits in an address-safe alphabet. Guessing one is not a strategy. */
export const newShareToken = () => randomBytes(16).toString('base64url');

export const isShareToken = (v) => /^[A-Za-z0-9_-]{16,64}$/.test(String(v ?? ''));

/** The link for this thing, or null. */
export async function shareOf(sql, kind, refId) {
  const [row] = await sql`
    SELECT * FROM share_links WHERE kind = ${kind} AND ref_id = ${refId}`;
  return row || null;
}

/**
 * Make one, or hand back the one that already exists.
 *
 * Pressing "share" twice must not quietly retire the address somebody has
 * already pasted somewhere, so this is deliberately not a new token each
 * time. Replacing a token is a separate, explicit act: stop sharing, then
 * share again.
 */
export async function makeShare(sql, kind, refId, by) {
  const already = await shareOf(sql, kind, refId);
  if (already) return already;
  const token = newShareToken();
  await sql`
    INSERT INTO share_links (token, kind, ref_id, created_by)
    VALUES (${token}, ${kind}, ${refId}, ${by})
    ON CONFLICT (kind, ref_id) DO NOTHING`;
  return (await shareOf(sql, kind, refId)) || null;
}

export async function dropShare(sql, kind, refId) {
  const rows = await sql`
    DELETE FROM share_links WHERE kind = ${kind} AND ref_id = ${refId} RETURNING token`;
  return rows.length > 0;
}

/** What a token points at, or null when it was revoked or never existed. */
export async function readShare(sql, token) {
  if (!isShareToken(token)) return null;
  const [row] = await sql`SELECT * FROM share_links WHERE token = ${token}`;
  return row || null;
}

/** The address to copy. The app resolves #/s/<token> on arrival. */
export const shareUrl = (site, token) => `${String(site || '').replace(/\/+$/, '')}/#/s/${token}`;
