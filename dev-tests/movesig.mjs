/**
 * Moving a signature after it has already been stamped onto the letter.
 *
 * The button is on the step that signed, the editor is the same canvas the
 * box was placed on, and saving re-stamps the letter without touching the
 * approvals. Asked for on 19 October, because the alternative was ตีกลับ.
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
  pg.on('dialog', async (d) => { await d.accept(''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}
const TITLE = 'MV: หนังสือย้ายลายเซ็น';

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

// A clean slate: an earlier run's letter must not be the one under test.
await kk.evaluate(async (title) => {
  for (const d of (await (await fetch('/api/documents')).json()).documents || []) {
    if (d.title === title) await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
  }
}, TITLE);

/** A two-page letter, uploaded and signed straight through the API. */
const made = await kk.evaluate(async (title) => {
  const { PDFDocument } = window.pdfLibForTests || {};
  // A minimal two-page PDF written by hand — no library needed for a sheet
  // with nothing on it, and the suite stays independent of pdf-lib loading.
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
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  let bin = ''; bytes.forEach((v) => { bin += String.fromCharCode(v); });

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
        mark: s.signs ? { page: 1, x: 0.6, y: 0.82, w: 0.25, h: 0.07 } : null,
      })),
    }),
  });
  return res.json();
}, TITLE);
ok('a two-page letter is uploaded', Boolean(made && made.id), JSON.stringify(made).slice(0, 60));

const signed = await boss.evaluate(async (id) => {
  const r = await fetch('/api/documents?do=approve', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return r.status;
}, made.id);
ok('...and the director signs it', signed === 200, String(signed));

console.log('\n1. The button sits on the step that signed');
await boss.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
await boss.waitForTimeout(2400);
const moveBtns = boss.locator('#modal-root .doc-steps .ds-move');
ok('the signed step offers to move its signature', (await moveBtns.count()) >= 1,
  `${await moveBtns.count()} button(s)`);
ok('...and a step nobody has signed yet does not',
  (await boss.locator('#modal-root .doc-steps li.waiting .ds-move').count()) === 0);
await boss.screenshot({ path: '/tmp/claude-0/mv-steps.png' });

console.log('\n2. The editor is the page itself, with the real signature on it');
// The director's own step, which is the last signing one in the chain.
await moveBtns.last().click();
await boss.waitForFunction(() => {
  const all = document.querySelectorAll('.veil');
  const v = all[all.length - 1];
  const c = v && v.querySelector('.pdf-canvas');
  return c && c.width > 400 && c.height > c.width;
}, null, { timeout: 30000 });
await boss.waitForTimeout(700);
const top = boss.locator('#modal-root .veil').last();
ok('the box on the page is the real signature',
  (await top.locator('.sig-box.real img.sig-real').count()) >= 1);
ok('...with a size slider to put it right', (await top.locator('.sig-size').count()) === 1);
ok('...and a pager, because the letter has two pages',
  (await top.locator('.pdf-pager button').count()) === 2);
await boss.screenshot({ path: '/tmp/claude-0/mv-editor.png' });

const sheet = top.locator('.pdf-sheet');
const sbox = await sheet.boundingBox();
// Tapping the box that is there takes it away; tapping clear paper adds one.
await sheet.click({ position: { x: sbox.width * 0.72, y: sbox.height * 0.855 } });
await boss.waitForTimeout(300);
await sheet.click({ position: { x: sbox.width * 0.25, y: sbox.height * 0.3 } });
await boss.waitForTimeout(400);
const spots = await top.locator('.sig-box').count();
ok('a tap moves it to the new spot', spots === 1, `${spots} box(es)`);
const where = await top.locator('.sig-box').first().evaluate((n) => ({
  left: parseFloat(n.style.left), top: parseFloat(n.style.top),
}));
ok('...up where the finger went', where.top < 45 && where.left < 45, JSON.stringify(where));

await top.locator('footer .btn.primary').click();
await boss.waitForTimeout(2600);
const after = await boss.evaluate(async (id) =>
  (await (await fetch('/api/documents?id=' + id)).json()), made.id);
const movedStep = after.steps.find((s) => (s.marks || []).length && s.state === 'approved' && s.username === 'Jade_Pres');
ok('saving really moves it on the letter',
  Boolean(movedStep) && movedStep.marks[0].y < 0.45, JSON.stringify(movedStep && movedStep.marks));
ok('...without disturbing the approval', movedStep.state === 'approved');
ok('...and the signed copy is stamped again',
  (after.files.find((f) => f.kind === 'signed') || {}).size > 0,
  JSON.stringify(after.files.map((f) => [f.kind, f.size])));
ok('...with the move in the letter’s history',
  after.events.some((e) => e.kind === 'mark_moved'), after.events.map((e) => e.kind).join(','));
await boss.screenshot({ path: '/tmp/claude-0/mv-after.png' });

console.log('\n3. Somebody with no part in it is not offered the button');
const stranger = await as('Ploy_StaffCon', 'memberPw11');
await stranger.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
await stranger.waitForTimeout(2200);
ok('a member who is not in the chain cannot even see the letter, let alone move it',
  (await stranger.locator('#modal-root .ds-move').count()) === 0);

await kk.evaluate((id) => fetch('/api/documents?id=' + id, { method: 'DELETE' }), made.id);
if (errs.length) { console.log('\nPAGE ERRORS:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }
console.log(failed === 0 && errs.length === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 && errs.length === 0 ? 0 : 1);
