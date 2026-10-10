import { sortRecipients } from '../lib/notifyprefs.js';
import { getSql, toBuffer } from '../lib/db.js';
import { currentUser } from '../lib/auth.js';
import { withNode } from '../lib/http.js';
import { isDepartment, matchUnit, departmentByKey, DEPARTMENTS, DEPARTMENT_KEYS } from '../lib/departments.js';
import { writeAccess } from '../lib/sheets.js';
import {
  registerDocument, updateStatus as updateRegisterStatus, writeNames,
  REGISTER_STATUS, registerConfigured,
} from '../lib/docregister.js';
import {
  proposeChain, pendingStep, canAct, canReplaceFile, canSeeDocument,
  progressOf, progressFraction, signsPdf, isSecretary, ROLE_TH,
  isHeadSecretary, canManageSecretaries, canDeleteDocument, pickSecretary,
  canSend, canBounce, isSendingRole, APPROVAL_ROLES, candidatesFor,
} from '../lib/approval.js';
import {
  stampSignatures, pageCount, looksLikePdf, looksLikePng, pngSize,
} from '../lib/pdfsign.js';
import { sendToMany, unreadCount } from '../lib/push.js';
import { lineConfigured, push as linePush, pageLink } from '../lib/line.js';
import { flex, listBubble } from '../lib/lineflex.js';

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
const MAX_SOURCE = 3 * 1024 * 1024;

/**
 * The editable original that may ride along with the PDF.
 *
 * Word first, because that is what the committee writes letters in, but a
 * .doc, an .odt or a Pages export are all somebody's editable master and
 * there is no reason to refuse them. The PDF is still the thing that gets
 * signed; this is only ever a copy to correct from.
 */
const SOURCE_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  pages: 'application/x-iwork-pages-sffpages',
};
const SOURCE_EXTS = Object.keys(SOURCE_TYPES);

/**
 * Reads the attached source file, or says why it cannot.
 *
 * The extension decides the type: browsers disagree about what a .docx is
 * (Chrome says the long OpenXML name, some Windows setups say
 * application/octet-stream), so trusting the name the person chose is both
 * more reliable and what they will see again on the way out.
 */
function readSource(value) {
  if (!value || !value.data) return { none: true };
  const name = clean(value.name, 200) || 'document.docx';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!SOURCE_EXTS.includes(ext)) return { error: 'NOT_A_DOC' };
  const got = fromBase64(value.data, MAX_SOURCE);
  if (got.error) return { error: got.error === 'FILE_TOO_BIG' ? 'SOURCE_TOO_BIG' : got.error, size: got.size, limit: got.limit };
  return { buffer: got.buffer, name, mime: SOURCE_TYPES[ext] };
}

/** Writes (or replaces) the editable original on a document. */
async function putSource(sql, docId, source) {
  await sql`
    INSERT INTO doc_files (doc_id, kind, bytes, byte_size, pages, file_name, mime, updated_at)
    VALUES (${docId}, 'source', ${source.buffer}, ${source.buffer.length}, 0,
            ${source.name}, ${source.mime}, now())
    ON CONFLICT (doc_id, kind) DO UPDATE SET
      bytes = EXCLUDED.bytes, byte_size = EXCLUDED.byte_size,
      file_name = EXCLUDED.file_name, mime = EXCLUDED.mime, updated_at = now()`;
}

const PRIORITIES = ['low', 'medium', 'high', 'highest'];
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const clean = (v, max = 400) => String(v ?? '').trim().slice(0, max);

/**
 * The addresses เลขานุการ will forward to.
 *
 * Several are allowed and usual — a letter to a faculty goes to the office
 * and to the person who asked for it. Split on anything people actually type
 * between addresses, kept only if they look like addresses at all, and
 * returned as one comma-separated string, which is what a mail client wants.
 */
