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
 * Sends to several people at once.
 *
 * Two things make this fast. Everyone's devices are fetched in ONE query
 * rather than two per person, and the notifications go out in parallel
 * batches rather than one after another — five people with a phone each used
 * to mean five round trips to Apple stacked end to end, which the person who
 * pressed the button sat and waited through.
 *
 * Batched rather than all at once: firing two hundred requests simultaneously
 * is a good way to be rate-limited, which shows up as everyone's notification
 * failing together.
 */
const BATCH = 12;

export async function sendToMany(sql, usernames, payloadFor) {
  const names = [...new Set(usernames)];
  if (!names.length) return { sent: 0, reached: 0, removed: 0, errors: [] };

  // One query for who has notifications on, one for every device they own.
  const people = await sql`
    SELECT username, push_enabled FROM users WHERE username = ANY(${names})`;
  const off = new Set(people.filter((p) => p.push_enabled === false).map((p) => p.username));
  const wanted = names.filter((n) => !off.has(n));
  if (!wanted.length) return { sent: 0, reached: 0, removed: 0, errors: [] };

  const subs = await sql`
    SELECT * FROM push_subscriptions WHERE username = ANY(${wanted})`;
  if (!subs.length) return { sent: 0, reached: 0, removed: 0, errors: [] };

  const keys = await getKeys(sql);
  const results = [];

  for (let i = 0; i < subs.length; i += BATCH) {
    const slice = subs.slice(i, i + BATCH);
    const done = await Promise.all(slice.map(async (sub) => {
      const payload = typeof payloadFor === 'function' ? payloadFor(sub.username) : payloadFor;
      try {
        await deliver(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          {
            vapidDetails: { subject: VAPID_SUBJECT, ...keys },
            TTL: payload.level === 'urgent' ? 60 * 60 : 60 * 60 * 24,
            urgency: payload.level === 'urgent' ? 'high' : 'normal',
          },
        );
        return { sub, ok: true };
      } catch (error) {
        return { sub, ok: false, error };
      }
    }));
    results.push(...done);
  }

  // Bookkeeping afterwards, in as few statements as possible.
  const good = results.filter((r) => r.ok).map((r) => r.sub.endpoint);
  const gone = results
    .filter((r) => !r.ok && [404, 410].includes(r.error?.statusCode))
    .map((r) => r.sub.endpoint);
  const soft = results.filter((r) => !r.ok && ![404, 410].includes(r.error?.statusCode));

  if (good.length) {
    await sql`UPDATE push_subscriptions SET last_ok_at = now(), fail_count = 0, last_error = NULL
              WHERE endpoint = ANY(${good})`;
  }
  if (gone.length) {
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ANY(${gone})`;
  }
  if (soft.length) {
    const message = String(soft[0].error?.message || '').slice(0, 300);
    console.error('[push]', soft.length, 'refused —', message);
    await sql`UPDATE push_subscriptions SET fail_count = fail_count + 1, last_error = ${message}
              WHERE endpoint = ANY(${soft.map((r) => r.sub.endpoint)})`;
    await sql`DELETE FROM push_subscriptions WHERE fail_count >= 8`;
  }

  return {
    sent: good.length,
    reached: new Set(results.filter((r) => r.ok).map((r) => r.sub.username)).size,
    removed: gone.length,
    errors: soft.slice(0, 3).map((r) => ({
      host: hostOf(r.sub.endpoint),
      status: r.error?.statusCode || 0,
      message: String(r.error?.message || '').slice(0, 300),
    })),
  };
}

/** How many unread notifications this person has, for the icon badge. */
export async function unreadCount(sql, username) {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM notifications
    WHERE username = ${username} AND read_at IS NULL`;
  return row?.n ?? 0;
}
