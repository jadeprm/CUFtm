/**
 * Availability, clashes and the rank rule, exercised through the real page.
 *
 * The API suite already proves the rules hold. What this proves is the part a
 * person actually meets: that the warning appears before anything is saved,
 * that the override is offered exactly when it would really apply, and that
 * pressing "go back" leaves nothing behind.
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

/**
 * A context per person.
 *
 * Signing a second person in through the same browser just lands on the work
 * page, because the first session is still live — which cost half an hour of
 * looking at a "fill: element is not visible" error that was nothing to do with
 * the page being tested.
 */
async function as(user, pass) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 1000 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`PAGEERROR (${user}): ` + e.message));
  pg.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text());
  });
  pg.on('dialog', async (d) => { await d.accept(); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}

/**
 * A Monday, and a SOON one.
 *
 * Monday because Ploy's stated free evening below is a Monday. Soon because the
 * work page shows the six nearest meetings and nothing else — a fixture a month
 * out sat behind the dev database's accumulated meetings and never appeared,
 * which failed a check about a chip for reasons that had nothing to do with the
 * chip.
 */
const MONDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); // the next Monday
  /**
   * Formatted from the local parts, NOT through toISOString().
   *
   * This machine's clock is on Bangkok time, so any evening date turned into
   * the day before on the way through UTC — which handed the whole suite a
   * Sunday, a day Ploy has no hours on, and failed two checks about the
   * override for a reason that had nothing to do with the override.
   */
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
})();

// ===========================================================================
console.log('\nSaying when you are free');

const ploy = await as('Ploy_StaffCon', 'memberPw11');
await ploy.goto(`http://localhost:${PORT}/#/profile`, { waitUntil: 'networkidle' });
await ploy.waitForTimeout(2500);

const freeBox = ploy.locator('.field', { hasText: 'เวลาที่ว่าง' }).first();
ok('the profile has a place to say when you are free',
  (await freeBox.count()) === 1);
ok('...and says plainly that leaving it blank means always free',
  /ถือว่าว่างตลอด/.test(await freeBox.innerText()),
  (await freeBox.innerText()).split('\n')[1]);

// Clear whatever previous runs left, through the page.
let remove = freeBox.locator('.free-row button');
while (await remove.count()) {
  await remove.first().click();
  await ploy.waitForTimeout(900);
  remove = freeBox.locator('.free-row button');
}
ok('starting from nothing, it says so rather than showing an empty box',
  (await freeBox.locator('.free-none').count()) >= 1);

await freeBox.locator('.free-add select').first().selectOption('mon');
await freeBox.locator('.free-add input[type=time]').first().fill('17:00');
await freeBox.locator('.free-add input[type=time]').nth(1).fill('22:00');
await freeBox.locator('.free-add button').first().click();
await ploy.waitForTimeout(1800);
ok('an evening can be added', (await freeBox.locator('.free-row').count()) === 1,
  await freeBox.locator('.free-row').first().innerText().catch(() => ''));

/**
 * The add row is one sentence — "Monday, 17:00 to 22:00, add" — so it has to
 * read across. Every input in this app is width:100% by default, which turned
 * it into five stacked full-width boxes.
 */
const row = await Promise.all(['select', 'input[type=time]'].map(async (sel) =>
  freeBox.locator('.free-add ' + sel).first().boundingBox()));
ok('...and the controls for adding one sit on a line, not stacked',
  row[0] && row[1] && Math.abs(row[0].y - row[1].y) < 10,
  JSON.stringify(row.map((x) => x && Math.round(x.y))));

// A stretch of days away.
const awayAdd = freeBox.locator('.free-add.away');
await awayAdd.locator('input[type=date]').first().fill('2026-12-01');
await awayAdd.locator('input[type=date]').nth(1).fill('2026-12-15');
await awayAdd.locator('input[type=text]').first().fill('สอบปลายภาค');
await awayAdd.locator('button').first().click();
await ploy.waitForTimeout(1800);
const awayRows = await freeBox.locator('.free-list').last().locator('.free-row').allInnerTexts();
ok('a stretch of days away can be added', awayRows.some((x) => /2026-12-01/.test(x)),
  awayRows.join(' | ').slice(0, 70));
