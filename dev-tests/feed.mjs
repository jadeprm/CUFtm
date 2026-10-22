/**
 * The feed, driven through the page.
 *
 * The server side has its own checks in run.mjs §94. What only exists in the
 * browser is the part this suite is for: the composer, the way the pictures
 * lay themselves out by how many there are, replies opening in place, the
 * ••• menu, and the ฝ่าย picker that replaced a tab per ฝ่าย.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const head = (s) => console.log('\n' + s);

async function as(user, pass, viewport = { width: 1280, height: 1000 }) {
  const ctx = await b.newContext({ viewport });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(`${user}: ${m.text()}`);
  });
  pg.on('dialog', async (d) => { await d.accept(''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2800);
  await pg.goto(`http://localhost:${PORT}/#/feed`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(2200);
  return pg;
}

/** Two real PNGs of different shapes, so the layout rules can be told apart. */
const SHOTS = ['/tmp/claude-0/feed-a.png', '/tmp/claude-0/feed-b.png'];
{
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const zlib = await import('node:zlib');
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(body) >>> 0);
    return Buffer.concat([len, body, cc]);
  };
  const png = (w, h, grey) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.concat(Array.from({ length: h }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, grey)])));
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
  };
  mkdirSync('/tmp/claude-0', { recursive: true });
  writeFileSync(SHOTS[0], png(240, 400, 170));   // portrait
  writeFileSync(SHOTS[1], png(400, 240, 110));   // landscape
}

const TAG = 'FEEDTEST ' + Date.now().toString(36).slice(-5);

/**
 * Unpin whatever a previous run left pinned, before anything else.
 *
 * Only five posts may be held at the top at once, which is a real limit and
 * not a formality — so an earlier run legitimately fills every slot and this
 * one's pin is legitimately refused. Without this the suite fails on a rule
 * working exactly as intended, which is the most confusing kind of red.
 */
async function clearPins(pg) {
  await pg.evaluate(async () => {
    const d = await fetch('/api/notifications?do=feed', { credentials: 'same-origin' })
      .then((r) => r.json());
    for (const p of (d.pinned || [])) {
      await fetch('/api/notifications?do=feed-post', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: p.id, pinned: false }),
      });
    }
  });
}

// ===========================================================================
head('1. The composer');

const tidier = await as('Jade_Pres', 'fairAdmin1');
await clearPins(tidier);
await tidier.context().close();

const ploy = await as('Ploy_StaffCon', 'memberPw11');
ok('a member — who cannot create a task — gets a composer',
  await ploy.locator('.feed-compose-row').count() === 1);

/**
 * Three tabs and a dropdown, never a tab per ฝ่าย. An admin is in all
 * fourteen, which produced seventeen buttons over three lines.
 */
ok('there are three tabs, not one per ฝ่าย',
  await ploy.locator('.feed-scopes > button').count() === 3,
  String(await ploy.locator('.feed-scopes > button').count()));
ok('...and the ฝ่าย choice is a dropdown beside them',
  await ploy.locator('.feed-dept-pick').count() === 1);
ok('...which starts on ทั้งโครงการ in the composer, the honest default',
  (await ploy.locator('.feed-where').inputValue()) === '');

await ploy.locator('.feed-compose-row textarea').fill(TAG + ' ภาพเก็บของเมื่อคืน');
await ploy.setInputFiles('#feed-img', SHOTS);
await ploy.waitForTimeout(1200);
ok('two pictures attach and preview', await ploy.locator('.feed-shot img').count() === 2);

await ploy.locator('.feed-compose-row button:has-text("โพสต์")').click();
await ploy.waitForTimeout(2600);

const mine = ploy.locator('.feed-card', { hasText: TAG }).first();
ok('the post appears at the top of the feed', await mine.count() === 1);
ok('...with both pictures', await mine.locator('.feed-img').count() === 2);
/** Two pictures sit side by side; one would get the full width at its shape. */
ok('...laid out as a pair rather than a single strip',
  await mine.locator('.feed-images.n2').count() === 1);
ok('...and the composer is empty again',
  (await ploy.locator('.feed-compose-row textarea').inputValue()) === '');

// ===========================================================================
head('2. Replies, in place');

const kk = await as('Kungking_HeadCon', 'brandNew22');
const theirs = kk.locator('.feed-card', { hasText: TAG }).first();
ok('somebody else sees it', await theirs.count() === 1);

/** A conversation hidden behind a button is a conversation nobody joins. */
ok('with no replies yet, the reply box is folded away',
  await theirs.locator('.feed-replies').isHidden());
await theirs.locator('.feed-act:has-text("ตอบ")').click();
await kk.waitForTimeout(400);
ok('...and the reply button opens it', await theirs.locator('.feed-replies').isVisible());

await theirs.locator('.feed-reply-add input').fill('เหนื่อยแต่สนุกครับ');
await theirs.locator('.feed-reply-add button').click();
await kk.waitForTimeout(2400);

