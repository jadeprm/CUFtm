import { getSql, json, noDatabase, hasDatabase, requestUrl, toBuffer } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';
import { accessSet, seesEverything } from '../lib/scope.js';
import { readImage } from '../lib/popup.js';
import {
  MAX_IMAGES, MAX_IMAGE, MAX_LINKS, PAGE_SIZE,
  canPost, canSeeFeed, canEditPost, canDeletePost, canDeleteComment, canModerate,
  listPosts, hydrate, shapePost, addPost, editPost, toggleLike, addComment,
  tellAboutFeed, flagged, pinnedPosts, setPinned, MAX_PINNED,
} from '../lib/feed.js';

/**
 * The bell: a person's own notifications.
 *
 *   GET   /api/notifications            my notifications, newest first
 *   PATCH /api/notifications            { ids: [...] } or { all: true } to mark read
 *   PATCH /api/notifications?do=ack     { id } — acknowledge an urgent one
 *
 * And the feed, which rides this endpoint — see the note above `feed()`:
 *
 *   GET    /api/notifications?do=feed          one page of it
 *   POST   /api/notifications?do=feed-post     write one
 *   PATCH  /api/notifications?do=feed-post     edit the words of my own
 *   DELETE /api/notifications?do=feed-post     remove one
 *   GET    /api/notifications?do=feed-image    a picture from a post
 *   POST   /api/notifications?do=feed-like     ❤, and pressing again takes it back
 *   POST   /api/notifications?do=feed-comment  reply
 *   DELETE /api/notifications?do=feed-comment  remove a reply
 *   POST   /api/notifications?do=feed-report   tell the admins about one
 *   GET    /api/notifications?do=feed-flagged  admin: what has been reported
 *   POST   /api/notifications?do=feed-flagged  admin: looked at it, nothing wrong
 */
async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const action = requestUrl(request).searchParams.get('do') || '';
  if (action.indexOf('feed') === 0) return feed(request, action, sql, me);

  if (request.method === 'GET') {
    const rows = await sql`
      SELECT * FROM notifications
      WHERE username = ${me.username}
      ORDER BY created_at DESC
      LIMIT 100`;
    const unread = rows.filter((r) => !r.read_at).length;
    return json({
      unread,
      notifications: rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        level: r.level || 'normal',
        announcementId: r.announcement_id || null,
        createdAt: r.created_at,
        read: Boolean(r.read_at),
        acked: Boolean(r.acked_at),
      })),
      // Urgent messages nobody has acknowledged yet. The page shows these on
      // top of whatever else is open — the whole point of marking something
      // urgent is that it is not waiting politely behind the task list.
      pending: rows
        .filter((r) => r.level === 'urgent' && !r.acked_at)
        .map((r) => r.id),
    });
  }

  // ---- acknowledge an urgent message --------------------------------------
  if (request.method === 'PATCH' && action === 'ack') {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id ?? '').slice(0, 64);
    if (!id) return json({ error: 'ID_REQUIRED' }, 400);
    await sql`
      UPDATE notifications SET acked_at = now(), read_at = COALESCE(read_at, now())
      WHERE id = ${id} AND username = ${me.username}`;
    const [{ unread }] = await sql`
      SELECT count(*)::int AS unread FROM notifications
      WHERE username = ${me.username} AND read_at IS NULL`;
    return json({ ok: true, unread });
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    if (body.all) {
      await sql`UPDATE notifications SET read_at = now()
                WHERE username = ${me.username} AND read_at IS NULL`;
    } else if (Array.isArray(body.ids) && body.ids.length) {
      const ids = body.ids.map((i) => String(i).slice(0, 64));
      await sql`UPDATE notifications SET read_at = now()
                WHERE username = ${me.username} AND id = ANY(${ids})`;
    }
    const [{ unread }] = await sql`
      SELECT count(*)::int AS unread FROM notifications
      WHERE username = ${me.username} AND read_at IS NULL`;
    return json({ ok: true, unread });
  }

  return json({ error: 'METHOD' }, 405);
}


// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/**
 * Why the feed lives in the notifications endpoint.
 *
 * Vercel's Hobby plan allows twelve Serverless Functions and there are
 * exactly twelve files under api/. A thirteenth fails the build, so every
 * feature since October has ridden an existing one. This was the smallest,
 * and the pairing is not arbitrary: almost everything the feed does to
 * anybody else is write them a notification.
 */
