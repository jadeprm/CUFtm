/**
 * The two things เลขานุการ asked for: a Word original beside the PDF from the
 * moment a letter is filled in, and a way for them to send a letter back.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d='') => { console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`); if(!c) failed++; };
async function as(user, pass, opts) {
  const ctx = await b.newContext(opts);
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(`${user}: ${e.message}`));
  pg.on('dialog', async d => { await d.accept(d.type()==='prompt' ? 'ชื่อผู้รับสะกดผิด แก้แล้วส่งใหม่นะคะ' : ''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}
const DESK = { viewport: { width: 1440, height: 950 } };
const TITLE = 'WD: หนังสือขอใช้หอประชุม';

const kk = await as('Kungking_HeadCon', 'brandNew22', DESK);
await kk.evaluate(async (title) => {
  const j = (u, o) => fetch(u, o).then(r => r.json());
  for (const d of (await j('/api/documents')).documents || []) {
    if (d.title === title) await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
  }
}, TITLE);
await kk.evaluate(() => { location.hash = '#/docs'; }); await kk.waitForTimeout(1300);

console.log('\n1. Filling a letter in: the Word file sits beside the PDF');
await kk.locator('#main .page-head button.primary').first().click(); await kk.waitForTimeout(900);
ok('the form offers an editable original as well as the PDF',
  (await kk.locator('.modal .field', { hasText: 'ไฟล์ Word' }).count()) === 1);
ok('...marked as optional', (await kk.locator('.modal .opt-tag').innerText()).includes('ไม่บังคับ'));
await kk.locator('.modal input[type=text]').nth(1).fill(TITLE);
await kk.locator('.modal input[type=text]').nth(2).fill('คณะวิศวกรรมศาสตร์');
// Inside the university, so เลขานุการ need no address to forward to.
await kk.locator('.modal .inline-check input[type=checkbox]').first().check();
const pdfBytes = await kk.evaluate(async () => {
  const { PDFDocument } = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm').catch(() => ({}));
  return null;
});
// A one-page PDF built in the page, and a pretend .docx.
await kk.locator('.modal #doc-pdf').setInputFiles({
  name: 'letter.pdf', mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>'),
});
await kk.waitForTimeout(600);
await kk.locator('.modal #doc-source').setInputFiles({
  name: 'ขอใช้หอประชุม.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  buffer: Buffer.from('PK\u0003\u0004 docx'),
});
await kk.waitForTimeout(600);
ok('picking one names it back', (await kk.locator('.modal .field', { hasText: 'ไฟล์ Word' }).locator('.hint').innerText()).includes('.docx'));
await kk.locator('.modal .field', { hasText: 'ไฟล์ Word' }).scrollIntoViewIfNeeded();
await kk.waitForTimeout(300);
await kk.screenshot({ path: '/tmp/claude-0/wd-form.png' });

/**
 * All the way through the real form, because a Word file that only works
 * when the document is built over the API is a Word file that does not work.
 */
await kk.locator('.modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' })
  .locator('input[type="checkbox"]').check();
await kk.waitForTimeout(200);
await kk.locator('.modal footer .btn.primary').click(); await kk.waitForTimeout(2500);
ok('the form moves on to the chain with the Word file attached',
  (await kk.locator('.modal .chain-row').count()) >= 2,
  String(await kk.locator('.modal .chain-row').count()));
await kk.locator('.modal footer .btn.primary').click();
await kk.waitForFunction(() => {
  const c = document.querySelector('.veil .pdf-canvas');
  return c && c.width > 400 && c.height > c.width;
}, null, { timeout: 30000 });
await kk.waitForTimeout(400);
const signers = kk.locator('.veil .seg.wrap button');
const nMarks = await signers.count();
for (let i = 0; i < nMarks; i += 1) {
  await signers.nth(i).click();
  await kk.waitForFunction(() => {
    const c = document.querySelector('.veil .pdf-canvas');
    return c && c.width > 400;
  }, null, { timeout: 30000 });
  await kk.waitForTimeout(300);
  const sheet = kk.locator('.veil .pdf-sheet');
  const box = await sheet.boundingBox();
  await sheet.click({ position: { x: box.width * (0.25 + i * 0.15), y: box.height * 0.72 } });
  await kk.waitForTimeout(350);
}
await kk.locator('.veil footer button.primary').click();
await kk.waitForSelector('.veil .doc-done', { timeout: 25000 }).catch(async () => {
  console.log('  (stuck — footer:', (await kk.locator('.veil footer').innerText()).replace(/\s+/g, ' '),
    '| page errors:', JSON.stringify(errs), ')');
});
ok('submitting the form with a Word file attached finishes',
  (await kk.locator('.veil .doc-done').count()) === 1);
