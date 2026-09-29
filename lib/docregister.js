import {
  sheetWriteConfigured, listTabs, readRanges, readRange, writeRanges, quoteTab, columnLetter,
} from './sheets.js';

/**
 * The document register — เลขรันเอกสาร.
 *
 * The committee keeps a spreadsheet with one tab per ฝ่าย. Each tab holds its
 * รหัสฝ่าย and a log: เลขรันเอกสาร, ชื่อเรื่อง, สถานะ, ผู้รับผิดชอบ, หมายเหตุ,
 * and beside it a list of รายชื่อผู้รับผิดชอบ. The numbers run per ฝ่าย —
 * อบจ.จฬฟ. 03.01-001/2569, then 002, and so on.
 *
 * Three decisions shape this file.
 *
 * The spreadsheet is the master, not a copy. The format of a number, the code
 * for each ฝ่าย and the year are all read from the sheet rather than written
 * down here, because the committee maintains that sheet and a second copy of
 * the numbering plan in code would be wrong within a term.
 *
 * A tab is found by the ฝ่าย name INSIDE it (C1), not by the tab's own label.
 * The labels are abbreviated and occasionally misspelled — "Exhibiton",
 * "Timer, AP" — while the cell inside each one carries the proper name.
 *
 * And nothing here ever throws. A register that cannot be reached must not
 * stop a document being sent; it reports what it could not do, and the next
 * attempt picks it up.
 */

export const REGISTER_ID = () => process.env.DOC_SHEET_ID || '';
export const registerConfigured = () => Boolean(sheetWriteConfigured() && REGISTER_ID());

/** Row 3 is the header; the log starts at row 4. */
const FIRST_ROW = 4;
const LAST_ROW = 400;

/** Columns, as the committee laid them out. */
const COL = { index: 'A', number: 'B', title: 'C', status: 'D', who: 'E', note: 'F' };
/** The name list beside it. */
const NAME_COL = { index: 'H', name: 'I' };

/**
 * Matching is forgiving, because the two sides were written by different
 * people at different times: spacing, case, brackets and the ฝ่าย prefix all
 * vary. The app says ฝ่ายเนื้อหา where the sheet says เนื้อหา, and the sheet
 * says ทรัพยากรบุคคล (HR) where the app says HR.
 */
const normalise = (value) =>
  String(value ?? '').toLowerCase().replace(/[\s_\-.()]/g, '');

/** The same, with a leading ฝ่าย dropped — it is a title, not part of the name. */
const bare = (value) => normalise(value).replace(/^ฝ่าย/, '');

/**
 * The stage of a document, in the words the register uses.
 *
 * Not the same words as the app's own status chips: this column is read by
 * people looking at a spreadsheet of letters, not at a task board.
 */
export const REGISTER_STATUS = {
  approving: 'รออนุมัติ',
  secretary: 'รอเลขาฯ ส่ง',
  done: 'อนุมัติครบแล้ว',
  sent: 'ส่งแล้ว',
  rejected: 'ถูกตีกลับ',
  archived: 'ส่งแล้ว (เก็บเข้าคลังแล้ว)',
};

// ---------------------------------------------------------------------------
// Reading the plan
// ---------------------------------------------------------------------------

let cached = null;
const CACHE_MS = 10 * 60 * 1000;

/**
 * Every tab, with the ฝ่าย it is for and that ฝ่าย's code.
 *
 * Cached for ten minutes: this is forty-odd ranges in one call, and the plan
 * changes when somebody restructures the committee, not between documents.
 */
export async function loadPlan({ force = false } = {}) {
  if (!registerConfigured()) return { ok: false, reason: 'NOT_CONFIGURED', tabs: [] };
  if (!force && cached && cached.at > Date.now() - CACHE_MS) return cached.plan;

  try {
    const id = REGISTER_ID();
    const titles = await listTabs(id);
    // B1:C2 is where every tab keeps ฝ่าย and รหัสฝ่าย.
    const heads = await readRanges(id, titles.map((t) => `${quoteTab(t)}!B1:C2`));

    const tabs = titles.map((title, i) => {
      const rows = heads[i] || [];
      const name = (rows[0] || [])[1] || '';
      const code = (rows[1] || [])[1] || '';
      return { title, name: String(name).trim(), code: String(code).trim() };
    }).filter((t) => t.code);

    const plan = { ok: true, tabs };
    cached = { at: Date.now(), plan };
    return plan;
  } catch (error) {
    return { ok: false, reason: 'SHEET_UNREACHABLE', message: String(error?.message || error).slice(0, 200), tabs: [] };
  }
}

