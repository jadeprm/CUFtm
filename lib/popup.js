/**
 * The pop-up that greets people when they open the app.
 *
 * The committee's problem was never that it had nothing to say. It is that a
 * notice in LINE reaches whoever is reading LINE, and a notice in the bell
 * reaches whoever presses the bell — and neither reaches somebody who opened
 * the app to see their own tasks, which is the one moment nearly everybody
 * passes through.
 *
 * So this is the most intrusive thing in the app: a box over the page, before
 * anything else. Which is exactly why it is the most constrained thing in the
 * app. Three rules, and they are the whole design:
 *
 *   **Once per person.** `popup_seen` remembers, and the author has to go out
 *   of their way to choose otherwise. A notice that reappears on every visit
 *   is a notice people learn to dismiss before reading, and once they have
 *   learnt that, the next one does not work either.
 *
 *   **It ends by itself.** Every pop-up has a window. Nobody has to remember
 *   to switch off the notice about last Tuesday's meeting, because the thing
 *   that makes these useless is the stale one that nobody took down.
 *
 *   **Only admins and co-admins.** Not every Editor. There are forty-odd
 *   people who can create work; if all of them could put a box in front of
 *   the whole committee, there would be a queue.
 */

import { ACCESS } from './auth.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * How often one pop-up may come back.
 *
 *   once   — the normal case, and the default
 *   daily  — once each day it is live, for a countdown that is worth repeating
 *   always — every single load, for the genuine emergency only
 */
export const REPEATS = ['once', 'daily', 'always'];

/** A poster, not a photo album. 1.5 MB covers any reasonable JPEG or PNG. */
export const MAX_IMAGE = 1.5 * 1024 * 1024;

/** More than a handful live at once and it stops being a pop-up and becomes a queue. */
export const MAX_LIVE = 3;

export const isRepeat = (v) => REPEATS.includes(v);
export const canManagePopups = (user) =>
  user?.access === ACCESS.ADMIN || user?.access === ACCESS.COADMIN;

const clip = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clipLines = (v, max) =>
  String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);

const stamp = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Reads what an admin typed, or says what is wrong with it.
 *
 * A pop-up needs a title and either words or a picture — a box with a heading
 * and nothing in it is worse than no box. Beyond that everything is optional,
 * because the common case is three lines and a poster.
 */
export function readPopup(input, { existing = null, safeUrl } = {}) {
  const title = input.title !== undefined ? clip(input.title, 120) : existing?.title;
  if (!title) return { error: 'TITLE_REQUIRED' };

  const body = input.body !== undefined ? clipLines(input.body, 1200) : (existing?.body || '');

  let linkUrl = existing?.link_url || '';
  if (input.linkUrl !== undefined) {
    const raw = clip(input.linkUrl, 1000);
    if (!raw) linkUrl = '';
    else {
      const safe = safeUrl ? safeUrl(raw) : raw;
      if (!safe) return { error: 'BAD_URL' };
      linkUrl = safe;
    }
  }

  const starts = input.startsAt !== undefined ? stamp(input.startsAt) : (existing?.starts_at || null);
  const ends = input.endsAt !== undefined ? stamp(input.endsAt) : (existing?.ends_at || null);
  if (starts && ends && new Date(ends) <= new Date(starts)) return { error: 'ENDS_BEFORE_IT_STARTS' };

  const repeatMode = input.repeat !== undefined
    ? (isRepeat(input.repeat) ? input.repeat : 'once')
    : (existing?.repeat_mode || 'once');

  return {
    popup: {
      title,
      body,
      linkUrl,
      linkLabel: input.linkLabel !== undefined
        ? clip(input.linkLabel, 40)
        : (existing?.link_label || ''),
      repeatMode,
      startsAt: starts,
      endsAt: ends,
      active: input.active !== undefined ? Boolean(input.active) : (existing?.active ?? true),
    },
  };
}

export function shapePopup(row, { stats = null, forAdmin = false } = {}) {
  const out = {
    id: row.id,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url || '',
    linkLabel: row.link_label || '',
    hasImage: Boolean(row.image_mime),
    imageW: Number(row.image_w || 0),
    imageH: Number(row.image_h || 0),
    repeat: row.repeat_mode,
    startsAt: row.starts_at || null,
    endsAt: row.ends_at || null,
    active: row.active,
  };
  if (forAdmin) {
    out.createdBy = row.created_by;
    out.createdAt = row.created_at;
    out.audience = (() => {
      try { return JSON.parse(row.audience); } catch { return { kind: 'everyone' }; }
    })();
    out.live = isLive(row);
    /**
     * Shown to whoever wrote it, because it is the only honest measure of
     * whether the thing worked. A notice put in front of 180 people and
     * dismissed by 12 is worth knowing before the next one is written the
     * same way.
     */
    if (stats) out.stats = stats;
  }
  return out;
}

/** Whether a pop-up's window is open right now. */
export function isLive(row, now = new Date()) {
  if (!row.active) return false;
  if (row.starts_at && new Date(row.starts_at) > now) return false;
  if (row.ends_at && new Date(row.ends_at) <= now) return false;
  return true;
}

/**
 * The one pop-up to show this person, or none.
 *
 * `rows` are the live pop-ups this person's audience includes, newest first,
 * and `seen` maps a pop-up id to the row in popup_seen.
 *
 * Only ever ONE at a time, even when three are live: two boxes stacked over
 * the page is how somebody dismisses both without reading either. The others
 * wait for the next visit, which is also what makes MAX_LIVE a real limit
 * rather than a formality.
 */
export function pickForViewer(rows, seen, today) {
  for (const row of rows) {
    const mark = seen[row.id];
    if (!mark) return row;
    if (row.repeat_mode === 'always') return row;
    if (row.repeat_mode === 'daily' && String(mark.on_day) !== today) return row;
  }
  return null;
}

