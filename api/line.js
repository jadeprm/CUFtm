import { getSql } from '../lib/db.js';
import { spaceIdsFor } from '../lib/spaces.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';
import { assembled } from './tasks.js';
import { assembledEvents, canSeeEvent } from './events.js';
import {
  lineConfigured, verifySignature, reply, text, newLinkCode,
  installRichMenu, removeRichMenu, taskLink, pageLink,
} from '../lib/line.js';
import { RICH_MENU_PNG_BASE64, RICH_MENU_VERSION } from '../lib/richmenu-image.js';
import {
  readCommand, parseTaskLine, todayIso, addDays,
  sayTask, sayEvent, sayDate, HELP, MENU, MARK, PRIORITY_TH, STATUS_TH,
  canSeeTask, canSetStatus, canDeleteTask, canPostTo,
} from '../lib/linecmd.js';
import {
  ask, answer, nextStep, FIRST_STEP, isCancel,
  MENU_ADD, MENU_VIEW, MENU_MANAGE,
} from '../lib/lineflow.js';
import { canSeeDocument, canAct, pendingStep, progressOf } from '../lib/approval.js';
import { approveDocument, rejectDocument } from './documents.js';
import { flex, listBubble, documentBubble, TASK_STEPS } from '../lib/lineflex.js';
import { taskCard, eventCard, meetingCard, fitCarousel } from '../lib/linecards.js';
import { assembleMeetings } from '../lib/meetingstore.js';
import { canSeeMeeting, canReply as meetingOpenForReplies } from '../lib/meeting.js';
import { isSecretary } from '../lib/approval.js';

