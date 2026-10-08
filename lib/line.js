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
 * Where the website lives, for the links the bot hands out.
 *
 * A chat is the wrong place for sub-tasks, attachments and long descriptions,
 * so rather than building clumsy half-versions of those, the bot points at the
 * page that already does them well. Vercel supplies its own domain, so this
 * needs no configuration in the normal case; SITE_URL overrides it for a
 * custom domain.
 *
 * Returns null when no address is known, and every caller then leaves the link
 * out entirely — "go to the website" with no address is worse than silence.
 */
export function siteUrl() {
  const explicit = process.env.SITE_URL || process.env.PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : null;
}

/** A link straight to one task's pop-up. */
export const taskLink = (id) => {
  const base = siteUrl();
  return base ? `${base}/#/t/${encodeURIComponent(id)}` : null;
};

export const pageLink = (page = 'work') => {
  const base = siteUrl();
  return base ? `${base}/#/${page}` : null;
};

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

/**
 * Free. Answers a message the person just sent, using the token that came with it.
 *
 * A reply LINE refuses is a reply nobody sees — the chat simply goes quiet,
 * which is what "ประชุม" and "M0005" did: one card carried a Google Calendar
 * link longer than LINE allows, so LINE turned down the whole answer and the
 * person was left staring at their own message. So every message is cleaned
 * first (see sanitizeMessage), and if LINE still says no, the same answer goes
 * again as plain text. A refused reply does not use up the token.
 */
export async function reply(replyToken, messages) {
  const clean = asMessages(messages).map(sanitizeMessage);
  try {
    return await callLine('/message/reply', { replyToken, messages: clean });
  } catch (error) {
    if (error.statusCode !== 400) throw error;
    console.error('[line] reply refused, sending as text:', String(error.message).slice(0, 300));
    return callLine('/message/reply', { replyToken, messages: asPlainText(clean) });
  }
}

/** Charged, one per recipient. Only the daily digest uses this. */
export async function push(to, messages) {
  const clean = asMessages(messages).map(sanitizeMessage);
  try {
    return await callLine('/message/push', { to, messages: clean });
  } catch (error) {
    if (error.statusCode !== 400) throw error;
    return callLine('/message/push', { to, messages: asPlainText(clean) });
  }
}

// ---------------------------------------------------------------------------
// Making sure LINE will take it
// ---------------------------------------------------------------------------

const URI_OK = /^(https?:\/\/|line:\/\/|tel:)/i;
const MAX_URI = 1000;
const clipTo = (value, n) => {
  const chars = Array.from(String(value ?? ''));
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
};

/** A link LINE will accept, or null. Over-long links lose their extras first. */
export function lineSafeUri(uri) {
  const raw = String(uri || '').trim();
  if (!raw || !URI_OK.test(raw)) return null;
  if (raw.length <= MAX_URI) return raw;
  // Google Calendar links carry the whole agenda; the event itself is what matters.
  try {
    const url = new URL(raw);
    for (const extra of ['details', 'add', 'location']) {
      url.searchParams.delete(extra);
      if (url.toString().length <= MAX_URI) return url.toString();
    }
  } catch { /* not a URL we can trim */ }
  return null;
}

function actionOk(action) {
  if (!action || typeof action !== 'object') return false;
  if (action.label !== undefined) action.label = clipTo(action.label, 20) || 'เปิด';
  if (action.type === 'uri') {
    const uri = lineSafeUri(action.uri);
    if (!uri) return false;
    action.uri = uri;
  }
  if (action.type === 'postback') {
    if (!action.data || String(action.data).length > 300) return false;
    if (action.displayText !== undefined) {
      action.displayText = clipTo(action.displayText, 300);
      if (!action.displayText) delete action.displayText;
    }
  }
  if (action.type === 'message') {
    action.text = clipTo(action.text, 300);
    if (!action.text) return false;
  }
  return true;
}

/**
 * Walks a Flex message and mends what LINE would refuse: a button whose link
 * is too long or not a link loses the button; blank text becomes a dash; an
 * empty footer is dropped. Everything else is left as built.
 */
function mend(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map(mend).filter((child) => child !== null);
  }
  if (node.type === 'button' && !actionOk(node.action)) return null;
  if (node.action && node.type !== 'button' && !actionOk(node.action)) delete node.action;
  if (node.type === 'text' && !String(node.text ?? '').trim() && !node.contents) node.text = '-';
  if (node.type === 'text' && node.text !== undefined) node.text = String(node.text).slice(0, 2000);
  for (const key of Object.keys(node)) {
    if (node[key] && typeof node[key] === 'object') node[key] = mend(node[key]);
  }
  if (node.type === 'bubble') {
    for (const part of ['header', 'body', 'footer']) {
      if (node[part] && Array.isArray(node[part].contents) && !node[part].contents.length) delete node[part];
    }
  }
  if (node.type === 'carousel' && Array.isArray(node.contents)) node.contents = node.contents.slice(0, 12);
  return node;
}

export function sanitizeMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const m = JSON.parse(JSON.stringify(message));
  if (m.type === 'text') m.text = String(m.text || '').trim() ? String(m.text).slice(0, 4900) : '-';
  if (m.type === 'flex') {
    m.altText = clipTo(m.altText || 'ข้อความจากบอท', 400);
    m.contents = mend(m.contents);
  }
  if (m.quickReply && Array.isArray(m.quickReply.items)) {
    m.quickReply.items = m.quickReply.items.filter((item) => actionOk(item.action)).slice(0, 13);
    if (!m.quickReply.items.length) delete m.quickReply;
  }
  return m;
}

/** The last resort: the same answer, as words. */
function asPlainText(messages) {
  const quick = messages.map((m) => m.quickReply).filter(Boolean).pop();
  const lines = messages.map((m) => (m.type === 'text' ? m.text : m.altText || '')).filter(Boolean);
  const out = { type: 'text', text: (lines.join('\n\n') || 'เรียบร้อยค่ะ').slice(0, 4900) };
  if (quick) out.quickReply = quick;
  return [out];
}

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
const RICH_MENU_H = 1686;
// Two rows of three, in the order the picture draws them.
const RICH_BUTTONS = [
  ['เพิ่มงาน', 'ตรวจสอบงาน', 'จัดการงาน'],
  ['ประชุม', 'กิจกรรม', 'เอกสาร'],
];

export async function installRichMenu(pngBuffer) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');

  const rows = RICH_BUTTONS.length;
  const rowH = Math.floor(RICH_MENU_H / rows);
  const areas = RICH_BUTTONS.flatMap((row, r) => {
    const cell = Math.floor(RICH_MENU_W / row.length);
    return row.map((label, i) => ({
      bounds: {
        x: i * cell,
        y: r * rowH,
        // The last button in a row, and the last row, take the remainder, so
        // rounding never leaves a dead strip of pixels at the edges.
        width: i === row.length - 1 ? RICH_MENU_W - i * cell : cell,
        height: r === rows - 1 ? RICH_MENU_H - r * rowH : rowH,
      },
      action: { type: 'message', label: label.slice(0, 20), text: label },
    }));
  });

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