await kk.locator('.veil footer .btn').last().click().catch(() => {});
await kk.waitForTimeout(800);

const made = await kk.evaluate(async (title) =>
  ((await (await fetch('/api/documents')).json()).documents || []).find((d) => d.title === title), TITLE);
ok('the letter exists, built the way a person would build it', Boolean(made && made.id),
  JSON.stringify(made || {}).slice(0, 90));
if (made) {
  const files = await kk.evaluate(async (id) =>
    (await (await fetch('/api/documents?id=' + id)).json()).files.map((f) => f.kind).sort().join(), made.id);
  ok('...with the Word original stored beside the PDF', files.includes('source'), files);
}

if (made && made.id) {
  console.log('\n2. It reaches เลขานุการ, who can send it back');
  const boss = await as('Jade_Pres', 'fairAdmin1', DESK);
  await boss.evaluate(async (id) => {
    for (let i = 0; i < 8; i += 1) {
      const d = await (await fetch('/api/documents?id=' + id)).json();
      const next = (d.steps || []).find((s) => s.state === 'waiting');
      if (!next || next.role === 'secretary' || next.role === 'sender') break;
      const who = next.username;
      // Only the person whose turn it is may sign; this browser is Jade's, so
      // anything in front of her is approved from the writer's tab instead.
      await fetch('/api/documents?do=approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, who }) });
      const after = await (await fetch('/api/documents?id=' + id)).json();
      if (JSON.stringify(after.steps) === JSON.stringify(d.steps)) break;
    }
  }, made.id);
  // Whatever Jade could not sign, the writer signs.
  await kk.evaluate(async (id) => {
    for (let i = 0; i < 4; i += 1) {
      await fetch('/api/documents?do=approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    }
  }, made.id);
  await boss.evaluate(async (id) => {
    for (let i = 0; i < 4; i += 1) {
      await fetch('/api/documents?do=approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    }
  }, made.id);

  const sec = await as('Sunday_Sec', 'sundayPw1', DESK);
  await sec.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
  await sec.waitForTimeout(2300);
  const stage = await sec.evaluate(async (id) => (await (await fetch('/api/documents?id=' + id)).json()).document.stage, made.id);
  ok('it is sitting with เลขานุการ', stage === 'secretary', stage);
  const buttons = (await sec.locator('#modal-root footer .btn').allInnerTexts()).join(' | ');
  ok('they are offered ส่งแล้ว and ตีกลับ', /ส่งให้ผู้รับแล้ว|ส่งแล้ว/.test(buttons) && /ตีกลับ/.test(buttons), buttons);
  ok('...and the Word original is there to download',
    (await sec.locator('#modal-root .chip.dept.src').count()) === 1,
    (await sec.locator('#modal-root .chip.dept').allInnerTexts()).join(' / '));
  await sec.screenshot({ path: '/tmp/claude-0/wd-secretary.png' });

  await sec.locator('#modal-root footer .btn.danger', { hasText: 'ตีกลับ' }).click();
  await sec.waitForTimeout(2300);
  const back = await sec.evaluate(async (id) => (await (await fetch('/api/documents?id=' + id)).json()), made.id);
  ok('sending it back works from the page', back.document.stage === 'rejected', back.document.stage);
  ok('...and the Word file survives for the writer to fix',
    (back.files || []).map((f) => f.kind).join() === 'source', (back.files || []).map((f) => f.kind).join() || '(none)');

  await kk.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
  await kk.waitForTimeout(2200);
  const writerSees = await kk.locator('#modal-root').innerText();
  ok('the writer sees why it came back', /สะกดผิด/.test(writerSees), writerSees.split('\n').filter((l) => /สะกด/.test(l)).join(' '));
  ok('...and can still pick up the Word file', (await kk.locator('#modal-root .chip.dept.src').count()) === 1);
  await kk.screenshot({ path: '/tmp/claude-0/wd-writer.png' });
  await kk.evaluate((id) => fetch('/api/documents?id=' + id, { method: 'DELETE' }), made.id);
}

console.log('errs', JSON.stringify(errs));
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close(); process.exit(failed ? 1 : 0);
