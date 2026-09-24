import { DEPARTMENTS, unitsOf } from './departments.js';
import { canPostTo } from './scope.js';
import { parseDate, parseTime, todayIso, sayDate, matchPerson } from './linecmd.js';

/**
 * Adding a task by answering questions, one at a time.
 *
 * Typing "เพิ่มงาน ติดต่อสถานที่ 20/11 18:00 @กุ๊งกิ๊ง #เนื้อหา !ด่วน" is fast
 * once you know the syntax and impossible before then. This is the other way
 * in: the bot asks, you tap. Every question offers buttons, so most of a task
 * can be created without typing anything after the title.
 *
 * Three rules hold everywhere, and they are what stop a chat wizard becoming a
 * trap. Every single step accepts ยกเลิก and ends the conversation there and
 * then. Every optional step offers ข้าม. And a conversation nobody finishes is
 * forgotten after a day rather than waiting forever for an answer.
 */

export const CANCEL = ['ยกเลิก', 'cancel', 'เลิก', 'ออก', 'จบ', 'หยุด'];
export const SKIP = ['ข้าม', 'skip', 'ไม่ระบุ', '-'];
export const BACK = ['ย้อนกลับ', 'กลับ', 'back'];

export const isCancel = (t) => CANCEL.includes(String(t || '').trim().toLowerCase());
export const isSkip = (t) => SKIP.includes(String(t || '').trim().toLowerCase());
export const isBack = (t) => BACK.includes(String(t || '').trim().toLowerCase());

/** The three things the rich menu offers. */
export const MENU_ADD = ['เพิ่มงาน', 'เพิ่มงานใหม่', 'add task'];
export const MENU_VIEW = ['ตรวจสอบงาน', 'ดูงาน', 'view tasks'];
export const MENU_MANAGE = ['จัดการงาน', 'manage', 'manage tasks'];

/**
 * The questions, in the order they are asked.
 *
 * Kept as data rather than a chain of ifs so the order can be read at a glance
 * and changed in one place — and so "which step comes next" is never a
 * decision made in three different functions that can disagree.
 */
export const ADD_STEPS = [
  'title', 'description', 'dueDate', 'dueTime',
  'assignees', 'scope', 'department', 'unit',
  'priority', 'status', 'notify', 'confirm',
];

const PRIORITY_CHOICES = [
  ['ปกติ', 'medium'], ['ด่วน', 'high'], ['ด่วนที่สุด', 'highest'], ['ต่ำ', 'low'],
];
const STATUS_CHOICES = [
  ['ยังไม่เริ่ม', 'todo'], ['กำลังทำ', 'doing'], ['รอตรวจ', 'review'],
];
const SCOPE_CHOICES = [
  ['เฉพาะหัวหน้าฝ่าย', 'heads'], ['เฉพาะสมาชิกฝ่าย', 'members'],
  ['ทั้งฝ่าย', 'all'], ['ไม่ต้องแท็กฝ่าย', 'none'],
];
const NOTIFY_CHOICES = [
  ['ครบทุกแบบ', 'created,7d,24h,due'],
  ['7 วัน + 1 วัน + วันครบกำหนด', '7d,24h,due'],
  ['เฉพาะวันครบกำหนด', 'due'],
  ['ไม่ต้องแจ้งเตือน', ''],
];

const pick = (choices, text) => {
  const want = String(text || '').trim().toLowerCase();
  const found = choices.find(([label]) => label.toLowerCase() === want);
  return found ? found[1] : undefined;
};

/** Quick-reply labels always carry a way out. */
const withExit = (labels) => [...labels, 'ยกเลิก'];

const PEOPLE_PER_PAGE = 8;

/**
 * Asks the question for one step.
 *
 * Returns the words and the buttons; it never touches the draft, so the
 * question a person sees and the answer the next call reads cannot drift
 * apart.
 */
