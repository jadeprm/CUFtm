import { neon } from '@neondatabase/serverless';
import { applyOrg } from './departments.js';
import { applyCircles } from './circles.js';
import { setStoredDriveToken } from './drive.js';
import { unseal } from './googlecal.js';

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

/**
 * The org overlay, re-read at most this often per warm instance.
 *
 * It is one small query, but it is one on the path of every single request,
 * and the chart changes a handful of times a term. Half a minute of staleness
 * costs nothing; the endpoint that writes a change clears the cache itself so
 * the admin who made it sees it at once.
 */
const ORG_TTL_MS = 30_000;
let orgAt = 0;
let orgLoading = null;

/**
 * Forget the cached org chart and circles — called after the page changes
 * either, so whoever made the change sees it on their next request rather
 * than up to half a minute later.
 */
export function forgetOrg() { orgAt = 0; orgLoading = null; }

async function loadOrg(sql) {
  if (Date.now() - orgAt < ORG_TTL_MS) return;
  if (orgLoading) return orgLoading;
  orgLoading = (async () => {
    try {
      const [departments, units, groups, members, drive] = await Promise.all([
        sql`SELECT key, th, en, parent, sort, hidden FROM org_departments ORDER BY sort, key`,
        sql`SELECT department, name, sort, hidden FROM org_units ORDER BY sort, name`,
        sql`SELECT key, th, en, note, self_join, sort, hidden FROM circle_groups ORDER BY sort, key`,
        sql`SELECT circle, username, state FROM circle_people`,
        sql`SELECT value FROM meta WHERE key = 'drive_refresh'`,
      ]);
      applyOrg({ departments, units });
      applyCircles({ groups, members });
      /**
       * The archive's refresh token, if it was connected with the button
       * rather than pasted into the environment. Put here so that
       * driveConfigured() can stay a plain synchronous check — see the
       * note on setStoredDriveToken in lib/drive.js.
       */
      setStoredDriveToken(drive.length ? unseal(drive[0].value) : null);
      orgAt = Date.now();
    } finally {
      orgLoading = null;
    }
  })();
  return orgLoading;
}

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
  // Every endpoint awaits `ready` already, so folding the overlay in here is
  // what keeps one source of truth for the chart without touching call sites.
  return { sql, ready: schemaReady.then(() => loadOrg(sql)) };
}

/**
 * Bumped whenever anything below changes.
 *
 * Without this, every cold start replayed about fifty CREATE TABLE IF NOT
 * EXISTS and ALTER TABLE statements before answering a single request — each
 * one its own round trip to the database, and all of them doing nothing. Now a
 * cold start costs one SELECT when the schema is already current.
 */
const SCHEMA_VERSION = '2026-10-25d';

