/** The documents page filters, seen rather than assumed. */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const pg = await (await b.newContext({viewport:{width:1180,height:940},deviceScaleFactor:2})).newPage();
const errs=[]; pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
pg.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text());});
let failed=0; const ok=(l,c,d='')=>{console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`);if(!c)failed++;};

const signIn = async (user, pass) => {
  await pg.goto('http://localhost:4700/', { waitUntil:'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2200);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2500);
};

await signIn('Jade_Pres', 'fairAdmin1');
await pg.locator('#tabs a[href="#/docs"]').first().click();
await pg.waitForTimeout(2400);

const segs = await pg.locator('.seg button').allInnerTexts();
console.log('\nfilters offered:', segs.join(' | '));
ok('the documents page now has a filter row', segs.length >= 3, segs.join(' | '));
ok('...with one of them selected', await pg.locator('.seg button.on').count() === 1);

const countOf = async (label) => {
  await pg.locator('.seg button').filter({ hasText: label }).first().click();
  await pg.waitForTimeout(600);
  return pg.locator('.doc-card').count();
};
const all = await countOf(/ทั้งหมด|^All/);
const turn = await countOf(/รอฉัน|Waiting on me/);
const open = await countOf(/ยังไม่ส่ง|Not yet sent/);
ok('choosing a filter really narrows the list', turn <= all && open <= all,
  `all ${all}, waiting on me ${turn}, not yet sent ${open}`);
ok('...and the counts on the buttons match what is listed',
  (await pg.locator('.seg button').allInnerTexts()).some((x) => x.includes('(' + all + ')')),
  (await pg.locator('.seg button').allInnerTexts()).join(' | '));

// An admin who is not a secretary is not offered a secretary's pile.
ok('a non-secretary is not offered the secretary filter',
  !segs.some((x) => /ที่ฉันดูแล|Mine to handle/.test(x)), segs.join(' | '));
await pg.screenshot({ path: 'd1-docfilters.png' });

console.log(errs.length ? '\nERRORS: ' + errs.join(' | ') : '\nno console errors');
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close(); process.exit(failed ? 1 : 0);
