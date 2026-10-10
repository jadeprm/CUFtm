/**
 * Three things asked for together:
 *   1. every task says what it is to me — รับผิดชอบ / ได้รับผ่านฝ่าย / ติดตาม
 *   2. notifications: แจ้งเตือน / เงียบ / ปิด, per category and per task
 *   3. "ที่กำลังจะถึง" as a compact agenda instead of big boxes
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0;
const errs = [];
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};
const SHOTS = '/tmp/claude-0';

async function as(user, pass, opts) {
  const ctx = await b.newContext(opts);
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('dialog', async (d) => { await d.accept(); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.evaluate(() => { try { localStorage.setItem('fair-work-view2', 'list'); } catch (e) {} });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2800);
  return pg;
}
const DESK = { viewport: { width: 1440, height: 950 } };
const PHONE = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true };

// Fixtures, made by Jade: one task naming Kungking, one tagging his department,
// one he only follows; and enough meetings and events to need folding.
const jade = await as('Jade_Pres', 'fairAdmin1', DESK);
const made = await jade.evaluate(async () => {
  const j = (u, o) => fetch(u, { ...o, headers: { 'content-type': 'application/json' } }).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) if (/^บท:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
  for (const e of (await j('/api/events')).events || []) if (/^วาระ:/.test(e.title)) await fetch('/api/events?id=' + e.id, { method: 'DELETE' });
  const d = (n) => { const x = new Date(Date.now() + n * 864e5); return [x.getFullYear(), String(x.getMonth() + 1).padStart(2, '0'), String(x.getDate()).padStart(2, '0')].join('-'); };
  const mk = async (body) => (await j('/api/tasks', { method: 'POST', body: JSON.stringify({ notify: [], ...body }) })).task.id;
  const ids = {
    named: await mk({ title: 'บท: ชื่อฉันเอง', assignees: ['Kungking_HeadCon'], dueDate: d(2) }),
    dept: await mk({ title: 'บท: ผ่านฝ่าย', assignees: ['Jade_Pres'], departments: [{ key: 'content', scope: 'heads' }], dueDate: d(3) }),
    watch: await mk({ title: 'บท: แค่ติดตาม', assignees: ['Jade_Pres'], viewers: ['Kungking_HeadCon'], dueDate: d(4) }),
  };
  for (let i = 0; i < 6; i++) {
    await j('/api/events', { method: 'POST', body: JSON.stringify({ title: 'วาระ: กิจกรรมที่ ' + (i + 1), startsOn: d(i % 3), allDay: i % 2 === 0, startsAt: i % 2 ? '14:00' : null, place: 'หอประชุม', notify: [] }) });
  }
  return ids;
});
await jade.context().close();

// ===========================================================================
console.log('\n1. What each task is to me — on a computer');
const kk = await as('Kungking_HeadCon', 'brandNew22', DESK);
await kk.evaluate(() => { location.hash = '#/work'; }); await kk.waitForTimeout(1200);
const badge = async (title) => {
  const li = kk.locator('li.task', { hasText: title }).first();
  if (!(await li.count())) return null;
  return li.locator('.role-badge').evaluate((n) => n.className + '|' + n.textContent).catch(() => null);
};
const b1 = await badge('บท: ชื่อฉันเอง');
const b2 = await badge('บท: ผ่านฝ่าย');
const b3 = await badge('บท: แค่ติดตาม');
ok('a task naming me says รับผิดชอบ', b1 && b1.includes('role-named') && b1.includes('รับผิดชอบ'), b1);
ok('a task my department was tagged on says ได้รับผ่านฝ่าย', b2 && b2.includes('role-dept') && b2.includes('ผ่านฝ่าย'), b2);
ok('a task I only follow says ติดตาม', b3 && b3.includes('role-watch') && b3.includes('ติดตาม'), b3);
const look = await kk.locator('li.task', { hasText: 'บท: ชื่อฉันเอง' }).first().locator('.role-badge')
  .evaluate((n) => getComputedStyle(n).backgroundColor);
const look3 = await kk.locator('li.task', { hasText: 'บท: แค่ติดตาม' }).first().locator('.role-badge')
  .evaluate((n) => getComputedStyle(n).backgroundColor);
ok('...and they look different, not just read different', look !== look3, `${look} vs ${look3}`);
ok('the badge leads the title, before the code', await kk.locator('li.task', { hasText: 'บท: ชื่อฉันเอง' }).first()
  .locator('.t-title > :first-child').evaluate((n) => n.classList.contains('role-badge')));

// The filter
const seg = kk.locator('.role-tabs');
ok('there is a way to show only one kind', (await seg.count()) === 1);
await seg.locator('button[data-role="watch"]').click(); await kk.waitForTimeout(500);
const onlyWatch = await kk.locator('ul.tasks li.task').evaluateAll((els) => els.map((e) => e.querySelector('.role-badge')?.className || ''));
ok('ติดตาม shows only the tasks I follow', onlyWatch.length >= 1 && onlyWatch.every((c) => c.includes('role-watch')), String(onlyWatch.length));
await seg.locator('button[data-role="dept"]').click(); await kk.waitForTimeout(500);
const onlyDept = await kk.locator('ul.tasks li.task').evaluateAll((els) => els.map((e) => e.querySelector('.role-badge')?.className || ''));
ok('ได้รับผ่านฝ่าย shows only those', onlyDept.length >= 1 && onlyDept.every((c) => c.includes('role-dept')), String(onlyDept.length));
await seg.locator('button[data-role="all"]').click(); await kk.waitForTimeout(500);
await kk.screenshot({ path: `${SHOTS}/roles-desk.png` });

// Inside the task: the role, and who is there how.
await kk.locator('li.task', { hasText: 'บท: ผ่านฝ่าย' }).first().locator('.t-title').click(); await kk.waitForTimeout(800);
const rows = await kk.locator('#modal-root .view-rows').innerText();
ok('the task says my role in words', rows.includes('บทบาทของคุณ') && rows.includes('ฝ่ายของคุณถูกแท็ก'), rows.slice(0, 120));
ok('...and lists the department people apart from the people named',
  rows.includes('ผู้รับผิดชอบ') && /ได้รับผ่านฝ่าย[\s\S]*Kungking/.test(rows));

// ===========================================================================
console.log('\n2. Notifications — one task');
const ctl = kk.locator('#modal-root .notify-ctl');
ok('the task has its own notification switch', (await ctl.count()) === 1);
ok('...starting at "as my settings", which it names', (await ctl.locator('button.on').innerText()).includes('ตามการตั้งค่า'));
await ctl.locator('button[data-level="off"]').click(); await kk.waitForTimeout(900);
ok('choosing ปิด lights it', (await ctl.locator('button.on').getAttribute('data-level')) === 'off');
const saved = await kk.evaluate(async () => (await fetch('/api/users?do=notify').then((r) => r.json())).items);
ok('...and it is saved', saved.some((i) => i.scope === 'task' && i.id && i.level === 'off'), JSON.stringify(saved));
await kk.screenshot({ path: `${SHOTS}/notify-task.png` });
await kk.locator('#modal-root .modal header button').last().click(); await kk.waitForTimeout(300);

console.log('\n2. Notifications — the settings page');
await kk.evaluate(() => { location.hash = '#/profile'; }); await kk.waitForTimeout(1500);
const cats = kk.locator('.notify-cat');
ok('the profile lists every category', (await cats.count()) === 8, String(await cats.count()));
const watchCat = kk.locator('.notify-cat[data-cat="task_watch"]');
ok('tasks I follow start เงียบ', (await watchCat.locator('button.on').getAttribute('data-level')) === 'quiet');
await kk.locator('.notify-cat[data-cat="event"] button[data-level="quiet"]').click(); await kk.waitForTimeout(900);
ok('switching events to เงียบ sticks', (await kk.locator('.notify-cat[data-cat="event"] button.on').getAttribute('data-level')) === 'quiet');
ok('the one-off setting from the task is listed by name',
  (await kk.locator('.notify-items li', { hasText: 'บท: ผ่านฝ่าย' }).count()) === 1);
await kk.locator('#notify-settings').scrollIntoViewIfNeeded();
await kk.locator('#notify-settings').screenshot({ path: `${SHOTS}/notify-settings.png` });
await kk.locator('.notify-items li', { hasText: 'บท: ผ่านฝ่าย' }).locator('button').click(); await kk.waitForTimeout(900);
ok('...and can be removed from there', (await kk.locator('.notify-items li', { hasText: 'บท: ผ่านฝ่าย' }).count()) === 0);
await kk.locator('.notify-cat[data-cat="event"] button[data-level="all"]').click(); await kk.waitForTimeout(700);

// ===========================================================================
console.log('\n3. Coming up, as an agenda');
await kk.evaluate(() => { location.hash = '#/all'; }); await kk.waitForTimeout(1500);
const up = kk.locator('.upcoming');
ok('the coming-up section is there', (await up.count()) === 1);
const nRows = await up.locator('.up-row').count();
ok('it shows four rows to begin with', nRows === 4, String(nRows));
const heights = await up.locator('.up-row').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
ok('each row is slim — one line, not a box', heights.every((x) => x <= 46), heights.join(','));
ok('rows are grouped by day', (await up.locator('.up-group').count()) >= 1);
ok('each says what it is: ประชุม or กิจกรรม', (await up.locator('.up-kind').allInnerTexts()).every((x) => /ประชุม|กิจกรรม/.test(x)));
const total = await up.locator('.up-more').innerText();
await up.locator('.up-more').click(); await kk.waitForTimeout(400);
ok('ดูทั้งหมด unfolds the rest', (await up.locator('.up-row').count()) > 4, `${total} → ${await up.locator('.up-row').count()}`);
await up.locator('.up-more').click(); await kk.waitForTimeout(300);
const deskBox = await up.boundingBox();
ok('the whole section is short on a computer', deskBox.height < 260, `${Math.round(deskBox.height)}px`);
await up.locator('.up-row.event').first().click(); await kk.waitForTimeout(800);
ok('tapping a row opens it', (await kk.locator('#modal-root .modal').count()) === 1);
await kk.locator('#modal-root .modal header button').last().click(); await kk.waitForTimeout(300);
await kk.screenshot({ path: `${SHOTS}/upcoming-desk.png`, clip: { x: 0, y: 0, width: 1440, height: 520 } });

// ===========================================================================
console.log('\nOn a phone');
const ph = await as('Kungking_HeadCon', 'brandNew22', PHONE);
await ph.evaluate(() => { location.hash = '#/work'; }); await ph.waitForTimeout(1500);
ok('the role tabs are there on a phone', (await ph.locator('.ph-roles button').count()) === 4);
ok('cards carry the badge on a phone too',
  (await ph.locator('li.task', { hasText: 'บท: แค่ติดตาม' }).first().locator('.role-badge.role-watch').count()) === 1);
const phUp = await ph.locator('.upcoming').boundingBox();
ok('coming up takes little of the screen', phUp && phUp.height < 240, phUp && `${Math.round(phUp.height)}px`);
ok('nothing scrolls sideways', await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await ph.screenshot({ path: `${SHOTS}/phone-mine.png` });
await ph.evaluate(() => { location.hash = '#/profile'; }); await ph.waitForTimeout(1500);
await ph.locator('#notify-settings').scrollIntoViewIfNeeded();
await ph.screenshot({ path: `${SHOTS}/phone-notify.png` });
ok('the settings fit the phone', await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

// Tidy.
await kk.evaluate(async () => {
  const j = (u) => fetch(u).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) if (/^บท:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
});
const tidy = await as('Jade_Pres', 'fairAdmin1', DESK);
await tidy.evaluate(async () => {
  const j = (u) => fetch(u).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) if (/^บท:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
  for (const e of (await j('/api/events')).events || []) if (/^วาระ:/.test(e.title)) await fetch('/api/events?id=' + e.id, { method: 'DELETE' });
});
void made;

console.log(errs.length ? '\nerrors:\n' + errs.join('\n') : '\nno page errors');
if (errs.length) failed += errs.length;
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
