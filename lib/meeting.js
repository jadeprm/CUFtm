/**
 * Meetings: the agenda, the running order, and who said they are coming.
 *
 * Kept away from the endpoint on purpose — the parts worth being sure about
 * here are rules, not database calls: what the committee's standard agenda
 * looks like, what happens to the running order when somebody adds an item in
 * the middle, and who is allowed to answer an invitation and until when.
 */
import { ACCESS } from './auth.js';

/** planned → the meeting is ahead; held → it happened; called off → it did not. */
export const MEETING_STATUS = ['planned', 'held', 'cancelled'];
export const isMeetingStatus = (v) => MEETING_STATUS.includes(v);

/** invited → nobody has answered; the other two are answers. */
export const REPLIES = ['invited', 'accepted', 'declined'];
export const isReply = (v) => REPLIES.includes(v);

/**
 * The committee's own agenda, as it appears in every set of minutes.
 *
 * Taken from รายงานการประชุมคณะกรรมการโครงการ — five วาระ in a fixed order,
 * every meeting, whether or not each has anything in it. Offered as a starting
 * point rather than imposed: a working session of three people does not need
 * วาระที่ 3, and a blank agenda is the other choice.
 *
 * The durations are a first guess at a ninety-minute meeting, there to be
 * changed. They matter because the page adds them up and says when the meeting
 * would actually end, which is the moment people notice an agenda is too long.
 */
export const STANDARD_AGENDA = [
  { kind: 'chair', th: 'วาระที่ 1 วาระประธานแจ้งให้ที่ประชุมทราบ',
    en: 'Item 1 — Chair’s announcements' },
  { kind: 'inform', th: 'วาระที่ 2 วาระเรื่องแจ้งเพื่อทราบ',
    en: 'Item 2 — For information' },
  { kind: 'carried', th: 'วาระที่ 3 เรื่องสืบเนื่อง',
    en: 'Item 3 — Matters arising' },
  { kind: 'decide', th: 'วาระที่ 4 เรื่องเสนอเพื่อพิจารณา',
    en: 'Item 4 — For consideration' },
  { kind: 'other', th: 'วาระที่ 5 เรื่องอื่น ๆ',
    en: 'Item 5 — Any other business' },
];

/**
 * The standard agenda as rows ready to insert, or nothing for a blank one.
 *
 * The five carry NO duration of their own. They are headings: วาระที่ 4 takes
 * exactly as long as the things somebody puts under it, and a made-up forty
 * minutes against an empty heading is a number nobody chose and everybody
 * would have had to correct.
 */
export function startingAgenda(template, lang = 'th') {
  if (template !== 'standard') return [];
  return STANDARD_AGENDA.map((item, i) => ({
    slot: i + 1,
    title: lang === 'en' ? item.en : item.th,
    minutes: 0,
    kind: item.kind,
    detail: '',
    priority: 'medium',
  }));
}

/**
 * Put a list of agenda items into a clean running order.
 *
 * Slots arrive from people, which means duplicates, gaps, and the number 7 on
 * a three-item agenda. Sorting by the slot asked for and then renumbering from
 * one keeps everybody's intended position without ever leaving a hole. Ties
 * break on when the item was proposed, so adding an item at the same position
 * as an existing one puts it after, not before.
 */
export function inOrder(items = []) {
  const byPosition = (a, b) => {
    const slot = (Number(a.slot) || 0) - (Number(b.slot) || 0);
    if (slot !== 0) return slot;
    return String(a.created_at || a.createdAt || '')
      .localeCompare(String(b.created_at || b.createdAt || ''));
  };
  const parentOf = (x) => x.parent_id || x.parentId || null;

  const heads = items.filter((x) => !parentOf(x)).sort(byPosition);
  const out = [];

  heads.forEach((head, i) => {
    const n = i + 1;
    const kids = items.filter((x) => parentOf(x) === head.id).sort(byPosition);

    /**
     * A heading's duration is whatever sits under it.
     *
     * Nobody sets the length of วาระที่ 4 directly — it is as long as its
     * items, and showing a figure that disagreed with the rows beneath it
     * would be worse than showing none.
     */
    const minutes = kids.length
      ? kids.reduce((sum, k) => sum + Math.max(0, Number(k.minutes) || 0), 0)
      : Math.max(0, Number(head.minutes) || 0);

    out.push({ ...head, slot: n, depth: 0, number: String(n),
      minutes, hasChildren: kids.length > 0 });
    kids.forEach((kid, j) => {
      out.push({ ...kid, slot: j + 1, depth: 1, number: `${n}.${j + 1}`,
        parentId: head.id, hasChildren: false });
    });
  });

  // An item whose parent has since been deleted still belongs on the agenda
  // rather than vanishing from it, so it is listed at the end.
  const placed = new Set(out.map((x) => x.id));
  items.filter((x) => !placed.has(x.id)).sort(byPosition).forEach((orphan, i) => {
    out.push({ ...orphan, slot: heads.length + i + 1, depth: 0,
      number: String(heads.length + i + 1), parentId: null, hasChildren: false });
  });

  return out;
}

