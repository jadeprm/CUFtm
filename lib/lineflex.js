/**
 * LINE messages people can actually read on a phone.
 *
 * Everything the bot said used to be one block of plain text. On a 5-inch
 * screen, a list of ten tasks written that way is a wall — nothing stands out,
 * the deadline and the title run together, and acting on item 3 means counting
 * lines. Flex messages let a message have the shape of what it describes: a
 * document gets a progress bar and its steps, a task list gets one row per
 * task with the urgent ones coloured.
 *
 * Kept as plain builders with no network and no database, so every layout here
 * can be checked in a test rather than by looking at a phone.
 *
 * Two rules the whole file follows. Colours carry meaning and are never the
 * only carrier — the same state is always in words too, because a third of
 * people cannot rely on a red/green distinction and a screenshot in a group
 * chat loses it anyway. And nothing is truncated to make a layout fit: LINE's
 * own limits are respected by sending fewer rows, not shorter ones.
 */

const INK = '#1F2328';
const FAINT = '#6B7280';
const LINE_GREY = '#E5E7EB';
const PAPER = '#FFFFFF';

/** State colours, in the same order the work moves. */
export const STATE_COLOUR = {
  waiting: '#9CA3AF',
  doing: '#E8A33D',
  approving: '#E8A33D',
  secretary: '#3B82F6',
  done: '#15803D',
  sent: '#15803D',
  rejected: '#DC2626',
  overdue: '#DC2626',
  today: '#B45309',
};

const PRIORITY_COLOUR = {
  highest: '#DC2626',
  high: '#B45309',
  medium: FAINT,
  low: FAINT,
};

const PRIORITY_TH = {
  highest: 'ด่วนที่สุด', high: 'ด่วน', medium: 'ปานกลาง', low: 'ไม่เร่ง',
};

const clip = (value, max) => String(value ?? '').slice(0, max);

/** LINE rejects an empty text node outright, so nothing here may render one. */
const line = (value, extra = {}) => ({
  type: 'text', text: clip(value, 300) || ' ', size: 'sm', color: INK, wrap: true, ...extra,
});

const separator = () => ({ type: 'separator', color: LINE_GREY, margin: 'md' });

/**
 * A three-part progress bar, like the one on the fault-reporting apps people
 * here already use: filled for what has happened, pale for what has not, with
 * the stage names underneath so the picture is never the only thing saying
 * where a document is.
 */
export function progressBar(stages, colour) {
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'xs',
        contents: stages.map((s) => ({
          type: 'box',
          layout: 'vertical',
          height: '6px',
          backgroundColor: s.done ? colour : LINE_GREY,
          cornerRadius: '3px',
          contents: [{ type: 'filler' }],
        })),
      },
      {
        type: 'box',
        layout: 'horizontal',
        margin: 'sm',
        contents: stages.map((s, i) => ({
          type: 'text',
          text: clip(s.label, 20),
          size: 'xxs',
          color: s.current ? colour : FAINT,
          weight: s.current ? 'bold' : 'regular',
          align: i === 0 ? 'start' : i === stages.length - 1 ? 'end' : 'center',
          wrap: false,
        })),
      },
    ],
  };
}

/**
 * One document, in full: where it is, who has it, what each person did and
 * when, and the buttons for whatever this reader is allowed to do next.
 */
