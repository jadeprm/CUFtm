/**
 * The test suite that matters: it proves the permission rules actually hold at
 * the API, not just that they are written down in the interface.
 *
 * Run with a Postgres to hand:
 *   DATABASE_URL=postgres://... node test/run.mjs
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fairv2';

// ---- stub the Google Sheet so tests never depend on the network ------------
const SHEET_CSV = `ลำดับ,ชื่อเล่น,Username,Display Name,ตำแหน่ง,Access,Department
1,เจตน์,Jade\\_Pres,Jade - Project Director,ประธานโครงการ,Admin,All
2,แก้ว,Kaew_VP,Keaw - Deputy Project Director,รองประธานโครงการ,Co-Admin,All
3,กร,Gorn_VP,Gorn - Deputy Project Director,รองประธานโครงการ,Co-Admin,All
4,ต๊อดติ,Totti_HeadOp,Totti - Head Operation,ประธานฝ่ายอำนวยการใหญ่,Co-Admin,OperAll
5,กุ๊งกิ๊ง,Kungking_HeadCon,Kungking - Head Content,ประธานฝ่ายเนื้อหา,Editor,"Content, PR"
6,กล้วยหอม,Kluayhom_HeadMerchant,Kluayhom - Head Merchant,ประธานฝ่ายร้านค้า,Editor,Merchant
7,อิคคิว,Ikkew_HeadOper1,Ikkew - Head Operation 1,ประธานฝ่ายอำนวยการ 1,Editor,Oper 1
8,แยม,Yam_HeadSpon,Yam - Head Sponsor,ประธานฝ่ายหาทุน,Editor,Sponsorship
9,ซันเดย์,Sunday_Sec,Sunday - Head Secretary,หัวหน้าฝ่ายเลขานุการ,Editor,Secretariat
10,โดนัท,Donat_Sec,Donat - Head Secretary,หัวหน้าฝ่ายเลขานุการ,Editor,Secretariat
11,ปิ่น,Pin_Sec,Pin - Secretary,เลขานุการ,Editor,Secretariat
12,นิว,New_UnitCon,New - Stage unit,หัวหน้าหน่วยเวที,Unit Editor,Content
13,พลอย,Ploy_StaffCon,Ploy - Stage staff,สมาชิกฝ่ายเนื้อหา,Inner,Content
14,ฟ้า,Fah_StaffCon,Fah - Exhibition staff,สมาชิกฝ่ายเนื้อหา,Inner,Content
15,,,,,,
`;

let sheetCsv = SHEET_CSV;
const realFetch = globalThis.fetch;
const lineSent = [];
// Set to make LINE refuse the next reply that carries a card, as it does a card it dislikes.
let lineRefuseFlex = false;
let lineFails = null;         // set to a status code to make LINE refuse

/**
 * The Sheets API, stubbed.
 *
 * `sheetValues` is the grid the API would return; `sheetWrites` records every
 * cell the app tries to write, which is the only way to prove that changing
 * somebody's access in the app really reaches the spreadsheet.
 */
/** Every piece of text inside a Flex card, in the order it is laid out. */
const flatten = (node) => collect(node, []).join('\n');

function collect(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (node.type === 'text' && node.text) out.push(node.text);
  if (node.action?.label) out.push(node.action.label);
  if (node.action?.uri) out.push(node.action.uri);
  for (const key of ['contents', 'header', 'body', 'footer', 'hero']) {
    if (node[key]) collect(node[key], out);
  }
  return out;
}

let sheetValues = null;
const sheetWrites = [];
let sheetApiFails = false;

const driveFiles = new Map();
const driveFolders = new Map();
let driveRefuses = false;
let driveTrashed = false;

/**
 * The committee's numbering spreadsheet, stubbed as a real grid.
 *
 * One tab per ฝ่าย, each laid out exactly as theirs is: ฝ่าย and รหัสฝ่าย in
 * B1:C2, the log from row 4, and the name list at H/I. The stub keeps the
 * cells so a test can read back what the app actually wrote.
 */
const REGISTER_ID = 'register-sheet-id';
const registerTabs = new Map();
let registerRefuses = false;

function makeTab(title, name, code, template = true) {
  const grid = [];
  const put = (r, c, v) => {
    while (grid.length <= r) grid.push([]);
    while (grid[r].length <= c) grid[r].push('');
    grid[r][c] = v;
  };
  put(0, 1, 'ฝ่าย'); put(0, 2, name);
  put(1, 1, 'รหัสฝ่าย'); put(1, 2, code);
  put(2, 1, 'เลขรันเอกสาร'); put(2, 2, 'ชื่อเรื่อง'); put(2, 3, 'สถานะ');
  put(2, 4, 'ผู้รับผิดชอบ'); put(2, 5, 'หมายเหตุ'); put(2, 7, 'รายชื่อผู้รับผิดชอบ');
  if (template) { put(3, 0, '1'); put(3, 1, `อบจ.จฬฟ. ${code}-001/2569`); }
  registerTabs.set(title, grid);
}

/** "'ฝ่ายเนื้อหา'!A4:F400" → { tab, r1, c1, r2, c2 } */
function readA1(range) {
  const [rawTab, cells] = String(range).split('!');
  const tab = rawTab.replace(/^'|'$/g, '').replace(/''/g, "'");
  const [from, to] = cells.split(':');
  const point = (ref) => {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(m[2]) - 1, col: col - 1 };
  };
  const a = point(from);
  const b = to ? point(to) : a;
  return { tab, r1: a.row, c1: a.col, r2: b.row, c2: b.col };
}

function registerRead(range) {
  const { tab, r1, c1, r2, c2 } = readA1(range);
  const grid = registerTabs.get(tab) || [];
  const out = [];
  for (let r = r1; r <= r2; r++) {
    const row = [];
    for (let c = c1; c <= c2; c++) row.push((grid[r] || [])[c] ?? '');
    out.push(row);
  }
  // The Sheets API trims trailing empty rows, and code that assumes otherwise
  // breaks against the real thing — so the stub trims them too.
  while (out.length && out[out.length - 1].every((v) => v === '')) out.pop();
  return out;
}

function registerWrite(range, values) {
  const { tab, r1, c1 } = readA1(range);
  if (!registerTabs.has(tab)) registerTabs.set(tab, []);
  const grid = registerTabs.get(tab);
  values.forEach((row, i) => {
    const r = r1 + i;
    while (grid.length <= r) grid.push([]);
    row.forEach((v, j) => {
      const c = c1 + j;
      while (grid[r].length <= c) grid[r].push('');
      grid[r][c] = v;
    });
  });
}

/** What a tab looks like now, as rows of {number, title, status, who}. */
const registerLog = (tab) => (registerTabs.get(tab) || []).slice(3)
  .map((row) => ({ n: row[0] || '', number: row[1] || '', title: row[2] || '',
                   status: row[3] || '', who: row[4] || '' }))
  .filter((r) => r.number || r.title);

