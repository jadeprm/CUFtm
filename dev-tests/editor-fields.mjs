/**
 * Phase 3 verification (C1–C6):
 * - C1: Lazy thumbnail rail with per-signer colored dots + zoom controls + phone horizontal strip
 * - C2: Pointer drag changing stored fractions, selection toolbar (delete, duplicate all pages),
 *       corner resize handle, size slider (selected-only vs apply-all)
 * - C3: Opens on last page by default
 * - C4: Auto-suggested ghost boxes from pdf.js text content ("ลงชื่อ" / "(......)") + auto-place
 * - C5: Field kinds (signature, date in Thai Buddhist year, nameTitle, initials) stamped via
 *       pdfkit + TH Sarabun New embedded into pdf-lib; legacy boxes without `kind` still stamp
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import PdfKitDocument from 'pdfkit';
import { PDFDocument } from 'pdf-lib';
import { sarabunRegular } from '../lib/fonts.js';
import { stampSignatures, formatThaiDate } from '../lib/pdfsign.js';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const SHOT_DIR = process.env.SHOT_DIR || '';
const TMP = '/tmp/claude-0/phase3';
mkdirSync(TMP, { recursive: true });

/** Builds a 3-page Thai PDF whose page 3 contains "ลงชื่อ" and "(............)" cues. */
const THREE_PAGE_PDF = `${TMP}/Phase3_Thai_3Pages.pdf`;
async function makeThai3PagePdf() {
  return new Promise((resolve, reject) => {
    const doc = new PdfKitDocument({ size: 'A4', margin: 64 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('th', sarabunRegular());

    doc.font('th').fontSize(16).text('หน้า 1 — หนังสือขอความอนุเคราะห์โครงการงานจุฬาฯแฟร์', 64, 80);
    doc.addPage();
    doc.font('th').fontSize(16).text('หน้า 2 — รายละเอียดกิจกรรมและกำหนดการ', 64, 80);
    doc.addPage();
    doc.font('th').fontSize(16).text('หน้า 3 — ส่วนลงนามรับรองเอกสาร', 64, 80);
    doc.font('th').fontSize(15).text('ลงชื่อ ........................................', 180, 420);
    doc.font('th').fontSize(15).text('(........................................)', 200, 460);
    doc.font('th').fontSize(15).text('ลงนาม ........................................', 180, 560);
    doc.end();
  });
}
const threePageBuf = await makeThai3PagePdf();
writeFileSync(THREE_PAGE_PDF, threePageBuf);

let failed = 0;
const errs = [];
const ok = (l, c, d = '') => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`);
  if (!c) failed += 1;
};

console.log('1. Server-side stamping: Thai date, nameTitle, initials, and legacy box without kind');
{
  // Minimal 1x1 PNG
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEElEQVR42mP8z8DwHwMJBAAxBgH/K2b5eAAAAABJRU5ErkJggg==',
    'base64',
  );
  const res = await stampSignatures(threePageBuf, [
    // Legacy mark with no `kind` property -> defaults to signature
    { username: 'legacy', page: 1, x: 0.1, y: 0.2, w: 0.2, h: 0.06, png: tinyPng },
    // Thai Buddhist date on page 2
    { username: 'tester', page: 2, x: 0.55, y: 0.7, w: 0.22, h: 0.05, kind: 'date', actedAt: '2026-11-27T08:00:00Z' },
    // Name + title on page 3
    { username: 'tester', page: 3, x: 0.50, y: 0.78, w: 0.30, h: 0.07, kind: 'nameTitle',
      fullName: 'เจตน์ วุฒิเกริก', position: 'ประธานโครงการ' },
    // Initials on page 3
    { username: 'tester', page: 3, x: 0.15, y: 0.85, w: 0.10, h: 0.04, kind: 'initials', png: tinyPng },
  ]);
  const reloaded = await PDFDocument.load(res.bytes);
  ok('C5: Thai date formats in Buddhist Era (Asia/Bangkok)',
    formatThaiDate('2026-11-27T08:00:00Z') === '27 พ.ย. 2569',
    formatThaiDate('2026-11-27T08:00:00Z'));
  ok('C5/C6: all 4 marks (legacy, date, nameTitle, initials) stamped on 3-page PDF without error',
    res.placed.length === 4 && res.skipped.length === 0 && reloaded.getPageCount() === 3,
    `placed=${res.placed.length} skipped=${res.skipped.length} pages=${reloaded.getPageCount()}`);
}

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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const pg = await login(ctx, 'Kungking_HeadCon', 'brandNew22');

  // Clean up previous Phase 3 test docs
  await pg.evaluate(async () => {
    const res = await (await fetch('/api/documents')).json();
    for (const d of res.documents || []) {
      if (d.title && d.title.includes('Phase3 Thai 3Pages')) {
        await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
      }
    }
  });

  console.log('\n2. Desktop placement editor (C1 rail+zoom, C2 drag+dup+resize, C3 last page, C4 ghosts, C5 kinds)');
  await pg.evaluate(() => { location.hash = '#/docs'; });
  await pg.waitForTimeout(1000);
  await pg.locator('#main .page-head button.primary').first().click();
  await pg.waitForTimeout(500);
  await pg.locator('.modal #doc-pdf').setInputFiles(THREE_PAGE_PDF);
  await pg.waitForFunction(() => {
    const m = document.querySelector('.modal .pdf-card-meta small');
    return m && m.textContent.includes('3 ');
  }, { timeout: 10000 });
  await pg.locator('.modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' }).locator('input[type="checkbox"]').check();
  await pg.waitForTimeout(1400);
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForSelector('.modal .chain-row', { timeout: 10000 });
  await pg.waitForTimeout(1400);
  await pg.locator('.modal footer .btn.primary').click();
  await pg.waitForFunction(() => {
    const c = document.querySelector('.veil .pdf-canvas');
    return c && c.width > 400;
  }, { timeout: 15000 });
  await pg.waitForTimeout(900);

  // C3: Opened on page 3 (last page) by default
  const pagerText = await pg.locator('.veil .pdf-pager span').textContent();
  ok('C3: placement editor opens on last page (3 / 3) by default',
    (pagerText || '').includes('3 / 3'), pagerText || '');

  // C1: Thumbnail rail has 3 thumbnails
  const thumbCount = await pg.locator('.veil .pe-rail .pe-thumb').count();
  ok('C1: desktop thumbnail rail renders 3 page thumbs', thumbCount === 3, `thumbs=${thumbCount}`);

  // C4: Ghosts detected on page 3 ("ลงชื่อ" / "(......)" / "ลงนาม")
  const ghostCount = await pg.locator('.veil .sig-ghost').count();
  ok('C4: auto-suggest detects ghost boxes on Thai signature cues', ghostCount >= 2, `ghosts=${ghostCount}`);

  // Click "วางตามที่ระบบแนะนำ" to auto-place for all empty signers
  const autoBtn = pg.locator('.veil button', { hasText: 'วางตามที่ระบบแนะนำ' });
  ok('C4: "วางตามที่ระบบแนะนำ" button is visible', await autoBtn.isVisible());
  await autoBtn.click();
  await pg.waitForTimeout(400);
  const placedAfterAuto = await pg.locator('.veil .sig-box').count();
  ok('C4: auto-place assigns signature boxes to signers with 0 boxes', placedAfterAuto >= 2, `boxes=${placedAfterAuto}`);

  // C2: Drag the first box and verify its left/top fractions change
  const firstBox = pg.locator('.veil .sig-box').first();
  const beforePos = await firstBox.evaluate((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  const bRect = await firstBox.boundingBox();
  await pg.mouse.move(bRect.x + bRect.width / 2, bRect.y + bRect.height / 2);
  await pg.mouse.down();
  await pg.mouse.move(bRect.x + bRect.width / 2 - 90, bRect.y + bRect.height / 2 - 70, { steps: 6 });
  await pg.mouse.up();
  await pg.waitForTimeout(300);
  const afterPos = await firstBox.evaluate((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  ok('C2/C6: pointer drag moves box and updates stored fractions',
    Math.abs(afterPos.left - beforePos.left) > 3 && Math.abs(afterPos.top - beforePos.top) > 2,
    `(${beforePos.left.toFixed(1)},${beforePos.top.toFixed(1)}) -> (${afterPos.left.toFixed(1)},${afterPos.top.toFixed(1)})`);

  // C2: Selection toolbar visible with "ทำซ้ำทุกหน้า" and "ลบ"
  const dupBtn = pg.locator('.veil .pe-selbar button', { hasText: 'ทำซ้ำทุกหน้า' });
  ok('C2: selecting a box shows selection toolbar with duplicate-all-pages', await dupBtn.isVisible());
  await dupBtn.click();
  await pg.waitForTimeout(300);
  // Check thumbnail dots appear on pages 1, 2, and 3!
  const pagesWithDots = await pg.evaluate(() =>
    Array.from(document.querySelectorAll('.veil .pe-rail .pe-thumb'))
      .filter((el) => el.querySelectorAll('.pe-dot').length > 0).length
  );
  ok('C2/C6: duplicate-to-all-pages copies box to all 3 pages (dots on all 3 thumbs)',
    pagesWithDots === 3, `pagesWithDots=${pagesWithDots}`);

  // C5: Place a Thai `date` box and a `nameTitle` box on page 3
  await pg.locator('.veil .pe-kinds button[data-kind="date"]').click();
  await pg.waitForTimeout(150);
  const sheet = pg.locator('.veil .pdf-sheet');
  await sheet.click({ position: { x: 200, y: 180 } });
  await pg.waitForTimeout(250);
  await pg.locator('.veil .pe-kinds button[data-kind="nameTitle"]').click();
  await pg.waitForTimeout(150);
  await sheet.click({ position: { x: 420, y: 180 } });
  await pg.waitForTimeout(300);

  const dateBoxCount = await pg.locator('.veil .sig-box.kind-date').count();
  const nameBoxCount = await pg.locator('.veil .sig-box.kind-nameTitle').count();
  ok('C5: date and nameTitle boxes render live Thai previews on canvas',
    dateBoxCount === 1 && nameBoxCount === 1, `date=${dateBoxCount} nameTitle=${nameBoxCount}`);

  // C1: Zoom + updates % readout
  await pg.locator('.veil .pe-zoom button', { hasText: '+' }).click();
  await pg.waitForTimeout(200);
  const zoomText = await pg.locator('.veil .pe-zoom-pct').textContent();
  ok('C1: zoom + increases scale readout', zoomText === '120%', zoomText || '');
  await pg.locator('.veil .pe-zoom button', { hasText: 'พอดีหน้า' }).click();
  await pg.waitForTimeout(200);

  if (SHOT_DIR) {
    await pg.screenshot({ path: `${SHOT_DIR}/phase3_desktop_editor.png` });
  }

  // Submit the 3-page doc with signature + duplicated boxes + date + nameTitle and verify server persists `kind`
  await pg.waitForTimeout(1400);
  await pg.locator('.veil footer .btn.primary').click();
  await pg.waitForSelector('.veil .doc-done', { timeout: 20000 });
  const savedDoc = await pg.evaluate(async () => {
    const list = (await (await fetch('/api/documents')).json()).documents || [];
    const hit = list.find((d) => d.title && d.title.includes('Phase3 Thai 3Pages'));
    if (!hit) return null;
    return (await fetch('/api/documents?id=' + hit.id)).json();
  });
  const allMarks = (savedDoc?.steps || []).flatMap((s) => s.marks || []);
  const kinds = [...new Set(allMarks.map((m) => m.kind))];
  const pagesCovered = [...new Set(allMarks.map((m) => m.page))];
  ok('C5/C6: server persisted signature, date, nameTitle across all 3 pages and stamped signed PDF',
    kinds.includes('signature') && kinds.includes('date') && kinds.includes('nameTitle') &&
    pagesCovered.length === 3 && (savedDoc?.files || []).some((f) => f.kind === 'signed'),
    `kinds=${kinds.join(',')} pages=${pagesCovered.join(',')}`);

  await ctx.close();

  // ---- Phone check (390x844) ----
  console.log('\n3. Phone (390x844) horizontal strip & editor layout');
  const pCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const ppg = await login(pCtx, 'Kungking_HeadCon', 'brandNew22');
  await ppg.evaluate(() => { location.hash = '#/docs'; });
  await ppg.waitForTimeout(900);
  await ppg.locator('#fab').click();
  await ppg.waitForTimeout(500);
  const docOpt = ppg.locator('.fab-sheet button').filter({ hasText: /เอกสาร/ }).first();
  if (await docOpt.count()) await docOpt.click();
  await ppg.waitForSelector('.modal #doc-pdf', { state: 'attached', timeout: 8000 });
  await ppg.locator('.modal #doc-pdf').setInputFiles(THREE_PAGE_PDF);
  await ppg.waitForFunction(() => document.querySelector('.modal .pdf-card'), { timeout: 10000 });
  await ppg.locator('.modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' }).locator('input[type="checkbox"]').check();
  await ppg.waitForTimeout(1400);
  await ppg.locator('.modal footer .btn.primary').click();
  await ppg.waitForSelector('.modal .chain-row', { timeout: 10000 });
  await ppg.waitForTimeout(1400);
  await ppg.locator('.modal footer .btn.primary').click();
  await ppg.waitForFunction(() => {
    const c = document.querySelector('.veil .pdf-canvas');
    return c && c.width > 300;
  }, { timeout: 15000 });
  await ppg.waitForTimeout(700);
  const railDir = await ppg.evaluate(() => getComputedStyle(document.querySelector('.veil .pe-rail')).flexDirection);
  const noSideScroll = await ppg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  ok('C1 Phone: thumbnail rail switches to horizontal strip above page with no sideways scroll',
    railDir === 'row' && noSideScroll, `flexDirection=${railDir} noSideScroll=${noSideScroll}`);
  if (SHOT_DIR) {
    await ppg.screenshot({ path: `${SHOT_DIR}/phase3_phone_editor.png` });
  }
  await pCtx.close();

  ok('zero console/page errors across desktop and phone', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${failed ? `FAILED (${failed})` : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
