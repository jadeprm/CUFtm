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
let client = null;

export function getSql() {
  if (!connectionString) throw new Error('NO_DATABASE');
  /**
   * One handle per warm instance. Neon's driver is stateless over HTTP, so
   * this costs nothing in production — but every local test run was opening a
   * fresh connection pool per request and running Postgres out of slots.
   */
  const sql = client || (client = neon(connectionString));

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
   * One row per browser someone has allowed notifications in — a phone and a
   * laptop are two rows for the same person, which is the point.
   *
   * The endpoint is the primary key because that is what the browser hands
   * out and what identifies the subscription to Apple's and Google's push
   * services. fail_count lets a dead subscription be dropped after it has
   * been rejected, rather than on the first transient error.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_ok_at TIMESTAMPTZ,
      fail_count INT NOT NULL DEFAULT 0
    )`;

  /**
   * Announcements an admin has sent. Kept separate from notifications so the
   * message is stored once and the per-person rows only carry who has read
   * it — otherwise editing or auditing a message sent to 200 people would
   * mean touching 200 rows.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS announcements (
      id         TEXT PRIMARY KEY,
      sent_by    TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      level      TEXT NOT NULL DEFAULT 'normal',
      audience   TEXT NOT NULL DEFAULT '',
      link       TEXT,
      recipients INT NOT NULL DEFAULT 0,
      pushed     INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /**
   * Which departments a person may work in.
   *
   * One row per grant, because the roster sheet gives people several
   * ("Content, PR") and the assistant heads need all three Operations
   * divisions. users.department stays as their home teamspace — the one new
   * tasks land in — and is always one of the keys listed here.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS user_departments (
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      department TEXT NOT NULL,
      PRIMARY KEY (username, department)
    )`;

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
  // Sub-unit inside a department (เวที, กิจกรรม, VR…), for when the roster
  // grows past heads-only and a department becomes too big to be one list.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unit TEXT`;

  // "All" in the sheet, or the All switch on the admin page: a flag rather
  // than a row per department, so a department added later is covered too.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS all_departments BOOLEAN NOT NULL DEFAULT false`;
  // Set once an admin edits someone's access in the app. The sheet sync then
  // leaves that person alone, so a change made here is not silently undone an
  // hour later. "Follow the sheet again" clears it.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS depts_pinned BOOLEAN NOT NULL DEFAULT false`;

  /**
   * level: 'normal' | 'urgent'. An urgent notification alerts harder on the
   * phone and has to be acknowledged in the app, which is how an admin finds
   * out who has actually seen it.
   */
  await sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'normal'`;
  await sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS announcement_id TEXT`;
  await sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ`;
  // Someone can turn push off without revoking the browser permission.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT true`;

  // What the push service said when it last refused a notification, so a
  // delivery problem can be read off the screen instead of guessed at.
  await sql`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_error TEXT`;

  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'`;
  /**
   * The task's home department — its teamspace. Distinct from task_departments,
   * which is "who else should be tagged": a task lives in exactly one place but
   * can involve several departments.
   */
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS department TEXT`;

  /**
   * One-time backfill: everyone who already had a department keeps it as a
   * grant, so upgrading a live database does not blank out anyone's access.
   *
   * Guarded by a meta key rather than left to run every cold start, because
   * after this an admin may legitimately remove that department — and a
   * migration that keeps putting it back would be a bug nobody could explain.
   */
  const [done] = await sql`SELECT value FROM meta WHERE key = 'dept_backfill'`;
  if (!done) {
    await sql`
      INSERT INTO user_departments (username, department)
      SELECT username, department FROM users WHERE department IS NOT NULL
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO meta (key, value) VALUES ('dept_backfill', ${new Date().toISOString()})
      ON CONFLICT (key) DO NOTHING`;
  }

  await sql`CREATE INDEX IF NOT EXISTS idx_people_user ON task_people(username)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_userdept_dept ON user_departments(department)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(username)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_notif_ann ON notifications(announcement_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_users_caltoken ON users(calendar_token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_dept ON tasks(department)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_users_dept ON users(department)`;
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
