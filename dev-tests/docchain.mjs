/**
 * The document form, after the three things she asked for.
 *
 * What has to hold: a ฝ่าย with two ประธาน gets a row for each; a letter from
 * อำนวยการ 2 passes through อำนวยการใหญ่; rows can be added, removed and
 * moved — the thing the old form could not do at all; choosing ส่งเอง swaps
 * เลขานุการ for you and drops the email; leaving เลขานุการ to post it without
 * an address is refused; and the เลขรันเอกสาร is shown the moment it is sent.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { quietGuide } from './quiet.mjs';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fairv2';
const { getSql } = await import('../lib/db.js');
const { sql, ready } = getSql();
await ready;

const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0;
const errs = [];
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

async function as(user, pass, opts) {
  const ctx = await b.newContext(opts);
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('dialog', async (d) => { await d.accept(); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(2300);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2800);
  return pg;
}
const field = (pg, label) =>
  pg.locator('.veil .modal .field', { hasText: label }).first().locator('input, textarea, select').first();

// Two ประธาน for ฝ่ายเนื้อหา, and อำนวยการ 2 under อำนวยการใหญ่.
await sql`UPDATE users SET is_head = true, position = 'ประธานฝ่ายเนื้อหา' WHERE username = 'Fah_StaffCon'`;
await sql`UPDATE users SET department = 'operations', is_head = true,
                           position = 'ประธานฝ่ายอำนวยการใหญ่' WHERE username = 'Totti_HeadOp'`;
// A deputy whose name sorts first, so "which one does the form suggest" has
// a wrong answer available to it.
await sql`INSERT INTO users (username, display_name, nickname, position, access, department, is_head, active)
          VALUES ('Beam_OpDeputy', 'Beam - Deputy Head Operation', 'บีมบีม',
                  'รองประธานฝ่ายอำนวยการใหญ่', 'editor', 'operations', true, true)
          ON CONFLICT (username) DO UPDATE SET position = EXCLUDED.position,
            department = EXCLUDED.department, is_head = EXCLUDED.is_head, active = true`;

const { PDFDocument } = await import('pdf-lib');
const made = await PDFDocument.create();
made.addPage([595.28, 841.89]);
writeFileSync('/tmp/claude-0/chain-letter.pdf', Buffer.from(await made.save()));

const pg = await as('Ploy_StaffCon', 'memberPw11', { viewport: { width: 1440, height: 950 } });
await pg.locator('#tabs a[data-page="docs"]').click(); await pg.waitForTimeout(1200);
await pg.locator('#main .page-head button.primary').click(); await pg.waitForTimeout(700);

// ---------------------------------------------------------------------------
console.log('\nWho sends it, on the first page of the form');
const sendField = pg.locator('.veil .modal .field', { hasText: 'ใครเป็นคนส่งเอกสาร' }).first();
ok('the form asks who sends it', (await sendField.count()) === 1);
ok('...starting with เลขานุการ, which is how it worked before',
  (await sendField.locator('.seg button.on').innerText()).includes('เลขานุการ'));
ok('...and asks for the address they will forward to',
  (await pg.locator('.veil .modal input[placeholder*="@"]').count()) === 1);
await sendField.locator('.seg button', { hasText: 'ส่งเอง' }).click(); await pg.waitForTimeout(300);
ok('choosing ส่งเอง takes the address away, because nobody is forwarding it',
  (await pg.locator('.veil .modal input[placeholder*="@"]').count()) === 0);
await sendField.locator('.seg button', { hasText: 'เลขานุการ' }).click(); await pg.waitForTimeout(300);

await field(pg, 'ผู้รับผิดชอบ').fill('พลอย ใจงาม');
await field(pg, 'ชื่อเอกสาร').fill('ลำดับ: หนังสือทดสอบ');
await pg.locator('.veil .modal #doc-pdf').setInputFiles('/tmp/claude-0/chain-letter.pdf');
await pg.waitForTimeout(900);

await pg.locator('.veil footer button.primary').click(); await pg.waitForTimeout(600);
ok('it will not go on without an address, or a tick saying it stays inside Chula',
  (await pg.locator('.veil .notice.err').innerText()).includes('อีเมล'),
  await pg.locator('.veil .notice.err').innerText());
await pg.locator('.veil .modal .field', { hasText: 'หน่วยงานภายในจุฬาฯ' })
  .locator('input[type="checkbox"]').check();
await pg.waitForTimeout(200);
ok('...and ticking it greys the address out rather than hiding the question',
  await field(pg, 'อีเมลผู้รับ').isDisabled());

await pg.locator('.veil footer button.primary').click(); await pg.waitForTimeout(2500);

// ---------------------------------------------------------------------------
console.log('\nThe chain, which can now be edited');
const rows = () => pg.locator('.veil .chain-row');
const roleAt = async (i) => {
  const row = rows().nth(i);
  const sel = row.locator('select.chain-role');
  return (await sel.count()) ? sel.locator('option:checked').innerText() : row.locator('label').first().innerText();
};
const lineUp = async () => {
  const out = [];
  for (let i = 0; i < await rows().count(); i++) out.push((await roleAt(i)).trim());
  return out.join(' → ');
};
let order = await lineUp();
ok('a ฝ่าย with two ประธาน gets a row for each of them',
  (order.match(/ประธานฝ่าย/g) || []).length === 2, order);
ok('...and the chain still ends on เลขานุการ', order.endsWith('เลขานุการ'), order);
const people = await rows().locator('select:not(.chain-role)').evaluateAll((els) =>
  els.map((e) => e.value));
ok('...named as two different people', new Set(people.filter(Boolean)).size === people.filter(Boolean).length,
  JSON.stringify(people));
await pg.screenshot({ path: '/tmp/claude-0/chain-two-heads.png' });

// Adding somebody — the thing the old form could not do.
const before = await rows().count();
await pg.locator('.veil .add-signer').click(); await pg.waitForTimeout(300);
ok('+ เพิ่มผู้ลงนาม adds a row', (await rows().count()) === before + 1);
const added = rows().nth(before - 1);
ok('...before whoever posts the letter, never after', (await roleAt(before)).includes('เลขานุการ'),
  await lineUp());
await added.locator('select.chain-role').selectOption('divisionHead'); await pg.waitForTimeout(300);
ok('...and its role can be set to ประธานฝ่ายอำนวยการใหญ่',
  (await roleAt(before - 1)).includes('อำนวยการใหญ่'), await lineUp());

/**
 * Changing a row's role changes who it offers. It used to offer the whole
 * roster, which is how ต๊อดติ came to be sitting under ประธานโครงการ.
 */
