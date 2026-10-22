/**
 * The feed: what the committee says to itself.
 *
 * Everything else in this app is work. A task has an owner and a deadline, a
 * document is on its way somewhere, an announcement is one person telling
 * everybody. None of that is where a committee of two hundred actually lives
 * — that was a LINE group, where the photo of last night's build and the
 * question about Friday scroll past each other and are gone by morning.
 *
 * So: posts, pictures, likes and comments, and nothing else. The things it
 * deliberately does NOT have are as much the design as the things it does.
 *
 * **No nested replies.** A committee feed is not a forum, and what a nested
 * thread reliably produces on a phone is a column six indents deep that
 * nobody can read. To answer one person, say their name — which is what
 * mentions are for.
 *
 * **No algorithm.** Newest first, always. A feed that decides what somebody
 * should see is a feed people cannot rely on for "did I miss anything", and
 * that reliability is the entire reason to move off the LINE group.
 *
 * **No reactions beyond one.** A single ❤ says "seen, and I liked it", which
 * is the whole job. Six emoji would turn every post into a small referendum.
 *
 * **Reporting hides nothing.** One person's objection is not a verdict, and a
 * feed where anybody can make a post vanish has a heckler's veto. A report
 * puts the post in front of the admins, who decide.
 */

import { ACCESS } from './auth.js';
import { isDepartment } from './departments.js';
import { accessSet, seesEverything, safeUrl } from './scope.js';
import { sortRecipients } from './notifyprefs.js';
import { sendToMany } from './push.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Four pictures is a post; twelve is an album nobody scrolls past. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE = 2 * 1024 * 1024;
/** Enough for "here is the sheet and the form"; not a link dump. */
export const MAX_LINKS = 3;
export const MAX_BODY = 4000;
export const MAX_COMMENT = 1500;
/** One page of feed. The page asks for more when somebody reaches the end. */
export const PAGE_SIZE = 25;
/** Nobody can be tagged into a post twenty times over. */
export const MAX_MENTIONS = 20;

/** Five held items above the stream is already a second feed. */
export const MAX_PINNED = 5;

const clipLines = (v, max) =>
  String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const clip = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * Everybody posts. That is the point, and it is what Jade asked for.
 *
 * Unlike the shelf and the task list, there is no editor floor here: a feed
 * only works if the people doing the work are in it, and a สมาชิกฝ่าย who
 * has to ask their ประธานฝ่าย to post a photo simply will not post.
 */
export const canPost = (user) => Boolean(user);

/** The ฝ่าย feeds this person may read. */
export function canSeeFeed(user, department) {
  if (!user) return false;
  if (!department) return true;
  return seesEverything(user) || accessSet(user).has(department);
}

/**
 * Where somebody may post.
 *
 * Reading another ฝ่าย's feed and posting into it are different things: an
 * Editor sees across the whole fair by design (the 15 October rule), but
 * dropping a post into a ฝ่าย they are not part of is walking into somebody
 * else's room. Posting is for the committee feed and your own ฝ่าย.
 */
export function canPostTo(user, department) {
  if (!user) return false;
  if (!department) return true;
  if (user.access === ACCESS.ADMIN || user.access === ACCESS.COADMIN) return true;
  return accessSet(user).has(department);
}

/** Your own post, until somebody has replied to it — then the edit is marked. */
export const canEditPost = (user, post) =>
  Boolean(user && post) && post.created_by === user.username;

/**
 * Deleting: the author, and the admins.
 *
 * Not ประธานฝ่าย for their own ฝ่าย's feed, deliberately. A head deleting a
 * member's post is the thing that kills a feed, and "ask an admin" is a
 * slow enough path that it only gets walked when something is actually
 * wrong.
 */
export const canDeletePost = (user, post) =>
  Boolean(user && post)
  && (post.created_by === user.username
    || user.access === ACCESS.ADMIN || user.access === ACCESS.COADMIN);

export const canModerate = (user) =>
  user?.access === ACCESS.ADMIN || user?.access === ACCESS.COADMIN;