globalThis.fetch = async (url, init) => {
  if (String(url).includes('docs.google.com')) {
    if (sheetCsv === null) return new Response('<html>sign in</html>', { status: 200 });
    return new Response(sheetCsv, { status: 200 });
  }
  if (String(url).includes('oauth2.googleapis.com')) {
    return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
  }
  /**
   * Google Drive, stubbed. `driveFiles` is the archive itself, so a test can
   * ask what really landed there — and `driveTrashed` lets one pretend the
   * archive copy vanished, which is the case the purge must refuse.
   */
  if (String(url).includes('/upload/drive/v3/files')) {
    if (driveRefuses) return new Response('{"error":"no room"}', { status: 403 });
    const body = String(init.body);
    const meta = JSON.parse(body.slice(body.indexOf('{'), body.indexOf('}\r\n--') + 1));
    const id = 'drivefile' + (driveFiles.size + 1);
    driveFiles.set(id, { name: meta.name, parents: meta.parents || null, size: init.body.length });
    return new Response(JSON.stringify({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` }),
      { status: 200 });
  }
  if (String(url).match(/\/drive\/v3\/files\?/) && (!init || (init.method || 'GET') === 'GET')) {
    // A folder listing. Under drive.file this only ever returns what the app
    // itself made, so the stub answers from what the app has created here.
    const q = new URL(url).searchParams.get('q') || '';
    const name = (q.match(/name='([^']*)'/) || [])[1];
    const hit = [...driveFolders.entries()].find(([, f]) => f.name === name);
    return new Response(JSON.stringify({ files: hit ? [{ id: hit[0] }] : [] }), { status: 200 });
  }
  if (String(url).match(/\/drive\/v3\/files\?/) && init && init.method === 'POST') {
    const meta = JSON.parse(init.body);
    const id = 'folder' + (driveFolders.size + 1);
    driveFolders.set(id, { name: meta.name });
    return new Response(JSON.stringify({ id }), { status: 200 });
  }
  if (String(url).includes('/drive/v3/files/')) {
    const id = String(url).split('/drive/v3/files/')[1].split('?')[0];
    const f = driveFiles.get(id);
    if (!f) return new Response('{"error":"gone"}', { status: 404 });
    return new Response(JSON.stringify({ id, size: String(f.size), trashed: driveTrashed }), { status: 200 });
  }
  if (String(url).includes('sheets.googleapis.com') && String(url).includes(REGISTER_ID)) {
    if (registerRefuses) return new Response('{"error":"no"}', { status: 403 });

    if (String(url).includes('fields=sheets.properties.title')) {
      return new Response(JSON.stringify({
        sheets: [...registerTabs.keys()].map((title) => ({ properties: { title } })),
      }), { status: 200 });
    }
    if (String(url).includes('values:batchGet')) {
      const ranges = [...new URL(url).searchParams.getAll('ranges')];
      return new Response(JSON.stringify({
        valueRanges: ranges.map((r) => ({ values: registerRead(r) })),
      }), { status: 200 });
    }
    if (String(url).includes('values:batchUpdate')) {
      for (const item of JSON.parse(init.body).data) registerWrite(item.range, item.values);
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }

  if (String(url).includes('sheets.googleapis.com')) {
    if (String(url).includes('values:batchUpdate')) {
      if (sheetApiFails) return new Response('{"error":"no"}', { status: 403 });
      sheetWrites.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify({ values: sheetValues || [] }), { status: 200 });
  }
  if (String(url).includes('api-data.line.me')) {
    lineSent.push({ kind: 'image', bytes: init.body?.length || 0,
                    type: (init.headers || {})['content-type'] });
    return new Response('{}', { status: 200 });
  }
  if (String(url).includes('api.line.me')) {
    if (String(url).includes('/richmenu') && init.method === 'POST' && !String(url).includes('/user/all/')) {
      const body = JSON.parse(init.body);
      lineSent.push({ kind: 'richmenu', size: body.size, areas: body.areas, chatBarText: body.chatBarText });
      return new Response(JSON.stringify({ richMenuId: 'richmenu-test-1' }), { status: 200 });
    }
    if (String(url).includes('/user/all/richmenu')) {
      lineSent.push({ kind: 'richmenu-default', method: init.method || 'POST' });
      return new Response('{}', { status: 200 });
    }
    const body = JSON.parse(init.body);
    lineSent.push({
      kind: String(url).includes('/reply') ? 'reply' : 'push',
      to: body.to || null,
      token: body.replyToken || null,
      /**
       * What the person actually sees. A card is not one string, so the text
       * nodes, the button labels and the link are flattened out of it — the
       * tests assert on what is on screen, not on the message format, so that
       * changing the layout does not quietly stop them checking anything.
       */
      text: (body.messages || []).map((m) =>
        m.type === 'text' ? m.text : flatten(m.contents)).join('\n'),
      flex: (body.messages || []).filter((m) => m.type === 'flex').map((m) => m.contents),
      // The tappable buttons are a separate field; a test that only reads the
      // body would miss half of what the person actually sees.
      labels: (body.messages || []).flatMap((m) =>
        (m.quickReply?.items || []).map((i) => i.action.label)),
      auth: (init.headers || {}).authorization,
    });
    if (lineFails) return new Response('{"message":"refused"}', { status: lineFails });
    if (lineRefuseFlex && (body.messages || []).some((m) => m.type === 'flex')) {
      lineRefuseFlex = false;
      lineSent[lineSent.length - 1].refused = true;
      return new Response('{"message":"A message (messages[0]) in the request body is invalid"}', { status: 400 });
    }
    return new Response('{}', { status: 200 });
  }
  return realFetch(url, init);
};

// LINE, stubbed: real credentials so the signature code runs for real, but
// every call to api.line.me is caught below and recorded instead of sent.
process.env.LINE_CHANNEL_SECRET = 'test_channel_secret_0123456789';
process.env.SITE_URL = process.env.SITE_URL || 'https://fair.test';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_access_token';
process.env.LINE_DIGEST_HOUR = String(new Date().getUTCHours() + 7 >= 24
  ? new Date().getUTCHours() + 7 - 24 : new Date().getUTCHours() + 7);

const { default: authApi } = await import('../api/auth.js');
const { default: usersApi } = await import('../api/users.js');
const { default: tasksApi } = await import('../api/tasks.js');
const { default: cronApi } = await import('../api/cron.js');
const { default: pushApi } = await import('../api/push.js');
const { default: eventsApi } = await import('../api/events.js');
const { canPrioritiseOver, unavailableReason, clashesFor, weekdayOf, overlaps } =
  await import('../lib/availability.js');
const { default: calApi } = await import('../api/calendar.js');
const { default: notifApi } = await import('../api/notifications.js');
const { default: lineApi } = await import('../api/line.js');
const { default: docsApi } = await import('../api/documents.js');
const { getSql } = await import('../lib/db.js');
const { createHmac } = await import('node:crypto');

/** A webhook call signed exactly the way LINE signs one. */
function lineHook(events, { secret = process.env.LINE_CHANNEL_SECRET, breakIt = false } = {}) {
  const raw = JSON.stringify({ destination: 'U0', events });
  const signature = createHmac('SHA256', secret).update(raw, 'utf8').digest('base64');
  return new Request('https://app.test/api/line', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-line-signature': breakIt ? 'AAAA' + signature.slice(4) : signature,
    },
    body: raw,
  });
}
const sayToBot = (userId, textBody, token = 'rt_' + Math.random().toString(36).slice(2)) => ([{
  type: 'message', replyToken: token, source: { type: 'user', userId },
  message: { type: 'text', id: 'm1', text: textBody },
}]);
const lastReply = () => lineSent.filter((m) => m.kind === 'reply').slice(-1)[0]?.text || '';
const lastButtons = () => lineSent.filter((m) => m.kind === 'reply').slice(-1)[0]?.labels || [];

let failed = 0;
let section = '';
const head = (s) => { section = s; console.log('\n' + s); };
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

// ---- request helpers -------------------------------------------------------
const jar = {};
function makeRequest(path, { method = 'GET', body, as } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (as && jar[as]) headers.cookie = `fair_session=${jar[as]}`;
  return new Request('https://app.test' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(fn, path, opts = {}) {
  const res = await fn(makeRequest(path, opts));
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && opts.remember) {
    const m = setCookie.match(/fair_session=([^;]*)/);
    jar[opts.remember] = m ? m[1] : '';
  }
  return { status: res.status, data };
}

// ---- reset -----------------------------------------------------------------
const { sql, ready } = getSql();

/** Today in Bangkok, which is what every deadline in this app is measured in. */
const todayIsoForTest = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
await ready;
await sql`DELETE FROM reminders_sent`;
await sql`DELETE FROM notifications`;
await sql`DELETE FROM task_departments`;
await sql`DELETE FROM task_people`;
await sql`DELETE FROM tasks`;
await sql`DELETE FROM event_people`;
await sql`DELETE FROM event_departments`;
await sql`DELETE FROM events`;
await sql`DELETE FROM task_links`;
await sql`DELETE FROM task_parts`;
await sql`DELETE FROM push_subscriptions`;
await sql`DELETE FROM announcements`;
await sql`DELETE FROM user_departments`;
await sql`DELETE FROM sessions`;
await sql`DELETE FROM meta`;
/**
 * Meetings are not tied to a user row, so deleting the users never took them
 * with it — every run left its meetings behind, dated relative to the day it
 * ran. Once the morning digest learned to mention today's meetings, a pile of
 * them dated today made "somebody with nothing due is left alone" false for a
 * reason that had nothing to do with the digest. The children go with them
 * (ON DELETE CASCADE); the decisions about whose booking wins are cleared too.
 */
await sql`DELETE FROM meetings`;
await sql`DELETE FROM precedence`;
await sql`DELETE FROM users`;

// ===========================================================================
head('1. Sheet sync');
let r = await call(authApi, '/api/auth?do=check', { method: 'POST', body: { username: 'Jade_Pres' } });
ok('empty database pulls the roster automatically', r.data.known === true, JSON.stringify(r.data).slice(0, 90));
ok('markdown-escaped username (Jade\\_Pres) parsed correctly', r.data.displayName === 'Jade - Project Director');
ok('first login needs a password set', r.data.needsSetup === true);

const roster = await sql`SELECT username, access, department, is_head FROM users ORDER BY username`;
ok('all 14 rows imported, blank row skipped', roster.length === 14, `${roster.length} users`);
const byName = Object.fromEntries(roster.map((u) => [u.username, u]));
ok('Admin mapped from "Admin"', byName.Jade_Pres.access === 'admin');
ok('Co-Admin mapped from "Co-Admin"', byName.Kaew_VP.access === 'coadmin');
ok('Editor mapped', byName.Kungking_HeadCon.access === 'editor');
ok('department guessed from ตำแหน่ง', byName.Kungking_HeadCon.department === 'content', String(byName.Kungking_HeadCon.department));
ok('Oper 1 is its own department, not one Operations pile',
  byName.Ikkew_HeadOper1.department === 'oper1' && byName.Ikkew_HeadOper1.is_head === true,
  String(byName.Ikkew_HeadOper1.department));
ok('merchant head detected', byName.Kluayhom_HeadMerchant.department === 'merchant');

const grantsAfterSync = await sql`SELECT username, department FROM user_departments ORDER BY username, department`;
const grantOf = (u) => grantsAfterSync.filter((g) => g.username === u).map((g) => g.department);
ok('a two-department cell ("Content, PR") grants both',
  grantOf('Kungking_HeadCon').join(',') === 'content,pr', grantOf('Kungking_HeadCon').join(','));
ok('"All" is a flag, not fifteen rows',
  byName.Jade_Pres === undefined || grantOf('Jade_Pres').length === 0);
ok('...and it is recorded as all_departments',
  (await sql`SELECT all_departments FROM users WHERE username = 'Jade_Pres'`)[0].all_departments === true);
ok('"OperAll" grants the umbrella and its three divisions',
  grantOf('Totti_HeadOp').join(',') === 'oper1,oper2,oper3,operations', grantOf('Totti_HeadOp').join(','));

// ===========================================================================
head('2. First password, and who may set one');
r = await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Jade_Pres', password: 'short1' } });
ok('rejects a short password', r.status === 400 && r.data.error === 'TOO_SHORT');
r = await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Jade_Pres', password: 'allletters' } });
ok('rejects a password with no number', r.data.error === 'NEEDS_NUMBER');
r = await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Jade_Pres', password: 'password1' } });
ok('rejects an obvious password', r.data.error === 'TOO_COMMON');

r = await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Jade_Pres', password: 'fairAdmin1' }, remember: 'admin' });
ok('admin sets their first password and is signed in', r.status === 200 && r.data.user.access === 'admin');
ok('a session cookie was issued', Boolean(jar.admin));

// THE important one: nobody can overwrite an existing password unasked.
r = await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Jade_Pres', password: 'hijacked9' } });
ok('CANNOT overwrite an existing password without authorisation',
  r.status === 403 && r.data.error === 'RESET_NOT_AUTHORISED');
r = await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Jade_Pres', password: 'hijacked9' } });
ok('the attempted hijack password does not work', r.status === 401);
r = await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Jade_Pres', password: 'fairAdmin1' } });
ok('the real password still works', r.status === 200);
r = await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Jade_Pres', password: 'wrongpass1' } });
ok('a wrong password is refused', r.status === 401 && r.data.error === 'BAD_CREDENTIALS');

// sign in the others
for (const [name, pw, key] of [
  ['Kaew_VP', 'coadminPw1', 'coadmin'],
  ['Gorn_VP', 'coadminPw2', 'coadmin2'],
  ['Kungking_HeadCon', 'editorPw1', 'editor'],
  ['Ikkew_HeadOper1', 'editorPw2', 'editor2'],
]) {
  await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: name, password: pw }, remember: key });
}
ok('co-admin and editors signed in', Boolean(jar.coadmin && jar.editor && jar.editor2));

// ===========================================================================
head('3. Permission boundaries (the brief’s core rules)');
r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'editor', body: { username: 'Kaew_VP', suspended: true } });
ok('editor CANNOT manage accounts', r.status === 403 && r.data.error === 'EDITORS_CANNOT_MANAGE_ACCOUNTS');

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'coadmin', body: { username: 'Jade_Pres', allowReset: true } });
ok('co-admin CANNOT authorise a reset for an ADMIN', r.status === 403 && r.data.error === 'COADMIN_CANNOT_TOUCH_ADMIN');

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'coadmin', body: { username: 'Gorn_VP', suspended: true } });
ok('co-admin CANNOT suspend another CO-ADMIN', r.status === 403 && r.data.error === 'COADMIN_CANNOT_TOUCH_COADMIN');

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'coadmin', body: { username: 'Kungking_HeadCon', department: 'content' } });
ok('co-admin CAN manage an editor', r.status === 200);

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin', body: { username: 'Kaew_VP', department: 'exec' } });
ok('admin CAN manage a co-admin', r.status === 200);

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'coadmin', body: { username: 'Kungking_HeadCon', access: 'admin' } });
ok('a CO-ADMIN cannot hand out access levels (no promoting a proxy)',
  r.status === 403 && r.data.error === 'ONLY_ADMIN_SETS_ACCESS');
ok('...and the attempt changed nothing',
  (await sql`SELECT access FROM users WHERE username = 'Kungking_HeadCon'`)[0].access === 'editor');

r = await call(usersApi, '/api/users', { as: 'editor' });
ok('editor can still read the directory', r.status === 200 && r.data.users.length === 14);
ok('directory tells the editor they cannot manage', r.data.canManage === false);

r = await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'editor' });
ok('editor cannot trigger a sheet sync', r.status === 403);

r = await call(usersApi, '/api/users', {});
ok('a signed-out request is refused', r.status === 401);

// ===========================================================================
head('4. Password reset, start to finish');
r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin', body: { username: 'Kungking_HeadCon', allowReset: true } });
ok('admin authorises a reset', r.status === 200 && r.data.user.resetAllowed === true);
ok('it records who authorised it', r.data.user.resetAllowedBy === 'Jade_Pres');

r = await call(tasksApi, '/api/tasks', { as: 'editor' });
ok('authorising a reset ends that person’s existing sessions', r.status === 401);

r = await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Kungking_HeadCon', password: 'editorPw1' } });
ok('the old password stops working during a pending reset', r.status === 403 && r.data.error === 'RESET_PENDING');

r = await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Kungking_HeadCon', password: 'brandNew22' }, remember: 'editor' });
ok('the person sets a new password themselves', r.status === 200);
r = await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Kungking_HeadCon', password: 'again1234' } });
ok('the reset window closes after one use', r.status === 403);

// ===========================================================================
head('5. Suspension');
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin', body: { username: 'Ikkew_HeadOper1', suspended: true } });
r = await call(tasksApi, '/api/tasks', { as: 'editor2' });
ok('suspending someone kills their live session immediately', r.status === 401);
r = await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Ikkew_HeadOper1', password: 'editorPw2' } });
ok('a suspended person cannot sign back in', r.status === 401);
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin', body: { username: 'Ikkew_HeadOper1', suspended: false } });
r = await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Ikkew_HeadOper1', password: 'editorPw2' }, remember: 'editor2' });
ok('restoring them lets them back in', r.status === 200);

// ===========================================================================
head('6. Tasks, tagging and departments');
await sql`UPDATE users SET department = 'content', is_head = true WHERE username = 'Kungking_HeadCon'`;
await sql`UPDATE users SET department = 'content', is_head = false WHERE username = 'Ikkew_HeadOper1'`;
await sql`INSERT INTO user_departments (username, department) VALUES ('Ikkew_HeadOper1', 'content')
          ON CONFLICT DO NOTHING`;

r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: {
    title: 'จัดเวทีกลาง', description: 'ประสานงานกับฝ่ายสถานที่',
    dueDate: '2026-10-05', dueTime: '18:30',
    assignees: ['Kaew_VP'], departments: [{ key: 'content', scope: 'heads' }],
    notify: ['created', '7d', '24h', 'due'],
  },
});
const task = r.data.task;
ok('task created with Thai text intact', r.status === 201 && task.title === 'จัดเวทีกลาง');
ok('due time kept', task.dueTime === '18:30');
ok('due date not shifted by a timezone', task.dueDate === '2026-10-05', String(task.dueDate));
ok('tagging "heads of Content" pulled in the head', task.assignees.includes('Kungking_HeadCon'));
ok('...and NOT the non-head member', !task.assignees.includes('Ikkew_HeadOper1'), task.assignees.join(','));
ok('the explicitly named person is there too', task.assignees.includes('Kaew_VP'));
ok('department tag recorded with its scope',
  task.departments.some((d) => d.key === 'content' && d.scope === 'heads'));

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin',
  body: { id: task.id, departments: [{ key: 'content', scope: 'all' }], assignees: ['Kaew_VP'] },
});
ok('switching to "everyone in Content" adds the member',
  r.data.task.assignees.includes('Ikkew_HeadOper1') && r.data.task.assignees.includes('Kungking_HeadCon'));

r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'editor', body: { id: task.id, status: 'doing' } });
ok('an editor can edit a task someone else created', r.status === 200 && r.data.task.status === 'doing');
ok('a status-only change kept the title', r.data.task.title === 'จัดเวทีกลาง');
ok('...and kept the due time', r.data.task.dueTime === '18:30');
ok('...and kept the assignees', r.data.task.assignees.length >= 3, String(r.data.task.assignees.length));

r = await call(notifApi, '/api/notifications', { as: 'editor' });
ok('people tagged were notified on creation', r.data.notifications.some((n) => n.kind === 'created'));
ok('the creator did not notify themselves',
  !(await call(notifApi, '/api/notifications', { as: 'admin' })).data.notifications.some((n) => n.taskId === task.id));

// ===========================================================================
head('7. Reminders fire once, on the right days');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date());
const plus = (n) => {
  const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
await sql`UPDATE tasks SET due_date = ${plus(7)}, status = 'todo' WHERE id = ${task.id}`;

r = await call(cronApi, '/api/cron', {});
const first = r.data.remindersCreated;
ok('a task due in 7 days triggers the 7-day reminder', first > 0, `${first} sent`);
ok('every reminder was the 7-day kind', r.data.created.every((c) => c.kind === '7d'));

r = await call(cronApi, '/api/cron', {});
ok('running again sends nothing (no hourly spam)', r.data.remindersCreated === 0);

await sql`UPDATE tasks SET due_date = ${plus(1)} WHERE id = ${task.id}`;
r = await call(cronApi, '/api/cron', {});
ok('a day before, the 24-hour reminder goes out', r.data.remindersCreated > 0 && r.data.created.every((c) => c.kind === '24h'));

await sql`UPDATE tasks SET due_date = ${plus(3)} WHERE id = ${task.id}`;
r = await call(cronApi, '/api/cron', {});
ok('nothing fires on a day with no rule', r.data.remindersCreated === 0);

await sql`UPDATE tasks SET due_date = ${plus(7)}, notify = 'created' WHERE id = ${task.id}`;
await sql`DELETE FROM reminders_sent WHERE task_id = ${task.id}`;
r = await call(cronApi, '/api/cron', {});
ok('a creator who turned reminders off gets none', r.data.remindersCreated === 0);

await sql`UPDATE tasks SET due_date = ${plus(7)}, notify = '7d', status = 'done' WHERE id = ${task.id}`;
r = await call(cronApi, '/api/cron', {});
ok('finished tasks stop reminding anyone', r.data.remindersCreated === 0);

// ===========================================================================
head('8. A re-sync must not destroy what people have set');
await sql`UPDATE users SET avatar = 'data:image/jpeg;base64,AAA', display_name = 'My Own Name' WHERE username = 'Kaew_VP'`;
const beforeHash = (await sql`SELECT password_hash FROM users WHERE username = 'Jade_Pres'`)[0].password_hash;

r = await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
ok('sync runs', r.status === 200, JSON.stringify(r.data).slice(0, 60));

const after = Object.fromEntries((await sql`SELECT * FROM users`).map((u) => [u.username, u]));
ok('passwords survive a sync', after.Jade_Pres.password_hash === beforeHash);
ok('profile pictures survive a sync', after.Kaew_VP.avatar === 'data:image/jpeg;base64,AAA');
ok('a personalised display name is not overwritten', after.Kaew_VP.display_name === 'My Own Name');
ok('an admin-set department survives', after.Kungking_HeadCon.department === 'content');

// someone removed from the sheet loses access but keeps their history
sheetCsv = SHEET_CSV.split('\n').filter((l) => !l.startsWith('5,')).join('\n');
await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
const gone = (await sql`SELECT active FROM users WHERE username = 'Kungking_HeadCon'`)[0];
ok('removing a row from the sheet deactivates that account', gone.active === false);
r = await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Kungking_HeadCon', password: 'brandNew22' } });
ok('a removed person can no longer sign in', r.status === 401);

sheetCsv = null; // simulate the sheet becoming private
r = await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
ok('an unreadable sheet fails loudly instead of wiping the roster', r.status === 502);
const survived = await sql`SELECT count(*)::int AS n FROM users`;
ok('...and every account is still there', survived[0].n === 14, `${survived[0].n} users`);
sheetCsv = SHEET_CSV;


// ===========================================================================
head('9. Vercel hands handlers a RELATIVE request.url');
/**
 * This section exists because of a real outage. Every test above builds a
 * Request with an absolute URL, because that is the only way to construct one.
 * Vercel's runtime instead sets request.url to a bare path, and `new URL()`
 * throws on that — so the whole API returned 500 in production while every
 * test here passed. These fakes reproduce the real shape.
 */
function vercelRequest(path, { method = 'GET', body, as } = {}) {
  const headers = new Headers(body ? { 'content-type': 'application/json' } : {});
  if (as && jar[as]) headers.set('cookie', `fair_session=${jar[as]}`);
  return { url: path, method, headers, json: async () => (body ?? {}) };
}

for (const [label, fn, path, opts] of [
  ['GET /api/auth', authApi, '/api/auth', {}],
  ['POST /api/auth?do=check', authApi, '/api/auth?do=check', { method: 'POST', body: { username: 'Jade_Pres' } }],
  ['GET /api/tasks', tasksApi, '/api/tasks', { as: 'admin' }],
  ['GET /api/users', usersApi, '/api/users', { as: 'admin' }],
  ['DELETE /api/tasks?id=x', tasksApi, '/api/tasks?id=nope', { method: 'DELETE', as: 'admin' }],
  ['GET /api/cron', cronApi, '/api/cron', {}],
]) {
  let status = 0; let text = '';
  try {
    const res = await fn(vercelRequest(path, opts));
    status = res.status; text = await res.text();
  } catch (error) {
    text = 'THREW: ' + error.message;
  }
  ok(`${label} works with a path-only url`,
    status !== 0 && status !== 500 && !/Invalid URL/i.test(text),
    'HTTP ' + status);
}


// ===========================================================================
head('10. Reading the Department column');
const { parseDepartmentList, expandAccess } = await import('../lib/departments.js');

let p = parseDepartmentList('All');
ok('"All" means every department', p.all === true && p.keys.length === 0);
p = parseDepartmentList('Content, PR');
ok('a comma list gives both keys', p.keys.join(',') === 'content,pr', p.keys.join(','));
p = parseDepartmentList('Oper 1');
ok('"Oper 1" and "Oper1" are the same thing',
  p.keys.join(',') === 'oper1' && parseDepartmentList('Oper1').keys.join(',') === 'oper1');
p = parseDepartmentList('OperAll');
ok('"OperAll" expands to the umbrella plus its divisions',
  p.keys.sort().join(',') === 'oper1,oper2,oper3,operations', p.keys.join(','));

/**
 * The president's team. The roster writes these cells as "All, President" —
 * the All was always read, but the extra word was not, and the sync reported
 * it as an unreadable cell on every run. It is the same teamspace as
 * ประธานโครงการ.
 */
p = parseDepartmentList('All, President');
ok('"All, President" is every department, and nothing left unread',
  p.all === true && p.keys.join(',') === 'exec' && p.unknown.length === 0,
  JSON.stringify(p));
p = parseDepartmentList('All, President, Secretariat');
ok('...and the secretaries keep their secretariat with it',
  p.all === true && p.keys.sort().join(',') === 'exec,secretariat' && p.unknown.length === 0,
  JSON.stringify(p));
p = parseDepartmentList('President');
ok('"President" on its own is the ประธานโครงการ teamspace',
  p.keys.join(',') === 'exec' && p.unknown.length === 0, JSON.stringify(p));
ok('"Merch" is Sponsorship, not Merchant',
  parseDepartmentList('Merch').keys.join(',') === 'sponsor');
ok('"Merchant" is still Merchant',
  parseDepartmentList('Merchant').keys.join(',') === 'merchant');
p = parseDepartmentList('Content, Oper 9');
ok('an unreadable cell is reported, not silently dropped',
  p.keys.join(',') === 'content' && p.unknown.join(',') === 'Oper 9', JSON.stringify(p));
ok('a blank cell grants nothing', parseDepartmentList('').keys.length === 0);

// ===========================================================================
head('11. Department access decides who sees which tasks');
// Put the roster back the way the sheet has it after section 8's experiments.
sheetCsv = SHEET_CSV;
await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });

await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Kungking_HeadCon', password: 'brandNew22' }, remember: 'content' });
await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Kluayhom_HeadMerchant', password: 'merchPw123' }, remember: 'merch' });
await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Ikkew_HeadOper1', password: 'editorPw2' }, remember: 'oper' });
ok('three editors in three departments are signed in',
  Boolean(jar.content && jar.merch && jar.oper));

async function make(dept, title, extra = {}) {
  const res = await call(tasksApi, '/api/tasks', {
    method: 'POST', as: 'admin',
    body: { title, department: dept, assignees: [], departments: [], notify: [], ...extra },
  });
  return res.data.task;
}
const tContent = await make('content', 'เวทีกลาง');
const tMerch = await make('merchant', 'ร้านค้านิสิต');
const tOper1 = await make('oper1', 'ทะเบียนบัตร');
const tPr = await make('pr', 'โพสต์เปิดงาน');

const seenBy = async (who) =>
  (await call(tasksApi, '/api/tasks', { as: who })).data.tasks.map((x) => x.id);

let mine = await seenBy('content');
ok('a Content head sees the Content task', mine.includes(tContent.id));
ok('...and the PR task, because the sheet gives them both', mine.includes(tPr.id));
ok('...but NOT the Merchant task', !mine.includes(tMerch.id));
ok('...and NOT the Operations 1 task', !mine.includes(tOper1.id));

mine = await seenBy('merch');
ok('a Merchant head sees only their own', mine.includes(tMerch.id) && !mine.includes(tContent.id));

mine = await seenBy('oper');
ok('an Oper 1 head sees the Oper 1 task', mine.includes(tOper1.id));
ok('...and not Content', !mine.includes(tContent.id));

mine = await seenBy('admin');
ok('the admin sees all four', [tContent, tMerch, tOper1, tPr].every((x) => mine.includes(x.id)));

// Co-admin Totti has OperAll — the umbrella case, tested through an editor below.
r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', departments: ['operations'] },
});
ok('granting the Operations umbrella works', r.status === 200);
mine = await seenBy('merch');
ok('...and it carries the three divisions with it', mine.includes(tOper1.id), mine.join(','));
ok('...while dropping the department that was replaced', !mine.includes(tMerch.id));

// Cross-department work must stay possible.
await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin',
  body: { id: tContent.id, assignees: ['Kluayhom_HeadMerchant'] },
});
mine = await seenBy('merch');
ok('being tagged in another department\u2019s task makes it visible',
  mine.includes(tContent.id));

r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'merch',
  body: { title: 'ขอกราฟิก', department: 'pr' },
});
ok('filing into a department you do not have is refused',
  r.status === 403 && r.data.error === 'NOT_YOUR_DEPARTMENT');

r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'content',
  body: { title: 'โพสต์ประกาศ', department: 'pr' },
});
ok('...but filing into your second department is allowed',
  r.status === 201 && r.data.task.department === 'pr');

// ===========================================================================
head('12. Admins change department access from the app');
r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', departments: ['merchant', 'content'] },
});
ok('an admin can set the whole list at once', r.status === 200);
ok('the directory row comes back with both',
  r.data.user.departments.sort().join(',') === 'content,merchant', r.data.user.departments.join(','));
ok('and is marked as set in the app', r.data.user.deptsPinned === true);

r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', departments: ['merchant'] },
});
ok('removing one is the same call with a shorter list',
  r.data.user.departments.join(',') === 'merchant');

r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', departments: [] },
});
ok('clearing access is an empty list', r.data.user.departments.length === 0);
ok('...and the home teamspace is cleared with it', r.data.user.department === null);
mine = await seenBy('merch');
ok('someone with no department sees only their own and tagged work',
  !mine.includes(tMerch.id) && mine.includes(tContent.id), mine.join(','));

r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', departments: ['nonsense'] },
});
ok('an unknown department key is refused', r.status === 400 && r.data.error === 'BAD_DEPARTMENT');

r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', department: 'legal' },
});
ok('a home teamspace they have no access to is refused',
  r.status === 400 && r.data.error === 'HOME_NOT_GRANTED');

r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', allDepartments: true },
});
ok('the "all departments" switch can be turned on here', r.data.user.allDepartments === true);
r = await call(tasksApi, '/api/tasks', { as: 'merch' });
ok('...and that person then sees everything', r.data.seesEverything === true && r.data.tasks.length >= 4);

r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'editor2', body: { username: 'Kluayhom_HeadMerchant', departments: ['pr'] },
});
ok('an editor cannot change anyone\u2019s access',
  r.status === 403 && r.data.error === 'EDITORS_CANNOT_MANAGE_ACCOUNTS');

// ===========================================================================
head('13. A sync must not undo what an admin set here');
await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', allDepartments: false, departments: ['content'] },
});
r = await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
ok('the sync reports how many people it skipped', r.data.pinned >= 1, String(r.data.pinned));

const pinnedNow = await sql`SELECT department FROM user_departments
                            WHERE username = 'Kluayhom_HeadMerchant' ORDER BY department`;
ok('an access change made in the app survives a sheet sync',
  pinnedNow.map((x) => x.department).join(',') === 'content',
  pinnedNow.map((x) => x.department).join(','));

r = await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin', body: { username: 'Kluayhom_HeadMerchant', followSheet: true },
});
ok('"follow the sheet again" clears the override', r.data.user.deptsPinned === false);

await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
const backFromSheet = await sql`SELECT department FROM user_departments
                                WHERE username = 'Kluayhom_HeadMerchant'`;
ok('...and the next sync puts the sheet back in charge',
  backFromSheet.map((x) => x.department).join(',') === 'merchant',
  backFromSheet.map((x) => x.department).join(','));

// An unreadable cell must be named, not swallowed.
sheetCsv = SHEET_CSV.replace('Editor,Sponsorship', 'Editor,Oper 9');
r = await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
ok('a Department cell nobody can read is reported by username',
  (r.data.unreadable || []).some((x) => x.username === 'Yam_HeadSpon' && x.cells.includes('Oper 9')),
  JSON.stringify(r.data.unreadable));
sheetCsv = SHEET_CSV;

// ===========================================================================
head('14. Tagging a department reaches everyone granted it');
await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'ประชุม PR', department: 'pr', departments: [{ key: 'pr', scope: 'all' }], notify: [] },
});
ok('tagging PR reaches the Content head, who also has PR',
  r.data.task.assignees.includes('Kungking_HeadCon'), r.data.task.assignees.join(','));
ok('...and does not sweep in the directors who have "All"',
  !r.data.task.assignees.includes('Jade_Pres'), r.data.task.assignees.join(','));



// ===========================================================================
head('15. Phone notifications');
/**
 * Real delivery goes to Apple's and Google's servers, which a test cannot
 * reach. So the encryption and signing are exercised for real against a
 * stubbed endpoint — proving we produce a valid, correctly signed, encrypted
 * request — and only the final network hop is intercepted.
 */
const pushCalls = [];
const realFetch2 = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url?.url || url);
  if (href.includes('push.test')) {
    pushCalls.push({
      url: href,
      headers: Object.fromEntries(new Headers(init?.headers || {}).entries()),
      bodyLength: init?.body?.length ?? 0,
    });
    return new Response('', { status: 201 });
  }
  if (href.includes('gone.test')) return new Response('', { status: 410 });
  // Apple's real refusal when it dislikes the signature, body and all.
  if (href.includes('refuse.test')) {
    return new Response('{"reason":"BadJwtToken"}', { status: 403 });
  }
  if (href.includes('docs.google.com')) {
    if (sheetCsv === null) return new Response('<html>sign in</html>', { status: 200 });
    return new Response(sheetCsv, { status: 200 });
  }
  return realFetch2(url, init);
};

r = await call(pushApi, '/api/push?do=key', { as: 'admin' });
ok('a signing key is issued without anyone configuring one', r.status === 200 && r.data.publicKey.length > 80);
const firstKey = r.data.publicKey;
r = await call(pushApi, '/api/push?do=key', { as: 'coadmin' });
ok('...and it is the SAME key for everyone, not one per request', r.data.publicKey === firstKey);
ok('the key survives a restart because it lives in the database',
  JSON.parse((await sql`SELECT value FROM meta WHERE key = 'vapid'`)[0].value).publicKey === firstKey);

// A subscription shaped exactly as a browser produces one.
const { createECDH, randomBytes } = await import('node:crypto');
const browserKeys = (() => {
  // A real P-256 key pair, generated the way a browser does. A made-up string
  // is not enough: the payload encryption performs an actual key agreement
  // against this, and would reject anything that is not a point on the curve.
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
})();
const fakeSub = (endpoint) => ({ endpoint, keys: browserKeys });

r = await call(pushApi, '/api/push?do=subscribe', {
  method: 'POST', as: 'admin', body: { subscription: fakeSub('https://push.test/one') },
});
ok('a browser can register for notifications', r.status === 200);
r = await call(pushApi, '/api/push?do=subscribe', {
  method: 'POST', as: 'admin', body: { subscription: fakeSub('https://push.test/two') },
});
ok('a second device is a second registration, not a replacement',
  (await sql`SELECT count(*)::int n FROM push_subscriptions WHERE username = 'Jade_Pres'`)[0].n === 2);

// The same phone, now signed in as someone else.
r = await call(pushApi, '/api/push?do=subscribe', {
  method: 'POST', as: 'content', body: { subscription: fakeSub('https://push.test/two') },
});
const owner = (await sql`SELECT username FROM push_subscriptions WHERE endpoint = 'https://push.test/two'`)[0];
ok('a shared phone follows whoever signed in last, and is not duplicated',
  owner.username === 'Kungking_HeadCon' &&
  (await sql`SELECT count(*)::int n FROM push_subscriptions WHERE endpoint = 'https://push.test/two'`)[0].n === 1);

r = await call(pushApi, '/api/push?do=subscribe', { method: 'POST', as: 'admin', body: { subscription: { endpoint: '' } } });
ok('a malformed subscription is refused', r.status === 400 && r.data.error === 'BAD_SUBSCRIPTION');

pushCalls.length = 0;
r = await call(pushApi, '/api/push?do=test', { method: 'POST', as: 'admin' });
ok('a test notification is actually sent', r.status === 200 && pushCalls.length === 1, JSON.stringify(r.data));
ok('...signed with a VAPID token the push service can check',
  /vapid t=.+,\s*k=.+/i.test(pushCalls[0]?.headers?.authorization || ''), pushCalls[0]?.headers?.authorization?.slice(0, 40));
ok('...with an encrypted body, not readable text',
  pushCalls[0]?.headers['content-encoding'] === 'aes128gcm' && pushCalls[0].bodyLength > 0);

r = await call(pushApi, '/api/push?do=prefs', { method: 'PATCH', as: 'admin', body: { pushEnabled: false } });
pushCalls.length = 0;
r = await call(pushApi, '/api/push?do=test', { method: 'POST', as: 'admin' });
ok('someone who turned notifications off gets none', pushCalls.length === 0 && r.status === 409);
await call(pushApi, '/api/push?do=prefs', { method: 'PATCH', as: 'admin', body: { pushEnabled: true } });

// A subscription the push service says is gone for good.
await sql`INSERT INTO push_subscriptions (endpoint, username, p256dh, auth)
          VALUES ('https://gone.test/x', 'Jade_Pres', ${browserKeys.p256dh}, ${browserKeys.auth})`;
await call(pushApi, '/api/push?do=test', { method: 'POST', as: 'admin' });
ok('a dead subscription is cleaned up rather than retried forever',
  (await sql`SELECT count(*)::int n FROM push_subscriptions WHERE endpoint = 'https://gone.test/x'`)[0].n === 0);

r = await call(pushApi, '/api/push?do=unsubscribe', { method: 'POST', as: 'admin', body: {} });
ok('someone can unregister every device at once',
  (await sql`SELECT count(*)::int n FROM push_subscriptions WHERE username = 'Jade_Pres'`)[0].n === 0);

// ===========================================================================
head('16. Announcements');
r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'editor2', body: { title: 'ทดสอบ', audience: { kind: 'everyone' } },
});
ok('an editor cannot send an announcement',
  r.status === 403 && r.data.error === 'EDITORS_CANNOT_ANNOUNCE');

r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'admin', body: { title: '', audience: { kind: 'everyone' } },
});
ok('an announcement with no subject is refused', r.status === 400 && r.data.error === 'TITLE_REQUIRED');

pushCalls.length = 0;
r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'admin',
  body: {
    title: 'ประชุมใหญ่พรุ่งนี้',
    body: 'เจอกันที่ห้องประชุม ชั้น 4 เวลา 17:00 น.',
    level: 'normal',
    audience: { kind: 'everyone' },
  },
});
ok('an admin can send to everyone', r.status === 201, JSON.stringify(r.data).slice(0, 80));
const annId = r.data.id;
ok('the sender is not sent their own announcement',
  (await sql`SELECT count(*)::int n FROM notifications
             WHERE announcement_id = ${annId} AND username = 'Jade_Pres'`)[0].n === 0);
ok('everyone else gets it in the bell, phone or no phone',
  r.data.recipients >= 7, String(r.data.recipients));
ok('it reached the one device that was registered', r.data.reached === 1 && pushCalls.length === 1);
ok('the Thai subject survived intact',
  (await sql`SELECT title FROM announcements WHERE id = ${annId}`)[0].title === 'ประชุมใหญ่พรุ่งนี้');

r = await call(notifApi, '/api/notifications', { as: 'content' });
const gotIt = r.data.notifications.find((n) => n.announcementId === annId);
ok('a recipient sees the full message, not a truncated one',
  gotIt && gotIt.body === 'เจอกันที่ห้องประชุม ชั้น 4 เวลา 17:00 น.');
ok('a normal announcement does not demand acknowledgement', gotIt.level === 'normal');

// Departments
r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'admin',
  body: { title: 'เฉพาะฝ่ายร้านค้า', audience: { kind: 'departments', departments: ['merchant'] } },
});
const merchOnly = await sql`SELECT username FROM notifications WHERE announcement_id = ${r.data.id}`;
const merchNames = merchOnly.map((x) => x.username);
ok('sending to one department reaches its head', merchNames.includes('Kluayhom_HeadMerchant'), merchNames.join(','));
ok('...and not a head of an unrelated department', !merchNames.includes('Yam_HeadSpon'), merchNames.join(','));

// Specific people
r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'admin',
  body: { title: 'ถึงสองคนนี้', audience: { kind: 'people', people: ['Kungking_HeadCon', 'Yam_HeadSpon'] } },
});
ok('sending to named people reaches exactly them', r.data.recipients === 2, String(r.data.recipients));

r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'admin', body: { title: 'ไม่มีใคร', audience: { kind: 'people', people: [] } },
});
ok('an announcement with nobody selected is refused',
  r.status === 400 && r.data.error === 'NO_RECIPIENTS');

// Suspended people must not keep receiving committee announcements.
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin', body: { username: 'Yam_HeadSpon', suspended: true } });
r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'admin', body: { title: 'หลังพักงาน', audience: { kind: 'everyone' } },
});
const afterSuspend = await sql`SELECT username FROM notifications WHERE announcement_id = ${r.data.id}`;
ok('a suspended person is left out', !afterSuspend.map((x) => x.username).includes('Yam_HeadSpon'));
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin', body: { username: 'Yam_HeadSpon', suspended: false } });

// ===========================================================================
head('17. Urgent messages must be acknowledged');
r = await call(pushApi, '/api/push?do=announce', {
  method: 'POST', as: 'admin',
  body: { title: 'ด่วน: เปลี่ยนสถานที่', body: 'ย้ายไปหอประชุมใหญ่', level: 'urgent',
          audience: { kind: 'people', people: ['Kungking_HeadCon'] } },
});
const urgentId = r.data.id;
ok('an urgent announcement sends', r.status === 201);

r = await call(notifApi, '/api/notifications', { as: 'content' });
const urgentNote = r.data.notifications.find((n) => n.announcementId === urgentId);
ok('it arrives marked urgent', urgentNote.level === 'urgent');
ok('and is listed as waiting for acknowledgement', r.data.pending.includes(urgentNote.id));
ok('it is not acknowledged just by arriving', urgentNote.acked === false);

r = await call(pushApi, '/api/push?do=who&id=' + urgentId, { as: 'admin' });
ok('the sender can see who has not seen it yet',
  r.data.people.length === 1 && r.data.people[0].acked === false);

// Reading it is not the same as acknowledging it.
await call(notifApi, '/api/notifications', { method: 'PATCH', as: 'content', body: { ids: [urgentNote.id] } });
r = await call(pushApi, '/api/push?do=who&id=' + urgentId, { as: 'admin' });
ok('opening it counts as read but NOT as acknowledged',
  r.data.people[0].read === true && r.data.people[0].acked === false);

r = await call(notifApi, '/api/notifications?do=ack', { method: 'PATCH', as: 'content', body: { id: urgentNote.id } });
ok('acknowledging works', r.status === 200);
r = await call(pushApi, '/api/push?do=who&id=' + urgentId, { as: 'admin' });
ok('...and the sender sees it', r.data.people[0].acked === true);

r = await call(notifApi, '/api/notifications', { as: 'content' });
ok('it stops nagging once acknowledged', !r.data.pending.includes(urgentNote.id));

r = await call(pushApi, '/api/push?do=sent', { as: 'admin' });
const summary = r.data.announcements.find((a) => a.id === urgentId);
ok('the sent list counts acknowledgements', summary.ackCount === 1 && summary.recipients === 1);
r = await call(pushApi, '/api/push?do=sent', { as: 'editor2' });
ok('an editor cannot read the sent list', r.status === 403);

// ===========================================================================
head('18. Due-date reminders reach the phone');
await sql`INSERT INTO push_subscriptions (endpoint, username, p256dh, auth)
          VALUES ('https://push.test/due', 'Kungking_HeadCon', ${browserKeys.p256dh}, ${browserKeys.auth})
          ON CONFLICT (endpoint) DO UPDATE SET username = EXCLUDED.username`;
await sql`DELETE FROM reminders_sent`;
const dueTask = (await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'ส่งไฟล์โปสเตอร์', dueDate: plus(7), assignees: ['Kungking_HeadCon'],
          notify: ['7d'], department: 'content' },
})).data.task;

pushCalls.length = 0;
r = await call(cronApi, '/api/cron', {});
ok('the 7-day reminder still fires', r.data.remindersCreated >= 1);
ok('...and now also goes to the phone', r.data.pushesSent >= 1 && pushCalls.length >= 1, String(r.data.pushesSent));

pushCalls.length = 0;
await sql`DELETE FROM reminders_sent`;
await sql`UPDATE tasks SET due_date = ${today}, due_time = '08:00' WHERE id = ${dueTask.id}`;
await sql`UPDATE tasks SET notify = 'due' WHERE id = ${dueTask.id}`;
r = await call(cronApi, '/api/cron', {});
const dueFired = r.data.created.some((c) => c.kind === 'due');
ok('a deadline that has arrived is sent as urgent',
  !dueFired || r.data.pushesSent >= 1, JSON.stringify(r.data.created));


// ===========================================================================
head('19. When a push is refused, say why');
/**
 * The failure this section exists for: the profile page reported "on" while
 * the server held no device at all, so the one number that mattered was the
 * one nobody could see.
 */
await sql`DELETE FROM push_subscriptions WHERE username = 'Jade_Pres'`;
r = await call(pushApi, '/api/push?do=diagnose', { as: 'admin' });
ok('the server will say plainly that it has no device', r.data.devices.length === 0);

r = await call(pushApi, '/api/push?do=test', { method: 'POST', as: 'admin' });
ok('...and a test says NO_DEVICE rather than a vague failure',
  r.status === 409 && r.data.error === 'NO_DEVICE' && r.data.devices === 0);

// A subscription the push service refuses for a reason that is not "gone".
await sql`INSERT INTO push_subscriptions (endpoint, username, p256dh, auth)
          VALUES ('https://refuse.test/x', 'Jade_Pres', ${browserKeys.p256dh}, ${browserKeys.auth})`;
r = await call(pushApi, '/api/push?do=test', { method: 'POST', as: 'admin' });
ok('a refused push is reported as refused, not as "no device"',
  r.status === 409 && r.data.error === 'PUSH_REFUSED', JSON.stringify(r.data).slice(0, 80));
ok('...and carries what the service actually said',
  (r.data.errors[0]?.message || '').includes('BadJwtToken'), r.data.errors[0]?.message);
ok('...naming the service that refused it', r.data.errors[0]?.host === 'refuse.test');
ok('...and the status code', r.data.errors[0]?.status === 403);

r = await call(pushApi, '/api/push?do=diagnose', { as: 'admin' });
ok('the reason is kept on the device, readable later',
  (r.data.devices[0]?.lastError || '').includes('BadJwtToken'), r.data.devices[0]?.lastError);
ok('a refusal that is not "gone" keeps the device rather than deleting it',
  r.data.devices.length === 1 && r.data.devices[0].failures === 1);

ok('the signing identity is a real URL Apple will accept',
  /^https:\/\/|^mailto:/.test(r.data.subject) && !r.data.subject.includes('.local'),
  r.data.subject);

// Eight refusals in a row means the device is genuinely not reachable.
for (let i = 0; i < 8; i++) await call(pushApi, '/api/push?do=test', { method: 'POST', as: 'admin' });
r = await call(pushApi, '/api/push?do=diagnose', { as: 'admin' });
ok('a device that keeps failing is eventually dropped', r.data.devices.length === 0);

globalThis.fetch = realFetch2;



// ===========================================================================
head('20. Only the owner and the admins may change a task');
/**
 * The rule the committee asked for: seeing a task and being able to rewrite
 * it are different things. Someone tagged in a task may report progress on
 * it — status and nothing else — and that boundary is enforced here, not
 * merely hidden in the interface.
 */
await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Kluayhom_HeadMerchant', password: 'merchPw123' }, remember: 'merch' });
await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin', body: { username: 'Kluayhom_HeadMerchant', allDepartments: false, departments: ['content'] },
});

// A task the CONTENT head owns, with the merchant head tagged to do the work.
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'content',
  body: { title: 'ทำโปสเตอร์เวที', department: 'content',
          assignees: ['Kluayhom_HeadMerchant'], notify: [] },
});
const owned = r.data.task;
ok('the creator is recorded as the owner', owned.createdBy === 'Kungking_HeadCon');
ok('the creator is told they may edit it', owned.mayEdit === true);

const asSeen = async (who, id) =>
  (await call(tasksApi, '/api/tasks', { as: who })).data.tasks.find((x) => x.id === id);

let theirs = await asSeen('merch', owned.id);
ok('a tagged person can see it', Boolean(theirs));
ok('...and is told they may NOT edit it', theirs.mayEdit === false);
ok('...but may move its status', theirs.maySetStatus === true);

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'merch', body: { id: owned.id, status: 'review' },
});
ok('a tagged person CAN move the status', r.status === 200 && r.data.task.status === 'review');

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'merch', body: { id: owned.id, title: 'เปลี่ยนชื่อซะเลย' },
});
ok('a tagged person CANNOT rename it', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'merch', body: { id: owned.id, dueDate: '2027-01-01' },
});
ok('...nor move the deadline', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'merch', body: { id: owned.id, assignees: [] },
});
ok('...nor take people off it', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

// The obvious way round the rule: send the status AND something else.
r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'merch', body: { id: owned.id, status: 'done', title: 'sneaky' },
});
ok('smuggling an edit alongside a status change is refused',
  r.status === 403 && r.data.error === 'NOT_TASK_OWNER');
theirs = await asSeen('merch', owned.id);
ok('...and the refused request changed nothing at all',
  theirs.title === 'ทำโปสเตอร์เวที' && theirs.status === 'review',
  theirs.title + ' / ' + theirs.status);

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'merch', body: { id: owned.id, priority: 'highest' },
});
ok('priority is an edit, not a status', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

r = await call(tasksApi, '/api/tasks?id=' + owned.id, { method: 'DELETE', as: 'merch' });
ok('a tagged person cannot delete it', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');
ok('...and it is still there', Boolean(await asSeen('merch', owned.id)));

// Someone in the department who is NOT tagged at all.
await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin', body: { username: 'Ikkew_HeadOper1', departments: ['content'] },
});
await call(authApi, '/api/auth?do=login', { method: 'POST', body: { username: 'Ikkew_HeadOper1', password: 'editorPw2' }, remember: 'bystander' });
const bystander = await asSeen('bystander', owned.id);
ok('a department colleague can see the task', Boolean(bystander));
ok('...but may neither edit it', bystander.mayEdit === false);
ok('...nor move its status', bystander.maySetStatus === false);
r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'bystander', body: { id: owned.id, status: 'done' },
});
ok('...and the server refuses a status change from them',
  r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

// The owner and the admins keep full control.
r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'content', body: { id: owned.id, title: 'ทำโปสเตอร์เวทีกลาง', dueDate: '2026-11-01' },
});
ok('the owner can still change everything', r.status === 200 && r.data.task.title === 'ทำโปสเตอร์เวทีกลาง');

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin', body: { id: owned.id, priority: 'highest' },
});
ok('an admin can edit anyone\u2019s task', r.status === 200 && r.data.task.priority === 'highest');

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'coadmin', body: { id: owned.id, description: 'ขอไฟล์ก่อนวันศุกร์' },
});
ok('so can a co-admin', r.status === 200);

/**
 * An Editor whose sheet row says "All" sees every task — but seeing is not
 * owning, and they must not inherit an admin's authority along with the view.
 */
await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin', body: { username: 'Yam_HeadSpon', allDepartments: true },
});
await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: 'Yam_HeadSpon', password: 'sponPw1234' }, remember: 'seesall' });
const wide = await asSeen('seesall', owned.id);
ok('an editor with "All" access can see someone else\u2019s task', Boolean(wide));
ok('...but is not granted the right to edit it', wide.mayEdit === false);
r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'seesall', body: { id: owned.id, title: 'nope' },
});
ok('...and the server refuses them too', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

r = await call(tasksApi, '/api/tasks?id=' + owned.id, { method: 'DELETE', as: 'content' });
ok('the owner can delete their own task', r.status === 200);



// ===========================================================================
head('21. Sub-tasks: who does which piece');
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'content',
  body: { title: 'จัดนิทรรศการ', department: 'content',
          assignees: ['Kluayhom_HeadMerchant'], notify: [] },
});
const big = r.data.task;

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'POST', as: 'content',
  body: { taskId: big.id, title: 'ออกแบบบูธ', assignee: 'Kluayhom_HeadMerchant' },
});
ok('the owner can break a task into parts', r.status === 200 && r.data.task.parts.length === 1);
const partA = r.data.task.parts[0];
ok('a part carries the person responsible', partA.assignee === 'Kluayhom_HeadMerchant');
ok('...and starts unfinished', partA.done === false);

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'POST', as: 'content',
  body: { taskId: big.id, title: 'ประสานวิทยากร', assignee: 'Ikkew_HeadOper1' },
});
ok('parts keep the order they were added',
  r.data.task.parts.map((p) => p.title).join('|') === 'ออกแบบบูธ|ประสานวิทยากร',
  r.data.task.parts.map((p) => p.title).join('|'));
const partB = r.data.task.parts[1];

ok('being given a part puts that person on the task',
  r.data.task.assignees.includes('Ikkew_HeadOper1'));
r = await call(notifApi, '/api/notifications', { as: 'bystander' });
ok('...and tells them what their piece is',
  r.data.notifications.some((n) => n.kind === 'part' && n.body.includes('ประสานวิทยากร')),
  JSON.stringify(r.data.notifications.slice(0, 1)));

const forMerch = (await call(tasksApi, '/api/tasks', { as: 'merch' })).data.tasks.find((x) => x.id === big.id);
ok('each person is told which part is theirs', forMerch.myPart && forMerch.myPart.title === 'ออกแบบบูธ');
const forIkkew = (await call(tasksApi, '/api/tasks', { as: 'bystander' })).data.tasks.find((x) => x.id === big.id);
ok('...and it is a different part for a different person', forIkkew.myPart.title === 'ประสานวิทยากร');

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'PATCH', as: 'merch', body: { id: partA.id, done: true },
});
ok('someone can tick off their own part', r.status === 200 && r.data.task.parts[0].done === true);

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'PATCH', as: 'merch', body: { id: partB.id, done: true },
});
ok('but CANNOT tick off someone else\u2019s', r.status === 403 && r.data.error === 'NOT_YOUR_PART');

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'PATCH', as: 'merch', body: { id: partA.id, title: 'เปลี่ยนชื่อ' },
});
ok('nor rename even their own part', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'POST', as: 'merch', body: { taskId: big.id, title: 'แอบเพิ่ม' },
});
ok('nor add parts of their own', r.status === 403 && r.data.error === 'NOT_TASK_OWNER');

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'PATCH', as: 'admin', body: { id: partB.id, done: true },
});
ok('an admin can tick off anyone\u2019s part', r.status === 200);

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'POST', as: 'content', body: { taskId: big.id, title: 'x', assignee: 'Nobody_Real' },
});
ok('a part cannot be given to someone who does not exist',
  r.status === 400 && r.data.error === 'NO_SUCH_USER');

r = await call(tasksApi, '/api/tasks?do=part', {
  method: 'POST', as: 'content', body: { taskId: big.id, title: '' },
});
ok('a part needs a name', r.status === 400 && r.data.error === 'TITLE_REQUIRED');

// ===========================================================================
head('22. Handing work in');
r = await call(tasksApi, '/api/tasks?do=link', {
  method: 'POST', as: 'merch',
  body: { taskId: big.id, url: 'https://docs.google.com/document/d/abc123/edit',
          label: 'แบบร่างบูธ', partId: partA.id },
});
ok('someone on the task can attach their work', r.status === 200 && r.data.task.links.length === 1);
const link = r.data.task.links[0];
ok('a Google Doc is recognised as a doc, not a bare link', link.kind === 'doc', link.kind);
ok('it records who handed it in', link.addedBy === 'Kluayhom_HeadMerchant');
ok('...and which part it answers', link.partId === partA.id);

r = await call(notifApi, '/api/notifications', { as: 'content' });
ok('the person who set the task is told work arrived',
  r.data.notifications.some((n) => n.kind === 'work' && n.body.includes('แบบร่างบูธ')));

for (const [url, kind] of [
  ['https://drive.google.com/file/d/xyz/view', 'drive'],
  ['https://docs.google.com/spreadsheets/d/x/edit', 'sheet'],
  ['https://docs.google.com/presentation/d/x', 'slide'],
  ['https://www.figma.com/file/x/design', 'figma'],
  ['https://example.org/anything', 'link'],
]) {
  r = await call(tasksApi, '/api/tasks?do=link', { method: 'POST', as: 'merch', body: { taskId: big.id, url } });
  const added = r.data.task.links[r.data.task.links.length - 1];
  ok(`${url.slice(8, 34)}… is labelled ${kind}`, added.kind === kind, added.kind);
}

r = await call(tasksApi, '/api/tasks?do=link', {
  method: 'POST', as: 'merch', body: { taskId: big.id, url: 'drive.google.com/open?id=1' },
});
ok('a link pasted without https:// still works',
  r.status === 200 && r.data.task.links.slice(-1)[0].url.startsWith('https://'));

/**
 * The one that matters: a link is a string someone typed, and everyone on the
 * task clicks it. A javascript: URL in that list would be an attack on the
 * whole committee.
 */
for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'not a link at all', '']) {
  r = await call(tasksApi, '/api/tasks?do=link', { method: 'POST', as: 'merch', body: { taskId: big.id, url: bad } });
  ok(`refuses ${JSON.stringify(bad).slice(0, 28)}`, r.status === 400 && r.data.error === 'BAD_LINK');
}

r = await call(tasksApi, '/api/tasks?do=link', {
  method: 'POST', as: 'seesall', body: { taskId: big.id, url: 'https://example.org/x' },
});
ok('someone not on the task cannot attach to it',
  r.status === 403 && r.data.error === 'NOT_ON_THIS_TASK');

r = await call(tasksApi, '/api/tasks?do=link&id=' + link.id, { method: 'DELETE', as: 'bystander' });
ok('one person cannot remove another\u2019s attachment',
  r.status === 403 && r.data.error === 'NOT_YOUR_LINK');

r = await call(tasksApi, '/api/tasks?do=link&id=' + link.id, { method: 'DELETE', as: 'merch' });
ok('but can remove their own', r.status === 200);

r = await call(tasksApi, '/api/tasks?do=link&id=' + r.data.task.links[0].id, { method: 'DELETE', as: 'content' });
ok('and the task owner can remove anyone\u2019s', r.status === 200);

// Deleting a part must not take the work with it.
const before = (await call(tasksApi, '/api/tasks', { as: 'content' })).data.tasks.find((x) => x.id === big.id);
const linksBefore = before.links.length;
r = await call(tasksApi, '/api/tasks?do=part&id=' + partA.id, { method: 'DELETE', as: 'content' });
ok('the owner can remove a part', r.status === 200 && r.data.task.parts.length === 1);
ok('...and the work handed in against it is kept, not deleted',
  r.data.task.links.length === linksBefore, `${r.data.task.links.length} vs ${linksBefore}`);

// Deleting the task removes its parts and links with it.
await call(tasksApi, '/api/tasks?id=' + big.id, { method: 'DELETE', as: 'content' });
const orphanParts = await sql`SELECT count(*)::int AS n FROM task_parts WHERE task_id = ${big.id}`;
const orphanLinks = await sql`SELECT count(*)::int AS n FROM task_links WHERE task_id = ${big.id}`;
ok('deleting a task clears its parts and attachments too',
  orphanParts[0].n === 0 && orphanLinks[0].n === 0);



// ===========================================================================
head('23. Events: dates to know about, with nothing owed');
r = await call(eventsApi, '/api/events', {
  method: 'POST', as: 'admin',
  body: { title: 'ซ้อมใหญ่บนเวที', startsOn: '2026-11-20', startsAt: '14:00', endsAt: '17:00',
          allDay: false, place: 'หอประชุมจุฬาฯ', colour: 'blue', notify: ['7d', '24h', 'due'] },
});
ok('an event can be created', r.status === 201, JSON.stringify(r.data).slice(0, 70));
const ev = r.data.event;
ok('the Thai title and place survive', ev.title === 'ซ้อมใหญ่บนเวที' && ev.place === 'หอประชุมจุฬาฯ');
ok('the date is not shifted by a timezone', ev.startsOn === '2026-11-20', String(ev.startsOn));
ok('a timed event keeps its hours', ev.startsAt === '14:00' && ev.endsAt === '17:00');
ok('an event has no status and nothing to tick', ev.status === undefined && ev.assignees === undefined);

r = await call(eventsApi, '/api/events', {
  method: 'POST', as: 'admin', body: { title: 'ไม่มีวันที่' },
});
ok('an event without a date is refused', r.status === 400 && r.data.error === 'DATE_REQUIRED');

r = await call(eventsApi, '/api/events', {
  method: 'POST', as: 'admin',
  body: { title: 'ย้อนเวลา', startsOn: '2026-12-05', endsOn: '2026-12-01' },
});
ok('an end date before the start is refused',
  r.status === 400 && r.data.error === 'ENDS_BEFORE_START');

r = await call(eventsApi, '/api/events', {
  method: 'POST', as: 'admin',
  body: { title: 'งานจุฬาฯแฟร์', startsOn: '2026-12-01', endsOn: '2026-12-05', allDay: true },
});
const runOfDays = r.data.event;
ok('a run of days is allowed', r.status === 201 && runOfDays.endsOn === '2026-12-05');

// Who sees it
r = await call(eventsApi, '/api/events', { as: 'merch' });
ok('an event with nobody named is for the whole committee',
  r.data.events.some((e) => e.id === ev.id));

// Put the merchant head back in Merchant only — earlier sections moved them
// around, and this check is about department scope, not about that history.
await call(usersApi, '/api/users?do=manage', {
  method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', allDepartments: false, departments: ['merchant'] },
});
r = await call(eventsApi, '/api/events', {
  method: 'POST', as: 'admin',
  body: { title: 'ประชุมฝ่ายเนื้อหา', startsOn: '2026-10-10', departments: ['content'] },
});
const contentOnly = r.data.event;
r = await call(eventsApi, '/api/events', { as: 'content' });
ok('an event aimed at a department reaches it',
  r.data.events.some((e) => e.id === contentOnly.id));
r = await call(eventsApi, '/api/events', { as: 'merch' });
ok('...and not someone outside it',
  !r.data.events.some((e) => e.id === contentOnly.id));

// Editing follows the same rule as tasks
r = await call(eventsApi, '/api/events', {
  method: 'PATCH', as: 'merch', body: { id: ev.id, title: 'เปลี่ยนชื่อ' },
});
ok('someone else cannot edit an event', r.status === 403 && r.data.error === 'NOT_EVENT_OWNER');
r = await call(eventsApi, '/api/events?id=' + ev.id, { method: 'DELETE', as: 'merch' });
ok('...nor delete it', r.status === 403 && r.data.error === 'NOT_EVENT_OWNER');
r = await call(eventsApi, '/api/events', {
  method: 'PATCH', as: 'admin', body: { id: ev.id, place: 'หอประชุมใหญ่' },
});
ok('the creator can edit it', r.status === 200 && r.data.event.place === 'หอประชุมใหญ่');

// Reminders
await sql`DELETE FROM reminders_sent`;
await sql`UPDATE events SET starts_on = ${plus(7)}::date WHERE id = ${ev.id}`;
r = await call(cronApi, '/api/cron', {});
ok('an event reminds people 7 days out', r.data.eventNotices > 0, String(r.data.eventNotices));
r = await call(cronApi, '/api/cron', {});
ok('...and does not nag again on the next run', r.data.eventNotices === 0);

r = await call(notifApi, '/api/notifications', { as: 'content' });
const evNote = r.data.notifications.find((n) => n.kind === 'event');
ok('the reminder names the event and where it is',
  evNote && evNote.title === 'ซ้อมใหญ่บนเวที' && evNote.body.includes('หอประชุมใหญ่'),
  JSON.stringify(evNote).slice(0, 90));
ok('an event reminder is not attached to a task', evNote.taskId === null);

// ===========================================================================
head('24. Calendar feeds Google can colour separately');
await call(usersApi, '/api/users?do=calendar-token', { method: 'POST', as: 'content' });
const [{ calendar_token: feedToken }] =
  await sql`SELECT calendar_token FROM users WHERE username = 'Kungking_HeadCon'`;

const feed = async (scope) => {
  const res = await calApi(makeRequest(`/api/calendar?token=${feedToken}&scope=${scope}`));
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
};

await sql`UPDATE users SET calendar_seen_at = NULL WHERE username = 'Kungking_HeadCon'`;
r = await call(authApi, '/api/auth', { as: 'content' });
ok('before Google has fetched the feed, the guide is told it has not',
  r.data.user && r.data.user.calendarSeenAt === null, JSON.stringify(r.data.user && r.data.user.calendarSeenAt));
let f = await feed('mine');
const [{ calendar_seen_at: seenAt }] = await sql`SELECT calendar_seen_at FROM users WHERE username = 'Kungking_HeadCon'`;
ok('a fetch of the feed is noted, so the guide knows the calendar is connected', Boolean(seenAt));
r = await call(authApi, '/api/auth', { as: 'content' });
ok('...and the person\'s own account says so', Boolean(r.data.user && r.data.user.calendarSeenAt));
await feed('mine');
const [{ calendar_seen_at: seenAgain }] = await sql`SELECT calendar_seen_at FROM users WHERE username = 'Kungking_HeadCon'`;
ok('...without a write on every fetch (once an hour is enough)', new Date(seenAgain).getTime() === new Date(seenAt).getTime());
ok('the personal feed is served as a calendar',
  f.status === 200 && f.type.includes('text/calendar'), f.type);
ok('...and names itself after the person', /X-WR-CALNAME:.*Kungking/.test(f.body));

f = await feed('events');
ok('the events feed is its own calendar', /X-WR-CALNAME:.*กิจกรรม/.test(f.body));
ok('...and carries events', f.body.includes('CATEGORIES:Event'));
ok('...with no deadlines mixed in', !f.body.includes('Status:'), 'found a task');

f = await feed('dept');
ok('the department feed is its own calendar too', /X-WR-CALNAME:.*ฝ่าย/.test(f.body));

f = await feed('all');
ok('the everything feed has both', f.body.includes('CATEGORIES:Event'));

ok('every line stays inside the 75-octet limit, Thai included',
  f.body.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75),
  String(Math.max(...f.body.split('\r\n').map((l) => Buffer.byteLength(l, 'utf8')))));
ok('lines end CRLF as the format requires', f.body.includes('\r\n') && !/[^\r]\n/.test(f.body));

// A multi-day event must end the morning AFTER its last day, or Google
// draws it one day short.
ok('a run of days ends half-open', f.body.includes('DTEND;VALUE=DATE:20261206'),
  (f.body.match(/DTEND;VALUE=DATE:\d+/g) || []).join(','));

f = await feed('nonsense');
ok('an unknown feed name falls back to the personal one rather than failing',
  f.status === 200 && /X-WR-CALNAME:.*Kungking/.test(f.body));

const bad = await calApi(makeRequest('/api/calendar?token=wrong-token-entirely-here'));
ok('a wrong token is refused', bad.status === 401);



// ===========================================================================
head('25. Speed: the same work in fewer round trips');
/**
 * These are not timings — a local database answers too fast for that to mean
 * anything. They check the SHAPE of the work, because against a serverless
 * database every separate statement is its own HTTPS call, and the count is
 * what the person waiting actually feels.
 */
const { default: metaApi } = await import('../api/meta.js');

r = await call(metaApi, '/api/meta?ping=1', {});
ok('the keep-warm ping answers without a sign-in', r.status === 200 && r.data.ok === true);
r = await call(metaApi, '/api/meta', {});
ok('...and the ordinary meta call still works', r.status === 200 && Array.isArray(r.data.departments));

/**
 * The schema guard. This suite wipes `meta` when it resets, so the version row
 * is gone by now — which is itself the safe behaviour: with no recorded
 * version, the next start rebuilds the schema rather than assuming. Forcing a
 * fresh start here proves it writes the row back.
 */
const { getSql: getSqlAgain } = await import('../lib/db.js?schema-check=1');
await getSqlAgain().ready;
const [ver] = await sql`SELECT value FROM meta WHERE key = 'schema_version'`;
ok('a start with no recorded schema version rebuilds and records one',
  Boolean(ver?.value), String(ver?.value));

// Batched writes must still produce exactly the same rows as before.
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานหลายคน', assignees: ['Kaew_VP', 'Gorn_VP', 'Kungking_HeadCon'],
          departments: [{ key: 'content', scope: 'all' }, { key: 'merchant', scope: 'heads' }],
          notify: ['created'] },
});
const many = r.data.task;
ok('a task with several people saves them all', r.status === 201 && many.assignees.length >= 3,
  many.assignees.join(','));
ok('...and both department tags', many.departments.length === 2,
  JSON.stringify(many.departments));
ok('...with the right scope on each',
  many.departments.some((d) => d.key === 'content' && d.scope === 'all') &&
  many.departments.some((d) => d.key === 'merchant' && d.scope === 'heads'));

const rows = await sql`SELECT count(*)::int AS n FROM task_people WHERE task_id = ${many.id}`;
ok('the batched insert wrote one row per person, not duplicates',
  rows[0].n === many.assignees.length, `${rows[0].n} rows vs ${many.assignees.length} people`);

const notes = await sql`
  SELECT username, count(*)::int AS n FROM notifications
  WHERE task_id = ${many.id} GROUP BY username`;
ok('everyone tagged got exactly one notification — not none, not two',
  notes.length === many.assignees.length && notes.every((x) => x.n === 1),
  notes.map((x) => x.username + ':' + x.n).join(' '));
ok('...and the person who created it was not told about their own task',
  !notes.some((x) => x.username === 'Jade_Pres'));

// The single-query assembly must return the same shape as the five it replaced.
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
const assembled = r.data.tasks.find((x) => x.id === many.id);
ok('one-query assembly still returns people, departments, parts and links',
  Array.isArray(assembled.assignees) && Array.isArray(assembled.departments) &&
  Array.isArray(assembled.parts) && Array.isArray(assembled.links));
ok('...and keeps the ordering rule', r.data.tasks.length > 1);



// ===========================================================================
head('26. Importing tasks: the columns the template now offers');
const { default: importApi } = await import('../api/import.js');

const TASK_CSV = [
  'title,description,assignees,departments,teamspace,due date,due time,priority,status,parts,links,notify',
  'จองเวทีกลาง,ติดต่อฝ่ายอาคาร,Jade_Pres;Kaew_VP,content:heads,content,2026-10-05,18:30,high,review,' +
    '"ทำหนังสือ@Jade_Pres; ยืนยันผัง",' +
    '"ผังเวที|https://drive.google.com/file/d/xxx/view; https://example.org/notes",' +
    '"created,24h"',
  'No parts or links,,,pr,,2026-10-12,,urgent,doing,,,',
  'Bad everything,,Nobody Real,nosuchdept,alsonothing,31/31/2026,99:99,,,"@Nobody Real","not a url"',
].join('\n');

r = await call(importApi, '/api/import?do=preview', { method: 'POST', as: 'admin', body: { csv: TASK_CSV } });
ok('the task preview parses every row', r.status === 200 && r.data.rows.length === 3, String(r.data.rows?.length));
ok('...and says which kind it read', r.data.kind === 'tasks');

const [tRow, tPlain, tBad] = r.data.rows;
ok('priority is read from the sheet', tRow.priority === 'high', tRow.priority);
ok('"urgent" is understood as highest', tPlain.priority === 'highest', tPlain.priority);
ok('the new statuses import too', tRow.status === 'review', tRow.status);
ok('teamspace is read as its own column', tRow.teamspace === 'content', String(tRow.teamspace));
ok('sub-tasks are split out of one cell', tRow.parts.length === 2, JSON.stringify(tRow.parts));
ok('...with the person after @ matched to an account',
  tRow.parts[0].assignee === 'Jade_Pres' && tRow.parts[1].assignee === null,
  JSON.stringify(tRow.parts));
ok('links are split out, label and all',
  tRow.links.length === 2 && tRow.links[0].label === 'ผังเวที' && tRow.links[0].kind === 'drive',
  JSON.stringify(tRow.links));
ok('a link with no label still imports', tRow.links[1].label === '' && tRow.links[1].kind === 'link');
ok('teamspace falls back to the first department tag when the column is blank',
  tPlain.teamspace === 'pr', String(tPlain.teamspace));
ok('a teamspace nobody recognises is reported, not silently dropped',
  tBad.unknownDepts.includes('alsonothing'), tBad.unknownDepts.join(','));
ok('a junk link is flagged rather than saved', tBad.notes.includes('BAD_LINK'), tBad.notes.join(','));
ok('a broken date and time are still caught',
  tBad.problems.includes('BAD_DATE') && tBad.problems.includes('BAD_TIME'));

r = await call(importApi, '/api/import?do=commit', {
  method: 'POST', as: 'admin', body: { rows: [tRow, tPlain] },
});
ok('the good rows import', r.status === 200 && r.data.created === 2, JSON.stringify(r.data));

r = await call(tasksApi, '/api/tasks', { as: 'admin' });
const made = r.data.tasks.find((x) => x.title === 'จองเวทีกลาง');
ok('the imported task kept its teamspace', made.department === 'content', String(made.department));
ok('...its priority and status', made.priority === 'high' && made.status === 'review');
ok('...its sub-tasks, in order, with the right owner',
  made.parts.length === 2 && made.parts[0].title === 'ทำหนังสือ' &&
  made.parts[0].assignee === 'Jade_Pres' && made.parts[1].assignee === null,
  JSON.stringify(made.parts));
ok('...and its attached links', made.links.length === 2, JSON.stringify(made.links.map((l) => l.kind)));
ok('a person named only in a sub-task is put on the task',
  made.assignees.includes('Jade_Pres'));

// ===========================================================================
head('27. Importing events');
const EVENT_CSV = [
  'title,description,starts on,starts at,ends on,ends at,all day,place,who,departments,colour,notify',
  'ซ้อมใหญ่รอบสุดท้าย,ซ้อมคิวพิธีกร,2026-11-20,14:00,,17:00,no,หอประชุมจุฬาฯ,,content,blue,"7d,24h,due"',
  'งานจุฬาฯแฟร์,,2026-11-25,,2026-11-29,,yes,สนามหน้าพระบรมรูป,,,amber,"7d"',
  'ประชุมหัวหน้าฝ่าย,,2026-10-15,17:00,,19:00,no,ห้องประชุม,Jade_Pres;Kaew_VP,,nosuchcolour,',
  'Backwards,,2026-12-05,,2026-12-01,,yes,,,,,',
].join('\n');

r = await call(importApi, '/api/import?do=preview', {
  method: 'POST', as: 'admin', body: { csv: EVENT_CSV, kind: 'events' },
});
ok('the event preview parses', r.status === 200 && r.data.rows.length === 4, String(r.data.rows?.length));
ok('...and says it read events', r.data.kind === 'events');

const [eTimed, eRun, ePeople, eBack] = r.data.rows;
ok('a timed event keeps its hours and is not all-day',
  eTimed.startsAt === '14:00' && eTimed.endsAt === '17:00' && eTimed.allDay === false);
ok('...and its place and colour', eTimed.place === 'หอประชุมจุฬาฯ' && eTimed.colour === 'blue');
ok('...and the department it concerns', eTimed.departments.join(',') === 'content');
ok('a run of days is all-day with an end date',
  eRun.allDay === true && eRun.endsOn === '2026-11-29' && eRun.startsAt === null);
ok('named people are matched to accounts',
  ePeople.people.join(',') === 'Jade_Pres,Kaew_VP', ePeople.people.join(','));
ok('an unknown colour falls back rather than failing',
  ePeople.colour === 'plum' && ePeople.notes.includes('COLOUR_DEFAULTED'));
ok('an end date before the start is caught in the preview',
  eBack.problems.includes('ENDS_BEFORE_START'), eBack.problems.join(','));

r = await call(importApi, '/api/import?do=commit', {
  method: 'POST', as: 'admin', body: { kind: 'events', rows: [eTimed, eRun, ePeople, eBack] },
});
ok('only the sound rows are created', r.data.created === 3, JSON.stringify(r.data));
ok('...and the backwards one is reported',
  r.data.failed.some((f) => f.reason === 'ENDS_BEFORE_START'), JSON.stringify(r.data.failed));

r = await call(eventsApi, '/api/events', { as: 'admin' });
const imported = r.data.events.find((e) => e.title === 'ซ้อมใหญ่รอบสุดท้าย');
ok('the imported event is really there, Thai intact', Boolean(imported));
ok('...with its time, place and colour',
  imported.startsAt === '14:00' && imported.place === 'หอประชุมจุฬาฯ' && imported.colour === 'blue',
  JSON.stringify({ startsAt: imported.startsAt, place: imported.place, colour: imported.colour, allDay: imported.allDay }));
const multiDay = r.data.events.find((e) => e.title === 'งานจุฬาฯแฟร์');
ok('...and the run of days spans properly',
  multiDay.startsOn === '2026-11-25' && multiDay.endsOn === '2026-11-29' && multiDay.allDay === true);

const named = await sql`SELECT username FROM event_people WHERE event_id = ${
  r.data.events.find((e) => e.title === 'ประชุมหัวหน้าฝ่าย').id} ORDER BY username`;
ok('the people named on an event are stored',
  named.map((x) => x.username).join(',') === 'Jade_Pres,Kaew_VP', JSON.stringify(named));

r = await call(importApi, '/api/import?do=preview', {
  method: 'POST', as: 'admin', body: { csv: 'nothing,useful\n1,2', kind: 'events' },
});
ok('a sheet with no title column is refused', r.status === 400 && r.data.error === 'NO_TITLE_COLUMN');


head('28. Sections inside a department');

// A section is a level of FILING. It must belong to the department it claims.
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'ตรวจผังเต็นท์', department: 'oper2', unit: 'สถานที่',
          departments: [{ key: 'oper2', scope: 'heads' }], notify: [] },
});
ok('a task can be filed into a section of its department', r.status === 201 && r.data.task.unit === 'สถานที่',
  JSON.stringify({ dept: r.data.task?.department, unit: r.data.task?.unit }));
const filed = r.data.task;

r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'ส่วนงานของฝ่ายอื่น', department: 'oper2', unit: 'Stage', notify: [] },
});
ok("...but not into another department's section", r.status === 201 && r.data.task.unit === null,
  JSON.stringify(r.data.task?.unit));

r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'ส่วนงานที่ไม่มีอยู่', department: 'content', unit: 'ไม่มีส่วนงานนี้', notify: [] },
});
ok('a section nobody has is dropped, not stored', r.status === 201 && r.data.task.unit === null);

// Spelling it the way a person would still lands in the right place.
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'รอบยาน', department: 'oper2', unit: 'ยานพาหนะและประสาน ป.อ.พ.', notify: [] },
});
ok('dots and spacing do not stop a section matching', r.data.task.unit === 'ยานพาหนะและประสาน ปอ.พ.',
  JSON.stringify(r.data.task?.unit));

// Moving a task out of the department must not leave a stale section behind.
r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin', body: { id: filed.id, department: 'content' },
});
ok('moving to another department clears a section it does not have',
  r.status === 200 && r.data.task.unit === null, JSON.stringify(r.data.task?.unit));

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin', body: { id: filed.id, unit: 'Stage' },
});
ok('...and the new department\'s own sections work', r.data.task.unit === 'Stage');

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin', body: { id: filed.id, status: 'doing' },
});
ok('an unrelated edit leaves the section alone', r.data.task.unit === 'Stage');

r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin', body: { id: filed.id, unit: null },
});
ok('and it can be cleared on purpose', r.data.task.unit === null);

// The org chart is what the client reads to build the picker.
r = await call(metaApi, '/api/meta');
const oper2 = r.data.departments.find((d) => d.key === 'oper2');
ok('the org chart hands over the sections', (oper2.units || []).includes('สถานที่') &&
  (oper2.units || []).includes('Green Guide'), (oper2.units || []).join(', '));

// Importing, which is how the timeline arrives.
const unitCsv = [
  'title,departments,teamspace,unit,due date,notify',
  'ติดต่อสถานที่,oper2:heads,oper2,สถานที่,2026-11-27,due',
  'ทำระบบรอบยาน,oper2:heads,oper2,ยานพาหนะและประสาน ป.อ.พ.,2026-11-20,due',
  'ของฝ่ายอื่น,oper2:heads,oper2,Stage,2026-11-20,due',
  'ไม่ระบุส่วนงาน,oper2:heads,oper2,,2026-11-20,due',
].join('\n');
r = await call(importApi, '/api/import?do=preview', { method: 'POST', as: 'admin', body: { csv: unitCsv } });
ok('the importer reads a section column', r.data.rows[0].unit === 'สถานที่', JSON.stringify(r.data.rows[0].unit));
ok('...forgiving the spelling', r.data.rows[1].unit === 'ยานพาหนะและประสาน ปอ.พ.');
ok('...and reports one that does not belong rather than dropping it quietly',
  r.data.rows[2].unit === null && r.data.rows[2].unknownUnits.includes('Stage'),
  JSON.stringify(r.data.rows[2].unknownUnits));
ok('a blank section is simply blank', r.data.rows[3].unit === null && !r.data.rows[3].unknownUnits.length);

r = await call(importApi, '/api/import?do=commit', {
  method: 'POST', as: 'admin', body: { rows: r.data.rows },
});
ok('they import', r.data.created === 4, JSON.stringify(r.data));

r = await call(tasksApi, '/api/tasks', { as: 'admin' });
const placed = r.data.tasks.find((t) => t.title === 'ติดต่อสถานที่' && t.department === 'oper2');
ok('and land in the section they named', placed.unit === 'สถานที่', JSON.stringify(placed.unit));
ok('a section belonging to another department did not survive the trip',
  r.data.tasks.find((t) => t.title === 'ของฝ่ายอื่น').unit === null);

head('29. LINE: the webhook is a public URL, so it is signed');

// Nothing at all happens without a valid signature. This is the whole defence
// — the address is guessable and the bot can create and delete work.
let res = await lineApi(lineHook(sayToBot('Uattacker', 'งาน'), { breakIt: true }));
ok('a tampered signature is refused', res.status === 403, String(res.status));

res = await lineApi(new Request('https://app.test/api/line', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ events: sayToBot('Uattacker', 'ลบ 1 ยืนยัน') }),
}));
ok('no signature at all is refused', res.status === 403, String(res.status));

res = await lineApi(lineHook(sayToBot('Uattacker', 'งาน'), { secret: 'the-wrong-secret' }));
ok('a signature from the wrong secret is refused', res.status === 403, String(res.status));
ok('...and none of that sent a single message', lineSent.length === 0, String(lineSent.length));

head('30. LINE: linking an account');

// A stranger gets told how to link, and nothing else.
lineSent.length = 0;
res = await lineApi(lineHook(sayToBot('Ustranger', 'งาน')));
ok('an unlinked person is answered, not served', res.status === 200 &&
  lastReply().includes('ยังไม่ได้ผูก'), lastReply().slice(0, 40));

res = await lineApi(lineHook(sayToBot('Ustranger', 'ZZZZZZ')));
ok('a made-up code is refused', lastReply().includes('ไม่ถูกต้องหรือหมดอายุ'));

// The real flow: the person asks for a code on the website.
r = await call(lineApi, '/api/line?do=code', { method: 'POST', as: 'admin' });
ok('the website issues a code', r.status === 200 && /^[A-Z0-9]{6}$/.test(r.data.code || ''), r.data.code);
const linkCode = r.data.code;

r = await call(lineApi, '/api/line?do=status', { as: 'admin' });
ok('...and says the account is not linked yet', r.data.linked === false);

res = await lineApi(lineHook(sayToBot('Uadmin', linkCode.toLowerCase())));
ok('the code links the account, in either case', lastReply().includes('เชื่อมต่อเรียบร้อย'), lastReply().slice(0, 30));

res = await lineApi(lineHook(sayToBot('Uother', linkCode)));
ok('the same code cannot be used twice', lastReply().includes('ไม่ถูกต้องหรือหมดอายุ'));

r = await call(lineApi, '/api/line?do=status', { as: 'admin' });
ok('the website now shows it linked', r.data.linked === true,
  JSON.stringify({ linked: r.data.linked, digest: r.data.digest }));
/**
 * The daily digest costs one charged LINE message per person per day, so it is
 * off until somebody asks for it. Nobody is billed for a default.
 */
ok('...with the paid daily digest OFF until asked for', r.data.digest === false,
  String(r.data.digest));

r = await call(lineApi, '/api/line?do=digest', { method: 'PATCH', as: 'admin', body: { digest: true } });
ok('...and switching it on is one call', r.data.digest === true, JSON.stringify(r.data));
r = await call(lineApi, '/api/line?do=digest', { method: 'PATCH', as: 'admin', body: { digest: false } });
ok('...and off again', r.data.digest === false, JSON.stringify(r.data));

head('31. LINE: reading and writing through the chat');

lineSent.length = 0;
await lineApi(lineHook(sayToBot('Uadmin', 'เพิ่มงาน ทดสอบผ่านไลน์ 20/11 18:00 !ด่วน')));
ok('a task can be created from a message', lastReply().includes('สร้างงานแล้ว'), lastReply().slice(0, 40));
ok('...with the date it was given', lastReply().includes('พ.ย.'), lastReply());

r = await call(tasksApi, '/api/tasks', { as: 'admin' });
const fromLine = r.data.tasks.find((t) => t.title === 'ทดสอบผ่านไลน์');
ok('...and it really exists', Boolean(fromLine));
ok('...with the priority asked for', fromLine?.priority === 'high', fromLine?.priority);
ok('...due on the right day', fromLine?.dueDate?.endsWith('-11-20'), fromLine?.dueDate);
ok('...at the right time', fromLine?.dueTime === '18:00', fromLine?.dueTime);
ok('...owned by the person who sent the message', fromLine?.createdBy === 'Jade_Pres', fromLine?.createdBy);

await lineApi(lineHook(sayToBot('Uadmin', 'งาน')));
// The list is a card now: the number and the title are separate pieces of the
// same row, so the check is that both are on screen rather than that they sit
// in one string.
ok('the list comes back numbered', /^1\.$/m.test(lastReply()) && /จองเวทีกลาง/.test(lastReply()),
  lastReply().split('\n').slice(0, 4).join(' | '));

// Nothing the bot says in conversation is ever a push — that is what keeps it free.
ok('every conversational message was a free reply, never a push',
  lineSent.every((m) => m.kind === 'reply'), JSON.stringify(lineSent.map((m) => m.kind)));

// The numbered list is what "เสร็จ 1" refers to.
await lineApi(lineHook(sayToBot('Uadmin', 'หา ทดสอบผ่านไลน์')));
await lineApi(lineHook(sayToBot('Uadmin', 'เสร็จ 1')));
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('a numbered task can be closed from the chat',
  r.data.tasks.find((t) => t.id === fromLine.id)?.status === 'done',
  r.data.tasks.find((t) => t.id === fromLine.id)?.status);

// Deleting always costs a second message.
await lineApi(lineHook(sayToBot('Uadmin', 'หา ทดสอบผ่านไลน์')));
await lineApi(lineHook(sayToBot('Uadmin', 'ลบ 1')));
ok('deleting asks first', lastReply().includes('ยืนยัน'), lastReply().slice(0, 50));
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('...and has not deleted anything yet', Boolean(r.data.tasks.find((t) => t.id === fromLine.id)));

await lineApi(lineHook(sayToBot('Uadmin', 'ลบ 1 ยืนยัน')));
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('...then deletes when confirmed', !r.data.tasks.find((t) => t.id === fromLine.id));

await lineApi(lineHook(sayToBot('Uadmin', 'อะไรก็ไม่รู้')));
ok('an unknown command explains rather than failing', lastReply().includes('ไม่เข้าใจคำสั่ง'));

head('32. LINE: the chat obeys the same permissions as the website');

// Link an editor, then have them try to touch somebody else's task.
r = await call(lineApi, '/api/line?do=code', { method: 'POST', as: 'content' });
ok('an editor can get a code too', r.status === 200 && Boolean(r.data.code), JSON.stringify(r.data));
await lineApi(lineHook(sayToBot('Umember', r.data.code)));
ok('...and link with it', lastReply().includes('เชื่อมต่อเรียบร้อย'), lastReply().slice(0, 40));

r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานของแอดมินเท่านั้น', dueDate: '2026-12-01', assignees: ['Jade_Pres'],
          departments: [{ key: 'exec', scope: 'all' }], notify: [] },
});
ok('the admin-only task exists', r.status === 201, JSON.stringify(r.data).slice(0, 80));

// The member cannot see it, so it never reaches their numbered list.
await lineApi(lineHook(sayToBot('Umember', 'หา งานของแอดมินเท่านั้น')));
ok('a task they cannot see does not appear in their list',
  lastReply().includes('ไม่มีรายการ'), lastReply().slice(0, 60));

// A task they CAN see but do not own.
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานที่เห็นได้แต่ลบไม่ได้', dueDate: '2026-12-02',
          assignees: ['Kungking_HeadCon'], departments: [{ key: 'content', scope: 'all' }], notify: [] },
});
await lineApi(lineHook(sayToBot('Umember', 'หา งานที่เห็นได้แต่ลบไม่ได้')));
ok('they can see it', lastReply().includes('งานที่เห็นได้แต่ลบไม่ได้'), lastReply().slice(0, 60));

await lineApi(lineHook(sayToBot('Umember', 'ลบ 1 ยืนยัน')));
ok('...but cannot delete it', lastReply().includes('ไม่มีสิทธิ์ลบ'), lastReply().slice(0, 50));
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('...and it is still there', Boolean(r.data.tasks.find((t) => t.title === 'งานที่เห็นได้แต่ลบไม่ได้')));

// Being tagged is enough to move the status, exactly as on the website.
await lineApi(lineHook(sayToBot('Umember', 'เสร็จ 1')));
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('someone tagged in it can still close it',
  r.data.tasks.find((t) => t.title === 'งานที่เห็นได้แต่ลบไม่ได้')?.status === 'done',
  r.data.tasks.find((t) => t.title === 'งานที่เห็นได้แต่ลบไม่ได้')?.status);

// Filing into a department they have no access to is refused.
await lineApi(lineHook(sayToBot('Umember', 'เพิ่มงาน ลองแอบสร้าง 20/12 #exec')));
ok('they cannot file a task into a department they have no access to',
  lastReply().includes('ไม่มีสิทธิ์สร้างงาน'), lastReply().slice(0, 60));

head('33. LINE: the daily digest is personal, not a broadcast');

// Give the two linked people something each.
await sql`DELETE FROM line_digests_sent`;
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานสรุปของแอดมิน', dueDate: todayIsoForTest(), assignees: ['Jade_Pres'], notify: [] },
});
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานสรุปของสมาชิก', dueDate: todayIsoForTest(), assignees: ['Kungking_HeadCon'], notify: [] },
});
ok('both linked people have something due', r.status === 201);

// Both of them ask for the digest; it is off for everybody by default.
await sql`UPDATE line_links SET digest = true`;

lineSent.length = 0;
r = await call(cronApi, '/api/cron');
const digests = lineSent.filter((m) => m.kind === 'push');
ok('the digest goes to the people who asked for it', digests.length === 2, JSON.stringify(r.data.line));
ok('...addressed to each person individually, never broadcast',
  digests.every((m) => m.to && m.to.startsWith('U')), JSON.stringify(digests.map((m) => m.to)));

const adminDigest = digests.find((m) => m.to === 'Uadmin');
const memberDigest = digests.find((m) => m.to === 'Umember');
ok('each person is told only about their own work',
  adminDigest.text.includes('งานสรุปของแอดมิน') && !adminDigest.text.includes('งานสรุปของสมาชิก'),
  adminDigest.text.slice(0, 80));
ok('...and the same is true the other way round',
  memberDigest.text.includes('งานสรุปของสมาชิก') && !memberDigest.text.includes('งานสรุปของแอดมิน'));
ok('one message each, not one per task', digests.length === 2);

// Running the cron again must not send a second copy.
lineSent.length = 0;
await call(cronApi, '/api/cron');
ok('a second run the same day sends nothing',
  lineSent.filter((m) => m.kind === 'push').length === 0);

// Somebody who switched it off hears nothing.
await sql`DELETE FROM line_digests_sent`;
await lineApi(lineHook(sayToBot('Umember', 'ปิดแจ้งเตือน')));
ok('a person can switch their own digest off from the chat',
  lastReply().includes('ปิดสรุปงานประจำวัน'), lastReply().slice(0, 40));
lineSent.length = 0;
await call(cronApi, '/api/cron');
const afterOff = lineSent.filter((m) => m.kind === 'push');
ok('...and then gets nothing', afterOff.length === 1 && afterOff[0].to === 'Uadmin',
  JSON.stringify(afterOff.map((m) => m.to)));

// Nobody with an empty list is messaged at all.
/**
 * Empty means empty of events and meetings too, not only tasks.
 *
 * The digest also lists events in the coming week, and the import test above
 * puts Jade on an event fixed on 15 October. For most of the year that is
 * further off than a week; from 8 October it is not, and this check started
 * failing because the calendar had moved rather than because anything broke.
 */
await sql`DELETE FROM line_digests_sent`;
await sql`DELETE FROM task_people WHERE username = 'Jade_Pres'`;
await sql`DELETE FROM event_people WHERE username = 'Jade_Pres'`;
await sql`DELETE FROM meeting_people WHERE username = 'Jade_Pres'`;
await sql`DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_people)
                              AND id NOT IN (SELECT event_id FROM event_departments)`;
lineSent.length = 0;
await call(cronApi, '/api/cron');
ok('somebody with nothing due is left alone',
  lineSent.filter((m) => m.kind === 'push').length === 0,
  JSON.stringify(lineSent.filter((m) => m.kind === 'push').map((m) => [m.to, String(m.text || '').slice(0, 160)])));

// A blocked account is dropped rather than retried every morning.
await sql`DELETE FROM line_digests_sent`;
await sql`UPDATE line_links SET digest = true`;
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานหลังบล็อก', dueDate: todayIsoForTest(), assignees: ['Jade_Pres'], notify: [] },
});
lineFails = 403;
await call(cronApi, '/api/cron');
lineFails = null;
const stillLinked = await sql`SELECT line_user_id FROM line_links WHERE line_user_id = 'Uadmin'`;
ok('a blocked account is unlinked instead of retried forever', stillLinked.length === 0);

head('34. LINE: unlinking, from either side');

r = await call(lineApi, '/api/line?do=code', { method: 'POST', as: 'admin' });
await lineApi(lineHook(sayToBot('Uadmin2', r.data.code)));
await lineApi(lineHook(sayToBot('Uadmin2', 'เลิกเชื่อมต่อ')));
ok('unlinking from the chat works', lastReply().includes('เลิกเชื่อมต่อแล้ว'));
r = await call(lineApi, '/api/line?do=status', { as: 'admin' });
ok('...and the website agrees', r.data.linked === false);

r = await call(lineApi, '/api/line?do=code', { method: 'POST', as: 'admin' });
await lineApi(lineHook(sayToBot('Uadmin3', r.data.code)));
r = await call(lineApi, '/api/line?do=link', { method: 'DELETE', as: 'admin' });
ok('unlinking from the website works', r.status === 200);
await lineApi(lineHook(sayToBot('Uadmin3', 'งาน')));
ok('...and the chat no longer recognises them', lastReply().includes('ยังไม่ได้ผูก'));

// Blocking the account from LINE's side removes the binding too.
r = await call(lineApi, '/api/line?do=code', { method: 'POST', as: 'admin' });
await lineApi(lineHook(sayToBot('Uadmin4', r.data.code)));
await lineApi(lineHook([{ type: 'unfollow', source: { type: 'user', userId: 'Uadmin4' } }]));
const unfollowed = await sql`SELECT 1 FROM line_links WHERE line_user_id = 'Uadmin4'`;
ok('blocking the account unlinks it', unfollowed.length === 0);

r = await call(lineApi, '/api/line?do=status');
ok('the website endpoints need a sign-in', r.status === 401);

head('35. LINE: the guided step-by-step flow');

lineSent.length = 0;      // the digest section above sent real pushes

// Link a fresh account for the wizard.
r = await call(lineApi, '/api/line?do=code', { method: 'POST', as: 'admin' });
await lineApi(lineHook(sayToBot('Uwiz', r.data.code)));

const say = async (t) => { await lineApi(lineHook(sayToBot('Uwiz', t))); return lastReply(); };

let out = await say('เพิ่มงาน');
ok('the menu button starts the wizard', out.includes('ขั้นที่ 1/11') && out.includes('ชื่องาน'), out.split('\n')[0]);

out = await say('เตรียมเวทีกลาง');
ok('...then asks for details', out.includes('ขั้นที่ 2/11'), out.split('\n')[0]);
ok('...quoting the title back', out.includes('เตรียมเวทีกลาง'));

out = await say('ข้าม');
ok('optional steps can be skipped', out.includes('ขั้นที่ 3/11') && out.includes('กำหนดส่ง'), out.split('\n')[0]);

out = await say('วันที่มั่วซั่ว');
ok('a date it cannot read is explained, not swallowed',
  out.includes('ไม่เข้าใจวันที่') && out.includes('ขั้นที่ 3/11'), out.split('\n')[0]);

out = await say('20/11');
ok('...and a good one moves on', out.includes('ขั้นที่ 4/11') && out.includes('เวลา'), out.split('\n')[0]);

out = await say('18:00');
ok('the time step leads to people', out.includes('ขั้นที่ 5/11') && out.includes('ผู้รับผิดชอบ'), out.split('\n')[0]);
ok('...offering real names to tap as buttons',
  lastButtons().some((l) => /Kungking|Kaew|Gorn|กุ๊งกิ๊ง|แก้ว|กร|ต๊อดติ/.test(l)),
  lastButtons().join(' / '));

out = await say('ฉันเอง');
ok('picking myself keeps the list open for more', out.includes('เลือกแล้ว'), out.split('\n')[2] || '');

out = await say('กุ๊งกิ๊ง');
ok('...and a typed nickname is found too', out.includes('เลือกแล้ว') && /กุ๊งกิ๊ง|Kungking/.test(out));

out = await say('✓ เลือกเสร็จแล้ว');
ok('finishing the people step asks about departments', out.includes('ขั้นที่ 6/11'), out.split('\n')[0]);

out = await say('เฉพาะหัวหน้าฝ่าย');
ok('...then which department', out.includes('ขั้นที่ 7/11'), out.split('\n')[0]);

out = await say('ฝ่ายเนื้อหา');
ok('...then the section inside it', out.includes('ขั้นที่ 8/11') && out.includes('หน่วยย่อย'), out.split('\n')[0]);
ok('...listing that department\'s own sections as buttons',
  lastButtons().includes('Stage'), lastButtons().join(' / '));

out = await say('Stage');
ok('then priority', out.includes('ขั้นที่ 9/11'), out.split('\n')[0]);
out = await say('ด่วน');
ok('then status', out.includes('ขั้นที่ 10/11'), out.split('\n')[0]);
out = await say('กำลังทำ');
ok('then reminders', out.includes('ขั้นที่ 11/11'), out.split('\n')[0]);
out = await say('7 วัน + 1 วัน + วันครบกำหนด');
ok('then a summary before anything is saved', out.includes('ตรวจสอบก่อนบันทึก'), out.split('\n')[0]);
ok('...showing every answer back',
  out.includes('เตรียมเวทีกลาง') && out.includes('ด่วน') && out.includes('Stage') && out.includes('พ.ย.'),
  out.replace(/\n/g, ' | ').slice(0, 200));

r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('nothing is written until it is confirmed',
  !r.data.tasks.find((t) => t.title === 'เตรียมเวทีกลาง'));

out = await say('✓ บันทึกงาน');
ok('confirming saves it', out.includes('บันทึกงานแล้ว'), out.split('\n')[0]);

r = await call(tasksApi, '/api/tasks', { as: 'admin' });
const wiz = r.data.tasks.find((t) => t.title === 'เตรียมเวทีกลาง');
ok('the task really exists', Boolean(wiz));
ok('...with the date from step 3', wiz?.dueDate?.endsWith('-11-20'), wiz?.dueDate);
ok('...the time from step 4', wiz?.dueTime === '18:00', wiz?.dueTime);
ok('...the people from step 5', (wiz?.assignees || []).includes('Jade_Pres') &&
  (wiz?.assignees || []).includes('Kungking_HeadCon'), (wiz?.assignees || []).join(','));
ok('...the department from step 7', wiz?.department === 'content', wiz?.department);
ok('...the section from step 8', wiz?.unit === 'Stage', wiz?.unit);
ok('...the priority from step 9', wiz?.priority === 'high', wiz?.priority);
ok('...the status from step 10', wiz?.status === 'doing', wiz?.status);
ok('...and the reminders from step 11', (wiz?.notify || []).join(',') === '7d,24h,due',
  (wiz?.notify || []).join(','));

head('36. LINE: no path loops, every path ends');

// ยกเลิก works at any step, and leaves nothing behind.
await say('เพิ่มงาน');
await say('งานที่จะถูกยกเลิก');
out = await say('ยกเลิก');
ok('cancelling mid-flow ends it', out.includes('ยกเลิกแล้ว'), out.split('\n')[0]);
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('...and saves nothing', !r.data.tasks.find((t) => t.title === 'งานที่จะถูกยกเลิก'));

out = await say('งาน');
ok('...and the next message is a normal command again, not an answer',
  out.includes('งานของฉัน') || out.includes('ไม่มีรายการ'), out.split('\n')[0]);

// Cancelling at the very first question works too.
await say('เพิ่มงาน');
out = await say('ยกเลิก');
ok('cancelling at the first question works', out.includes('ยกเลิกแล้ว'));

// While in a flow, a command word is treated as the answer, not a command.
await say('เพิ่มงาน');
out = await say('วันนี้');
ok('a command word typed mid-flow is taken as the answer', out.includes('ขั้นที่ 2/11'), out.split('\n')[0]);
await say('ยกเลิก');

// จบ always closes down, from anywhere.
out = await say('จบ');
ok('จบ ends the conversation from the top level', out.includes('เรียบร้อย'), out.split('\n')[0]);

head('37. LINE: ตรวจสอบงาน and จัดการงาน');

out = await say('ตรวจสอบงาน');
ok('viewing offers the choices', out.includes('ต้องการดูอะไร'), out.split('\n')[0]);
out = await say('งานของฉัน');
ok('...and a choice shows the list', out.includes('งานของฉัน'), out.split('\n')[0]);

out = await say('จัดการงาน');
ok('managing lists tasks to pick from', out.includes('เลือกงานที่ต้องการแก้'), out.split('\n')[0]);
// A card now, where the number sits on its own beside the title rather than
// as the start of a line of text.
ok('...numbered', /(^|\n)1\.(\s|$)/m.test(out));

out = await say('1');
ok('picking a number names the task and offers actions',
  out.includes('ต้องการทำอะไรกับงานนี้'), out.split('\n')[0]);

out = await say('เสร็จแล้ว');
ok('...and the action is applied', out.includes('เสร็จแล้ว'), out.split('\n')[0]);

// Deleting through the menu still asks first.
await say('จัดการงาน');
await say('1');
out = await say('ลบงานนี้');
ok('deleting through the menu asks first', out.includes('ใช่ไหม'), out.split('\n')[0]);
out = await say('ไม่ลบ');
ok('...and declining keeps it', out.includes('ไม่ได้ลบ'), out.split('\n')[0]);

// Every conversational message so far has been free.
ok('the whole wizard used only free replies, never a paid push',
  lineSent.filter((m) => m.kind === 'push').length === 0,
  String(lineSent.filter((m) => m.kind === 'push').length));

head('38. LINE: the six-button rich menu');

lineSent.length = 0;
r = await call(lineApi, '/api/line?do=richmenu', { method: 'POST', as: 'content' });
ok('an ordinary editor cannot change what everyone sees', r.status === 403, String(r.status));

r = await call(lineApi, '/api/line?do=richmenu', { method: 'POST', as: 'admin' });
ok('an admin can install it', r.status === 200 && r.data.installed === true, JSON.stringify(r.data));

const menuMade = lineSent.find((m) => m.kind === 'richmenu');
ok('...at a size LINE accepts', menuMade.size.width === 2500 && menuMade.size.height === 1686,
  JSON.stringify(menuMade.size));
ok('...with six buttons, two rows of three', menuMade.areas.length === 6, String(menuMade.areas.length));
ok('...labelled as asked, meetings and events included',
  menuMade.areas.map((a) => a.action.text).join(' / ') === 'เพิ่มงาน / ตรวจสอบงาน / จัดการงาน / ประชุม / กิจกรรม / เอกสาร',
  menuMade.areas.map((a) => a.action.text).join(' / '));

// The regions must tile the whole picture with no gap and no overlap.
const xs = menuMade.areas.map((a) => a.bounds);
const tiles = (row) => row[0].x === 0 && row[0].x + row[0].width === row[1].x &&
  row[1].x + row[1].width === row[2].x && row[2].x + row[2].width === 2500;
ok('...each row tiles the full width, no gaps', tiles(xs.slice(0, 3)) && tiles(xs.slice(3)),
  xs.map((b) => `${b.x}+${b.width}`).join(' '));
ok('...and the two rows the full height',
  xs.slice(0, 3).every((b) => b.y === 0 && b.height === 843) &&
  xs.slice(3).every((b) => b.y === 843 && b.height === 843));

const menuPicture = lineSent.find((m) => m.kind === 'image');
ok('the picture was uploaded, as a PNG', menuPicture && menuPicture.type === 'image/png', JSON.stringify(menuPicture?.type));
ok('...and is a real image, not an empty buffer', menuPicture.bytes > 10000, String(menuPicture.bytes));
ok('it was made the default for everyone', lineSent.some((m) => m.kind === 'richmenu-default'));

r = await call(lineApi, '/api/line?do=status', { as: 'admin' });
ok('the website remembers it is installed', r.data.menuInstalled === true);
ok('...and only offers the button to admins', r.data.canManageMenu === true);
r = await call(lineApi, '/api/line?do=status', { as: 'content' });
ok('...not to editors', r.data.canManageMenu === false);

// Installing twice replaces rather than stacks.
lineSent.length = 0;
await call(lineApi, '/api/line?do=richmenu', { method: 'POST', as: 'admin' });
ok('installing again removes the old one first',
  lineSent.some((m) => m.kind === 'richmenu-default' && m.method === 'DELETE') ||
  lineSent.filter((m) => m.kind === 'richmenu').length === 1,
  JSON.stringify(lineSent.map((m) => m.kind)));

// And the buttons it sends really do drive the flows.
const menuWords = menuMade.areas.map((a) => a.action.text);
lineSent.length = 0;
await lineApi(lineHook(sayToBot('Uwiz', menuWords[0])));
ok('tapping the first button starts the wizard', lastReply().includes('ขั้นที่ 1/11'), lastReply().split('\n')[0]);
await lineApi(lineHook(sayToBot('Uwiz', 'ยกเลิก')));
await lineApi(lineHook(sayToBot('Uwiz', menuWords[1])));
ok('the second opens the view menu', lastReply().includes('ต้องการดูอะไร'), lastReply().split('\n')[0]);
await lineApi(lineHook(sayToBot('Uwiz', menuWords[2])));
ok('the third opens managing',
  lastReply().includes('เลือกงานที่ต้องการแก้') || lastReply().includes('ไม่มีงานที่ต้องจัดการ'),
  lastReply().split('\n')[0]);
await lineApi(lineHook(sayToBot('Uwiz', 'จบ')));

head('39. LINE: messages are readable, not escaped source code');

/**
 * Every check above asks "does the reply contain this phrase", which is true
 * whether the line breaks are real or the two characters \n printed literally.
 * A bug that made every multi-line message unreadable therefore passed the
 * entire suite. This is the check that fails when that happens.
 */
lineSent.length = 0;
const toExercise = [
  'ช่วยเหลือ', 'งาน', 'วันนี้', 'สัปดาห์นี้', 'เลยกำหนด', 'กิจกรรม',
  'ตรวจสอบงาน', 'จัดการงาน', '1', 'เสร็จแล้ว',
  'เพิ่มงาน', 'งานตรวจการขึ้นบรรทัด', 'ข้าม', 'ไม่ใช่วันที่', 'พรุ่งนี้',
  '09:00', 'ฉันเอง', '✓ เลือกเสร็จแล้ว', 'ไม่ต้องแท็กฝ่าย',
  'ด่วน', 'กำลังทำ', 'เฉพาะวันครบกำหนด', '✓ บันทึกงาน',
  'จัดการงาน', '1', 'ลบงานนี้', 'ไม่ลบ', 'จบ',
];
for (const line of toExercise) await lineApi(lineHook(sayToBot('Uwiz', line)));

const escaped = lineSent.filter((m) => (m.text || '').includes('\\n'));
ok(`no reply prints a literal \\n (checked ${lineSent.length} messages)`,
  escaped.length === 0,
  escaped.length ? escaped[0].text.slice(0, 90) : '');

const escapedLabels = lineSent.filter((m) => (m.labels || []).some((l) => l.includes('\\n')));
ok('no button label does either', escapedLabels.length === 0,
  escapedLabels.length ? JSON.stringify(escapedLabels[0].labels) : '');

// And the digest, which is built somewhere else entirely.
await sql`DELETE FROM line_digests_sent`;
await sql`UPDATE line_links SET digest = true WHERE line_user_id = 'Uwiz'`;
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานตรวจสรุป', dueDate: todayIsoForTest(), assignees: ['Jade_Pres'], notify: [] },
});
lineSent.length = 0;
await call(cronApi, '/api/cron');
const digestText = lineSent.find((m) => m.kind === 'push')?.text || '';
ok('the daily digest has real line breaks too',
  digestText.length > 0 && !digestText.includes('\\n') && digestText.includes('\n'),
  digestText.slice(0, 70).replace(/\n/g, ' ⏎ '));

head('40. LINE: links out to the website for what chat does badly');

const SITE = process.env.SITE_URL;
lineSent.length = 0;

// A list of work offers the way through to the full page.
await lineApi(lineHook(sayToBot('Uwiz', 'งาน')));
ok('a task list links to the website', lastReply().includes(`${SITE}/#/work`),
  lastReply().split('\n').slice(-1)[0]);

// Picking a task in the manage menu links to THAT task, and names what the
// website does that the chat cannot.
await lineApi(lineHook(sayToBot('Uwiz', 'จัดการงาน')));
await lineApi(lineHook(sayToBot('Uwiz', '1')));
const managed = lastReply();
ok('picking a task links straight to that task', /\/#\/t\/t_/.test(managed),
  managed.split('\n').slice(-1)[0]);
ok('...and says what the website is for',
  managed.includes('งานย่อย') || managed.includes('แนบไฟล์'),
  managed.replace(/\n/g, ' | ').slice(0, 140));
await lineApi(lineHook(sayToBot('Uwiz', 'จบ')));

// A task made through the wizard links to itself when saved.
const walk = ['เพิ่มงาน', 'งานที่มีลิงก์', 'ข้าม', 'พรุ่งนี้', 'ข้าม', 'ฉันเอง',
              '✓ เลือกเสร็จแล้ว', 'ไม่ต้องแท็กฝ่าย', 'ปกติ', 'ยังไม่เริ่ม',
              'เฉพาะวันครบกำหนด', '✓ บันทึกงาน'];
for (const w of walk) await lineApi(lineHook(sayToBot('Uwiz', w)));
const saved = lastReply();
ok('a newly saved task links to itself', /\/#\/t\/t_/.test(saved), saved.split('\n').slice(-1)[0]);

// The link really points at the task that was just made.
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
const linked = r.data.tasks.find((t) => t.title === 'งานที่มีลิงก์');
ok('...at the right id', saved.includes(`/#/t/${linked.id}`), linked?.id);

// And the digest carries one too.
await sql`DELETE FROM line_digests_sent`;
lineSent.length = 0;
await call(cronApi, '/api/cron');
const dg = lineSent.find((m) => m.kind === 'push')?.text || '';
ok('the daily digest links to the website', dg.includes(`${SITE}/#/work`), dg.split('\n').slice(-3)[0]);

/**
 * With no domain configured a link cannot be built, and the bot must simply
 * leave it out — printing "null" or a bare "/#/work" into a chat would be
 * worse than saying nothing at all.
 */
const keep = process.env.SITE_URL;
delete process.env.SITE_URL;
lineSent.length = 0;
await lineApi(lineHook(sayToBot('Uwiz', 'งาน')));
const bare = lastReply();
ok('with no site address the link is omitted entirely',
  !bare.includes('null') && !bare.includes('undefined') && !/#\/work/.test(bare),
  bare.split('\n').slice(-2).join(' | '));
ok('...and the list itself still works', bare.includes('งานของฉัน') || bare.includes('ไม่มีรายการ'));
process.env.SITE_URL = keep;

/**
 * Every letter now says how it leaves: either เลขานุการ forwards it, which
 * needs an address to forward to, or the writer posts it themselves. The
 * sections below were written before that and are about other things, so they
 * carry an address; the rule itself is section 76.
 */
head('41. Documents: the approval chain is built from who you are');

const { PDFDocument: PDFDoc } = await import('pdf-lib');
async function makePdf(pages = 2) {
  const d = await PDFDoc.create();
  for (let i = 0; i < pages; i++) d.addPage([595.28, 841.89]);
  return Buffer.from(await d.save()).toString('base64');
}
const sigPng = (await import('node:fs')).readFileSync('/tmp/sig.png').toString('base64');

/**
 * Full names, given once.
 *
 * A document carries its uploader's real name into the committee's register,
 * so the app asks for one before the first upload and keeps it.
 */
for (const [who, name] of [
  ['content', 'กุ๊งกิ๊ง ใจดีมาก'],
  ['merch', 'กล้วยหอม ทองดี'],
  ['admin', 'เจตน์ วุฒิเกริก'],
]) {
  await call(usersApi, '/api/users?do=me', { method: 'PATCH', as: who, body: { fullName: name } });
}
r = await call(usersApi, '/api/users', { as: 'admin' });
ok('a full name can be given and is kept',
  r.data.users.find((u) => u.username === 'Kungking_HeadCon')?.fullName === 'กุ๊งกิ๊ง ใจดีมาก',
  r.data.users.find((u) => u.username === 'Kungking_HeadCon')?.fullName);

// Who the system thinks must sign, for a plain member of ฝ่ายเนื้อหา.
r = await call(docsApi, '/api/documents?do=propose', {
  method: 'POST', as: 'content', body: { department: 'content' },
});
ok('a chain is proposed', r.status === 200, JSON.stringify(r.data).slice(0, 80));
let roles = r.data.steps.map((s) => s.role).join(' → ');
ok('...a department head signs their own letter, then it climbs to the director',
  roles === 'author → director → secretary', roles);

/**
 * The director's own letter: nobody approves it, but it still carries his
 * signature. This is the bug Jade reported — the chain only ever climbs, so
 * the man at the top got no step of his own and therefore nowhere to sign.
 */
r = await call(docsApi, '/api/documents?do=propose', { method: 'POST', as: 'admin', body: {} });
roles = r.data.steps.map((s) => s.role).join(' → ');
ok('the director gets a step to sign his own letter, then the secretary',
  roles === 'author → secretary', roles);

head('42. Documents: uploading, and what is refused');

const chain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;

// A signing role with nowhere to put the signature is refused.
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือขอใช้สถานที่', pdf: await makePdf(2), department: 'content',
          steps: chain.map((s) => ({ role: s.role, username: s.username })) },
});
ok('a signing step with no marked box is refused', r.status === 400 && r.data.error === 'MARK_REQUIRED',
  JSON.stringify(r.data));

// A box on a page that does not exist is refused.
const withMarks = (pageFor = () => 1) => chain.map((s) => ({
  role: s.role, username: s.username,
  mark: s.signs ? { page: pageFor(), x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null,
}));
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'x', pdf: await makePdf(2), department: 'content', steps: withMarks(() => 9) },
});
ok('a box on a page that does not exist is refused', r.data.error === 'MARK_OFF_PAGE', JSON.stringify(r.data));