const personSel = rows().nth(before - 1).locator('select:not(.chain-role)');
const shortlist = async () => personSel.evaluate((el) => {
  const g = el.querySelector('optgroup');
  return { label: g ? g.label : null, people: g ? [...g.querySelectorAll('option')].map((o) => o.value) : [] };
});
let list = await shortlist();
ok('...and the people it offers are the ones who hold that post',
  list.people.join() === 'Totti_HeadOp,Beam_OpDeputy', JSON.stringify(list));
ok('...under the name of the post, so it is obvious why they are listed',
  (list.label || '').includes('อำนวยการใหญ่'), list.label);
ok('...with ต๊อดติ chosen, not his deputy', (await personSel.inputValue()) === 'Totti_HeadOp',
  await personSel.inputValue());

await added.locator('select.chain-role').selectOption('director'); await pg.waitForTimeout(300);
list = await shortlist();
ok('ประธานโครงการ offers only the three who hold it',
  list.people.join() === 'Jade_Pres,Gorn_VP,Kaew_VP', JSON.stringify(list.people));
ok('...and ต๊อดติ is not one of them', !list.people.includes('Totti_HeadOp'));
ok('...though anybody else is still reachable further down the list, by ฝ่าย',
  (await personSel.locator('optgroup').count()) > 1,
  String(await personSel.locator('optgroup').count()));
