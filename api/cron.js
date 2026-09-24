import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { fetchPeople, syncPeople } from '../lib/sheet.js';
import { sendToUser, unreadCount } from '../lib/push.js';
import { assembledEvents, audienceOf } from './events.js';
import { withNode } from '../lib/http.js';
import { lineConfigured, push, text as lineText } from '../lib/line.js';
import { sayTask, sayDate, MENU as LINE_MENU } from '../lib/linecmd.js';

/**
 * The reminder run. Something external calls this every hour — see README,
 * "Hourly reminders".
 *
 * Reminders are decided on *calendar days in Bangkok*, not on an exact number
 * of hours. That matters: an hourly poke can arrive late, or not at all if the
 * pinger has a hiccup, and an exact-hours rule would silently skip that
 * reminder forever. Day-based rules still fire on the next run that happens,
 * and `reminders_sent` guarantees each person hears about each thing once.
 */

const TZ = 'Asia/Bangkok';

/** Today's calendar date in Bangkok, as YYYY-MM-DD. */
function todayInBangkok(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function hourInBangkok(now = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now),
  );
}

const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

const toIsoDate = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
};

const MESSAGES = {
  '7d': { th: 'ครบกำหนดในอีก 7 วัน', en: 'Due in 7 days' },
  '24h': { th: 'ครบกำหนดพรุ่งนี้', en: 'Due tomorrow' },
  due: { th: 'ครบกำหนดวันนี้', en: 'Due today' },
};

