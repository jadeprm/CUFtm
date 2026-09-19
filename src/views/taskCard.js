import { ACTION_IDS, CARD_BLOCKS } from '../constants.js';
import { STATUS_LABELS, TaskStatus, encodeTaskRef } from '../task.js';

/**
 * The interactive task card, and the patcher that keeps it current.
 *
 * `buildTaskCard` renders a brand-new task. `applyStatusToCard` takes the blocks
 * Slack sends us on a button click and rewrites just the parts that changed.
 * Patching rather than rebuilding is what makes this work without a database:
 * the title, description and assignee stay exactly as posted, because we never
 * have to remember them.
 */

/**
 * Slack mrkdwn treats &, < and > as control characters. Unescaped user text
 * means a title like "a < b" renders wrong or breaks the block outright.
 * https://docs.slack.dev/messaging/formatting-message-text#escaping
 */
const escapeText = (text = '') =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const truncate = (text = '', max = 2800) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Renders YYYY-MM-DD in UTC, so a due date never shifts a day between viewers. */
function formatDueDate(isoDate) {
  if (!isoDate) return 'No due date';

  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;

  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const isOverdue = (dueDate, status) =>
  Boolean(dueDate) && status !== TaskStatus.DONE && dueDate < todayUtc();

// --- the individual pieces, so build and patch always agree ----------------

const headlineText = (title, description, status) => {
  const wrapped =
    status === TaskStatus.DONE ? `~${escapeText(title)}~` : `*${escapeText(title)}*`;
  return description ? `${wrapped}\n${truncate(escapeText(description))}` : wrapped;
};

const statusField = (status) => ({ type: 'mrkdwn', text: `*Status*\n${STATUS_LABELS[status]}` });

const dueField = (dueDate, status) => ({
  type: 'mrkdwn',
  text: `*Due*\n${formatDueDate(dueDate)}${isOverdue(dueDate, status) ? '  :warning: overdue' : ''}`,
});

const metaText = (taskId, updatedBy) =>
  `\`${taskId}\` · last updated by <@${updatedBy}> <!date^${Math.floor(
    Date.now() / 1000,
  )}^{date_short_pretty} at {time}|just now>`;

function statusButtons(task) {
  const value = encodeTaskRef(task);
  const elements = [];

  if (task.status !== TaskStatus.IN_PROGRESS && task.status !== TaskStatus.DONE) {
    elements.push({
      type: 'button',
      action_id: ACTION_IDS.STATUS_IN_PROGRESS,
      text: { type: 'plain_text', text: 'In Progress', emoji: true },
      value,
    });
  }

  if (task.status !== TaskStatus.DONE) {
    elements.push({
      type: 'button',
      action_id: ACTION_IDS.STATUS_DONE,
      style: 'primary',
      text: { type: 'plain_text', text: 'Done', emoji: true },
      value,
    });
  } else {
    elements.push({
      type: 'button',
      action_id: ACTION_IDS.STATUS_TODO,
      text: { type: 'plain_text', text: 'Reopen', emoji: true },
      value,
    });
  }

  return elements;
}

// --- public API -------------------------------------------------------------

/**
 * Renders a new task card.
 *
 * @returns {{text: string, blocks: object[]}} Spread straight into
 *   `chat.postMessage`. `text` is the notification and screen-reader fallback.
 */
export function buildTaskCard(task) {
  const blocks = [
    {
      type: 'section',
      block_id: CARD_BLOCKS.HEADLINE,
      text: { type: 'mrkdwn', text: headlineText(task.title, task.description, task.status) },
    },
    {
      type: 'section',
      block_id: CARD_BLOCKS.FIELDS,
      fields: [
        { type: 'mrkdwn', text: `*Assignee*\n<@${task.assigneeId}>` },
        dueField(task.dueDate, task.status),
        statusField(task.status),
        { type: 'mrkdwn', text: `*Created by*\n<@${task.creatorId}>` },
      ],
    },
  ];

  if (task.sourceLink) {
    blocks.push({
      type: 'context',
      block_id: CARD_BLOCKS.SOURCE,
      elements: [{ type: 'mrkdwn', text: `:link: From <${task.sourceLink}|the original message>` }],
    });
  }

  blocks.push({
    type: 'actions',
    block_id: CARD_BLOCKS.ACTIONS,
    elements: statusButtons(task),
  });

  blocks.push({
    type: 'context',
    block_id: CARD_BLOCKS.META,
    elements: [{ type: 'mrkdwn', text: metaText(task.id, task.creatorId) }],
  });

  return {
    text: `New task for <@${task.assigneeId}>: ${task.title}`,
    blocks,
  };
}

/**
 * Rewrites an existing card for a new status.
 *
 * Blocks are looked up by `block_id`, never by index, so redesigning the card
 * cannot silently corrupt cards that are already sitting in channels.
 *
 * @param {object[]} blocks    `body.message.blocks` from the button click
 * @param {object} change      { status, updatedBy, taskId, dueDate }
 * @returns {{text: string, blocks: object[]}}
 */
export function applyStatusToCard(blocks, { status, updatedBy, taskId, dueDate }) {
  const next = structuredClone(blocks ?? []);
  const find = (blockId) => next.find((block) => block.block_id === blockId);

  // Strike the title through when done, un-strike it when reopened.
  const headline = find(CARD_BLOCKS.HEADLINE);
  if (headline?.text?.text) {
    headline.text.text = restyleHeadline(headline.text.text, status);
  }

  // Refresh the Status and Due fields, matching on their labels.
  const fields = find(CARD_BLOCKS.FIELDS);
  if (Array.isArray(fields?.fields)) {
    fields.fields = fields.fields.map((field) => {
      if (field?.text?.startsWith('*Status*')) return statusField(status);
      if (field?.text?.startsWith('*Due*')) return dueField(dueDate, status);
      return field;
    });
  }

  // Swap the buttons for the ones that make sense from the new status.
  const actions = find(CARD_BLOCKS.ACTIONS);
  if (actions) {
    actions.elements = statusButtons({ id: taskId, status, dueDate });
  }

  const meta = find(CARD_BLOCKS.META);
  if (meta) {
    meta.elements = [{ type: 'mrkdwn', text: metaText(taskId, updatedBy) }];
  }

  const title = plainHeadline(headline?.text?.text ?? '');

  return {
    text: status === TaskStatus.DONE ? `Completed: ${title}` : `Task updated: ${title}`,
    blocks: next,
  };
}

/** Swaps the first line's `*bold*` and `~strikethrough~` wrappers. */
function restyleHeadline(text, status) {
  const [firstLine, ...rest] = text.split('\n');
  const bare = firstLine.replace(/^[*~]/, '').replace(/[*~]$/, '');
  const wrapped = status === TaskStatus.DONE ? `~${bare}~` : `*${bare}*`;
  return [wrapped, ...rest].join('\n');
}

const plainHeadline = (text) =>
  text.split('\n')[0].replace(/^[*~]/, '').replace(/[*~]$/, '') || 'task';

export const __testing = { escapeText, formatDueDate, isOverdue, restyleHeadline };
