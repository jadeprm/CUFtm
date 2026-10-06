/**
 * The two things Jade asked for on the meeting tab, looked at rather than
 * assumed: a colour of its own, and somewhere to put a description and papers.
 *
 * The colour is checked as a computed pixel value against the task and event
 * colours, because "I changed the CSS variable" and "it looks different on
 * screen" are not the same claim — a rule can be overridden further down the
 * stylesheet and nothing says so.
 */
import { chromium } from 'playwright';

const PORT = process.argv[2] || '4700';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.4 });
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
pg.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text());
});
pg.on('dialog', async (d) => { await d.accept(); });

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await pg.fill('#in-username', 'Jade_Pres'); await pg.click('#auth-submit');
await pg.waitForTimeout(2300);
await pg.fill('#in-password', 'fairAdmin1');
if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', 'fairAdmin1');
await pg.click('#auth-submit'); await pg.waitForTimeout(2600);

// ---------------------------------------------------------------------------
console.log('\nA meeting has a colour of its own');

const swatches = await pg.evaluate(() => {
  const read = (name) => getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim();
  return { task: read('--accent'), event: read('--doing'), meeting: read('--meet') };
});
ok('the three kinds have three different colours',
  swatches.meeting && swatches.meeting !== swatches.task && swatches.meeting !== swatches.event,
  `task ${swatches.task} · event ${swatches.event} · meeting ${swatches.meeting}`);

/**
 * Three dots live in the calendar key. Reading the pixels they actually render
 * is the only way to know the new variable reaches them — the old rules named
 * --accent and would still have looked fine in the stylesheet.
 */
await pg.locator('#tabs a[href="#/calendar"]').first().click();
await pg.waitForTimeout(2200);
const dots = await pg.evaluate(() => {
  const grab = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : null;
  };
  return {
    task: grab('.cal-legend .dot.task'),
    event: grab('.cal-legend .dot.event'),
    meeting: grab('.cal-legend .dot.meeting'),
  };
});
ok('...and the calendar key draws the meeting dot in none of the others',
  dots.meeting && dots.meeting !== dots.task && dots.meeting !== dots.event,
  `task ${dots.task} · event ${dots.event} · meeting ${dots.meeting}`);

/**
 * The key is not the calendar. What matters is a real chip on the grid, so one
 * of each is put on the same quiet day and compared — including an event in
 * BLUE, which is the nearest thing to the new indigo that anybody can choose
 * from the event palette. Hue alone would not be enough against it, so a
 * meeting also carries a thicker edge and a faint ring, and those are what keep
 * the two apart on a printed month view or for somebody who cannot separate the
 * hues at all.
 */
const QUIET_DAY = '2026-10-21';
await pg.evaluate(async (day) => {
  const d = await fetch('/api/events?do=meetings').then((x) => x.json());
  for (const m of (d.meetings || [])) {
    if (m.title === 'เทียบสีปฏิทิน') {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(m.id), { method: 'DELETE' });
    }
  }
  const e = await fetch('/api/events').then((x) => x.json());
  for (const ev of (e.events || [])) {
    if (ev.title === 'เทียบสีปฏิทิน-กิจกรรม') {
      await fetch('/api/events?id=' + encodeURIComponent(ev.id), { method: 'DELETE' });
    }
  }
  await fetch('/api/events?do=meeting', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'เทียบสีปฏิทิน', meetsOn: day, meetsAt: '11:00', template: 'blank' }),
  });
  await fetch('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'เทียบสีปฏิทิน-กิจกรรม', startsOn: day, startsAt: '12:00', colour: 'blue' }),
  });
}, QUIET_DAY);
await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(2800);

const chips = await pg.evaluate(() => {
  const one = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { border: s.borderLeftColor, width: s.borderLeftWidth, ring: s.boxShadow };
  };
  return { meeting: one('.cal-chip.meeting'), event: one('.cal-chip.event') };
});
ok('a meeting chip really is drawn on the grid in the meeting colour',
  chips.meeting && chips.meeting.border === dots.meeting,
  chips.meeting && chips.meeting.border);
ok('...told apart from even a blue event by more than hue alone',
  chips.meeting && chips.event &&
  chips.meeting.border !== chips.event.border &&
  chips.meeting.width !== chips.event.width &&
  chips.meeting.ring !== 'none' && chips.event.ring === 'none',
  chips.meeting && chips.event
    ? `meeting ${chips.meeting.border} ${chips.meeting.width} ring · event ${chips.event.border} ${chips.event.width}`
    : 'one of the chips was missing');

