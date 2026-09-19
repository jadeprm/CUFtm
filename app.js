import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';

import { registerListeners } from './src/listeners/index.js';

/**
 * Local development entry point (optional).
 *
 * This runs the same listeners over Socket Mode: an outbound WebSocket to Slack,
 * so your laptop needs no public URL. Vercel does not use this file — it uses
 * `api/slack/events.js`. Keeping both means you can test a change locally before
 * pushing it live.
 *
 * Requires SLACK_APP_TOKEN and Socket Mode switched on in your app settings.
 * See README, "Running it on your own computer".
 */

const missing = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'].filter(
  (key) => !process.env[key],
);

if (missing.length > 0) {
  console.error(
    `Missing environment variable(s): ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill in the values from https://api.slack.com/apps',
  );
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel[(process.env.LOG_LEVEL ?? 'info').toUpperCase()] ?? LogLevel.INFO,
});

registerListeners(app);

app.error(async (error) => {
  console.error('[bolt] unhandled listener error:', error);
});

// Close the socket cleanly so Slack does not hold a dead connection.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} received, shutting down…`);
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  });
}

app
  .start()
  .then(() => console.log('⚡ Task Manager running locally in Socket Mode'))
  .catch((error) => {
    console.error('Failed to start:', error);
    process.exit(1);
  });
