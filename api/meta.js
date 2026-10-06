import { json, hasDatabase, getSql, requestUrl } from '../lib/db.js';
import { DEPARTMENTS } from '../lib/departments.js';
import { STATUSES, PRIORITIES } from '../lib/scope.js';
import { withNode } from '../lib/http.js';
import { currentUser, canEditTasks, canManageAccounts } from '../lib/auth.js';
import { makeCode, readCode, readTarget, shortUrl } from '../lib/shortlink.js';
import { siteUrl } from '../lib/line.js';
import { CIRCLES } from '../lib/circles.js';
import { ACCESS_ORDER } from '../lib/auth.js';

/**
 * Reference data, the keep-warm ping, and short links.
 *
 * The short links are here rather than in an endpoint of their own for one
 * blunt reason: Vercel turns every file under api/ into its own Serverless
 * Function and the Hobby plan allows twelve. There are already twelve. A
 * thirteenth file would fail the build, so `/s/ABC123` is rewritten onto this
 * function by vercel.json — a rewrite is routing, not a function, and costs
 * nothing.
 *
 *   GET    /api/meta                 department tree, statuses, priorities
 *   GET    /api/meta?ping=1          keep the database awake
 *   GET    /s/ABC123                 follow a short link  (rewritten to ?go=)
 *   GET    /api/meta?do=links        the links I may see
 *   POST   /api/meta?do=link         make one
 *   PATCH  /api/meta?do=link         change where it points, or switch it off
 *   DELETE /api/meta?do=link&code=…  remove one
 */

/** Nobody needs two hundred short links; a runaway script might make them. */
const MAX_PER_PERSON = 200;

async function handler(request) {
  const url = requestUrl(request);
  const action = url.searchParams.get('do') || '';
  const go = url.searchParams.get('go');

  if (hasDatabase && go) return follow(go);
  if (hasDatabase && (action === 'links' || action === 'link')) {
    return links(request, action);
  }

  /**
   * A keep-warm ping: /api/meta?ping=1
   *
   * The free database goes to sleep after a few minutes with nothing to do,
   * and waking it costs a second or two on whatever unlucky request arrives
   * first. A cheap query every few minutes keeps it awake during the day,
   * which is the difference between "instant" and "why is it thinking".
   *
   * Deliberately the smallest possible query, and it needs no sign-in, so a
   * free pinger can call it. It exposes nothing.
   */
  if (hasDatabase && url.searchParams.get('ping')) {
    const started = Date.now();
    try {
      const { sql, ready } = getSql();
      await ready;
      await sql`SELECT 1`;
      return json({ ok: true, ms: Date.now() - started });
    } catch (error) {
      return json({ ok: false, ms: Date.now() - started, error: 'DB_ASLEEP' }, 503);
    }
  }

  return json({
    hasDatabase,
    /**
     * Whether the committee has opened the system yet.
     *
     * Read from the environment rather than the database so it can be switched
     * on the evening before launch without a deployment, and so the holding
     * page costs nothing to serve when it is off.
     */
    comingSoon: process.env.COMING_SOON === '1',
    opensAt: process.env.LAUNCH_AT || null,
    /**
     * The circles, as definitions only.
     *
     * Who is in one is worked out from the roster the page already has, so
     * this endpoint stays a cheap piece of reference data rather than another
     * query against the users table on every page load. The server re-expands
     * every circle when anything is actually saved, so the page's version of
     * the list is a convenience and never the thing of record.
     */
    circles: CIRCLES.map((c) => ({ key: c.key, th: c.th, en: c.en, floor: c.floor, note: c.note })),
    accessOrder: ACCESS_ORDER,
    departments: DEPARTMENTS.map((d) => ({
      key: d.key, th: d.th, en: d.en, units: d.units, parent: d.parent || null,
    })),
    statuses: STATUSES,
    priorities: PRIORITIES,
  });
}

// ---------------------------------------------------------------------------
// Following one
// ---------------------------------------------------------------------------

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A page for a link that goes nowhere.
 *
 * Returned instead of a bare 404 because these addresses are printed on
 * posters and said out loud: somebody standing in front of a banner with a
 * typo needs to be told it is a typo, in a language they read, rather than
 * shown a browser error page.
 */
