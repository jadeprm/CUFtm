import { CALLBACK_IDS, LIMITS } from '../../constants.js';
import { buildTaskModal } from '../../views/taskModal.js';

/**
 * Message shortcut: "Create task from message"
 *
 * Slack trigger: a `message_action` payload, fired from a message's
 * "More actions" menu. The payload carries the message text, its author and its
 * timestamp — everything needed to prefill the form.
 *
 * The callback_id must match the one in manifest.json.
 */

/** The first non-empty line of a message makes a serviceable task title. */
function deriveTitle(text = '') {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > LIMITS.PREFILL_TITLE_MAX
    ? `${trimmed.slice(0, LIMITS.PREFILL_TITLE_MAX - 1)}…`
    : trimmed;
}

export default function registerCreateTaskShortcut(app) {
  app.shortcut(CALLBACK_IDS.MESSAGE_SHORTCUT, async ({ shortcut, ack, client, logger }) => {
    await ack();

    const channelId = shortcut.channel?.id ?? null;
    const message = shortcut.message ?? {};
    const messageTs = shortcut.message_ts ?? message.ts;

    // A permalink is a nice-to-have, so a failure here must not block the modal.
    let sourceLink = null;
    if (channelId && messageTs) {
      try {
        const result = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
        sourceLink = result.permalink ?? null;
      } catch (error) {
        logger.debug('Could not resolve a permalink for the source message', error);
      }
    }

    try {
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: buildTaskModal({
          channelId,
          // Keep the task with its conversation: reply in the thread if there is one.
          threadTs: message.thread_ts ?? messageTs ?? null,
          sourceLink,
          prefill: {
            title: deriveTitle(message.text),
            description: message.text ?? '',
            // Default to whoever wrote the message; the picker stays editable.
            assigneeId: message.user ?? shortcut.user?.id,
          },
        }),
      });
    } catch (error) {
      logger.error('Failed to open the task modal from a message shortcut', error);
    }
  });
}

export const __testing = { deriveTitle };
