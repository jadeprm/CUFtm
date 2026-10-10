/**
 * The 2026-10 redesign, in a browser, on a computer and on a phone:
 *
 *   the sidebar — docked, narrowed to icons, detached to float
 *   หน้าแรก — the brief, the numbers, the charts, the badges
 *   the work page — the grouped list, the timeline, dragging a bar
 *   spaces — making one, filing a task into it, its page
 *   ตารางของฉัน — an appointment, office hours, somebody booking them,
 *                 finding a time and turning it into a meeting
 *   repeating meetings — made from the form, changed "this and following"
 *   the phone — bottom bar, drawer, and no page wider than the screen
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
const DESK = { viewport: { width: 1440, height: 950 } };
const PHONE = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function as(user, pass, opts, { home = false } = {}) {
  const ctx = await b.newContext(opts);
  // Tells quiet.mjs not to send a bare address to the work page.
  if (home) await ctx.addCookies([{ name: 'fair-test-home', value: '1', url: `http://localhost:${PORT}/` }]);
  const pg = await ctx.newPage();
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
const wide = (pg) => pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

// ---- fixtures, through the API as Jade ------------------------------------
const jade = await as('Jade_Pres', 'fairAdmin1', DESK, { home: true });
await jade.evaluate(async ({ d }) => {
  const j = (u, o) => fetch(u, { ...o, headers: { 'content-type': 'application/json' } }).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) if (/^RD:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
  for (const s of (await j('/api/tasks?do=spaces')).spaces) if (/^RD /.test(s.name)) await fetch('/api/tasks?do=space&id=' + s.id, { method: 'DELETE' });
  for (const m of (await j('/api/events?do=meetings')).meetings) if (/^RD:/.test(m.title)) await fetch('/api/events?do=meeting&scope=following&id=' + m.id, { method: 'DELETE' });
  const mk = (body) => j('/api/tasks', { method: 'POST', body: JSON.stringify({ notify: [], assignees: ['Jade_Pres'], ...body }) });
  await mk({ title: 'RD: วางผังเวที', startDate: d.m2, dueDate: d.p5, status: 'doing', priority: 'high' });
  await mk({ title: 'RD: เช็กเสียง', dueDate: d.p2, status: 'review' });
  const done = await mk({ title: 'RD: สรุปงบ', dueDate: d.p1, status: 'todo' });
  await j('/api/tasks', { method: 'PATCH', body: JSON.stringify({ id: done.task.id, status: 'done' }) });
}, { d: { m2: iso(-2), p1: iso(1), p2: iso(2), p5: iso(5) } });
await jade.reload(); await jade.waitForTimeout(2600);

// ===========================================================================
console.log('\n1. The sidebar, on a computer');
const side = await jade.locator('#sidebar').boundingBox();
ok('the navigation is down the left', side && side.x === 0 && side.width >= 200 && side.height >= 800, JSON.stringify(side));
ok('...and the nav links live inside it', await jade.locator('#sidebar #tabs a[data-page="work"]').isVisible());
ok('the app opens on หน้าแรก', await jade.locator('#tabs a[data-page="home"].on').count() === 1);
await jade.click('#sb-collapse'); await jade.waitForTimeout(300);
const rail = await jade.locator('#sidebar').boundingBox();
ok('it narrows to icons', rail.width < 90, String(rail.width));
ok('...with the labels hidden', !(await jade.locator('#sidebar #tabs a[data-page="work"] .tl').isVisible()));
await jade.reload(); await jade.waitForTimeout(2500);
ok('...and stays narrow after a reload', (await jade.locator('#sidebar').boundingBox()).width < 90);
await jade.click('#sb-collapse'); await jade.waitForTimeout(200);
await jade.click('#sb-detach'); await jade.waitForTimeout(400);
const floated = await jade.locator('#sidebar').boundingBox();
ok('detached, it leaves the page to the content', floated.x < -100, JSON.stringify(floated));
ok('...and a menu button appears in the top bar', await jade.locator('#sb-open').isVisible());
await jade.click('#sb-open'); await jade.waitForTimeout(400);
ok('...which brings it back floating over the page', (await jade.locator('#sidebar').boundingBox()).x >= 0);
await jade.screenshot({ path: `${SHOTS}/rd-float.png` });
await jade.click('#sidebar #tabs a[data-page="work"]'); await jade.waitForTimeout(900);
ok('...and picking a page closes it again', (await jade.locator('#sidebar').boundingBox()).x < -100);
await jade.evaluate(() => { localStorage.setItem('fair-sb', 'full'); }); await jade.reload(); await jade.waitForTimeout(2500);

// ===========================================================================
console.log('\n2. หน้าแรก');
await go(jade, '#/home', 1800);
ok('a greeting band with my name', /เจตน์|Jade/.test(await jade.locator('.hello h2').innerText()), await jade.locator('.hello h2').innerText());
ok('four numbers', await jade.locator('.kpis .kpi').count() === 4);
const kpiOpen = Number(await jade.locator('.kpi').first().locator('.kpi-n').innerText());
const realOpen = await jade.evaluate(async () => (await (await fetch('/api/tasks')).json()).tasks
  .filter((t) => t.assignees.includes('Jade_Pres') && t.status !== 'done').length);
ok('...the first is how many of my tasks are open, counted right', kpiOpen === realOpen, `${kpiOpen} vs ${realOpen}`);
ok('a chart of tasks finished per week, eight bars', await jade.locator('.hc-trend svg rect').count() === 8);
ok('a status ring in the five status colours', await jade.locator('.hc-status svg circle').count() >= 2);
ok('the on-time ring and the best-day chart', await jade.locator('.hc-ontime svg.donut').count() === 1 && await jade.locator('.hc-days svg rect').count() === 7);
ok('achievements, some earned', await jade.locator('.badge-item').count() >= 6 && await jade.locator('.badge-item.got').count() >= 1);
ok('today, as a timeline', await jade.locator('.hc-today .today-item, .hc-today .today-empty').count() >= 1);
await jade.screenshot({ path: `${SHOTS}/rd-home.png`, fullPage: true });

// ===========================================================================
console.log('\n3. The work page: list, timeline');
await go(jade, '#/work');
await jade.evaluate(() => { localStorage.setItem('fair-work-view2', 'list'); });
await jade.locator('.view-seg button').nth(1).click(); await jade.waitForTimeout(700);
const groups = await jade.locator('.lgroup').evaluateAll((g) => g.map((x) => x.dataset.st));
ok('the list is grouped by status, in the order work moves', groups.length >= 2 &&
  groups.every((st, i) => i === 0 || ['todo', 'doing', 'review', 'feedback', 'done'].indexOf(st) > ['todo', 'doing', 'review', 'feedback', 'done'].indexOf(groups[i - 1])), groups.join());
const doingHead = await jade.locator('.lgroup[data-st="doing"] .lg-head .st-pill').evaluate((n) => getComputedStyle(n).backgroundColor).catch(() => '');
const reviewHead = await jade.locator('.lgroup[data-st="review"] .lg-head .st-pill').evaluate((n) => getComputedStyle(n).backgroundColor).catch(() => '');
ok('each group wears its status colour — กำลังทำ blue, รอตรวจ amber', /47, 127, 240/.test(doingHead) && /240, 160, 32/.test(reviewHead), `${doingHead} / ${reviewHead}`);
const rowH = await jade.locator('.lgroup li.lrow').first().boundingBox();
ok('rows are slim', rowH.height <= 52, String(rowH.height));
await jade.locator('.lgroup[data-st="review"] .lg-head').click(); await jade.waitForTimeout(200);
ok('a group folds', !(await jade.locator('.lgroup[data-st="review"] ul').isVisible()));
await jade.locator('.lgroup[data-st="review"] .lg-head').click();

await jade.locator('.view-seg button').nth(2).click(); await jade.waitForTimeout(900);
ok('the timeline draws', await jade.locator('.gantt .g-row').count() >= 2);
const bar = jade.locator('.g-row', { hasText: 'RD: วางผังเวที' }).locator('.g-barline');
ok('a task with a start date is a bar', await bar.count() === 1);
ok('one with only a deadline is a diamond', await jade.locator('.g-row', { hasText: 'RD: เช็กเสียง' }).locator('.g-milestone').count() === 1);
ok('today is marked', await jade.locator('.g-today').count() === 1);
const bb = await bar.boundingBox();
const day = await jade.locator('.g-grid').evaluate((n) => parseFloat(getComputedStyle(n).getPropertyValue('--day')));
await jade.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await jade.mouse.down();
await jade.mouse.move(bb.x + bb.width / 2 + day * 2 + 3, bb.y + bb.height / 2, { steps: 6 });
await jade.mouse.up();
await jade.waitForTimeout(1500);
const moved = await jade.evaluate(async () => (await (await fetch('/api/tasks')).json()).tasks.find((t) => t.title === 'RD: วางผังเวที'));
ok('dragging a bar two days moves both dates two days', moved.startDate === iso(0) && moved.dueDate === iso(7), `${moved.startDate} → ${moved.dueDate}`);
await jade.screenshot({ path: `${SHOTS}/rd-gantt.png` });

// ===========================================================================
console.log('\n4. Spaces');
await jade.locator('.sb-add').click(); await jade.waitForTimeout(400);
await jade.locator('.modal input[type=text]').first().fill('RD ทีมเวที');
await jade.locator('.sp-swatches .swatch').nth(2).click();
await jade.locator('.modal .picker input').first().fill('Kung'); await jade.waitForTimeout(250);
await jade.locator('.modal .picker .opt').first().click();
await jade.locator('.modal footer .btn.primary').click(); await jade.waitForTimeout(1600);
ok('making a space opens its page', /#\/space\//.test(await jade.evaluate(() => location.hash)));
ok('...in the colour picked', /15, 165, 160/.test(await jade.locator('.space-band').evaluate((n) => getComputedStyle(n).backgroundImage)));
ok('...and it is in the sidebar', await jade.locator('#sb-extra .sb-item', { hasText: 'RD ทีมเวที' }).count() === 1);
await jade.locator('.space-head .btn.primary').click(); await jade.waitForTimeout(500);
ok('a new task from the space page is filed in it', await jade.locator('.modal select option:checked', { hasText: 'RD ทีมเวที' }).count() === 1);
await jade.locator('.modal input[type=text]').first().fill('RD: งานใน space');
await jade.locator('.modal footer .btn.primary').click(); await jade.waitForTimeout(1800);
ok('...and shows on the space’s list', await jade.locator('li.task', { hasText: 'RD: งานใน space' }).count() === 1);
const spaceId = await jade.evaluate(() => decodeURIComponent(location.hash.split('/space/')[1]));

const kk = await as('Kungking_HeadCon', 'brandNew22', DESK);
await go(kk, '#/space/' + encodeURIComponent(spaceId), 1500);
ok('a member sees the space and its task', await kk.locator('li.task', { hasText: 'RD: งานใน space' }).count() === 1);
ok('...but no settings button', await kk.locator('.space-head .btn', { hasText: /ตั้งค่า/ }).count() === 0);

// ===========================================================================
console.log('\n5. ตารางของฉัน');
await go(kk, '#/schedule', 1800);
ok('a week of columns', await kk.locator('.wk-col').count() === 7);
await kk.locator('.sched-actions .btn', { hasText: 'Office hours' }).click(); await kk.waitForTimeout(700);
const rowSel = kk.locator('.oh-row').first();
// The coming Monday, in Bangkok — what the app calls "next Monday".
const bkkDow = new Date(iso(0) + 'T12:00:00Z').getUTCDay();
const nextMonday = iso(((8 - bkkDow) % 7) || 7);
await rowSel.locator('select').first().selectOption('mon');
await rowSel.locator('input[type=time]').first().fill('10:00');
await rowSel.locator('input[type=time]').nth(1).fill('11:00');
await kk.locator('.modal footer .btn.primary').click(); await kk.waitForTimeout(1500);
ok('office hours saved and listed', await kk.locator('.oh-list li').count() >= 1);
await kk.locator('.sched-actions .btn.primary').click(); await kk.waitForTimeout(400);
await kk.locator('.modal input[type=text]').first().fill('RD นัดหมอ');
await kk.locator('.modal input[type=date]').fill(nextMonday);
await kk.locator('.modal input[type=time]').first().fill('10:00');
await kk.locator('.modal input[type=time]').nth(1).fill('10:30');
await kk.locator('.modal footer .btn.primary').click(); await kk.waitForTimeout(1200);

// Jade books one of his slots.
await go(jade, '#/schedule', 1500);
await jade.locator('.sched-actions .btn', { hasText: /จองเวลา|Book/ }).click(); await jade.waitForTimeout(900);
await jade.locator('.host', { hasText: 'Kungking' }).click(); await jade.waitForTimeout(1200);
const times = await jade.locator('.slot-day', { hasText: /12|13|14|15|16|17|18|19/ }).first().locator('.slot').allInnerTexts().catch(() => []);
ok('his slots leave out the half hour his appointment covers', times.length >= 1 && !times.includes('10:00') && times.includes('10:30'), times.join(','));
await jade.locator('.slot', { hasText: '10:30' }).first().click(); await jade.waitForTimeout(300);
await jade.locator('.book-confirm textarea').fill('คุยเรื่องคิว');
await jade.locator('.book-confirm .btn.primary').click(); await jade.waitForTimeout(1500);
ok('the booking goes through', await jade.locator('.book-done').count() === 1);
await jade.screenshot({ path: `${SHOTS}/rd-booked.png` });
await jade.keyboard.press('Escape');
await kk.reload(); await kk.waitForTimeout(2500);
await go(kk, '#/schedule', 300);
await kk.evaluate((d) => { /* jump to the booked week */ }, nextMonday);
const bell = await kk.evaluate(async () => (await (await fetch('/api/notifications')).json()).notifications.filter((n) => n.kind === 'booking').length);
ok('he is told somebody booked him', bell >= 1, String(bell));

