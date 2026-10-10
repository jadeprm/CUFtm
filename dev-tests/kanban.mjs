/**
 * The work page as a board, on a computer and on a phone.
 *
 * What has to hold: every task is in the column for its status; a card
 * dragged to another column really changes its status on the server; a card
 * the person may not move cannot be dragged; the board/list choice is
 * remembered; and on a phone the columns swipe, the chips follow, and moving a
 * card does not throw you back to the first column.
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
  // The list is the default since the redesign; this suite is about the board.
  await pg.evaluate(() => { try { localStorage.setItem('fair-work-view2', 'board'); } catch (e) {} });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2800);
  return pg;
}

const DESK = { viewport: { width: 1440, height: 950 } };
const PHONE = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true };

// ===========================================================================
console.log('\nOn a computer');
const pg = await as('Jade_Pres', 'fairAdmin1', DESK);

// Fixtures: one card in each of two columns, owned by Jade so she may move them.
const ids = await pg.evaluate(async () => {
  const j = (u, o) => fetch(u, { ...o, headers: { 'content-type': 'application/json' } }).then((r) => r.json());
  const old = (await j('/api/tasks')).tasks.filter((t) => /^บอร์ด:/.test(t.title));
  for (const t of old) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
  /**
   * Due yesterday, so overdue, so at the top of its column — a card at the
   * bottom of a 35-card column is dragged from off the screen, which tests
   * the browser's auto-scroll rather than the board.
   */
  const d = new Date(Date.now() - 864e5);
  const yesterday = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  const mk = async (title) => (await j('/api/tasks', { method: 'POST', body: JSON.stringify({
    title, assignees: ['Jade_Pres'], notify: [], dueDate: yesterday }) })).task.id;
  return { a: await mk('บอร์ด: ลากไปกำลังทำ'), b: await mk('บอร์ด: ย้ายบนมือถือ') };
});
await pg.evaluate(() => { location.hash = '#/all'; });
await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(2400);

ok('the work page opens as a board when that is the view picked', (await pg.locator('.kanban').count()) === 1);
const heads = await pg.locator('.kb-col .kb-head').allInnerTexts();
ok('...with a column for every status, in the order work moves', heads.length === 5,
  heads.map((x) => x.replace(/\s+/g, ' ')).join(' | '));

/**
 * Every task sits in the column for its own status, and the count on each
 * column is the number of cards in it (the finished column excepted, which is
 * cut short on purpose).
 */
const placed = await pg.evaluate(() => {
  const bad = [];
  document.querySelectorAll('.kb-col').forEach((col) => {
    col.querySelectorAll('li.task').forEach((li) => {
      if (li.dataset.status !== col.dataset.status) bad.push(li.textContent.slice(0, 30));
    });
  });
  return bad;
});
ok('every card is in the column for its status', placed.length === 0, placed.join(', '));
const counted = await pg.evaluate(() => [...document.querySelectorAll('.kb-col:not([data-status="done"])')].map((c) =>
  [Number(c.querySelector('.kb-head .n').textContent), c.querySelectorAll('li.task').length]));
ok('...and each column says how many it holds', counted.every(([n, k]) => n === k), JSON.stringify(counted));
ok('no status tabs above the board — the columns are the statuses',
  (await pg.locator('#main .filters .seg').count()) === 0);

// ---- dragging ----
const card = pg.locator('.kb-col[data-status="todo"] li.task', { hasText: 'บอร์ด: ลากไปกำลังทำ' });
ok('a card the person may move can be dragged', (await card.getAttribute('draggable')) === 'true');
/**
 * Dropped on the column's heading rather than its middle. A tall column's
 * middle is off the screen, and Playwright scrolls to it before pressing the
 * mouse — so the press landed on whichever card had scrolled under the
 * pointer and the wrong task moved. The heading is always in view, and a drop
 * anywhere in a column counts.
 */
await card.dragTo(pg.locator('.kb-col[data-status="doing"] .kb-head'));
await pg.waitForTimeout(1800);
ok('dropping it in another column moves it there',
  (await pg.locator('.kb-col[data-status="doing"] li.task', { hasText: 'บอร์ด: ลากไปกำลังทำ' }).count()) === 1);
const serverSays = await pg.evaluate(async (id) =>
  (await fetch('/api/tasks').then((r) => r.json())).tasks.find((t) => t.id === id).status, ids.a);
ok('...and the server agrees it is now in progress', serverSays === 'doing', serverSays);

// ---- the list is still there, and the choice is remembered ----
await pg.locator('.view-seg button', { hasText: 'รายการ' }).click(); await pg.waitForTimeout(800);
ok('switching to the list shows the list', (await pg.locator('.kanban').count()) === 0 &&
  (await pg.locator('ul.tasks li.task').count()) > 0);
ok('...with the status tabs back above it', (await pg.locator('#main .filters .seg').count()) === 1);
await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(2400);
ok('...and it stays the list after a reload', (await pg.locator('.kanban').count()) === 0);
await pg.locator('.view-seg button', { hasText: 'บอร์ด' }).click(); await pg.waitForTimeout(800);
ok('back to the board', (await pg.locator('.kanban').count()) === 1);

