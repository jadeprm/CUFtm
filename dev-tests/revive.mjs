/**
 * Bringing a rejected letter back with the signatures it already had.
 *
 * A ตีกลับ deletes the PDFs, and until 19 October that was the end of the
 * letter: a correction meant a new document and everybody signing the same
 * page twice. This checks the button is offered to the right people, says
 * whose signatures are coming back, and that putting the corrected file in
 * really does restore them.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const DESK = { viewport: { width: 1440, height: 980 } };
async function as(user, pass) {
  const ctx = await b.newContext(DESK);
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(`${user}: ${m.text()}`); });
  pg.on('dialog', async (d) => { await d.accept(d.type() === 'prompt' ? 'วันที่ผิด' : ''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}
const TITLE = 'RV: หนังสือกู้คืนหลังตีกลับ';

/** The corrected file the writer will upload, made here rather than borrowed. */
const FIXED = '/tmp/claude-0/rv-corrected.pdf';
{
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { PDFDocument } = await import('pdf-lib');
  const made = await PDFDocument.create();
  made.addPage([595.28, 841.89]);
  made.addPage([595.28, 841.89]);
  mkdirSync('/tmp/claude-0', { recursive: true });
  writeFileSync(FIXED, Buffer.from(await made.save()));
}

const kk = await as('Kungking_HeadCon', 'brandNew22');
const boss = await as('Jade_Pres', 'fairAdmin1');
async function giveSignature(pg) {
  return pg.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 420; c.height = 120;
    const x = c.getContext('2d');
    x.strokeStyle = '#102040'; x.lineWidth = 5; x.lineCap = 'round';
    x.beginPath(); x.moveTo(20, 90);
    for (let i = 0; i < 400; i += 8) x.lineTo(20 + i, 90 - Math.sin(i / 22) * 42 - i / 14);
    x.stroke();
    const r = await fetch('/api/documents?do=signature', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ png: c.toDataURL('image/png').split(',')[1], width: 420, height: 120 }),
    });
    return r.status;
  });
}
ok('both signers have a signature on file',
  (await giveSignature(kk)) === 200 && (await giveSignature(boss)) === 200);

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
        role: s.role, username: s.username,
        mark: s.signs ? { page: 1, x: 0.6, y: 0.8, w: 0.25, h: 0.07 } : null,
      })),
    }),
  });
  return res.json();
}, TITLE);
ok('a letter is submitted and signed by its writer', Boolean(made && made.id));

console.log('\n1. The director sends it back');
await boss.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
await boss.waitForTimeout(2400);
await boss.locator('#modal-root footer .btn.danger').first().click();
await boss.waitForTimeout(2400);
const bounced = await boss.evaluate(async (id) => (await (await fetch('/api/documents?id=' + id)).json()), made.id);
ok('the letter is sent back', bounced.document.stage === 'rejected', bounced.document.stage);
ok('...and its PDFs are gone', !bounced.files.some((f) => f.kind !== 'source'),
  JSON.stringify(bounced.files.map((f) => f.kind)));

console.log('\n2. The writer puts the corrected file in');
await kk.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
await kk.waitForTimeout(2400);
const reviveBtn = kk.locator('#modal-root footer .btn.primary').filter({ hasText: 'กู้ลายเซ็นเดิม' });
ok('the writer is offered the corrected-file button', (await reviveBtn.count()) === 1);
const keeps = await kk.locator('#modal-root footer .hint').allInnerTexts();
ok('...told whose signatures come back with it',
  keeps.some((x) => /Kungking/i.test(x)), keeps.join(' | ') || 'nothing said');
await kk.screenshot({ path: '/tmp/claude-0/rv-button.png' });

await kk.locator('#modal-root footer input[type=file][accept*="pdf"]').first().setInputFiles(FIXED);
await kk.waitForTimeout(4000);
const back = await kk.evaluate(async (id) => (await (await fetch('/api/documents?id=' + id)).json()), made.id);
ok('the letter is back in its chain', back.document.stage !== 'rejected', back.document.stage);
ok('...with the signed copy rebuilt',
  (back.files.find((f) => f.kind === 'signed') || {}).size > 0,
  JSON.stringify(back.files.map((f) => [f.kind, f.size])));
ok('...the writer’s approval untouched',
  back.steps.some((s) => s.username === 'Kungking_HeadCon' && s.state === 'approved'));
ok('...and the director asked again, with a clean slate',
  back.steps.some((s) => s.username === 'Jade_Pres' && s.state === 'waiting' && !s.comment),
  JSON.stringify(back.steps.map((s) => [s.username, s.state])));
ok('...and the button is gone now there is nothing to revive',
  (await kk.locator('#modal-root footer .btn').filter({ hasText: 'กู้ลายเซ็นเดิม' }).count()) === 0);
await kk.screenshot({ path: '/tmp/claude-0/rv-back.png' });

console.log('\n3. Not on offer to somebody with no part in it');
const stranger = await as('Ploy_StaffCon', 'memberPw11');
await stranger.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
await stranger.waitForTimeout(2200);
ok('a member outside the letter is offered nothing',
  (await stranger.locator('#modal-root footer .btn').filter({ hasText: 'กู้ลายเซ็นเดิม' }).count()) === 0);

await kk.evaluate((id) => fetch('/api/documents?id=' + id, { method: 'DELETE' }), made.id);
if (errs.length) { console.log('\nPAGE ERRORS:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }
console.log(failed === 0 && errs.length === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 && errs.length === 0 ? 0 : 1);
