import { getSql } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';
import { isDepartment, matchUnit } from '../lib/departments.js';
import {
  proposeChain, pendingStep, canAct, canReplaceFile, canSeeDocument,
  progressOf, progressFraction, signsPdf, isSecretary, ROLE_TH,
} from '../lib/approval.js';
import {
  stampSignatures, pageCount, looksLikePdf, looksLikePng, pngSize,
} from '../lib/pdfsign.js';
import { sendToMany, unreadCount } from '../lib/push.js';
import { lineConfigured, push as linePush, text as lineText, pageLink } from '../lib/line.js';

/**
 * Documents that need signing.
 *
 *   GET  /api/documents              everything I am allowed to see
 *   GET  /api/documents?id=…         one document, its chain and its history
 *   GET  /api/documents?id=…&file=…  the PDF itself, original or signed
 *   POST /api/documents?do=propose   who would have to sign this
 *   POST /api/documents?do=create    upload, with the signature boxes marked
 *   POST /api/documents?do=approve   sign it, and stamp it if the role signs
 *   POST /api/documents?do=reject    send it back with a reason
 *   POST /api/documents?do=replace   put a corrected file in, keeping the chain
 *   POST /api/documents?do=send      the secretary marks it sent
 *   POST /api/documents?do=signature save my own signature
 *   GET  /api/documents?do=signature have I got one
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Three megabytes.
 *
 * The request carries the file base64-encoded, which inflates it by a third,
 * and the platform refuses a body over about 4.5 MB. Refusing a large file
 * here with a clear message beats a request that dies halfway with none.
 */
const MAX_PDF = 3 * 1024 * 1024;
const MAX_PNG = 512 * 1024;

const PRIORITIES = ['low', 'medium', 'high', 'highest'];
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const clean = (v, max = 400) => String(v ?? '').trim().slice(0, max);

/** bytea comes back as a Buffer, or as a \\x… string depending on the driver. */
function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const text = String(value);
  if (text.startsWith('\\x')) return Buffer.from(text.slice(2), 'hex');
  return Buffer.from(text, 'binary');
}

function fromBase64(value, limit) {
  const raw = String(value || '').replace(/^data:[^,]*,/, '');
  if (!raw) return { error: 'EMPTY_FILE' };
  let buffer;
  try { buffer = Buffer.from(raw, 'base64'); } catch { return { error: 'BAD_FILE' }; }
  if (!buffer.length) return { error: 'EMPTY_FILE' };
  if (buffer.length > limit) return { error: 'FILE_TOO_BIG', size: buffer.length, limit };
  return { buffer };
}

