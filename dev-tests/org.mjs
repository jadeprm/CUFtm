/**
 * The admin page's org chart and "เพิ่มสมาชิก", driven through the page.
 *
 * The server side has its own checks in run.mjs §96. What only exists here is
 * whether an admin can actually get at any of it: the section is at the
 * bottom of a long page, every change redraws the whole thing, and the point
 * of the work was that nobody should have to ask for a deployment to add a
 * หน่วย. A section that saves correctly and cannot be found is the same
 * failure as one that does not save.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';

const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const head = (s) => console.log('\n' + s);

async function as(user, pass) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(`${user}: ${m.text()}`);
  });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2800);
  await pg.goto(`http://localhost:${PORT}/#/admin`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(2500);
  return pg;
}

/**
 * Fixtures from a crashed run outlive it: a ฝ่าย and a หน่วย added here stay
 * in the overlay, and the next run then fails on a rule working correctly.
 * Cleared at both ends.
 */
const TEST_UNIT = 'ทดสอบหน่วยใหม่';
const TEST_DEPT_TH = 'ฝ่ายทดสอบ';
const TEST_USER = 'Wawa_MemDecor';

async function tidy(pg) {
  await pg.evaluate(async ([unit, user]) => {
    const send = (path, method, body) => fetch(path, {
      method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {});
    await send('/api/users?do=org', 'DELETE', { kind: 'unit', department: 'content', name: unit });
    const chart = await fetch('/api/users?do=org').then((r) => r.json()).catch(() => ({}));
    for (const d of (chart.departments || [])) {
      if (d.added) await send('/api/users?do=org', 'PATCH', { kind: 'department', key: d.key, hidden: true });
    }
    // A user can only be removed once they are out of use, as the page itself
    // insists — suspend, then delete.
    await send('/api/users?do=manage', 'PATCH', { username: user, suspended: true });
    await send(`/api/users?do=user&username=${encodeURIComponent(user)}`, 'DELETE');
  }, [unit_and_user()[0], unit_and_user()[1]]);
}
function unit_and_user() { return [TEST_UNIT, TEST_USER]; }

head('The org chart is on the admin page, and an admin can reach it');
const admin = await as('Jade_Pres', 'fairAdmin1');
await tidy(admin);
await admin.reload({ waitUntil: 'networkidle' });
await admin.waitForTimeout(2500);

ok('the section is there', await admin.locator('.org-admin').count() === 1);
const deptCards = admin.locator('.org-dept');
ok('every ฝ่าย is listed', await deptCards.count() >= 14, String(await deptCards.count()));

/** A หน่วย reads as a sub-category of its ฝ่าย, not as a free-text field. */
const contentCard = admin.locator('.org-dept', { hasText: 'ฝ่ายเนื้อหา' }).first();
ok('a ฝ่าย shows its หน่วย underneath it',
  await contentCard.locator('.chip.unit').count() >= 9,
  String(await contentCard.locator('.chip.unit').count()));
ok('...and the key is shown, since it is the part that cannot change',
  (await contentCard.locator('.org-key').first().textContent()) === 'content');

head('Adding a หน่วย, without a deployment');
admin.once('dialog', (d) => d.accept(TEST_UNIT));
await admin.locator('.org-dept', { hasText: 'ฝ่ายเนื้อหา' }).first().locator('.chip.add').click();
const newUnit = admin.locator('.org-dept', { hasText: 'ฝ่ายเนื้อหา' }).first()
  .locator('.chip.unit', { hasText: TEST_UNIT });
await newUnit.first().waitFor({ timeout: 15000 }).catch(() => {});
ok('it appears in the chart straight away', await newUnit.count() === 1);

/**
 * And in the pickers, which is the half that used to need a deployment: a
 * chart the admin page agrees with and the rest of the app does not is worse
 * than no chart at all.
 */
await admin.locator('.org-admin .page-head.sub .btn', { hasText: 'เพิ่มสมาชิก' }).click();
await admin.waitForTimeout(700);
const peek = admin.locator('.veil .modal').last();
await peek.locator('select').first().selectOption('content');
await admin.waitForTimeout(400);
const offered = await peek.locator('select').nth(1).locator('option').allTextContents();
ok('...and in the pickers the rest of the page reads from', offered.includes(TEST_UNIT),
  offered.join(', '));
await peek.locator('header .btn.ghost').click();
await admin.waitForTimeout(400);

head('Adding a ฝ่าย');
await admin.locator('.org-admin .page-head.sub .btn', { hasText: 'เพิ่มฝ่าย' }).click();
await admin.waitForTimeout(600);
const modal = admin.locator('.veil .modal').last();
await modal.locator('.field input').first().fill(TEST_DEPT_TH);
await modal.locator('.field input').nth(1).fill('Testing');
await modal.locator('.btn.primary').click();
const newDeptCard = admin.locator('.org-dept', { hasText: TEST_DEPT_TH });
await newDeptCard.first().waitFor({ timeout: 15000 }).catch(() => {});
ok('the new ฝ่าย is on the page', await newDeptCard.count() === 1);
ok('...and is marked as one added here rather than transcribed',
  await newDeptCard.locator('.chip.sm').count() === 1);

head('Adding somebody the sheet has not caught up with');
await admin.locator('.org-admin .page-head.sub .btn', { hasText: 'เพิ่มสมาชิก' }).click();
await admin.waitForTimeout(600);
const form = admin.locator('.veil .modal').last();
await form.locator('.field input').first().fill('หว่าหวา');
/** The username is suggested from the nickname, never imposed. */
await form.locator('.field input').nth(1).click();
await admin.waitForTimeout(300);
await form.locator('.field input').nth(1).fill(TEST_USER);
await form.locator('.field input').nth(3).fill('สมาชิกฝ่ายตกแต่งสถานที่');
await form.locator('select').first().selectOption('content');
await admin.waitForTimeout(400);
await form.locator('select').nth(1).selectOption('ตกแต่งสถานที่');
await form.locator('.btn.primary').click();
const herRow = admin.locator('.users-table tbody tr', { hasText: 'หว่าหวา' });
await herRow.first().waitFor({ timeout: 15000 }).catch(() => {});
ok('she is in the directory a moment later', await herRow.count() >= 1);

head('An editor is offered none of it');
const editor = await as('Kungking_HeadCon', 'brandNew22');
ok('no org chart', await editor.locator('.org-admin').count() === 0);

await tidy(admin);
ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
await b.close();
console.log(failed === 0 ? '\nORG OK' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
