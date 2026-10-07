/** Short links and their QR codes, in a real browser. */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const ctx = await b.newContext({ viewport: { width: 1240, height: 1000 } });
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
pg.on('dialog', async d => { console.log('  DIALOG:', d.message().slice(0, 50)); await d.accept(); });

let failed = 0;
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };

await pg.goto('http://localhost:4700/', { waitUntil: 'networkidle' });
await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(3000);
await pg.fill('#in-password', 'fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2500);

console.log('\nShort links');

// Reached from the profile menu, not a sixth tab.
await pg.click('#me-avatar'); await pg.waitForTimeout(400);
ok('the profile menu offers it', await pg.locator('#me-pop a[href="#/links"]').count() === 1);
await pg.locator('#me-pop a[href="#/links"]').click();
await pg.waitForTimeout(1200);
ok('the page opens', await pg.locator('.link-form').count() === 1);

await pg.locator('.link-form input[type="url"]').fill('https://forms.gle/cufair-volunteer-2026');
await pg.locator('.link-form input[type="text"]').first().fill('รับสมัครอาสาสมัคร');
await pg.locator('.link-form input.code-input').fill('volunteer');
await pg.locator('.link-form button.primary').click();
await pg.waitForTimeout(1800);

ok('making one opens its QR code straight away', await pg.locator('.veil .qr-canvas').count() === 1);
const shown = await pg.locator('.veil .qr-url').innerText();
ok('...showing the whole address that goes on the poster',
  /^https?:\/\/[^/]+\/s\/VOLUNTEER$/.test(shown), shown);

const drawn = await pg.evaluate(() => {
  const c = document.querySelector('.veil .qr-canvas');
  const x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
  return { w: c.width, h: c.height, darkShare: dark / (d.length / 4) };
});
ok('...actually drawn, not an empty square',
  drawn.darkShare > 0.15 && drawn.darkShare < 0.6, JSON.stringify(drawn));
ok('...and big enough to print', drawn.w >= 480, `${drawn.w}px`);
await pg.screenshot({ path: 'z-qr.png', fullPage: false });

/**
 * The code is put through a real QR decoder.
 *
 * Drawing black squares that look right is not the same as producing a code a
 * phone can read, and the difference would only be discovered after five
 * hundred posters had been printed. The pixels are taken out of the canvas and
 * decoded exactly as a camera would.
 */
const pixels = await pg.evaluate(() => {
  const c = document.querySelector('.veil .qr-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  return { w: c.width, h: c.height, data: Array.from(d.data) };
});
const jsQR = (await import('jsqr')).default;
const read = jsQR(Uint8ClampedArray.from(pixels.data), pixels.w, pixels.h);
ok('a real QR decoder can read it',
  Boolean(read) && read.data.endsWith('/s/VOLUNTEER'), read ? read.data : 'could not decode');
/**
 * And what it reads has to be a WHOLE address. A camera has no idea what site
 * the code came from, so a relative /s/CODE in a QR is a code that goes
 * nowhere — which is what happens when the server has no SITE_URL configured.
 */
ok('...and what it reads is a complete address, not a relative path',
  Boolean(read) && /^https?:\/\/[^/]+\/s\/VOLUNTEER$/.test(read.data),
  read ? read.data : '-');

await pg.locator('.veil footer button').last().click();
await pg.waitForTimeout(600);

const row = pg.locator('.link-row').filter({ hasText: 'VOLUNTEER' }).first();
ok('it is listed', await row.count() === 1);
ok('...with the destination shown in full, so it can be checked before printing',
  (await row.locator('.lr-target').innerText()).includes('forms.gle/cufair-volunteer-2026'),
  await row.locator('.lr-target').innerText());

/**
 * The redirect, followed by a real browser that has never signed in.
 *
 * Pointed at a page this sandbox can actually reach — the destination being
 * off the network would fail the navigation for reasons that have nothing to
 * do with the redirect working.
 */
await pg.evaluate(async () => {
  await fetch('/api/meta?do=link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://localhost:4700/icon-192.png', code: 'LOCAL' }),
  });
});
const visitor = await (await b.newContext()).newPage();
await visitor.goto('http://localhost:4700/s/local', { waitUntil: 'domcontentloaded' })
  .catch(() => {});
console.log('  followed /s/local →', visitor.url().slice(0, 60));
ok('a short link redirects a browser that has never signed in',
  visitor.url().includes('/icon-192.png'), visitor.url().slice(0, 60));

await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(1800);
const hits = await pg.locator('.link-row').filter({ hasText: 'LOCAL' }).first()
  .locator('.lr-hits b').innerText();
ok('...and the click is counted on the page', Number(hits) >= 1, hits);

// A dead code explains itself.
await visitor.goto('http://localhost:4700/s/NOSUCH', { waitUntil: 'domcontentloaded' });
ok('a wrong code shows a page people can read',
  (await visitor.locator('body').innerText()).includes('ไม่พบลิงก์นี้'),
  (await visitor.locator('body').innerText()).split('\n')[0]);
await visitor.screenshot({ path: 'z-missing.png' });

console.log(errs.length ? '\nERRORS: ' + errs.join(' | ') : '\nno console errors');
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(failed ? 1 : 0);