ok('...and the person themselves sees their own reason',
  awayRows.some((x) => /สอบปลายภาค/.test(x)));
ok('...with the page saying out loud that others will not',
  /ไม่เห็นเหตุผล/.test(await freeBox.innerText()));

// What it survives.
await ploy.reload({ waitUntil: 'networkidle' }); await ploy.waitForTimeout(2600);
const afterReload = ploy.locator('.field', { hasText: 'เวลาที่ว่าง' }).first();
ok('all of it is still there after a reload',
  (await afterReload.locator('.free-row').count()) === 2,
  String(await afterReload.locator('.free-row').count()));

// ===========================================================================
console.log('\nThe warning when somebody is not free');

const kaew = await as('Kaew_VP', 'coadminPw1');

/**
 * A meeting a co-admin called, inside Ploy's own free evening.
 *
 * The title carries the date, so a run that crashed before its cleanup cannot
 * leave a same-titled meeting on another day for the next run to pick up —
 * which is exactly what happened, and failed a check about a chip because the
 * card being inspected was last week's fixture rather than this one's.
 */
await kaew.evaluate(async (day) => {
  const d = await fetch('/api/events?do=meetings').then((x) => x.json());
  for (const m of (d.meetings || [])) {
    if (/^ทดสอบชนเวลา/.test(m.title)) {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(m.id), { method: 'DELETE' });
    }
  }
  await fetch('/api/events?do=meeting', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'ทดสอบชนเวลา ' + day, meetsOn: day, meetsAt: '18:00',
                           people: ['Ploy_StaffCon'] }),
  });
}, MONDAY);
const FIXTURE = 'ทดสอบชนเวลา ' + MONDAY;

/**
 * Opens the task form, fills it in, and presses save.
 *
 * Clears any dialog still open first. Pressing "go back" on the warning puts
 * you back in the form you were filling in — which is the right thing for it to
 * do and left this helper clicking at a button underneath a veil.
 */
async function proposeTask(pg, { title, at, who }) {
  await pg.goto(`http://localhost:${PORT}/#/work`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1200);
  for (let i = 0; i < 4 && await pg.locator('.veil').count(); i += 1) {
    await pg.evaluate(() => {
      const v = document.querySelectorAll('#modal-root .veil');
      v.forEach((x) => x.remove());
    });
    await pg.waitForTimeout(300);
  }
  await pg.waitForTimeout(1100);
  await pg.locator('#main .page-head button.primary').first().click();
  await pg.waitForTimeout(1300);
  await pg.locator('.modal input[type=text]').first().fill(title);
  await pg.locator('.modal input[type=date]').first().fill(MONDAY);
  await pg.locator('.modal input[type=time]').first().fill(at);
  await pg.locator('.modal .picker input[type=text]').first().fill(who);
  await pg.waitForTimeout(800);
  await pg.locator('.modal .picker .opt').first().click();
  await pg.waitForTimeout(500);
  await pg.locator('.modal footer button.primary').first().click();
  await pg.waitForTimeout(2600);
}

// 18:15 is inside Ploy's stated evening, so the ONLY clash is the meeting.
await proposeTask(kaew, { title: 'ตรวจคิวเวที', at: '18:15', who: 'Ploy' });
ok('the warning appears before anything is saved',
  (await kaew.locator('.veil .clash-list').count()) === 1);
const warnText = await kaew.locator('.veil .clash-list').innerText();
ok('...naming the person, not a username', /Ploy - Stage staff/.test(warnText), warnText.split('\n')[0]);
ok('...and what they already have, with its code',
  warnText.includes(FIXTURE) && /M\d{4}/.test(warnText),
  warnText.replace(/\n/g, ' | ').slice(0, 80));
ok('...said as a heads-up rather than a refusal',
  /แจ้งให้ทราบ/.test(await kaew.locator('.veil .modal').last().innerText()));

/**
 * Every clash here is a booking, and a co-admin outranks every booking — so the
 * override must be on offer.
 */
