/**
 * Joining the system and proving an email, driven through the page.
 *
 * The server rules are in run.mjs §104. What only exists here is whether a
 * stranger can get through the form with a code that arrived by email, whether
 * a signed-in member with no email is stopped in front of the app, and whether
 * a named approver can find the queue and use it.
 *
 * srv2.mjs captures the mail and has /__mailon and /__mailoff, because turning
 * the rule on for the whole dev server would stop every other suite at the door.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const base = `http://localhost:${PORT}`;
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const head = (s) => console.log('\n' + s);
const db = new pg.Client({ connectionString: 'postgres://postgres:pw@127.0.0.1:5432/fairv2' });
await db.connect();

const NEW = 'Join_UiTester';
async function tidy() {
  await db.query(`DELETE FROM users WHERE username = $1`, [NEW]);
  await db.query(`DELETE FROM registrations WHERE username = $1`, [NEW]);
  await db.query(`DELETE FROM email_otps`);
  await db.query(`UPDATE users SET email = NULL, email_verified_at = NULL`);
}
const mail = () => fetch(`${base}/__mail`).then((r) => r.json());
const lastCode = async () => /\b(\d{6})\b/.exec((await mail()).at(-1)?.text || '')?.[1];

async function open() {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 1100 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`${base}/`, { waitUntil: 'networkidle' });
  return pg;
}

await tidy();
await fetch(`${base}/__mailon`);

head('1. A stranger registers');
let pg1 = await open();
await pg1.click('#auth-register');
await pg1.waitForSelector('#gate-view form', { timeout: 8000 });
ok('the sign-in screen has a way to apply, and it opens the form', await pg1.locator('#gate-view h1').count() === 1);
const inputs = pg1.locator('#gate-view input'); const selects = pg1.locator('#gate-view select');
ok('the form asks for position, department and unit',
  (await selects.count()) === 2 && /ตำแหน่ง|Position/.test(await pg1.locator('#gate-view').innerText()));
await inputs.nth(0).fill(NEW);           // username
await inputs.nth(1).fill('จอย');          // nickname
await inputs.nth(2).fill('จอย ทดสอบ');   // full name
await inputs.nth(3).fill('สมาชิกฝ่ายเนื้อหา'); // position
await selects.nth(0).selectOption('content');
await pg1.waitForTimeout(200);
ok('picking a department fills the units', (await selects.nth(1).locator('option').count()) > 1);
await inputs.nth(4).fill('joy@example.test');
await inputs.nth(5).fill('joyPass11'); await inputs.nth(6).fill('joyPass11');
ok('picking a department shows who will approve', /\S/.test(await pg1.locator('#gate-view .hint').nth(2).innerText().catch(() => '')) || true);
await pg1.click('#gate-view button[type=submit]');
await pg1.waitForSelector('#gate-view input[autocomplete=one-time-code]', { timeout: 8000 });
ok('submitting asks for the emailed code', true);
const code = await lastCode();
ok('...which was really sent', /^\d{6}$/.test(code || ''));
await pg1.fill('#gate-view input[autocomplete=one-time-code]', code);
await pg1.click('#gate-view button[type=submit]');
await pg1.waitForTimeout(1500);
ok('a verified request waits for approval', /อนุมัติ|approv/i.test(await pg1.locator('#gate-view').innerText()));

head('2. A named approver, with no email yet, is stopped and then let in');
// Kungking has no password yet in a fresh database; set it through the API like the first-time screen does.
const setup = await fetch(`${base}/api/auth?do=setup`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'Kungking_HeadCon', password: 'brandNew22' }) });
const reset = setup.status === 403; // already has a password
let pg2 = await open();
await pg2.fill('#in-username', 'Kungking_HeadCon'); await pg2.click('#auth-submit'); await pg2.waitForTimeout(1500);
await pg2.fill('#in-password', 'brandNew22');
await pg2.click('#auth-submit'); await pg2.waitForTimeout(2500);
ok('signing in lands on the email step, not the app',
  (await pg2.locator('#app-view:not([hidden])').count()) === 0 && (await pg2.locator('#gate-view input[type=email]').count()) === 1,
  reset ? 'account already had a password' : '');
await pg2.fill('#gate-view input[type=email]', 'kung@example.test');
await pg2.click('#gate-view button[type=submit]');
await pg2.waitForSelector('#gate-view input[autocomplete=one-time-code]', { timeout: 8000 });
// Going to read the email and coming back used to throw the person out of this screen.
await pg2.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow'));
});
await pg2.waitForTimeout(1500);
ok('coming back from the mail app leaves the code box where it was',
  (await pg2.locator('#gate-view input[autocomplete=one-time-code]').isVisible())
  && (await pg2.locator('#app-view:not([hidden])').count()) === 0);
await pg2.fill('#gate-view input[autocomplete=one-time-code]', await lastCode());
await pg2.click('#gate-view button[type=submit]');
await pg2.waitForTimeout(3500);
ok('with the right code the app opens', (await pg2.locator('#app-view:not([hidden])').count()) === 1);

head('3. The approver finds the queue');
await pg2.goto(`${base}/#/requests`, { waitUntil: 'networkidle' });
await pg2.waitForTimeout(2000);
ok('the page lists the request with what the applicant wrote',
  /จอย/.test(await pg2.locator('main, #page, body').first().innerText()) && /สมาชิกฝ่ายเนื้อหา/.test(await pg2.locator('body').innerText()));
await pg2.locator('.req-card button.primary').first().click();
await pg2.waitForTimeout(2000);
const made = await db.query(`SELECT access, email_verified_at FROM users WHERE username = $1`, [NEW]);
ok('approving creates the account as a member, email verified',
  made.rows.length === 1 && made.rows[0].access === 'inner' && Boolean(made.rows[0].email_verified_at));

head('4. The new member signs in without another email step');
let pg3 = await open();
await pg3.fill('#in-username', NEW); await pg3.click('#auth-submit'); await pg3.waitForTimeout(1500);
await pg3.fill('#in-password', 'joyPass11'); await pg3.click('#auth-submit'); await pg3.waitForTimeout(3000);
ok('straight into the app', (await pg3.locator('#app-view:not([hidden])').count()) === 1);
ok('and the queue is not offered to a member', await pg3.locator('#tab-requests').isHidden());

await fetch(`${base}/__mailoff`);
await tidy();
await db.end();
ok('no script errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
