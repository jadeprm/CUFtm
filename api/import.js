import { getSql, json, noDatabase, hasDatabase, requestUrl } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';
import { parseCsv } from '../lib/sheet.js';
import { DEPARTMENTS, isDepartment } from '../lib/departments.js';
import {
  STATUSES, PRIORITIES, isPriority, isColour, COLOUR_KEYS, safeUrl, linkKind,
} from '../lib/scope.js';

/**
 * Bulk import of tasks from a spreadsheet.
 *
 *   POST /api/import?do=preview   { csv } or { sheetUrl }, optional { kind: 'events' }
 *   POST /api/import?do=commit    { rows: [...] }, optional { kind: 'events' }
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
  departments: ['departments', 'department', 'ฝ่าย', 'tag departments', 'แท็กฝ่าย'],
  teamspace: ['teamspace', 'home', 'ฝ่ายหลัก', 'ฝ่ายเจ้าของ'],
  dueDate: ['due date', 'duedate', 'due', 'กำหนดส่ง', 'วันที่'],
  dueTime: ['due time', 'duetime', 'time', 'เวลา'],
  status: ['status', 'สถานะ'],
  notify: ['notify', 'reminders', 'แจ้งเตือน'],
  priority: ['priority', 'ความสำคัญ', 'ระดับ'],
  parts: ['parts', 'subtasks', 'sub-tasks', 'งานย่อย'],
  links: ['links', 'link', 'work', 'ไฟล์งาน', 'ลิงก์'],
};

/** The same idea for events, which have a start and an end rather than a deadline. */
const EVENT_COLUMNS = {
  title: ['title', 'event', 'ชื่อกิจกรรม', 'กิจกรรม'],
  description: ['description', 'details', 'detail', 'รายละเอียด'],
  startsOn: ['starts on', 'start date', 'date', 'starts', 'วันที่', 'วันที่เริ่ม'],
  startsAt: ['starts at', 'start time', 'from', 'time', 'เวลาเริ่ม', 'เวลา'],
  endsOn: ['ends on', 'end date', 'until', 'ถึงวันที่', 'วันที่จบ'],
  endsAt: ['ends at', 'end time', 'to', 'เวลาจบ'],
  allDay: ['all day', 'allday', 'ทั้งวัน'],
  place: ['place', 'where', 'location', 'venue', 'สถานที่'],
  people: ['who', 'people', 'attendees', 'เกี่ยวข้องกับใคร', 'ผู้เกี่ยวข้อง'],
  departments: ['departments', 'department', 'ฝ่าย'],
  colour: ['colour', 'color', 'สี'],
  notify: ['notify', 'remind', 'reminders', 'แจ้งเตือน'],
};

function columnIndexes(header, map = COLUMNS) {
  const lower = header.map((h) => clean(h, 60).toLowerCase());
  const found = {};
  for (const [key, names] of Object.entries(map)) {
    found[key] = lower.findIndex((h) => names.includes(h));
  }
  return found;
}

/** "yes", "ใช่", "true", "1" — the ways people write a tick in a spreadsheet. */
const isYes = (value) => {
  const v = clean(value, 20).toLowerCase();
  if (!v) return null;
  return ['yes', 'y', 'true', '1', 'ใช่', 'ทั้งวัน', 'x'].includes(v);
};

/**
 * Sub-tasks written in one cell: "ออกแบบบูธ@กุ๊งกิ๊ง; ประสานวิทยากร@North".
 *
 * The name after @ is optional — a part with nobody on it is a perfectly
 * reasonable thing to import and hand out later.
 */
function parseParts(text, people) {
  const out = [];
  const unknown = [];
  for (const piece of splitItems(text)) {
    const at = piece.lastIndexOf('@');
    const title = clean(at === -1 ? piece : piece.slice(0, at), 200).trim();
    if (!title) continue;
    const who = at === -1 ? '' : piece.slice(at + 1).trim();
    const person = who ? matchPerson(who, people) : null;
    if (who && !person) unknown.push(who);
    out.push({ title, assignee: person ? person.username : null });
  }
  return { parts: out, unknown };
}