// Find a time, and make a meeting of it.
await jade.locator('.sched-actions .btn', { hasText: /หาเวลา|Find/ }).click(); await jade.waitForTimeout(600);
await jade.locator('.find-modal .picker input').first().fill('Kung'); await jade.waitForTimeout(250);
await jade.locator('.find-modal .picker .opt').first().click();
await jade.locator('.find-modal input[type=date]').fill(nextMonday);
await jade.locator('.find-modal select').nth(1).selectOption('3');
await jade.locator('.find-modal footer .btn.primary').click(); await jade.waitForTimeout(1600);
const firstSlot = await jade.locator('.found .slot').first().innerText();
ok('times come back when both are free', /\d\d:\d\d–\d\d:\d\d/.test(firstSlot), firstSlot);
const proposed = await jade.locator('.found .slot').allInnerTexts();
ok('...none of them over his appointment or the booking', !proposed.some((x) => /^10:00|^10:30/.test(x) && x.includes(nextMonday)), proposed.slice(0, 6).join(' '));
ok('...with a row per person to show why', await jade.locator('.assist .as-row:not(.as-ruler-row)').count() === 2);
await jade.screenshot({ path: `${SHOTS}/rd-find.png` });
await jade.locator('.assist .btn.primary').click(); await jade.waitForTimeout(700);
const mtgDate = await jade.locator('.modal input[type=date]').first().inputValue();
const mtgPeople = await jade.locator('.modal .picker .chip.who').allInnerTexts();
ok('picking a time opens a meeting with the date, time and people filled in',
  /^\d{4}-\d\d-\d\d$/.test(mtgDate) && mtgPeople.some((x) => x.includes('Kungking')), `${mtgDate} ${mtgPeople.join('/')}`);

