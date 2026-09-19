import { LIMITS } from '../../constants.js';
import { buildTaskModal } from '../../views/taskModal.js';

/**
 * Slash command: /todo [optional title]
 *
 * Slack trigger: a `command` payload, POSTed when someone types /todo.
 * Two clocks are running — Slack wants a response within 3 seconds, and the
 * `trigger_id` needed to open a modal expires in 3 seconds. So: ack() first,
 * then open the modal immediately.
 */
export default function registerTodoCommand(app) {
  app.command('/todo', async ({ command, ack, client, logger }) => {
    await ack();

    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildTaskModal({
          channelId: command.channel_id,
          prefill: {
            // `/todo ship the invoice fix` prefills the title.
            title: command.text?.trim().slice(0, LIMITS.PREFILL_TITLE_MAX),
            assigneeId: command.user_id,
          },
        }),
      });
    } catch (error) {
      logger.error('Failed to open the task modal', error);

      // The modal never appeared — say something rather than nothing.
      await client.chat
        .postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: ":warning: I couldn't open the task form. Please try again in a moment.",
        })
        .catch(() => {});
    }
  });
}
