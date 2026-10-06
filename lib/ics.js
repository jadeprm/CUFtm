/**
 * Builds an iCalendar (.ics) feed of somebody's tasks.
 *
 * This is how tasks reach Google Calendar without a single credential: the app
 * publishes a feed at a private URL, the person subscribes to it once, and
 * Google fetches it on its own. No OAuth, no Google Cloud project, no client
 * secret to store or rotate.
 *
 * The trade-off, stated plainly because it will be noticed: Google refreshes a
 * subscribed calendar on its own schedule — often only every few hours, and
 * sometimes up to a day. It is right for "what is coming up"; it is not a live
 * mirror. The per-task "Add to Google Calendar" link is the instant path.
 */

const TZ_OFFSET_MINUTES = 7 * 60; // Asia/Bangkok, no daylight saving, ever

const pad = (n) => String(n).padStart(2, '0');

/** A date with no time becomes an all-day event. */
const dateOnly = (iso) => iso.replace(/-/g, '');

/**
 * Converts a Bangkok wall-clock time to the UTC stamp iCalendar wants.
 * Doing the arithmetic explicitly beats trusting the server's local timezone,
 * which on Vercel is UTC and on a laptop is anything at all.
 */
function toUtcStamp(isoDate, hhmm) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, hh, mm) - TZ_OFFSET_MINUTES * 60000);
  return (
    utc.getUTCFullYear() +
    pad(utc.getUTCMonth() + 1) +
    pad(utc.getUTCDate()) +
    'T' +
    pad(utc.getUTCHours()) +
    pad(utc.getUTCMinutes()) +
    '00Z'
  );
}

const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Escapes the characters iCalendar treats as structure. */
const esc = (text = '') =>
  String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/**
 * Folds a line to 75 octets, per RFC 5545.
 *
 * Counting characters is not enough: Thai is three bytes per character in
 * UTF-8, so a 70-character Thai line is 210 octets and strict parsers reject
 * it. This walks actual bytes and never splits one.
 */