async function migrate(sql) {
  let fresh = false;
  try {
    const [row] = await sql`SELECT value FROM meta WHERE key = 'schema_version'`;
    if (row?.value === SCHEMA_VERSION) return;
    // No row at all means the schema has never been written down, which is
    // either a brand-new database or one whose first build did not finish.
    fresh = !row;
  } catch (error) {
    // meta does not exist yet, so this is a brand new database: fall through
    // and build everything.
    fresh = true;
  }

  /**
   * An empty database needs two passes.
   *
   * applySchema is written in the order the app grew, so a column added to
   * doc_steps in October sits above the CREATE TABLE that first made
   * doc_steps — that is where the note explaining it belongs. Against the
   * live database the order never mattered, because the tables were already
   * there. Against an empty one the first ALTER on a table created further
   * down stops the run, and every retry stops in exactly the same place: a
   * brand-new Neon project would never finish its first request.
   *
   * So on a brand-new database it runs once leniently — anything that refers
   * to a table that does not exist yet is skipped, which leaves every CREATE
   * TABLE applied — and then again for real, when the ALTERs have something
   * to alter. Every statement in there is idempotent, so the second pass
   * costs nothing but time nobody is waiting for, once, ever.
   */
  if (fresh) {
    const lenient = (...args) => sql(...args).catch((error) => {
      if (error?.code === '42P01' || /does not exist/i.test(error?.message || '')) return [];
      throw error;
    });
    await applySchema(lenient);
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
   * Which วาระ a paper belongs to, or none.
   *
   * NULL means the paper is for the meeting as a whole, which is what every
   * existing row is and what the form still offers first. A committee's
   * papers divide two ways in practice — the minutes of last time and the
   * joining link belong to the meeting; the budget spreadsheet belongs to
   * วาระที่ 4.2 and is noise everywhere else — and one list cannot say which
   * is which.
   *
   * ON DELETE SET NULL rather than CASCADE, deliberately: removing an agenda
   * item must not silently destroy the paper somebody attached to it. The
   * paper falls back to the meeting, where it can be seen and re-filed.
   */
  await sql`ALTER TABLE meeting_files ADD COLUMN IF NOT EXISTS agenda_id TEXT
            REFERENCES meeting_agenda(id) ON DELETE SET NULL`;
  await sql`CREATE INDEX IF NOT EXISTS meeting_files_agenda_idx ON meeting_files (agenda_id)`;

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

  /* ---- 2026-10-11: the redesign ------------------------------------------ */

  /**
   * Spaces: working groups that cut across the org chart.
   *
   * A department is who you are; a space is what you are working on with
   * whoever else is on it — the stage crew drawn from three ฝ่าย, the
   * sponsorship push, a one-off task force. Anybody may start one. Who is in
   * it is a list of people plus, optionally, whole departments or sections,
   * so a space for "everyone in อำนวยการ 2" stays right as people join.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS spaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      colour      TEXT NOT NULL DEFAULT 'pink',
      icon        TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL,
      archived    BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS space_members (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      role     TEXT NOT NULL DEFAULT 'member',
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (space_id, username)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS space_members_user_idx ON space_members (username)`;
  await sql`
    CREATE TABLE IF NOT EXISTS space_departments (
      space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      department TEXT NOT NULL,
      unit       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (space_id, department, unit)
    )`;
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS space_id TEXT`;
  await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS space_id TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS space_id TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS tasks_space_idx ON tasks (space_id)`;

  /**
   * When work starts and when it actually finished.
   *
   * start_date is what the Gantt view draws a bar from; a task without one is
   * drawn as a point on its due date. done_at is set the moment a task reaches
   * เสร็จแล้ว and cleared if it is reopened — the home page's "on time" and
   * "finished this week" figures are read from it. Tasks finished before it
   * existed take their last update as the closest thing to a finish time.
   */
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date DATE`;
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ`;
  await sql`UPDATE tasks SET done_at = updated_at WHERE status = 'done' AND done_at IS NULL`;

  /**
   * Repeating meetings. Each occurrence is an ordinary meeting row — its own
   * agenda, its own replies, its own minutes — tied to the others by
   * series_id so it can be changed or cancelled "this one" or "this and
   * every one after".
   */
  await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS series_id TEXT`;
  await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS repeat_rule TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS meetings_series_idx ON meetings (series_id, meets_on)`;

  /**
   * A person's own time: appointments, focus blocks, and the office hours
   * other people may book. `kind` is 'personal' | 'focus' | 'office' |
   * 'booking'. A booking is written twice — once for the host (kind
   * 'booking', with_user = the guest) and once for the guest — so each
   * person's schedule is one simple query and either side can cancel.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS appointments (
      id          TEXT PRIMARY KEY,
      owner       TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'personal',
      title       TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      place       TEXT NOT NULL DEFAULT '',
      starts_at   TIMESTAMPTZ NOT NULL,
      ends_at     TIMESTAMPTZ NOT NULL,
      with_user   TEXT,
      booking_id  TEXT,
      google_id   TEXT,
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS appointments_owner_idx ON appointments (owner, starts_at)`;

  /**
   * Weekly office hours: when somebody is open to being booked, and in what
   * size of slot. A booking is only accepted inside one of these, on a slot
   * boundary, and where nothing else of theirs already sits.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS office_hours (
      id          TEXT PRIMARY KEY,
      owner       TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      weekday     TEXT NOT NULL,
      from_at     TEXT NOT NULL,
      to_at       TEXT NOT NULL,
      slot_min    INT  NOT NULL DEFAULT 30,
      place       TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS office_hours_owner_idx ON office_hours (owner)`;

  /**
   * A person's own Google Calendar, connected by them signing in to Google.
   *
   * The refresh token is encrypted with a key held only in the environment
   * (lib/googlecal.js) and never leaves the server: the page is told whether
   * a calendar is connected and which address, nothing more.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS google_links (
      username      TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      email         TEXT NOT NULL DEFAULT '',
      refresh_enc   TEXT NOT NULL,
      scope         TEXT NOT NULL DEFAULT '',
      push_events   BOOLEAN NOT NULL DEFAULT false,
      linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_ok_at    TIMESTAMPTZ,
      last_error    TEXT
    )`;
  /** One-use values that tie Google's answer back to who asked. */
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state      TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /**
   * The editable original beside the PDF — `kind = 'source'`.
   *
   * A letter that comes back for a correction is corrected in Word, not in a
   * PDF, and until now the only copy in the system was the flattened one. The
   * PDF is still what gets signed and sent; this rides along so whoever has to
   * fix it has the file to fix. `file_name` and `mime` are only meaningful for
   * a source, since the PDFs are served as PDFs under the letter's own title.
   */
  await sql`ALTER TABLE doc_files ADD COLUMN IF NOT EXISTS file_name TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE doc_files ADD COLUMN IF NOT EXISTS mime TEXT NOT NULL DEFAULT ''`;

  /**
   * Meeting reminders.
   *
   * Which ones a meeting sends, as a comma-separated list of windows: '3d',
   * '1d', '1h'. Invitations, changes and cancellations are not in here —
   * those always go, because they are news rather than a reminder, and
   * somebody who does not want them silences ประชุม in their notification
   * settings like any other category.
   */
  await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS notify TEXT NOT NULL DEFAULT '1d,1h'`;

  /**
   * Who actually pressed the button, and whose signature went on.
   *
   * Anybody in a letter's own chain may approve or reject it at any stage
   * (Jade, 18 October) — a letter waiting three days on somebody with no
   * phone signal helps nobody. The step still says whose step it was;
   * `acted_by` says who dealt with it, so the history reads
   * "อนุมัติโดย แก้ว แทน กุ๊งกิ๊ง" rather than quietly crediting the wrong
   * person.
   *
   * `signed_by` is whose signature was stamped, which is normally whoever
   * pressed — their own name, their own signature. It differs only when the
   * owner of a signature has authorised somebody to sign for them, below.
   */
  await sql`ALTER TABLE doc_steps ADD COLUMN IF NOT EXISTS acted_by TEXT`;
  await sql`ALTER TABLE doc_steps ADD COLUMN IF NOT EXISTS signed_by TEXT`;
  /**
   * The signature on a letter belongs to the name printed under it, always
   * (19 October). Rows written under the earlier rule recorded the person who
   * pressed the button instead. They are NOT corrected here on purpose: the
   * stored PDF is wrong too, and the mismatch is the only way to find those
   * letters — oneDocument puts the row and the file right together the first
   * time somebody opens one.
   */

  /**
   * Signing on somebody's behalf, arranged in advance.
   *
   * A ประธานฝ่าย going abroad for a fortnight can authorise their รองประธาน
   * to sign as them, once, for every letter rather than per document. Only
   * the owner of the signature can add or remove a delegate; the stamp is
   * then the owner's own signature, and the history records who pressed.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS signature_delegates (
      owner      TEXT NOT NULL,
      delegate   TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner, delegate)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS signature_delegates_delegate_idx
            ON signature_delegates (delegate)`;

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
  /**
   * Who actually puts the letter in front of the recipient, and how to reach
   * them. 'secretary' is the old behaviour — the chain ends on เลขานุการ, who
   * forwards it. 'self' means the person who wrote it sends it themselves, so
   * the last step is theirs.
   *
   * The address is what เลขานุการ forwards to. It is not needed for a letter
   * that stays inside Chula, which is what internal_unit says — those go by
   * the university's own internal post rather than by email.
   */
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'secretary'`;
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS recipient_email TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS internal_unit BOOLEAN NOT NULL DEFAULT false`;
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

  /**
   * Bug reports and suggestions, from anybody in the committee.
   *
   * This table is the committee's own voice in its own tool. Before it existed
   * a bug was a message in a LINE group that scrolled away by lunchtime, and a
   * good idea was a sentence somebody said in a meeting — neither reached
   * whoever was going to act on it, and the same fault got reported five times
   * by five people who each thought they were the first.
   *
   * `code` is the short handle people quote at each other, R0042, built from
   * a sequence the same way tasks and events get theirs.
   *
   * `doing` is deliberately a column of its own rather than part of the body.
   * "ตอนนั้นกำลังทำอะไรอยู่" is the single most useful sentence in any bug
   * report and the one people leave out when the form is a blank box, so the
   * form asks for it separately and so does the summary.
   *
   * `page`, `device` and `app_version` are filled in by the page, not typed:
   * which route they were on, what browser and screen, and which build they
   * were actually running. A report against a build from last week usually
   * explains itself, and nobody can be expected to know their own user agent.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS reports (
      id          TEXT PRIMARY KEY,
      code        TEXT,
      kind        TEXT NOT NULL DEFAULT 'bug',
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      doing       TEXT NOT NULL DEFAULT '',
      severity    TEXT NOT NULL DEFAULT 'normal',
      state       TEXT NOT NULL DEFAULT 'new',
      page        TEXT NOT NULL DEFAULT '',
      device      TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      dup_of      TEXT,
      created_by  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      urgent_at   TIMESTAMPTZ,
      nudged_at   TIMESTAMPTZ,
      triaged_by  TEXT,
      triaged_at  TIMESTAMPTZ,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE SEQUENCE IF NOT EXISTS report_code_seq`;
  await sql`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
      FROM reports WHERE code IS NULL)
    UPDATE reports r SET code = 'R' || lpad(numbered.n::text, 4, '0')
    FROM numbered WHERE r.id = numbered.id`;
  await sql`SELECT setval('report_code_seq',
    GREATEST((SELECT count(*) FROM reports), (SELECT last_value FROM report_code_seq)))`;
  await sql`CREATE INDEX IF NOT EXISTS reports_day_idx ON reports (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS reports_state_idx ON reports (state, severity)`;
  await sql`CREATE INDEX IF NOT EXISTS reports_owner_idx ON reports (created_by)`;

  /**
   * Screenshots. Up to three per report, in the database rather than Drive
   * because they are small, short-lived and worth nothing once the bug is
   * fixed — and because a report must go through even when Drive is not
   * connected, which for most of this project's life it has not been.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS report_files (
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      idx       INT NOT NULL,
      bytes     BYTEA NOT NULL,
      mime      TEXT NOT NULL DEFAULT 'image/png',
      byte_size INT NOT NULL DEFAULT 0,
      PRIMARY KEY (report_id, idx)
    )`;

  /**
   * "เจอเหมือนกัน".
   *
   * One row per person per report, so the count is how many people hit it and
   * not how many times somebody pressed a button. It is the cheapest honest
   * measure of how bad something is: five people saying they hit the same
   * fault outranks one person calling their own report urgent.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS report_votes (
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      username  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (report_id, username)
    )`;

  /**
   * The co-admins an admin has put on the rota.
   *
   * Admins are on it always and are not listed here — this table holds only
   * the people an admin has added, which is what Jade asked for: an urgent
   * fault should wake the handful of people who can do something about it,
   * not every co-admin account that happens to exist.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS report_team (
      username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      added_by TEXT NOT NULL,
      at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /**
   * The pop-up that greets people when they open the app.
   *
   * The committee's problem is not that it has nothing to say — it is that a
   * notice in LINE is read by whoever is looking at LINE, and an announcement
   * in the bell is read by whoever presses the bell. Neither reaches somebody
   * who opens the app to check their own tasks, which is the one moment the
   * whole committee reliably passes through.
   *
   * So this is deliberately the most intrusive thing in the app, and
   * deliberately the most constrained:
   *
   *   - it appears ONCE per person per pop-up (`popup_seen`), unless the
   *     author chose otherwise, because a notice that reappears every time is
   *     a notice people learn to dismiss without reading;
   *   - it has a start and an end, so nobody has to remember to switch off
   *     the notice about an event that already happened;
   *   - only admins and co-admins can make one.
   *
   * The image is stored here rather than in Drive for the same reason the
   * report screenshots are: it is small, it is temporary, and a poster must
   * still go up when Drive is not connected.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS popups (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      image       BYTEA,
      image_mime  TEXT NOT NULL DEFAULT '',
      image_w     INT NOT NULL DEFAULT 0,
      image_h     INT NOT NULL DEFAULT 0,
      link_url    TEXT NOT NULL DEFAULT '',
      link_label  TEXT NOT NULL DEFAULT '',
      audience    TEXT NOT NULL DEFAULT '{"kind":"everyone"}',
      repeat_mode TEXT NOT NULL DEFAULT 'once',
      starts_at   TIMESTAMPTZ,
      ends_at     TIMESTAMPTZ,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_by  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS popups_live_idx ON popups (active, starts_at, ends_at)`;

  /**
   * Who has seen which pop-up, and when.
   *
   * Doubles as the only honest measure of whether anybody read the thing:
   * a notice shown to 180 people and dismissed by 12 is worth knowing about
   * before the next one is written the same way.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS popup_seen (
      popup_id TEXT NOT NULL REFERENCES popups(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      on_day   DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Bangkok')::date,
      clicked  BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (popup_id, username)
    )`;

  /**
   * The shelf of important links, as folders inside folders.
   *
   * What this replaces: a pinned LINE message with fourteen Google Drive URLs
   * in it, which is how every committee stores its own paperwork and which
   * fails in the same way every year — the link to the template everybody
   * needs is the eleventh line of a message from September.
   *
   * One table for both folders and links (`kind`), with `parent_id` pointing
   * at the folder above. A single table rather than two is what makes the
   * nesting free: moving a folder is one UPDATE of one column, and so is
   * moving a link.
   *
   * `department` scopes a branch to one ฝ่าย — null means the whole
   * committee. A ฝ่าย's own folder of internal paperwork does not belong on
   * everybody's shelf, and a shelf nobody can tidy is a shelf nobody uses.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS doc_links (
      id         TEXT PRIMARY KEY,
      parent_id  TEXT REFERENCES doc_links(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL DEFAULT 'link',
      title      TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      url        TEXT NOT NULL DEFAULT '',
      icon       TEXT NOT NULL DEFAULT '',
      colour     TEXT NOT NULL DEFAULT '',
      department TEXT,
      position   INT NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS doc_links_parent_idx ON doc_links (parent_id, position)`;
  await sql`CREATE INDEX IF NOT EXISTS doc_links_dept_idx ON doc_links (department)`;

  /**
   * The feed: what the committee says to itself.
   *
   * Everything else in this app is work — a task has an owner and a deadline,
   * a document is going somewhere, an announcement is one person telling
   * everybody. None of that is where a committee of two hundred actually
   * lives, which until now was a LINE group where the photo of last night's
   * build and the question about Friday scroll past each other and are gone
   * by morning.
   *
   * `department` null means the whole committee; set, it means that ฝ่าย's
   * own feed. Both exist on purpose: a ฝ่าย needs somewhere to talk that is
   * not in front of two hundred people, and the committee needs one place
   * that everybody actually sees.
   *
   * `edited_at` rather than a silent overwrite. A post people have replied to
   * is part of a conversation, and changing it without saying so is how a
   * thread stops making sense.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS posts (
      id         TEXT PRIMARY KEY,
      department TEXT,
      body       TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      edited_at  TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS posts_feed_idx ON posts (department, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS posts_when_idx ON posts (created_at DESC)`;

  /**
   * A post held at the top of the feed.
   *
   * A timestamp rather than a boolean, because a committee eventually pins
   * two things and then the order it pinned them in is the order they should
   * sit in. Admins only: posting is open to everybody precisely because a
   * post costs nobody anything, and being at the top of everybody's page is
   * a different thing that belongs to the committee.
   */
  await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`;
  await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned_by TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS posts_pinned_idx ON posts (pinned_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS posts_who_idx ON posts (created_by)`;

  /**
   * What is attached to a post: pictures, and links.
   *
   * One table, told apart by `kind`, for the same reason the shelf uses one:
   * they are one list to the person who made the post. Pictures live here
   * rather than in Drive because a feed photo is small, is looked at for a
   * week and then never again, and must still work when Drive is not set up.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS post_files (
      post_id   TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      idx       INT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'image',
      bytes     BYTEA,
      mime      TEXT NOT NULL DEFAULT '',
      width     INT NOT NULL DEFAULT 0,
      height    INT NOT NULL DEFAULT 0,
      byte_size INT NOT NULL DEFAULT 0,
      url       TEXT NOT NULL DEFAULT '',
      title     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (post_id, idx)
    )`;

  /**
   * One row per person per post. The count is how many people liked it, not
   * how many times a button was pressed.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id  TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, username)
    )`;

  /**
   * Comments, deliberately flat.
   *
   * No replies-to-replies. A committee feed is not a forum, and the one thing
   * a nested thread reliably produces on a phone is a column six indents deep
   * that nobody can read. If somebody needs to answer one person, they say
   * their name.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS post_comments (
      id         TEXT PRIMARY KEY,
      post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      edited_at  TIMESTAMPTZ
    )`;
  await sql`CREATE INDEX IF NOT EXISTS post_comments_idx ON post_comments (post_id, created_at)`;

  /**
   * Who was tagged, on a post or on a comment.
   *
   * Stored rather than worked out from the text each time, because this is
   * also the answer to "what was I tagged in" — and because a name parsed out
   * of a body is a guess, while this is what the page actually sent.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS post_mentions (
      post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS post_mentions_who ON post_mentions (username, at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS post_mentions_once
            ON post_mentions (post_id, COALESCE(comment_id, ''), username)`;

  /**
   * Somebody saying "this should not be here".
   *
   * A report does not hide anything by itself — one person's objection is not
   * a verdict, and a feed where anybody can make a post disappear is a feed
   * with a heckler's veto. It puts the post in front of the admins, who
   * decide. The unique index means a second report from the same person
   * replaces the first rather than inflating the count.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS post_reports (
      post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      why        TEXT NOT NULL DEFAULT '',
      at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      handled_at TIMESTAMPTZ,
      handled_by TEXT
    )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS post_reports_once
            ON post_reports (post_id, COALESCE(comment_id, ''), username)`;

  await sql`CREATE INDEX IF NOT EXISTS idx_people_user ON task_people(username)`;

  /**
   * A meeting's standing invitation, kept as circles rather than as the names
   * they happened to cover on the day.
   *
   * The page used to turn "ทุกคน" into a list of usernames before it ever
   * reached here, which looks identical until somebody joins the committee a
   * week later: they are not on the list, they never see the meeting, and the
   * first anyone hears of it is a LINE message asking whether they have been
   * added yet. Storing the circle means the invitation is a rule, and
   * topUpStandingInvites() re-applies it after every roster sync.
   */
  await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS circles TEXT`;

  /**
   * What a Google consent was asked for.
   *
   * The same callback now answers two different flows — a person linking
   * their own calendar, and an admin connecting the committee's Drive — and
   * they end in different places with different scopes. Defaulting to
   * 'calendar' keeps every state row already in flight meaning what it did.
   */
  await sql`ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'calendar'`;

  /**
   * The org chart, as far as the admin page has changed it.
   *
   * lib/departments.js holds the chart as transcribed from the fair's own
   * org chart, and that stays: it is the thing anyone can read without a
   * database. These two tables are the overlay on top of it — a renamed
   * ฝ่าย, a หน่วย nobody thought of in September, a ฝ่าย that turned out to
   * exist. Before them, adding เสื้อโครงการ meant editing a source file and
   * a deployment, which is not something a committee should have to ask for.
   *
   * Nothing is ever deleted. A key is written on tasks, grants, meetings and
   * documents, so putting a department away means hiding it from the pickers
   * and leaving everything that already points at it alone.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS org_departments (
      key        TEXT PRIMARY KEY,
      th         TEXT,
      en         TEXT,
      parent     TEXT,
      sort       INTEGER NOT NULL DEFAULT 0,
      hidden     BOOLEAN NOT NULL DEFAULT false,
      added_by   TEXT,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS org_units (
      department TEXT NOT NULL,
      name       TEXT NOT NULL,
      sort       INTEGER NOT NULL DEFAULT 0,
      hidden     BOOLEAN NOT NULL DEFAULT false,
      added_by   TEXT,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (department, name)
    )`;

  /**
   * Somebody the admin page created rather than the roster sheet.
   *
   * The sync closes every account it does not find a row for, which is right
   * for a roster the sheet owns and wrong for a person added here ten minutes
   * ago. The flag clears itself the moment their name does appear in the
   * sheet — from then on the sheet owns them like everybody else.
   */
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS off_sheet BOOLEAN NOT NULL DEFAULT false`;

  /**
   * Groups the committee invented, alongside the four it was born with.
   *
   * lib/circles.js describes คณะกรรมการบริหาร, คณะทำงานหลัก, หัวหน้าทั้งหมด
   * and ทุกคน as questions asked of the roster — "who is at least an editor
   * right now" — which is exactly right for those four and no use at all for
   * "คนที่มารื้อของวันเสาร์". A group here has no access floor: nobody is in
   * it by derivation, only by being put in or walking in.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS circle_groups (
      key        TEXT PRIMARY KEY,
      th         TEXT NOT NULL,
      en         TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      self_join  BOOLEAN NOT NULL DEFAULT true,
      sort       INTEGER NOT NULL DEFAULT 0,
      hidden     BOOLEAN NOT NULL DEFAULT false,
      added_by   TEXT,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  /**
   * Who is in a circle when the derivation gets it wrong.
   *
   * `in` and `out` rather than a membership list, because the four built-in
   * circles keep deriving: ต๊อดติ is a co-admin because he manages people,
   * which is a reason to be in คณะกรรมการบริหาร and not the only one — and
   * the assistant who sits on the board without the access level to match
   * was previously unrepresentable. For a group from the table above there
   * is nothing to derive, so only `in` rows mean anything.
   *
   * `by_self` marks a row somebody wrote about themselves, so that an admin
   * putting somebody in a group and that person walking into it are
   * distinguishable — only the second can be undone by the person.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS circle_people (
      circle   TEXT NOT NULL,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      state    TEXT NOT NULL DEFAULT 'in',
      by_self  BOOLEAN NOT NULL DEFAULT false,
      set_by   TEXT,
      set_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (circle, username)
    )`;

  /**
   * Labels somebody keeps for their own work, seen by nobody else.
   *
   * Deliberately not a second department system. A ฝ่าย says who you answer
   * to and who may see what; these say "รอของ" or "ทำที่บ้านได้" and mean
   * nothing to anybody but the person who wrote them, which is why they are
   * scoped to a username in both tables rather than shared and argued over.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS user_tags (
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      name     TEXT NOT NULL,
      colour   TEXT NOT NULL DEFAULT '',
      sort     INTEGER NOT NULL DEFAULT 0,
      made_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, name)
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS task_tags (
      task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      name     TEXT NOT NULL,
      PRIMARY KEY (task_id, username, name),
      FOREIGN KEY (username, name) REFERENCES user_tags(username, name) ON DELETE CASCADE
    )`;
  await sql`CREATE INDEX IF NOT EXISTS task_tags_mine ON task_tags (username, name)`;

  /**
   * Every foreign key follows its parent when the parent's key changes.
   *
   * Added so that a username can be corrected. It is the key about sixty
   * columns hang off, and until now the only way to fix a typo in one was to
   * delete the account — which throws away every task the person is on,
   * every document they signed and every meeting they answered.
   *
   * ON UPDATE CASCADE costs nothing the rest of the time: the keys it
   * follows (a task id, a document id) never change. What it buys is that
   * the thirty-odd tables pointing at users(username) move inside the single
   * UPDATE, atomically — a session or a signature pointing at a user who no
   * longer exists is not a state worth risking. The columns with no foreign
   * key are swept separately; see lib/rename.js.
   *
   * Written as a loop over what the database actually has rather than
   * thirty hand-written ALTERs, so a table added next month is covered by
   * the next deployment without anybody remembering this block exists.
   */
  await sql`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.conname, cl.relname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE c.contype = 'f' AND n.nspname = 'public'
          AND pg_get_constraintdef(c.oid) NOT LIKE '%ON UPDATE%'
      LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.relname, r.conname);
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s ON UPDATE CASCADE',
                       r.relname, r.conname, r.def);
      END LOOP;
    END $$`;
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