await added.locator('select.chain-role').selectOption('divisionHead'); await pg.waitForTimeout(300);

// Moving and removing.
await rows().nth(before - 1).locator('.chain-head button', { hasText: '↑' }).click();
await pg.waitForTimeout(300);
ok('↑ moves a row up the order', (await roleAt(before - 2)).includes('อำนวยการใหญ่'), await lineUp());
await rows().nth(before - 2).locator('.chain-head button', { hasText: '✕' }).click();
await pg.waitForTimeout(300);
ok('✕ takes it out again', (await rows().count()) === before, await lineUp());
ok('...and the row that posts it cannot be removed',
  await rows().last().locator('.chain-head button', { hasText: '✕' }).isDisabled());
ok('...nor can the writer be dropped from their own letter, where there is one',
  (await rows().first().locator('select.chain-role').count()) === 1 ||
  await rows().first().locator('.chain-head button', { hasText: '✕' }).isDisabled());

// The same person twice is caught before the PDF stage.
const first = rows().first().locator('select:not(.chain-role)');
const second = rows().nth(1).locator('select:not(.chain-role)');
const who = await first.inputValue();
await second.selectOption(who); await pg.waitForTimeout(200);
await pg.locator('.veil footer button.primary').click(); await pg.waitForTimeout(500);
ok('the same person twice in one chain is caught',
  (await pg.locator('.veil .notice.err').innerText()).includes('ซ้ำ'),
  await pg.locator('.veil .notice.err').innerText());
// Put the second ประธาน back, so the chain is two different people again.
await second.selectOption('Kungking_HeadCon'); await pg.waitForTimeout(200);

// ---------------------------------------------------------------------------
console.log('\nSigning boxes, then the number');
await pg.locator('.veil footer button.primary').click();
await pg.waitForFunction(() => {
  const c = document.querySelector('.veil .pdf-canvas');
  return c && c.width > 400 && c.height > c.width;
}, null, { timeout: 30000 });
await pg.waitForTimeout(400);
const signers = pg.locator('.veil .seg.wrap button');
const marks = await signers.count();
ok('every signer gets a box to place', marks >= 3, String(marks));
const rendered = () => pg.waitForFunction(() => {
  const c = document.querySelector('.veil .pdf-canvas');
  return c && c.width > 400;
}, null, { timeout: 30000 });
for (let i = 0; i < marks; i++) {
  // Picking a signer redraws the whole pane, canvas and all, so the page has
  // to be back before the tap that places their box means anything.
  await signers.nth(i).click();
  await rendered(); await pg.waitForTimeout(300);
  const sheet = pg.locator('.veil .pdf-sheet');
  const box = await sheet.boundingBox();
  // Clicked through the element, so Playwright scrolls an A4 page that is
  // taller than the window into view instead of clicking off the screen.
  await sheet.click({ position: { x: box.width * (0.25 + i * 0.15), y: box.height * 0.72 } });
  await pg.waitForTimeout(350);
}
ok('...and each one ends up with exactly one', (await pg.locator('.veil .sig-box').count()) === marks,
  String(await pg.locator('.veil .sig-box').count()));
await pg.locator('.veil footer button.primary').click();
await pg.waitForSelector('.veil .doc-done', { timeout: 20000 });
const done = await pg.locator('.veil .doc-done').innerText();
ok('submitting ends on a panel of its own, not silence', done.includes('ส่งเรื่องเรียบร้อย'), done.slice(0, 60));
ok('...which either gives the number or says the register could not be reached',
  /เลขที่หนังสือของคุณ|ออกเลขที่หนังสือไม่ได้/.test(done), done.replace(/\s+/g, ' ').slice(0, 120));
ok('...and says what happens next', /ขั้นต่อไป/.test(done));
await pg.screenshot({ path: '/tmp/claude-0/chain-submitted.png' });