/** An event is not due — it happens. The wording follows. */
const EVENT_MESSAGES = {
  '7d': { th: 'อีก 7 วัน', en: 'In 7 days' },
  '24h': { th: 'พรุ่งนี้', en: 'Tomorrow' },
  due: { th: 'วันนี้', en: 'Today' },
};

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  // If a secret is configured it must match, so the endpoint can't be hammered.
  const secret = process.env.CRON_SECRET || '';
  if (secret) {
    const url = requestUrl(request);
    const given = url.searchParams.get('key') || request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (given !== secret) return json({ error: 'BAD_KEY' }, 401);
  }

  const { sql, ready } = getSql();
  await ready;

  const today = todayInBangkok();
  const hour = hourInBangkok();
  const created = [];
  // Collected as we go and pushed at the end, so a slow or unreachable push
  // service can never stop a reminder being written to the bell.
  const toPush = [];

  const tasks = await sql`
    SELECT * FROM tasks
    WHERE due_date IS NOT NULL AND status <> 'done'`;

  for (const task of tasks) {
    const due = toIsoDate(task.due_date);
    if (!due) continue;

    const days = daysBetween(today, due);
    const wants = String(task.notify || '').split(',');

    let kind = null;
    if (days === 7) kind = '7d';
    else if (days === 1) kind = '24h';
    else if (days === 0) kind = 'due';
    if (!kind || !wants.includes(kind)) continue;

    /**
     * A task due today at a set time waits until that hour before its final
     * reminder — otherwise a 6 pm deadline pings people at 1 am.
     * With no time set, it goes out from 8 am.
     */
    if (kind === 'due') {
      const dueHour = task.due_time ? Number(String(task.due_time).slice(0, 2)) : 8;
      if (hour < dueHour) continue;
    }

    const people = await sql`SELECT username FROM task_people WHERE task_id = ${task.id}`;

    for (const { username } of people) {
      const [already] = await sql`
        SELECT 1 FROM reminders_sent
        WHERE task_id = ${task.id} AND username = ${username} AND kind = ${kind}`;
      if (already) continue;

      const when = task.due_time ? `${due} ${task.due_time}` : due;
      const id = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

      await sql`
        INSERT INTO notifications (id, username, task_id, kind, title, body)
        VALUES (${id}, ${username}, ${task.id}, ${kind}, ${task.title},
                ${`${MESSAGES[kind].th} / ${MESSAGES[kind].en} — ${when}`})`;
      await sql`
        INSERT INTO reminders_sent (task_id, username, kind)
        VALUES (${task.id}, ${username}, ${kind}) ON CONFLICT DO NOTHING`;

      created.push({ task: task.id, username, kind });
      toPush.push({
        username,
        id,
        taskId: task.id,
        title: task.title,
        when,
        kind,
        // A deadline that has arrived is worth interrupting someone for; a
        // reminder a week out is not.
        level: kind === 'due' ? 'urgent' : 'normal',
      });
    }
  }

  /**
   * Now the phones. Each person's own language is used, because a committee
   * member who set the app to English should not get Thai on their lock screen.
   */
  let pushed = 0;
  for (const item of toPush) {
    const [person] = await sql`SELECT lang FROM users WHERE username = ${item.username}`;
    const lang = person?.lang === 'en' ? 'en' : 'th';
    const result = await sendToUser(sql, item.username, {
      id: item.id,
      taskId: item.taskId,
      title: item.title,
      body: `${MESSAGES[item.kind][lang]} — ${item.when}`,
      level: item.level,
      lang,
      tag: `task-${item.taskId}`,
      unread: await unreadCount(sql, item.username),
    });
    pushed += result.sent;
  }

  /**
   * Events, the same way.
   *
   * They share reminders_sent with tasks — an event id is distinctive enough
   * that the two can never collide — so an event reminds each person once and
   * then stays quiet, exactly like a deadline does.
   */
  const events = await sql`SELECT * FROM events WHERE starts_on >= ${today}::date - 1`;
  const allEvents = await assembledEvents(sql);
  let eventNotices = 0;

  for (const row of events) {
    const event = allEvents.find((e) => e.id === row.id);
    if (!event) continue;

    const days = daysBetween(today, event.startsOn);
    let kind = null;
    if (days === 7) kind = '7d';
    else if (days === 1) kind = '24h';
    else if (days === 0) kind = 'due';
    if (!kind || !event.notify.includes(kind)) continue;

    // A timed event on the day itself waits for a civilised hour rather than
    // waking people at 1am about something at 6pm.
    if (kind === 'due' && hour < 7) continue;

    const when = event.allDay
      ? event.startsOn
      : `${event.startsOn} ${event.startsAt || ''}`.trim();

    for (const username of await audienceOf(sql, event)) {
      const [already] = await sql`
        SELECT 1 FROM reminders_sent
        WHERE task_id = ${event.id} AND username = ${username} AND kind = ${kind}`;
      if (already) continue;

      const [person] = await sql`SELECT lang FROM users WHERE username = ${username}`;
      const lang = person?.lang === 'en' ? 'en' : 'th';
      const line = `${EVENT_MESSAGES[kind][lang]} \u00b7 ${when}` +
        (event.place ? ` \u00b7 ${event.place}` : '');

      const id = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      await sql`
        INSERT INTO notifications (id, username, task_id, kind, title, body)
        VALUES (${id}, ${username}, ${null}, ${'event'}, ${event.title}, ${line})`;
      await sql`
        INSERT INTO reminders_sent (task_id, username, kind)
        VALUES (${event.id}, ${username}, ${kind}) ON CONFLICT DO NOTHING`;

      eventNotices++;
      const result = await sendToUser(sql, username, {
        id,
        title: event.title,
        body: line,
        level: kind === 'due' ? 'urgent' : 'normal',
        lang,
        tag: `event-${event.id}`,
        unread: await unreadCount(sql, username),
      });
      pushed += result.sent;
    }
  }

  /**
   * The LINE digest — the only message this app ever pays for.
   *
   * One message per person, addressed to that person's own LINE account,
   * listing only their own work. Never a broadcast: a broadcast would go to
   * everyone who ever added the account, would tell people about work that is
   * not theirs, and would cost the same per recipient anyway.
   */
  const digest = await sendDigests(sql, today);

  // Keep the roster current, and tidy up expired sessions while we're here.
  let roster = null;
  try {
    roster = await syncPeople(sql, await fetchPeople());
  } catch (error) {
    roster = { error: error.message };
  }
  await sql`DELETE FROM sessions WHERE expires_at < now()`;

  return json({
    ok: true,
    today,
    hour,
    remindersCreated: created.length,
    created,
    eventNotices,
    pushesSent: pushed,
    line: digest,
    roster,
    secured: Boolean(secret),
    ...(secret ? {} : { warning: 'Set CRON_SECRET in Vercel and add ?key=… to the ping URL.' }),
  });
}

/**
 * Everyone who has connected LINE and left the digest switched on, gets one
 * message, once, on any day they have something to do.
 *
 * Three rules keep this affordable and welcome. Nothing is sent to somebody
 * with an empty list — silence is the correct message when there is nothing
 * due. Everything that person has is gathered into ONE message rather than one
 * per task. And a row in line_digests_sent means a retried cron, or a second
 * ping in the same hour, cannot send the same person a second copy.
 */
