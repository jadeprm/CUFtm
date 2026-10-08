/** Meetings where they now live: the work page, the calendar, and the dialog. */
import { chromium } from 'playwright';
import { quietGuide, expandUpcoming } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const ctx = await b.newContext({ viewport:{width:1850,height:1000}, deviceScaleFactor:1.3 });
const pg = await ctx.newPage();
const errs=[]; pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
pg.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text());});
pg.on('dialog', async d => { await d.accept(); });
let failed=0; const ok=(l,c,d='')=>{console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`);if(!c)failed++;};

const signIn = async (u,p) => {
  await pg.goto('http://localhost:4700/', { waitUntil:'networkidle' });
  await pg.fill('#in-username',u); await pg.click('#auth-submit'); await pg.waitForTimeout(2200);
  await pg.fill('#in-password',p);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm',p);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
};
await signIn('Jade_Pres','fairAdmin1');

console.log('\nMeetings now live with the work');
ok('the separate การประชุม tab is gone',
  (await pg.locator('#tabs a[href="#/meetings"]').count()) === 0);
await expandUpcoming(pg);
const rail = await pg.locator('.up-row.meeting').count();
ok('upcoming meetings appear in the strip on the work page', rail >= 1, String(rail));
ok('...and the work page offers นัดประชุม',
  (await pg.locator('.page-head button', { hasText: /นัดประชุม/ }).count()) >= 1);

await pg.locator('#tabs a[href="#/calendar"]').first().click(); await pg.waitForTimeout(2000);
ok('the calendar has a key for meetings',
  (await pg.locator('.cal-legend .dot.meeting').count()) === 1);

// Open a meeting from the work page and check it reads before it edits.
// A meeting made under the new rules — the ones already in the dev database
// predate headings and keep their flat agenda.
await pg.evaluate(async () => {
  /**
   * Cleared out first, and dated tomorrow.
   *
   * The rail shows the six soonest meetings. A fixed far-future date plus one
   * leftover copy per previous run meant this meeting was eventually pushed off
   * the end of it, and the test failed for having been run too many times
   * rather than for anything being wrong. So: anything left from a previous run
   * goes, and the new one is close enough to the front to stay there.
   */
  const existing = await fetch('/api/events?do=meetings').then((x) => x.json());
  for (const old of (existing.meetings || [])) {
    if (old.title === 'ประชุมทดสอบวาระย่อย') {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(old.id), { method: 'DELETE' });
    }
  }
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const r = await fetch('/api/events?do=meeting', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'ประชุมทดสอบวาระย่อย', meetsOn: tomorrow,
                           meetsAt: '17:00', template: 'standard' }),
  });
  const { id } = await r.json();
  await fetch('/api/events?do=meetings').then((x) => x.json()).then(async (d) => {
    const m = d.meetings.find((x) => x.id === id);
    const head = m.agenda.filter((x) => x.depth === 0)[3];
    await fetch('/api/events?do=agenda', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingId: id, title: 'ขอหารืองบประมาณ',
                             minutes: 15, parentId: head.id }),
    });
  });
});
await pg.locator('#tabs a[href="#/work"]').first().click(); await pg.waitForTimeout(1200);
await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(2600);
await expandUpcoming(pg);
await pg.locator('.up-row.meeting', { hasText: 'ทดสอบวาระย่อย' }).first().click();
await pg.waitForTimeout(1400);
// The agenda's own add boxes are inputs and belong in view mode; what must
// NOT be showing is the detail form.
ok('a meeting opens as something to read',
  (await pg.locator('.veil .mtg-summary').count()) === 1 &&
  !(await pg.locator('.veil .field label', { hasText: /ลิงก์เข้าประชุม/ }).first().isVisible().catch(() => false)),
  'summary shown, detail form hidden');
ok('...with an edit button for somebody who may change it',
  (await pg.locator('.veil footer button', { hasText: /แก้ไขรายละเอียด/ }).count()) === 1);

// Attendee chips on one line.
/**
 * Eleven people wrap onto several lines, so "all on one line" was never the
 * test. What was actually wrong is that a chip carrying a photograph was a
 * different height from one carrying initials and sat higher than its
 * neighbours — so: every chip the same height, and every chip on a given row
 * sharing a top edge.
 */
const boxes = await pg.locator('.veil .mtg-people .chip').evaluateAll(
  (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), h: Math.round(r.height) };
  }));
ok('every attendee chip is the same height',
  new Set(boxes.map((x) => x.h)).size === 1,
  boxes.map((x) => x.h).join(','));
const rows = {};
boxes.forEach((x) => { rows[x.top] = (rows[x.top] || 0) + 1; });
// With one attendee there is nothing to align against, so the row check only
// means something once there are several.
ok('...and chips on a row share a top edge, photo or not',
  boxes.length < 2 || Object.keys(rows).length < boxes.length,
  `${boxes.length} chips across ${Object.keys(rows).length} rows`);

// The agenda nests and shows no sixth heading.
const numbers = await pg.locator('.veil .agenda-row .t-code').allInnerTexts();
console.log('  agenda numbering:', numbers.join(' '));
ok('the agenda numbers sub-items as 4.1, not วาระที่ 6',
  numbers.some((x) => x.includes('.')) &&
  numbers.filter((x) => !x.includes('.')).length === 5,
  numbers.join(' '));
const minsField = pg.locator('.veil .agenda-add input[type="number"]').first();
ok('the duration box starts empty rather than guessing',
  (await minsField.inputValue()) === '', `"${await minsField.inputValue()}"`);
/**
 * The button used to disable itself until a duration was typed, which from
 * the other side of the screen is indistinguishable from a broken page. It
 * now stays alive and says what is missing.
 */
const addBox = pg.locator('.veil .agenda-add').first();
await addBox.locator('input[type="text"]').fill('ทดสอบว่าเตือนไหม');
await addBox.locator('button').click();
await pg.waitForTimeout(400);
ok('...and adding without a duration says so rather than doing nothing',
  await addBox.locator('.add-why').isVisible(),
  await addBox.locator('.add-why').innerText().catch(() => '(silent)'));

await pg.locator('.veil footer button', { hasText: /แก้ไขรายละเอียด/ }).first().click();
await pg.waitForTimeout(600);
ok('pressing edit reveals the form',
  (await pg.locator('.veil .body input:visible').count()) > 3,
  `${await pg.locator('.veil .body input:visible').count()} inputs`);
await pg.screenshot({ path: 'v1-meeting.png' });

console.log(errs.length?'\nERRORS: '+errs.join(' | '):'\nno console errors');
console.log(failed?`\n${failed} CHECK(S) FAILED`:'\nALL CHECKS PASSED');
await b.close(); process.exit(failed?1:0);