ok('a co-admin is offered the override when every clash is a booking',
  (await kaew.locator('.veil footer button', { hasText: /ให้อันนี้สำคัญกว่า/ }).count()) === 1);

// Going back must leave nothing behind at all.
const beforeCount = await kaew.evaluate(() =>
  fetch('/api/tasks').then((x) => x.json()).then((d) => d.tasks.length));
await kaew.locator('.veil footer button', { hasText: /ย้อนกลับ/ }).first().click();
await kaew.waitForTimeout(1600);
const afterCount = await kaew.evaluate(() =>
  fetch('/api/tasks').then((x) => x.json()).then((d) => d.tasks.length));
ok('pressing go back saves nothing', beforeCount === afterCount, `${beforeCount} → ${afterCount}`);

// ---- the override that nobody has ----
/**
 * 09:45 is outside Ploy's stated hours. No rank in this committee makes
 * somebody's own stated availability go away, so the override must NOT be
 * offered — a button that claimed otherwise would be the system lying about
 * what it can do.
 */
await proposeTask(kaew, { title: 'งานเช้าวันจันทร์', at: '09:45', who: 'Ploy' });
const mixedText = await kaew.locator('.veil .clash-list').innerText();
ok('being outside somebody’s stated hours is reported too',
  /ว่างเฉพาะ/.test(mixedText), mixedText.replace(/\n/g, ' | ').slice(0, 80));
ok('...and is shown differently from a mere double booking',
  (await kaew.locator('.veil .clash-why li.away').count()) >= 1 &&
  (await kaew.locator('.veil .clash-why li.booked').count()) >= 0);
ok('...and NO override is offered, because no rank overrules an exam or a lecture',
  (await kaew.locator('.veil footer button', { hasText: /ให้อันนี้สำคัญกว่า/ }).count()) === 0,
  'the top of the committee cannot move somebody’s timetable');
await kaew.locator('.veil footer button', { hasText: /ย้อนกลับ/ }).first().click();
await kaew.waitForTimeout(1200);

// ---- an editor, who outranks less ----
const kungking = await as('Kungking_HeadCon', 'brandNew22');
await proposeTask(kungking, { title: 'งานของหัวหน้าฝ่าย', at: '18:15', who: 'Ploy' });
ok('an editor is warned about the same clash', (await kungking.locator('.veil .clash-list').count()) === 1);
/**
 * The meeting belongs to a co-admin, and an editor does not outrank a
 * co-admin. If this button ever appeared the rank rule would be decorative.
 */
ok('...but is not offered the override, because the meeting is a co-admin’s',
  (await kungking.locator('.veil footer button', { hasText: /ให้อันนี้สำคัญกว่า/ }).count()) === 0);
ok('...and can still save anyway, because this warns and never blocks',
  (await kungking.locator('.veil footer button', { hasText: /บันทึกต่อไป/ }).count()) === 1);
await kungking.locator('.veil footer button', { hasText: /ย้อนกลับ/ }).first().click();
await kungking.waitForTimeout(1200);

// ===========================================================================
console.log('\nDeclaring which one counts');

await proposeTask(kaew, { title: 'งานที่สำคัญกว่า', at: '18:15', who: 'Ploy' });
await kaew.locator('.veil footer button', { hasText: /ให้อันนี้สำคัญกว่า/ }).first().click();
await kaew.waitForTimeout(3000);

const saved = await kaew.evaluate(() =>
  fetch('/api/tasks').then((x) => x.json())
    .then((d) => d.tasks.some((t) => t.title === 'งานที่สำคัญกว่า')));
ok('the task is saved when the override is taken', saved === true);

/**
 * The point of the whole feature: the person who is double-booked can see which
 * one the committee expects them at. Shown to THEM and to nobody else, because
 * to everybody else it is somebody else's scheduling.
 */
/**
 * Reloaded, not just navigated to.
 *
 * Ploy signed in before any of this existed, and a hash change does not refetch
 * — so her page was still holding the meeting list from sign-in and the card
 * being looked for had never been in it.
 */