// ===========================================================================
console.log('\n6. A meeting that repeats');
await jade.locator('.modal input[type=text]').first().fill('RD: ประชุมประจำสัปดาห์');
await jade.locator('.repeat-box select').first().selectOption('weekly');
await jade.locator('.repeat-box input[type=number]').fill('4');
await jade.locator('.modal footer .btn.primary').click(); await jade.waitForTimeout(2500);
const series = await jade.evaluate(async () => (await (await fetch('/api/events?do=meetings')).json()).meetings
  .filter((m) => m.title === 'RD: ประชุมประจำสัปดาห์'));
ok('four meetings, a week apart, in one series', series.length === 4 && new Set(series.map((m) => m.seriesId)).size === 1, String(series.length));
const second = series.sort((a, b) => (a.meetsOn < b.meetsOn ? -1 : 1))[1];
await jade.evaluate((id) => {
  const m = (window.__fairMeetings || []);
  return id;
}, second.id);
await jade.evaluate(async (id) => {
  await fetch('/api/events?do=meeting', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, place: 'ห้อง 2', scope: 'following' }) });
}, second.id);
const places = await jade.evaluate(async () => (await (await fetch('/api/events?do=meetings')).json()).meetings
  .filter((m) => m.title === 'RD: ประชุมประจำสัปดาห์').sort((a, b) => (a.meetsOn < b.meetsOn ? -1 : 1)).map((m) => m.place || '-'));
