import { ACTION_IDS } from '../../constants.js';
import { decodeTaskRef, isValidStatus } from '../../task.js';
import { applyStatusToCard } from '../../views/taskCard.js';

/**
 * Status buttons: In Progress / Done / Reopen.
 *
 * Slack trigger: a `block_actions` payload from a button inside an `actions`
 * block. One regex-constrained listener covers all three — the target status is
 * encoded in the action_id, the task id and due date travel in the button value.
 *
 * The payload also includes the message's current blocks, which is the whole
 * trick: we patch those and call chat.update. No lookup, no database, and a card
 * posted months ago still works after any number of redeploys.
 */
export default function registerTaskStatusActions(app) {
  const statusPattern = new RegExp(`^${ACTION_IDS.STATUS_PREFIX}(todo|in_progress|done)$`);

  app.action(statusPattern, async ({ ack, action, body, client, logger }) => {
    // Ack within 3 seconds or Slack shows the user an error under the button.
    await ack();

    const status = action.action_id.slice(ACTION_IDS.STATUS_PREFIX.length);
    if (!isValidStatus(status)) {
      logger.warn(`Ignoring unknown status transition: ${action.action_id}`);
      return;
    }

    const channel = body.channel?.id;
    const messageTs = body.message?.ts;
    const blocks = body.message?.blocks;

    if (!channel || !messageTs || !Array.isArray(blocks)) {
      logger.warn('Button click arrived without the message context needed to update the card');
      return;
    }

    const { id: taskId, dueDate } = decodeTaskRef(action.value);

    try {
      const updated = applyStatusToCard(blocks, {
        status,
        updatedBy: body.user.id,
        taskId,
        dueDate,
      });

      // chat.update rewrites the message in place — this is the live update.
      await client.chat.update({ channel, ts: messageTs, ...updated });

      logger.info(`Task ${taskId} -> ${status} by ${body.user.id}`);
    } catch (error) {
      logger.error(`Failed to update task ${taskId}`, error);

      await client.chat
        .postEphemeral({
          channel,
          user: body.user.id,
          text: ":warning: I couldn't update that task. Please try again.",
        })
        .catch(() => {});
    }
  });
}
