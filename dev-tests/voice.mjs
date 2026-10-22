/**
 * The committee's own voice: reporting a bug, the pop-up, the shelf of links.
 *
 * Three features from 22 October, driven through the real pages rather than
 * the API — because every one of them has a part that only exists in the
 * browser: the live duplicate check as somebody types a title, the pop-up's
 * refusal to close on a stray tap, and the breadcrumb that walks back out of
 * a folder.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
// This is the one suite that wants the real pop-up through.
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }), { popups: true });
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const head = (s) => console.log('\n' + s);

async function as(user, pass, viewport = { width: 1440, height: 980 }) {
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
  return pg;
}

/** A real PNG on disk, for the screenshot and poster pickers. */
const SHOT = '/tmp/claude-0/voice-shot.png';
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(320, 0); ihdr.writeUInt32BE(180, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 180 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(320 * 3, 200)])));
  mkdirSync('/tmp/claude-0', { recursive: true });
  writeFileSync(SHOT, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/**
 * Clear what a previous run left live, BEFORE anything else.
 *
 * A pop-up outlives the run that made it, and this suite is the one that
 * lets pop-ups through — so a crashed run would greet section 1 with a box
 * over the button it is trying to press.
 */
async function clearPopups(pg) {
  await pg.evaluate(async () => {
    const d = await fetch('/api/push?do=popups', { credentials: 'same-origin' }).then((r) => r.json());
    for (const p of (d.popups || [])) {
      await fetch('/api/push?do=popup-delete&id=' + encodeURIComponent(p.id),
        { method: 'DELETE', credentials: 'same-origin' });
    }
  });
}
async function clearShelf(pg) {
  await pg.evaluate(async () => {
    const d = await fetch('/api/meta?do=shelf', { credentials: 'same-origin' }).then((r) => r.json());
    const mine = (d.nodes || []).filter((n) => n.title.indexOf('VOICE:') === 0);
    // Deepest first, so a folder is empty by the time its own turn comes.
    mine.sort((a, b) => (b.parentId ? 1 : 0) - (a.parentId ? 1 : 0));
    for (const n of mine) {
      await fetch('/api/meta?do=shelf-delete&id=' + encodeURIComponent(n.id),
        { method: 'DELETE', credentials: 'same-origin' });
    }
  });
}

const tidier = await as('Jade_Pres', 'fairAdmin1');
await clearPopups(tidier);
await clearShelf(tidier);
await tidier.context().close();

// ===========================================================================
head('1. A member reports a bug, from the page where it happened');

const ploy = await as('Ploy_StaffCon', 'memberPw11');
await ploy.goto(`http://localhost:${PORT}/#/reports`, { waitUntil: 'networkidle' });
await ploy.waitForTimeout(1500);

ok('a member — who cannot create a task — is offered the report button',
  await ploy.locator('button:has-text("แจ้งเรื่องใหม่")').count() > 0);

await ploy.click('button:has-text("แจ้งเรื่องใหม่")');
await ploy.waitForTimeout(700);
ok('the form opens on บั๊ก rather than making them choose first',
  await ploy.locator('.rep-kindseg button.on b').first().innerText() === 'บั๊ก');

/**
 * "ตอนนั้นกำลังทำอะไรอยู่" is above the description on purpose: it is the most
 * useful sentence in a bug report and the one people skip when it comes last.
 */
const fieldOrder = await ploy.$$eval('.modal .body .field label', (els) => els.map((e) => e.textContent));
const iDoing = fieldOrder.findIndex((x) => /ตอนนั้นกำลังทำอะไร/.test(x));
const iBody = fieldOrder.findIndex((x) => /^เกิดอะไรขึ้น$/.test(x));
ok('...and it asks what they were doing BEFORE it asks what happened',
  iDoing > -1 && iBody > -1 && iDoing < iBody, `doing@${iDoing} body@${iBody}`);

ok('the urgent choice says plainly that it wakes people up',
  (await ploy.locator('.rep-sevseg button.sev-urgent').count()) > 0);
await ploy.click('.rep-sevseg button.sev-urgent');
await ploy.waitForTimeout(300);
ok('...and says so the moment it is chosen',
  /ปลุก/.test(await ploy.locator('.rep-sevseg ~ .notice.warn, .field .notice.warn').first().innerText()));

// What is being sent about the device is shown, not attached quietly.
await ploy.click('.rep-auto summary');
await ploy.waitForTimeout(250);
const autoText = await ploy.locator('.rep-auto ul').innerText();
ok('the device line is shown to them before they send it',
  /เครื่อง:/.test(autoText) && /เวอร์ชัน:/.test(autoText), autoText.replace(/\n/g, ' | '));
ok('...and carries no phone number or anything else personal',
  !/\d{3}-\d{3}-\d{4}/.test(autoText));

await ploy.fill('.modal .field input[type="text"]', 'VOICE: ปุ่มบันทึกในหน้างานกดไม่ติด');
await ploy.locator('textarea').first().fill('กำลังแก้สถานะงานในหน้างาน');
await ploy.locator('textarea').nth(1).fill('กดแล้วไม่มีอะไรเกิดขึ้น ต้องรีเฟรชหน้า');
await ploy.setInputFiles('#rep-shots', SHOT);
await ploy.waitForTimeout(900);
ok('a screenshot can be attached, and shows as a thumbnail',
  await ploy.locator('.rep-shot img').count() === 1);

await ploy.click('button:has-text("ส่งเรื่อง")');
await ploy.waitForTimeout(2200);
const sentCode = await ploy.locator('.rep-sent-code code').innerText().catch(() => '');
ok('submitting ends on the report’s own code, which is the handle people quote',
  /^R\d{4}$/.test(sentCode), sentCode);
await ploy.click('.modal footer button:has-text("ปิด")');
await ploy.waitForTimeout(900);

// ===========================================================================
head('2. The duplicate check, which is the point of an open list');

await ploy.click('button:has-text("แจ้งเรื่องใหม่")');
await ploy.waitForTimeout(600);
// Deliberately NOT the same words: "ปุ่มบันทึกกดไม่ได้" shares no substring
// with "ปุ่มบันทึกในหน้างานกดไม่ติด", and is plainly the same fault.
await ploy.fill('.modal .field input[type="text"]', 'ปุ่มบันทึก กดไม่ได้ หน้างาน');
await ploy.waitForTimeout(900);
ok('typing a title that matches an existing report offers it back',
  await ploy.locator('.rep-dups:not([hidden])').count() > 0);
const dupRow = ploy.locator('.rep-dup-row').first();
ok('...naming it by code', /^R\d{4}$/.test((await dupRow.locator('code').innerText()).trim()));
const dupBtn = (await dupRow.locator('button').last().innerText()).trim();
ok('...and offers the press instead of a second report — already pressed, in her case, since she reported it',
  dupBtn === 'เจอเหมือนกัน' || dupBtn === 'กดแล้ว', dupBtn);
await ploy.locator('.modal header button:has-text("✕")').click();
await ploy.waitForTimeout(500);

// ===========================================================================
head('3. What a member may and may not see of a report');

await ploy.locator('.rep-open').first().click();
await ploy.waitForTimeout(900);
const bodyText = await ploy.locator('.modal .body').innerText();
ok('their own report shows them its device line', /เครื่อง:/.test(bodyText));
ok('...and does not offer them the triage controls',
  await ploy.locator('.rep-triage').count() === 0);
await ploy.locator('.modal header button:has-text("✕")').click();
await ploy.waitForTimeout(400);

const ikkew = await as('Ikkew_HeadOper1', 'editorPw2');
await ikkew.goto(`http://localhost:${PORT}/#/reports`, { waitUntil: 'networkidle' });
await ikkew.waitForTimeout(1600);
ok('somebody else sees the report on the list', await ikkew.locator('.rep-row').count() > 0);
await ikkew.locator('.rep-open').first().click();
await ikkew.waitForTimeout(900);
const otherText = await ikkew.locator('.modal .body').innerText();
ok('...but not the browser line somebody else’s report carries', !/เครื่อง:/.test(otherText));
ok('...nor the screenshots', await ikkew.locator('.rep-shot').count() === 0);
await ikkew.locator('.modal header button:has-text("✕")').click();
await ikkew.waitForTimeout(400);

// เจอเหมือนกัน from the list, with the count on the button itself.
/**
 * Asserted as a toggle rather than a direction: a vote outlives the run that
 * cast it, so "it goes up by one" is only true against a fresh database.
 * What is always true is that one press changes it, the button reflects
 * that, and a second press puts it back.
 */
const metooBtn = ikkew.locator('.rep-row .rep-metoo').first();
const countOf = () => metooBtn.locator('b').innerText().then(Number);
const wasOn = (await metooBtn.getAttribute('class')).includes('on');
const before = await countOf();
await metooBtn.click();
await ikkew.waitForTimeout(1100);
const after = await countOf();
const nowOn = (await metooBtn.getAttribute('class')).includes('on');
ok('pressing the button counts them, without opening anything',
  after === before + (wasOn ? -1 : 1) && nowOn === !wasOn,
  before + ' to ' + after + ', on: ' + wasOn + ' to ' + nowOn);

await metooBtn.click();
await ikkew.waitForTimeout(1100);
ok('...and pressing it again puts it back exactly as it was',
  (await countOf()) === before
  && (await metooBtn.getAttribute('class')).includes('on') === wasOn);

ok('an editor is not offered the daily summary tab',
  await ikkew.locator('.rep-tabs button:has-text("สรุปรายวัน")').count() === 0);

// ===========================================================================
head('4. The rota, and the summary they work from');

const jade = await as('Jade_Pres', 'fairAdmin1');
await jade.goto(`http://localhost:${PORT}/#/reports`, { waitUntil: 'networkidle' });
await jade.waitForTimeout(1600);
ok('an admin gets the สรุปรายวัน tab', await jade.locator('.rep-tabs button:has-text("สรุปรายวัน")').count() > 0);
await jade.click('.rep-tabs button:has-text("สรุปรายวัน")');
await jade.waitForTimeout(1600);

const digest = await jade.locator('.rep-digest').innerText();
ok('the summary is there, as one block of text to copy', digest.length > 80);
ok('...headed by the day, and split into today and what is still open',
  /สรุปรายงานปัญหา/.test(digest) && /ของวันนี้/.test(digest) && /ยังค้างอยู่/.test(digest));
ok('...and naming no particular developer anywhere', !/claude/i.test(digest));
ok('there is one button that copies the whole thing',
  await jade.locator('button:has-text("คัดลอกทั้งหมด")').count() > 0);

// The rota picker: admins listed but not tickable, editors not offered at all.
await jade.click('button:has-text("ตั้งคนที่จะได้รับแจ้งเรื่องด่วน")');
await jade.waitForTimeout(800);
ok('admins are shown as always told, with no checkbox to untick',
  await jade.locator('.rep-team-row.fixed').count() > 0
  && await jade.locator('.rep-team-row.fixed input').count() === 0);
const pickable = await jade.$$eval('.rep-team-row:not(.fixed) span.grow', (els) => els.map((e) => e.textContent));
ok('...and only co-admins can be added', pickable.length > 0, pickable.join(', '));
await jade.locator('.modal header button:has-text("✕")').click();
await jade.waitForTimeout(400);

// An admin opening a report does get the triage controls.
await jade.click('.rep-tabs button:has-text("ยังค้างอยู่")');
await jade.waitForTimeout(900);
await jade.locator('.rep-open').first().click();
await jade.waitForTimeout(900);
ok('an admin opening a report gets the triage controls', await jade.locator('.rep-triage').count() === 1);
await jade.selectOption('.rep-triage select >> nth=0', 'planned');
await jade.locator('.rep-triage textarea').fill('รับเรื่องแล้ว จะแก้รอบหน้า');
await jade.click('.rep-triage button:has-text("บันทึก")');
await jade.waitForTimeout(1600);
ok('...and saving says so', /บันทึกแล้ว/.test(await jade.locator('.modal .notice.ok').innerText().catch(() => '')));
await jade.locator('.modal header button:has-text("✕")').click();
await jade.waitForTimeout(500);

// ===========================================================================
head('5. The pop-up: written, previewed, and seen once');

await jade.goto(`http://localhost:${PORT}/#/announce`, { waitUntil: 'networkidle' });
await jade.waitForTimeout(1800);
ok('the pop-up list sits with the announcements, where admins already are',
  await jade.locator('h2:has-text("ป๊อปอัปประกาศ")').count() > 0);

await clearPopups(jade);
await jade.reload({ waitUntil: 'networkidle' });
await jade.waitForTimeout(1800);
ok('...and with none live, making one is offered',
  await jade.locator('button:has-text("สร้างป๊อปอัป")').isEnabled());

await jade.click('button:has-text("สร้างป๊อปอัป")');
await jade.waitForTimeout(800);
ok('the editor shows a preview beside the form', await jade.locator('.pop-preview-card').count() === 1);

await jade.locator('.pop-editor-form input[type="text"]').first().fill('VOICE: ประชุมใหญ่ 25 ต.ค.');
await jade.locator('.pop-editor-form textarea').first().fill('ห้อง 301 เวลา 17.00 น.');
await jade.waitForTimeout(600);
const prev = await jade.locator('.pop-preview-card').innerText();
ok('...and the preview follows what is typed, as it is typed',
  /ประชุมใหญ่ 25 ต\.ค\./.test(prev) && /ห้อง 301/.test(prev), prev.replace(/\n/g, ' | ').slice(0, 80));

/**
 * The preview is drawn at a phone's width on purpose: a notice that fits a
 * laptop and takes two screens on a phone is the mistake this is here to
 * catch, and it can only be caught at the width people read on.
 */
const prevWidth = await jade.locator('.pop-preview-card').evaluate((el) => el.getBoundingClientRect().width);
ok('...at about a phone’s width, which is where it has to work', prevWidth <= 340, Math.round(prevWidth) + 'px');

await jade.setInputFiles('#pop-img', SHOT);
await jade.waitForTimeout(1100);
ok('a poster can be attached, and lands in the preview',
  await jade.locator('.pop-preview-card img').count() === 1);

await jade.click('.modal footer button:has-text("สร้างป๊อปอัป")');
await jade.waitForTimeout(2200);
ok('it is saved and listed as showing now',
  await jade.locator('.sent-row:has-text("VOICE: ประชุมใหญ่")').count() > 0);

// Now somebody opening the app.
const fresh = await as('New_UnitCon', 'unitLead11');
await fresh.waitForTimeout(5200);
const pop = fresh.locator('.pop-veil .pop-modal');
ok('somebody opening the app is greeted by it', await pop.count() === 1);
if (await pop.count()) {
  ok('...with the poster at its real shape, so the box does not jump as it loads',
    Number(await fresh.locator('.pop-img').evaluate((el) => el.getBoundingClientRect().height)) > 40);
  ok('...and the picture actually loaded',
    await fresh.locator('.pop-img img').evaluate((el) => el.naturalWidth) === 320);

  /**
   * The one dialog in the app that a stray tap near the edge must not close,
   * because it is the only one the person did not ask for.
   */
  await fresh.locator('.pop-veil').click({ position: { x: 5, y: 5 } });
  await fresh.waitForTimeout(600);
  ok('a tap on the background does NOT dismiss it', await pop.count() === 1);

  await fresh.locator('.pop-modal footer button:has-text("รับทราบ")').click();
  await fresh.waitForTimeout(1400);
  ok('...but รับทราบ does', await pop.count() === 0);

  await fresh.reload({ waitUntil: 'networkidle' });
  await fresh.waitForTimeout(5600);
  ok('and it does not come back on the next visit',
    await fresh.locator('.pop-veil .pop-modal').count() === 0);
}

// ===========================================================================
head('6. The shelf: folders inside folders, and a way back out');

await jade.goto(`http://localhost:${PORT}/#/shelf`, { waitUntil: 'networkidle' });
await jade.waitForTimeout(1600);

await clearShelf(jade);
await jade.reload({ waitUntil: 'networkidle' });
await jade.waitForTimeout(1600);

await jade.click('button:has-text("+ สร้างโฟลเดอร์")');
await jade.waitForTimeout(700);
await jade.locator('.modal .field input[type="text"]').first().fill('VOICE: แบบฟอร์มกลาง');
await jade.click('.modal footer button:has-text("สร้างโฟลเดอร์")');
await jade.waitForTimeout(1800);
ok('a folder appears on the shelf', await jade.locator('.shelf-card:has-text("VOICE: แบบฟอร์มกลาง")').count() > 0);

await jade.locator('.shelf-card.folder:has-text("VOICE: แบบฟอร์มกลาง")').click();
await jade.waitForTimeout(900);
ok('opening it says so in the breadcrumb',
  (await jade.locator('.shelf-crumbs').innerText()).includes('VOICE: แบบฟอร์มกลาง'));
ok('...and the folder is empty, and says what to do about it',
  /ยังว่าง/.test(await jade.locator('.empty').innerText()));

await jade.click('button:has-text("+ เพิ่มลิงก์")');
await jade.waitForTimeout(700);
await jade.locator('.modal .field input[type="text"]').first().fill('VOICE: เทมเพลตหนังสือเชิญ');
await jade.locator('.modal input[type="url"]').fill('docs.google.com/document/d/voice-test');
await jade.locator('.modal textarea').first().fill('ใช้กับหนังสือเชิญหน่วยงานภายนอก');
await jade.click('.modal footer button:has-text("เพิ่มลิงก์")');
await jade.waitForTimeout(1800);

const card = jade.locator('.shelf-card:has-text("VOICE: เทมเพลตหนังสือเชิญ")');
ok('the link lands inside the folder we were in', await card.count() === 1);
ok('...as a real anchor, so a long-press or middle-click works on it',
  await card.evaluate((el) => el.tagName) === 'A');
ok('...opening in a new tab rather than replacing the app',
  await card.getAttribute('target') === '_blank'
  && (await card.getAttribute('rel') || '').includes('noopener'));
ok('...labelled by its host rather than ninety characters of address',
  (await card.locator('.shelf-host').innerText()).trim() === 'docs.google.com');
ok('...with the note under it', /หนังสือเชิญหน่วยงานภายนอก/.test(await card.innerText()));

await jade.locator('.shelf-crumbs button:has-text("ทั้งหมด")').click();
await jade.waitForTimeout(800);
ok('the breadcrumb walks back out to the top',
  await jade.locator('.shelf-card:has-text("VOICE: แบบฟอร์มกลาง")').count() > 0
  && await jade.locator('.shelf-card:has-text("VOICE: เทมเพลต")').count() === 0);
ok('...and the folder now says how much is in it',
  /1 รายการ/.test(await jade.locator('.shelf-card.folder:has-text("VOICE: แบบฟอร์มกลาง")').innerText()));

// A member reads the shelf but is not offered the buttons.
await ploy.goto(`http://localhost:${PORT}/#/shelf`, { waitUntil: 'networkidle' });
await ploy.waitForTimeout(1500);
ok('a member sees the shelf', await ploy.locator('.shelf-card').count() > 0);
ok('...and is not offered the add buttons',
  await ploy.locator('button:has-text("+ เพิ่มลิงก์")').count() === 0
  || !(await ploy.locator('button:has-text("+ เพิ่มลิงก์")').first().isVisible()));

// ===========================================================================
head('7. On a phone');

const phone = await as('Jade_Pres', 'fairAdmin1', { width: 390, height: 844 });
await phone.goto(`http://localhost:${PORT}/#/shelf`, { waitUntil: 'networkidle' });
await phone.waitForTimeout(1600);
const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok('the shelf does not scroll sideways at 390px', !wide);
ok('...and the card tools are there without a hover, which a phone has not',
  await phone.locator('.shelf-tools').first().isVisible().catch(() => false));

await phone.goto(`http://localhost:${PORT}/#/reports`, { waitUntil: 'networkidle' });
await phone.waitForTimeout(1600);
const wideRep = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok('the report list does not scroll sideways either', !wideRep);
const metoo = phone.locator('.rep-metoo').first();
if (await metoo.count()) {
  const box = await metoo.boundingBox();
  ok('...and เจอเหมือนกัน is still a thumb-sized target', box && box.width >= 44 && box.height >= 44,
    box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none');
}

// ===========================================================================
/**
 * Take the pop-up down, whatever happened above.
 *
 * A live pop-up left behind would appear over every other browser suite's
 * page and break them in a way that looks nothing like its cause — which is
 * exactly how links.mjs's leftover QR code used to break the next run.
 */
try { await clearPopups(jade); } catch (e) { errs.push('cleanup: ' + e.message); }
try { await clearShelf(jade); } catch (e) { errs.push('cleanup: ' + e.message); }

ok('no page errors anywhere in this suite', errs.length === 0, errs.slice(0, 4).join(' | '));
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