await ploy.goto(`http://localhost:${PORT}/#/work`, { waitUntil: 'networkidle' });
await ploy.reload({ waitUntil: 'networkidle' });
await ploy.waitForTimeout(3000);
const beaten = await ploy.evaluate((FIXTURE) =>
  fetch('/api/events?do=meetings').then((x) => x.json())
    .then((d) => (d.meetings.find((m) => m.title === FIXTURE) || {}).outrankedBy || []), FIXTURE);
ok('the meeting it beat is marked as outranked', beaten.length >= 1, JSON.stringify(beaten));
/**
 * Two rows, not one, and that is right: the task form puts its creator on the
 * task by default, and Kaew is also in the meeting she called — so she is
 * double-booked too and her own decision applies to her own calendar as well.
 */
ok('...once for each person who is actually double-booked',
  beaten.some((x) => x.username === 'Ploy_StaffCon') &&
  beaten.some((x) => x.username === 'Kaew_VP'),
  beaten.map((x) => x.username).join(', '));

const card = ploy.locator('.event-card.meeting', { hasText: FIXTURE });
ok('the meeting is on her work page to carry the mark',
  (await card.count()) === 1, String(await card.count()));
ok('...and the mark is on screen for the person who is double-booked',
  (await card.locator('.chip.outranked').count()) === 1,
  (await card.first().innerText().catch(() => '')).replace(/\n/g, ' | '));

// Somebody else's clash is nobody else's business.
ok('...but not shown to somebody who is not on both',
  (await kaew.locator('.chip.outranked').count()) === 0,
  String(await kaew.locator('.chip.outranked').count()));

// ===========================================================================
console.log('\nAnybody may be appointed now');

/**
 * New leads เวที and Fah is in Exhibition. Until Jade asked for this, a unit
 * head was offered only their own section and the server refused the rest.
 */
const newUnit = await as('New_UnitCon', 'unitLead11');
await newUnit.goto(`http://localhost:${PORT}/#/work`, { waitUntil: 'networkidle' });
await newUnit.waitForTimeout(2300);
await newUnit.locator('#main .page-head button.primary').first().click();
await newUnit.waitForTimeout(1300);
await newUnit.locator('.modal .picker input[type=text]').first().fill('Fah');
await newUnit.waitForTimeout(900);
ok('a unit head is now offered somebody in another section',
  (await newUnit.locator('.modal .picker .opt').count()) >= 1,
  (await newUnit.locator('.modal .picker .opt').allInnerTexts()).join(' | ').slice(0, 60));

await newUnit.locator('.modal input[type=text]').first().fill('งานข้ามหน่วยจากหน้าเว็บ');
await newUnit.locator('.modal input[type=date]').first().fill(MONDAY);
await newUnit.locator('.modal .picker .opt').first().click();
await newUnit.waitForTimeout(500);
await newUnit.locator('.modal footer button.primary').first().click();
await newUnit.waitForTimeout(2800);
const crossed = await newUnit.evaluate(() =>
  fetch('/api/tasks').then((x) => x.json())
    .then((d) => d.tasks.find((t) => t.title === 'งานข้ามหน่วยจากหน้าเว็บ')));
ok('...and the task really saves', Boolean(crossed), crossed && crossed.code);
ok('...with that person on it', Boolean(crossed) && crossed.assignees.includes('Fah_StaffCon'),
  crossed && crossed.assignees.join(', '));

// ---- tidy up, so the next run starts where this one did ----
await kaew.evaluate(async () => {
  const d = await fetch('/api/tasks').then((x) => x.json());
  for (const t of d.tasks) {
    if (['งานที่สำคัญกว่า', 'งานข้ามหน่วยจากหน้าเว็บ'].includes(t.title)) {
      await fetch('/api/tasks?id=' + encodeURIComponent(t.id), { method: 'DELETE' });
    }
  }
  const m = await fetch('/api/events?do=meetings').then((x) => x.json());
  for (const x of m.meetings) {
    if (/^ทดสอบชนเวลา/.test(x.title)) {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(x.id), { method: 'DELETE' });
    }
  }
});

console.log(errs.length ? '\nconsole errors:\n' + errs.join('\n') : '\nno console errors');
if (errs.length) failed += errs.length;
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
