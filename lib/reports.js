/**
 * Bug reports and suggestions.
 *
 * The committee is two hundred people using a tool one person maintains. Before
 * this existed a fault reached that person as a message in a LINE group, which
 * is to say it reached them if they happened to be reading at the time: the
 * report scrolled away, the screenshot expired, and nobody could tell whether
 * the thing had been fixed, dismissed, or simply missed. Five people would
 * report the same fault, each certain they were the first.
 *
 * So: anybody may file one, from inside the app, on the page where the thing
 * went wrong — and what they file is kept, numbered, answerable and countable.
 *
 * Two rules shape everything here.
 *
 * **Reporting is open to everyone.** A member who cannot create a task can
 * still report a bug, because the people who find bugs are the people doing the
 * work, and making them ask a ประธานฝ่าย to pass it on is how a fault goes
 * unreported. There is nothing to abuse: a report is a sentence in a list.
 *
 * **Urgent means somebody is woken up, so it has to be rare.** The reporter
 * ticks it, which is right — they are the one standing in front of the broken
 * thing — and an admin can raise or lower it afterwards, which is also right,
 * because "urgent" from inside one person's afternoon is not always urgent for
 * the fair. Only a BUG can be urgent. A suggestion, however good, is not an
 * emergency, and allowing it to be marked as one would teach everybody to
 * ignore the alert.
 */

import { ACCESS } from './auth.js';
import { sortRecipients } from './notifyprefs.js';
import { sendToMany } from './push.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A bug, or something somebody would like. Nothing else. */
export const KINDS = ['bug', 'idea'];

/**
 * How bad it is, worst first.
 *
 *   urgent  — ใช้งานไม่ได้เลย: the work cannot go on. Wakes people.
 *   high    — ติดขัด แต่พอทำได้: there is a way round it.
 *   normal  — เรื่องเล็ก, and every suggestion.
 */
export const SEVERITIES = ['urgent', 'high', 'normal'];

/**
 * Where a report is up to.
 *
 * `planned` exists because "we know, it is on the list" is a real and useful
 * answer, and without it the only honest states are "nobody has looked" and
 * "done" — which is why trackers without it fill up with reports nobody dares
 * close.
 */
export const STATES = ['new', 'planned', 'fixed', 'declined', 'duplicate'];

export const isKind = (v) => KINDS.includes(v);
export const isSeverity = (v) => SEVERITIES.includes(v);
export const isState = (v) => STATES.includes(v);

/** Up to three screenshots, 2 MB each — a phone screenshot is well under it. */
export const MAX_SHOTS = 3;
export const MAX_SHOT = 2 * 1024 * 1024;

/** How many people have to say "เจอเหมือนกัน" before the admins are told. */
export const NUDGE_AT = 5;

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** Keeps the line breaks somebody typed, drops the control characters. */
const clipLines = (value, max) =>
  String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * Everybody may file one, and that is the point.
 *
 * Kept as a function rather than inlined as `true` so that if the day ever
 * comes when somebody has to be stopped, there is one place to stop them.
 */
export const canReport = (user) => Boolean(user);

/**
 * Who may read the whole of every report — the device line, the screenshots,
 * the admin's notes — and who may change a report's state or severity.
 *
 * Admins always. Co-admins only when an admin has put them on the rota, which
 * is exactly what Jade asked for: the alert should reach the handful of people
 * who can act on it rather than every co-admin account in the roster.
 *
 * `team` is the set of usernames from the report_team table.
 */
export function canTriage(user, team) {
  if (!user) return false;
  if (user.access === ACCESS.ADMIN) return true;
  if (user.access === ACCESS.COADMIN) return Boolean(team && team.has(user.username));
  return false;
}

/** Only an admin decides who is on the rota. A co-admin cannot add themselves. */
export const canSetTeam = (user) => user?.access === ACCESS.ADMIN;

/**
 * Whether this person may see this report at all.
 *
 * Everybody sees the list — the title, the kind, how many people hit it and
 * what became of it. That openness is doing a job: it is how somebody about to
 * report a fault discovers it is already reported and presses เจอเหมือนกัน
 * instead, and it is how the committee can see that reporting something here
 * actually leads somewhere. What is held back from the list is the private
 * part: the reporter's browser and screen, the screenshots they took of
 * whatever was on their screen at the time, and the triage notes.
 */
export const canSeeReport = () => true;

