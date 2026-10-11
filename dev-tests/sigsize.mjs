/**
 * The real signature in the placement box, the signer's own check, booking a
 * slot that is already taken, several days at once, and office hours copied
 * from stated availability.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d='') => { console.log(`  ${c?'PASS':'FAIL'}  ${l}${d?' — '+d:''}`); if(!c) failed++; };
const DESK = { viewport: { width: 1440, height: 980 } };
async function as(user, pass, opts) {
  const ctx = await b.newContext(opts || DESK);
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(`${user}: ${e.message}`));
  pg.on('console', m => { if (m.type()==='error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(`${user}: ${m.text()}`); });
  pg.on('dialog', async d => { await d.accept(d.type()==='prompt' ? 'ลายเซ็นเล็กไป' : ''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}
const iso = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() + n*864e5));
const TITLE = 'SG: หนังสือตรวจลายเซ็น';

// Everyone in the chain needs a saved signature for there to be one to show.
const kk = await as('Kungking_HeadCon', 'brandNew22');
async function giveSignature(pg) {
  return pg.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 420; c.height = 120;
    const x = c.getContext('2d');
    x.strokeStyle = '#102040'; x.lineWidth = 5; x.lineCap = 'round';
    x.beginPath(); x.moveTo(20, 90);
    for (let i = 0; i < 400; i += 8) x.lineTo(20 + i, 90 - Math.sin(i / 22) * 42 - i / 14);
    x.stroke();
    const png = c.toDataURL('image/png').split(',')[1];
    const r = await fetch('/api/documents?do=signature', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ png, width: 420, height: 120 }),
    });
    return r.status;
  });
}
ok('a signature is saved for the writer', (await giveSignature(kk)) === 200);
const boss = await as('Jade_Pres', 'fairAdmin1');
ok('...and for the director', (await giveSignature(boss)) === 200);

await kk.evaluate(async (title) => {
  for (const d of (await (await fetch('/api/documents')).json()).documents || []) {
    if (d.title === title) await fetch('/api/documents?id=' + d.id, { method: 'DELETE' });
  }
}, TITLE);

console.log('\n1. Placing the boxes: the real signature, not a pink rectangle');
await kk.evaluate(() => { location.hash = '#/docs'; }); await kk.waitForTimeout(1400);
await kk.locator('#main .page-head button.primary').first().click(); await kk.waitForTimeout(900);
await kk.locator('.modal input[type=text]').nth(1).fill(TITLE);
await kk.locator('.modal input[type=text]').nth(2).fill('คณะวิศวกรรมศาสตร์');
await kk.locator('.modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' }).locator('input[type="checkbox"]').check();
await kk.locator('.modal #doc-pdf').setInputFiles('/tmp/claude-0/chain-letter.pdf');
await kk.waitForTimeout(900);
await kk.locator('.modal footer .btn.primary').click(); await kk.waitForTimeout(2500);
await kk.locator('.modal footer .btn.primary').click();
await kk.waitForFunction(() => {
  const c = document.querySelector('.veil .pdf-canvas');
  return c && c.width > 400 && c.height > c.width;
}, null, { timeout: 30000 });
await kk.waitForTimeout(500);

ok('there is a size slider for the signature', (await kk.locator('.veil .sig-size').count()) === 1);
const sheet = kk.locator('.veil .pdf-sheet');
const sbox = await sheet.boundingBox();
await sheet.click({ position: { x: sbox.width * 0.35, y: sbox.height * 0.7 } });
await kk.waitForTimeout(500);
ok('a placed box shows the real signature, not an empty rectangle',
  (await kk.locator('.veil .sig-box.real img.sig-real').count()) === 1);
const imgOk = await kk.locator('.veil .sig-box img.sig-real').evaluate((n) => n.complete && n.naturalWidth > 0);
ok('...and the image actually loads', imgOk);
const shape = await kk.locator('.veil .sig-box').first().evaluate((n) => {
  const r = n.getBoundingClientRect();
  const i = n.querySelector('img');
  return { box: r.width / r.height, img: i.naturalWidth / i.naturalHeight };
});
ok('...at the signature’s own proportions, so the box IS the signature',
  Math.abs(shape.box - shape.img) < 0.12, `box ${shape.box.toFixed(2)} vs image ${shape.img.toFixed(2)}`);
await kk.screenshot({ path: '/tmp/claude-0/sg-place.png' });

const before = await kk.locator('.veil .sig-box').first().evaluate((n) => n.getBoundingClientRect().width);
await kk.locator('.veil .sig-size').fill('14');
await kk.waitForTimeout(400);
const after = await kk.locator('.veil .sig-box').first().evaluate((n) => n.getBoundingClientRect().width);
ok('the slider really resizes it', after < before * 0.75, `${Math.round(before)}px → ${Math.round(after)}px`);
const stillRight = await kk.locator('.veil .sig-box').first().evaluate((n) => {
  const r = n.getBoundingClientRect();
  const i = n.querySelector('img');
  return Math.abs(r.width / r.height - i.naturalWidth / i.naturalHeight);
});
ok('...without squashing it', stillRight < 0.12, String(stillRight.toFixed(3)));
await kk.locator('.veil .sig-size').fill('26'); await kk.waitForTimeout(300);

// The rest of the signers, then submit.
const signers = kk.locator('.veil .seg.wrap button');
for (let i = 1; i < await signers.count(); i += 1) {
  await signers.nth(i).click();
  await kk.waitForFunction(() => { const c = document.querySelector('.veil .pdf-canvas'); return c && c.width > 400; }, null, { timeout: 30000 });
  await kk.waitForTimeout(300);
  const bb = await sheet.boundingBox();
  await sheet.click({ position: { x: bb.width * (0.3 + i * 0.12), y: bb.height * 0.78 } });
  await kk.waitForTimeout(350);
}
await kk.locator('.veil footer button.primary').click();
await kk.waitForSelector('.veil .doc-done', { timeout: 25000 });
await kk.locator('.veil footer .btn').last().click().catch(() => {});
await kk.waitForTimeout(900);
const made = await kk.evaluate(async (title) =>
  ((await (await fetch('/api/documents')).json()).documents || []).find((d) => d.title === title), TITLE);
ok('the letter is submitted', Boolean(made && made.id));

console.log('\n2. The signer checks their own before approving');
if (made) {
  await boss.evaluate((id) => { location.hash = '#/d/' + id; }, made.id);
  await boss.waitForTimeout(2200);
  ok('the signer is offered a look at their own signature',
    (await boss.locator('#modal-root .sig-check-head').count()) === 1);
  await boss.locator('#modal-root .sig-check-head').click();
  await boss.waitForFunction(() => {
    const c = document.querySelector('#modal-root .sig-check-body .pdf-canvas');
    return c && c.width > 400;
  }, null, { timeout: 30000 });
  await boss.waitForTimeout(600);
  ok('...and sees it on the page, at its real size',
    (await boss.locator('#modal-root .sig-check-body .sig-box.mine img.sig-real').count()) >= 1);
  const loads = await boss.locator('#modal-root .sig-check-body img.sig-real').first()
    .evaluate((n) => n.complete && n.naturalWidth > 0);
  ok('...with the image loaded', loads);
  await boss.screenshot({ path: '/tmp/claude-0/sg-check.png' });
  await kk.evaluate((id) => fetch('/api/documents?id=' + id, { method: 'DELETE' }), made.id);
}

console.log('\n3. Office hours: several days at once, and from my free time');
// From nothing, so an earlier run's hours cannot change what the form shows.
await kk.evaluate(async () => {
  await fetch('/api/calendar?do=office', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windows: [] }) });
  await fetch('/api/users?do=free', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windows: [] }) });
});
await kk.evaluate(() => { location.hash = '#/schedule'; }); await kk.waitForTimeout(2200);
await kk.locator('.sched-actions .btn', { hasText: 'Office hours' }).click(); await kk.waitForTimeout(800);
ok('the day picker is chips, not one dropdown', (await kk.locator('.modal .oh-row .day-chip').count()) === 7);
const row = kk.locator('.modal .oh-row').first();
for (const d of ['อ', 'พฤ']) await row.locator('.day-chip', { hasText: new RegExp('^' + d + '$') }).click();
await row.locator('input[type=time]').first().fill('15:00');
await row.locator('input[type=time]').nth(1).fill('17:00');
await kk.screenshot({ path: '/tmp/claude-0/sg-office.png' });
await kk.locator('.modal footer .btn.primary').click(); await kk.waitForTimeout(1800);
const saved = await kk.evaluate(async () => (await (await fetch('/api/calendar?do=office')).json()).windows);
ok('one row saved a window on every day ticked',
  saved.length >= 2 && saved.every((w) => w.from === '15:00' && w.to === '17:00'),
  saved.map((w) => w.day + ' ' + w.from + '-' + w.to).join(', '));

// Stated weekly free time, then copied across.
await kk.evaluate(async () => {
  await fetch('/api/users?do=free', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ windows: [
      { day: 'wed', from: '13:00', to: '16:00' }, { day: 'sat', from: '10:00', to: '12:00' }] }) });
});
await kk.locator('.sched-actions .btn', { hasText: 'Office hours' }).click(); await kk.waitForTimeout(800);
ok('there is a way to use the free time already on my profile',
  (await kk.locator('.modal .btn', { hasText: 'ใช้เวลาว่างประจำสัปดาห์' }).count()) === 1);
await kk.locator('.modal .btn', { hasText: 'ใช้เวลาว่างประจำสัปดาห์' }).click();
await kk.waitForTimeout(1200);
const rowTimes = await kk.locator('.modal .oh-row input[type=time]').evaluateAll((els) => els.map((e) => e.value).join(','));
ok('...which fills the form from it', rowTimes === '13:00,16:00,10:00,12:00', rowTimes);
await kk.locator('.modal footer .btn.primary').click(); await kk.waitForTimeout(1800);
const copied = await kk.evaluate(async () => (await (await fetch('/api/calendar?do=office')).json()).windows);
ok('...and saves as office hours', copied.map((w) => w.day + ' ' + w.from).sort().join(', ') === 'sat 10:00, wed 13:00',
  copied.map((w) => w.day + ' ' + w.from).join(', '));

console.log('\n4. Booking a slot the host is not free for');
/**
 * Set up against a date rather than a weekday, so this reads the same
 * whatever day of the week it is run on and whatever the container thinks
 * the time is.
 */