function cleanEmails(value) {
  const parts = String(value ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const ok = parts.filter((x) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(x));
  return [...new Set(ok)].slice(0, 10).join(', ').slice(0, 400);
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
    if (action === 'secretaries') return listSecretaries(sql, me);
    if (id && url.searchParams.get('file')) {
      return downloadFile(sql, me, id, url.searchParams.get('file'));
    }
    if (id) return oneDocument(sql, me, id);
    return listDocuments(sql, me);
  }

  if (request.method === 'DELETE' && id) return removeDocument(sql, me, id);
  if (request.method !== 'POST') return json({ error: 'UNKNOWN_ACTION' }, 400);
  const body = await request.json().catch(() => ({}));

  switch (action) {
    case 'signature': return saveSignature(sql, me, body);
    case 'propose':   return propose(sql, me, body);
    case 'create':    return createDocument(sql, me, body);
    case 'approve':   return approve(sql, me, body);
    case 'reject':    return reject(sql, me, body);
    case 'replace':   return replaceFile(sql, me, body);
    case 'source':    return putSourceFile(sql, me, body);
    case 'send':      return markSent(sql, me, body);
    case 'secretaries': return changeSecretaries(sql, me, body);
    case 'names':       return syncNames(sql, me);
    case 'assign':      return reassignSecretary(sql, me, body);
    default:          return json({ error: 'UNKNOWN_ACTION' }, 400);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const rosterFor = (sql) => sql`
  SELECT u.username, u.display_name, u.nickname, u.position, u.access,
         u.full_name, u.department, u.unit, u.is_head, u.active, u.suspended,
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
  docNumber: d.doc_number || null,
  docTab: d.doc_tab || null,
  // Who posts it, and where to — see the send_mode column in lib/db.js.
  sendMode: d.send_mode === 'self' ? 'self' : 'secretary',
  recipientEmail: d.recipient_email || '',
  internalUnit: d.internal_unit === true,
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
  // The stored flag, not the role: an approver may have chosen not to stamp,
  // and a step created before that flag existed falls back to its role.
  signs: s.signs === undefined || s.signs === null ? signsPdf(s.role) : s.signs,
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
        // Which secretary this one lands on. A secretary sees every document
        // in the committee, so without this they cannot pick out the ones that
        // are actually theirs to send.
        secretary: (mine.find((s) => s.role === 'secretary') || {}).username || null,
      };
    });

  return json({
    documents: visible,
    isSecretary: isSecretary(me),
    mayManageSecretaries: canManageSecretaries(me),
    registerReady: registerConfigured(),
    myFullName: me.full_name || null,
    mine: visible.filter((d) => d.myTurn).length,
  });
}

async function oneDocument(sql, me, id) {
  const [doc] = await sql`SELECT * FROM documents WHERE id = ${id}`;
  if (!doc) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const steps = await sql`SELECT * FROM doc_steps WHERE doc_id = ${id} ORDER BY position`;
  if (!canSeeDocument(me, doc, steps)) return json({ error: 'NOT_ALLOWED' }, 403);

  const events = await sql`SELECT * FROM doc_events WHERE doc_id = ${id} ORDER BY at`;
  const files = await sql`SELECT kind, byte_size, pages, file_name, mime, updated_at FROM doc_files WHERE doc_id = ${id}`;

  return json({
    document: shapeDoc(doc),
    steps: steps.map(shapeStep),
    events: events.map((e) => ({ id: e.id, at: e.at, kind: e.kind, username: e.username, detail: e.detail })),
    files: files.map((f) => ({
      kind: f.kind, size: f.byte_size, pages: f.pages, at: f.updated_at,
      name: f.file_name || '', mime: f.mime || '',
    })),
    progress: progressOf(doc, steps),
    fraction: progressFraction(doc, steps),
    myTurn: canAct(me, doc, steps),
    mayReplace: canReplaceFile(me, doc, steps),
    maySend: canSend(me, doc, steps),
    // Sending it back for a correction — see canBounce in lib/approval.js.
    mayBounce: canBounce(me, doc, steps),
    mayDelete: canDeleteDocument(me, doc, steps),
    mayAssign: canManageSecretaries(me) && doc.stage !== 'sent',
  });
}

async function downloadFile(sql, me, id, kind) {
  const want = kind === 'signed' ? 'signed' : (kind === 'source' ? 'source' : 'original');
  const [doc] = await sql`SELECT * FROM documents WHERE id = ${id}`;
  if (!doc) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const steps = await sql`SELECT * FROM doc_steps WHERE doc_id = ${id} ORDER BY position`;
  if (!canSeeDocument(me, doc, steps)) return json({ error: 'NOT_ALLOWED' }, 403);

  const [row] = await sql`
    SELECT bytes, file_name, mime FROM doc_files WHERE doc_id = ${id} AND kind = ${want}`;
  const buffer = toBuffer(row?.bytes);
  if (!buffer) {
    // Cleared after archiving: the copy in Drive is the one that exists now.
    if (doc.drive_url) return json({ error: 'ARCHIVED', driveUrl: doc.drive_url }, 410);
    // Cleared on rejection: the record survives so the reason can be read.
    if (doc.stage === 'rejected' && want !== 'source') {
      return json({ error: 'REJECTED_FILE_REMOVED' }, 410);
    }
    return json({ error: 'NO_FILE' }, 404);
  }

  /**
   * The PDF opens in the browser; the editable original downloads.
   *
   * Nothing renders a .docx in a tab, so `inline` would only produce a
   * mystery file in the downloads folder with the wrong name. It keeps the
   * name it was uploaded under, because that is what the person who has to
   * correct it will be looking for.
   */
  const isSource = want === 'source';
  const name = isSource
    ? (row.file_name || 'document.docx')
    : `${doc.title || 'document'}.pdf`;

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': isSource ? (row.mime || 'application/octet-stream') : 'application/pdf',
      'content-length': String(buffer.length),
      'content-disposition':
        `${isSource ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
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
  const parent = departmentByKey(department)?.parent || null;
  const rule = await secretaryRule(sql);
  const chain = proposeChain(me, {
    people, department, unit, parent,
    sendMode: body.sendMode === 'self' ? 'self' : 'secretary',
    secretaryPick: (options) => pickSecretary(options, { ...rule, department }),
  });

  return json({
    department,
    unit,
    parent,
    /**
     * Every role, with who can fill it.
     *
     * Sent whether or not the proposed chain uses the role, because the form
     * lets somebody change a row's role or add one — and a row that offered
     * the whole roster is how ต๊อดติ ended up sitting under ประธานโครงการ,
     * a post he does not hold.
     */
    roles: APPROVAL_ROLES.map((role) => ({
      role,
      label: ROLE_TH[role] || role,
      options: pickList(role, { people, department, unit, uploader: me, parent }),
    })),
    steps: chain.map((s) => ({ ...s, roleLabel: ROLE_TH[s.role] || s.role })),
    // Everything needed to let the uploader change who is on it.
    people: people.map((p) => ({
      username: p.username, displayName: p.display_name, nickname: p.nickname,
      position: p.position, department: p.department, unit: p.unit, isHead: p.is_head,
    })),
  });
}

/**
 * Who to offer for a role, as against who the chain proposes for it.
 *
 * The proposal is about THIS letter: the ประธานฝ่าย of the ฝ่าย it came from,
 * the chair of the division that ฝ่าย sits under. The list behind the role
 * dropdown is a different question — somebody who changes a row to
 * ประธานฝ่ายอำนวยการใหญ่ on a letter from ฝ่ายเนื้อหา means the people who
 * hold that post, and scoping it to the letter's own ฝ่าย offered them
 * nobody at all. So: this letter's people first, then everybody else who
 * holds the same kind of post.
 */
const UMBRELLAS = [...new Set(DEPARTMENTS.filter((d) => d.parent).map((d) => d.parent))];

function pickList(role, { people, department, unit, uploader, parent }) {
  const seen = new Set();
  const out = [];
  const add = (list) => {
    for (const person of list) {
      if (seen.has(person.username)) continue;
      seen.add(person.username);
      out.push(person.username);
    }
  };

  add(candidatesFor(role, { people, department, unit, uploader, parent }));
  if (role === 'deptHead') {
    for (const key of DEPARTMENT_KEYS) {
      add(candidatesFor('deptHead', { people, department: key, unit: null, uploader }));
    }
  }
  if (role === 'divisionHead') {
    for (const key of UMBRELLAS) {
      add(candidatesFor('divisionHead', { people, department, unit, uploader, parent: key }));
    }
  }
  if (role === 'unitHead' && department) {
    for (const name of (departmentByKey(department)?.units || [])) {
      add(candidatesFor('unitHead', { people, department, unit: name, uploader }));
    }
  }
  return out;
}

async function createDocument(sql, me, body) {
  const title = clean(body.title, 200);
  if (!title) return json({ error: 'TITLE_REQUIRED' }, 400);

  /**
   * The uploader's full name, asked for once.
   *
   * It goes in the ผู้รับผิดชอบ column of the committee's register, where
   * "Kungking_HeadCon" would be no use to anybody reading a book of letters.
   * Taken here rather than on the profile page because this is the moment it
   * is actually needed, and saved so nobody is asked twice.
   */
  const fullName = clean(body.fullName, 120);
  if (fullName) {
    await sql`UPDATE users SET full_name = ${fullName}, updated_at = now()
              WHERE username = ${me.username}`;
    me.full_name = fullName;
  }
  if (!me.full_name) return json({ error: 'FULL_NAME_REQUIRED' }, 400);

  const got = fromBase64(body.pdf, MAX_PDF);
  if (got.error) return json({ error: got.error, limit: got.limit, size: got.size }, 400);
  if (!looksLikePdf(got.buffer)) return json({ error: 'NOT_A_PDF' }, 400);

  const pages = await pageCount(got.buffer);
  if (!pages) return json({ error: 'UNREADABLE_PDF' }, 400);

  /**
   * The Word original, if one was attached. Optional: plenty of letters
   * arrive as a PDF from somewhere else and there is nothing to attach.
   * Checked here, before anything is written, so a bad file is refused
   * rather than leaving a letter with half its files.
   */
  const source = readSource(body.source);
  if (source.error) return json({ error: source.error, limit: source.limit, size: source.size }, 400);

  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!steps.length) return json({ error: 'NO_APPROVERS' }, 400);

  /**
   * Who sends the finished letter.
   *
   * 'self' is the writer posting it themselves — some ฝ่าย deal with their own
   * recipients and routing it through เลขานุการ only adds a day. Either way
   * the chain ends on exactly one sending step, and it is last: a letter that
   * went out before the last signature would be the one mistake this whole
   * flow exists to prevent.
   */
  const sendMode = body.sendMode === 'self' ? 'self' : 'secretary';
  const sending = steps.filter((st) => isSendingRole(st.role));
  if (sending.length !== 1 || !isSendingRole(steps[steps.length - 1].role)) {
    return json({ error: 'BAD_CHAIN_END' }, 400);
  }
  const lastStep = steps[steps.length - 1];
  if (sendMode === 'self' && (lastStep.role !== 'sender' || lastStep.username !== me.username)) {
    return json({ error: 'SENDER_MUST_BE_YOU' }, 400);
  }
  if (sendMode === 'secretary' && lastStep.role !== 'secretary') {
    return json({ error: 'BAD_CHAIN_END' }, 400);
  }
  if (steps.slice(0, -1).some((st) => !APPROVAL_ROLES.includes(st.role))) {
    return json({ error: 'BAD_ROLE' }, 400);
  }

  /**
   * The address เลขานุการ forwards to.
   *
   * Only when they are the ones sending, and not for a letter that stays
   * inside the university — those travel by Chula's own internal post, and
   * demanding an address for them would be asking for something that does not
   * exist.
   */
  const internalUnit = body.internalUnit === true;
  const email = cleanEmails(body.recipientEmail);
  if (sendMode === 'secretary' && !internalUnit && !email) {
    return json({ error: 'EMAIL_REQUIRED' }, 400);
  }

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

  /**
   * The person named as เลขานุการ has to be one.
   *
   * The form only ever offers secretaries, so this is for anything that does
   * not come from the form — a letter whose last step is somebody who cannot
   * see the เอกสาร page would sit there with nobody able to send it.
   */
  if (sendMode === 'secretary') {
    const allowed = candidatesFor('secretary', { people, department: null, unit: null, uploader: me })
      .map((p) => p.username);
    if (allowed.length && !allowed.includes(lastStep.username)) {
      return json({ error: 'NOT_A_SECRETARY' }, 400);
    }
  }

  /**
   * The boxes a step will sign in.
   *
   * One signer may have several — an initial on each page as well as a
   * signature at the end — so this is a list. A single `mark` is still
   * accepted so that anything built against the older shape keeps working.
   */
  const boxesOf = (s) => {
    const list = Array.isArray(s.marks) ? s.marks : (s.mark ? [s.mark] : []);
    return list.filter((m) => m && Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.y)));
  };

  // Every signing step needs somewhere for the signature to go.
  const missing = steps.filter((s) => signsPdf(s.role) && !boxesOf(s).length);
  if (missing.length) {
    return json({ error: 'MARK_REQUIRED', who: missing.map((s) => s.username) }, 400);
  }
  const offPage = steps.filter((s) =>
    boxesOf(s).some((m) => Math.round(m.page || 1) < 1 || Math.round(m.page || 1) > pages));
  if (offPage.length) return json({ error: 'MARK_OFF_PAGE', pages }, 400);

  const department = isDepartment(body.department) ? body.department : (me.department || null);
  const unit = department ? matchUnit(department, body.unit) : null;
  const id = newId('doc');

  await sql`
    INSERT INTO documents (id, title, note, recipient, priority, stage, department, unit,
                           created_by, send_mode, recipient_email, internal_unit)
    VALUES (${id}, ${title}, ${clean(body.note, 2000)}, ${clean(body.recipient, 200)},
            ${PRIORITIES.includes(body.priority) ? body.priority : 'medium'},
            'approving', ${department}, ${unit}, ${me.username},
            ${sendMode}, ${email}, ${internalUnit})`;

  await sql`
    INSERT INTO doc_files (doc_id, kind, bytes, byte_size, pages)
    VALUES (${id}, 'original', ${got.buffer}, ${got.buffer.length}, ${pages})`;
  if (!source.none) await putSource(sql, id, source);

  let position = 0;
  for (const step of steps) {
    position += 1;
    const role = clean(step.role, 20);
    const boxes = boxesOf(step);
    const first = boxes[0] || {};

    /**
     * The author's own step is already done the moment it is created.
     *
     * Nobody grants the author permission to sign their own letter, so this
     * step exists to carry a signature, not to wait for one. Leaving it
     * 'waiting' would park every such document on its own writer.
     */
    const isAuthor = role === 'author';
    const stepId = newId('st');

    await sql`
      INSERT INTO doc_steps (id, doc_id, position, role, username, page, x, y, w, h, signs, state, acted_at)
      VALUES (${stepId}, ${id}, ${position}, ${role}, ${step.username},
              ${Math.max(1, Math.round(first.page || 1))},
              ${boxes.length ? Number(first.x) : null}, ${boxes.length ? Number(first.y) : null},
              ${boxes.length ? Number(first.w) : null}, ${boxes.length ? Number(first.h) : null},
              ${boxes.length > 0}, ${isAuthor ? 'approved' : 'waiting'},
              ${isAuthor ? new Date() : null})`;

    for (const m of boxes) {
      await sql`
        INSERT INTO doc_boxes (id, step_id, page, x, y, w, h)
        VALUES (${newId('box')}, ${stepId}, ${Math.max(1, Math.round(m.page || 1))},
                ${Number(m.x)}, ${Number(m.y)}, ${Number(m.w)}, ${Number(m.h)})`;
    }
  }

  await note(sql, id, 'created', me.username, title);

  /**
   * The เลขรันเอกสาร, taken the moment the letter is submitted.
   *
   * It used to be issued at the far end, once every signature was in, which
   * kept the book free of numbers for letters that were never sent — but it
   * also meant the number did not exist while the letter was being written on,
   * and the number belongs ON the letter. So it is taken here and the writer
   * is told it straight away; a letter that is later ตีกลับ keeps its number
   * and its row says so, which is a truer record than a gap.
   *
   * Best effort: a spreadsheet that cannot be reached must never stop a
   * document being submitted, and the next stage tries again.
   */
  const numbering = await issueNumber(sql, {
    id, department, unit, title, created_by: me.username,
  }, REGISTER_STATUS.approving);

  /**
   * The author's signature goes on straight away.
   *
   * Their step is already approved, so without this the signed copy would not
   * appear until somebody else acted — and for a director's letter, where the
   * author step may be the only signing one, possibly never.
   */
  if (steps.some((s) => clean(s.role, 20) === 'author')) {
    const fresh = await sql`SELECT * FROM doc_steps WHERE doc_id = ${id} ORDER BY position`;
    await rebuildSigned(sql, id, fresh);
  }

  // Whoever is actually waiting — not simply the first step, which for a
  // letter the author signed is already done.
  const first = steps.find((s) => clean(s.role, 20) !== 'author') || steps[0];
  const watchers = await secretaries(sql);
  const numberTag = numbering?.ok ? ` · เลขที่ ${numbering.number}` : '';
  await tellPeople(sql, {
    usernames: [first.username, ...watchers],
    actor: first.username,
    docId: id,
    priority: body.priority,
    title: `${urgencyTag(body.priority)}เอกสารรออนุมัติ: ${title}`,
    body: `${me.display_name || me.username} ส่งเอกสารให้คุณลงนาม/อนุมัติ${numberTag}`,
  });

  /**
   * And the writer is told their own number, in the chat as well as the bell.
   *
   * This is the one message a person genuinely needs pushed to them about
   * their own document: the number has to go onto the letter, and hunting for
   * it in a spreadsheet is exactly the errand this replaces.
   */
  if (numbering?.ok) {
    /**
     * No `actor`, so this one does not go out over LINE. The person is
     * looking at the screen that just told them the number, and a LINE push
     * is charged per message — see tellPeople. The bell keeps it findable.
     */
    await tellPeople(sql, {
      usernames: [me.username],
      docId: id,
      priority: body.priority,
      title: `เลขที่หนังสือของคุณ: ${numbering.number}`,
      body: `${title} — เขียนเลขนี้ลงบนหนังสือได้เลย`,
    });
  }

  return json({ ok: true, id, pages, numbering }, 201);
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
/**
 * Telling people about a document.
 *
 * Three channels, and only one of them costs money — which is why they no
 * longer carry the same list.
 *
 * The in-app bell and the phone's own notifications go to EVERYONE who should
 * know: the person whose turn it is, the uploader, and every secretary
 * watching. Both are free however many people are on the committee.
 *
 * A LINE message is a charged push, per person, every time. So it goes only to
 * whoever actually has to DO something — `actor` — and nobody else. A
 * secretary watching twenty documents move through four steps each does not
 * need eighty paid messages to learn what the เอกสาร page would have told them;
 * they get the bell like everybody else, and LINE only when a document is
 * genuinely theirs to handle.
 *
 * Anybody who would rather have everything in LINE can still ask for the daily
 * digest, which is one message rather than eighty.
 */