/** The private part — only the rota, and the person who filed it. */
export function canSeeDetail(user, report, team) {
  if (!user) return false;
  if (canTriage(user, team)) return true;
  return report?.created_by === user.username;
}

/** The rota, as a Set. Admins are implicit and not in the table. */
export async function teamOf(sql) {
  const rows = await sql`SELECT username FROM report_team`;
  return new Set(rows.map((r) => r.username));
}

/**
 * Everybody who should hear about an urgent fault: every admin, plus the
 * co-admins on the rota. Read fresh each time rather than cached, because the
 * one moment this matters is the moment somebody has just been added.
 */
export async function respondersOf(sql) {
  const rows = await sql`
    SELECT username FROM users
     WHERE active = true AND suspended = false
       AND (access = 'admin' OR username IN (SELECT username FROM report_team))`;
  return rows.map((r) => r.username);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A report as the page wants it.
 *
 * `detail` decides whether the private half is included. The same shaping
 * function serves the open list and the rota's inbox so there is no second
 * version of it to forget to lock down.
 */
export function shapeReport(row, { detail = false, me = null } = {}) {
  const out = {
    id: row.id,
    code: row.code || null,
    kind: row.kind,
    title: row.title,
    severity: row.severity,
    state: row.state,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dupOf: row.dup_of || null,
    votes: Number(row.votes || 0),
    // Whether I have already said I hit this, so the button can say so.
    voted: Boolean(row.voted),
    shots: Number(row.shots || 0),
    mine: me ? row.created_by === me : false,
  };
  if (detail) {
    out.body = row.body;
    out.doing = row.doing;
    out.page = row.page;
    out.device = row.device;
    out.appVersion = row.app_version;
    out.note = row.note;
    out.triagedBy = row.triaged_by || null;
    out.triagedAt = row.triaged_at || null;
    out.urgentAt = row.urgent_at || null;
  }
  return out;
}

/**
 * The list.
 *
 * One query with the vote count and the screenshot count folded in, rather than
 * a count per row: this is the page's first request and the list is read far
 * more often than it is written.
 */
export async function listReports(sql, me, { limit = 400 } = {}) {
  return sql`
    SELECT r.*,
           (SELECT count(*)::int FROM report_votes v WHERE v.report_id = r.id) AS votes,
           (SELECT count(*)::int FROM report_files f WHERE f.report_id = r.id) AS shots,
           EXISTS (SELECT 1 FROM report_votes v
                    WHERE v.report_id = r.id AND v.username = ${me}) AS voted
      FROM reports r
     ORDER BY r.created_at DESC
     LIMIT ${limit}`;
}

export async function oneReport(sql, me, id) {
  const [row] = await sql`
    SELECT r.*,
           (SELECT count(*)::int FROM report_votes v WHERE v.report_id = r.id) AS votes,
           (SELECT count(*)::int FROM report_files f WHERE f.report_id = r.id) AS shots,
           EXISTS (SELECT 1 FROM report_votes v
                    WHERE v.report_id = r.id AND v.username = ${me}) AS voted
      FROM reports r WHERE r.id = ${id} OR r.code = ${id}`;
  return row || null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Files one.
 *
 * `shots` arrives as an array of { buffer, mime } the caller has already
 * decoded and size-checked — this function does not touch base64, so the
 * decoding rules stay in one place next to the other uploads in the app.
 */
export async function addReport(sql, me, input, shots = []) {
  const kind = isKind(input.kind) ? input.kind : 'bug';
  const title = clip(input.title, 160);
  if (!title) return { error: 'TITLE_REQUIRED' };

  /**
   * A suggestion is never urgent, whatever the form sent.
   *
   * Enforced here rather than only in the page, because the alert this unlocks
   * is the one thing in the feature that costs somebody their evening.
   */
  let severity = isSeverity(input.severity) ? input.severity : 'normal';
  if (kind === 'idea' && severity === 'urgent') severity = 'high';

  const id = newId('rep');
  await sql`
    INSERT INTO reports (id, code, kind, title, body, doing, severity, page, device, app_version, created_by, urgent_at)
    VALUES (${id}, 'R' || lpad(nextval('report_code_seq')::text, 4, '0'),
            ${kind}, ${title}, ${clipLines(input.body, 4000)}, ${clipLines(input.doing, 1000)},
            ${severity}, ${clip(input.page, 120)}, ${clip(input.device, 300)},
            ${clip(input.appVersion, 40)}, ${me.username},
            ${severity === 'urgent' ? new Date().toISOString() : null})`;

  for (let i = 0; i < Math.min(shots.length, MAX_SHOTS); i++) {
    const shot = shots[i];
    await sql`
      INSERT INTO report_files (report_id, idx, bytes, mime, byte_size)
      VALUES (${id}, ${i}, ${shot.buffer}, ${shot.mime || 'image/png'}, ${shot.buffer.length})`;
  }

  /**
   * The reporter counts as one person who hit it, so the number on the list is
   * "how many people have run into this" and not "how many besides the
   * reporter" — which reads as zero on a report that has just been filed.
   */
  await sql`
    INSERT INTO report_votes (report_id, username) VALUES (${id}, ${me.username})
    ON CONFLICT DO NOTHING`;

  const [row] = await sql`SELECT * FROM reports WHERE id = ${id}`;
  return { report: row };
}

/**
 * Triage: the state, the severity, a note, or marking it a duplicate.
 *
 * Only ever called for somebody canTriage has already allowed, and every field
 * is optional so the inbox can change one thing without resending the rest.
 */
export async function triageReport(sql, me, report, patch) {
  if (patch.state !== undefined) {
    if (!isState(patch.state)) return { error: 'BAD_STATE' };
    await sql`UPDATE reports SET state = ${patch.state} WHERE id = ${report.id}`;
  }

  if (patch.severity !== undefined) {
    if (!isSeverity(patch.severity)) return { error: 'BAD_SEVERITY' };
    if (report.kind === 'idea' && patch.severity === 'urgent') {
      return { error: 'IDEA_CANNOT_BE_URGENT' };
    }
    /**
     * `urgent_at` is stamped the first time something becomes urgent and never
     * cleared. An admin lowering a severity does not make it untrue that the
     * fault was urgent for a while, and that is the number worth having later:
     * how long an urgent fault sat before anybody moved.
     */
    const stamp = patch.severity === 'urgent' && !report.urgent_at;
    await sql`
      UPDATE reports SET severity = ${patch.severity},
             urgent_at = ${stamp ? new Date().toISOString() : report.urgent_at}
       WHERE id = ${report.id}`;
  }

  if (patch.note !== undefined) {
    await sql`UPDATE reports SET note = ${clipLines(patch.note, 2000)} WHERE id = ${report.id}`;
  }

  if (patch.dupOf !== undefined) {
    const of = clip(patch.dupOf, 16).toUpperCase();
    if (!of) {
      await sql`UPDATE reports SET dup_of = NULL WHERE id = ${report.id}`;
    } else {
      const [other] = await sql`SELECT code FROM reports WHERE code = ${of}`;
      if (!other) return { error: 'NO_SUCH_REPORT' };
      if (other.code === report.code) return { error: 'NOT_ITS_OWN_DUPLICATE' };
      await sql`
        UPDATE reports SET dup_of = ${other.code}, state = 'duplicate' WHERE id = ${report.id}`;
    }
  }

  await sql`
    UPDATE reports SET triaged_by = ${me.username}, triaged_at = now(), updated_at = now()
     WHERE id = ${report.id}`;

  const [row] = await sql`SELECT * FROM reports WHERE id = ${report.id}`;
  return { report: row };
}

/** เจอเหมือนกัน, and pressing it again takes it back. */
export async function toggleVote(sql, me, report) {
  const [had] = await sql`
    SELECT 1 FROM report_votes WHERE report_id = ${report.id} AND username = ${me.username}`;
  if (had) {
    await sql`
      DELETE FROM report_votes WHERE report_id = ${report.id} AND username = ${me.username}`;
  } else {
    await sql`
      INSERT INTO report_votes (report_id, username) VALUES (${report.id}, ${me.username})
      ON CONFLICT DO NOTHING`;
  }
  const [{ votes }] = await sql`
    SELECT count(*)::int AS votes FROM report_votes WHERE report_id = ${report.id}`;
  return { voted: !had, votes };
}

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

/**
 * Buzzes the rota.
 *
 * The bell row is always 'normal' and only the PUSH is raised, which is the
 * rule the rest of the app follows: an urgent bell row opens a dialog over
 * whatever the person is doing the next time they load the page, and that is
 * reserved for an announcement somebody deliberately sent to the committee. A
 * broken page deserves a buzz on the lock screen, not a door in the face.
 */
export async function tellResponders(sql, { actor, title, body, tag, loudly = false }) {
  const people = (await respondersOf(sql)).filter((u) => u !== actor);
  if (!people.length) return 0;

  const { loud, quiet } = await sortRecipients(sql, people, { category: 'report' });
  const targets = loud.concat(quiet);
  if (!targets.length) return 0;

  const idFor = {};
  for (const u of targets) idFor[u] = newId('n');
  await sql`
    INSERT INTO notifications (id, username, kind, title, body)
    SELECT i, u, 'report', ${clip(title, 200)}, ${clip(body, 500)}
    FROM unnest(${targets.map((u) => idFor[u])}::text[], ${targets}::text[]) AS t(i, u)`;

  if (loud.length) {
    try {
      await sendToMany(sql, loud, (username) => ({
        id: idFor[username],
        title: clip(title, 200),
        body: clip(body, 500),
        level: loudly ? 'urgent' : 'normal',
        tag,
        url: './#/reports',
      }));
    } catch (error) {
      console.error('[reports] push failed:', String(error?.message || error).slice(0, 200));
    }
  }
  return targets.length;
}

/**
 * Tells the person who filed it what became of it.
 *
 * Without this the feature quietly dies: somebody reports two things, hears
 * nothing either time, and reasonably concludes that reporting is a way of
 * talking to yourself. The one notification that keeps people filing reports
 * is the one that says somebody read theirs.
 */
export async function tellReporter(sql, report, { actor, title, body }) {
  if (!report.created_by || report.created_by === actor) return 0;
  const { loud, quiet } = await sortRecipients(sql, [report.created_by], { category: 'report' });
  const targets = loud.concat(quiet);
  if (!targets.length) return 0;

  const id = newId('n');
  await sql`
    INSERT INTO notifications (id, username, kind, title, body)
    VALUES (${id}, ${report.created_by}, 'report', ${clip(title, 200)}, ${clip(body, 500)})`;

  if (loud.length) {
    try {
      await sendToMany(sql, loud, () => ({
        id, title: clip(title, 200), body: clip(body, 500),
        level: 'normal', tag: `report-${report.id}`, url: './#/reports',
      }));
    } catch (error) {
      console.error('[reports] push failed:', String(error?.message || error).slice(0, 200));
    }
  }
  return targets.length;
}

/**
 * Many people hitting the same thing is itself urgent.
 *
 * Somebody reporting their own fault as เรื่องเล็ก is being modest about their
 * own afternoon; five people pressing เจอเหมือนกัน on it is a fact about the
 * fair. So the rota is told once — once ever, hence `nudged_at` — when a report
 * nobody has marked urgent reaches the threshold. Told, not escalated: the
 * severity is still an admin's to set, and a counter should not be able to
 * wake people up by itself night after night.
 */
export async function maybeNudge(sql, report, votes) {
  if (votes < NUDGE_AT) return false;
  if (report.nudged_at) return false;
  if (report.severity === 'urgent') return false;
  if (!['new', 'planned'].includes(report.state)) return false;

  await sql`UPDATE reports SET nudged_at = now() WHERE id = ${report.id}`;
  await tellResponders(sql, {
    actor: null,
    title: `${votes} คนเจอปัญหาเดียวกัน · ${report.code || ''}`.trim(),
    body: report.title,
    tag: `report-nudge-${report.id}`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The daily summary
// ---------------------------------------------------------------------------

const SEV_TH = { urgent: 'ใช้งานไม่ได้เลย', high: 'ติดขัด', normal: 'เรื่องเล็ก' };
const STATE_TH = { new: 'ยังไม่ได้ดู', planned: 'อยู่ในแผน', fixed: 'แก้แล้ว', declined: 'ไม่ทำ', duplicate: 'ซ้ำ' };

/**
 * Everything the day's work needs, as one block of plain text to copy.
 *
 * Why text and not a tidy JSON export: this gets pasted into a chat with
 * whoever is going to do the work, and it has to be readable by the person
 * pasting it as well as by whatever reads it afterwards. Plain text with
 * headings is the one format that is good at both.
 *
 * Two groups, deliberately:
 *
 *   **ของวันนี้** — what came in on the chosen day, which is the day's news.
 *   **ยังค้างอยู่** — everything still open from before, because a report
 *   filed on Tuesday and ignored on Wednesday is the one most likely to be
 *   ignored again, and a summary that only ever shows today's arrivals is how
 *   that happens.
 *
 * Urgent first inside each group, then by how many people hit it. The device
 * line and the screenshot count are included because they are the difference
 * between a report somebody can act on and a report somebody has to go and
 * ask about.
 */
export function digestText(rows, { day, siteUrl = '' } = {}) {
  const today = rows.filter((r) => r.on_day === day);
  const open = rows.filter((r) => r.on_day !== day && ['new', 'planned'].includes(r.state));

  /**
   * Worst first — with one adjustment that matters.
   *
   * A report that enough people have said they hit is ordered one band
   * higher than its own severity, because that is precisely what the
   * threshold means: somebody calling their own fault เรื่องเล็ก is being
   * modest about their afternoon, and six people saying they hit the same
   * thing is a fact about the fair. One band, never more, so volume can
   * promote a small bug above a middling one but can never put it above a
   * genuine ใช้งานไม่ได้เลย. Votes then break ties inside a band.
   */
  const rank = (r) => {
    const sev = SEVERITIES.indexOf(r.severity);
    const crowded = Number(r.votes || 0) >= NUDGE_AT;
    return Math.max(0, sev - (crowded ? 1 : 0)) * 1000 - Number(r.votes || 0);
  };
  const order = (list) => [...list].sort((a, b) => rank(a) - rank(b));

  const lines = [];
  lines.push(`สรุปรายงานปัญหาและข้อเสนอ · ${day}`);
  lines.push(`ระบบ: ${siteUrl || 'CUFTM'}`);
  lines.push('');

  const block = (heading, list) => {
    lines.push(`## ${heading} (${list.length})`);
    if (!list.length) {
      lines.push('— ไม่มี');
      lines.push('');
      return;
    }
    for (const r of order(list)) {
      const head = [
        r.code || r.id,
        r.kind === 'bug' ? 'BUG' : 'IDEA',
        SEV_TH[r.severity] || r.severity,
        STATE_TH[r.state] || r.state,
      ].join(' · ');
      lines.push(`### ${head}`);
      lines.push(`เรื่อง: ${r.title}`);
      if (Number(r.votes || 0) > 1) lines.push(`เจอเหมือนกัน: ${r.votes} คน`);
      if (r.doing) lines.push(`ตอนนั้นกำลัง: ${r.doing}`);
      if (r.body) lines.push(`รายละเอียด: ${r.body}`);
      if (r.page) lines.push(`หน้า: ${r.page}`);
      if (r.device) lines.push(`เครื่อง: ${r.device}`);
      if (r.app_version) lines.push(`เวอร์ชัน: ${r.app_version}`);
      if (Number(r.shots || 0)) lines.push(`มีภาพหน้าจอ ${r.shots} รูป (เปิดดูในหน้ารายงาน)`);
      if (r.dup_of) lines.push(`ซ้ำกับ: ${r.dup_of}`);
      if (r.note) lines.push(`บันทึกของแอดมิน: ${r.note}`);
      lines.push(`แจ้งโดย: ${r.created_by}`);
      lines.push('');
    }
  };

  block('ของวันนี้', today);
  block('ยังค้างอยู่จากก่อนหน้านี้', open);

  const urgent = rows.filter((r) => r.severity === 'urgent' && ['new', 'planned'].includes(r.state));
  lines.push(`## สรุป`);
  lines.push(`เข้ามาวันนี้ ${today.length} เรื่อง · ค้างอยู่ทั้งหมด ${open.length + today.filter((r) => ['new', 'planned'].includes(r.state)).length} เรื่อง · ด่วน ${urgent.length} เรื่อง`);

  return lines.join('\n');
}

/**
 * The rows the summary is built from.
 *
 * `on_day` is worked out in Bangkok time by the database rather than from a
 * timestamp in the page, because "today" has to mean the same day to everybody
 * reading the summary — and a report filed at half past midnight belongs to the
 * day it was filed, not to whatever day it is where the laptop is.
 */
export async function digestRows(sql, day) {
  return sql`
    SELECT r.*,
           (r.created_at AT TIME ZONE 'Asia/Bangkok')::date::text AS on_day,
           (SELECT count(*)::int FROM report_votes v WHERE v.report_id = r.id) AS votes,
           (SELECT count(*)::int FROM report_files f WHERE f.report_id = r.id) AS shots
      FROM reports r
     WHERE (r.created_at AT TIME ZONE 'Asia/Bangkok')::date = ${day}::date
        OR r.state IN ('new', 'planned')
     ORDER BY r.created_at DESC
     LIMIT 500`;
}