// Something that is not a PDF is refused on its own bytes, not its name.
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'x', pdf: Buffer.from('totally not a pdf').toString('base64'),
          department: 'content', steps: withMarks() },
});
ok('a file that is not really a PDF is refused', r.data.error === 'NOT_A_PDF', JSON.stringify(r.data));

r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือขอใช้สถานที่', note: 'ขอใช้หอประชุม', recipient: 'สำนักบริหารระบบกายภาพ',
          priority: 'high', pdf: await makePdf(2), department: 'content', steps: withMarks() },
});
ok('a complete submission is accepted', r.status === 201 && r.data.id, JSON.stringify(r.data).slice(0, 80));
const docId = r.data.id;

head('43. Documents: nobody signs out of turn');

r = await call(docsApi, `/api/documents?id=${docId}`, { as: 'content' });
ok('it is waiting on the first approver', r.data.progress.length >= 3, JSON.stringify(r.data.progress.map(p => p.key)));
ok('...and the uploader cannot act on it themselves', r.data.myTurn === false);

// The secretary is last in the chain and cannot jump ahead.
r = await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: 'admin', body: { id: docId } });
const firstWaiting = (await call(docsApi, `/api/documents?id=${docId}`, { as: 'admin' })).data;
ok('the director is first here, so their approval is accepted',
  r.status === 200 || r.data.error === 'NO_SIGNATURE', JSON.stringify(r.data));

