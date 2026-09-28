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
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                line(`${row.number ?? i + 1}.`, { flex: 0, color: FAINT, size: 'xs' }),
                line(row.title, { flex: 5, size: 'sm', weight: 'bold' }),
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
