import { guessFromPosition, parseDepartmentList } from './departments.js';
import { normaliseAccess, setDepartments } from './auth.js';

/**
 * Pulls the roster from the Google Sheet.
 *
 * The sheet is the master list for membership and access. It is read through
 * the plain CSV export, which works with no Google credentials at all as long
 * as the sheet's link sharing is on — so there is no service account, no API
 * key, and nothing to rotate.
 *
 * Requires the sheet to be shared as at least "Anyone with the link → Viewer".
 * Viewer is enough, and Viewer is what it should be: with Editor, anyone
 * holding the link could grant themselves Admin in this app.
 */

export const SHEET_ID =
  process.env.SHEET_ID || '1Qz0hEyyaqVPDdX25YBcHFj9Q_o1OeY4kZ-JOh654Y5U';

const csvUrl = (id) =>
  `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=0`;

/** A real CSV reader: handles quoted fields, escaped quotes and newlines inside cells. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const headerIndex = (header, ...names) => {
  const lower = header.map((h) => String(h).trim().toLowerCase());
  for (const name of names) {
    const i = lower.indexOf(String(name).toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
};

/** Sheet text may carry markdown escaping (`Jade\_Pres`) when copied around. */
const clean = (value) => String(value ?? '').replace(/\\([_*~`])/g, '$1').trim();

export function rowsToPeople(rows) {
  if (!rows.length) return [];

  // The header is not always the first line — find it.
  let headerAt = rows.findIndex((r) => headerIndex(r, 'username') !== -1);
  if (headerAt === -1) return [];

  const header = rows[headerAt];
  const col = {
    nickname: headerIndex(header, 'ชื่อเล่น', 'nickname'),
    username: headerIndex(header, 'username'),
    display: headerIndex(header, 'display name', 'displayname'),
    position: headerIndex(header, 'ตำแหน่ง', 'position', 'role'),
    access: headerIndex(header, 'access'),
    department: headerIndex(header, 'department', 'ฝ่าย', 'departments', 'category'),
  };
  if (col.username === -1) return [];

  const people = [];
  const seen = new Set();

  for (let i = headerAt + 1; i < rows.length; i++) {
    const row = rows[i];
    const username = clean(row[col.username]);
    if (!username) continue;

    const key = username.toLowerCase();
    if (seen.has(key)) continue; // a duplicate row must not overwrite the first
    seen.add(key);

    const position = col.position === -1 ? '' : clean(row[col.position]);
    const deptCell = col.department === -1 ? '' : clean(row[col.department]);
    const parsed = parseDepartmentList(deptCell);

    // A blank Department cell falls back to reading the ตำแหน่ง text, so a row
    // added in a hurry still lands somewhere sensible.
    const guessed = parsed.all || parsed.keys.length ? null : guessFromPosition(position).department;

    people.push({
      username,
      nickname: col.nickname === -1 ? '' : clean(row[col.nickname]),
      sheetName: col.display === -1 ? username : clean(row[col.display]) || username,
      position,
      access: normaliseAccess(col.access === -1 ? '' : clean(row[col.access])),
      departmentCell: deptCell,
      allDepartments: parsed.all,
      departments: parsed.keys.length ? parsed.keys : (guessed ? [guessed] : []),
      unknownDepartments: parsed.unknown,
    });
  }
  return people;
}

export async function fetchPeople(sheetId = SHEET_ID) {
  const res = await fetch(csvUrl(sheetId), { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `Could not read the sheet (HTTP ${res.status}). Check that its sharing is set to ` +
        '"Anyone with the link" with at least Viewer access.',
    );
  }
  const text = await res.text();

  // A sign-in page instead of CSV means the sheet is not link-shared.
  if (/<html/i.test(text.slice(0, 200))) {
    throw new Error(
      'The sheet is not readable without signing in. Set its sharing to ' +
        '"Anyone with the link → Viewer" and try again.',
    );
  }
  return rowsToPeople(parseCsv(text));
}

/**
 * Writes the roster into the database.
 *
 * What the sheet owns: who exists, their access level, position, nickname, and
 * department access — until an admin overrides someone's access in the app,
 * after which that person's departments are left alone.
 * What the app owns and sync must never trample: passwords, profile pictures,
 * language choice, and the suspended flag.
 *
 * A display name the person has personalised is also left alone — it only
 * follows the sheet while it still matches what the sheet last said.
 */
export async function syncPeople(sql, people) {
  if (!people.length) {
    throw new Error('The sheet produced no usable rows; nothing was changed.');
  }

  let added = 0;
  let updated = 0;
  let pinned = 0;
  const unreadable = [];

  for (const person of people) {
    if (person.unknownDepartments.length) {
      unreadable.push({ username: person.username, cells: person.unknownDepartments });
    }

    const [existing] = await sql`SELECT * FROM users WHERE lower(username) = ${person.username.toLowerCase()}`;
    const guess = guessFromPosition(person.position);

    if (!existing) {
      await sql`
        INSERT INTO users (username, nickname, sheet_name, display_name, position, access,
                           department, all_departments, is_head, active)
        VALUES (${person.username}, ${person.nickname}, ${person.sheetName}, ${person.sheetName},
                ${person.position}, ${person.access}, ${person.departments[0] ?? null},
                ${person.allDepartments}, ${guess.isHead}, true)
      `;
      await setDepartments(sql, person.username, person.departments);
      added++;
      continue;
    }

    const keepsOwnName =
      existing.display_name && existing.display_name !== existing.sheet_name;

    /**
     * is_head is left exactly as it is on an update. The sheet has no column
     * for it — it is only ever guessed from the ตำแหน่ง text when a row is
     * first seen — so a sync has no opinion to impose, and the tick box on the
     * admin page is the one place it changes after that.
     */

    await sql`
      UPDATE users SET
        nickname     = ${person.nickname},
        sheet_name   = ${person.sheetName},
        display_name = ${keepsOwnName ? existing.display_name : person.sheetName},
        position     = ${person.position},
        access       = ${person.access},
        is_head      = ${existing.is_head},
        active       = true,
        updated_at   = now()
      WHERE username = ${existing.username}
    `;

    /**
     * Department access follows the sheet — unless an admin has changed it in
     * the app, which sets depts_pinned. Overwriting that would make the admin
     * page a lie: the change would appear to work and then vanish at the next
     * sync, with nothing on screen to explain why.
     */
    if (existing.depts_pinned) {
      pinned++;
    } else {
      await sql`UPDATE users SET all_departments = ${person.allDepartments}
                WHERE username = ${existing.username}`;
      await setDepartments(sql, existing.username, person.departments);
    }
    updated++;
  }

  // Anyone no longer listed loses access, but their account and history remain.
  const names = people.map((p) => p.username.toLowerCase());
  const deactivated = await sql`
    UPDATE users SET active = false, updated_at = now()
    WHERE active = true AND lower(username) <> ALL(${names})
    RETURNING username
  `;

  await sql`
    INSERT INTO meta (key, value) VALUES ('last_sync', ${new Date().toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;

  return {
    added,
    updated,
    pinned,
    unreadable,
    deactivated: deactivated.map((r) => r.username),
  };
}
