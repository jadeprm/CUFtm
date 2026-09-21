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
const SHEET_CSV = `ลำดับ,ชื่อเล่น,Username,Display Name,ตำแหน่ง,Access,Profile Picture
1,เจตน์,Jade\\_Pres,Jade - Project Director,ประธานโครงการ,Admin,
2,แก้ว,Kaew_VP,Keaw - Deputy Project Director,รองประธานโครงการ,Co-Admin,
3,กร,Gorn_VP,Gorn - Deputy Project Director,รองประธานโครงการ,Co-Admin,
4,ต๊อดติ,Totti_HeadOp,Totti - Head Operation,ประธานฝ่ายอำนวยการใหญ่,Co-Admin,
5,กุ๊งกิ๊ง,Kungking_HeadCon,Kungking - Head Content,ประธานฝ่ายเนื้อหา,Editor,
6,กล้วยหอม,Kluayhom_HeadMerchant,Kluayhom - Head Merchant,ประธานฝ่ายร้านค้า,Editor,
7,อิคคิว,Ikkew_HeadOper1,Ikkew - Head Operation 1,ประธานฝ่ายอำนวยการ 1,Editor,
8,แยม,Yam_HeadSpon,Yam - Head Sponsor,ประธานฝ่ายหาทุน,Editor,
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
ok('operations head detected', byName.Ikkew_HeadOper1.department === 'operations' && byName.Ikkew_HeadOper1.is_head === true);
ok('merchant head detected', byName.Kluayhom_HeadMerchant.department === 'merchant');

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

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
