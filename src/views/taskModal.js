import { ACTION_IDS, CALLBACK_IDS, INPUT_BLOCKS, LIMITS } from '../constants.js';

/**
 * The "Create a task" modal.
 *
 * One view serves both entry points: the /todo slash command and the message
 * shortcut. The shortcut just passes `prefill` and `sourceLink`.
 */

const isoDate = (date) => date.toISOString().slice(0, 10);

const tomorrow = () => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return isoDate(date);
};

/** Slack rejects an empty `initial_value`, so send undefined instead of "". */
const orUndefined = (value) => (value && String(value).trim() ? String(value) : undefined);

/**
 * @param {object} [options]
 * @param {string|null} [options.channelId]  Conversation to preselect as the post target
 * @param {string|null} [options.threadTs]   Thread to reply in, when built from a message
 * @param {string|null} [options.sourceLink] Permalink shown as context inside the modal
 * @param {object} [options.prefill]         { title, description, assigneeId, dueDate }
 */
export function buildTaskModal({
  channelId = null,
  threadTs = null,
  sourceLink = null,
  prefill = {},
} = {}) {
  /**
   * `private_metadata` is the only way to carry context from opening the modal
   * through to its submission — a `view_submission` payload has no channel or
   * message of its own. Slack caps it at 3000 characters: identifiers only.
   */
  const privateMetadata = JSON.stringify({ channelId, threadTs, sourceLink });

  const blocks = [];

  if (sourceLink) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Creating a task from <${sourceLink}|this message>.` }],
    });
  }

  blocks.push(
    {
      type: 'input',
      block_id: INPUT_BLOCKS.TITLE,
      label: { type: 'plain_text', text: 'Title' },
      element: {
        type: 'plain_text_input',
        action_id: ACTION_IDS.TITLE,
        max_length: LIMITS.TITLE_MAX,
        initial_value: orUndefined(prefill.title),
        placeholder: { type: 'plain_text', text: 'What needs to happen?' },
      },
    },
    {
      type: 'input',
      block_id: INPUT_BLOCKS.DESCRIPTION,
      optional: true,
      label: { type: 'plain_text', text: 'Description' },
      element: {
        type: 'plain_text_input',
        action_id: ACTION_IDS.DESCRIPTION,
        multiline: true,
        max_length: LIMITS.DESCRIPTION_MAX,
        initial_value: orUndefined(prefill.description),
        placeholder: { type: 'plain_text', text: 'Context, links, what "done" means…' },
      },
    },
    {
      type: 'input',
      block_id: INPUT_BLOCKS.ASSIGNEE,
      label: { type: 'plain_text', text: 'Assignee' },
      element: {
        type: 'users_select',
        action_id: ACTION_IDS.ASSIGNEE,
        initial_user: orUndefined(prefill.assigneeId),
        placeholder: { type: 'plain_text', text: 'Pick a teammate' },
      },
    },
    {
      type: 'input',
      block_id: INPUT_BLOCKS.DUE_DATE,
      label: { type: 'plain_text', text: 'Due date' },
      element: {
        type: 'datepicker',
        action_id: ACTION_IDS.DUE_DATE,
        initial_date: prefill.dueDate ?? tomorrow(),
        placeholder: { type: 'plain_text', text: 'Select a date' },
      },
    },
    {
      type: 'input',
      block_id: INPUT_BLOCKS.CHANNEL,
      label: { type: 'plain_text', text: 'Post the task card in' },
      element: {
        type: 'conversations_select',
        action_id: ACTION_IDS.CHANNEL,
        initial_conversation: orUndefined(channelId),
        default_to_current_conversation: true,
        filter: { include: ['public', 'private', 'im'], exclude_bot_users: true },
      },
    },
  );

  return {
    type: 'modal',
    callback_id: CALLBACK_IDS.TASK_MODAL,
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Create a task' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/** Pulls the submitted values out of `view.state.values`. */
export function readModalSubmission(view) {
  const values = view.state.values;

  return {
    title: values[INPUT_BLOCKS.TITLE]?.[ACTION_IDS.TITLE]?.value?.trim() ?? '',
    description: values[INPUT_BLOCKS.DESCRIPTION]?.[ACTION_IDS.DESCRIPTION]?.value?.trim() ?? '',
    assigneeId: values[INPUT_BLOCKS.ASSIGNEE]?.[ACTION_IDS.ASSIGNEE]?.selected_user ?? null,
    dueDate: values[INPUT_BLOCKS.DUE_DATE]?.[ACTION_IDS.DUE_DATE]?.selected_date ?? null,
    targetConversationId:
      values[INPUT_BLOCKS.CHANNEL]?.[ACTION_IDS.CHANNEL]?.selected_conversation ?? null,
    metadata: parseMetadata(view.private_metadata),
  };
}

function parseMetadata(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
