import { APP_VERSION } from '../lib/version.js';
import { json, hasDatabase, getSql, requestUrl, toBuffer } from '../lib/db.js';
import { DEPARTMENTS } from '../lib/departments.js';
import { STATUSES, PRIORITIES } from '../lib/scope.js';
import { withNode } from '../lib/http.js';
import { currentUser, canEditTasks, canManageAccounts } from '../lib/auth.js';
import { makeCode, readCode, readTarget, shortUrl } from '../lib/shortlink.js';
import { siteUrl, siteHosts, shortlinkUrl } from '../lib/line.js';
import { CIRCLES } from '../lib/circles.js';
import { accessSet, seesEverything } from '../lib/scope.js';
import {
  MAX_DEPTH, MAX_NODES, canAddToShelf, canSeeNode, canEditNode, canDeleteNode,
  visibleTree, shapeNode, allNodes, childCounts, descendantsOf, addNode, editNode,
} from '../lib/shelf.js';
import { ACCESS_ORDER } from '../lib/auth.js';
import {
  KINDS, SEVERITIES, STATES, MAX_SHOTS, MAX_SHOT, NUDGE_AT,
  canReport, canTriage, canSetTeam, canSeeDetail, teamOf,
  shapeReport, listReports, oneReport,
  addReport, triageReport, toggleVote,
  tellResponders, tellReporter, maybeNudge,
  digestText, digestRows,
} from '../lib/reports.js';

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
 *
 *   GET    /api/meta?do=reports         the reports I may see, and what I may do
 *   POST   /api/meta?do=report          file a bug or a suggestion
 *   PATCH  /api/meta?do=report          triage one (the rota only)
 *   POST   /api/meta?do=report-vote     เจอเหมือนกัน, and pressing it again undoes it
 *   GET    /api/meta?do=report-shot     one screenshot
 *   GET    /api/meta?do=report-digest   the day's summary, as text to copy
 *   POST   /api/meta?do=report-team     who else gets the urgent alert (admins only)
 *
 *   GET    /api/meta?do=shelf           the shelf of important links, as I may see it
 *   POST   /api/meta?do=shelf-add       add a link or a folder
 *   PATCH  /api/meta?do=shelf-edit      rename, re-scope or move one
 *   DELETE /api/meta?do=shelf-delete    remove one (a folder takes its contents)
 *   POST   /api/meta?do=shelf-order     re-order one folder's contents

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
  if (hasDatabase && action.indexOf('report') === 0) return reports(request, action);
  if (hasDatabase && action.indexOf('shelf') === 0) return shelf(request, action);

  /**
   * An action this build does not know about is an error, not reference data.
   *
   * Learnt the hard way on 22 October. A deployment went out with the new
   * page but an old copy of this file, so `?do=reports` fell through to the
   * block below and answered 200 with the department tree. The page got a
   * perfectly valid response with none of the fields it wanted and showed
   * "เกิดข้อผิดพลาด กรุณาลองใหม่", which is true and tells nobody anything —
   * and from the outside the server looked healthy, because every version
   * string matched.
   *
   * Saying UNKNOWN_ACTION instead turns that into a sentence naming the real
   * problem, and makes a half-applied deploy visible from one request with
   * no sign-in.
   */
  if (action) return json({ error: 'UNKNOWN_ACTION', action, version: APP_VERSION }, 400);

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
    // What the SERVER is running — see lib/version.js.
    version: APP_VERSION,
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
  // The address printed on posters and encoded in the QR — chulafair.com when
  // SHORTLINK_URL says so, the app's own address otherwise.
  const shortSite = shortlinkUrl();
  const shape = (row) => ({
    code: row.code,
    url: row.url,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at,
    active: row.active,
    hits: row.hits,
    lastHitAt: row.last_hit_at,
    shortUrl: shortUrl(shortSite, row.code),
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
      site: shortSite,
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
    const target = readTarget(body.url, { siteUrl: site, hosts: siteHosts() });
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
      const target = readTarget(body.url, { siteUrl: site, hosts: siteHosts() });
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


// ---------------------------------------------------------------------------
// Bug reports and suggestions
// ---------------------------------------------------------------------------

/**
 * Decodes one screenshot.
 *
 * Images only, and the type is read from the bytes rather than trusted from
 * the `mime` the page sent: this is the one place in the feature where
 * anybody at all can put a file into the database, so what comes out of it
 * later must be something a browser will only ever render as a picture.
 */
function readShot(value) {
  const raw = String(value || '').replace(/^data:[^,]*,/, '');
  if (!raw) return { error: 'EMPTY_FILE' };
  let buffer;
  try { buffer = Buffer.from(raw, 'base64'); } catch { return { error: 'BAD_FILE' }; }
  if (!buffer.length) return { error: 'EMPTY_FILE' };
  if (buffer.length > MAX_SHOT) return { error: 'SHOT_TOO_BIG', limit: MAX_SHOT };

  const png = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
  const jpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const webp = buffer.length > 12
    && buffer.slice(0, 4).toString('latin1') === 'RIFF'
    && buffer.slice(8, 12).toString('latin1') === 'WEBP';
  if (!png && !jpeg && !webp) return { error: 'NOT_AN_IMAGE' };

  return { buffer, mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' };
}

async function reports(request, action) {
  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);
  const team = await teamOf(sql);
  const mayTriage = canTriage(me, team);

  // ---- the list ----------------------------------------------------------
  if (action === 'reports' && request.method === 'GET') {
    const rows = await listReports(sql, me.username);
    /**
     * Everybody gets the list; the private half of each row is included only
     * where canSeeDetail allows it, which for most people is their own
     * reports. The decision is made per row rather than per request, so one
     * list serves everybody and there is no second code path to lock down.
     */
    const reportList = rows.map((row) => shapeReport(row, {
      detail: canSeeDetail(me, row, team),
      me: me.username,
    }));

    /** Who is on the rota, and who could be put on it. Admins only. */
    let rota = null;
    if (canSetTeam(me)) {
      const people = await sql`
        SELECT username, nickname, display_name, access FROM users
         WHERE active = true AND suspended = false
           AND access IN ('admin', 'coadmin')
         ORDER BY access DESC, nickname`;
      rota = {
        chosen: [...team],
        candidates: people
          .filter((p) => p.access === 'coadmin')
          .map((p) => ({ username: p.username, name: p.nickname || p.display_name || p.username })),
        // Listed so the page can say plainly that these people are always told.
        always: people.filter((p) => p.access === 'admin').map((p) => ({
          username: p.username, name: p.nickname || p.display_name || p.username,
        })),
      };
    }

    return json({
      reports: reportList,
      kinds: KINDS,
      severities: SEVERITIES,
      states: STATES,
      mayReport: canReport(me),
      mayTriage,
      maySetTeam: canSetTeam(me),
      // So the page can show who is going to be woken by an urgent tick.
      responders: mayTriage ? [...team] : null,
      rota,
      nudgeAt: NUDGE_AT,
      maxShots: MAX_SHOTS,
      maxShot: MAX_SHOT,
      version: APP_VERSION,
    });
  }

  // ---- filing one --------------------------------------------------------
  if (action === 'report' && request.method === 'POST') {
    if (!canReport(me)) return json({ error: 'CANNOT_REPORT' }, 403);
    const body = await request.json().catch(() => ({}));

    const shots = [];
    for (const raw of (Array.isArray(body.shots) ? body.shots : []).slice(0, MAX_SHOTS)) {
      const shot = readShot(raw);
      if (shot.error) return json({ error: shot.error, limit: MAX_SHOT }, 400);
      shots.push(shot);
    }

    const made = await addReport(sql, me, body, shots);
    if (made.error) return json({ error: made.error }, 400);
    const report = made.report;

    /**
     * An urgent fault wakes the rota at once — that is the whole reason the
     * tick exists. Everything else waits for the daily summary, which is the
     * bargain that keeps the alert worth answering: if every suggestion
     * buzzed somebody's phone, the next genuine emergency would arrive in a
     * notification shade nobody reads any more.
     */
    if (report.severity === 'urgent') {
      await tellResponders(sql, {
        actor: me.username,
        title: `ด่วน · ${report.code}`,
        body: `${report.title} — แจ้งโดย ${me.nickname || me.display_name || me.username}`,
        tag: `report-${report.id}`,
        loudly: true,
      });
    }

    const fresh = await oneReport(sql, me.username, report.id);
    return json({ report: shapeReport(fresh, { detail: true, me: me.username }) }, 201);
  }

  // ---- triage ------------------------------------------------------------
  if (action === 'report' && request.method === 'PATCH') {
    if (!mayTriage) return json({ error: 'NOT_ON_THE_ROTA' }, 403);
    const body = await request.json().catch(() => ({}));

    const before = await oneReport(sql, me.username, String(body.id || ''));
    if (!before) return json({ error: 'NO_SUCH_REPORT' }, 404);

    const done = await triageReport(sql, me, before, body);
    if (done.error) return json({ error: done.error }, 400);
    const after = done.report;

    /**
     * The reporter hears when the ANSWER changed, not when a note was tidied.
     *
     * Severity is left out on purpose: an admin lowering somebody's urgent to
     * ติดขัด is a judgement about the fair's afternoon, and telling the
     * reporter "your report has been downgraded" would mostly teach people
     * not to tick the box honestly.
     */
    if (body.state !== undefined && after.state !== before.state) {
      const said = {
        planned: 'รับเรื่องแล้ว อยู่ในแผนที่จะแก้',
        fixed: 'แก้แล้ว',
        declined: 'พิจารณาแล้วยังไม่ทำ',
        duplicate: `ซ้ำกับเรื่องที่มีอยู่แล้ว${after.dup_of ? ' (' + after.dup_of + ')' : ''}`,
        new: 'กลับมาเป็นเรื่องที่ยังไม่ได้ดู',
      }[after.state] || after.state;
      await tellReporter(sql, after, {
        actor: me.username,
        title: `${after.code} · ${said}`,
        body: after.note ? `${after.title} — ${after.note}` : after.title,
      });
    }

    /**
     * An admin raising something TO urgent buzzes the rest of the rota, for
     * the same reason the tick does: whoever is going to fix it has to find
     * out now rather than in tomorrow's summary.
     */
    if (after.severity === 'urgent' && before.severity !== 'urgent') {
      await tellResponders(sql, {
        actor: me.username,
        title: `ด่วน · ${after.code}`,
        body: `${after.title} — ${me.nickname || me.display_name || me.username} ตั้งเป็นเรื่องด่วน`,
        tag: `report-${after.id}`,
        loudly: true,
      });
    }

    const fresh = await oneReport(sql, me.username, after.id);
    return json({ report: shapeReport(fresh, { detail: true, me: me.username }) });
  }

  // ---- เจอเหมือนกัน -------------------------------------------------------
  if (action === 'report-vote' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const report = await oneReport(sql, me.username, String(body.id || ''));
    if (!report) return json({ error: 'NO_SUCH_REPORT' }, 404);

    const done = await toggleVote(sql, me, report);
    const nudged = done.voted ? await maybeNudge(sql, report, done.votes) : false;
    return json({ ...done, nudged });
  }

  // ---- one screenshot ----------------------------------------------------
  if (action === 'report-shot' && request.method === 'GET') {
    const report = await oneReport(sql, me.username, url.searchParams.get('id') || '');
    if (!report) return json({ error: 'NO_SUCH_REPORT' }, 404);
    /**
     * A screenshot is whatever was on somebody's screen at the time, which may
     * be a letter, a phone number or a private message. So unlike the list,
     * these are closed: the rota and the person who took it, nobody else.
     */
    if (!canSeeDetail(me, report, team)) return json({ error: 'NOT_YOURS' }, 403);

    const i = Math.max(0, Math.min(MAX_SHOTS - 1, Number(url.searchParams.get('i') || 0)));
    const [row] = await sql`
      SELECT bytes, mime FROM report_files WHERE report_id = ${report.id} AND idx = ${i}`;
    if (!row) return json({ error: 'NO_SUCH_SHOT' }, 404);

    const bytes = toBuffer(row.bytes);
    return new Response(bytes, {
      headers: {
        'content-type': row.mime || 'image/png',
        'content-length': String(bytes.length),
        // Never cached by anything in between: see the note on the mime type.
        'cache-control': 'private, no-store',
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // ---- the day's summary -------------------------------------------------
  if (action === 'report-digest' && request.method === 'GET') {
    if (!mayTriage) return json({ error: 'NOT_ON_THE_ROTA' }, 403);

    /**
     * The day defaults to today in Bangkok, not to the browser's today: the
     * committee reads this summary together and it has to mean the same day
     * to all of them.
     */
    const asked = String(url.searchParams.get('day') || '');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(asked)
      ? asked
      : (await sql`SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS d`)[0].d;

    const rows = await digestRows(sql, day);
    return json({
      day,
      text: digestText(rows, { day, siteUrl: siteUrl() }),
      counts: {
        today: rows.filter((r) => r.on_day === day).length,
        open: rows.filter((r) => ['new', 'planned'].includes(r.state)).length,
        urgent: rows.filter((r) => r.severity === 'urgent' && ['new', 'planned'].includes(r.state)).length,
      },
    });
  }

  // ---- who else gets woken up --------------------------------------------
  if (action === 'report-team' && request.method === 'POST') {
    if (!canSetTeam(me)) return json({ error: 'ADMINS_ONLY' }, 403);
    const body = await request.json().catch(() => ({}));
    const asked = [...new Set((Array.isArray(body.usernames) ? body.usernames : [])
      .map((u) => String(u || '').trim()).filter(Boolean))].slice(0, 20);

    /**
     * Only a co-admin can be added, and only an active one.
     *
     * Not a member or an editor: being woken at night by a broken page is a
     * job with power attached, and the people who have that power in this app
     * are its admins and co-admins. Admins are already told and are filtered
     * out rather than refused, so ticking one is simply a no-op.
     */
    const ok = asked.length
      ? (await sql`
          SELECT username FROM users
           WHERE username = ANY(${asked}) AND active = true AND suspended = false
             AND access = 'coadmin'`).map((r) => r.username)
      : [];

    await sql`DELETE FROM report_team WHERE username <> ALL(${ok.length ? ok : ['']})`;
    for (const username of ok) {
      await sql`
        INSERT INTO report_team (username, added_by) VALUES (${username}, ${me.username})
        ON CONFLICT (username) DO NOTHING`;
    }

    const refused = asked.filter((u) => !ok.includes(u));
    return json({ chosen: ok, refused });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}


// ---------------------------------------------------------------------------
// The shelf: important links, in folders
// ---------------------------------------------------------------------------

async function shelf(request, action) {
  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  const url = requestUrl(request);
  const rows = await allNodes(sql);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // ---- the whole shelf ---------------------------------------------------
  if (action === 'shelf' && request.method === 'GET') {
    const visible = visibleTree(rows, me);
    /**
     * The count on a folder counts only what the VIEWER can see.
     *
     * A folder saying "8 รายการ" that opens on three is worse than no count
     * at all — it reads as a bug, or worse, as something being kept from
     * them. So the number is recomputed over the visible set rather than
     * taken from the database's own total.
     */
    const seen = new Set(visible.map((r) => r.id));
    const visibleCounts = {};
    for (const r of visible) {
      if (r.parent_id && seen.has(r.parent_id)) {
        visibleCounts[r.parent_id] = (visibleCounts[r.parent_id] || 0) + 1;
      }
    }
    return json({
      nodes: visible.map((r) => shapeNode(r, me, visibleCounts[r.id] || 0)),
      mayAdd: canAddToShelf(me),
      maxDepth: MAX_DEPTH,
      maxNodes: MAX_NODES,
      // The ฝ่าย this person may scope a branch to — the page offers these only.
      myDepartments: seesEverything(me)
        ? DEPARTMENTS.map((d) => d.key)
        : [...accessSet(me)].filter((k) => k && k !== 'all'),
    });
  }

  // ---- adding one --------------------------------------------------------
  if (action === 'shelf-add' && request.method === 'POST') {
    if (!canAddToShelf(me)) return json({ error: 'MEMBERS_CANNOT_ADD' }, 403);
    const body = await request.json().catch(() => ({}));
    const made = await addNode(sql, me, body, byId);
    if (made.error) return json({ error: made.error, limit: made.limit }, 400);
    return json({ node: shapeNode(made.node, me, 0) }, 201);
  }

  // ---- changing or moving one -------------------------------------------
  if (action === 'shelf-edit' && request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const existing = byId.get(String(body.id || ''));
    if (!existing || !canSeeNode(me, existing)) return json({ error: 'NO_SUCH_ITEM' }, 404);
    if (!canEditNode(me, existing)) return json({ error: 'NOT_YOURS' }, 403);

    const done = await editNode(sql, me, existing, body, byId);
    if (done.error) return json({ error: done.error, limit: done.limit }, 400);

    const counts = await childCounts(sql);
    return json({ node: shapeNode(done.node, me, counts[done.node.id] || 0) });
  }

  // ---- removing one ------------------------------------------------------
  if (action === 'shelf-delete' && request.method === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    const existing = byId.get(id);
    if (!existing || !canSeeNode(me, existing)) return json({ error: 'NO_SUCH_ITEM' }, 404);

    const inside = descendantsOf(rows, id);
    if (!canDeleteNode(me, existing, inside.length)) {
      return json({ error: 'FOLDER_NOT_EMPTY', inside: inside.length }, 403);
    }

    /**
     * Deleting a folder takes everything under it — the foreign key cascades.
     * The count goes back so the page can say what actually went, rather than
     * reporting "deleted" for a tidy-up that removed nineteen links.
     */
    await sql`DELETE FROM doc_links WHERE id = ${id}`;
    return json({ ok: true, deleted: id, alsoRemoved: inside.length });
  }

  /**
   * Re-ordering a folder's contents in one go.
   *
   * One request for the whole folder rather than one per item: a drag that
   * moves one card changes the position of everything after it, and sending
   * those one at a time is how a list ends up half-sorted when a phone loses
   * signal mid-drag.
   */
  if (action === 'shelf-order' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x || '')).slice(0, MAX_NODES);
    if (!ids.length) return json({ error: 'NOTHING_TO_ORDER' }, 400);

    const nodes = ids.map((id) => byId.get(id)).filter(Boolean);
    if (nodes.length !== ids.length) return json({ error: 'NO_SUCH_ITEM' }, 404);
    // Everything must sit in the same folder, or "position" means nothing.
    const parent = nodes[0].parent_id || null;
    if (nodes.some((n) => (n.parent_id || null) !== parent)) {
      return json({ error: 'NOT_THE_SAME_FOLDER' }, 400);
    }
    if (nodes.some((n) => !canEditNode(me, n))) return json({ error: 'NOT_YOURS' }, 403);

    for (let i = 0; i < ids.length; i++) {
      await sql`UPDATE doc_links SET position = ${i + 1}, updated_at = now() WHERE id = ${ids[i]}`;
    }
    return json({ ok: true, ordered: ids.length });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}


/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
