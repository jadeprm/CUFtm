/** The avatar cropper, and the new short codes, in a real browser. */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
import { writeFileSync } from 'node:fs';

const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const pg = await (await b.newContext({ viewport: { width: 1200, height: 950 } })).newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
pg.on('dialog', async d => { console.log('  DIALOG:', d.message().slice(0, 60)); await d.accept(); });

let failed = 0;
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };

await pg.goto('http://localhost:4700/', { waitUntil: 'networkidle' });
await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit'); await pg.waitForTimeout(3000);
await pg.fill('#in-password', 'fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2500);

// --- short codes and search -------------------------------------------------
const made = await pg.evaluate(async () => {
  const mk = async (title, description) => {
    const r = await fetch('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, description, dueDate: '2026-12-05', assignees: ['Jade_Pres'], notify: [] }),
    });
    return (await r.json()).task;
  };
  return [await mk('ติดต่อฝ่ายสถานที่', 'เรื่องลานพระบรมรูป'), await mk('สรุปงบประมาณ', 'ตัวเลขจากเหรัญญิก')];
});
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(2000);

console.log('\nShort codes and search');
const codes = await pg.locator('li.task .t-code').allInnerTexts();
ok('every card shows its code', codes.length >= 2 && /^T\d{4}$/.test(codes[0]), codes.slice(0, 3).join(' '));

const search = pg.locator('input.search');
await search.fill(made[0].code);
await pg.waitForTimeout(700);
let titles = await pg.locator('li.task .t-title').allInnerTexts();
ok('searching a code finds exactly that task',
  titles.length === 1 && titles[0].includes('ติดต่อฝ่ายสถานที่'), titles.join(' | '));

await search.fill('เหรัญญิก');
await pg.waitForTimeout(700);
titles = await pg.locator('li.task .t-title').allInnerTexts();
ok('...and searching words reaches the description',
  titles.length === 1 && titles[0].includes('สรุปงบประมาณ'), titles.join(' | '));

await search.fill('');
await pg.waitForTimeout(700);
ok('clearing the box brings everything back',
  (await pg.locator('li.task').count()) >= 2, String(await pg.locator('li.task').count()));

await pg.locator('li.task').first().click();
await pg.waitForTimeout(900);
ok('the code is on the task itself, ready to copy',
  await pg.locator('.veil .view-code').count() === 1,
  await pg.locator('.veil .view-code').innerText().catch(() => '-'));
await pg.keyboard.press('Escape');
await pg.waitForTimeout(500);

// --- the cropper ------------------------------------------------------------
console.log('\nProfile picture');
await pg.click('#me-avatar'); await pg.waitForTimeout(400);
await pg.locator('#me-pop a[href="#/profile"]').click();
await pg.waitForTimeout(1500);

// A wide picture, so a blind centre crop would obviously lose the sides.
const wide = Buffer.from(await pg.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#b51e64'; x.fillRect(0, 0, 600, 200);
  x.fillStyle = '#fff'; x.fillRect(0, 0, 100, 200);
  const b64 = c.toDataURL('image/png').split(',')[1];
  return Array.from(atob(b64), ch => ch.charCodeAt(0));
}));
writeFileSync('/tmp/wide.png', wide);

await pg.locator('#main input[type="file"][accept="image/*"]').setInputFiles('/tmp/wide.png');
await pg.waitForTimeout(1200);
ok('choosing a picture opens the cropper', await pg.locator('.veil .crop-canvas').count() === 1);
ok('...with a zoom control', await pg.locator('.veil .crop-zoom').count() === 1);
await pg.screenshot({ path: 'x-crop.png', fullPage: false });

// Drag it, zoom it, and keep it.
const box = await pg.locator('.veil .crop-canvas').boundingBox();
await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await pg.mouse.down();
await pg.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 8 });
await pg.mouse.up();
await pg.locator('.veil .crop-zoom').fill('160');
await pg.waitForTimeout(400);
await pg.screenshot({ path: 'x-crop2.png', fullPage: false });

await pg.locator('.veil footer button.primary').click();
await pg.waitForTimeout(900);
ok('the cropper closes on Use this picture', await pg.locator('.veil').count() === 0);

const preview = await pg.locator('#main .avatar img, #main .avatar.lg img').first().getAttribute('src');
ok('...and the preview is the cropped square',
  Boolean(preview && preview.startsWith('data:image/jpeg')), (preview || '').slice(0, 30));

const shape = await pg.evaluate((src) => new Promise((res) => {
  const i = new Image();
  i.onload = () => res(i.width + 'x' + i.height);
  i.src = src;
}), preview);
ok('...saved square, at avatar size', shape === '192x192', shape);

const saveBtn = pg.locator('#main .modal > footer button.primary').first();
await saveBtn.click();
await pg.waitForTimeout(2000);
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(2000);
ok('it survives a reload', Boolean(await pg.locator('#me-avatar img').count()));

console.log(errs.length ? '\nERRORS: ' + errs.join(' | ') : '\nno console errors');
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(failed ? 1 : 0);