const missingPage = (code, message) =>
  new Response(
    `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ไม่พบลิงก์นี้</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;
place-items:center;min-height:100vh;margin:0;background:#faf7f8;color:#1f2328;text-align:center;padding:24px}
main{max-width:22rem}code{background:#f0eaec;padding:2px 8px;border-radius:6px;font-size:1.1em}
p{color:#6b7280;line-height:1.6}</style></head>
<body><main><h1>ไม่พบลิงก์นี้</h1>
<p>${escapeHtml(message)}</p>
<p><code>/s/${escapeHtml(code)}</code></p>
<p>ลองตรวจตัวอักษรอีกครั้ง หรือถามผู้ที่ให้ลิงก์นี้มา</p></main></body></html>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

/**
 * Sends somebody on their way.
 *
 * Deliberately open to anybody — that is the whole point of a short link —
 * and deliberately a 302 rather than a 301: a permanent redirect is cached by
 * browsers forever, so a link retargeted after a poster goes out would keep
 * sending anybody who had used it once to the old address.
 */
async function follow(rawCode) {
  const { sql, ready } = getSql();
  await ready;

  const read = readCode(rawCode);
  if (read.error) return missingPage(String(rawCode).slice(0, 32), 'รหัสลิงก์ไม่ถูกต้อง');

  const [link] = await sql`SELECT * FROM short_links WHERE code = ${read.code}`;
  if (!link) return missingPage(read.code, 'ลิงก์นี้ไม่มีอยู่ในระบบ');
  if (!link.active) return missingPage(read.code, 'ลิงก์นี้ถูกปิดใช้งานแล้ว');

  /**
   * Counting happens after the destination is known and never blocks the
   * redirect: somebody scanning a QR code at the fair should not wait on a
   * statistic, and a counter that fails must not break a working link.
   */
  try {
    await sql`
      UPDATE short_links SET hits = hits + 1, last_hit_at = now() WHERE code = ${read.code}`;
    await sql`
      INSERT INTO short_hits (code, on_day, hits)
      VALUES (${read.code}, (now() AT TIME ZONE 'Asia/Bangkok')::date, 1)
      ON CONFLICT (code, on_day) DO UPDATE SET hits = short_hits.hits + 1`;
  } catch (error) {
    console.error('[short] could not count a hit:', String(error?.message || error).slice(0, 160));
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: link.url,
      // Never cached: a retargeted link has to take effect for everybody at
      // once, including people who have followed it before.
      'cache-control': 'no-store, no-cache, must-revalidate',
      'referrer-policy': 'no-referrer',
    },
  });
}

// ---------------------------------------------------------------------------
// Managing them
// ---------------------------------------------------------------------------

async function links(request, action) {
  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);
  const site = siteUrl();
  const shape = (row) => ({
    code: row.code,
    url: row.url,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at,
    active: row.active,
    hits: row.hits,
    lastHitAt: row.last_hit_at,
    shortUrl: shortUrl(site, row.code),
    mine: row.created_by === me.username,
  });

  // ---- the list ----------------------------------------------------------
  if (request.method === 'GET') {
    /**
     * Everybody sees every link, not only their own.
     *
     * A link on the committee's domain is the committee's business: somebody
     * should be able to find out where /s/CUFAIR points without asking around,
     * and a directory nobody can see is a directory where a bad link can sit
     * unnoticed. Only admins can delete other people's, though.
     */
    const rows = await sql`SELECT * FROM short_links ORDER BY created_at DESC LIMIT 500`;
    const [{ mine }] = await sql`
      SELECT count(*)::int AS mine FROM short_links WHERE created_by = ${me.username}`;

    return json({
      links: rows.map(shape),
      site,
      mayCreate: canEditTasks(me),
      mayManageAll: canManageAccounts(me),
      remaining: Math.max(0, MAX_PER_PERSON - mine),
    });
  }

  // ---- making one --------------------------------------------------------
  if (request.method === 'POST') {
    /**
     * A member cannot make one, for the same reason they cannot create a task:
     * a short link on this domain is a published thing, and publishing under
     * the committee's name is not a member's to do alone.
     */
    if (!canEditTasks(me)) return json({ error: 'MEMBERS_CANNOT_CREATE' }, 403);

    const body = await request.json().catch(() => ({}));
    const target = readTarget(body.url, { siteUrl: site });
    if (target.error) return json({ error: target.error }, 400);

    const [{ mine }] = await sql`
      SELECT count(*)::int AS mine FROM short_links WHERE created_by = ${me.username}`;
    if (mine >= MAX_PER_PERSON) return json({ error: 'TOO_MANY_LINKS', limit: MAX_PER_PERSON }, 400);

    const title = String(body.title ?? '').trim().slice(0, 120);

    /**
     * A code somebody chose, or one made up.
     *
     * A chosen code that is taken is refused rather than quietly altered — a
     * person typing CUFAIR into the box is about to print it, and handing them
     * CUFAIR2 instead would be discovered on the poster.
     */
    if (body.code) {
      const read = readCode(body.code);
      if (read.error) return json({ error: read.error }, 400);

      const [taken] = await sql`SELECT code FROM short_links WHERE code = ${read.code}`;
      if (taken) return json({ error: 'CODE_TAKEN', code: read.code }, 409);

      await sql`
        INSERT INTO short_links (code, url, title, created_by)
        VALUES (${read.code}, ${target.url}, ${title}, ${me.username})`;
      const [made] = await sql`SELECT * FROM short_links WHERE code = ${read.code}`;
      return json({ link: shape(made) }, 201);
    }

    /**
     * A made-up code, with the database deciding the winner.
     *
     * Two people creating a link in the same instant could generate the same
     * six characters; the primary key catches it and this tries again rather
     * than one of them silently overwriting the other.
     */
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeCode();
      try {
        await sql`
          INSERT INTO short_links (code, url, title, created_by)
          VALUES (${code}, ${target.url}, ${title}, ${me.username})`;
        const [made] = await sql`SELECT * FROM short_links WHERE code = ${code}`;
        return json({ link: shape(made) }, 201);
      } catch (error) {
        if (!/duplicate key|unique/i.test(String(error?.message || ''))) throw error;
      }
    }
    return json({ error: 'COULD_NOT_MAKE_CODE' }, 503);
  }

  // ---- changing one ------------------------------------------------------
  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const read = readCode(body.code);
    if (read.error) return json({ error: read.error }, 400);

    const [link] = await sql`SELECT * FROM short_links WHERE code = ${read.code}`;
    if (!link) return json({ error: 'NO_SUCH_LINK' }, 404);
    if (link.created_by !== me.username && !canManageAccounts(me)) {
      return json({ error: 'NOT_YOUR_SHORT_LINK' }, 403);
    }

    if (body.url !== undefined) {
      const target = readTarget(body.url, { siteUrl: site });
      if (target.error) return json({ error: target.error }, 400);
      await sql`UPDATE short_links SET url = ${target.url} WHERE code = ${read.code}`;
    }
    if (body.title !== undefined) {
      await sql`UPDATE short_links SET title = ${String(body.title).trim().slice(0, 120)}
                WHERE code = ${read.code}`;
    }
    if (body.active !== undefined) {
      await sql`UPDATE short_links SET active = ${Boolean(body.active)} WHERE code = ${read.code}`;
    }

    const [fresh] = await sql`SELECT * FROM short_links WHERE code = ${read.code}`;
    return json({ link: shape(fresh) });
  }

  // ---- removing one ------------------------------------------------------
  if (request.method === 'DELETE') {
    const read = readCode(url.searchParams.get('code'));
    if (read.error) return json({ error: read.error }, 400);

    const [link] = await sql`SELECT * FROM short_links WHERE code = ${read.code}`;
    if (!link) return json({ error: 'NO_SUCH_LINK' }, 404);
    if (link.created_by !== me.username && !canManageAccounts(me)) {
      return json({ error: 'NOT_YOUR_SHORT_LINK' }, 403);
    }

    /**
     * Deleting frees the code for somebody else to claim, which matters: a
     * poster already printed with it would then point somewhere new. Switching
     * a link off keeps the code reserved and is what people usually want, so
     * the page offers that first.
     */
    await sql`DELETE FROM short_links WHERE code = ${read.code}`;
    return json({ ok: true, deleted: read.code });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
