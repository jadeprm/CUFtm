/**
 * The whole agenda, end to end in a browser: build one on the page, save it,
 * reopen it, and add an item under a วาระ. Every step of this is one Jade
 * actually performed and that silently did nothing.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
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

const boxes = pg.locator('.veil .agenda-add');
ok('each standing วาระ has its own add box', await boxes.count() === 5,
  String(await boxes.count()));

// Press the button with nothing filled in — it must SAY why, not sit dead.
const box4 = boxes.nth(3);
await box4.locator('button').click();
await pg.waitForTimeout(400);
ok('pressing add with nothing typed explains itself',
  await box4.locator('.add-why').isVisible(),
  await box4.locator('.add-why').innerText().catch(() => '(silent)'));

await box4.locator('input[type="text"]').fill('คัดเลือกผู้สมัคร');
await box4.locator('button').click();
await pg.waitForTimeout(400);
ok('...and with no duration it says that too',
  (await box4.locator('.add-why').innerText()).length > 0,
  await box4.locator('.add-why').innerText());

await box4.locator('input[type="number"]').fill('20');
await box4.locator('button').click();
await pg.waitForTimeout(600);
const nums = await pg.locator('.veil .agenda-row .t-code').allInnerTexts();
ok('the item appears, numbered 4.1', nums.includes('4.1'), nums.join(' '));
ok('...and there is still no sixth วาระ',
  nums.filter((x) => !x.includes('.')).length === 5, nums.join(' '));

await pg.locator('.veil footer button', { hasText: /^บันทึก/ }).first().click();
await pg.waitForTimeout(2500);

console.log('\nReopening it');
await pg.locator('.event-card.meeting', { hasText: tag }).first().click();
await pg.waitForTimeout(1500);
const nums2 = await pg.locator('.veil .agenda-row .t-code').allInnerTexts();
console.log('  saved agenda:', nums2.join(' '));
ok('the saved agenda keeps its five headings', 
  nums2.filter((x) => !x.includes('.')).length === 5, nums2.join(' '));
ok('...and the sub-item survived the save', nums2.includes('4.1'), nums2.join(' '));
ok('...and each heading still offers its own add box',
  await pg.locator('.veil .agenda-add').count() === 5,
  String(await pg.locator('.veil .agenda-add').count()));

// Add one to a different วาระ on the saved meeting.
const box2 = pg.locator('.veil .agenda-add').nth(1);
await box2.locator('input[type="text"]').fill('แจ้งกำหนดการรับสมัคร');
await box2.locator('input[type="number"]').fill('5');
await box2.locator('button').click();
await pg.waitForTimeout(2500);
await pg.locator('.event-card.meeting', { hasText: tag }).first().click();
await pg.waitForTimeout(1500);
const nums3 = await pg.locator('.veil .agenda-row .t-code').allInnerTexts();
console.log('  after proposing:', nums3.join(' '));
ok('an item proposed on a saved meeting appears under its วาระ',
  nums3.includes('2.1') && nums3.includes('4.1'), nums3.join(' '));
await pg.screenshot({ path: 'a1-agenda.png' });

console.log(errs.length?'\nERRORS: '+errs.join(' | '):'\nno console errors');
console.log(failed?`\n${failed} CHECK(S) FAILED`:'\nALL CHECKS PASSED');
await b.close(); process.exit(failed?1:0);
