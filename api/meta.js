import { json, hasDatabase } from '../lib/db.js';
import { DEPARTMENTS } from '../lib/departments.js';

/**
 * Static reference data the page needs before anyone signs in: the department
 * tree from the org chart, and whether a database is connected at all.
 */
export default async function handler() {
  return json({
    hasDatabase,
    departments: DEPARTMENTS.map((d) => ({ key: d.key, th: d.th, en: d.en, units: d.units })),
  });
}
