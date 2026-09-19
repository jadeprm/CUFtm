/**
 * Every identifier Slack hands back to us.
 *
 * Slack payloads are stringly-typed: a modal's `callback_id`, an input's
 * `block_id` and an element's `action_id` are the only handles you get when
 * something arrives. Keeping them in one file means the view builder and the
 * listener reading the response can never drift apart.
 */

export const CALLBACK_IDS = Object.freeze({
  TASK_MODAL: 'task_modal_submit',
  /** Must match the shortcut callback_id in manifest.json. */
  MESSAGE_SHORTCUT: 'create_task_from_message',
});

/** `block_id`s of the modal inputs. Also the keys used for inline errors. */
export const INPUT_BLOCKS = Object.freeze({
  TITLE: 'title_block',
  DESCRIPTION: 'description_block',
  ASSIGNEE: 'assignee_block',
  DUE_DATE: 'due_date_block',
  CHANNEL: 'channel_block',
});

/**
 * `block_id`s of the posted task card.
 *
 * These matter more than they look. On a button click Slack sends us the card's
 * current blocks, and we patch them in place rather than looking the task up in
 * a database. Naming the blocks means we can find them without relying on array
 * positions that shift the moment the card design changes.
 */
export const CARD_BLOCKS = Object.freeze({
  HEADLINE: 'task_headline',
  FIELDS: 'task_fields',
  SOURCE: 'task_source',
  ACTIONS: 'task_actions',
  META: 'task_meta',
});

export const ACTION_IDS = Object.freeze({
  TITLE: 'title_input',
  DESCRIPTION: 'description_input',
  ASSIGNEE: 'assignee_select',
  DUE_DATE: 'due_date_picker',
  CHANNEL: 'channel_select',

  /** Status buttons share a prefix so one listener handles all three. */
  STATUS_PREFIX: 'task_status_',
  STATUS_TODO: 'task_status_todo',
  STATUS_IN_PROGRESS: 'task_status_in_progress',
  STATUS_DONE: 'task_status_done',
});

export const LIMITS = Object.freeze({
  TITLE_MAX: 255,
  PREFILL_TITLE_MAX: 150,
  DESCRIPTION_MAX: 3000,
});