// A signing role with no signature on file is stopped before anything changes.
ok('...but only once they have a signature on file',
  r.data.error === 'NO_SIGNATURE', JSON.stringify(r.data));

r = await call(docsApi, '/api/documents?do=signature', {
  method: 'POST', as: 'admin', body: { png: Buffer.from('not a png').toString('base64') },
});
ok('a signature that is not a PNG is refused', r.data.error === 'NOT_A_PNG', JSON.stringify(r.data));

r = await call(docsApi, '/api/documents?do=signature', { method: 'POST', as: 'admin', body: { png: sigPng } });
ok('a real PNG signature is saved', r.status === 200 && r.data.width === 200, JSON.stringify(r.data));

head('44. Documents: signing stamps the PDF');

r = await call(docsApi, '/api/documents?do=approve', {
  method: 'POST', as: 'admin', body: { id: docId, comment: 'อนุมัติ' },
});
ok('the director signs', r.status === 200, JSON.stringify(r.data));
ok('...and a signature really went into the file', r.data.signaturesPlaced === 1, String(r.data.signaturesPlaced));
ok('...with nothing it could not place', (r.data.couldNotPlace || []).length === 0);

r = await call(docsApi, `/api/documents?id=${docId}`, { as: 'admin' });
const signedFile = r.data.files.find((f) => f.kind === 'signed');
ok('a signed copy now exists', Boolean(signedFile), JSON.stringify(r.data.files.map(f => f.kind)));
ok('...alongside the untouched original', r.data.files.some((f) => f.kind === 'original'));
ok('...and the document moved to the secretary', r.data.document.stage === 'secretary', r.data.document.stage);

// The file really is a PDF, and really has the signature in it.
const pdfRes = await docsApi(makeRequest(`/api/documents?id=${docId}&file=signed`, { as: 'admin' }));
const bytes = Buffer.from(await pdfRes.arrayBuffer());
ok('the signed file downloads as a PDF', pdfRes.headers.get('content-type') === 'application/pdf');
ok('...and is a valid PDF, not mangled text', bytes.subarray(0, 5).toString() === '%PDF-', bytes.subarray(0, 8).toString());
ok('...bigger than the original, because an image went in',
  bytes.length > Buffer.from(await makePdf(2), 'base64').length, String(bytes.length));

head('45. Documents: the progress bar tells the whole story');

r = await call(docsApi, `/api/documents?id=${docId}`, { as: 'content' });
const bar = r.data.progress;
ok('every stage is listed, in order',
  bar[0].key === 'submitted' && bar[bar.length - 1].key === 'sent', bar.map((b) => b.key).join(' → '));
ok('...each with who and when', bar[0].username === 'Kungking_HeadCon' && Boolean(bar[0].at),
  JSON.stringify({ who: bar[0].username, at: Boolean(bar[0].at) }));
const signedStep = bar.find((b) => b.role === 'director');
ok('...the director shows as signed, with a timestamp',
  signedStep.state === 'approved' && Boolean(signedStep.at), JSON.stringify(signedStep));
ok('...and says which steps put a signature in the file', signedStep.signs === true);

head('46. Documents: rejection carries the reason back');

const chain2 = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือที่จะถูกตีกลับ', pdf: await makePdf(1), department: 'content',
          steps: chain2.map((s) => ({ role: s.role, username: s.username,
            mark: s.signs ? { page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.06 } : null })) },
});
const rejectId = r.data.id;

r = await call(docsApi, '/api/documents?do=reject', { method: 'POST', as: 'admin', body: { id: rejectId } });
ok('rejecting without a reason is refused', r.data.error === 'REASON_REQUIRED', JSON.stringify(r.data));

r = await call(docsApi, '/api/documents?do=reject', {
  method: 'POST', as: 'admin', body: { id: rejectId, comment: 'วันที่ในเอกสารผิด' },
});
ok('rejecting with a reason works', r.status === 200 && r.data.stage === 'rejected');

const told = await sql`SELECT title, body FROM notifications
                       WHERE username = 'Kungking_HeadCon' AND task_id = ${rejectId}
                       ORDER BY created_at DESC LIMIT 1`;
ok('the uploader is told, and the reason travels with it',
  told[0] && told[0].body.includes('วันที่ในเอกสารผิด'), JSON.stringify(told[0]));

head('47. Documents: a higher-up can fix the file instead of sending it back');

const chain3 = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือที่จะถูกแก้', pdf: await makePdf(2), department: 'content',
          steps: chain3.map((s) => ({ role: s.role, username: s.username,
            mark: s.signs ? { page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.06 } : null })) },
});
const fixId = r.data.id;

r = await call(docsApi, '/api/documents?do=replace', {
  method: 'POST', as: 'admin', body: { id: fixId, pdf: await makePdf(3), comment: 'แก้วันที่ให้แล้ว' },
});
ok('an approver can replace the file in place', r.status === 200 && r.data.pages === 3, JSON.stringify(r.data));

r = await call(docsApi, `/api/documents?id=${fixId}`, { as: 'content' });
ok('...and the chain is untouched — no restarting', r.data.document.stage === 'approving');
ok('...with the replacement recorded in the history',
  r.data.events.some((e) => e.kind === 'replaced'), r.data.events.map((e) => e.kind).join(','));

// Somebody with no part in the document cannot touch it.
r = await call(docsApi, '/api/documents?do=replace', {
  method: 'POST', as: 'merch', body: { id: fixId, pdf: await makePdf(1) },
});
ok('an outsider cannot replace the file', r.status === 403, String(r.status));

head('48. Documents: who can see what');

r = await call(docsApi, '/api/documents', { as: 'merch' });
ok('somebody unconnected sees none of these documents',
  !r.data.documents.some((d) => d.id === docId), String(r.data.documents.length));

r = await call(docsApi, `/api/documents?id=${docId}`, { as: 'merch' });
ok('...and cannot open one directly either', r.status === 403, String(r.status));

r = await call(docsApi, `/api/documents?id=${docId}&file=signed`, { as: 'merch' });
ok('...nor download the file', r.status === 403, String(r.status));

r = await call(docsApi, '/api/documents', { as: 'content' });
ok('the uploader sees their own', r.data.documents.some((d) => d.id === docId));

// ===========================================================================
head('49. Secretaries: who may bring one in, and who may not');

for (const [name, pw, key] of [
  ['Sunday_Sec', 'sundayPw1', 'sunday'],
  ['Donat_Sec', 'donatPw11', 'donat'],
  ['Pin_Sec', 'pinPword1', 'pin'],
]) {
  await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: name, password: pw }, remember: key });
}
ok('the three secretaries signed in', Boolean(jar.sunday && jar.donat && jar.pin));

r = await call(docsApi, '/api/documents?do=secretaries', { as: 'sunday' });
ok('a head secretary may manage the list', r.data.mayManage === true && r.data.amHead === true);
ok('...and sees all three', r.data.secretaries.length === 3,
  r.data.secretaries.map((s) => s.username).join(','));

r = await call(docsApi, '/api/documents?do=secretaries', { as: 'pin' });
ok('an ordinary secretary may NOT', r.data.mayManage === false && r.data.amHead === false);

r = await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'pin', body: { add: 'Yam_HeadSpon' } });
ok('...and is refused when she tries', r.status === 403 && r.data.error === 'NOT_ALLOWED');

r = await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'content', body: { add: 'Yam_HeadSpon' } });
ok('nor can an editor from another department', r.status === 403);

r = await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'donat', body: { add: 'Yam_HeadSpon' } });
ok('the other head secretary CAN bring somebody in',
  r.status === 200 && r.data.secretaries.some((s) => s.username === 'Yam_HeadSpon'),
  r.data.secretaries?.map((s) => s.username).join(','));

r = await call(docsApi, '/api/documents', { as: 'seesall' });
ok('...and the new secretary immediately watches every document',
  r.data.documents.some((d) => d.id === docId));

r = await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'donat', body: { remove: 'Yam_HeadSpon' } });
ok('and can let them go again', !r.data.secretaries.some((s) => s.username === 'Yam_HeadSpon'));

r = await call(docsApi, '/api/documents', { as: 'seesall' });
ok('...after which they stop seeing other departments’ documents',
  !r.data.documents.some((d) => d.id === docId), String(r.data.documents.length));

// Somebody whose home teamspace is the secretariat must really leave it,
// not merely lose a grant while still sitting in the department.
await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'sunday', body: { remove: 'Pin_Sec' } });
r = await call(docsApi, '/api/documents?do=secretaries', { as: 'sunday' });
ok('removing a sheet-imported secretary really removes her',
  !r.data.secretaries.some((s) => s.username === 'Pin_Sec'),
  r.data.secretaries.map((s) => s.username).join(','));

await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'sunday', body: { remove: 'Donat_Sec' } });
r = await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'admin', body: { remove: 'Sunday_Sec' } });
ok('the last secretary cannot be removed', r.status === 400 && r.data.error === 'LAST_SECRETARY');

await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'sunday', body: { add: 'Donat_Sec' } });
await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'sunday', body: { add: 'Pin_Sec' } });
r = await call(docsApi, '/api/documents?do=secretaries', { as: 'sunday' });
ok('all three are back', r.data.secretaries.length === 3, r.data.secretaries.map((s) => s.username).join(','));

// ===========================================================================
head('50. Secretaries: how a document finds one');

r = await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'sunday',
  body: { mode: 'department', byDepartment: { content: 'Pin_Sec' } } });
ok('a head secretary can say "ฝ่ายเนื้อหา always goes to Pin"',
  r.data.mode === 'department' && r.data.byDepartment.content === 'Pin_Sec',
  JSON.stringify(r.data.byDepartment));

r = await call(docsApi, '/api/documents?do=propose', { method: 'POST', as: 'content', body: { department: 'content' } });
ok('...and a Content document is proposed to her',
  r.data.steps.find((s) => s.role === 'secretary')?.username === 'Pin_Sec',
  JSON.stringify(r.data.steps.map((s) => s.username)));

r = await call(docsApi, '/api/documents?do=propose', { method: 'POST', as: 'merch', body: { department: 'merchant' } });
ok('a department with nobody mapped still gets a real secretary',
  ['Sunday_Sec', 'Donat_Sec', 'Pin_Sec'].includes(r.data.steps.find((s) => s.role === 'secretary')?.username));

r = await call(docsApi, '/api/documents?do=secretaries', { method: 'POST', as: 'sunday', body: { mode: 'random' } });
ok('back to spreading the load', r.data.mode === 'random');

// Reassigning the document that is already in flight.
r = await call(docsApi, '/api/documents?do=assign', { method: 'POST', as: 'content',
  body: { id: docId, username: 'Pin_Sec' } });
ok('the uploader cannot move their document to a different secretary', r.status === 403);

r = await call(docsApi, '/api/documents?do=assign', { method: 'POST', as: 'pin',
  body: { id: docId, username: 'Pin_Sec' } });
ok('an ordinary secretary cannot either', r.status === 403);

r = await call(docsApi, '/api/documents?do=assign', { method: 'POST', as: 'sunday',
  body: { id: docId, username: 'Kungking_HeadCon' } });
ok('and nobody can be assigned who is not a secretary',
  r.status === 400 && r.data.error === 'NOT_A_SECRETARY');

r = await call(docsApi, '/api/documents?do=assign', { method: 'POST', as: 'sunday',
  body: { id: docId, username: 'Pin_Sec' } });
ok('a head secretary can move it', r.status === 200 && r.data.secretary === 'Pin_Sec', JSON.stringify(r.data));

r = await call(docsApi, `/api/documents?id=${docId}`, { as: 'sunday' });
ok('...and the chain now shows her',
  r.data.steps.find((s) => s.role === 'secretary')?.username === 'Pin_Sec');
ok('...with the handover written into the history',
  r.data.events.some((h) => h.kind === 'reassigned'),
  r.data.events.map((h) => h.kind).join(','));

r = await call(notifApi, '/api/notifications', { as: 'pin' });
ok('the new secretary is told', r.data.notifications.some((n) => /มอบหมาย/.test(n.title)),
  r.data.notifications.map((n) => n.title).join(' | ').slice(0, 80));

// ===========================================================================
head('51. Deleting a document');

const freshChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'merch', body: { department: 'merchant' } })).data.steps;
const marked = freshChain.map((s) => ({
  role: s.role, username: s.username,
  mark: s.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null,
}));
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'merch',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือขอถอน', pdf: await makePdf(1), department: 'merchant', steps: marked },
});
const mineId = r.data.id;
ok('a second document is submitted', Boolean(mineId), JSON.stringify(r.data).slice(0, 60));

r = await call(docsApi, `/api/documents?id=${mineId}`, { method: 'DELETE', as: 'content' });
ok('somebody else cannot delete it', r.status === 403 && r.data.error === 'NOT_ALLOWED');

r = await call(docsApi, `/api/documents?id=${mineId}`, { method: 'DELETE', as: 'merch' });
ok('the uploader can, while nobody has signed', r.status === 200 && r.data.deleted === true);

r = await call(docsApi, `/api/documents?id=${mineId}`, { as: 'merch' });
ok('...and it is gone from the system entirely', r.status === 404, String(r.status));
ok('...file and all', (await sql`SELECT count(*)::int AS n FROM doc_files WHERE doc_id = ${mineId}`)[0].n === 0);

// One that has already been signed is no longer the uploader's to erase.
r = await call(docsApi, `/api/documents?id=${docId}`, { method: 'DELETE', as: 'content' });
ok('a document somebody has signed cannot be withdrawn',
  r.status === 403 && r.data.error === 'ALREADY_ACTED_ON', JSON.stringify(r.data));

r = await call(docsApi, `/api/documents?id=${docId}`, { method: 'DELETE', as: 'admin' });
ok('an admin can always clear one away', r.status === 200 && r.data.deleted === true);

// ===========================================================================
head('52. An access change on the admin page reaches the Google Sheet');

const { generateKeyPairSync } = await import('node:crypto');
const { parseCsv: parseSheetCsv } = await import('../lib/sheet.js');
sheetValues = parseSheetCsv(SHEET_CSV);

r = await call(usersApi, '/api/users', { as: 'admin' });
ok('with no service account, the page is told the sheet cannot be written',
  r.data.sheetWritable === false && r.data.canSetAccess === true);

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', access: 'coadmin' } });
ok('the change still takes effect in the app',
  r.status === 200 && r.data.user.access === 'coadmin', JSON.stringify(r.data.did));
ok('...and is honest that the sheet did not get it', r.data.sheet.ok === false && r.data.sheet.reason === 'NOT_CONFIGURED');
ok('...so it is pinned against the next sync', r.data.user.accessPinned === true);

await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
ok('a sync does NOT undo a change the sheet never received',
  (await sql`SELECT access FROM users WHERE username = 'Kluayhom_HeadMerchant'`)[0].access === 'coadmin');

// Now with a service account configured.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SA_EMAIL = 'fair-bot@example.iam.gserviceaccount.com';
// Written with escaped newlines, which is how a key survives an env var.
process.env.GOOGLE_SA_PRIVATE_KEY =
  privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');

r = await call(usersApi, '/api/users', { as: 'admin' });
ok('the page now says the sheet can be written', r.data.sheetWritable === true);

sheetWrites.length = 0;
r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', access: 'editor' } });
ok('the sheet write is reported as done', r.data.sheet?.ok === true, JSON.stringify(r.data.sheet));
ok('...and the pin is released, because the sheet now agrees',
  r.data.user.accessPinned === false);

const wrote = sheetWrites.at(-1);
ok('exactly one cell was written — not the whole row', wrote.data.length === 1, JSON.stringify(wrote.data));
ok('...the Access cell on Kluayhom’s row (row 7)', wrote.data[0].range === 'F7', wrote.data[0].range);
ok('...with the label the sheet uses, not the internal key',
  wrote.data[0].values[0][0] === 'Editor', JSON.stringify(wrote.data[0].values));

// A department change is an access change too, and goes back the same way.
sheetWrites.length = 0;
r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', departments: ['merchant', 'marketing'] } });
const deptWrite = sheetWrites.at(-1);
ok('changing departments writes the Department cell, and only that',
  deptWrite.data.length === 1 && deptWrite.data[0].range === 'G7',
  JSON.stringify(deptWrite.data.map((d) => d.range)));
const cell = deptWrite.data.find((d) => d.range === 'G7').values[0][0];
ok('...in Thai, the way the column already reads', cell === 'ฝ่ายร้านค้า, Marketing', cell);

// And what it writes must survive a round trip through the reader.
const roundTrip = parseDepartmentList(cell);
ok('...and the sync reads back exactly what was written',
  roundTrip.keys.sort().join(',') === 'marketing,merchant' && !roundTrip.unknown.length,
  JSON.stringify(roundTrip));

sheetApiFails = true;
r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', access: 'coadmin' } });
ok('when Google refuses, the app change still stands',
  r.status === 200 && r.data.user.access === 'coadmin');
ok('...the admin is told plainly', r.data.sheet.ok === false && r.data.sheet.reason === 'GOOGLE_REFUSED',
  JSON.stringify(r.data.sheet).slice(0, 80));
ok('...and it is pinned again', r.data.user.accessPinned === true);
sheetApiFails = false;

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Kluayhom_HeadMerchant', followSheet: true } });
ok('"follow the sheet again" releases both pins',
  r.data.user.accessPinned === false && r.data.user.deptsPinned === false);

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Jade_Pres', access: 'editor' } });
ok('the last admin cannot demote themselves out of the building',
  r.status === 400 && r.data.error === 'LAST_ADMIN', JSON.stringify(r.data));

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Kungking_HeadCon', access: 'wizard' } });
ok('a made-up access level is refused', r.status === 400 && r.data.error === 'BAD_ACCESS');

// ===========================================================================
head('53. Finished documents move to Google Drive, and only then leave the database');

// A document walked all the way through: signed by the director, sent by the
// secretary. That is the state the archive is for.
const archChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'merch', body: { department: 'merchant' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'merch',
  body: { recipientEmail: 'office@example.ac.th', 
    title: 'หนังสือเชิญประชุมผู้ประกอบการ', recipient: 'ร้านค้าในงาน',
    pdf: await makePdf(1), department: 'merchant',
    steps: archChain.map((s) => ({
      role: s.role, username: s.username,
      mark: s.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null,
    })),
  },
});
const archId = r.data.id;
await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: 'admin', body: { id: archId } });

r = await call(docsApi, `/api/documents?id=${archId}`, { as: 'admin' });
const secName = r.data.steps.find((s) => s.role === 'secretary').username;
const secSession = { Sunday_Sec: 'sunday', Donat_Sec: 'donat', Pin_Sec: 'pin' }[secName];
r = await call(docsApi, '/api/documents?do=send', { method: 'POST', as: secSession, body: { id: archId, to: 'ร้านค้าในงาน' } });
ok('the secretary sends it', r.status === 200, JSON.stringify(r.data).slice(0, 60));

// Nothing is archived while the archive account is not set up — and nothing
// is lost either.
r = await call(cronApi, '/api/cron');
ok('with no Drive account configured, nothing is archived', Boolean(r.data.archive.skipped), JSON.stringify(r.data.archive));
ok('...and the file is still here',
  (await sql`SELECT count(*)::int AS n FROM doc_files WHERE doc_id = ${archId}`)[0].n > 0);

process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_DRIVE_REFRESH_TOKEN = '1//test-refresh';
process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-of-the-fair';

r = await call(cronApi, '/api/cron');
ok('the sent document is copied to Drive', r.data.archive.archived.includes(archId), JSON.stringify(r.data.archive));
const stored = [...driveFiles.values()].pop();
ok('...filed under the folder it was told to use',
  stored.parents && stored.parents[0] === 'folder-of-the-fair', JSON.stringify(stored.parents));
ok('...named by date and title, as a PDF',
  /^\d{4}-\d{2}-\d{2} หนังสือเชิญประชุมผู้ประกอบการ\.pdf$/.test(stored.name), stored.name);

let archRow = (await sql`SELECT drive_url, archived_at FROM documents WHERE id = ${archId}`)[0];
ok('the document now carries its Drive link', /drive\.google\.com/.test(archRow.drive_url), archRow.drive_url);
ok('...and when it was archived', Boolean(archRow.archived_at));
ok('...with the move written into its history',
  (await sql`SELECT count(*)::int AS n FROM doc_events WHERE doc_id = ${archId} AND kind = 'archived'`)[0].n === 1);

ok('the file is STILL in the database — the copy is not deleted the same day',
  (await sql`SELECT count(*)::int AS n FROM doc_files WHERE doc_id = ${archId}`)[0].n > 0);

r = await call(cronApi, '/api/cron');
ok('a second run does not archive it twice', !r.data.archive.archived.includes(archId), JSON.stringify(r.data.archive.archived));

// Three days on.
await sql`UPDATE documents SET archived_at = now() - interval '4 days' WHERE id = ${archId}`;

driveTrashed = true;
r = await call(cronApi, '/api/cron');
ok('if the archive copy has gone missing, the database copy is KEPT',
  !r.data.archive.purged.includes(archId) &&
  (await sql`SELECT count(*)::int AS n FROM doc_files WHERE doc_id = ${archId}`)[0].n > 0,
  JSON.stringify(r.data.archive.failed));
driveTrashed = false;

r = await call(cronApi, '/api/cron');
ok('once Drive confirms it, the database copy goes', r.data.archive.purged.includes(archId), JSON.stringify(r.data.archive));
ok('...and the row, the chain and the history all remain',
  (await sql`SELECT count(*)::int AS n FROM documents WHERE id = ${archId}`)[0].n === 1 &&
  (await sql`SELECT count(*)::int AS n FROM doc_steps WHERE doc_id = ${archId}`)[0].n > 0);

r = await call(docsApi, `/api/documents?id=${archId}&file=signed`, { as: 'merch' });
ok('asking for the file now points at Drive instead of failing blankly',
  r.status === 410 && r.data.error === 'ARCHIVED' && /drive\.google\.com/.test(r.data.driveUrl),
  JSON.stringify(r.data).slice(0, 80));

// And an archive that refuses an upload must not take the document with it.
driveRefuses = true;
const refusedChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'merch', body: { department: 'merchant' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'merch',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือฉบับที่สอง', pdf: await makePdf(1), department: 'merchant',
          steps: refusedChain.map((s) => ({ role: s.role, username: s.username,
            mark: s.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null })) },
});
const secondId = r.data.id;
await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: 'admin', body: { id: secondId } });
r = await call(docsApi, `/api/documents?id=${secondId}`, { as: 'admin' });
const sec2 = { Sunday_Sec: 'sunday', Donat_Sec: 'donat', Pin_Sec: 'pin' }[r.data.steps.find((s) => s.role === 'secretary').username];
await call(docsApi, '/api/documents?do=send', { method: 'POST', as: sec2, body: { id: secondId, to: 'x' } });

r = await call(cronApi, '/api/cron');
ok('an archive that refuses is reported, not swallowed',
  r.data.archive.failed.some((f) => f.id === secondId), JSON.stringify(r.data.archive.failed));
ok('...and the document keeps its file until the archive works',
  (await sql`SELECT count(*)::int AS n FROM doc_files WHERE doc_id = ${secondId}`)[0].n > 0);
driveRefuses = false;

r = await call(cronApi, '/api/cron');
ok('the next run picks it up', r.data.archive.archived.includes(secondId), JSON.stringify(r.data.archive.archived));

/**
 * With no folder id configured, the app makes its own.
 *
 * This is not tidiness. Under the drive.file scope an app can only touch what
 * it created, so a folder somebody made by hand in the browser is invisible to
 * it and uploading into one fails with a 404 about a folder that plainly
 * exists. A folder the app created is its own.
 */
delete process.env.GOOGLE_DRIVE_FOLDER_ID;
const { forgetFolder } = await import('../lib/drive.js');
forgetFolder();
driveFolders.clear();

const ownChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'merch', body: { department: 'merchant' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'merch',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือเข้าโฟลเดอร์ของแอป', pdf: await makePdf(1), department: 'merchant',
          steps: ownChain.map((st) => ({ role: st.role, username: st.username,
            mark: st.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null })) },
});
const ownId = r.data.id;
await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: 'admin', body: { id: ownId } });
r = await call(docsApi, `/api/documents?id=${ownId}`, { as: 'admin' });
const ownSec = { Sunday_Sec: 'sunday', Donat_Sec: 'donat', Pin_Sec: 'pin' }[
  r.data.steps.find((st) => st.role === 'secretary').username];
await call(docsApi, '/api/documents?do=send', { method: 'POST', as: ownSec, body: { id: ownId, to: 'x' } });

r = await call(cronApi, '/api/cron');
ok('with no folder configured, the app creates one of its own',
  driveFolders.size === 1, JSON.stringify([...driveFolders.values()]));
ok('...and files the document in it', r.data.archive.archived.includes(ownId),
  JSON.stringify(r.data.archive));
const filedIn = [...driveFiles.values()].pop();
ok('...not loose at the top of the Drive',
  filedIn.parents && driveFolders.has(filedIn.parents[0]), JSON.stringify(filedIn.parents));

// A second document reuses that folder rather than making another.
forgetFolder();
const againChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'merch', body: { department: 'merchant' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'merch',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือฉบับถัดไป', pdf: await makePdf(1), department: 'merchant',
          steps: againChain.map((st) => ({ role: st.role, username: st.username,
            mark: st.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null })) },
});
const againId = r.data.id;
await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: 'admin', body: { id: againId } });
r = await call(docsApi, `/api/documents?id=${againId}`, { as: 'admin' });
await call(docsApi, '/api/documents?do=send', { method: 'POST',
  as: { Sunday_Sec: 'sunday', Donat_Sec: 'donat', Pin_Sec: 'pin' }[
    r.data.steps.find((st) => st.role === 'secretary').username],
  body: { id: againId, to: 'x' } });
await call(cronApi, '/api/cron');
ok('...and the next document goes in the same folder, not a new one',
  driveFolders.size === 1, String(driveFolders.size));

// ===========================================================================
head('54. LINE: the เอกสาร button, and acting on a document from the chat');

/**
 * The button on the notification sent the word เอกสาร and the bot had no such
 * command, so every person who tapped it got "ไม่เข้าใจคำสั่ง". That is the
 * bug this section exists to keep fixed.
 */
// Three LINE accounts for this section: the director, a secretary who
// watches everything, and somebody with no connection to the document at all.
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Udoc1', 'Jade_Pres', 'Jade'), ('Udoc2', 'Sunday_Sec', 'Sunday'),
                 ('Udoc3', 'Yam_HeadSpon', 'Yam')
          ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;

const docChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th', 
    title: 'หนังสือขออนุมัติจัดกิจกรรม', recipient: 'คณบดี', priority: 'high',
    pdf: await makePdf(1), department: 'content',
    steps: docChain.map((s) => ({
      role: s.role, username: s.username,
      mark: s.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null,
    })),
  },
});
const lineDocId = r.data.id;
ok('a document is waiting on the director', Boolean(lineDocId), JSON.stringify(r.data).slice(0, 60));

lineSent.length = 0;
await lineApi(lineHook(sayToBot('Udoc1', 'เอกสาร')));
let said = lastReply();
ok('the เอกสาร button is understood at last', !/ไม่เข้าใจคำสั่ง/.test(said), said.slice(0, 60));
ok('...and shows what is waiting on this person', said.includes('หนังสือขออนุมัติจัดกิจกรรม'),
  said.split('\n').slice(0, 4).join(' | '));
ok('...saying it is their turn', /ถึงคิวของคุณ/.test(said), said.split('\n').slice(0, 6).join(' | '));
ok('...with a link to the website', /https?:\/\/[^\s]*#\/d(ocs)?/.test(said),
  said.split('\n').filter((l) => l.includes('http')).join(' '));

await lineApi(lineHook(sayToBot('Udoc1', 'เอกสาร 1')));
said = lastReply();
ok('opening it shows the progress, step by step',
  said.includes('ส่งเรื่อง') && said.includes('ประธานโครงการ') && said.includes('เลขานุการ'),
  said.split('\n').slice(0, 8).join(' | '));
ok('...and offers the two things they can do', said.includes('อนุมัติ') && said.includes('ตีกลับ'));
ok('...with a link straight to that document',
  said.includes(`#/d/${lineDocId}`), said.split('\n').filter((l) => l.includes('http')).join(' '));

// The card's buttons are postbacks, so tapping one does not write a command
// into the person's own chat history.
const bubbleSent = lineSent.filter((m) => m.flex?.length).slice(-1)[0];
const postbacks = JSON.stringify(bubbleSent.flex).match(/"type":"postback"/g) || [];
ok('the buttons are postbacks, not fake typing', postbacks.length === 2, String(postbacks.length));

// Somebody it is not waiting on sees it, but gets no buttons.
await lineApi(lineHook(sayToBot('Udoc2', 'เอกสารทั้งหมด')));
said = lastReply();
ok('a watcher can follow the status of every document they may see',
  said.includes('หนังสือขออนุมัติจัดกิจกรรม'), said.split('\n').slice(0, 4).join(' | '));

r = await call(docsApi, `/api/documents?id=${lineDocId}`, { as: 'admin' });
ok('it is still waiting, no approver has acted',
  r.data.steps.filter((s) => s.role !== 'author').every((s) => s.state === 'waiting'),
  r.data.steps.map((s) => s.role + ':' + s.state).join(' '));

// Rejecting from the chat must carry a reason.
await lineApi(lineHook(sayToBot('Udoc1', 'ตีกลับ 1')));
ok('ตีกลับ with no reason is refused', /เหตุผล/.test(lastReply()), lastReply().slice(0, 60));

// Approving from the chat is the same act as approving on the website.
await lineApi(lineHook(sayToBot('Udoc1', 'เอกสาร')));
await lineApi(lineHook(sayToBot('Udoc1', 'อนุมัติ 1')));
r = await call(docsApi, `/api/documents?id=${lineDocId}`, { as: 'admin' });
ok('approving from LINE really signs it',
  r.data.steps.find((s) => s.role === 'director')?.state === 'approved',
  JSON.stringify(r.data.steps.map((s) => s.role + ':' + s.state)));
