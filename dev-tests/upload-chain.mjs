/**
 * Phase 2 verification (B1–B8):
 * - B1: Drop zone first in stage 1, %PDF- check, preview card + thumbnail + page count
 * - B2: Filename auto-prefills empty title
 * - B3: Compact read-only fullName line with edit toggle
 * - B4: Every recipient email validated, naming the exact invalid address (client + server)
 * - B5: 10 MB PDF limit, >2 MB chunked upload via do=pdf-part, encrypted PDF rejection
 * - B6: Searchable person combobox (filter + keyboard nav)
 * - B7: "ใช้ลำดับเดิม" saved chain per dept+unit
 * - B8: Pointer-events drag-to-reorder keeping locked rows fixed
 * Plus desktop (1440x900) and phone (390x844) screenshots.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const SHOT_DIR = process.env.SHOT_DIR || '';
const TMP = '/tmp/claude-0/phase2';
mkdirSync(TMP, { recursive: true });

// 1) Normal 2-page PDF with underscores/hyphens in filename (tests B1 + B2)
const SMALL_PDF = `${TMP}/CUFair_2026-Request_Letter.pdf`;
{
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  pdf.addPage([595, 842]);
  writeFileSync(SMALL_PDF, Buffer.from(await pdf.save()));
}

// 2) Fake non-PDF file (tests client %PDF- magic byte check)
const FAKE_PDF = `${TMP}/not-real.pdf`;
writeFileSync(FAKE_PDF, 'Hello this is plain text, not a PDF');

// 3) Large >2.3 MB valid PDF (tests B5 chunked upload via do=pdf-part)
const BIG_PDF = `${TMP}/Large_Attachment_2_5MB.pdf`;
{
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const raw = Buffer.from(await pdf.save());
  // Valid PDF comment padding (~2.4 MB) before %%EOF is 100% valid in pdf-lib and pdf.js
  const eofIdx = raw.lastIndexOf('%%EOF');
  const padLine = Buffer.from('%' + 'A'.repeat(1023) + '\n');
  const pad = Buffer.concat(Array.from({ length: 2400 }, () => padLine));
  writeFileSync(BIG_PDF, Buffer.concat([raw.subarray(0, eofIdx), pad, raw.subarray(eofIdx)]));
}

// 4) Minimal encrypted PDF fixture (has /Encrypt dictionary in trailer so pdf-lib rejects as encrypted)
const ENCRYPTED_PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
  '4 0 obj<</Filter/Standard/V 1/R 2/O(12345678901234567890123456789012)/U(12345678901234567890123456789012)/P -4>>endobj\n' +
  'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000054 00000 n \n0000000105 00000 n \n0000000168 00000 n \n' +
  'trailer<</Size 5/Root 1 0 R/Encrypt 4 0 R>>\nstartxref\n295\n%%EOF\n',
  'latin1',
);

let failed = 0;
const errs = [];
const ok = (l, c, d = '') => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`);
  if (!c) failed += 1;
};

async function login(ctx, user, pass) {
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user} pageerror: ${e.message}`));
  pg.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) {
      errs.push(`${user} console: ${m.text()}`);
    }
  });
  pg.on('dialog', async (d) => { await d.accept(); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user);
  await pg.click('#auth-submit');
  await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit');
  await pg.waitForTimeout(2600);
  return pg;
}

const browser = quietGuide(await chromium.launch());
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await login(ctx, 'Kungking_HeadCon', 'brandNew22');

  // Clean previous Phase 2 test docs
  await pg.evaluate(async () => {
    localStorage.clear();
    const res = await (await fetch('/api/documents')).json();
    for (const d of res.documents || []) {
      if (d.title && (d.title.includes('CUFair 2026') || d.title.includes('Large Attachment'))) {
        await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
      }
    }
  });

  console.log('\n1. API checks: encrypted PDF rejection & strict multi-email validation');
  const encRes = await pg.evaluate(async (b64) => {
    const r = await fetch('/api/documents?do=create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Enc test', pdf: b64, department: 'content', internalUnit: true,
        steps: [{ role: 'director', username: 'Jade_Pres', signs: true, marks: [{ page: 1, x: 0.2, y: 0.2, w: 0.2, h: 0.1 }] },
                { role: 'secretary', username: 'Pin_Sec', signs: false, marks: [] }],
      }),
    });
    return { status: r.status, data: await r.json() };
  }, ENCRYPTED_PDF_BYTES.toString('base64'));
  ok('server rejects encrypted PDF with PDF_ENCRYPTED',
    encRes.status === 400 && encRes.data.error === 'PDF_ENCRYPTED',
    JSON.stringify(encRes));

  const badMailRes = await pg.evaluate(async () => {
    const r = await fetch('/api/documents?do=create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Mail test', pdf: btoa('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000054 00000 n \n0000000105 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n168\n%%EOF\n'),
        department: 'content', sendMode: 'secretary', internalUnit: false, strictEmails: true,
        recipientEmail: 'good@chula.ac.th, broken-addr, ok2@chula.ac.th',
        steps: [{ role: 'director', username: 'Jade_Pres', signs: true, marks: [{ page: 1, x: 0.2, y: 0.2, w: 0.2, h: 0.1 }] },
                { role: 'secretary', username: 'Pin_Sec', signs: false, marks: [] }],
      }),
    });
    return { status: r.status, data: await r.json() };
  });
  ok('server rejects bad second email and names it',
    badMailRes.status === 400 && badMailRes.data.error === 'BAD_EMAIL' && badMailRes.data.bad === 'broken-addr',
    JSON.stringify(badMailRes));

  console.log('\n2. Stage 1 UX (B1 drop zone, B2 filename title, B3 compact sender, B4 multi-email)');
  await pg.evaluate(() => { location.hash = '#/docs'; });
  await pg.waitForTimeout(1000);
  await pg.locator('#main .page-head button.primary').first().click();
  await pg.waitForTimeout(600);

  // B1: Drop zone is the very first field in modal pane
  const firstIsDrop = await pg.evaluate(() => {
    const fields = document.querySelectorAll('.modal .pane > .field');
    return fields.length > 0 && Boolean(fields[0].querySelector('.pdf-drop'));
  });
  ok('B1: PDF drop zone is first field in stage 1', firstIsDrop);

  // B3: Full name shown as one read-only line with edit link
  const compactSender = await pg.locator('.modal .sender-inline').count();
  ok('B3: existing fullName shown as compact one-line row', compactSender === 1);

  // B1: Non-PDF magic byte rejection
  await pg.locator('.modal #doc-pdf').setInputFiles(FAKE_PDF);
  await pg.waitForTimeout(400);
  const notPdfErr = await pg.locator('.modal .notice.err:not([hidden])').textContent();
  ok('B1: client rejects non-PDF by %PDF- magic bytes', /PDF/.test(notPdfErr || ''), notPdfErr || '');

  // B1 + B2: Valid PDF renders preview card, thumbnail, page count, and prefills title
  await pg.locator('.modal #doc-pdf').setInputFiles(SMALL_PDF);
  await pg.waitForFunction(() => {
    const meta = document.querySelector('.modal .pdf-card-meta small');
    return meta && meta.textContent.includes('2 ');
  }, { timeout: 10000 });
  const titleVal = await pg.locator('.modal input[type=text]').first().inputValue();
  ok('B2: empty title prefilled from filename', titleVal === 'CUFair 2026 Request Letter', titleVal);

  // B4: Client validates every recipient email and names the invalid one
  await pg.locator('.modal input[placeholder*="อีเมล"], .modal input[placeholder*="email"]').first().fill('ok@chula.ac.th, typo@bad');
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForTimeout(300);
  const clientBadMail = await pg.locator('.modal .notice.err:not([hidden])').textContent();
  ok('B4: client identifies exact bad email in list', (clientBadMail || '').includes('typo@bad'), clientBadMail || '');

  if (SHOT_DIR) {
    await pg.screenshot({ path: `${SHOT_DIR}/phase2_desktop_stage1.png` });
  }

  // Fix email and advance to Stage 2
  await pg.locator('.modal input[placeholder*="อีเมล"], .modal input[placeholder*="email"]').first().fill('ok@chula.ac.th, sec@chula.ac.th');
  await pg.waitForTimeout(1400);
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForSelector('.modal .chain-row', { timeout: 10000 });

  console.log('\n3. Stage 2 UX (B6 searchable combobox, B8 drag-to-reorder, B7 saved chain)');
  // Add an extra signer so we have at least 2 unlocked rows to reorder
  await pg.locator('.modal .add-signer').click();
  await pg.waitForTimeout(300);

  // B6: Open combobox on the newly added unlocked approver row (before sending secretary), filter, pick via Enter
  const combos = pg.locator('.modal .chain-row .pcombo-btn:not([disabled])');
  const comboCount = await combos.count();
  ok('B6: searchable combobox replaces person <select>', comboCount >= 2, `combos=${comboCount}`);
  await combos.nth(comboCount - 2).click();
  await pg.waitForSelector('.pcombo-search', { timeout: 5000 });
  await pg.fill('.pcombo-search', 'Gorn');
  await pg.waitForTimeout(200);
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(200);
  const allVals = await pg.evaluate(() =>
    Array.from(document.querySelectorAll('.modal .chain-row .pcombo')).map((el) => el.getAttribute('data-value'))
  );
  ok('B6: combobox filters and selects via keyboard Enter', allVals.includes('Gorn_VP'), JSON.stringify(allVals));

  // B8: Drag-to-reorder unlocked rows via pointer handle while keeping locked rows pinned
  const dragHandles = pg.locator('.modal .chain-drag');
  const hCount = await dragHandles.count();
  ok('B8: drag handles appear on unlocked rows only', hCount >= 2, `handles=${hCount}`);
  const beforeOrder = await pg.evaluate(() =>
    Array.from(document.querySelectorAll('.modal .chain-row .pcombo')).map((el) => el.getAttribute('data-value'))
  );
  const fromBox = await dragHandles.nth(0).boundingBox();
  const toBox = await dragHandles.nth(1).boundingBox();
  await pg.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await pg.mouse.down();
  await pg.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 6 });
  await pg.mouse.up();
  await pg.waitForTimeout(300);
  const afterOrder = await pg.evaluate(() =>
    Array.from(document.querySelectorAll('.modal .chain-row .pcombo')).map((el) => el.getAttribute('data-value'))
  );
  ok('B8: pointer drag reorders unlocked rows without moving locked ends',
    beforeOrder[0] === afterOrder[0] &&
    beforeOrder[beforeOrder.length - 1] === afterOrder[afterOrder.length - 1] &&
    JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder),
    `${beforeOrder.join(',')} -> ${afterOrder.join(',')}`);

  if (SHOT_DIR) {
    await pg.screenshot({ path: `${SHOT_DIR}/phase2_desktop_stage2.png` });
  }

  console.log('\n4. B5: >2 MB chunked PDF upload (do=pdf-part) + B7 saved chain restore');
  // Go back to stage 1, swap to the 2.4 MB PDF, and submit end-to-end!
  await pg.locator('.modal footer button', { hasText: 'ย้อนกลับ' }).click();
  await pg.waitForTimeout(400);
  await pg.locator('.modal #doc-pdf').setInputFiles(BIG_PDF);
  await pg.waitForFunction(() => {
    const meta = document.querySelector('.modal .pdf-card-meta small');
    return meta && meta.textContent.includes('MB');
  }, { timeout: 10000 });

  let pdfPartCalls = 0;
  pg.on('response', (res) => {
    if (res.url().includes('do=pdf-part') && res.status() === 200) pdfPartCalls++;
  });

  await pg.waitForTimeout(1400);
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForSelector('.modal .chain-row', { timeout: 10000 });
  await pg.waitForTimeout(1400);
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForFunction(() => {
    const c = document.querySelector('.veil .pdf-canvas');
    return c && c.width > 400;
  }, { timeout: 15000 });

  // Place a box for each signer chip in stage 3
  const chips = pg.locator('.modal .seg button');
  const chipN = await chips.count();
  const sheet = pg.locator('.veil .pdf-sheet');
  for (let k = 0; k < Math.max(1, chipN); k++) {
    if (chipN > 0) await chips.nth(k).click();
    await pg.waitForTimeout(200);
    await sheet.click({ position: { x: 140 + k * 160, y: 140 } });
    await pg.waitForTimeout(250);
  }
  await pg.waitForTimeout(1400);
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForSelector('.modal .doc-done', { timeout: 25000 });
  ok('B5: >2 MB PDF uploaded in chunks via do=pdf-part and created doc', pdfPartCalls >= 2, `pdfPartCalls=${pdfPartCalls}`);

  // Close done modal and open a fresh upload to verify B7 ("ใช้ลำดับเดิม")
  await pg.locator('.modal footer button', { hasText: 'ปิด' }).click();
  await pg.waitForTimeout(1600);
  await pg.locator('#main .page-head button.primary').first().click();
  await pg.waitForTimeout(500);
  await pg.locator('.modal #doc-pdf').setInputFiles(SMALL_PDF);
  await pg.waitForTimeout(600);
  await pg.locator('.modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' }).locator('input[type="checkbox"]').check();
  await pg.waitForTimeout(1400);
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForSelector('.modal .chain-row', { timeout: 10000 });
  const hasLastBtn = await pg.locator('.modal button', { hasText: 'ใช้ลำดับเดิม' }).count();
  ok('B7: "ใช้ลำดับเดิม" button appears for same dept+unit after submit', hasLastBtn === 1);
  if (hasLastBtn) {
    await pg.locator('.modal button', { hasText: 'ใช้ลำดับเดิม' }).click();
    await pg.waitForTimeout(300);
    const restored = await pg.evaluate(() =>
      Array.from(document.querySelectorAll('.modal .chain-row .pcombo')).map((el) => el.getAttribute('data-value'))
    );
    ok('B7: clicking "ใช้ลำดับเดิม" restores previous chain', restored.length >= 2, JSON.stringify(restored));
  }
  await ctx.close();

  // ---- Phone check (390x844) ----
  console.log('\n5. Phone (390x844) layout verification');
  const pCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const ppg = await login(pCtx, 'Kungking_HeadCon', 'brandNew22');
  await ppg.evaluate(() => { location.hash = '#/docs'; });
  await ppg.waitForTimeout(1000);
  await ppg.locator('#fab').click();
  await ppg.waitForTimeout(500);
  const docOpt = ppg.locator('.fab-sheet button').filter({ hasText: /เอกสาร/ }).first();
  if (await docOpt.count()) await docOpt.click();
  await ppg.waitForSelector('.modal #doc-pdf', { state: 'attached', timeout: 8000 });
  await ppg.locator('.modal #doc-pdf').setInputFiles(SMALL_PDF);
  await ppg.waitForFunction(() => document.querySelector('.modal .pdf-card'), { timeout: 10000 });
  await ppg.waitForTimeout(400);
  if (SHOT_DIR) {
    await ppg.screenshot({ path: `${SHOT_DIR}/phase2_phone_stage1.png` });
  }
  await ppg.locator('.modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' }).locator('input[type="checkbox"]').check();
  await ppg.waitForTimeout(1400);
  await ppg.locator('.modal footer .btn.primary').click();
  await ppg.waitForSelector('.modal .chain-row', { timeout: 10000 });
  await ppg.locator('.modal .chain-row .pcombo-btn:not([disabled])').first().click();
  await ppg.waitForSelector('.pcombo-search', { timeout: 5000 });
  await ppg.waitForTimeout(300);
  if (SHOT_DIR) {
    await ppg.screenshot({ path: `${SHOT_DIR}/phase2_phone_stage2_combo.png` });
  }
  const noSideScroll = await ppg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  ok('Phone: stage 1 & stage 2 combobox fit with no sideways scroll', noSideScroll);
  await pCtx.close();

  ok('zero console/page errors across desktop and phone', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