/** Forgets the cached plan — for tests, and after somebody edits the sheet. */
export const forgetPlan = () => { cached = null; };

/**
 * Which tab a document belongs on.
 *
 * The section first, because a letter from Stage is registered under Stage
 * and not under ฝ่ายเนื้อหา; the department is the fallback for a document
 * that belongs to no particular section.
 */
export function tabFor(plan, { unit, department }) {
  const find = (wanted) => {
    if (!wanted) return null;

    // Exact first, on the ฝ่าย name inside the tab and then on its label.
    const want = normalise(wanted);
    const exact = plan.tabs.find((t) => normalise(t.name) === want) ||
      plan.tabs.find((t) => normalise(t.title) === want);
    if (exact) return exact;

    // Then ignoring the ฝ่าย prefix on either side.
    const stem = bare(wanted);
    const stemmed = plan.tabs.filter((t) => bare(t.name) === stem || bare(t.title) === stem);
    if (stemmed.length === 1) return stemmed[0];

    /**
     * Last, one name containing the other — "HR" inside "ทรัพยากรบุคคล (HR)".
     *
     * Only when exactly ONE tab matches. กิจกรรม is also inside กิจกรรมบนเวที
     * and กิจกรรมงานวัด, and a letter filed under the wrong ฝ่าย because a
     * name was a substring of three others would be worse than one that was
     * not filed at all.
     */
    if (stem.length < 2) return null;
    const loose = plan.tabs.filter((t) => {
      const name = bare(t.name);
      return name.includes(stem) || stem.includes(name);
    });
    return loose.length === 1 ? loose[0] : null;
  };
  return find(unit) || find(department) || null;
}

// ---------------------------------------------------------------------------
// The numbers themselves
// ---------------------------------------------------------------------------

/**
 * Pulls a number apart: "อบจ.จฬฟ. 03.01-007/2569" → prefix, 7, width 3, year.
 *
 * Written as a shape rather than a fixed string so the committee can change
 * the prefix or the year without this needing an edit.
 */
export function readNumber(text) {
  const m = String(text ?? '').trim().match(/^(.*?)(\d+)(\s*\/\s*(\d{4}))?$/);
  if (!m) return null;
  return {
    prefix: m[1],
    seq: Number(m[2]),
    width: m[2].length,
    year: m[4] || null,
  };
}

export const formatNumber = ({ prefix, seq, width, year }) =>
  `${prefix}${String(seq).padStart(width, '0')}${year ? `/${year}` : ''}`;

/** The Buddhist year, which is what these numbers are dated in. */
export const buddhistYear = (now = new Date()) =>
  String(Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric',
  }).format(now)) + 543);

/**
 * The next number for a tab, and the row it should be written on.
 *
 * `rows` is the log as the sheet returns it, from row 4 down. The next number
 * follows the highest one already issued — not the row count — because a blank
 * row left in the middle must not hand out a number somebody already has.
 *
 * The first row of every tab arrives pre-filled with 001 as a template, which
 * is how the format is learned. That row is used rather than skipped when
 * nothing has been registered yet.
 */