export function ask(step, draft, context) {
  const { me, people } = context;

  switch (step) {
    case 'title':
      return {
        text: 'เพิ่มงานใหม่ — ขั้นที่ 1/11\n\nชื่องานคืออะไรคะ',
        labels: ['ยกเลิก'],
      };

    case 'description':
      return {
        text: `ขั้นที่ 2/11 — รายละเอียดงาน\n\n"${draft.title}"\n\nพิมพ์รายละเอียด หรือกด ข้าม`,
        labels: withExit(['ข้าม']),
      };

    case 'dueDate':
      return {
        text: 'ขั้นที่ 3/11 — กำหนดส่ง\n\nกดเลือก หรือพิมพ์วันที่ เช่น 20/11 หรือ 2026-11-20',
        labels: withExit(['วันนี้', 'พรุ่งนี้', 'ศุกร์นี้', 'ศุกร์หน้า', 'ข้าม']),
      };

    case 'dueTime':
      return {
        text: 'ขั้นที่ 4/11 — เวลา (ถ้ามี)\n\nกดเลือก หรือพิมพ์เวลา เช่น 18:00',
        labels: withExit(['09:00', '12:00', '17:00', '18:00', 'ข้าม']),
      };

    case 'assignees': {
      const chosen = draft.assignees || [];
      const offer = peoplePage(people, me, chosen, draft.page || 0);
      const lines = ['ขั้นที่ 5/11 — ผู้รับผิดชอบ'];
      if (chosen.length) {
        lines.push('', 'เลือกแล้ว: ' + chosen.map((u) => nameOf(people, u)).join(', '));
      }
      lines.push('', 'กดชื่อเพื่อเลือก (เลือกได้หลายคน) หรือพิมพ์ชื่อเพื่อค้นหา');
      const labels = offer.names.map((u) => nameOf(people, u));
      if (offer.more) labels.push('▸ คนอื่น ๆ');
      labels.push('ฉันเอง');
      if (chosen.length) labels.push('✓ เลือกเสร็จแล้ว');
      else labels.push('ข้าม');
      return { text: lines.join('\n'), labels: withExit(labels) };
    }

    case 'scope':
      return {
        text: 'ขั้นที่ 6/11 — แท็กคนทั้งฝ่ายด้วยไหมคะ\n\nคนที่แท็กจะเห็นงานนี้และได้รับแจ้งเตือน',
        labels: withExit(SCOPE_CHOICES.map(([label]) => label)),
      };

    case 'department': {
      const mine = DEPARTMENTS.filter((d) => canPostTo(me, d.key));
      return {
        text: 'ขั้นที่ 7/11 — ฝ่ายที่งานนี้อยู่',
        labels: withExit(mine.slice(0, 11).map((d) => d.th)),
      };
    }

    case 'unit': {
      const units = draft.department ? unitsOf(draft.department) : [];
      if (!units.length) return null;     // nothing to ask; the caller skips on
      return {
        text: 'ขั้นที่ 8/11 — หน่วยย่อยในฝ่าย',
        labels: withExit([...units.slice(0, 10), 'ทั้งฝ่าย']),
      };
    }

    case 'priority':
      return {
        text: 'ขั้นที่ 9/11 — ความสำคัญ',
        labels: withExit(PRIORITY_CHOICES.map(([label]) => label)),
      };

    case 'status':
      return {
        text: 'ขั้นที่ 10/11 — สถานะเริ่มต้น',
        labels: withExit(STATUS_CHOICES.map(([label]) => label)),
      };

    case 'notify':
      return {
        text: 'ขั้นที่ 11/11 — แจ้งเตือนเมื่อไหร่',
        labels: withExit(NOTIFY_CHOICES.map(([label]) => label)),
      };

    case 'confirm':
      return { text: summary(draft, people), labels: ['✓ บันทึกงาน', 'เริ่มใหม่', 'ยกเลิก'] };

    default:
      return null;
  }
}

/**
 * Reads one answer.
 *
 * Returns `{ draft, next }` to move on, `{ draft, stay: true, note }` to ask
 * the same question again with an explanation, or `{ done: true }` / `{ cancel: true }`.
 * Validation lives here and nowhere else, so an answer the bot accepted is an
 * answer the database will accept too.
 */