async function handler(request) {
  const url = new URL(request.url, 'https://placeholder.local');
  const action = url.searchParams.get('do') || '';
  const id = url.searchParams.get('id') || '';
  const { sql, ready } = getSql();
  await ready;

  const me = await currentUser(request, sql);
  if (!me) return json({ error: 'NOT_SIGNED_IN' }, 401);

  if (request.method === 'GET') {
    if (action === 'signature') return mySignature(sql, me);
    if (id && url.searchParams.get('file')) {
      return downloadFile(sql, me, id, url.searchParams.get('file'));
    }
    if (id) return oneDocument(sql, me, id);
    return listDocuments(sql, me);
  }

  if (request.method !== 'POST') return json({ error: 'UNKNOWN_ACTION' }, 400);
  const body = await request.json().catch(() => ({}));

  switch (action) {
    case 'signature': return saveSignature(sql, me, body);
    case 'propose':   return propose(sql, me, body);
    case 'create':    return createDocument(sql, me, body);
    case 'approve':   return approve(sql, me, body);
    case 'reject':    return reject(sql, me, body);
    case 'replace':   return replaceFile(sql, me, body);
    case 'send':      return markSent(sql, me, body);
    default:          return json({ error: 'UNKNOWN_ACTION' }, 400);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const rosterFor = (sql) => sql`
  SELECT u.username, u.display_name, u.nickname, u.position, u.access,
         u.department, u.unit, u.is_head, u.active, u.suspended,
         COALESCE((SELECT json_agg(d.department) FROM user_departments d
                   WHERE d.username = u.username), '[]') AS depts
  FROM users u WHERE u.active = true AND u.suspended = false`;

const asPeople = (rows) => rows.map((r) => ({
  ...r,
  departments: Array.isArray(r.depts)
    ? r.depts
    : (() => { try { return JSON.parse(r.depts); } catch { return []; } })(),
}));

const shapeDoc = (d) => ({
  id: d.id,
  title: d.title,
  note: d.note,
  recipient: d.recipient,
  priority: d.priority,
  stage: d.stage,
  department: d.department,
  unit: d.unit,
  createdBy: d.created_by,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
  finishedAt: d.finished_at,
  sentAt: d.sent_at,
  sentBy: d.sent_by,
  driveUrl: d.drive_url,
  archivedAt: d.archived_at,
});

const shapeStep = (s) => ({
  id: s.id,
  position: s.position,
  role: s.role,
  roleLabel: ROLE_TH[s.role] || s.role,
  username: s.username,
  state: s.state,
  actedAt: s.acted_at,
  comment: s.comment,
  signs: signsPdf(s.role),
  mark: s.x === null ? null : { page: s.page, x: s.x, y: s.y, w: s.w, h: s.h },
});

async function listDocuments(sql, me) {
  const docs = await sql`SELECT * FROM documents ORDER BY updated_at DESC LIMIT 200`;
  const steps = await sql`SELECT * FROM doc_steps ORDER BY doc_id, position`;
  const byDoc = new Map();
  for (const s of steps) {
    if (!byDoc.has(s.doc_id)) byDoc.set(s.doc_id, []);
    byDoc.get(s.doc_id).push(s);
  }

  const visible = docs
    .filter((d) => canSeeDocument(me, d, byDoc.get(d.id) || []))
    .map((d) => {
      const mine = byDoc.get(d.id) || [];
      const waiting = pendingStep(mine);
      return {
        ...shapeDoc(d),
        steps: mine.map(shapeStep),
        waitingOn: waiting ? waiting.username : null,
        waitingRole: waiting ? (ROLE_TH[waiting.role] || waiting.role) : null,
        myTurn: canAct(me, d, mine),
        progress: progressFraction(d, mine),
      };
    });

  return json({
    documents: visible,
    isSecretary: isSecretary(me),
    mine: visible.filter((d) => d.myTurn).length,
  });
}

async function oneDocument(sql, me, id) {
  const [doc] = await sql`SELECT * FROM documents WHERE id = ${id}`;
  if (!doc) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const steps = await sql`SELECT * FROM doc_steps WHERE doc_id = ${id} ORDER BY position`;
  if (!canSeeDocument(me, doc, steps)) return json({ error: 'NOT_ALLOWED' }, 403);

  const events = await sql`SELECT * FROM doc_events WHERE doc_id = ${id} ORDER BY at`;
  const files = await sql`SELECT kind, byte_size, pages, updated_at FROM doc_files WHERE doc_id = ${id}`;

  return json({
    document: shapeDoc(doc),
    steps: steps.map(shapeStep),
    events: events.map((e) => ({ id: e.id, at: e.at, kind: e.kind, username: e.username, detail: e.detail })),
    files: files.map((f) => ({ kind: f.kind, size: f.byte_size, pages: f.pages, at: f.updated_at })),
    progress: progressOf(doc, steps),
    fraction: progressFraction(doc, steps),
    myTurn: canAct(me, doc, steps),
    mayReplace: canReplaceFile(me, doc, steps),
    maySend: isSecretary(me) && doc.stage === 'secretary',
  });
}

async function downloadFile(sql, me, id, kind) {
  const want = kind === 'signed' ? 'signed' : 'original';
  const [doc] = await sql`SELECT * FROM documents WHERE id = ${id}`;
  if (!doc) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const steps = await sql`SELECT * FROM doc_steps WHERE doc_id = ${id} ORDER BY position`;
  if (!canSeeDocument(me, doc, steps)) return json({ error: 'NOT_ALLOWED' }, 403);

  const [row] = await sql`SELECT bytes FROM doc_files WHERE doc_id = ${id} AND kind = ${want}`;
  const buffer = toBuffer(row?.bytes);
  if (!buffer) {
    // Cleared after archiving: the copy in Drive is the one that exists now.
    if (doc.drive_url) return json({ error: 'ARCHIVED', driveUrl: doc.drive_url }, 410);
    return json({ error: 'NO_FILE' }, 404);
  }

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(buffer.length),
      'content-disposition': `inline; filename="${encodeURIComponent(doc.title || 'document')}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
}

async function mySignature(sql, me) {
  const [row] = await sql`SELECT width, height, updated_at FROM signatures WHERE username = ${me.username}`;
  return json({ has: Boolean(row), width: row?.width || 0, height: row?.height || 0, at: row?.updated_at || null });
}

async function saveSignature(sql, me, body) {
  const got = fromBase64(body.png, MAX_PNG);
  if (got.error) return json({ error: got.error, limit: got.limit }, 400);
  if (!looksLikePng(got.buffer)) return json({ error: 'NOT_A_PNG' }, 400);

  const size = pngSize(got.buffer);
  await sql`
    INSERT INTO signatures (username, png, width, height, updated_at)
    VALUES (${me.username}, ${got.buffer}, ${size.width}, ${size.height}, now())
    ON CONFLICT (username) DO UPDATE
      SET png = EXCLUDED.png, width = EXCLUDED.width,
          height = EXCLUDED.height, updated_at = now()`;
  return json({ ok: true, width: size.width, height: size.height });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

async function propose(sql, me, body) {
  const people = asPeople(await rosterFor(sql));
  const department = isDepartment(body.department) ? body.department : (me.department || null);
  const unit = department ? matchUnit(department, body.unit) : null;
  const chain = proposeChain(me, { people, department, unit });

  return json({
    department,
    unit,
    steps: chain.map((s) => ({ ...s, roleLabel: ROLE_TH[s.role] || s.role })),
    // Everything needed to let the uploader change who is on it.
    people: people.map((p) => ({
      username: p.username, displayName: p.display_name, nickname: p.nickname,
      position: p.position, department: p.department, unit: p.unit, isHead: p.is_head,
    })),
  });
}

async function createDocument(sql, me, body) {
  const title = clean(body.title, 200);
  if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

  const got = fromBase64(body.pdf, MAX_PDF);
  if (got.error) return json({ error: got.error, limit: got.limit, size: got.size }, 400);
  if (!looksLikePdf(got.buffer)) return json({ error: 'NOT_A_PDF' }, 400);

  const pages = await pageCount(got.buffer);
  if (!pages) return json({ error: 'UNREADABLE_PDF' }, 400);

  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!steps.length) return json({ error: 'NO_APPROVERS' }, 400);

  // Everyone named must exist and be active — a chain pointing at a departed
  // member would stall silently and nobody would know why.
  const people = asPeople(await rosterFor(sql));
  const known = new Set(people.map((p) => p.username));

  // A step nobody was chosen for is a different problem from a step naming
  // somebody who has left, and the person uploading needs to be told which.
  const unchosen = steps.filter((s) => !s.username);
  if (unchosen.length) {
    return json({ error: 'APPROVER_NOT_CHOSEN', roles: unchosen.map((s) => s.role) }, 400);
  }
  const bad = steps.filter((s) => !known.has(s.username));
  if (bad.length) return json({ error: 'UNKNOWN_APPROVER', who: bad.map((s) => s.username) }, 400);

  // Every signing step needs somewhere for the signature to go.
  const missing = steps.filter((s) => signsPdf(s.role) && !s.mark);
  if (missing.length) {
    return json({ error: 'MARK_REQUIRED', who: missing.map((s) => s.username) }, 400);
  }
  const offPage = steps.filter((s) => s.mark && (s.mark.page < 1 || s.mark.page > pages));
  if (offPage.length) return json({ error: 'MARK_OFF_PAGE', pages }, 400);

  const department = isDepartment(body.department) ? body.department : (me.department || null);
  const unit = department ? matchUnit(department, body.unit) : null;
  const id = newId('doc');

  await sql`
    INSERT INTO documents (id, title, note, recipient, priority, stage, department, unit, created_by)
    VALUES (${id}, ${title}, ${clean(body.note, 2000)}, ${clean(body.recipient, 200)},
            ${PRIORITIES.includes(body.priority) ? body.priority : 'medium'},
            'approving', ${department}, ${unit}, ${me.username})`;

  await sql`
    INSERT INTO doc_files (doc_id, kind, bytes, byte_size, pages)
    VALUES (${id}, 'original', ${got.buffer}, ${got.buffer.length}, ${pages})`;

  let position = 0;
  for (const step of steps) {
    position += 1;
    const mark = step.mark || {};
    await sql`
      INSERT INTO doc_steps (id, doc_id, position, role, username, page, x, y, w, h)
      VALUES (${newId('st')}, ${id}, ${position}, ${clean(step.role, 20)}, ${step.username},
              ${Math.max(1, Math.round(mark.page || 1))},
              ${step.mark ? Number(mark.x) : null}, ${step.mark ? Number(mark.y) : null},
              ${step.mark ? Number(mark.w) : null}, ${step.mark ? Number(mark.h) : null})`;
  }

  await note(sql, id, 'created', me.username, title);

  const first = steps[0];
  const watchers = await secretaries(sql);
  await tellPeople(sql, {
    usernames: [first.username, ...watchers],
    docId: id,
    priority: body.priority,
    title: `${urgencyTag(body.priority)}เอกสารรออนุมัติ: ${title}`,
    body: `${me.display_name || me.username} ส่งเอกสารให้คุณลงนาม/อนุมัติ`,
  });

  return json({ ok: true, id, pages }, 201);
}

/**
 * Tells the people who need to know.
 *
 * Three channels, and the order matters: the in-app bell is written FIRST and
 * always, because it is the only one that cannot fail. Push and LINE are best
 * effort on top — a phone that is off, a person who never allowed
 * notifications, or LINE being unreachable must never stop a document
 * advancing or lose the record that it did.
 *
 * Secretaries are copied on everything by design: she asked for them to watch
 * every step, so they are added to the recipients of each event rather than
 * being notified by a separate mechanism that could drift out of step.
 */
async function tellPeople(sql, { usernames, title, body, docId, priority, urgent }) {
  const people = [...new Set(usernames.filter(Boolean))];
  if (!people.length) return { told: 0 };

  const ids = people.map(() => newId('n'));
  await sql`
    INSERT INTO notifications (id, username, task_id, kind, title, body)
    SELECT i, u, ${docId}, 'document', ${clean(title, 200)}, ${clean(body, 500)}
    FROM unnest(${ids}::text[], ${people}::text[]) AS t(i, u)`;

  const link = pageLink('docs');
  const payload = (username) => ({
    id: ids[people.indexOf(username)],
    title: clean(title, 200),
    body: clean(body, 500),
    level: urgent || priority === 'highest' ? 'urgent' : 'normal',
    tag: `doc-${docId}`,
    url: `./#/d/${docId}`,
  });

  try {
    await sendToMany(sql, people, payload);
  } catch (error) {
    console.error('[documents] push failed:', String(error?.message || error).slice(0, 200));
  }

  if (lineConfigured()) {
    try {
      const links = await sql`
        SELECT line_user_id, username FROM line_links WHERE username = ANY(${people})`;
      const lines = [clean(title, 200), clean(body, 500)];
      if (link) lines.push('', `${link.replace(/#\/docs$/, '')}#/d/${docId}`);
      const message = lines.filter(Boolean).join('\n');
      for (const row of links) {
        await linePush(row.line_user_id, lineText(message, ['เอกสาร', 'จบ'])).catch(() => {});
      }
    } catch (error) {
      console.error('[documents] LINE failed:', String(error?.message || error).slice(0, 200));
    }
  }
  return { told: people.length };
}