export function nextEntry(rows, { code, year }) {
  let best = null;
  let firstFree = -1;

  rows.forEach((row, i) => {
    const number = readNumber((row || [])[1]);
    const title = String((row || [])[2] ?? '').trim();
    if (number && (!best || number.seq > best.seq)) best = number;
    if (!title && firstFree === -1) firstFree = i;
  });

  const shape = best || {
    prefix: `อบจ.จฬฟ. ${code}-`,
    seq: 0,
    width: 3,
    year,
  };

  // Nothing registered yet: the template row IS the first entry, so its own
  // number is used rather than one past it.
  const usedTemplate = !rows.some((row) => String((row || [])[2] ?? '').trim());
  const seq = usedTemplate ? Math.max(shape.seq, 1) : shape.seq + 1;

  return {
    number: formatNumber({ ...shape, seq, year: shape.year || year }),
    seq,
    rowIndex: firstFree === -1 ? rows.length : firstFree,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Registers one document: takes the next number for its ฝ่าย and writes the
 * row. Returns `{ ok, number, tab, row }`, or `{ ok: false, reason }`.
 */
export async function registerDocument({ department, unit, title, status, responsible }) {
  if (!registerConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };

  try {
    const plan = await loadPlan();
    if (!plan.ok) return { ok: false, reason: plan.reason };

    const tab = tabFor(plan, { unit, department });
    if (!tab) return { ok: false, reason: 'NO_TAB_FOR_DEPARTMENT', department, unit };

    const id = REGISTER_ID();
    const range = `${quoteTab(tab.title)}!${COL.index}${FIRST_ROW}:${COL.note}${LAST_ROW}`;
    const rows = await readRange(id, range);

    const entry = nextEntry(rows, { code: tab.code, year: buddhistYear() });
    const row = FIRST_ROW + entry.rowIndex;

    await writeRanges(id, [{
      range: `${quoteTab(tab.title)}!${COL.index}${row}:${COL.who}${row}`,
      values: [[String(entry.seq), entry.number, title, status, responsible || '']],
    }]);

    return { ok: true, number: entry.number, tab: tab.title, code: tab.code, row };
  } catch (error) {
    return { ok: false, reason: 'SHEET_REFUSED', message: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * Updates the สถานะ of a row already registered.
 *
 * Finds the row by its number rather than trusting a stored row index: people
 * insert and sort rows in a spreadsheet, and a stale index would overwrite
 * somebody else's line.
 */
export async function updateStatus({ tab, number, status }) {
  if (!registerConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!tab || !number) return { ok: false, reason: 'NOT_REGISTERED' };

  try {
    const id = REGISTER_ID();
    const range = `${quoteTab(tab)}!${COL.number}${FIRST_ROW}:${COL.number}${LAST_ROW}`;
    const rows = await readRange(id, range);
    const at = rows.findIndex((r) => String((r || [])[0] ?? '').trim() === number);
    if (at === -1) return { ok: false, reason: 'ROW_NOT_FOUND' };

    const row = FIRST_ROW + at;
    await writeRanges(id, [{
      range: `${quoteTab(tab)}!${COL.status}${row}`,
      values: [[status]],
    }]);
    return { ok: true, row };
  } catch (error) {
    return { ok: false, reason: 'SHEET_REFUSED', message: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * Fills in the รายชื่อผู้รับผิดชอบ list on a tab from the roster.
 *
 * So that the names in the register are the same names as in the app, spelled
 * the same way, rather than whatever each person types that day. Only people
 * who have given a full name are listed — a row saying "Kungking_HeadCon" in
 * a book of letters would be worse than a short list.
 */
export async function writeNames({ department, unit, names }) {
  if (!registerConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };

  try {
    const plan = await loadPlan();
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const tab = tabFor(plan, { unit, department });
    if (!tab) return { ok: false, reason: 'NO_TAB_FOR_DEPARTMENT' };

    const clean = [...new Set(names.filter(Boolean).map((n) => String(n).trim()))].sort();
    if (!clean.length) return { ok: false, reason: 'NO_NAMES' };

    const last = FIRST_ROW + Math.max(clean.length, 20) - 1;
    const values = [];
    for (let i = 0; i < Math.max(clean.length, 20); i++) {
      values.push(i < clean.length ? [String(i + 1), clean[i]] : ['', '']);
    }

    await writeRanges(REGISTER_ID(), [{
      range: `${quoteTab(tab.title)}!${NAME_COL.index}${FIRST_ROW}:${NAME_COL.name}${last}`,
      values,
    }]);
    return { ok: true, tab: tab.title, listed: clean.length };
  } catch (error) {
    return { ok: false, reason: 'SHEET_REFUSED', message: String(error?.message || error).slice(0, 200) };
  }
}

export { COL, NAME_COL, FIRST_ROW, normalise, bare };
