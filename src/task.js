import { randomUUID } from 'node:crypto';

/**
 * The task "model".
 *
 * There is deliberately no database. The posted Slack message *is* the record:
 * when someone clicks a status button, Slack sends us the card's current blocks
 * and we rewrite them. That single decision is what lets this run on free
 * serverless hosting, where the process handling the click is usually not the
 * one that created the task and no memory survives between requests.
 *
 * What you give up: no "/todo list", no reporting, no reminders. See README,
 * "Adding a real database", for the upgrade path when you want those.
 */

export const TaskStatus = Object.freeze({
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
});

export const STATUS_LABELS = Object.freeze({
  [TaskStatus.TODO]: ':clipboard: To do',
  [TaskStatus.IN_PROGRESS]: ':construction: In progress',
  [TaskStatus.DONE]: ':white_check_mark: Done',
});

export const isValidStatus = (status) => Object.values(TaskStatus).includes(status);

export const newTaskId = () => `T-${randomUUID().slice(0, 8).toUpperCase()}`;

/**
 * The few facts a button has to carry so a click can rebuild the card
 * faithfully: everything else is already visible in the message.
 *
 * Slack caps a button's `value` at 2000 characters, so this stays tiny —
 * short keys, no title, no description.
 */
export function encodeTaskRef(task) {
  return JSON.stringify({ i: task.id, d: task.dueDate ?? null });
}

export function decodeTaskRef(value) {
  try {
    const parsed = JSON.parse(value);
    return { id: parsed.i ?? 'unknown', dueDate: parsed.d ?? null };
  } catch {
    // Older cards stored the bare id. Degrade rather than break the button.
    return { id: value || 'unknown', dueDate: null };
  }
}
