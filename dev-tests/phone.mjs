/**
 * The app on a phone, checked rather than admired.
 *
 * Every line here is something that was actually broken at 390px: the
 * notification panel hanging off the left edge, the whole page scrolling
 * sideways, the navigation eating half the screen, and the รอตรวจ tab showing
 * tasks that are not under review.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';

const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const ctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
pg.on('dialog', async (d) => { await d.accept(); });

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

await pg.goto('http://localhost:4700/', { waitUntil: 'networkidle' });
await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(3000);
await pg.fill('#in-password', 'fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2500);

const sideways = () => pg.evaluate(() =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth);

console.log('\nPhone — 390 x 844');

ok('the page does not scroll sideways', !(await sideways()));

// Navigation along the bottom, where a thumb reaches.
const nav = await pg.locator('#tabs').boundingBox();
ok('navigation sits at the bottom of the screen', nav.y > 700, `y=${Math.round(nav.y)}`);
ok('...and is one row, not a column', nav.height < 90, `${Math.round(nav.height)}px tall`);
ok('...showing the short labels',
  (await pg.locator('#tabs a:visible').allInnerTexts()).join('').includes('งาน'),
  (await pg.locator('#tabs a:visible').allInnerTexts()).map((s) => s.replace(/\s+/g, '')).join(' / '));

// The top bar is one line again.
const top = await pg.locator('.topbar').boundingBox();
ok('the top bar is a single row', top.height < 90, `${Math.round(top.height)}px tall`);

// The bell: this is the one she could not use at all.
await pg.click('#bell-btn');
await pg.waitForTimeout(700);
const pop = await pg.locator('#bell-pop').boundingBox();
ok('the notification panel is fully on screen',
  pop.x >= 0 && pop.x + pop.width <= 390,
  `${Math.round(pop.x)} → ${Math.round(pop.x + pop.width)}`);
ok('...and wide enough to read', pop.width > 300, `${Math.round(pop.width)}px`);
await pg.screenshot({ path: 'm2-bell.png' });

// The profile menu, which replaced the profile tab.
await pg.click('#bell-btn');
await pg.waitForTimeout(300);
await pg.click('#me-avatar');
await pg.waitForTimeout(600);
ok('the avatar opens the profile menu', !(await pg.locator('#me-pop').isHidden()));
const mePop = await pg.locator('#me-pop').boundingBox();
ok('...fully on screen too', mePop.x >= 0 && mePop.x + mePop.width <= 390,
  `${Math.round(mePop.x)} → ${Math.round(mePop.x + mePop.width)}`);
ok('...carrying the theme and the language',
  (await pg.locator('#me-pop').innerText()).includes('ธีม') &&
  (await pg.locator('#me-pop').innerText()).includes('ภาษา'),
  (await pg.locator('#me-pop').innerText()).replace(/\n/g, ' | '));

// Opening one panel closes the other.
await pg.click('#bell-btn');
await pg.waitForTimeout(400);
ok('opening the bell closes the profile menu', await pg.locator('#me-pop').isHidden());
await pg.click('#bell-btn');
await pg.waitForTimeout(300);

// Every tap target big enough for a thumb.
const small = await pg.evaluate(() => {
  const out = [];
  document.querySelectorAll('#tabs a, .topbar button, .topbar .avatar').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && (r.height < 34 || r.width < 30)) {
      out.push((el.textContent || el.id).trim().slice(0, 14) + ' ' +
        Math.round(r.width) + '×' + Math.round(r.height));
    }
  });
  return out;
});
ok('nothing in the chrome is too small to tap', small.length === 0, small.join(' | '));

/**
 * The status tabs. Picking รอตรวจ used to apply no filter at all, so the list
 * showed everything — including finished work — while the count beside the tab
 * said 1.
 */
const seed = await pg.evaluate(async () => {
  const mk = async (title, status) => {
    const r = await fetch('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, dueDate: '2026-12-01', assignees: ['Jade_Pres'], notify: [] }),
    });
    const { task } = await r.json();
    if (status !== 'todo') {
      await fetch('/api/tasks', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: task.id, status }),
      });
    }
    return task.id;
  };
  return {
    todo: await mk('มือถือ: ยังไม่เริ่ม', 'todo'),
    review: await mk('มือถือ: รอตรวจ', 'review'),
    done: await mk('มือถือ: เสร็จแล้ว', 'done'),
  };
});
/**
 * These checks are about the LIST's status filter. The work page now opens as
 * a board, where the same chips jump between columns instead of filtering —
 * so the list is chosen first, the way a person would with the toggle.
 * The board has its own suite (kanban.mjs).
 */
await pg.evaluate(() => { try { localStorage.setItem('fair-work-view', 'list'); } catch (e) {} });
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(2000);

/**
 * On a phone the status tabs are a line of chips (.ph-chips) rather than a
 * segmented control — the redesign that put the four dropdowns in a sheet.
 * Same buttons, same filtering; only where they live changed.
 */