/** Links written in one cell: "แบบร่าง|https://…; https://…" — label optional. */
function parseLinks(text) {
  const out = [];
  const bad = [];
  for (const piece of splitItems(text)) {
    const bar = piece.indexOf('|');
    const label = bar === -1 ? '' : clean(piece.slice(0, bar), 120).trim();
    const raw = bar === -1 ? piece : piece.slice(bar + 1);
    const url = safeUrl(raw);
    if (!url) { bad.push(piece.slice(0, 60)); continue; }
    out.push({ url, label, kind: linkKind(url) });
  }
  return { links: out, bad };
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

/**
 * The splitter for cells whose items have structure of their own.
 *
 * Sub-tasks and links use `|` and `,` inside a single item — a label may
 * contain a comma, and `แบบร่าง|https://…` puts the bar between label and
 * address — so those two characters cannot also be separators. Semicolons and
 * line breaks are what divide one item from the next, and the cap is larger
 * because three full URLs in one cell run well past the length a list of
 * names ever reaches.
 */
const splitItems = (text) =>
  clean(text, 2000)
    .split(/[;\n]/)
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

    // The teamspace the task lives in. Named explicitly when the column is
    // there; otherwise the first department tag, as before.
    const named = matchDepartment(col.teamspace === -1 ? '' : raw[col.teamspace]);
    if (col.teamspace !== -1 && clean(raw[col.teamspace], 60) && !named) {
      unknownDepts.push(clean(raw[col.teamspace], 60));
    }
    const teamspace = named && isDepartment(named.key)
      ? named.key
      : (departments.find((d) => isDepartment(d.key))?.key || null);

    const partResult = parseParts(col.parts === -1 ? '' : raw[col.parts], people);
    unknownPeople.push(...partResult.unknown);

    const linkResult = parseLinks(col.links === -1 ? '' : raw[col.links]);
    if (linkResult.bad.length) notes.push('BAD_LINK');

    out.push({
      line: i + 1,
      title,
      description: clean(col.description === -1 ? '' : raw[col.description], 4000),
      assignees,
      departments,
      teamspace,
      dueDate: dateResult.date,
      dueTime: timeResult.time,
      status: STATUSES.includes(status) ? status : 'todo',
      priority,
      parts: partResult.parts,
      links: linkResult.links,
      notify: notifyList.length ? notifyList : NOTIFY_KINDS,
      unknownPeople,
      unknownDepts,
      problems,
      notes,
    });
  }

  return { rows: out, truncated: rows.length - headerAt - 1 > MAX_ROWS };
}

/**
 * The same job for events.
 *
 * Kept separate from the task builder rather than bolted onto it with flags:
 * they share almost no columns, and one function trying to be both is how a
 * date ends up in the wrong field.
 */