const clashDay = iso(3);
const clashWeekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(clashDay + 'T12:00:00Z').getUTCDay()];
await kk.evaluate(async ({ day, on }) => {
  await fetch('/api/calendar?do=office', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ windows: [{ day, from: '13:00', to: '16:00', slot: 30, place: 'ห้องชมรม' }] }) });
  await fetch('/api/calendar?do=appt', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'focus', title: 'งานเงียบ', on, at: '13:00', to: '14:00' }) });
}, { day: clashWeekday, on: clashDay });

const ploy = await as('Ploy_StaffCon', 'memberPw11');
const offered = await ploy.evaluate(async (on) =>
  (await (await fetch('/api/calendar?do=slots&host=Kungking_HeadCon&from=' + on + '&to=' + on)).json()).slots, clashDay);
ok('every slot in the window comes back, busy ones included',
  offered.length === 6 && offered.filter((x) => x.taken).map((x) => x.at).join() === '13:00,13:30',
  offered.map((x) => x.at + (x.taken ? '!' : '')).join());

await ploy.evaluate(() => { location.hash = '#/schedule'; }); await ploy.waitForTimeout(2000);
await ploy.locator('.sched-actions .btn', { hasText: /จองเวลา/ }).click(); await ploy.waitForTimeout(900);
await ploy.locator('.host', { hasText: 'Kungking' }).click();
await ploy.waitForSelector('.book .slot', { timeout: 15000 }).catch(() => {});
await ploy.waitForTimeout(500);
ok('slots the host is busy for are shown, not hidden',
  (await ploy.locator('.slot.taken').count()) >= 1,
  'taken ' + (await ploy.locator('.slot.taken').count()) + ' of ' + (await ploy.locator('.slot').count()));