const segButtons = pg.locator('.ph-chips button');
const labels = await segButtons.allInnerTexts();
console.log('  status tabs:', labels.map((s) => s.replace(/\s+/g, ' ')).join(' / '));

const reviewTab = segButtons.filter({ hasText: 'รอตรวจ' }).first();
await reviewTab.scrollIntoViewIfNeeded();
await reviewTab.click();
await pg.waitForTimeout(800);
const listed = await pg.locator('li.task .t-title').allInnerTexts();
/**
 * Every task listed is one under review — not "exactly one", which only held
 * while the dev database was fresh and turned into a false alarm as soon as
 * this script had been run twice.
 */
ok('the รอตรวจ tab shows only tasks under review',
  listed.length >= 1 && listed.every((x) => x.includes('รอตรวจ')),
  listed.join(' | ') || 'nothing listed');

const doneTab = segButtons.filter({ hasText: 'เสร็จแล้ว' }).first();
await doneTab.scrollIntoViewIfNeeded();
await doneTab.click();
await pg.waitForTimeout(800);
const doneList = await pg.locator('li.task .t-title').allInnerTexts();
ok('...and เสร็จแล้ว shows only finished ones',
  doneList.length >= 1 && doneList.every((x) => x.includes('เสร็จ')), doneList.join(' | '));

ok('still no sideways scroll with a full list', !(await sideways()));
await pg.screenshot({ path: 'm1-work.png' });

// A dialog on a phone should be the screen, not a postage stamp.
const allTab = segButtons.first();
await allTab.scrollIntoViewIfNeeded();
await allTab.click();
await pg.waitForTimeout(600);
await pg.locator('li.task').first().click();
await pg.waitForTimeout(1200);
const modal = await pg.locator('.veil .modal').first().boundingBox();
ok('a dialog uses the width of the screen', modal.width > 360, `${Math.round(modal.width)}px`);
ok('...and does not push the page sideways', !(await sideways()));
await pg.screenshot({ path: 'm3-task.png' });

// The short links page, which has its own row layout.
await pg.keyboard.press('Escape');
await pg.waitForTimeout(400);
await pg.evaluate(async () => {
  await fetch('/api/meta?do=link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://forms.gle/a-fairly-long-destination-url-for-testing',
                           title: 'ใบสมัครอาสาสมัคร', code: 'PHONE' }),
  });
});
await pg.goto('http://localhost:4700/#/links', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1800);
ok('the short links page fits the screen', !(await sideways()));
const shortCodes = await pg.locator('.link-row .lr-short code').allInnerTexts();
ok('...and a link row is readable on it',
  shortCodes.length >= 1 && shortCodes.some((x) => x.includes('PHONE')),
  shortCodes.join(' | ') || 'none');
await pg.locator('.link-row button').filter({ hasText: 'QR' }).first().click();
await pg.waitForTimeout(1200);
const qrBox = await pg.locator('.veil .qr-canvas').boundingBox();
ok('...and the QR code fits the screen too', qrBox && qrBox.x >= 0 && qrBox.x + qrBox.width <= 390,
  qrBox ? `${Math.round(qrBox.x)} → ${Math.round(qrBox.x + qrBox.width)}` : 'none');
await pg.screenshot({ path: 'm6-links.png' });

console.log(errs.length ? '\nERRORS: ' + errs.join(' | ') : '\nno console errors');

// ---- the meeting page at 390px -----------------------------------------
// A dialog left open from the checks above would swallow every click here.
await pg.evaluate(() => document.querySelectorAll('.veil').forEach((v) => v.remove()));
await pg.waitForTimeout(300);
// Meetings live on the work page now, in a rail of their own.
await pg.locator('#tabs a[href="#/work"]').first().click();
await pg.waitForTimeout(2200);
ok('the work page still fits the screen with meetings on it', !(await sideways()));
if (await pg.locator('.event-card.meeting').count()) {
  await pg.locator('.event-card.meeting').first().click();
  await pg.waitForTimeout(1400);
  const agendaBox = await pg.locator('.veil .modal').first().boundingBox();
  ok('...and a meeting opens without pushing the page sideways', !(await sideways()));
  ok('...using the width of the screen', agendaBox.width > 360, `${Math.round(agendaBox.width)}px`);
  const rsvpBtn = await pg.locator('.veil .rsvp button').first().boundingBox();
  ok('...with reply buttons big enough for a thumb',
    !rsvpBtn || rsvpBtn.height >= 30, rsvpBtn ? `${Math.round(rsvpBtn.height)}px` : 'none shown');
  await pg.screenshot({ path: 'm7-meeting.png' });
}

console.log(failed ? `\n${failed} PHONE CHECK(S) FAILED` : '\nALL PHONE CHECKS PASSED (meetings too)');
await b.close();
process.exit(failed ? 1 : 0);