function buildEventRows(rows, people) {
  if (!rows.length) return { error: 'EMPTY' };

  const headerAt = rows.findIndex((r) => columnIndexes(r, EVENT_COLUMNS).title !== -1);
  if (headerAt === -1) return { error: 'NO_TITLE_COLUMN' };

  const col = columnIndexes(rows[headerAt], EVENT_COLUMNS);
  const out = [];
  const at = (raw, key) => (col[key] === -1 ? '' : raw[col[key]]);

  for (let i = headerAt + 1; i < rows.length && out.length < MAX_ROWS; i++) {
    const raw = rows[i];
    const title = clean(at(raw, 'title'), 200);
    if (!title) continue;

    const problems = [];
    const notes = [];

    const start = parseDate(at(raw, 'startsOn'));
    if (start.error || !start.date) problems.push('BAD_DATE');
    if (start.note) notes.push(start.note);

    const end = parseDate(at(raw, 'endsOn'));
    if (end.error) problems.push('BAD_DATE');
    if (end.date && start.date && end.date < start.date) problems.push('ENDS_BEFORE_START');

    const from = parseTime(at(raw, 'startsAt'));
    const to = parseTime(at(raw, 'endsAt'));
    if (from.error || to.error) problems.push('BAD_TIME');

    // All day unless a start time says otherwise — the common case for a
    // committee calendar is a whole day, and a blank column should mean that.
    const said = isYes(at(raw, 'allDay'));
    const allDay = said === null ? !from.time : said;

    const people_ = [];
    const unknownPeople = [];
    for (const name of splitList(at(raw, 'people'))) {
      const person = matchPerson(name, people);
      if (person) { if (!people_.includes(person.username)) people_.push(person.username); }
      else unknownPeople.push(name);
    }

    const departments = [];
    const unknownDepts = [];
    for (const name of splitList(at(raw, 'departments'))) {
      const dept = matchDepartment(name);
      if (dept && isDepartment(dept.key)) {
        if (!departments.includes(dept.key)) departments.push(dept.key);
      } else unknownDepts.push(name);
    }

    const colourWord = clean(at(raw, 'colour'), 20).toLowerCase();
    const colour = isColour(colourWord) ? colourWord : 'plum';
    if (colourWord && !isColour(colourWord)) notes.push('COLOUR_DEFAULTED');

    const notifyList = splitList(at(raw, 'notify'))
      .map((n) => n.toLowerCase())
      .filter((n) => ['7d', '24h', 'due'].includes(n));

    out.push({
      line: i + 1,
      title,
      description: clean(at(raw, 'description'), 4000),
      startsOn: start.date,
      startsAt: allDay ? null : from.time,
      endsOn: end.date,
      endsAt: allDay ? null : to.time,
      allDay,
      place: clean(at(raw, 'place'), 200),
      people: people_,
      departments,
      colour,
      notify: notifyList.length ? notifyList : ['7d', '24h', 'due'],
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
    const parsed = parseCsv(csv);
    const result = body.kind === 'events'
      ? buildEventRows(parsed, people)
      : buildRows(parsed, people);
    if (result.error) return json({ error: result.error }, 400);

    return json({
      kind: body.kind === 'events' ? 'events' : 'tasks',
      rows: result.rows,
      truncated: result.truncated,
      max: MAX_ROWS,
    });
  }

  if (action === 'commit') {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
    if (!rows.length) return json({ error: 'EMPTY' }, 400);

    let created = 0;
    const failed = [];

    // ---- events -----------------------------------------------------------
    if (body.kind === 'events') {
      for (const row of rows) {
        const title = clean(row.title, 200);
        const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(row.startsOn || '') ? row.startsOn : null;
        if (!title) { failed.push({ line: row.line, reason: 'NO_TITLE' }); continue; }
        if (!startsOn) { failed.push({ line: row.line, reason: 'NO_DATE' }); continue; }

        const endsOn = /^\d{4}-\d{2}-\d{2}$/.test(row.endsOn || '') ? row.endsOn : null;
        if (endsOn && endsOn < startsOn) {
          failed.push({ line: row.line, reason: 'ENDS_BEFORE_START' });
          continue;
        }

        try {
          const id = `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const allDay = row.allDay !== false;
          const notify = (Array.isArray(row.notify) ? row.notify : ['7d', '24h', 'due'])
            .filter((k) => ['7d', '24h', 'due'].includes(k)).join(',');

          await sql`
            INSERT INTO events (id, title, description, starts_on, starts_at, ends_on, ends_at,
                                all_day, place, department, colour, notify, created_by)
            VALUES (${id}, ${title}, ${clean(row.description, 4000)},
                    ${startsOn},
                    ${allDay ? null : (/^\d{2}:\d{2}$/.test(row.startsAt || '') ? row.startsAt : null)},
                    ${endsOn},
                    ${allDay ? null : (/^\d{2}:\d{2}$/.test(row.endsAt || '') ? row.endsAt : null)},
                    ${allDay}, ${clean(row.place, 200)},
                    ${(row.departments || []).find(isDepartment) || me.department || null},
                    ${isColour(row.colour) ? row.colour : 'plum'},
                    ${notify}, ${me.username})`;

          const named = (row.people || []).map((x) => clean(x, 64)).filter(Boolean);
          if (named.length) {
            await sql`
              INSERT INTO event_people (event_id, username)
              SELECT ${id}, u FROM unnest(${named}::text[]) AS u ON CONFLICT DO NOTHING`;
          }
          const keys = (row.departments || []).filter(isDepartment);
          if (keys.length) {
            await sql`
              INSERT INTO event_departments (event_id, department)
              SELECT ${id}, d FROM unnest(${keys}::text[]) AS d ON CONFLICT DO NOTHING`;
          }
          created++;
        } catch (error) {
          failed.push({ line: row.line, reason: String(error.message || error).slice(0, 120) });
        }
      }
      return json({ kind: 'events', created, failed });
    }

    for (const row of rows) {
      const title = clean(row.title, 200);
      if (!title) { failed.push({ line: row.line, reason: 'NO_TITLE' }); continue; }

      try {
        const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const notify = (Array.isArray(row.notify) ? row.notify : NOTIFY_KINDS)
          .filter((k) => NOTIFY_KINDS.includes(k)).join(',');

        // Imported tasks land in the importer's own teamspace unless the row
        // says otherwise, so nothing arrives somewhere nobody can see.
        const home = isDepartment(row.teamspace)
          ? { key: row.teamspace }
          : (row.departments || []).find((d) => isDepartment(d.key));
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
        // Sub-tasks and attached work, if the row carried any.
        const parts = Array.isArray(row.parts) ? row.parts.slice(0, 50) : [];
        let position = 0;
        for (const part of parts) {
          const partTitle = clean(part?.title, 200);
          if (!partTitle) continue;
          const who = part?.assignee ? clean(part.assignee, 64) : null;
          await sql`
            INSERT INTO task_parts (id, task_id, title, assignee, position, created_by)
            VALUES (${`p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`},
                    ${id}, ${partTitle}, ${who}, ${position++}, ${me.username})`;
          if (who) {
            await sql`INSERT INTO task_people (task_id, username) VALUES (${id}, ${who})
                      ON CONFLICT DO NOTHING`;
          }
        }

        for (const link of (Array.isArray(row.links) ? row.links.slice(0, 20) : [])) {
          const href = safeUrl(link?.url);
          if (!href) continue;
          await sql`
            INSERT INTO task_links (id, task_id, url, label, kind, added_by)
            VALUES (${`l_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`},
                    ${id}, ${href}, ${clean(link?.label, 120)}, ${linkKind(href)}, ${me.username})`;
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
