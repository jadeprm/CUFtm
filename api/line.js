import { getSql } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';
import { assembled } from './tasks.js';
import { assembledEvents, canSeeEvent } from './events.js';
import {
  lineConfigured, verifySignature, reply, text, newLinkCode,
  installRichMenu, removeRichMenu,
} from '../lib/line.js';
import { RICH_MENU_PNG_BASE64 } from '../lib/richmenu-image.js';
import {
  readCommand, parseTaskLine, todayIso, addDays,
  sayTask, sayEvent, sayDate, HELP, MENU,
  canSeeTask, canSetStatus, canDeleteTask, canPostTo,
} from '../lib/linecmd.js';
import {
  ask, answer, nextStep, FIRST_STEP, isCancel,
  MENU_ADD, MENU_VIEW, MENU_MANAGE,
} from '../lib/lineflow.js';

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
    return json({
      configured: lineConfigured(),
      linked: rows.length > 0,
      displayName: rows[0]?.display_name || null,
      digest: rows[0]?.digest !== false,
      linkedAt: rows[0]?.linked_at || null,
      canManageMenu: me.access === 'admin' || me.access === 'coadmin',
      menuInstalled: Boolean(menu?.value),
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
      await sql`DELETE FROM meta WHERE key = 'line_richmenu'`;
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
    }
  }
  return json({ ok: true });
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

  if (event.type !== 'message' || event.message?.type !== 'text') return;

  const body = String(event.message.text || '').trim();
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
  await sql`
    INSERT INTO line_links (line_user_id, username, display_name, last_seen_at)
    VALUES (${lineUserId}, ${found.username}, ${''}, now())
    ON CONFLICT (line_user_id) DO UPDATE
      SET username = EXCLUDED.username, last_seen_at = now()`;

  const [person] = await sql`SELECT display_name FROM users WHERE username = ${found.username}`;
  return text([
    `เชื่อมต่อเรียบร้อยค่ะ — ${person?.display_name || found.username}`,
    '',
    'จะได้รับสรุปงานประจำวันทุกเช้า และสั่งงานผ่านแชตนี้ได้เลย',
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
    return text('ตรวจสอบงาน — ต้องการดูอะไรคะ',
      ['งานของฉัน', 'วันนี้', 'สัปดาห์นี้', 'เลยกำหนด', 'กิจกรรม', 'จบ']);
  }
  if (MENU_MANAGE.includes(typed)) return startManage(sql, me, lineUserId, today);
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

    case 'search':
      return listTasks(sql, me, lineUserId, today, {
        title: `ผลการค้นหา "${command.rest}"`,
        where: (t) => t.title.toLowerCase().includes(command.rest.toLowerCase()),
      });

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
  const lines = [opts.title, ''];
  shown.forEach((t, i) => lines.push(sayTask(t, i + 1, today)));
  if (found.length > shown.length) {
    lines.push('', `…และอีก ${found.length - shown.length} งาน`);
  }
  if (events.length) {
    lines.push('', 'กิจกรรม');
    events.slice(0, 5).forEach((e, i) => lines.push(sayEvent(e, shown.length + i + 1, today)));
  }
  lines.push('', 'พิมพ์ "เสร็จ <เลข>" เพื่อปิดงาน');

  await remember(sql, lineUserId, [
    ...shown.map((t) => ({ kind: 'task', id: t.id })),
    ...events.slice(0, 5).map((e) => ({ kind: 'event', id: e.id })),
  ]);
  return text(lines.join('\n'), MENU);
}

async function listEvents(sql, me, lineUserId, today) {
  const found = (await assembledEvents(sql))
    .filter((e) => canSeeEvent(me, e))
    .filter((e) => (e.endsOn || e.startsOn) >= today)
    .sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1))
    .slice(0, LIST_LIMIT);

  if (!found.length) return text('กิจกรรมที่กำลังจะถึง\n\nยังไม่มีค่ะ', MENU);

  const lines = ['กิจกรรมที่กำลังจะถึง', ''];
  found.forEach((e, i) => lines.push(sayEvent(e, i + 1, today)));
  await remember(sql, lineUserId, found.map((e) => ({ kind: 'event', id: e.id })));
  return text(lines.join('\n'), MENU);
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
    INSERT INTO tasks (id, title, description, due_date, due_time, status, priority,
                       department, created_by, notify)
    VALUES (${id}, ${parsed.title.slice(0, 200)}, ${''},
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
    INSERT INTO events (id, title, description, starts_on, starts_at, ends_on, ends_at,
                        all_day, place, department, colour, notify, created_by)
    VALUES (${id}, ${parsed.title.slice(0, 200)}, ${''},
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

  const result = answer(state.step, state.draft, body, context);

  if (result.cancel) {
    await clearFlow(sql, lineUserId);
    return text('ยกเลิกแล้วค่ะ ไม่ได้บันทึกอะไร\\nกดปุ่มด้านล่างจอเมื่อต้องการเริ่มใหม่', []);
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
    return text((result.note ? `${result.note}\\n\\n` : '') + q.text, q.labels);
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
    INSERT INTO tasks (id, title, description, due_date, due_time, status, priority,
                       department, unit, created_by, notify)
    VALUES (${id}, ${draft.title.slice(0, 200)}, ${draft.description || ''},
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
  return text([
    '✓ บันทึกงานแล้วค่ะ',
    '',
    draft.title,
    draft.dueDate ? `กำหนดส่ง ${sayDate(draft.dueDate)}${draft.dueTime ? ` ${draft.dueTime} น.` : ''}` : 'ไม่มีกำหนดส่ง',
    `แจ้งเตือน ${names.length} คน`,
    who.length ? `ผู้รับผิดชอบ: ${who.join(', ')}` : '',
  ].filter(Boolean).join('\\n'), ['เพิ่มงานอีก', 'ตรวจสอบงาน', 'จบ']);
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

  const lines = ['จัดการงาน — เลือกงานที่ต้องการแก้'];
  lines.push('');
  mine.forEach((t, i) => lines.push(sayTask(t, i + 1, today)));

  await remember(sql, lineUserId, mine.map((t) => ({ kind: 'task', id: t.id })));
  await saveFlow(sql, lineUserId, 'manage', 'pick', {});
  return text(lines.join('\\n'), [...mine.map((_, i) => String(i + 1)), 'จบ']);
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
    return text([
      task.title,
      `กำหนดส่ง ${sayDate(task.dueDate, today)}${task.dueTime ? ` ${task.dueTime} น.` : ''}`,
      '',
      labels.length > 2 ? 'ต้องการทำอะไรกับงานนี้คะ' : 'ไม่มีสิทธิ์แก้งานนี้ค่ะ',
    ].join('\\n'), labels);
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
    return text(`${task.title}\\n→ ${typed}`, ['จัดการงาน', 'ตรวจสอบงาน', 'จบ']);
  }

  if (typed === 'ลบงานนี้') {
    if (!canDeleteTask(me, task)) return text('ไม่มีสิทธิ์ลบงานนี้ค่ะ', ['จบ']);
    await saveFlow(sql, lineUserId, 'manage', 'confirmDelete', state.draft);
    return text(`จะลบงาน "${task.title}" ใช่ไหมคะ\\nลบแล้วกู้คืนไม่ได้`, ['ยืนยันลบ', 'ไม่ลบ', 'จบ']);
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
