/**
 * The getting-started guide: install, notifications, Google Calendar.
 *
 * What has to hold: it opens by itself for anybody with a step left, and not
 * for anybody who has finished; "Later" puts it off for this visit only; each
 * kind of phone gets the instructions that work on it; a step is ticked from
 * what the browser and the server actually report, not from a button press
 * alone; and it can always be reopened from the profile menu.
 */
import { chromium } from 'playwright';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fairv2';
const { getSql } = await import('./lib/db.js');
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

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const LINE_UA = IPHONE_UA + ' Line/14.12.0';

const DESK = { viewport: { width: 1440, height: 950 } };
const phone = (ua) => ({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: ua });

/** This browser already allows notifications and holds a subscription. */
const PUSH_ON = () => {
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
  ServiceWorkerContainer.prototype.getRegistration = async () => ({
    pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/x' }) },
  });
};

async function signIn(ctx, user, pass) {
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  await pg.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit');
  return pg;
}

/** Waits for the guide, closing anything that opened first (it waits for those). */
async function guideOf(pg, ms = 9000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pg.locator('#modal-root .guide-modal').count()) return true;
    const other = pg.locator('#modal-root .veil:not(:has(.guide-modal)) .modal > header button');
    if (await other.count()) await other.last().click().catch(() => {});
    await pg.waitForTimeout(400);
  }
  return false;
}
const items = (pg) => pg.locator('.guide-modal .gd-item').evaluateAll((els) =>
  els.map((e) => `${e.classList.contains('done') ? '✓' : e.classList.contains('now') ? '→' : '·'} ${e.textContent.trim()}`));
const rawKeys = (pg) => pg.locator('.guide-modal').evaluate((m) =>
  [...m.querySelectorAll('*')].map((e) => e.childNodes.length === 1 && e.firstChild.nodeType === 3 ? e.textContent.trim() : '')
    .filter((x) => /^guide[A-Z_]/.test(x)));

// ===========================================================================
console.log('\nThe strings');
{
  const ctx = await b.newContext(DESK);
  const pg = await ctx.newPage();
  await pg.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
  const missing = await pg.evaluate(() => {
    const th = Object.keys(window.STRINGS.th).filter((k) => k.startsWith('guide'));
    const en = Object.keys(window.STRINGS.en).filter((k) => k.startsWith('guide'));
    return { th: th.length, onlyTh: th.filter((k) => !en.includes(k)), onlyEn: en.filter((k) => !th.includes(k)) };
  });
  ok('every guide line is written in Thai and in English',
    missing.th > 40 && !missing.onlyTh.length && !missing.onlyEn.length,
    `${missing.th} lines; ${[...missing.onlyTh, ...missing.onlyEn].join(', ')}`);
  await ctx.close();
}

// ===========================================================================
console.log('\nOn a computer, first visit');
await sql`UPDATE users SET calendar_seen_at = NULL WHERE username IN ('Jade_Pres', 'Kaew_VP', 'Ploy_StaffCon', 'Fah_StaffCon', 'New_UnitCon')`;
await sql`UPDATE users SET calendar_token = NULL WHERE username = 'Kaew_VP'`;

const deskCtx = await b.newContext(DESK);
let pg = await signIn(deskCtx, 'Jade_Pres', 'fairAdmin1');
ok('the guide opens by itself after signing in', await guideOf(pg));
let list = await items(pg);
ok('...as a checklist of what is left', list.length === 2, list.join(' | '));
ok('...without "add to home screen", which means nothing on a computer',
  !list.some((x) => x.includes('หน้าจอโฮม')));
ok('...starting at notifications', list[0].startsWith('→') && list[0].includes('แจ้งเตือน'));
const perm = await pg.evaluate(() => Notification.permission);
if (perm === 'denied') {
  ok('notifications blocked in this browser: it says how to unblock them',
    (await pg.locator('.guide-modal .gd-li').count()) === 3 &&
    (await pg.locator('.guide-modal footer .btn', { hasText: 'ตรวจอีกครั้ง' }).count()) === 1);
} else {
  ok('there is one button to turn notifications on',
    (await pg.locator('.guide-modal footer .btn', { hasText: 'เปิด' }).count()) >= 1, perm);
}
ok('no line shows as a bare key', (await rawKeys(pg)).length === 0, (await rawKeys(pg)).join(', '));

await pg.locator('.guide-modal footer .btn', { hasText: 'ไว้ทีหลัง' }).click();
await pg.waitForTimeout(400);
ok('"Later" closes it', (await pg.locator('.guide-modal').count()) === 0);
await pg.reload({ waitUntil: 'networkidle' });
ok('...and it stays closed for the rest of this visit', !(await guideOf(pg, 5000)));

