/**
 * Outgoing email, through Resend's HTTP API.
 *
 * One provider, one function. The key lives only in the environment
 * (RESEND_API_KEY, set in Vercel by whoever runs the deployment) and never in
 * the repository or the database. MAIL_FROM is the sender, which Resend wants
 * on a domain that has been verified there — chulafair.com.
 *
 * With no key the app says so honestly rather than pretending: mailConfigured()
 * is false, sendMail() returns { ok: false, error: 'MAIL_NOT_CONFIGURED' },
 * and the rule that every member must have a verified email stays switched off
 * (see emailEnforced) so nobody is locked out of a system that cannot email them.
 */

export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY);

/** The "every member must verify an email" rule applies once mail can actually be sent. */
export const emailEnforced = () => mailConfigured() && process.env.EMAIL_REQUIRED !== 'off';

const FROM = () => process.env.MAIL_FROM || 'CUFTM <noreply@chulafair.com>';

export async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) return { ok: false, error: 'MAIL_NOT_CONFIGURED' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: FROM(), to: [to], subject, text }),
    });
    if (!res.ok) return { ok: false, error: 'MAIL_REFUSED', status: res.status };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: 'MAIL_UNREACHABLE', message: String(error?.message || error).slice(0, 200) };
  }
}