/** Everyone who watches every document. */
const secretaries = async (sql) => {
  const rows = await sql`
    SELECT DISTINCT u.username FROM users u
    LEFT JOIN user_departments d ON d.username = u.username
    WHERE u.active = true AND u.suspended = false
      AND (u.department = 'secretariat' OR d.department = 'secretariat')`;
  return rows.map((r) => r.username);
};

const PRIORITY_TH = { highest: 'ด่วนที่สุด', high: 'ด่วน', medium: '', low: '' };
const urgencyTag = (priority) => (PRIORITY_TH[priority] ? `[${PRIORITY_TH[priority]}] ` : '');

const note = (sql, docId, kind, username, detail = '') => sql`
  INSERT INTO doc_events (id, doc_id, kind, username, detail)
  VALUES (${newId('ev')}, ${docId}, ${kind}, ${username}, ${clean(detail, 1000)})`;

// ---------------------------------------------------------------------------
// Acting on it
// ---------------------------------------------------------------------------

async function loadFor(sql, id) {
  const [doc] = await sql`SELECT * FROM documents WHERE id = ${id}`;
  if (!doc) return null;
  const steps = await sql`SELECT * FROM doc_steps WHERE doc_id = ${id} ORDER BY position`;
  return { doc, steps };
}

async function approve(sql, me, body) {
  const found = await loadFor(sql, clean(body.id, 64));
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;

  if (!canAct(me, doc, steps)) return json({ error: 'NOT_YOUR_TURN' }, 403);
  const step = pendingStep(steps);

  /**
   * A signing role must actually have a signature on file.
   *
   * Checked before anything is written, so a head without one is told to set
   * it up rather than the document advancing with an empty box where their
   * name should be.
   */
  let signature = null;
  if (signsPdf(step.role)) {
    const [row] = await sql`SELECT png FROM signatures WHERE username = ${me.username}`;
    signature = toBuffer(row?.png);
    if (!signature) return json({ error: 'NO_SIGNATURE' }, 400);
  }

  await sql`
    UPDATE doc_steps SET state = 'approved', acted_at = now(), comment = ${clean(body.comment, 1000)}
    WHERE id = ${step.id}`;

  const after = await sql`SELECT * FROM doc_steps WHERE doc_id = ${doc.id} ORDER BY position`;
  const stamped = await rebuildSigned(sql, doc.id, after);

  const next = pendingStep(after);
  const stage = next ? (next.role === 'secretary' ? 'secretary' : 'approving') : 'done';
  await sql`
    UPDATE documents SET stage = ${stage === 'done' ? 'done' : stage}, updated_at = now(),
      finished_at = ${stage === 'done' ? new Date().toISOString() : null}
    WHERE id = ${doc.id}`;

  await note(sql, doc.id, signsPdf(step.role) ? 'signed' : 'approved', me.username,
    clean(body.comment, 1000));

  const watchers = await secretaries(sql);
  if (next) {
    await tellPeople(sql, {
      usernames: [next.username, ...watchers],
      docId: doc.id,
      priority: doc.priority,
      title: `${urgencyTag(doc.priority)}${next.role === 'secretary' ? 'เอกสารพร้อมส่ง' : 'เอกสารรออนุมัติ'}: ${doc.title}`,
      body: next.role === 'secretary'
        ? 'ลงนามครบแล้ว รอเลขานุการส่งให้ผู้รับ'
        : `${me.display_name || me.username} อนุมัติแล้ว ถึงคิวของคุณ`,
    });
  } else {
    await tellPeople(sql, {
      usernames: [doc.created_by, ...watchers],
      docId: doc.id,
      priority: doc.priority,
      title: `เอกสารอนุมัติครบแล้ว: ${doc.title}`,
      body: 'ลงนามครบทุกขั้นแล้ว',
    });
  }

  return json({
    ok: true,
    stage,
    signaturesPlaced: stamped.placed.length,
    couldNotPlace: stamped.skipped,
    waitingOn: next ? next.username : null,
  });
}