export function answer(step, draft, input, context) {
  const { me, people } = context;
  const text = String(input || '').trim();

  if (isCancel(text)) return { cancel: true };

  switch (step) {
    case 'title': {
      if (!text) return { stay: true, note: 'ยังไม่ได้พิมพ์ชื่องานค่ะ' };
      if (text.length > 200) return { stay: true, note: 'ชื่องานยาวเกินไป (ไม่เกิน 200 ตัวอักษร)' };
      return { draft: { ...draft, title: text }, next: true };
    }

    case 'description':
      return { draft: { ...draft, description: isSkip(text) ? '' : text.slice(0, 4000) }, next: true };

    case 'dueDate': {
      if (isSkip(text)) return { draft: { ...draft, dueDate: null }, next: true };
      const date = parseDate(text, todayIso());
      if (!date) {
        return { stay: true, note: `ไม่เข้าใจวันที่ "${text}" — ลองแบบ 20/11 หรือ 2026-11-20 หรือกดปุ่มด้านล่าง` };
      }
      return { draft: { ...draft, dueDate: date }, next: true };
    }

    case 'dueTime': {
      if (isSkip(text)) return { draft: { ...draft, dueTime: null }, next: true };
      const time = parseTime(text);
      if (!time) return { stay: true, note: `ไม่เข้าใจเวลา "${text}" — ลองแบบ 18:00` };
      // A time with no date would be a deadline nobody can act on.
      if (!draft.dueDate) {
        return { stay: true, note: 'ยังไม่ได้ตั้งวันครบกำหนด จึงใส่เวลาไม่ได้ค่ะ กด ข้าม ไปก่อนได้' };
      }
      return { draft: { ...draft, dueTime: time }, next: true };
    }

    case 'assignees': {
      const chosen = draft.assignees || [];

      if (isSkip(text)) return { draft: { ...draft, assignees: [], page: 0 }, next: true };
      if (text === '✓ เลือกเสร็จแล้ว') {
        if (!chosen.length) return { stay: true, note: 'ยังไม่ได้เลือกใครเลยค่ะ' };
        return { draft: { ...draft, page: 0 }, next: true };
      }
      if (text === '▸ คนอื่น ๆ') {
        return { draft: { ...draft, page: (draft.page || 0) + 1 }, stay: true };
      }
      if (text === 'ฉันเอง') {
        const already = chosen.includes(me.username);
        return {
          draft: { ...draft, assignees: already ? chosen : [...chosen, me.username] },
          stay: true,
          note: already ? 'เลือกไว้แล้วค่ะ' : null,
        };
      }

      const found = matchPerson(text, people);
      if (!found) return { stay: true, note: `ไม่พบชื่อ "${text}" — ลองพิมพ์ชื่อเล่นหรือ username` };
      if (chosen.includes(found.username)) {
        return { stay: true, note: `${nameOf(people, found.username)} เลือกไว้แล้วค่ะ` };
      }
      return { draft: { ...draft, assignees: [...chosen, found.username] }, stay: true };
    }

    case 'scope': {
      const value = pick(SCOPE_CHOICES, text);
      if (value === undefined) return { stay: true, note: 'กรุณากดเลือกจากปุ่มด้านล่างค่ะ' };
      return { draft: { ...draft, scope: value }, next: true };
    }

    case 'department': {
      const dept = DEPARTMENTS.find((d) => d.th === text || d.en === text || d.key === text);
      if (!dept) return { stay: true, note: 'กรุณากดเลือกฝ่ายจากปุ่มด้านล่างค่ะ' };
      if (!canPostTo(me, dept.key)) {
        return { stay: true, note: `ไม่มีสิทธิ์สร้างงานในฝ่าย ${dept.th} ค่ะ` };
      }
      // Changing department invalidates any section already chosen.
      return { draft: { ...draft, department: dept.key, unit: null }, next: true };
    }

    case 'unit': {
      if (text === 'ทั้งฝ่าย' || isSkip(text)) return { draft: { ...draft, unit: null }, next: true };
      const units = unitsOf(draft.department);
      const found = units.find((u) => u.toLowerCase() === text.toLowerCase());
      if (!found) return { stay: true, note: 'กรุณากดเลือกจากปุ่มด้านล่าง หรือกด ทั้งฝ่าย' };
      return { draft: { ...draft, unit: found }, next: true };
    }

    case 'priority': {
      const value = pick(PRIORITY_CHOICES, text);
      if (value === undefined) return { stay: true, note: 'กรุณากดเลือกจากปุ่มด้านล่างค่ะ' };
      return { draft: { ...draft, priority: value }, next: true };
    }

    case 'status': {
      const value = pick(STATUS_CHOICES, text);
      if (value === undefined) return { stay: true, note: 'กรุณากดเลือกจากปุ่มด้านล่างค่ะ' };
      return { draft: { ...draft, status: value }, next: true };
    }

    case 'notify': {
      const value = pick(NOTIFY_CHOICES, text);
      if (value === undefined) return { stay: true, note: 'กรุณากดเลือกจากปุ่มด้านล่างค่ะ' };
      return { draft: { ...draft, notify: value }, next: true };
    }

    case 'confirm': {
      if (text === 'เริ่มใหม่') return { restart: true };
      if (text === '✓ บันทึกงาน' || text.includes('บันทึก')) return { save: true };
      return { stay: true, note: 'กด ✓ บันทึกงาน เพื่อบันทึก หรือ ยกเลิก เพื่อทิ้งงานนี้' };
    }

    default:
      return { cancel: true };
  }
}