async function feed(request, action, sql, me) {
  const url = requestUrl(request);

  const postById = async (id) => {
    const [row] = await sql`SELECT * FROM posts WHERE id = ${String(id || '').slice(0, 64)}`;
    return row || null;
  };

  // ---- one page of it ----------------------------------------------------
  if (action === 'feed' && request.method === 'GET') {
    const scope = ['all', 'main', 'dept', 'mentions'].includes(url.searchParams.get('scope') || '')
      ? url.searchParams.get('scope') : 'all';
    const department = url.searchParams.get('department') || null;
    if (scope === 'dept' && !canSeeFeed(me, department)) {
      return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);
    }

    const rows = await listPosts(sql, me, {
      scope, department, before: url.searchParams.get('before') || null,
    });
    // One more than a page was asked for, so "is there more" needs no count.
    const more = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const extra = await hydrate(sql, me, page);

    /**
     * The pinned posts ride along with the FIRST page only.
     *
     * They are a short fixed list, not part of the stream — sending them
     * again with page two would just draw them twice.
     */
    let pinned = [];
    if (!url.searchParams.get('before')) {
      const rows = await pinnedPosts(sql, me, { scope, department });
      const pinExtra = await hydrate(sql, me, rows);
      pinned = rows.map((r) => shapePost(r, me, pinExtra));
    }

    return json({
      posts: page.map((r) => shapePost(r, me, extra)),
      pinned,
      maxPinned: MAX_PINNED,
      more,
      next: page.length ? page[page.length - 1].created_at : null,
      mayPost: canPost(me),
      maxImages: MAX_IMAGES,
      maxImage: MAX_IMAGE,
      maxLinks: MAX_LINKS,
      mayModerate: canModerate(me),
      /** The ฝ่าย this person may post into, for the composer's picker. */
      myDepartments: [...accessSet(me)].filter(Boolean),
      seesEverything: seesEverything(me),
    });
  }

  // ---- writing one -------------------------------------------------------
  if (action === 'feed-post' && request.method === 'POST') {
    if (!canPost(me)) return json({ error: 'CANNOT_POST' }, 403);
    const body = await request.json().catch(() => ({}));

    const images = [];
    for (const raw of (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)) {
      const got = readImage(raw, { max: MAX_IMAGE });
      if (got.error) return json({ error: got.error, limit: MAX_IMAGE }, 400);
      images.push(got);
    }

    const made = await addPost(sql, me, body, images);
    if (made.error) return json({ error: made.error }, 400);

    if (made.mentioned.length) {
      await tellAboutFeed(sql, {
        to: made.mentioned,
        actor: me.username,
        title: `${me.nickname || me.display_name || me.username} แท็กคุณในโพสต์`,
        body: made.post.body || '(รูปภาพ)',
        tag: `feed-${made.post.id}`,
      });
    }

    const extra = await hydrate(sql, me, [made.post]);
    return json({ post: shapePost(made.post, me, extra) }, 201);
  }

  // ---- editing the words -------------------------------------------------
  if (action === 'feed-post' && request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const post = await postById(body.id);
    if (!post) return json({ error: 'NO_SUCH_POST' }, 404);

    /**
     * Pinning and editing are different powers, so they are checked apart:
     * an admin may hold anybody's post at the top without that meaning they
     * may rewrite its words, and an author may rewrite their own without
     * being able to put it in front of two hundred people.
     */
    if (body.pinned !== undefined) {
      if (!canModerate(me)) return json({ error: 'ADMINS_ONLY' }, 403);
      const done = await setPinned(sql, me, post, Boolean(body.pinned));
      if (done.error) return json({ error: done.error, limit: done.limit }, 400);
      const extra = await hydrate(sql, me, [done.post]);
      return json({ post: shapePost(done.post, me, extra) });
    }

    if (!canEditPost(me, post)) return json({ error: 'NOT_YOUR_POST' }, 403);

    const done = await editPost(sql, post, body);
    if (done.error) return json({ error: done.error }, 400);
    const extra = await hydrate(sql, me, [done.post]);
    return json({ post: shapePost(done.post, me, extra) });
  }

  // ---- removing one ------------------------------------------------------
  if (action === 'feed-post' && request.method === 'DELETE') {
    const post = await postById(url.searchParams.get('id'));
    if (!post) return json({ error: 'NO_SUCH_POST' }, 404);
    if (!canDeletePost(me, post)) return json({ error: 'NOT_YOUR_POST' }, 403);
    // Pictures, comments, likes and reports all cascade from the row.
    await sql`DELETE FROM posts WHERE id = ${post.id}`;
    return json({ ok: true, deleted: post.id });
  }

  // ---- a picture ---------------------------------------------------------
  if (action === 'feed-image' && request.method === 'GET') {
    const post = await postById(url.searchParams.get('id'));
    if (!post) return json({ error: 'NO_SUCH_POST' }, 404);
    if (!canSeeFeed(me, post.department)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);

    const idx = Math.max(0, Math.min(MAX_IMAGES - 1, Number(url.searchParams.get('i') || 0)));
    const [row] = await sql`
      SELECT bytes, mime FROM post_files
       WHERE post_id = ${post.id} AND idx = ${idx} AND kind = 'image'`;
    if (!row || !row.bytes) return json({ error: 'NO_SUCH_IMAGE' }, 404);

    const bytes = toBuffer(row.bytes);
    return new Response(bytes, {
      headers: {
        'content-type': row.mime || 'image/png',
        'content-length': String(bytes.length),
        // A feed photo never changes once posted, so it may be cached hard —
        // but privately: a ฝ่าย's feed is not for a shared proxy to keep.
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // ---- ❤ -----------------------------------------------------------------
  if (action === 'feed-like' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const post = await postById(body.id);
    if (!post) return json({ error: 'NO_SUCH_POST' }, 404);
    if (!canSeeFeed(me, post.department)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);
    /**
     * A like tells nobody. It is the lightest thing in the app on purpose,
     * and a notification per heart would make it the loudest.
     */
    return json(await toggleLike(sql, me, post));
  }

  // ---- comments ----------------------------------------------------------
  if (action === 'feed-comment' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const post = await postById(body.postId);
    if (!post) return json({ error: 'NO_SUCH_POST' }, 404);
    if (!canSeeFeed(me, post.department)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);

    const made = await addComment(sql, me, post, body);
    if (made.error) return json({ error: made.error }, 400);

    const who = me.nickname || me.display_name || me.username;
    /**
     * The post's author hears, and so does anybody tagged — but nobody is
     * told twice for one comment, which is why the mention list has the
     * author removed from it rather than both notices going out.
     */
    const tagged = made.mentioned.filter((u) => u !== post.created_by);
    await tellAboutFeed(sql, {
      to: [post.created_by],
      actor: me.username,
      title: `${who} ตอบโพสต์ของคุณ`,
      body: made.comment.body,
      tag: `feed-${post.id}`,
    });
    if (tagged.length) {
      await tellAboutFeed(sql, {
        to: tagged,
        actor: me.username,
        title: `${who} แท็กคุณในความคิดเห็น`,
        body: made.comment.body,
        tag: `feed-${post.id}`,
      });
    }

    const extra = await hydrate(sql, me, [post]);
    return json({ post: shapePost(post, me, extra) }, 201);
  }

  if (action === 'feed-comment' && request.method === 'DELETE') {
    const [comment] = await sql`
      SELECT * FROM post_comments WHERE id = ${String(url.searchParams.get('id') || '').slice(0, 64)}`;
    if (!comment) return json({ error: 'NO_SUCH_COMMENT' }, 404);
    const post = await postById(comment.post_id);
    if (!canDeleteComment(me, comment, post)) return json({ error: 'NOT_YOUR_COMMENT' }, 403);
    await sql`DELETE FROM post_comments WHERE id = ${comment.id}`;
    return json({ ok: true, deleted: comment.id });
  }

  // ---- reporting ---------------------------------------------------------
  if (action === 'feed-report' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const post = await postById(body.postId);
    if (!post) return json({ error: 'NO_SUCH_POST' }, 404);
    if (!canSeeFeed(me, post.department)) return json({ error: 'NOT_YOUR_DEPARTMENT' }, 403);

    const commentId = String(body.commentId || '').slice(0, 64) || null;
    if (commentId) {
      const [c] = await sql`
        SELECT id FROM post_comments WHERE id = ${commentId} AND post_id = ${post.id}`;
      if (!c) return json({ error: 'NO_SUCH_COMMENT' }, 404);
    }

    /**
     * Reporting hides nothing. One person's objection is not a verdict, and
     * a feed where anybody can make a post vanish has a heckler's veto. This
     * puts it in front of the admins, who decide.
     */
    await sql`
      INSERT INTO post_reports (post_id, comment_id, username, why)
      VALUES (${post.id}, ${commentId}, ${me.username},
              ${String(body.why || '').replace(/\s+/g, ' ').trim().slice(0, 500)})
      ON CONFLICT (post_id, COALESCE(comment_id, ''), username)
      DO UPDATE SET why = EXCLUDED.why, at = now(), handled_at = NULL, handled_by = NULL`;

    const admins = await sql`
      SELECT username FROM users
       WHERE active = true AND suspended = false AND access IN ('admin', 'coadmin')`;
    await tellAboutFeed(sql, {
      to: admins.map((a) => a.username),
      actor: me.username,
      title: 'มีคนรายงานโพสต์ในฟีด',
      body: (post.body || '(รูปภาพ)').slice(0, 120),
      tag: `feed-report-${post.id}`,
    });

    return json({ ok: true });
  }

  // ---- what the admins have to look at -----------------------------------
  if (action === 'feed-flagged' && request.method === 'GET') {
    if (!canModerate(me)) return json({ error: 'ADMINS_ONLY' }, 403);
    const rows = await flagged(sql);
    return json({
      flagged: rows.map((r) => ({
        postId: r.post_id,
        commentId: r.comment_id || null,
        by: r.username,
        why: r.why,
        at: r.at,
        body: r.body,
        author: r.created_by,
        department: r.department || null,
      })),
    });
  }

  /** "Looked at it, nothing wrong" — clears the flag without touching the post. */
  if (action === 'feed-flagged' && request.method === 'POST') {
    if (!canModerate(me)) return json({ error: 'ADMINS_ONLY' }, 403);
    const body = await request.json().catch(() => ({}));
    const postId = String(body.postId || '').slice(0, 64);
    if (!postId) return json({ error: 'ID_REQUIRED' }, 400);
    await sql`
      UPDATE post_reports SET handled_at = now(), handled_by = ${me.username}
       WHERE post_id = ${postId} AND handled_at IS NULL`;
    return json({ ok: true });
  }

  return json({ error: 'UNKNOWN_ACTION', action }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
