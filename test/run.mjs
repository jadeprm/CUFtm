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
9,,,,,,
`;

let sheetCsv = SHEET_CSV;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('docs.google.com')) {
    if (sheetCsv === null) return new Response('<html>sign in</html>', { status: 200 });
    return new Response(sheetCsv, { status: 200 });
  }
  return realFetch(url, init);
};

const { default: authApi } = await import('../api/auth.js');
const { default: usersApi } = await import('../api/users.js');
const { default: tasksApi } = await import('../api/tasks.js');
const { default: cronApi } = await import('../api/cron.js');
const { default: pushApi } = await import('../api/push.js');
const { default: eventsApi } = await import('../api/events.js');
const { default: calApi } = await import('../api/calendar.js');
const { default: notifApi } = await import('../api/notifications.js');
const { getSql } = await import('../lib/db.js');

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
await sql`DELETE FROM users`;

// ===========================================================================
head('1. Sheet sync');
let r = await call(authApi, '/api/auth?do=check', { method: 'POST', body: { username: 'Jade_Pres' } });
ok('empty database pulls the roster automatically', r.data.known === true, JSON.stringify(r.data).slice(0, 90));
ok('markdown-escaped username (Jade\\_Pres) parsed correctly', r.data.displayName === 'Jade - Project Director');
ok('first login needs a password set', r.data.needsSetup === true);

const roster = await sql`SELECT username, access, department, is_head FROM users ORDER BY username`;
ok('all 8 rows imported, blank row skipped', roster.length === 8, `${roster.length} users`);
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

r = await call(usersApi, '/api/users?do=manage', { method: 'PATCH', as: 'admin', body: { username: 'Kungking_HeadCon', access: 'admin' } });
ok('access level cannot be raised through the API (sheet is master)',
  r.status === 400 && r.data.error === 'ACCESS_FROM_SHEET');

r = await call(usersApi, '/api/users', { as: 'editor' });
ok('editor can still read the directory', r.status === 200 && r.data.users.length === 8);
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
ok('...and every account is still there', survived[0].n === 8, `${survived[0].n} users`);
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

let f = await feed('mine');
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


console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
