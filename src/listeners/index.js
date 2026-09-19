import registerTodoCommand from './commands/todo.js';
import registerCreateTaskShortcut from './shortcuts/createTaskFromMessage.js';
import registerTaskSubmission from './views/taskSubmission.js';
import registerTaskStatusActions from './actions/taskStatus.js';

/**
 * Every Slack trigger, wired up in one place.
 *
 * Both entry points call this — `api/slack/events.js` on Vercel and `app.js`
 * when running locally — so the two deployments can never diverge in behaviour.
 */
export function registerListeners(app) {
  registerTodoCommand(app); // /todo                    -> command
  registerCreateTaskShortcut(app); // message shortcut  -> message_action
  registerTaskSubmission(app); // modal Create button   -> view_submission
  registerTaskStatusActions(app); // status buttons     -> block_actions
}
