import { neon } from '@neondatabase/serverless';

/**
 * Database access and the schema, in one place.
 *
 * Every endpoint calls `getSql()`, which creates the tables on first use. The
 * statements are all `IF NOT EXISTS`, so a cold start after a deploy costs one
 * cheap round trip and never damages existing data.
 */

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  '';

export const hasDatabase = Boolean(connectionString);

let schemaReady = null;

export function getSql() {
  if (!connectionString) throw new Error('NO_DATABASE');
  const sql = neon(connectionString);

  if (!schemaReady) {
    schemaReady = migrate(sql).catch((error) => {
      schemaReady = null; // let the next request retry rather than fail forever
      throw error;
    });
  }
  return { sql, ready: schemaReady };
}

async function migrate(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      username        TEXT PRIMARY KEY,
      nickname        TEXT NOT NULL DEFAULT '',
      sheet_name      TEXT NOT NULL DEFAULT '',
      display_name    TEXT NOT NULL DEFAULT '',
      position        TEXT NOT NULL DEFAULT '',
      access          TEXT NOT NULL DEFAULT 'editor',
      department      TEXT,
      is_head         BOOLEAN NOT NULL DEFAULT false,
      avatar          TEXT,
      password_hash   TEXT,
      password_salt   TEXT,
      reset_allowed   BOOLEAN NOT NULL DEFAULT false,
      reset_allowed_by TEXT,
      lang            TEXT NOT NULL DEFAULT 'th',
      -- active mirrors the sheet: false once a row disappears from it.
      -- suspended is an admin override the sync never touches, so blocking
      -- someone in an emergency is not undone by the next sheet pull.
      active          BOOLEAN NOT NULL DEFAULT true,
      suspended       BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_date    DATE,
      due_time    TEXT,
      status      TEXT NOT NULL DEFAULT 'todo',
      created_by  TEXT NOT NULL,
      notify      TEXT NOT NULL DEFAULT 'created,7d,24h,due',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS task_people (
      task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      PRIMARY KEY (task_id, username)
    )`;

  /** scope: 'all' | 'heads' | 'members' — kept so the card can say "all heads of Content". */
  await sql`
    CREATE TABLE IF NOT EXISTS task_departments (
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      department TEXT NOT NULL,
      scope      TEXT NOT NULL DEFAULT 'all',
      PRIMARY KEY (task_id, department, scope)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      task_id    TEXT,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at    TIMESTAMPTZ
    )`;

  /**
   * One row per reminder actually sent. The unique key is what stops the hourly
   * job from sending the same "due tomorrow" notice every hour for a day.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS reminders_sent (
      task_id  TEXT NOT NULL,
      username TEXT NOT NULL,
      kind     TEXT NOT NULL,
      sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, username, kind)
    )`;

  await sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

  /**
   * Additive migrations for databases that already exist.
   *
   * CREATE TABLE IF NOT EXISTS does nothing to a table that is already there,
   * so a new column has to be added explicitly. Every statement here is
   * idempotent and safe to run on every cold start — and, crucially, none of
   * them drops or rewrites anything, so a live database with real tasks in it
   * upgrades without losing a row.
   */
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'system'`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token TEXT`;

  await sql`CREATE INDEX IF NOT EXISTS idx_people_user ON task_people(username)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_users_caltoken ON users(calendar_token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(username, read_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username)`;
}

/**
 * Reads the query string off a request.
 *
 * Vercel's runtime sets `request.url` to a relative path ("/api/auth?do=check"),
 * while the Web standard and every local test give an absolute one. `new URL()`
 * throws on the relative form, so always parse against a base — it is ignored
 * when the URL is already absolute, and supplies the missing origin when it is not.
 */
export const requestUrl = (request) => new URL(request.url, 'http://internal.local');

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });

export const noDatabase = () =>
  json(
    {
      error: 'NO_DATABASE',
      message:
        'No database is connected. In Vercel: Storage → Neon → Create, connect it to this project, then redeploy.',
    },
    503,
  );