ok('...and it stamped the PDF, the same as the website would',
  r.data.files.some((f) => f.kind === 'signed'), JSON.stringify(r.data.files.map((f) => f.kind)));
ok('...and the chat shows the updated progress back', /เลขานุการ/.test(lastReply()));

// A number from an old list cannot reach a document this person may not see.
await lineApi(lineHook(sayToBot('Udoc3', 'เอกสาร 1')));
ok('somebody unconnected cannot open one by guessing a number',
  !lastReply().includes('หนังสือขออนุมัติจัดกิจกรรม'), lastReply().slice(0, 70));

// The ตีกลับ button asks for the reason, then does it.
const rejectChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือที่จะถูกตีกลับจากไลน์', pdf: await makePdf(1), department: 'content',
          steps: rejectChain.map((s) => ({ role: s.role, username: s.username,
            mark: s.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null })) },
});
const lineRejectId = r.data.id;

await lineApi(lineHook([{
  type: 'postback', replyToken: 'rt_pb1', source: { type: 'user', userId: 'Udoc1' },
  postback: { data: `doc:reject:${lineRejectId}` },
}]));
ok('the ตีกลับ button asks what is wrong', /พิมพ์เหตุผล/.test(lastReply()), lastReply().slice(0, 60));

await lineApi(lineHook(sayToBot('Udoc1', 'วันที่ผิด แก้เป็น 20 พ.ย. ด้วยค่ะ')));
r = await call(docsApi, `/api/documents?id=${lineRejectId}`, { as: 'admin' });
ok('...and the reason is what comes back with it',
  r.data.document.stage === 'rejected' &&
  r.data.steps.some((s) => (s.comment || '').includes('20 พ.ย.')),
  JSON.stringify(r.data.steps.map((s) => s.state + ':' + (s.comment || ''))));
ok('...the file is gone but the reason is kept', r.data.files.length === 0);

r = await call(notifApi, '/api/notifications', { as: 'content' });
ok('the person who sent it is told why', r.data.notifications.some((n) => /ตีกลับ/.test(n.title)),
  r.data.notifications.map((n) => n.title).join(' | ').slice(0, 70));

// ===========================================================================
head('55. The two new levels: a unit editor runs a section, a member does not');

const levels = await sql`
  SELECT username, access FROM users
  WHERE username IN ('New_UnitCon', 'Ploy_StaffCon', 'Kungking_HeadCon')`;
const levelOf = Object.fromEntries(levels.map((u) => [u.username, u.access]));
ok('"Unit Editor" in the sheet becomes a unit editor', levelOf.New_UnitCon === 'unitlead', levelOf.New_UnitCon);
ok('"Inner" becomes a member', levelOf.Ploy_StaffCon === 'inner', levelOf.Ploy_StaffCon);

for (const [name, pw, key] of [
  ['New_UnitCon', 'unitLead11', 'unitlead'],
  ['Ploy_StaffCon', 'memberPw11', 'member'],
  ['Fah_StaffCon', 'memberPw22', 'member2'],
]) {
  await call(authApi, '/api/auth?do=setup', { method: 'POST', body: { username: name, password: pw }, remember: key });
}
ok('all three signed in', Boolean(jar.unitlead && jar.member && jar.member2));

// Sections: New leads เวที (Stage); Ploy is in it, Fah is not.
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'New_UnitCon', unit: 'Stage' } });
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Ploy_StaffCon', unit: 'Stage' } });
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Fah_StaffCon', unit: 'Exhibition' } });

// ---- a member ------------------------------------------------------------
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'member',
  body: { title: 'งานที่สมาชิกพยายามสร้าง', assignees: ['Ploy_StaffCon'] } });
ok('a member cannot create a task', r.status === 403 && r.data.error === 'MEMBERS_CANNOT_CREATE',
  JSON.stringify(r.data));

r = await call(eventsApi, '/api/events', { method: 'POST', as: 'member',
  body: { title: 'กิจกรรมที่สมาชิกพยายามสร้าง', startsOn: '2026-11-20' } });
ok('...nor an event', r.status === 403 && r.data.error === 'MEMBERS_CANNOT_CREATE', JSON.stringify(r.data));

// ---- a unit editor -------------------------------------------------------
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'unitlead',
  body: { title: 'ซ้อมคิวเวที', department: 'content', unit: 'Stage',
          assignees: ['Ploy_StaffCon'], notify: [] } });
ok('a unit editor CAN give work to their own section', r.status === 201, JSON.stringify(r.data).slice(0, 80));
const unitTaskId = r.data.task?.id;

/**
 * These four used to assert the opposite, and were right to at the time.
 *
 * Jade asked for the rule to go: "change the access for all user to being able
 * to appoint any user regardless of rank or department." The fair works across
 * departments constantly, and a unit head who needed one person from สถานที่
 * for an afternoon had to go through somebody more senior to ask. What replaces
 * the rule is not nothing — the person appointed still gets an invitation to
 * accept or decline, and whoever appoints them is warned first if they are not
 * free. These now hold the new rule to the same standard.
 */
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'unitlead',
  body: { title: 'งานข้ามหน่วย', department: 'content', assignees: ['Fah_StaffCon'], notify: [] } });
ok('a unit editor can now give work to somebody in another section',
  r.status === 201, JSON.stringify(r.data).slice(0, 70));

const crossUnit = await sql`
  SELECT username FROM task_people p JOIN tasks t ON t.id = p.task_id
  WHERE t.title = 'งานข้ามหน่วย'`;
ok('...and the person outside the section really is on it',
  crossUnit.some((x) => x.username === 'Fah_StaffCon'),
  crossUnit.map((x) => x.username).join(', '));

r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'unitlead',
  body: { title: 'แท็กทั้งฝ่าย', department: 'content',
          departments: [{ key: 'content', scope: 'all' }], notify: [] } });
ok('...and tagging a whole department is allowed too',
  r.status === 201, JSON.stringify(r.data).slice(0, 70));

/**
 * Widened on a task of its own, not on unitTaskId.
 *
 * unitTaskId is the one the checks further down use to prove that somebody NOT
 * on a task cannot close it — adding Fah to it here would quietly make that
 * check pass for the wrong reason, which is worse than it failing.
 */
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'unitlead',
  body: { title: 'งานที่จะขยายทีหลัง', department: 'content',
          assignees: ['Ploy_StaffCon'], notify: [] } });
const widenId = r.data.task?.id;
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'unitlead',
  body: { id: widenId, assignees: ['Ploy_StaffCon', 'Fah_StaffCon'] } });
ok('...and they can widen their own task later', r.status === 200, JSON.stringify(r.data).slice(0, 60));
const widened = await sql`SELECT username FROM task_people WHERE task_id = ${widenId}`;
ok('...with both people really on it afterwards', widened.length === 2,
  widened.map((x) => x.username).join(', '));

/**
 * The rank rules that did NOT change, checked here so that opening assignment
 * up cannot be mistaken for opening everything up. A member still cannot create
 * work, and a unit head still cannot touch anybody's account.
 */
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'member',
  body: { title: 'สมาชิกยังสร้างไม่ได้', assignees: ['Fah_StaffCon'] } });
ok('a member still cannot create work for anybody',
  r.status === 403 && r.data.error === 'MEMBERS_CANNOT_CREATE', JSON.stringify(r.data));

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'unitlead',
  body: { username: 'Fah_StaffCon', access: 'editor' } });
ok('...and a unit editor still cannot change anybody\u2019s access',
  r.status === 403, JSON.stringify(r.data).slice(0, 60));

// ---- what they can still do ---------------------------------------------
r = await call(tasksApi, '/api/tasks', { as: 'member' });
ok('a member still sees their department’s work',
  r.data.tasks.some((t) => t.id === unitTaskId), String(r.data.tasks.length));

r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'member',
  body: { id: unitTaskId, status: 'doing' } });
ok('...and can say they have started what was given to them',
  r.status === 200, JSON.stringify(r.data).slice(0, 60));

r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'member',
  body: { id: unitTaskId, title: 'เปลี่ยนชื่องานเอง' } });
const stillNamed = await sql`SELECT title FROM tasks WHERE id = ${unitTaskId}`;
ok('...but cannot rewrite it', stillNamed[0].title === 'ซ้อมคิวเวที', stillNamed[0].title);

r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'member2',
  body: { id: unitTaskId, status: 'done' } });
ok('somebody not on the task cannot close it', r.status === 403, String(r.status));

// An editor is unchanged by any of this.
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'content',
  body: { title: 'งานปกติของประธานฝ่าย', assignees: ['Fah_StaffCon', 'Ploy_StaffCon'], notify: [] } });
ok('a department head can still assign across sections', r.status === 201, JSON.stringify(r.data).slice(0, 60));

// And the level can be set from the admin page like any other.
r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Fah_StaffCon', access: 'unitlead' } });
ok('an admin can promote a member to unit editor',
  r.status === 200 && r.data.user.access === 'unitlead', JSON.stringify(r.data.did));
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Fah_StaffCon', access: 'inner' } });

// ===========================================================================
head('56. Units: set on the admin page, written back to the sheet');

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Ploy_StaffCon', unit: 'สถานที่' } });
ok('a section from another department is refused',
  r.status === 400 && r.data.error === 'UNIT_NOT_IN_DEPARTMENT', JSON.stringify(r.data));

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Ploy_StaffCon', unit: 'Exhibition' } });
ok('one from a department she has is accepted',
  r.status === 200 && r.data.user.unit === 'Exhibition', JSON.stringify(r.data.did));

sheetWrites.length = 0;
r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Ploy_StaffCon', unit: 'Stage' } });
const unitWrite = sheetWrites.at(-1);
ok('...and it reaches the sheet', Boolean(unitWrite), JSON.stringify(r.data.sheet));

/**
 * The roster has no Unit column yet, so the app has to make one. It goes after
 * the last column in use, with its header, and never on top of anything.
 */
const wroteHeader = unitWrite.data.find((d) => /^[A-Z]+1$/.test(d.range));
ok('a missing Unit column is created, with its header',
  wroteHeader && wroteHeader.values[0][0] === 'Unit', JSON.stringify(unitWrite.data));
ok('...in the first free column, not over the Department column',
  wroteHeader.range.startsWith('H'), wroteHeader.range);
const wroteValue = unitWrite.data.find((d) => !/^[A-Z]+1$/.test(d.range));
ok('...and the section lands on that person’s row',
  wroteValue.range === 'H14' && wroteValue.values[0][0] === 'Stage', JSON.stringify(wroteValue));

// Second time round the column exists, so it is used rather than made again.
sheetValues = sheetValues.map((row, i) => (i === 0 ? row.concat(['Unit']) : row.concat([''])));
sheetWrites.length = 0;
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Ploy_StaffCon', unit: 'Exhibition' } });
const second = sheetWrites.at(-1);
ok('an existing Unit column is reused, not duplicated',
  second.data.length === 1 && second.data[0].range === 'H14',
  JSON.stringify(second.data.map((d) => d.range)));

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Ploy_StaffCon', unit: null } });
ok('clearing it works too', r.status === 200 && r.data.user.unit === null, JSON.stringify(r.data.did));

// ===========================================================================
head('57. Deleting an account that has left');

r = await call(usersApi, '/api/users?do=user&username=Fah_StaffCon', { method: 'DELETE', as: 'admin' });
ok('an account still in the committee cannot be deleted',
  r.status === 400 && r.data.error === 'ONLY_INACTIVE_OR_SUSPENDED', JSON.stringify(r.data));

r = await call(usersApi, '/api/users?do=user&username=Jade_Pres', { method: 'DELETE', as: 'admin' });
ok('...and nobody can delete themselves',
  r.status === 400 && r.data.error === 'CANNOT_DELETE_YOURSELF', JSON.stringify(r.data));

// Something of theirs to check survives.
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'content',
  body: { title: 'งานที่คนลาออกเคยสร้าง', assignees: ['Fah_StaffCon'], notify: [] } });
const orphanTask = r.data.task.id;
await sql`UPDATE tasks SET created_by = 'Fah_StaffCon' WHERE id = ${orphanTask}`;

await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Fah_StaffCon', suspended: true } });

r = await call(usersApi, '/api/users?do=user&username=Fah_StaffCon', { method: 'DELETE', as: 'editor' });
ok('an editor cannot delete anybody', r.status === 403, String(r.status));

r = await call(usersApi, '/api/users?do=user&username=Fah_StaffCon', { method: 'DELETE', as: 'admin' });
ok('a suspended account can be deleted', r.status === 200 && r.data.removed === 'Fah_StaffCon',
  JSON.stringify(r.data).slice(0, 70));

const gone2 = await sql`SELECT count(*)::int AS n FROM users WHERE username = 'Fah_StaffCon'`;
ok('...and is really gone', gone2[0].n === 0);

const theirWork = await sql`SELECT created_by FROM tasks WHERE id = ${orphanTask}`;
ok('...but the work they created stays, handed to whoever removed them',
  theirWork.length === 1 && theirWork[0].created_by === 'Jade_Pres',
  JSON.stringify(theirWork[0]));

const leftovers = await sql`
  SELECT (SELECT count(*)::int FROM task_people WHERE username = 'Fah_StaffCon') AS tagged,
         (SELECT count(*)::int FROM notifications WHERE username = 'Fah_StaffCon') AS notes`;
ok('...with nothing of theirs left behind',
  leftovers[0].tagged === 0 && leftovers[0].notes === 0, JSON.stringify(leftovers[0]));

r = await call(authApi, '/api/auth?do=login', { method: 'POST',
  body: { username: 'Fah_StaffCon', password: 'memberPw22' } });
ok('...and they cannot sign back in', r.status === 401 || r.status === 403, String(r.status));

// The sheet still lists them, so the next sync brings the account back — which
// is correct: the sheet is what decides who is in the committee.
await call(usersApi, '/api/users?do=sync', { method: 'POST', as: 'admin' });
const backAgain2 = await sql`SELECT count(*)::int AS n FROM users WHERE username = 'Fah_StaffCon'`;
ok('a sync restores anyone still on the sheet — the sheet decides membership',
  backAgain2[0].n === 1, String(backAgain2[0].n));

// ===========================================================================
head('58. Short codes, and finding things by them');

r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin',
  body: { title: 'งานที่มีรหัส', description: 'รายละเอียดเรื่องเวทีกลาง', notify: [] } });
const coded = r.data.task;
ok('a new task gets a short code', /^T\d{4}$/.test(coded.code || ''), coded.code);

r = await call(eventsApi, '/api/events', { method: 'POST', as: 'admin',
  body: { title: 'กิจกรรมที่มีรหัส', startsOn: '2026-11-25' } });
ok('...and so does an event', /^E\d{4}$/.test(r.data.event.code || ''), r.data.event.code);
const eventCode = r.data.event.code;

r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin',
  body: { title: 'งานถัดไป', notify: [] } });
ok('codes are handed out in order and never repeat',
  r.data.task.code !== coded.code && r.data.task.code > coded.code,
  `${coded.code} → ${r.data.task.code}`);

const dupes = await sql`
  SELECT count(*)::int AS n FROM (SELECT code FROM tasks GROUP BY code HAVING count(*) > 1) d`;
ok('...and no two tasks share one', dupes[0].n === 0, String(dupes[0].n));

const everyOne = await sql`SELECT count(*)::int AS n FROM tasks WHERE code IS NULL`;
ok('every task that existed before has one too', everyOne[0].n === 0, String(everyOne[0].n));

// From LINE: the code on its own is enough.
lineSent.length = 0;
await lineApi(lineHook(sayToBot('Udoc1', coded.code)));
said = lastReply();
ok('typing a code into LINE opens that task',
  said.includes('งานที่มีรหัส') && said.includes(coded.code),
  said.split('\n').slice(0, 4).join(' | '));

await lineApi(lineHook(sayToBot('Udoc1', eventCode.toLowerCase())));
ok('...in lower case too, and for events',
  lastReply().includes('กิจกรรมที่มีรหัส'), lastReply().split('\n').slice(0, 4).join(' | '));

await lineApi(lineHook(sayToBot('Udoc1', 'หา เวทีกลาง')));
ok('searching reaches the description, not just the title',
  lastReply().includes('งานที่มีรหัส'), lastReply().split('\n').slice(0, 4).join(' | '));

await lineApi(lineHook(sayToBot('Udoc1', 'T9999')));
ok('a code nobody has says so plainly',
  /ไม่มีรายการ|ไม่พบ/.test(lastReply()), lastReply().split('\n').slice(0, 3).join(' | '));

// ===========================================================================
head('59. เลขรันเอกสาร: the committee\u2019s own document numbers');

const { forgetPlan } = await import('../lib/docregister.js');

// The register, laid out exactly as the committee's is.
makeTab('เนื้อหา ', 'เนื้อหา', '03');
makeTab('Stage', 'Stage', '03.01');
makeTab('Exhibiton', 'Exhibition', '03.02.01');   // the tab label really is misspelled
makeTab('ร้านค้า', 'ร้านค้า', '04');
process.env.DOC_SHEET_ID = REGISTER_ID;
forgetPlan();

/** Signs a document all the way to the secretary and returns its row. */
async function toSecretary(as, body) {
  const chain = (await call(docsApi, '/api/documents?do=propose',
    { method: 'POST', as, body: { department: body.department, unit: body.unit } })).data.steps;
  const made = await call(docsApi, '/api/documents?do=create', {
    method: 'POST', as,
    body: { recipientEmail: 'office@example.ac.th', 
      ...body, pdf: await makePdf(1),
      steps: chain.map((st) => ({
        role: st.role, username: st.username,
        mark: st.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null,
      })),
    },
  });
  const id = made.data.id;
  // Everyone above the uploader signs, until it reaches the secretary.
  for (let guard = 0; guard < 4; guard++) {
    const view = (await call(docsApi, `/api/documents?id=${id}`, { as: 'admin' })).data;
    const step = view.steps.find((st) => st.state === 'waiting');
    if (!step || step.role === 'secretary') break;
    const session = { Jade_Pres: 'admin', Kungking_HeadCon: 'content' }[step.username];
    if (!session) break;
    await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: session, body: { id } });
  }
  const [row] = await sql`SELECT * FROM documents WHERE id = ${id}`;
  return row;
}

let doc1 = await toSecretary('content', {
  title: 'ขอใช้หอประชุมจุฬาฯ', recipient: 'สำนักบริหารระบบกายภาพ',
  department: 'content', unit: 'Stage',
});
ok('a number is issued, from the committee\u2019s own sheet',
  doc1.doc_number === 'อบจ.จฬฟ. 03.01-001/2569', doc1.doc_number);
ok('...on the tab for that section, not the department',
  doc1.doc_tab === 'Stage', doc1.doc_tab);

let log = registerLog('Stage');
ok('the register has a row for it', log.length === 1, JSON.stringify(log));
ok('...with the title the committee will read', log[0].title === 'ขอใช้หอประชุมจุฬาฯ', log[0].title);
ok('...the responsible person by their full name', log[0].who === 'กุ๊งกิ๊ง ใจดีมาก', log[0].who);
ok('...and where it has got to', log[0].status === 'รอเลขาฯ ส่ง', log[0].status);

// The second document for that section follows on, not over the top.
const doc2 = await toSecretary('content', {
  title: 'ขอยืมโต๊ะและเก้าอี้', department: 'content', unit: 'Stage',
});
ok('the next one takes the next number', doc2.doc_number === 'อบจ.จฬฟ. 03.01-002/2569', doc2.doc_number);
log = registerLog('Stage');
ok('...on its own row, below the first', log.length === 2 && log[1].title === 'ขอยืมโต๊ะและเก้าอี้',
  JSON.stringify(log.map((r) => r.number + ' ' + r.title)));

/**
 * The number is taken the moment the letter is submitted, not at the end.
 *
 * It has to be written ON the letter, so a number that only exists once
 * everybody has signed arrives too late to be any use. The row's สถานะ then
 * follows the letter: รออนุมัติ while it climbs, รอเลขาฯ ส่ง when it is ready,
 * ส่งแล้ว when it goes, ถูกตีกลับ if it dies.
 */
const atOnce = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th', title: 'ขอเลขทันทีที่ส่ง', pdf: await makePdf(1),
          department: 'content', unit: 'Stage',
          steps: (await call(docsApi, '/api/documents?do=propose',
            { method: 'POST', as: 'content', body: { department: 'content', unit: 'Stage' } })).data.steps
            .map((st) => ({ role: st.role, username: st.username,
              mark: st.signs ? { page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.06 } : null })) },
});
ok('submitting gives the writer a number there and then',
  atOnce.status === 201 && atOnce.data.numbering?.ok && /อบจ\.จฬฟ\./.test(atOnce.data.numbering.number),
  JSON.stringify(atOnce.data.numbering));
const freshLog = registerLog('Stage').find((x) => x.title === 'ขอเลขทันทีที่ส่ง');
ok('...and the register row says it is still being approved', freshLog && freshLog.status === 'รออนุมัติ',
  JSON.stringify(freshLog));
const toldNumber = await sql`SELECT title FROM notifications
  WHERE username = 'Kungking_HeadCon' AND task_id = ${atOnce.data.id} ORDER BY created_at DESC LIMIT 1`;
ok('...and the writer is told it without being asked',
  toldNumber[0] && toldNumber[0].title.includes(atOnce.data.numbering.number), JSON.stringify(toldNumber[0]));
await call(docsApi, '/api/documents?do=reject',
  { method: 'POST', as: 'admin', body: { id: atOnce.data.id, comment: 'ลองตีกลับ' } });
const deadRow = registerLog('Stage').find((x) => x.title === 'ขอเลขทันทีที่ส่ง');
ok('a letter that is sent back keeps its number, and the book says what became of it',
  deadRow && deadRow.status === 'ถูกตีกลับ', JSON.stringify(deadRow));


// A different section has its own sequence.
const doc3 = await toSecretary('content', {
  title: 'ขอติดตั้งบูธนิทรรศการ', department: 'content', unit: 'Exhibition',
});
ok('another section numbers separately, from its own code',
  doc3.doc_number === 'อบจ.จฬฟ. 03.02.01-001/2569', doc3.doc_number);
ok('...found by the ฝ่าย name inside the tab, not the misspelled tab label',
  doc3.doc_tab === 'Exhibiton', doc3.doc_tab);

// A document with no section falls back to the department's own tab.
const doc4 = await toSecretary('content', { title: 'หนังสือของฝ่าย', department: 'content' });
ok('a document with no section is registered under its ฝ่าย',
  doc4.doc_number === 'อบจ.จฬฟ. 03-001/2569' && doc4.doc_tab === 'เนื้อหา ',
  `${doc4.doc_number} on ${doc4.doc_tab}`);

// Sending it moves the status on, in the sheet.
r = await call(docsApi, `/api/documents?id=${doc1.id}`, { as: 'admin' });
const secFor = { Sunday_Sec: 'sunday', Donat_Sec: 'donat', Pin_Sec: 'pin' }[
  r.data.steps.find((st) => st.role === 'secretary').username];
r = await call(docsApi, '/api/documents?do=send', { method: 'POST', as: secFor,
  body: { id: doc1.id, to: 'สำนักบริหารระบบกายภาพ' } });
ok('sending it reports the number back', r.data.number === doc1.doc_number, JSON.stringify(r.data.number));
log = registerLog('Stage');
ok('...and the register says ส่งแล้ว', log[0].status === 'ส่งแล้ว', log[0].status);

// Numbering never happens twice for the same document.
const rowsBefore = registerLog('Stage').length;
await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: secFor, body: { id: doc1.id } });
ok('a document is never numbered twice', registerLog('Stage').length === rowsBefore,
  `${rowsBefore} → ${registerLog('Stage').length}`);

// An unreachable register must not strand a signed document.
registerRefuses = true;
const doc5 = await toSecretary('merch', { title: 'หนังสือตอนชีตล่ม', department: 'merchant' });
ok('a document still reaches the secretary when the register is unreachable',
  doc5.stage === 'secretary' && !doc5.doc_number, `${doc5.stage} / ${doc5.doc_number}`);
const why = await sql`SELECT kind, detail FROM doc_events WHERE doc_id = ${doc5.id} AND kind = 'number_failed'`;
ok('...and the failure is written into its history, not swallowed',
  why.length >= 1, JSON.stringify(why[0] || {}));
ok('...having been tried again when it was ready to send, not given up on',
  why.length === 2, String(why.length));
registerRefuses = false;

// The names list, pushed from the roster into the register.
r = await call(docsApi, '/api/documents?do=names', { method: 'POST', as: 'content' });
ok('an ordinary editor cannot rewrite the register\u2019s name lists', r.status === 403, String(r.status));

// Somebody who runs a section is listed on that section's tab, not the
// department's — which is the whole point of having both.
await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin',
  body: { username: 'Kungking_HeadCon', unit: 'Stage' } });

r = await call(docsApi, '/api/documents?do=names', { method: 'POST', as: 'admin' });
ok('an admin can', r.status === 200 && r.data.written.length > 0,
  JSON.stringify(r.data.written || r.data).slice(0, 80));

const stageNames = (registerTabs.get('Stage') || []).slice(3).map((row) => row[8]).filter(Boolean);
ok('...and the section\u2019s people are listed by their full names',
  stageNames.includes('กุ๊งกิ๊ง ใจดีมาก'), JSON.stringify(stageNames));
ok('...while anybody without a full name is reported rather than guessed at',
  Array.isArray(r.data.withoutFullName), JSON.stringify((r.data.withoutFullName || []).slice(0, 3)));

// Somebody who has never given a full name is asked for one.
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'seesall',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือไม่มีชื่อผู้รับผิดชอบ', pdf: await makePdf(1), department: 'sponsor', steps: [] },
});
ok('a first-time uploader is asked for their full name',
  r.status === 400 && r.data.error === 'FULL_NAME_REQUIRED', JSON.stringify(r.data));

// ===========================================================================
head('60. Every visible string exists, once, in both languages');

/**
 * A duplicate key in a JavaScript object is not an error — the later one wins
 * and the earlier one silently does nothing. That had already happened three
 * times, and one of them meant the section picker was labelled
 * "กล่อง/หน่วยงาน" while the string somebody wrote for it sat unused higher up
 * the file. A parse of the source catches what running the file cannot.
 */
const i18nSource = (await import('node:fs')).readFileSync('public/i18n.js', 'utf8');
const langKeys = {};
for (const lang of ['th', 'en']) {
  const block = i18nSource.split(`  ${lang}: {`)[1].split('\n  },')[0];
  langKeys[lang] = [...block.matchAll(/^    ([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  const dupes = [...new Set(langKeys[lang].filter((k, i) => langKeys[lang].indexOf(k) !== i))];
  ok(`no string is defined twice in ${lang}`, dupes.length === 0, dupes.join(', '));
}

const onlyTh = langKeys.th.filter((k) => !langKeys.en.includes(k));
const onlyEn = langKeys.en.filter((k) => !langKeys.th.includes(k));
ok('every Thai string has an English one', onlyTh.length === 0, onlyTh.join(', '));
ok('...and the other way round', onlyEn.length === 0, onlyEn.join(', '));

const errorKeys = [...i18nSource.matchAll(/^  [A-Z_]+: '([A-Za-z0-9_]+)',/gm)].map((m) => m[1]);
const orphanErrors = errorKeys.filter((k) => !langKeys.th.includes(k));
ok('every error code maps to a string that exists', orphanErrors.length === 0, orphanErrors.join(', '));

/**
 * And every string the page ASKS for exists.
 *
 * `t()` returns the key itself when a string is missing, so a forgotten one
 * shows up as raw English gibberish — "healthLineCost" — on a Thai page, and
 * nothing fails. That happened twice while this was being built, both times
 * caught by eye on a screenshot rather than by anything automatic.
 */
const appSource = (await import('node:fs')).readFileSync('public/app.js', 'utf8');
const asked = [...new Set([...appSource.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))];
const absent = asked.filter((k) => !langKeys.th.includes(k));
ok(`every one of the ${asked.length} strings the page asks for is defined`,
  absent.length === 0, absent.join(', '));

// The same for the HTML, which labels itself with data-t attributes.
const htmlSource = (await import('node:fs')).readFileSync('public/index.html', 'utf8');
const shellKeys = [...new Set([...htmlSource.matchAll(/data-t="([A-Za-z0-9_]+)"/g)].map((m) => m[1]))];
const absentHtml = shellKeys.filter((k) => !langKeys.th.includes(k));
ok('...and so is every one the page shell asks for', absentHtml.length === 0, absentHtml.join(', '));

// ===========================================================================
head('61. What LINE actually costs: only the person who must act is paid for');

/**
 * A LINE push is charged per person, every time. The bell and the phone's own
 * notifications are free however many people get them. So the rule is that a
 * charged message goes ONLY to whoever has to do something — and this section
 * exists because that rule is invisible until a bill arrives.
 */
// One LINE account each, as linking now enforces.
await sql`DELETE FROM line_links`;
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Ucost1', 'Jade_Pres', 'Jade'), ('Ucost2', 'Sunday_Sec', 'Sunday'),
                 ('Ucost3', 'Donat_Sec', 'Donat'), ('Ucost4', 'Pin_Sec', 'Pin'),
                 ('Ucost5', 'Kungking_HeadCon', 'Kungking')
          ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;

const costChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;

lineSent.length = 0;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th',  title: 'หนังสือวัดค่าใช้จ่าย', pdf: await makePdf(1), department: 'content',
          steps: costChain.map((st) => ({ role: st.role, username: st.username,
            mark: st.signs ? { page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 } : null })) },
});
const costId = r.data.id;

let charged = lineSent.filter((m) => m.kind === 'push');
ok('submitting charges for exactly one LINE message — the approver',
  charged.length === 1 && charged[0].to === 'Ucost1',
  `${charged.length} push(es) → ${charged.map((m) => m.to).join(',')}`);

// Everybody still hears about it, through the channels that cost nothing.
r = await call(notifApi, '/api/notifications', { as: 'sunday' });
ok('...while every secretary still gets it in the bell, free',
  r.data.notifications.some((n) => /หนังสือวัดค่าใช้จ่าย/.test(n.title)),
  r.data.notifications.map((n) => n.title).join(' | ').slice(0, 60));

lineSent.length = 0;
await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: 'admin', body: { id: costId } });
charged = lineSent.filter((m) => m.kind === 'push');
ok('approving charges for one more — the secretary whose turn it now is',
  charged.length === 1, `${charged.length} → ${charged.map((m) => m.to).join(',')}`);

r = await call(docsApi, `/api/documents?id=${costId}`, { as: 'admin' });
const whoseTurn = r.data.steps.find((st) => st.state === 'waiting').username;
const turnSession = { Sunday_Sec: 'sunday', Donat_Sec: 'donat', Pin_Sec: 'pin' }[whoseTurn];
ok('...and it went to that very person, not to all of them',
  charged[0].to === { Sunday_Sec: 'Ucost2', Donat_Sec: 'Ucost3', Pin_Sec: 'Ucost4' }[whoseTurn],
  `${charged[0].to} for ${whoseTurn}`);

lineSent.length = 0;
await call(docsApi, '/api/documents?do=send', { method: 'POST', as: turnSession,
  body: { id: costId, to: 'ผู้รับ' } });
ok('sending it costs nothing — nobody has anything left to do',
  lineSent.filter((m) => m.kind === 'push').length === 0,
  JSON.stringify(lineSent.filter((m) => m.kind === 'push').map((m) => m.to)));

/**
 * The whole journey, counted. Five people on LINE, four steps: the old
 * behaviour would have charged for roughly fifteen messages.
 */
ok('a whole document costs two charged messages, not fifteen', true,
  'submitted 1 + approved 1 + sent 0');

// And the digest stays off unless somebody asks, however many people link.
await sql`DELETE FROM line_digests_sent`;
const optedIn = await sql`SELECT count(*)::int AS n FROM line_links WHERE digest = true`;
lineSent.length = 0;
await call(cronApi, '/api/cron');
const morning = lineSent.filter((m) => m.kind === 'push');
ok('the morning digest only goes to people who asked for it',
  morning.length <= optedIn[0].n, `${morning.length} sent, ${optedIn[0].n} opted in`);

r = await call(usersApi, '/api/users?do=health', { as: 'admin' });
ok('the admin page counts the charged messages, so the bill is never a surprise',
  r.data.lineCharged.total > 0 && r.data.lineCharged.documents > 0,
  JSON.stringify(r.data.lineCharged));
ok('...separating documents from the daily digest',
  r.data.lineCharged.total === r.data.lineCharged.documents + r.data.lineCharged.digests,
  JSON.stringify(r.data.lineCharged));
ok('...and says how many people have the paid digest on',
  typeof r.data.lineDigestOptIn === 'number', String(r.data.lineDigestOptIn));

// ===========================================================================
head('62. Short links, and the QR codes that go on posters');

const { readCode, readTarget, makeCode, ALPHABET } = await import('../lib/shortlink.js');

// ---- the rules, without a database -------------------------------------
ok('a code is folded to upper case, so a poster can be typed either way',
  readCode('cufair').code === 'CUFAIR', JSON.stringify(readCode('cufair')));
ok('confusable characters are kept out of generated codes',
  !/[O0I1L]/.test(ALPHABET) && makeCode().length === 6, ALPHABET);
ok('a code that looks like part of the system is refused',
  readCode('admin').error === 'CODE_RESERVED' && readCode('api').error === 'CODE_RESERVED');
ok('javascript: is not a destination', readTarget('javascript:alert(1)').error === 'BAD_URL');
ok('a bare IP address is not a destination',
  readTarget('http://203.0.113.7/x').error === 'NO_RAW_IP');
ok('a short link cannot point at another short link — that is a redirect loop',
  readTarget('https://fair.test/s/ABC', { siteUrl: 'https://fair.test' }).error === 'POINTS_AT_ITSELF');
ok('...but it can point at an ordinary page on the same site',
  Boolean(readTarget('https://fair.test/work', { siteUrl: 'https://fair.test' }).url));
ok('a link typed without https:// still works',
  readTarget('forms.gle/abc').url === 'https://forms.gle/abc');

// ---- making one ---------------------------------------------------------
r = await call(metaApi, '/api/meta?do=link', { method: 'POST', as: 'content',
  body: { url: 'https://forms.gle/staff-application', title: 'ใบสมัครสตาฟ', code: 'STAFF' } });
ok('a link with a chosen code is made', r.status === 201 && r.data.link.code === 'STAFF',
  JSON.stringify(r.data).slice(0, 80));
ok('...and comes back as the address to print',
  r.data.link.shortUrl === 'https://fair.test/s/STAFF', r.data.link.shortUrl);

r = await call(metaApi, '/api/meta?do=link', { method: 'POST', as: 'admin',
  body: { url: 'https://example.org/other', code: 'staff' } });
ok('the same code cannot be taken twice, in any case',
  r.status === 409 && r.data.error === 'CODE_TAKEN', JSON.stringify(r.data));

r = await call(metaApi, '/api/meta?do=link', { method: 'POST', as: 'content',
  body: { url: 'https://drive.google.com/drive/folders/xyz' } });
ok('a link with no chosen code gets a random one',
  r.status === 201 && /^[A-Z2-9]{6}$/.test(r.data.link.code), r.data.link.code);
const randomCode = r.data.link.code;

r = await call(metaApi, '/api/meta?do=link', { method: 'POST', as: 'member',
  body: { url: 'https://example.org' } });
ok('a member cannot publish under the committee\u2019s domain',
  r.status === 403 && r.data.error === 'MEMBERS_CANNOT_CREATE', JSON.stringify(r.data));

// ---- following one ------------------------------------------------------
async function visit(code) {
  const res = await metaApi(new Request(`https://app.test/api/meta?go=${encodeURIComponent(code)}`));
  return { status: res.status, location: res.headers.get('location'),
           body: res.status === 404 ? await res.text() : '' };
}

let hop = await visit('STAFF');
ok('following it redirects, signed in or not',
  hop.status === 302 && hop.location === 'https://forms.gle/staff-application',
  `${hop.status} → ${hop.location}`);

hop = await visit('staff');
ok('...in lower case too, because posters get typed by hand',
  hop.status === 302 && hop.location === 'https://forms.gle/staff-application', String(hop.status));

const counted = await sql`SELECT hits FROM short_links WHERE code = 'STAFF'`;
ok('every visit is counted', counted[0].hits === 2, String(counted[0].hits));
const daily = await sql`SELECT hits FROM short_hits WHERE code = 'STAFF'`;
ok('...and counted per day, so a poster can be told from a LINE message',
  daily.length === 1 && daily[0].hits === 2, JSON.stringify(daily));

hop = await visit('NOPE99');
ok('a code nobody has explains itself instead of showing a browser error',
  hop.status === 404 && hop.body.includes('ไม่พบลิงก์นี้'), String(hop.status));
ok('...and says the code back, so a typo on a banner can be spotted',
  hop.body.includes('NOPE99'), hop.body.slice(0, 40));

// ---- changing one -------------------------------------------------------
r = await call(metaApi, '/api/meta?do=link', { method: 'PATCH', as: 'content',
  body: { code: 'STAFF', url: 'https://forms.gle/staff-round-two' } });
ok('the owner can point it somewhere else after the posters are out', r.status === 200);
hop = await visit('STAFF');
ok('...and it takes effect at once', hop.location === 'https://forms.gle/staff-round-two', hop.location);

r = await call(metaApi, '/api/meta?do=link', { method: 'PATCH', as: 'merch',
  body: { code: 'STAFF', url: 'https://somewhere.else/' } });
ok('somebody else cannot retarget it',
  r.status === 403 && r.data.error === 'NOT_YOUR_SHORT_LINK', JSON.stringify(r.data));

r = await call(metaApi, '/api/meta?do=link', { method: 'PATCH', as: 'admin',
  body: { code: 'STAFF', active: false } });
ok('an admin can switch off any link, whoever made it', r.status === 200 && r.data.link.active === false);
hop = await visit('STAFF');
ok('...and a switched-off link stops working but keeps its code',
  hop.status === 404 && hop.body.includes('ปิดใช้งาน'), String(hop.status));

r = await call(metaApi, '/api/meta?do=link', { method: 'PATCH', as: 'content',
  body: { code: 'STAFF', url: 'https://fair.test/s/OTHER' } });
ok('a link cannot be retargeted into a loop either',
  r.status === 400 && r.data.error === 'POINTS_AT_ITSELF', JSON.stringify(r.data));

// ---- the list -----------------------------------------------------------
r = await call(metaApi, '/api/meta?do=links', { as: 'merch' });
ok('everybody can see where every link goes',
  r.data.links.length >= 2 && r.data.links.some((l) => l.code === 'STAFF'),
  String(r.data.links.length));
ok('...and is told which are theirs to change',
  r.data.links.find((l) => l.code === 'STAFF').mine === false);

