/**
 * The shelf: important links, in folders inside folders.
 *
 * Every committee keeps its paperwork the same way — a pinned LINE message
 * with fourteen Drive URLs in it — and it fails the same way every year. The
 * template everybody needs is the eleventh line of a message from September,
 * so people stop looking and ask in the group chat instead, and somebody
 * answers with the link, and next week somebody else asks again.
 *
 * So: folders, like Drive, because that is the shape people already think in.
 * A folder holds links and other folders, to any depth this module allows.
 *
 * Two decisions worth stating.
 *
 * **One table for folders and links.** `kind` tells them apart and
 * `parent_id` points at the folder above. That is what makes moving things
 * free — dragging a whole folder of แบบฟอร์ม into another folder is one
 * UPDATE of one column, exactly like moving a single link.
 *
 * **A branch can belong to one ฝ่าย.** `department` null means the whole
 * committee; set, it means that ฝ่าย and anybody who can see across ฝ่าย.
 * อำนวยการ 2's internal paperwork does not belong on everybody's shelf, and
 * without this the shelf fills up with other people's folders until it is as
 * unusable as the pinned message was.
 */

import { ACCESS } from './auth.js';
import { isDepartment } from './departments.js';
import { accessSet, seesEverything, safeUrl } from './scope.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const KINDS = ['folder', 'link'];

/**
 * How deep folders may go.
 *
 * Not a technical limit — the table would happily nest forever. It is a limit
 * on how lost somebody can get: six levels is deeper than any committee's
 * paperwork actually is, and past that the breadcrumb no longer fits on a
 * phone, which is the point at which a filing system stops helping.
 */
export const MAX_DEPTH = 6;

/** Enough for a committee's whole paperwork, few enough to load in one query. */
export const MAX_NODES = 600;

const clip = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clipLines = (v, max) =>
  String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * Who may put something on the shelf.
 *
 * Anybody who may create work. A member is excluded for the same reason they
 * cannot create a task: a link on the committee's shelf is a published thing
 * that the rest of the committee will trust, and publishing under the
 * committee's name is not a member's to do alone. They can still read all of
 * it, which is the part that matters to them.
 */
export const canAddToShelf = (user) => Boolean(user) && user.access !== ACCESS.INNER;

/**
 * Whether this person may see this node.
 *
 * A node with no department is everybody's. A node scoped to a ฝ่าย is for
 * the people in it, plus anybody who sees across ฝ่าย anyway (Editor and
 * above, per canSeeTask's rule — a ประธานฝ่าย needs to know what the other
 * ฝ่าย are working to).
 */
export function canSeeNode(user, node) {
  if (!user) return false;
  if (!node.department) return true;
  if (seesEverything(user) || accessSet(user).has(node.department)) return true;
  return node.created_by === user.username;
}

/**
 * Who may rename, move or re-scope a node.
 *
 * Whoever put it there, plus admins. Deliberately NOT everybody who may add:
 * a shelf where any Editor can rewrite any other ฝ่าย's folder is a shelf
 * that gets quietly reorganised by whoever last had an opinion.
 */
export function canEditNode(user, node) {
  if (!user || !node) return false;
  if (user.access === ACCESS.ADMIN || user.access === ACCESS.COADMIN) return true;
  return node.created_by === user.username;
}

/**
 * Deleting a folder takes everything under it — the database cascades.
 *
 * So a folder that is not empty is admins-only even for the person who made
 * it: by then other people have filed things in it, and losing somebody
 * else's links to a tidy-up is not recoverable.
 */
export function canDeleteNode(user, node, childCount) {
  if (!user || !node) return false;
  if (user.access === ACCESS.ADMIN || user.access === ACCESS.COADMIN) return true;
  if (node.created_by !== user.username) return false;
  return node.kind === 'link' || !childCount;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The whole shelf in one query, filtered to what this person may see.
 *
 * One request rather than a request per folder. A few hundred rows of titles
 * and URLs is a handful of kilobytes, and having all of it means opening a
 * folder, going back, and following a breadcrumb are instant — which is the
 * difference between a filing system people browse and one they avoid.
 *
 * A node whose PARENT is hidden is dropped too, however permissive its own
 * scope: a link inside อำนวยการ 2's folder is inside that folder, and
 * showing it loose at the root would be a leak dressed up as a convenience.
 */
export function visibleTree(rows, user) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const allowed = new Set();

  const ok = (node, seen = new Set()) => {
    if (!node) return false;
    if (allowed.has(node.id)) return true;
    // A cycle should be impossible, but a self-referencing row must not hang.
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    if (!canSeeNode(user, node)) return false;
    if (node.parent_id && !ok(byId.get(node.parent_id), seen)) return false;
    allowed.add(node.id);
    return true;
  };

  return rows.filter((r) => ok(r));
}

