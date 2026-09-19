import { CALLBACK_IDS, INPUT_BLOCKS } from '../../constants.js';
import { TaskStatus, newTaskId } from '../../task.js';
import { buildTaskCard } from '../../views/taskCard.js';
import { readModalSubmission } from '../../views/taskModal.js';

/**
 * Modal submission.
 *
 * Slack trigger: a `view_submission` payload, sent when the user clicks Create.
 * The ack() here carries more weight than most:
 *   - `await ack()` closes the modal
 *   - `await ack({ response_action: 'errors', errors })` keeps it open and shows
 *     inline errors under the named block_ids
 * You get exactly one ack, within 3 seconds — so validate before doing any work.
 */

const todayUtc = () => new Date().toISOString().slice(0, 10);

export default function registerTaskSubmission(app) {
  app.view(CALLBACK_IDS.TASK_MODAL, async ({ ack, view, body, client, logger }) => {
    const { title, description, assigneeId, dueDate, targetConversationId, metadata } =
      readModalSubmission(view);

    // ---- Validation, before the modal closes ------------------------------
    const errors = {};
    if (!title) errors[INPUT_BLOCKS.TITLE] = 'Give the task a title.';
    if (!assigneeId) errors[INPUT_BLOCKS.ASSIGNEE] = 'Pick someone to own this task.';
    if (dueDate && dueDate < todayUtc()) {
      errors[INPUT_BLOCKS.DUE_DATE] = 'The due date cannot be in the past.';
    }
    if (!targetConversationId) {
      errors[INPUT_BLOCKS.CHANNEL] = 'Choose where the task card should go.';
    }

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    await ack(); // Valid — close the modal, then do the slower Web API work.

    const creatorId = body.user.id;

    const task = {
      id: newTaskId(),
      title,
      description,
      assigneeId,
      creatorId,
      dueDate,
      sourceLink: metadata.sourceLink ?? null,
      status: TaskStatus.TODO,
    };

    try {
      /**
       * One card, one source of truth. The assignee is @-mentioned in the card
       * and in the fallback text, so Slack notifies them without us posting a
       * second copy that could drift out of sync.
       */
      await client.chat.postMessage({
        channel: targetConversationId,
        thread_ts:
          metadata.channelId === targetConversationId ? metadata.threadTs ?? undefined : undefined,
        ...buildTaskCard(task),
      });

      logger.info(`Created task ${task.id} for ${assigneeId} in ${targetConversationId}`);
    } catch (error) {
      logger.error(`Failed to post task ${task.id}`, error);

      // The modal has already closed, so a DM is the only way back to the user.
      const slackError = error?.data?.error;
      const reason =
        slackError === 'not_in_channel' || slackError === 'channel_not_found'
          ? `I'm not in <#${targetConversationId}>. Invite me there with \`/invite @Task Manager\` and try again.`
          : "Something went wrong posting that task. Nothing was saved — please try again.";

      await client.chat
        .postMessage({ channel: creatorId, text: `:warning: ${reason}` })
        .catch(() => {});
    }
  });
}
