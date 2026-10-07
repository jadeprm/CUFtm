/**
 * Every page and every dialog, photographed the way a phone sees it.
 *
 *   node phonesweep.mjs <outdir> [port]
 *
 * Not a test — a camera. Used before and after the phone redesign so the two
 * can be put side by side, and so nothing gets redesigned from memory.
 *
 * The safe areas are simulated: Chromium does not emulate an iPhone's notch or
 * home indicator, so env(safe-area-inset-*) is always 0 here. The phone layer
 * reads them through --sa-top / --sa-bottom, which this overrides to the real
 * iPhone 15 values — so anything that would sit under the home indicator on a
 * real phone sits under the painted bar here too, where it can be seen.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || '/tmp/claude-0/sweep';
const PORT = process.argv[3] || '4700';
mkdirSync(OUT, { recursive: true });

const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const ctx = await b.newContext({
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  colorScheme: process.env.DARK ? 'dark' : 'light',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
pg.on('dialog', async (d) => { await d.dismiss(); });

/** The iPhone's own furniture, painted on so nothing can hide under it unseen. */
async function paintSafeAreas() {
  await pg.addStyleTag({ content: `
    :root { --sa-top: 47px !important; --sa-bottom: 34px !important; }
    body::before, body::after { content: ''; position: fixed; left: 0; right: 0; z-index: 2147483647;
      pointer-events: none; background: rgba(0,0,0,.18); }
    body::before { top: 0; height: 47px; }
    body::after { bottom: 0; height: 34px; }` });
}

let n = 0;
async function shot(name, { full = false } = {}) {
  n += 1;
  const file = `${OUT}/${String(n).padStart(2, '0')}-${name}.png`;
  await pg.screenshot({ path: file, fullPage: full });
  console.log('  ' + file);
}
async function closeAll() {
  await pg.evaluate(() => document.querySelectorAll('#modal-root .veil').forEach((v) => v.remove()));
  await pg.waitForTimeout(200);
}
async function go(hash) {
  await closeAll();
  await pg.evaluate((h) => { location.hash = h; }, hash);
  await pg.waitForTimeout(1600);
}
async function tap(locator) {
  const el = typeof locator === 'string' ? pg.locator(locator).first() : locator;
  if (!(await el.count())) return false;
  await el.click({ timeout: 4000 }).catch(() => {});
  await pg.waitForTimeout(1200);
  return true;
}

await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await paintSafeAreas();
await shot('signin');
await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
await pg.fill('#in-password', 'fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2800);

/**
 * Data shaped like the committee's real screens: a task with ten people on it
 * and a paragraph of description, because that is what made the detail view
 * unusable in the screenshot Jade sent — a one-person test task hides it.
 */
await pg.evaluate(async () => {
  const j = (u, o) => fetch(u, { ...o, headers: { 'content-type': 'application/json' } }).then((r) => r.json());
  const all = await j('/api/tasks');
  if (!all.tasks.some((t) => t.title === 'เตรียมเนื้อหาเพื่อรวมกับ tmr fest')) {
    const people = (await j('/api/users')).users.filter((u) => u.active).slice(0, 10).map((u) => u.username);
    const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    await j('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: 'เตรียมเนื้อหาเพื่อรวมกับ tmr fest', priority: 'high', dueDate: due, dueTime: '18:00',
      description: '- ประสานงานกับฝ่ายเนื้อหา - คุยกับอาจารย์ไวท์ - ประสานกับสถานที่',
      assignees: people, notify: [] }) });
  }
});
await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(2600);
await paintSafeAreas();

console.log('pages');
await go('#/work'); await shot('work');
await shot('work-full', { full: true });
await go('#/calendar'); await shot('calendar');
await go('#/docs'); await shot('docs');
await go('#/announce'); await shot('announce');
await go('#/admin'); await shot('admin');
await shot('admin-full', { full: true });
await go('#/profile'); await shot('profile');
await shot('profile-full', { full: true });
await go('#/links'); await shot('links');

console.log('dialogs');
await go('#/work');
if (await tap(pg.locator('li.task, .t-row', { hasText: 'tmr fest' }))) {
  await shot('task-detail');
  await pg.locator('#modal-root .veil .body').last().evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
  await pg.waitForTimeout(300);
  await shot('task-detail-bottom');
}
/**
 * Making things goes through the + button and the sheet it opens — on a phone
 * that is the only way in, so it is the way the camera goes in too.
 */
async function fromFab(label, name, after) {
  await go('#/work');
  if (!(await tap('#fab'))) return;
  if (name === 'create-sheet') { await shot(name); return; }
  if (await tap(pg.locator('#modal-root .act', { hasText: label }))) {
    await shot(name);
    if (after) await after();
  }
}
await fromFab(null, 'create-sheet');
await fromFab(/งานใหม่|New task/, 'task-new');
await fromFab(/นัดประชุม/, 'meeting-new', async () => {
  await pg.locator('#modal-root .veil .body').last().evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
  await pg.waitForTimeout(300);
  await shot('meeting-new-bottom');
});
await fromFab(/กิจกรรม/, 'event-new');
await fromFab(/นำเข้า/, 'import');
await go('#/work');
if (await tap(pg.locator('.ph-filter'))) await shot('filters');
await go('#/work');
if (await tap(pg.locator('.event-card.meeting').first())) await shot('meeting-view');
await go('#/docs');
if (await tap('#fab')) await shot('doc-upload');
await go('#/docs');
if (await tap(pg.locator('.doc-card').first())) {
  await shot('doc-view');
  await pg.locator('#modal-root .veil .body').last().evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
  await pg.waitForTimeout(300);
  await shot('doc-view-bottom');
}
await go('#/docs');
if (await tap(pg.locator('#main .page-head button', { hasText: /เลขานุการ/ }).first())) await shot('secretaries');
await go('#/work');
if (await tap(pg.locator('.event-card:not(.meeting)').first())) await shot('event-view');
await go('#/links');
if (await tap(pg.locator('#main button', { hasText: /QR/ }).first())) await shot('qr');
await go('#/work');
await closeAll();
if (await tap('#bell-btn')) {
  if (await tap(pg.locator('#bell-items .item').first())) await shot('notification');
}
await go('#/work');
await closeAll();
if (await tap('#bell-btn')) await shot('bell');
await pg.mouse.click(5, 300); await pg.waitForTimeout(300);
if (await tap('#me-avatar')) await shot('me-menu');

console.log(errs.length ? '\nerrors:\n' + errs.join('\n') : '\nno page errors');
await b.close();
