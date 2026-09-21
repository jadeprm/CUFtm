import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { fetchPeople, syncPeople } from '../lib/sheet.js';

export const config = {
  runtime: 'edge',
};

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

export default async function handler(request) {
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
                ${`${MESSAGES[kind].th} / ${MESSAGES[kind].en} —${when}`})`;
      await sql`
        INSERT INTO reminders_sent (task_id, username, kind)
        VALUES (${task.id}, ${username}, ${kind}) ON CONFLICT DO NOTHING`;

      created.push({ task: task.id, username, kind });
    }
  }

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
    roster,
    secured: Boolean(secret),
    ...(secret ? {} : { warning: 'Set CRON_SECRET in Vercel and add ?key=… to the ping URL.' }),
  });
}