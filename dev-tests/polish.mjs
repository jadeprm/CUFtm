/**
 * The 2026-10-19c polish pass, in a browser:
 *
 *   dark mode — due chips follow the theme instead of staying pastel
 *   the list — group headers and the "รับผิดชอบ" badge are readable and quiet
 *   the phone — the floating + never covers the last row
 *   a first day — somebody with no tasks gets a "start here" card, not charts of zeros
 *   documents — the empty page says what it is for and offers the upload
 *   page weight — English and the QR library arrive only when needed
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
const DESK = { viewport: { width: 1440, height: 950 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function as(user, pass, opts, { home = false, scripts = null } = {}) {
  const ctx = await b.newContext(opts);
  if (home) await ctx.addCookies([{ name: 'fair-test-home', value: '1', url: `http://localhost:${PORT}/` }]);
  const pg = await ctx.newPage();
  if (scripts) pg.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url()); });
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(`${user}: ${m.text()}`); });
  pg.on('dialog', async (d) => { await d.accept(); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}
const go = async (pg, hash, wait = 1300) => { await pg.evaluate((h) => { location.hash = h; }, hash); await pg.waitForTimeout(wait); };
const iso = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() + n * 864e5));
const bg = (pg, sel) => pg.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
const dark = (rgb) => { const [r, g, bl] = (rgb.match(/\d+/g) || []).map(Number); return (r + g + bl) / 3 < 90; };

// ---- fixtures: tasks due tomorrow, in 3 days and in 12, all Jade's ---------
const scripts = [];
const jade = await as('Jade_Pres', 'fairAdmin1', DESK, { scripts });
await jade.evaluate(async ({ d }) => {
  const j = (u, o) => fetch(u, { ...o, headers: { 'content-type': 'application/json' } }).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) if (/^PL:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
  const mk = (body) => j('/api/tasks', { method: 'POST', body: JSON.stringify({ notify: [], assignees: ['Jade_Pres', 'Kungking_HeadCon'], ...body }) });
  await mk({ title: 'PL: พรุ่งนี้', dueDate: d.p1, status: 'review', priority: 'high' });
  await mk({ title: 'PL: สามวัน', dueDate: d.p3, status: 'doing' });
  await mk({ title: 'PL: สิบสองวัน', dueDate: d.p12, status: 'todo' });
}, { d: { p1: iso(1), p3: iso(3), p12: iso(12) } });

console.log('\n1. Page weight');
ok('a Thai sign-in loads neither the English strings nor the QR library',
  !scripts.some((u) => /i18n-en\.js|qrcode\.js/.test(u)), scripts.map((u) => u.split('/').pop()).join(', '));
await jade.click('#sidebar .lang-toggle button[data-lang="en"]'); await jade.waitForTimeout(1500);
ok('switching to English fetches the English strings once', scripts.filter((u) => /i18n-en\.js/.test(u)).length === 1);
ok('...and the page is then in English', /Home/.test(await jade.locator('#tabs a[data-page="home"] .tl').innerText()));
await jade.click('#sidebar .lang-toggle button[data-lang="th"]'); await jade.waitForTimeout(1200);
ok('...and back in Thai', /หน้าแรก/.test(await jade.locator('#tabs a[data-page="home"] .tl').innerText()));

console.log('\n2. The list, in light and dark');
await jade.evaluate(() => { try { localStorage.setItem('fair-work-view2', 'list'); } catch (e) {} });
await go(jade, '#/work', 1800);
const headInk = await jade.locator('.lg-head .st-pill').first().evaluate((el) => getComputedStyle(el).color);
ok('a group header is not white text on the status colour', headInk !== 'rgb(255, 255, 255)', headInk);
const badge = await jade.locator('.role-badge.role-named').first();
if (await badge.count()) {
  ok('"รับผิดชอบ" is the quiet badge, not filled pink', (await badge.evaluate((el) => getComputedStyle(el).backgroundColor)) !== 'rgb(200, 48, 111)');
}
await jade.emulateMedia({ colorScheme: 'dark' });
await jade.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await jade.waitForTimeout(400);
const chips = await jade.locator('.due-chip.u-now, .due-chip.u-soon, .due-chip.u-ahead').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
ok('in dark mode every urgency chip is dark too', chips.length >= 2 && chips.every(dark), chips.join(' '));
await jade.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

console.log('\n3. The phone');
const jPhone = await as('Jade_Pres', 'fairAdmin1', PHONE);
await jPhone.evaluate(() => { try { localStorage.setItem('fair-work-view2', 'list'); } catch (e) {} });
await go(jPhone, '#/work', 1800);
await jPhone.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await jPhone.waitForTimeout(500);
const fab = await jPhone.locator('#fab').boundingBox();
const last = await jPhone.locator('ul.list-view li.lrow').last().boundingBox();
ok('scrolled to the end, the last row sits above the + button', fab && last && last.y + last.height <= fab.y + 1,
  JSON.stringify({ rowBottom: last && Math.round(last.y + last.height), fabTop: fab && Math.round(fab.y) }));

console.log('\n4. A first day');
/**
 * Somebody genuinely empty-handed, made so here rather than assumed.
 *
 * This section needs a person with no work at all, and Fah is only that
 * person until another suite tags her in something (phonesweep does). The
 * fixture is built instead of hoped for, so the run order stops mattering.
 */
await jade.evaluate(async () => {
  const j = (u) => fetch(u).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) {
    const on = (t.named || t.assignees || []).concat(t.viewers || []);
    if (on.includes('Fah_StaffCon')) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
  }
});
const fah = await as('Fah_StaffCon', 'memberPw22', PHONE, { home: true });
await go(fah, '#/home', 1600);
ok('somebody with no tasks sees a "start here" card', await fah.locator('.hc-start').count() === 1);
ok('...first, above today', await fah.evaluate(() => document.querySelector('.home-grid').firstElementChild.classList.contains('hc-start')));
ok('...and no charts of zeros', await fah.locator('.hc-trend, .hc-status, .hc-ontime, .hc-days').count() === 0);
/**
 * This asserted the opposite until creation was opened to everybody. The
 * "start here" card is the first thing an empty-handed person sees, and a
 * สมาชิกฝ่าย with nothing on their plate is exactly who should be able to
 * put the first thing there. See run.mjs §102.
 */
ok('a สมาชิกฝ่าย with nothing on their plate is offered the first task',
  await fah.locator('.hc-start .btn.primary').count() === 1);
const jHome = await as('Jade_Pres', 'fairAdmin1', DESK, { home: true });
await go(jHome, '#/home', 1600);
ok('somebody with work still gets the charts', await jHome.locator('.hc-trend').count() === 1 && await jHome.locator('.hc-start').count() === 0);

console.log('\n5. Documents, empty');
await go(fah, '#/docs', 1600);
const empty = fah.locator('.empty').first();
ok('the empty page explains what documents are for', (await empty.locator('.empty-help').count()) === 1);
ok('...and offers the upload', (await empty.locator('button.btn.primary').count()) === 1);

// Tidy up.
await jade.evaluate(async () => {
  const j = (u) => fetch(u).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) if (/^PL:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
});

ok('no errors in the browser console', errs.length === 0, errs.slice(0, 5).join(' | '));
console.log(failed === 0 ? '\nALL POLISH CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed ? 1 : 0);