export async function addPopup(sql, user, popup, audience, image) {
  const [{ live }] = await sql`
    SELECT count(*)::int AS live FROM popups
     WHERE active = true AND (ends_at IS NULL OR ends_at > now())`;
  if (live >= MAX_LIVE) return { error: 'TOO_MANY_LIVE', limit: MAX_LIVE };

  const id = newId('pop');
  await sql`
    INSERT INTO popups (id, title, body, image, image_mime, image_w, image_h,
                        link_url, link_label, audience, repeat_mode,
                        starts_at, ends_at, active, created_by)
    VALUES (${id}, ${popup.title}, ${popup.body},
            ${image?.buffer || null}, ${image?.mime || ''},
            ${image?.width || 0}, ${image?.height || 0},
            ${popup.linkUrl}, ${popup.linkLabel},
            ${JSON.stringify(audience || { kind: 'everyone' })}, ${popup.repeatMode},
            ${popup.startsAt}, ${popup.endsAt}, ${popup.active}, ${user.username})`;

  const [row] = await sql`SELECT * FROM popups WHERE id = ${id}`;
  return { popup: row };
}

export async function editPopup(sql, existing, popup, audience, image) {
  await sql`
    UPDATE popups
       SET title = ${popup.title}, body = ${popup.body},
           link_url = ${popup.linkUrl}, link_label = ${popup.linkLabel},
           repeat_mode = ${popup.repeatMode}, starts_at = ${popup.startsAt},
           ends_at = ${popup.endsAt}, active = ${popup.active},
           audience = ${audience ? JSON.stringify(audience) : existing.audience},
           updated_at = now()
     WHERE id = ${existing.id}`;

  /**
   * The image is only touched when one was sent.
   *
   * Otherwise editing the words of a notice would silently drop its poster,
   * which is the kind of bug somebody discovers by looking at the live
   * pop-up. `image: null` explicitly removes it.
   */
  if (image === null) {
    await sql`
      UPDATE popups SET image = NULL, image_mime = '', image_w = 0, image_h = 0
       WHERE id = ${existing.id}`;
  } else if (image) {
    await sql`
      UPDATE popups SET image = ${image.buffer}, image_mime = ${image.mime},
             image_w = ${image.width || 0}, image_h = ${image.height || 0}
       WHERE id = ${existing.id}`;
  }

  const [row] = await sql`SELECT * FROM popups WHERE id = ${existing.id}`;
  return { popup: row };
}

/**
 * Who saw it and who followed the link.
 *
 * `shown` counts people, not impressions: a pop-up set to repeat daily and
 * dismissed by the same person five times is one person who has seen it, and
 * reporting five would make a notice nobody new has read look like it is
 * spreading.
 */
export async function statsFor(sql, id) {
  const [row] = await sql`
    SELECT count(*)::int AS shown,
           count(*) FILTER (WHERE clicked)::int AS clicked
      FROM popup_seen WHERE popup_id = ${id}`;
  return { shown: Number(row?.shown || 0), clicked: Number(row?.clicked || 0) };
}

/**
 * Reads the poster.
 *
 * The type is taken from the bytes, never from what the page claimed, and the
 * pixel size is read from the header so the box can hold the right amount of
 * room before the image arrives — a pop-up that jumps as its picture loads is
 * a pop-up whose dismiss button moves out from under somebody's thumb.
 */
export function readImage(value, { max = MAX_IMAGE } = {}) {
  const raw = String(value || '').replace(/^data:[^,]*,/, '');
  if (!raw) return { error: 'EMPTY_FILE' };
  let buffer;
  try { buffer = Buffer.from(raw, 'base64'); } catch { return { error: 'BAD_FILE' }; }
  if (!buffer.length) return { error: 'EMPTY_FILE' };
  if (buffer.length > max) return { error: 'IMAGE_TOO_BIG', limit: max, size: buffer.length };

  const size = imageSize(buffer);
  if (!size) return { error: 'NOT_AN_IMAGE' };
  return { buffer, mime: size.mime, width: size.width, height: size.height };
}

/**
 * The type and pixel size of a PNG, JPEG or WebP, from its header alone.
 *
 * Written out rather than pulled from a library because it is twenty lines
 * and this project has a hard twelve-function budget — a dependency for
 * reading two integers is a dependency to keep updated for the next year.
 */
export function imageSize(buffer) {
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer.slice(1, 4).toString('latin1') === 'PNG') {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    // Walk the segment markers to the first frame header, which carries the size.
    let at = 2;
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) { at++; continue; }
      const marker = buffer[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = buffer.readUInt16BE(at + 2);
      // SOF0/1/2/3/5/6/7/9/10/11/13/14/15 — every frame header but DHT/DAC/DNL.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          mime: 'image/jpeg',
          height: buffer.readUInt16BE(at + 5),
          width: buffer.readUInt16BE(at + 7),
        };
      }
      if (length < 2) break;
      at += 2 + length;
    }
    // A JPEG whose header could not be walked is still a JPEG; the box just
    // has to guess its shape, which is better than refusing a valid picture.
    return { mime: 'image/jpeg', width: 0, height: 0 };
  }

  if (buffer.length > 30
      && buffer.slice(0, 4).toString('latin1') === 'RIFF'
      && buffer.slice(8, 12).toString('latin1') === 'WEBP') {
    const kind = buffer.slice(12, 16).toString('latin1');
    if (kind === 'VP8X') {
      return {
        mime: 'image/webp',
        width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
        height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
      };
    }
    if (kind === 'VP8 ') {
      return {
        mime: 'image/webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (kind === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return {
        mime: 'image/webp',
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    return { mime: 'image/webp', width: 0, height: 0 };
  }

  return null;
}
