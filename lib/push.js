import webpush from 'web-push';

/**
 * Web push: the part that reaches a phone when nobody has the site open.
 *
 * Nothing here talks to Apple or Google directly. The browser hands us an
 * endpoint URL belonging to its own push service, and we post an encrypted
 * payload to it signed with our VAPID key. No developer account, no App Store,
 * no third-party service in the middle.
 */

/**
 * Who is sending. Part of the signed token, and Apple is strict about it:
 * it wants a real mailto: or https: URL and rejects the whole push with
 * BadJwtToken if it does not like what it sees. A made-up .local address is
 * exactly the kind of thing it refuses, so the site's own URL is used, which
 * Vercel supplies, and a plausible address is the fallback.
 */
const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'mailto:fairtasks@example.com');

let cached = null;

/**
 * The application's signing keys.
 *
 * Generated on first use and kept in the database rather than asked for as
 * environment variables. That is a deliberate trade: it means nobody has to
 * copy a private key into a settings page to make notifications work, which
 * is exactly the kind of step that gets done wrong or skipped. Environment
 * variables still win when they are set, so the keys can be moved later
 * without losing anyone's subscription.
 *
 * Rotating these keys invalidates every existing subscription, so they are
 * written once and then read forever.
 */
export async function getKeys(sql) {
  if (cached) return cached;

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    cached = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
    return cached;
  }

  const [row] = await sql`SELECT value FROM meta WHERE key = 'vapid'`;
  if (row) {
    cached = JSON.parse(row.value);
    return cached;
  }

  const fresh = webpush.generateVAPIDKeys();
  // ON CONFLICT DO NOTHING, then read back: two cold starts racing each other
  // must end up with the same pair, or half the subscriptions would be signed
  // with a key the other half cannot verify.
  await sql`
    INSERT INTO meta (key, value) VALUES ('vapid', ${JSON.stringify(fresh)})
    ON CONFLICT (key) DO NOTHING`;
  const [stored] = await sql`SELECT value FROM meta WHERE key = 'vapid'`;
  cached = JSON.parse(stored.value);
  return cached;
}

/** Exposed so the diagnostics page can show what the signature claims. */
export const SUBJECT_IN_USE = VAPID_SUBJECT;

export async function publicKey(sql) {
  return (await getKeys(sql)).publicKey;
}

/**
 * Sends one payload to every browser a person has allowed.
 *
 * Failures are expected and handled rather than thrown: people uninstall the
 * app, clear their browser, or replace their phone, and the endpoint keeps
 * existing until the push service rejects it. A 404 or 410 means it is gone
 * for good and the row is deleted; anything else is counted, and a
 * subscription that has failed repeatedly is dropped too.
 */
export async function sendToUser(sql, username, payload) {
  const [person] = await sql`SELECT push_enabled FROM users WHERE username = ${username}`;
  if (person && person.push_enabled === false) return { sent: 0, removed: 0, skipped: 'off' };

  const subs = await sql`SELECT * FROM push_subscriptions WHERE username = ${username}`;
  if (!subs.length) return { sent: 0, removed: 0, errors: [] };

  const keys = await getKeys(sql);
  const body = JSON.stringify(payload);
  const options = {
    vapidDetails: { subject: VAPID_SUBJECT, ...keys },
    TTL: payload.level === 'urgent' ? 60 * 60 : 60 * 60 * 24,
    urgency: payload.level === 'urgent' ? 'high' : 'normal',
  };

  let sent = 0;
  let removed = 0;
  const errors = [];

  for (const sub of subs) {
    try {
      await deliver(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        options,
      );
      sent++;
      await sql`UPDATE push_subscriptions SET last_ok_at = now(), fail_count = 0, last_error = NULL
                WHERE endpoint = ${sub.endpoint}`;
    } catch (error) {
      const status = error?.statusCode || 0;
      const message = String(error?.message || error).slice(0, 300);
      errors.push({ host: hostOf(sub.endpoint), status, message });
      console.error('[push]', username, message);

      if (status === 404 || status === 410) {
        await sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`;
        removed++;
      } else {
        const [row] = await sql`
          UPDATE push_subscriptions SET fail_count = fail_count + 1, last_error = ${message}
          WHERE endpoint = ${sub.endpoint} RETURNING fail_count`;
        if (row && row.fail_count >= 8) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`;
          removed++;
        }
      }
    }
  }

  return { sent, removed, errors };
}

const hostOf = (endpoint) => {
  try { return new URL(endpoint).host; } catch (e) { return 'unknown'; }
};

/**
 * Encrypts, signs and posts one notification.
 *
 * web-push builds the request — the ECDH key agreement, the AES-GCM payload
 * encryption and the VAPID signature are all its work — but the request is
 * sent with fetch rather than its built-in sender, which uses Node's https
 * module. Two reasons: fetch is what a serverless runtime is tuned for, and
 * a transport that can be substituted is a transport that can be tested.
 */
async function deliver(subscription, body, options) {
  const details = webpush.generateRequestDetails(subscription, body, options);

  // Content-Length is set by fetch itself; passing it through as well makes
  // some servers reject the request outright.
  const headers = {};
  for (const [key, value] of Object.entries(details.headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    headers[key] = String(value);
  }

  const response = await fetch(details.endpoint, {
    method: details.method || 'POST',
    headers,
    body: details.body,
  });

  if (!response.ok) {
    /**
     * Apple and Google explain their refusals in the response body — "BadJwtToken",
     * "VapidPkHashMismatch" and so on. Throwing away that text and reporting a
     * bare status code is how a delivery problem becomes unfixable, so it is
     * kept and carried back to whoever is looking.
     */
    const detail = await response.text().catch(() => '');
    const error = new Error(
      `Push refused by ${new URL(details.endpoint).host}: HTTP ${response.status}` +
      (detail ? ` — ${detail.slice(0, 300)}` : ''),
    );
    error.statusCode = response.status;
    error.detail = detail.slice(0, 300);
    throw error;
  }
  return response;
}

/**
 * Sends to several people, and counts how many actually had a device.
 *
 * One at a time on purpose. Vercel's free plan gives a function ten seconds,
 * and firing 200 requests at once is a good way to be rate-limited by a push
 * service — which shows up as everyone's notification failing at once.
 */
export async function sendToMany(sql, usernames, payloadFor) {
  let sent = 0;
  let reached = 0;
  let removed = 0;

  for (const username of usernames) {
    const payload = typeof payloadFor === 'function' ? payloadFor(username) : payloadFor;
    const result = await sendToUser(sql, username, payload);
    sent += result.sent;
    removed += result.removed;
    if (result.sent > 0) reached++;
  }
  return { sent, reached, removed };
}

/** How many unread notifications this person has, for the icon badge. */
export async function unreadCount(sql, username) {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM notifications
    WHERE username = ${username} AND read_at IS NULL`;
  return row?.n ?? 0;
}
