/**
 * End-to-end test against the REAL production code path:
 * the same VercelReceiver + createHandler the deployed app uses, fed
 * cryptographically-signed Slack requests, with the Slack Web API pointed at a
 * local mock that records every outgoing call.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { App } from '@slack/bolt';
import { VercelReceiver, createHandler } from '@vercel/slack-bolt';
import { registerListeners } from '../src/listeners/index.js';

const SIGNING_SECRET = 'test-signing-secret';
const calls = [];

// ---- mock Slack API --------------------------------------------------------
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url.replace('/api/', '').split('?')[0];
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { parsed = Object.fromEntries(new URLSearchParams(body)); }
    calls.push({ method, args: parsed });
    const replies = {
      'auth.test': { ok: true, user_id: 'UBOT', team_id: 'T1', bot_id: 'B1' },
      'views.open': { ok: true, view: { id: 'V1' } },
      'chat.postMessage': { ok: true, channel: parsed.channel ?? 'C1', ts: '1700000000.000100' },
      'chat.update': { ok: true, channel: parsed.channel ?? 'C1', ts: parsed.ts },
      'chat.getPermalink': { ok: true, permalink: 'https://team.slack.com/archives/C1/p170' },
      'chat.postEphemeral': { ok: true },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(replies[method] ?? { ok: true }));
  });
});
await new Promise((r) => mock.listen(0, r));
const mockUrl = `http://127.0.0.1:${mock.address().port}/api/`;

// ---- the app, wired exactly as api/slack/events.js wires it ----------------
const receiver = new VercelReceiver({ signingSecret: SIGNING_SECRET });
const app = new App({
  token: 'xoxb-test', signingSecret: SIGNING_SECRET, receiver,
  deferInitialization: true, clientOptions: { slackApiUrl: mockUrl },
});
registerListeners(app);
const handler = createHandler(app, receiver);

// ---- signed request helper -------------------------------------------------
function signedRequest(rawBody, contentType) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${ts}:${rawBody}`).digest('hex');
  return new Request('https://app.vercel.app/api/slack/events', {
    method: 'POST', body: rawBody,
    headers: { 'content-type': contentType, 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
  });
}
const form = (obj) => signedRequest(new URLSearchParams(obj).toString(), 'application/x-www-form-urlencoded');
const payload = (obj) => form({ payload: JSON.stringify(obj) });
const since = () => { const n = calls.length; return () => calls.slice(n); };

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- 0. signature verification --------------------------------------------
console.log('\n0. Security');
const bad = new Request('https://app.vercel.app/api/slack/events', {
  method: 'POST', body: 'command=%2Ftodo',
  headers: { 'content-type': 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': String(Math.floor(Date.now()/1000)), 'x-slack-signature': 'v0=deadbeef' },
});
const badRes = await handler(bad);
check('forged signature rejected', badRes.status >= 400, `HTTP ${badRes.status}`);

// ---- 1. /todo opens the modal ---------------------------------------------
console.log('\n1. Slash command  /todo ship the invoice fix');
let seen = since();
let res = await handler(form({
  command: '/todo', text: 'ship the invoice fix', trigger_id: 'TRIG1',
  channel_id: 'C1', user_id: 'UCREATOR', team_id: 'T1', response_url: 'https://hooks/1',
}));
await new Promise((r) => setTimeout(r, 400)); // let post-ack work land
let open = seen().find((c) => c.method === 'views.open');
const openedView = open ? JSON.parse(typeof open.args.view === 'string' ? open.args.view : JSON.stringify(open.args.view)) : null;
check('acked 200', res.status === 200, `HTTP ${res.status}`);
check('views.open called', Boolean(open));
check('title prefilled from command text',
  openedView?.blocks?.find((b) => b.block_id === 'title_block')?.element?.initial_value === 'ship the invoice fix');
check('callback_id correct', openedView?.callback_id === 'task_modal_submit');

// ---- 2. message shortcut prefills from the message ------------------------
console.log('\n2. Message shortcut  "Create task from message"');
seen = since();
res = await handler(payload({
  type: 'message_action', callback_id: 'create_task_from_message', trigger_id: 'TRIG2',
  user: { id: 'UCREATOR' }, channel: { id: 'C1' }, team: { id: 'T1' }, message_ts: '1699999999.000100',
  message: { type: 'message', user: 'UAUTHOR', ts: '1699999999.000100', text: 'The CSV export is broken\nsteps below' },
}));
await new Promise((r) => setTimeout(r, 400)); // let post-ack work land
const shortcutCalls = seen();
const view2 = (() => { const c = shortcutCalls.find((x) => x.method === 'views.open'); return c ? JSON.parse(typeof c.args.view === 'string' ? c.args.view : JSON.stringify(c.args.view)) : null; })();
const get = (id) => view2?.blocks?.find((b) => b.block_id === id)?.element?.initial_value ?? view2?.blocks?.find((b) => b.block_id === id)?.element?.initial_user;
check('acked 200', res.status === 200);
check('permalink fetched', shortcutCalls.some((c) => c.method === 'chat.getPermalink'));
check('title = first line of message', get('title_block') === 'The CSV export is broken', get('title_block'));
check('description = full message', get('description_block') === 'The CSV export is broken\nsteps below');
check('assignee = message author', get('assignee_block') === 'UAUTHOR', get('assignee_block'));
check('source link carried in private_metadata',
  JSON.parse(view2?.private_metadata ?? '{}').sourceLink?.includes('team.slack.com'));

// ---- 3. submission validation ---------------------------------------------
console.log('\n3. Modal submission — validation');
const submission = (overrides = {}) => ({
  type: 'view_submission', user: { id: 'UCREATOR' }, team: { id: 'T1' },
  view: {
    callback_id: 'task_modal_submit', private_metadata: JSON.stringify({ channelId: 'C1', threadTs: null, sourceLink: null }),
    state: { values: {
      title_block: { title_input: { value: overrides.title ?? 'Ship the invoice fix' } },
      description_block: { description_input: { value: 'context here' } },
      assignee_block: { assignee_select: { selected_user: overrides.assignee ?? 'UASSIGNEE' } },
      due_date_block: { due_date_picker: { selected_date: overrides.due ?? '2027-01-15' } },
      channel_block: { channel_select: { selected_conversation: 'C1' } },
    } },
  },
});
seen = since();
res = await handler(payload(submission({ due: '2020-01-01' })));
let bodyText = await res.clone().text();
check('past due date -> inline error, modal stays open',
  bodyText.includes('response_action') && bodyText.includes('errors') && bodyText.includes('due_date_block'));
check('nothing posted on invalid submission', !seen().some((c) => c.method === 'chat.postMessage'));

seen = since();
res = await handler(payload(submission({ title: '   ' })));
bodyText = await res.clone().text();
check('blank title -> inline error', bodyText.includes('title_block'));

// ---- 4. valid submission posts the card -----------------------------------
console.log('\n4. Modal submission — valid');
seen = since();
res = await handler(payload(submission()));
await new Promise((r) => setTimeout(r, 400)); // post-ack work
const postCalls = seen().filter((c) => c.method === 'chat.postMessage');
const posted = postCalls[0];
const postedBlocks = posted ? JSON.parse(typeof posted.args.blocks === 'string' ? posted.args.blocks : JSON.stringify(posted.args.blocks)) : [];
check('exactly one card posted (no duplicate DM copy)', postCalls.length === 1, `${postCalls.length} posts`);
check('posted to the chosen conversation', posted?.args.channel === 'C1');
check('assignee @-mentioned in fallback text (this is the notification)',
  String(posted?.args.text ?? '').includes('<@UASSIGNEE>'), posted?.args.text);
check('all five card blocks present',
  ['task_headline', 'task_fields', 'task_actions', 'task_meta'].every((id) => postedBlocks.some((b) => b.block_id === id)),
  postedBlocks.map((b) => b.block_id).join(','));
const btns = postedBlocks.find((b) => b.block_id === 'task_actions')?.elements ?? [];
check('starts with In Progress + Done buttons',
  btns.map((b) => b.action_id).join(',') === 'task_status_in_progress,task_status_done');

// ---- 5. the buttons, with no database anywhere ----------------------------
console.log('\n5. Status buttons — full cycle, stateless');
let currentBlocks = postedBlocks;
for (const [actionId, label, expectNext] of [
  ['task_status_in_progress', 'In Progress', 'task_status_done'],
  ['task_status_done', 'Done', 'task_status_todo'],
  ['task_status_todo', 'Reopen', 'task_status_in_progress,task_status_done'],
]) {
  const button = currentBlocks.find((b) => b.block_id === 'task_actions').elements.find((e) => e.action_id === actionId);
  seen = since();
  res = await handler(payload({
    type: 'block_actions', user: { id: 'UCLICKER' }, team: { id: 'T1' },
    channel: { id: 'C1' }, container: { channel_id: 'C1', message_ts: '1700000000.000100' },
    message: { ts: '1700000000.000100', blocks: currentBlocks },
    actions: [{ type: 'button', action_id: actionId, block_id: 'task_actions', value: button.value }],
  }));
  await new Promise((r) => setTimeout(r, 300));
  const upd = seen().find((c) => c.method === 'chat.update');
  if (!upd) { check(`${label} -> chat.update`, false); break; }
  currentBlocks = JSON.parse(typeof upd.args.blocks === 'string' ? upd.args.blocks : JSON.stringify(upd.args.blocks));
  const status = currentBlocks.find((b) => b.block_id === 'task_fields').fields.find((f) => f.text.startsWith('*Status*')).text.split('\n')[1];
  const nextBtns = currentBlocks.find((b) => b.block_id === 'task_actions').elements.map((e) => e.action_id).join(',');
  const headline = currentBlocks.find((b) => b.block_id === 'task_headline').text.text.split('\n')[0];
  check(`${label} -> updated in place`, upd.args.ts === '1700000000.000100' && nextBtns === expectNext,
    `${status} | next: ${nextBtns} | ${headline}`);
}
check('title survived three round trips with no stored copy',
  currentBlocks.find((b) => b.block_id === 'task_headline').text.text.includes('Ship the invoice fix'));
check('description survived too',
  currentBlocks.find((b) => b.block_id === 'task_headline').text.text.includes('context here'));

mock.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} — ${calls.length} Slack API calls exercised`);
process.exit(failures === 0 ? 0 : 1);