export function documentBubble({
  title, stage, stageLabel, priority, recipient, uploader, steps = [],
  link, actions = [], number = null,
}) {
  const colour = STATE_COLOUR[stage] || STATE_COLOUR.waiting;

  const header = {
    type: 'box',
    layout: 'vertical',
    backgroundColor: colour,
    paddingAll: '12px',
    spacing: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          line(stageLabel, { color: PAPER, size: 'xs', weight: 'bold', flex: 1 }),
          ...(priority && priority !== 'medium'
            ? [line(PRIORITY_TH[priority] || priority,
                { color: PAPER, size: 'xs', align: 'end', flex: 0 })]
            : []),
        ],
      },
      line((number ? `${number}. ` : '') + title, { color: PAPER, weight: 'bold', size: 'md' }),
    ],
  };

  const body = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '12px',
    spacing: 'sm',
    contents: [
      progressBar([
        { label: 'ส่งเรื่อง', done: true },
        { label: 'ลงนาม', done: stage !== 'rejected', current: stage === 'approving' },
        { label: 'ส่งให้ผู้รับ', done: stage === 'sent', current: stage === 'secretary' },
      ], colour),
      separator(),
    ],
  };

  if (recipient) body.contents.push(field('ถึง', recipient));
  if (uploader) body.contents.push(field('ผู้ส่ง', uploader));

  /**
   * The steps, each with its own dot. Whoever the document is waiting on is
   * the one fact a person opens this message for, so their row is bold and
   * everything already done is greyed — the eye lands on the live one.
   */
  if (steps.length) {
    body.contents.push(separator());
    for (const step of steps) {
      const dot = step.state === 'approved' ? '✓'
        : step.state === 'rejected' ? '✕'
        : step.current ? '●' : '○';
      const stepColour = step.state === 'approved' ? STATE_COLOUR.done
        : step.state === 'rejected' ? STATE_COLOUR.rejected
        : step.current ? colour : FAINT;

      body.contents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          line(dot, { flex: 0, color: stepColour, size: 'sm' }),
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              line(step.label + (step.who ? ` · ${step.who}` : ''),
                { size: 'sm', weight: step.current ? 'bold' : 'regular', color: stepColour }),
              ...(step.when ? [line(step.when, { size: 'xxs', color: FAINT })] : []),
              ...(step.comment ? [line(`“${step.comment}”`, { size: 'xxs', color: FAINT })] : []),
            ],
          },
        ],
      });
    }
  }

  return bubble(header, body, buttons(actions, link));
}

const field = (label, value) => ({
  type: 'box',
  layout: 'baseline',
  spacing: 'sm',
  contents: [
    line(label, { flex: 2, color: FAINT, size: 'xs' }),
    line(value, { flex: 5, size: 'sm' }),
  ],
});

/**
 * A list — of tasks, of documents, of anything with a state and a date.
 *
 * One row each, with the marker and the date on the same line as the title, so
 * ten of them can be taken in at a glance instead of read.
 */
export function listBubble({
  title, subtitle, rows = [], link, linkLabel, actions = [], empty = 'ไม่มีรายการค่ะ 🎉',
}) {
  const header = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '12px',
    backgroundColor: '#F3F4F6',
    contents: [
      line(title, { weight: 'bold', size: 'md' }),
      ...(subtitle ? [line(subtitle, { size: 'xs', color: FAINT })] : []),
    ],
  };

  const body = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '12px',
    spacing: 'sm',
    contents: rows.length
      ? rows.map((row, i) => ({
          type: 'box',
          layout: 'vertical',
          spacing: 'none',
          margin: i ? 'md' : 'none',
          /**
           * A row is a button when it has somewhere to go: tapping a task in
           * the list opens its full card, instead of the person having to
           * type "ดู 3". `say` rows send a plain message — used inside a
           * conversation that is waiting for a number — and `data` rows a
           * postback, which keeps the chat history free of commands.
           */
          ...(row.data ? { action: { type: 'postback', label: 'ดู', data: clip(row.data, 300), displayText: row.say || undefined } }
            : row.say ? { action: { type: 'message', label: 'ดู', text: clip(row.say, 300) } } : {}),
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                line(`${row.number ?? i + 1}.`, { flex: 0, color: FAINT, size: 'xs' }),
                line(row.title, { flex: 5, size: 'sm', weight: 'bold' }),
                ...(row.data || row.say ? [line('›', { flex: 0, color: FAINT, size: 'sm' })] : []),
              ],
            },
            ...(row.meta
              ? [line(row.meta, {
                  size: 'xxs',
                  color: row.state ? (STATE_COLOUR[row.state] || FAINT) : FAINT,
                  margin: 'xs',
                })]
              : []),
          ],
        }))
      : [line(empty, { color: FAINT })],
  };

  // A card that is only an announcement — a notification, say — has its whole
  // message in the header, and a body saying "nothing here" would be a lie.
  const hasBody = rows.length || empty !== null;
  return bubble(header, hasBody ? body : null, buttons(actions, link, linkLabel));
}

