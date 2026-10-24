/**
 * Changing somebody's username without taking their account apart.
 *
 * A username is not a label here — it is the key every assignment, signature,
 * invitation and notification hangs off, written into about sixty columns
 * across the schema. So the only way to fix a typo used to be to delete the
 * account and make a new one, which throws away every task the person is on,
 * every document they signed and every meeting they answered. Jade asked for
 * the other thing, and this is it.
 *
 * Two mechanisms, deliberately:
 *
 *   1. Every foreign key in the schema carries ON UPDATE CASCADE (added in
 *      lib/db.js). That makes the thirty-odd tables that point at
 *      users(username) move with the row, inside the one UPDATE, atomically.
 *      It is the half that must not half-happen — a session or a signature
 *      pointing at a user that no longer exists is not a state to be in.
 *
 *   2. The columns with no foreign key — task_people, meeting_people,
 *      tasks.created_by and the rest — are swept afterwards, found by asking
 *      the database what they are rather than from a list in this file. A
 *      list would be correct on the day it was written and quietly wrong the
 *      first time somebody adds a table.
 */

/**
 * Columns that hold a username, as the database describes itself.
 *
 * The name pattern catches the house style — `username`, anything ending in
 * `_by`, `owner`, `assignee` — and EXTRA names the ones that do not follow
 * it. `users.username` is left out because it is the row being renamed, not
 * a reference to it.
 */
const EXTRA = ['signature_delegates.delegate', 'appointments.with_user'];

export async function usernameColumns(sql) {
  const rows = await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying')
      AND (column_name ~ '(^|_)(by|user|username|owner|assignee|host|recipient|sender|member|actor)$'
           OR table_name || '.' || column_name = ANY(${EXTRA}))
      AND NOT (table_name = 'users' AND column_name = 'username')
    ORDER BY table_name, column_name`;
  /**
   * Two that match the pattern and are not people: a LINE user id belongs to
   * LINE, and a browser's user agent is a string about a browser. Renaming
   * either would be quiet nonsense.
   */
  return rows.filter((r) => !/^line_user_id$|^user_agent$/.test(r.column_name));
}

/** A username that can live in a URL, a cookie and a spreadsheet cell. */
export const USERNAME_SHAPE = /^[A-Za-z0-9_.-]{3,64}$/;

/**
 * Move one person from one username to another.
 *
 * Returns which tables moved and how many rows, which the admin page shows:
 * a rename that silently touched nothing is the same shape as one that
 * worked, and the difference matters when it is somebody's signature.
 */
export async function renameUser(sql, from, to) {
  const columns = await usernameColumns(sql);

  // The row itself. Every foreign key follows it in the same statement.
  await sql`UPDATE users SET username = ${to}, updated_at = now() WHERE username = ${from}`;

  /**
   * And the columns nothing enforces. Run after the row, so that at no point
   * does a foreign key point at a user who is not there — and idempotent, so
   * the columns the cascade already moved simply match nothing.
   */
  const moved = [];
  for (const col of columns) {
    /**
     * `sql.query` rather than the tagged template, because a table and a
     * column cannot be parameters — Postgres will not take an identifier as
     * $1. The two VALUES still are; only the names are interpolated, and
     * only after quote() has refused anything that is not an identifier.
     */
    const done = await sql.query(
      `UPDATE ${quote(col.table_name)} SET ${quote(col.column_name)} = $1
       WHERE ${quote(col.column_name)} = $2
       RETURNING 1`,
      [to, from],
    );
    const rows = Array.isArray(done) ? done.length : Number(done?.rowCount || 0);
    if (rows) moved.push({ table: col.table_name, column: col.column_name, rows });
  }
  return { moved, columnsChecked: columns.length };
}

/**
 * Identifiers go into these statements by name rather than as parameters,
 * which Postgres does not allow for a table or a column — so they are quoted
 * the way Postgres quotes them, and anything that is not a plain identifier
 * is refused rather than escaped. The names come from information_schema and
 * never from a request, so this is a belt on top of braces.
 */
function quote(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
