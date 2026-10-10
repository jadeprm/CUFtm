/**
 * Spaces — working groups that are not departments.
 *
 *   GET    /api/tasks?do=spaces           the spaces I am in (admins: all)
 *   POST   /api/tasks?do=space            start one
 *   PATCH  /api/tasks?do=space            rename, recolour, change who is in it
 *   DELETE /api/tasks?do=space&id=…       archive it (its tasks stay, unfiled)
 *   POST   /api/tasks?do=space-leave      take myself off one
 *
 * Rides on /api/tasks because the Hobby plan's twelve functions are all in
 * use, and a space is mostly a way of looking at tasks anyway.
 *
 * Who is in a space: the person who started it, everyone listed by name, and
 * — when departments are listed — everybody whose home department (or, with
 * a section given, home section) matches. Membership is what lets someone
 * see the tasks filed into the space, on top of whatever their department
 * already lets them see; it never hides anything they could see before.
 */
import { DEPARTMENT_KEYS, matchUnit } from './departments.js';
import { seesEverything } from './scope.js';

export const SPACE_COLOURS = ['pink', 'indigo', 'teal', 'amber', 'violet', 'green', 'blue', 'red'];
const MAX_SPACES_PER_PERSON = 40;

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const newId = () => `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The members' departments as {key, unit} pairs the chart actually has. */
export function readSpaceDepartments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value.slice(0, 30)) {
    const key = clean(raw && (raw.key ?? raw.department ?? raw), 32);
    if (!DEPARTMENT_KEYS.includes(key)) continue;
    const unit = raw && raw.unit ? (matchUnit(key, raw.unit) || '') : '';
    const id = key + '|' + unit;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, unit });
  }
  return out;
}

/** May this person change the space — its name, colour and members? */
export function canManageSpace(user, space) {
  if (!user || !space) return false;
  if (seesEverything(user)) return true;
  if (space.createdBy === user.username) return true;
  return (space.members || []).some((m) => m.username === user.username && m.role === 'owner');
}

/** Is this person in the space, by name or through their department? */
export function inSpace(user, space) {
  if (!user || !space || space.archived) return false;
  if (space.createdBy === user.username) return true;
  if ((space.members || []).some((m) => m.username === user.username)) return true;
  return (space.departments || []).some((d) =>
    d.key === user.department && (!d.unit || d.unit === (user.unit || '')));
}

/** Every space, with its people, its departments and how much is in it. */
export async function allSpaces(sql) {
  const rows = await sql`
    SELECT s.*,
      COALESCE((SELECT json_agg(json_build_object('username', m.username, 'role', m.role) ORDER BY m.added_at)
                FROM space_members m WHERE m.space_id = s.id), '[]') AS people,
      COALESCE((SELECT json_agg(json_build_object('key', d.department, 'unit', d.unit))
                FROM space_departments d WHERE d.space_id = s.id), '[]') AS depts,
      (SELECT count(*) FROM tasks t WHERE t.space_id = s.id AND t.status <> 'done')::int AS open_tasks,
      (SELECT count(*) FROM tasks t WHERE t.space_id = s.id AND t.status = 'done')::int AS done_tasks
    FROM spaces s
    WHERE s.archived = false
    ORDER BY lower(s.name)`;
  const arr = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v) || []; } catch { return []; } })());
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description || '',
    colour: SPACE_COLOURS.includes(s.colour) ? s.colour : 'pink',
    icon: s.icon || '',
    createdBy: s.created_by,
    createdAt: s.created_at,
    archived: Boolean(s.archived),
    members: arr(s.people),
    departments: arr(s.depts),
    openTasks: Number(s.open_tasks) || 0,
    doneTasks: Number(s.done_tasks) || 0,
  }));
}

/** The ids of the spaces this person is in — what canSeeTask checks against. */
export async function spaceIdsFor(sql, user) {
  if (!user) return [];
  // Lighter than allSpaces: no counts, and only the spaces that could match.
  const rows = await sql`
    SELECT s.id FROM spaces s
    WHERE s.archived = false AND (
      s.created_by = ${user.username}
      OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.username = ${user.username})
      OR EXISTS (SELECT 1 FROM space_departments d WHERE d.space_id = s.id
                 AND d.department = ${user.department || ''}
                 AND (d.unit = '' OR d.unit = ${user.unit || ''})))`;
  return rows.map((r) => r.id);
}

/** Who is in a space, as usernames, given the roster. */
export function spacePeople(space, roster = []) {
  const out = new Set([space.createdBy, ...(space.members || []).map((m) => m.username)]);
  for (const p of roster) {
    if ((space.departments || []).some((d) => d.key === p.department && (!d.unit || d.unit === (p.unit || '')))) {
      out.add(p.username);
    }
  }
  return [...out].filter(Boolean);
}

async function writeMembers(sql, id, members, owner) {
  const wanted = new Map();
  for (const m of (Array.isArray(members) ? members : []).slice(0, 200)) {
    const username = clean(m && (m.username ?? m), 64);
    if (!username) continue;
    wanted.set(username, m && m.role === 'owner' ? 'owner' : 'member');
  }
  wanted.set(owner, 'owner');
  const names = [...wanted.keys()];
  const real = (await sql`SELECT username FROM users WHERE username = ANY(${names})`).map((r) => r.username);
  await sql`DELETE FROM space_members WHERE space_id = ${id} AND username <> ALL(${real})`;
  for (const username of real) {
    await sql`
      INSERT INTO space_members (space_id, username, role) VALUES (${id}, ${username}, ${wanted.get(username)})
      ON CONFLICT (space_id, username) DO UPDATE SET role = EXCLUDED.role`;
  }
}

async function writeDepartments(sql, id, departments) {
  await sql`DELETE FROM space_departments WHERE space_id = ${id}`;
  for (const d of departments) {
    await sql`INSERT INTO space_departments (space_id, department, unit) VALUES (${id}, ${d.key}, ${d.unit})
              ON CONFLICT DO NOTHING`;
  }
}

async function listFor(sql, me) {
  const all = await allSpaces(sql);
  const everything = seesEverything(me);
  return all
    .filter((s) => everything || inSpace(me, s))
    .map((s) => ({ ...s, mine: inSpace(me, s), mayManage: canManageSpace(me, s) }));
}

export async function handleSpaces(sql, me, request, url, json) {
  const action = url.searchParams.get('do');

  if (action === 'spaces' && request.method === 'GET') {
    return json({ spaces: await listFor(sql, me), colours: SPACE_COLOURS });
  }

  if (action === 'space-leave' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = clean(body.id, 64);
    const [row] = await sql`SELECT created_by FROM spaces WHERE id = ${id}`;
    if (!row) return json({ error: 'NO_SUCH_SPACE' }, 404);
    // The person who started it cannot walk out and leave it ownerless.
    if (row.created_by === me.username) return json({ error: 'OWNER_CANNOT_LEAVE' }, 400);
    await sql`DELETE FROM space_members WHERE space_id = ${id} AND username = ${me.username}`;
    return json({ ok: true, spaces: await listFor(sql, me) });
  }

  if (action !== 'space') return json({ error: 'METHOD' }, 405);

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = clean(body.name, 80);
    if (!name) return json({ error: 'NAME_REQUIRED' }, 400);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM spaces WHERE created_by = ${me.username} AND archived = false`;
    if (n >= MAX_SPACES_PER_PERSON) return json({ error: 'TOO_MANY_SPACES' }, 400);

    const id = newId();
    await sql`
      INSERT INTO spaces (id, name, description, colour, icon, created_by)
      VALUES (${id}, ${name}, ${clean(body.description, 500)},
              ${SPACE_COLOURS.includes(body.colour) ? body.colour : 'pink'},
              ${clean(body.icon, 4)}, ${me.username})`;
    await writeMembers(sql, id, body.members, me.username);
    await writeDepartments(sql, id, readSpaceDepartments(body.departments));
    const spaces = await listFor(sql, me);
    return json({ ok: true, id, space: spaces.find((s) => s.id === id), spaces }, 201);
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const id = clean(body.id, 64);
    const space = (await allSpaces(sql)).find((s) => s.id === id);
    if (!space) return json({ error: 'NO_SUCH_SPACE' }, 404);
    if (!canManageSpace(me, space)) return json({ error: 'NOT_SPACE_OWNER' }, 403);

    await sql`
      UPDATE spaces SET
        name        = COALESCE(${body.name === undefined ? null : (clean(body.name, 80) || null)}, name),
        description = COALESCE(${body.description === undefined ? null : clean(body.description, 500)}, description),
        colour      = COALESCE(${SPACE_COLOURS.includes(body.colour) ? body.colour : null}, colour),
        icon        = COALESCE(${body.icon === undefined ? null : clean(body.icon, 4)}, icon),
        updated_at  = now()
      WHERE id = ${id}`;
    if (body.members !== undefined) await writeMembers(sql, id, body.members, space.createdBy);
    if (body.departments !== undefined) await writeDepartments(sql, id, readSpaceDepartments(body.departments));
    const spaces = await listFor(sql, me);
    return json({ ok: true, space: spaces.find((s) => s.id === id), spaces });
  }

  if (request.method === 'DELETE') {
    const id = clean(url.searchParams.get('id'), 64);
    const space = (await allSpaces(sql)).find((s) => s.id === id);
    if (!space) return json({ error: 'NO_SUCH_SPACE' }, 404);
    if (!canManageSpace(me, space)) return json({ error: 'NOT_SPACE_OWNER' }, 403);
    // Archived rather than deleted: the tasks in it are real work and keep
    // existing; they simply stop being filed anywhere.
    await sql`UPDATE spaces SET archived = true, updated_at = now() WHERE id = ${id}`;
    await sql`UPDATE tasks SET space_id = NULL WHERE space_id = ${id}`;
    await sql`UPDATE meetings SET space_id = NULL WHERE space_id = ${id}`;
    return json({ ok: true, spaces: await listFor(sql, me) });
  }

  return json({ error: 'METHOD' }, 405);
}
