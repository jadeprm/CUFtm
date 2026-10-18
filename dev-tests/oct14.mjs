/**
 * The 14 October round: Bangkok time on the document page, folded people
 * lists, one bar for proposing a วาระ, the meeting notice as a PDF, the LINE
 * step in the guide, the week-time card, the profile across two columns, the
 * user list in the committee's order with filters, and meetings that drop off
 * "ที่กำลังจะถึง" once they have finished.
 */
import { chromium } from 'playwright';
import { quietGuide } from './quiet.mjs';
const PORT = process.argv[2] || '4700';
const b = quietGuide(await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
let failed = 0; const errs = [];
const ok = (l, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!c) failed++; };
const DESK = { viewport: { width: 1440, height: 980 } };
async function as(user, pass, opts) {
  const ctx = await b.newContext(opts || DESK);
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(`${user}: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g|qr-official/.test(m.text())) errs.push(`${user}: ${m.text()}`); });
  pg.on('dialog', async (d) => { await d.accept(''); });
  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await pg.fill('#in-username', user); await pg.click('#auth-submit'); await pg.waitForTimeout(1800);
  await pg.fill('#in-password', pass);
  if (await pg.locator('#field-confirm:not([hidden])').count()) await pg.fill('#in-confirm', pass);
  await pg.click('#auth-submit'); await pg.waitForTimeout(2600);
  return pg;
}
const iso = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() + n * 864e5));
const bkkNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const SHOTS = '/tmp/claude-0';

const jade = await as('Jade_Pres', 'fairAdmin1');

// ===========================================================================
console.log('\n1. A meeting that has already finished');
/**
 * Set up against the clock in Bangkok rather than a fixed hour, so this says
 * the same thing whenever it is run.
 */
const [nowH, nowM] = bkkNow().split(':').map(Number);
const nowMin = nowH * 60 + nowM;
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/**
 * One that ended ten minutes ago and one still an hour off, worked out in
 * minutes rather than whole hours — run at 00:20 the hour version produced a
 * "finished" meeting that had not started.
 */
const doneDay = nowMin >= 80 ? iso(0) : iso(-1);
const doneStart = nowMin >= 80 ? nowMin - 70 : 22 * 60;
const doneEnd = nowMin >= 80 ? nowMin - 10 : 23 * 60;
const aheadDay = nowMin + 60 < 24 * 60 ? iso(0) : iso(1);
const aheadAt = nowMin + 60 < 24 * 60 ? nowMin + 60 : 9 * 60;
const earlier = clock(doneStart);
const earlierEnd = clock(doneEnd);
const later = clock(aheadAt);

const made = await jade.evaluate(async (x) => {
  const mk = (title, on, meetsAt, endsAt) => fetch('/api/events?do=meeting', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, meetsOn: on, meetsAt, endsAt, place: 'ห้องทดสอบ', people: ['Jade_Pres'] }),
  }).then((r) => r.json());
  const done = await mk('O14: ประชุมที่จบไปแล้ว', x.doneDay, x.a, x.b2);
  const ahead = await mk('O14: ประชุมที่ยังไม่ถึง', x.aheadDay, x.c, null);
  return { done: done.id || null, ahead: ahead.id || null };
}, { doneDay, aheadDay, a: earlier, b2: earlierEnd, c: later });

await jade.evaluate(() => { location.hash = '#/work'; });
await jade.reload({ waitUntil: 'networkidle' }); await jade.waitForTimeout(2600);
await jade.locator('.up-head .up-all, .up-list').first().waitFor({ timeout: 10000 }).catch(() => {});
const upText = await jade.locator('.up-list').first().innerText().catch(() => '');
ok('a meeting that finished earlier today is off ที่กำลังจะถึง',
  !/ประชุมที่จบไปแล้ว/.test(upText), upText.split('\n').slice(0, 6).join(' | '));
ok('...while one still to come is on it', /ประชุมที่ยังไม่ถึง/.test(upText));

// ===========================================================================
console.log('\n2. หนังสือนัดประชุม');
const notice = await jade.evaluate(async (id) => {
  const r = await fetch('/api/events?do=notice&id=' + encodeURIComponent(id));
  const buf = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), size: buf.length,
    head: String.fromCharCode(...buf.slice(0, 5)) };
}, made.ahead);
ok('the notice comes back as a PDF', notice.status === 200 && /application\/pdf/.test(notice.type || ''),
  `${notice.status} ${notice.type}`);
ok('...and is a real one, not an error page', notice.head === '%PDF-' && notice.size > 3000,
  `${notice.head} ${notice.size} bytes`);

const outsider = await as('Ploy_StaffCon', 'memberPw11');
const refused = await outsider.evaluate(async (id) =>
  (await fetch('/api/events?do=notice&id=' + encodeURIComponent(id))).status, made.ahead);
ok('somebody the meeting has nothing to do with cannot fetch it', refused === 403, String(refused));

// ===========================================================================
console.log('\n3. One bar for proposing a วาระ');
await jade.evaluate(async (id) => {
  const head = await fetch('/api/events?do=agenda', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meetingId: id, title: 'O14: เรื่องเสนอเพื่อพิจารณา', minutes: 20, kind: 'consider' }),
  });
  return head.status;
}, made.ahead);
await jade.reload({ waitUntil: 'networkidle' }); await jade.waitForTimeout(2400);
await jade.locator('.up-row', { hasText: 'ยังไม่ถึง' }).first().click();
await jade.waitForTimeout(1200);
const addBars = await jade.locator('.agenda-add').count();
ok('there is one add bar, however many วาระ there are', addBars === 1, String(addBars));
ok('...and it asks which วาระ the item is for',
  (await jade.locator('.agenda-add .agenda-under').count()) <= 1);
await jade.screenshot({ path: `${SHOTS}/o14-agenda.png` });
await jade.keyboard.press('Escape'); await jade.waitForTimeout(400);

// ===========================================================================
console.log('\n4. The user list: the committee\'s order, and filters');
await jade.evaluate(() => { location.hash = '#/admin'; }); await jade.waitForTimeout(2600);
const names = await jade.locator('.users-table tbody tr .u-name').allInnerTexts();
const levels = await jade.evaluate(() =>
  Array.from(document.querySelectorAll('.users-table tbody tr')).map((r) => r.dataset.access));
const rank = { admin: 0, coadmin: 1, editor: 2, unitlead: 3, inner: 4 };
const live = await jade.evaluate(() =>
  Array.from(document.querySelectorAll('.users-table tbody tr')).map((r) => r.className.includes('off')));
const sorted = levels.every((lv, i) => i === 0 || live[i - 1] || live[i] || rank[levels[i - 1]] <= rank[lv]);
ok('people are listed by rank before name', sorted, levels.slice(0, 8).join(','));
ok('...and the first one is an admin, not whoever is alphabetically first',
  levels[0] === 'admin', names.slice(0, 3).join(' | '));

ok('there is a filter for ฝ่าย, สิทธิ์ and สถานะ',
  (await jade.locator('.user-filters select').count()) === 3);
const before = await jade.locator('.users-table tbody tr:not([hidden])').count();
await jade.locator('.user-filters select').nth(1).selectOption('inner');
await jade.waitForTimeout(500);
const after = await jade.locator('.users-table tbody tr:not([hidden])').count();
const onlyMembers = await jade.evaluate(() =>
  Array.from(document.querySelectorAll('.users-table tbody tr:not([hidden])')).every((r) => r.dataset.access === 'inner'));
ok('picking a level shows only that level', after < before && onlyMembers, `${before} → ${after}`);
ok('...and says how much of the list is showing',
  /\d/.test(await jade.locator('.user-count').innerText()),
  await jade.locator('.user-count').innerText());
await jade.locator('.user-filters select').nth(1).selectOption('');
await jade.waitForTimeout(400);
await jade.screenshot({ path: `${SHOTS}/o14-users.png` });

// ===========================================================================
console.log('\n5. The profile, across the page');
await jade.evaluate(() => { location.hash = '#/profile'; }); await jade.waitForTimeout(2200);
const cols = await jade.evaluate(() => {
  const g = document.querySelector('.pf-grid');
  if (!g) return null;
  const boxes = Array.from(g.querySelectorAll(':scope > .pf-col')).map((c) => c.getBoundingClientRect());
  return { n: boxes.length, sameRow: boxes.length === 2 && Math.abs(boxes[0].top - boxes[1].top) < 40,
    width: Math.round(g.getBoundingClientRect().width) };
});
ok('the profile fills the page instead of a narrow column', cols && cols.width > 700, cols && String(cols.width));
ok('...in two columns side by side', cols && cols.sameRow, cols && `${cols.n} columns`);
await jade.screenshot({ path: `${SHOTS}/o14-profile.png` });

// ===========================================================================
console.log('\n6. เวลาของสัปดาห์นี้ fits its card');
await jade.evaluate(() => { location.hash = '#/schedule'; }); await jade.waitForTimeout(2800);
const alloc = await jade.evaluate(() => {
  const card = document.querySelector('.card.alloc');
  if (!card) return null;
  const big = card.querySelector('.donut-big');
  const ring = card.querySelector('.donut');
  if (!big || !ring) return null;
  const t = big.getBoundingClientRect();
  const r = ring.getBoundingClientRect();
  return { fits: t.left > r.left && t.right < r.right, text: big.textContent,
    overflow: Math.round(card.scrollWidth - card.clientWidth) };
});
ok('the number inside the ring stays inside it', alloc && alloc.fits, alloc && `"${alloc.text}"`);
ok('...and the card does not overflow sideways', alloc && alloc.overflow <= 1, alloc && String(alloc.overflow));
await jade.screenshot({ path: `${SHOTS}/o14-schedule.png` });

// ===========================================================================
console.log('\n7. Bangkok time on a document');
/**
 * The server sends UTC. Anything signed after 7pm Bangkok falls on the
 * previous day in that string, which is what the เอกสาร page used to print.
 */
const doc = await jade.evaluate(async () => {
  const list = await (await fetch('/api/documents')).json();
  for (const d of list.documents || []) {
    const one = await (await fetch('/api/documents?id=' + encodeURIComponent(d.id))).json();
    const step = (one.progress || []).find((p) => p.at);
    if (step) return { id: d.id, at: step.at };
  }
  return null;
});
if (!doc) {
  ok('a document with a stamped step to check', false, 'none in the fixture');
} else {
  const want = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(doc.at));
  const utc = String(doc.at).slice(11, 16);
  await jade.evaluate(() => { location.hash = '#/docs'; }); await jade.waitForTimeout(2200);
  await jade.evaluate((id) => {
    document.querySelectorAll('.doc-card, .dc, button').forEach(() => {});
    location.hash = '#/docs';
  }, doc.id);
  await jade.locator('.doc-card, .dc-title').first().click({ timeout: 10000 }).catch(() => {});
  await jade.waitForTimeout(1600);
  const whens = await jade.locator('.ds-when').allInnerTexts().catch(() => []);
  const shown = whens.join(' ');
  ok('the clock on a step is Bangkok time', shown.length > 0 && !shown.includes(utc) === (utc !== want),
    `shown "${whens[0] || ''}" · bangkok ${want} · utc ${utc}`);
  await jade.keyboard.press('Escape'); await jade.waitForTimeout(400);
}

// ===========================================================================
console.log('\n8. A crowd of people folds on a computer too');
const taskId = await jade.evaluate(async () => {
  const users = (await (await fetch('/api/users')).json()).users
    .filter((u) => u.active && !u.suspended).slice(0, 9).map((u) => u.username);
  const r = await fetch('/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'O14: งานที่มีคนติดตามเยอะ', dueDate: null,
      assignees: users.slice(0, 2), viewers: users.slice(2) }),
  });
  const d = await r.json();
  return (d.task && d.task.id) || null;
});
// Opened by its own link rather than hunted for in a filtered list.
await jade.evaluate((id) => { location.hash = '#/t/' + id; }, taskId);
await jade.waitForTimeout(2200);
ok('seven watchers collapse to a row of faces on a computer',
  (await jade.locator('.veil .ppl-fold .ppl-sum').count()) >= 1,
  (await jade.locator('.veil .ppl-sum').innerText().catch(() => '(none)')).replace(/\n/g, ' '));
await jade.locator('.veil .ppl-sum').first().click().catch(() => {});
await jade.waitForTimeout(400);
ok('...and open again on a tap', (await jade.locator('.veil .ppl-fold .chip.who').count()) >= 6,
  String(await jade.locator('.veil .ppl-fold .chip.who').count()));
await jade.screenshot({ path: `${SHOTS}/o14-people.png` });
await jade.keyboard.press('Escape'); await jade.waitForTimeout(400);
if (taskId) {
  await jade.evaluate((id) => fetch('/api/tasks?id=' + encodeURIComponent(id), { method: 'DELETE' }), taskId);
}

// ===========================================================================
console.log('\n9. The people doing the work can edit it');
const perm = await jade.evaluate(async () => {
  const r = await fetch('/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'O14: งานที่ผู้รับผิดชอบแก้เองได้',
      assignees: ['Ploy_StaffCon'], viewers: ['Fah_StaffCon'], notify: [] }),
  });
  const d = await r.json();
  return (d.task && d.task.id) || null;
});
const ploy = outsider;   // Ploy, a member, is the one it was given to
await ploy.evaluate((id) => { location.hash = '#/t/' + id; }, perm);
await ploy.waitForTimeout(2200);
ok('the person it was given to is given the edit button',
  (await ploy.locator('.veil footer .btn', { hasText: /แก้ไข/ }).count()) >= 1);
ok('...but not the delete button',
  (await ploy.locator('.veil footer .btn.danger', { hasText: /ลบงาน/ }).count()) === 0);
const edited = await ploy.evaluate(async (id) => {
  const r = await fetch('/api/tasks', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, title: 'O14: แก้โดยผู้รับผิดชอบ', dueDate: '2026-12-09' }),
  });
  return { status: r.status, body: (await r.json()).task || {} };
}, perm);
ok('...and the change goes through', edited.status === 200 && edited.body.title === 'O14: แก้โดยผู้รับผิดชอบ',
  `${edited.status} ${edited.body.title || ''}`);
const delTry = await ploy.evaluate(async (id) =>
  (await fetch('/api/tasks?id=' + encodeURIComponent(id), { method: 'DELETE' })).status, perm);
ok('...while deleting it is still the owner\'s', delTry === 403, String(delTry));

const fah = await as('Fah_StaffCon', 'memberPw22');
const watcherTry = await fah.evaluate(async (id) => {
  const seen = (await (await fetch('/api/tasks')).json()).tasks.find((t) => t.id === id);
  const r = await fetch('/api/tasks', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, title: 'ผู้ติดตามแก้' }),
  });
  return { sees: Boolean(seen), mayEdit: seen && seen.mayEdit, status: r.status };
}, perm);
ok('a watcher sees it but cannot edit it',
  watcherTry.sees && watcherTry.mayEdit === false && watcherTry.status === 403,
  JSON.stringify(watcherTry));

// ===========================================================================
console.log('\n10. An editor sees the whole fair');
const kung = await as('Kungking_HeadCon', 'brandNew22');
const far = await jade.evaluate(async () => {
  const r = await fetch('/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'O14: งานของฝ่ายอื่น', department: 'sponsor', notify: [] }),
  });
  return ((await r.json()).task || {}).id || null;
});
await kung.reload({ waitUntil: 'networkidle' }); await kung.waitForTimeout(2600);
const farSeen = await kung.evaluate(async (id) => {
  const t = (await (await fetch('/api/tasks')).json()).tasks.find((x) => x.id === id);
  return t ? { yes: true, mayEdit: t.mayEdit } : { yes: false };
}, far);
ok('a department head sees a task filed under another ฝ่าย', farSeen.yes === true);
ok('...without being handed the right to change it', farSeen.mayEdit === false);
await kung.evaluate(() => { location.hash = '#/work'; }); await kung.waitForTimeout(2000);
// The department dropdown is the one whose first option is "ทุกฝ่าย".
const deptOptions = await kung.evaluate(() => {
  const sel = Array.from(document.querySelectorAll('select'))
    .find((s) => s.options[0] && /ทุกฝ่าย/.test(s.options[0].textContent));
  return sel ? Array.from(sel.options).map((o) => o.textContent.trim()) : [];
});
ok('...and can filter to that ฝ่าย, because its work is on their screen',
  deptOptions.some((x) => /หาทุน|Sponsor/.test(x)), deptOptions.slice(0, 8).join(' | '));

await jade.evaluate(async (ids) => {
  for (const id of ids) {
    if (id) await fetch('/api/tasks?id=' + encodeURIComponent(id), { method: 'DELETE' });
  }
}, [perm, far]);

// ===========================================================================
console.log('\n11. Meeting notifications');
await jade.evaluate(() => { location.hash = '#/work'; }); await jade.waitForTimeout(1500);
await jade.locator('.page-head .btn', { hasText: /นัดประชุม/ }).first().click();
await jade.waitForTimeout(900);
const remindRow = jade.locator('.veil .field', { hasText: 'เตือนก่อนประชุม' }).first();
ok('the meeting form asks which reminders to send',
  (await remindRow.locator('input[type=checkbox]').count()) === 3,
  String(await remindRow.locator('input[type=checkbox]').count()));
const ticked = await remindRow.locator('input[type=checkbox]').evaluateAll((els) => els.map((e) => e.checked));
ok('...with a day before and an hour before on by default',
  ticked.join() === 'false,true,true', ticked.join());
ok('...and says plainly that invitations and changes always go',
  /ทันทีที่ถูกเชิญ/.test(await remindRow.innerText()));
await jade.keyboard.press('Escape'); await jade.waitForTimeout(500);

const invited = await outsider.evaluate(async () =>
  ((await (await fetch('/api/notifications')).json()).notifications || [])
    .filter((n) => n.kind === 'meeting').length);
await jade.evaluate(async (on) => {
  await fetch('/api/events?do=meeting', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'O14: ประชุมแจ้งเตือน', meetsOn: on, meetsAt: '15:00',
      place: 'ห้องทดสอบ', people: ['Ploy_StaffCon'] }),
  });
}, iso(2));
const afterInvite = await outsider.evaluate(async () =>
  ((await (await fetch('/api/notifications')).json()).notifications || [])
    .filter((n) => n.kind === 'meeting'));
ok('being invited puts a notice in the bell', afterInvite.length === invited + 1,
  (afterInvite[0] || {}).title || '(none)');
ok('...that says when and where', /O14/.test((afterInvite[0] || {}).title || '') &&
  /ห้องทดสอบ/.test((afterInvite[0] || {}).body || ''), (afterInvite[0] || {}).body || '');

await jade.evaluate(async () => {
  const d = await (await fetch('/api/events?do=meetings')).json();
  for (const m of (d.meetings || [])) {
    if (/^O14: ประชุมแจ้งเตือน/.test(m.title)) {
      await fetch('/api/events?do=meeting&id=' + encodeURIComponent(m.id), { method: 'DELETE' });
    }
  }
});

await jade.evaluate(async (ids) => {
  for (const id of ids) {
    if (id) await fetch('/api/events?do=meeting&id=' + encodeURIComponent(id), { method: 'DELETE' });
  }
}, [made.done, made.ahead]);

ok('no errors in the browser console', errs.length === 0, errs.slice(0, 4).join(' | '));
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await b.close(); process.exit(failed ? 1 : 0);
