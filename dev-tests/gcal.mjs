/** The Google Calendar link, where a person would look for it. */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const pg = await (await b.newContext({viewport:{width:1700,height:1000},deviceScaleFactor:1.3})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
let failed=0; const ok=(l,c,d='')=>{console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`);if(!c)failed++;};
await pg.goto('http://localhost:4700/', { waitUntil:'networkidle' });
await pg.fill('#in-username','Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(2200);
await pg.fill('#in-password','fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm','fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2600);

await pg.locator('.event-card.meeting').first().click(); await pg.waitForTimeout(1500);
const link = pg.locator('.veil a', { hasText: /Google Calendar/ }).first();
ok('the meeting shows an "add to Google Calendar" link', await link.count() === 1);
const href = await link.getAttribute('href');
console.log('  href:', (href||'').slice(0, 90));
ok('...pointing at Google, in Bangkok time',
  /^https:\/\/calendar\.google\.com\/calendar\/render\?/.test(href||'') &&
  (href||'').includes('ctz=Asia%2FBangkok'));
ok('...and opening in a new tab rather than leaving the app',
  await link.getAttribute('target') === '_blank');
await pg.screenshot({ path: 'c1-gcal.png' });
console.log(errs.length?'\nERRORS: '+errs.join(' | '):'\nno console errors');
console.log(failed?`\n${failed} CHECK(S) FAILED`:'\nALL CHECKS PASSED');
await b.close(); process.exit(failed?1:0);
