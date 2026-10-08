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

/**
 * Bumped whenever anything below changes.
 *
 * Without this, every cold start replayed about fifty CREATE TABLE IF NOT
 * EXISTS and ALTER TABLE statements before answering a single request — each
 * one its own round trip to the database, and all of them doing nothing. Now a
 * cold start costs one SELECT when the schema is already current.
 */
const SCHEMA_VERSION = '2026-10-08c';

async function migrate(sql) {
  try {
    const [row] = await sql`SELECT value FROM meta WHERE key = 'schema_version'`;
    if (row?.value === SCHEMA_VERSION) return;
  } catch (error) {
    // meta does not exist yet, so this is a brand new database: fall through
    // and build everything.
  }

  await applySchema(sql);

  await sql`
    INSERT INTO meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

async function applySchema(sql) {
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
   * Events: dates the committee needs to know about, with no work attached.
   *
   * Deliberately NOT a task with the fields removed. An event has no status,
   * nobody owes anything on it, and it is never "done" — it happens, and then
   * it is past. Modelling it as a task would mean a rehearsal sitting in
   * someone's to-do list forever waiting to be ticked.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_on   DATE NOT NULL,
      starts_at   TEXT,
      ends_on     DATE,
      ends_at     TEXT,
      all_day     BOOLEAN NOT NULL DEFAULT true,
      place       TEXT NOT NULL DEFAULT '',
      department  TEXT,
      colour      TEXT NOT NULL DEFAULT 'plum',
      notify      TEXT NOT NULL DEFAULT '7d,24h,due',
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /** Who an event concerns — for the reminder, and for who sees it. */
  await sql`
    CREATE TABLE IF NOT EXISTS event_people (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      PRIMARY KEY (event_id, username)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS event_departments (
      event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      department TEXT NOT NULL,
      PRIMARY KEY (event_id, department)
    )`;

  /**
   * The parts a task breaks into, each one someone's responsibility.
   *
   * Separate rows rather than a checklist inside the task, because the point
   * is who owns which piece: four people on one task is four people who each
   * need to know what their bit is and tick it off themselves.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS task_parts (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      assignee   TEXT,
      done       BOOLEAN NOT NULL DEFAULT false,
      done_at    TIMESTAMPTZ,
      done_by    TEXT,
      position   INT NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /**
   * Finished work, handed in as a link.
   *
   * Links rather than uploads on purpose: the committee already keeps its
   * files in Google Drive, and a copy living in this app would be a second
   * version of the truth that nobody updates. part_id lets a link be attached
   * to one person's piece rather than to the task as a whole.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS task_links (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      part_id    TEXT,
      url        TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      kind       TEXT NOT NULL DEFAULT 'link',
      added_by   TEXT NOT NULL,
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
   * Set when an admin changes someone's access level in the app and the write
   * back to the Google Sheet did not get through. The sync then leaves that
   * person's access alone instead of restoring the stale value from the sheet.
   * When the sheet write succeeds there is nothing to disagree about, so the
   * pin is cleared and the sheet stays the master as before.
   */
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS access_pinned BOOLEAN NOT NULL DEFAULT false`;

  /**
   * A short code people can say out loud.
   *
   * "Have you seen T0042" works in a corridor and in a LINE message; a
   * fifteen-character internal id does not. Numbered from a sequence rather
   * than generated at random, because a counter cannot collide and because
   * T0042 tells you roughly when something was made, which a random code does
   * not.
   *
   * The internal id stays exactly as it was — this is a label for people, not
   * a key for the database, and swapping the key would break every link
   * already sent.
   */
  /**
   * Signing and approving, pulled apart.
   *
   * They used to be the same act: a step stamped a signature if its ROLE was
   * one of the signing roles, and nothing else could vary. That conflation
   * caused two separate complaints. A letter written by the project director
   * never got a director step — the chain only ever climbs, and there is
   * nothing above him — so his own letters had nowhere to put his signature.
   * And a department head who wanted to approve a letter without their
   * signature appearing on it had no way to say so.
   *
   * `signs` is that decision, held per step rather than per role: set from the
   * role when the chain is built, and lowered by an approver who chooses to
   * approve without stamping.
   */
  await sql`ALTER TABLE doc_steps ADD COLUMN IF NOT EXISTS signs BOOLEAN NOT NULL DEFAULT true`;
  await sql`UPDATE doc_steps SET signs = (role IN ('deptHead', 'director', 'author'))
            WHERE acted_at IS NULL`;

  /**
   * Signature boxes, one row each, so one person can sign in several places.
   *
   * The box used to live on the step itself, which allowed exactly one per
   * signer — no good for a letter that wants an initial on every page as well
   * as a signature at the end. The columns on doc_steps are left alone and
   * still carry the first box, so nothing that reads them breaks; this table
   * is what the stamping actually walks.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS doc_boxes (
      id       TEXT PRIMARY KEY,
      step_id  TEXT NOT NULL REFERENCES doc_steps(id) ON DELETE CASCADE,
      page     INT NOT NULL DEFAULT 1,
      x        REAL NOT NULL,
      y        REAL NOT NULL,
      w        REAL NOT NULL,
      h        REAL NOT NULL
    )`;
  await sql`CREATE INDEX IF NOT EXISTS doc_boxes_step_idx ON doc_boxes (step_id)`;

  // Every box already drawn becomes the first row of its step, once.
  await sql`
    INSERT INTO doc_boxes (id, step_id, page, x, y, w, h)
    SELECT 'box1_' || s.id, s.id, s.page, s.x, s.y, s.w, s.h
    FROM doc_steps s
    WHERE s.x IS NOT NULL AND s.y IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM doc_boxes b WHERE b.step_id = s.id)`;

  /**
   * Whether an invited person has actually said yes.
   *
   * Being named on something and having agreed to it are different facts, and
   * the system only ever recorded the first. 'invited' is the honest default
   * for everybody already on a task: nobody asked them, so nobody may claim
   * they accepted. The person who created it counts as accepted, since putting
   * your own name on your own event is an answer.
   */
  await sql`ALTER TABLE task_people ADD COLUMN IF NOT EXISTS reply TEXT NOT NULL DEFAULT 'invited'`;
  await sql`ALTER TABLE task_people ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`;
  await sql`ALTER TABLE event_people ADD COLUMN IF NOT EXISTS reply TEXT NOT NULL DEFAULT 'invited'`;
  await sql`ALTER TABLE event_people ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`;
  await sql`
    UPDATE task_people p SET reply = 'accepted', replied_at = now()
    FROM tasks t WHERE t.id = p.task_id AND t.created_by = p.username AND p.reply = 'invited'`;
  await sql`
    UPDATE event_people p SET reply = 'accepted', replied_at = now()
    FROM events e WHERE e.id = p.event_id AND e.created_by = p.username AND p.reply = 'invited'`;

  /**
   * Meetings.
   *
   * Deliberately their own table rather than a flag on events. A meeting has
   * things an event has no use for — an agenda that people propose items to, a
   * link to join, minutes that only exist afterwards — and an event has a
   * colour and a multi-day span that a meeting does not. Sharing one table
   * would have meant a dozen columns that are null for one half of the rows.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS meetings (
      id          TEXT PRIMARY KEY,
      code        TEXT,
      title       TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      meets_on    DATE NOT NULL,
      meets_at    TEXT,
      ends_at     TEXT,
      place       TEXT NOT NULL DEFAULT '',
      join_url    TEXT NOT NULL DEFAULT '',
      agenda_url  TEXT NOT NULL DEFAULT '',
      minutes_url TEXT NOT NULL DEFAULT '',
      department  TEXT,
      status      TEXT NOT NULL DEFAULT 'planned',
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS meetings_when_idx ON meetings (meets_on, meets_at)`;
  await sql`CREATE SEQUENCE IF NOT EXISTS meeting_code_seq`;

  /**
   * One row per person invited, and what they said.
   *
   * `circles` on the meeting itself is not kept: a circle is expanded at the
   * moment of inviting and the people are written down. An invitation is a
   * fact about who was asked on that day, and re-deriving it later would
   * quietly change the guest list of a meeting that has already happened.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS meeting_people (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      username   TEXT NOT NULL,
      reply      TEXT NOT NULL DEFAULT 'invited',
      replied_at TIMESTAMPTZ,
      PRIMARY KEY (meeting_id, username)
    )`;

  /**
   * The agenda, one row per item.
   *
   * `slot` is the running order and `minutes` how long it should take, both
   * chosen by whoever proposed it. Anybody invited may add an item — that is
   * the point of the thing — so `proposed_by` records who, and `kind` carries
   * the committee's own five วาระ headings for the ones that come from the
   * standard template.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS meeting_agenda (
      id          TEXT PRIMARY KEY,
      meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      slot        INT NOT NULL DEFAULT 1,
      title       TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '',
      minutes     INT NOT NULL DEFAULT 0,
      priority    TEXT NOT NULL DEFAULT 'medium',
      kind        TEXT NOT NULL DEFAULT 'item',
      proposed_by TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS meeting_agenda_idx ON meeting_agenda (meeting_id, slot)`;

  /**
   * An agenda item can hang under one of the standing วาระ.
   *
   * The committee's agenda is always the same five headings; what changes is
   * what sits UNDER them. An item proposed by a department head is เรื่องเสนอ
   * เพื่อพิจารณา 4.2, not a sixth วาระ — inventing วาระที่ 6 would be wrong in
   * the minutes. A heading has no parent; everything else points at one.
   */
  /**
   * People outside the committee, invited by email.
   *
   * A guest has no account here and never will — an อาจารย์ที่ปรึกษา, somebody
   * from the university, a supplier. They are kept apart from meeting_people
   * for that reason: that table points at usernames and carries replies this
   * system collects, and a guest answers in Google, not here.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS meeting_guests (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      added_by   TEXT NOT NULL,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (meeting_id, email)
    )`;

  /**
   * Papers that belong to a meeting.
   *
   * Two quite different things, deliberately in one table, because to the
   * person attaching them they are the same act: a file they picked off their
   * laptop, and a link they pasted. A link costs nothing and is the better
   * answer when the document already lives in Drive; a file has to be put
   * somewhere, and `drive_url` is where it ends up when the archive account is
   * configured. `bytes` is only the fallback for when it is not — this
   * deployment pays Neon by the gigabyte, so a file that reached Drive has its
   * bytes dropped here immediately rather than kept as a second copy.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS meeting_files (
      id            TEXT PRIMARY KEY,
      meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      mime          TEXT NOT NULL DEFAULT '',
      byte_size     INT NOT NULL DEFAULT 0,
      bytes         BYTEA,
      drive_file_id TEXT,
      drive_url     TEXT,
      link_url      TEXT NOT NULL DEFAULT '',
      added_by      TEXT NOT NULL,
      added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS meeting_files_mtg_idx ON meeting_files (meeting_id, added_at)`;

  /**
   * When somebody is free in a normal week.
   *
   * Free time rather than busy time, because a student's week is defined by
   * the few evenings they are NOT in a lecture, and listing those is three
   * rows instead of twenty. A person with no rows here is treated as always
   * available — with four hundred people most will never open the page, and a
   * system that called all of them unavailable would be ignored within a week.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS user_availability (
      username  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      weekday   TEXT NOT NULL,
      from_at   TEXT NOT NULL,
      to_at     TEXT NOT NULL,
      PRIMARY KEY (username, weekday, from_at, to_at)
    )`;

  /**
   * Days somebody is away — exams, a trip, a family thing.
   *
   * Separate from the weekly hours because it is a different kind of fact: the
   * hours are what is normally true, and this is the stretch where the normal
   * week does not apply. Hours are optional, for the afternoon somebody has one
   * class rather than a whole week of exams.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS user_blocks (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      from_on    DATE NOT NULL,
      to_on      DATE NOT NULL,
      from_at    TEXT,
      to_at      TEXT,
      reason     TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS user_blocks_who_idx ON user_blocks (username, from_on, to_on)`;

  /**
   * A booking that was made knowing it clashed, and declared the one that counts.
   *
   * Only the fact is kept, not the ranking that produced it: access levels
   * change, and a decision taken in October by somebody who was then a co-admin
   * should not quietly reverse itself in January when they are not. `over` is
   * the thing that was pushed aside, so the person on both can see which to
   * turn up to.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS precedence (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      item_id    TEXT NOT NULL,
      over_kind  TEXT NOT NULL,
      over_id    TEXT NOT NULL,
      username   TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS precedence_over_idx ON precedence (over_kind, over_id)`;
  await sql`CREATE INDEX IF NOT EXISTS precedence_item_idx ON precedence (kind, item_id)`;

  /**
   * When this person's calendar feed was last fetched.
   *
   * The only honest answer to "has she linked Google Calendar?" — Google
   * fetches a subscribed feed the moment it is added and every few hours
   * after, so a recent fetch means a calendar somewhere is subscribed. The
   * first-run guide stops asking once this is set.
   */
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_seen_at TIMESTAMPTZ`;

  /**
   * People who follow a task without being on it.
   *
   * Kept apart from task_people on purpose: everything that reads task_people
   * — reminders, "my tasks", the clash check, who may move the status, the
   * calendar feed — means "the people doing it", and a viewer must not be
   * swept into any of that. A viewer can see the task and hears when it moves
   * along; that is all.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS task_viewers (
      task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      added_by TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, username)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS task_viewers_user_idx ON task_viewers (username)`;

  /**
   * How somebody came to be on a task: named on it ('named'), reached through
   * a department tag ('dept'), or handed a piece of it ('part'). The card says
   * which, because "this is mine" and "my department was tagged" are not the
   * same amount of responsibility. Rows from before this was kept read as
   * named — the most responsible reading, and the one they were shown as.
   */
  await sql`ALTER TABLE task_people ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'named'`;

  /**
   * What each person wants to hear about — see lib/notifyprefs.js. A category
   * is stored with an empty item_id; an override on one task, event or
   * document carries that thing's id.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS notify_prefs (
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      scope      TEXT NOT NULL,
      item_id    TEXT NOT NULL DEFAULT '',
      level      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, scope, item_id)
    )`;

  await sql`ALTER TABLE meeting_agenda ADD COLUMN IF NOT EXISTS parent_id TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS meeting_agenda_parent_idx ON meeting_agenda (parent_id)`;

  /**
   * Repairs agendas whose headings were saved as ordinary items.
   *
   * The page built the five standing วาระ without the `kind` that marks them
   * as headings, so every meeting created through it got five plain lines:
   * nothing could be filed under them, and the add box that belongs beneath
   * each one never appeared. The titles are fixed and recognisable, so the
   * meetings already made can be put right rather than rebuilt by hand.
   */
  await sql`
    UPDATE meeting_agenda SET kind = CASE
      WHEN title LIKE 'วาระที่ 1%' OR title LIKE 'Item 1 %' THEN 'chair'
      WHEN title LIKE 'วาระที่ 2%' OR title LIKE 'Item 2 %' THEN 'inform'
      WHEN title LIKE 'วาระที่ 3%' OR title LIKE 'Item 3 %' THEN 'carried'
      WHEN title LIKE 'วาระที่ 4%' OR title LIKE 'Item 4 %' THEN 'decide'
      WHEN title LIKE 'วาระที่ 5%' OR title LIKE 'Item 5 %' THEN 'other'
      ELSE kind END
    WHERE parent_id IS NULL AND kind = 'item'
      AND (title LIKE 'วาระที่ %' OR title LIKE 'Item _ %')`;

  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS code TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS code TEXT`;
  await sql`CREATE SEQUENCE IF NOT EXISTS task_code_seq`;
  await sql`CREATE SEQUENCE IF NOT EXISTS event_code_seq`;

  // Everything already in the database gets one, oldest first, so the numbers
  // read in the order the work actually happened.
  await sql`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
      FROM tasks WHERE code IS NULL)
    UPDATE tasks t SET code = 'T' || lpad(numbered.n::text, 4, '0')
    FROM numbered WHERE t.id = numbered.id`;
  await sql`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
      FROM events WHERE code IS NULL)
    UPDATE events e SET code = 'E' || lpad(numbered.n::text, 4, '0')
    FROM numbered WHERE e.id = numbered.id`;

  /**
   * The counter is moved past whatever is already there rather than set to a
   * fixed number, so running this again — which happens on every schema bump —
   * can never hand out a code twice.
   */
  await sql`SELECT setval('task_code_seq',
    GREATEST((SELECT count(*) FROM tasks), (SELECT last_value FROM task_code_seq)))`;
  await sql`SELECT setval('event_code_seq',
    GREATEST((SELECT count(*) FROM events), (SELECT last_value FROM event_code_seq)))`;

  await sql`SELECT setval('meeting_code_seq',
    GREATEST((SELECT count(*) FROM meetings), (SELECT last_value FROM meeting_code_seq)))`;

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS tasks_code_idx ON tasks (code)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS events_code_idx ON events (code)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS meetings_code_idx ON meetings (code)`;

  /**
   * The full name, as it goes on a letter.
   *
   * The roster's Display Name is "Jade - Project Director", which is right for
   * a task board and wrong for the ผู้รับผิดชอบ column of a document register.
   * Asked for once, the first time somebody sends a document, and kept.
   */
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT`;

  /**
   * The committee's own document number — อบจ.จฬฟ. 03.01-007/2569.
   *
   * Issued from the numbering spreadsheet when a document reaches the
   * secretary, which is the last moment it can still be written on the letter
   * and the first moment it is certain to go out. `doc_tab` remembers which
   * ฝ่าย's page it was registered on, so its status can be kept current there.
   */
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_number TEXT`;
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_tab TEXT`;
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_code TEXT`;
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS numbered_at TIMESTAMPTZ`;

  /**
   * The daily LINE digest is now OFF unless somebody asks for it.
   *
   * It is the only thing this app sends that costs money — one charged push
   * per person per day — and at a few hundred people that is the whole LINE
   * bill on its own, for a message most people can get free by typing "งาน"
   * or tapping the menu. So it became opt-in, and everybody who was signed up
   * by the old default is switched off here rather than being billed for a
   * choice they never made.
   *
   * Anybody who does want it turns it on themselves: เปิดแจ้งเตือน in the chat,
   * or the switch on their profile page.
   */
  await sql`ALTER TABLE line_links ALTER COLUMN digest SET DEFAULT false`;
  await sql`UPDATE line_links SET digest = false WHERE digest = true`;

  /**
   * A count of the LINE messages that cost money.
   *
   * Every push is billed per person, and the plans are bought a month at a
   * time — so "are we near the limit" has to be answerable before the answer
   * arrives as a bill. One row per charged message, with what it was for, and
   * nothing at all for replies, which are free.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS line_charges (
      id       BIGSERIAL PRIMARY KEY,
      username TEXT,
      kind     TEXT NOT NULL,
      sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS line_charges_month_idx ON line_charges (sent_at)`;

  /**
   * Short links — cu-ftm.vercel.app/s/ABC123.
   *
   * `code` is the primary key because it IS the address: two links with the
   * same code would be two different places behind one printed poster, and the
   * database refusing that outright is better than the app checking and
   * occasionally losing a race.
   *
   * `created_by` is not bookkeeping. A link on the committee's own domain
   * borrows the committee's credibility, so every one of them has a name
   * against it and can be switched off by whoever runs the fair.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS short_links (
      code        TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      active      BOOLEAN NOT NULL DEFAULT true,
      hits        INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_hit_at TIMESTAMPTZ
    )`;
  await sql`CREATE INDEX IF NOT EXISTS short_links_owner_idx ON short_links (created_by)`;

  /**
   * Clicks per day.
   *
   * A running total says a poster worked; a total per day says WHICH poster,
   * because the committee knows what went up on which morning. One row per
   * link per day, which is small enough to keep for the whole year.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS short_hits (
      code   TEXT NOT NULL REFERENCES short_links(code) ON DELETE CASCADE,
      on_day DATE NOT NULL,
      hits   INT NOT NULL DEFAULT 0,
      PRIMARY KEY (code, on_day)
    )`;

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

  /**
   * LINE.
   *
   * `line_links` is the binding between a LINE account and a person here. The
   * LINE user id is the primary key, so one LINE account speaks for exactly one
   * person — otherwise a shared phone could act as two committee members.
   *
   * `line_codes` holds the short-lived codes people read off their profile page
   * and type into the chat. They are single use and expire, which is what makes
   * a six-character code safe enough to say out loud.
   *
   * `line_recent` remembers the numbered list the bot last showed someone, so
   * "เสร็จ 3" means the third thing on screen. Per person, replaced every time
   * a new list is sent, and meaningless to anyone else.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS line_links (
      line_user_id TEXT PRIMARY KEY,
      username     TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      digest       BOOLEAN NOT NULL DEFAULT false,
      linked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ
    )`;
  await sql`CREATE INDEX IF NOT EXISTS line_links_username_idx ON line_links (username)`;

  await sql`
    CREATE TABLE IF NOT EXISTS line_codes (
      code       TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS line_recent (
      line_user_id TEXT NOT NULL,
      position     INT  NOT NULL,
      kind         TEXT NOT NULL,
      ref_id       TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (line_user_id, position)
    )`;

  /**
   * Documents that need signing.
   *
   * `stage` is the whole state machine: draft → the chain of approvers in
   * order → secretary → sent, or rejected at any point. The chain itself lives
   * in doc_steps rather than being computed on the fly, because who had to
   * sign is a fact about a particular document at a particular moment and must
   * not change when somebody's job title does months later.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      note         TEXT NOT NULL DEFAULT '',
      recipient    TEXT NOT NULL DEFAULT '',
      priority     TEXT NOT NULL DEFAULT 'medium',
      stage        TEXT NOT NULL DEFAULT 'approving',
      department   TEXT,
      unit         TEXT,
      created_by   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at  TIMESTAMPTZ,
      sent_at      TIMESTAMPTZ,
      sent_by      TEXT,
      drive_file_id TEXT,
      drive_url    TEXT,
      archived_at  TIMESTAMPTZ
    )`;
  await sql`CREATE INDEX IF NOT EXISTS documents_stage_idx ON documents (stage, updated_at DESC)`;

  /**
   * The file itself, both versions.
   *
   * `kind` is 'original' or 'signed'. The original is never touched: a signed
   * copy is built from it each time somebody signs, so a wrong signature can
   * be undone and the untouched document is always recoverable.
   *
   * Stored in the database on purpose while a document is in flight — only a
   * handful are ever open at once — and cleared once the archive copy in Drive
   * has been verified, which is what keeps this table small.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS doc_files (
      doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      bytes      BYTEA,
      byte_size  INT NOT NULL DEFAULT 0,
      pages      INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (doc_id, kind)
    )`;

  /**
   * One row per person who must sign, in order.
   *
   * `position` drives everything: the lowest unsigned position is where the
   * document is now, and nobody can sign out of turn. A step also carries the
   * box the uploader drew, so the signature lands where they said it should.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS doc_steps (
      id         TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      position   INT NOT NULL,
      role       TEXT NOT NULL,
      username   TEXT NOT NULL,
      page       INT NOT NULL DEFAULT 1,
      x          REAL,
      y          REAL,
      w          REAL,
      h          REAL,
      state      TEXT NOT NULL DEFAULT 'waiting',
      acted_at   TIMESTAMPTZ,
      comment    TEXT NOT NULL DEFAULT ''
    )`;
  await sql`CREATE INDEX IF NOT EXISTS doc_steps_doc_idx ON doc_steps (doc_id, position)`;

  /** Everything that ever happened to a document, for the progress bar. */
  await sql`
    CREATE TABLE IF NOT EXISTS doc_events (
      id       TEXT PRIMARY KEY,
      doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind     TEXT NOT NULL,
      username TEXT,
      detail   TEXT NOT NULL DEFAULT ''
    )`;
  await sql`CREATE INDEX IF NOT EXISTS doc_events_doc_idx ON doc_events (doc_id, at)`;

  /**
   * A person's signature, drawn or uploaded once and reused.
   *
   * Kept out of the users table because it is large and read only when a
   * document is actually being stamped.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS signatures (
      username   TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      png        BYTEA NOT NULL,
      width      INT NOT NULL DEFAULT 0,
      height     INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /**
   * Which secretary looks after which department's documents.
   *
   * Only consulted when the head secretaries have chosen 'department' mode;
   * in 'random' mode the table is ignored rather than deleted, so switching
   * back and forth does not lose the mapping they built up.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS secretary_prefs (
      department TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      set_by     TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /**
   * A conversation in progress.
   *
   * Adding a task through chat is a dozen questions, and the answers have to
   * survive between messages — LINE gives no session of its own. One row per
   * LINE account: which flow they are in, which question they are on, and the
   * half-built task so far.
   *
   * Exactly one row per person, replaced when a new flow starts, so nobody can
   * end up half-way through two things at once. Rows are swept after a day of
   * silence: an abandoned conversation must never still be waiting for an
   * answer a week later.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS line_flows (
      line_user_id TEXT PRIMARY KEY,
      flow         TEXT NOT NULL,
      step         TEXT NOT NULL,
      draft        TEXT NOT NULL DEFAULT '{}',
      page         INT  NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /** One digest per person per day, so a retried cron cannot send it twice. */
  await sql`
    CREATE TABLE IF NOT EXISTS line_digests_sent (
      username TEXT NOT NULL,
      on_day   DATE NOT NULL,
      sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, on_day)
    )`;

  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'`;
  /**
   * The task's home department — its teamspace. Distinct from task_departments,
   * which is "who else should be tagged": a task lives in exactly one place but
   * can involve several departments.
   */
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS department TEXT`;

  /**
   * The section inside that department — สถานที่ within อำนวยการ 2, Stage
   * within เนื้อหา. Free text rather than a foreign key on purpose: the org
   * chart is edited in code and renaming a section must not orphan the tasks
   * filed under it. The API only ever writes a name the chart already lists.
   */
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS unit TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS tasks_unit_idx ON tasks (department, unit)`;

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
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_task ON task_parts(task_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_parts_who ON task_parts(assignee)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_links_task ON task_links(task_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_when ON events(starts_on)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_people ON event_people(username)`;
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
/**
 * A bytea column as real bytes.
 *
 * The HTTP driver hands these back as a `\x…` hex string while the local
 * Postgres driver returns a Buffer, and a PDF read as text is a mangled PDF.
 * Lives here because it is a fact about the database connection, not about any
 * one thing stored in it.
 */
export function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const text = String(value);
  if (text.startsWith('\\x')) return Buffer.from(text.slice(2), 'hex');
  return Buffer.from(text, 'binary');
}

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