/**
 * Rebuilds the signed PDF from the untouched original.
 *
 * Every time, from scratch, using exactly the approvals recorded right now.
 * Stamping incrementally onto the previous signed copy would mean a mistake
 * could never be undone, and an approval that was reversed would leave its
 * signature behind in the file.
 */
async function rebuildSigned(sql, docId, steps) {
  const [orig] = await sql`SELECT bytes FROM doc_files WHERE doc_id = ${docId} AND kind = 'original'`;
  const original = toBuffer(orig?.bytes);
  if (!original) return { placed: [], skipped: [{ reason: 'NO_ORIGINAL' }] };

  const signing = steps.filter((s) => s.state === 'approved' && signsPdf(s.role) && s.x !== null);
  const marks = [];
  for (const step of signing) {
    const [row] = await sql`SELECT png FROM signatures WHERE username = ${step.username}`;
    const png = toBuffer(row?.png);
    if (!png) continue;
    marks.push({ username: step.username, page: step.page, x: step.x, y: step.y, w: step.w, h: step.h, png });
  }

  if (!marks.length) return { placed: [], skipped: [] };

  const out = await stampSignatures(original, marks);
  await sql`
    INSERT INTO doc_files (doc_id, kind, bytes, byte_size, pages, updated_at)
    VALUES (${docId}, 'signed', ${out.bytes}, ${out.bytes.length}, ${out.pages}, now())
    ON CONFLICT (doc_id, kind) DO UPDATE
      SET bytes = EXCLUDED.bytes, byte_size = EXCLUDED.byte_size,
          pages = EXCLUDED.pages, updated_at = now()`;
  return out;
}

