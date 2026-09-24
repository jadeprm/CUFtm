import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * Talking to a LINE Official Account.
 *
 * Two kinds of message exist and the difference is money, not technology.
 * A REPLY answers something the person just sent, uses a one-shot token that
 * came with their message, and is free and unlimited. A PUSH is started by us
 * and is charged per recipient — one reminder to twenty-five people is
 * twenty-five messages against the monthly quota, which on the free Thai plan
 * is about three hundred.
 *
 * So everything the bot says in conversation is a reply, and the only pushes
 * are the once-a-day digests. That is not an optimisation, it is the whole
 * reason the feature is affordable.
 */

const API = 'https://api.line.me/v2/bot';

export const lineConfigured = () =>
  Boolean(process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN);

/**
 * Proves the request really came from LINE.
 *
 * Without this the webhook URL is a public endpoint that will do anything the
 * body tells it to — create tasks, delete them, read the committee's work —
 * for anyone who finds the address. The signature is an HMAC of the raw body
 * with the channel secret, which only LINE and this server know.
 *
 * Both the bytes as they arrived and a re-serialised form are accepted,
 * because some runtimes parse the body before a handler can see it and the
 * original bytes are then unrecoverable. Neither form can be forged without
 * the secret, so accepting both costs nothing in safety.
 */
export function verifySignature(rawBody, signature, secret = process.env.LINE_CHANNEL_SECRET) {
  if (!secret || !signature) return false;

  const candidates = [rawBody];
  try {
    const again = JSON.stringify(JSON.parse(rawBody));
    if (again !== rawBody) candidates.push(again);
  } catch { /* not JSON; the raw form is all there is */ }

  let sent;
  try { sent = Buffer.from(String(signature), 'base64'); } catch { return false; }

  for (const candidate of candidates) {
    const mine = createHmac('SHA256', secret).update(candidate, 'utf8').digest();
    if (mine.length === sent.length && timingSafeEqual(mine, sent)) return true;
  }
  return false;
}

async function callLine(path, payload) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');

  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    /**
     * LINE explains refusals in the body — an expired reply token, a quota
     * that has run out, a user who blocked the account. Throwing away that
     * text and reporting a bare status is how a delivery problem becomes
     * unfixable, so it is carried back to whoever is looking.
     */
    const detail = await response.text().catch(() => '');
    const error = new Error(`LINE refused ${path}: HTTP ${response.status}` +
      (detail ? ` — ${detail.slice(0, 300)}` : ''));
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

/** Free. Answers a message the person just sent, using the token that came with it. */
export const reply = (replyToken, messages) =>
  callLine('/message/reply', { replyToken, messages: asMessages(messages) });

/** Charged, one per recipient. Only the daily digest uses this. */
export const push = (to, messages) =>
  callLine('/message/push', { to, messages: asMessages(messages) });

/**
 * LINE takes at most five messages per call and 5,000 characters each. A long
 * list of tasks is split rather than truncated, because a reminder that stops
 * halfway is worse than two reminders.
 */
function asMessages(input) {
  const list = Array.isArray(input) ? input : [input];
  return list
    .map((m) => (typeof m === 'string' ? { type: 'text', text: m } : m))
    .map((m) => (m.type === 'text' ? { ...m, text: String(m.text).slice(0, 4900) } : m))
    .slice(0, 5);
}

/**
 * The buttons under the reply box.
 *
 * Typing Thai on a phone while walking between buildings is the actual usage,
 * so the commands people reach for most are one tap instead.
 */
export const quickReplies = (labels) => ({
  items: labels.slice(0, 13).map((label) => ({
    type: 'action',
    action: { type: 'message', label: label.slice(0, 20), text: label },
  })),
});

export const text = (body, labels) => {
  const message = { type: 'text', text: body };
  if (labels && labels.length) message.quickReply = quickReplies(labels);
  return message;
};

/**
 * A linking code.
 *
 * Deliberately short and short-lived rather than a password: it is read off a
 * screen and typed into a chat, and it only ever grants the account that
 * generated it. Ambiguous characters are left out so nobody types O for 0.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newLinkCode() {
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/**
 * Installing the rich menu — the three buttons under the keyboard.
 *
 * Done from here rather than by hand in the Official Account Manager because
 * the tappable regions have to line up exactly with the picture, and getting
 * that right by dragging boxes over an image is fiddly and easy to get subtly
 * wrong. The coordinates below are computed from the same numbers that drew
 * the image, so they cannot drift apart.
 *
 * Each region simply sends its own label as if the person had typed it, so the
 * menu and the typed commands are the same single path through the code.
 */
const RICH_MENU_W = 2500;
const RICH_MENU_H = 843;
const RICH_BUTTONS = ['เพิ่มงาน', 'ตรวจสอบงาน', 'จัดการงาน'];

export async function installRichMenu(pngBuffer) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');

  const cell = Math.floor(RICH_MENU_W / RICH_BUTTONS.length);
  const areas = RICH_BUTTONS.map((label, i) => ({
    bounds: {
      x: i * cell,
      y: 0,
      // The last button takes the remainder, so rounding never leaves a dead
      // strip of pixels down the right-hand edge.
      width: i === RICH_BUTTONS.length - 1 ? RICH_MENU_W - i * cell : cell,
      height: RICH_MENU_H,
    },
    action: { type: 'message', label: label.slice(0, 20), text: label },
  }));

  const created = await callLine('/richmenu', {
    size: { width: RICH_MENU_W, height: RICH_MENU_H },
    selected: true,
    name: 'Fair tasks menu',
    chatBarText: 'เมนูงาน',
    areas,
  });
  const { richMenuId } = await created.json();

  // The picture goes to a different host from everything else — api-data,
  // not api — and is posted as raw bytes rather than JSON.
  const upload = await fetch(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    {
      method: 'POST',
      headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` },
      body: pngBuffer,
    },
  );
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    throw new Error(`LINE refused the menu image: HTTP ${upload.status} — ${detail.slice(0, 200)}`);
  }

  // Make it the default, so everyone sees it without doing anything.
  await callLine(`/user/all/richmenu/${richMenuId}`, {});
  return richMenuId;
}

/** Takes the menu away again, and deletes it. */
export async function removeRichMenu(richMenuId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  });
  if (richMenuId) {
    await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    });
  }
}
