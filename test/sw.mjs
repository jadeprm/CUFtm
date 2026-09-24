/**
 * The service worker, exercised directly.
 *
 * It only ever runs inside a browser, driven by a push that arrives from
 * Apple or Google — neither of which a test can produce. So it is loaded here
 * with a stand-in `self`, and the events are fired by hand. That covers the
 * part that is ours: turning a payload into the right notification, and
 * sending a tap to the right place.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) bad++;
};

function loadWorker() {
  const shown = [];
  const listeners = {};
  const opened = [];
  let clientList = [];

  const self = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    skipWaiting: () => {},
    registration: {
      showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); },
      pushManager: { subscribe: () => Promise.resolve({ endpoint: 'x', toJSON: () => ({}) }) },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(clientList),
      openWindow: (url) => { opened.push(url); return Promise.resolve(); },
    },
    navigator: { setAppBadge: () => {}, clearAppBadge: () => {} },
  };

  const ctx = vm.createContext({ self, fetch: () => Promise.resolve(), console });
  ctx.globalThis = ctx;
  vm.runInContext(readFileSync('public/sw.js', 'utf8'), ctx);

  const fire = async (type, event) => {
    const waits = [];
    event.waitUntil = (p) => waits.push(p);
    for (const fn of listeners[type] || []) fn(event);
    await Promise.all(waits);
  };

  return { shown, fire, opened, setClients: (l) => { clientList = l; } };
}

console.log('Service worker');

// ---- a normal push ---------------------------------------------------------
let w = loadWorker();
await w.fire('push', {
  data: { json: () => ({ id: 'n1', title: 'ส่งไฟล์โปสเตอร์', body: 'ครบกำหนดพรุ่งนี้', taskId: 't1', level: 'normal', unread: 3 }) },
});
ok('a push becomes a notification', w.shown.length === 1);
ok('the Thai title is passed through untouched', w.shown[0].title === 'ส่งไฟล์โปสเตอร์');
ok('the body comes through', w.shown[0].options.body === 'ครบกำหนดพรุ่งนี้');
ok('it carries the id so a tap knows what to open', w.shown[0].options.data.id === 'n1');
ok('a normal one does not demand attention', w.shown[0].options.requireInteraction !== true);
ok('one notification per thing, replacing rather than stacking',
  w.shown[0].options.tag === 'n-n1' && w.shown[0].options.renotify === true);

// ---- an urgent push --------------------------------------------------------
w = loadWorker();
await w.fire('push', {
  data: { json: () => ({ id: 'n2', title: 'ด่วน: เปลี่ยนสถานที่', body: 'ย้ายไปหอประชุมใหญ่', level: 'urgent' }) },
});
ok('an urgent one stays on screen until it is dealt with',
  w.shown[0].options.requireInteraction === true);
ok('...and buzzes noticeably', Array.isArray(w.shown[0].options.vibrate) && w.shown[0].options.vibrate.length > 3);
ok('...and offers a way straight in', (w.shown[0].options.actions || []).length === 1);

// ---- a push with nothing useful in it --------------------------------------
w = loadWorker();
await w.fire('push', { data: { json: () => { throw new Error('not json'); } } });
ok('a malformed push still shows something rather than failing silently',
  w.shown.length === 1 && w.shown[0].title.length > 0, w.shown[0]?.title);

w = loadWorker();
await w.fire('push', {});
ok('a push with no payload at all is survivable', w.shown.length === 1);

// ---- tapping it ------------------------------------------------------------
w = loadWorker();
const focus = [];
const posted = [];
w.setClients([{ focus: () => { focus.push(1); return Promise.resolve(); }, postMessage: (m) => posted.push(m) }]);
await w.fire('notificationclick', {
  notification: { close() {}, data: { id: 'n9', taskId: 't9' } },
});
ok('tapping reuses the open window instead of opening another', focus.length === 1 && w.opened.length === 0);
ok('...and tells it which notification to show', posted[0]?.id === 'n9', JSON.stringify(posted[0]));

w = loadWorker();
w.setClients([]);
await w.fire('notificationclick', {
  notification: { close() {}, data: { id: 'n9' } },
});
ok('with nothing open, it opens the app on that notification',
  w.opened.length === 1 && w.opened[0].includes('#/n/n9'), w.opened[0]);

console.log(bad === 0 ? '\nSERVICE WORKER OK' : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
