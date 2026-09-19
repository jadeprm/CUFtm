import { App } from '@slack/bolt';
import { VercelReceiver, createHandler } from '@vercel/slack-bolt';

import { registerListeners } from '../../src/listeners/index.js';

/**
 * Vercel entry point — this is the file Vercel turns into a live URL.
 *
 * Its path decides the URL: `api/slack/events.js` is served at
 * `https://your-project.vercel.app/api/slack/events`, which is the Request URL
 * you paste into your Slack app's settings. Renaming this file changes that URL.
 *
 * `VercelReceiver` is Slack and Vercel's official adapter. It reads the raw
 * request body, verifies Slack's signature, and keeps post-ack work alive after
 * the response is sent — the three things that otherwise break a Bolt app on
 * serverless hosting.
 */

const receiver = new VercelReceiver();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,

  // Serverless: initialise per request rather than at module load.
  deferInitialization: true,
});

registerListeners(app);

app.error(async (error) => {
  console.error('[bolt] unhandled listener error:', error);
});

export default createHandler(app, receiver);
