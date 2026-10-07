/**
 * The two moments somebody waits at: while the app loads, and before it opens.
 * Both used to be a blank white screen.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const ctx = await b.newContext({ viewport:{width:1280,height:900}, deviceScaleFactor:1.4 });
const pg = await ctx.newPage();
const errs=[]; pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
pg.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text());});
let failed=0; const ok=(l,c,d='')=>{console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`);if(!c)failed++;};

console.log('\nWhile the app is loading');
// Hold the API so the splash is the only thing on screen, as on a slow phone.
await pg.route('**/api/auth', async (route) => {
  await new Promise((r) => setTimeout(r, 2500));
  await route.continue();
});
await pg.goto('http://localhost:4700/', { waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(400);

ok('something is on screen straight away', await pg.locator('#boot-view').isVisible());
ok('...the app name, so it is recognisably the right site',
  (await pg.locator('#boot-view').innerText()).includes('งานจุฬาฯแฟร์'),
  (await pg.locator('#boot-view').innerText()).replace(/\n/g, ' | '));
const painted = await pg.locator('#boot-view').evaluate(
  (el) => getComputedStyle(el).backgroundColor);
ok('...and it is painted, not transparent over a blank page',
  painted !== 'rgba(0, 0, 0, 0)', painted);
await pg.screenshot({ path: 'w1-loading.png' });

await pg.waitForTimeout(3000);
ok('the splash goes away once the app is ready',
  (await pg.locator('#boot-view').count()) === 0);
await pg.unroute('**/api/auth');

console.log('\nBefore the system opens');
await pg.route('**/api/meta', async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  body.comingSoon = true;
  body.opensAt = '20 ตุลาคม 2569';
  await route.fulfill({ response: res, body: JSON.stringify(body) });
});
await pg.goto('http://localhost:4700/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1500);

ok('a stranger gets the holding page, not a sign-in box',
  (await pg.locator('#soon-view').isVisible()) &&
  !(await pg.locator('#auth-view').isVisible()));
ok('...saying when it opens',
  (await pg.locator('#soon-when').innerText()).includes('20 ตุลาคม'),
  await pg.locator('#soon-when').innerText());
ok('...and who it is for',
  (await pg.locator('#soon-view').innerText()).includes('คณะกรรมการ'));
ok('...with no blank splash left behind', (await pg.locator('#boot-view').count()) === 0);
await pg.screenshot({ path: 'w2-soon.png' });

await pg.locator('#soon-signin').click();
await pg.waitForTimeout(600);
ok('a committee member can still get to the sign-in',
  (await pg.locator('#auth-view').isVisible()) &&
  !(await pg.locator('#soon-view').isVisible()));
ok('...and the address remembers that, so a reload does not trap them',
  pg.url().includes('enter=1'), pg.url());

await pg.goto('http://localhost:4700/?enter=1', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1200);
ok('opening with ?enter=1 skips the holding page entirely',
  await pg.locator('#auth-view').isVisible());

console.log(errs.length?'\nERRORS: '+errs.join(' | '):'\nno console errors');
console.log(failed?`\n${failed} CHECK(S) FAILED`:'\nALL CHECKS PASSED');
await b.close(); process.exit(failed?1:0);