await pg.evaluate(async () => {
  const d = await fetch('/api/events?do=meetings').then((x) => x.json());
  for (const m of (d.meetings || [])) {
    if (m.title === 'เทียบสีปฏิทิน') {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(m.id), { method: 'DELETE' });
    }
  }
  const e = await fetch('/api/events').then((x) => x.json());
  for (const ev of (e.events || [])) {
    if (ev.title === 'เทียบสีปฏิทิน-กิจกรรม') {
      await fetch('/api/events?id=' + encodeURIComponent(ev.id), { method: 'DELETE' });
    }
  }
});

// ---------------------------------------------------------------------------
console.log('\nA description, and somewhere to put the papers');

/**
 * Made through the API and dated tomorrow, so it is at the front of the rail
 * the work page shows rather than somewhere past the sixth card.
 */
const made = await pg.evaluate(async () => {
  const existing = await fetch('/api/events?do=meetings').then((x) => x.json());
  for (const old of (existing.meetings || [])) {
    if (old.title === 'ประชุมทดสอบเอกสารประกอบ') {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(old.id), { method: 'DELETE' });
    }
  }
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const r = await fetch('/api/events?do=meeting', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'ประชุมทดสอบเอกสารประกอบ', meetsOn: tomorrow, meetsAt: '09:30',
      note: 'กรุณาอ่านตัวเลขของเดือนที่แล้วมาก่อนเข้าประชุม\nและเตรียมคำถามมาด้วย',
      template: 'standard',
    }),
  });
  return r.json();
});
ok('a meeting can be created with a description', Boolean(made.id), JSON.stringify(made).slice(0, 60));

await pg.locator('#tabs a[href="#/work"]').first().click(); await pg.waitForTimeout(1200);
await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(2600);

/** The meeting card itself must be drawn in the meeting colour, not the task one. */
const card = pg.locator('.event-card.meeting', { hasText: 'ทดสอบเอกสารประกอบ' }).first();
const cardBorder = await card.evaluate((el) => getComputedStyle(el).borderLeftColor);
ok('a meeting card on the work page carries the meeting colour',
  cardBorder === dots.meeting, `${cardBorder} vs dot ${dots.meeting}`);

await card.click();
await pg.waitForTimeout(1500);

/**
 * The description used to be shown under the TITLE's label, which is the one
 * place it cannot go, because the title is already the heading of the dialog.
 */
const rows = await pg.locator('.veil .mtg-summary .sum-row').allInnerTexts();
const noteRow = rows.find((x) => /อ่านตัวเลขของเดือนที่แล้ว/.test(x)) || '';
ok('the description is shown on the meeting',
  Boolean(noteRow), noteRow.replace(/\n/g, ' | ').slice(0, 70));
ok('...under its own label, not the title’s',
  /รายละเอียดเพิ่มเติม/.test(noteRow) && !/หัวข้อ/.test(noteRow),
  noteRow.split('\n')[0]);
ok('...and keeps the line breaks somebody typed',
  await pg.locator('.veil .mtg-summary .sum-value')
    .filter({ hasText: 'เตรียมคำถาม' }).first()
    .evaluate((el) => getComputedStyle(el).whiteSpace === 'pre-wrap')
    .catch(() => false));

// ---- the papers section ----
ok('the meeting has a papers section', (await pg.locator('.veil .mtg-files').count()) === 1);
ok('...which says plainly that there are none yet',
  (await pg.locator('.veil .mtg-file-none').count()) === 1,
  (await pg.locator('.veil .mtg-file-none').first().innerText().catch(() => '')));
ok('...and offers both a file and a link',
  (await pg.locator('.veil .mtg-file-add button', { hasText: /แนบไฟล์/ }).count()) === 1 &&
  (await pg.locator('.veil .mtg-file-add button', { hasText: /เพิ่มลิงก์/ }).count()) === 1);

// Pasting a link, through the page rather than the API.
await pg.fill('.veil .mtg-file-add input[type=url]', 'https://drive.google.com/file/d/xyz/view');
await pg.locator('.veil .mtg-file-add button', { hasText: /เพิ่มลิงก์/ }).first().click();
await pg.waitForTimeout(2200);
ok('a pasted link appears in the list straight away',
  (await pg.locator('.veil .mtg-file').count()) === 1,
  (await pg.locator('.veil .mtg-file').first().innerText().catch(() => '')).replace(/\n/g, ' · '));