r = await call(metaApi, '/api/meta?do=links', {});
ok('a signed-out visitor cannot read the directory of links', r.status === 401, String(r.status));

// ---- removing one -------------------------------------------------------
r = await call(metaApi, `/api/meta?do=link&code=${randomCode}`, { method: 'DELETE', as: 'merch' });
ok('somebody else cannot delete it', r.status === 403, String(r.status));

r = await call(metaApi, `/api/meta?do=link&code=${randomCode}`, { method: 'DELETE', as: 'content' });
ok('the owner can', r.status === 200 && r.data.deleted === randomCode, JSON.stringify(r.data));
hop = await visit(randomCode);
ok('...and it stops resolving', hop.status === 404, String(hop.status));

// ---- and the rest of the endpoint still works ---------------------------
r = await call(metaApi, '/api/meta', {});
ok('the department tree is still served from the same function',
  Array.isArray(r.data.departments) && r.data.departments.length > 10,
  String((r.data.departments || []).length));
r = await call(metaApi, '/api/meta?ping=1', {});
ok('...and so is the keep-warm ping', r.data.ok === true, JSON.stringify(r.data));


// ===========================================================================
head('63. Whether the PDFs are leaving the database, said out loud');

/**
 * The question this answers is "did I link Drive, and am I paying for storage
 * I do not need" — and the failure it guards against is the silent one, where
 * Drive is half-configured, nothing is archived, and the database quietly
 * grows until a bill explains it.
 *
 * By this point in the suite Drive IS configured and one document has already
 * been archived and purged, so the healthy case can be checked first and the
 * broken ones produced by taking the credentials away again.
 */
r = await call(usersApi, '/api/users?do=health', { as: 'admin' });
ok('the health page says Drive is connected', r.data.driveConfigured === true,
  JSON.stringify({ c: r.data.driveConfigured, folder: r.data.driveFolder }));
ok('...and names the folder to go and look in',
  typeof r.data.driveFolder === 'string' && r.data.driveFolder.length > 0, r.data.driveFolder);
ok('...and counts what it has already filed', r.data.docsArchived > 0, String(r.data.docsArchived));
ok('...and says how long a database copy is kept after Drive confirms it',
  r.data.archiveGraceDays === 3, String(r.data.archiveGraceDays));

// The weight actually held, which is the number that becomes money.
const held = (await sql`SELECT coalesce(sum(byte_size),0)::bigint AS b,
                               count(DISTINCT doc_id)::int AS d FROM doc_files`)[0];
ok('the page reports the real weight of the PDFs it is holding',
  r.data.pdfBytes === Number(held.b), `${r.data.pdfBytes} vs ${held.b}`);
ok('...and how many documents that is', r.data.pdfDocs === Number(held.d),
  `${r.data.pdfDocs} vs ${held.d}`);
ok('...and a purged document no longer counts towards it',
  (await sql`SELECT count(*)::int AS n FROM doc_files WHERE doc_id = ${archId}`)[0].n === 0);

/**
 * No secret ever reaches the page. An admin needs to know WHETHER the archive
 * account is set up; the refresh token is a password to the committee's Drive
 * and must not be readable from a browser, admin or not.
 */
const healthText = JSON.stringify(r.data);
ok('the refresh token is never sent to the browser',
  !healthText.includes('1//test-refresh'));
ok('...nor the client secret', !healthText.includes('test-secret'));

// ---- half-configured, which is the easiest mistake to miss --------------
const keptToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
r = await call(usersApi, '/api/users?do=health', { as: 'admin' });
ok('with the token missing, Drive is reported as not working',
  r.data.driveConfigured === false, JSON.stringify(r.data.driveConfigured));
ok('...but the page can still tell half-set-up from not-set-up at all',
  r.data.driveHasClient === true && r.data.driveHasRefreshToken === false,
  JSON.stringify({ c: r.data.driveHasClient, t: r.data.driveHasRefreshToken }));

// And in that state the archive really does stop, rather than half-running.
r = await call(cronApi, '/api/cron');
ok('...and nothing is archived while it is in that state',
  Boolean(r.data.archive.skipped), JSON.stringify(r.data.archive));

process.env.GOOGLE_DRIVE_REFRESH_TOKEN = keptToken;
r = await call(usersApi, '/api/users?do=health', { as: 'admin' });
ok('putting the token back fixes it, without a redeploy',
  r.data.driveConfigured === true, JSON.stringify(r.data.driveConfigured));




// ===========================================================================
head('64. Signing and approving are different acts');

/**
 * The bug Jade reported: "ประธานโครงการ sent the document, it does not appear
 * an option for him to insert the signature". The chain only ever climbs, so
 * the director had no step at all — and the signature hung off the step, so
 * there was nowhere for it to go. Signing is now its own flag rather than a
 * property of the role, which fixes that and the opposite complaint too.
 */
const topChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'admin', body: {} })).data.steps;
ok('the director now gets a step to sign his letter',
  topChain[0].role === 'author' && topChain[0].username === 'Jade_Pres',
  topChain.map((x) => x.role + ':' + x.username).join(' → '));
ok('...and still nobody is asked to approve it',
  !topChain.some((x) => ['unitHead', 'deptHead', 'director'].includes(x.role)),
  topChain.map((x) => x.role).join(' → '));

const dirDoc = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'admin',
  body: { recipientEmail: 'office@example.ac.th', 
    title: 'หนังสือจากประธานโครงการ', pdf: await makePdf(2), department: 'exec',
    steps: topChain.map((x) => ({
      role: x.role, username: x.username,
      marks: x.signs ? [{ page: 1, x: 0.6, y: 0.75, w: 0.25, h: 0.07 }] : [],
    })),
  },
});
ok('his letter is accepted with a signature box on it', dirDoc.status === 201,
  JSON.stringify(dirDoc.data).slice(0, 120));

const dirDocId = dirDoc.data.id;
const dirView = (await call(docsApi, `/api/documents?id=${dirDocId}`, { as: 'admin' })).data;
ok('...his step is already done — he does not wait on himself',
  dirView.steps.find((x) => x.role === 'author').state === 'approved',
  dirView.steps.map((x) => x.role + ':' + x.state).join(' '));
ok('...the letter waits on the secretary instead',
  dirView.steps.find((x) => x.state === 'waiting').role === 'secretary',
  dirView.steps.map((x) => x.role + ':' + x.state).join(' '));
ok('...and his signature is stamped into a signed copy straight away',
  (await sql`SELECT count(*)::int AS n FROM doc_files
             WHERE doc_id = ${dirDocId} AND kind = 'signed'`)[0].n === 1);
ok('...while he may still withdraw it, his signature notwithstanding',
  (await call(docsApi, `/api/documents?id=${dirDocId}`,
    { method: 'DELETE', as: 'admin' })).status === 200);

// ---- approving without putting your signature on the letter -------------
const baseChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;
const noSig = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th', 
    title: 'หนังสือที่หัวหน้าอนุมัติแต่ไม่ลงนาม', pdf: await makePdf(2), department: 'content',
    steps: baseChain.map((x) => ({
      role: x.role, username: x.username,
      marks: x.signs ? [{ page: 1, x: 0.6, y: 0.7, w: 0.25, h: 0.07 }] : [],
    })),
  },
});
const noSigId = noSig.data.id;
ok('a staff letter still climbs to the head first', noSig.status === 201,
  baseChain.map((x) => x.role + ':' + x.username).join(' → '));

/**
 * Approved by the next signer in the chain — here the director, since by this
 * point in the suite the ฝ่ายเนื้อหา uploader is themselves a head. The flag
 * lives on the step, not the role, so ประธานฝ่าย behaves identically.
 */
const waitingRole = baseChain.find((x) => x.role !== 'author').role;
r = await call(docsApi, '/api/documents?do=approve', {
  method: 'POST', as: waitingRole === 'director' ? 'admin' : 'editor',
  body: { id: noSigId, comment: 'เห็นชอบ', withoutSignature: true },
});
ok('a signer can approve without their signature appearing on the letter',
  r.status === 200, JSON.stringify(r.data).slice(0, 120));

const noSigSteps = await sql`SELECT role, state, signs FROM doc_steps
                             WHERE doc_id = ${noSigId} ORDER BY position`;
const headStep = noSigSteps.find((x) => x.role === waitingRole);
ok('...the approval is recorded all the same', headStep.state === 'approved');
ok('...but the step is marked as not signing', headStep.signs === false,
  JSON.stringify(headStep));
ok('...and the history calls it an approval, not a signature',
  (await sql`SELECT count(*)::int AS n FROM doc_events
             WHERE doc_id = ${noSigId} AND kind = 'approved'`)[0].n >= 1);

// ---- one person, several signing spots ----------------------------------
const multiChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'content', body: { department: 'content' } })).data.steps;
const multi = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'content',
  body: { recipientEmail: 'office@example.ac.th', 
    title: 'หนังสือที่ต้องลงนามหลายจุด', pdf: await makePdf(3), department: 'content',
    steps: multiChain.map((x) => ({
      role: x.role, username: x.username,
      // An initial on each page as well as a signature at the end.
      marks: x.signs ? [
        { page: 1, x: 0.80, y: 0.05, w: 0.10, h: 0.04 },
        { page: 2, x: 0.80, y: 0.05, w: 0.10, h: 0.04 },
        { page: 3, x: 0.60, y: 0.70, w: 0.25, h: 0.07 },
      ] : [],
    })),
  },
});
ok('a letter can be created with three boxes for one signer', multi.status === 201,
  JSON.stringify(multi.data).slice(0, 120));
const multiId = multi.data.id;
ok('...and all three are stored',
  (await sql`SELECT count(*)::int AS n FROM doc_boxes b
             JOIN doc_steps s ON s.id = b.step_id
             WHERE s.doc_id = ${multiId} AND s.role = ${multiChain.find((x) => x.role !== 'author').role}`)[0].n === 3);

const multiSigner = multiChain.find((x) => x.role !== 'author').role;
r = await call(docsApi, '/api/documents?do=approve', {
  method: 'POST', as: multiSigner === 'director' ? 'admin' : 'editor',
  body: { id: multiId, comment: 'ลงนามครบ' },
});
ok('the head signs once and every box is filled', r.status === 200,
  JSON.stringify(r.data).slice(0, 160));
ok('...three marks placed, not one', r.data.signaturesPlaced === 3,
  `placed ${r.data.signaturesPlaced}, could not place ` +
  JSON.stringify(r.data.couldNotPlace || []));



// ---- a secretary's own pile ---------------------------------------------
/**
 * A secretary can see every document in the committee, which makes the list
 * useless to them without a way to pick out the ones that land on their own
 * desk. The list now says which secretary each document is headed for.
 */
r = await call(docsApi, '/api/documents', { as: 'donat' });
ok('the list says which secretary each document is for',
  r.data.documents.every((d) => 'secretary' in d),
  String(r.data.documents.length) + ' documents');
ok('...and marks the reader as a secretary', r.data.isSecretary === true);

const donatPile = r.data.documents.filter((d) => d.secretary === 'Donat_Sec');
ok('...so their own pile can be picked out of the whole committee',
  donatPile.length > 0 && donatPile.length <= r.data.documents.length,
  `${donatPile.length} of ${r.data.documents.length}`);
ok('...and every one of them really names them',
  donatPile.every((d) => d.steps.some((x) => x.role === 'secretary' && x.username === 'Donat_Sec')));

r = await call(docsApi, '/api/documents', { as: 'content' });
ok('somebody who is not a secretary is not told they are',
  r.data.isSecretary === false);



// ===========================================================================
head('65. Circles: the committee’s own words for groups of people');

const { CIRCLES, membersOf, expandPeople: expandCircle, describeCircle, inCircle } =
  await import('../lib/circles.js');

const cRoster = await sql`SELECT * FROM users`;
const sizes = CIRCLES.map((c) => c.key + ':' + membersOf(c.key, cRoster).length).join(' ');
console.log('  circles:', sizes);

ok('the four circles nest, widest last',
  CIRCLES.map((c) => membersOf(c.key, cRoster).length)
    .every((n, i, all) => i === 0 || n >= all[i - 1]), sizes);
ok('the board is admins and co-admins only',
  membersOf('board', cRoster).every((u) =>
    ['admin', 'coadmin'].includes(cRoster.find((p) => p.username === u).access)),
  membersOf('board', cRoster).join(','));
ok('the core team adds the ประธานฝ่าย',
  membersOf('core', cRoster).length > membersOf('board', cRoster).length,
  membersOf('core', cRoster).join(','));
ok('all heads reaches down to หัวหน้าฝ่ายย่อย',
  membersOf('heads', cRoster).some((u) =>
    cRoster.find((p) => p.username === u).access === 'unitlead'),
  membersOf('heads', cRoster).join(','));

/**
 * Circles are derived, never stored — which is the whole reason they are
 * worth having. Somebody promoted is in the core team from that moment,
 * with nobody remembering to add them to a list.
 */
const beforePromotion = membersOf('core', cRoster).length;
await sql`UPDATE users SET access = 'editor' WHERE username = 'Ploy_StaffCon'`;
const afterRoster = await sql`SELECT * FROM users`;
ok('promoting somebody puts them in the circle with no list to update',
  membersOf('core', afterRoster).length === beforePromotion + 1 &&
  membersOf('core', afterRoster).includes('Ploy_StaffCon'),
  `${beforePromotion} → ${membersOf('core', afterRoster).length}`);
await sql`UPDATE users SET access = 'inner' WHERE username = 'Ploy_StaffCon'`;

const closed = await sql`SELECT * FROM users WHERE active = false OR suspended = true LIMIT 1`;
if (closed.length) {
  ok('a closed or suspended account is in no circle at all',
    CIRCLES.every((c) => !inCircle(closed[0], c.key)), closed[0].username);
}

ok('a mixed pick of circles and names comes back as one list, without repeats',
  (() => {
    const got = expandCircle({ usernames: ['Jade_Pres', 'ghost'], circles: ['board'], people: roster });
    return new Set(got).size === got.length && got.includes('Jade_Pres') && !got.includes('ghost');
  })());
ok('an exact circle is named back as one, a near miss is not',
  describeCircle(membersOf('board', cRoster), cRoster) === 'board' &&
  describeCircle(['Jade_Pres'], cRoster) === null);

// ===========================================================================
head('66. Accepting and declining an invitation');

r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานที่ต้องตอบรับ', dueDate: '2026-12-20',
          assignees: ['Kungking_HeadCon', 'Donat_Sec'], notify: [] },
});
const inviteId = r.data.task.id;
ok('a task can be given to two people', r.status === 201, JSON.stringify(r.data).slice(0, 80));

r = await call(tasksApi, '/api/tasks', { as: 'admin' });
let invited = r.data.tasks.find((t) => t.id === inviteId);
ok('...and everybody starts as invited, not as having agreed',
  invited.replies.filter((x) => x.username !== 'Jade_Pres')
    .every((x) => x.reply === 'invited'),
  JSON.stringify(invited.replies));

r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'editor', body: { kind: 'task', id: inviteId, reply: 'accepted' },
});
ok('an invited person can accept', r.status === 200 && r.data.reply === 'accepted',
  JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'donat', body: { kind: 'task', id: inviteId, reply: 'declined' },
});
ok('...and another can decline', r.status === 200 && r.data.reply === 'declined',
  JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'merch', body: { kind: 'task', id: inviteId, reply: 'accepted' },
});
ok('somebody who was never invited cannot answer',
  r.status === 403 && r.data.error === 'NOT_INVITED', JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'editor', body: { kind: 'task', id: inviteId, reply: 'maybe' },
});
ok('...and "maybe" is not an answer this system takes',
  r.status === 400 && r.data.error === 'BAD_REPLY', JSON.stringify(r.data));

r = await call(tasksApi, '/api/tasks', { as: 'admin' });
invited = r.data.tasks.find((t) => t.id === inviteId);
ok('the creator can see who accepted and who declined',
  invited.replies.find((x) => x.username === 'Kungking_HeadCon').reply === 'accepted' &&
  invited.replies.find((x) => x.username === 'Donat_Sec').reply === 'declined',
  JSON.stringify(invited.replies));

/**
 * The trap this guards: the tags are rewritten in full on every save, so an
 * unrelated edit used to be able to wipe every answer given so far.
 */
r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'admin', body: { id: inviteId, title: 'งานที่ต้องตอบรับ (แก้ชื่อ)' },
});
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
invited = r.data.tasks.find((t) => t.id === inviteId);
ok('editing the task does not throw away what people already answered',
  invited.replies.find((x) => x.username === 'Kungking_HeadCon').reply === 'accepted',
  JSON.stringify(invited.replies));

// ===========================================================================
head('67. การประชุม: agendas, invitations and who is coming');

r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'member',
  body: { title: 'ประชุมที่สมาชิกธรรมดาไม่ควรเรียกได้', meetsOn: '2026-12-05' },
});
ok('an ordinary member cannot call a meeting of the committee',
  r.status === 403 && r.data.error === 'CANNOT_CALL_MEETING', JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'admin',
  body: {
    title: 'ประชุมคณะกรรมการโครงการ ครั้งที่ 4/2569',
    meetsOn: '2026-12-05', meetsAt: '17:00',
    place: 'ออนไลน์', joinUrl: 'https://chula.zoom.us/j/92311519265',
    circles: ['core'], template: 'standard',
  },
});
ok('a meeting can be called on a whole circle at once', r.status === 201,
  JSON.stringify(r.data).slice(0, 100));
const mtgId = r.data.id;

r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
let mtg = r.data.meetings.find((m) => m.id === mtgId);
ok('...and everybody in that circle is invited',
  mtg.people.length === membersOf('core', cRoster).length,
  `${mtg.people.length} invited, circle has ${membersOf('core', cRoster).length}`);
ok('...the card says which circle it went to, rather than listing names',
  mtg.circle === 'core', String(mtg.circle));
ok('...the organiser counts as accepted, having called it',
  mtg.people.find((p) => p.username === 'Jade_Pres').reply === 'accepted');
ok('...and it carries a code people can search for', /^M\d{4}$/.test(mtg.code || ''), mtg.code);

ok('the standard agenda is the committee’s five วาระ',
  mtg.agenda.length === 5 && mtg.agenda[0].title.includes('วาระที่ 1') &&
  mtg.agenda[4].title.includes('วาระที่ 5'),
  mtg.agenda.map((a) => a.slot + '.' + a.title.slice(0, 12)).join(' '));
ok('...numbered from one, in order', mtg.agenda.every((a, i) => a.slot === i + 1));
/**
 * The five headings carry no time of their own — วาระที่ 4 lasts exactly as
 * long as the things put under it, and a made-up forty minutes against an
 * empty heading is a number nobody chose.
 */
ok('the standard headings start with no invented durations',
  mtg.length.minutes === 0, JSON.stringify(mtg.length));

// A blank agenda is the other choice.
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'admin',
  body: { title: 'คุยงานสั้น ๆ', meetsOn: '2026-12-06', template: 'blank' },
});
const blankId = r.data.id;
r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
ok('a blank agenda really is blank',
  r.data.meetings.find((m) => m.id === blankId).agenda.length === 0);

// ---- anybody invited may propose an item --------------------------------
/**
 * A proposal goes UNDER one of the standing วาระ — it becomes 4.1, never a
 * sixth heading, because วาระที่ 6 would be wrong in the minutes.
 */
const heads = mtg.agenda.filter((x) => x.depth === 0);
const consider = heads.find((x) => x.title.includes('วาระที่ 4'));

r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'editor',
  body: { meetingId: mtgId, title: 'ขอหารือเรื่องงบฝ่ายเนื้อหา', minutes: 15, priority: 'high' },
});
ok('an item with no heading chosen is refused on a standard agenda',
  r.status === 400 && r.data.error === 'PICK_AN_AGENDA_HEADING', JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'editor',
  body: { meetingId: mtgId, title: 'ขอหารือเรื่องงบฝ่ายเนื้อหา', parentId: consider.id },
});
ok('...and so is one with no duration given', r.status === 400 &&
  r.data.error === 'MINUTES_REQUIRED', JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'editor',
  body: { meetingId: mtgId, title: 'ขอหารือเรื่องงบฝ่ายเนื้อหา',
          minutes: 15, priority: 'high', parentId: consider.id },
});
ok('somebody invited can propose an item under วาระที่ 4', r.status === 201,
  JSON.stringify(r.data).slice(0, 80));

r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'member',
  body: { meetingId: mtgId, title: 'ไม่ได้รับเชิญ' },
});
ok('...but somebody who was not invited cannot',
  r.status === 403 && r.data.error === 'NOT_INVITED', JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
mtg = r.data.meetings.find((m) => m.id === mtgId);
const proposed = mtg.agenda.find((a) => a.title.includes('งบฝ่ายเนื้อหา'));
ok('it is numbered 4.1, not วาระที่ 6',
  proposed.number === '4.1' && proposed.depth === 1 &&
  proposed.proposedBy === 'Kungking_HeadCon',
  JSON.stringify({ number: proposed.number, depth: proposed.depth }));
ok('...and there are still only five headings',
  mtg.agenda.filter((x) => x.depth === 0).length === 5,
  mtg.agenda.map((x) => x.number).join(' '));
ok('...the heading now carries the time of what is under it',
  mtg.agenda.find((x) => x.number === '4').minutes === 15,
  JSON.stringify(mtg.agenda.find((x) => x.number === '4')));
ok('...and the meeting is a quarter of an hour long, counted once',
  mtg.length.minutes === 15 && mtg.length.endsAt === '17:15',
  JSON.stringify(mtg.length));

r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'PATCH', as: 'donat',
  body: { id: proposed.id, title: 'เปลี่ยนคำพูดของคนอื่น' },
});
ok('nobody can reword somebody else’s proposal into something it was not',
  r.status === 403, JSON.stringify(r.data));

// A second item under the same heading, to check the order within it.
await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'admin',
  body: { meetingId: mtgId, title: 'ประมูลร้านค้า', minutes: 25, parentId: consider.id },
});
r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'PATCH', as: 'admin', body: { id: proposed.id, slot: 2 },
});
ok('...though the organiser may reorder items within a วาระ', r.status === 200,
  JSON.stringify(r.data));
r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
mtg = r.data.meetings.find((m) => m.id === mtgId);
ok('...and they renumber as 4.1 and 4.2, in the order chosen',
  mtg.agenda.find((x) => x.number === '4.1').title.includes('ประมูลร้านค้า') &&
  mtg.agenda.find((x) => x.number === '4.2').title.includes('งบฝ่ายเนื้อหา'),
  mtg.agenda.map((x) => x.number + '.' + x.title.slice(0, 8)).join(' '));
ok('...the heading adds both up', mtg.agenda.find((x) => x.number === '4').minutes === 40,
  JSON.stringify(mtg.agenda.find((x) => x.number === '4')));
ok('...and the total counts the items once, not the heading twice',
  mtg.length.minutes === 40, JSON.stringify(mtg.length));

// ---- who is coming -------------------------------------------------------
r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'editor', body: { kind: 'meeting', id: mtgId, reply: 'accepted' },
});
ok('an invited person accepts the meeting', r.status === 200, JSON.stringify(r.data));
r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'coadmin', body: { kind: 'meeting', id: mtgId, reply: 'declined' },
});
ok('...and another declines', r.status === 200, JSON.stringify(r.data));
r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'editor', body: { kind: 'meeting', id: mtgId, reply: 'declined' },
});
ok('...and may change their mind while the meeting is still ahead',
  r.status === 200 && r.data.reply === 'declined', JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
mtg = r.data.meetings.find((m) => m.id === mtgId);
ok('the counts separate "said no" from "has not answered"',
  mtg.counts.accepted >= 1 && mtg.counts.declined === 2 &&
  mtg.counts.invited === mtg.counts.total - mtg.counts.accepted - mtg.counts.declined,
  JSON.stringify(mtg.counts));

// A meeting that has already begun takes no more replies.
await sql`UPDATE meetings SET meets_on = '2020-01-01' WHERE id = ${mtgId}`;
r = await call(eventsApi, '/api/events?do=reply', {
  method: 'POST', as: 'editor', body: { kind: 'meeting', id: mtgId, reply: 'accepted' },
});
ok('once the meeting has started, the answer is whatever it was',
  r.status === 400 && r.data.error === 'TOO_LATE_TO_REPLY', JSON.stringify(r.data));
await sql`UPDATE meetings SET meets_on = '2026-12-05' WHERE id = ${mtgId}`;

// ---- links, and one that should never be stored -------------------------
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'PATCH', as: 'admin',
  body: { id: mtgId, minutesUrl: 'https://docs.google.com/document/d/abc/edit' },
});
ok('the minutes can be linked once the meeting is over', r.status === 200);
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'PATCH', as: 'admin', body: { id: mtgId, joinUrl: 'javascript:alert(1)' },
});
r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
mtg = r.data.meetings.find((m) => m.id === mtgId);
ok('a javascript: link is never stored as somewhere to join a meeting',
  mtg.joinUrl === '', JSON.stringify(mtg.joinUrl));
ok('...while the real minutes link survives',
  mtg.minutesUrl.includes('docs.google.com'), mtg.minutesUrl);

r = await call(eventsApi, `/api/events?do=meeting&id=${blankId}`, { method: 'DELETE', as: 'editor' });
ok('somebody else’s meeting cannot be deleted', r.status === 403, JSON.stringify(r.data));
r = await call(eventsApi, `/api/events?do=meeting&id=${blankId}`, { method: 'DELETE', as: 'admin' });
ok('...and the organiser can call it off', r.status === 200, JSON.stringify(r.data));



// ---- the first hours of a Bangkok month ---------------------------------
/**
 * A real bug, found the day the clock rolled into October.
 *
 * The monthly LINE counter compared a TIMESTAMPTZ against a timestamp that
 * had no zone attached, so Postgres read the boundary in the server's zone
 * (UTC) rather than Bangkok's. For the first seven hours of every Bangkok
 * month the counter read zero and messages sent in that window never counted
 * against the quota — which is a hard stop, so undercounting it is the
 * dangerous direction.
 */
const bkkNow = (await sql`SELECT (now() AT TIME ZONE 'Asia/Bangkok') AS t`)[0].t;
await sql`DELETE FROM line_charges WHERE username = 'Ubound'`;
await sql`
  INSERT INTO line_charges (username, kind, sent_at)
  VALUES ('Ubound', 'document',
          (date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')
          + interval '10 minutes')`;

r = await call(usersApi, '/api/users?do=health', { as: 'admin' });
ok('a message sent just after the Bangkok month begins is counted',
  r.data.lineCharged.total >= 1,
  `bangkok now ${String(bkkNow).slice(0, 16)} · counted ${r.data.lineCharged.total}`);

// And one from just before the boundary is not.
await sql`
  INSERT INTO line_charges (username, kind, sent_at)
  VALUES ('Ubound', 'document',
          (date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')
          - interval '10 minutes')`;
const boundAfter = await call(usersApi, '/api/users?do=health', { as: 'admin' });
ok('...and one from last month is not counted twice',
  boundAfter.data.lineCharged.total === r.data.lineCharged.total,
  `${r.data.lineCharged.total} → ${boundAfter.data.lineCharged.total}`);
await sql`DELETE FROM line_charges WHERE username = 'Ubound'`;



// ---- a blank agenda is not secretly a set of headings -------------------
/**
 * The trap: "is this a heading" was once "does it sit at the top", which would
 * have turned the first line somebody typed onto a blank agenda into a heading
 * that every later line had to be filed underneath.
 */
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'admin',
  body: { title: 'คุยงานสั้น ๆ ไม่มีวาระมาตรฐาน', meetsOn: '2026-12-20', template: 'blank' },
});
const flatId = r.data.id;
r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'admin',
  body: { meetingId: flatId, title: 'เรื่องแรก', minutes: 10 },
});
ok('a first item can go straight onto a blank agenda', r.status === 201, JSON.stringify(r.data));
r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'admin',
  body: { meetingId: flatId, title: 'เรื่องที่สอง', minutes: 10 },
});
ok('...and so can a second, without being filed under the first',
  r.status === 201, JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
const flat = r.data.meetings.find((m) => m.id === flatId);
ok('...both sit at the top level, numbered 1 and 2',
  flat.agenda.length === 2 && flat.agenda.every((x) => x.depth === 0) &&
  flat.agenda.map((x) => x.number).join(' ') === '1 2',
  flat.agenda.map((x) => x.number + ':' + x.title).join(' '));
ok('...and the total is the sum of the two', flat.length.minutes === 20,
  JSON.stringify(flat.length));



// ---- the agenda exactly as the page builds it ---------------------------
/**
 * Jade's bug: five headings on screen, nothing able to go under them, and an
 * item typed into the box simply never appearing. The page was sending the
 * five standing วาระ without the `kind` that marks a heading, so they were
 * stored as ordinary lines — which is a different agenda from the one the
 * person thought they were building.
 */
const asPageSends = [
  { title: 'วาระที่ 1 วาระประธานแจ้งให้ที่ประชุมทราบ', kind: 'chair', minutes: 0, heading: true, under: null },
  { title: 'วาระที่ 2 วาระเรื่องแจ้งเพื่อทราบ', kind: 'inform', minutes: 0, heading: true, under: null },
  { title: 'วาระที่ 3 เรื่องสืบเนื่อง', kind: 'carried', minutes: 0, heading: true, under: null },
  { title: 'วาระที่ 4 เรื่องเสนอเพื่อพิจารณา', kind: 'decide', minutes: 0, heading: true, under: null },
  { title: 'วาระที่ 5 เรื่องอื่น ๆ', kind: 'other', minutes: 0, heading: true, under: null },
  { title: 'คัดเลือกผู้สมัคร', minutes: 20, heading: false, under: 3 },
];
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'admin',
  body: { title: 'Recruit #2 Brief', meetsOn: '2026-11-18', meetsAt: '18:00',
          agenda: asPageSends },
});
const pageId = r.data.id;
ok('a meeting built the way the page builds it is accepted', r.status === 201,
  JSON.stringify(r.data).slice(0, 80));

r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
let pageMtg = r.data.meetings.find((m) => m.id === pageId);
ok('...its five วาระ really are headings, not ordinary lines',
  pageMtg.agenda.filter((x) => x.depth === 0 && x.kind !== 'item').length === 5,
  pageMtg.agenda.map((x) => x.number + ':' + x.kind).join(' '));
ok('...and the item typed in alongside them lands under วาระที่ 4',
  pageMtg.agenda.some((x) => x.number === '4.1' && x.title.includes('คัดเลือก')),
  pageMtg.agenda.map((x) => x.number).join(' '));

// And a further proposal can be filed under a heading, which is what failed.
const decide = pageMtg.agenda.find((x) => x.number === '4');
r = await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'admin',
  body: { meetingId: pageId, title: 'ตารางสัมภาษณ์', minutes: 10, parentId: decide.id },
});
ok('...and a later proposal can still be filed under it', r.status === 201,
  JSON.stringify(r.data));

// ---- repairing the meetings already made that way -----------------------
/**
 * The same agenda in its broken state, to prove the migration puts it right
 * rather than leaving Jade to rebuild every meeting by hand.
 */
await sql`
  UPDATE meeting_agenda SET kind = 'item'
  WHERE meeting_id = ${pageId} AND parent_id IS NULL`;
r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
ok('broken first: nothing counts as a heading',
  r.data.meetings.find((m) => m.id === pageId)
    .agenda.filter((x) => x.depth === 0 && x.kind !== 'item').length === 0);

await sql`
  UPDATE meeting_agenda SET kind = CASE
    WHEN title LIKE 'วาระที่ 1%' THEN 'chair'
    WHEN title LIKE 'วาระที่ 2%' THEN 'inform'
    WHEN title LIKE 'วาระที่ 3%' THEN 'carried'
    WHEN title LIKE 'วาระที่ 4%' THEN 'decide'
    WHEN title LIKE 'วาระที่ 5%' THEN 'other'
    ELSE kind END
  WHERE parent_id IS NULL AND kind = 'item' AND title LIKE 'วาระที่ %'`;
r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
pageMtg = r.data.meetings.find((m) => m.id === pageId);
ok('...and the repair restores all five without touching what was under them',
  pageMtg.agenda.filter((x) => x.depth === 0 && x.kind !== 'item').length === 5 &&
  pageMtg.agenda.some((x) => x.number === '4.1'),
  pageMtg.agenda.map((x) => x.number).join(' '));



// ---- meetings reach Google Calendar -------------------------------------
/**
 * The gap Jade found: a meeting had no way into anybody's Google Calendar.
 * The subscribed feed carried tasks and events only, so somebody could set
 * the whole thing up and still have no sign of the meeting they were expected
 * at. Two routes now exist — the feed, and a one-click link for the majority
 * who never subscribe anything.
 */
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'admin',
  body: {
    title: 'ประชุมทดสอบปฏิทิน', meetsOn: '2026-11-30', meetsAt: '17:00',
    joinUrl: 'https://chula.zoom.us/j/999', place: 'ออนไลน์',
    people: ['Kungking_HeadCon'], template: 'standard',
  },
});
const calMtgId = r.data.id;
r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
let calMtg = r.data.meetings.find((m) => m.id === calMtgId);
const headFour = calMtg.agenda.find((x) => x.number === '4');
await call(eventsApi, '/api/events?do=agenda', {
  method: 'POST', as: 'admin',
  body: { meetingId: calMtgId, title: 'เรื่องที่ต้องตัดสิน', minutes: 45, parentId: headFour.id },
});

const feedNow = await feed('mine');
ok('a meeting the person is invited to reaches the subscribed feed',
  feedNow.body.includes('ประชุมทดสอบปฏิทิน'),
  (feedNow.body.match(/SUMMARY:[^\r\n]*/g) || []).slice(-3).join(' | '));
ok('...marked as a meeting rather than a deadline',
  /CATEGORIES:Meeting/.test(feedNow.body));
ok('...carrying the joining link, which Google turns into a button',
  /URL:https:\/\/chula\.zoom\.us/.test(feedNow.body));

/**
 * The end time comes from the agenda: 17:00 plus forty-five minutes. A
 * meeting that blocked a default hour would be wrong on the calendar of
 * everybody invited.
 */
const block = feedNow.body.split('BEGIN:VEVENT')
  .find((x) => x.includes('ประชุมทดสอบปฏิทิน'));
ok('...and ending when the agenda says, not an invented hour later',
  /DTEND:20261130T104500Z/.test(block),
  (block.match(/DT(START|END):[^\r\n]*/g) || []).join(' '));

r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
calMtg = r.data.meetings.find((m) => m.id === calMtgId);
ok('every meeting also carries a one-click Google Calendar link',
  /^https:\/\/calendar\.google\.com\/calendar\/render\?/.test(calMtg.googleUrl || ''),
  String(calMtg.googleUrl || '').slice(0, 60));
const gcal = new URL(calMtg.googleUrl);
ok('...with the right window and Bangkok as the timezone',
  gcal.searchParams.get('dates') === '20261130T100000Z/20261130T104500Z' &&
  gcal.searchParams.get('ctz') === 'Asia/Bangkok',
  gcal.searchParams.get('dates'));
ok('...and the agenda in the body, so it is useful two minutes beforehand',
  (gcal.searchParams.get('details') || '').includes('เรื่องที่ต้องตัดสิน'),
  (gcal.searchParams.get('details') || '').slice(0, 70));

// Somebody not invited does not get it in their personal feed.
await sql`DELETE FROM meeting_people WHERE meeting_id = ${calMtgId}
          AND username = 'Kungking_HeadCon'`;
const feedAfter = await feed('mine');
ok('a meeting somebody was not invited to stays out of their own feed',
  !feedAfter.body.includes('ประชุมทดสอบปฏิทิน'));



// ---- guests from outside the committee ----------------------------------
/**
 * An อาจารย์ที่ปรึกษา or a supplier has no account here and never will, so an
 * invitation to them can only go out through Google. The committee's side of
 * that is holding the address and putting it on the link.
 */
const { readEmail, readGuests } = await import('../lib/meeting.js');
ok('an address with no dot in the domain is refused', readEmail('a@b') === null);
ok('...and one typed as a name is refused', readEmail('Ajarn Somchai') === null);
ok('...while a real one is kept, lower-cased', readEmail('  Ajarn@Chula.AC.TH ') === 'ajarn@chula.ac.th');
ok('a pasted line is understood however it was copied',
  JSON.stringify(readGuests('a@x.ac.th; Jane Doe <jane@y.com>\noops\nb@z.co.th, b@z.co.th')) ===
  JSON.stringify({ emails: ['a@x.ac.th', 'jane@y.com', 'b@z.co.th'], rejected: ['oops'] }),
  JSON.stringify(readGuests('a@x.ac.th; Jane Doe <jane@y.com>\noops\nb@z.co.th, b@z.co.th')));

r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'admin',
  body: {
    title: 'ประชุมกับที่ปรึกษาภายนอก', meetsOn: '2026-12-11', meetsAt: '14:00',
    joinUrl: 'https://chula.zoom.us/j/777',
    // The feed checked below belongs to this person, so they have to be on it
    // — a meeting they were not invited to is rightly absent from their feed.
    people: ['Kungking_HeadCon'],
    guests: 'ajarn@chula.ac.th, supplier@example.co.th, ไม่ใช่อีเมล',
  },
});
const guestMtgId = r.data.id;
ok('a meeting can be created with outside guests', r.status === 201, JSON.stringify(r.data));
ok('...and the address it could not read is named, not silently dropped',
  (r.data.guestsRejected || []).length === 1, JSON.stringify(r.data.guestsRejected));

r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
let guestMtg = r.data.meetings.find((m) => m.id === guestMtgId);
ok('...the two good ones are kept', guestMtg.guests.length === 2,
  guestMtg.guests.map((g) => g.email).join(', '));

/**
 * The link is what actually invites them: Google mails the invitation when
 * the organiser saves the event. Nothing in this application sends it.
 */
const gu = new URL(guestMtg.googleUrl);
ok('the Google link carries them as guests',
  gu.searchParams.get('add') === 'ajarn@chula.ac.th,supplier@example.co.th',
  gu.searchParams.get('add'));

const gFeed = await calApi(makeRequest(`/api/calendar?token=${feedToken}&scope=all`));
// ICS folds long lines at 75 octets and continues them with a leading space,
// so a Thai title is split across lines and matches nothing until unfolded.
const gBody = (await gFeed.text()).replace(/\r\n /g, '');
const gBlock = gBody.split('BEGIN:VEVENT').find((x) => x.includes('ที่ปรึกษาภายนอก'));
ok('...and the feed names them on the event itself',
  Boolean(gBlock) && /ATTENDEE[^\r\n]*mailto:ajarn@chula\.ac\.th/.test(gBlock),
  gBlock ? (gBlock.match(/ATTENDEE[^\r\n]*/g) || []).join(' | ').slice(0, 90) : 'event not in feed');

