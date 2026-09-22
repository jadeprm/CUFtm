import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';
import { parseCsv } from '../lib/sheet.js';
import { DEPARTMENTS, isDepartment } from '../lib/departments.js';
import { STATUSES, PRIORITIES, isPriority } from '../lib/scope.js';

/**
 * Bulk import of tasks from a spreadsheet.
 *
 *   POST /api/import?do=preview   { csv } or { sheetUrl }
 *   POST /api/import?do=commit    { rows: [...] }
 *
 * Preview and commit are deliberately separate. Importing forty tasks is not
 * undoable in one click, so nothing is written until the person has seen
 * exactly what will be created — which names matched, which did not, which
 * dates were understood.
 */

const NOTIFY_KINDS = ['created', '7d', '24h', 'due'];
const MAX_ROWS = 300;

const clean = (v, max = 4000) => String(v ?? '').trim().slice(0, max);

/** Header names people actually type, in both languages. */
const COLUMNS = {
  title: ['title', 'task', 'ชื่องาน', 'งาน'],
  description: ['description', 'details', 'detail', 'รายละเอียด'],
  assignees: ['assignees', 'assignee', 'who', "who's on it", 'ผู้รับผิดชอบ', 'คนทำ'],
  departments: ['departments', 'department', 'ฝ่าย'],
  dueDate: ['due date', 'duedate', 'due', 'กำหนดส่ง', 'วันที่'],
  dueTime: ['due time', 'duetime', 'time', 'เวลา'],
  status: ['status', 'สถานะ'],
  notify: ['notify', 'reminders', 'แจ้งเตือน'],
  priority: ['priority', 'ความสำคัญ', 'ระดับ'],
};

function columnIndexes(header) {
  const lower = header.map((h) => clean(h, 60).toLowerCase());
  const found = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    found[key] = lower.findIndex((h) => names.includes(h));
  }
  return found;
}

/**
 * Accepts 2026-10-05 and 05/10/2026.
 *
 * Slash dates are read day-first, the Thai and British convention. That is a
 * guess, and a wrong guess silently moves a deadline — so the preview shows
 * every parsed date back in unambiguous form before anything is saved, and the
 * template asks for YYYY-MM-DD.
 */
function parseDate(value) {
  const v = clean(value, 40);
  if (!v) return { date: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };

  const slash = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (Number(m) > 12) return { date: null, error: 'BAD_DATE' };
    return { date: iso, note: Number(d) <= 12 ? 'DAY_FIRST_ASSUMED' : undefined };
  }
  return { date: null, error: 'BAD_DATE' };
}

