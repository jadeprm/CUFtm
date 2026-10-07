/**
 * Turning a task, an event or a meeting into the props its LINE card takes.
 *
 * Separate from the builders in lineflex.js (which only know about layout)
 * and from api/line.js (which only knows about the conversation), so that the
 * part in the middle — what day is "พรุ่งนี้", how many days late is late,
 * which names to print and when to say "และอีก 6 คน" — can be tested with a
 * fixed date and no database.
 */
import { taskBubble, eventBubble, meetingBubble } from './lineflex.js';
import { sayDate } from './linecmd.js';
import { departmentByKey } from './departments.js';
import { colourHex } from './scope.js';

const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

const deptName = (key) => (departmentByKey(key) || {}).th || key;
const dayOf = (iso) => String(Number(String(iso).slice(8, 10)));
const monthOf = (iso) => MONTH_TH[Number(String(iso).slice(5, 7)) - 1] || '';
const shortDate = (iso) => `${dayOf(iso)} ${monthOf(iso)}`;

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** "8 ต.ค. 14:30", in Bangkok, for an instant the database stored. */
function stamp(value) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return `${Number(parts.day)} ${MONTH_TH[Number(parts.month) - 1]} ${parts.hour}:${parts.minute} น.`;
}

/**
 * Up to four names, then a count — a card is not a register, and ten names
 * wrapped over five lines pushed the facts that matter off the bottom.
 */
function namesOf(usernames = [], names = {}, max = 4) {
  return {
    people: usernames.slice(0, max).map((u) => names[u] || u),
    more: Math.max(0, usernames.length - max),
  };
}

export function taskCard(task, { today, names = {}, canMove = false, link = null, me = null }) {
  let dueState = null;
  let overdueBy = 0;
  if (task.dueDate && task.status !== 'done') {
    if (task.dueDate < today) { dueState = 'overdue'; overdueBy = daysBetween(task.dueDate, today); }
    else if (task.dueDate === today) dueState = 'today';
  }
  const { people, more } = namesOf(task.assignees, names);
  const parts = task.parts || [];
  return taskBubble({
    id: task.id,
    code: task.code,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due: task.dueDate
      ? sayDate(task.dueDate, today) + (task.dueTime ? ` ${task.dueTime} น.` : '')
      : null,
    dueState,
    overdueBy,
    people,
    morePeople: more,
    department: task.department ? deptName(task.department) : null,
    unit: task.unit || null,
    description: task.description || '',
    parts: { done: parts.filter((x) => x.done).length, total: parts.length },
    files: (task.links || []).length,
    createdBy: task.createdBy ? (names[task.createdBy] || task.createdBy) : null,
    updated: stamp(task.updatedAt),
    viewers: (task.viewers || []).length,
    watching: Boolean(me) && (task.viewers || []).includes(me) && !(task.assignees || []).includes(me),
    canMove,
    link,
  });
}

/** "อีก 3 วัน", "พรุ่งนี้", "วันนี้" — or nothing for a day long past. */
function untilLabel(iso, today) {
  if (!iso) return null;
  const n = daysBetween(today, iso);
  if (n < 0) return null;
  if (n === 0) return 'วันนี้';
  if (n === 1) return 'พรุ่งนี้';
  return `อีก ${n} วัน`;
}

/**
 * A Google Calendar link for an event, built here rather than on the page:
 * a card in a chat is often the only place somebody sees the event before the
 * day, and "add it to my calendar" is the thing they want to do with it.
 * Times are local to Bangkok and say so, so a phone set to another zone still
 * puts the rehearsal at the right hour.
 */
export function googleLinkForEvent(e) {
  const compact = (iso) => String(iso).replace(/-/g, '');
  const next = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  };
  const end = e.endsOn || e.startsOn;
  let dates;
  if (e.allDay || !e.startsAt) {
    dates = `${compact(e.startsOn)}/${next(end)}`;
  } else {
    const t = (hhmm) => String(hhmm).replace(':', '') + '00';
    const finish = e.endsAt || e.startsAt;
    dates = `${compact(e.startsOn)}T${t(e.startsAt)}/${compact(end)}T${t(finish)}`;
  }
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: e.title, dates,
    details: e.description || '', location: e.place || '', ctz: 'Asia/Bangkok',
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function eventCard(e, { today, names = {}, link = null }) {
  const multi = e.endsOn && e.endsOn !== e.startsOn;
  const hours = e.allDay || !e.startsAt ? 'ทั้งวัน'
    : `${e.startsAt}${e.endsAt ? `–${e.endsAt}` : ''} น.`;
  const when = (multi ? `${shortDate(e.startsOn)} – ${shortDate(e.endsOn)} · ` : `${shortDate(e.startsOn)} · `) + hours;

  let audience = null;
  if ((e.people || []).length) {
    const { people, more } = namesOf(e.people, names);
    audience = people.join(', ') + (more ? ` และอีก ${more} คน` : '');
  } else if ((e.departments || []).length) {
    audience = e.departments.map(deptName).join(', ');
  } else {
    audience = 'ทุกคนในงาน';
  }

  return eventBubble({
    code: e.code,
    title: e.title,
    colour: colourHex(e.colour),
    day: dayOf(e.startsOn),
    month: monthOf(e.startsOn),
    when,
    place: e.place || null,
    audience,
    description: e.description || '',
    untilLabel: untilLabel(e.startsOn, today),
    link,
    calendarLink: googleLinkForEvent(e),
  });
}

export function meetingCard(m, { today, me, canReply = false, link = null }) {
  const mine = (m.people || []).find((p) => p.username === me);
  // The headings and the first of what is under them, up to eight lines —
  // enough to know what the meeting is for without the card scrolling forever.
  const agenda = (m.agenda || []).filter((a) => a.depth === 0 || !a.hasChildren);
  const shown = agenda.slice(0, 8);
  const length = m.length && m.length.minutes
    ? `${m.length.minutes} นาที${m.length.endsAt ? ` (ถึง ${m.length.endsAt})` : ''}`
    : null;
  return meetingBubble({
    id: m.id,
    code: m.code,
    title: m.title,
    day: dayOf(m.meetsOn),
    month: monthOf(m.meetsOn),
    when: `${shortDate(m.meetsOn)}${m.meetsAt ? ` · ${m.meetsAt} น.` : ''}`,
    place: m.place || null,
    joinUrl: m.joinUrl || null,
    untilLabel: untilLabel(m.meetsOn, today),
    agenda: shown.map((a) => ({ number: a.number, title: a.title, depth: a.depth, minutes: a.minutes })),
    agendaMore: agenda.length - shown.length,
    length,
    counts: m.counts || { accepted: 0, declined: 0, invited: 0, total: 0 },
    myReply: mine ? mine.reply : null,
    canReply: Boolean(mine) && canReply,
    note: m.note || '',
    link,
    calendarLink: m.googleUrl || null,
  });
}

/**
 * As many cards as LINE will take in one message.
 *
 * A carousel holds at most ten bubbles and the whole message must stay under
 * 50KB; a task card with a long description is several KB. Rather than let
 * LINE refuse the whole reply, cards are dropped from the end until it fits,
 * and the caller is told how many went so it can say so.
 */
export function fitCarousel(bubbles, limit = 45000) {
  const out = bubbles.slice(0, 10);
  while (out.length > 1 && JSON.stringify(out).length > limit) out.pop();
  return { bubbles: out, dropped: bubbles.length - out.length };
}