/** A comment is the commenter's, the post owner's, or an admin's to remove. */
export const canDeleteComment = (user, comment, post) =>
  Boolean(user && comment)
  && (comment.created_by === user.username
    || (post && post.created_by === user.username)
    || canModerate(user));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One page of the feed.
 *
 * `department` null with `scope: 'all'` means everything this person may see
 * — the combined feed. A named department means that ฝ่าย alone. 'main'
 * means the committee-wide feed only, which is what somebody wants when the
 * ฝ่าย chatter is not what they came for.
 *
 * Paged by timestamp rather than OFFSET: a feed gains rows at the top while
 * somebody is reading it, and OFFSET 25 after three new posts shows them
 * three they have already read.
 */
export async function listPosts(sql, me, { scope = 'all', department = null, before = null } = {}) {
  const mine = seesEverything(me) ? null : [...accessSet(me)].filter(Boolean);
  const cutoff = before || null;

  if (scope === 'main') {
    return sql`
      SELECT * FROM posts
       WHERE department IS NULL
         AND pinned_at IS NULL
         AND (${cutoff}::timestamptz IS NULL OR created_at < ${cutoff}::timestamptz)
       ORDER BY created_at DESC LIMIT ${PAGE_SIZE + 1}`;
  }

  if (scope === 'dept' && department) {
    return sql`
      SELECT * FROM posts
       WHERE department = ${department}
         AND pinned_at IS NULL
         AND (${cutoff}::timestamptz IS NULL OR created_at < ${cutoff}::timestamptz)
       ORDER BY created_at DESC LIMIT ${PAGE_SIZE + 1}`;
  }

  if (scope === 'mentions') {
    return sql`
      SELECT p.* FROM posts p
       WHERE EXISTS (SELECT 1 FROM post_mentions m
                      WHERE m.post_id = p.id AND m.username = ${me.username})
         AND p.pinned_at IS NULL
         AND (${cutoff}::timestamptz IS NULL OR p.created_at < ${cutoff}::timestamptz)
       ORDER BY p.created_at DESC LIMIT ${PAGE_SIZE + 1}`;
  }

  // Everything this person may see: the committee feed plus their own ฝ่าย.
  if (mine === null) {
    return sql`
      SELECT * FROM posts
       WHERE pinned_at IS NULL
         AND (${cutoff}::timestamptz IS NULL OR created_at < ${cutoff}::timestamptz)
       ORDER BY created_at DESC LIMIT ${PAGE_SIZE + 1}`;
  }
  return sql`
    SELECT * FROM posts
     WHERE (department IS NULL OR department = ANY(${mine.length ? mine : ['']}))
       AND pinned_at IS NULL
         AND (${cutoff}::timestamptz IS NULL OR created_at < ${cutoff}::timestamptz)
     ORDER BY created_at DESC LIMIT ${PAGE_SIZE + 1}`;
}

/**
 * The pinned posts, which are their own short list above the stream.
 *
 * Kept out of the paginated query rather than sorted to the top of it. The
 * feed pages by `created_at < cutoff`, which is exactly what makes it cheap
 * and correct — and a pinned post from September sorted to the top would
 * either be skipped by that cutoff on page two or repeat on every page. A
 * separate list on the first page only is both simpler and what the reader
 * expects: a few held items, then the stream.
 */
