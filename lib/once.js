import { createHash } from 'node:crypto';

/**
 * "Pressed twice" must not mean "made twice".
 *
 * A slow response makes people press again, and each press is a perfectly
 * valid request. So a create is refused when the same person has just sent the
 * same thing: the first one to claim the key proceeds, a repeat inside the
 * window is told so. The claim is a single INSERT … ON CONFLICT, which is what
 * makes two requests landing together safe, not merely unlikely.
 */
const WINDOW_S = 20;

export async function claimOnce(sql, username, kind, body) {
  const key = createHash('sha1').update(`${username}|${kind}|${JSON.stringify(body)}`).digest('hex');
  const rows = await sql`
    INSERT INTO request_keys (key, created_at) VALUES (${key}, now())
    ON CONFLICT (key) DO UPDATE SET created_at = now()
      WHERE request_keys.created_at < now() - (${WINDOW_S} || ' seconds')::interval
    RETURNING key`;
  if (Math.random() < 0.02) await sql`DELETE FROM request_keys WHERE created_at < now() - interval '1 hour'`;
  return rows.length > 0;
}
