import { json, hasDatabase } from '../lib/db.js';
import { DEPARTMENTS } from '../lib/departments.js';
import { withNode } from '../lib/http.js';

/**
 * Static reference data the page needs before anyone signs in: the department
 * tree from the org chart, and whether a database is connected at all.
 */
async function handler() {
  return json({
    hasDatabase,
    departments: DEPARTMENTS.map((d) => ({ key: d.key, th: d.th, en: d.en, units: d.units })),
  });
}

/** Vercel's Node runtime calls this with (req, res); the adapter bridges it. */
export default withNode(handler);