ok('...marked as a link rather than a file',
  /ลิงก์/.test(await pg.locator('.veil .mtg-file .f-kind').first().innerText()),
  await pg.locator('.veil .mtg-file .f-kind').first().innerText());
ok('...opening in a new tab, since it is somewhere else',
  (await pg.locator('.veil .mtg-file a.f-name').first().getAttribute('target')) === '_blank');
ok('...and the box is cleared so the next one is not pasted on top of it',
  (await pg.locator('.veil .mtg-file-add input[type=url]').inputValue()) === '');

// Attaching a real file, through the file input.
await pg.locator('.veil .mtg-file-add input[type=file]').setInputFiles({
  name: 'งบประมาณเดือนตุลาคม.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(900, 0x20), Buffer.from('\n%%EOF\n')]),
});
await pg.waitForTimeout(3000);
const names = await pg.locator('.veil .mtg-file .f-name').allInnerTexts();
ok('a file picked off the laptop is attached too',
  names.some((n) => /งบประมาณเดือนตุลาคม/.test(n)), names.join(' · '));
ok('...and its size is shown, so nobody downloads 3 MB on data by accident',
  (await pg.locator('.veil .mtg-file .f-meta').allInnerTexts()).some((x) => /KB|MB/.test(x)),
  (await pg.locator('.veil .mtg-file .f-meta').allInnerTexts()).join(' · '));
ok('...and the button goes back to its own label rather than staying "uploading"',
  /แนบไฟล์/.test(await pg.locator('.veil .mtg-file-add button').first().innerText()),
  await pg.locator('.veil .mtg-file-add button').first().innerText());

// Removing one.
const before = await pg.locator('.veil .mtg-file').count();
await pg.locator('.veil .mtg-file button', { hasText: /เอาออก/ }).first().click();
await pg.waitForTimeout(2400);
ok('a paper can be taken off again',
  (await pg.locator('.veil .mtg-file').count()) === before - 1,
  `${before} → ${await pg.locator('.veil .mtg-file').count()}`);

// ---- the editor's own form ----
await pg.locator('.veil footer button', { hasText: /แก้ไขรายละเอียด/ }).first().click();
await pg.waitForTimeout(900);
ok('the form has a description box, which it never had before',
  (await pg.locator('.veil textarea').count()) >= 2 &&
  (await pg.locator('.veil .field', { hasText: /รายละเอียดเพิ่มเติม/ }).locator('textarea').count()) === 1);
ok('...carrying what is already there rather than starting empty',
  /อ่านตัวเลขของเดือนที่แล้ว/.test(
    await pg.locator('.veil .field', { hasText: /รายละเอียดเพิ่มเติม/ })
      .locator('textarea').first().inputValue()));

/**
 * The save button has to be reachable. The form is long, and this dialog is the
 * one where the buttons previously sat below the fold with nothing on screen to
 * suggest they were there.
 */
const saveBox = await pg.locator('.veil footer button.primary').first().boundingBox();
ok('...and the save button is on screen, not below the fold',
  saveBox && saveBox.y + saveBox.height <= 1000, JSON.stringify(saveBox));

// Changing the description through the form and seeing it stick.
await pg.locator('.veil .field', { hasText: /รายละเอียดเพิ่มเติม/ })
  .locator('textarea').first().fill('เปลี่ยนรายละเอียดแล้ว');
await pg.locator('.veil footer button.primary').first().click();
await pg.waitForTimeout(2800);

const kept = await pg.evaluate(async () => {
  const d = await fetch('/api/events?do=meetings').then((x) => x.json());
  const m = (d.meetings || []).find((x) => x.title === 'ประชุมทดสอบเอกสารประกอบ');
  return m ? { note: m.note, files: (m.files || []).length } : null;
});
ok('a description edited through the form is saved',
  kept && kept.note === 'เปลี่ยนรายละเอียดแล้ว', kept && kept.note);
ok('...and saving the details does not take the papers with it',
  kept && kept.files === 1, kept && String(kept.files));

// Tidy up after itself, so the rail does not fill with test meetings.
await pg.evaluate(async () => {
  const d = await fetch('/api/events?do=meetings').then((x) => x.json());
  for (const m of (d.meetings || [])) {
    if (m.title === 'ประชุมทดสอบเอกสารประกอบ') {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(m.id), { method: 'DELETE' });
    }
  }
});

console.log(errs.length ? '\nconsole errors:\n' + errs.join('\n') : '\nno console errors');
if (errs.length) failed += errs.length;
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
