/**
 * Pictures of every page, for the handbook.
 *
 * Not a test: it signs in as Jade on the development server and photographs
 * each page at retina size, so the user guide can show the real thing rather
 * than a drawing of it. Run it after a change that moves anything visible:
 *
 *   node dev-tests/srv2.mjs &
 *   node dev-tests/shots.mjs [outputDirectory]
 *
 * The web fonts come from Google, which a sandbox usually cannot reach; put
 * Anuphan in the system fonts first or the pictures come out in a fallback
 * face that is not what anybody sees in production.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { quietGuide } from './quiet.mjs';
const PORT = 4700;
const OUT = process.argv[2] || '/tmp/cuftm-shots';
mkdirSync(OUT, { recursive: true });
const b = quietGuide(await chromium.launch());
const errs = [];

async function signIn(viewport, deviceScaleFactor) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor });
  await ctx.addCookies([{ name: 'fair-test-home', value: '1', url: `http://localhost:${PORT}/` }]);
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push('ERR ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push('CON ' + m.text()); });
  pg.on('dialog', async (d) => { await d.accept(); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', 'fairAdmin1');
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
  await pg.click('#auth-submit'); await pg.waitForTimeout(2800);
  return pg;
}

const desk = await signIn({ width: 1440, height: 950 }, 2);
const go = async (hash, wait = 1600) => { await desk.evaluate((h) => { location.hash = h; }, hash); await desk.waitForTimeout(wait); };
const shot = async (name, opts = {}) => {
  await desk.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log('shot', name);
};

await go('#/home', 2600);
await shot('home');
// the overdue number, pressed
const kpis = await desk.locator('.kpi').count();
if (kpis >= 3) { await desk.locator('.kpi').nth(2).click(); await desk.waitForTimeout(900); }
await shot('home-kpi');

await go('#/work', 2200); await shot('work');
await go('#/schedule', 2200); await shot('schedule');
await go('#/calendar', 2200); await shot('calendar');
await go('#/docs', 2200); await shot('docs');
await go('#/shelf', 1800); await shot('shelf');
await go('#/guide', 2000); await shot('guide');
await go('#/control', 3500); await shot('control');
await go('#/profile', 2200); await shot('profile');
await go('#/account', 1800); await shot('account');
// the account page with one card open
const chg = desk.locator('.acct-change');
if (await chg.count()) { await chg.nth(2).click(); await desk.waitForTimeout(600); }
await shot('account-open');
await go('#/admin', 2400); await shot('admin');

// a phone, for the chapter about using it on the move
const phone = await signIn({ width: 390, height: 844, isMobile: true, hasTouch: true }, 3);
await phone.evaluate(() => { location.hash = '#/home'; }); await phone.waitForTimeout(2600);
await phone.screenshot({ path: `${OUT}/phone-home.png` });
await phone.evaluate(() => { location.hash = '#/work'; }); await phone.waitForTimeout(1800);
await phone.screenshot({ path: `${OUT}/phone-work.png` });
console.log('shot phone');

console.log(errs.length ? 'CONSOLE PROBLEMS:\n' + errs.slice(0, 12).join('\n') : 'no console errors');
await b.close();