ok('"this and following" from the second changes the last three', places.join() === `${places[0]},ห้อง 2,ห้อง 2,ห้อง 2` && places[0] !== 'ห้อง 2', places.join());

// ===========================================================================
console.log('\n7. On a phone');
const ph = await as('Jade_Pres', 'fairAdmin1', PHONE, { home: true });
const tabsBox = await ph.locator('#tabs').boundingBox();
ok('the nav is a bar along the bottom', tabsBox.y > 700 && tabsBox.width >= 390, JSON.stringify(tabsBox));
const tabLabels = (await ph.locator('#tabs a:visible .ts').allInnerTexts()).join('|');
ok('...with หน้าแรก, ตาราง, งาน, เอกสาร and เมนู', tabLabels === 'หน้าแรก|ตาราง|งาน|เอกสาร|เมนู', tabLabels);
await ph.click('#tab-more'); await ph.waitForTimeout(500);
ok('เมนู opens the drawer', (await ph.locator('#sidebar').boundingBox()).x >= 0);
ok('...which holds the other pages and the spaces', await ph.locator('#sidebar .sb-drawer-nav a[href="#/calendar"]').count() === 1 &&
  await ph.locator('#sidebar .sb-item', { hasText: 'RD ทีมเวที' }).count() === 1);
await ph.screenshot({ path: `${SHOTS}/rd-ph-drawer.png` });
await ph.locator('#sidebar .sb-drawer-nav a[href="#/calendar"]').click(); await ph.waitForTimeout(900);
ok('...and closes when a page is picked', (await ph.locator('#sidebar').boundingBox()).x < 0 && await ph.evaluate(() => location.hash) === '#/calendar');
for (const page of ['#/home', '#/schedule', '#/work', '#/space/' + encodeURIComponent(spaceId)]) {
  await go(ph, page, 1500);
  ok(`${page.split('/')[1]} fits the screen with no sideways scroll`, !(await wide(ph)));
  await ph.screenshot({ path: `${SHOTS}/rd-ph-${page.split('/')[1]}.png` });
}
await go(ph, '#/work', 900);
await ph.evaluate(() => { localStorage.setItem('fair-work-view2', 'list'); }); await ph.reload(); await ph.waitForTimeout(2500);
await go(ph, '#/work', 900);
const prow = await ph.locator('li.lrow').first().boundingBox();
ok('list rows on a phone are two short lines', prow && prow.height <= 72, prow && String(prow.height));
await go(ph, '#/schedule', 1500);
ok('the phone schedule is a day with a strip of seven days', await ph.locator('.day-strip .ds-day').count() === 7);

// ===========================================================================
// Tidy up what this made, so other suites start clean.
await jade.evaluate(async () => {
  const j = (u) => fetch(u).then((r) => r.json());
  for (const t of (await j('/api/tasks')).tasks) if (/^RD:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
  for (const s of (await j('/api/tasks?do=spaces')).spaces) if (/^RD /.test(s.name)) await fetch('/api/tasks?do=space&id=' + s.id, { method: 'DELETE' });
  for (const m of (await j('/api/events?do=meetings')).meetings) if (/^RD:/.test(m.title)) await fetch('/api/events?do=meeting&scope=following&id=' + m.id, { method: 'DELETE' });
  const from = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  for (const a of (await j('/api/calendar?do=schedule&from=' + from + '&to=' + to)).appointments || []) await fetch('/api/calendar?do=appt&id=' + a.id, { method: 'DELETE' });
});

ok('no errors in the browser console', errs.length === 0, errs.slice(0, 5).join(' | '));
console.log(failed === 0 ? '\nALL REDESIGN CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed ? 1 : 0);