export async function pinnedPosts(sql, me, { scope = 'all', department = null } = {}) {
  const mine = seesEverything(me) ? null : [...accessSet(me)].filter(Boolean);

  /**
   * Capped. Five pinned posts is a second feed above the feed, at which
   * point nothing is pinned because everything is.
   */
  if (scope === 'main') {
    return sql`
      SELECT * FROM posts WHERE pinned_at IS NOT NULL AND department IS NULL
       ORDER BY pinned_at DESC LIMIT ${MAX_PINNED}`;
  }
  if (scope === 'dept' && department) {
    return sql`
      SELECT * FROM posts WHERE pinned_at IS NOT NULL AND department = ${department}
       ORDER BY pinned_at DESC LIMIT ${MAX_PINNED}`;
  }
  if (scope === 'mentions') return [];
  if (mine === null) {
    return sql`
      SELECT * FROM posts WHERE pinned_at IS NOT NULL
       ORDER BY pinned_at DESC LIMIT ${MAX_PINNED}`;
  }
  return sql`
    SELECT * FROM posts
     WHERE pinned_at IS NOT NULL
       AND (department IS NULL OR department = ANY(${mine.length ? mine : ['']}))
     ORDER BY pinned_at DESC LIMIT ${MAX_PINNED}`;
}

/**
 * Holding a post at the top, or letting it go.
 *
 * Only `canModerate` — the same people who handle a reported post. Posting
 * is open to everybody because a post costs nobody anything; the top of two
 * hundred people's page is not the same kind of thing.
 */