function parseTime(value) {
  const v = clean(value, 20);
  if (!v) return { time: null };
  const m = v.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return { time: null, error: 'BAD_TIME' };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return { time: null, error: 'BAD_TIME' };
  return { time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

const STATUS_WORDS = {
  todo: 'todo', 'to do': 'todo', 'ยังไม่เริ่ม': 'todo',
  doing: 'doing', 'in progress': 'doing', 'กำลังทำ': 'doing',
  review: 'review', 'under review': 'review', 'รอตรวจ': 'review',
  feedback: 'feedback', 'feedback provided': 'feedback', 'feedback given': 'feedback',
  'ตรวจแล้ว': 'feedback', 'ให้ความเห็นแล้ว': 'feedback',
  done: 'done', 'เสร็จแล้ว': 'done', 'เสร็จ': 'done',
};

const PRIORITY_WORDS = {
  low: 'low', 'ต่ำ': 'low',
  medium: 'medium', normal: 'medium', 'ปานกลาง': 'medium', 'กลาง': 'medium',
  high: 'high', 'สูง': 'high',
  highest: 'highest', urgent: 'highest', 'สูงมาก': 'highest', 'ด่วน': 'highest', 'ด่วนมาก': 'highest',
};

/** Matches a written name to an account: username, display name or nickname. */
function matchPerson(text, people) {
  const q = clean(text, 80).toLowerCase();
  if (!q) return null;
  return (
    people.find((p) => p.username.toLowerCase() === q) ||
    people.find((p) => (p.display_name || '').toLowerCase() === q) ||
    people.find((p) => (p.sheet_name || '').toLowerCase() === q) ||
    people.find((p) => (p.nickname || '').toLowerCase() === q) ||
    people.find((p) => (p.display_name || '').toLowerCase().startsWith(q) && q.length >= 3) ||
    null
  );
}

/** "Content", "ฝ่ายเนื้อหา" and "content:heads" all resolve. */
function matchDepartment(text) {
  const raw = clean(text, 60);
  if (!raw) return null;
  const [namePart, scopePart] = raw.split(':');
  const q = clean(namePart, 60).toLowerCase();
  const scope = ['heads', 'members', 'all'].includes(clean(scopePart, 10).toLowerCase())
    ? clean(scopePart, 10).toLowerCase()
    : 'all';

  const dept =
    DEPARTMENTS.find((d) => d.key === q) ||
    DEPARTMENTS.find((d) => d.en.toLowerCase() === q) ||
    DEPARTMENTS.find((d) => d.th.toLowerCase() === q) ||
    DEPARTMENTS.find((d) => d.th.replace(/^ฝ่าย/, '').toLowerCase() === q);

  return dept ? { key: dept.key, scope } : null;
}

const splitList = (text) =>
  clean(text, 500)
    .split(/[,;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function buildRows(rows, people) {
  if (!rows.length) return { error: 'EMPTY' };

  const headerAt = rows.findIndex((r) => columnIndexes(r).title !== -1);
  if (headerAt === -1) return { error: 'NO_TITLE_COLUMN' };

  const col = columnIndexes(rows[headerAt]);
  const out = [];

  for (let i = headerAt + 1; i < rows.length && out.length < MAX_ROWS; i++) {
    const raw = rows[i];
    const title = clean(col.title === -1 ? '' : raw[col.title], 200);
    if (!title) continue; // blank lines and spacer rows

    const problems = [];
    const notes = [];

    const dateResult = parseDate(col.dueDate === -1 ? '' : raw[col.dueDate]);
    if (dateResult.error) problems.push('BAD_DATE');
    if (dateResult.note) notes.push(dateResult.note);

    const timeResult = parseTime(col.dueTime === -1 ? '' : raw[col.dueTime]);
    if (timeResult.error) problems.push('BAD_TIME');

    const assignees = [];
    const unknownPeople = [];
    for (const name of splitList(col.assignees === -1 ? '' : raw[col.assignees])) {
      const person = matchPerson(name, people);
      if (person) { if (!assignees.includes(person.username)) assignees.push(person.username); }
      else unknownPeople.push(name);
    }

    const departments = [];
    const unknownDepts = [];
    for (const name of splitList(col.departments === -1 ? '' : raw[col.departments])) {
      const dept = matchDepartment(name);
      if (dept && isDepartment(dept.key)) {
        if (!departments.some((d) => d.key === dept.key && d.scope === dept.scope)) departments.push(dept);
      } else unknownDepts.push(name);
    }

    const statusWord = clean(col.status === -1 ? '' : raw[col.status], 30).toLowerCase();
    const status = STATUS_WORDS[statusWord] || 'todo';
    if (statusWord && !STATUS_WORDS[statusWord]) notes.push('STATUS_DEFAULTED');

    const priorityWord = clean(col.priority === -1 ? '' : raw[col.priority], 30).toLowerCase();
    const priority = PRIORITY_WORDS[priorityWord] || 'medium';
    if (priorityWord && !PRIORITY_WORDS[priorityWord]) notes.push('PRIORITY_DEFAULTED');

    const notifyList = splitList(col.notify === -1 ? '' : raw[col.notify])
      .map((n) => n.toLowerCase())
      .filter((n) => NOTIFY_KINDS.includes(n));

    out.push({
      line: i + 1,
      title,
      description: clean(col.description === -1 ? '' : raw[col.description], 4000),
      assignees,
      departments,
      dueDate: dateResult.date,
      dueTime: timeResult.time,
      status: STATUSES.includes(status) ? status : 'todo',
      priority,
      notify: notifyList.length ? notifyList : NOTIFY_KINDS,
      unknownPeople,
      unknownDepts,
      problems,
      notes,
    });
  }

  return { rows: out, truncated: rows.length - headerAt - 1 > MAX_ROWS };
}

/** Turns any Google Sheets link into its CSV export. */
function sheetCsvUrl(link) {
  const id = String(link).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
  if (!id) return null;
  const gid = String(link).match(/[#&?]gid=(\d+)/)?.[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

async function handler(request) {
  if (!hasDatabase) return noDatabase();

  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const action = requestUrl(request).searchParams.get('do');
  const body = await request.json().catch(() => ({}));

  if (action === 'preview') {
    let csv = clean(body.csv, 400_000);

    if (!csv && body.sheetUrl) {
      const target = sheetCsvUrl(body.sheetUrl);
      if (!target) return json({ error: 'BAD_SHEET_URL' }, 400);
      try {
        const res = await fetch(target, { redirect: 'follow' });
        if (!res.ok) return json({ error: 'SHEET_UNREADABLE', status: res.status }, 502);
        csv = await res.text();
        if (/<html/i.test(csv.slice(0, 200))) {
          return json({
            error: 'SHEET_PRIVATE',
            message: 'That sheet is not shared. Set it to "Anyone with the link → Viewer".',
          }, 502);
        }
      } catch (error) {
        return json({ error: 'SHEET_UNREADABLE', message: error.message }, 502);
      }
    }

    if (!csv) return json({ error: 'EMPTY' }, 400);

    const people = await sql`SELECT username, display_name, sheet_name, nickname FROM users WHERE active = true`;
    const result = buildRows(parseCsv(csv), people);
    if (result.error) return json({ error: result.error }, 400);

    return json({ rows: result.rows, truncated: result.truncated, max: MAX_ROWS });
  }

  if (action === 'commit') {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
    if (!rows.length) return json({ error: 'EMPTY' }, 400);

    let created = 0;
    const failed = [];

    for (const row of rows) {
      const title = clean(row.title, 200);
      if (!title) { failed.push({ line: row.line, reason: 'NO_TITLE' }); continue; }

      try {
        const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const notify = (Array.isArray(row.notify) ? row.notify : NOTIFY_KINDS)
          .filter((k) => NOTIFY_KINDS.includes(k)).join(',');

        // Imported tasks land in the importer's own teamspace unless a row
        // names a department, so nothing arrives somewhere invisible.
        const home = (row.departments || []).find((d) => isDepartment(d.key));
        await sql`
          INSERT INTO tasks (id, title, description, due_date, due_time, status, priority,
                             department, created_by, notify)
          VALUES (${id}, ${title}, ${clean(row.description, 4000)},
                  ${/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate || '') ? row.dueDate : null},
                  ${/^\d{2}:\d{2}$/.test(row.dueTime || '') ? row.dueTime : null},
                  ${STATUSES.includes(row.status) ? row.status : 'todo'},
                  ${isPriority(row.priority) ? row.priority : 'medium'},
                  ${home ? home.key : (me.department || null)}, ${me.username}, ${notify})`;

        // Resolve department tags to people, exactly as the task form does.
        const set = new Set((row.assignees || []).map((a) => clean(a, 64)).filter(Boolean));
        for (const d of row.departments || []) {
          if (!isDepartment(d.key)) continue;
          const found =
            d.scope === 'heads'
              ? await sql`SELECT u.username FROM users u JOIN user_departments x ON x.username = u.username
                          WHERE x.department = ${d.key} AND u.is_head = true AND u.active = true`
              : d.scope === 'members'
                ? await sql`SELECT u.username FROM users u JOIN user_departments x ON x.username = u.username
                            WHERE x.department = ${d.key} AND u.is_head = false AND u.active = true`
                : await sql`SELECT u.username FROM users u JOIN user_departments x ON x.username = u.username
                            WHERE x.department = ${d.key} AND u.active = true`;
          for (const f of found) set.add(f.username);
          await sql`INSERT INTO task_departments (task_id, department, scope)
                    VALUES (${id}, ${d.key}, ${d.scope}) ON CONFLICT DO NOTHING`;
        }
        for (const username of set) {
          await sql`INSERT INTO task_people (task_id, username) VALUES (${id}, ${username})
                    ON CONFLICT DO NOTHING`;
          if (username !== me.username && notify.includes('created')) {
            await sql`
              INSERT INTO notifications (id, username, task_id, kind, title, body)
              VALUES (${`n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`},
                      ${username}, ${id}, 'created', ${title},
                      ${`${me.display_name || me.username} added you to this task.`})`;
          }
        }
        created++;
      } catch (error) {
        failed.push({ line: row.line, reason: String(error.message || error).slice(0, 120) });
      }
    }

    return json({ created, failed });
  }

  return json({ error: 'UNKNOWN_ACTION' }, 400);
}

export default withNode(handler);