await pg.locator('.veil footer button.primary').click(); await pg.waitForTimeout(2000);
const whoRow = pg.locator('#modal-root .vrow', { hasText: 'ใครเป็นคนส่งเอกสาร' });
ok('the letter itself says who posts it', (await whoRow.count()) === 1);
ok('...and that it stays inside Chula', (await whoRow.innerText()).includes('หน่วยงานภายในจุฬาฯ'),
  (await whoRow.innerText()).replace(/\s+/g, ' '));

// ---------------------------------------------------------------------------
console.log('\nA letter from อำนวยการ 2');
await sql`UPDATE users SET department = 'oper2', unit = 'สถานที่', is_head = true,
                           position = 'ประธานฝ่ายอำนวยการ 2' WHERE username = 'Ikkew_HeadOper1'`;
await sql`DELETE FROM user_departments WHERE username = 'Ikkew_HeadOper1'`;
await sql`INSERT INTO user_departments (username, department) VALUES ('Ikkew_HeadOper1', 'oper2')
          ON CONFLICT DO NOTHING`;
const north = await as('Ikkew_HeadOper1', 'editorPw2', { viewport: { width: 1440, height: 950 } });
await north.locator('#tabs a[data-page="docs"]').click(); await north.waitForTimeout(1200);
await north.locator('#main .page-head button.primary').click(); await north.waitForTimeout(700);
await north.locator('.veil .modal .field', { hasText: 'ใครเป็นคนส่งเอกสาร' }).first()
  .locator('.seg button', { hasText: 'ส่งเอง' }).click();
await field(north, 'ผู้รับผิดชอบ').fill('นอร์ท ใจกว้าง');
await field(north, 'ชื่อเอกสาร').fill('ลำดับ: จากอำนวยการ 2');
await north.locator('.veil .modal #doc-pdf').setInputFiles('/tmp/claude-0/chain-letter.pdf');
await north.waitForTimeout(900);
await north.locator('.veil footer button.primary').click(); await north.waitForTimeout(2500);
const northRows = north.locator('.veil .chain-row');
// The chosen role of each row, not every role the dropdown offers.
const flat = (await northRows.evaluateAll((els) => els.map((el) => {
  const sel = el.querySelector('select.chain-role');
  return (sel ? sel.options[sel.selectedIndex].textContent : el.querySelector('label').textContent).trim();
}))).join(' → ');
ok('it goes ผู้จัดทำ → อำนวยการใหญ่ → ประธานโครงการ → ผู้ส่ง, which is what she asked for',
  flat === 'ผู้จัดทำ → ประธานฝ่ายอำนวยการใหญ่ → ประธานโครงการ → ผู้ส่งเอกสาร', flat);
ok('...and the last row says she posts it herself',
  (await northRows.last().innerText()).includes('คุณจะเป็นผู้ส่งเอกสารนี้เอง'));
await north.screenshot({ path: '/tmp/claude-0/chain-oper2.png' });

// ---------------------------------------------------------------------------
console.log('\nA letter from ประธานโครงการ herself');
/**
 * Her own letters have nobody above them to approve, so the chain is just her
 * signature and whoever posts it — and with the old form that meant there was
 * no way to put anybody else on one at all.
 */
const boss = await as('Jade_Pres', 'fairAdmin1', { viewport: { width: 1440, height: 950 } });
await boss.locator('#tabs a[data-page="docs"]').click(); await boss.waitForTimeout(1200);
await boss.locator('#main .page-head button.primary').click(); await boss.waitForTimeout(700);
await boss.locator('.veil .modal .field', { hasText: 'ใครเป็นคนส่งเอกสาร' }).first()
  .locator('.seg button', { hasText: 'เลขานุการ' }).click();