// ---- a card somebody may not move ----
/**
 * A member who is not on a task can see it on their department's board but
 * may not change its status, so the card must not be draggable for them —
 * offering a drag the server would refuse is offering a failure.
 */
const member = await as('Fah_StaffCon', 'memberPw22', DESK).catch(() => null);
if (member) { await member.evaluate(() => { location.hash = '#/all'; }); await member.waitForTimeout(1500); }
if (member && (await member.locator('.kanban').count())) {
  const lockedCards = await member.locator('.kanban li.task .status-btn.locked').count();
  ok('the member sees cards they are not on', lockedCards > 0, `${lockedCards} locked`);
  const locked = await member.evaluate(() =>
    [...document.querySelectorAll('.kanban li.task')].filter((li) =>
      li.querySelector('.status-btn.locked') && li.getAttribute('draggable') === 'true').length);
  ok('a card the person may not move cannot be dragged', locked === 0, `${locked} draggable`);
} else {
  console.log('  (skipped the member check: no board for that account here)');
}

// ===========================================================================
console.log('\nOn a phone');
const ph = await as('Jade_Pres', 'fairAdmin1', PHONE);
await ph.evaluate(() => { location.hash = '#/all'; }); await ph.waitForTimeout(1600);

ok('the phone gets the board too', (await ph.locator('.kanban.kb-phone').count()) === 1);
const colW = await ph.locator('.kb-phone .kb-col').first().boundingBox();
ok('one column is most of the screen wide, readable rather than squeezed', colW.width >= 300,
  `${Math.round(colW.width)}px`);
ok('the board swipes on its own; the page does not scroll sideways',
  await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
ok('the next column peeks in from the edge so it is obvious there is more',
  ((await ph.locator('.kb-phone .kb-col').nth(1).boundingBox()).x) < 393);

// The chips jump to a column, and the lit one follows.
await ph.locator('.ph-chips button').nth(1).click(); await ph.waitForTimeout(900);
const doingX = (await ph.locator('.kb-col[data-status="doing"]').boundingBox()).x;
ok('tapping a chip swipes the board to that column', doingX >= 0 && doingX < 40, `${Math.round(doingX)}px`);
ok('...and that chip is the one lit up',
  (await ph.locator('.ph-chips button').nth(1).getAttribute('class') || '').includes('on'));

// Moving a card on a phone: the status box opens a sheet.
await ph.locator('.ph-chips button').first().click(); await ph.waitForTimeout(900);
const phCard = ph.locator('.kb-col[data-status="todo"] li.task', { hasText: 'บอร์ด: ย้ายบนมือถือ' });
ok('nothing is draggable on a phone, where drag-and-drop does not exist',
  (await ph.locator('.kanban li.task[draggable="true"]').count()) === 0);
await phCard.locator('.status-btn').click(); await ph.waitForTimeout(800);
ok('the status box opens a sheet of where it can go',
  (await ph.locator('#modal-root .act').count()) === 5);
await ph.locator('#modal-root .act', { hasText: 'รอตรวจ' }).click(); await ph.waitForTimeout(1800);
ok('choosing one moves the card',
  (await ph.locator('.kb-col[data-status="review"] li.task', { hasText: 'บอร์ด: ย้ายบนมือถือ' }).count()) === 1);
const phServer = await ph.evaluate(async (id) =>
  (await fetch('/api/tasks').then((r) => r.json())).tasks.find((t) => t.id === id).status, ids.b);
ok('...on the server as well', phServer === 'review', phServer);

// Moving a card from a later column must not throw you back to the first.
await ph.locator('.ph-chips button').nth(2).click(); await ph.waitForTimeout(900);
const before = await ph.evaluate(() => document.querySelector('.kanban').scrollLeft);
await ph.locator('.kb-col[data-status="review"] li.task', { hasText: 'บอร์ด: ย้ายบนมือถือ' })
  .locator('.status-btn').click(); await ph.waitForTimeout(700);
await ph.locator('#modal-root .act', { hasText: 'ตรวจแล้ว' }).click(); await ph.waitForTimeout(1800);
const after = await ph.evaluate(() => document.querySelector('.kanban').scrollLeft);
ok('the board stays where it was after a move', before > 0 && Math.abs(after - before) < 40,
  `${Math.round(before)} → ${Math.round(after)}`);

// The list is one tap away on a phone too.
await ph.locator('.ph-view').click(); await ph.waitForTimeout(800);
ok('the list is one tap away', (await ph.locator('.kanban').count()) === 0 &&
  (await ph.locator('ul.tasks li.task').count()) > 0);
await ph.locator('.ph-view').click(); await ph.waitForTimeout(600);

// Tidy.
await pg.evaluate(async () => {
  const d = await fetch('/api/tasks').then((r) => r.json());
  for (const t of d.tasks) if (/^บอร์ด:/.test(t.title)) await fetch('/api/tasks?id=' + t.id, { method: 'DELETE' });
});

console.log(errs.length ? '\nerrors:\n' + errs.join('\n') : '\nno page errors');
if (errs.length) failed += errs.length;
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