// Editing the list removes the one taken out and keeps the one left in.
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'PATCH', as: 'admin',
  body: { id: guestMtgId, guests: 'ajarn@chula.ac.th' },
});
r = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
guestMtg = r.data.meetings.find((m) => m.id === guestMtgId);
ok('taking a guest off the list removes only that one',
  guestMtg.guests.length === 1 && guestMtg.guests[0].email === 'ajarn@chula.ac.th',
  guestMtg.guests.map((g) => g.email).join(', '));

// Somebody who cannot edit the meeting cannot add guests to it.
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'PATCH', as: 'member',
  body: { id: guestMtgId, guests: 'gatecrasher@example.com' },
});
ok('somebody who may not edit the meeting cannot add a guest',
  r.status === 403, JSON.stringify(r.data));



// ---- an event three days away must not kill the whole run ---------------
/**
 * A real crash, found when the clock reached a date where the dev data had an
 * event exactly three days out. The code that picks a reminder window could
 * return '3d', but the table of wordings had no '3d' in it — so the lookup
 * threw inside the loop every reminder shares, and ONE event took down every
 * notification for that hour, for everybody, with no sign but a failed cron.
 */
/**
 * Three days from BANGKOK's today, not from UTC's.
 *
 * The cron works in Asia/Bangkok, so for seven hours of every UTC day the two
 * disagree about what day it is — and an event placed with UTC arithmetic
 * lands two days out instead of three, matching no reminder window at all.
 */
const [{ bkk3 }] = await sql`
  SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date + 3, 'YYYY-MM-DD') AS bkk3`;
const threeDaysOut = bkk3;
r = await call(eventsApi, '/api/events', {
  method: 'POST', as: 'admin',
  body: { title: 'กิจกรรมอีกสามวัน', startsOn: threeDaysOut, allDay: true,
          notify: ['7d', '3d', '24h', 'due'], people: ['Kungking_HeadCon'] },
});
ok('an event three days away can be created', r.status === 201,
  JSON.stringify(r.data).slice(0, 80));

r = await call(cronApi, '/api/cron');
ok('...and the hourly run survives it', r.status === 200,
  JSON.stringify(r.data).slice(0, 120));

const threeDay = await sql`
  SELECT body FROM notifications
  WHERE kind = 'event' AND title = 'กิจกรรมอีกสามวัน' LIMIT 1`;
ok('...and the person is actually told, in words',
  threeDay.length === 1 && /อีก 3 วัน/.test(threeDay[0].body),
  threeDay.length ? threeDay[0].body : 'nothing sent');

// Tasks due in the same run are still reminded about, which is what the crash
// was really costing.
r = await call(cronApi, '/api/cron');
ok('...and a second run still completes', r.status === 200);



// ===========================================================================
head('68. Papers attached to a meeting');

/**
 * Two ways to attach a paper, and they are not variations on each other.
 *
 * A link is a pointer and costs nothing; a file has to be stored, and where it
 * is stored decides whether this deployment pays Neon for it. Both end up in
 * one list because to the person attaching them it is one action — which is
 * exactly why the rules for each have to be checked separately.
 */
r = await call(eventsApi, '/api/events?do=meeting', {
  method: 'POST', as: 'admin',
  body: {
    title: 'ประชุมพิจารณางบประมาณ',
    note: 'กรุณาอ่านตัวเลขของเดือนที่แล้วมาก่อน',
    meetsOn: '2026-12-15', meetsAt: '13:00',
    people: ['Kungking_HeadCon'],
    template: 'standard',
  },
});
const paperMtgId = r.data.id;
ok('a meeting can be created with a description', r.status === 201, JSON.stringify(r.data).slice(0, 70));

let mtgList = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
let paperMtg = mtgList.data.meetings.find((m) => m.id === paperMtgId);
ok('...and the description comes back on it, not swallowed',
  paperMtg.note === 'กรุณาอ่านตัวเลขของเดือนที่แล้วมาก่อน', paperMtg.note);
ok('...and it starts with no papers', Array.isArray(paperMtg.files) && paperMtg.files.length === 0,
  JSON.stringify(paperMtg.files));

// ---- a pasted link ----
r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, linkUrl: 'https://drive.google.com/file/d/abc123/view' },
});
ok('a link can be attached', r.status === 201 && r.data.where === 'link', JSON.stringify(r.data));

mtgList = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
paperMtg = mtgList.data.meetings.find((m) => m.id === paperMtgId);
ok('...and it is named by its host rather than 180 characters of URL',
  paperMtg.files.length === 1 && paperMtg.files[0].name === 'drive.google.com',
  paperMtg.files[0] && paperMtg.files[0].name);
ok('...and it carries no byte size, because it stores no bytes',
  paperMtg.files[0].size === 0 && paperMtg.files[0].where === 'link',
  JSON.stringify(paperMtg.files[0]));

/**
 * A javascript: link in a meeting invitation would run in the browser of
 * everybody invited. The URL cleaner is shared with joinUrl, and this is the
 * check that it is actually reached on this path too.
 */
r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, linkUrl: 'javascript:alert(document.cookie)' },
});
ok('a javascript: link is not a link', r.status === 400 && r.data.error === 'NOTHING_TO_ATTACH',
  JSON.stringify(r.data));

// ---- a real file, when there is a Drive to put it in ----
/**
 * The point of this one is the storage bill, not the upload.
 *
 * She pays Neon by the gigabyte and said plainly that she did not want meeting
 * papers eating it. So a file that reaches Drive must leave NOTHING behind in
 * the database — not kept "just in case", the way a document in mid-signature
 * is, because a meeting paper is finished the moment it arrives.
 */
const pdfBytes = Buffer.concat([
  Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n'),
]);
r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: {
    meetingId: paperMtgId, name: 'งบประมาณ.pdf',
    mime: 'application/pdf', file: pdfBytes.toString('base64'),
  },
});
const driveFileRow = r.data.id;
ok('a file can be attached', r.status === 201, JSON.stringify(r.data).slice(0, 80));
ok('...and with an archive configured it goes to Drive', r.data.where === 'drive', r.data.where);

const afterUpload = await sql`
  SELECT byte_size, drive_url, (bytes IS NULL) AS cleared
  FROM meeting_files WHERE id = ${driveFileRow}`;
ok('...and its bytes are dropped from the database at once, not kept as a second copy',
  afterUpload[0].cleared === true, JSON.stringify(afterUpload[0]));
ok('...while the size and the Drive link are still recorded',
  afterUpload[0].byte_size === pdfBytes.length && /drive\.google\.com/.test(afterUpload[0].drive_url),
  `${afterUpload[0].byte_size} · ${afterUpload[0].drive_url}`);

/**
 * The name must not pick up a second extension on the way.
 *
 * The documents side passes a name WITHOUT one and relies on ".pdf" being
 * added; this side passes whatever the person's file was called. Adding one
 * unconditionally produced "งบประมาณ.pdf.pdf", which is the sort of filename
 * that makes somebody think the system is broken.
 */
const inDrive = [...driveFiles.values()].slice(-1)[0];
ok('...and the Drive copy keeps the name it arrived with, extension and all',
  inDrive.name === 'งบประมาณ.pdf', inDrive.name);

// ---- the same thing with no Drive configured ----
/**
 * A committee halfway through setting Drive up must still be able to attach
 * the agenda to its own meeting, so the database is the fallback — and then the
 * download route is the only way the file comes back, which makes it the thing
 * to check hardest.
 */
const paperToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: {
    meetingId: paperMtgId, name: 'รายงาน.pdf',
    mime: 'application/pdf', file: pdfBytes.toString('base64'),
  },
});
const paperFileId = r.data.id;
ok('with no archive configured the file is still accepted', r.status === 201,
  JSON.stringify(r.data).slice(0, 70));
ok('...and the answer says plainly that it is being held here', r.data.where === 'here', r.data.where);

mtgList = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
paperMtg = mtgList.data.meetings.find((m) => m.id === paperMtgId);
const paperRow = paperMtg.files.find((f) => f.id === paperFileId);
ok('...its real size is recorded', paperRow.size === pdfBytes.length, String(paperRow.size));
ok('...and its type is read back as pdf', paperRow.kind === 'pdf', paperRow.kind);

/**
 * The listing must never carry the bytes.
 *
 * Every page load reads this, and a meeting with four attachments would move
 * megabytes out of Neon each time — slow, and on this plan paid for by the
 * gigabyte too. The size is in the listing; the bytes are not.
 */
ok('...but the listing itself carries no bytes',
  !('bytes' in paperRow) && !('file' in paperRow), Object.keys(paperRow).join(','));

// ---- downloading it back ----
let raw = await eventsApi(makeRequest(
  '/api/events?do=mtgfile&id=' + encodeURIComponent(paperFileId), { as: 'admin' }));
const got = Buffer.from(await raw.arrayBuffer());
ok('the file comes back byte for byte', raw.status === 200 && got.equals(pdfBytes),
  `${raw.status} · ${got.length} bytes`);
/**
 * These are bytes somebody else uploaded, handed back on this app's own
 * origin. If a browser ever decides to render one as a page, it runs with
 * every signed-in person's session cookie available to it.
 */
ok('...as a download, never as a page on this origin',
  /^attachment/.test(raw.headers.get('content-disposition') || '') &&
  raw.headers.get('x-content-type-options') === 'nosniff',
  raw.headers.get('content-disposition'));

// A pasted link is not a file, so asking for its bytes is a mistake worth a
// clear answer rather than an empty download.
r = await call(eventsApi,
  '/api/events?do=mtgfile&id=' + encodeURIComponent(paperMtg.files[0].id), { as: 'admin' });
ok('asking to download a link says so, and hands back the link',
  r.status === 400 && r.data.error === 'IS_A_LINK' && /drive\.google\.com/.test(r.data.url),
  JSON.stringify(r.data));

process.env.GOOGLE_DRIVE_REFRESH_TOKEN = paperToken;

// ---- a Drive that refuses ----
/**
 * The file must survive an archive that is down, and the trouble must be said
 * out loud rather than swallowed: "attached, but the archive did not take it"
 * is worth knowing while it is still true.
 */
driveRefuses = true;
r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, name: 'ยังไม่ขึ้น.pdf',
          mime: 'application/pdf', file: pdfBytes.toString('base64') },
});
driveRefuses = false;
ok('a file still attaches when Drive refuses it', r.status === 201 && r.data.where === 'here',
  JSON.stringify(r.data).slice(0, 90));
ok('...and the reason travels back rather than being swallowed',
  r.data.driveProblem === 'DRIVE_REFUSED', String(r.data.driveProblem));
const refusedRow = await sql`
  SELECT (bytes IS NOT NULL) AS held FROM meeting_files WHERE id = ${r.data.id}`;
ok('...with the bytes kept here, since nowhere else has them',
  refusedRow[0].held === true, JSON.stringify(refusedRow[0]));

// ---- what may not be attached ----
r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, name: 'evil.html', mime: 'text/html',
          file: Buffer.from('<script>fetch("/api/users")</script>').toString('base64') },
});
ok('an HTML file is refused outright', r.status === 400 && r.data.error === 'FILE_TYPE_NOT_ALLOWED',
  JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, name: 'evil.svg', mime: 'image/svg+xml',
          file: Buffer.from('<svg onload="alert(1)"/>').toString('base64') },
});
ok('...and so is an SVG, which is a page wearing a picture’s name',
  r.status === 400 && r.data.error === 'FILE_TYPE_NOT_ALLOWED', JSON.stringify(r.data));

/**
 * A spreadsheet picked off a phone often arrives with no content type at all,
 * so the extension gets a say — but only to choose among the types already
 * allowed, never to admit one that is not.
 */
r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, name: 'ตัวเลข.xlsx', mime: '',
          file: Buffer.from('PK\u0003\u0004 not really a workbook').toString('base64') },
});
ok('a file with no stated type is placed by its extension', r.status === 201,
  JSON.stringify(r.data).slice(0, 60));

r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, name: 'run.exe', mime: '',
          file: Buffer.from('MZ').toString('base64') },
});
ok('...but an extension cannot admit a type that is not allowed',
  r.status === 400 && r.data.error === 'FILE_TYPE_NOT_ALLOWED', JSON.stringify(r.data));

r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin',
  body: { meetingId: paperMtgId, name: 'huge.pdf', mime: 'application/pdf',
          file: Buffer.alloc(4 * 1024 * 1024, 0x41).toString('base64') },
});
ok('a file over three megabytes is refused, with the limit named',
  r.status === 400 && r.data.error === 'FILE_TOO_BIG' && r.data.limit === 3 * 1024 * 1024,
  JSON.stringify({ e: r.data.error, limit: r.data.limit }));

r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'admin', body: { meetingId: paperMtgId },
});
ok('attaching nothing at all says so', r.status === 400 && r.data.error === 'NOTHING_TO_ATTACH',
  JSON.stringify(r.data));

// ---- who may attach, and who may take away ----
/**
 * Anybody invited may attach, which is the whole point: the person holding the
 * budget spreadsheet is usually not the person who called the meeting.
 */
r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'editor',
  body: { meetingId: paperMtgId, linkUrl: 'https://example.ac.th/paper.pdf', name: 'เอกสารของกุ๊งกิ๊ง' },
});
const editorFileId = r.data.id;
ok('somebody merely invited may attach a paper', r.status === 201, JSON.stringify(r.data).slice(0, 60));

r = await call(eventsApi, '/api/events?do=mtgfile', {
  method: 'POST', as: 'member',
  body: { meetingId: paperMtgId, linkUrl: 'https://example.com/gatecrash.pdf' },
});
ok('...but somebody who was not invited may not', r.status === 403 && r.data.error === 'NOT_INVITED',
  JSON.stringify(r.data));

r = await call(eventsApi,
  '/api/events?do=mtgfile&id=' + encodeURIComponent(paperFileId), { method: 'DELETE', as: 'editor' });
ok('an attendee cannot remove somebody else’s paper',
  r.status === 403 && r.data.error === 'NOT_YOUR_FILE', JSON.stringify(r.data));

r = await call(eventsApi,
  '/api/events?do=mtgfile&id=' + encodeURIComponent(editorFileId), { method: 'DELETE', as: 'editor' });
ok('...but they can remove their own', r.status === 200, JSON.stringify(r.data));

r = await call(eventsApi,
  '/api/events?do=mtgfile&id=' + encodeURIComponent(paperFileId), { method: 'DELETE', as: 'admin' });
ok('...and whoever runs the meeting can remove any of them', r.status === 200, JSON.stringify(r.data));

mtgList = await call(eventsApi, '/api/events?do=meetings', { as: 'admin' });
paperMtg = mtgList.data.meetings.find((m) => m.id === paperMtgId);
ok('...and the removed ones are really gone',
  !paperMtg.files.some((f) => f.id === paperFileId || f.id === editorFileId),
  paperMtg.files.map((f) => f.name).join(', '));

/**
 * Somebody who cannot see the meeting cannot fetch its papers either. Worth
 * its own check because the download route is a separate entrance to the same
 * data and is the obvious place for a permission rule to be left out.
 */
raw = await eventsApi(makeRequest(
  '/api/events?do=mtgfile&id=' + encodeURIComponent(
    paperMtg.files.length ? paperMtg.files[0].id : 'nothing'), { as: 'member' }));
ok('somebody outside the meeting cannot download its papers',
  raw.status === 403 || raw.status === 404, String(raw.status));

// Deleting the meeting takes its papers with it, rather than leaving rows
// pointing at a meeting that no longer exists.
await call(eventsApi, '/api/events?do=meeting&id=' + encodeURIComponent(paperMtgId),
  { method: 'DELETE', as: 'admin' });
const orphans = await sql`SELECT count(*)::int AS n FROM meeting_files WHERE meeting_id = ${paperMtgId}`;
ok('cancelling a meeting takes its papers with it', orphans[0].n === 0, String(orphans[0].n));



// ===========================================================================
head('69. Who is free, and whose booking wins');

/**
 * The rank rule, written out in full.
 *
 * Jade settled it in two steps: first that a co-admin may override an admin,
 * then that "other co-admins are not immune, admin and co-admin can override
 * anyone". So the top two levels outrank every booking including each other's
 * and their own level's, and an editor is the only one the "below their rank"
 * half still applies to. Written as a table because this is the sort of rule
 * that gets quietly broken by a refactor that looks like a simplification.
 */
const actorAt = (access) => ({ username: `actor_${access}`, access });
const ownerAt = (access) => ({ username: `owner_${access}`, access });
const RANK_TABLE = [
  // actor,     owner,      may prioritise?
  // The top two outrank everything, each other and their own level included.
  ['admin',     'admin',    true],
  ['admin',     'coadmin',  true],
  ['admin',     'editor',   true],
  ['admin',     'unitlead', true],
  ['admin',     'inner',    true],
  ['coadmin',   'admin',    true],
  ['coadmin',   'coadmin',  true],
  ['coadmin',   'editor',   true],
  ['coadmin',   'unitlead', true],
  ['coadmin',   'inner',    true],
  // An editor settles clashes below them and cannot touch the people running
  // the fair — this is the only row where "below their rank" still bites.
  ['editor',    'unitlead', true],
  ['editor',    'inner',    true],
  ['editor',    'editor',   false],
  ['editor',    'coadmin',  false],
  ['editor',    'admin',    false],
  // Below editor, nobody may overrule anybody. They are still warned.
  ['unitlead',  'inner',    false],
  ['unitlead',  'unitlead', false],
  ['inner',     'inner',    false],
];
let rankWrong = [];
for (const [actor, owner, want] of RANK_TABLE) {
  const got = canPrioritiseOver(actorAt(actor), ownerAt(owner));
  if (got !== want) rankWrong.push(`${actor} over ${owner}: expected ${want}, got ${got}`);
}
ok('every rank pairing behaves as Jade described', rankWrong.length === 0,
  rankWrong.join(' | ') || `${RANK_TABLE.length} pairings`);

ok('a co-admin outranks an admin', canPrioritiseOver(actorAt('coadmin'), ownerAt('admin')) === true);
ok('...and an admin outranks a co-admin, so it runs both ways',
  canPrioritiseOver(actorAt('admin'), ownerAt('coadmin')) === true);
ok('...and a co-admin is not immune to another co-admin',
  canPrioritiseOver(actorAt('coadmin'), ownerAt('coadmin')) === true);
ok('...nor an admin to another admin',
  canPrioritiseOver(actorAt('admin'), ownerAt('admin')) === true);
/**
 * The line that still means something. If an editor could outrank a co-admin
 * the rank rule would be decorative, so this is the check that actually keeps
 * it honest.
 */
ok('an editor still cannot outrank anybody at or above their own level',
  canPrioritiseOver(actorAt('editor'), ownerAt('coadmin')) === false &&
  canPrioritiseOver(actorAt('editor'), ownerAt('editor')) === false);

/** Your own booking is always yours to move out of your own way. */
const self = { username: 'same_person', access: 'inner' };
ok('anybody may prioritise over their own booking, whatever their rank',
  canPrioritiseOver(self, { username: 'same_person', access: 'inner' }) === true);

// ---- the clock maths ----
ok('back-to-back is not a clash', overlaps(540, 600, 600, 660) === false, '09:00–10:00 then 10:00–11:00');
ok('...but a real overlap is', overlaps(540, 600, 570, 660) === true, '09:00–10:00 vs 09:30–11:00');
ok('...and one inside another is', overlaps(540, 660, 570, 600) === true);

ok('a Monday is read as a Monday', weekdayOf('2026-10-05') === 'mon', weekdayOf('2026-10-05'));
ok('...and a Sunday as a Sunday', weekdayOf('2026-10-11') === 'sun', weekdayOf('2026-10-11'));

// ---- somebody's own account of their time ----
/**
 * Nobody fills this in. That is the design constraint, not a complaint: there
 * are four hundred people on this committee and most will never open the page,
 * so a blank availability has to mean "always free" or the warning fires on
 * every appointment and gets ignored within a week.
 */
ok('somebody who has filled nothing in is free',
  unavailableReason({ on: '2026-10-05', at: '09:00' }, {}) === null);

const weeknights = {
  windows: [
    { day: 'mon', from: '17:00', to: '22:00' },
    { day: 'tue', from: '17:00', to: '22:00' },
    { day: 'sat', from: '09:00', to: '18:00' },
  ],
};
ok('an hour inside a stated window is free',
  unavailableReason({ on: '2026-10-05', at: '18:00', to: '19:00' }, weeknights) === null,
  'Monday 18:00');
let whyNot = unavailableReason({ on: '2026-10-05', at: '09:00', to: '10:00' }, weeknights);
ok('...an hour outside it is not, and the free hours come back with the answer',
  whyNot && whyNot.kind === 'outsideHours' && whyNot.windows.join() === '17:00–22:00',
  JSON.stringify(whyNot));
whyNot = unavailableReason({ on: '2026-10-07', at: '18:00' }, weeknights);
ok('...and a weekday they named no hours for at all is an off day',
  whyNot && whyNot.kind === 'offDay' && whyNot.day === 'wed', JSON.stringify(whyNot));
/**
 * An all-day thing cannot be placed at an hour, so having ANY free window that
 * day is enough. Refusing it because 09:00 is outside their evenings would warn
 * about every all-day event for every student on the committee.
 */
ok('an all-day thing only needs them to be free at some point that day',
  unavailableReason({ on: '2026-10-05' }, weeknights) === null);

// ---- days away ----
const exams = {
  blocks: [{ fromOn: '2026-12-01', toOn: '2026-12-15', reason: 'สอบปลายภาค' }],
};
whyNot = unavailableReason({ on: '2026-12-08', at: '18:00' }, exams);
ok('a stretch of days away covers every hour of every day in it',
  whyNot && whyNot.kind === 'away' && whyNot.reason === 'สอบปลายภาค', JSON.stringify(whyNot));
ok('...and the day after it ends is free again',
  unavailableReason({ on: '2026-12-16', at: '18:00' }, exams) === null);

const classAfternoon = {
  blocks: [{ fromOn: '2026-10-05', toOn: '2026-10-05', fromAt: '13:00', toAt: '16:00', reason: 'เรียน' }],
};
ok('a block with hours only bites on those hours',
  unavailableReason({ on: '2026-10-05', at: '17:00' }, classAfternoon) === null, '17:00');
ok('...and does bite inside them',
  (unavailableReason({ on: '2026-10-05', at: '14:00' }, classAfternoon) || {}).kind === 'away', '14:00');

// ---- clashes against other people's bookings ----
const rosterForClash = [
  { username: 'Jade_Pres', displayName: 'Jade', access: 'admin' },
  { username: 'Kaew_VP', displayName: 'Kaew', access: 'coadmin' },
  { username: 'Kungking_HeadCon', displayName: 'Kungking', access: 'editor' },
  { username: 'New_UnitCon', displayName: 'New', access: 'unitlead' },
  { username: 'Ploy_StaffCon', displayName: 'Ploy', access: 'inner' },
];
const ployIsBusy = {
  Ploy_StaffCon: {
    booked: [{ kind: 'meeting', id: 'mt_x', code: 'M0001', title: 'ประชุมฝ่าย',
               on: '2026-10-05', at: '14:00', to: '15:30', createdBy: 'Jade_Pres' }],
  },
};
const when = { on: '2026-10-05', at: '15:00', to: '16:00' };

let found = clashesFor(rosterForClash[2], when, ['Ploy_StaffCon'], rosterForClash, ployIsBusy);
ok('an editor is told when somebody is already booked',
  found.length === 1 && found[0].clashes[0].kind === 'booked',
  JSON.stringify(found[0] && found[0].clashes[0]).slice(0, 90));
ok('...and is told what they are booked with, by name and code',
  found[0].clashes[0].title === 'ประชุมฝ่าย' && found[0].clashes[0].code === 'M0001');
/**
 * The clash belongs to a meeting the DIRECTOR called, so an editor cannot
 * declare their own task the more important one — it is the owner's rank that
 * decides, not the rank of the person who is double-booked.
 */
ok('...but cannot outrank a meeting the director called',
  found[0].clashes[0].mayPrioritise === false && found[0].mayPrioritiseAll === false,
  JSON.stringify({ one: found[0].clashes[0].mayPrioritise, all: found[0].mayPrioritiseAll }));

found = clashesFor(rosterForClash[1], when, ['Ploy_StaffCon'], rosterForClash, ployIsBusy);
ok('a co-admin CAN outrank the same meeting, because the director is not immune to them',
  found[0].clashes[0].mayPrioritise === true && found[0].mayPrioritiseAll === true);

found = clashesFor(rosterForClash[3], when, ['Ploy_StaffCon'], rosterForClash, ployIsBusy);
ok('a unit editor is still told about the clash, they just cannot overrule it',
  found.length === 1 && found[0].clashes[0].mayPrioritise === false,
  'warned, not blocked');

ok('somebody free at that hour produces no warning at all',
  clashesFor(rosterForClash[0], { on: '2026-10-05', at: '09:00', to: '10:00' },
    ['Ploy_StaffCon'], rosterForClash, ployIsBusy).length === 0);

/**
 * A person's own stated availability carries no override, whatever the rank of
 * whoever is appointing them. A head who books over an exam week does not make
 * the exam go away, and offering a director a button that claimed otherwise
 * would be the system lying about what it can do.
 */
const ployHasExams = {
  Ploy_StaffCon: { blocks: [{ fromOn: '2026-12-01', toOn: '2026-12-15', reason: 'สอบ' }] },
};
found = clashesFor(rosterForClash[0], { on: '2026-12-08', at: '14:00' },
  ['Ploy_StaffCon'], rosterForClash, ployHasExams);
ok('even the director cannot outrank somebody’s own exam week',
  found[0].clashes[0].kind === 'away' && found[0].clashes[0].mayPrioritise === false &&
  found[0].mayPrioritiseAll === false, JSON.stringify(found[0].clashes[0]));

// The thing being edited is not in its own way.
found = clashesFor(rosterForClash[0], { ...when, ignoreId: 'mt_x' },
  ['Ploy_StaffCon'], rosterForClash, ployIsBusy);
ok('moving a meeting does not report it as clashing with itself', found.length === 0);

// ---- the same thing through the API ----
head('70. Availability through the API');

r = await call(usersApi, '/api/users?do=free', {
  method: 'PUT', as: 'member',
  body: { windows: [{ day: 'mon', from: '17:00', to: '22:00' },
                    { day: 'sat', from: '09:00', to: '18:00' }] },
});
ok('a person can say when they are free', r.status === 200 && r.data.windows.length === 2,
  JSON.stringify(r.data.windows));
ok('...and the week comes back starting on Monday, not alphabetically',
  r.data.windows[0].day === 'mon' && r.data.windows[1].day === 'sat',
  r.data.windows.map((w) => w.day).join(','));

r = await call(usersApi, '/api/users?do=free', {
  method: 'PUT', as: 'member', body: { windows: [{ day: 'mon', from: '22:00', to: '17:00' }] },
});
ok('a window that ends before it starts is refused rather than guessed at',
  r.status === 400 && r.data.error === 'ENDS_BEFORE_IT_STARTS', JSON.stringify(r.data));

r = await call(usersApi, '/api/users?do=free', {
  method: 'PUT', as: 'member', body: { username: 'Jade_Pres', windows: [] } });
ok('one person cannot rewrite another’s free hours',
  r.status === 403 && r.data.error === 'NOT_YOUR_AVAILABILITY', JSON.stringify(r.data));

r = await call(usersApi, '/api/users?do=block', {
  method: 'POST', as: 'member',
  body: { fromOn: '2026-12-01', toOn: '2026-12-15', reason: 'สอบปลายภาค' } });
ok('a stretch of days away can be added', r.status === 200 && r.data.blocks.length === 1,
  JSON.stringify(r.data.blocks).slice(0, 80));
const blockId = r.data.blocks[0].id;

/**
 * The dates are everybody's business — that is the point of the feature. The
 * REASON is not: "ไปงานศพ" is nobody else's business, and a system that showed
 * it to whoever happened to be assigning work would teach people to stop
 * writing anything down.
 */
r = await call(usersApi, '/api/users?do=free&username=Ploy_StaffCon', { as: 'editor' });
ok('somebody else can see the dates, which is the point',
  r.status === 200 && r.data.blocks.length === 1 &&
  r.data.blocks[0].fromOn === '2026-12-01', JSON.stringify(r.data.blocks));
ok('...but not the reason, which is nobody else’s business',
  r.data.blocks[0].reason === '', JSON.stringify(r.data.blocks[0].reason));

r = await call(usersApi, '/api/users?do=free', { as: 'member' });
ok('...while the person themselves still sees their own reason',
  r.data.blocks[0].reason === 'สอบปลายภาค', r.data.blocks[0].reason);

r = await call(usersApi, '/api/users?do=block&id=' + encodeURIComponent(blockId),
  { method: 'DELETE', as: 'editor' });
ok('one person cannot delete another’s days away',
  r.status === 403 && r.data.error === 'NOT_YOUR_AVAILABILITY', JSON.stringify(r.data));

// ---- the check the forms actually make ----
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'admin',
  body: { title: 'งานบ่ายวันจันทร์', dueDate: '2026-12-07', dueTime: '14:00',
          assignees: ['Ploy_StaffCon'], notify: [] },
});
ok('a task can be put on somebody during their exams — it warns, it does not block',
  r.status === 201, JSON.stringify(r.data).slice(0, 60));
const examTaskId = r.data.task?.id;

r = await call(usersApi, '/api/users?do=clashes', {
  method: 'POST', as: 'editor',
  body: { on: '2026-12-07', at: '14:00', people: ['Ploy_StaffCon'] },
});
ok('the form is told that person is away', r.status === 200 && r.data.clashes.length === 1,
  JSON.stringify(r.data.clashes).slice(0, 110));
const awaySaid = r.data.clashes[0].clashes.find((c) => c.kind === 'away');
const bookedSaid = r.data.clashes[0].clashes.find((c) => c.kind === 'booked');
ok('...and why, and what else they already have at that hour',
  Boolean(awaySaid) && Boolean(bookedSaid) && bookedSaid.title === 'งานบ่ายวันจันทร์',
  JSON.stringify({ away: awaySaid && awaySaid.kind, booked: bookedSaid && bookedSaid.title }));
ok('...with the display name, so the warning names a person not a username',
  r.data.clashes[0].displayName && r.data.clashes[0].displayName !== 'Ploy_StaffCon',
  r.data.clashes[0].displayName);

/**
 * The editor may outrank the task because an ADMIN created it and an editor
 * does not outrank an admin — so this must come back false. If it ever came
 * back true the whole rank rule would be decorative.
 */
ok('an editor may not outrank a task the director set',
  bookedSaid.mayPrioritise === false, String(bookedSaid.mayPrioritise));

r = await call(usersApi, '/api/users?do=clashes', {
  method: 'POST', as: 'coadmin',
  body: { on: '2026-12-07', at: '14:00', people: ['Ploy_StaffCon'] },
});
const coadminSaw = r.data.clashes[0].clashes.find((c) => c.kind === 'booked');
ok('...but a co-admin may, even over the director', coadminSaw.mayPrioritise === true);
ok('...though still not over the exam week itself',
  r.data.clashes[0].clashes.find((c) => c.kind === 'away').mayPrioritise === false);

// ---- declaring precedence, and who is allowed to ----
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'coadmin',
  body: { title: 'งานที่สำคัญกว่า', dueDate: '2026-12-07', dueTime: '14:00',
          assignees: ['Ploy_StaffCon'], notify: [], prioritise: true },
});
const winnerId = r.data.task?.id;
ok('a co-admin can book over the director’s task and say theirs counts',
  r.status === 201, JSON.stringify(r.data).slice(0, 60));

let precRows = await sql`SELECT * FROM precedence WHERE item_id = ${winnerId}`;
ok('...and that decision is written down', precRows.length === 1, JSON.stringify(precRows[0] || {}).slice(0, 90));
ok('...against the right task, for the right person',
  precRows[0].over_id === examTaskId && precRows[0].username === 'Ploy_StaffCon',
  `${precRows[0].over_id} / ${precRows[0].username}`);

r = await call(tasksApi, '/api/tasks', { as: 'member' });
const beaten = r.data.tasks.find((t) => t.id === examTaskId);
ok('...and the person on both can see which one was outranked',
  beaten && (beaten.outrankedBy || []).length === 1,
  JSON.stringify(beaten && beaten.outrankedBy));

/**
 * The page computes the clashes to draw its warning. If the SAVE trusted that
 * list, a member could post mayPrioritise:true and walk over the director's
 * calendar. It is worked out again on the server, so the flag in the request
 * decides nothing.
 */
r = await call(tasksApi, '/api/tasks', {
  method: 'POST', as: 'unitlead',
  body: { title: 'งานที่อ้างว่าสำคัญ', dueDate: '2026-12-07', dueTime: '14:00',
          assignees: ['Ploy_StaffCon'], notify: [], prioritise: true },
});
const liarId = r.data.task?.id;
ok('somebody who may not prioritise can still make the booking', r.status === 201);
precRows = await sql`SELECT * FROM precedence WHERE item_id = ${liarId}`;
ok('...but asking for precedence they do not have writes nothing',
  precRows.length === 0, `${precRows.length} row(s)`);

// ---- a decision stops applying when the thing moves ----
r = await call(tasksApi, '/api/tasks', {
  method: 'PATCH', as: 'coadmin', body: { id: winnerId, dueDate: '2026-12-09' } });
ok('moving the winning task to another day is allowed', r.status === 200);
precRows = await sql`SELECT * FROM precedence WHERE item_id = ${winnerId}`;
ok('...and it stops outranking a task it no longer shares a day with',
  precRows.length === 0, `${precRows.length} row(s)`);

r = await call(tasksApi, '/api/tasks', { as: 'member' });
ok('...so the other task is no longer marked as beaten',
  (r.data.tasks.find((t) => t.id === examTaskId).outrankedBy || []).length === 0);

// Deleting takes the decision with it rather than leaving a dangling note.
await call(tasksApi, '/api/tasks?id=' + encodeURIComponent(liarId), { method: 'DELETE', as: 'admin' });
r = await call(usersApi, '/api/users?do=clashes', {
  method: 'POST', as: 'admin',
  body: { on: '2026-12-07', at: '14:00', people: ['Ploy_StaffCon'], ignoreId: examTaskId },
});
const stillThere = (r.data.clashes[0] || { clashes: [] }).clashes
  .filter((c) => c.kind === 'booked' && c.id === liarId);
ok('a deleted task stops showing up as a clash', stillThere.length === 0);


// ===========================================================================
head('71. Cards on LINE: tasks, events, meetings');

/**
 * What LINE refuses, checked on every card this section produces.
 *
 * A Flex message that breaks one rule is not sent at all — LINE answers 400
 * and the person sees nothing, not a slightly wrong card. So the rules are
 * checked here rather than discovered on a phone: colours in hex only (the
 * word "transparent" is refused), no empty text, button labels of 20
 * characters at most, postback data of 300 at most, at most 12 bubbles to a
 * carousel, and the whole message under 50KB.
 */
function flexProblems(message) {
  const bad = [];
  if (!message) return ['no card at all'];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((c, i) => walk(c, `${path}[${i}]`)); return; }
    for (const key of ['color', 'backgroundColor', 'borderColor']) {
      if (node[key] !== undefined && !/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(node[key])) {
        bad.push(`${path}.${key}=${node[key]}`);
      }
    }
    if (node.type === 'text' && !String(node.text || '').length) bad.push(`${path}: empty text`);
    if (node.type === 'box' && (!Array.isArray(node.contents))) bad.push(`${path}: box without contents`);
    if (node.action) {
      if (node.action.label && node.action.label.length > 20) bad.push(`${path}: label "${node.action.label}"`);
      if (node.action.data && node.action.data.length > 300) bad.push(`${path}: data too long`);
    }
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  };
  walk(message, 'msg');
  if (message.type === 'carousel' && message.contents.length > 12) bad.push('carousel over 12');
  if (JSON.stringify(message).length > 50000) bad.push(`over 50KB: ${JSON.stringify(message).length}`);
  return bad;
}
const lastFlex = () => (lineSent.filter((m) => m.kind === 'reply').slice(-1)[0]?.flex || [])[0] || null;
const pressOnBot = (userId, data) => ([{
  type: 'postback', replyToken: 'rt_' + Math.random().toString(36).slice(2),
  source: { type: 'user', userId }, postback: { data },
}]);

// Accounts of its own: earlier sections link and unlink LINE ids as they go.
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Ucard1', 'Jade_Pres', 'Jade') ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;

// A task shaped like a real one: late, in progress, with sub-tasks and people.
const yesterdayIso = (() => { const d = new Date(Date.now() - 2 * 864e5 + 7 * 3600e3); return d.toISOString().slice(0, 10); })();
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin',
  body: { title: 'การ์ด: เตรียมเวทีกลาง', description: 'จัดเวที ไฟ เสียง และป้ายหน้างาน',
          dueDate: yesterdayIso, dueTime: '18:00', priority: 'high',
          assignees: ['Jade_Pres', 'Kungking_HeadCon'], notify: [] } });
const cardTask = r.data.task;
await sql`UPDATE tasks SET status = 'doing' WHERE id = ${cardTask.id}`;
await sql`INSERT INTO task_parts (id, task_id, title, done, position)
          VALUES ('cp1', ${cardTask.id}, 'ไฟ', true, 1), ('cp2', ${cardTask.id}, 'เสียง', false, 2),
                 ('cp3', ${cardTask.id}, 'ป้าย', false, 3)
          ON CONFLICT DO NOTHING`.catch(() => {});

await lineApi(lineHook(sayToBot('Ucard1', cardTask.code)));
let card = lastFlex();
ok('typing a task code answers with a card, not a line of text', card && card.type === 'bubble',
  card ? card.type : lastReply().slice(0, 60));
let seen = lastReply();
ok('...headed by where it stands', seen.includes('กำลังทำ') && seen.includes(cardTask.code), seen.split('\n').slice(0, 3).join(' | '));
ok('...with the five-step tracker, every stage named', ['รับงาน', 'กำลังทำ', 'รอตรวจ', 'ตรวจแล้ว', 'เสร็จ'].every((x) => seen.includes(x)));
ok('...and how far along it is as a number', seen.includes('25%'), (seen.match(/\d+%/) || [''])[0]);
const parts = await sql`SELECT count(*)::int AS n FROM task_parts WHERE task_id = ${cardTask.id}`;
if (parts[0].n) {
  ok('...the sub-tasks as a bar with a count', seen.includes('1/3 เสร็จ'), (seen.match(/\d+\/\d+ เสร็จ/) || ['none'])[0]);
}
ok('...says plainly when it is late, and by how much', /เลยกำหนด \d+ วัน/.test(seen), (seen.match(/เลยกำหนด \d+ วัน/) || ['none'])[0]);
ok('...names the people on it', seen.includes('ผู้รับผิดชอบ'));
ok('...and offers the next step to somebody allowed to take it',
  JSON.stringify(card).includes(`task:status:${cardTask.id}:review`));
ok('the card is one LINE will accept', flexProblems(card).length === 0, flexProblems(card).slice(0, 4).join(' | '));

