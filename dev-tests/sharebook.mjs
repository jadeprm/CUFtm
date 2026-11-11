/**
 * Two ways something leaves this app: a link to one task, and a page where
 * somebody with no account books a time.
 *
 * What has to hold: the share dialog hands back an address, a member from
 * another ฝ่าย can open it and gets a read-only dialog, pasting the address
 * into the search box opens it too (the way in on an iPhone), and a visitor
 * who is signed in to nothing can pick a slot, prove an email address and
 * end up on the host's schedule.
 */
import { chromium } from 'playwright';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fairv2';
if (/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) await import('./neon-local.mjs');
const { getSql } = await import('../lib/db.js');
const { sql, ready } = getSql();
await ready;

const PORT = process.argv[2] || '4700';
const ORIGIN = `http://localhost:${PORT}`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let failed = 0;
const errs = [];
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};
const mail = () => fetch(ORIGIN + '/__mail').then((r) => r.json());
/** A title nothing left behind by an earlier run can match. */
const TITLE = 'งานทดสอบลิงก์แชร์ ' + Date.now().toString(36);

async function signIn(user, pass) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  await pg.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  for (let i = 0; i < 6; i++) { await pg.keyboard.press('Escape'); await pg.waitForTimeout(250); }
  await pg.evaluate(() => { const r = document.getElementById('modal-root'); if (r) r.innerHTML = ''; });
  return pg;
}

// Everything here is done with mail switched OFF, so the email rule stays out
// of the way; the booking half turns it on for itself.
await fetch(ORIGIN + '/__mailoff');

console.log('\nA link to one task');
const owner = await signIn('Kluayhom_HeadMerchant', 'merchPw123');
await owner.goto(ORIGIN + '/#/work', { waitUntil: 'networkidle' });
await owner.waitForTimeout(1200);

// A task of this person's own, made through the API the page itself uses.
const made = await owner.evaluate(async (name) => {
  const res = await fetch('/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: name, department: 'merchant',
      assignees: ['Kluayhom_HeadMerchant'], notify: [] }),
  });
  return (await res.json()).task;
}, TITLE);
ok('a task to share exists', Boolean(made && made.id), made && made.id);

await owner.reload({ waitUntil: 'networkidle' });
await owner.waitForTimeout(1800);
for (let i = 0; i < 4; i++) { await owner.keyboard.press('Escape'); await owner.waitForTimeout(200); }
await owner.evaluate(() => { const r = document.getElementById('modal-root'); if (r) r.innerHTML = ''; });
// Found the way anybody would find it, so the test fails if the page does.
await owner.locator('input.search').first().fill(TITLE);
await owner.waitForTimeout(1200);
const row = owner.locator('.task', { hasText: TITLE }).first();
ok('it is findable on the page', await row.count() > 0);
await row.click();
await owner.waitForTimeout(1200);
ok('its dialog opens', (await owner.locator('.modal header').first().innerText()).includes(TITLE));

const shareBtn = owner.locator('.modal footer button', { hasText: 'แชร์' }).first();
ok('the dialog offers a share button', await shareBtn.count() > 0);
await shareBtn.click();
await owner.waitForTimeout(800);
ok('...which explains who can open the link before making one',
  (await owner.locator('.share-box .hint').first().innerText()).includes('ล็อกอิน'));
// Nothing is shared until somebody says so.
const startBtn = owner.locator('.share-box button', { hasText: 'สร้างลิงก์' }).first();
ok('...and offers to make one rather than having made it already', await startBtn.count() > 0);
await startBtn.click();
await owner.waitForTimeout(1500);
const shareLink = await owner.locator('.share-url').first().inputValue();
ok('an address comes back', /#\/s\/[A-Za-z0-9_-]{16,}$/.test(shareLink), shareLink);
ok('...and it says what an iPhone will do with it',
  (await owner.locator('.share-box').innerText()).includes('Safari'));

console.log('\nSomebody in another ฝ่าย follows it');
/**
 * A member of another ฝ่าย — not a ประธานฝ่าย, who sees the whole fair
 * anyway and for whom a link would prove nothing.
 */
const other = await signIn('Ploy_StaffCon', 'memberPw11');
const sawFirst = await other.evaluate(async (id) => {
  const d = await (await fetch('/api/tasks')).json();
  return d.tasks.some((t) => t.id === id);
}, made.id);
ok('they cannot normally see it at all', sawFirst === false);

/**
 * The address as this browser would reach it. The server builds the link
 * from the host it was asked on, which behind a proxy is not the host the
 * test is using — what is being checked here is the token, not the hostname.
 */
const followUrl = ORIGIN + shareLink.slice(shareLink.indexOf('/#/'));
await other.goto(followUrl, { waitUntil: 'networkidle' });
await other.waitForTimeout(2600);
const dlg = other.locator('.modal').first();
ok('the link opens the task for them', await dlg.count() > 0 && (await dlg.innerText()).includes(TITLE));
ok('...read-only, with no edit button', !(await dlg.innerText()).includes('แก้งาน'));

console.log('\nThe way in on an iPhone: paste it into the search box');
await other.goto(ORIGIN + '/#/work', { waitUntil: 'networkidle' });
await other.waitForTimeout(1500);
for (let i = 0; i < 4; i++) { await other.keyboard.press('Escape'); await other.waitForTimeout(200); }
await other.evaluate(() => { const r = document.getElementById('modal-root'); if (r) r.innerHTML = ''; });
const box = other.locator('input.search').first();
await box.fill(followUrl);
await other.waitForTimeout(2600);
ok('pasting the address opens the task rather than searching for it',
  await other.locator('.modal').count() > 0 &&
  (await other.locator('.modal').first().innerText()).includes(TITLE));
ok('...and the box is left empty, not full of a URL', (await box.inputValue()) === '');

console.log('\nOffice hours a stranger can book');
// Whatever an interrupted run left behind, so the counts below mean something.
await sql`DELETE FROM appointments WHERE guest_email = 'guest@outside.test'`;
await fetch(ORIGIN + '/__mailon');
const host = await signIn('Ikkew_HeadOper1', 'editorPw2');
const token = await host.evaluate(async () => {
  const mon = (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + 7); return d.toISOString().slice(0, 10); })();
  await fetch('/api/calendar?do=office', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ windows: [{ day: 'mon', from: '13:00', to: '15:00', slot: 30, place: 'ห้อง 2' }] }),
  });
  const res = await fetch('/api/calendar?do=office-public', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public: true }),
  });
  return (await res.json()).token;
});
ok('the host switches the public page on and gets an address', Boolean(token) && token.length >= 16, token);