/**
 * How long the agenda says the meeting will take, and when it would end.
 *
 * Returned as minutes and as a clock time, because "95 minutes" and "ends
 * 18:35" are answers to different questions and the second is the one that
 * makes somebody cut an item.
 */
export function agendaLength(items = [], startsAt = null) {
  // Only the leaves: a heading's figure is the sum of its children, so adding
  // both would count every item twice.
  const minutes = items
    .filter((i) => !i.hasChildren)
    .reduce((sum, i) => sum + Math.max(0, Number(i.minutes) || 0), 0);
  if (!startsAt || !/^\d{1,2}:\d{2}$/.test(startsAt)) return { minutes, endsAt: null };

  const [h, m] = startsAt.split(':').map(Number);
  const total = h * 60 + m + minutes;
  // A meeting that runs past midnight says so rather than wrapping silently.
  const endsAt = `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return { minutes, endsAt, nextDay: total >= 24 * 60 };
}

/**
 * Who may set a meeting up.
 *
 * The same people who run the committee's calendar — secretaries, who convene
 * meetings as their actual job, plus anybody from editor upwards. A member
 * cannot call a meeting of the committee, though they can propose items to one
 * they have been invited to.
 */
export function canCreateMeeting(user, { isSecretary = false } = {}) {
  if (!user) return false;
  if (isSecretary) return true;
  return [ACCESS.ADMIN, ACCESS.COADMIN, ACCESS.EDITOR].includes(user.access);
}

/** The organiser, an admin, or a secretary may change a meeting. */
export function canEditMeeting(user, meeting, { isSecretary = false } = {}) {
  if (!user || !meeting) return false;
  if (user.access === ACCESS.ADMIN || user.access === ACCESS.COADMIN) return true;
  if (isSecretary) return true;
  return (meeting.created_by || meeting.createdBy) === user.username;
}

/** Invited people see it; so do the people who run the committee. */
export function canSeeMeeting(user, meeting, invited = [], { isSecretary = false } = {}) {
  if (!user) return false;
  if (user.access === ACCESS.ADMIN || user.access === ACCESS.COADMIN || isSecretary) return true;
  if ((meeting.created_by || meeting.createdBy) === user.username) return true;
  return invited.some((p) => p.username === user.username);
}

/**
 * Anybody invited may propose an item — and take their own back.
 *
 * The organiser may remove any item, because somebody has to be able to keep
 * an agenda to a sensible length, but they cannot edit the wording of
 * somebody else's proposal into something it was not.
 */
export const canProposeItem = (user, invited = []) =>
  Boolean(user) && invited.some((p) => p.username === user.username);

export function canRemoveItem(user, meeting, item, { isSecretary = false } = {}) {
  if (!user || !item) return false;
  if (item.proposed_by === user.username || item.proposedBy === user.username) return true;
  return canEditMeeting(user, meeting, { isSecretary });
}

/**
 * Papers: who may attach one, and who may take one away.
 *
 * Attaching follows proposing an item — anybody invited, because the person who
 * has the budget spreadsheet is usually not the person who called the meeting,
 * and making them email it round defeats the point of having the meeting in the
 * system at all. Removing is your own, or the organiser's, exactly as with
 * agenda items.
 */
export const canAttach = (user, invited = []) => canProposeItem(user, invited);

export function canRemoveAttachment(user, meeting, file, { isSecretary = false } = {}) {
  if (!user || !file) return false;
  if ((file.added_by || file.addedBy) === user.username) return true;
  return canEditMeeting(user, meeting, { isSecretary });
}

/**
 * What may be attached to a meeting.
 *
 * An allow-list, not a block-list. These files are handed back to a browser by
 * a download route, and the one outcome worth ruling out completely is somebody
 * attaching an .html or .svg that then runs as a page on this origin with every
 * signed-in person's session cookie available to it. Everything a committee
 * actually brings to a meeting is here; anything else is a link.
 */
export const ATTACH_TYPES = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
};

/** The type a file claims, if it is one we are willing to hold. */
export function readAttachType(mime, name = '') {
  const claimed = String(mime || '').split(';')[0].trim().toLowerCase();
  if (ATTACH_TYPES[claimed]) return claimed;

  /**
   * Some browsers send nothing at all for an .xlsx picked off a phone, so the
   * extension gets a say — but only to CHOOSE among the types already allowed,
   * never to admit one that is not.
   */
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (!ext) return null;
  const found = Object.keys(ATTACH_TYPES).find((k) => ATTACH_TYPES[k] === ext[1]);
  return found || null;
}

/**
 * Whether an invitation can still be answered.
 *
 * Until the meeting starts, and not after — she asked for exactly this. A
 * reply afterwards is not an RSVP, it is a claim about attendance, and the
 * minutes are where that belongs. A cancelled meeting takes no replies either.
 */
export function canReply(meeting, now = new Date()) {
  if (!meeting || meeting.status === 'cancelled') return false;
  return startsAfter(meeting, now);
}

/** The moment a meeting begins, in Bangkok, as a Date. */
export function startsAt(meeting) {
  /**
   * A DATE column comes back as a Date object from the driver and as a string
   * from the page, and String(aDate) is "Sat Dec 05 2026 …" — which matches no
   * date pattern at all. Read straight, every meeting looked like it had no
   * start time, so every invitation was refused as too late to answer.
   */
  const raw = meeting.meets_on ?? meeting.meetsOn ?? '';
  const day = raw instanceof Date
    ? [raw.getFullYear(), String(raw.getMonth() + 1).padStart(2, '0'),
      String(raw.getDate()).padStart(2, '0')].join('-')
    : String(raw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const time = /^\d{1,2}:\d{2}$/.test(meeting.meets_at || meeting.meetsAt || '')
    ? (meeting.meets_at || meeting.meetsAt) : '00:00';
  const [h, m] = time.split(':').map(Number);
  // +07:00 is written out rather than relying on the server's own zone, which
  // in this deployment is not Bangkok.
  return new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`);
}