/**
 * Which people to offer, and whether there are more.
 *
 * The committee is about two hundred people and LINE allows thirteen buttons,
 * so the order matters: the people in the asker's own departments come first,
 * because those are who they are almost always assigning to. Everyone else is
 * a page away, and typing a name searches the whole roster regardless.
 */
export function peoplePage(people, me, chosen, page) {
  const mine = new Set([me.department, ...(me.departments || [])].filter(Boolean));
  const near = [];
  const far = [];
  for (const u of people) {
    if (chosen.includes(u.username)) continue;
    if (u.username === me.username) continue;          // "ฉันเอง" covers this
    ((u.departments || []).some((d) => mine.has(d)) ? near : far).push(u.username);
  }
  const ordered = [...near, ...far];
  const start = page * PEOPLE_PER_PAGE;
  return {
    names: ordered.slice(start, start + PEOPLE_PER_PAGE),
    more: ordered.length > start + PEOPLE_PER_PAGE,
    total: ordered.length,
  };
}

const nameOf = (people, username) => {
  const u = people.find((p) => p.username === username);
  return u ? (u.nickname || u.display_name || u.username) : username;
};

/** What they are about to save, in full, before anything is written. */
export function summary(draft, people) {
  const deptName = DEPARTMENTS.find((d) => d.key === draft.department)?.th || '—';
  const scopeLabel = SCOPE_CHOICES.find(([, v]) => v === draft.scope)?.[0] || 'ไม่ต้องแท็กฝ่าย';
  const prioLabel = PRIORITY_CHOICES.find(([, v]) => v === draft.priority)?.[0] || 'ปกติ';
  const statusLabel = STATUS_CHOICES.find(([, v]) => v === draft.status)?.[0] || 'ยังไม่เริ่ม';
  const notifyLabel = NOTIFY_CHOICES.find(([, v]) => v === draft.notify)?.[0] || '7 วัน + 1 วัน + วันครบกำหนด';

  return [
    'ตรวจสอบก่อนบันทึก',
    '',
    `ชื่องาน: ${draft.title}`,
    `รายละเอียด: ${draft.description || '—'}`,
    `กำหนดส่ง: ${draft.dueDate ? sayDate(draft.dueDate) : 'ไม่มีกำหนด'}${draft.dueTime ? ` ${draft.dueTime} น.` : ''}`,
    `ผู้รับผิดชอบ: ${(draft.assignees || []).length
      ? draft.assignees.map((u) => nameOf(people, u)).join(', ') : '—'}`,
    `ฝ่าย: ${deptName}${draft.unit ? ` · ${draft.unit}` : ''}`,
    `แท็กในฝ่าย: ${scopeLabel}`,
    `ความสำคัญ: ${prioLabel}`,
    `สถานะ: ${statusLabel}`,
    `แจ้งเตือน: ${notifyLabel}`,
    '',
    'ถูกต้องไหมคะ',
  ].join('\n');
}

/** The step after this one, skipping any question with nothing to ask. */
export function nextStep(step, draft, context) {
  const at = ADD_STEPS.indexOf(step);
  for (let i = at + 1; i < ADD_STEPS.length; i++) {
    const candidate = ADD_STEPS[i];
    // A department with no sections has no section question to ask.
    if (candidate === 'unit' && !(draft.department && unitsOf(draft.department).length)) continue;
    // Nobody tagged a department, so there is nothing to scope or file under.
    if (candidate === 'department' && draft.scope === 'none') continue;
    if (candidate === 'unit' && draft.scope === 'none') continue;
    if (ask(candidate, draft, context)) return candidate;
  }
  return 'confirm';
}

export const FIRST_STEP = ADD_STEPS[0];
export { SCOPE_CHOICES, PRIORITY_CHOICES, STATUS_CHOICES, NOTIFY_CHOICES };