// ---------------------------------------------------------------------------
// Cards for one task, one event, one meeting
// ---------------------------------------------------------------------------

/** The five statuses a task moves through, with their colours. */
export const TASK_STEPS = [
  { key: 'todo', label: 'ยังไม่เริ่ม', short: 'รับงาน', colour: '#6B7280' },
  { key: 'doing', label: 'กำลังทำ', short: 'กำลังทำ', colour: '#D97706' },
  { key: 'review', label: 'รอตรวจ', short: 'รอตรวจ', colour: '#B51E64' },
  { key: 'feedback', label: 'ตรวจแล้ว', short: 'ตรวจแล้ว', colour: '#0F766E' },
  { key: 'done', label: 'เสร็จแล้ว', short: 'เสร็จ', colour: '#15803D' },
];

/** The next step forward from each status, as the button that takes it. */
export const NEXT_STEP = {
  todo: { to: 'doing', label: '▶ เริ่มทำ' },
  doing: { to: 'review', label: 'ส่งตรวจ' },
  review: { to: 'feedback', label: 'ตรวจแล้ว' },
  feedback: { to: 'done', label: '✓ ปิดงาน' },
};

const box = (layout, contents, extra = {}) => ({ type: 'box', layout, contents, ...extra });
const CLEAR = '#FFFFFF00';
const filler = () => ({ type: 'filler' });

/**
 * A bar filled to a percentage.
 *
 * Real proportions, not three fixed segments: "2 of 7 sub-tasks done" draws
 * 29% of the bar. The number is always written beside it, so the bar is never
 * the only thing saying how far along something is.
 */
export function percentBar(percent, colour, height = '8px') {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  // Nothing done is an empty track, not a 0%-wide box LINE may refuse.
  const fill = pct
    ? [box('vertical', [filler()], {
        width: `${Math.max(pct, 4)}%`, height, backgroundColor: colour, cornerRadius: '4px',
      })]
    : [filler()];
  return box('vertical', fill, { height, backgroundColor: LINE_GREY, cornerRadius: '4px', margin: 'sm' });
}

/**
 * The status tracker, the way Traffy Fondue draws a report's progress: a dot
 * for every stage joined by a line, everything up to now filled in, the stage
 * it is at drawn as a ring, and the name of each stage underneath its dot.
 *
 * Built as five equal columns — each one a dot with half a line either side —
 * so every label sits exactly under its own dot whatever the width of the
 * phone. A row of dots and lines with labels in a separate row drifts apart.
 */
export function stepTracker(status) {
  const at = Math.max(0, TASK_STEPS.findIndex((s) => s.key === status));
  const colour = TASK_STEPS[at].colour;
  return box('horizontal', TASK_STEPS.map((step, i) => {
    const reached = i <= at;
    const current = i === at;
    // LINE takes colours as hex only — "transparent" gets the whole message
    // refused — so the outer half-lines are a fully transparent hex instead.
    const lineLeft = i === 0 ? CLEAR : (i <= at ? colour : LINE_GREY);
    const lineRight = i === TASK_STEPS.length - 1 ? CLEAR : (i < at ? colour : LINE_GREY);
    const dot = box('vertical', [
      line(reached && !current ? '✓' : ' ', {
        size: 'xxs', color: PAPER, align: 'center', weight: 'bold', wrap: false,
      }),
    ], {
      width: '20px', height: '20px', cornerRadius: '10px', justifyContent: 'center', alignItems: 'center',
      backgroundColor: current ? PAPER : (reached ? colour : LINE_GREY),
      ...(current ? { borderWidth: '4px', borderColor: colour } : {}),
      flex: 0,
    });
    return box('vertical', [
      box('horizontal', [
        box('vertical', [filler()], { height: '3px', backgroundColor: lineLeft, flex: 1 }),
        dot,
        box('vertical', [filler()], { height: '3px', backgroundColor: lineRight, flex: 1 }),
      ], { alignItems: 'center', height: '20px' }),
      line(step.short, {
        size: 'xxs', align: 'center', wrap: false, margin: 'sm',
        color: current ? colour : (reached ? INK : FAINT), weight: current ? 'bold' : 'regular',
      }),
    ], { flex: 1 });
  }), { margin: 'md' });
}