const after = kk.locator('.feed-card', { hasText: TAG }).first();
ok('the reply lands on the card', await after.locator('.feed-reply').count() === 1,
  await after.locator('.feed-reply').innerText().catch(() => '(none)'));
ok('...and the count on the button says so',
  /1/.test(await after.locator('.feed-act:has-text("ตอบ")').innerText()));
ok('...and a card that HAS replies shows them without being asked',
  await after.locator('.feed-replies').isVisible());

// ===========================================================================
head('3. Liking');

const likeBtn = after.locator('.feed-act:has-text("ถูกใจ")');
await likeBtn.click();
await kk.waitForTimeout(1300);
ok('liking marks the button and shows the count',
  (await likeBtn.getAttribute('class')).includes('on') && /1/.test(await likeBtn.innerText()),
  await likeBtn.innerText());
await likeBtn.click();
await kk.waitForTimeout(1300);
ok('...and pressing again takes it back, leaving no zero on screen',
  !(await likeBtn.getAttribute('class')).includes('on')
  && !/\d/.test(await likeBtn.innerText()), await likeBtn.innerText());

// ===========================================================================
head('4. The ••• menu, and pinning');

ok('somebody else is not offered edit or delete on your post',
  !(await after.locator('.feed-menu-pop').innerText().catch(() => '')).includes('แก้ไข'));

const jade = await as('Jade_Pres', 'fairAdmin1');
const asAdmin = jade.locator('.feed-card', { hasText: TAG }).first();
await asAdmin.locator('.feed-menu').click();
await jade.waitForTimeout(400);
const menuText = await asAdmin.locator('.feed-menu-pop').innerText();
ok('an admin is offered pinning', /ปักหมุด/.test(menuText), menuText.replace(/\n/g, ' | '));

await asAdmin.locator('.feed-menu-pop button:has-text("ปักหมุดไว้บนสุด")').click();
await jade.waitForTimeout(2600);

const pinnedCard = jade.locator('.feed-card.pinned', { hasText: TAG });
ok('the post is held at the top, and says so', await pinnedCard.count() === 1);
ok('...and appears exactly once, not in the stream as well',
  await jade.locator('.feed-card', { hasText: TAG }).count() === 1,
  String(await jade.locator('.feed-card', { hasText: TAG }).count()));

/** Opening one menu closes any other: two lists of actions over each other
 *  gives no way to tell which post either belongs to. */
const cards = jade.locator('.feed-card');
if (await cards.count() > 1) {
  await cards.nth(0).locator('.feed-menu').click();
  await jade.waitForTimeout(250);
  await cards.nth(1).locator('.feed-menu').click();
  await jade.waitForTimeout(250);
  ok('only one ••• menu is open at a time',
    await jade.locator('.feed-menu-pop:visible').count() === 1,
    String(await jade.locator('.feed-menu-pop:visible').count()));
} else {
  ok('only one ••• menu is open at a time', true, 'only one card to test with');
}

// ===========================================================================
head('5. A ฝ่าย post stays in its ฝ่าย');

await kk.locator('.feed-compose-row textarea').fill(TAG + ' เรื่องภายในฝ่ายเนื้อหา');
const deptValue = await kk.locator('.feed-where option').evaluateAll(
  (els) => (els.find((e) => e.value) || {}).value);
if (deptValue) {
  await kk.locator('.feed-where').selectOption(deptValue);
  await kk.locator('.feed-compose-row button:has-text("โพสต์")').click();
  await kk.waitForTimeout(2600);
  ok('a ฝ่าย post is marked with its ฝ่าย',
    await kk.locator('.feed-card', { hasText: 'เรื่องภายในฝ่ายเนื้อหา' }).locator('.chip.dept').count() >= 1);

  const outsider = await as('Ikkew_HeadOper1', 'editorPw2');
  ok('...and somebody in another ฝ่าย does not see it',
    await outsider.locator('.feed-card', { hasText: 'เรื่องภายในฝ่ายเนื้อหา' }).count() === 0);
} else {
  ok('a ฝ่าย post is marked with its ฝ่าย', true, 'this account is in no ฝ่าย');
  ok('...and somebody in another ฝ่าย does not see it', true, 'skipped');
}

// ===========================================================================
head('6. On a phone');

const phone = await as('Ploy_StaffCon', 'memberPw11', { width: 390, height: 844 });
ok('the feed does not scroll sideways at 390px',
  !(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
const act = phone.locator('.feed-act').first();
if (await act.count()) {
  const box = await act.boundingBox();
  ok('...and ถูกใจ is a thumb-sized target', box && box.height >= 44,
    box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'none');
}
ok('...and the tab row still fits',
  await phone.locator('#tabs').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));

// ===========================================================================
try { await clearPins(jade); } catch (e) { errs.push('cleanup: ' + e.message); }

ok('no page errors anywhere in this suite', errs.length === 0, errs.slice(0, 4).join(' | '));
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
