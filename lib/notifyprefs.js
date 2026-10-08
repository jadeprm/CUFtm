/**
 * What each person wants to hear about, and how loudly.
 *
 * Three levels, the same everywhere:
 *   all    — a phone alert (and LINE, where that applies) plus the bell
 *   quiet  — the bell only: there when they look, never buzzing
 *   off    — nothing at all
 *
 * A person sets a level for each CATEGORY below, and may override it for one
 * task, event or document. The override wins: "tell me about tasks I follow,
 * quietly — except this one, which I want on my lock screen".
 *
 * Every place that notifies anybody asks sortRecipients first, so a choice made
 * here is honoured by the task API, the hourly reminders, documents and
 * announcements alike rather than by whichever of them remembered to check.
 */

export const LEVELS = ['all', 'quiet', 'off'];

/**
 * The categories, in the order the settings page lists them, with what each
 * defaults to. Following a task defaults to quiet: somebody made a viewer did
 * not ask to be buzzed every time it moves.
 */
export const CATEGORIES = [
  { key: 'task_named', fallback: 'all' },     // put on a task by name, or given a piece of it
  { key: 'task_dept', fallback: 'all' },      // reached through a department tag
  { key: 'task_reminder', fallback: 'all' },  // 7 days / 3 days / 24 h / due / overdue
  { key: 'task_work', fallback: 'all' },      // somebody handed work in on a task I set
  { key: 'task_watch', fallback: 'quiet' },   // a task I follow (viewer) moved along
  { key: 'event', fallback: 'all' },          // event reminders
  { key: 'document', fallback: 'all' },       // documents waiting for me, approved, returned
  { key: 'announce', fallback: 'all' },       // announcements (urgent ones always come through)
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const ITEM_SCOPES = ['task', 'event', 'doc'];

export const isLevel = (v) => LEVELS.includes(v);
const fallbackOf = (category) => (CATEGORIES.find((c) => c.key === category) || { fallback: 'all' }).fallback;

/**
 * Splits a list of people into who hears it out loud and who only gets the
 * bell. Anyone who has switched it off is in neither list.
 *
 * `force` is for the rare message nobody may silence — an urgent announcement
 * from the committee — which goes to everyone out loud.
 */
export async function sortRecipients(sql, usernames, { category, scope = null, id = null, force = false } = {}) {
  const people = [...new Set((usernames || []).filter(Boolean))];
  if (!people.length || force) return { loud: people, quiet: [], off: [] };

  const rows = await sql`
    SELECT username, scope, item_id, level FROM notify_prefs
    WHERE username = ANY(${people})
      AND ((scope = ${category} AND item_id = '')
        OR (scope = ${scope || '-'} AND item_id = ${id || '-'}))`;

  const loud = [];
  const quiet = [];
  const off = [];
  for (const username of people) {
    const mine = rows.filter((r) => r.username === username);
    const item = mine.find((r) => r.scope === scope && r.item_id === id);
    const cat = mine.find((r) => r.scope === category && r.item_id === '');
    const level = (item && item.level) || (cat && cat.level) || fallbackOf(category);
    (level === 'all' ? loud : level === 'quiet' ? quiet : off).push(username);
  }
  return { loud, quiet, off };
}

/** One person's settings, for the settings page: every category, filled in. */
export async function prefsOf(sql, username) {
  const rows = await sql`
    SELECT scope, item_id, level, updated_at FROM notify_prefs WHERE username = ${username}`;
  const categories = {};
  for (const c of CATEGORIES) {
    const set = rows.find((r) => r.scope === c.key && r.item_id === '');
    categories[c.key] = set ? set.level : c.fallback;
  }
  const items = rows
    .filter((r) => ITEM_SCOPES.includes(r.scope))
    .map((r) => ({ scope: r.scope, id: r.item_id, level: r.level }));

  // Names for the overrides, so the list reads as things rather than ids.
  const ids = (scope) => items.filter((i) => i.scope === scope).map((i) => i.id);
  const named = {};
  const taskIds = ids('task');
  const eventIds = ids('event');
  const docIds = ids('doc');
  if (taskIds.length) {
    for (const r of await sql`SELECT id, code, title FROM tasks WHERE id = ANY(${taskIds})`) named[`task:${r.id}`] = r;
  }
  if (eventIds.length) {
    for (const r of await sql`SELECT id, code, title FROM events WHERE id = ANY(${eventIds})`) named[`event:${r.id}`] = r;
  }
  if (docIds.length) {
    for (const r of await sql`SELECT id, COALESCE(doc_code, doc_number) AS code, title FROM documents WHERE id = ANY(${docIds})`) {
      named[`doc:${r.id}`] = r;
    }
  }
  return {
    categories,
    defaults: Object.fromEntries(CATEGORIES.map((c) => [c.key, c.fallback])),
    // Overrides on things that have since been deleted are dropped, not shown.
    items: items
      .filter((i) => named[`${i.scope}:${i.id}`])
      .map((i) => ({ ...i, code: named[`${i.scope}:${i.id}`].code || null, title: named[`${i.scope}:${i.id}`].title })),
  };
}

/**
 * Sets one level. `level: null` removes the setting — back to the category
 * default for an item, back to the built-in default for a category.
 */
export async function setPref(sql, username, { scope, id = '', level }) {
  const isCategory = CATEGORY_KEYS.includes(scope);
  if (!isCategory && !ITEM_SCOPES.includes(scope)) return 'BAD_SCOPE';
  const itemId = isCategory ? '' : String(id || '').slice(0, 64);
  if (!isCategory && !itemId) return 'ID_REQUIRED';
  if (level === null || level === undefined || level === '') {
    await sql`DELETE FROM notify_prefs WHERE username = ${username} AND scope = ${scope} AND item_id = ${itemId}`;
    return null;
  }
  if (!isLevel(level)) return 'BAD_LEVEL';
  await sql`
    INSERT INTO notify_prefs (username, scope, item_id, level)
    VALUES (${username}, ${scope}, ${itemId}, ${level})
    ON CONFLICT (username, scope, item_id) DO UPDATE SET level = EXCLUDED.level, updated_at = now()`;
  return null;
}