/** A small rounded label — status, priority, overdue. */
const pill = (text, colour, onDark = false) => box('vertical', [
  line(text, { size: 'xxs', weight: 'bold', color: onDark ? colour : PAPER, wrap: false, align: 'center' }),
], {
  backgroundColor: onDark ? PAPER : colour, cornerRadius: '10px',
  paddingStart: '8px', paddingEnd: '8px', paddingTop: '2px', paddingBottom: '2px', flex: 0,
});

const sectionTitle = (text) => line(text, { size: 'xs', color: FAINT, weight: 'bold', margin: 'lg' });

/**
 * One task, in full — what somebody gets when they ask about a task.
 *
 * Header: the status as a colour, the code, the title. Then the tracker, so
 * "where is it" is answered before a word is read; then how far along the
 * sub-tasks are as a bar with a count; then the facts; then a button for the
 * next step, offered only to somebody allowed to take it.
 *
 * `due` is the deadline already worded ("พรุ่งนี้ 18:00 น."), and `dueState`
 * one of overdue/today/null, worked out by the caller who knows what day it
 * is — a builder that read the clock could not be tested.
 */
const ROLE_TH = {
  named: 'คุณรับผิดชอบ',
  part: 'คุณรับผิดชอบงานย่อย',
  dept: 'ได้รับผ่านฝ่าย',
  watch: 'ติดตามอยู่ · ดูอย่างเดียว',
};

