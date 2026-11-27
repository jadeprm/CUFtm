/**
 * Phase 5 verification (E1–E4):
 * - E1: SHA-256 stored for original PDF and every stamped PDF in doc_files
 * - E2: Existing doc_events extended with actor, ip, user_agent logging all lifecycle events
 * - E3: Appended Thai "ประวัติการลงนาม" page on completed PDF (never duplicated on rebuild/move-mark)
 * - E4: Chronological audit timeline & SHA-256 verification card rendered in openDoc() on desktop & phone
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const SHOT_DIR = process.env.SHOT_DIR || '';
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fairv2';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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
  page.on('dialog', async (d) => { await d.accept(); });
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

// Build a clean 2-page PDF buffer
const madePdf = await PDFDocument.create();
madePdf.addPage([595, 842]);
madePdf.addPage([595, 842]);
const origBuf = Buffer.from(await madePdf.save());
const origExpectedSha = sha256(origBuf);

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();

const browser = quietGuide(await chromium.launch());
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const boss = await login(ctx, 'Jade_Pres', 'fairAdmin1');

  // Clean previous Phase 5 test docs
  await boss.evaluate(async () => {
    const list = (await (await fetch('/api/documents')).json()).documents || [];
    for (const d of list) {
      if (d.title && d.title.includes('Phase5 Audit Trail')) {
        await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
      }
    }
  });

  console.log('\n1. E1 & E2: Create 2-page doc, complete chain, verify SHA-256 & doc_events columns');
  const created = await boss.evaluate(async (b64) => {
    const r = await fetch('/api/documents?do=create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Phase5 Audit Trail Test',
        sendMode: 'self',
        internalUnit: true,
        pdf: b64,
        steps: [
          { role: 'author', username: 'Jade_Pres', signs: true,
            marks: [{ page: 2, x: 0.2, y: 0.7, w: 0.22, h: 0.07, kind: 'signature' }] },
          { role: 'deptHead', username: 'Kungking_HeadCon', signs: true,
            marks: [{ page: 2, x: 0.55, y: 0.7, w: 0.22, h: 0.07, kind: 'signature' }] },
          { role: 'sender', username: 'Jade_Pres', signs: false, marks: [] },
        ],
      }),
    });
    return r.json();
  }, origBuf.toString('base64'));
  const docId = created.id;
  ok('created 2-page test document', Boolean(docId), docId || '');

  // Check original SHA-256 stored immediately on create (E1)
  const { rows: origRow } = await db.query(
    `SELECT sha256, pages FROM doc_files WHERE doc_id = $1 AND kind = 'original'`, [docId],
  );
  ok('E1: original PDF SHA-256 matches exact buffer digest',
    origRow[0]?.sha256 === origExpectedSha && origRow[0]?.pages === 2,
    `${(origRow[0]?.sha256 || '').slice(0, 12)}...`);

  // Approve step 2 as Jade_Pres standing in for Kungking_HeadCon -> completes chain!
  const approveRes = await boss.evaluate(async (id) => {
    const r = await fetch('/api/documents?do=approve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, comment: 'ตรวจสอบเรียบร้อย' }),
    });
    return { status: r.status, data: await r.json() };
  }, docId);
  ok('chain completed by approving final signing step', approveRes.status === 200 && approveRes.data.stage === 'secretary',
    JSON.stringify(approveRes.data));

  // Verify E1 & E3: signed PDF now has 3 pages (2 original + 1 appended Thai audit page) & matching SHA-256
  const { rows: signedRow } = await db.query(
    `SELECT bytes, sha256, pages FROM doc_files WHERE doc_id = $1 AND kind = 'signed'`, [docId],
  );
  const signedBuf = signedRow[0]?.bytes;
  const loadedSigned = await PDFDocument.load(signedBuf);
  ok('E1: signed PDF SHA-256 stored and matches actual bytes',
    signedRow[0]?.sha256 === sha256(signedBuf), `${(signedRow[0]?.sha256 || '').slice(0, 12)}...`);
  ok('E3: completed signed PDF appends 1 "ประวัติการลงนาม" page (2 -> 3 pages)',
    signedRow[0]?.pages === 3 && loadedSigned.getPageCount() === 3,
    `pages=${loadedSigned.getPageCount()}`);

  // Verify E3 non-duplication: moving a mark rebuilds from untouched original -> STILL 3 pages (never 4!)
  const { rows: stRows } = await db.query(
    `SELECT id FROM doc_steps WHERE doc_id = $1 AND role = 'author'`, [docId],
  );
  await boss.evaluate(async ({ id, stepId }) => {
    await fetch('/api/documents?do=move-mark', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, stepId, marks: [{ page: 2, x: 0.25, y: 0.65, w: 0.22, h: 0.07, kind: 'signature' }] }),
    });
  }, { id: docId, stepId: stRows[0].id });
  const { rows: afterMove } = await db.query(
    `SELECT pages, sha256, bytes FROM doc_files WHERE doc_id = $1 AND kind = 'signed'`, [docId],
  );
  ok('E3: rebuilding on move-mark keeps exactly 3 pages (no duplicate audit page) and updates SHA-256',
    afterMove[0]?.pages === 3 && afterMove[0]?.sha256 === sha256(afterMove[0].bytes) && afterMove[0]?.sha256 !== signedRow[0].sha256,
    `pages=${afterMove[0]?.pages}`);

  // Verify E2: doc_events recorded actor, ip, user_agent and expected lifecycle kinds
  const { rows: evRows } = await db.query(
    `SELECT kind, username, actor, ip, user_agent FROM doc_events WHERE doc_id = $1 ORDER BY at`, [docId],
  );
  const kinds = evRows.map((e) => e.kind);
  const hasMeta = evRows.some((e) => e.kind === 'created' && e.actor === 'Jade_Pres' && e.user_agent);
  ok('E2: doc_events logs created, sent_to_step, signed, acted_for, completed with actor & user_agent',
    ['created', 'sent_to_step', 'signed', 'acted_for', 'completed'].every((k) => kinds.includes(k)) && hasMeta,
    kinds.join(','));

  console.log('\n2. E4: Audit timeline & SHA-256 card in openDoc() + appended PDF page viewer');
  await boss.evaluate((id) => { location.hash = '#/d/' + id; }, docId);
  await boss.waitForSelector('.veil .audit-box', { timeout: 12000 });
  const auditItems = await boss.locator('.veil .audit-list .audit-item').count();
  const hashRows = await boss.locator('.veil .audit-hashes .audit-hash-row').count();
  ok('E4 Desktop: openDoc renders audit timeline and both SHA-256 hashes',
    auditItems >= 4 && hashRows === 2, `items=${auditItems} hashes=${hashRows}`);
  await boss.locator('.veil .audit-box').scrollIntoViewIfNeeded();
  await boss.waitForTimeout(300);
  if (SHOT_DIR) {
    await boss.screenshot({ path: `${SHOT_DIR}/phase5_desktop_audit_timeline.png` });
  }

  // Open the signed PDF in the built-in viewer and flip to page 3 (the Thai audit page!)
  await boss.locator('.veil .view-rows button', { hasText: 'ไฟล์ที่ลงนามแล้ว' }).click();
  await boss.waitForFunction(() => {
    const all = document.querySelectorAll('.veil');
    const top = all[all.length - 1];
    const c = top && top.querySelector('.pdf-canvas');
    return c && c.width > 400;
  }, { timeout: 15000 });
  const topVeil = boss.locator('#modal-root .veil').last();
  await topVeil.locator('.pdf-pager button', { hasText: '›' }).click();
  await boss.waitForTimeout(400);
  await topVeil.locator('.pdf-pager button', { hasText: '›' }).click();
  await boss.waitForTimeout(700);
  const p3Label = await topVeil.locator('.pdf-pager span').textContent();
  ok('E3 Viewer: signed PDF renders appended page 3 / 3 cleanly in built-in viewer',
    (p3Label || '').includes('3 / 3'), p3Label || '');
  if (SHOT_DIR) {
    await boss.screenshot({ path: `${SHOT_DIR}/phase5_desktop_audit_pdf_page.png` });
  }
  await ctx.close();

  // Phone verification (390x844)
  console.log('\n3. Phone (390x844) audit timeline verification');
  const pCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pboss = await login(pCtx, 'Jade_Pres', 'fairAdmin1');
  await pboss.evaluate((id) => { location.hash = '#/d/' + id; }, docId);
  await pboss.waitForSelector('.veil .audit-box', { timeout: 12000 });
  await pboss.locator('.veil .audit-box').scrollIntoViewIfNeeded();
  await pboss.waitForTimeout(400);
  const phoneNoSide = await pboss.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  ok('E4 Phone: audit timeline & SHA-256 card fit with zero sideways scroll', phoneNoSide);
  if (SHOT_DIR) {
    await pboss.screenshot({ path: `${SHOT_DIR}/phase5_phone_audit_timeline.png` });
  }
  await pCtx.close();

  ok('zero console/page errors across desktop and phone', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
  await db.end();
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
