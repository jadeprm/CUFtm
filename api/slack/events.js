/**
 * Retired.
 *
 * This project used to be a Slack app. The file that lived here imported the
 * Slack packages, which are no longer listed in package.json — leaving the old
 * version in place would fail the build for the whole site.
 *
 * Overwriting it with this stub is easier and safer than asking someone to
 * remember to delete a file. It imports nothing and answers plainly if Slack
 * still has an old Request URL pointing here.
 *
 * Safe to delete whenever you like.
 */
export default async function handler() {
  return new Response(
    'This Slack integration has been retired. The task tracker now lives at the site root.\n',
    { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}