export function taskBubble({
  code, title, status, priority, due, dueState, overdueBy = 0,
  people = [], morePeople = 0, department, unit, description,
  parts = { done: 0, total: 0 }, files = 0, createdBy, updated,
  link, canMove = false, id, viewers = 0, role = null,
}) {
  const step = TASK_STEPS.find((s) => s.key === status) || TASK_STEPS[0];
  const at = TASK_STEPS.indexOf(step);
  const percent = Math.round((at / (TASK_STEPS.length - 1)) * 100);

  const header = box('vertical', [
    box('horizontal', [
      line(step.label.toUpperCase(), { color: PAPER, size: 'xs', weight: 'bold', flex: 1, wrap: false }),
      ...(code ? [line(code, { color: PAPER, size: 'xs', align: 'end', flex: 0, wrap: false })] : []),
    ]),
    line(title, { color: PAPER, weight: 'bold', size: 'lg', margin: 'sm' }),
    ...((priority && priority !== 'medium') || dueState === 'overdue' || ROLE_TH[role] ? [box('horizontal', [
      // What this task is to the person reading it: theirs, their
      // department's, or one they only follow.
      ...(ROLE_TH[role] ? [pill(ROLE_TH[role], INK, true)] : []),
      ...(priority && priority !== 'medium'
        ? [pill(PRIORITY_TH[priority] || priority, PRIORITY_COLOUR[priority] || INK, true)] : []),
      ...(dueState === 'overdue'
        ? [pill(`เลยกำหนด ${overdueBy} วัน`, STATE_COLOUR.overdue, true)] : []),
      filler(),
    ], { spacing: 'sm', margin: 'md' })] : []),
  ], { backgroundColor: step.colour, paddingAll: '14px' });

  const body = box('vertical', [
    box('horizontal', [
      line('ความคืบหน้า', { size: 'xs', color: FAINT, weight: 'bold', flex: 1 }),
      line(`${percent}%`, { size: 'sm', color: step.colour, weight: 'bold', align: 'end', flex: 0 }),
    ]),
    stepTracker(status),
  ], { paddingAll: '14px', spacing: 'sm' });

  // Sub-tasks: a real proportion, with the count beside it.
  if (parts.total) {
    const partsPct = (parts.done / parts.total) * 100;
    body.contents.push(separator());
    body.contents.push(box('horizontal', [
      line('งานย่อย', { size: 'xs', color: FAINT, weight: 'bold', flex: 1 }),
      line(`${parts.done}/${parts.total} เสร็จ`, { size: 'xs', color: INK, align: 'end', flex: 0, weight: 'bold' }),
    ], { margin: 'md' }));
    body.contents.push(percentBar(partsPct, STATE_COLOUR.done));
  }

  body.contents.push(separator());
  const facts = [];
  if (due) {
    facts.push(field('กำหนดส่ง', due));
    if (dueState) {
      facts[facts.length - 1].contents[1].color = STATE_COLOUR[dueState] || INK;
      facts[facts.length - 1].contents[1].weight = 'bold';
    }
  }
  if (people.length) facts.push(field('ผู้รับผิดชอบ', people.join(', ') + (morePeople ? ` และอีก ${morePeople} คน` : '')));
  if (department) facts.push(field('ฝ่าย', department + (unit ? ` · ${unit}` : '')));
  if (viewers) facts.push(field('ผู้ติดตาม', `${viewers} คน`));
  if (files) facts.push(field('ไฟล์งาน', `${files} ไฟล์`));
  if (createdBy) facts.push(field('มอบหมายโดย', createdBy));
  if (updated) facts.push(field('อัปเดตล่าสุด', updated));
  facts.forEach((f, i) => { if (i) f.margin = 'sm'; body.contents.push(f); });
  if (!facts.length) body.contents.push(line('ยังไม่มีรายละเอียด', { size: 'xs', color: FAINT }));
  else body.contents[body.contents.length - facts.length].margin = 'md';

  if (description) {
    body.contents.push(sectionTitle('รายละเอียด'));
    body.contents.push(line(clip(description, 280) + (description.length > 280 ? '…' : ''), { size: 'sm', margin: 'xs' }));
  }

  const next = NEXT_STEP[status];
  const actions = canMove && next && id ? [{
    label: next.label, data: `task:status:${id}:${next.to}`, style: 'primary',
    colour: (TASK_STEPS.find((s) => s.key === next.to) || step).colour,
    say: `${title} → ${(TASK_STEPS.find((s) => s.key === next.to) || {}).label}`,
  }] : [];
  if (canMove && id && status !== 'todo') {
    actions.push({ label: 'เปลี่ยนสถานะ…', data: `task:pick:${id}`, say: 'เปลี่ยนสถานะ' });
  }
  return bubble(header, body, buttons(actions, link, 'เปิดบนเว็บ'));
}

/**
 * The date as a calendar leaf: the day big, the month small above it — the
 * way a date reads on a wall calendar, which is the first thing anybody wants
 * from an event.
 */
const leaf = (day, month, colour) => box('vertical', [
  line(month, { size: 'xxs', color: PAPER, align: 'center', weight: 'bold', wrap: false }),
  line(day, { size: 'xl', color: PAPER, align: 'center', weight: 'bold', wrap: false }),
], {
  width: '56px', backgroundColor: colour, cornerRadius: '10px',
  paddingTop: '6px', paddingBottom: '6px', flex: 0, justifyContent: 'center',
});

/**
 * One event: the date as a leaf, when and where, who for, and what it is.
 *
 * Button labels stay within LINE's 20 characters — "เพิ่มลง Google Calendar"
 * is 23, and one label over the limit gets the entire card refused, not just
 * that button shortened.
 */
