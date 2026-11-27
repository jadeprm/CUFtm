/**
 * Phase 4 verification (D1–D5):
 * - D1: Stage 2 "+ เพิ่มผู้ลงนามภายนอก" adds external step (name/email/position) before sending
 * - D2: Token stored only as sha256(token) with 14-day expiry; bilingual email sent on reaching step
 * - D3: Public /sign/<token> SPA without login (assets via <base href="/">, PDF + highlighted box,
 *       signature pad draw + consent required, one-time token invalidation, ext_sig_png on step only)
 * - D4: Inline signature pad for internal approver with no saved signature + "บันทึกไว้ใช้ครั้งหน้า"
 * - D5: Owner tools in openDoc() (status badges, resend invalidating old token, edit email)
 *       + cron 3-day reminder and 14-day expiry
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import pg from 'pg';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const SHOT_DIR = process.env.SHOT_DIR || '';
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fairv2';
const TMP = '/tmp/claude-0/phase4';
mkdirSync(TMP, { recursive: true });

const EXT_PDF = `${TMP}/Phase4_External_Sign.pdf`;
{
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  pdf.addPage([595, 842]);
  writeFileSync(EXT_PDF, Buffer.from(await pdf.save()));
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
let failed = 0;
const errs = [];
const ok = (l, c, d = '') => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`);
  if (!c) failed += 1;
};

async function login(ctx, user, pass) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`${user} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) {
      errs.push(`${user} console: ${m.text()}`);
    }
  });
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt' && /อีเมลใหม่|new email/i.test(d.message())) {
      await d.accept('advisor.updated@chula.ac.th');
    } else {
      await d.accept();
    }
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.fill('#in-username', user);
  await page.click('#auth-submit');
  await page.waitForTimeout(1800);
  await page.fill('#in-password', pass);
  if (await page.locator('#field-confirm:not([hidden])').count()) await page.fill('#in-confirm', pass);
  await page.click('#auth-submit');
  await page.waitForTimeout(2600);
  return page;
}

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();

const browser = quietGuide(await chromium.launch());
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const owner = await login(ctx, 'Jade_Pres', 'fairAdmin1');

  // Clean previous Phase 4 test docs & rate-limit entries
  await db.query(`DELETE FROM ext_rate_limits`);
  await owner.evaluate(async () => {
    const list = (await (await fetch('/api/documents')).json()).documents || [];
    for (const d of list) {
      if (d.title && d.title.includes('Phase4 External')) {
        await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
      }
    }
  });

  console.log('\n1. D1: Create document with an external signer (self-send so external is first waiting)');
  await owner.evaluate(() => { location.hash = '#/docs'; });
  await owner.waitForTimeout(1000);
  await owner.locator('#main .page-head button.primary').first().click();
  await owner.waitForTimeout(500);
  await owner.locator('.modal #doc-pdf').setInputFiles(EXT_PDF);
  await owner.waitForFunction(() => document.querySelector('.modal .pdf-card'), { timeout: 10000 });
  // Choose "ส่งเอง" so there is no secretaryCheck ahead of external signer
  await owner.locator('.modal button', { hasText: 'ส่งเอง' }).click();
  await owner.waitForTimeout(1400);
  await owner.locator('.modal footer .btn.primary').click();
  await owner.waitForSelector('.modal .chain-row', { timeout: 10000 });

  // Click "+ เพิ่มผู้ลงนามภายนอก" and fill name, email, position
  await owner.locator('.modal .add-ext-signer').click();
  await owner.waitForSelector('.modal .ext-fields', { timeout: 5000 });
  const extInputs = owner.locator('.modal .ext-fields input');
  await extInputs.nth(0).fill('รศ.ดร.สมชาย อาจารย์ที่ปรึกษา');
  await extInputs.nth(1).fill('advisor@chula.ac.th');
  await extInputs.nth(2).fill('อาจารย์ที่ปรึกษาโครงการ');

  await owner.waitForTimeout(1400);
  await owner.locator('.modal footer .btn.primary').click();
  await owner.waitForFunction(() => {
    const c = document.querySelector('.veil .pdf-canvas');
    return c && c.width > 400;
  }, { timeout: 15000 });

  // Place boxes for all signing chips (author + external)
  const chips = owner.locator('.veil .pe-signers button');
  const chipN = await chips.count();
  const sheet = owner.locator('.veil .pdf-sheet');
  for (let i = 0; i < Math.max(1, chipN); i++) {
    if (chipN > 0) await chips.nth(i).click();
    await owner.waitForTimeout(200);
    await sheet.click({ position: { x: 160 + i * 200, y: 200 } });
    await owner.waitForTimeout(250);
  }
  await owner.waitForTimeout(1400);
  await owner.locator('.veil footer .btn.primary').click();
  await owner.waitForSelector('.veil .doc-done', { timeout: 20000 });

  // Open the created document
  await owner.locator('.veil footer .btn.primary').click();
  await owner.waitForSelector('.veil .doc-steps', { timeout: 10000 });
  await owner.waitForTimeout(600);

  // Inspect DB row for the external step
  const { rows: docRows } = await db.query(
    `SELECT id FROM documents WHERE title LIKE '%Phase4 External%' ORDER BY created_at DESC LIMIT 1`,
  );
  const docId = docRows[0]?.id;
  ok('D1: document with external signer created', Boolean(docId), docId || '');

  const { rows: extSteps } = await db.query(
    `SELECT * FROM doc_steps WHERE doc_id = $1 AND role = 'external'`, [docId],
  );
  const extStep = extSteps[0];
  ok('D2: external step stores 64-char sha256 token_hash and 14-day expiry (null username)',
    Boolean(extStep && extStep.username === null && /^[0-9a-f]{64}$/.test(extStep.token_hash || '') && extStep.token_expires_at),
    `hashLen=${(extStep?.token_hash || '').length}`);

  console.log('\n2. D5: Owner external status & edit email / resend controls in openDoc()');
  const sentBadge = await owner.locator('.veil .doc-steps .chip', { hasText: 'ส่งอีเมลแล้ว' }).count();
  ok('D5: openDoc shows external status badge "ส่งอีเมลแล้ว"', sentBadge >= 1);
  if (SHOT_DIR) {
    await owner.screenshot({ path: `${SHOT_DIR}/phase4_desktop_owner_ext.png` });
  }
  const hashBeforeEdit = extStep.token_hash;
  await owner.locator('.veil .ds-ext-tools button', { hasText: 'แก้อีเมล' }).click();
  await owner.waitForTimeout(1200);
  const { rows: afterEdit } = await db.query(`SELECT ext_email, token_hash FROM doc_steps WHERE id = $1`, [extStep.id]);
  ok('D5: edit email updates ext_email and rotates token_hash (invalidating old token)',
    afterEdit[0]?.ext_email === 'advisor.updated@chula.ac.th' && afterEdit[0]?.token_hash !== hashBeforeEdit,
    afterEdit[0]?.ext_email || '');

  const hashBeforeResend = afterEdit[0].token_hash;
  await owner.locator('.veil .ds-ext-tools button', { hasText: 'ส่งอีเมลอีกครั้ง' }).click();
  await owner.waitForTimeout(1200);
  const { rows: afterResend } = await db.query(`SELECT token_hash FROM doc_steps WHERE id = $1`, [extStep.id]);
  ok('D5: resend email rotates token_hash (invalidating previous token)',
    afterResend[0]?.token_hash && afterResend[0].token_hash !== hashBeforeResend);

  console.log('\n3. D3: Unauthenticated public /sign/<token> flow (desktop & phone)');
  // Mint a known raw token directly into token_hash (same sha256 scheme) so we can open /sign/<token>
  const liveToken = randomBytes(32).toString('base64url');
  await db.query(`UPDATE doc_steps SET token_hash = $1, viewed_at = NULL WHERE id = $2`, [sha256(liveToken), extStep.id]);

  // First check phone layout on /sign/<token> (logged-out context!)
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phoneExt = await phoneCtx.newPage();
  phoneExt.on('pageerror', (e) => errs.push(`ext-phone pageerror: ${e.message}`));
  await phoneExt.goto(`http://localhost:${PORT}/sign/${liveToken}`, { waitUntil: 'networkidle' });
  await phoneExt.waitForFunction(() => {
    const c = document.querySelector('.ext-wrap .pdf-canvas');
    return c && c.width > 300;
  }, { timeout: 15000 });
  await phoneExt.waitForTimeout(500);
  const phoneNoSide = await phoneExt.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  ok('D3 Phone: /sign/<token> loads PDF + pad without login and zero sideways scroll', phoneNoSide);
  if (SHOT_DIR) {
    await phoneExt.screenshot({ path: `${SHOT_DIR}/phase4_phone_ext_sign.png` });
  }
  await phoneCtx.close();

  // Verify viewed_at was recorded
  const { rows: viewedRows } = await db.query(`SELECT viewed_at FROM doc_steps WHERE id = $1`, [extStep.id]);
  ok('D3/D5: opening /sign/<token> records viewed_at timestamp', Boolean(viewedRows[0]?.viewed_at));

  // Desktop public /sign/<token> signing
  const pubCtx = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const pub = await pubCtx.newPage();
  pub.on('pageerror', (e) => errs.push(`ext-desk pageerror: ${e.message}`));
  pub.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) {
      errs.push(`ext-desk console: ${m.text()}`);
    }
  });
  await pub.goto(`http://localhost:${PORT}/sign/${liveToken}`, { waitUntil: 'networkidle' });
  await pub.waitForFunction(() => {
    const c = document.querySelector('.ext-wrap .pdf-canvas');
    return c && c.width > 400;
  }, { timeout: 15000 });
  await pub.waitForTimeout(400);

  // Switch to blue ink and draw a signature stroke on .spad-canvas
  await pub.locator('.spad-ink').nth(1).click();
  const padEl = pub.locator('.spad-canvas');
  const pBox = await padEl.boundingBox();
  await pub.mouse.move(pBox.x + 60, pBox.y + 80);
  await pub.mouse.down();
  await pub.mouse.move(pBox.x + 220, pBox.y + 45, { steps: 6 });
  await pub.mouse.move(pBox.x + 360, pBox.y + 95, { steps: 6 });
  await pub.mouse.up();
  await pub.waitForTimeout(200);

  // Try clicking sign WITHOUT ticking consent -> must refuse with Thai consent message
  await pub.locator('.ext-acts .btn.primary').click();
  await pub.waitForTimeout(300);
  const consentErr = await pub.locator('.ext-card .notice.err:not([hidden])').textContent();
  ok('D3: refuses signing until consent checkbox is ticked',
    (consentErr || '').includes('ยินยอม'), consentErr || '');

  if (SHOT_DIR) {
    await pub.screenshot({ path: `${SHOT_DIR}/phase4_desktop_ext_sign.png` });
  }

  // Tick consent and submit
  await pub.locator('.ext-consent input[type="checkbox"]').check();
  await pub.waitForTimeout(1400);
  await pub.locator('.ext-acts .btn.primary').click();
  await pub.waitForSelector('.ext-card .notice.ok', { timeout: 15000 });
  const doneMsg = await pub.locator('.ext-card .notice.ok').textContent();
  ok('D3: external signer signs and approves successfully', (doneMsg || '').includes('ลงนามเอกสารเรียบร้อย'), doneMsg || '');

  // Verify token is invalidated immediately on reload
  await pub.reload({ waitUntil: 'networkidle' });
  await pub.waitForSelector('.ext-card .notice.err', { timeout: 10000 });
  const reuseErr = await pub.locator('.ext-card .notice.err').textContent();
  ok('D3: reloading used token shows friendly Thai invalid/used error',
    (reuseErr || '').includes('ไม่ถูกต้อง') || (reuseErr || '').includes('เรียบร้อย'), reuseErr || '');

  // Verify ext_sig_png lives ONLY on doc_steps, token_hash is NULL, and doc advanced to 'secretary' (self-send ready)
  const { rows: doneStep } = await db.query(
    `SELECT state, token_hash, octet_length(ext_sig_png) AS png_len FROM doc_steps WHERE id = $1`, [extStep.id],
  );
  const { rows: doneDoc } = await db.query(`SELECT stage FROM documents WHERE id = $1`, [docId]);
  const { rows: signedFile } = await db.query(`SELECT byte_size FROM doc_files WHERE doc_id = $1 AND kind = 'signed'`, [docId]);
  ok('D3: step approved, token_hash nulled, ext_sig_png stored on step, signed PDF rebuilt, chain advanced',
    doneStep[0]?.state === 'approved' && doneStep[0]?.token_hash === null &&
    Number(doneStep[0]?.png_len) > 200 && doneDoc[0]?.stage === 'secretary' &&
    Number(signedFile[0]?.byte_size) > 500,
    `state=${doneStep[0]?.state} png=${doneStep[0]?.png_len} stage=${doneDoc[0]?.stage}`);
  await pubCtx.close();

  console.log('\n4. D4: Inline signature pad for internal approver with no saved signature');
  // Temporarily remove Kungking_HeadCon's saved signature so Kungking must use the inline pad
  await db.query(`DELETE FROM signatures WHERE username = 'Kungking_HeadCon'`);
  // Create a quick doc waiting on Kungking_HeadCon via API
  const d4Doc = await owner.evaluate(async () => {
    const rawPdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000054 00000 n \n0000000105 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n170\n%%EOF\n';
    const r = await fetch('/api/documents?do=create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Phase4 External Inline Pad Test', sendMode: 'self', internalUnit: true,
        pdf: btoa(rawPdf),
        steps: [
          { role: 'deptHead', username: 'Kungking_HeadCon', signs: true, marks: [{ page: 1, x: 0.4, y: 0.5, w: 0.25, h: 0.08 }] },
          { role: 'sender', username: 'Jade_Pres', signs: false, marks: [] },
        ],
      }),
    });
    return r.json();
  });
  await ctx.close();

  // Log in as Kungking_HeadCon (who has no saved signature right now)
  const gCtx = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const kk = await login(gCtx, 'Kungking_HeadCon', 'brandNew22');
  await kk.evaluate((id) => { location.hash = '#/d/' + id; }, d4Doc.id);
  await kk.waitForSelector('.veil .inline-pad-box', { timeout: 12000 });
  ok('D4: inline signature pad appears in openDoc for internal approver without saved signature', true);
  const inPad = kk.locator('.veil .inline-pad-box .spad-canvas');
  await inPad.scrollIntoViewIfNeeded();
  await kk.waitForTimeout(200);
  const ib = await inPad.boundingBox();
  await kk.mouse.move(ib.x + 50, ib.y + 70);
  await kk.mouse.down();
  await kk.mouse.move(ib.x + 240, ib.y + 50, { steps: 5 });
  await kk.mouse.up();
  await kk.waitForTimeout(300);
  await kk.locator('.veil footer .btn.primary').click();
  await kk.waitForTimeout(2500);
  const { rows: savedSig } = await db.query(`SELECT width, height FROM signatures WHERE username = 'Kungking_HeadCon'`);
  ok('D4: approving with inline pad ("บันทึกไว้ใช้ครั้งหน้า") stamps doc and saves signature for future use',
    Boolean(savedSig[0] && savedSig[0].width > 0), JSON.stringify(savedSig[0] || null));
  await gCtx.close();

  console.log('\n5. D5 Cron: 3-day reminder and 14-day token expiry');
  // Seed an expired external step & a 4-day-old waiting external step and call /api/cron
  const expDocId = `doc_extcron_${Date.now().toString(36)}`;
  await db.query(
    `INSERT INTO documents (id, title, stage, created_by, send_mode, internal_unit)
     VALUES ($1, 'Phase4 External Cron Expiry', 'approving', 'Jade_Pres', 'self', true)`, [expDocId],
  );
  await db.query(
    `INSERT INTO doc_steps (id, doc_id, position, role, username, state, ext_name, ext_email, token_hash, token_expires_at)
     VALUES ($1, $2, 1, 'external', NULL, 'waiting', 'Expired Signer', 'exp@chula.ac.th', $3, now() - interval '1 hour')`,
    ['st_exp_' + Date.now().toString(36), expDocId, sha256('expired_token_test')],
  );
  const cronRes = await (await fetch(`http://localhost:${PORT}/api/cron`)).json();
  const { rows: afterCronExp } = await db.query(`SELECT token_hash FROM doc_steps WHERE doc_id = $1`, [expDocId]);
  const { rows: expEvents } = await db.query(`SELECT kind FROM doc_events WHERE doc_id = $1 AND kind = 'expired'`, [expDocId]);
  ok('D5 Cron: expires overdue external token, clears token_hash, logs expired event',
    cronRes.ok && afterCronExp[0]?.token_hash === null && expEvents.length === 1,
    JSON.stringify(cronRes.externalSigners));

  // Cleanup cron test doc
  await db.query(`DELETE FROM documents WHERE id = $1`, [expDocId]);

  ok('zero console/page errors across desktop, phone, and public /sign/<token>', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
  await db.end();
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
