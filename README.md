# Slack Task Manager

A task manager that lives inside Slack. Create tasks from a slash command or straight off a message, assign them, and move them through To do → In Progress → Done without leaving the channel.

Built with [Bolt for JavaScript](https://tools.slack.dev/bolt-js/). Deploys free to Vercel via [`@vercel/slack-bolt`](https://www.npmjs.com/package/@vercel/slack-bolt).

**To deploy it, follow [DEPLOY.md](./DEPLOY.md)** — written for a non-programmer, no command line needed.

---

## What it does

| Trigger | Slack payload | What happens |
| --- | --- | --- |
| `/todo`, or `/todo fix the login bug` | `command` | Opens the task form, title prefilled from whatever followed the command |
| More actions (⋯) → **Create task from message** | `message_action` | Opens the same form, prefilled with the message text, its author as assignee, and a link back to it |
| The form's **Create** button | `view_submission` | Validates, then posts an interactive card to the chosen conversation |
| **In Progress** / **Done** / **Reopen** | `block_actions` | Rewrites the card in place with the new status |

There is no web interface, and there shouldn't be — Slack is the interface.

---

## Project layout

```
api/slack/events.js    The Vercel entry point. Its path IS the Request URL
                       you give Slack: /api/slack/events
app.js                 Optional local entry point (Socket Mode)
manifest.json          Slack app definition — paste into api.slack.com
src/
  constants.js         Every callback_id / block_id / action_id
  task.js              Task shape, id generation, button-value encoding
  views/
    taskModal.js       The form, and reading its submission
    taskCard.js        The task card, and the patcher that updates it
  listeners/
    index.js           Wires all four triggers
    commands/todo.js
    shortcuts/createTaskFromMessage.js
    views/taskSubmission.js
    actions/taskStatus.js
```

Both entry points call the same `registerListeners`, so local and deployed behaviour can't drift apart.

---

## The one design decision worth understanding

**There is no database, on purpose. The Slack message is the record.**

The first version of this app kept tasks in a `Map` in memory. That works on a server that stays running, and breaks completely on free serverless hosting: the function that handles a button click is usually not the one that created the task, and nothing survives between requests. Every card would go dead within minutes.

So status changes don't look anything up. When someone clicks a button, Slack's payload includes the card's *current blocks*. `applyStatusToCard` patches those — swaps the status field, restyles the title, replaces the buttons — and `chat.update` writes them back. The task id and due date ride along in the button's `value` (35 characters, against Slack's 2000-character cap), because those two facts can't be read back off the rendered card.

What this buys: a card posted months ago still works after any number of redeploys, and there's nothing to pay for, back up, or run migrations against.

What it costs: nothing can query across tasks. No `/todo list`, no "what's overdue", no reminders, no reporting.

---

## Adding a real database

When you want the querying, one file changes shape and one gets added back:

1. Pick free hosted Postgres ([Neon](https://neon.tech), [Supabase](https://supabase.com)) or Redis ([Upstash](https://upstash.com)). All have free tiers that work from serverless functions.
2. Add a `src/store/taskStore.js` with async `createTask` / `getTask` / `updateTask` / `listTasks`.
3. Write to it in `listeners/views/taskSubmission.js` after posting the card, storing the returned `{channel, ts}` so you can find the message later.
4. In `listeners/actions/taskStatus.js`, read the task by id, update it, then rebuild the card with `buildTaskCard` instead of patching. Keep the patch path as a fallback for cards older than the database.

Then `/todo list`, a daily digest and an App Home view all become possible.

---

## Other things worth knowing

**Acknowledge within three seconds.** Every listener calls `ack()` before anything slow. Slack shows the user an error past that, and a `trigger_id` — needed to open a modal — expires in three seconds too.

**`private_metadata` carries context through the form.** A `view_submission` payload has no channel or message of its own. The channel id, thread timestamp and source permalink are serialised in when the modal opens and read back on submit. Capped at 3000 characters, so identifiers only.

**Inline validation keeps the form open.** `ack({ response_action: 'errors', errors })` shows errors under the named blocks; a plain `ack()` closes the form. You get one or the other, once.

**Blocks are found by `block_id`, never by index.** Redesigning the card can't corrupt cards already sitting in channels.

**User text is escaped.** Slack mrkdwn treats `&`, `<` and `>` as control characters, so a title like `a < b` would otherwise render wrong or break the block.

**One card, not two.** The assignee is `@`-mentioned in the card, which notifies them, rather than posting a second copy to their DMs that could drift out of sync with the first.

---

## Limits to be aware of

- **Non-commercial only** on Vercel's free plan — see [DEPLOY.md](./DEPLOY.md).
- **One workspace.** A single bot token means one workspace. Distributing the app to others requires implementing Bolt's OAuth `installationStore`.
- **Retries aren't deduplicated.** Slack retries deliveries it thinks failed. Without storage there's nothing to dedupe against, so a retried submission could post a task twice. Rare, and fixed by the database step above.
- **Due dates compare in UTC.** For a team spread across timezones, read the user's `tz` via `users.info` and validate against their local date.
- **Logs last one hour** on Vercel's free plan.

---

## Sources

- [Deploying Bolt to Vercel](https://docs.slack.dev/tools/bolt-js/deployments/vercel/) — Slack Developer Docs
- [`@vercel/slack-bolt`](https://www.npmjs.com/package/@vercel/slack-bolt) — the receiver this uses
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) — free limits and the non-commercial restriction
- [Escaping text](https://docs.slack.dev/messaging/formatting-message-text) — Slack mrkdwn rules
