import { DEPARTMENTS, matchUnit } from './departments.js';
import {
  STATUSES, PRIORITIES, isStatus,
  canSeeTask, canSetStatus, canDeleteTask, canPostTo, seesEverything,
} from './scope.js';

/**
 * Understanding what somebody typed into LINE.
 *
 * People are walking between buildings with one thumb on a phone, so this is
 * written to be forgiving rather than clever: the command word can be Thai or
 * English, extra spaces are ignored, dates can be written four different ways,
 * and anything it cannot make sense of gets an answer that says what WAS
 * understood instead of "invalid command".
 *
 * Nothing here decides who may do what. Every write hands off to the same
 * permission rules the website uses, so a member cannot do through the bot
 * what they could not do through a browser.
 */

export const TZ = 'Asia/Bangkok';

export function todayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------------------
// Reading dates the way people write them
// ---------------------------------------------------------------------------

const WEEKDAYS = {
  'จันทร์': 1, 'อังคาร': 2, 'พุธ': 3, 'พฤหัส': 4, 'พฤหัสบดี': 4,
  'ศุกร์': 5, 'เสาร์': 6, 'อาทิตย์': 0,
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};

/**
 * Turns one word into a date, or returns null.
 *
 * Years are the awkward part: Thai people write both 2026 and 2569 for the
 * same year, and a two-digit year is ambiguous. Buddhist years are detected by
 * being impossibly large for a Gregorian one and converted; a bare day/month
 * is read as the next such date rather than one in the past, because nobody
 * types a deadline that has already gone.
 */
