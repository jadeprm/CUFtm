/**
 * Viewers on a task, in the browser.
 *
 * Whoever sets a task up can name people to follow it without doing it; the
 * picker never offers somebody already on the task; and the viewer finds it
 * in their own list, marked as one they follow, with the status locked.
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

async function as(user, pass, opts) {
  const ctx = await b.newContext(opts);
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('dialog', async (d) => { await d.accept(); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.evaluate(() => { try { localStorage.setItem('fair-work-view', 'list'); } catch (e) {} });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2800);
  return pg;
}

const TITLE = 'ติดตาม: ตรวจแบบบูธ';
console.log('\nSetting a task up with a viewer');
const pg = await as('Jade_Pres', 'fairAdmin1', { viewport: { width: 1440, height: 950 } });
await pg.evaluate(async (title) => {
  const d = await fetch('/api/tasks').then((r) => r.json());
  for (const t of d.tasks) if (t.title.startsWith(title.slice(0, 7))) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
}, TITLE);
await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(2000);
await pg.locator('#main .btn.primary', { hasText: 'งานใหม่' }).first().click();
await pg.waitForTimeout(600);
const dlg = pg.locator('#modal-root .modal').last();
await dlg.locator('input[type="text"]').first().fill(TITLE);

const viewerField = dlg.locator('.field', { has: pg.locator('.picker.viewers') });
ok('the task form has a viewers box', (await viewerField.count()) === 1);
ok('...explaining what a viewer is', (await viewerField.locator('.field-hint').innerText()).includes('ไม่ได้รับผิดชอบ'));
const vSearch = viewerField.locator('.search input');
await vSearch.fill('Jade');
await pg.waitForTimeout(200);
ok('somebody already on the task is not offered as a viewer',
  (await viewerField.locator('.options .opt').count()) === 0);
await vSearch.fill('Ploy');
await pg.waitForTimeout(200);
await viewerField.locator('.options .opt').first().click();
await pg.waitForTimeout(200);
ok('picking someone adds them as a viewer',
  (await viewerField.locator('.selected .chip.who').count()) === 1);

// Put her on the task as well: she drops off the viewers.
const doers = dlg.locator('.field', { has: pg.locator('.picker:not(.viewers)') }).first();
await doers.locator('.search input').fill('Ploy');
await pg.waitForTimeout(200);
await doers.locator('.options .opt').first().click();
await pg.waitForTimeout(200);
ok('putting a viewer on the task takes them off the viewers',
  (await viewerField.locator('.selected .chip.who').count()) === 0);
// …and back again.
await doers.locator('.selected .chip.who', { hasText: 'Ploy' }).first().click().catch(async () => {
  await doers.locator('.selected .chip.who').last().click();
});
await pg.waitForTimeout(200);
await vSearch.fill('Ploy'); await pg.waitForTimeout(200);
await viewerField.locator('.options .opt').first().click(); await pg.waitForTimeout(200);
await pg.screenshot({ path: '/tmp/claude-0/viewers-form.png' });
await dlg.locator('footer .btn.primary').click();
await pg.waitForTimeout(2500);
// A clash question, if any, is answered "go ahead".
if (await pg.locator('#modal-root .modal').count()) {
  const go = pg.locator('#modal-root .modal footer .btn.primary');
  if (await go.count()) { await go.first().click(); await pg.waitForTimeout(2000); }
}
const saved = await pg.evaluate(async (title) =>
  (await fetch('/api/tasks').then((r) => r.json())).tasks.find((t) => t.title === title), TITLE);
ok('saved with her as a viewer, not as one of the people doing it',
  saved && saved.viewers.join() === 'Ploy_StaffCon' && !saved.assignees.includes('Ploy_StaffCon'),
  saved && JSON.stringify({ v: saved.viewers, a: saved.assignees }));
await pg.evaluate(() => { location.hash = '#/all'; }); await pg.waitForTimeout(1200);
ok('the creator\'s card shows how many are following',
  (await pg.locator('li.task', { hasText: TITLE }).locator('.chip.viewers-n').count()) === 1);

console.log('\nThe viewer, on a phone');
const ph = await as('Ploy_StaffCon', 'memberPw11',
  { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
await ph.evaluate(() => { location.hash = '#/'; }); await ph.waitForTimeout(1500);
const card = ph.locator('li.task', { hasText: TITLE });
ok('it is in her own list', (await card.count()) === 1);
ok('...marked as one she follows', (await card.locator('.chip.watching').count()) === 1);
ok('...with the status locked', (await card.locator('.status-btn.locked').count()) === 1);
await ph.screenshot({ path: '/tmp/claude-0/viewers-list.png' });
await card.locator('.t-title').click(); await ph.waitForTimeout(900);
ok('opening it says she is following it, view only',
  (await ph.locator('#modal-root .watching-note').count()) === 1);
ok('...with no status buttons and no edit button',
  (await ph.locator('#modal-root .view-quick').count()) === 0 &&
  (await ph.locator('#modal-root footer .btn', { hasText: 'แก้ไข' }).count()) === 0);
ok('...and the viewers listed on the task', (await ph.locator('#modal-root .view-rows').innerText()).includes('ผู้ติดตาม'));
await ph.screenshot({ path: '/tmp/claude-0/viewers-open.png' });

// The board, too: her followed card is there and cannot be moved.
await ph.locator('#modal-root .modal header button').last().click().catch(() => {});
await ph.evaluate(() => { localStorage.setItem('fair-work-view', 'board'); });
await ph.reload({ waitUntil: 'networkidle' }); await ph.waitForTimeout(2200);
ok('on the board it sits in its column with the rest of her work',
  (await ph.locator('.kanban li.task', { hasText: TITLE }).count()) === 1);
await ph.evaluate(() => { localStorage.setItem('fair-work-view', 'list'); });

await pg.evaluate(async (id) => { await fetch('/api/tasks?id=' + id, { method: 'DELETE' }); }, saved && saved.id);

console.log(errs.length ? '\nerrors:\n' + errs.join('\n') : '\nno page errors');
if (errs.length) failed += errs.length;
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