await boss.locator('.veil .modal input[placeholder*="@"]').fill('registrar@chula.ac.th');
await field(boss, 'ผู้รับผิดชอบ').fill('เจด ใจดี');
await field(boss, 'ชื่อเอกสาร').fill('ลำดับ: จากประธานโครงการ');
await boss.locator('.veil .modal #doc-pdf').setInputFiles('/tmp/claude-0/chain-letter.pdf');
await boss.waitForTimeout(900);
await boss.locator('.veil footer button.primary').click(); await boss.waitForTimeout(2500);

const bossRows = boss.locator('.veil .chain-row');
const bossRoles = async () => (await bossRows.evaluateAll((els) => els.map((el) => {
  const sel = el.querySelector('select.chain-role');
  return (sel ? sel.options[sel.selectedIndex].textContent : el.querySelector('label').textContent).trim();
}))).join(' → ');
ok('her own letter starts as just her signature and เลขานุการ',
  (await bossRoles()) === 'ผู้จัดทำ → เลขานุการ', await bossRoles());
ok('...and there is still a way to put somebody on it', (await boss.locator('.veil .add-signer').count()) === 1);
await boss.locator('.veil .add-signer').click(); await boss.waitForTimeout(300);
ok('+ เพิ่มผู้ลงนาม adds a row to her letter too',
  (await bossRoles()) === 'ผู้จัดทำ → ประธานฝ่าย → เลขานุการ', await bossRoles());
const added2 = bossRows.nth(1).locator('select:not(.chain-role)');
const everyone = await added2.locator('option').count();
ok('...offering the whole committee, not a shortlist of two', everyone > 10, String(everyone));
await added2.selectOption('Kungking_HeadCon'); await boss.waitForTimeout(200);
await boss.screenshot({ path: '/tmp/claude-0/chain-director.png' });
await boss.locator('.veil footer button.primary').click();
await boss.waitForFunction(() => {
  const c = document.querySelector('.veil .pdf-canvas');
  return c && c.width > 400;
}, null, { timeout: 30000 });
const bossSigners = boss.locator('.veil .seg.wrap button');
const bossMarks = await bossSigners.count();
ok('...and the person she added gets a signature box of their own', bossMarks === 2, String(bossMarks));
for (let i = 0; i < bossMarks; i++) {
  await bossSigners.nth(i).click();
  await boss.waitForFunction(() => {
    const c = document.querySelector('.veil .pdf-canvas');
    return c && c.width > 400;
  }, null, { timeout: 30000 });
  await boss.waitForTimeout(300);
  const sheet = boss.locator('.veil .pdf-sheet');
  const box = await sheet.boundingBox();
  await sheet.click({ position: { x: box.width * (0.3 + i * 0.2), y: box.height * 0.7 } });
  await boss.waitForTimeout(350);
}
await boss.locator('.veil footer button.primary').click();
await boss.waitForSelector('.veil .doc-done', { timeout: 20000 });
ok('...and the letter goes through with both of them on it', true);
await boss.locator('.veil footer button.primary').click(); await boss.waitForTimeout(2000);
const bossChain = await boss.locator('#modal-root .doc-steps').innerText();
ok('the saved letter has her, the head she added, and เลขานุการ, in that order',
  /ผู้จัดทำ[\s\S]*ประธานฝ่าย[\s\S]*เลขานุการ/.test(bossChain), bossChain.replace(/\s+/g, ' ').slice(0, 140));

// Tidy up the roster changes.
await sql`UPDATE users SET is_head = false, position = 'ฝ่ายเนื้อหา' WHERE username = 'Fah_StaffCon'`;
await sql`DELETE FROM users WHERE username = 'Beam_OpDeputy'`;
await pg.evaluate(async () => {
  const d = await fetch('/api/documents').then((r) => r.json());
  for (const doc of d.documents || []) {
    if (/^ลำดับ:/.test(doc.title)) await fetch('/api/documents?id=' + doc.id, { method: 'DELETE' });
  }
});

console.log(errs.length ? '\nerrors:\n' + errs.join('\n') : '\nno page errors');
if (errs.length) failed += errs.length;
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