export function shapeNode(row, user, childCount = 0) {
  return {
    id: row.id,
    parentId: row.parent_id || null,
    kind: row.kind,
    title: row.title,
    note: row.note,
    url: row.url,
    icon: row.icon || '',
    colour: row.colour || '',
    department: row.department || null,
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // How many things are in a folder, so it can say so without opening it.
    count: childCount,
    mayEdit: canEditNode(user, row),
    mayDelete: canDeleteNode(user, row, childCount),
  };
}

export async function allNodes(sql) {
  return sql`
    SELECT * FROM doc_links
     ORDER BY position, lower(title)
     LIMIT ${MAX_NODES}`;
}

/** How deep a node sits, counting the root as 0. */
export function depthOf(byId, parentId) {
  let depth = 0;
  let at = parentId;
  const seen = new Set();
  while (at && !seen.has(at)) {
    seen.add(at);
    depth++;
    at = byId.get(at)?.parent_id || null;
    if (depth > MAX_DEPTH + 2) break;
  }
  return depth;
}

/** Whether `maybeChild` is inside `node` — the check that stops a folder being moved into itself. */
export function isDescendant(byId, nodeId, maybeChild) {
  let at = maybeChild;
  const seen = new Set();
  while (at && !seen.has(at)) {
    if (at === nodeId) return true;
    seen.add(at);
    at = byId.get(at)?.parent_id || null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Reads what somebody typed into a node, or says what is wrong with it.
 *
 * `existing` is the row being edited, so a PATCH can send one field. The URL
 * goes through the app's own `safeUrl`, which is what keeps a `javascript:`
 * address off a shelf that the whole committee clicks without looking.
 */
export function readNode(input, { existing = null, user = null } = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : (existing?.kind || 'link');

  const title = input.title !== undefined ? clip(input.title, 120) : existing?.title;
  if (!title) return { error: 'TITLE_REQUIRED' };

  let url = existing?.url || '';
  if (input.url !== undefined) {
    const raw = clip(input.url, 1000);
    if (kind === 'link') {
      if (!raw) return { error: 'URL_REQUIRED' };
      const safe = safeUrl(raw);
      if (!safe) return { error: 'BAD_URL' };
      url = safe;
    } else {
      // A folder may carry no address. Set one by mistake and it is dropped
      // rather than kept invisibly, so converting a link to a folder is clean.
      url = '';
    }
  }
  if (kind === 'link' && !url) return { error: 'URL_REQUIRED' };
  if (kind === 'folder') url = '';

  let department = existing?.department || null;
  if (input.department !== undefined) {
    const key = clip(input.department, 40);
    if (!key) department = null;
    else if (!isDepartment(key)) return { error: 'NO_SUCH_DEPARTMENT' };
    else {
      /**
       * Somebody may only scope a branch to a ฝ่าย they are actually in.
       *
       * Otherwise "put this in อำนวยการ 2's folder" becomes a way to hide a
       * link from everybody including อำนวยการ 2, who never asked for it.
       */
      if (user && !seesEverything(user) && !accessSet(user).has(key)) {
        return { error: 'NOT_YOUR_DEPARTMENT' };
      }
      department = key;
    }
  }

  return {
    node: {
      kind,
      title,
      url,
      department,
      note: input.note !== undefined ? clipLines(input.note, 600) : (existing?.note || ''),
      icon: input.icon !== undefined ? clip(input.icon, 8) : (existing?.icon || ''),
      colour: input.colour !== undefined ? clip(input.colour, 16) : (existing?.colour || ''),
    },
  };
}

export async function addNode(sql, user, input, byId) {
  const parentId = clip(input.parentId, 64) || null;
  if (parentId) {
    const parent = byId.get(parentId);
    if (!parent) return { error: 'NO_SUCH_FOLDER' };
    if (parent.kind !== 'folder') return { error: 'NOT_A_FOLDER' };
    if (!canSeeNode(user, parent)) return { error: 'NO_SUCH_FOLDER' };
    if (depthOf(byId, parentId) >= MAX_DEPTH) return { error: 'TOO_DEEP', limit: MAX_DEPTH };
  }

  const read = readNode(input, { user });
  if (read.error) return { error: read.error };

  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM doc_links`;
  if (n >= MAX_NODES) return { error: 'SHELF_FULL', limit: MAX_NODES };

  /**
   * A new thing goes at the end of its folder rather than the top.
   *
   * The order on a shelf is usually the order somebody put things there, and
   * a system that silently pushes the newest to the front reorders a folder
   * every time anybody adds to it.
   */
  const [{ last }] = parentId
    ? await sql`SELECT COALESCE(max(position), 0)::int AS last FROM doc_links WHERE parent_id = ${parentId}`
    : await sql`SELECT COALESCE(max(position), 0)::int AS last FROM doc_links WHERE parent_id IS NULL`;

  const id = newId('dl');
  const node = read.node;
  await sql`
    INSERT INTO doc_links (id, parent_id, kind, title, note, url, icon, colour, department, position, created_by)
    VALUES (${id}, ${parentId}, ${node.kind}, ${node.title}, ${node.note}, ${node.url},
            ${node.icon}, ${node.colour}, ${node.department}, ${last + 1}, ${user.username})`;

  const [row] = await sql`SELECT * FROM doc_links WHERE id = ${id}`;
  return { node: row };
}

export async function editNode(sql, user, existing, input, byId) {
  const read = readNode(input, { existing, user });
  if (read.error) return { error: read.error };
  const node = read.node;

  /** Moving it. `parentId: null` means out to the root. */
  let parentId = existing.parent_id || null;
  if (input.parentId !== undefined) {
    const wanted = clip(input.parentId, 64) || null;
    if (wanted) {
      const parent = byId.get(wanted);
      if (!parent) return { error: 'NO_SUCH_FOLDER' };
      if (parent.kind !== 'folder') return { error: 'NOT_A_FOLDER' };
      if (!canSeeNode(user, parent)) return { error: 'NO_SUCH_FOLDER' };
      // A folder cannot be moved inside itself, or inside its own child —
      // which would cut that whole branch off the shelf for good.
      if (wanted === existing.id || isDescendant(byId, existing.id, wanted)) {
        return { error: 'CANNOT_MOVE_INTO_ITSELF' };
      }
      if (depthOf(byId, wanted) >= MAX_DEPTH) return { error: 'TOO_DEEP', limit: MAX_DEPTH };
    }
    parentId = wanted;
  }

  await sql`
    UPDATE doc_links
       SET parent_id = ${parentId}, kind = ${node.kind}, title = ${node.title},
           note = ${node.note}, url = ${node.url}, icon = ${node.icon},
           colour = ${node.colour}, department = ${node.department}, updated_at = now()
     WHERE id = ${existing.id}`;

  const [row] = await sql`SELECT * FROM doc_links WHERE id = ${existing.id}`;
  return { node: row };
}

/** How many things are directly inside each folder. */
export async function childCounts(sql) {
  const rows = await sql`
    SELECT parent_id, count(*)::int AS n FROM doc_links
     WHERE parent_id IS NOT NULL GROUP BY parent_id`;
  const out = {};
  for (const r of rows) out[r.parent_id] = r.n;
  return out;
}

/** Everything inside a folder, at any depth — what deleting it would take. */
export function descendantsOf(rows, id) {
  const kids = new Map();
  for (const r of rows) {
    if (!r.parent_id) continue;
    if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
    kids.get(r.parent_id).push(r);
  }
  const out = [];
  const walk = (at, seen = new Set()) => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const child of kids.get(at) || []) {
      out.push(child);
      walk(child.id, seen);
    }
  };
  walk(id);
  return out;
}