const tab2 = await deskCtx.newPage();
tab2.on('pageerror', (e) => errs.push(`tab2: ${e.message}`));
await tab2.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
ok('coming back later (a new visit) brings it back', await guideOf(tab2));
await tab2.locator('.guide-modal header button').click();
await tab2.close();

// The menu
await pg.click('#me-avatar'); await pg.waitForTimeout(300);
const menuLabel = await pg.locator('#me-guide').innerText();
ok('the profile menu has "คู่มือเริ่มต้นใช้งาน"', menuLabel.includes('คู่มือ'), menuLabel);
await pg.click('#me-guide'); await pg.waitForTimeout(800);
ok('...which opens the guide whenever wanted', (await pg.locator('.guide-modal').count()) === 1);
ok('...with the menu closed behind it', await pg.locator('#me-pop').isHidden());
await pg.locator('.guide-modal header button').click(); await pg.waitForTimeout(300);
await deskCtx.close();

// ===========================================================================
console.log('\nThe Google Calendar step');
const calCtx = await b.newContext(DESK);
await calCtx.addInitScript(PUSH_ON);
pg = await signIn(calCtx, 'Kaew_VP', 'coadminPw1');
ok('with notifications already on, the guide still opens for the calendar', await guideOf(pg));
list = await items(pg);
ok('...notifications ticked, the calendar next', list[0].startsWith('✓') && list[1].startsWith('→'), list.join(' | '));
ok('...with its three steps', (await pg.locator('.guide-modal .gd-card .gd-li').count()) === 3);

await pg.locator('.guide-modal .gd-actions .btn', { hasText: 'สร้างลิงก์ปฏิทิน' }).click();
await pg.waitForTimeout(1200);
const open = pg.locator('.guide-modal .gd-actions a', { hasText: 'Google Calendar' });
const href = (await open.count()) ? await open.getAttribute('href') : '';
const [{ calendar_token: token }] = await sql`SELECT calendar_token FROM users WHERE username = 'Kaew_VP'`;
ok('"create" makes the link and offers to open Google with it',
  href.startsWith('https://calendar.google.com/calendar/u/0/r/settings/addbyurl?cid='), href.slice(0, 70));
const cid = decodeURIComponent(href.split('cid=')[1] || '');
ok('...for her own feed: her tasks, events and meetings', Boolean(token) && cid.includes(token) && cid.endsWith('&scope=mine'));
ok('...it opens in a new tab, keeping the guide here', (await open.getAttribute('target')) === '_blank');
ok('...with a copy button for adding it by hand',
  (await pg.locator('.guide-modal .gd-actions .btn', { hasText: 'คัดลอกลิงก์' }).count()) === 1);
ok('no iPhone-calendar button on a computer',
  (await pg.locator('.guide-modal .gd-actions a[href^="webcal:"]').count()) === 0);

// Pressing "added" before Google has looked: believed for now, and said so.
await pg.locator('.guide-modal footer .btn', { hasText: 'เพิ่มแล้ว' }).click();
await pg.waitForTimeout(700);
ok('"added" before Google has fetched it says it has not seen it yet',
  (await pg.locator('.guide-modal .notice.warn').innerText().catch(() => '')).includes('Google'));
await pg.waitForTimeout(2200);
ok('...but takes her word for it and finishes', (await pg.locator('.guide-modal .gd-card.done').count()) === 1);
await pg.locator('.guide-modal footer .btn').click();

// Google fetches the feed: now the server knows, without her word.
await pg.evaluate(() => { localStorage.removeItem('fair-guide-cal-claimed'); sessionStorage.clear(); });
const res = await fetch(cid);
ok('Google fetching the feed works', res.status === 200);
const [{ calendar_seen_at: seen }] = await sql`SELECT calendar_seen_at FROM users WHERE username = 'Kaew_VP'`;
ok('...and is recorded against her', Boolean(seen));
await pg.reload({ waitUntil: 'networkidle' });
ok('with everything done, the guide no longer opens by itself', !(await guideOf(pg, 5000)));
await pg.click('#me-avatar'); await pg.click('#me-guide'); await pg.waitForTimeout(900);
list = await items(pg);
ok('...and from the menu it shows every step ticked', list.length === 2 && list.every((x) => x.startsWith('✓')), list.join(' | '));
ok('...under "all set"', (await pg.locator('.guide-modal .gd-card.done').count()) === 1);
await calCtx.close();