// A visitor: a brand-new browser context, signed in to nothing at all.
const guestCtx = await b.newContext({ viewport: { width: 420, height: 880 }, isMobile: true, hasTouch: true });
const guest = await guestCtx.newPage();
guest.on('pageerror', (e) => errs.push('guest: ' + e.message));
await guest.goto(`${ORIGIN}/#/book/${token}`, { waitUntil: 'networkidle' });
await guest.waitForTimeout(2200);
const pageText = await guest.locator('body').innerText();
ok('a stranger sees the booking page, not a sign-in box', /จองเวลานัดหมาย/.test(pageText), pageText.slice(0, 80));
ok('...with the host’s name on it', /Ikkew|อิ๊กกิ้ว/i.test(pageText));
ok('...and no sidebar, bell or anything else of the app', await guest.locator('#app-view:not([hidden])').count() === 0);
const slots = guest.locator('.pb-slot:not(.taken)');
ok('...and the open half hours', await slots.count() >= 4, String(await slots.count()));

await slots.first().click();
await guest.waitForTimeout(700);
await guest.fill('.pub-book input[type=text]', 'คุณสมชาย ทดสอบ');
await guest.fill('.pub-book input[type=email]', 'guest@outside.test');
await fetch(ORIGIN + '/__mailon');
await guest.locator('.pub-book button[type=submit]').first().click();
await guest.waitForTimeout(2500);
ok('the code step appears', (await guest.locator('body').innerText()).includes('ยืนยันอีเมล'));
const sent = await mail();
const code = /\b(\d{6})\b/.exec(sent.at(-1)?.text || '')?.[1];
ok('...and a code was emailed to the address they typed',
  Boolean(code) && String(sent.at(-1).to) === 'guest@outside.test', JSON.stringify(sent.at(-1)?.to));

await guest.fill('.pub-book input[inputmode=numeric]', code);
await guest.locator('.pub-book button[type=submit]').first().click();
await guest.waitForTimeout(2500);
ok('the booking goes through', (await guest.locator('body').innerText()).includes('จองเรียบร้อยแล้ว'));

const [booked] = await sql`
  SELECT guest_name, guest_email, guest_token FROM appointments
  WHERE owner = 'Ikkew_HeadOper1' AND guest_email = 'guest@outside.test'`;
ok('...and it is on the host’s schedule, with who made it', Boolean(booked) && /สมชาย/.test(booked.guest_name || ''),
  JSON.stringify(booked || {}));

const after = await mail();
const cancelUrl = /#\/unbook\/([A-Za-z0-9_-]+)/.exec(after.at(-1)?.text || '')?.[1];
ok('the visitor is emailed a way to cancel', Boolean(cancelUrl));
await guest.goto(`${ORIGIN}/#/unbook/${cancelUrl}`, { waitUntil: 'networkidle' });
await guest.waitForTimeout(1800);
await guest.locator('.pub-book button', { hasText: 'ยกเลิกนัดหมาย' }).first().click();
await guest.waitForTimeout(2000);
ok('...and it works without signing in to anything',
  (await guest.locator('body').innerText()).includes('ยกเลิกเรียบร้อย'));
const left = await sql`SELECT count(*)::int AS n FROM appointments WHERE guest_email = 'guest@outside.test'`;
ok('...leaving the host’s schedule clear', left[0].n === 0);

await fetch(ORIGIN + '/__mailoff');
console.log(errs.length ? '\nconsole errors: ' + errs.join(' | ') : '\nno console errors');
if (errs.length) failed++;
console.log(failed === 0 ? '\nSHARE/BOOK OK' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