function fold(line) {
  const encoder = new TextEncoder();
  const chars = [...line];
  const out = [];
  let current = '';
  let bytes = 0;

  for (const ch of chars) {
    const size = encoder.encode(ch).length;
    // 74 leaves room for the leading space continuation lines carry.
    if (bytes + size > 74) {
      out.push(current);
      current = ' ' + ch;
      bytes = 1 + size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

const addDay = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const STATUS_WORD = { todo: 'ยังไม่เริ่ม / To do', doing: 'กำลังทำ / Doing', done: 'เสร็จแล้ว / Done' };

/**
 * @param {object[]} tasks   tasks with dueDate set
 * @param {string} calName   what the calendar is called in Google
 * @param {(u:string)=>string} nameOf  username -> display name
 */
export function buildIcs(tasks, calName, nameOf = (u) => u, events = [], meetings = []) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fair Tasks//Chula Fair//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calName)}`,
    'X-WR-TIMEZONE:Asia/Bangkok',
    // Hints to Google how often to come back. Advisory only; Google decides.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  const now = stampNow();

  for (const task of tasks) {
    if (!task.dueDate) continue;

    const people = (task.assignees || []).map(nameOf).join(', ');
    const description = [
      task.description || '',
      people ? `ผู้รับผิดชอบ / Assigned: ${people}` : '',
      `สถานะ / Status: ${STATUS_WORD[task.status] || task.status}`,
    ]
      .filter(Boolean)
      .join('\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${task.id}@fair-tasks`);
    lines.push(`DTSTAMP:${now}`);

    if (task.dueTime) {
      lines.push(`DTSTART:${toUtcStamp(task.dueDate, task.dueTime)}`);
      // A deadline has no duration; an hour reads better in a day view than a dot.
      const end = new Date(
        Date.UTC(
          ...task.dueDate.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))),
          ...task.dueTime.split(':').map(Number),
        ) - TZ_OFFSET_MINUTES * 60000 + 60 * 60000,
      );
      lines.push(
        `DTEND:${end.getUTCFullYear()}${pad(end.getUTCMonth() + 1)}${pad(end.getUTCDate())}T${pad(
          end.getUTCHours(),
        )}${pad(end.getUTCMinutes())}00Z`,
      );
    } else {
      // All-day events are half-open: DTEND is the morning after.
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(task.dueDate)}`);
      lines.push(`DTEND;VALUE=DATE:${dateOnly(addDay(task.dueDate))}`);
    }

    lines.push(`SUMMARY:${esc(task.title)}`);
    if (description) lines.push(`DESCRIPTION:${esc(description)}`);
    lines.push(`STATUS:${task.status === 'done' ? 'CONFIRMED' : 'CONFIRMED'}`);
    if (task.status === 'done') lines.push('CATEGORIES:Done');
    lines.push('END:VEVENT');
  }

  /**
   * Events, which are not deadlines.
   *
   * A task becomes a one-hour block at its due time because a deadline is a
   * moment; an event keeps the length it was given, because a rehearsal that
   * runs 14:00–17:00 should look three hours long in the calendar.
   */
  for (const event of events) {
    if (!event.startsOn) continue;

    const description = [
      event.description || '',
      event.place ? `สถานที่ / Where: ${event.place}` : '',
    ].filter(Boolean).join('\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}@fair-tasks`);
    lines.push(`DTSTAMP:${now}`);

    if (!event.allDay && event.startsAt) {
      lines.push(`DTSTART:${toUtcStamp(event.startsOn, event.startsAt)}`);
      const endDate = event.endsOn || event.startsOn;
      const endTime = event.endsAt || addHour(event.startsAt);
      lines.push(`DTEND:${toUtcStamp(endDate, endTime)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(event.startsOn)}`);
      // Half-open again: a one-day event ends the following morning, and a
      // run of days ends the morning after its last day.
      lines.push(`DTEND;VALUE=DATE:${dateOnly(addDay(event.endsOn || event.startsOn))}`);
    }

    lines.push(`SUMMARY:${esc(event.title)}`);
    if (description) lines.push(`DESCRIPTION:${esc(description)}`);
    if (event.place) lines.push(`LOCATION:${esc(event.place)}`);
    lines.push('CATEGORIES:Event');
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }

  /**
   * Meetings.
   *
   * They were missing from the feed entirely, which meant somebody could
   * subscribe the committee's calendar into Google and still not see the
   * meeting they were expected at. A meeting carries its own extras — where
   * to join, and the agenda — because the point of having it in Google is to
   * open it from a phone two minutes beforehand.
   */
  for (const meeting of meetings) {
    if (!meeting.meetsOn || meeting.status === 'cancelled') continue;

    const going = (meeting.people || []).filter((p) => p.reply === 'accepted').length;
    const description = [
      meeting.note || '',
      meeting.joinUrl ? `เข้าประชุม / Join: ${meeting.joinUrl}` : '',
      meeting.agendaUrl ? `ระเบียบวาระ / Agenda: ${meeting.agendaUrl}` : '',
      (meeting.agenda || []).length
        ? 'ระเบียบวาระ / Agenda:\n' + meeting.agenda
          .map((a) => `  ${a.number} ${a.title}${a.minutes ? ` (${a.minutes} min)` : ''}`)
          .join('\n')
        : '',
      going ? `ตอบรับแล้ว / Accepted: ${going}` : '',
    ].filter(Boolean).join('\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${meeting.id}@fair-tasks`);
    lines.push(`DTSTAMP:${now}`);

    if (meeting.meetsAt) {
      lines.push(`DTSTART:${toUtcStamp(meeting.meetsOn, meeting.meetsAt)}`);
      const endTime = meeting.endsAt || endOfMeeting(meeting);
      lines.push(`DTEND:${toUtcStamp(meeting.meetsOn, endTime)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(meeting.meetsOn)}`);
      lines.push(`DTEND;VALUE=DATE:${dateOnly(addDay(meeting.meetsOn))}`);
    }

    lines.push(`SUMMARY:${esc(meeting.title)}`);
    if (description) lines.push(`DESCRIPTION:${esc(description)}`);
    // The joining link is the "location" of an online meeting, and Google
    // turns it into a button on the event.
    const where = meeting.place || meeting.joinUrl || '';
    if (where) lines.push(`LOCATION:${esc(where)}`);
    if (meeting.joinUrl) lines.push(`URL:${esc(meeting.joinUrl)}`);
    /**
     * Who was invited, named in the event itself.
     *
     * A subscribed feed is read-only — nobody is invited BY this, and Google
     * sends no mail because of it. These lines are so the organiser opening
     * the event can see the guest list without coming back to the committee's
     * own site to look it up.
     */
    for (const guest of meeting.guests || []) {
      if (!guest || !guest.email) continue;
      const cn = guest.name ? `;CN=${esc(guest.name)}` : '';
      lines.push(`ATTENDEE${cn};CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${guest.email}`);
    }

    lines.push('CATEGORIES:Meeting');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/**
 * When a meeting is expected to finish.
 *
 * The agenda knows: it is the start plus everything on it. Falling back to an
 * hour when there is no agenda yet beats blocking the whole afternoon.
 */
function endOfMeeting(meeting) {
  const mins = (meeting.length && meeting.length.minutes)
    || (meeting.agenda || []).filter((a) => !a.hasChildren)
      .reduce((n, a) => n + (Number(a.minutes) || 0), 0);
  if (!mins) return addHour(meeting.meetsAt);
  const [h, m] = String(meeting.meetsAt).split(':').map(Number);
  const total = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * The one-click "Add to Google Calendar" link for a meeting.
 *
 * For somebody who has not subscribed the feed — which is most people — this
 * is the whole of their Google Calendar integration, so it carries the joining
 * link and the agenda rather than just a title and a time.
 */
export function googleCalendarUrlForMeeting(meeting) {
  if (!meeting || !meeting.meetsOn) return null;

  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text', meeting.title);

  if (meeting.meetsAt) {
    const end = meeting.endsAt || endOfMeeting(meeting);
    params.set('dates',
      `${toUtcStamp(meeting.meetsOn, meeting.meetsAt)}/${toUtcStamp(meeting.meetsOn, end)}`);
  } else {
    params.set('dates', `${dateOnly(meeting.meetsOn)}/${dateOnly(addDay(meeting.meetsOn))}`);
  }

  const details = [
    meeting.note || '',
    meeting.joinUrl ? `เข้าประชุม / Join: ${meeting.joinUrl}` : '',
    (meeting.agenda || []).length
      ? 'ระเบียบวาระ / Agenda:\n' + meeting.agenda
        .map((a) => `  ${a.number} ${a.title}${a.minutes ? ` (${a.minutes} min)` : ''}`)
        .join('\n')
      : '',
  ].filter(Boolean).join('\n');
  if (details) params.set('details', details);
  if (meeting.place || meeting.joinUrl) {
    params.set('location', meeting.place || meeting.joinUrl);
  }

  /**
   * Guests from outside the committee.
   *
   * `add` is Google's own parameter for a guest list, comma separated. This
   * is what actually invites them: opening this link puts them on the event,
   * and Google emails the invitation when the organiser saves it. Nothing
   * this application does sends that email itself.
   */
  const guests = (meeting.guests || []).map((g) => g.email).filter(Boolean);
  if (guests.length) params.set('add', guests.join(','));

  params.set('ctz', 'Asia/Bangkok');

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** 14:30 → 15:30, wrapping at midnight rather than producing 24:30. */
function addHour(time) {
  const [h, m] = String(time).split(':').map(Number);
  return `${pad((h + 1) % 24)}:${pad(m)}`;
}

/**
 * The one-click "Add to Google Calendar" link for a single task.
 * Instant, needs no subscription, and works for anyone with a Google account.
 */
export function googleCalendarUrl(task, peopleNames = []) {
  if (!task.dueDate) return null;

  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text', task.title);

  if (task.dueTime) {
    const start = toUtcStamp(task.dueDate, task.dueTime);
    const [hh, mm] = task.dueTime.split(':').map(Number);
    const endHH = pad((hh + 1) % 24);
    const endDate = hh + 1 > 23 ? addDay(task.dueDate) : task.dueDate;
    params.set('dates', `${start}/${toUtcStamp(endDate, `${endHH}:${pad(mm)}`)}`);
  } else {
    params.set('dates', `${dateOnly(task.dueDate)}/${dateOnly(addDay(task.dueDate))}`);
  }

  const details = [
    task.description || '',
    peopleNames.length ? `ผู้รับผิดชอบ / Assigned: ${peopleNames.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (details) params.set('details', details);
  params.set('ctz', 'Asia/Bangkok');

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