async function tellPeople(sql, { usernames, title, body, docId, priority, urgent, actor }) {
  const asked = [...new Set(usernames.filter(Boolean))];
  if (!asked.length) return { told: 0 };

  /**
   * Their settings first. The person whose turn it is still gets the bell
   * even with documents switched off — a document waiting on somebody who
   * cannot see that it is waiting stops the whole chain.
   */
  const heard = await sortRecipients(sql, asked, { category: 'document', scope: 'doc', id: docId });
  const turn = [].concat(actor || []).filter(Boolean);
  const quiet = heard.quiet.concat(heard.off.filter((u) => turn.includes(u)));
  const loud = heard.loud;
  const people = loud.concat(quiet);
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
    if (loud.length) await sendToMany(sql, loud, payload);
  } catch (error) {
    console.error('[documents] push failed:', String(error?.message || error).slice(0, 200));
  }

  // Only the person who has to act, and only if they have linked LINE.
  const payFor = [...new Set([].concat(actor || []).filter(Boolean))]
    .filter((u) => loud.includes(u));

  if (lineConfigured() && payFor.length) {
    try {
      const links = await sql`
        SELECT line_user_id, username FROM line_links WHERE username = ANY(${payFor})`;
      /**
       * A card, not a paragraph.
       *
       * The old message put the title, the reason and a raw URL in one block
       * of grey text, which on a phone is the hardest possible way to read
       * "this is waiting for you". The card leads with what happened and puts
       * the two things a person can do next under their thumb.
       */
      const deep = link ? `${link.replace(/#\/docs$/, '')}#/d/${docId}` : null;
      const card = flex(`${clean(title, 120)} — ${clean(body, 120)}`, listBubble({
        title: clean(title, 200),
        subtitle: clean(body, 500),
        rows: [],
        empty: null,
        link: deep,
        actions: [{
          label: 'ดูเอกสาร', style: 'primary',
          data: `doc:open:${docId}`, say: 'ขอดูเอกสารนี้',
        }],
      }), ['เอกสาร', 'เอกสารทั้งหมด', 'จบ']);

      for (const row of links) {
        await linePush(row.line_user_id, card).catch(() => {});
        // Counted, because this one is billed.
        await sql`INSERT INTO line_charges (username, kind) VALUES (${row.username}, 'document')`;
      }
    } catch (error) {
      console.error('[documents] LINE failed:', String(error?.message || error).slice(0, 200));
    }
  }
  return { told: people.length, lineTo: payFor.length };
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
   * Approving without signing.
   *
   * A department head may want their approval recorded without their signature
   * appearing on the letter — they are agreeing to it, not putting their name
   * on its face. The approval is logged either way; only the stamp is dropped.
   * A step that was never a signing step cannot be turned into one here.
   */
  const withoutSignature = body.withoutSignature === true;
  const willSign = step.signs !== false && !withoutSignature;

  /**
   * A signing role must actually have a signature on file.
   *
   * Checked before anything is written, so a head without one is told to set
   * it up rather than the document advancing with an empty box where their
   * name should be.
   */
  let signature = null;
  if (willSign && signsPdf(step.role)) {
    const [row] = await sql`SELECT png FROM signatures WHERE username = ${me.username}`;
    signature = toBuffer(row?.png);
    if (!signature) return json({ error: 'NO_SIGNATURE' }, 400);
  }

  await sql`
    UPDATE doc_steps SET state = 'approved', acted_at = now(), signs = ${willSign},
      comment = ${clean(body.comment, 1000)}
    WHERE id = ${step.id}`;

  const after = await sql`SELECT * FROM doc_steps WHERE doc_id = ${doc.id} ORDER BY position`;
  const stamped = await rebuildSigned(sql, doc.id, after);

  const next = pendingStep(after);
  const stage = next ? (isSendingRole(next.role) ? 'secretary' : 'approving') : 'done';
  await sql`
    UPDATE documents SET stage = ${stage === 'done' ? 'done' : stage}, updated_at = now(),
      finished_at = ${stage === 'done' ? new Date().toISOString() : null}
    WHERE id = ${doc.id}`;

  await note(sql, doc.id, willSign && signsPdf(step.role) ? 'signed' : 'approved', me.username,
    clean(body.comment, 1000));

  /**
   * The committee's เลขรันเอกสาร, issued once every signature is in.
   *
   * This is the last moment the number can still be written on the letter, and
   * the first moment the letter is certain to go out — so the book gets no
   * gaps from documents that were rejected along the way, and the secretary
   * has the number in hand before they send anything.
   *
   * Best effort on purpose: an unreachable spreadsheet must not strand a
   * signed document, so it is recorded as unnumbered and the secretary is told.
   */
  let numbering = null;
  if (next && isSendingRole(next.role)) {
    /**
     * The number is taken when the letter is submitted, so by now it normally
     * exists and only its สถานะ needs moving on. The retry is for the day the
     * spreadsheet was unreachable at submission: a letter that is signed and
     * ready to go must not be the one without a number.
     */
    if (doc.doc_number) {
      await updateRegisterStatus({
        tab: doc.doc_tab, number: doc.doc_number, status: REGISTER_STATUS.secretary,
      });
    } else {
      numbering = await issueNumber(sql, doc);
    }
  }

  const watchers = await secretaries(sql);
  if (next) {
    await tellPeople(sql, {
      usernames: [next.username, ...watchers],
      actor: next.username,
      docId: doc.id,
      priority: doc.priority,
      title: `${urgencyTag(doc.priority)}${isSendingRole(next.role) ? 'เอกสารพร้อมส่ง' : 'เอกสารรออนุมัติ'}: ${doc.title}`,
      body: isSendingRole(next.role)
        ? [
            'ลงนามครบแล้ว',
            doc.doc_number || numbering?.number ? `เลขที่ ${doc.doc_number || numbering.number}` : '',
            next.role === 'sender' ? 'ส่งให้ผู้รับแล้วกดยืนยันในระบบ' : 'รอเลขานุการส่งให้ผู้รับ',
            next.role === 'secretary' && doc.recipient_email ? `ส่งไปที่ ${doc.recipient_email}` : '',
            next.role === 'secretary' && doc.internal_unit ? 'หน่วยงานภายในจุฬาฯ' : '',
          ].filter(Boolean).join(' · ')
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
    numbering,
  });
}