export function parseDate(word, today = todayIso()) {
  const raw = String(word || '').trim().toLowerCase();
  if (!raw) return null;

  if (['วันนี้', 'today'].includes(raw)) return today;
  if (['พรุ่งนี้', 'tomorrow', 'พรุ้งนี้'].includes(raw)) return addDays(today, 1);
  if (['มะรืน', 'มะรืนนี้'].includes(raw)) return addDays(today, 2);

  /**
   * "ศุกร์นี้" / "friday" / "ศุกร์หน้า".
   *
   * Said on a Friday, "ศุกร์นี้" means today — that is what a person means
   * when they say it, and pushing it a week out would silently move a deadline.
   * "หน้า" is the word for wanting the one after, so it always skips ahead.
   */
  const nextWeek = /หน้า$/.test(raw) || /^next/.test(raw);
  const weekday = raw.replace(/^วัน/, '').replace(/^next\s*/, '').replace(/(นี้|หน้า)$/, '').trim();
  if (Object.prototype.hasOwnProperty.call(WEEKDAYS, weekday)) {
    const want = WEEKDAYS[weekday];
    const base = new Date(`${today}T00:00:00Z`).getUTCDay();
    let ahead = (want - base + 7) % 7;
    if (nextWeek && ahead === 0) ahead = 7;
    else if (nextWeek) ahead += 7;
    return addDays(today, ahead);
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return normaliseYear(Number(iso[1]), iso[2], iso[3]);

  const slash = raw.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (slash) {
    const day = slash[1].padStart(2, '0');
    const month = slash[2].padStart(2, '0');
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
    if (slash[3]) {
      let year = Number(slash[3]);
      if (year < 100) year += 2000;
      return normaliseYear(year, month, day);
    }
    // No year written: this year, or next year if that date has already gone.
    // Still checked for existing — "31/2" is a typo, not a deadline.
    const year = Number(today.slice(0, 4));
    return normaliseYear(year, month, day) && `${year}-${month}-${day}` >= today
      ? `${year}-${month}-${day}`
      : normaliseYear(year + 1, month, day);
  }
  return null;
}

/** 2569 is 2026 said in Buddhist years, which half the committee will type. */
function normaliseYear(year, month, day) {
  const gregorian = year > 2400 ? year - 543 : year;
  const iso = `${gregorian}-${month}-${day}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function parseTime(word) {
  const raw = String(word || '').trim();
  const m = raw.match(/^(\d{1,2})[:.](\d{2})$/) || raw.match(/^(\d{1,2})\.(\d{2})\s*น\.?$/);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const PRIORITY_WORDS = {
  'ด่วนที่สุด': 'highest', 'ด่วนมาก': 'highest', highest: 'highest', urgent: 'highest',
  'ด่วน': 'high', 'สูง': 'high', high: 'high',
  'ปกติ': 'medium', medium: 'medium', normal: 'medium',
  'ต่ำ': 'low', low: 'low',
};

const STATUS_WORDS = {
  'ยังไม่เริ่ม': 'todo', todo: 'todo',
  'กำลังทำ': 'doing', doing: 'doing', 'ทำอยู่': 'doing',
  'รอตรวจ': 'review', review: 'review',
  'ตรวจแล้ว': 'feedback', feedback: 'feedback',
  'เสร็จแล้ว': 'done', 'เสร็จ': 'done', done: 'done',
};

// ---------------------------------------------------------------------------
// Pulling the pieces out of one line of text
// ---------------------------------------------------------------------------

/**
 * "เพิ่มงาน ติดต่อสถานที่ 20/11 18:00 @กุ๊งกิ๊ง #เนื้อหา !ด่วน"
 *
 * The markers are read wherever they appear and removed; whatever text is left
 * is the title. That way the order does not matter and someone who writes the
 * date first is not told they got it wrong.
 */
export function parseTaskLine(body, people, today = todayIso()) {
  const out = {
    title: '', dueDate: null, dueTime: null, assignees: [], departments: [],
    priority: null, unknownPeople: [], unknownDepts: [],
  };
  const leftover = [];

  for (const word of String(body || '').split(/\s+/).filter(Boolean)) {
    if (word.startsWith('@') && word.length > 1) {
      const found = matchPerson(word.slice(1), people);
      if (found) out.assignees.push(found.username);
      else out.unknownPeople.push(word.slice(1));
      continue;
    }
    if (word.startsWith('#') && word.length > 1) {
      const dept = matchDepartment(word.slice(1));
      if (dept) out.departments.push({ key: dept.key, scope: 'all' });
      else out.unknownDepts.push(word.slice(1));
      continue;
    }
    if (word.startsWith('!') && word.length > 1) {
      const level = PRIORITY_WORDS[word.slice(1).toLowerCase()];
      if (level) { out.priority = level; continue; }
    }
    if (!out.dueTime) {
      const time = parseTime(word);
      if (time) { out.dueTime = time; continue; }
    }
    if (!out.dueDate) {
      const date = parseDate(word, today);
      if (date) { out.dueDate = date; continue; }
    }
    leftover.push(word);
  }

  out.title = leftover.join(' ').trim();
  return out;
}

const normalise = (v) => String(v ?? '').toLowerCase().replace(/[\s_\-.]/g, '');

export function matchPerson(text, people) {
  const q = normalise(text);
  if (!q) return null;
  const fields = (u) => [u.username, u.display_name || u.displayName, u.nickname]
    .filter(Boolean).map(normalise);
  return people.find((u) => fields(u).includes(q))
    || people.find((u) => fields(u).some((f) => f.startsWith(q)))
    || null;
}

export function matchDepartment(text) {
  const q = normalise(text);
  if (!q) return null;
  return DEPARTMENTS.find((d) => normalise(d.key) === q)
    || DEPARTMENTS.find((d) => normalise(d.en) === q)
    || DEPARTMENTS.find((d) => normalise(d.th) === q)
    || DEPARTMENTS.find((d) => normalise(d.th.replace(/^ฝ่าย/, '')) === q)
    || null;
}

// ---------------------------------------------------------------------------
// Saying things back
// ---------------------------------------------------------------------------

const THAI_MONTH = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function sayDate(iso, today = todayIso()) {
  if (!iso) return 'ไม่มีกำหนด';
  const gap = daysBetween(today, iso);
  const stamp = `${Number(iso.slice(8, 10))} ${THAI_MONTH[Number(iso.slice(5, 7))]}`;
  if (gap === 0) return `วันนี้ (${stamp})`;
  if (gap === 1) return `พรุ่งนี้ (${stamp})`;
  if (gap < 0) return `เลยกำหนด ${-gap} วัน (${stamp})`;
  if (gap <= 14) return `อีก ${gap} วัน (${stamp})`;
  return stamp;
}

const MARK = { todo: '○', doing: '◐', review: '◔', feedback: '◕', done: '●' };
const STATUS_TH = {
  todo: 'ยังไม่เริ่ม', doing: 'กำลังทำ', review: 'รอตรวจ',
  feedback: 'ตรวจแล้ว', done: 'เสร็จแล้ว',
};
const PRIORITY_TH = { highest: 'ด่วนที่สุด', high: 'ด่วน', medium: '', low: 'ต่ำ' };

export function sayTask(task, index, today = todayIso()) {
  const bits = [`${index}. ${MARK[task.status] || '○'} ${task.title}`];
  const tail = [sayDate(task.dueDate, today) + (task.dueTime ? ` ${task.dueTime} น.` : '')];
  if (PRIORITY_TH[task.priority]) tail.push(PRIORITY_TH[task.priority]);
  if (task.status !== 'todo') tail.push(STATUS_TH[task.status]);
  bits.push(`    ${tail.join(' · ')}`);
  return bits.join('\n');
}

export function sayEvent(event, index, today = todayIso()) {
  const when = sayDate(event.startsOn, today) +
    (!event.allDay && event.startsAt ? ` ${event.startsAt} น.` : '');
  const tail = [when];
  if (event.place) tail.push(event.place);
  return `${index}. ◆ ${event.title}\n    ${tail.join(' · ')}`;
}

export const HELP = [
  'คำสั่งที่ใช้ได้',
  '',
  'ดูงาน',
  '· งาน — งานของฉันที่ยังไม่เสร็จ',
  '· วันนี้ — ครบกำหนดวันนี้',
  '· สัปดาห์นี้ — ครบกำหนดใน 7 วัน',
  '· เลยกำหนด — งานที่เลยกำหนดแล้ว',
  '· กิจกรรม — กิจกรรมที่กำลังจะถึง',
  '· หา <คำ> — ค้นหาจากชื่องาน',
  '',
  'แก้งาน (ใช้เลขที่เห็นในรายการล่าสุด)',
  '· เสร็จ 3 — ทำเครื่องหมายว่าเสร็จ',
  '· กำลังทำ 3 / รอตรวจ 3',
  '· ลบ 3 — ลบงาน (ต้องพิมพ์ ลบ 3 ยืนยัน)',
  '',
  'เพิ่มงาน',
  '· เพิ่มงาน ติดต่อสถานที่ 20/11 18:00 @กุ๊งกิ๊ง #เนื้อหา !ด่วน',
  '  วันที่เขียนได้หลายแบบ: 20/11, 2026-11-20, พรุ่งนี้, ศุกร์นี้',
  '· เพิ่มกิจกรรม ซ้อมใหญ่ 20/11 14:00',
  '',
  'อื่น ๆ',
  '· ปิดแจ้งเตือน / เปิดแจ้งเตือน — สรุปงานประจำวัน',
  '· เลิกเชื่อมต่อ — เลิกผูกบัญชี LINE นี้',
].join('\n');

export const MENU = ['งาน', 'วันนี้', 'สัปดาห์นี้', 'เลยกำหนด', 'กิจกรรม', 'ช่วยเหลือ'];

// ---------------------------------------------------------------------------
// Which command is this?
// ---------------------------------------------------------------------------

const COMMANDS = [
  ['help', ['ช่วย', 'ช่วยเหลือ', 'help', '?', 'เมนู', 'menu', 'คำสั่ง']],
  ['mine', ['งาน', 'งานของฉัน', 'งานฉัน', 'task', 'tasks', 'mytasks', 'my tasks']],
  ['today', ['วันนี้', 'today']],
  ['week', ['สัปดาห์นี้', 'สัปดาห์', 'อาทิตย์นี้', 'week', 'thisweek', 'this week']],
  ['overdue', ['เลยกำหนด', 'ค้าง', 'งานค้าง', 'overdue', 'late']],
  ['events', ['กิจกรรม', 'event', 'events']],
  ['digestOn', ['เปิดแจ้งเตือน', 'เปิดสรุป', 'notify on']],
  ['digestOff', ['ปิดแจ้งเตือน', 'ปิดสรุป', 'notify off']],
  ['unlink', ['เลิกเชื่อมต่อ', 'เลิกเชื่อม', 'ยกเลิกการเชื่อมต่อ', 'unlink', 'logout']],
  ['whoami', ['ฉันคือใคร', 'บัญชี', 'whoami', 'me']],
];

const PREFIXES = [
  ['search', ['หา ', 'ค้นหา ', 'find ', 'search ']],
  ['addTask', ['เพิ่มงาน ', 'งานใหม่ ', 'add task ', 'addtask ', 'new task ']],
  ['addEvent', ['เพิ่มกิจกรรม ', 'กิจกรรมใหม่ ', 'add event ', 'addevent ']],
  ['delete', ['ลบงาน ', 'ลบ ', 'delete ', 'del ']],
];

/** Splits one line into a command name and whatever followed it. */
export function readCommand(input) {
  const text = String(input || '').trim().replace(/\s+/g, ' ');
  if (!text) return { name: 'empty', rest: '' };
  const lower = text.toLowerCase();

  for (const [name, words] of COMMANDS) {
    if (words.includes(lower)) return { name, rest: '' };
  }
  for (const [name, starts] of PREFIXES) {
    for (const start of starts) {
      if (lower.startsWith(start)) return { name, rest: text.slice(start.length).trim() };
    }
  }
  // "เสร็จ 3", "กำลังทำ 3" — a status word followed by a number from the list.
  const status = lower.match(/^(\S+)\s+(\d{1,2})$/);
  if (status && STATUS_WORDS[status[1]]) {
    return { name: 'setStatus', rest: status[2], status: STATUS_WORDS[status[1]] };
  }
  // A six-character linking code, typed on its own.
  if (/^[A-Za-z0-9]{6}$/.test(text)) return { name: 'code', rest: text.toUpperCase() };

  return { name: 'unknown', rest: text };
}

export { STATUS_WORDS, PRIORITY_WORDS, STATUS_TH, PRIORITY_TH, MARK, isStatus, STATUSES, PRIORITIES };
export { canSeeTask, canSetStatus, canDeleteTask, canPostTo, seesEverything, matchUnit };
