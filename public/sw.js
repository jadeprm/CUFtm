/* ==========================================================================
   Service worker — the part of the app that keeps running after you close it.

   It does exactly two jobs: show a notification when one is pushed, and open
   the right screen when someone taps it. Deliberately no offline caching: a
   task list that quietly serves yesterday's data is worse than one that says
   it cannot reach the server.
   ========================================================================== */

self.addEventListener('install', function () {
  // Take over straight away rather than waiting for every tab to close,
  // so an updated worker is live on the next visit instead of some later one.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  var title = data.title || 'งานจุฬาฯแฟร์';
  var urgent = data.level === 'urgent';

  var options = {
    body: data.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    lang: data.lang || 'th',
    dir: 'auto',
    data: {
      id: data.id || null,
      taskId: data.taskId || null,
      url: data.url || './',
    },
    // A tag per notification id means a repeat push replaces rather than
    // stacks; renotify makes the replacement still alert, which is what an
    // urgent message needs.
    tag: data.tag || ('n-' + (data.id || Date.now())),
    renotify: Boolean(data.id),
    silent: false,
    timestamp: data.at ? Date.parse(data.at) : Date.now(),
  };

  if (urgent) {
    // The strongest the web platform actually offers: stays on screen until
    // it is dealt with (desktop), buzzes, and sorts above the rest. It cannot
    // break through Do Not Disturb — only a native app with Apple's critical
    // alert entitlement can do that.
    options.requireInteraction = true;
    options.vibrate = [220, 90, 220, 90, 220];
    options.actions = [{ action: 'open', title: data.actionLabel || 'เปิดดู' }];
  } else {
    options.vibrate = [120];
  }

  event.waitUntil(
    self.registration.showNotification(title, options).then(function () {
      return updateBadge(data.unread);
    }),
  );
});

/**
 * Opens the app on the notification that was tapped.
 *
 * Reuses an already-open window when there is one — otherwise every tap
 * leaves another copy of the app behind — and passes the notification id in
 * the URL so the detail popup opens on arrival.
 */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var info = event.notification.data || {};
  var target = './' + (info.id ? '#/n/' + encodeURIComponent(info.id) : '');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if ('focus' in client) {
          client.postMessage({ type: 'open-notification', id: info.id || null });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    }),
  );
});

/** Keeps the number on the home-screen icon honest. Ignored where unsupported. */
function updateBadge(unread) {
  try {
    if (typeof unread !== 'number' || !self.navigator || !self.navigator.setAppBadge) return;
    if (unread > 0) return self.navigator.setAppBadge(unread);
    return self.navigator.clearAppBadge();
  } catch (e) { /* badging is a nicety, never a reason to fail the push */ }
}

/**
 * A subscription can be rotated by the browser without asking. When that
 * happens the old endpoint stops working, so the new one is sent straight to
 * the server — otherwise the person silently stops receiving anything.
 */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: event.oldSubscription?.options?.applicationServerKey })
      .then(function (sub) {
        return fetch('./api/push?do=subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: sub, replaces: event.oldSubscription?.endpoint || null }),
        });
      })
      .catch(function () { /* nothing useful to do from here; the page re-registers on next open */ }),
  );
});