async function reject(sql, me, body) {
  const found = await loadFor(sql, clean(body.id, 64));
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;
  if (!canAct(me, doc, steps)) return json({ error: 'NOT_YOUR_TURN' }, 403);

  const comment = clean(body.comment, 1000);
  if (!comment) return json({ error: 'REASON_REQUIRED' }, 400);

  const step = pendingStep(steps);
  await sql`UPDATE doc_steps SET state = 'rejected', acted_at = now(), comment = ${comment}
            WHERE id = ${step.id}`;
  await sql`UPDATE documents SET stage = 'rejected', updated_at = now() WHERE id = ${doc.id}`;
  await note(sql, doc.id, 'rejected', me.username, comment);

  /**
   * The reason travels with the notice. A bare "rejected" would send the
   * uploader hunting for someone to ask, which is the whole problem this is
   * meant to solve.
   */
  const watchers = await secretaries(sql);
  await tellPeople(sql, {
    usernames: [doc.created_by, ...watchers],
    docId: doc.id,
    priority: doc.priority,
    urgent: true,
    title: `เอกสารถูกตีกลับ: ${doc.title}`,
    body: `${me.display_name || me.username}: ${comment}`,
  });

  return json({ ok: true, stage: 'rejected', uploader: doc.created_by, comment });
}

