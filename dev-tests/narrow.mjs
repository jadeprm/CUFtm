/**
 * The work list in a narrow column.
 *
 * The row is a six-column grid with five fixed columns, so everything the
 * window loses comes out of the title. On a laptop with the sidebar open the
 * title column fell to 26px and then to nothing, and a Thai title came out one
 * syllable per line — a row three hundred pixels tall. What has run out is the
 * width of the LIST, not of the window, so the fix is a container query and
 * this checks it at the widths people actually use.
 */
import { chromium } from 'playwright';

const PORT = process.argv[2] || '4700';
const ORIGIN = `http://localhost:${PORT}`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let failed = 0;
const errs = [];
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
await pg.fill('#in-password', 'fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2500);
for (let i = 0; i < 6; i++) { await pg.keyboard.press('Escape'); await pg.waitForTimeout(300); }
await pg.evaluate(() => { const r = document.getElementById('modal-root'); if (r) r.innerHTML = ''; });

await pg.goto(ORIGIN + '/#/work', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1200);
const listBtn = pg.locator('.view-seg button').nth(1);
if (await listBtn.count()) { await listBtn.click(); await pg.waitForTimeout(1200); }

const measure = () => pg.evaluate(() => {
  const rows = [...document.querySelectorAll('ul.list-view li.lrow')];
  // The CELL the title sits in, not the text: a short title is narrow because
  // it is short, which says nothing about whether there was room for it.
  const cells = [...document.querySelectorAll('ul.list-view .t-title')];
  return {
    title: Math.round(Math.min(...cells.map((n) => n.getBoundingClientRect().width))),
    tallest: Math.round(Math.max(...rows.map((r) => r.getBoundingClientRect().height))),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

console.log('\nThe work list, as the window narrows');
for (const w of [1440, 1200, 1040, 900, 800, 740]) {
  await pg.setViewportSize({ width: w, height: 900 });
  await pg.waitForTimeout(500);
  const m = await measure();
  ok(`at ${w}px the title still has room to read`, m.title >= 120, `title ${m.title}px`);
  ok(`...and no row is taller than two lines`, m.tallest <= 110, `tallest ${m.tallest}px`);
  ok(`...and nothing hangs off the side`, m.overflow <= 2, `overflow ${m.overflow}px`);
}

console.log(errs.length ? '\nconsole errors: ' + errs.join(' | ') : '\nno console errors');
if (errs.length) failed++;
console.log(failed === 0 ? '\nNARROW OK' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
