/** Short links and their QR codes, in a real browser. */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const ctx = await b.newContext({ viewport: { width: 1240, height: 1000 }, acceptDownloads: true });
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

/**
 * The two downloads.
 *
 * The plain PNG is the code itself; the A4 sheet is the thing people actually
 * print. Both are saved through a blob and a real anchor — an unattached
 * anchor with a data URL opens the image as a page in Safari instead of
 * saving it, which is what "the QR isn't centred when I download it" was.
 */
const saved = {};
for (const [label, key] of [[/แผ่นพร้อมพิมพ์/, 'sheet'], [/ดาวน์โหลด PNG/, 'plain']]) {
  const [dl] = await Promise.all([
    pg.waitForEvent('download', { timeout: 15000 }),
    pg.locator('.veil footer button').filter({ hasText: label }).click(),
  ]);
  saved[key] = `/tmp/claude-0/links-qr-${key}.png`;
  await dl.saveAs(saved[key]);
  saved[key + 'Name'] = dl.suggestedFilename();
}
ok('the plain PNG downloads as a file', /^qr-VOLUNTEER\.png$/.test(saved.plainName || ''), saved.plainName);
ok('...and the printable one beside it', /^qr-VOLUNTEER-a4\.png$/.test(saved.sheetName || ''), saved.sheetName);

/** Where the ink actually sits on each page, measured rather than assumed. */
const inkOf = async (file) => pg.evaluate(async (bytes) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + bytes;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let minX = 1e9; let minY = 1e9; let maxX = -1; let maxY = -1;
  for (let y = 0; y < c.height; y++) {
    for (let xx = 0; xx < c.width; xx++) {
      const i = (y * c.width + xx) * 4;
      if (d[i] < 128) {
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { w: c.width, h: c.height,
    left: minX, right: c.width - 1 - maxX, top: minY, bottom: c.height - 1 - maxY };
}, (await import('node:fs')).readFileSync(file).toString('base64'));

const plainInk = await inkOf(saved.plain);
ok('the plain PNG is the code with an even quiet zone round it',
  plainInk.left === plainInk.right && plainInk.top === plainInk.bottom && plainInk.left > 0,
  JSON.stringify(plainInk));

const sheetInk = await inkOf(saved.sheet);
ok('the sheet is A4 at 300dpi', sheetInk.w === 2480 && sheetInk.h === 3508,
  `${sheetInk.w}×${sheetInk.h}`);
/**
 * Within a few pixels at 300 dpi: the code is centred exactly, and the lines
 * of text are centred on their own middle, which the glyphs' side bearings
 * move by a fraction of a millimetre either way.
 */
ok('...with everything on it centred across the page',
  Math.abs(sheetInk.left - sheetInk.right) <= 12, `${sheetInk.left} / ${sheetInk.right}`);
ok('...and sitting in the middle of it, not high or low',
  Math.abs(sheetInk.top - sheetInk.bottom) <= 60, `${sheetInk.top} / ${sheetInk.bottom}`);

/**
 * The sheet is decoded INSIDE the page.
 *
 * A4 at 300 dpi is 8.7 million pixels, and handing that to Node as an array
 * of 35 million numbers took the run past its time limit and got the process
 * killed — all the checks passing, no summary, and the fixture left behind
 * for the next run to trip over. The decoder goes to the pixels instead.
 */
// Resolved against the repository, not the shell: this suite lives in
// dev-tests/ but the package is installed at the root.
await pg.addScriptTag({ path: new URL('../node_modules/jsqr/dist/jsQR.js', import.meta.url).pathname });
const sheetText = await pg.evaluate(async (bytes) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + bytes;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height);
  const got = window.jsQR(d.data, c.width, c.height);
  return got ? got.data : null;
}, (await import('node:fs')).readFileSync(saved.sheet).toString('base64'));
ok('...and the code on the printed sheet still scans',
  Boolean(sheetText) && sheetText.endsWith('/s/VOLUNTEER'),
  sheetText || 'could not decode');

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

/**
 * Both fixture codes go, win or lose.
 *
 * They are unique by design, so a run that left them behind made the NEXT run
 * fail at "making one opens its QR code straight away" — a confusing way to
 * be told that the last run crashed.
 */
await pg.evaluate(async () => {
  const d = await (await fetch('/api/meta?do=links')).json();
  for (const l of (d.links || [])) {
    if (['VOLUNTEER', 'LOCAL'].includes(String(l.code).toUpperCase())) {
      await fetch('/api/meta?do=link&code=' + encodeURIComponent(l.code), { method: 'DELETE' });
    }
  }
}).catch(() => {});

console.log(errs.length ? '\nERRORS: ' + errs.join(' | ') : '\nno console errors');
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(failed ? 1 : 0);