// ===========================================================================
console.log('\nOn an iPhone, in Safari');
const iosCtx = await b.newContext(phone(IPHONE_UA));
pg = await signIn(iosCtx, 'Ploy_StaffCon', 'memberPw11');
ok('the guide opens by itself', await guideOf(pg));
await pg.waitForTimeout(500);
list = await items(pg);
ok('...with all three steps, home screen first', list.length === 3 && list[0].startsWith('→') && list[0].includes('หน้าจอโฮม'),
  list.join(' | '));
ok('...as a sheet from the bottom, like every dialog on a phone',
  await pg.locator('#modal-root .veil.sheet:has(.guide-modal)').count() === 1);
const sheet = await pg.locator('.guide-modal').boundingBox();
ok('...that fits on the screen', sheet && sheet.y >= 0 && sheet.y + sheet.height <= 852 + 1,
  sheet && `${Math.round(sheet.y)}–${Math.round(sheet.y + sheet.height)}`);
const lastBtn = await pg.locator('.guide-modal footer .btn').last().boundingBox();
ok('...with its buttons above the bottom edge, not sunk under it', lastBtn && lastBtn.y + lastBtn.height <= 852,
  lastBtn && `${Math.round(lastBtn.y + lastBtn.height)}px`);
const iosSteps = await pg.locator('.guide-modal .gd-li .gd-tx').allInnerTexts();
ok('Safari\'s own steps: Share, then "เพิ่มไปยังหน้าจอโฮม"',
  iosSteps.length === 4 && iosSteps[1].includes('เพิ่มไปยังหน้าจอโฮม'), iosSteps.join(' / '));
ok('...with the Share icon drawn beside the step that needs it',
  (await pg.locator('.guide-modal .gd-li').first().locator('.gd-ic svg').count()) === 1);
ok('no line shows as a bare key', (await rawKeys(pg)).length === 0);
const shotDir = '/tmp/claude-0';
await pg.screenshot({ path: `${shotDir}/guide-ios.png` });

await pg.locator('.guide-modal footer .btn', { hasText: 'ติดตั้งแล้ว' }).click();
await pg.waitForTimeout(900);
list = await items(pg);
ok('"installed" ticks it and moves on to notifications', list[0].startsWith('✓') && list[1].startsWith('→'), list.join(' | '));
ok('...which, in a Safari tab, says it must be opened from the icon first',
  (await pg.locator('.guide-modal .notice.warn').innerText().catch(() => '')).includes('หน้าจอโฮม'));
await pg.screenshot({ path: `${shotDir}/guide-ios-2.png` });
await iosCtx.close();

// ===========================================================================
console.log('\nOn an Android phone, in Chrome');
const andCtx = await b.newContext(phone(ANDROID_UA));
// Chrome offers to install: stand in for its event, accepted when shown.
await andCtx.addInitScript(() => {
  window.addEventListener('load', () => setTimeout(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  }, 50));
});
pg = await signIn(andCtx, 'Fah_StaffCon', 'memberPw22');
ok('the guide opens by itself', await guideOf(pg));
const oneTap = pg.locator('.guide-modal footer .btn', { hasText: 'ติดตั้งแอป' });
ok('Chrome can install in one tap, so there is one button for it', (await oneTap.count()) === 1);
await oneTap.click(); await pg.waitForTimeout(900);
ok('...which shows Chrome\'s own install box', await pg.evaluate(() => window.__prompted === true));
list = await items(pg);
ok('...and once accepted, the step is ticked', list[0].startsWith('✓'), list.join(' | '));
await pg.screenshot({ path: `${shotDir}/guide-android.png` });
await andCtx.close();

// ===========================================================================
console.log('\nOpened from a link in LINE');
const lineCtx = await b.newContext(phone(LINE_UA));
pg = await signIn(lineCtx, 'New_UnitCon', 'unitLead11');
ok('the guide opens by itself', await guideOf(pg));
const lineSteps = await pg.locator('.guide-modal .gd-li .gd-tx').allInnerTexts();
ok('inside LINE it first says to open the page in a real browser',
  lineSteps.length === 3 && lineSteps[1].includes('เปิดในเบราว์เซอร์'), lineSteps.join(' / '));
await lineCtx.close();

await sql`UPDATE users SET calendar_seen_at = NULL WHERE username IN ('Kaew_VP')`;

console.log(errs.length ? '\nerrors:\n' + errs.join('\n') : '\nno page errors');
if (errs.length) failed += errs.length;
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();

process.exit(failed === 0 ? 0 : 1);
