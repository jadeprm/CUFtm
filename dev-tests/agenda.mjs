/**
 * The whole agenda, end to end in a browser: build one on the page, save it,
 * reopen it, and add an item under a วาระ. Every step of this is one Jade
 * actually performed and that silently did nothing.
 */
import { chromium } from 'playwright';
import { quietGuide, expandUpcoming } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const pg = await (await b.newContext({viewport:{width:1700,height:1000},deviceScaleFactor:1.3})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
pg.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text());});
pg.on('dialog', async d => { await d.accept(); });
let failed=0; const ok=(l,c,d='')=>{console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`);if(!c)failed++;};

await pg.goto('http://localhost:4700/', { waitUntil:'networkidle' });
await pg.fill('#in-username','Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(2200);
await pg.fill('#in-password','fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm','fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2600);

console.log('\nBuilding an agenda on the page');
await pg.locator('.page-head button', { hasText: 'นัดประชุม' }).first().click();
await pg.waitForTimeout(1000);

const title = pg.locator('.veil .field', { hasText: 'เรื่องที่ประชุม' }).locator('input').first();
/**
 * A unique title and tomorrow's date: the rail shows the six soonest, and this
 * script has been run enough times that a fixed title and a far-off date left
 * its own meeting pushed off the end of the list it then looked in.
 */
const tag = 'Recruit ' + Date.now().toString(36).slice(-5);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
await title.fill(tag);
await pg.locator('.veil .field', { hasText: 'วันที่' }).locator('input').first().fill(tomorrow);

/**
 * One bar for the whole agenda, with the วาระ picked in it — five identical
 * add rows down the page was the thing people could not read.
 */
const boxes = pg.locator('.veil .agenda-add');
ok('there is one add bar for the whole agenda', await boxes.count() === 1,
  String(await boxes.count()));
const box4 = boxes.first();
ok('...and it asks which วาระ the item goes under',
  await box4.locator('select.agenda-under').count() === 1);
const underOptions = await box4.locator('select.agenda-under option').allInnerTexts();
ok('...listing every standing วาระ', underOptions.length === 5, underOptions.join(' | '));
await box4.locator('select.agenda-under').selectOption({ index: 3 });

// Press the button with nothing filled in — it must SAY why, not sit dead.
await box4.locator('button.btn').click();
await pg.waitForTimeout(400);
ok('pressing add with nothing typed explains itself',
  await box4.locator('.add-why').isVisible(),
  await box4.locator('.add-why').innerText().catch(() => '(silent)'));

await box4.locator('input[type="text"]').fill('คัดเลือกผู้สมัคร');
await box4.locator('button.btn').click();
await pg.waitForTimeout(400);
ok('...and with no duration it says that too',
  (await box4.locator('.add-why').innerText()).length > 0,
  await box4.locator('.add-why').innerText());

await box4.locator('input[type="number"]').fill('20');
await box4.locator('button.btn').click();
await pg.waitForTimeout(600);
const nums = await pg.locator('.veil .agenda-row .t-code').allInnerTexts();
ok('the item appears, numbered 4.1', nums.includes('4.1'), nums.join(' '));
ok('...and there is still no sixth วาระ',
  nums.filter((x) => !x.includes('.')).length === 5, nums.join(' '));

await pg.locator('.veil footer button', { hasText: /^บันทึก/ }).first().click();
await pg.waitForTimeout(2500);

console.log('\nReopening it');
await expandUpcoming(pg);
await pg.locator('.up-row.meeting', { hasText: tag }).first().click();
await pg.waitForTimeout(1500);
const nums2 = await pg.locator('.veil .agenda-row .t-code').allInnerTexts();
console.log('  saved agenda:', nums2.join(' '));
ok('the saved agenda keeps its five headings', 
  nums2.filter((x) => !x.includes('.')).length === 5, nums2.join(' '));
ok('...and the sub-item survived the save', nums2.includes('4.1'), nums2.join(' '));
ok('...and the saved meeting has the one add bar too',
  await pg.locator('.veil .agenda-add').count() === 1,
  String(await pg.locator('.veil .agenda-add').count()));

// Add one to a different วาระ on the saved meeting, through the picker.
const box2 = pg.locator('.veil .agenda-add').first();
await box2.locator('select.agenda-under').selectOption({ index: 1 });
await box2.locator('input[type="text"]').fill('แจ้งกำหนดการรับสมัคร');
await box2.locator('input[type="number"]').fill('5');
await box2.locator('button.btn').click();
await pg.waitForTimeout(2500);
await expandUpcoming(pg);
await pg.locator('.up-row.meeting', { hasText: tag }).first().click();
await pg.waitForTimeout(1500);
const nums3 = await pg.locator('.veil .agenda-row .t-code').allInnerTexts();
console.log('  after proposing:', nums3.join(' '));
ok('an item proposed on a saved meeting appears under its วาระ',
  nums3.includes('2.1') && nums3.includes('4.1'), nums3.join(' '));
await pg.screenshot({ path: 'a1-agenda.png' });

// ===========================================================================
console.log('\nPapers: for the whole meeting, or for one วาระ');

/**
 * Added 22 October. Three papers in one undifferentiated list was the whole
 * problem — the budget spreadsheet for วาระ 4.2 sat beside the joining link,
 * and nothing said which was which.
 *
 * The default has to be unchanged, so this checks ทั้งการประชุม is what the
 * picker offers first before it checks that anything else works.
 */
const underRow = pg.locator('.veil .mtg-under-row select');
ok('the papers box asks which วาระ a paper is for',
  await underRow.count() === 1, String(await underRow.count()));
const firstOption = await underRow.locator('option').first().innerText();
ok('...and offers ทั้งการประชุม first, which is what it was before',
  firstOption.trim() === 'ทั้งการประชุม', firstOption);
ok('...and the whole agenda after it',
  (await underRow.locator('option').count()) >= 7,
  String(await underRow.locator('option').count()));
ok('...with ทั้งการประชุม already chosen, so nothing changes for anybody',
  (await underRow.inputValue()) === '');

// A paper for the meeting as a whole — the old behaviour, unchanged.
const linkIn = pg.locator('.veil .mtg-file-add input[type="url"]');
await linkIn.fill('https://docs.google.com/document/d/minutes-last-time');
await pg.locator('.veil .mtg-file-add button', { hasText: 'เพิ่มลิงก์' }).click();
await pg.waitForTimeout(2200);
ok('a paper attached with nothing chosen lands on the meeting',
  await pg.locator('.veil .mtg-file').count() === 1,
  String(await pg.locator('.veil .mtg-file').count()));
ok('...and with only one group there is no heading to read',
  await pg.locator('.veil .mtg-file-head').count() === 0);

// Now one for วาระ 4.1 specifically. Selected by the option's own value,
// because the visible label carries indenting that an exact match would miss.
const valueFor = async (sel, startsWith) => sel.locator('option').evaluateAll(
  (els, want) => (els.find((e) => e.textContent.trim().indexOf(want) === 0) || {}).value,
  startsWith);
const v41 = await valueFor(pg.locator('.veil .mtg-under-row select'), '4.1.');
ok('...and วาระ 4.1 is one of the choices', Boolean(v41), String(v41));
await pg.locator('.veil .mtg-under-row select').selectOption(v41);
await pg.locator('.veil .mtg-file-add input[type="url"]').fill('https://docs.google.com/spreadsheets/d/applicants');
await pg.locator('.veil .mtg-file-add button', { hasText: 'เพิ่มลิงก์' }).click();
await pg.waitForTimeout(2200);

const heads = await pg.locator('.veil .mtg-file-head').allInnerTexts();
ok('filing one under a วาระ splits the list into groups',
  heads.length === 2, heads.join(' | '));
ok('...with the meeting\u2019s own papers first',
  heads[0] === 'ทั้งการประชุม', heads.join(' | '));
ok('...and the วาระ named by its number, as people say it out loud',
  /^4\.1\./.test(heads[1] || ''), heads[1]);

/**
 * The count on the agenda row is the point of the whole change: it is what
 * somebody reads while the meeting runs, at the moment that วาระ comes up.
 */
const paperChip = pg.locator('.veil .agenda-row', { hasText: 'คัดเลือกผู้สมัคร' }).locator('.chip.paper');
ok('the วาระ\u2019s own row says it has a paper',
  await paperChip.isVisible() && /1/.test(await paperChip.innerText()),
  await paperChip.innerText().catch(() => '(none)'));

// Re-filing: a committee that attached everything to the meeting has a list
// to sort out, and re-uploading is not an answer.
const looseRow = pg.locator('.veil .mtg-file').first();
const mover = looseRow.locator('select.f-under');
ok('each paper can be re-filed from its own row', await mover.count() === 1);
await mover.selectOption(await valueFor(mover, '4.1.'));
await pg.waitForTimeout(2200);

const heads2 = await pg.locator('.veil .mtg-file-head').allInnerTexts();
/**
 * With everything now under one วาระ there is still a heading, and there has
 * to be: "only one group, so say nothing" would leave the reader unable to
 * tell the papers are filed at all. The heading is dropped only when that one
 * group is the meeting's own, which is what the list meant before.
 */
ok('moving the last loose paper leaves one group, and it still says which วาระ',
  heads2.length === 1 && /^4\.1\./.test(heads2[0]), heads2.join(' | '));
const chipAfter = await pg.locator('.veil .agenda-row', { hasText: 'คัดเลือกผู้สมัคร' })
  .locator('.chip.paper').innerText();
ok('...and the count on the agenda row follows, rather than going stale',
  /2/.test(chipAfter), chipAfter);

await pg.screenshot({ path: 'a2-papers.png' });

console.log(errs.length?'\nERRORS: '+errs.join(' | '):'\nno console errors');
console.log(failed?`\n${failed} CHECK(S) FAILED`:'\nALL CHECKS PASSED');
await b.close(); process.exit(failed?1:0);
