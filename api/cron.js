import { getSql, json, noDatabase, hasDatabase, requestUrl, toBuffer } from '../lib/db.js';
import { fetchPeople, syncPeople } from '../lib/sheet.js';
import { sendToUser, unreadCount } from '../lib/push.js';
import { assembledEvents, audienceOf } from './events.js';
import { withNode } from '../lib/http.js';
import { lineConfigured, push, pageLink } from '../lib/line.js';
import { flex, listBubble } from '../lib/lineflex.js';
import { sayDate, MARK, PRIORITY_TH, MENU as LINE_MENU } from '../lib/linecmd.js';
import { driveConfigured, archivePdf, archiveHolds } from '../lib/drive.js';
import { updateStatus as updateRegisterStatus, REGISTER_STATUS } from '../lib/docregister.js';


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

/**
 * The reminder ladder.
 *
 * It used to be 7 days, 1 day, and the day itself — and nothing else, ever.
 * A task due in four days got silence, and a task that went past its deadline
 * got silence too, which is exactly the moment somebody needs telling. Three
 * days and an overdue notice close both gaps.
 */
const MESSAGES = {
  '7d': { th: 'ครบกำหนดในอีก 7 วัน', en: 'Due in 7 days' },
  '3d': { th: 'ครบกำหนดในอีก 3 วัน', en: 'Due in 3 days' },
  '24h': { th: 'ครบกำหนดพรุ่งนี้', en: 'Due tomorrow' },
  due: { th: 'ครบกำหนดวันนี้', en: 'Due today' },
  overdue: { th: 'เลยกำหนดแล้ว', en: 'Now overdue' },
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
    else if (days === 3) kind = '3d';
    else if (days === 1) kind = '24h';
    else if (days === 0) kind = 'due';
    else if (days < 0) kind = 'overdue';
    if (!kind) continue;

    /**
     * A task that has gone past its deadline is told once, on the first run
     * after the day turns, and then left alone. Nagging every hour about the
     * same late task would train people to ignore the bell, which costs more
     * than the late task does.
     *
     * It is also not opt-out: somebody who switched off the advance warnings
     * still needs to know when they have missed something.
     */
    if (kind !== 'overdue' && !wants.includes(kind)) continue;

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
        // A deadline that has arrived, or has been missed, is worth
        // interrupting someone for; a reminder a week out is not.
        level: kind === 'due' || kind === 'overdue' ? 'urgent' : 'normal',
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
    else if (days === 3) kind = '3d';
    else if (days === 1) kind = '24h';
    else if (days === 0) kind = 'due';
    // An event that has happened is not late, it is over — no overdue notice.
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

  // Finished documents move to Drive, and their database copy goes three days
  // after that — see archiveDocuments().
  const archive = await archiveDocuments(sql);

  // Keep the roster current, and tidy up expired sessions while we're here.
  let roster = null;
  try {
    roster = await syncPeople(sql, await fetchPeople());
  } catch (error) {
    roster = { error: error.message };
  }
  await sql`DELETE FROM sessions WHERE expires_at < now()`;

  /**
   * A record that this run happened.
   *
   * Without it, "notifications are not arriving" is unanswerable from inside
   * the app — nobody can tell the difference between nothing being due and
   * nothing ever calling this endpoint. The admin page reads it and says which
   * it is.
   */
  await sql`
    INSERT INTO meta (key, value) VALUES ('last_cron', ${new Date().toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

  return json({
    ok: true,
    today,
    hour,
    remindersCreated: created.length,
    created,
    eventNotices,
    pushesSent: pushed,
    line: digest,
    archive,
    roster,
    secured: Boolean(secret),
    ...(secret ? {} : { warning: 'Set CRON_SECRET in Vercel and add ?key=… to the ping URL.' }),
  });
}

/**
 * Finished documents, moved out to Google Drive and then cleared from here.
 *
 * Two separate steps, deliberately days apart, because they answer different
 * worries. A document that has been sent is copied to Drive on the next run —
 * that is the archive, and it happens while the database copy is still there to
 * prove it worked. Only three days later is the database copy deleted, and only
 * after asking Drive whether it really still holds a file of the right size.
 * The gap is the room to notice a bad archive before the other copy is gone.
 *
 * Everything here is best effort. An unreachable Drive leaves the document
 * exactly where it is and the next run tries again; nothing is ever deleted on
 * the strength of an upload that was not confirmed.
 */
const ARCHIVE_GRACE_DAYS = Number(process.env.DOC_ARCHIVE_DAYS || 3);

async function archiveDocuments(sql) {
  if (!driveConfigured()) return { skipped: 'not configured' };

  const archived = [];
  const failed = [];
  const purged = [];

  // Sent, and not yet in Drive. The signed copy is the one worth keeping; a
  // document nobody had to sign is archived as its original.
  const waiting = await sql`
    SELECT id, title, recipient, department, created_by, sent_at, doc_tab, doc_number
    FROM documents
    WHERE sent_at IS NOT NULL AND drive_file_id IS NULL
    ORDER BY sent_at
    LIMIT 20`;

  for (const doc of waiting) {
    const [file] = await sql`
      SELECT kind, bytes, byte_size FROM doc_files
      WHERE doc_id = ${doc.id} ORDER BY (kind = 'signed') DESC LIMIT 1`;
    if (!file) { failed.push({ id: doc.id, reason: 'NO_FILE' }); continue; }

    // The driver hands this back as a Date or as a string depending on where
    // it is running, and String(aDate) is "Mon Sep 28 …" — not a name anybody
    // wants a folder full of. Both forms go through the Bangkok formatter.
    const when = todayInBangkok(new Date(doc.sent_at));
    const result = await archivePdf(toBuffer(file.bytes), {
      name: `${when} ${doc.title}`,
      description: [doc.recipient ? `ถึง ${doc.recipient}` : '', `โดย ${doc.created_by}`]
        .filter(Boolean).join(' · '),
    });

    if (!result.ok) { failed.push({ id: doc.id, reason: result.reason }); continue; }

    await sql`
      UPDATE documents
      SET drive_file_id = ${result.id}, drive_url = ${result.url}, archived_at = now()
      WHERE id = ${doc.id}`;
    await sql`
      INSERT INTO doc_events (id, doc_id, kind, username, detail)
      VALUES (${'ev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)},
              ${doc.id}, 'archived', NULL, ${result.url})`;

    // The committee's register says so too, so somebody reading the book can
    // see that the letter is filed and not only that it went out.
    await updateRegisterStatus({
      tab: doc.doc_tab, number: doc.doc_number, status: REGISTER_STATUS.archived,
    });
    archived.push(doc.id);
  }

  // Old enough, and confirmed to be in Drive: the database copy can go.
  const ripe = await sql`
    SELECT d.id, d.drive_file_id,
           (SELECT max(byte_size) FROM doc_files f WHERE f.doc_id = d.id) AS byte_size
    FROM documents d
    WHERE d.drive_file_id IS NOT NULL
      AND d.archived_at < now() - (${ARCHIVE_GRACE_DAYS} || ' days')::interval
      AND EXISTS (SELECT 1 FROM doc_files f WHERE f.doc_id = d.id)
    LIMIT 20`;

  for (const doc of ripe) {
    const holds = await archiveHolds(doc.drive_file_id, Number(doc.byte_size || 0));
    if (!holds.ok) { failed.push({ id: doc.id, reason: 'KEPT_' + holds.reason }); continue; }
    await sql`DELETE FROM doc_files WHERE doc_id = ${doc.id}`;
    purged.push(doc.id);
  }

  return { archived, purged, failed, graceDays: ARCHIVE_GRACE_DAYS };
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

    const card = digestCard(theirTasks, theirEvents, today);
    try {
      await push(link.line_user_id, card);
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

/**
 * The morning digest, as a card.
 *
 * This is the one message everybody gets every day, so it is the one worth
 * making readable: late work first and in red, then today, then the week, each
 * as its own row rather than as another line in a paragraph. The count in the
 * subtitle is what people actually read on the lock screen.
 */
function digestCard(tasks, events, today) {
  const overdue = tasks.filter((t) => toIsoDate(t.due_date) < today);
  const dueToday = tasks.filter((t) => toIsoDate(t.due_date) === today);
  const ahead = tasks.filter((t) => toIsoDate(t.due_date) > today);

  const rows = [];
  let n = 0;

  const block = (heading, list, state) => {
    for (const t of list.slice(0, 8)) {
      n += 1;
      rows.push({
        number: n,
        title: `${MARK[t.status] || '\u25cb'} ${t.title}`,
        state,
        meta: [
          heading,
          sayDate(toIsoDate(t.due_date), today) + (t.due_time ? ` ${t.due_time} \u0e19.` : ''),
          PRIORITY_TH[t.priority] || null,
        ].filter(Boolean).join(' \u00b7 '),
      });
    }
  };

  block('เลยกำหนดแล้ว', overdue, 'overdue');
  block('ครบกำหนดวันนี้', dueToday, 'today');
  block('ใน 7 วันข้างหน้า', ahead, null);

  for (const e of events.slice(0, 5)) {
    n += 1;
    rows.push({
      number: n,
      title: `\u25c6 ${e.title}`,
      meta: [
        sayDate(toIsoDate(e.starts_on), today) +
          (!e.all_day && e.starts_at ? ` ${e.starts_at} \u0e19.` : ''),
        e.place || null,
      ].filter(Boolean).join(' \u00b7 '),
    });
  }

  const counts = [
    overdue.length ? `เลยกำหนด ${overdue.length}` : null,
    dueToday.length ? `วันนี้ ${dueToday.length}` : null,
    ahead.length ? `สัปดาห์นี้ ${ahead.length}` : null,
    events.length ? `กิจกรรม ${events.length}` : null,
  ].filter(Boolean).join(' \u00b7 ');

  return flex(`สรุปงานของคุณวันนี้ — ${counts}`, listBubble({
    title: 'สรุปงานของคุณวันนี้',
    subtitle: counts + ' \u00b7 พิมพ์ "ปิดแจ้งเตือน" เพื่อหยุดสรุปนี้',
    rows,
    link: pageLink('work'),
    linkLabel: 'เปิดบนเว็บ',
  }), LINE_MENU);
}

const addDaysIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
