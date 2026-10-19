/**
 * Approving without signing, from the form.
 *
 * Unticking ลงลายเซ็น beside a step used to make the letter impossible to
 * submit: the form stopped asking for that person's box and the server went
 * on demanding one, so every press of ส่งเรื่อง answered "ต้องวางช่องลงนาม
 * อย่างน้อยหนึ่งจุด" and named nobody. Reported 19 October.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
async function as(user, pass) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 980 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(`${user}: ${m.text()}`); });
  pg.on('dialog', async (d) => { await d.accept(''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}
const TITLE = 'SO: หนังสืออนุมัติไม่ลงนาม';
const LETTER = '/tmp/claude-0/so-letter.pdf';
{
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { PDFDocument } = await import('pdf-lib');
  const made = await PDFDocument.create();
  made.addPage([595.28, 841.89]);
  made.addPage([595.28, 841.89]);
  mkdirSync('/tmp/claude-0', { recursive: true });
  writeFileSync(LETTER, Buffer.from(await made.save()));
}

const kk = await as('Kungking_HeadCon', 'brandNew22');
await kk.evaluate(async (title) => {
  for (const d of (await (await fetch('/api/documents')).json()).documents || []) {
    if (d.title === title) await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
  }
}, TITLE);

await kk.evaluate(() => { location.hash = '#/docs'; }); await kk.waitForTimeout(1400);
await kk.locator('#main .page-head button.primary').first().click(); await kk.waitForTimeout(900);
await kk.locator('.modal input[type=text]').nth(1).fill(TITLE);
await kk.locator('.modal input[type=text]').nth(2).fill('คณะวิศวกรรมศาสตร์');
await kk.locator('.modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' }).locator('input[type="checkbox"]').check();
await kk.locator('.modal #doc-pdf').setInputFiles(LETTER);
await kk.waitForTimeout(900);
await kk.locator('.modal footer .btn.primary').click(); await kk.waitForTimeout(2500);

console.log('\n1. Taking the tick off one signer');
const ticks = kk.locator('.modal .chain .inline-check input[type=checkbox]:checked');
const before = await ticks.count();
ok('the chain offers a ลงลายเซ็น tick on more than one step', before >= 2, `${before} ticked`);
await ticks.last().uncheck();
await kk.waitForTimeout(300);
await kk.screenshot({ path: '/tmp/claude-0/so-chain.png' });

await kk.locator('.modal footer .btn.primary').click();
await kk.waitForFunction(() => {
  const c = document.querySelector('.veil .pdf-canvas');
  return c && c.width > 400;
}, null, { timeout: 30000 });
await kk.waitForTimeout(600);
const chips = await kk.locator('.veil .seg.wrap button').count();
ok('...so the marks page asks for one fewer box', chips === before - 1, `${chips} of ${before}`);

const sheet = kk.locator('.veil .pdf-sheet');
for (let i = 0; i < chips; i += 1) {
  await kk.locator('.veil .seg.wrap button').nth(i).click();
  await kk.waitForFunction(() => { const c = document.querySelector('.veil .pdf-canvas'); return c && c.width > 400; }, null, { timeout: 30000 });
  await kk.waitForTimeout(300);
  const bb = await sheet.boundingBox();
  await sheet.click({ position: { x: bb.width * (0.3 + i * 0.12), y: bb.height * 0.78 } });
  await kk.waitForTimeout(350);
}

console.log('\n2. And it submits');
await kk.locator('.veil footer button.primary').click();
await kk.waitForTimeout(4000);
const stuck = await kk.locator('.veil .notice.err:not([hidden])').allInnerTexts();
ok('no "ต้องวางช่องลงนาม" dead end', !stuck.some((x) => /ช่องลงนาม/.test(x)),
  stuck.join(' | ') || 'no error shown');
ok('...the letter is submitted', (await kk.locator('.veil .doc-done').count()) === 1);
await kk.screenshot({ path: '/tmp/claude-0/so-done.png' });

const made = await kk.evaluate(async (title) =>
  ((await (await fetch('/api/documents')).json()).documents || []).find((d) => d.title === title), TITLE);
ok('...and really is in the system', Boolean(made && made.id));
if (made) {
  const full = await kk.evaluate(async (id) => (await (await fetch('/api/documents?id=' + id)).json()), made.id);
  ok('...with the unticked step recorded as approving without a signature',
    full.steps.some((s) => s.signs === false && s.role !== 'secretary' && s.role !== 'sender'),
    JSON.stringify(full.steps.map((s) => [s.role, s.signs])));
  await kk.evaluate((id) => fetch('/api/documents?id=' + id, { method: 'DELETE' }), made.id);
}

if (errs.length) { console.log('\nPAGE ERRORS:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }
console.log(failed === 0 && errs.length === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 && errs.length === 0 ? 0 : 1);