export function startsAfter(meeting, now = new Date()) {
  const at = startsAt(meeting);
  return at ? at.getTime() > now.getTime() : false;
}

/**
 * An email address, or nothing.
 *
 * Deliberately strict about the shape and deliberately NOT clever about it:
 * the only thing this has to catch is a typo, or a name typed where an address
 * belongs, because an address with a mistake in it means a guest who never
 * hears about the meeting and nobody noticing until the day.
 */
export function readEmail(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw.length > 254) return null;
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(raw)) return null;
  return raw;
}

/**
 * Guests pasted in however somebody happened to have them.
 *
 * People paste a line out of an email — commas, semicolons, newlines,
 * sometimes "Name <addr>" — so all of those are accepted, and anything that is
 * not an address is handed back rather than silently dropped. A guest list
 * that quietly lost one name is worse than one that complains.
 */
export function readGuests(value) {
  const parts = (Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/))
    .map((x) => {
      if (x && typeof x === 'object') return x.email;
      const m = String(x ?? '').match(/<([^>]+)>/);
      return m ? m[1] : x;
    });

  const emails = [];
  const rejected = [];
  const seen = new Set();
  for (const part of parts) {
    const raw = String(part ?? '').trim();
    if (!raw) continue;
    const email = readEmail(raw);
    if (!email) { rejected.push(raw.slice(0, 80)); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return { emails, rejected };
}

/**
 * The headcount, for the colour-coded list of who is coming.
 *
 * 'invited' is counted separately from 'declined' rather than folded into a
 * single "not coming": somebody who has not answered is a person to chase,
 * and somebody who declined is not.
 */
export function replyCounts(people = []) {
  const out = { accepted: 0, declined: 0, invited: 0 };
  for (const p of people) {
    const reply = isReply(p.reply) ? p.reply : 'invited';
    out[reply] += 1;
  }
  out.total = people.length;
  return out;
}