/**
 * The LINE Official Account.
 *
 *   POST /api/line              the webhook LINE calls (signed; never a browser)
 *   POST /api/line?do=code      issue a linking code for the signed-in person
 *   GET  /api/line?do=status    is my LINE linked, and is the digest on
 *   DELETE /api/line?do=link    unlink, from the website side
 *
 * Every reply the bot sends is a REPLY, never a push, so conversation is free
 * however much anybody uses it. The only charged messages this app ever sends
 * are the daily digests in api/cron.js.
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const CODE_MINUTES = 15;
const LIST_LIMIT = 10;

async function handler(request) {
  const url = new URL(request.url, 'https://placeholder.local');
  const action = url.searchParams.get('do') || '';
  const { sql, ready } = getSql();
  await ready;

  if (request.method === 'POST' && !action) return webhook(request, sql);

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  if (request.method === 'GET' && action === 'status') {
    const rows = await sql`
      SELECT line_user_id, display_name, digest, linked_at
      FROM line_links WHERE username = ${me.username}`;
    const [menu] = await sql`SELECT value FROM meta WHERE key = 'line_richmenu'`;
    const [menuVersion] = await sql`SELECT value FROM meta WHERE key = 'line_richmenu_version'`;
    return json({
      configured: lineConfigured(),
      linked: rows.length > 0,
      displayName: rows[0]?.display_name || null,
      digest: rows[0]?.digest === true,
      linkedAt: rows[0]?.linked_at || null,
      canManageMenu: me.access === 'admin' || me.access === 'coadmin',
      menuInstalled: Boolean(menu?.value),
      menuOutdated: Boolean(menu?.value) && menuVersion?.value !== RICH_MENU_VERSION,
    });
  }

  if (request.method === 'POST' && action === 'code') {
    if (!lineConfigured()) return json({ error: 'LINE_NOT_SET_UP' }, 400);
    // One live code per person: asking again replaces the old one rather than
    // leaving a trail of codes that all still work.
    await sql`DELETE FROM line_codes WHERE username = ${me.username} OR expires_at < now()`;
    const code = newLinkCode();
    const expires = new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString();
    await sql`INSERT INTO line_codes (code, username, expires_at)
              VALUES (${code}, ${me.username}, ${expires})`;
    return json({ code, expiresAt: expires, minutes: CODE_MINUTES });
  }

  /**
   * Installing the three-button menu. Admins only: it changes what every
   * member of the committee sees at the bottom of their chat.
   */
  if (action === 'richmenu') {
    if (me.access !== 'admin' && me.access !== 'coadmin') {
      return json({ error: 'NOT_ALLOWED' }, 403);
    }
    if (!lineConfigured()) return json({ error: 'LINE_NOT_SET_UP' }, 400);

    if (request.method === 'DELETE') {
      const [row] = await sql`SELECT value FROM meta WHERE key = 'line_richmenu'`;
      await removeRichMenu(row?.value || null);
      await sql`DELETE FROM meta WHERE key IN ('line_richmenu', 'line_richmenu_version')`;
      return json({ ok: true, installed: false });
    }

    if (request.method === 'POST') {
      try {
        const png = Buffer.from(RICH_MENU_PNG_BASE64, 'base64');
        // Replace rather than stack: installing twice would otherwise leave an
        // orphaned menu behind on the account every time.
        const [old] = await sql`SELECT value FROM meta WHERE key = 'line_richmenu'`;
        if (old?.value) await removeRichMenu(old.value).catch(() => {});
        const id = await installRichMenu(png);
        await sql`INSERT INTO meta (key, value) VALUES ('line_richmenu', ${id})
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
        await sql`INSERT INTO meta (key, value) VALUES ('line_richmenu_version', ${RICH_MENU_VERSION})
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
        return json({ ok: true, installed: true, richMenuId: id });
      } catch (error) {
        return json({ error: 'LINE_REFUSED', message: String(error?.message || error).slice(0, 300) }, 502);
      }
    }
  }

  if (request.method === 'DELETE' && action === 'link') {
    await sql`DELETE FROM line_links WHERE username = ${me.username}`;
    return json({ ok: true, linked: false });
  }

  if (request.method === 'PATCH' && action === 'digest') {
    const body = await request.json().catch(() => ({}));
    const on = body.digest !== false;
    await sql`UPDATE line_links SET digest = ${on} WHERE username = ${me.username}`;
    return json({ ok: true, digest: on });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

async function webhook(request, sql) {
  const raw = await request.text();
  const signature = request.headers.get('x-line-signature');

  /**
   * Refuse anything unsigned, before reading a single field out of the body.
   *
   * This URL is public and its address is guessable. Without this check, a
   * stranger could post a fake "message" event and the bot would happily
   * create, change or delete the committee's tasks for them.
   */
  if (!lineConfigured() || !verifySignature(raw, signature)) {
    return json({ error: 'BAD_SIGNATURE' }, 403);
  }

  let payload = {};
  try { payload = JSON.parse(raw); } catch { return json({ ok: true }); }

  for (const event of payload.events || []) {
    try {
      await handleEvent(sql, event);
    } catch (error) {
      // One person's broken message must not stop everyone else's being
      // answered, and LINE retries a non-200 — which would replay the lot.
      console.error('[line] event failed:', String(error?.message || error).slice(0, 300));
      /**
       * And never silence. Whatever went wrong, the person gets an answer
       * that says so and offers the way forward, rather than a chat that
       * looks as though the bot is off.
       */
      if (event.replyToken) {
        await reply(event.replyToken, text(
          'ขออภัยค่ะ ตอนนี้ตอบคำสั่งนี้ไม่ได้ ลองอีกครั้ง หรือเปิดบนเว็บ' +
          (pageLink('work') ? `\n${pageLink('work')}` : ''), MENU)).catch(() => {});
      }
    }
  }
  await refreshMenu(sql);
  return json({ ok: true });
}

/**
 * Brings the menu everybody sees up to date by itself.
 *
 * Once an admin has installed the menu, a new version of the app with a new
 * picture (the meetings and events buttons, say) should not wait for somebody
 * to remember to press "reinstall". The first message after a deploy swaps it,
 * after that message has been answered. The version is written first, so two
 * messages arriving together cannot both start a swap.
 */
async function refreshMenu(sql) {
  try {
    const [menu] = await sql`SELECT value FROM meta WHERE key = 'line_richmenu'`;
    if (!menu?.value) return;   // never installed: leave the account as it is
    // A swap LINE refused is tried again, but not on every message.
    const [state] = await sql`SELECT value FROM meta WHERE key = 'line_richmenu_version'`;
    const failedAt = /^failed:(\d+)$/.exec(state?.value || '');
    if (failedAt && Date.now() - Number(failedAt[1]) < 3600e3) return;
    const claimed = await sql`
      INSERT INTO meta (key, value) VALUES ('line_richmenu_version', ${RICH_MENU_VERSION})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      WHERE meta.value IS DISTINCT FROM EXCLUDED.value
      RETURNING key`;
    // A row back means the stored version was missing or different — exactly
    // when to swap. installRichMenu also makes the new one everybody's default.
    if (!claimed.length) return;
    const id = await installRichMenu(Buffer.from(RICH_MENU_PNG_BASE64, 'base64'));
    await sql`UPDATE meta SET value = ${id} WHERE key = 'line_richmenu'`;
    // The old menu itself, now unused.
    if (menu.value !== id) {
      await fetch(`https://api.line.me/v2/bot/richmenu/${menu.value}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      }).catch(() => {});
    }
  } catch (error) {
    console.error('[line] menu refresh failed:', String(error?.message || error).slice(0, 300));
    await sql`UPDATE meta SET value = ${`failed:${Date.now()}`} WHERE key = 'line_richmenu_version'`.catch(() => {});
  }
}

async function handleEvent(sql, event) {
  if (event.type === 'unfollow') {
    // They blocked or deleted the account; the binding is meaningless now.
    await sql`DELETE FROM line_links WHERE line_user_id = ${event.source?.userId || ''}`;
    return;
  }

  const lineUserId = event.source?.userId;
  const token = event.replyToken;
  if (!token || !lineUserId) return;

  if (event.type === 'follow') {
    const [known] = await sql`SELECT username FROM line_links WHERE line_user_id = ${lineUserId}`;
    return reply(token, text(known ? backAgain(known.username) : WELCOME, known ? MENU : []));
  }

  /**
   * A button on a card.
   *
   * Postbacks rather than message actions, so tapping อนุมัติ does not write
   * a command into the person's own chat history as if they had typed it.
   * The data is turned into the same command string a typist would send, so
   * there is one path through the code whichever way somebody acts.
   */
  const isPostback = event.type === 'postback';
  if (!isPostback && (event.type !== 'message' || event.message?.type !== 'text')) return;

  const body = isPostback
    ? fromPostback(event.postback?.data)
    : String(event.message.text || '').trim();
  if (!body) return;
  const [link] = await sql`
    SELECT l.*, u.display_name FROM line_links l
    JOIN users u ON u.username = l.username
    WHERE l.line_user_id = ${lineUserId}`;

  if (!link) return reply(token, await tryLinking(sql, lineUserId, body, event));

  await sql`UPDATE line_links SET last_seen_at = now() WHERE line_user_id = ${lineUserId}`;

  const me = await personFor(sql, link.username);
  if (!me) {
    await sql`DELETE FROM line_links WHERE line_user_id = ${lineUserId}`;
    return reply(token, text('บัญชีนี้ถูกปิดหรือถูกลบไปแล้ว จึงเลิกเชื่อมต่อให้อัตโนมัติ'));
  }

  /**
   * A conversation in progress takes priority over everything else.
   *
   * Someone half-way through adding a task who types "งาน" means it as the
   * answer to the question they were just asked, not as a command. The only
   * words that break out are the ones that end the conversation, which the
   * flow handles itself.
   */
  const flow = await activeFlow(sql, lineUserId);
  if (flow) return reply(token, await step(sql, me, lineUserId, flow, body));

  return reply(token, await run(sql, me, lineUserId, body));
}

/**
 * "doc:approve:doc_abc" → "อนุมัติ doc_abc".
 *
 * Rejecting is the exception: it needs a reason, and a button cannot carry one
 * somebody has not written yet, so the button asks for it instead of doing it.
 */
function fromPostback(data) {
  const [kind, verb, id, extra] = String(data || '').split(':');
  /**
   * Buttons on task, event and meeting cards. They become '#…' commands — a
   * form nobody types by accident — and go through the same permission checks
   * as everything else; the button is a convenience, never an authorisation.
   */
  if (kind === 'task' && verb === 'status' && id && extra) return `#task-status ${id} ${extra}`;
  if (kind === 'task' && verb === 'pick' && id) return `#task-pick ${id}`;
  if (kind === 'meeting' && verb === 'reply' && id && extra) return `#meeting-reply ${id} ${extra}`;
  if (kind === 'open' && verb && id) return `#open ${verb} ${id}`;
  if (kind !== 'doc' || !id) return '';
  if (verb === 'approve') return `อนุมัติ ${id}`;
  if (verb === 'reject') return `ขอเหตุผล ${id}`;
  if (verb === 'open') return `เอกสาร ${id}`;
  return '';
}

const WELCOME = [
  'สวัสดีค่ะ นี่คือบอทติดตามงานจุฬาฯแฟร์',
  '',
  'บัญชี LINE นี้ยังไม่ได้ผูกกับใคร',
  'เปิดเว็บ → โปรไฟล์ → เชื่อมต่อ LINE',
  'แล้วพิมพ์รหัส 6 หลักที่เห็นมาที่นี่',
].join('\n');

const backAgain = (username) => `ยินดีต้อนรับกลับค่ะ เชื่อมต่อกับบัญชี ${username} อยู่แล้ว\nพิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่ง`;

/**
 * Someone the bot does not recognise.
 *
 * The only thing an unlinked person can do is present a code, so this is the
 * whole of their conversation. The code is consumed on use and cannot be tried
 * repeatedly, and a wrong one says nothing about whether it exists.
 */
async function tryLinking(sql, lineUserId, body, event) {
  const command = readCommand(body);
  if (command.name !== 'code') return text(WELCOME);

  await sql`DELETE FROM line_codes WHERE expires_at < now()`;
  const [found] = await sql`
    SELECT username FROM line_codes WHERE code = ${command.rest} AND expires_at > now()`;
  if (!found) {
    return text('รหัสไม่ถูกต้องหรือหมดอายุแล้ว\nขอรหัสใหม่ได้ที่ เว็บ → โปรไฟล์ → เชื่อมต่อ LINE');
  }

  await sql`DELETE FROM line_codes WHERE code = ${command.rest}`;

  /**
   * One LINE account per person, in both directions.
   *
   * The primary key already stops one LINE account speaking for two people.
   * This is the other way round: linking a new account replaces the old one,
   * so somebody who changes phone or re-links does not end up on the list
   * twice — which would double every message they are sent, and every message
   * is charged.
   */
  await sql`DELETE FROM line_links WHERE username = ${found.username} AND line_user_id <> ${lineUserId}`;
  await sql`
    INSERT INTO line_links (line_user_id, username, display_name, last_seen_at)
    VALUES (${lineUserId}, ${found.username}, ${''}, now())
    ON CONFLICT (line_user_id) DO UPDATE
      SET username = EXCLUDED.username, last_seen_at = now()`;

  const [person] = await sql`SELECT display_name FROM users WHERE username = ${found.username}`;
  return text([
    `เชื่อมต่อเรียบร้อยค่ะ — ${person?.display_name || found.username}`,
    '',
    'สั่งงานผ่านแชตนี้ได้เลย และจะได้รับแจ้งเตือนเมื่อมีเอกสารถึงคิวของคุณ',
    'อยากได้สรุปงานทุกเช้าด้วย พิมพ์ "เปิดแจ้งเตือน"',
    'พิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่งทั้งหมด',
  ].join('\n'), MENU);
}

/** The signed-in person, in the shape the permission rules expect. */
async function personFor(sql, username) {
  const [row] = await sql`
    SELECT u.*,
           COALESCE((SELECT json_agg(d.department)
                     FROM user_departments d WHERE d.username = u.username), '[]') AS depts
    FROM users u
    WHERE u.username = ${username} AND u.active = true AND u.suspended = false`;
  if (!row) return null;
  row.departments = Array.isArray(row.depts)
    ? row.depts
    : (() => { try { return JSON.parse(row.depts); } catch { return []; } })();
  row.allDepartments = row.all_departments;
  delete row.depts;
  // Spaces widen what a person can see — the same rule as the web page.
  row.spaceIds = await spaceIdsFor(sql, row);
  return row;
}

// ---------------------------------------------------------------------------
// Running one command
// ---------------------------------------------------------------------------

async function run(sql, me, lineUserId, body) {
  const command = readCommand(body);
  const today = todayIso();
  const typed = String(body || '').trim();

  // The three rich-menu buttons, and the sub-menus they open.
  if (MENU_ADD.includes(typed)) return startAdd(sql, me, lineUserId);
  if (MENU_VIEW.includes(typed)) {
    return text('ตรวจสอบงาน — ต้องการดูอะไรคะ\nแตะปุ่มด้านล่าง หรือพิมพ์รหัส เช่น T0042 / M0005',
      ['งานของฉัน', 'ความคืบหน้า', 'วันนี้', 'สัปดาห์นี้', 'เลยกำหนด', 'ประชุม', 'กิจกรรม', 'เอกสาร', 'จบ']);
  }
  if (MENU_MANAGE.includes(typed)) return startManage(sql, me, lineUserId, today);
  /**
   * A bare code, typed or pasted on its own — "T0042".
   *
   * Nobody is going to type "หา T0042" when the code is already the whole
   * message, and a code is distinctive enough that it cannot be mistaken for
   * anything else somebody might say.
   */
  if (/^[TEM]\d{3,6}$/i.test(typed)) return showOne(sql, me, lineUserId, typed, today);
  /**
   * A number on its own — "2" — means the second line of the list just shown.
   * People answer a numbered list with a number; saying "ไม่เข้าใจ" to that,
   * as it used to, was the bot being obtuse.
   */
  if (/^\d{1,2}$/.test(typed)) return showOne(sql, me, lineUserId, typed, today);

  // Card buttons — see fromPostback.
  if (typed.startsWith('#')) return cardAction(sql, me, lineUserId, typed, today);

  if (['จบ', 'จบการทำงาน', 'ปิดเมนู', 'done', 'exit'].includes(typed.toLowerCase())) {
    await sql`DELETE FROM line_flows WHERE line_user_id = ${lineUserId}`;
    return text('เรียบร้อยค่ะ 👋\nกดปุ่มด้านล่างจอเมื่อต้องการเริ่มใหม่', []);
  }

  switch (command.name) {
    case 'help':
      return text(HELP, MENU);

    case 'whoami':
      return text([
        `${me.display_name || me.username} (${me.username})`,
        `สิทธิ์: ${me.access}`,
        `ฝ่าย: ${(me.departments || []).join(', ') || '—'}`,
      ].join('\n'), MENU);

    case 'mine':
      return listTasks(sql, me, lineUserId, today, {
        title: 'งานของฉันที่ยังไม่เสร็จ',
        where: (t) => (t.assignees || []).includes(me.username) && t.status !== 'done',
      });

    case 'today':
      return listTasks(sql, me, lineUserId, today, {
        title: 'ครบกำหนดวันนี้',
        where: (t) => t.status !== 'done' && t.dueDate === today,
        alsoEvents: (e) => e.startsOn === today,
      });

    case 'week':
      return listTasks(sql, me, lineUserId, today, {
        title: 'ครบกำหนดใน 7 วัน',
        where: (t) => t.status !== 'done' && t.dueDate && t.dueDate >= today
          && t.dueDate <= addDays(today, 7),
        alsoEvents: (e) => e.startsOn >= today && e.startsOn <= addDays(today, 7),
      });

    case 'overdue':
      return listTasks(sql, me, lineUserId, today, {
        title: 'งานที่เลยกำหนดแล้ว',
        where: (t) => t.status !== 'done' && t.dueDate && t.dueDate < today,
      });

    case 'events':
      return listEvents(sql, me, lineUserId, today);

    case 'meetings':
      return listMeetings(sql, me, lineUserId, today);

    case 'progress':
      return myProgress(sql, me, lineUserId, today);

    case 'detail':
      return showOne(sql, me, lineUserId, command.rest, today);

    case 'docs':       return listDocs(sql, me, lineUserId, { mine: true });
    case 'docsAll':    return listDocs(sql, me, lineUserId, { mine: false });
    case 'docOpen':    return openDoc(sql, me, lineUserId, command.rest);
    case 'docApprove': return approveFromLine(sql, me, lineUserId, command.rest);
    case 'docReject':  return rejectFromLine(sql, me, lineUserId, command.rest);
    case 'docAskWhy':  return askWhy(sql, me, lineUserId, command.rest);

    case 'search': {
      // The short code counts as a search term, because a code is exactly what
      // somebody pastes into a chat when they mean one particular task.
      const q = command.rest.toLowerCase();
      return listTasks(sql, me, lineUserId, today, {
        title: `ผลการค้นหา "${command.rest}"`,
        where: (t) => (t.code || '').toLowerCase() === q ||
          t.title.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q),
        alsoEvents: (e) => (e.code || '').toLowerCase() === q ||
          e.title.toLowerCase().includes(q),
      });
    }

    case 'addTask':   return addTask(sql, me, command.rest, today);
    case 'addEvent':  return addEvent(sql, me, command.rest, today);
    case 'setStatus': return setStatus(sql, me, lineUserId, command, today);
    case 'delete':    return removeTask(sql, me, lineUserId, command.rest);

    case 'digestOn':
    case 'digestOff': {
      const on = command.name === 'digestOn';
      await sql`UPDATE line_links SET digest = ${on} WHERE line_user_id = ${lineUserId}`;
      return text(on
        ? 'เปิดสรุปงานประจำวันแล้วค่ะ จะส่งให้ทุกเช้าเมื่อมีงานที่ต้องทำ'
        : 'ปิดสรุปงานประจำวันแล้วค่ะ ยังพิมพ์ถามได้ตลอดเวลา', MENU);
    }

    case 'unlink':
      await sql`DELETE FROM line_links WHERE line_user_id = ${lineUserId}`;
      return text('เลิกเชื่อมต่อแล้วค่ะ หากต้องการใช้อีกครั้ง ขอรหัสใหม่ได้ที่ เว็บ → โปรไฟล์');

    case 'code':
      return text('บัญชีนี้เชื่อมต่ออยู่แล้วค่ะ พิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่ง', MENU);

    default:
      return text(`ไม่เข้าใจคำสั่ง "${body.slice(0, 60)}"\n\n${HELP}`, MENU);
  }
}

/**
 * Remembers what was just shown, so "เสร็จ 3" means the third line.
 *
 * Replaced wholesale each time a list goes out — the numbers on screen are
 * always the newest ones, and an old number can never act on a task the person
 * is no longer looking at.
 */
async function remember(sql, lineUserId, rows) {
  await sql`DELETE FROM line_recent WHERE line_user_id = ${lineUserId}`;
  if (!rows.length) return;
  await sql`
    INSERT INTO line_recent (line_user_id, position, kind, ref_id)
    SELECT ${lineUserId}, p, k, r
    FROM unnest(${rows.map((_, i) => i + 1)}::int[],
                ${rows.map((x) => x.kind)}::text[],
                ${rows.map((x) => x.id)}::text[]) AS t(p, k, r)`;
}

async function recall(sql, lineUserId, position) {
  const [row] = await sql`
    SELECT kind, ref_id FROM line_recent
    WHERE line_user_id = ${lineUserId} AND position = ${position}`;
  return row || null;
}

async function listTasks(sql, me, lineUserId, today, opts) {
  const all = (await assembled(sql)).filter((t) => canSeeTask(me, t));
  const found = all.filter(opts.where).sort(byUrgency(today));

  let events = [];
  if (opts.alsoEvents) {
    events = (await assembledEvents(sql))
      .filter((e) => canSeeEvent(me, e))
      .filter(opts.alsoEvents)
      .sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  }

  if (!found.length && !events.length) {
    return text(`${opts.title}\n\nไม่มีรายการค่ะ 🎉`, MENU);
  }

  const shown = found.slice(0, LIST_LIMIT);
  const shownEvents = events.slice(0, 5);

  await remember(sql, lineUserId, [
    ...shown.map((t) => ({ kind: 'task', id: t.id })),
    ...shownEvents.map((e) => ({ kind: 'event', id: e.id })),
  ]);

  /**
   * One row per task rather than one paragraph per task: the marker, the
   * title and the deadline line up, so ten of them can be scanned instead of
   * read, and a late one is red before anybody has read a word.
   */
  const rows = shown.map((t, i) => ({
    number: i + 1,
    data: `open:task:${t.id}`,
    title: `${MARK[t.status] || '○'} ${t.title}`,
    state: !t.dueDate ? null
      : t.dueDate < today ? 'overdue'
      : t.dueDate === today ? 'today' : null,
    meta: [
      sayDate(t.dueDate, today) + (t.dueTime ? ` ${t.dueTime} น.` : ''),
      PRIORITY_TH[t.priority] || null,
      t.status !== 'todo' ? STATUS_TH[t.status] : null,
    ].filter(Boolean).join(' · '),
  })).concat(shownEvents.map((e, i) => ({
    number: shown.length + i + 1,
    data: `open:event:${e.id}`,
    title: `◆ ${e.title}`,
    meta: [
      sayDate(e.startsOn, today) + (!e.allDay && e.startsAt ? ` ${e.startsAt} น.` : ''),
      e.place || null,
    ].filter(Boolean).join(' · '),
  })));

  const more = found.length > shown.length ? `แสดง ${shown.length} จาก ${found.length} งาน · ` : '';

  return flex(`${opts.title} (${found.length})`, listBubble({
    title: opts.title,
    subtitle: `${more}แตะรายการเพื่อดูความคืบหน้า · พิมพ์ "เสร็จ <เลข>" เพื่อปิดงาน`,
    rows,
    link: pageLink('work'),
    linkLabel: 'ดูทั้งหมดบนเว็บ',
  }), MENU);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DOC_STAGE_TH = {
  approving: 'กำลังรออนุมัติ',
  secretary: 'รอเลขาฯ ส่ง',
  done: 'อนุมัติครบแล้ว',
  sent: 'ส่งแล้ว',
  rejected: 'ถูกตีกลับ',
};

/** Everything about one document this person is allowed to know. */
async function docsFor(sql, me) {
  const docs = await sql`SELECT * FROM documents ORDER BY updated_at DESC LIMIT 100`;
  const steps = await sql`SELECT * FROM doc_steps ORDER BY doc_id, position`;
  const byDoc = new Map();
  for (const s of steps) {
    if (!byDoc.has(s.doc_id)) byDoc.set(s.doc_id, []);
    byDoc.get(s.doc_id).push(s);
  }
  return docs
    .map((doc) => ({ doc, steps: byDoc.get(doc.id) || [] }))
    .filter(({ doc, steps: mine }) => canSeeDocument(me, doc, mine));
}

const shortWhen = (value) => {
  if (!value) return '';
  const iso = typeof value === 'string' ? value : new Date(value).toISOString();
  return `${sayDate(iso.slice(0, 10))} ${iso.slice(11, 16)} น.`;
};

/**
 * The document list.
 *
 * Two versions of the same thing: what is waiting on ME, and the status of
 * everything I am entitled to watch. The second is what a secretary, an
 * admin or the person who sent a letter actually wants — "where has my
 * document got to" was previously a question only the website could answer.
 */
async function listDocs(sql, me, lineUserId, { mine }) {
  const all = await docsFor(sql, me);
  const names = await nameMap(sql);

  const chosen = mine
    ? all.filter(({ doc, steps }) => canAct(me, doc, steps))
    : all;

  if (!chosen.length) {
    return flex(mine ? 'ไม่มีเอกสารรอคุณ' : 'ยังไม่มีเอกสาร', listBubble({
      title: mine ? 'เอกสารที่รอคุณ' : 'สถานะเอกสาร',
      subtitle: mine ? 'ตอนนี้ไม่มีเอกสารที่รอคุณลงนามค่ะ' : 'ยังไม่มีเอกสารในระบบค่ะ',
      rows: [],
      link: pageLink('docs'),
    }), mine ? ['เอกสารทั้งหมด', ...MENU] : MENU);
  }

  const shown = chosen.slice(0, LIST_LIMIT);
  await remember(sql, lineUserId, shown.map(({ doc }) => ({ kind: 'doc', id: doc.id })));

  const rows = shown.map(({ doc, steps }, i) => {
    const step = pendingStep(steps);
    const waiting = step ? names[step.username] || step.username : null;
    return {
      number: i + 1,
      title: doc.title,
      state: doc.stage === 'rejected' ? 'rejected'
        : doc.stage === 'sent' ? 'sent'
        : canAct(me, doc, steps) ? 'today' : 'doing',
      meta: [
        DOC_STAGE_TH[doc.stage] || doc.stage,
        canAct(me, doc, steps) ? '← ถึงคิวของคุณ' : (waiting ? `รอ ${waiting}` : null),
      ].filter(Boolean).join(' · '),
    };
  });

  return flex(mine ? 'เอกสารที่รอคุณ' : 'สถานะเอกสาร', listBubble({
    title: mine ? 'เอกสารที่รอคุณ' : 'สถานะเอกสาร',
    subtitle: chosen.length > shown.length
      ? `แสดง ${shown.length} จาก ${chosen.length} ฉบับ · พิมพ์ "เอกสาร <เลข>" เพื่อดูรายละเอียด`
      : 'พิมพ์ "เอกสาร <เลข>" เพื่อดูรายละเอียด',
    rows,
    link: pageLink('docs'),
  }), [mine ? 'เอกสารทั้งหมด' : 'เอกสาร', ...MENU]);
}

/** One document, with its progress and whatever this person may do next. */
async function openDoc(sql, me, lineUserId, rest) {
  const found = await resolveDoc(sql, me, lineUserId, rest);
  if (found.error) return text(found.error, MENU);

  const { doc, steps } = found;
  const names = await nameMap(sql);
  const link = pageLink('docs');
  const mayAct = canAct(me, doc, steps);

  return flex(`${doc.title} — ${DOC_STAGE_TH[doc.stage] || doc.stage}`, documentBubble({
    title: doc.title,
    stage: doc.stage,
    stageLabel: DOC_STAGE_TH[doc.stage] || doc.stage,
    priority: doc.priority,
    recipient: doc.recipient,
    uploader: names[doc.created_by] || doc.created_by,
    steps: progressOf(doc, steps).map((p) => ({
      label: p.label,
      who: p.username ? names[p.username] || p.username : '',
      when: shortWhen(p.at),
      state: p.state === 'done' ? 'approved' : p.state,
      current: p.state === 'waiting' && p.username === (pendingStep(steps) || {}).username,
      comment: p.comment,
    })),
    actions: mayAct ? [
      { label: 'อนุมัติ', style: 'primary', colour: '#15803D',
        data: `doc:approve:${doc.id}`, say: 'อนุมัติเอกสารนี้' },
      { label: 'ตีกลับ', style: 'secondary',
        data: `doc:reject:${doc.id}`, say: 'ขอตีกลับเอกสารนี้' },
    ] : [],
    link: link ? `${link.replace(/#\/docs$/, '')}#/d/${doc.id}` : null,
  }), mayAct ? ['เอกสาร', 'เอกสารทั้งหมด', 'จบ'] : ['เอกสาร', 'เอกสารทั้งหมด', ...MENU]);
}

/**
 * Turns "2" — or a document id straight from a button — into a document.
 *
 * The numbers come from the list this person was last shown, which is why a
 * stale number cannot act on somebody else's document: the list was built
 * from what they are allowed to see in the first place.
 */
async function resolveDoc(sql, me, lineUserId, rest) {
  const raw = String(rest || '').trim();
  // A button sends the id, and a reason may follow it — "doc_abc แก้วันที่" —
  // so this reads the id off the front rather than expecting it alone.
  let id = raw.match(/^doc_[a-z0-9]+/i)?.[0] || null;

  if (!id) {
    const position = Number(raw.match(/^\d{1,2}/)?.[0]);
    if (!position) return { error: 'พิมพ์เลขที่เห็นในรายการด้วยค่ะ เช่น "เอกสาร 2"' };
    const row = await recall(sql, lineUserId, position);
    if (!row || row.kind !== 'doc') {
      return { error: `ไม่พบเอกสารหมายเลข ${position} ในรายการล่าสุด\nพิมพ์ "เอกสาร" เพื่อดูรายการใหม่` };
    }
    id = row.ref_id;
  }

  const [doc] = await sql`SELECT * FROM documents WHERE id = ${id}`;
  if (!doc) return { error: 'เอกสารนี้ถูกลบไปแล้วค่ะ' };
  const steps = await sql`SELECT * FROM doc_steps WHERE doc_id = ${id} ORDER BY position`;
  if (!canSeeDocument(me, doc, steps)) return { error: 'คุณไม่มีสิทธิ์ดูเอกสารนี้ค่ะ' };
  return { doc, steps };
}

const DOC_ERROR_TH = {
  NOT_YOUR_TURN: 'ยังไม่ถึงคิวของคุณค่ะ',
  NO_SIGNATURE: 'ต้องบันทึกลายเซ็นก่อนค่ะ — เปิดเว็บ → โปรไฟล์ → ลายเซ็น',
  REASON_REQUIRED: 'ต้องใส่เหตุผลด้วยค่ะ เช่น "ตีกลับ 2 แก้วันที่ก่อน"',
  NO_SUCH_DOCUMENT: 'ไม่พบเอกสารนี้ค่ะ',
  REJECTED_FILE_REMOVED: 'เอกสารนี้ถูกตีกลับและลบไฟล์ไปแล้วค่ะ',
};

/**
 * Signing from the chat.
 *
 * Hands straight to the website's own approve — same permission checks, same
 * stamping of the PDF, same notifications to everyone downstream. A signature
 * given on a phone is the same act as one given in a browser, so it must not
 * be a second implementation that can drift.
 */
async function approveFromLine(sql, me, lineUserId, rest) {
  const found = await resolveDoc(sql, me, lineUserId, rest);
  if (found.error) return text(found.error, MENU);

  const result = await (await approveDocument(sql, me, found.doc.id)).json();
  if (result.error) return text(DOC_ERROR_TH[result.error] || `ทำรายการไม่สำเร็จ (${result.error})`, MENU);

  return openDoc(sql, me, lineUserId, found.doc.id);
}

async function rejectFromLine(sql, me, lineUserId, rest) {
  const raw = String(rest || '').trim();
  const comment = raw.replace(/^(doc_[a-z0-9]+|\d{1,2})\s*/i, '').trim();
  if (!comment) {
    return text('ตีกลับต้องมีเหตุผลค่ะ เพื่อให้คนส่งรู้ว่าต้องแก้อะไร\nเช่น "ตีกลับ 2 แก้วันที่ก่อน"', MENU);
  }

  const found = await resolveDoc(sql, me, lineUserId, raw);
  if (found.error) return text(found.error, MENU);

  const result = await (await rejectDocument(sql, me, found.doc.id, comment)).json();
  if (result.error) return text(DOC_ERROR_TH[result.error] || `ทำรายการไม่สำเร็จ (${result.error})`, MENU);

  return text(`ตีกลับเรียบร้อยค่ะ\n${found.doc.title}\nเหตุผล: ${comment}\n\nระบบแจ้งผู้ส่งและเลขาฯ แล้ว`, MENU);
}

/** The ตีกลับ button: ask for the reason, then come back and do it. */
async function askWhy(sql, me, lineUserId, rest) {
  const found = await resolveDoc(sql, me, lineUserId, rest);
  if (found.error) return text(found.error, MENU);
  if (!canAct(me, found.doc, found.steps)) return text(DOC_ERROR_TH.NOT_YOUR_TURN, MENU);

  await saveFlow(sql, lineUserId, 'rejectDoc', 'reason', { docId: found.doc.id });
  return text(
    `ตีกลับ: ${found.doc.title}\n\nพิมพ์เหตุผลที่ต้องแก้ค่ะ ระบบจะส่งให้ผู้ส่งและเลขาฯ พร้อมกัน`,
    ['ยกเลิก']);
}

/** username → the name people actually call each other. */
async function nameMap(sql) {
  const rows = await sql`SELECT username, nickname, display_name FROM users`;
  const out = {};
  for (const r of rows) out[r.username] = r.nickname || r.display_name || r.username;
  return out;
}

async function listEvents(sql, me, lineUserId, today) {
  const found = (await assembledEvents(sql))
    .filter((e) => canSeeEvent(me, e))
    .filter((e) => (e.endsOn || e.startsOn) >= today)
    .sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1))
    .slice(0, LIST_LIMIT);

  if (!found.length) return text('กิจกรรมที่กำลังจะถึง\n\nยังไม่มีค่ะ', MENU);

  // One card per event, swiped through — not a block of text with the dates
  // buried in it.
  const names = await nameMap(sql);
  await remember(sql, lineUserId, found.map((e) => ({ kind: 'event', id: e.id })));
  const { bubbles } = fitCarousel(found.map((e) =>
    eventCard(e, { today, names, link: pageLink('calendar') })));
  return flex(`กิจกรรมที่กำลังจะถึง (${found.length})`, bubbles, MENU);
}

// ---------------------------------------------------------------------------
// Cards: one task, event or meeting in full
// ---------------------------------------------------------------------------

/**
 * One thing, as its full card — by list number ("ดู 3"), by code ("T0042",
 * "E0007", "M0003") or by id (a tapped row).
 */
async function showOne(sql, me, lineUserId, ref, today) {
  const raw = String(ref || '').trim();
  let kind = null;
  let id = null;
  let code = null;

  if (/^\d{1,2}$/.test(raw)) {
    const found = await recall(sql, lineUserId, Number(raw));
    if (!found) return text(`ไม่พบรายการที่ ${raw} ค่ะ\nพิมพ์ "งาน" "ประชุม" หรือ "กิจกรรม" เพื่อดูรายการก่อน`, MENU);
    if (found.kind === 'doc') return openDoc(sql, me, lineUserId, raw);
    kind = found.kind; id = found.ref_id;
  } else if (/^[TEM]\d{3,6}$/i.test(raw)) {
    code = raw.toUpperCase();
    kind = { T: 'task', E: 'event', M: 'meeting' }[code[0]];
  } else {
    const m = raw.match(/^(task|event|meeting)\s+(\S+)$/);
    if (m) { kind = m[1]; id = m[2]; }
  }
  if (!kind) return text('ไม่เข้าใจว่าต้องการดูอะไรค่ะ\nลองพิมพ์ "ดู 3" หรือรหัส เช่น T0042', MENU);

  const names = await nameMap(sql);
  if (kind === 'task') {
    const task = (await assembled(sql)).find((t) => (id ? t.id === id : (t.code || '').toUpperCase() === code));
    if (!task || !canSeeTask(me, task)) return text(`ไม่พบงาน ${code || ''} ค่ะ`.trim(), MENU);
    return flex(`${task.code || ''} ${task.title} — ${STATUS_TH[task.status] || ''}`.trim(),
      taskCard(task, { today, names, canMove: canSetStatus(me, task), link: taskLink(task.id), me: me.username }), MENU);
  }
  if (kind === 'event') {
    const e = (await assembledEvents(sql)).find((x) => (id ? x.id === id : (x.code || '').toUpperCase() === code));
    if (!e || !canSeeEvent(me, e)) return text(`ไม่พบกิจกรรม ${code || ''} ค่ะ`.trim(), MENU);
    return flex(e.title, eventCard(e, { today, names, link: pageLink('calendar') }), MENU);
  }
  const { meeting, invited } = await findMeeting(sql, me, (m) => (id ? m.id === id : (m.code || '').toUpperCase() === code));
  if (!meeting) return text(`ไม่พบการประชุม ${code || ''} ค่ะ`.trim(), MENU);
  return flex(meeting.title, meetingCard(meeting, {
    today, me: me.username, canReply: invited && meetingOpenForReplies(rowOf(meeting)), link: pageLink('work'),
  }), MENU);
}

/** A meeting the person may see, with whether they are on its guest list. */
async function findMeeting(sql, me, match) {
  const roster = await sql`SELECT * FROM users`;
  const all = await assembleMeetings(sql, roster);
  const meeting = all.find(match);
  if (!meeting) return { meeting: null, invited: false };
  const secretary = isSecretary(me);
  if (!canSeeMeeting(me, meeting, meeting.people, { isSecretary: secretary })) return { meeting: null, invited: false };
  return { meeting, invited: meeting.people.some((p) => p.username === me.username) };
}

/** canReply reads the database's field names; the assembled meeting uses the page's. */
const rowOf = (m) => ({ status: m.status, meets_on: m.meetsOn, meets_at: m.meetsAt });

/**
 * "ความคืบหน้า" — every open task of mine as a card with its tracker, most
 * urgent first. The question this answers is the one people message each
 * other in the group to ask, and a swipe through cards answers it in seconds.
 */
async function myProgress(sql, me, lineUserId, today) {
  const mine = (await assembled(sql))
    .filter((t) => canSeeTask(me, t))
    // The tasks I am doing, and after them the ones I was asked to follow —
    // "how is it going" is exactly what a viewer is there to ask.
    .filter((t) => ((t.assignees || []).includes(me.username) || (t.viewers || []).includes(me.username)) &&
      t.status !== 'done')
    .sort((a, b) => {
      const aw = (a.assignees || []).includes(me.username) ? 0 : 1;
      const bw = (b.assignees || []).includes(me.username) ? 0 : 1;
      return aw - bw || byUrgency(today)(a, b);
    });
  if (!mine.length) return text('ไม่มีงานค้างของคุณค่ะ 🎉', MENU);

  const names = await nameMap(sql);
  await remember(sql, lineUserId, mine.slice(0, 10).map((t) => ({ kind: 'task', id: t.id })));
  const { bubbles, dropped } = fitCarousel(mine.map((t) =>
    taskCard(t, { today, names, canMove: canSetStatus(me, t), link: taskLink(t.id), me: me.username })));
  const left = mine.length - bubbles.length;
  const out = [flex(`ความคืบหน้างานของฉัน (${mine.length})`, bubbles, left ? null : MENU)];
  if (left) out.push(text(`แสดง ${bubbles.length} จาก ${mine.length} งาน · ดูทั้งหมดบนเว็บ ${pageLink('work') || ''}`.trim(), MENU));
  void dropped;
  return out;
}

/** "ประชุม" — the meetings ahead that I am invited to, as cards. */
async function listMeetings(sql, me, lineUserId, today) {
  const roster = await sql`SELECT * FROM users`;
  const secretary = isSecretary(me);
  const all = (await assembleMeetings(sql, roster))
    .filter((m) => m.status === 'planned' && m.meetsOn >= today)
    .filter((m) => canSeeMeeting(me, m, m.people, { isSecretary: secretary }))
    // Mine first: an invitation is something to answer; a meeting I can see
    // because I run the committee is only something to know about.
    .sort((a, b) => {
      const ai = a.people.some((p) => p.username === me.username) ? 0 : 1;
      const bi = b.people.some((p) => p.username === me.username) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return (a.meetsOn + (a.meetsAt || '')) < (b.meetsOn + (b.meetsAt || '')) ? -1 : 1;
    })
    .slice(0, 10);
  if (!all.length) return text('ไม่มีการประชุมที่กำลังจะถึงค่ะ', MENU);
  await remember(sql, lineUserId, all.map((m) => ({ kind: 'meeting', id: m.id })));
  const { bubbles } = fitCarousel(all.map((m) => meetingCard(m, {
    today, me: me.username,
    canReply: m.people.some((p) => p.username === me.username) && meetingOpenForReplies(rowOf(m)),
    link: pageLink('work'),
  })));
  return flex(`การประชุมที่กำลังจะถึง (${all.length})`, bubbles, MENU);
}

/** What a button on a card asked for — see fromPostback. */
async function cardAction(sql, me, lineUserId, typed, today) {
  const [verb, a, b] = typed.slice(1).split(/\s+/);

  if (verb === 'open') return showOne(sql, me, lineUserId, `${a} ${b}`, today);

  if (verb === 'task-status') {
    const task = (await assembled(sql)).find((t) => t.id === a);
    if (!task || !canSeeTask(me, task)) return text('ไม่พบงานนี้แล้วค่ะ', MENU);
    if (!canSetStatus(me, task)) {
      return text(`ไม่มีสิทธิ์เปลี่ยนสถานะงาน "${task.title}" ค่ะ\nเปลี่ยนได้เฉพาะผู้ที่ถูกแท็ก ผู้สร้างงาน และแอดมิน`, MENU);
    }
    if (!TASK_STEPS.some((s) => s.key === b)) return text('ไม่รู้จักสถานะนี้ค่ะ', MENU);
    await sql`UPDATE tasks SET status = ${b}, updated_at = now() WHERE id = ${task.id}`;
    // The card comes back with the tracker moved on — the reply IS the proof
    // that it worked, rather than a line of text saying so.
    const fresh = (await assembled(sql)).find((t) => t.id === task.id);
    const names = await nameMap(sql);
    return flex(`${task.title} → ${STATUS_TH[b]}`,
      taskCard(fresh, { today, names, canMove: true, link: taskLink(fresh.id), me: me.username }), MENU);
  }

  if (verb === 'task-pick') {
    const task = (await assembled(sql)).find((t) => t.id === a);
    if (!task || !canSeeTask(me, task) || !canSetStatus(me, task)) return text('เปลี่ยนสถานะงานนี้ไม่ได้ค่ะ', MENU);
    return flex(`เปลี่ยนสถานะ: ${task.title}`, listBubble({
      title: 'เปลี่ยนสถานะเป็น…',
      subtitle: task.title,
      rows: TASK_STEPS.map((s, i) => ({
        number: i + 1,
        title: (s.key === task.status ? '● ' : '○ ') + s.label + (s.key === task.status ? ' (ตอนนี้)' : ''),
        data: s.key === task.status ? null : `task:status:${task.id}:${s.key}`,
        say: s.key === task.status ? null : `${task.title} → ${s.label}`,
      })),
    }), MENU);
  }

  if (verb === 'meeting-reply') {
    if (!['accepted', 'declined'].includes(b)) return text('ไม่เข้าใจคำตอบค่ะ', MENU);
    const { meeting, invited } = await findMeeting(sql, me, (m) => m.id === a);
    if (!meeting || !invited) return text('ไม่พบคำเชิญนี้ค่ะ', MENU);
    if (!meetingOpenForReplies(rowOf(meeting))) return text('การประชุมนี้เริ่มไปแล้ว ตอบไม่ได้แล้วค่ะ', MENU);
    await sql`UPDATE meeting_people SET reply = ${b}, replied_at = now()
              WHERE meeting_id = ${meeting.id} AND username = ${me.username}`;
    const again = (await findMeeting(sql, me, (m) => m.id === a)).meeting;
    return flex(b === 'accepted' ? 'ตอบรับแล้ว' : 'ตอบว่าไม่เข้าร่วมแล้ว', meetingCard(again, {
      today, me: me.username, canReply: true, link: pageLink('work'),
    }), MENU);
  }

  return text('ไม่เข้าใจคำสั่งค่ะ', MENU);
}

/** Most urgent first, the same order the website shows. */
const byUrgency = (today) => (a, b) => {
  const late = (t) => (t.dueDate && t.dueDate < today ? 0 : 1);
  if (late(a) !== late(b)) return late(a) - late(b);
  if ((a.dueDate || '9999') !== (b.dueDate || '9999')) {
    return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1;
  }
  const rank = { highest: 0, high: 1, medium: 2, low: 3 };
  return (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2);
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function addTask(sql, me, body, today) {
  const people = await sql`SELECT username, display_name, nickname FROM users WHERE active = true`;
  const parsed = parseTaskLine(body, people, today);

  if (!parsed.title) {
    return text('ยังไม่ได้ใส่ชื่องานค่ะ\n\nตัวอย่าง:\nเพิ่มงาน ติดต่อสถานที่ 20/11 18:00 @กุ๊งกิ๊ง #เนื้อหา !ด่วน');
  }

  // Filing follows the same rule as the website: your own teamspace unless you
  // name one you are allowed to post to.
  let department = me.department || null;
  const named = parsed.departments[0];
  if (named) {
    if (!canPostTo(me, named.key)) {
      return text(`ไม่มีสิทธิ์สร้างงานในฝ่าย ${named.key} ค่ะ`);
    }
    department = named.key;
  }

  const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const assignees = parsed.assignees.length ? parsed.assignees : [me.username];

  await sql`
    INSERT INTO tasks (id, code, title, description, due_date, due_time, status, priority,
                       department, created_by, notify)
    VALUES (${id}, 'T' || lpad(nextval('task_code_seq')::text, 4, '0'),
            ${parsed.title.slice(0, 200)}, ${''},
            ${parsed.dueDate}, ${parsed.dueTime}, 'todo',
            ${parsed.priority || 'medium'}, ${department}, ${me.username}, ${'7d,24h,due'})`;

  await sql`
    INSERT INTO task_people (task_id, username)
    SELECT ${id}, u FROM unnest(${assignees}::text[]) AS u ON CONFLICT DO NOTHING`;

  if (parsed.departments.length) {
    await sql`
      INSERT INTO task_departments (task_id, department, scope)
      SELECT ${id}, d, s
      FROM unnest(${parsed.departments.map((d) => d.key)}::text[],
                  ${parsed.departments.map((d) => d.scope)}::text[]) AS t(d, s)
      ON CONFLICT DO NOTHING`;
  }

  const lines = [`สร้างงานแล้ว: ${parsed.title}`];
  lines.push(`กำหนดส่ง: ${sayDate(parsed.dueDate, today)}${parsed.dueTime ? ` ${parsed.dueTime} น.` : ''}`);
  lines.push(`ผู้รับผิดชอบ: ${assignees.join(', ')}`);
  if (department) lines.push(`ฝ่าย: ${department}`);
  // Anything not understood is said out loud rather than dropped in silence.
  if (parsed.unknownPeople.length) lines.push(`⚠ ไม่พบชื่อ: ${parsed.unknownPeople.join(', ')}`);
  if (parsed.unknownDepts.length) lines.push(`⚠ ไม่พบฝ่าย: ${parsed.unknownDepts.join(', ')}`);
  if (!parsed.dueDate) lines.push('⚠ ยังไม่ได้ใส่วันครบกำหนด');

  return text(lines.join('\n'), MENU);
}

async function addEvent(sql, me, body, today) {
  const people = await sql`SELECT username, display_name, nickname FROM users WHERE active = true`;
  const parsed = parseTaskLine(body, people, today);

  if (!parsed.title) return text('ยังไม่ได้ใส่ชื่อกิจกรรมค่ะ\n\nตัวอย่าง:\nเพิ่มกิจกรรม ซ้อมใหญ่ 20/11 14:00');
  if (!parsed.dueDate) return text('กิจกรรมต้องมีวันที่ค่ะ\n\nตัวอย่าง:\nเพิ่มกิจกรรม ซ้อมใหญ่ 20/11 14:00');

  const id = `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    INSERT INTO events (id, code, title, description, starts_on, starts_at, ends_on, ends_at,
                        all_day, place, department, colour, notify, created_by)
    VALUES (${id}, 'E' || lpad(nextval('event_code_seq')::text, 4, '0'),
            ${parsed.title.slice(0, 200)}, ${''},
            ${parsed.dueDate}, ${parsed.dueTime}, ${null}, ${null},
            ${!parsed.dueTime}, ${''}, ${me.department || null}, 'plum',
            ${'7d,24h,due'}, ${me.username})`;

  if (parsed.assignees.length) {
    await sql`
      INSERT INTO event_people (event_id, username)
      SELECT ${id}, u FROM unnest(${parsed.assignees}::text[]) AS u ON CONFLICT DO NOTHING`;
  }

  return text([
    `สร้างกิจกรรมแล้ว: ${parsed.title}`,
    `วันที่: ${sayDate(parsed.dueDate, today)}${parsed.dueTime ? ` ${parsed.dueTime} น.` : ' (ทั้งวัน)'}`,
  ].join('\n'), MENU);
}

async function setStatus(sql, me, lineUserId, command, today) {
  const position = Number(command.rest);
  const found = await recall(sql, lineUserId, position);
  if (!found || found.kind !== 'task') {
    return text(`ไม่พบงานลำดับที่ ${position} ค่ะ\nพิมพ์ "งาน" เพื่อดูรายการก่อน`, MENU);
  }

  const task = (await assembled(sql)).find((t) => t.id === found.ref_id);
  if (!task || !canSeeTask(me, task)) return text('ไม่พบงานนี้แล้วค่ะ', MENU);
  if (!canSetStatus(me, task)) {
    return text(`ไม่มีสิทธิ์เปลี่ยนสถานะงาน "${task.title}" ค่ะ\nเปลี่ยนได้เฉพาะผู้ที่ถูกแท็ก ผู้สร้างงาน และแอดมิน`);
  }

  await sql`UPDATE tasks SET status = ${command.status}, updated_at = now()
            WHERE id = ${task.id}`;
  const label = { todo: 'ยังไม่เริ่ม', doing: 'กำลังทำ', review: 'รอตรวจ', feedback: 'ตรวจแล้ว', done: 'เสร็จแล้ว' };
  return text(`${task.title}\n→ ${label[command.status]}`, MENU);
}

async function removeTask(sql, me, lineUserId, rest) {
  const confirmed = /ยืนยัน|confirm/i.test(rest);
  const position = Number(String(rest).replace(/[^\d]/g, ''));
  const found = await recall(sql, lineUserId, position);
  if (!found) return text(`ไม่พบลำดับที่ ${position} ค่ะ\nพิมพ์ "งาน" เพื่อดูรายการก่อน`, MENU);

  if (found.kind === 'event') {
    const event = (await assembledEvents(sql)).find((e) => e.id === found.ref_id);
    if (!event) return text('ไม่พบกิจกรรมนี้แล้วค่ะ', MENU);
    if (event.createdBy !== me.username && me.access !== 'admin' && me.access !== 'coadmin') {
      return text('ลบได้เฉพาะผู้สร้างกิจกรรมและแอดมินค่ะ');
    }
    if (!confirmed) return text(`จะลบกิจกรรม "${event.title}" ใช่ไหมคะ\nพิมพ์: ลบ ${position} ยืนยัน`);
    await sql`DELETE FROM events WHERE id = ${event.id}`;
    return text(`ลบกิจกรรม "${event.title}" แล้วค่ะ`, MENU);
  }

  const task = (await assembled(sql)).find((t) => t.id === found.ref_id);
  if (!task || !canSeeTask(me, task)) return text('ไม่พบงานนี้แล้วค่ะ', MENU);
  if (!canDeleteTask(me, task)) {
    return text(`ไม่มีสิทธิ์ลบงาน "${task.title}" ค่ะ\nลบได้เฉพาะผู้สร้างงานและแอดมิน`);
  }

  /**
   * Deleting is the one thing a typo cannot be taken back from, so it always
   * costs a second message. Both are replies, so asking is free.
   */
  if (!confirmed) {
    return text(`จะลบงาน "${task.title}" ใช่ไหมคะ\nพิมพ์: ลบ ${position} ยืนยัน`);
  }
  await sql`DELETE FROM tasks WHERE id = ${task.id}`;
  return text(`ลบงาน "${task.title}" แล้วค่ะ`, MENU);
}


// ---------------------------------------------------------------------------
// The guided flows
// ---------------------------------------------------------------------------

/** A conversation is abandoned after a day rather than waiting forever. */
async function activeFlow(sql, lineUserId) {
  await sql`DELETE FROM line_flows WHERE updated_at < now() - interval '1 day'`;
  const [row] = await sql`SELECT * FROM line_flows WHERE line_user_id = ${lineUserId}`;
  if (!row) return null;
  let draft = {};
  try { draft = JSON.parse(row.draft); } catch { draft = {}; }
  return { flow: row.flow, step: row.step, draft };
}

const saveFlow = (sql, lineUserId, flow, step, draft) => sql`
  INSERT INTO line_flows (line_user_id, flow, step, draft, updated_at)
  VALUES (${lineUserId}, ${flow}, ${step}, ${JSON.stringify(draft)}, now())
  ON CONFLICT (line_user_id) DO UPDATE
    SET flow = EXCLUDED.flow, step = EXCLUDED.step,
        draft = EXCLUDED.draft, updated_at = now()`;

const clearFlow = (sql, lineUserId) =>
  sql`DELETE FROM line_flows WHERE line_user_id = ${lineUserId}`;

/** Everyone the asker could put on a task. */
const roster = (sql) => sql`
  SELECT u.username, u.display_name, u.nickname, u.department,
         COALESCE((SELECT json_agg(d.department) FROM user_departments d
                   WHERE d.username = u.username), '[]') AS depts
  FROM users u WHERE u.active = true AND u.suspended = false
  ORDER BY u.display_name`;

const asPeople = (rows) => rows.map((r) => ({
  ...r,
  departments: Array.isArray(r.depts)
    ? r.depts
    : (() => { try { return JSON.parse(r.depts); } catch { return []; } })(),
}));

async function startAdd(sql, me, lineUserId) {
  const draft = {};
  await saveFlow(sql, lineUserId, 'add', FIRST_STEP, draft);
  const people = asPeople(await roster(sql));
  const q = ask(FIRST_STEP, draft, { me, people });
  return text(q.text, q.labels);
}

/**
 * One turn of a guided conversation.
 *
 * Reads the answer, decides where to go, saves, and asks the next question.
 * The flow row is written before the reply is built, so a person who answers
 * twice quickly cannot end up two questions apart from what the bot thinks.
 */
async function step(sql, me, lineUserId, state, body) {
  const people = asPeople(await roster(sql));
  const context = { me, people };

  if (state.flow === 'manage') return manageStep(sql, me, lineUserId, state, body);

  /**
   * Waiting for the reason behind a ตีกลับ.
   *
   * The button cannot carry a reason nobody has written yet, so it asks for
   * one and this is where the answer lands. The reason is not optional
   * anywhere in this app: a document that comes back without one sends its
   * author hunting for somebody to ask.
   */
  if (state.flow === 'rejectDoc') {
    if (isCancel(body)) {
      await clearFlow(sql, lineUserId);
      return text('ยกเลิกแล้วค่ะ เอกสารยังอยู่ที่เดิม', MENU);
    }
    await clearFlow(sql, lineUserId);
    return rejectFromLine(sql, me, lineUserId, `${state.draft.docId} ${body}`);
  }

  const result = answer(state.step, state.draft, body, context);

  if (result.cancel) {
    await clearFlow(sql, lineUserId);
    return text('ยกเลิกแล้วค่ะ ไม่ได้บันทึกอะไร\nกดปุ่มด้านล่างจอเมื่อต้องการเริ่มใหม่', []);
  }

  if (result.restart) {
    await saveFlow(sql, lineUserId, 'add', FIRST_STEP, {});
    const q = ask(FIRST_STEP, {}, context);
    return text(q.text, q.labels);
  }

  if (result.save) return saveDraft(sql, me, lineUserId, state.draft, people);

  if (result.stay) {
    const draft = result.draft || state.draft;
    await saveFlow(sql, lineUserId, 'add', state.step, draft);
    const q = ask(state.step, draft, context);
    return text((result.note ? `${result.note}\n\n` : '') + q.text, q.labels);
  }

  const draft = result.draft;
  const to = nextStep(state.step, draft, context);
  await saveFlow(sql, lineUserId, 'add', to, draft);
  const q = ask(to, draft, context);
  return text(q.text, q.labels);
}

/** Writes the finished task, using exactly the same rules as the website. */
async function saveDraft(sql, me, lineUserId, draft, people) {
  if (!draft.title) {
    await clearFlow(sql, lineUserId);
    return text('ไม่มีชื่องาน จึงบันทึกไม่ได้ค่ะ', []);
  }

  const department = draft.scope === 'none' ? (me.department || null) : (draft.department || me.department || null);
  if (department && !canPostTo(me, department)) {
    await clearFlow(sql, lineUserId);
    return text(`ไม่มีสิทธิ์สร้างงานในฝ่ายนี้ค่ะ`, []);
  }

  const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const notify = draft.notify === undefined ? '7d,24h,due' : draft.notify;

  await sql`
    INSERT INTO tasks (id, code, title, description, due_date, due_time, status, priority,
                       department, unit, created_by, notify)
    VALUES (${id}, 'T' || lpad(nextval('task_code_seq')::text, 4, '0'),
            ${draft.title.slice(0, 200)}, ${draft.description || ''},
            ${draft.dueDate || null}, ${draft.dueTime || null},
            ${draft.status || 'todo'}, ${draft.priority || 'medium'},
            ${department}, ${draft.unit || null}, ${me.username}, ${notify})`;

  // Named people, plus everyone the department tag reaches.
  const set = new Set(draft.assignees || []);
  if (draft.scope && draft.scope !== 'none' && draft.department) {
    const found = draft.scope === 'heads'
      ? await sql`SELECT u.username FROM users u JOIN user_departments x ON x.username = u.username
                  WHERE x.department = ${draft.department} AND u.is_head = true AND u.active = true`
      : draft.scope === 'members'
        ? await sql`SELECT u.username FROM users u JOIN user_departments x ON x.username = u.username
                    WHERE x.department = ${draft.department} AND u.is_head = false AND u.active = true`
        : await sql`SELECT u.username FROM users u JOIN user_departments x ON x.username = u.username
                    WHERE x.department = ${draft.department} AND u.active = true`;
    for (const row of found) set.add(row.username);
    await sql`INSERT INTO task_departments (task_id, department, scope)
              VALUES (${id}, ${draft.department}, ${draft.scope}) ON CONFLICT DO NOTHING`;
  }
  if (!set.size) set.add(me.username);

  const names = [...set];
  await sql`INSERT INTO task_people (task_id, username)
            SELECT ${id}, u FROM unnest(${names}::text[]) AS u ON CONFLICT DO NOTHING`;

  await clearFlow(sql, lineUserId);

  const who = (draft.assignees || []).map((u) => {
    const p = people.find((x) => x.username === u);
    return p ? (p.nickname || p.display_name || u) : u;
  });
  const link = taskLink(id);
  return text([
    '✓ บันทึกงานแล้วค่ะ',
    '',
    draft.title,
    draft.dueDate ? `กำหนดส่ง ${sayDate(draft.dueDate)}${draft.dueTime ? ` ${draft.dueTime} น.` : ''}` : 'ไม่มีกำหนดส่ง',
    `แจ้งเตือน ${names.length} คน`,
    who.length ? `ผู้รับผิดชอบ: ${who.join(', ')}` : '',
    link ? '' : null,
    link ? 'เพิ่มงานย่อยหรือแนบไฟล์ได้ที่' : null,
    link,
  ].filter((x) => x !== null && x !== '').join('\n'), ['เพิ่มงานอีก', 'ตรวจสอบงาน', 'จบ']);
}

/**
 * Managing: show the list, pick a number, then choose what to do to it.
 *
 * Two steps rather than one so nobody has to remember a number from an earlier
 * message, and so the task being changed is named back before it changes.
 */
async function startManage(sql, me, lineUserId, today) {
  const all = (await assembled(sql)).filter((t) => canSeeTask(me, t));
  const mine = all
    .filter((t) => (t.assignees || []).includes(me.username) || t.createdBy === me.username)
    .filter((t) => t.status !== 'done')
    .sort(byUrgency(today))
    .slice(0, 9);

  if (!mine.length) {
    await clearFlow(sql, lineUserId);
    return text('ไม่มีงานที่ต้องจัดการค่ะ 🎉', ['เพิ่มงาน', 'ตรวจสอบงาน', 'จบ']);
  }

  await remember(sql, lineUserId, mine.map((t) => ({ kind: 'task', id: t.id })));
  await saveFlow(sql, lineUserId, 'manage', 'pick', {});
  /**
   * A list card whose rows send their own number — the conversation is
   * waiting for "3", and tapping the third row says exactly that.
   */
  return flex('จัดการงาน — เลือกงานที่ต้องการแก้', listBubble({
    title: 'จัดการงาน',
    subtitle: 'เลือกงานที่ต้องการแก้ — แตะรายการ หรือพิมพ์เลข',
    rows: mine.map((t, i) => ({
      number: i + 1,
      say: String(i + 1),
      title: `${MARK[t.status] || '○'} ${t.title}`,
      state: t.dueDate && t.dueDate < today ? 'overdue' : t.dueDate === today ? 'today' : null,
      meta: [sayDate(t.dueDate, today) + (t.dueTime ? ` ${t.dueTime} น.` : ''),
        STATUS_TH[t.status], PRIORITY_TH[t.priority] || null].filter(Boolean).join(' · '),
    })),
  }), [...mine.map((_, i) => String(i + 1)), 'จบ']);
}

async function manageStep(sql, me, lineUserId, state, body) {
  const typed = String(body || '').trim();
  const today = todayIso();

  if (isCancel(typed)) {
    await clearFlow(sql, lineUserId);
    return text('ปิดเมนูจัดการงานแล้วค่ะ', []);
  }

  if (state.step === 'pick') {
    const position = Number(typed.replace(/[^\d]/g, ''));
    const found = position ? await recall(sql, lineUserId, position) : null;
    if (!found) return text('กรุณากดเลือกหมายเลขงานจากปุ่มด้านล่างค่ะ', ['จบ']);

    const task = (await assembled(sql)).find((t) => t.id === found.ref_id);
    if (!task) {
      await clearFlow(sql, lineUserId);
      return text('ไม่พบงานนี้แล้วค่ะ', ['จบ']);
    }

    await saveFlow(sql, lineUserId, 'manage', 'act', { id: task.id, position });
    const labels = [];
    if (canSetStatus(me, task)) labels.push('เสร็จแล้ว', 'กำลังทำ', 'รอตรวจ');
    if (canDeleteTask(me, task)) labels.push('ลบงานนี้');
    labels.push('เลือกงานอื่น', 'จบ');
    /**
     * The chat is good at status and bad at everything else. Rather than
     * building a clumsy half-version of sub-tasks and attachments here, the
     * reply says what the website does better and links straight to this task.
     */
    const link = taskLink(task.id);
    return text([
      task.title,
      `กำหนดส่ง ${sayDate(task.dueDate, today)}${task.dueTime ? ` ${task.dueTime} น.` : ''}`,
      (task.parts || []).length ? `งานย่อย ${task.parts.filter((p) => p.done).length}/${task.parts.length}` : '',
      (task.links || []).length ? `ไฟล์งาน ${task.links.length}` : '',
      '',
      labels.length > 2 ? 'ต้องการทำอะไรกับงานนี้คะ' : 'ไม่มีสิทธิ์แก้งานนี้ค่ะ',
      link ? '' : null,
      link ? 'แก้รายละเอียด งานย่อย หรือแนบไฟล์ ทำบนเว็บได้ที่' : null,
      link,
    ].filter((x) => x !== null && x !== '').join('\n'), labels);
  }

  // state.step === 'act'
  if (typed === 'เลือกงานอื่น') return startManage(sql, me, lineUserId, today);

  const task = (await assembled(sql)).find((t) => t.id === state.draft.id);
  if (!task) {
    await clearFlow(sql, lineUserId);
    return text('ไม่พบงานนี้แล้วค่ะ', ['จบ']);
  }

  const statusFor = { 'เสร็จแล้ว': 'done', 'กำลังทำ': 'doing', 'รอตรวจ': 'review' }[typed];
  if (statusFor) {
    if (!canSetStatus(me, task)) return text('ไม่มีสิทธิ์เปลี่ยนสถานะงานนี้ค่ะ', ['จบ']);
    await sql`UPDATE tasks SET status = ${statusFor}, updated_at = now() WHERE id = ${task.id}`;
    await clearFlow(sql, lineUserId);
    const done = taskLink(task.id);
    return text([`${task.title}`, `→ ${typed}`, done ? '' : null, done].filter(Boolean).join('\n'),
      ['จัดการงาน', 'ตรวจสอบงาน', 'จบ']);
  }

  if (typed === 'ลบงานนี้') {
    if (!canDeleteTask(me, task)) return text('ไม่มีสิทธิ์ลบงานนี้ค่ะ', ['จบ']);
    await saveFlow(sql, lineUserId, 'manage', 'confirmDelete', state.draft);
    return text(`จะลบงาน "${task.title}" ใช่ไหมคะ\nลบแล้วกู้คืนไม่ได้`, ['ยืนยันลบ', 'ไม่ลบ', 'จบ']);
  }

  if (state.step === 'confirmDelete') {
    if (typed === 'ยืนยันลบ') {
      if (!canDeleteTask(me, task)) return text('ไม่มีสิทธิ์ลบงานนี้ค่ะ', ['จบ']);
      await sql`DELETE FROM tasks WHERE id = ${task.id}`;
      await clearFlow(sql, lineUserId);
      return text(`ลบงาน "${task.title}" แล้วค่ะ`, ['จัดการงาน', 'จบ']);
    }
    await clearFlow(sql, lineUserId);
    return text('ไม่ได้ลบค่ะ', ['จัดการงาน', 'จบ']);
  }

  return text('กรุณากดเลือกจากปุ่มด้านล่างค่ะ', ['เลือกงานอื่น', 'จบ']);
}

export default withNode(handler);
export { personFor, run };