async function sendDigests(sql, today) {
  if (!lineConfigured()) return { skipped: 'not configured' };

  // Only in the morning, once. The hour is Bangkok time, like everything else.
  const hour = hourInBangkok();
  const wanted = Number(process.env.LINE_DIGEST_HOUR || 8);
  if (hour !== wanted) return { skipped: `not ${wanted}:00 in Bangkok (now ${hour})` };

  const links = await sql`
    SELECT l.line_user_id, l.username
    FROM line_links l
    JOIN users u ON u.username = l.username
    WHERE l.digest = true AND u.active = true AND u.suspended = false
      AND NOT EXISTS (
        SELECT 1 FROM line_digests_sent d
        WHERE d.username = l.username AND d.on_day = ${today}::date)`;
  if (!links.length) return { sent: 0, considered: 0 };

  const soon = addDaysIso(today, 7);
  const names = links.map((l) => l.username);

  // Two queries for the whole committee rather than two per person.
  const tasks = await sql`
    SELECT t.id, t.title, t.due_date, t.due_time, t.status, t.priority, p.username
    FROM tasks t JOIN task_people p ON p.task_id = t.id
    WHERE p.username = ANY(${names}) AND t.status <> 'done'
      AND t.due_date IS NOT NULL AND t.due_date <= ${soon}::date
    ORDER BY t.due_date, t.due_time NULLS LAST`;

  const events = await sql`
    SELECT e.id, e.title, e.starts_on, e.starts_at, e.all_day, e.place, p.username
    FROM events e JOIN event_people p ON p.event_id = e.id
    WHERE p.username = ANY(${names})
      AND e.starts_on >= ${today}::date AND e.starts_on <= ${soon}::date
    ORDER BY e.starts_on, e.starts_at NULLS FIRST`;

  const mine = (rows, username) => rows.filter((r) => r.username === username);

  let sent = 0;
  const errors = [];
  for (const link of links) {
    const theirTasks = mine(tasks, link.username);
    const theirEvents = mine(events, link.username);
    if (!theirTasks.length && !theirEvents.length) continue;   // say nothing

    const body = digestText(theirTasks, theirEvents, today);
    try {
      await push(link.line_user_id, lineText(body, LINE_MENU));
      await sql`INSERT INTO line_digests_sent (username, on_day)
                VALUES (${link.username}, ${today}::date)
                ON CONFLICT DO NOTHING`;
      sent++;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200);
      errors.push({ username: link.username, message });
      console.error('[line digest]', link.username, message);
      /**
       * 403 means they blocked the account or the binding is dead. Keeping the
       * row would mean failing again every morning forever, so it goes.
       */
      if (error?.statusCode === 403) {
        await sql`DELETE FROM line_links WHERE line_user_id = ${link.line_user_id}`;
      }
    }
  }
  return { sent, considered: links.length, errors: errors.slice(0, 3) };
}

function digestText(tasks, events, today) {
  const overdue = tasks.filter((t) => toIsoDate(t.due_date) < today);
  const dueToday = tasks.filter((t) => toIsoDate(t.due_date) === today);
  const ahead = tasks.filter((t) => toIsoDate(t.due_date) > today);

  const lines = ['สรุปงานของคุณวันนี้', ''];
  let n = 0;

  const block = (heading, rows) => {
    if (!rows.length) return;
    lines.push(heading);
    rows.slice(0, 8).forEach((t) => {
      n += 1;
      lines.push(sayTask({
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: toIsoDate(t.due_date),
        dueTime: t.due_time,
      }, n, today));
    });
    if (rows.length > 8) lines.push(`    …และอีก ${rows.length - 8} งาน`);
    lines.push('');
  };

  block('⚠ เลยกำหนดแล้ว', overdue);
  block('ครบกำหนดวันนี้', dueToday);
  block('ใน 7 วันข้างหน้า', ahead);

  if (events.length) {
    lines.push('กิจกรรม');
    events.slice(0, 5).forEach((e) => {
      const when = sayDate(toIsoDate(e.starts_on), today) +
        (!e.all_day && e.starts_at ? ` ${e.starts_at} น.` : '');
      lines.push(`◆ ${e.title}`);
      lines.push(`    ${[when, e.place].filter(Boolean).join(' · ')}`);
    });
    lines.push('');
  }

  lines.push('พิมพ์ "งาน" เพื่อดูทั้งหมด · "ปิดแจ้งเตือน" เพื่อหยุดสรุปนี้');
  return lines.join('\n');
}

const addDaysIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