/**
 * A corrected file, put in place without restarting the chain.
 *
 * This is the alternative to rejecting: a head who spots a typo fixes it and
 * the document carries on from where it was, rather than the uploader redoing
 * every step. Signatures already given are re-stamped onto the new file, and
 * anyone who has already signed is told, because they signed something that
 * has since changed.
 */
async function replaceFile(sql, me, body) {
  const found = await loadFor(sql, clean(body.id, 64));
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;
  if (!canReplaceFile(me, doc, steps)) return json({ error: 'NOT_ALLOWED' }, 403);

  const got = fromBase64(body.pdf, MAX_PDF);
  if (got.error) return json({ error: got.error, limit: got.limit, size: got.size }, 400);
  if (!looksLikePdf(got.buffer)) return json({ error: 'NOT_A_PDF' }, 400);
  const pages = await pageCount(got.buffer);
  if (!pages) return json({ error: 'UNREADABLE_PDF' }, 400);

  const offPage = steps.filter((s) => s.x !== null && s.page > pages);
  if (offPage.length) return json({ error: 'MARK_OFF_PAGE', pages }, 400);

  await sql`
    INSERT INTO doc_files (doc_id, kind, bytes, byte_size, pages, updated_at)
    VALUES (${doc.id}, 'original', ${got.buffer}, ${got.buffer.length}, ${pages}, now())
    ON CONFLICT (doc_id, kind) DO UPDATE
      SET bytes = EXCLUDED.bytes, byte_size = EXCLUDED.byte_size,
          pages = EXCLUDED.pages, updated_at = now()`;

  const stamped = await rebuildSigned(sql, doc.id, steps);
  await sql`UPDATE documents SET updated_at = now() WHERE id = ${doc.id}`;
  await note(sql, doc.id, 'replaced', me.username, clean(body.comment, 1000));

  const alreadySigned = steps.filter((s) => s.state === 'approved').map((s) => s.username);
  const waiting = pendingStep(steps);
  const watchers = await secretaries(sql);
  await tellPeople(sql, {
    usernames: [doc.created_by, ...alreadySigned, waiting?.username, ...watchers],
    docId: doc.id,
    priority: doc.priority,
    title: `เอกสารถูกแก้ไข: ${doc.title}`,
    body: `${me.display_name || me.username} อัปโหลดไฟล์ใหม่แทน` +
      (alreadySigned.length ? ' · ลายเซ็นเดิมถูกประทับลงไฟล์ใหม่แล้ว' : ''),
  });

  return json({ ok: true, pages, restamped: stamped.placed.length, alreadySigned });
}

