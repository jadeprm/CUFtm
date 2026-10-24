/**
 * AdSense on the sign-in screen, and on nothing else.
 *
 * The thing worth testing is not that a script tag appears — it is that it
 * stops appearing the moment somebody is inside the app. index.html is the
 * whole app, so a tag in the head would put Auto ads over the committee's
 * task board, and Auto ads keeps placing anchors after it loads, so taking
 * the elements away by hand would not hold either.
 *
 * The real site is the only host that loads it; ?ads=1 is how this suite
 * gets the same behaviour on localhost.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const head = (s) => console.log('\n' + s);

const SCRIPT = 'pagead2.googlesyndication.com';

async function page() {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  /**
   * Google's own script, answered locally. The sandbox cannot reach it, and
   * a suite that depends on a third party being up is a suite that goes red
   * for reasons that have nothing to do with the app.
   */
  await ctx.route(`**://*.${'googlesyndication.com'}/**`, (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: 'window.__adsenseLoaded = true;',
  }));
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(e.message));
  return pg;
}

const has = (pg) => pg.evaluate((needle) => Array.prototype.some.call(
  document.scripts, (s) => (s.src || '').indexOf(needle) !== -1), SCRIPT);

head('The sign-in screen');
const pg = await page();
await pg.goto(`http://localhost:${PORT}/?ads=1`, { waitUntil: 'networkidle' });
await pg.waitForTimeout(1500);
ok('the script is loaded where somebody signs in', await has(pg));
ok('...and it is Jade’s publisher id',
  await pg.evaluate((n) => Array.prototype.filter.call(document.scripts, (s) => (s.src || '').indexOf(n) !== -1)[0]
    .src.indexOf('ca-pub-6829067770704612') !== -1, SCRIPT));

head('Inside the app');
await pg.fill('#in-username', 'Jade_Pres');
await pg.click('#auth-submit');
await pg.waitForTimeout(1800);
await pg.fill('#in-password', 'fairAdmin1');
await pg.click('#auth-submit');
await pg.waitForTimeout(5000);
ok('signing in gets you into the app', await pg.locator('#app-view:not([hidden])').count() === 1);
ok('...and the ad script is gone with the page that carried it', !(await has(pg)));

head('Somebody who already has a session never sees it at all');
await pg.goto(`http://localhost:${PORT}/#/work`, { waitUntil: 'networkidle' });
await pg.waitForTimeout(2500);
ok('no sign-in screen, so no script', !(await has(pg)));

head('Anywhere that is not the real site');
const plain = await page();
await plain.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await plain.waitForTimeout(1500);
ok('localhost loads nothing, so dev and the other suites are untouched', !(await has(plain)));

ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
console.log(failed === 0 ? '\nADS OK' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