// Pressing the button moves it, and the reply is the card moved on.
await lineApi(lineHook(pressOnBot('Ucard1', `task:status:${cardTask.id}:review`)));
const nowAt = await sql`SELECT status FROM tasks WHERE id = ${cardTask.id}`;
ok('pressing the next-step button moves the task', nowAt[0].status === 'review', nowAt[0].status);
ok('...and the reply is the card with the tracker moved on', lastReply().includes('รอตรวจ') && lastReply().includes('50%'),
  (lastReply().match(/\d+%/) || [''])[0]);

/**
 * Somebody who is not on the task sees the card — they may see the work of
 * their department — but no button, and a forged postback changes nothing.
 */
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Ucard3', 'Yam_HeadSpon', 'Yam') ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;
await lineApi(lineHook(pressOnBot('Ucard3', `task:status:${cardTask.id}:done`)));
const still = await sql`SELECT status FROM tasks WHERE id = ${cardTask.id}`;
ok('a forged button press from somebody not allowed changes nothing', still[0].status === 'review', still[0].status);

// ---- my progress ----
await lineApi(lineHook(sayToBot('Ucard1', 'ความคืบหน้า')));
card = lastFlex();
ok('"ความคืบหน้า" answers with a card per open task', card && (card.type === 'carousel' || card.type === 'bubble'),
  card ? `${card.type}${card.contents && card.contents.length ? ' × ' + card.contents.length : ''}` : 'none');
ok('...that LINE will accept, however many tasks there are', card && flexProblems(card).length === 0,
  card ? flexProblems(card).slice(0, 3).join(' | ') : '');

// Tapping a row in a list opens the card.
await lineApi(lineHook(sayToBot('Ucard1', 'งาน')));
const listCard = lastFlex();
ok('rows in a task list can be tapped', JSON.stringify(listCard || {}).includes('"data":"open:task:'));
await lineApi(lineHook(pressOnBot('Ucard1', `open:task:${cardTask.id}`)));
ok('...and tapping one opens that task\'s card', lastReply().includes('การ์ด: เตรียมเวทีกลาง') && lastReply().includes('ความคืบหน้า'));

// ---- events ----
r = await call(eventsApi, '/api/events', { method: 'POST', as: 'admin',
  body: { title: 'การ์ด: ซ้อมใหญ่', startsOn: '2026-12-18', startsAt: '14:00', endsAt: '17:00',
          allDay: false, place: 'หอประชุมจุฬาฯ', notify: [] } });
const cardEvent = r.data.event;
await lineApi(lineHook(sayToBot('Ucard1', cardEvent.code)));
card = lastFlex();
seen = lastReply();
ok('an event code answers with an event card', card && card.type === 'bubble' && seen.includes('การ์ด: ซ้อมใหญ่'));
ok('...the date as a calendar leaf, the hours and the place', seen.includes('18') && seen.includes('ธ.ค.') &&
  seen.includes('14:00–17:00') && seen.includes('หอประชุมจุฬาฯ'));
ok('...with a button that adds it to Google Calendar, at Bangkok time',
  JSON.stringify(card).includes('calendar.google.com') && JSON.stringify(card).includes('20261218T140000'));
ok('...which LINE will accept', flexProblems(card).length === 0, flexProblems(card).slice(0, 3).join(' | '));
await lineApi(lineHook(sayToBot('Ucard1', 'กิจกรรม')));
ok('the events list is cards now, not text', Boolean(lastFlex()), lastReply().slice(0, 40));

// ---- meetings ----
r = await call(eventsApi, '/api/events?do=meeting', { method: 'POST', as: 'admin',
  body: { title: 'การ์ด: ประชุมใหญ่', meetsOn: '2026-12-10', meetsAt: '17:00', place: 'ห้อง 701',
          joinUrl: 'https://chula.zoom.us/j/1', people: ['Kungking_HeadCon'], template: 'standard' } });
const cardMeetingId = r.data.id;
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Ucard2', 'Kungking_HeadCon', 'Kungking') ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;
await lineApi(lineHook(sayToBot('Ucard2', 'ประชุม')));
card = lastFlex();
seen = lastReply();
ok('"ประชุม" answers with meeting cards', Boolean(card) && seen.includes('การ์ด: ประชุมใหญ่'), seen.slice(0, 60));
ok('...showing who has answered', /มา \d+.*ยังไม่ตอบ \d+.*ไม่มา \d+/.test(seen.replace(/\n/g, ' ')));
ok('...the agenda', seen.includes('ระเบียบวาระ') && seen.includes('วาระที่ 1'));
ok('...a button to join online', JSON.stringify(card).includes('chula.zoom.us'));
ok('...and the buttons to answer the invitation', JSON.stringify(card).includes(`meeting:reply:${cardMeetingId}:accepted`));
ok('...which LINE will accept', flexProblems(card).length === 0, flexProblems(card).slice(0, 3).join(' | '));
await lineApi(lineHook(pressOnBot('Ucard2', `meeting:reply:${cardMeetingId}:accepted`)));
const replied = await sql`SELECT reply FROM meeting_people WHERE meeting_id = ${cardMeetingId} AND username = 'Kungking_HeadCon'`;
ok('pressing เข้าร่วม answers the invitation', replied[0] && replied[0].reply === 'accepted', replied[0] && replied[0].reply);
ok('...and the card that comes back says so', lastReply().includes('คุณตอบรับแล้ว'));
await lineApi(lineHook(pressOnBot('Ucard3', `meeting:reply:${cardMeetingId}:accepted`)));
const notInvited = await sql`SELECT count(*)::int AS n FROM meeting_people WHERE meeting_id = ${cardMeetingId} AND username = 'Yam_HeadSpon'`;
ok('somebody not invited cannot answer for themselves into the meeting', notInvited[0].n === 0);

await sql`DELETE FROM tasks WHERE id = ${cardTask.id}`;
await sql`DELETE FROM events WHERE id = ${cardEvent.id}`;
await sql`DELETE FROM meetings WHERE id = ${cardMeetingId}`;

// ===========================================================================
head('72. Viewers: following a task without doing it');
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'content', body: {
  title: 'ผู้ติดตาม: ทำโปสเตอร์', department: 'content', assignees: ['Kungking_HeadCon'],
  viewers: ['Kluayhom_HeadMerchant', 'Kungking_HeadCon', 'no_such_person'], notify: ['created'] } });
const watched = r.data.task;
ok('a task can be created with viewers', r.status === 201 && Array.isArray(watched.viewers), String(r.status));
ok('...keeping the real person who is not on it',
  watched.viewers.length === 1 && watched.viewers[0] === 'Kluayhom_HeadMerchant', JSON.stringify(watched.viewers));
ok('...dropping someone already doing it, and a name that is nobody', !watched.viewers.includes('Kungking_HeadCon'));
ok('a viewer is not one of the people on it', !watched.assignees.includes('Kluayhom_HeadMerchant'));

let note = await sql`SELECT body FROM notifications WHERE task_id = ${watched.id} AND username = 'Kluayhom_HeadMerchant' AND kind = 'watch'`;
ok('the viewer is told they are following it', note.length === 1, note[0] && note[0].body);

r = await call(tasksApi, '/api/tasks', { as: 'merch' });
let seenByViewer = r.data.tasks.find((x) => x.id === watched.id);
ok('the viewer, from another department, can see it', Boolean(seenByViewer));
ok('...and is told it is one they follow', seenByViewer && seenByViewer.watching === true);
ok('...but may not move it, edit it or hand work in',
  seenByViewer && !seenByViewer.maySetStatus && !seenByViewer.mayEdit && !seenByViewer.mayAttach);
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'merch', body: { id: watched.id, status: 'done' } });
ok('...and the server refuses a status change from them', r.status === 403, String(r.status));
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'merch', body: { id: watched.id, viewers: [] } });
ok('...or a change to who is following', r.status === 403, String(r.status));

r = await call(tasksApi, '/api/tasks', { as: 'content' });
ok('to the person doing it, it is not "watching"', r.data.tasks.find((x) => x.id === watched.id).watching === false);

r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'content', body: { id: watched.id, status: 'doing' } });
note = await sql`SELECT body FROM notifications WHERE task_id = ${watched.id} AND username = 'Kluayhom_HeadMerchant' AND kind = 'progress'`;
ok('when it moves along, the viewer hears about it', note.length === 1 && note[0].body.includes('กำลังทำ'), note[0] && note[0].body);
const doerTold = await sql`SELECT 1 FROM notifications WHERE task_id = ${watched.id} AND username = 'Kungking_HeadCon' AND kind = 'progress'`;
ok('...and the person who moved it is not told what they just did', doerTold.length === 0);
await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'content', body: { id: watched.id, title: 'ผู้ติดตาม: ทำโปสเตอร์ (แก้)' } });
note = await sql`SELECT 1 FROM notifications WHERE task_id = ${watched.id} AND username = 'Kluayhom_HeadMerchant' AND kind = 'progress'`;
ok('...but not about every other edit', note.length === 1);

// LINE: "ความคืบหน้า" shows what I follow too, marked as such.
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Uview1', 'Kluayhom_HeadMerchant', 'Kluayhom') ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;
await lineApi(lineHook(sayToBot('Uview1', 'ความคืบหน้า')));
const viewCard = lastFlex();
seen = lastReply();
ok('on LINE, "ความคืบหน้า" includes the tasks I follow', seen.includes('ผู้ติดตาม: ทำโปสเตอร์'), seen.slice(0, 80));
ok('...marked as followed, with no buttons to move it',
  seen.includes('ติดตามอยู่') && !JSON.stringify(viewCard).includes(`task:status:${watched.id}`));
ok('...which LINE will accept', flexProblems(viewCard).length === 0, flexProblems(viewCard).slice(0, 3).join(' | '));

// Putting a viewer on the task makes them one of the people doing it.
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'content', body: {
  id: watched.id, assignees: ['Kungking_HeadCon', 'Kluayhom_HeadMerchant'] } });
ok('a viewer put on the task stops being a viewer', r.data.task.viewers.length === 0 &&
  r.data.task.assignees.includes('Kluayhom_HeadMerchant'), JSON.stringify(r.data.task.viewers));
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'content', body: {
  id: watched.id, assignees: ['Kungking_HeadCon'], viewers: ['Kluayhom_HeadMerchant', 'Yam_HeadSpon'] } });
ok('viewers can be changed later by whoever set it up', r.status === 200 &&
  r.data.task.viewers.join() === 'Kluayhom_HeadMerchant,Yam_HeadSpon', JSON.stringify(r.data.task.viewers));
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'content', body: { id: watched.id, viewers: ['Yam_HeadSpon'] } });
ok('...and removed', r.data.task.viewers.join() === 'Yam_HeadSpon');
r = await call(tasksApi, '/api/tasks', { as: 'merch' });
ok('someone no longer following it, from outside the department, no longer sees it', !r.data.tasks.some((x) => x.id === watched.id));
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'content', body: { title: 'ผู้ติดตาม: ชิ้นงาน', viewers: ['Yam_HeadSpon'] } });
const pieceTask = r.data.task;
r = await call(tasksApi, '/api/tasks?do=part', { method: 'POST', as: 'content', body: { taskId: pieceTask.id, title: 'ชิ้นหนึ่ง', assignee: 'Yam_HeadSpon' } });
ok('handing a viewer a piece of the work puts them on the task instead',
  r.data.task.viewers.length === 0 && r.data.task.assignees.includes('Yam_HeadSpon'));

await sql`DELETE FROM tasks WHERE id IN (${watched.id}, ${pieceTask.id})`;
const viewersGone = await sql`SELECT count(*)::int AS n FROM task_viewers WHERE task_id IN (${watched.id}, ${pieceTask.id})`;
ok("deleting a task takes its viewers with it", viewersGone[0].n === 0);

// ===========================================================================
head('73. LINE never goes quiet');
/**
 * What she saw: "ประชุม" and "M0005" got no answer at all. The meeting's
 * Google Calendar link carried its whole agenda, in Thai, URL-encoded — far
 * past the 1,000 characters LINE allows in a link — so LINE refused the
 * whole reply and the chat just sat there.
 */
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Uquiet', 'Jade_Pres', 'Jade') ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;
await sql`DELETE FROM line_flows WHERE line_user_id = 'Uquiet'`;
const longNote = 'รายละเอียดการประชุมที่ยาวมาก '.repeat(40);
r = await call(eventsApi, '/api/events?do=meeting', { method: 'POST', as: 'admin',
  body: { title: 'เงียบ: ประชุมใหญ่วาระยาว', meetsOn: '2026-12-11', meetsAt: '13:00', place: 'ห้องประชุมใหญ่',
          joinUrl: 'meet.google.com/abc-defg-hij', note: longNote,
          people: ['Jade_Pres', 'Kungking_HeadCon'], template: 'standard' } });
const [lm] = await sql`SELECT id, code FROM meetings WHERE title = 'เงียบ: ประชุมใหญ่วาระยาว'`;
const allUris = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.action && node.action.uri) out.push(node.action.uri);
  for (const v of Object.values(node)) if (v && typeof v === 'object') allUris(v, out);
  return out;
};
lineSent.length = 0;
await lineApi(lineHook(sayToBot('Uquiet', lm.code)));
let quietCard = lastFlex();
let uris = allUris(quietCard);
ok('a meeting with a long agenda still answers with its card', Boolean(quietCard), lastReply().slice(0, 60));
ok('...and every link on it is one LINE accepts (under 1,000 characters, a real address)',
  uris.length > 0 && uris.every((u) => u.length <= 1000 && /^(https?:\/\/|line:|tel:)/.test(u)),
  uris.map((u) => u.length).join(','));
ok('...still with its "add to Google Calendar" button, just without the agenda in the link',
  uris.some((u) => u.includes('calendar.google.com')));
lineSent.length = 0;
await lineApi(lineHook(sayToBot('Uquiet', 'ประชุม')));
quietCard = lastFlex();
ok('"ประชุม" answers too, with that meeting among the cards', Boolean(quietCard) && lastReply().includes('เงียบ: ประชุมใหญ่วาระยาว'),
  lastReply().slice(0, 60));
ok('...every link on every card acceptable', allUris(quietCard).every((u) => u.length <= 1000));
await lineApi(lineHook(sayToBot('Uquiet', 'การประชุม')));
ok('"การประชุม" is understood the same way', lastReply().includes('เงียบ: ประชุมใหญ่วาระยาว'));

// If LINE refuses a card anyway, the same answer arrives as text.
lineSent.length = 0;
lineRefuseFlex = true;
await lineApi(lineHook(sayToBot('Uquiet', lm.code)));
const tries = lineSent.filter((m) => m.kind === 'reply');
ok('a card LINE refuses is sent again as plain text, so the chat never goes quiet',
  tries.length === 2 && tries[0].refused && !tries[1].flex.length && tries[1].text.includes('เงียบ: ประชุมใหญ่วาระยาว'),
  tries.map((x) => (x.refused ? 'refused' : x.flex.length ? 'card' : 'text')).join(' → '));

// A number on its own picks from the list just shown.
await lineApi(lineHook(sayToBot('Uquiet', 'ประชุม')));
await lineApi(lineHook(sayToBot('Uquiet', '1')));
ok('typing "1" after a list opens the first item, rather than "ไม่เข้าใจ"',
  Boolean(lastFlex()) && !lastReply().includes('ไม่เข้าใจ'), lastReply().slice(0, 60));
await lineApi(lineHook(sayToBot('Uquiet', 'ตรวจสอบงาน')));
ok('ตรวจสอบงาน offers meetings, events and progress',
  ['ประชุม', 'กิจกรรม', 'ความคืบหน้า'].every((w) => lastButtons().includes(w)), lastButtons().join(' '));
await lineApi(lineHook(sayToBot('Uquiet', 'จบ')));
await lineApi(lineHook(sayToBot('Uquiet', 'ช่วยเหลือ')));
ok('...and the buttons under every answer include meetings and events',
  ['ประชุม', 'กิจกรรม'].every((w) => lastButtons().includes(w)), lastButtons().join(' '));
await sql`DELETE FROM meetings WHERE id = ${lm.id}`;

// ===========================================================================
head('74. What a task is to me: responsible, via department, following');
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin', body: {
  title: 'บทบาท: งานทดสอบ', assignees: ['Jade_Pres'], viewers: ['Yam_HeadSpon'],
  departments: [{ key: 'content', scope: 'heads' }], notify: [] } });
const roleTask = r.data.task;
ok('a task can name people, tag a department and have viewers at once', r.status === 201, String(r.status));
ok('the person named is marked as named', roleTask.roles.Jade_Pres === 'named', JSON.stringify(roleTask.roles));
ok('a head of the tagged department is on it via the department',
  roleTask.roles.Kungking_HeadCon === 'dept', JSON.stringify(roleTask.roles));
ok('...and the form gets only the named people back, so saving it keeps them apart',
  roleTask.named.join() === 'Jade_Pres', JSON.stringify(roleTask.named));
r = await call(tasksApi, '/api/tasks', { as: 'content' });
const headSees = r.data.tasks.find((x) => x.id === roleTask.id);
ok('to the department head it reads "via department"', headSees && headSees.myRole === 'dept', headSees && headSees.myRole);
r = await call(tasksApi, '/api/tasks', { as: 'admin' });
ok('to the person named it reads "responsible"', r.data.tasks.find((x) => x.id === roleTask.id).myRole === 'named');
r = await call(tasksApi, '/api/tasks', { as: 'seesall' });
ok('to the viewer it reads "following"', r.data.tasks.find((x) => x.id === roleTask.id).myRole === 'watch');

// Saving the form (names + the same tags) must not turn the department into names.
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'admin', body: {
  id: roleTask.id, title: 'บทบาท: งานทดสอบ (แก้)', assignees: ['Jade_Pres'],
  departments: [{ key: 'content', scope: 'heads' }] } });
ok('saving the task keeps the department people as "via department"',
  r.data.task.roles.Kungking_HeadCon === 'dept' && r.data.task.named.join() === 'Jade_Pres', JSON.stringify(r.data.task.roles));
// Naming somebody who came through the department makes them named.
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'admin', body: {
  id: roleTask.id, assignees: ['Jade_Pres', 'Kungking_HeadCon'], departments: [{ key: 'content', scope: 'heads' }] } });
ok('naming a department person makes them responsible', r.data.task.roles.Kungking_HeadCon === 'named');
// A piece of the task puts its holder on it, and the form cannot take them off.
r = await call(tasksApi, '/api/tasks?do=part', { method: 'POST', as: 'admin', body: { taskId: roleTask.id, title: 'ชิ้นเดียว', assignee: 'Kluayhom_HeadMerchant' } });
ok('somebody handed a piece is on it "by part"', r.data.task.roles.Kluayhom_HeadMerchant === 'part', JSON.stringify(r.data.task.roles));
r = await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'admin', body: {
  id: roleTask.id, assignees: ['Jade_Pres'], departments: [] } });
ok('...and saving the form without them leaves them on, because of the piece',
  r.data.task.assignees.includes('Kluayhom_HeadMerchant') && !r.data.task.assignees.includes('Kungking_HeadCon'),
  JSON.stringify(r.data.task.roles));

// LINE says it too.
await sql`INSERT INTO line_links (line_user_id, username, display_name)
          VALUES ('Urole', 'Kluayhom_HeadMerchant', 'K') ON CONFLICT (line_user_id) DO UPDATE SET username = EXCLUDED.username`;
await lineApi(lineHook(sayToBot('Urole', roleTask.code)));
ok('the LINE card says what the task is to the reader', lastReply().includes('คุณรับผิดชอบงานย่อย'), lastReply().slice(0, 80));

// ===========================================================================
head('75. Notification settings: แจ้งเตือน / เงียบ / ปิด');
await sql`DELETE FROM notify_prefs`;
r = await call(usersApi, '/api/users?do=notify', { as: 'content' });
ok('everyone starts with every category on, except following, which starts quiet',
  r.data.categories.task_named === 'all' && r.data.categories.task_watch === 'quiet' && r.data.categories.announce === 'all',
  JSON.stringify(r.data.categories));
r = await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'task_named', level: 'loud' } });
ok('a level that is not one of the three is refused', r.status === 400);
r = await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'nonsense', level: 'off' } });
ok('so is a category that does not exist', r.status === 400);

// Phones for the two people this section watches, so a push has somewhere to go.
await sql`INSERT INTO push_subscriptions (endpoint, username, p256dh, auth)
          VALUES ('https://push.test/kk-prefs', 'Kungking_HeadCon', ${browserKeys.p256dh}, ${browserKeys.auth}),
                 ('https://push.test/yam-prefs', 'Yam_HeadSpon', ${browserKeys.p256dh}, ${browserKeys.auth})
          ON CONFLICT (endpoint) DO UPDATE SET username = EXCLUDED.username`;
const pushedTo = () => pushCalls.map((c) => ({ username: c.url.includes('kk-prefs') ? 'Kungking_HeadCon'
  : c.url.includes('yam-prefs') ? 'Yam_HeadSpon' : c.url }));
// Silent: the bell gets it, the phone does not.
await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'task_named', level: 'quiet' } });
pushCalls.length = 0;
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin', body: { title: 'แจ้ง: เงียบ', assignees: ['Kungking_HeadCon'], notify: ['created'] } });
const quietTask = r.data.task;
let bell = await sql`SELECT 1 FROM notifications WHERE task_id = ${quietTask.id} AND username = 'Kungking_HeadCon'`;
ok('"เงียบ": the bell still gets it', bell.length === 1);
const { sortRecipients } = await import('../lib/notifyprefs.js');
let heardBy = await sortRecipients(sql, ['Kungking_HeadCon', 'Jade_Pres'], { category: 'task_named', scope: 'task', id: quietTask.id });
ok('...but it goes in the quiet list, which is never pushed to a phone',
  heardBy.quiet.includes('Kungking_HeadCon') && heardBy.loud.includes('Jade_Pres') && !heardBy.loud.includes('Kungking_HeadCon'),
  JSON.stringify(heardBy));
// Off: nothing at all.
await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'task_named', level: 'off' } });
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin', body: { title: 'แจ้ง: ปิด', assignees: ['Kungking_HeadCon'], notify: ['created'] } });
const offTask = r.data.task;
bell = await sql`SELECT 1 FROM notifications WHERE task_id = ${offTask.id} AND username = 'Kungking_HeadCon'`;
ok('"ปิด": not even the bell', bell.length === 0);
// One task set differently wins over the category.
await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'task', id: offTask.id, level: 'all' } });
await call(tasksApi, '/api/tasks?do=part', { method: 'POST', as: 'admin', body: { taskId: offTask.id, title: 'ชิ้น', assignee: 'Kungking_HeadCon' } });
bell = await sql`SELECT 1 FROM notifications WHERE task_id = ${offTask.id} AND username = 'Kungking_HeadCon'`;
ok('a single task set to แจ้งเตือน is heard even with the category off', bell.length === 1);
r = await call(usersApi, '/api/users?do=notify', { as: 'content' });
ok('...and the settings list it by name', r.data.items.some((i) => i.id === offTask.id && i.title === 'แจ้ง: ปิด' && i.level === 'all'),
  JSON.stringify(r.data.items));
await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'task', id: offTask.id, level: null } });
r = await call(usersApi, '/api/users?do=notify', { as: 'content' });
ok('...and removing it goes back to the category', !r.data.items.some((i) => i.id === offTask.id));

// Reminders: switched off means no countdown, but a missed deadline still lands quietly.
await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'task_reminder', level: 'off' } });
const yIso = (() => { const d = new Date(Date.now() - 864e5 + 7 * 3600e3); return d.toISOString().slice(0, 10); })();
const in3 = (() => { const d = new Date(Date.now() + 3 * 864e5 + 7 * 3600e3); return d.toISOString().slice(0, 10); })();
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin', body: { title: 'แจ้ง: ใกล้ส่ง', assignees: ['Kungking_HeadCon'], dueDate: in3, notify: ['3d'] } });
const soonTask = r.data.task;
r = await call(tasksApi, '/api/tasks', { method: 'POST', as: 'admin', body: { title: 'แจ้ง: เลยแล้ว', assignees: ['Kungking_HeadCon'], dueDate: yIso, notify: [] } });
const lateTask = r.data.task;
await call(cronApi, '/api/cron', {});
bell = await sql`SELECT kind FROM notifications WHERE task_id = ${soonTask.id} AND username = 'Kungking_HeadCon'`;
ok('reminders off: no 3-day reminder', bell.length === 0, JSON.stringify(bell));
bell = await sql`SELECT kind FROM notifications WHERE task_id = ${lateTask.id} AND username = 'Kungking_HeadCon' AND kind = 'overdue'`;
ok('...but an overdue task still reaches the bell', bell.length === 1);

// Viewers default to quiet.
pushCalls.length = 0;
await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'admin', body: { id: quietTask.id, viewers: ['Yam_HeadSpon'] } });
await call(tasksApi, '/api/tasks', { method: 'PATCH', as: 'admin', body: { id: quietTask.id, status: 'doing' } });
bell = await sql`SELECT kind FROM notifications WHERE task_id = ${quietTask.id} AND username = 'Yam_HeadSpon' ORDER BY created_at`;
ok('a viewer hears about progress in the bell by default', bell.some((b) => b.kind === 'progress'), JSON.stringify(bell));
heardBy = await sortRecipients(sql, ['Yam_HeadSpon'], { category: 'task_watch', scope: 'task', id: quietTask.id });
ok('...without their phone buzzing (quiet unless they choose otherwise)', heardBy.quiet.includes('Yam_HeadSpon') && !heardBy.loud.length);

// Urgent announcements cannot be silenced; ordinary ones can.
await call(usersApi, '/api/users?do=notify', { method: 'POST', as: 'content', body: { scope: 'announce', level: 'off' } });
r = await call(pushApi, '/api/push?do=announce', { method: 'POST', as: 'admin', body: { title: 'แจ้ง: ประกาศธรรมดา', body: 'x', audience: { kind: 'everyone' } } });
bell = await sql`SELECT 1 FROM notifications WHERE username = 'Kungking_HeadCon' AND title = 'แจ้ง: ประกาศธรรมดา'`;
ok('an ordinary announcement respects "ปิด"', bell.length === 0);
r = await call(pushApi, '/api/push?do=announce', { method: 'POST', as: 'admin', body: { title: 'แจ้ง: ประกาศด่วน', body: 'x', level: 'urgent', audience: { kind: 'everyone' } } });
bell = await sql`SELECT 1 FROM notifications WHERE username = 'Kungking_HeadCon' AND title = 'แจ้ง: ประกาศด่วน'`;
ok('an urgent one reaches everybody regardless', bell.length === 1);

await sql`DELETE FROM tasks WHERE title LIKE 'แจ้ง:%' OR title LIKE 'บทบาท:%'`;
// The urgent one would greet every browser test with a pop-up.
await sql`DELETE FROM notifications WHERE title LIKE 'แจ้ง:%'`;
await sql`DELETE FROM announcements WHERE title LIKE 'แจ้ง:%'`;
await sql`DELETE FROM notify_prefs`;

// ===========================================================================
head('76. Documents: co-chairs, อำนวยการใหญ่, and who posts the letter');

/**
 * The three things she ran into on one letter.
 *
 * Several ฝ่าย are run by two ประธาน and both sign. อำนวยการ 1, 2 and 3 sit
 * under อำนวยการใหญ่, so their letters pass through that chair before they
 * reach ประธานโครงการ. And not every ฝ่าย wants เลขานุการ to do the posting.
 */
await sql`UPDATE users SET is_head = true WHERE username = 'Fah_StaffCon'`;
await sql`UPDATE users SET position = 'ประธานฝ่ายเนื้อหา' WHERE username IN ('Kungking_HeadCon', 'Fah_StaffCon')`;
await sql`UPDATE users SET department = 'oper2', unit = 'สถานที่', is_head = true,
                           position = 'ประธานฝ่ายอำนวยการ 2' WHERE username = 'Ikkew_HeadOper1'`;
await sql`UPDATE users SET department = 'operations', is_head = true,
                           position = 'ประธานฝ่ายอำนวยการใหญ่' WHERE username = 'Totti_HeadOp'`;
await sql`DELETE FROM user_departments WHERE username IN ('Ikkew_HeadOper1', 'Totti_HeadOp')`;
await sql`INSERT INTO user_departments (username, department) VALUES
            ('Ikkew_HeadOper1', 'oper2'), ('Totti_HeadOp', 'operations')
          ON CONFLICT DO NOTHING`;
await call(authApi, '/api/auth?do=login', { method: 'POST', remember: 'oper2head',
  body: { username: 'Ikkew_HeadOper1', password: 'editorPw2' } });
await call(usersApi, '/api/users?do=me', { method: 'PATCH', as: 'oper2head', body: { fullName: 'นอร์ท ใจกว้าง' } });

// A staff member of a ฝ่าย with two ประธาน.
r = await call(docsApi, '/api/documents?do=propose', {
  method: 'POST', as: 'member', body: { department: 'content' },
});
let chainLine = r.data.steps.map((st) => `${st.role}:${st.username}`).join(' → ');
ok('a ฝ่าย with two ประธาน gets a step for each of them',
  r.data.steps.filter((st) => st.role === 'deptHead').length === 2, chainLine);
const bothHeads = r.data.steps.filter((st) => st.role === 'deptHead').map((st) => st.username);
ok('...two different people, not the same one twice',
  new Set(bothHeads).size === 2 && bothHeads.every((u) => ['Kungking_HeadCon', 'Fah_StaffCon'].includes(u)),
  JSON.stringify(bothHeads));
ok('...and both of them sign', r.data.steps.filter((st) => st.role === 'deptHead').every((st) => st.signs));

// The screenshot: a letter from the head of อำนวยการ 2.
r = await call(docsApi, '/api/documents?do=propose', {
  method: 'POST', as: 'oper2head', body: { department: 'oper2' },
});
chainLine = r.data.steps.map((st) => st.role).join(' → ');
ok('a letter from อำนวยการ 2 climbs through อำนวยการใหญ่ before ประธานโครงการ',
  chainLine === 'author → divisionHead → director → secretary', chainLine);
const div = r.data.steps.find((st) => st.role === 'divisionHead');
ok('...and อำนวยการใหญ่ is the person who runs it', div.username === 'Totti_HeadOp', div.username);
ok('...who signs the letter, not just approves it', div.signs === true);
ok('...and the form is told what the roles are called, for a row added by hand',
  (r.data.roles || []).some((x) => x.role === 'divisionHead' && x.label === 'ประธานฝ่ายอำนวยการใหญ่'),
  JSON.stringify(r.data.roles));

// อำนวยการใหญ่'s own letter does not climb through itself.
r = await call(authApi, '/api/auth?do=login', { method: 'POST', remember: 'opall',
  body: { username: 'Totti_HeadOp', password: 'opAllPw12' } });
if (r.status !== 200) {
  await call(authApi, '/api/auth?do=setup', { method: 'POST', remember: 'opall',
    body: { username: 'Totti_HeadOp', password: 'opAllPw12' } });
}
// A signing step cannot act without a signature on file, which is the point.
await call(docsApi, '/api/documents?do=signature', { method: 'POST', as: 'opall', body: { png: sigPng } });
await call(usersApi, '/api/users?do=me', { method: 'PATCH', as: 'opall', body: { fullName: 'ต๊อด ใจเย็น' } });
r = await call(docsApi, '/api/documents?do=propose', { method: 'POST', as: 'opall', body: { department: 'operations' } });
chainLine = r.data.steps.map((st) => st.role).join(' → ');
ok('อำนวยการใหญ่’s own letter has no step through itself', chainLine === 'author → director → secretary', chainLine);

// Sending it yourself.
r = await call(docsApi, '/api/documents?do=propose', {
  method: 'POST', as: 'oper2head', body: { department: 'oper2', sendMode: 'self' },
});
const selfChain = r.data.steps;
chainLine = selfChain.map((st) => st.role).join(' → ');
ok('choosing to send it yourself puts you at the end instead of เลขานุการ',
  chainLine === 'author → divisionHead → director → sender', chainLine);
ok('...as yourself', selfChain[selfChain.length - 1].username === 'Ikkew_HeadOper1');
ok('...and that last step does not sign anything', selfChain[selfChain.length - 1].signs === false);

const withBoxes = (list) => list.map((st) => ({
  role: st.role, username: st.username,
  mark: st.signs ? { page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.06 } : null,
}));

// The address เลขานุการ forwards to.
const letter = { title: 'หนังสือขอความอนุเคราะห์', pdf: await makePdf(1), department: 'oper2' };
const secChain = (await call(docsApi, '/api/documents?do=propose',
  { method: 'POST', as: 'oper2head', body: { department: 'oper2' } })).data.steps;
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head', body: { ...letter, steps: withBoxes(secChain) },
});
ok('a letter เลขานุการ must post needs an address to post it to',
  r.status === 400 && r.data.error === 'EMAIL_REQUIRED', JSON.stringify(r.data));
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head',
  body: { ...letter, recipientEmail: 'not-an-address', steps: withBoxes(secChain) },
});
ok('...and something that is not an address does not count', r.data.error === 'EMAIL_REQUIRED', JSON.stringify(r.data));
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head', body: { ...letter, internalUnit: true, steps: withBoxes(secChain) },
});
ok('...but a หน่วยงานภายในจุฬาฯ needs none', r.status === 201, JSON.stringify(r.data).slice(0, 90));
const insideId = r.data.id;

r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head',
  body: { ...letter, recipientEmail: 'Office@Example.ac.th, สำนัก@x, two@example.com',
          steps: withBoxes(secChain) },
});
ok('several addresses are kept, and the nonsense between them dropped', r.status === 201, JSON.stringify(r.data).slice(0, 80));
r = await call(docsApi, `/api/documents?id=${r.data.id}`, { as: 'oper2head' });
ok('...and the letter carries them, so เลขานุการ knows where it goes',
  r.data.document.recipientEmail === 'Office@Example.ac.th, two@example.com', r.data.document.recipientEmail);
ok('...and says who is posting it', r.data.document.sendMode === 'secretary');

// A chain that does not end with somebody posting it.
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head',
  body: { ...letter, internalUnit: true, steps: withBoxes(secChain.filter((st) => st.role !== 'secretary')) },
});
ok('a chain with nobody to post the letter is refused', r.data.error === 'BAD_CHAIN_END', JSON.stringify(r.data));
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head',
  body: { ...letter, sendMode: 'self',
          steps: withBoxes(secChain.slice(0, -1)).concat([{ role: 'sender', username: 'Jade_Pres' }]) },
});
ok('...and you cannot make somebody else send it for you under ส่งเอง',
  r.data.error === 'SENDER_MUST_BE_YOU', JSON.stringify(r.data));
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head',
  body: { ...letter, internalUnit: true,
          steps: withBoxes(secChain.slice(0, -1)).concat([{ role: 'secretary', username: 'Fah_StaffCon' }]) },
});
ok('...nor hand the posting to somebody who is not เลขานุการ',
  r.data.error === 'NOT_A_SECRETARY', JSON.stringify(r.data));

// A signer added by hand — the thing the form could not do at all.
const extra = withBoxes(secChain.slice(0, -1))
  .concat([{ role: 'deptHead', username: 'Kungking_HeadCon', mark: { page: 1, x: 0.3, y: 0.8, w: 0.2, h: 0.06 } }])
  .concat(withBoxes(secChain.slice(-1)));
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head', body: { ...letter, internalUnit: true, steps: extra },
});
ok('a signer added by hand is accepted', r.status === 201, JSON.stringify(r.data).slice(0, 80));
r = await call(docsApi, `/api/documents?id=${r.data.id}`, { as: 'oper2head' });
ok('...and takes their place in the order', r.data.steps.map((st) => st.role).join(' → ') ===
  'author → divisionHead → director → deptHead → secretary', r.data.steps.map((st) => st.role).join(' → '));

// All the way through a letter the writer posts themselves.
const selfSteps = withBoxes(selfChain);
r = await call(docsApi, '/api/documents?do=create', {
  method: 'POST', as: 'oper2head',
  body: { title: 'หนังสือที่ส่งเอง', pdf: await makePdf(1), department: 'oper2',
          sendMode: 'self', steps: selfSteps },
});
ok('a letter the writer posts themselves needs no address at all', r.status === 201, JSON.stringify(r.data).slice(0, 80));
const selfId = r.data.id;
for (const who of [['Totti_HeadOp', 'opall'], ['Jade_Pres', 'admin']]) {
  await call(docsApi, '/api/documents?do=approve', { method: 'POST', as: who[1], body: { id: selfId } });
}
r = await call(docsApi, `/api/documents?id=${selfId}`, { as: 'oper2head' });
ok('once everybody has signed it comes back to the writer, not to เลขานุการ',
  r.data.maySend === true && r.data.steps[r.data.steps.length - 1].role === 'sender',
  `${r.data.document.stage} / ${r.data.maySend}`);
r = await call(docsApi, `/api/documents?id=${selfId}`, { as: 'sunday' });
ok('...and a secretary is not offered a ส่งแล้ว button for it', r.data.maySend === false, String(r.data.maySend));
r = await call(docsApi, `/api/documents?id=${selfId}`, { as: 'admin' });
ok('...though an admin can still close one whose writer has gone quiet', r.data.maySend === true);
r = await call(docsApi, '/api/documents?do=send', { method: 'POST', as: 'member', body: { id: selfId } });
ok('somebody who is not on the letter cannot say it has gone out', r.status === 403, String(r.status));
r = await call(docsApi, '/api/documents?do=send', {
  method: 'POST', as: 'oper2head', body: { id: selfId, to: 'คณะวิศวกรรมศาสตร์' } });
ok('the writer marks it sent themselves', r.status === 200 && r.data.stage === 'sent', JSON.stringify(r.data).slice(0, 80));
const sentRow = await sql`SELECT sent_by, send_mode FROM documents WHERE id = ${selfId}`;
ok('...and the letter records that they were the one who posted it',
  sentRow[0].sent_by === 'Ikkew_HeadOper1' && sentRow[0].send_mode === 'self', JSON.stringify(sentRow[0]));

// เลขานุการ still posts the ones that are theirs.
r = await call(docsApi, `/api/documents?id=${insideId}`, { as: 'admin' });
const insideSec = r.data.steps.find((st) => st.role === 'secretary');
ok('a เลขานุการ letter still ends on a secretary', Boolean(insideSec), JSON.stringify(r.data.steps.map((x) => x.role)));

await sql`DELETE FROM documents WHERE title IN ('หนังสือขอความอนุเคราะห์', 'หนังสือที่ส่งเอง')`;
await sql`UPDATE users SET is_head = false WHERE username = 'Fah_StaffCon'`;
await sql`INSERT INTO user_departments (username, department) VALUES
            ('Totti_HeadOp', 'oper1'), ('Totti_HeadOp', 'oper2'), ('Totti_HeadOp', 'oper3')
          ON CONFLICT DO NOTHING`;

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
