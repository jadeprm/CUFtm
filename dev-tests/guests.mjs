/** Inviting somebody with no account here, the way a person would do it. */
import { chromium } from 'playwright';
import { quietGuide, expandUpcoming } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const pg = await (await b.newContext({viewport:{width:1700,height:1000},deviceScaleFactor:1.3})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
pg.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text());});
let alerted=''; pg.on('dialog', async d => { alerted = d.message(); await d.accept(); });
let failed=0; const ok=(l,c,d='')=>{console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`);if(!c)failed++;};

await pg.goto('http://localhost:4700/', { waitUntil:'networkidle' });
await pg.fill('#in-username','Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(2200);
await pg.fill('#in-password','fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm','fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2600);

const tag = 'Guests ' + Date.now().toString(36).slice(-5);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

console.log('\nInviting an outside guest');
await pg.locator('.page-head button', { hasText: 'นัดประชุม' }).first().click();
await pg.waitForTimeout(1000);
await pg.locator('.veil .field', { hasText: 'เรื่องที่ประชุม' }).locator('input').first().fill(tag);
await pg.locator('.veil .field', { hasText: 'วันที่' }).locator('input').first().fill(tomorrow);
await pg.locator('.veil .field', { hasText: 'เวลาเริ่ม' }).locator('input').first().fill('14:00');

const guestBox = pg.locator('.veil .field', { hasText: 'แขกภายนอก' }).locator('textarea').first();
ok('the meeting form has a box for outside guests', await guestBox.count() === 1);
// Typed the way somebody pastes it out of an email, with one bad entry.
await guestBox.fill('Ajarn Somchai <ajarn@chula.ac.th>, supplier@example.co.th, ไม่ใช่อีเมล');

await pg.locator('.veil footer button', { hasText: /^บันทึก/ }).first().click();
await pg.waitForTimeout(2800);
ok('...and saving says which address it could not read',
  alerted.includes('ไม่ใช่อีเมล'), alerted || '(no message)');

await expandUpcoming(pg);
await pg.locator('.up-row.meeting', { hasText: tag }).first().click();
await pg.waitForTimeout(1500);
const chips = await pg.locator('.veil .sum-row', { hasText: 'แขกภายนอก' })
  .locator('.chip').allInnerTexts();
console.log('  guests listed:', chips.join(', '));
ok('the two good addresses are listed on the meeting',
  chips.length === 2 && chips.includes('ajarn@chula.ac.th'), chips.join(', '));
ok('...and the name in angle brackets was understood, not stored whole',
  !chips.some((x) => x.includes('<')), chips.join(', '));

const note = await pg.locator('.veil .sum-row', { hasText: 'แขกภายนอก' })
  .locator('.hint').innerText().catch(() => '');
ok('...with it said plainly that this system sends no email itself',
  /ไม่ได้ส่งอีเมลเอง/.test(note), note.slice(0, 70));

const href = await pg.locator('.veil a', { hasText: /Google Calendar/ }).first().getAttribute('href');
const add = new URL(href).searchParams.get('add');
ok('the Google Calendar link carries them as guests',
  add === 'ajarn@chula.ac.th,supplier@example.co.th', add);
await pg.screenshot({ path: 'g1-guests.png' });

console.log(errs.length?'\nERRORS: '+errs.join(' | '):'\nno console errors');

// ---- answering, and changing the answer --------------------------------
console.log('\nRSVP: answer, then change it deliberately');
await pg.keyboard.press('Escape');
await pg.evaluate(() => document.querySelectorAll('.veil').forEach((v) => v.remove()));
await pg.waitForTimeout(400);
await expandUpcoming(pg);
await pg.locator('.up-row.meeting', { hasText: tag }).first().click();
await pg.waitForTimeout(1400);

/**
 * Whoever called the meeting is already down as going — calling it is an
 * answer — so this opens on the answered state, which is the one Jade
 * reported: two buttons still sitting there as though nothing had registered.
 */
const rsvp = pg.locator('.veil .rsvp').first();
ok('the organiser opens on their answer, not on the question',
  (await rsvp.locator('button').count()) === 1 &&
  (await rsvp.innerText()).includes('คุณตอบรับแล้ว'),
  (await rsvp.innerText()).replace(/\n/g, ' | '));

await rsvp.locator('button', { hasText: 'เปลี่ยนคำตอบ' }).first().click();
await pg.waitForTimeout(400);
ok('pressing change brings the question back',
  (await rsvp.locator('button').count()) === 2,
  (await rsvp.locator('button').allInnerTexts()).join(' / '));

await rsvp.locator('button', { hasText: 'จะเข้าร่วม' }).first().click();
await pg.waitForTimeout(1200);
ok('the dialog stays open after answering',
  (await pg.locator('.veil .modal').count()) === 1);
ok('...and the question is replaced by the answer',
  (await rsvp.locator('button').count()) === 1 &&
  (await rsvp.innerText()).includes('คุณตอบรับแล้ว'),
  (await rsvp.innerText()).replace(/\n/g, ' | '));
ok('...with one button, to change it',
  (await rsvp.locator('button').first().innerText()).includes('เปลี่ยนคำตอบ'),
  await rsvp.locator('button').first().innerText());

await rsvp.locator('button').first().click();
await pg.waitForTimeout(500);
ok('pressing change brings the two answers back',
  (await rsvp.locator('button').count()) === 2,
  (await rsvp.locator('button').allInnerTexts()).join(' / '));

await rsvp.locator('button', { hasText: 'ไม่เข้าร่วม' }).first().click();
await pg.waitForTimeout(1200);
ok('...and the new answer is kept',
  (await rsvp.innerText()).includes('ไม่เข้าร่วม'),
  (await rsvp.innerText()).replace(/\n/g, ' | '));
await pg.screenshot({ path: 'g2-rsvp.png' });

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL RSVP CHECKS PASSED');
await b.close();
process.exit(failed ? 1 : 0);