/**
 * Takes the next number for this document's ฝ่าย and writes its row.
 *
 * The register is the committee's own spreadsheet and the master for the
 * numbering; this only ever adds a line to it. The responsible person is the
 * uploader, by their full name, because that is who the recipient will ask
 * about the letter.
 */
async function issueNumber(sql, doc, status = REGISTER_STATUS.secretary) {
  const [uploader] = await sql`
    SELECT full_name, display_name, username FROM users WHERE username = ${doc.created_by}`;
  const dept = departmentByKey(doc.department);

  const result = await registerDocument({
    department: dept ? dept.th : null,
    unit: doc.unit || null,
    title: doc.title,
    status,
    responsible: uploader?.full_name || uploader?.display_name || doc.created_by,
  });

  if (result.ok) {
    await sql`
      UPDATE documents SET doc_number = ${result.number}, doc_tab = ${result.tab},
                           doc_code = ${result.code}, numbered_at = now()
      WHERE id = ${doc.id}`;
    await note(sql, doc.id, 'numbered', null, result.number);
  } else {
    await note(sql, doc.id, 'number_failed', null, result.reason || 'unknown');
  }
  return result;
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

  /**
   * Whose signature goes on, and where.
   *
   * `signs` rather than the role: an approver may have chosen to approve
   * without stamping, and the author signs without approving anything. A step
   * can own several boxes, so each one becomes its own mark.
   */
  const signing = steps.filter((s) => s.state === 'approved' && s.signs !== false);
  const marks = [];
  for (const step of signing) {
    const [row] = await sql`SELECT png FROM signatures WHERE username = ${step.username}`;
    const png = toBuffer(row?.png);
    if (!png) continue;

    const boxes = await sql`SELECT page, x, y, w, h FROM doc_boxes WHERE step_id = ${step.id}`;
    // Steps drawn before boxes existed still carry their one box inline.
    const spots = boxes.length
      ? boxes
      : (step.x === null || step.x === undefined
        ? []
        : [{ page: step.page, x: step.x, y: step.y, w: step.w, h: step.h }]);

    for (const spot of spots) {
      marks.push({
        username: step.username, page: spot.page,
        x: spot.x, y: spot.y, w: spot.w, h: spot.h, png,
      });
    }
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
  /**
   * Whoever the document is sitting with may send it back — including
   * เลขานุการ, who until now could only post it. They are the last pair of
   * eyes on a letter before it leaves the university, and they were the ones
   * finding the mistakes with no way to say so.
   */
  if (!canBounce(me, doc, steps)) return json({ error: 'NOT_YOUR_TURN' }, 403);

  const comment = clean(body.comment, 1000);
  if (!comment) return json({ error: 'REASON_REQUIRED' }, 400);

  const step = pendingStep(steps);
  await sql`UPDATE doc_steps SET state = 'rejected', acted_at = now(), comment = ${comment}
            WHERE id = ${step.id}`;
  await sql`UPDATE documents SET stage = 'rejected', updated_at = now() WHERE id = ${doc.id}`;
  await note(sql, doc.id, 'rejected', me.username, comment);

  /**
   * The file goes, the reason stays.
   *
   * A rejected document is dead — keeping the PDF only occupies space and
   * leaves a copy of something nobody approved. But the record and the reason
   * are what the uploader needs to fix it and what the committee needs to
   * remember, so those are kept for good. Deleting both would answer "why?"
   * with silence.
   */
  /**
   * The Word original stays, when there is one. It is the whole point of
   * attaching it: a letter comes back to be corrected, and the person
   * correcting it needs the file they can actually edit. It is small, it is
   * their own draft, and it goes when the document does.
   */
  await sql`DELETE FROM doc_files WHERE doc_id = ${doc.id} AND kind <> 'source'`;
  const [keptSource] = await sql`SELECT file_name FROM doc_files WHERE doc_id = ${doc.id} AND kind = 'source'`;
  await note(sql, doc.id, 'files_removed', null, keptSource
    ? `ลบไฟล์ PDF ออกจากระบบแล้ว เก็บไฟล์ต้นฉบับ (${keptSource.file_name}) ไว้ให้แก้ไข`
    : 'ลบไฟล์ออกจากระบบแล้ว เก็บเฉพาะประวัติและเหตุผล');

  /**
   * A number is only issued once every signature is in, so a rejection
   * normally happens before there is anything in the register. If one was
   * issued — a document sent back after it reached the secretary — the row
   * stays and says so, because a number that has been handed out cannot be
   * quietly taken back out of the book.
   */
  if (doc.doc_number) {
    await updateRegisterStatus({
      tab: doc.doc_tab, number: doc.doc_number, status: REGISTER_STATUS.rejected,
    });
  }

  /**
   * The reason travels with the notice. A bare "rejected" would send the
   * uploader hunting for someone to ask, which is the whole problem this is
   * meant to solve.
   */
  const watchers = await secretaries(sql);
  await tellPeople(sql, {
    usernames: [doc.created_by, ...watchers],
    actor: doc.created_by,
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
    actor: waiting?.username,
    docId: doc.id,
    priority: doc.priority,
    title: `เอกสารถูกแก้ไข: ${doc.title}`,
    body: `${me.display_name || me.username} อัปโหลดไฟล์ใหม่แทน` +
      (alreadySigned.length ? ' · ลายเซ็นเดิมถูกประทับลงไฟล์ใหม่แล้ว' : ''),
  });

  return json({ ok: true, pages, restamped: stamped.placed.length, alreadySigned });
}

/**
 * Attaching, replacing or removing the editable original after the fact.
 *
 * Same permission as replacing the PDF: anybody named in the chain, and the
 * writer while nothing has been signed. A letter that is sent back for a
 * correction is the commonest reason to want this, so it stays available on
 * a rejected document too.
 */
async function putSourceFile(sql, me, body) {
  const found = await loadFor(sql, clean(body.id, 64));
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;
  const bounced = doc.stage === 'rejected' && doc.created_by === me.username;
  if (!canReplaceFile(me, doc, steps) && !bounced) return json({ error: 'NOT_ALLOWED' }, 403);

  if (body.remove) {
    await sql`DELETE FROM doc_files WHERE doc_id = ${doc.id} AND kind = 'source'`;
    await note(sql, doc.id, 'source_removed', me.username, '');
    return json({ ok: true, source: null });
  }

  const source = readSource(body.source);
  if (source.none) return json({ error: 'EMPTY_FILE' }, 400);
  if (source.error) return json({ error: source.error, limit: source.limit, size: source.size }, 400);

  await putSource(sql, doc.id, source);
  await sql`UPDATE documents SET updated_at = now() WHERE id = ${doc.id}`;
  await note(sql, doc.id, 'source_added', me.username, source.name);
  return json({ ok: true, source: { name: source.name, size: source.buffer.length } });
}

async function markSent(sql, me, body) {
  const found = await loadFor(sql, clean(body.id, 64));
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;

  if (doc.stage === 'rejected') return json({ error: 'WAS_REJECTED' }, 400);
  const step = pendingStep(steps);
  /**
   * Whoever the last step names does the sending — เลขานุการ, or the writer
   * when they chose to send it themselves. A head secretary may still stand
   * in for a secretary who is away.
   */
  if (!canSend(me, doc, steps)) {
    if (step && !isSendingRole(step.role)) return json({ error: 'STILL_WAITING', on: step.username }, 400);
    return json({ error: 'NOT_ALLOWED' }, 403);
  }

  // The sending step is the last one, so completing it and sending are one act.
  if (step) {
    await sql`UPDATE doc_steps SET state = 'approved', acted_at = now() WHERE id = ${step.id}`;
  }

  await sql`
    UPDATE documents SET stage = 'sent', sent_at = now(), sent_by = ${me.username},
                         finished_at = COALESCE(finished_at, now()), updated_at = now()
    WHERE id = ${doc.id}`;
  await note(sql, doc.id, 'sent', me.username, clean(body.to || doc.recipient, 200));

  // The register's สถานะ follows the document. Best effort, like the rest of
  // the spreadsheet work: a letter that has gone out has gone out.
  const registered = await updateRegisterStatus({
    tab: doc.doc_tab, number: doc.doc_number, status: REGISTER_STATUS.sent,
  });

  // Nobody needs telling what they themselves just did, so a writer who sent
  // their own letter gets no notice; the secretaries watching still do.
  await tellPeople(sql, {
    usernames: [doc.created_by === me.username ? null : doc.created_by, ...(await secretaries(sql))],
    docId: doc.id,
    priority: doc.priority,
    title: `ส่งเอกสารแล้ว: ${doc.title}`,
    body: `${me.display_name || me.username} ส่งให้ ${clean(body.to || doc.recipient, 120) || 'ผู้รับ'} เรียบร้อย` +
      (doc.doc_number ? ` · เลขที่ ${doc.doc_number}` : ''),
  });

  return json({ ok: true, stage: 'sent', number: doc.doc_number || null, registered });
}


// ---------------------------------------------------------------------------
// Secretaries
// ---------------------------------------------------------------------------

/** How new documents are shared out, and the department mapping behind it. */
async function secretaryRule(sql) {
  const [row] = await sql`SELECT value FROM meta WHERE key = 'doc_secretary_mode'`;
  const prefs = await sql`SELECT department, username FROM secretary_prefs`;
  const byDepartment = {};
  for (const p of prefs) byDepartment[p.department] = p.username;
  return { mode: row?.value === 'department' ? 'department' : 'random', byDepartment };
}

async function listSecretaries(sql, me) {
  const people = asPeople(await rosterFor(sql));
  const secs = people.filter((p) => isSecretary(p));
  const rule = await secretaryRule(sql);

  return json({
    mayManage: canManageSecretaries(me),
    amHead: isHeadSecretary(me),
    mode: rule.mode,
    byDepartment: rule.byDepartment,
    secretaries: secs.map((p) => ({
      username: p.username,
      displayName: p.display_name,
      fullName: p.full_name || null,
      nickname: p.nickname,
      position: p.position,
      isHead: Boolean(p.is_head),
    })),
    // Anyone who could be brought in, for the "add somebody" picker.
    candidates: people
      .filter((p) => !isSecretary(p))
      .map((p) => ({ username: p.username, displayName: p.display_name, position: p.position })),
  });
}

/**
 * Bringing a secretary in, letting one go, and setting how documents are shared.
 *
 * Restricted to the head secretaries and the admins. Being an ordinary
 * secretary means watching every document, which is exactly why an ordinary
 * secretary must not be able to appoint more of them.
 */
async function changeSecretaries(sql, me, body) {
  if (!canManageSecretaries(me)) return json({ error: 'NOT_ALLOWED' }, 403);

  const touched = [];

  if (body.add) {
    const [person] = await sql`
      SELECT username FROM users WHERE username = ${clean(body.add, 64)} AND active = true`;
    if (!person) return json({ error: 'NO_SUCH_USER' }, 400);
    await sql`INSERT INTO user_departments (username, department)
              VALUES (${person.username}, 'secretariat') ON CONFLICT DO NOTHING`;
    // Somebody with no teamspace at all would otherwise be a secretary with
    // nowhere to file their own work.
    await sql`UPDATE users SET department = 'secretariat', updated_at = now()
              WHERE username = ${person.username} AND department IS NULL`;
    touched.push(person.username);
  }

  if (body.remove) {
    const target = clean(body.remove, 64);
    const people = asPeople(await rosterFor(sql));
    const left = people.filter((p) => isSecretary(p) && p.username !== target);
    // Removing the last secretary would leave every document with nowhere to
    // finish, so the last one cannot be removed.
    if (!left.length) return json({ error: 'LAST_SECRETARY' }, 400);
    await sql`DELETE FROM user_departments
              WHERE username = ${target} AND department = 'secretariat'`;
    await sql`DELETE FROM secretary_prefs WHERE username = ${target}`;

    /**
     * The home teamspace counts as being in the secretariat too, so clearing
     * only the grant would leave somebody who had been "removed" still seeing
     * every document. It moves to whatever else they have, or to nothing.
     */
    const rest = await sql`
      SELECT department FROM user_departments WHERE username = ${target} LIMIT 1`;
    await sql`UPDATE users SET department = ${rest[0]?.department ?? null}, updated_at = now()
              WHERE username = ${target} AND department = 'secretariat'`;
    touched.push(target);
  }

  /**
   * Whoever was moved is written back to the roster sheet, for the same reason
   * the admin page does it: the hourly sync reads that sheet, and a change it
   * has never heard of is a change that quietly disappears. If Google cannot
   * be reached the person is pinned instead, which holds the change here.
   */
  for (const username of touched) {
    const [row] = await sql`SELECT all_departments FROM users WHERE username = ${username}`;
    const keys = (await sql`SELECT department FROM user_departments WHERE username = ${username}`)
      .map((d) => d.department);
    const labels = row.all_departments ? ['All'] : keys.map((k) => departmentByKey(k)?.th || k);
    // Departments only: nobody's access level changed here.
    const wrote = await writeAccess(username, null, labels);
    await sql`UPDATE users SET depts_pinned = ${!wrote.ok} WHERE username = ${username}`;
  }

  if (body.mode === 'random' || body.mode === 'department') {
    await sql`INSERT INTO meta (key, value) VALUES ('doc_secretary_mode', ${body.mode})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }

  if (body.byDepartment && typeof body.byDepartment === 'object') {
    for (const [dept, username] of Object.entries(body.byDepartment)) {
      if (!isDepartment(dept)) continue;
      if (!username) {
        await sql`DELETE FROM secretary_prefs WHERE department = ${dept}`;
        continue;
      }
      await sql`
        INSERT INTO secretary_prefs (department, username, set_by, updated_at)
        VALUES (${dept}, ${clean(username, 64)}, ${me.username}, now())
        ON CONFLICT (department) DO UPDATE
          SET username = EXCLUDED.username, set_by = EXCLUDED.set_by, updated_at = now()`;
    }
  }

  return listSecretaries(sql, me);
}

/**
 * Moving a document to a different secretary.
 *
 * Only while it is still with them — once a document is sent, who handled it
 * is history and must not be rewritten.
 */
async function reassignSecretary(sql, me, body) {
  if (!canManageSecretaries(me)) return json({ error: 'NOT_ALLOWED' }, 403);
  const found = await loadFor(sql, clean(body.id, 64));
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;
  if (doc.stage === 'sent') return json({ error: 'ALREADY_SENT' }, 400);

  const step = steps.find((s) => s.role === 'secretary');
  if (!step) return json({ error: 'NO_SECRETARY_STEP' }, 400);
  if (step.state !== 'waiting') return json({ error: 'ALREADY_ACTED' }, 400);

  const people = asPeople(await rosterFor(sql));
  const target = people.find((p) => p.username === clean(body.username, 64) && isSecretary(p));
  if (!target) return json({ error: 'NOT_A_SECRETARY' }, 400);

  const before = step.username;
  await sql`UPDATE doc_steps SET username = ${target.username} WHERE id = ${step.id}`;
  await note(sql, doc.id, 'reassigned', me.username, `${before} → ${target.username}`);

  await tellPeople(sql, {
    usernames: [target.username],
    actor: target.username,
    docId: doc.id,
    priority: doc.priority,
    title: `เอกสารถูกมอบหมายให้คุณ: ${doc.title}`,
    body: `${me.display_name || me.username} มอบหมายให้คุณดูแลเอกสารนี้`,
  });

  return json({ ok: true, secretary: target.username, was: before });
}

/**
 * Pushes the roster's full names into the register's รายชื่อผู้รับผิดชอบ lists.
 *
 * One tab per ฝ่าย and unit, each getting the people who belong to it. This is
 * the other half of "link the names to the sheet and the web system": the
 * register stops being a place where everybody types their name differently,
 * and starts being a list picked from the same roster the app uses.
 *
 * Deliberately a button rather than something that runs on every change: it is
 * forty-odd writes to somebody else's spreadsheet, and doing that every time a
 * person edits their profile would be rude to the sheet and slow for them.
 */
async function syncNames(sql, me) {
  if (!canManageSecretaries(me)) return json({ error: 'NOT_ALLOWED' }, 403);
  if (!registerConfigured()) return json({ error: 'REGISTER_NOT_CONFIGURED' }, 400);

  const people = asPeople(await rosterFor(sql));
  const withNames = people.filter((p) => p.full_name);

  const done = [];
  const missed = [];

  // Every section that has somebody in it, then every department.
  const units = new Map();
  for (const person of withNames) {
    const key = `${person.department || ''}|${person.unit || ''}`;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(person.full_name);
  }

  for (const [key, names] of units) {
    const [department, unit] = key.split('|');
    const dept = departmentByKey(department);
    const result = await writeNames({
      department: dept ? dept.th : null,
      unit: unit || null,
      names,
    });
    if (result.ok) done.push({ tab: result.tab, listed: result.listed });
    else missed.push({ department: dept ? dept.th : department, unit, reason: result.reason });
  }

  return json({
    ok: true,
    written: done,
    missed,
    withoutFullName: people.filter((p) => !p.full_name).map((p) => p.username),
  });
}

// ---------------------------------------------------------------------------
// Throwing one away
// ---------------------------------------------------------------------------

/**
 * Deleting a document outright.
 *
 * Everything goes — the file, the chain, the history — because the uploader
 * asking for it back means it should never have been sent. The row cascades,
 * so no orphaned steps or events survive.
 */
async function removeDocument(sql, me, id) {
  const found = await loadFor(sql, id);
  if (!found) return json({ error: 'NO_SUCH_DOCUMENT' }, 404);
  const { doc, steps } = found;

  if (!canDeleteDocument(me, doc, steps)) {
    // Naming the reason matters: "somebody already signed it" is a different
    // problem from "this was never yours".
    const mine = (doc.created_by === me.username);
    return json({ error: mine ? 'ALREADY_ACTED_ON' : 'NOT_ALLOWED' }, 403);
  }

  const watchers = await secretaries(sql);
  await sql`DELETE FROM documents WHERE id = ${id}`;
  await tellPeople(sql, {
    usernames: watchers,
    docId: id,
    priority: doc.priority,
    title: `เอกสารถูกยกเลิก: ${doc.title}`,
    body: `${me.display_name || me.username} ยกเลิกเอกสารนี้`,
  });
  return json({ ok: true, deleted: true });
}

export default withNode(handler);
/**
 * The two actions the LINE bot needs.
 *
 * Exported rather than reimplemented so a signature given in a chat goes
 * through exactly the same permission checks, the same stamping and the same
 * notifications as one given on the website. There is one approval path in
 * this app, not two that have to be kept in step.
 */
export const approveDocument = (sql, me, id) => approve(sql, me, { id });
export const rejectDocument = (sql, me, id, comment) => reject(sql, me, { id, comment });

export { rebuildSigned };