export async function setPinned(sql, me, post, pinned) {
  if (pinned) {
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM posts
       WHERE pinned_at IS NOT NULL AND id <> ${post.id}
         AND (department IS NOT DISTINCT FROM ${post.department || null})`;
    if (n >= MAX_PINNED) return { error: 'TOO_MANY_PINNED', limit: MAX_PINNED };
  }
  await sql`
    UPDATE posts SET pinned_at = ${pinned ? new Date().toISOString() : null},
           pinned_by = ${pinned ? me.username : null}
     WHERE id = ${post.id}`;
  const [row] = await sql`SELECT * FROM posts WHERE id = ${post.id}`;
  return { post: row };
}

/**
 * Everything the page needs about a set of posts, in four queries rather than
 * four per post. A feed of 25 posts each fetching its own likes and comments
 * is 100 round trips to a database billed by the request.
 */
export async function hydrate(sql, me, posts) {
  const ids = posts.map((p) => p.id);
  if (!ids.length) return { files: {}, likes: {}, comments: {}, mentions: {}, reports: {} };

  const files = await sql`
    SELECT post_id, idx, kind, mime, width, height, byte_size, url, title
      FROM post_files WHERE post_id = ANY(${ids}) ORDER BY idx`;
  const likes = await sql`
    SELECT post_id, count(*)::int AS n,
           bool_or(username = ${me.username}) AS mine
      FROM post_likes WHERE post_id = ANY(${ids}) GROUP BY post_id`;
  const comments = await sql`
    SELECT id, post_id, body, created_by, created_at, edited_at
      FROM post_comments WHERE post_id = ANY(${ids}) ORDER BY created_at`;
  const mentions = await sql`
    SELECT post_id, comment_id, username FROM post_mentions WHERE post_id = ANY(${ids})`;
  const reports = await sql`
    SELECT post_id, count(*)::int AS n FROM post_reports
     WHERE post_id = ANY(${ids}) AND handled_at IS NULL GROUP BY post_id`;

  const by = (rows, key) => {
    const out = {};
    for (const r of rows) (out[r[key]] ||= []).push(r);
    return out;
  };
  const likeBy = {};
  for (const r of likes) likeBy[r.post_id] = { n: Number(r.n), mine: Boolean(r.mine) };
  const reportBy = {};
  for (const r of reports) reportBy[r.post_id] = Number(r.n);

  return {
    files: by(files, 'post_id'),
    likes: likeBy,
    comments: by(comments, 'post_id'),
    mentions: by(mentions, 'post_id'),
    reports: reportBy,
  };
}

export function shapePost(row, me, extra) {
  const files = extra.files[row.id] || [];
  const comments = extra.comments[row.id] || [];
  const mentions = (extra.mentions[row.id] || []);
  const like = extra.likes[row.id] || { n: 0, mine: false };

  return {
    id: row.id,
    department: row.department || null,
    body: row.body,
    createdBy: row.created_by,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    mine: row.created_by === me.username,
    pinned: Boolean(row.pinned_at),
    pinnedAt: row.pinned_at || null,
    mayEdit: canEditPost(me, row),
    mayDelete: canDeletePost(me, row),
    likes: like.n,
    liked: like.mine,
    images: files.filter((f) => f.kind === 'image').map((f) => ({
      idx: f.idx, width: Number(f.width) || 0, height: Number(f.height) || 0,
      size: Number(f.byte_size) || 0,
    })),
    links: files.filter((f) => f.kind === 'link').map((f) => ({
      idx: f.idx, url: f.url, title: f.title,
    })),
    // Tagged on the post itself, as opposed to in one of its comments.
    mentions: mentions.filter((m) => !m.comment_id).map((m) => m.username),
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdBy: c.created_by,
      createdAt: c.created_at,
      editedAt: c.edited_at || null,
      mentions: mentions.filter((m) => m.comment_id === c.id).map((m) => m.username),
      mayDelete: canDeleteComment(me, c, row),
    })),
    // Only the people who can act on a report are told one exists.
    reports: canModerate(me) ? (extra.reports[row.id] || 0) : 0,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The people a post may tag.
 *
 * Checked against the roster rather than trusted, and silently narrowed to
 * active accounts: tagging somebody who left should not fail the post, it
 * should just not tag them.
 */
export async function readMentions(sql, asked) {
  const names = [...new Set((Array.isArray(asked) ? asked : [])
    .map((n) => clip(n, 64)).filter(Boolean))].slice(0, MAX_MENTIONS);
  if (!names.length) return [];
  const rows = await sql`
    SELECT username FROM users
     WHERE username = ANY(${names}) AND active = true AND suspended = false`;
  return rows.map((r) => r.username);
}

export function readLinks(asked) {
  const out = [];
  for (const raw of (Array.isArray(asked) ? asked : []).slice(0, MAX_LINKS)) {
    const url = safeUrl(typeof raw === 'string' ? raw : raw?.url);
    if (!url) return { error: 'BAD_URL' };
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; }
    out.push({ url, title: clip(raw?.title, 120) || host });
  }
  return { links: out };
}

export async function addPost(sql, me, input, images) {
  const department = clip(input.department, 40) || null;
  if (department && !isDepartment(department)) return { error: 'NO_SUCH_DEPARTMENT' };
  if (!canPostTo(me, department)) return { error: 'NOT_YOUR_DEPARTMENT' };

  const body = clipLines(input.body, MAX_BODY);
  const got = readLinks(input.links);
  if (got.error) return { error: got.error };

  /**
   * A post has to carry something. An empty one is almost always a slip of
   * the thumb, and a feed with blank cards in it looks broken.
   */
  if (!body && !images.length && !got.links.length) return { error: 'NOTHING_TO_POST' };

  const id = newId('po');
  await sql`
    INSERT INTO posts (id, department, body, created_by)
    VALUES (${id}, ${department}, ${body}, ${me.username})`;

  let idx = 0;
  for (const img of images) {
    await sql`
      INSERT INTO post_files (post_id, idx, kind, bytes, mime, width, height, byte_size)
      VALUES (${id}, ${idx}, 'image', ${img.buffer}, ${img.mime},
              ${img.width || 0}, ${img.height || 0}, ${img.buffer.length})`;
    idx += 1;
  }
  for (const link of got.links) {
    await sql`
      INSERT INTO post_files (post_id, idx, kind, url, title)
      VALUES (${id}, ${idx}, 'link', ${link.url}, ${link.title})`;
    idx += 1;
  }

  const tagged = await readMentions(sql, input.mentions);
  for (const username of tagged) {
    await sql`
      INSERT INTO post_mentions (post_id, comment_id, username)
      VALUES (${id}, ${null}, ${username}) ON CONFLICT DO NOTHING`;
  }

  const [row] = await sql`SELECT * FROM posts WHERE id = ${id}`;
  return { post: row, mentioned: tagged };
}

/**
 * Editing the words.
 *
 * Pictures and links are not editable: replacing the photo under a comment
 * that says "nice photo" is the one edit that genuinely misleads people, and
 * deleting and reposting is both easy and honest.
 */
export async function editPost(sql, post, input) {
  const body = clipLines(input.body, MAX_BODY);
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM post_files WHERE post_id = ${post.id}`;
  if (!body && !Number(n)) return { error: 'NOTHING_TO_POST' };

  await sql`
    UPDATE posts SET body = ${body}, edited_at = now(), updated_at = now()
     WHERE id = ${post.id}`;
  const [row] = await sql`SELECT * FROM posts WHERE id = ${post.id}`;
  return { post: row };
}

export async function toggleLike(sql, me, post) {
  const [had] = await sql`
    SELECT 1 FROM post_likes WHERE post_id = ${post.id} AND username = ${me.username}`;
  if (had) {
    await sql`DELETE FROM post_likes WHERE post_id = ${post.id} AND username = ${me.username}`;
  } else {
    await sql`
      INSERT INTO post_likes (post_id, username) VALUES (${post.id}, ${me.username})
      ON CONFLICT DO NOTHING`;
  }
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM post_likes WHERE post_id = ${post.id}`;
  return { liked: !had, likes: Number(n) };
}

export async function addComment(sql, me, post, input) {
  const body = clipLines(input.body, MAX_COMMENT);
  if (!body) return { error: 'NOTHING_TO_POST' };

  const id = newId('pc');
  await sql`
    INSERT INTO post_comments (id, post_id, body, created_by)
    VALUES (${id}, ${post.id}, ${body}, ${me.username})`;

  const tagged = await readMentions(sql, input.mentions);
  for (const username of tagged) {
    await sql`
      INSERT INTO post_mentions (post_id, comment_id, username)
      VALUES (${post.id}, ${id}, ${username}) ON CONFLICT DO NOTHING`;
  }

  const [row] = await sql`SELECT * FROM post_comments WHERE id = ${id}`;
  return { comment: row, mentioned: tagged };
}

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

/**
 * The feed is quiet on purpose.
 *
 * It does NOT tell anybody that a new post exists. That is the difference
 * between a feed people visit and a LINE group people mute: two hundred
 * posts a week each buzzing two hundred phones is the thing everybody left
 * LINE to escape, and the moment it happens people turn the whole category
 * off and stop hearing the two notices that mattered.
 *
 * So exactly two things reach a phone: somebody replied to YOUR post, and
 * somebody tagged YOU. Both are addressed to one person by name, and both
 * are things that person is expected to answer.
 */
export async function tellAboutFeed(sql, { to, actor, title, body, url, tag }) {
  const people = [...new Set((to || []).filter((u) => u && u !== actor))];
  if (!people.length) return 0;

  const { loud, quiet } = await sortRecipients(sql, people, { category: 'feed' });
  const targets = loud.concat(quiet);
  if (!targets.length) return 0;

  const idFor = {};
  for (const u of targets) idFor[u] = newId('n');
  await sql`
    INSERT INTO notifications (id, username, kind, title, body)
    SELECT i, u, 'feed', ${clip(title, 200)}, ${clip(body, 500)}
    FROM unnest(${targets.map((u) => idFor[u])}::text[], ${targets}::text[]) AS t(i, u)`;

  if (loud.length) {
    try {
      await sendToMany(sql, loud, (username) => ({
        id: idFor[username],
        title: clip(title, 200),
        body: clip(body, 500),
        level: 'normal',
        tag,
        url: url || './#/feed',
      }));
    } catch (error) {
      console.error('[feed] push failed:', String(error?.message || error).slice(0, 200));
    }
  }
  return targets.length;
}

/** What the admins need to see: posts somebody has objected to. */
export async function flagged(sql) {
  return sql`
    SELECT r.post_id, r.comment_id, r.username, r.why, r.at,
           p.body, p.created_by, p.department
      FROM post_reports r JOIN posts p ON p.id = r.post_id
     WHERE r.handled_at IS NULL
     ORDER BY r.at DESC LIMIT 100`;
}