export function eventBubble({
  code, title, colour = '#B51E64', day, month, when, place, audience, description,
  untilLabel, link, calendarLink,
}) {
  const header = box('horizontal', [
    leaf(day, month, colour),
    box('vertical', [
      line('กิจกรรม' + (code ? ` · ${code}` : ''), { size: 'xxs', color: FAINT, weight: 'bold' }),
      line(title, { size: 'md', weight: 'bold', margin: 'xs' }),
      ...(untilLabel ? [line(untilLabel, { size: 'xs', color: colour, weight: 'bold', margin: 'xs' })] : []),
    ], { flex: 1, justifyContent: 'center' }),
  ], { paddingAll: '14px', spacing: 'lg', backgroundColor: '#FAFAFB' });

  const body = box('vertical', [
    field('เวลา', when),
    ...(place ? [Object.assign(field('สถานที่', place), { margin: 'sm' })] : []),
    ...(audience ? [Object.assign(field('สำหรับ', audience), { margin: 'sm' })] : []),
    ...(description ? [sectionTitle('รายละเอียด'),
      line(clip(description, 280) + (description.length > 280 ? '…' : ''), { size: 'sm', margin: 'xs' })] : []),
  ], { paddingAll: '14px', spacing: 'none', borderColor: colour });

  const footer = buttons([], link, 'เปิดบนเว็บ');
  if (calendarLink && footer) {
    footer.contents.unshift({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: 'ลง Google Calendar', uri: calendarLink },
    });
  }
  return bubble(header, body, footer);
}

const MEET = '#3F3AA6';

/**
 * One meeting: when and where, how to join, what is on the agenda, and who
 * has said they are coming — drawn as one bar split by answer, with the
 * numbers written under it — and, for somebody invited, the two buttons to
 * answer with.
 */
export function meetingBubble({
  code, title, day, month, when, place, joinUrl, untilLabel,
  agenda = [], agendaMore = 0, length,
  counts = { accepted: 0, declined: 0, invited: 0, total: 0 }, myReply, canReply = false,
  note, id, link, calendarLink,
}) {
  const header = box('horizontal', [
    leaf(day, month, MEET),
    box('vertical', [
      line('การประชุม' + (code ? ` · ${code}` : ''), { size: 'xxs', color: PAPER, weight: 'bold' }),
      line(title, { size: 'md', weight: 'bold', color: PAPER, margin: 'xs' }),
      ...(untilLabel ? [line(untilLabel, { size: 'xs', color: '#E0DEFF', margin: 'xs' })] : []),
    ], { flex: 1, justifyContent: 'center' }),
  ], { paddingAll: '14px', spacing: 'lg', backgroundColor: '#2E2A85' });

  const body = box('vertical', [
    field('เวลา', when + (length ? ` · ${length}` : '')),
    ...(place ? [Object.assign(field('สถานที่', place), { margin: 'sm' })] : []),
  ], { paddingAll: '14px', spacing: 'none' });

  if (counts.total) {
    const part = (n, colour) => (n ? [box('vertical', [filler()], {
      flex: n, height: '8px', backgroundColor: colour,
    })] : []);
    body.contents.push(sectionTitle('ผู้เข้าร่วม'));
    body.contents.push(box('horizontal', [
      ...part(counts.accepted, STATE_COLOUR.done),
      ...part(counts.invited, LINE_GREY),
      ...part(counts.declined, STATE_COLOUR.rejected),
    ], { cornerRadius: '4px', margin: 'sm', spacing: 'none' }));
    body.contents.push(line(
      `✓ มา ${counts.accepted}   ? ยังไม่ตอบ ${counts.invited}   ✕ ไม่มา ${counts.declined}`,
      { size: 'xxs', color: FAINT, margin: 'sm' }));
  }

  if (agenda.length) {
    body.contents.push(sectionTitle('ระเบียบวาระ'));
    for (const item of agenda) {
      body.contents.push(box('baseline', [
        line(item.number, { size: 'xs', color: item.depth ? FAINT : MEET, weight: 'bold', flex: 0 }),
        line(item.title, { size: item.depth ? 'xs' : 'sm', flex: 1, weight: item.depth ? 'regular' : 'bold' }),
        ...(item.minutes ? [line(`${item.minutes}′`, { size: 'xxs', color: FAINT, flex: 0 })] : []),
      ], { spacing: 'sm', margin: 'sm', ...(item.depth ? { paddingStart: '14px' } : {}) }));
    }
    if (agendaMore) body.contents.push(line(`และอีก ${agendaMore} เรื่อง`, { size: 'xxs', color: FAINT, margin: 'sm' }));
  }

  if (note) {
    body.contents.push(sectionTitle('รายละเอียด'));
    body.contents.push(line(clip(note, 240) + (note.length > 240 ? '…' : ''), { size: 'sm', margin: 'xs' }));
  }

  if (myReply) {
    const said = myReply === 'accepted' ? ['คุณตอบรับแล้ว', STATE_COLOUR.done]
      : myReply === 'declined' ? ['คุณตอบว่าไม่เข้าร่วม', STATE_COLOUR.rejected]
      : ['คุณยังไม่ได้ตอบ', STATE_COLOUR.today];
    body.contents.push(separator());
    body.contents.push(line(said[0], { size: 'sm', weight: 'bold', color: said[1], margin: 'md' }));
  }

  const actions = [];
  if (canReply && id && myReply !== 'accepted') {
    actions.push({ label: '✓ เข้าร่วม', data: `meeting:reply:${id}:accepted`, style: 'primary', colour: STATE_COLOUR.done, say: 'เข้าร่วม' });
  }
  if (canReply && id && myReply !== 'declined') {
    actions.push({ label: 'ไม่เข้าร่วม', data: `meeting:reply:${id}:declined`, say: 'ไม่เข้าร่วม' });
  }
  const footer = buttons(actions, link, 'เปิดบนเว็บ') || box('vertical', [], { paddingAll: '8px', spacing: 'xs' });
  if (joinUrl) {
    footer.contents.unshift({ type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: 'เข้าประชุมออนไลน์', uri: joinUrl } });
  }
  if (calendarLink) {
    footer.contents.push({ type: 'button', style: 'link', height: 'sm',
      action: { type: 'uri', label: 'ลง Google Calendar', uri: calendarLink } });
  }
  return bubble(header, body, footer.contents.length ? footer : null);
}

