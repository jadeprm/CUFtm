/**
 * The health panel's new Drive block, looked at rather than assumed.
 *
 * Two runs: the state Jade is probably in (no Drive credentials, PDFs piling
 * up in Postgres) and the state she wants (archived, and the database being
 * emptied behind it). The first is the one that has to be impossible to miss.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4400';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const ctx = await b.newContext({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(2500);
await pg.fill('#in-password', 'fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2500);

/** The health panel lives on the admin page. */
async function openHealth() {
  // Clicked, not navigated to: a fresh load of #/admin races the router
  // against sign-in and lands on the work page, which is not what a person
  // ever does.
  await pg.locator('#tabs a[href="#/admin"]').first().click();
  await pg.waitForTimeout(2600);
  const all = await pg.locator('.notice').allInnerTexts();
  console.log('  notices found: ' + all.length);
  const health = all.find((x) => /PDF|Drive/.test(x)) || all[all.length - 1] || '';
  return health.replace(/\n+/g, ' | ');
}

console.log('\nThe health panel, Drive NOT configured');
let text = await openHealth();
console.log('  panel:', text.slice(0, 600));
ok('it says Drive is not connected', /ยังไม่ได้เชื่อม Google Drive|not connected/.test(text));
ok('...and says the PDFs will keep growing', /จะโตขึ้น|keep growing/.test(text));
ok('...and gives the weight being held right now', /PDF/.test(text) && /(KB|MB)/.test(text));
await pg.screenshot({ path: 'h1-drive-off.png', fullPage: false });

console.log(errs.length ? '\nERRORS: ' + errs.join(' | ') : '\nno console errors');
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(failed ? 1 : 0);
