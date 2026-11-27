/* ==========================================================================
   Fair Tasks — Frontend API Client (FE ↔ BE boundary).

   Every network call from the browser to the backend passes through this
   module. Keeping HTTP transport, base-URL resolution, credential handling,
   in-flight write deduplication, binary downloads, and typed endpoint wrappers
   here decouples the UI views in public/app.js from backend route mechanics
   and makes it possible to host the frontend and backend on separate origins
   simply by setting `window.FAIR_API_BASE`.
   ========================================================================== */
(function (global) {
  'use strict';

  var base = typeof global.FAIR_API_BASE === 'string'
    ? global.FAIR_API_BASE.replace(/\/+$/, '')
    : '';

  function resolveUrl(path) {
    if (!path) return base || '/';
    if (/^https?:\/\//i.test(path)) return path;
    if (!base) return path;
    return base + (path.charAt(0) === '/' ? path : '/' + path);
  }

  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function credentialsMode() {
    return base ? 'include' : 'same-origin';
  }

  /**
   * Deduplicates identical concurrent writes (POST/PATCH/PUT/DELETE) so double
   * taps on a slow network join the in-flight request instead of creating
   * duplicate records.
   */
  var inFlight = {};

  function request(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    var bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    var key = method === 'GET' ? null : method + ' ' + path + ' ' + (bodyStr || '');
    if (key && inFlight[key]) return inFlight[key];

    var p = fetch(resolveUrl(path), {
      method: method,
      headers: bodyStr !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: bodyStr,
      credentials: credentialsMode(),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'SERVER');
          err.code = data.error || 'SERVER';
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });

    if (key) {
      inFlight[key] = p;
      var cleanup = function () { delete inFlight[key]; };
      p.then(cleanup, cleanup);
    }
    return p;
  }

  /** Fetches raw binary bytes (e.g. PDF originals & signed copies). */
  function fetchBytes(path) {
    return fetch(resolveUrl(path), { credentials: credentialsMode() }).then(function (res) {
      if (res.ok) return res.arrayBuffer();
      return res.json().catch(function () { return {}; }).then(function (body) {
        var err = new Error(body.error || String(res.status));
        err.code = body.error || 'SERVER';
        err.status = res.status;
        err.body = body;
        throw err;
      });
    });
  }

  /** Fetches a Blob (e.g. for forced file downloads on mobile & desktop). */
  function fetchBlob(path) {
    return fetch(resolveUrl(path), { credentials: credentialsMode() }).then(function (res) {
      if (!res.ok) {
        var err = new Error(String(res.status));
        err.status = res.status;
        throw err;
      }
      return res.blob();
    });
  }

  /* ---------- domain service clients ------------------------------------- */

  var FairAPI = {
    version: '2026-11-27e',
    url: resolveUrl,
    qs: qs,
    request: request,
    fetchBytes: fetchBytes,
    fetchBlob: fetchBlob,

    auth: {
      me: function () { return request('/api/auth'); },
      lookup: function (username) { return request('/api/auth?do=lookup', { method: 'POST', body: { username: username } }); },
      login: function (payload) { return request('/api/auth?do=login', { method: 'POST', body: payload }); },
      setPassword: function (payload) { return request('/api/auth?do=set-password', { method: 'POST', body: payload }); },
      logout: function () { return request('/api/auth?do=logout', { method: 'POST' }); },
      register: function (payload) { return request('/api/auth?do=register', { method: 'POST', body: payload }); },
      forgotSend: function (payload) { return request('/api/auth?do=forgot-send', { method: 'POST', body: payload }); },
      forgotReset: function (payload) { return request('/api/auth?do=forgot-reset', { method: 'POST', body: payload }); },
    },

    users: {
      list: function () { return request('/api/users'); },
      updateMe: function (payload) { return request('/api/users?do=me', { method: 'PATCH', body: payload }); },
      avatarUrl: function (username, version) {
        return resolveUrl('/api/users' + qs({ do: 'avatar', user: username, v: version }));
      },
      manage: function (payload) { return request('/api/users?do=manage', { method: 'PATCH', body: payload }); },
      health: function () { return request('/api/users?do=health'); },
      notifyPrefs: function () { return request('/api/users?do=notify'); },
      saveNotifyPrefs: function (payload) { return request('/api/users?do=notify', { method: 'PATCH', body: payload }); },
      tags: function () { return request('/api/users?do=tags'); },
      groups: function () { return request('/api/users?do=groups'); },
      registrations: function () { return request('/api/users?do=registrations'); },
      free: function (params) { return request('/api/users' + qs(Object.assign({ do: 'free' }, params))); },
    },

    tasks: {
      list: function () { return request('/api/tasks'); },
      create: function (payload) { return request('/api/tasks', { method: 'POST', body: payload }); },
      update: function (payload) { return request('/api/tasks', { method: 'PATCH', body: payload }); },
      remove: function (id) { return request('/api/tasks' + qs({ id: id }), { method: 'DELETE' }); },
    },

    spaces: {
      list: function () { return request('/api/tasks?do=spaces'); },
      create: function (payload) { return request('/api/tasks?do=space', { method: 'POST', body: payload }); },
      update: function (payload) { return request('/api/tasks?do=space', { method: 'PATCH', body: payload }); },
      remove: function (id) { return request('/api/tasks' + qs({ do: 'space', id: id }), { method: 'DELETE' }); },
    },

    events: {
      list: function () { return request('/api/events'); },
      create: function (payload) { return request('/api/events', { method: 'POST', body: payload }); },
      update: function (payload) { return request('/api/events', { method: 'PATCH', body: payload }); },
      remove: function (id) { return request('/api/events' + qs({ id: id }), { method: 'DELETE' }); },
    },

    meetings: {
      list: function () { return request('/api/events?do=meetings'); },
      create: function (payload) { return request('/api/events?do=meeting', { method: 'POST', body: payload }); },
      update: function (payload) { return request('/api/events?do=meeting', { method: 'PATCH', body: payload }); },
      reply: function (payload) { return request('/api/events?do=reply', { method: 'POST', body: payload }); },
    },

    calendar: {
      schedule: function (from, to) { return request('/api/calendar' + qs({ do: 'schedule', from: from, to: to })); },
      office: function () { return request('/api/calendar?do=office'); },
      saveOffice: function (payload) { return request('/api/calendar?do=office', { method: 'PUT', body: payload }); },
      officePublic: function (payload) { return request('/api/calendar?do=office-public', { method: 'POST', body: payload }); },
      google: function () { return request('/api/calendar?do=google'); },
      syncGoogle: function () { return request('/api/calendar?do=google-sync', { method: 'POST' }); },
      syncGoogleTasks: function () { return request('/api/calendar?do=google-tasks-sync', { method: 'POST' }); },
      bookingPage: function (token) { return request('/api/calendar' + qs({ book: token })); },
    },

    documents: {
      list: function () { return request('/api/documents'); },
      get: function (id) { return request('/api/documents' + qs({ id: id })); },
      propose: function (payload) { return request('/api/documents?do=propose', { method: 'POST', body: payload }); },
      create: function (payload) { return request('/api/documents?do=create', { method: 'POST', body: payload }); },
      uploadPdfPart: function (payload) { return request('/api/documents?do=pdf-part', { method: 'POST', body: payload }); },
      extView: function (token) { return request('/api/documents' + qs({ do: 'ext-view', token: token })); },
      extFileBytes: function (token) { return fetchBytes('/api/documents' + qs({ do: 'ext-file', token: token })); },
      extAct: function (payload) { return request('/api/documents?do=ext-act', { method: 'POST', body: payload }); },
      extResend: function (payload) { return request('/api/documents?do=ext-resend', { method: 'POST', body: payload }); },
      extEmail: function (payload) { return request('/api/documents?do=ext-email', { method: 'POST', body: payload }); },
      approve: function (payload) { return request('/api/documents?do=approve', { method: 'POST', body: payload }); },
      reject: function (payload) { return request('/api/documents?do=reject', { method: 'POST', body: payload }); },
      moveMark: function (payload) { return request('/api/documents?do=move-mark', { method: 'POST', body: payload }); },
      fileUrl: function (id, kind, download) {
        return resolveUrl('/api/documents' + qs({ id: id, file: kind, download: download ? 1 : undefined }));
      },
      fetchFileBytes: function (id, kind) {
        return fetchBytes('/api/documents' + qs({ id: id, file: kind }));
      },
    },

    notifications: {
      list: function () { return request('/api/notifications'); },
      markRead: function (payload) { return request('/api/notifications', { method: 'PATCH', body: payload }); },
    },

    push: {
      key: function () { return request('/api/push?do=key'); },
      subscribe: function (payload) { return request('/api/push?do=subscribe', { method: 'POST', body: payload }); },
      announcements: function () { return request('/api/push?do=announcements'); },
    },

    line: {
      status: function () { return request('/api/line?do=status'); },
      code: function () { return request('/api/line?do=code', { method: 'POST' }); },
      webhook: function () { return request('/api/line?do=webhook'); },
    },

    meta: {
      get: function () { return request('/api/meta'); },
      links: function () { return request('/api/meta?do=link'); },
      reports: function () { return request('/api/meta?do=report'); },
      share: function (token) { return request('/api/meta' + qs({ do: 'share', t: token })); },
      createShare: function (payload) { return request('/api/meta?do=share', { method: 'POST', body: payload }); },
    },

    importer: {
      run: function (payload) { return request('/api/import', { method: 'POST', body: payload }); },
    },
  };

  global.FairAPI = FairAPI;
}(typeof window !== 'undefined' ? window : globalThis));