function bubble(header, body, footer) {
  const out = { type: 'bubble', size: 'mega', header };
  if (body) out.body = body;
  if (footer) out.footer = footer;
  return out;
}

/**
 * The buttons.
 *
 * A postback rather than a message action, so tapping อนุมัติ does not fill
 * the person's own chat history with commands they never typed. The web link
 * is always last and always present when there is one: everything the chat
 * cannot do — attachments, sub-tasks, reading the PDF — lives there.
 */
function buttons(actions, link, linkLabel = 'เปิดบนเว็บ') {
  const items = actions.slice(0, 3).map((a) => ({
    type: 'button',
    style: a.style || 'secondary',
    height: 'sm',
    color: a.colour,
    action: { type: 'postback', label: clip(a.label, 20), data: clip(a.data, 300), displayText: a.say },
  }));

  if (link) {
    items.push({
      type: 'button',
      style: 'link',
      height: 'sm',
      action: { type: 'uri', label: clip(linkLabel, 20), uri: link },
    });
  }
  if (!items.length) return null;

  return { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '8px', contents: items };
}

/** Wraps one bubble, or several, as a message LINE will accept. */
export function flex(altText, contents, labels) {
  const list = Array.isArray(contents) ? contents.slice(0, 10) : [contents];
  const message = {
    type: 'flex',
    altText: clip(altText, 400) || 'งานจุฬาฯแฟร์',
    contents: list.length === 1 ? list[0] : { type: 'carousel', contents: list },
  };
  if (labels && labels.length) {
    message.quickReply = {
      items: labels.slice(0, 13).map((label) => ({
        type: 'action',
        action: { type: 'message', label: clip(label, 20), text: label },
      })),
    };
  }
  return message;
}

export { PRIORITY_TH, PRIORITY_COLOUR };
