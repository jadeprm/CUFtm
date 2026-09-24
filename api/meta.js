import { json, hasDatabase, getSql, requestUrl } from '../lib/db.js';
import { DEPARTMENTS } from '../lib/departments.js';
import { STATUSES, PRIORITIES } from '../lib/scope.js';
import { withNode } from '../lib/http.js';

/**
 * Static reference data the page needs before anyone signs in: the department
 * tree from the org chart, and whether a database is connected at all.
 */
async function handler(request) {
  /**
   * A keep-warm ping: /api/meta?ping=1
   *
   * The free database goes to sleep after a few minutes with nothing to do,
   * and waking it costs a second or two on whatever unlucky request arrives
   * first. A cheap query every few minutes keeps it awake during the day,
   * which is the difference between "instant" and "why is it thinking".
   *
   * Deliberately the smallest possible query, and it needs no sign-in, so a
   * free pinger can call it. It exposes nothing.
   */
  if (hasDatabase && requestUrl(request).searchParams.get('ping')) {
    const started = Date.now();
    try {
      const { sql, ready } = getSql();
      await ready;
      await sql`SELECT 1`;
      return json({ ok: true, ms: Date.now() - started });
    } catch (error) {
      return json({ ok: false, ms: Date.now() - started, error: 'DB_ASLEEP' }, 503);
    }
  }

  return json({
    hasDatabase,
    departments: DEPARTMENTS.map((d) => ({
      key: d.key, th: d.th, en: d.en, units: d.units, parent: d.parent || null,
    })),
    statuses: STATUSES,
    priorities: PRIORITIES,
  });
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