ok('...and said plainly before anything is pressed',
  (await ploy.locator('.book .hint').first().innerText()).includes('ไม่ว่าง'));
await ploy.screenshot({ path: '/tmp/claude-0/sg-slots.png' });
await ploy.locator('.slot.taken').first().click(); await ploy.waitForTimeout(700);
ok('...with the warning carried into the confirm step',
  (await ploy.locator('.book-confirm .notice.warn').count()) === 1,
  await ploy.locator('.book-confirm .notice.warn').innerText().catch(() => '(none)'));
await ploy.locator('.book-confirm .btn.primary').click(); await ploy.waitForTimeout(2200);
ok('...and the booking still goes through', (await ploy.locator('.book-done').count()) === 1);
await ploy.screenshot({ path: '/tmp/claude-0/sg-booked.png' });
const hostTold = await kk.evaluate(async () =>
  ((await (await fetch('/api/notifications')).json()).notifications || [])
    .filter((n) => n.kind === 'booking').map((n) => n.body)[0] || '');
ok('...and the host is told it lands on something they already had',
  /มีนัดอื่น/.test(hostTold), hostTold.slice(0, 90));

await kk.evaluate(async () => {
  await fetch('/api/calendar?do=office', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windows: [] }) });
  await fetch('/api/users?do=free', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windows: [] }) });
  const from = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  for (const a of (await (await fetch('/api/calendar?do=schedule&from=' + from + '&to=' + to)).json()).appointments || []) {
    await fetch('/api/calendar?do=appt&id=' + a.id, { method: 'DELETE' });
  }
});

ok('no errors in the browser console', errs.length === 0, errs.slice(0, 4).join(' | '));
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close(); process.exit(failed ? 1 : 0);