async function markSent(sql, me, body) {
  const found = await loadFor(sql, clean(body.id, 64));
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;

  if (!isSecretary(me)) return json({ error: 'NOT_ALLOWED' }, 403);
  if (doc.stage === 'rejected') return json({ error: 'WAS_REJECTED' }, 400);

  // The secretary is the last step, so approving it and sending are one act.
  const step = pendingStep(steps);
  if (step && step.role === 'secretary' && step.username === me.username) {
    await sql`UPDATE doc_steps SET state = 'approved', acted_at = now() WHERE id = ${step.id}`;
  } else if (step) {
    return json({ error: 'STILL_WAITING', on: step.username }, 400);
  }

  await sql`
    UPDATE documents SET stage = 'sent', sent_at = now(), sent_by = ${me.username},
                         finished_at = COALESCE(finished_at, now()), updated_at = now()
    WHERE id = ${doc.id}`;
  await note(sql, doc.id, 'sent', me.username, clean(body.to || doc.recipient, 200));

  await tellPeople(sql, {
    usernames: [doc.created_by],
    docId: doc.id,
    priority: doc.priority,
    title: `ส่งเอกสารแล้ว: ${doc.title}`,
    body: `${me.display_name || me.username} ส่งให้ ${clean(body.to || doc.recipient, 120) || 'ผู้รับ'} เรียบร้อย`,
  });

  return json({ ok: true, stage: 'sent' });
}

export default withNode(handler);
export { rebuildSigned, toBuffer };
