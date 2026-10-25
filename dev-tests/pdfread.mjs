/**
 * Reading a letter without leaving the app, on a computer and on a phone.
 *
 * Asked for on 22 October: the file chips used to hand the PDF to the phone's
 * own viewer, which on an installed home-screen app leaves no way back, and
 * offered no obvious way to save it. This checks the reader opens in place,
 * draws the page, closes, and that the download button asks for the file as
 * an attachment.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const DESK = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
async function as(user, pass, opts) {
  const ctx = await b.newContext(opts || DESK);
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(`${user}: ${m.text()}`); });
  pg.on('dialog', async (d) => { await d.accept(''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1600);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  const later = pg.locator('.veil button', { hasText: 'ไว้ทีหลัง' });
  if (await later.count()) { await later.first().click(); await pg.waitForTimeout(500); }
  await pg.evaluate(() => document.querySelectorAll('.veil').forEach((v) => v.remove()));
  return pg;
}
const TITLE = 'PR: หนังสือทดสอบเปิดอ่าน';

const kk = await as('Kungking_HeadCon', 'brandNew22');
await kk.evaluate(async (title) => {
  for (const d of (await (await fetch('/api/documents')).json()).documents || []) {
    if (d.title === title) await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
  }
}, TITLE);

const made = await kk.evaluate(async (title) => {
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj',
    '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj',
  ];
  let pdf = '%PDF-1.4\n'; const at = [];
  for (const o of objs) { at.push(pdf.length); pdf += o + '\n'; }
  const start = pdf.length;
  pdf += 'xref\n0 5\n0000000000 65535 f \n' +
    at.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer<</Size 5/Root 1 0 R>>\nstartxref\n${start}\n%%EOF`;
  let bin = '';
  for (let i = 0; i < pdf.length; i += 1) bin += String.fromCharCode(pdf.charCodeAt(i) & 0xff);
  const proposed = await (await fetch('/api/documents?do=propose', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ department: 'content' }),
  })).json();
  const res = await fetch('/api/documents?do=create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title, recipient: 'คณะวิศวกรรมศาสตร์', internalUnit: true, department: 'content',
      pdf: btoa(bin),
      steps: proposed.steps.map((s) => ({
        role: s.role, username: s.username, signs: s.signs,
        mark: s.signs ? { page: 1, x: 0.6, y: 0.8, w: 0.25, h: 0.07 } : null,
      })),
    }),
  });
  return res.json();
}, TITLE);
ok('a letter with a PDF to read', Boolean(made && made.id), JSON.stringify(made).slice(0, 60));

console.log('\n1. On a computer');
await kk.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
await kk.waitForTimeout(2400);
const chip = kk.locator('#modal-root .chip.as-btn').first();
ok('the PDF is a button that opens the reader, not a link out of the app',
  (await chip.count()) === 1 && (await kk.locator('#modal-root a.chip[target="_blank"][href*="file=original"]').count()) === 0);

await chip.click();
await kk.waitForFunction(() => {
  const c = document.querySelector('.pdf-modal .pdf-canvas');
  return c && c.width > 400;
}, null, { timeout: 30000 });
await kk.waitForTimeout(500);
const reader = kk.locator('#modal-root .veil').last();
ok('...the page is drawn inside the app', (await reader.locator('.pdf-canvas').count()) === 1);
ok('...with a pager, because the letter has two pages',
  (await reader.locator('.pdf-pager button').count()) === 2);
const buttons = await reader.locator('footer .btn').allInnerTexts();
ok('...a download and a close in the footer, and nothing else to crowd them',
  buttons.length === 2 && buttons.some((x) => /ดาวน์โหลด/.test(x)) && buttons.some((x) => /^ปิด$/.test(x.trim())),
  buttons.join(' | '));
ok('...with the browser\u2019s own viewer offered as a link, out of the way',
  (await reader.locator('.pdf-tab-link').count()) === 1);

/** The download asks the server for an attachment, under a real name. */
const asked = await kk.evaluate(async (id) => {
  const r = await fetch('/api/documents?id=' + id + '&file=original&download=1', { credentials: 'same-origin' });
  return { status: r.status, cd: r.headers.get('content-disposition') };
}, made.id);
ok('...and that download really is an attachment',
  asked.status === 200 && /^attachment;/.test(asked.cd || ''), String(asked.cd).slice(0, 60));

await reader.locator('footer .btn', { hasText: /^ปิด$/ }).first().click();
await kk.waitForTimeout(600);
ok('the close button leaves the reader and keeps the letter open',
  (await kk.locator('.pdf-modal').count()) === 0 &&
  (await kk.locator('#modal-root .modal').count()) >= 1);

console.log('\n2. On a phone');
const ph = await as('Kungking_HeadCon', 'brandNew22', PHONE);
await ph.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
await ph.waitForTimeout(2600);
await ph.locator('#modal-root .chip.as-btn').first().click();
await ph.waitForFunction(() => {
  const c = document.querySelector('.pdf-modal .pdf-canvas');
  return c && c.width > 300;
}, null, { timeout: 30000 });
await ph.waitForTimeout(600);
const box = await ph.locator('.pdf-modal .pdf-canvas').boundingBox();
ok('the page fits the width of the phone', box && box.width <= 390 && box.width > 200,
  box ? Math.round(box.width) + 'px' : 'none');
/**
 * On a phone the way out is the ✕ in the header — the app hides a footer
 * "ปิด" that only repeats it (ph-dup), and the sheet drags down to dismiss
 * as well. What matters is that an exit is on screen without scrolling.
 */
await ph.screenshot({ path: '/tmp/claude-0/pr-phone.png' });
const cross = await ph.locator('.pdf-modal > header button').last().boundingBox();
ok('...and the way out is on screen, big enough for a thumb',
  cross && cross.y >= 0 && cross.y + cross.height <= 844 && cross.height >= 32,
  cross ? `y=${Math.round(cross.y)} h=${Math.round(cross.height)}` : 'none');
ok('...with no second close crowding the footer',
  (await ph.locator('.pdf-modal footer .btn.ph-dup').count()) === 1 &&
  (await ph.locator('.pdf-modal footer .btn:visible').count()) === 1);
const dl = await ph.locator('.pdf-modal footer .btn.primary').boundingBox();
ok('...and ดาวน์โหลด sits above the home indicator, not under it',
  dl && dl.y + dl.height <= 844, dl ? `y=${Math.round(dl.y)} h=${Math.round(dl.height)}` : 'none');

/** Tapping it really does leave the reader. */
await ph.locator('.pdf-modal > header button').last().click();
await ph.waitForTimeout(600);
ok('...and tapping it leaves the reader, with the letter still open',
  (await ph.locator('.pdf-modal').count()) === 0 &&
  (await ph.locator('#modal-root .modal').count()) >= 1);
const sideways = await ph.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok('...with no sideways scroll', !sideways);

await kk.evaluate((id) => fetch('/api/documents?id=' + id, { method: 'DELETE' }), made.id);
if (errs.length) { console.log('\nPAGE ERRORS:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }
console.log(failed === 0 && errs.length === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 && errs.length === 0 ? 0 : 1);
