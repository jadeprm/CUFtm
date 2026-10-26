/* ==========================================================================
   Fair Tasks — the whole client.
   Plain JavaScript on purpose: no build step, no framework to upgrade, and
   anyone on the committee next year can open this file and read it.
   ========================================================================== */
(function () {
  'use strict';

  var S = {
    lang: 'th',
    theme: 'system',
    user: null,
    users: [],
    departments: [],
    tasks: [],
    notifs: [],
    unread: 0,
    canManage: false,
    canApprove: false,
    canSetAccess: false,
    sheetWritable: false,
    adminNotice: null,   // survives the redraw a change on the admin page causes
    lastSync: null,
    sheetId: null,
    page: 'work',
    scope: 'mine',      // 'mine' | 'all' — which half of the one work page
    filter: 'open',
    who: '',
    openTaskId: null,    // a task a link asked for, opened once the data lands
    openDocId: null,     // the same, for a document
    docs: [],
    mayManageSecretaries: false,
    registerReady: false,   // is the เลขรันเอกสาร spreadsheet connected
    dept: '',            // teamspace filter; '' = everything I can see
    unit: '',            // section-within-a-department filter
    prio: '',            // priority filter
    q: '',               // what is typed in the search box
    seesEverything: false,
    myDepartments: [],   // every teamspace I may work in
    push: {
      supported: false, permission: 'default', subscribed: false,
      key: null, standalone: false, devices: [], serverKnown: false,
    },
    announcements: [],
    events: [],
    colours: [],
    calView: 'month',
    calAnchor: null,
    calShowEvents: true,
    calRange: 7,
    calMineOnly: false,
  };

  /**
   * Applies the chosen appearance.
   *
   * 'system' removes the attribute entirely so the stylesheet's
   * prefers-color-scheme rules take over; 'light' and 'dark' stamp data-theme,
   * which every token block is written to respect in both directions.
   */
  function applyTheme(theme) {
    S.theme = ['light', 'dark', 'system'].indexOf(theme) !== -1 ? theme : 'system';
    if (S.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', S.theme);
    try { localStorage.setItem('fair-theme', S.theme); } catch (e) {}
    document.querySelectorAll('.theme-toggle button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.theme === S.theme);
      b.setAttribute('aria-pressed', String(b.dataset.theme === S.theme));
    });
  }

  function setTheme(theme) {
    applyTheme(theme);
    // The profile menu shows the current theme by name, so it has to be
    // redrawn — otherwise the label and the screen disagree.
    if (S.user) {
      renderShell();
      api('/api/users?do=me', { method: 'PATCH', body: { theme: S.theme } }).catch(function () {});
    }
  }

  /** Adds a classic script to the page and calls done when it loads or fails. */
  function loadScript(src, done) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = s.onerror = function () { done(); };
    document.head.appendChild(s);
  }

  /**
   * English is a separate file (i18n-en.js), fetched the first time somebody
   * is in English, so the Thai majority never downloads it. Callers that are
   * about to draw wait for it here; Thai needs nothing.
   */
  var langWaiting = null;
  function ensureLang(lang, done) {
    done = done || function () {};
    if (lang !== 'en' || window.STRINGS.en) { done(); return; }
    if (langWaiting) { langWaiting.push(done); return; }
    langWaiting = [done];
    loadScript('./i18n-en.js?v=' + APP_VERSION, function () {
      var q = langWaiting; langWaiting = null;
      q.forEach(function (f) { f(); });
    });
  }

  /** The safety net: anything drawn in English before the file arrived is drawn again once it has. */
  function redrawForLang() {
    var app = document.getElementById('app-view'), auth = document.getElementById('auth-view');
    if (S.user && app && !app.hidden) { renderShell(); renderPage(); }
    else if (!S.user && auth && !auth.hidden) renderAuth();
  }

  var t = function (key) {
    var table = window.STRINGS[S.lang];
    if (!table) {
      table = window.STRINGS.th;
      if (S.lang === 'en' && !langWaiting) ensureLang('en', redrawForLang);
    }
    return table[key] !== undefined ? table[key] : key;
  };
  /**
   * What this PAGE is. The server reports its own — see lib/version.js — and
   * the profile page says so when the two disagree, which is what a
   * half-finished deployment looks like from the outside.
   */
  var APP_VERSION = '2026-10-27c';

  var errText = function (code) {
    var key = window.ERROR_KEYS[code];
    return key ? t(key) : t('errGeneric');
  };

  /* ---------- task vocabulary --------------------------------------------
     Mirrors lib/scope.js. Listed in the order work actually moves, which is
     also the order every menu and segmented control shows them in.
     ---------------------------------------------------------------------- */
  var STATUS_LIST = ['todo', 'doing', 'review', 'feedback', 'done'];
  // Monday first, because that is how a Thai week is written and read.
  var WEEK_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var PRIORITY_LIST = ['low', 'medium', 'high', 'highest'];

  var STATUS_KEY = {
    todo: 'statusTodo', doing: 'statusDoing', review: 'statusReview',
    feedback: 'statusFeedback', done: 'statusDone',
  };
  var PRIORITY_KEY = {
    low: 'prioLow', medium: 'prioMedium', high: 'prioHigh', highest: 'prioHighest',
  };

  /** A one-character mark for the round status button on each card. */
  var MARK = { todo: '', doing: '\u25CF', review: '\u25D4', feedback: '\u25D1', done: '\u2713' };

  function statusLabel(status) { return t(STATUS_KEY[status] || status); }
  function prioLabel(priority) { return t(PRIORITY_KEY[priority] || priority); }

  /* ---------- tiny DOM helper ------------------------------------------- */
  function h(tag, props, kids) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;   // never innerHTML for data
        else if (k === 'html') node.innerHTML = v;     // only for our own markup
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }
  var $ = function (id) { return document.getElementById(id); };
  var clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  /* ---------- api ------------------------------------------------------- */
  /**
   * The same write, sent twice while the first is still out, is one write.
   * People press again when the server is slow, and every press used to be a
   * separate request — three presses, three meetings. A repeat now joins the
   * request already under way and gets its answer.
   */
  var inFlight = {};
  function api(path, options) {
    options = options || {};
    var method = options.method || 'GET';
    var key = method === 'GET' ? null : method + ' ' + path + ' ' + JSON.stringify(options.body || null);
    if (key && inFlight[key]) return inFlight[key];
    var p = fetch(path, {
      method: method,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || 'SERVER'); e.code = data.error; e.data = data; throw e; }
        return data;
      });
    });
    if (key) {
      inFlight[key] = p;
      var done = function () { delete inFlight[key]; };
      p.then(done, done);
    }
    return p;
  }

  /**
   * And a button that has just been pressed ignores a second press for a
   * moment, so the handler itself does not run twice and the page shows
   * something is happening instead of nothing.
   */
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('button.btn.primary, button.btn.danger, .modal footer button');
    if (!b || b.disabled) return;
    if (b.dataset.pressedAt && Date.now() - Number(b.dataset.pressedAt) < 1200) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    b.dataset.pressedAt = String(Date.now());
    b.classList.add('pressed');
    setTimeout(function () { b.classList.remove('pressed'); }, 1200);
  }, true);

  /* ---------- dates ----------------------------------------------------- */
  var TZ = 'Asia/Bangkok';
  function todayIso() {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date());
    var g = function (type) { return p.find(function (x) { return x.type === type; }).value; };
    return g('year') + '-' + g('month') + '-' + g('day');
  }
  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  /**
   * `opts` REPLACES the default parts rather than adding to them — asking for
   * a month and a year should give "November 2026", not "23 November 2026".
   */
  function fmtDate(iso, opts) {
    if (!iso) return t('noDue');
    var d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return iso;
    var parts = opts ? Object.assign({}, opts) : { day: 'numeric', month: 'short' };
    parts.timeZone = 'UTC';
    return d.toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB', parts);
  }
  /**
   * A moment, as Bangkok wall time.
   *
   * The server sends timestamps in UTC, and the document page used to read the
   * date and the clock straight out of that string — so a letter signed at
   * 17:05 showed 10:05, and anything done after 7pm was filed under the day
   * before. Everything in this committee happens on Bangkok time, so that is
   * what every timestamp is shown in, whatever clock the laptop is set to.
   */
  function bkkStamp(value) {
    if (!value) return null;
    var d = new Date(value);
    if (isNaN(d.getTime())) return null;
    var p = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    var g = function (type) { var x = p.find(function (y) { return y.type === type; }); return x ? x.value : ''; };
    // Intl gives hour 24 for midnight in some engines.
    var hh = g('hour') === '24' ? '00' : g('hour');
    return { date: g('year') + '-' + g('month') + '-' + g('day'), time: hh + ':' + g('minute') };
  }
  /** The date part only, for a timestamp. */
  function stampDate(value, opts) {
    var p = bkkStamp(value);
    return p ? fmtDate(p.date, opts) : '';
  }
  /** Date and clock, the way the committee writes it. */
  function fmtStamp(value, opts) {
    var p = bkkStamp(value);
    if (!p) return '';
    return fmtDate(p.date, opts) + ' ' + p.time + (S.lang === 'th' ? ' \u0e19.' : '');
  }

  function relativeDay(iso) {
    var today = todayIso();
    if (iso === today) return t('today');
    if (iso === addDays(today, 1)) return t('tomorrow');
    return null;
  }
  /** Whole days from today — negative for a date that has already gone past. */
  function daysFromToday(iso) {
    var a = new Date(todayIso() + 'T00:00:00Z').getTime();
    var b = new Date(iso + 'T00:00:00Z').getTime();
    if (isNaN(b)) return 0;
    return Math.round((b - a) / 86400000);
  }
  /**
   * A date said the way a person would say it.
   *
   * "20 พฤศจิกายน 2569" is accurate and tells you nothing — the question
   * anyone actually has is how long they have got. Today and tomorrow have
   * their own words; beyond that it is a count of days, and a date already
   * past says so rather than making you work it out.
   */
  function whenWording(iso, time, tail) {
    if (!iso) return t('noDue');
    var text = fmtDate(iso, { day: 'numeric', month: 'long', year: 'numeric' });
    if (time) text += ' · ' + time + (tail ? '–' + tail : '') + ' ' + t('hrsShort');
    // `tail` closes a time range, so it belongs with the clock, not after the
    // "in eleven days" that has to come last to read as a sentence.
    else if (tail) text += ' – ' + tail;
    var near = relativeDay(iso);
    if (near) return text + ' · ' + near;
    var days = daysFromToday(iso);
    if (days > 0 && days <= 60) return text + ' · ' + t('inDays').replace('{n}', String(days));
    if (days < 0 && days >= -365) return text + ' · ' + t('daysAgo').replace('{n}', String(-days));
    return text;
  }
  /** One labelled line of a read-only summary. */
  /**
   * The short code, as something to copy.
   *
   * People pass these around in LINE, so one tap to copy is the difference
   * between a code that gets used and one that gets retyped wrongly.
   */
  function codeChip(code) {
    var chip = h('button', { class: 'view-code', text: code, title: t('copyCode') });
    chip.addEventListener('click', function () {
      var done = function () {
        var was = chip.textContent;
        chip.textContent = t('codeCopied');
        setTimeout(function () { chip.textContent = was; }, 1200);
      };
      // Clipboard access is refused in some browsers and on insecure origins,
      // so the fallback selects the text for the person to copy themselves.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(function () { select(chip); });
      } else select(chip);

      function select(node) {
        var range = document.createRange();
        range.selectNodeContents(node);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
    return chip;
  }

  function vRow(label, value) {
    return h('div', { class: 'vrow' }, [
      h('div', { class: 'vk', text: label }),
      h('div', { class: 'vv' }, [value]),
    ]);
  }
  var vMuted = function (text) { return h('span', { class: 'vmuted', text: text }); };
  var isOverdue = function (task) {
    return task.dueDate && task.status !== 'done' && task.dueDate < todayIso();
  };

  /**
   * How urgent a task is, as one word.
   *
   * Two things decide it and they are not independent: how close the deadline
   * is, and how much it matters. A "highest" task due in a week deserves more
   * attention than an ordinary one due in a week, so priority lifts the task
   * up the scale rather than colouring it separately — which is what people
   * mean when they say something is urgent.
   *
   * Finished work drops off the scale entirely. A done task is not urgent no
   * matter what its deadline was, and colouring it red would be noise on the
   * one card nobody needs to act on.
   *
   * The order below is also the sort order: late, then now, then soon, then
   * ahead, then everything undated.
   */
  var URGENCY = ['late', 'now', 'soon', 'ahead', 'none', 'done'];
  function urgencyOf(task) {
    if (task.status === 'done') return 'done';

    var lift = task.priority === 'highest' ? 2 : task.priority === 'high' ? 1 : 0;

    // No deadline at all: only the loudest priority earns any colour.
    if (!task.dueDate) return lift >= 2 ? 'soon' : 'none';

    var days = daysFromToday(task.dueDate);
    if (days < 0) return 'late';

    var level = days === 0 ? 3 : days <= 3 ? 2 : days <= 7 ? 1 : 0;
    level += lift;
    return level >= 3 ? 'now' : level === 2 ? 'soon' : level === 1 ? 'ahead' : 'none';
  }
  var urgencyRank = function (task) { return URGENCY.indexOf(urgencyOf(task)); };

  /* ---------- people ---------------------------------------------------- */
  function userBy(username) {
    for (var i = 0; i < S.users.length; i++) if (S.users[i].username === username) return S.users[i];
    return null;
  }
  function nameOf(username) {
    var u = userBy(username);
    return u ? (u.displayName || u.username) : username;
  }
  function initials(name) {
    var s = String(name || '?').trim();
    return s.slice(0, 2).toUpperCase();
  }
  /**
   * Somebody's real signature, as an <img>, fetched once per person.
   *
   * The placement boxes used to be pink rectangles, which told nobody
   * anything about how big the signature inside them would come out — a box
   * twice the size of the handwriting looks identical to one that fits. The
   * image is drawn with object-fit: contain, which is exactly what
   * stampSignatures does to the PDF (see fit() in lib/pdfsign.js), so what is
   * on screen is what lands on the letter.
   */
  var SIG_URLS = {};
  function signatureUrl(username) {
    if (!SIG_URLS[username]) {
      SIG_URLS[username] = '/api/documents?do=sigimg&user=' + encodeURIComponent(username) +
        '&t=' + Date.now();
    }
    return SIG_URLS[username];
  }
  function signatureImg(username, cls) {
    return h('img', { class: cls || 'sig-real', src: signatureUrl(username), alt: '' });
  }

  /**
   * The box that fits a signature exactly, as fractions of the page.
   *
   * A signature is wide and short; a box of fixed proportions leaves it
   * floating in empty space and makes it look smaller than it was drawn. The
   * height follows from the width, the image's own proportions, and the
   * page's — so the picture fills its box and the box IS the signature.
   */
  function sigBoxSize(sig, pageAspect, width) {
    var w = width || 0.26;
    var ratio = (sig && sig.sigW && sig.sigH) ? (sig.sigW / sig.sigH) : 3.5;
    /**
     * In page fractions, not pixels. The box is w×h of a page that is itself
     * `pageAspect` wide for every 1 tall, so on screen it measures
     * (w · pageW) by (h · pageH) — and that is what has to match the image's
     * own proportions:  (w · pageW) / (h · pageH) = ratio.
     */
    var hh = (w * (pageAspect || 0.707)) / ratio;
    // Never taller than a quarter of the page, nor too small to see.
    hh = Math.max(0.012, Math.min(0.25, hh));
    return { w: w, h: hh };
  }

  function avatarNode(username, size) {
    var u = userBy(username);
    var cls = 'avatar' + (size ? ' ' + size : '');
    if (u && u.avatar) return h('span', { class: cls, title: nameOf(username) }, [h('img', { src: u.avatar, alt: '' })]);
    return h('span', { class: cls, title: nameOf(username), text: initials(u ? u.displayName : username) });
  }
  /**
   * Groups a list of people by department, mine first.
   *
   * Each person appears exactly once, under their home department — grouping
   * by every department they are granted would list the assistant head of
   * Operations four times, which reads as a bug.
   *
   * My own departments come first because those are the people I work with
   * daily; everyone else follows, so asking another department for something
   * stays possible without scrolling past them every time.
   */
  function groupPeople(people) {
    var ownKeys = myDepartments().map(function (d) { return d.key; });
    var groups = [];

    function collect(keys, prefix) {
      keys.forEach(function (key) {
        var d = null;
        for (var i = 0; i < S.departments.length; i++) {
          if (S.departments[i].key === key) d = S.departments[i];
        }
        if (!d) return;
        var members = people.filter(function (u) { return u.department === key; });
        if (members.length) groups.push({ label: prefix + (d[S.lang] || d.en), people: members });
      });
    }

    collect(ownKeys, '');
    collect(S.departments.map(function (d) { return d.key; }).filter(function (k) {
      return ownKeys.indexOf(k) === -1;
    }), S.seesEverything ? '' : t('otherDepartments') + ' \u00B7 ');

    var orphans = people.filter(function (u) { return !u.department; });
    if (orphans.length) groups.push({ label: t('noDepartment'), people: orphans });
    return groups;
  }

  /** The same grouping as <optgroup>s, for a plain <select>. */
  function groupedPeopleOptions(people) {
    return groupPeople(people).map(function (g) {
      return h('optgroup', { label: g.label }, g.people.map(function (u) {
        return h('option', {
          value: u.username,
          text: (u.unit ? u.unit + ' \u00B7 ' : '') + u.displayName,
          selected: S.who === u.username,
        });
      }));
    });
  }

  /**
   * Who sees every task.
   *
   * Wider than `seesEverything`, and on purpose: that one answers "may this
   * person act across the whole fair", while this answers "is the whole fair
   * on their screen". Since 2026-10-15 an Editor sees every ฝ่าย's work
   * without being able to file into it or change it — so this decides what to
   * SHOW, and myDepartments() below still decides what may be filed where.
   */
  function seesAllTasks() {
    if (S.seesEverything) return true;
    var a = S.user && S.user.access;
    return a === 'editor' || a === 'admin' || a === 'coadmin';
  }

  /** Departments this person may file into, as objects, in org-chart order. */
  function myDepartments() {
    if (S.seesEverything) return S.departments;
    return S.departments.filter(function (d) {
      return S.myDepartments.indexOf(d.key) !== -1;
    });
  }

  /** Everyone who has been granted this department. */
  function peopleIn(key) {
    return S.users.filter(function (u) {
      return (u.departments || []).indexOf(key) !== -1;
    });
  }

  /** Position in the org chart, so chips always list in the same order. */
  function chartOrder(key) {
    for (var i = 0; i < S.departments.length; i++) {
      if (S.departments[i].key === key) return i;
    }
    return 999;
  }

  /** The label, indented one step for the Operations divisions. */
  function deptOptionLabel(d) {
    return (d.parent ? '\u2001' : '') + (d[S.lang] || d.en);
  }

  function deptLabel(key) {
    for (var i = 0; i < S.departments.length; i++) {
      if (S.departments[i].key === key) return S.departments[i][S.lang] || S.departments[i].en;
    }
    return key;
  }

  /**
   * The sections inside a department — สถานที่ within อำนวยการ 2.
   *
   * These come from the org chart, not from the database, so the list is the
   * same everywhere and a section cannot be invented by typing one. They are
   * a level of FILING, not of permission: putting a task in สถานที่ changes
   * nothing about who may see or edit it.
   */
  function unitsOf(key) {
    for (var i = 0; i < S.departments.length; i++) {
      if (S.departments[i].key === key) return S.departments[i].units || [];
    }
    return [];
  }

  /** Every section across the departments this person can see, for filtering. */
  function myUnits() {
    var out = [];
    myDepartments().forEach(function (d) {
      (d.units || []).forEach(function (u) {
        out.push({ dept: d.key, unit: u });
      });
    });
    return out;
  }

  /**
   * Builds the one-click "Add to Google Calendar" URL.
   * Bangkok never observes daylight saving, so the offset is a constant.
   */
  function googleCalUrl(task) {
    if (!task.dueDate) return null;
    var p = new URLSearchParams();
    p.set('action', 'TEMPLATE');
    p.set('text', task.title);

    var flat = function (iso) { return iso.replace(/-/g, ''); };
    if (task.dueTime) {
      var toUtc = function (iso, hhmm) {
        var a = iso.split('-').map(Number), b = hhmm.split(':').map(Number);
        var d = new Date(Date.UTC(a[0], a[1] - 1, a[2], b[0], b[1]) - 7 * 60 * 60000);
        var z = function (n) { return String(n).padStart(2, '0'); };
        return d.getUTCFullYear() + z(d.getUTCMonth() + 1) + z(d.getUTCDate()) + 'T' +
               z(d.getUTCHours()) + z(d.getUTCMinutes()) + '00Z';
      };
      var hh = Number(task.dueTime.slice(0, 2));
      var endTime = String((hh + 1) % 24).padStart(2, '0') + task.dueTime.slice(2);
      var endDate = hh + 1 > 23 ? addDays(task.dueDate, 1) : task.dueDate;
      p.set('dates', toUtc(task.dueDate, task.dueTime) + '/' + toUtc(endDate, endTime));
    } else {
      p.set('dates', flat(task.dueDate) + '/' + flat(addDays(task.dueDate, 1)));
    }

    var people = (task.assignees || []).map(nameOf).join(', ');
    var details = [task.description || '', people ? t('assignTo') + ': ' + people : '']
      .filter(Boolean).join('\n');
    if (details) p.set('details', details);
    p.set('ctz', 'Asia/Bangkok');
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }

  /* ======================================================================
     Sign in
     ====================================================================== */
  var authState = { username: '', mode: 'ask', known: null };

  function showAuthNotice(message, kind) {
    var box = $('auth-notice');
    box.className = 'notice ' + (kind || 'err');
    box.textContent = message || '';
    box.hidden = !message;
  }

  /** Takes the splash down. Safe to call more than once. */
  function bootDone() {
    if (typeof window.__bootDone === 'function') window.__bootDone();
  }

  /**
   * The holding page.
   *
   * Says what the system is, who it is for, and when it opens — and still
   * offers a way in, because a committee member who arrives early should not
   * be locked out of their own system by a poster page.
   */
  function renderComingSoon() {
    $('soon-view').hidden = false;
    $('auth-view').hidden = true;
    $('app-view').hidden = true;
    document.documentElement.lang = S.lang;

    document.querySelectorAll('#soon-view [data-t]').forEach(function (n) {
      n.textContent = t(n.dataset.t);
    });

    var when = $('soon-when');
    if (S.opensAt) {
      when.hidden = false;
      when.textContent = t('soonOpens').replace('%s', S.opensAt);
    } else {
      when.hidden = true;
    }

    $('soon-signin').onclick = function () {
      // Not a reload: the sign-in is already in the page, it was only hidden.
      $('soon-view').hidden = true;
      $('auth-view').hidden = false;
      try {
        history.replaceState(null, '', location.pathname + '?enter=1' + location.hash);
      } catch (e) {}
      var box = $('in-username');
      if (box) box.focus();
    };
  }


  /* ---------- AdSense, on the sign-in screen and nowhere else ------------ */

  /**
   * The publisher id, or '' to switch the whole thing off.
   *
   * Jade's, and the one place to change or clear it. Everything below is
   * written so that an empty string here means no script is fetched, no
   * reload happens, and the app behaves exactly as it did before.
   */
  var ADSENSE_CLIENT = 'ca-pub-6829067770704612';

  /**
   * And where it is allowed to run.
   *
   * AdSense only serves on the site it approved, so a localhost or preview
   * build asking for the script gets nothing but a failed request and, worse,
   * the reload below for no reason — which would change the timing of every
   * browser suite in dev-tests for a feature none of them are about. The
   * one host that is the real site, plus ?ads=1 for testing the behaviour
   * itself.
   */
  var ADSENSE_HOSTS = ['task.chulafair.com'];
  var adsWanted = ADSENSE_HOSTS.indexOf(location.hostname) !== -1
    || /[?&]ads=1/.test(location.search);

  var adsLoaded = false;

  /**
   * Why this is injected rather than sitting in index.html.
   *
   * index.html is the whole app — one page, every screen. A script tag in
   * the head would put Auto ads on the task board, inside documents, over
   * the committee's meeting agendas, which is not what was asked for and is
   * not something two hundred people should have to look at while working.
   * Loading it when the sign-in screen draws keeps it to the one screen
   * somebody sees before they are inside anything.
   */
  function loadLoginAds() {
    if (adsLoaded || !adsWanted || !ADSENSE_CLIENT) return;
    adsLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' +
      encodeURIComponent(ADSENSE_CLIENT);
    // A blocked or failed script must not take the sign-in box with it.
    s.onerror = function () {};
    document.head.appendChild(s);
  }

  /**
   * Signing in starts the app over, when and only when an ad script loaded.
   *
   * Auto ads keeps watching the page after it loads and puts anchors and
   * overlays wherever it likes, so taking the elements away by hand is a
   * game nobody wins. A reload is the one thing that is certainly clean —
   * and it costs almost nothing here, because the signed-in app is about to
   * fetch everything anyway, and anybody who already has a session never
   * draws the sign-in screen and so never loads the script at all.
   */
  function afterSignIn() {
    if (S.user && S.user.emailRequired) { renderEmailGate(); return; }
    if (adsLoaded) { location.reload(); return; }
    boot();
  }

  function renderAuth() {
    if (S.lang === 'en' && !window.STRINGS.en) { ensureLang('en', renderAuth); return; }
    bootDone();
    /**
     * Before the committee opens the system, strangers get the holding page
     * rather than a sign-in box they have no account for. Anyone who already
     * has a session never comes through here, and ?enter=1 is the way past it
     * for the people building the thing.
     */
    if (S.comingSoon && !/[?&]enter=1/.test(location.search)) {
      renderComingSoon();
      return;
    }
    $('soon-view').hidden = true;
    $('gate-view').hidden = true;
    $('auth-view').hidden = false;
    $('app-view').hidden = true;
    document.documentElement.lang = S.lang;

    var known = authState.known;
    var setup = known && known.needsSetup;

    $('auth-title').textContent = authState.mode === 'ask' ? t('signInTitle')
      : setup ? t('firstTimeTitle') : t('signInTitle');
    $('step-username').hidden = authState.mode !== 'ask';
    $('step-known').hidden = authState.mode === 'ask';
    $('auth-back').hidden = authState.mode === 'ask';
    $('auth-forgot').hidden = authState.mode === 'ask' || setup;
    $('auth-register').hidden = authState.mode !== 'ask';
    $('auth-forgot').textContent = t('forgotTitle');
    $('field-confirm').hidden = !setup;
    $('pw-rules').textContent = setup ? t('pwRules') : '';
    $('auth-submit').textContent = authState.mode === 'ask' ? t('continue')
      : setup ? t('savePassword') : t('signIn');

    document.querySelectorAll('[data-t]').forEach(function (n) { n.textContent = t(n.dataset.t); });
    document.querySelectorAll('.lang-toggle button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.lang === S.lang);
    });

    if (known) {
      $('auth-name').textContent = known.displayName || authState.username;
      $('auth-sub').textContent = authState.username;
      var av = $('auth-avatar');
      clear(av);
      if (known.avatar) av.appendChild(h('img', { src: known.avatar, alt: '' }));
      else av.textContent = initials(known.displayName || authState.username);
      $('auth-help').textContent = setup
        ? (known.resetAuthorised ? t('resetHelp') : t('firstTimeHelp'))
        : '';
      $('in-password').setAttribute('autocomplete', setup ? 'new-password' : 'current-password');
    }

    loadLoginAds();
  }

  $('auth-form').addEventListener('submit', function (e) {
    e.preventDefault();
    showAuthNotice('');

    if (authState.mode === 'ask') {
      var name = $('in-username').value.trim();
      if (!name) return;
      api('/api/auth?do=check', { method: 'POST', body: { username: name } })
        .then(function (data) {
          if (!data.known) { showAuthNotice(data.pending ? t('regPendingNote') : t('errNoSuchUser'), data.pending ? 'warn' : undefined); return; }
          authState.username = name;
          authState.known = data;
          authState.mode = 'password';
          renderAuth();
          setTimeout(function () { $('in-password').focus(); }, 30);
        })
        .catch(function (err) { showAuthNotice(err.code === 'NO_DATABASE' ? t('noDatabase') : t('errOffline')); });
      return;
    }

    var password = $('in-password').value;
    var setup = authState.known && authState.known.needsSetup;

    if (setup) {
      if (password !== $('in-confirm').value) { showAuthNotice(t('errMismatch')); return; }
      api('/api/auth?do=setup', { method: 'POST', body: { username: authState.username, password: password } })
        .then(function (data) {
          S.user = data.user; S.lang = data.user.lang || S.lang;
          if (data.user.theme) applyTheme(data.user.theme);
          afterSignIn();
        })
        .catch(function (err) { showAuthNotice(errText(err.code)); });
    } else {
      api('/api/auth?do=login', { method: 'POST', body: { username: authState.username, password: password } })
        .then(function (data) {
          S.user = data.user; S.lang = data.user.lang || S.lang;
          if (data.user.theme) applyTheme(data.user.theme);
          afterSignIn();
        })
        .catch(function (err) {
          if (err.code === 'RESET_PENDING') {
            authState.known.needsSetup = true;
            authState.known.resetAuthorised = true;
            renderAuth();
            showAuthNotice(t('errResetPending'), 'warn');
            return;
          }
          showAuthNotice(errText(err.code));
        });
    }
  });

  $('auth-back').addEventListener('click', function () {
    authState.mode = 'ask'; authState.known = null;
    $('in-password').value = ''; $('in-confirm').value = '';
    showAuthNotice(''); renderAuth();
  });
  $('auth-forgot').addEventListener('click', function () { showAuthNotice(t('forgotHelp'), 'warn'); });


  /* ======================================================================
     Joining, and proving an email
     ====================================================================== */
  /**
   * One container for the two screens that are neither the sign-in box nor
   * the app: the registration form and the "link your email" step that
   * stands in front of everything until it is done. Drawn by hand into
   * #gate-view; the server enforces the email rule, this is only its face.
   */
  function showGate(kids) {
    bootDone();
    $('soon-view').hidden = true;
    $('auth-view').hidden = true;
    $('app-view').hidden = true;
    var box = $('gate-view');
    clear(box);
    box.hidden = false;
    document.documentElement.lang = S.lang;
    box.appendChild(h('div', { class: 'auth' }, kids));
  }

  function gateNotice() { return h('div', { class: 'notice err', hidden: true }); }
  function gateSay(n, text, kind) {
    n.hidden = !text; n.textContent = text || ''; n.className = 'notice ' + (kind || 'err');
  }
  function field(label, input) { return h('div', { class: 'field' }, [h('label', { text: label }), input]); }

  /** The six-digit step, shared by registration and by linking an email. */
  function codeStep(o) {
    var n = gateNotice(), input = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', placeholder: t('regCode') });
    var go = h('button', { type: 'submit', class: 'btn primary', text: t('regVerify') });
    var resend = h('button', { type: 'button', class: 'link', text: t('regResend'), onclick: function () {
      if (resend.disabled) return;
      resend.disabled = true;
      setTimeout(function () { resend.disabled = false; }, 45000);
      api(o.resendUrl, { method: 'POST', body: o.resendBody() })
        .then(function () { gateSay(n, t('regResent'), 'ok'); })
        .catch(function (err) { gateSay(n, errText(err.code)); });
    } });
    var form = h('form', { onsubmit: function (e) {
      e.preventDefault();
      go.disabled = true;
      api(o.verifyUrl, { method: 'POST', body: o.verifyBody(input.value.trim()) })
        .then(o.done)
        .catch(function (err) { go.disabled = false; gateSay(n, errText(err.code)); });
    } }, [
      h('h1', { text: o.title }),
      h('p', { class: 'hint', text: o.sent }), n, field(t('regCode'), input), go, resend,
    ].concat(o.extra || []));
    return form;
  }

  function renderEmailGate() {
    if (S.lang === 'en' && !window.STRINGS.en) { ensureLang('en', renderEmailGate); return; }
    var n = gateNotice();
    var email = h('input', { type: 'email', autocomplete: 'email', value: S.user.email || '' });
    var signOut = h('button', { type: 'button', class: 'link', text: t('emSignOut'), onclick: function () {
      api('/api/auth?do=logout', { method: 'POST' }).then(function () { location.reload(); });
    } });
    var sendBtn = h('button', { type: 'submit', class: 'btn primary', text: t('emSend') });
    function askCode(e) {
      if (e) e.preventDefault();
      if (sendBtn.disabled) return;
      sendBtn.disabled = true;
      var addr = email.value.trim();
      api('/api/auth?do=email-send', { method: 'POST', body: { email: addr } }).then(function () {
        showGate([codeStep({
          title: t('emTitle'), sent: t('regCodeSent').replace('%s', addr),
          resendUrl: '/api/auth?do=email-send', resendBody: function () { return { email: addr }; },
          verifyUrl: '/api/auth?do=email-verify', verifyBody: function (c) { return { email: addr, code: c }; },
          done: function (d) { S.user = d.user; afterSignIn(); },
          extra: [signOut],
        })]);
      }).catch(function (err) { sendBtn.disabled = false; gateSay(n, errText(err.code)); });
    }
    showGate([h('form', { onsubmit: askCode }, [
      h('h1', { text: t('emTitle') }), h('p', { class: 'hint', text: t('emWhy') }), n,
      field(t('regEmail'), email),
      sendBtn, signOut,
    ])]);
  }

  function renderRegister(opts) {
    if (S.lang === 'en' && !window.STRINGS.en) { ensureLang('en', function () { renderRegister(opts); }); return; }
    var n = gateNotice();
    if (!opts) {
      api('/api/auth?do=register-options').then(renderRegister)
        .catch(function () { renderAuth(); showAuthNotice(t('errOffline')); });
      return;
    }
    var lang = S.lang;
    var f = {
      username: h('input', { type: 'text', autocapitalize: 'none', autocomplete: 'username', spellcheck: 'false', maxlength: '64' }),
      nickname: h('input', { type: 'text', maxlength: '60' }),
      fullName: h('input', { type: 'text', maxlength: '120' }),
      position: h('input', { type: 'text', maxlength: '120' }),
      email: h('input', { type: 'email', autocomplete: 'email', maxlength: '200' }),
      password: h('input', { type: 'password', autocomplete: 'new-password' }),
      confirm: h('input', { type: 'password', autocomplete: 'new-password' }),
      dept: h('select', {}, [h('option', { value: '', text: t('regPick') })].concat(opts.departments.map(function (d) {
        return h('option', { value: d.key, text: lang === 'en' ? d.en : d.th });
      }))),
      unit: h('select', {}, [h('option', { value: '', text: t('regUnitNone') })]),
      who: h('div', { class: 'hint' }),
    };
    f.dept.addEventListener('change', function () {
      var d = opts.departments.filter(function (x) { return x.key === f.dept.value; })[0];
      clear(f.unit);
      f.unit.appendChild(h('option', { value: '', text: t('regUnitNone') }));
      ((d && d.units) || []).forEach(function (u) { f.unit.appendChild(h('option', { value: u, text: u })); });
      var names = ((d && d.approvers) || []).map(function (a) { return a.name + (a.position ? ' (' + a.position + ')' : ''); });
      f.who.textContent = d ? t('regWillAsk') + ': ' + (names.length ? names.join(', ') : t('regAdminsOnly')) : '';
    });
    var submit = h('button', { type: 'submit', class: 'btn primary', text: t('regSubmit') });
    var back = h('button', { type: 'button', class: 'link', text: t('regBackToSignIn'), onclick: function () { renderAuth(); } });

    function finish(msg) {
      showGate([h('h1', { text: t('regWait') }), h('p', { class: 'hint', text: msg }), back]);
    }

    var form = h('form', { onsubmit: function (e) {
      e.preventDefault();
      gateSay(n, '');
      if (f.password.value !== f.confirm.value) { gateSay(n, t('errMismatch')); return; }
      submit.disabled = true;
      api('/api/auth?do=register', { method: 'POST', body: {
        username: f.username.value.trim(), password: f.password.value, nickname: f.nickname.value,
        fullName: f.fullName.value, position: f.position.value, email: f.email.value,
        department: f.dept.value, unit: f.unit.value,
      } }).then(function (d) {
        if (d.firstRun && !d.id) { showGate([h('h1', { text: t('regTitle') }), h('p', { class: 'hint', text: t('regFirst') }), back]); return; }
        var addr = f.email.value.trim().toLowerCase();
        showGate([codeStep({
          title: t('regCodeTitle'), sent: t('regCodeSent').replace('%s', addr),
          resendUrl: '/api/auth?do=register-resend', resendBody: function () { return { id: d.id }; },
          verifyUrl: '/api/auth?do=register-verify', verifyBody: function (c) { return { id: d.id, code: c }; },
          done: function (r) { finish(r.firstRun ? t('regFirst') : t('regWaitBody')); },
          extra: [back],
        })]);
      }).catch(function (err) {
        submit.disabled = false;
        gateSay(n, errText(err.code));
      });
    } }, [
      h('h1', { text: t('regTitle') }),
      h('p', { class: 'hint', text: opts.firstRun ? t('regFirst') : t('regIntro') }),
      opts.mailReady || opts.firstRun ? null : h('div', { class: 'notice warn', text: t('regNoMail') }),
      n,
      field(t('regUsername'), f.username), field(t('regNickname'), f.nickname), field(t('regFullName'), f.fullName),
      field(t('regPosition'), f.position), field(t('regDepartment'), f.dept), field(t('regUnit'), f.unit),
      field(t('regEmail'), f.email), field(t('password'), f.password), field(t('confirmPassword'), f.confirm),
      h('p', { class: 'hint', text: t('pwRules') }),
      opts.firstRun ? null : f.who,
      submit, back,
    ]);
    showGate([form]);
  }
  $('auth-register').addEventListener('click', function () { renderRegister(); });

  /** The approvers' queue: people who have proved an email and are waiting for a yes. */
  function pageRequests(main) {
    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('reqTitle') })]));
    var notice = h('div', { class: 'notice', hidden: true });
    var list = h('div', { class: 'req-list' });
    main.appendChild(notice);
    main.appendChild(list);
    function load() {
      api('/api/users?do=registrations').then(function (d) {
        clear(list);
        if (!d.requests.length) { list.appendChild(h('p', { class: 'hint', text: t('reqEmpty') })); return; }
        d.requests.forEach(function (r) {
          function decide(approve) {
            api('/api/users?do=registration-decide', { method: 'POST', body: { id: r.id, approve: approve } })
              .then(function () {
                notice.hidden = false; notice.className = 'notice ok';
                notice.textContent = t(approve ? 'reqApproved' : 'reqRejected').replace('%s', r.username);
                load();
              })
              .catch(function (err) { notice.hidden = false; notice.className = 'notice err'; notice.textContent = errText(err.code); load(); });
          }
          list.appendChild(h('div', { class: 'card req-card' }, [
            h('strong', { text: r.nickname + ' · ' + r.fullName }),
            h('div', { class: 'hint', text: r.username + ' · ' + r.email }),
            h('div', { text: r.position + ' · ' + deptLabel(r.department) + (r.unit ? ' / ' + r.unit : '') }),
            h('div', { class: 'hint', text: t('reqNamed') + ': ' + r.approvers.join(', ') }),
            h('div', { class: 'req-act' }, [
              h('button', { class: 'btn primary', text: t('reqApprove'), onclick: function () { decide(true); } }),
              h('button', { class: 'btn danger', text: t('reqReject'), onclick: function () { decide(false); } }),
            ]),
          ]));
        });
      }).catch(function (err) { notice.hidden = false; notice.className = 'notice err'; notice.textContent = errText(err.code); });
    }
    load();
  }

  /* ======================================================================
     Shell
     ====================================================================== */
  function setLang(lang) {
    S.lang = lang === 'en' ? 'en' : 'th';
    try { localStorage.setItem('fair-lang', S.lang); } catch (e) {}
    document.documentElement.lang = S.lang;
    if (S.user) api('/api/users?do=me', { method: 'PATCH', body: { lang: S.lang } }).catch(function () {});
    ensureLang(S.lang, function () {
      if (S.user) { renderShell(); renderPage(); } else renderAuth();
    });
  }
  document.querySelectorAll('.lang-toggle button').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.dataset.lang); });
  });
  document.querySelectorAll('.theme-toggle button').forEach(function (b) {
    b.addEventListener('click', function () { setTheme(b.dataset.theme); });
  });

  /* ---------- the phone -------------------------------------------------- */

  /**
   * One question every phone-only decision asks: is this a phone?
   *
   * The same 720px line as phone.css, read through matchMedia so the script
   * and the stylesheet can never disagree about which side of it the screen is
   * on. Crossing it — a tablet turned on its side, a window dragged narrow —
   * redraws, because the two layouts are built differently, not just styled.
   */
  var PHONE_MQ = window.matchMedia ? window.matchMedia('(max-width: 720px)') : { matches: false };
  function isPhone() { return Boolean(PHONE_MQ.matches); }
  (function () {
    var redraw = function () { if (S.user) { renderShell(); renderPage(); } };
    if (PHONE_MQ.addEventListener) PHONE_MQ.addEventListener('change', redraw);
    else if (PHONE_MQ.addListener) PHONE_MQ.addListener(redraw);
  }());

  /**
   * How much of the screen is actually visible, kept in CSS variables.
   *
   * On an iPhone the keyboard does not shrink the page — it slides over it — so
   * a sheet sized to the window put its save button behind the keyboard, and
   * Safari's collapsing toolbar moves the bottom edge as you scroll. The
   * visual viewport is the part a person can see; sheets are sized to that.
   */
  (function trackViewport() {
    var vv = window.visualViewport;
    var root = document.documentElement;
    function sync() {
      var height = vv ? vv.height : window.innerHeight;
      root.style.setProperty('--vvh', Math.round(height) + 'px');
      root.style.setProperty('--vvt', Math.round(vv ? vv.offsetTop : 0) + 'px');
      // With the keyboard up the home indicator is covered anyway, so the
      // space kept clear for it would only be a gap above the keys.
      root.classList.toggle('kb-open', Boolean(vv) && window.innerHeight - height > 140);
    }
    sync();
    if (vv) { vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync); }
    window.addEventListener('resize', sync);
  }());

  /** Small line icons, drawn here so they look the same on every phone. */
  var ICON = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.8a3 3 0 010 5.4M17.5 14.3c1.7.6 2.7 2.2 3 4.7"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
    bellQuiet: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/><path d="M9 12h6"/>',
    bellOff: '<path d="M6 16V11a6 6 0 019.5-4.9M18 10.5V16l1.5 2H8"/><path d="M10 20.5a2 2 0 004 0M3.5 3.5l17 17"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    task: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M9 11.5l2.2 2.2L15.5 9"/>',
    event: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><circle cx="12" cy="14.5" r="1.6"/>',
    meeting: '<circle cx="8" cy="9" r="2.8"/><circle cx="16" cy="9" r="2.8"/><path d="M3 19c.5-2.8 2.5-4.4 5-4.4s4.5 1.6 5 4.4M11 19c.5-2.8 2.5-4.4 5-4.4s4.5 1.6 5 4.4"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v4.5h16V15"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    gantt: '<path d="M4 5v14M4 7.5h8M7 12h10M10 16.5h8"/>',
    flag: '<path d="M5.5 21V4.5M5.5 5h11l-2 4 2 4h-11"/>',
    spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    trophy: '<path d="M8 4.5h8v4.5a4 4 0 01-8 0z"/><path d="M8 6H5a3 3 0 003 4M16 6h3a3 3 0 01-3 4M12 13v4M8.5 20h7M10 17h4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    flame: '<path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3 2-4.6 3-7 .6 1.4 1.4 2.3 2.5 2.7C11.5 7.6 13 5 15.5 3.5c-.4 2.5.4 4.2 1.7 5.9 1.1 1.4 1.8 3 1.8 4.9C19 18.2 16 21 12 21z"/>',
    alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
    pie: '<path d="M12 3.5a8.5 8.5 0 108.5 8.5H12z"/><path d="M15 3.8A8.5 8.5 0 0120.2 9H15z"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    calplus: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4M12 12.5v5M9.5 15h5"/>',
    door: '<path d="M6 20.5V4.5a1 1 0 011-1h10a1 1 0 011 1v16"/><path d="M4 20.5h16M14.5 12.5v.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"/>',
    repeat: '<path d="M4 11V9a3 3 0 013-3h12l-3-3M20 13v2a3 3 0 01-3 3H5l3 3"/>',
    megaphone: '<path d="M4 10v4h3l6 4V6L7 10z"/><path d="M16.5 9.5a3.5 3.5 0 010 5"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.7-3.6 3.6-5.5 7-5.5s6.3 1.9 7 5.5"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    folder: '<path d="M3.5 7.5A2 2 0 015.5 5.5h3.6l2 2.4h7.4a2 2 0 012 2v8.1a2 2 0 01-2 2H5.5a2 2 0 01-2-2z"/>',
    bug: '<circle cx="12" cy="13" r="5"/><path d="M12 8V5M9.2 6 7.8 4M14.8 6l1.4-2M7 11.5 4 10.5M7 15l-3 1M17 11.5l3-1M17 15l3 1M10.5 20l-1 2M13.5 20l1 2"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    doc: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    board: '<rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="11" rx="1.5"/><rect x="15.5" y="4" width="5" height="13" rx="1.5"/>',
    list: '<path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4.5" cy="6.5" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17.5" r="1"/>',
  };
  function icon(name, cls) {
    var span = document.createElement('span');
    span.className = 'ic' + (cls ? ' ' + cls : '');
    span.setAttribute('aria-hidden', 'true');
    // A fixed string from the table above — nothing from a person reaches this.
    span.innerHTML = '<svg viewBox="0 0 24 24">' + (ICON[name] || '') + '</svg>';
    return span;
  }

  /**
   * Every dialog, as a sheet that rises from the bottom.
   *
   * Applied to whatever lands in #modal-root rather than written into each of
   * the twelve dialogs, so a dialog added next month is a sheet on a phone
   * without anybody remembering to make it one. What it changes:
   *
   *   · a handle to drag it down by, which is how every phone closes a sheet;
   *   · a footer button that only repeats the ✕ in the header is hidden — it
   *     was the third of three buttons that wrapped onto two lines each;
   *   · a footer left with nothing in it is hidden, rather than being a grey
   *     strip of nothing above the home indicator.
   *
   * Watching the footers matters as much as watching the dialogs: the task
   * dialog repaints its buttons every time it switches between reading and
   * editing, and each repaint would otherwise bring the duplicate back.
   */
  function tidySheet(veil) {
    var modal = veil.querySelector(':scope > .modal');
    if (!modal) return;
    if (!veil.classList.contains('sheet')) {
      veil.classList.add('sheet');
      modal.insertBefore(h('div', { class: 'grab', 'aria-hidden': 'true' }), modal.firstChild);
      dragToDismiss(veil, modal);
    }
    var header = modal.querySelector(':scope > header');
    var hasCross = Boolean(header) && Array.prototype.some.call(header.querySelectorAll('button'),
      function (b) { return /^[✕×]$/.test((b.textContent || '').trim()); });
    modal.querySelectorAll(':scope > footer').forEach(function (footer) {
      var useful = 0;
      Array.prototype.forEach.call(footer.children, function (el) {
        var repeat = hasCross && (el.textContent || '').trim() === t('close');
        el.classList.toggle('ph-dup', repeat);
        if (!repeat && !el.hidden && !el.classList.contains('grow')) useful += 1;
      });
      footer.classList.toggle('ph-empty', useful === 0);
    });
  }

  var tidyQueued = false;
  new MutationObserver(function () {
    if (tidyQueued) return;
    tidyQueued = true;
    requestAnimationFrame(function () {
      tidyQueued = false;
      if (!isPhone()) return;
      document.querySelectorAll('#modal-root > .veil').forEach(tidySheet);
    });
  }).observe($('modal-root'), { childList: true, subtree: true });

  /**
   * Drag the handle or the header down to close.
   *
   * Closes by clicking the veil, not by removing the dialog, so each dialog's
   * own close still runs — the task dialog puts the list back the way it was,
   * the meeting dialog refreshes. A dialog that ignores a click on its veil
   * stays open, and the sheet springs back rather than vanishing.
   */
  function dragToDismiss(veil, modal) {
    var startY = null;
    var dy = 0;
    modal.addEventListener('touchstart', function (e) {
      if (!isPhone() || !e.touches[0]) return;
      var el = e.target;
      if (el.closest('button, a, input, select, textarea, .seg')) return;
      if (!el.classList.contains('grab') && !el.closest('.modal > header')) return;
      startY = e.touches[0].clientY;
      dy = 0;
      modal.style.transition = 'none';
    }, { passive: true });
    modal.addEventListener('touchmove', function (e) {
      if (startY === null || !e.touches[0]) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      modal.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    var finish = function () {
      if (startY === null) return;
      startY = null;
      modal.style.transition = '';
      if (dy > 90) veil.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (veil.isConnected) modal.style.transform = '';
    };
    modal.addEventListener('touchend', finish);
    modal.addEventListener('touchcancel', finish);
  }

  /**
   * A short list of things to do, rising from the bottom.
   *
   * What a phone shows instead of a row of buttons it has no room for: each
   * choice is a full-width row a thumb cannot miss, with a line under it
   * saying what it does, because "กิจกรรม" and "นัดประชุม" are not obviously
   * different things to somebody in their first week.
   */
  function actionSheet(title, items) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var list = h('div', { class: 'act-list' }, items.filter(Boolean).map(function (it) {
      return h('button', {
        type: 'button', class: 'act' + (it.danger ? ' danger' : ''),
        onclick: function () { veil.remove(); it.onclick(); },
      }, [
        it.icon ? icon(it.icon, 'act-ic') : null,
        h('span', { class: 'act-tx' }, [
          h('b', { text: it.label }),
          it.sub ? h('small', { text: it.sub }) : null,
        ]),
      ]);
    }));
    veil.appendChild(h('div', { class: 'modal act-sheet' }, [
      h('header', {}, [
        h('h2', { text: title }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [list]),
    ]));
    $('modal-root').appendChild(veil);
    return veil;
  }

  /**
   * What the + button offers, asked choice by choice.
   *
   * A สมาชิกฝ่าย may call a meeting and may not put work on anybody, so a
   * single mayCreate() gate on the whole sheet gets one of those two wrong
   * whichever way it is set.
   */
  function openCreateSheet() {
    actionSheet(t('phCreateWhat'), [
      mayCreate() ? { icon: 'task', label: t('newTask'), sub: t('phNewTaskSub'), onclick: function () { openTask(null); } } : null,
      mayCreate() ? { icon: 'event', label: t('newEvent'), sub: t('phNewEventSub'), onclick: function () { openEvent(null); } } : null,
      mayCallMeeting()
        ? { icon: 'meeting', label: t('mtgNew'), sub: t('phNewMeetingSub'), onclick: function () { openMeeting(null); } }
        : null,
      mayCreate() ? { icon: 'upload', label: t('importTasks'), sub: t('phImportSub'), onclick: function () { openImport(); } } : null,
    ].filter(Boolean));
  }

  /**
   * The + button: what it does depends on the page, and on some pages it is
   * not there at all — announcements and the admin page are forms already, and
   * a button that makes "something" on them would be a guess.
   */
  function paintFab() {
    var fab = $('fab');
    if (!fab) return;
    var action = null;
    if ((S.page === 'work' || S.page === 'calendar') && (mayCreate() || mayCallMeeting())) action = openCreateSheet;
    if (S.page === 'docs') action = function () { openDocUpload(); };
    if (S.page === 'home' && (mayCreate() || mayCallMeeting())) action = openCreateSheet;
    // On a phone the schedule's own buttons sit above the fold; the + adds an appointment.
    if (S.page === 'schedule') action = function () { openAppointment(null, { on: S.schedAnchor || todayIso() }); };
    if (S.page === 'space' && mayCreate()) action = function () { S.newTaskSpace = S.spaceId; openTask(null); };
    fab.hidden = !action;
    fab.onclick = action;
    fab.setAttribute('aria-label', S.page === 'docs' ? t('docNew') : t('phCreateWhat'));
  }

  /** The name of the page, for the top bar on a phone. */
  function pageTitle() {
    if (S.page === 'space') {
      var sp = spaceBy(S.spaceId);
      return sp ? sp.name : t('spaces');
    }
    return t({
      home: 'navHome', schedule: 'navSchedule', requests: 'navRequests',
      work: 'navWork', calendar: 'navCalendar', docs: 'navDocs', announce: 'navAnnounce',
      admin: 'navAdmin', profile: 'profile', links: 'navLinks',
      reports: 'navReports', shelf: 'navShelf', feed: 'navFeed',
    }[S.page] || 'navWork');
  }

  /** The small line under the title: today's date on home, the scope elsewhere. */
  function pageSub() {
    if (S.page === 'home' || S.page === 'schedule') {
      return fmtDate(todayIso(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (S.page === 'work' && S.dept) return deptLabel(S.dept);
    if (S.page === 'space') { var sp = spaceBy(S.spaceId); return sp && sp.description ? sp.description : ''; }
    return '';
  }

  /* ---------- the sidebar ------------------------------------------------ */

  /**
   * Three ways to have the sidebar on a computer, remembered on this device:
   *   'full'  — docked, with names (the default)
   *   'rail'  — docked, icons only, for a narrow window or a wide board
   *   'float' — detached: off the page until the ☰ in the top bar opens it,
   *             then floating over the content and closing on a click away
   * On a phone it is always the drawer behind the เมนู tab.
   */
  var SB_MODES = ['full', 'rail', 'float'];
  function sbMode() {
    if (S.sbMode) return S.sbMode;
    try { S.sbMode = localStorage.getItem('fair-sb') || 'full'; } catch (e) { S.sbMode = 'full'; }
    if (SB_MODES.indexOf(S.sbMode) === -1) S.sbMode = 'full';
    return S.sbMode;
  }
  function setSbMode(mode) {
    S.sbMode = mode;
    try { localStorage.setItem('fair-sb', mode); } catch (e) {}
    applySbMode();
  }
  function applySbMode() {
    var root = document.documentElement;
    root.classList.toggle('sb-rail', sbMode() === 'rail');
    root.classList.toggle('sb-float', sbMode() === 'float');
    if (sbMode() !== 'float' && !isPhone()) openDrawer(false);
    var c = $('sb-collapse'); var d = $('sb-detach');
    if (c) { c.title = sbMode() === 'rail' ? t('sbExpand') : t('sbCollapse'); c.setAttribute('aria-label', c.title); }
    if (d) { d.title = sbMode() === 'float' ? t('sbDock') : t('sbDetach'); d.setAttribute('aria-label', d.title); }
  }
  function openDrawer(open) {
    var root = document.documentElement;
    root.classList.toggle('sb-open', Boolean(open));
    var scrim = $('sb-scrim');
    if (scrim) scrim.hidden = !open;
  }
  if ($('sb-collapse')) $('sb-collapse').addEventListener('click', function () {
    setSbMode(sbMode() === 'rail' ? 'full' : 'rail');
  });
  if ($('sb-detach')) $('sb-detach').addEventListener('click', function () {
    setSbMode(sbMode() === 'float' ? 'full' : 'float');
  });
  if ($('sb-open')) $('sb-open').addEventListener('click', function (e) { e.stopPropagation(); openDrawer(true); });
  if ($('sb-scrim')) $('sb-scrim').addEventListener('click', function () { openDrawer(false); });
  if ($('tab-more')) $('tab-more').addEventListener('click', function (e) {
    e.preventDefault();
    openDrawer(!document.documentElement.classList.contains('sb-open'));
  });
  // Picking anything in a floating sidebar or the drawer closes it.
  if ($('sidebar')) $('sidebar').addEventListener('click', function (e) {
    var hit = e.target.closest('a[href], .sb-item');
    if (hit && (isPhone() || sbMode() === 'float') && hit.id !== 'tab-more') setTimeout(function () { openDrawer(false); }, 0);
  });
  applySbMode();

  /**
   * The nav lives in the sidebar on a computer and along the bottom on a
   * phone. Moving the one element, rather than keeping two copies, keeps a
   * single set of links for everything that looks for them.
   */
  function placeNav() {
    var nav = $('tabs');
    var side = $('sidebar');
    var app = $('app-view');
    if (!nav || !side || !app) return;
    if (isPhone()) {
      if (nav.parentNode !== app) app.insertBefore(nav, $('fab'));
    } else if (nav.parentNode !== side) {
      side.insertBefore(nav, $('sb-extra'));
    }
    applySbMode();
  }

  function spaceBy(id) {
    return (S.spaces || []).filter(function (x) { return x.id === id; })[0] || null;
  }
  var SPACE_HEX = { pink: '#e0457b', indigo: '#5b5bd6', teal: '#0fa5a0', amber: '#f59e0b',
    violet: '#8b5cf6', green: '#12a36b', blue: '#2f7ff0', red: '#e5484d' };
  function spaceHex(sp) { return SPACE_HEX[(sp && sp.colour) || 'pink'] || SPACE_HEX.pink; }
  function spaceBadge(sp, cls) {
    var letter = sp.icon || String(sp.name || '?').trim().charAt(0).toUpperCase();
    return h('span', { class: cls || 'sb-ico', style: 'background:' + spaceHex(sp), text: letter });
  }

  function sbFolded(key, many) {
    var saved = null;
    try { saved = localStorage.getItem('fair-sb-fold-' + key); } catch (e) {}
    // A long list starts folded, so the spaces above it stay in view.
    return saved === null ? Boolean(many) : saved === '1';
  }
  function sbSection(key, title, items, addButton) {
    var sec = h('div', { class: 'sb-sec' + (sbFolded(key, items.length > 8) ? ' folded' : ''), dataset: { sec: key } });
    sec.appendChild(h('div', { class: 'sb-sec-head' }, [
      h('button', { type: 'button', class: 'sb-fold', onclick: function () {
        var now = !sec.classList.contains('folded');
        sec.classList.toggle('folded', now);
        try { localStorage.setItem('fair-sb-fold-' + key, now ? '1' : '0'); } catch (e) {}
      } }, [h('i', { text: '\u25be' }), title]),
    ]));
    sec.appendChild(h('div', { class: 'sb-list' }, items.concat(addButton ? [addButton] : [])));
    return sec;
  }

  /**
   * Spaces and departments, under the nav. Departments are the ones this
   * person can work in; picking one opens everyone's work filtered to it,
   * which is what the dropdown on the work page did one click deeper.
   */
  function renderSidebar() {
    var box = $('sb-extra');
    if (!box || !S.user) return;
    clear(box);

    // On a phone, the drawer also carries the pages that have no room in the bar.
    if (isPhone()) {
      var pages = [['feed', 'navFeed', 'megaphone'], ['calendar', 'navCalendar', 'event'], ['shelf', 'navShelf', 'folder'],
        ['announce', 'navAnnounce', 'megaphone', S.canManage],
        ['requests', 'navRequests', 'user', S.canApprove],
        ['admin', 'navAdmin', 'people', S.canManage], ['profile', 'profile', 'user'],
        ['links', 'navLinks', 'link'], ['reports', 'navReports', 'bug']];
      box.appendChild(h('div', { class: 'sb-drawer-nav' }, pages.filter(function (p) {
        return p[3] === undefined || p[3];
      }).map(function (p) {
        return h('a', { class: 'sb-item' + (S.page === p[0] ? ' on' : ''), href: '#/' + p[0] }, [
          h('span', { class: 'sb-ico', style: 'background:rgba(255,255,255,.1)' }, [icon(p[2])]),
          h('span', { class: 'sb-label', text: t(p[1]) }),
        ]);
      })));
    }

    var spaces = (S.spaces || []).filter(function (sp) { return sp.mine || S.seesEverything; });
    box.appendChild(sbSection('spaces', t('spaces'), spaces.map(function (sp) {
      return h('a', {
        class: 'sb-item' + (S.page === 'space' && S.spaceId === sp.id ? ' on' : ''),
        href: '#/space/' + encodeURIComponent(sp.id), title: sp.name,
      }, [
        spaceBadge(sp),
        h('span', { class: 'sb-label', text: sp.name }),
        sp.openTasks ? h('span', { class: 'sb-n', text: String(sp.openTasks) }) : null,
      ]);
    }), h('button', { type: 'button', class: 'sb-item sb-add', onclick: function () { openSpace(null); } }, [
      h('span', { class: 'sb-plus', text: '+' }), h('span', { class: 'sb-label', text: t('spaceNew') }),
    ])));

    // Every ฝ่าย for anybody who sees every ฝ่าย's work — otherwise the tasks
    // are in the list but there is no way to look at one department's worth.
    var depts = (S.departments || []).filter(function (d) {
      return seesAllTasks() || (S.myDepartments || []).indexOf(d.key) !== -1;
    });
    if (depts.length) {
      box.appendChild(sbSection('depts', t('departments'), depts.map(function (d) {
        var open = S.tasks.filter(function (x) {
          return x.status !== 'done' && (x.department === d.key ||
            (x.departments || []).some(function (y) { return y.key === d.key; }));
        }).length;
        return h('button', {
          type: 'button', class: 'sb-item' + (S.page === 'work' && S.dept === d.key ? ' on' : ''), title: deptLabel(d.key),
          onclick: function () {
            S.dept = d.key; S.unit = ''; S.scope = 'all'; S.role = '';
            if (location.hash === '#/work') { renderShell(); renderPage(); } else location.hash = '#/work';
          },
        }, [
          h('span', { class: 'sb-dot', style: 'background:' + deptHue(d.key) }),
          h('span', { class: 'sb-label', text: deptLabel(d.key) }),
          open ? h('span', { class: 'sb-n', text: String(open) }) : null,
        ]);
      })));
    }
  }

  /** A steady colour per department, from the chart palette, so a dot always means the same ฝ่าย. */
  var DEPT_HUES = ['#e0457b', '#5b5bd6', '#0fa5a0', '#f59e0b', '#8b5cf6', '#12a36b', '#2f7ff0', '#e5484d', '#d9468f', '#0ea5e9', '#a16207', '#7c3aed'];
  function deptHue(key) {
    var i = (S.departments || []).map(function (d) { return d.key; }).indexOf(key);
    return DEPT_HUES[(i < 0 ? 0 : i) % DEPT_HUES.length];
  }

  /**
   * A list of people that stays a line long on a phone.
   *
   * Ten people as ten full-width chips was most of the screen in the task Jade
   * photographed — the detail she opened the task to read was below it. The
   * same list on a computer was four wrapped lines of names above the thing
   * she had opened the task for, so it folds there too, just later: a row of
   * faces and a count, opening on a tap.
   */
  function peopleList(usernames, chipClass) {
    var chips = function () {
      return usernames.map(function (u) {
        return h('span', { class: 'chip who' + (chipClass ? ' ' + chipClass(u) : '') },
          [avatarNode(u, 'sm'), nameOf(u)]);
      });
    };
    var keep = isPhone() ? 4 : 6;
    if (usernames.length <= keep) return h('span', { class: 'selected' }, chips());

    var box = h('div', { class: 'ppl-fold' });
    function fold() {
      clear(box);
      box.appendChild(h('button', { type: 'button', class: 'ppl-sum', onclick: unfold }, [
        h('span', { class: 'stack' }, usernames.slice(0, keep).map(function (u) { return avatarNode(u, 'sm'); })),
        h('span', { class: 'ppl-n', text: t('phPeopleN').replace('%n', String(usernames.length)) }),
        h('span', { class: 'ppl-more', text: t('phShowAll') }),
      ]));
    }
    function unfold() {
      clear(box);
      box.appendChild(h('span', { class: 'selected' }, chips()));
      box.appendChild(h('button', { type: 'button', class: 'ppl-less', text: t('phShowLess'), onclick: fold }));
    }
    fold();
    return box;
  }

  function renderShell() {
    bootDone();
    $('soon-view').hidden = true;
    $('auth-view').hidden = true;
    $('app-view').hidden = false;
    $('brand-name').textContent = t('appName');
    $('brand-sub').textContent = t('appSub');
    // On a phone the page's own name takes the brand's place: there is room
    // for one of the two, and knowing which page you are on is the useful one.
    $('bar-title').textContent = pageTitle();
    document.querySelectorAll('#app-view [data-t]').forEach(function (n) { n.textContent = t(n.dataset.t); });
    document.querySelectorAll('.lang-toggle button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.lang === S.lang);
    });
    document.querySelectorAll('#tabs a').forEach(function (a) {
      a.classList.toggle('on', a.dataset.page === S.page);
    });
    $('tab-admin').hidden = !S.canManage;
    $('tab-announce').hidden = !S.canManage;
    $('tab-requests').hidden = !S.canApprove;
    if ($('gate-view')) $('gate-view').hidden = true;
    // The page's own name and a line under it, on the left of the top bar.
    if ($('bar-sub')) $('bar-sub').textContent = pageSub();
    placeNav();
    renderSidebar();

    var av = clear($('me-avatar'));
    if (S.user.avatar) av.appendChild(h('img', { src: S.user.avatar, alt: '' }));
    else av.textContent = initials(S.user.displayName);
    $('me-name').textContent = S.user.displayName || S.user.username;
    $('me-theme').textContent = t('theme') + ': ' + t('theme' +
      (S.theme || 'system').charAt(0).toUpperCase() + (S.theme || 'system').slice(1));
    $('me-lang').textContent = t('language') + ': ' + (S.lang === 'th' ? 'ไทย' : 'English');

    $('bell-count').hidden = S.unread === 0;
    $('bell-count').textContent = S.unread;
  }

  $('sign-out').addEventListener('click', function () {
    api('/api/auth?do=logout', { method: 'POST' }).then(function () { location.reload(); });
  });

  /**
   * The two things that hang off the top bar: the bell and the profile menu.
   *
   * Opening one closes the other, and a tap anywhere else closes both — on a
   * phone there is no room for two panels at once, and a panel left open over
   * the task list is the thing people complain about rather than report.
   */
  function openPop(which) {
    ['bell-pop', 'me-pop'].forEach(function (id) {
      $(id).hidden = id !== which || !$(id).hidden;
    });
    $('me-avatar').setAttribute('aria-expanded', String(!$('me-pop').hidden));
    if (!$('bell-pop').hidden) renderBell();
  }

  /**
   * Escape closes whatever is on top.
   *
   * Every dialog in this app already closes on a click outside, but on a
   * keyboard that means aiming at the dark part of the screen. Escape is what
   * people press, and until now nothing happened.
   */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var veils = document.querySelectorAll('#modal-root .veil');
    if (veils.length) { veils[veils.length - 1].remove(); return; }
    ['bell-pop', 'me-pop'].forEach(function (id) { $(id).hidden = true; });
    $('me-avatar').setAttribute('aria-expanded', 'false');
  });

  $('bell-btn').addEventListener('click', function (e) { e.stopPropagation(); openPop('bell-pop'); });
  $('me-avatar').addEventListener('click', function (e) { e.stopPropagation(); openPop('me-pop'); });

  document.addEventListener('click', function (e) {
    ['bell-pop', 'me-pop'].forEach(function (id) {
      var pop = $(id);
      if (pop.hidden) return;
      var owner = id === 'bell-pop' ? $('bell-btn') : $('me-avatar');
      if (!pop.contains(e.target) && !owner.contains(e.target) && e.target !== owner) pop.hidden = true;
    });
    $('me-avatar').setAttribute('aria-expanded', String(!$('me-pop').hidden));
  });

  // Both cycle rather than open a sub-menu: there are only three themes and
  // two languages, and a menu inside a menu on a phone is a trap.
  $('me-theme').addEventListener('click', function (e) {
    e.stopPropagation();
    var order = ['system', 'light', 'dark'];
    setTheme(order[(order.indexOf(S.theme || 'system') + 1) % order.length]);
  });
  $('me-guide').addEventListener('click', function () {
    ['bell-pop', 'me-pop'].forEach(function (id) { $(id).hidden = true; });
    guideStatus().then(function (steps) { openGuide(steps, true); });
  });
  $('me-lang').addEventListener('click', function (e) {
    e.stopPropagation();
    setLang(S.lang === 'th' ? 'en' : 'th');
  });
  $('mark-read').addEventListener('click', function (e) {
    e.stopPropagation();
    api('/api/notifications', { method: 'PATCH', body: { all: true } }).then(function (d) {
      S.unread = d.unread;
      S.notifs = S.notifs.map(function (n) { n.read = true; return n; });
      renderShell(); renderBell();
    });
  });

  function renderBell() {
    var box = clear($('bell-items'));
    if (!S.notifs.length) {
      box.appendChild(h('div', { class: 'empty', text: t('noNotifications') }));
      return;
    }
    S.notifs.forEach(function (n) {
      box.appendChild(h('div', {
        class: 'item' + (n.read ? '' : ' unread') + (n.level === 'urgent' ? ' urgent' : ''),
        onclick: function () {
          $('bell-pop').hidden = true;
          openNotification(n.id);
        },
      }, [
        h('b', {}, [
          n.level === 'urgent' ? h('span', { class: 'chip urgent-dot', text: t('urgent') }) : null,
          n.title,
        ]),
        h('span', { text: n.body }),
        h('small', { class: 'when', text: fmtWhen(n.createdAt) }),
      ]));
    });
  }

  window.addEventListener('hashchange', function () {
    routeFromHash(); renderShell(); renderPage(); flushPendingTask();
  });
  function routeFromHash() {
    var raw = (location.hash || '#/home').replace('#/', '');

    /**
     * #/n/<id> is where a tapped notification lands. It opens the detail
     * popup over whatever page was last used rather than being a page of its
     * own, so closing it leaves someone somewhere useful instead of blank.
     */
    if (raw.indexOf('n/') === 0) {
      var id = decodeURIComponent(raw.slice(2));
      location.replace('#/' + (S.page || 'mine'));
      setTimeout(function () { openNotification(id); }, 0);
      return;
    }

    /**
     * #/t/<id> opens one task directly, which is what a link from LINE points
     * at. Like a notification, it opens the pop-up over the work page rather
     * than being a page of its own — and it waits for the task list to arrive,
     * because a link followed from a phone usually lands before the data does.
     */
    if (raw.indexOf('d/') === 0) {
      S.openDocId = decodeURIComponent(raw.slice(2));
      location.replace('#/docs');
      S.page = 'docs';
      return;
    }

    if (raw.indexOf('t/') === 0) {
      /**
       * Remembered rather than opened on the spot.
       *
       * This runs once before the first load has finished, when the task list
       * is still empty — opening here would always fail. So the id is put
       * aside and whoever finishes loading opens it, which works the same
       * whether the link was followed cold or pasted into an open tab.
       */
      S.openTaskId = decodeURIComponent(raw.slice(2));
      location.replace('#/work');
      S.scope = 'all';
      S.page = 'work';
      return;
    }

    var page = raw;

    // The old addresses still work: they pick the scope and land on the one
    // page, so a bookmark or a link someone shared does not break.
    if (page === 'all') { S.scope = 'all'; page = 'work'; }
    else if (page === 'mine') { S.scope = 'mine'; page = 'work'; }
    else if (page === 'events') page = 'work';

    // Meetings no longer have a page of their own — they sit with the events
    // and the tasks. The old address still resolves so a link somebody already
    // shared lands somewhere sensible rather than nowhere.
    if (page === 'meetings') page = 'work';
    // #/space/<id> — one working group's page.
    if (page.indexOf('space/') === 0) {
      S.spaceId = decodeURIComponent(page.slice(6));
      page = 'space';
    }
    // #/schedule?google=ok — the word Google's return left in the address.
    if (page.indexOf('schedule?') === 0) {
      var q = page.split('?')[1] || '';
      var m = q.match(/google=([^&]+)/);
      if (m) S.googleNotice = decodeURIComponent(m[1]);
      var bk = q.match(/book=([^&]+)/);
      if (bk) S.bookHost = decodeURIComponent(bk[1]);
      page = 'schedule';
      try { history.replaceState(null, '', '#/schedule'); } catch (e) {}
    }
    if (page === 'more') page = S.page || 'home';
    if (['home', 'schedule', 'space', 'work', 'calendar', 'docs', 'profile', 'links', 'admin', 'announce',
      'reports', 'shelf', 'feed', 'requests'].indexOf(page) === -1) page = 'home';
    if (page === 'requests' && !S.canApprove) page = 'work';
    if ((page === 'admin' || page === 'announce') && !S.canManage) page = 'work';
    // Leaving the admin page drops whatever it was last saying, so coming back
    // to it tomorrow does not reopen with yesterday's message.
    if (page !== 'admin') S.adminNotice = null;
    // Going somewhere closes whatever was hanging off the top bar. A profile
    // menu left open over the page you just navigated to is a menu the person
    // has to dismiss before they can read anything.
    ['bell-pop', 'me-pop'].forEach(function (id) { if ($(id)) $(id).hidden = true; });
    S.page = page;
  }

  /**
   * Opens a task as soon as it exists, or gives up and says so.
   *
   * A link from a chat is followed cold: the page is still signing in and the
   * task list is still on its way. Waiting a moment beats showing "not found"
   * for a task that is merely half a second late.
   */
  /**
   * Opens the task a link asked for.
   *
   * The list held here can be older than the link. Someone adds a task on
   * their phone through LINE, then opens the link on a laptop tab that has
   * been sitting open since this morning — the task is real, but this page has
   * never heard of it. So a miss refetches once before giving up, and only a
   * task that is genuinely gone or genuinely not theirs gets the message.
   */
  function flushPendingTask(refetched) {
    var wanted = S.openTaskId;
    if (!wanted) return;

    var found = S.tasks.filter(function (x) { return x.id === wanted; })[0];
    if (found) { S.openTaskId = null; openTask(found); return; }

    if (refetched) { S.openTaskId = null; alert(t('taskNotFound')); return; }

    api('/api/tasks')
      .then(function (data) { S.tasks = data.tasks; renderPage(); flushPendingTask(true); })
      .catch(function () { S.openTaskId = null; alert(t('taskNotFound')); });
  }


  /* ======================================================================
     Documents for signing
     ====================================================================== */

  /**
   * Rendering a PDF page in the browser, so a box can be drawn on it.
   *
   * pdf.js is fetched only when somebody actually opens a document — it is a
   * large library and most visits to this app never touch a PDF, so loading it
   * on every page would slow down the parts people use constantly.
   */
  var pdfjsReady = null;
  function withPdfJs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise(function (resolve, reject) {
      /**
       * Served from this site, not a CDN.
       *
       * Marking where a signature goes is the one thing this feature cannot do
       * without, and a CDN is exactly the kind of thing a university network
       * blocks or an offline phone cannot reach. Shipping the library means it
       * works wherever the app itself works.
       */
      var base = './vendor';
      var tag = document.createElement('script');
      tag.src = base + '/pdf.min.js';
      tag.onload = function () {
        var lib = window.pdfjsLib;
        if (!lib) { reject(new Error('pdfjs missing')); return; }
        lib.GlobalWorkerOptions.workerSrc = base + '/pdf.worker.min.js';
        resolve(lib);
      };
      tag.onerror = function () { reject(new Error('pdfjs blocked')); };
      document.head.appendChild(tag);
    });
    return pdfjsReady;
  }

  /**
   * Draws one page into a canvas and reports its on-screen size.
   *
   * The size matters as much as the picture: a box drawn on the page is stored
   * as a fraction of it, and the fraction can only be worked out from where
   * the click landed relative to the rendered page.
   */
  function renderPdfPage(lib, data, pageNumber, canvas, targetWidth) {
    return lib.getDocument({ data: data.slice(0) }).promise.then(function (pdf) {
      return pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages)).then(function (page) {
        var natural = page.getViewport({ scale: 1 });
        var scale = targetWidth / natural.width;
        var viewport = page.getViewport({ scale: scale });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport })
          .promise.then(function () { return { pages: pdf.numPages }; });
      });
    });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('read failed')); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Five megabytes, and how a five-megabyte file gets there.
   *
   * The platform refuses a request body over about 4.5 MB, and base64 adds a
   * third on top, so anything over roughly 2 MB goes up in pieces: the file
   * is sliced, each slice is sent on its own, and the server appends them
   * into one row (see putSourcePart in api/documents.js). The last piece is
   * what turns the pieces into the document's editable original, so an
   * upload cut off halfway leaves nothing half-attached.
   */
  var MAX_SOURCE_BYTES = 5 * 1024 * 1024;
  var SOURCE_PART_BYTES = 1400 * 1024;

  function sendSourceInParts(docId, source, onProgress) {
    var file = source.file;
    var parts = Math.max(1, Math.ceil(file.size / SOURCE_PART_BYTES));
    var index = 0;
    function next() {
      if (index >= parts) return Promise.resolve();
      var slice = file.slice(index * SOURCE_PART_BYTES, (index + 1) * SOURCE_PART_BYTES);
      return fileToBase64(slice).then(function (b64) {
        return api('/api/documents?do=source-part', {
          method: 'POST',
          body: { id: docId, name: source.name, part: index, parts: parts, data: b64 },
        });
      }).then(function () {
        index += 1;
        if (onProgress) onProgress(index, parts);
        return next();
      });
    }
    return next();
  }

  var DOC_STAGE_TH = {
    approving: 'กำลังรออนุมัติ', secretary: 'รอเลขาฯ ส่ง',
    done: 'อนุมัติครบแล้ว', sent: 'ส่งแล้ว', rejected: 'ถูกตีกลับ',
  };

  function pageDocs(main) {
    var secBtn = h('button', {
      class: 'btn', text: t('docSecretaries'), hidden: !S.mayManageSecretaries,
      onclick: function () { openSecretaries(); },
    });

    /**
     * Pushes the roster's full names into the register's รายชื่อผู้รับผิดชอบ
     * lists — the other half of linking the two.
     *
     * A button rather than something automatic: it is forty-odd writes to the
     * committee's own spreadsheet, and doing that every time somebody edits
     * their profile would be rude to the sheet and slow for them.
     */
    var namesBtn = h('button', {
      class: 'btn', text: t('docSyncNames'),
      hidden: !(S.mayManageSecretaries && S.registerReady),
      onclick: function (e) {
        e.target.disabled = true;
        api('/api/documents?do=names', { method: 'POST' }).then(function (d) {
          var said = t('docSyncNamesDone').replace('%n', String(d.written.length));
          if (d.withoutFullName.length) {
            said += '  \u00b7  ' + t('docSyncNamesMissing')
              .replace('%n', String(d.withoutFullName.length));
          }
          alert(said);
          e.target.disabled = false;
        }).catch(function (err) { alert(errText(err.code)); e.target.disabled = false; });
      },
    });

    main.appendChild(h('div', { class: 'page-head' }, [
      h('h1', { text: t('navDocs') }),
      h('span', { class: 'grow' }),
      namesBtn,
      secBtn,
      // On a phone the + button in the corner does this.
      isPhone() ? null : h('button', { class: 'btn primary', text: t('docNew'), onclick: function () { openDocUpload(); } }),
    ]));

    /**
     * Narrowing the pile.
     *
     * A secretary can see every document in the committee, which is correct
     * and useless: the ones that matter to them are the ones that land on
     * their desk to send. "ที่ฉันดูแล" is that list, and is only offered to
     * the people for whom it means anything.
     */
    var filters = h('div', { class: 'seg wrap' });
    main.appendChild(filters);

    var list = h('div', { class: 'doc-list' });
    main.appendChild(list);

    function matching() {
      if (S.docFilter === 'turn') {
        return S.docs.filter(function (d) { return d.myTurn; });
      }
      if (S.docFilter === 'secretary') {
        return S.docs.filter(function (d) { return d.secretary === S.user.username; });
      }
      if (S.docFilter === 'open') {
        return S.docs.filter(function (d) { return !d.sentAt && d.stage !== 'rejected'; });
      }
      return S.docs;
    }

    function drawFilters() {
      clear(filters);
      var choices = [
        { key: 'all', label: t('docFilterAll'), count: S.docs.length },
        { key: 'turn', label: t('docFilterMyTurn'),
          count: S.docs.filter(function (d) { return d.myTurn; }).length },
        { key: 'open', label: t('docFilterOpen'),
          count: S.docs.filter(function (d) { return !d.sentAt && d.stage !== 'rejected'; }).length },
      ];
      if (S.isSecretary) {
        choices.push({ key: 'secretary', label: t('docFilterMine'),
          count: S.docs.filter(function (d) { return d.secretary === S.user.username; }).length });
      }
      choices.forEach(function (c) {
        filters.appendChild(h('button', {
          type: 'button', class: S.docFilter === c.key ? 'on' : '',
          text: c.label + ' (' + c.count + ')',
          onclick: function () { S.docFilter = c.key; drawFilters(); draw(); },
        }));
      });
    }

    function draw() {
      clear(list);
      var shown = matching();
      if (!shown.length) {
        // With nothing at all, say what this page is for and how to start, not only that it is empty.
        list.appendChild(h('div', { class: 'empty' }, S.docs.length ? [h('strong', { text: t('docNoneMatch') })] : [
          h('strong', { text: t('docNone') }),
          h('p', { class: 'empty-help', text: t('docNoneHelp') }),
          h('button', { class: 'btn primary', type: 'button', text: t('docNoneAction'), onclick: function () { openDocUpload(); } }),
        ]));
        return;
      }
      shown.forEach(function (doc) {
        list.appendChild(docCard(doc));
      });
    }

    api('/api/documents').then(function (data) {
      S.docs = data.documents || [];
      S.mayManageSecretaries = Boolean(data.mayManageSecretaries);
      S.isSecretary = Boolean(data.isSecretary);
      S.registerReady = Boolean(data.registerReady);
      if (data.myFullName && !S.user.fullName) S.user.fullName = data.myFullName;
      secBtn.hidden = !S.mayManageSecretaries;
      namesBtn.hidden = !(S.mayManageSecretaries && S.registerReady);
      // A secretary lands on their own pile; everyone else on everything.
      if (!S.docFilter) S.docFilter = S.isSecretary ? 'secretary' : 'all';
      drawFilters();
      draw();
      // A link from a notification asked for one in particular.
      if (S.openDocId) {
        var wanted = S.openDocId;
        S.openDocId = null;
        if (S.docs.some(function (d) { return d.id === wanted; })) openDoc(wanted);
        else alert(t('docNotFound'));
      }
    }).catch(function (err) {
      clear(list);
      list.appendChild(h('div', { class: 'notice err', text: errText(err.code) }));
    });

    draw();
  }

  function docCard(doc) {
    var waiting = doc.waitingOn ? nameOf(doc.waitingOn) : '—';
    return h('button', {
      class: 'doc-card' + (doc.myTurn ? ' mine' : '') + (doc.stage === 'rejected' ? ' bad' : ''),
      onclick: function () { openDoc(doc.id); },
    }, [
      h('div', { class: 'dc-top' }, [
        // The committee's own number, once it has one — that is what people
        // quote to each other and to whoever received the letter.
        doc.docNumber ? h('span', { class: 't-code', text: doc.docNumber }) : null,
        h('span', { class: 'dc-title', text: doc.title }),
        doc.priority && doc.priority !== 'medium'
          ? h('span', { class: 'chip prio prio-' + doc.priority, text: prioLabel(doc.priority) }) : null,
        doc.myTurn ? h('span', { class: 'chip who', text: t('docYourTurn') }) : null,
      ]),
      h('div', { class: 'dc-bar' }, [
        h('i', { style: 'width:' + Math.round((doc.progress || 0) * 100) + '%' }),
      ]),
      h('div', { class: 'dc-meta', text:
        (DOC_STAGE_TH[doc.stage] || doc.stage) +
        (doc.stage === 'approving' || doc.stage === 'secretary'
          ? ' · ' + t('docWaitingOn') + ' ' + waiting : '') +
        ' · ' + stampDate(doc.createdAt) }),
    ]);
  }


  /**
   * The secretariat: who is in it, and how documents are shared out.
   *
   * Open to the head secretaries and the admins only — being an ordinary
   * secretary means seeing every document, which is exactly why an ordinary
   * secretary must not be able to appoint more of them.
   */
  function openSecretaries() {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var bodyBox = h('div', { class: 'body' });
    var modal = h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h2', { text: t('docSecretaries') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      bodyBox,
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('close'), onclick: function () { veil.remove(); } }),
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);

    function send(change) {
      api('/api/documents?do=secretaries', { method: 'POST', body: change })
        .then(draw).catch(function (err) { alert(errText(err.code)); });
    }

    function draw(data) {
      clear(bodyBox);
      var pane = h('div', { class: 'pane' });

      pane.appendChild(h('p', { class: 'view-desc', text: t('docSecretariesHint') }));

      // Who is in it now. Each name removes itself; the last one cannot.
      var chips = h('div', { class: 'access-cell' }, data.secretaries.map(function (s) {
        return h('span', {
          class: 'chip who x', title: t('docRemoveSecretary'),
          onclick: function () {
            if (!confirm(t('docRemoveSecretarySure').replace('%s', s.displayName || s.username))) return;
            send({ remove: s.username });
          },
        }, [
          avatarNode(s.username, 'sm'),
          (s.isHead ? '★ ' : '') + (s.displayName || s.username) + ' ✕',
        ]);
      }));

      var add = h('select', {
        class: 'add-dept',
        onchange: function (e) {
          var who = e.target.value;
          e.target.value = '';
          if (who) send({ add: who });
        },
      }, [h('option', { value: '', text: '+ ' + t('docAddSecretary') })]
        .concat(data.candidates.map(function (p) {
          return h('option', { value: p.username, text: (p.displayName || p.username) + (p.position ? ' · ' + p.position : '') });
        })));
      chips.appendChild(add);
      pane.appendChild(vRow(t('docSecretaryList'), chips));

      /**
       * How a new document picks its secretary. Random spreads the load;
       * "by department" honours the mapping below and falls back to random for
       * any department nobody has been given.
       */
      var mode = h('select', {
        class: 'add-dept',
        onchange: function (e) { send({ mode: e.target.value }); },
      }, [
        h('option', { value: 'random', selected: data.mode === 'random', text: t('docAssignRandom') }),
        h('option', { value: 'department', selected: data.mode === 'department', text: t('docAssignByDept') }),
      ]);
      pane.appendChild(vRow(t('docAssignMode'), mode));

      if (data.mode === 'department') {
        var table = h('div', { class: 'view-rows' }, S.departments.map(function (d) {
          var pick = h('select', {
            class: 'add-dept',
            onchange: function (e) {
              var body = { byDepartment: {} };
              body.byDepartment[d.key] = e.target.value;
              send(body);
            },
          }, [h('option', { value: '', text: t('docAssignNobody') })]
            .concat(data.secretaries.map(function (s) {
              return h('option', {
                value: s.username, selected: data.byDepartment[d.key] === s.username,
                text: s.displayName || s.username,
              });
            })));
          return vRow(deptLabel(d.key), pick);
        }));
        pane.appendChild(table);
      }

      bodyBox.appendChild(pane);
    }

    api('/api/documents?do=secretaries').then(draw).catch(function (err) {
      clear(bodyBox);
      bodyBox.appendChild(h('div', { class: 'notice err', text: errText(err.code) }));
    });
  }

  /**
   * Submitting a document.
   *
   * Three stages in one dialog: what it is, who must sign it, and where their
   * signatures go. The last one is the reason this is a dialog and not a form —
   * the page has to be visible to point at.
   */
  function openDocUpload() {
    var draft = { title: '', note: '', recipient: '', priority: 'medium',
                  department: S.user.department || null, unit: S.user.unit || null,
                  // Who posts the finished letter, and how เลขานุการ reaches
                  // the recipient when it is them — see the เอกสาร section of
                  // api/documents.js.
                  sendMode: 'secretary', recipientEmail: '', internalUnit: false };
    var pdfBase64 = null;
    var pdfBytes = null;
    // The optional Word original, kept out here beside the PDF because
    // submit() is a sibling of the form that collects it.
    var sourceFile = null;
    var pages = 0;
    var chain = [];
    var people = [];
    var roleChoices = [];
    var stage = 'details';
    var marking = null;          // which step we are placing a box for
    var pageShown = 1;

    var notice = h('div', { class: 'notice err', hidden: true });
    var bodyBox = h('div', { class: 'body' });
    var footer = h('footer', {});

    function fail(message) {
      notice.hidden = false;
      notice.textContent = message;
    }

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var modal = h('div', { class: 'modal wide' }, [
      h('header', {}, [
        h('h2', { text: t('docNew') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      bodyBox, footer,
    ]);

    /* ---- stage 1: what it is ---- */
    function drawDetails() {
      clear(bodyBox); clear(footer);
      var title = h('input', { type: 'text', maxlength: '200', value: draft.title,
        placeholder: t('docTitlePlaceholder') });
      var note = h('textarea', { maxlength: '2000', rows: '2', placeholder: t('docNotePlaceholder') });
      note.value = draft.note;
      var recipient = h('input', { type: 'text', maxlength: '200', value: draft.recipient,
        placeholder: t('docRecipientPlaceholder') });

      var prio = h('div', { class: 'seg wrap' }, PRIORITY_LIST.slice().reverse().map(function (p) {
        return h('button', {
          type: 'button', class: 'prio-btn prio-' + p + (draft.priority === p ? ' on' : ''),
          text: prioLabel(p),
          onclick: function (e) {
            draft.priority = p;
            prio.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
            e.target.classList.add('on');
          },
        });
      }));

      /**
       * The section, beside the ฝ่าย.
       *
       * Not decoration: the committee numbers letters per section, so this is
       * what decides whether a letter is อบจ.จฬฟ. 03-001 or 03.01-001. It
       * defaults to the uploader's own section, which is right almost always.
       */
      var unitSelect = h('select', {});
      function fillUnits() {
        clear(unitSelect);
        var dept = S.departments.filter(function (d) { return d.key === draft.department; })[0];
        unitSelect.appendChild(h('option', { value: '', text: t('noUnit') }));
        (dept && dept.units ? dept.units : []).forEach(function (name) {
          unitSelect.appendChild(h('option', {
            value: name, text: name, selected: draft.unit === name,
          }));
        });
        unitSelect.disabled = !(dept && dept.units && dept.units.length);
      }
      unitSelect.addEventListener('change', function () { draft.unit = unitSelect.value || null; });

      var deptSelect = h('select', {
        onchange: function (e) {
          draft.department = e.target.value || null;
          draft.unit = null;
          fillUnits();
        },
      }, [h('option', { value: '', text: t('noDepartment') })].concat(
        myDepartments().map(function (d) {
          return h('option', { value: d.key, text: deptOptionLabel(d), selected: draft.department === d.key });
        })));

      /**
       * Who sends the finished letter, and where to.
       *
       * Some ฝ่าย deal with their own recipients and going through เลขานุการ
       * only adds a day; others need the secretariat to send on their behalf,
       * and then the address has to travel with the letter. A letter that
       * stays inside Chula needs no address at all, which is what the tick box
       * is for — asking for one would be asking for something that does not
       * exist.
       */
      var sendBox = h('div', { class: 'field' });
      function drawSend() {
        clear(sendBox);
        sendBox.appendChild(h('label', { text: t('docWhoSends') }));
        sendBox.appendChild(h('div', { class: 'seg wrap' }, [
          ['secretary', 'docSendBySecretary'], ['self', 'docSendMyself'],
        ].map(function (pair) {
          return h('button', {
            type: 'button', class: draft.sendMode === pair[0] ? 'on' : '', text: t(pair[1]),
            onclick: function () { draft.sendMode = pair[0]; drawSend(); },
          });
        })));
        sendBox.appendChild(h('small', { class: 'field-hint',
          text: t(draft.sendMode === 'self' ? 'docSendMyselfWhy' : 'docSendBySecretaryWhy') }));
        if (draft.sendMode !== 'secretary') return;

        var inside = h('input', { type: 'checkbox', checked: draft.internalUnit });
        var mail = h('input', {
          type: 'text', value: draft.recipientEmail, maxlength: '400',
          placeholder: t('docEmailPlaceholder'), disabled: draft.internalUnit,
        });
        mail.addEventListener('input', function () { draft.recipientEmail = mail.value; });
        inside.addEventListener('change', function () {
          draft.internalUnit = inside.checked;
          mail.disabled = inside.checked;
        });
        sendBox.appendChild(h('div', { class: 'field', style: 'margin-top:8px' }, [
          h('label', { text: t('docRecipientEmail') }), mail,
          h('label', { class: 'inline-check' }, [inside, t('docInsideChula')]),
        ]));
      }

      var fileInput = h('input', { type: 'file', id: 'doc-pdf', accept: 'application/pdf,.pdf' });
      var fileNote = h('p', { class: 'hint', text: t('docPdfHelp') });

      /**
       * The Word original, alongside the PDF.
       *
       * Letters come back to be corrected, and a PDF is no use for that —
       * asked for by เลขานุการ, who were the ones finding the mistakes. It is
       * optional: a letter that arrived as a PDF from somewhere else has no
       * editable original to attach.
       */
      var srcInput = h('input', {
        type: 'file', id: 'doc-source',
        accept: '.docx,.doc,.odt,.rtf,.pages,application/msword,' +
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      var srcNote = h('p', { class: 'hint', text: t('docSourceHelp') });
      var srcClear = h('button', {
        type: 'button', class: 'btn sm ghost', hidden: true, text: t('remove'),
        onclick: function () {
          sourceFile = null; srcInput.value = '';
          srcNote.textContent = t('docSourceHelp'); srcClear.hidden = true;
        },
      });
      srcInput.addEventListener('change', function () {
        var file = srcInput.files && srcInput.files[0];
        if (!file) return;
        if (file.size > MAX_SOURCE_BYTES) { fail(t('docTooBig')); srcInput.value = ''; return; }
        notice.hidden = true;
        /**
         * Over two megabytes the file does not travel with the letter.
         *
         * Vercel refuses a request body over about 4.5 MB and base64 adds a
         * third, so a five-megabyte .docx cannot ride along with the PDF in
         * the create call. The big ones are kept aside and sent in pieces
         * once the letter exists — see sendSourceInParts.
         */
        var big = file.size > 2 * 1024 * 1024;
        var shown = file.name + ' · ' + Math.round(file.size / 1024) + ' KB';
        if (big) {
          sourceFile = { name: file.name, file: file, big: true };
          srcNote.textContent = shown;
          srcClear.hidden = false;
          return;
        }
        fileToBase64(file).then(function (b64) {
          sourceFile = { name: file.name, data: b64 };
          srcNote.textContent = shown;
          srcClear.hidden = false;
        }).catch(function () { fail(t('errGeneric')); });
      });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) {
          fail(t('docTooBig'));
          fileInput.value = '';
          return;
        }
        notice.hidden = true;
        fileToBase64(file).then(function (b64) {
          pdfBase64 = b64;
          pdfBytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
          fileNote.textContent = file.name + ' · ' + Math.round(file.size / 1024) + ' KB';
        }).catch(function () { fail(t('errGeneric')); });
      });

      /**
       * The uploader's own name, asked for once.
       *
       * It goes in the ผู้รับผิดชอบ column of the committee's register, where
       * a username or "Kungking - Head Content" would be no use to whoever
       * reads the book of letters later. Asked here because this is where it
       * is needed, shown as already answered once it has been given, and kept
       * on the profile afterwards.
       */
      var fullName = h('input', {
        type: 'text', maxlength: '120', value: S.user.fullName || '',
        placeholder: t('fullNamePlaceholder'),
      });

      bodyBox.appendChild(h('div', { class: 'pane' }, [
        notice,
        h('div', { class: 'field' }, [
          h('label', { text: t('docResponsible') }),
          fullName,
          h('small', { style: 'color:var(--ink-faint);font-size:12px', text: t('fullNameWhy') }),
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('docTitle') }), title]),
        h('div', { class: 'field' }, [h('label', { text: t('docNote') }), note]),
        h('div', { class: 'field' }, [h('label', { text: t('docRecipient') }), recipient]),
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('teamspace') }), deptSelect]),
          h('div', { class: 'field' }, [
            h('label', { text: t('unit') }),
            unitSelect,
            h('small', { style: 'color:var(--ink-faint);font-size:12px', text: t('docUnitWhy') }),
          ]),
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('priority') }), prio]),
        sendBox,
        h('div', { class: 'field' }, [h('label', { for: 'doc-pdf', text: t('docPdf') }), fileInput, fileNote]),
        h('div', { class: 'field' }, [
          h('label', { for: 'doc-source' }, [t('docSource'), h('small', { class: 'opt-tag', text: t('optional') })]),
          srcInput, srcNote, srcClear,
        ]),
      ]));
      fillUnits();
      drawSend();

      footer.appendChild(h('button', {
        class: 'btn primary', text: t('docNext'),
        onclick: function () {
          draft.title = title.value.trim();
          draft.note = note.value.trim();
          draft.recipient = recipient.value.trim();
          draft.fullName = fullName.value.trim();
          if (!draft.fullName) { fail(t('docNeedFullName')); fullName.focus(); return; }
          if (!draft.title) { fail(t('docNeedTitle')); return; }
          if (!pdfBase64) { fail(t('docNeedPdf')); return; }
          if (draft.sendMode === 'secretary' && !draft.internalUnit &&
              !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(draft.recipientEmail.split(/[\s,;]+/)[0] || '')) {
            fail(t('docNeedEmail')); return;
          }
          // Remembered locally as well, so the field is pre-filled next time
          // even before the page has been reloaded.
          S.user.fullName = draft.fullName;
          notice.hidden = true;
          loadChain();
        },
      }));
      footer.appendChild(h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }));
    }

    function loadChain() {
      api('/api/documents?do=propose', {
        method: 'POST',
        body: { department: draft.department, unit: draft.unit, sendMode: draft.sendMode },
      }).then(function (data) {
        chain = data.steps.map(function (s) {
          return { role: s.role, roleLabel: s.roleLabel, username: s.username,
                   options: s.options, signs: s.signs, marks: [] };
        });
        people = data.people;
        roleChoices = data.roles || [];
        stage = 'who';
        drawWho();
      }).catch(function (err) { fail(errText(err.code)); });
    }

    /* ---- stage 2: who signs ---- */
    /**
     * The chain, as something you can actually edit.
     *
     * It used to be a fixed list of three dropdowns, which was wrong in two
     * ways she ran into on the same letter: a ฝ่าย with two ประธาน had nowhere
     * to put the second signature, and a letter from อำนวยการ 2 had no way to
     * pass through อำนวยการใหญ่ before ประธานโครงการ. So every row can now be
     * added, removed, moved and have its role changed.
     *
     * The last row is the exception. Somebody has to send the finished letter,
     * exactly one person does, and it must happen after the last signature —
     * so that row is fixed in place and only its person can change.
     */
    function sendingStep() {
      return chain.filter(function (s) { return s.role === 'secretary' || s.role === 'sender'; })[0] || null;
    }

    /** Who the roster says holds this role, in the order the server ranked them. */
    function candidatesFor(role) {
      var found = roleChoices.filter(function (r) { return r.role === role; })[0];
      return (found && found.options) || [];
    }

    /**
     * The people offered for one row.
     *
     * Whoever holds that post first, under the role's own name — a row that
     * says ประธานโครงการ should offer the three people who are, not a hundred
     * names in roster order. Everybody else is still there underneath, by
     * ฝ่าย, because the roster is never quite right and the form must never
     * be the reason a letter cannot be sent.
     */
    function personOptions(step) {
      var find = function (u) {
        return people.filter(function (p) { return p.username === u; })[0] || { username: u };
      };
      var label = function (p) {
        return (p.displayName || p.username) + (p.position ? ' \u00b7 ' + p.position : '');
      };
      var option = function (p) {
        return h('option', { value: p.username, text: label(p), selected: step.username === p.username });
      };

      var best = (step.options || []).slice();
      var taken = {};
      best.forEach(function (u) { taken[u] = true; });

      var groups = [];
      if (best.length) {
        groups.push(h('optgroup', { label: step.roleLabel || '' }, best.map(function (u) { return option(find(u)); })));
      }
      var byDept = {};
      people.forEach(function (p) {
        if (taken[p.username]) return;
        (byDept[p.department || ''] = byDept[p.department || ''] || []).push(p);
      });
      Object.keys(byDept).sort().forEach(function (key) {
        groups.push(h('optgroup', {
          label: (best.length ? t('docAnyoneElse') + ' \u00b7 ' : '') + (key ? deptLabel(key) : '\u2014'),
        }, byDept[key].map(option)));
      });
      return groups;
    }

    function drawWho() {
      clear(bodyBox); clear(footer);
      var sendStep = sendingStep();

      var rows = chain.map(function (step, i) {
        var isSending = step === sendStep;
        var locked = isSending || step.role === 'author';

        var person = h('select', {
          onchange: function (e) { step.username = e.target.value || null; },
        }, [h('option', { value: '', text: t('docPickPerson') })].concat(personOptions(step)));
        // The writer signs their own letter and nobody else can; so does the
        // person who said they would post it themselves.
        person.disabled = step.role === 'author' || step.role === 'sender';

        var roleSelect = h('select', {
          class: 'chain-role',
          onchange: function (e) {
            step.role = e.target.value;
            step.roleLabel = (roleChoices.filter(function (r) { return r.role === step.role; })[0] || {}).label || step.role;
            /**
             * A different role is a different question, so the row takes that
             * role's own people — and the person on it, unless they hold the
             * new post too. Keeping the old name was how a row could end up
             * saying ประธานโครงการ above somebody who is not one.
             */
            step.options = candidatesFor(step.role);
            if (step.options.length && step.options.indexOf(step.username) === -1) {
              step.username = step.options[0];
            }
            step.signs = step.role !== 'unitHead';
            drawWho();
          },
        }, roleChoices.map(function (r) {
          return h('option', { value: r.role, text: r.label, selected: step.role === r.role });
        }));

        var signBox = h('input', { type: 'checkbox', checked: step.signs, disabled: isSending });
        signBox.addEventListener('change', function () {
          step.signs = signBox.checked;
          if (!step.signs) step.marks = [];
        });

        var move = function (by) {
          return h('button', {
            type: 'button', class: 'btn ghost sm', text: by < 0 ? '\u2191' : '\u2193',
            disabled: locked || i + by < 0 || i + by >= chain.length - 1 ||
              chain[i + by].role === 'author',
            onclick: function () {
              var other = chain[i + by];
              chain[i + by] = step; chain[i] = other;
              drawWho();
            },
          });
        };

        return h('div', { class: 'chain-row' + (isSending ? ' sending' : '') }, [
          h('span', { class: 'chain-n', text: String(i + 1) }),
          h('div', { class: 'chain-main' }, [
            h('div', { class: 'chain-head' }, [
              locked
                ? h('label', { text: step.roleLabel || step.role })
                : roleSelect,
              h('span', { class: 'grow' }),
              isSending ? null : h('label', { class: 'inline-check sm' }, [signBox, t('docSigns')]),
              move(-1), move(1),
              h('button', {
                type: 'button', class: 'btn ghost sm danger', text: '\u2715',
                title: t('docRemoveSigner'), disabled: locked,
                onclick: function () {
                  chain = chain.filter(function (x) { return x !== step; });
                  drawWho();
                },
              }),
            ]),
            person,
            isSending ? h('small', { class: 'field-hint', text: t(step.role === 'sender' ? 'docSenderIsYou' : 'docSecretarySends') }) : null,
          ]),
        ]);
      });

      bodyBox.appendChild(h('div', { class: 'pane' }, [
        notice,
        h('p', { class: 'hint', text: t('docChainHelp') }),
        h('div', { class: 'chain' }, rows),
        h('button', {
          type: 'button', class: 'btn add-signer', text: '+ ' + t('docAddSigner'),
          onclick: function () {
            var at = chain.indexOf(sendingStep());
            var picks = candidatesFor('deptHead');
            var step = { role: 'deptHead', roleLabel: (roleChoices.filter(function (r) { return r.role === 'deptHead'; })[0] || {}).label || 'deptHead',
                         username: picks[0] || null, options: picks, signs: true, marks: [] };
            chain.splice(at < 0 ? chain.length : at, 0, step);
            drawWho();
          },
        }),
      ]));

      footer.appendChild(h('button', {
        class: 'btn primary', text: t('docNext'),
        onclick: function () {
          var blank = chain.filter(function (s) { return !s.username; });
          if (blank.length) { fail(t('docPickEveryone')); return; }
          var twice = chain.filter(function (s, i) {
            return chain.findIndex(function (x) { return x.username === s.username; }) !== i &&
              s.role !== 'sender' && s.role !== 'secretary';
          });
          if (twice.length) { fail(t('docSamePersonTwice').replace('%n', nameOf(twice[0].username))); return; }
          notice.hidden = true;
          stage = 'marks';
          drawMarks();
        },
      }));
      footer.appendChild(h('button', { class: 'btn', text: t('back'), onclick: drawDetails }));
    }

    /* ---- stage 3: where the signatures go ---- */
    function drawMarks() {
      clear(bodyBox); clear(footer);
      var needMarks = chain.filter(function (s) { return s.signs; });
      if (!needMarks.length) { submit(); return; }

      // A step that has been removed since cannot be the one being placed.
      if (needMarks.indexOf(marking) === -1) marking = needMarks[0];
      var canvas = h('canvas', { class: 'pdf-canvas' });
      var overlay = h('div', { class: 'pdf-overlay' });
      var sheet = h('div', { class: 'pdf-sheet' }, [canvas, overlay]);
      var pager = h('div', { class: 'pdf-pager' });

      /** What we know about each signer's saved signature. */
      var sigOf = function (username) {
        var p = people.filter(function (x) { return x.username === username; })[0];
        return p && p.hasSignature ? p : null;
      };
      /** The page's own proportions, so a box is sized against the real sheet. */
      var pageAspect = function () {
        return (canvas.width && canvas.height) ? (canvas.width / canvas.height) : 0.707;
      };

      var who = h('div', { class: 'seg wrap' }, needMarks.map(function (step) {
        return h('button', {
          type: 'button', class: marking === step ? 'on' : '',
          onclick: function () { marking = step; drawMarks(); },
        }, [
          step.marks.length ? h('span', { class: 'who-n', text: '\u2713' + step.marks.length }) : null,
          nameOf(step.username),
          sigOf(step.username) ? null : h('span', { class: 'no-sig-dot', title: t('docNoSignatureYet'), text: '!' }),
        ]);
      }));

      function paintOverlay() {
        clear(overlay);
        chain.forEach(function (s) {
          (s.marks || []).forEach(function (m) {
            if (m.page !== pageShown) return;
            var sig = sigOf(s.username);
            overlay.appendChild(h('div', {
              class: 'sig-box' + (s === marking ? ' on' : '') + (sig ? ' real' : ' empty'),
              style: 'left:' + (m.x * 100) + '%;top:' + (m.y * 100) + '%;' +
                     'width:' + (m.w * 100) + '%;height:' + (m.h * 100) + '%',
              title: nameOf(s.username),
            }, [
              // The real thing, fitted exactly as the stamp will fit it.
              sig ? signatureImg(s.username) : null,
              h('span', { class: 'sig-name', text: nameOf(s.username) }),
            ]));
          });
        });
      }

      /**
       * How big this person's signature should be, in one slider.
       *
       * Seeing the real signature is only half of it — the other half is
       * being able to do something about it. The slider is the width of the
       * box as a fraction of the page; the height follows the signature's own
       * proportions, so it never stretches. It moves every box this person
       * has, because somebody signing in three places wants them the same.
       */
      var sizePct = h('span', { class: 'sig-size-n' });
      var sizeIn = h('input', {
        type: 'range', min: '8', max: '45', step: '1', class: 'sig-size',
        value: String(Math.round((marking.marks[0] ? marking.marks[0].w : 0.26) * 100)),
      });
      function paintSize() {
        var pct = Number(sizeIn.value);
        sizePct.textContent = pct + '%';
        sizeIn.disabled = !marking.marks.length;
      }
      sizeIn.addEventListener('input', function () {
        var want = Number(sizeIn.value) / 100;
        var box = sigBoxSize(sigOf(marking.username), pageAspect(), want);
        marking.marks.forEach(function (m) {
          // Grown about its own centre, so it does not crawl across the page.
          m.x = Math.max(0, Math.min(1 - box.w, m.x + (m.w - box.w) / 2));
          m.y = Math.max(0, Math.min(1 - box.h, m.y + (m.h - box.h) / 2));
          m.w = box.w; m.h = box.h;
        });
        paintSize();
        paintOverlay();
      });

      var sizeRow = h('div', { class: 'sig-size-row' }, [
        h('label', { text: t('docSigSize') }), sizeIn, sizePct,
      ]);

      /**
       * A tap puts the box's CENTRE where the finger went.
       *
       * Measured against the canvas rather than the window, and stored as a
       * fraction of it, so the same box lands in the same place whether this
       * was drawn on a phone or a desktop and whatever size the PDF's pages are.
       */
      function place(e) {
        var rect = canvas.getBoundingClientRect();
        if (!rect.width) return;
        var point = e.touches && e.touches[0] ? e.touches[0] : e;
        // The box is the signature's own shape at the width the slider says,
        // so what is drawn on screen is the size it will be stamped.
        var want = Number(sizeIn.value) / 100;
        var size = sigBoxSize(sigOf(marking.username), pageAspect(), want);
        var w = size.w;
        var hh = size.h;
        var fx = (point.clientX - rect.left) / rect.width;
        var fy = (point.clientY - rect.top) / rect.height;

        /**
         * Tapping one of your own boxes takes it away again.
         *
         * A signer may need several spots — an initial on every page as well
         * as a signature at the end — so a tap ADDS rather than replaces, and
         * the only way back from a misplaced box would otherwise be to start
         * the upload over.
         */
        var hit = -1;
        marking.marks.forEach(function (m, i) {
          if (m.page === pageShown && fx >= m.x && fx <= m.x + m.w &&
              fy >= m.y && fy <= m.y + m.h) hit = i;
        });
        if (hit >= 0) {
          marking.marks.splice(hit, 1);
        } else {
          marking.marks.push({
            page: pageShown,
            x: Math.max(0, Math.min(1 - w, fx - w / 2)),
            y: Math.max(0, Math.min(1 - hh, fy - hh / 2)),
            w: w, h: hh,
          });
        }
        paintOverlay();
        paintSize();
        drawFooter();
      }
      sheet.addEventListener('click', place);

      bodyBox.appendChild(h('div', { class: 'pane' }, [
        notice,
        // One instruction, not two saying the same thing in different words.
        h('p', { class: 'hint', text: t('docMarkHelp') }),
        who,
        h('p', { class: 'hint', text: t('docMarkAdd') }),
        // Said plainly rather than left as an empty box they cannot explain.
        sigOf(marking.username) ? null : h('div', { class: 'notice warn', text: t('docNoSignatureFor').replace('%s', nameOf(marking.username)) }),
        sizeRow,
        pager,
        sheet,
      ]));
      paintSize();

      function drawPager() {
        clear(pager);
        if (pages < 2) return;
        pager.appendChild(h('button', {
          class: 'btn sm', text: '‹', disabled: pageShown <= 1,
          onclick: function () { pageShown--; show(); },
        }));
        pager.appendChild(h('span', { text: t('docPage') + ' ' + pageShown + ' / ' + pages }));
        pager.appendChild(h('button', {
          class: 'btn sm', text: '›', disabled: pageShown >= pages,
          onclick: function () { pageShown++; show(); },
        }));
      }

      function show() {
        withPdfJs().then(function (lib) {
          return renderPdfPage(lib, pdfBytes, pageShown, canvas, 900);
        }).then(function (info) {
          pages = info.pages;
          drawPager();
          paintOverlay();
        }).catch(function () { fail(t('docPdfViewFailed')); });
      }
      show();

      function drawFooter() {
        clear(footer);
        var ready = needMarks.every(function (s) { return s.marks.length; });
        footer.appendChild(h('button', {
          class: 'btn primary', text: t('docSubmit'), disabled: !ready, onclick: submit,
        }));
        footer.appendChild(h('button', { class: 'btn', text: t('back'), onclick: drawWho }));
        if (!ready) {
          footer.appendChild(h('span', { class: 'hint',
            text: t('docMarkRemaining').replace('{n}',
              String(needMarks.filter(function (s) { return !s.marks.length; }).length)) }));
        }
      }
      drawFooter();
    }

    function submit() {
      clear(footer);
      footer.appendChild(h('span', { class: 'hint', text: t('docSending') }));
      api('/api/documents?do=create', {
        method: 'POST',
        body: {
          title: draft.title, note: draft.note, recipient: draft.recipient,
          fullName: draft.fullName,
          priority: draft.priority, department: draft.department, unit: draft.unit,
          sendMode: draft.sendMode,
          recipientEmail: draft.sendMode === 'secretary' && !draft.internalUnit ? draft.recipientEmail : '',
          internalUnit: draft.sendMode === 'secretary' && draft.internalUnit,
          pdf: pdfBase64,
          source: sourceFile && !sourceFile.big ? sourceFile : null,
          steps: chain.map(function (s) {
            // `signs` goes with it: a step the sender unticked must not have a
            // box demanded of it at the far end.
            return { role: s.role, username: s.username, signs: s.signs !== false, marks: s.marks };
          }),
        },
      }).then(function (data) {
        // The big editable original follows the letter, in pieces.
        var after = (sourceFile && sourceFile.big && data && data.id)
          ? sendSourceInParts(data.id, sourceFile).catch(function () {
            // The letter is in; say what did not make it rather than losing
            // the submission over an attachment.
            alert(t('docSourceLater'));
          })
          : Promise.resolve();
        after.then(function () {
          api('/api/documents').then(function (fresh) {
            S.docs = fresh.documents || [];
            renderPage();
          });
        });
        /**
         * The เลขรันเอกสาร, said once and clearly.
         *
         * It is taken from the committee's own sheet the moment the letter is
         * submitted, and it has to be written onto the letter — so it gets a
         * panel of its own rather than being a line in a document view the
         * person has to go and find.
         */
        showNumber(data);
      }).catch(function (err) {
        var code = err.data && err.data.error;
        /**
         * Say WHOSE box is missing. "At least one spot is needed" sent people
         * back to a page where everybody visible already had one.
         */
        var who = (err.data && err.data.who) || [];
        fail(code === 'FILE_TOO_BIG' || code === 'SOURCE_TOO_BIG'
          ? t('docTooBig')
          : (code === 'MARK_REQUIRED' && who.length
            ? t('docMarkMissingFor').replace('%s', who.map(function (u) { return nameOf(u); }).join(', '))
            : errText(err.code)));
        // Back to whoever is missing one, rather than whoever was last picked.
        var blame = chain.filter(function (s) { return who.indexOf(s.username) !== -1; })[0];
        if (blame) { blame.signs = true; marking = blame; }
        drawMarks();
      });
    }

    function showNumber(data) {
      clear(bodyBox); clear(footer);
      var got = data.numbering && data.numbering.ok;
      bodyBox.appendChild(h('div', { class: 'pane doc-done' }, [
        h('div', { class: 'gd-card done' }, [
          guideIcon('check'),
          h('b', { text: t('docSubmitted') }),
          got ? h('div', { class: 'doc-number' }, [
            h('small', { text: t('docYourNumber') }),
            h('strong', { text: data.numbering.number }),
            h('button', {
              class: 'btn sm', text: t('copyIt'),
              onclick: function (e) {
                var btn = e.target;
                var done = function () {
                  btn.textContent = t('copied');
                  setTimeout(function () { btn.textContent = t('copyIt'); }, 1600);
                };
                if (navigator.clipboard) navigator.clipboard.writeText(data.numbering.number).then(done, done);
                else done();
              },
            }),
          ]) : h('p', { text: t('docNoNumberYet') }),
          h('p', { text: t(draft.sendMode === 'self' ? 'docNextSelf' : 'docNextSecretary') }),
        ]),
      ]));
      footer.appendChild(h('button', {
        class: 'btn primary', text: t('docOpenIt'),
        onclick: function () { veil.remove(); openDoc(data.id); },
      }));
      footer.appendChild(h('button', { class: 'btn', text: t('close'), onclick: function () { veil.remove(); } }));
    }

    drawDetails();
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
  }


  /**
   * One document: where it is, and what this person can do about it.
   */
  function openDoc(id) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var bodyBox = h('div', { class: 'body' });
    var footer = h('footer', {});
    var head2 = h('h2', { text: '…' });
    var modal = h('div', { class: 'modal wide' }, [
      h('header', {}, [head2, h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } })]),
      bodyBox, footer,
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);

    function load() {
      api('/api/documents?id=' + encodeURIComponent(id)).then(draw)
        .catch(function (err) {
          clear(bodyBox);
          bodyBox.appendChild(h('div', { class: 'notice err', text: errText(err.code) }));
        });
    }

    function draw(data) {
      var doc = data.document;
      head2.textContent = doc.title;
      clear(bodyBox); clear(footer);

      var pane = h('div', { class: 'pane' });

      pane.appendChild(h('div', { class: 'view-band' }, [
        h('span', { class: 'vb-status st-' + (doc.stage === 'sent' || doc.stage === 'done' ? 'done'
          : doc.stage === 'rejected' ? 'feedback' : 'doing'),
          text: DOC_STAGE_TH[doc.stage] || doc.stage }),
        doc.priority && doc.priority !== 'medium'
          ? h('span', { class: 'vb-prio prio-' + doc.priority, text: prioLabel(doc.priority) }) : null,
        h('span', { class: 'grow' }),
        h('span', { class: 'vb-due', text: t('docSubmittedOn') + ' ' +
          stampDate(doc.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }) }),
      ]));

      if (doc.note) pane.appendChild(h('p', { class: 'view-desc', text: doc.note }));

      /**
       * The progress bar, as a list rather than a strip.
       *
       * She asked for where the document is, when each step happened, who the
       * contact is at each stage and who has signed — that is four facts per
       * step, and a coloured strip can only show one of them.
       */
      var steps = h('ol', { class: 'doc-steps' }, data.progress.map(function (p) {
        var when = fmtStamp(p.at, { day: 'numeric', month: 'short' });
        /**
         * The step behind this row, when there is one — the progress list
         * carries the two ends as well, and only a real step has boxes.
         */
        var real = (data.steps || []).filter(function (st) {
          return p.key === 'step-' + st.position;
        })[0];
        return h('li', { class: 'ds ' + p.state }, [
          h('span', { class: 'ds-dot' }),
          h('div', { class: 'ds-main' }, [
            h('div', { class: 'ds-label' }, [
              p.label,
              p.signs ? h('span', { class: 'chip unit', text: t('docSigns') }) : null,
            ]),
            p.username ? h('div', { class: 'ds-who' }, [avatarNode(p.username, 'sm'), nameOf(p.username)]) : null,
            /**
             * Who actually dealt with it, when that was not the person whose
             * step it is. Anybody in a letter's chain may approve or bounce
             * at any stage now, and a history that quietly credited the wrong
             * person would be worse than no history.
             */
            p.actedBy ? h('div', { class: 'ds-standin' }, [
              avatarNode(p.actedBy, 'sm'),
              h('span', { text: t('docActedBy').replace('%n', nameOf(p.actedBy)) }),
              (p.signedBy && p.signedBy !== p.actedBy)
                ? h('span', { class: 'chip unit', text: t('docSignedAs').replace('%n', nameOf(p.signedBy)) })
                : null,
            ].filter(Boolean)) : null,
            when ? h('div', { class: 'ds-when', text: when }) : null,
            p.comment ? h('div', { class: 'ds-note', text: '“' + p.comment + '”' }) : null,
            /**
             * Putting a signature right without re-running the chain.
             *
             * Shown on the signed step itself rather than in a settings
             * corner, because the complaint is always about one particular
             * name on the page and that is where the eye already is.
             */
            (real && real.mayMove) ? h('button', {
              type: 'button', class: 'btn ghost sm ds-move', text: t('docMoveSig'),
              onclick: function () {
                openMoveSignature(doc, real, function () { load(); });
              },
            }) : null,
          ]),
        ]);
      }));
      pane.appendChild(steps);

      pane.appendChild(h('div', { class: 'view-rows' }, [
        // The number first: it is what everybody opens a letter's page to find.
        doc.docNumber
          ? vRow(t('docNumber'), h('span', { class: 'doc-no', text: doc.docNumber }))
          : null,
        vRow(t('docRecipient'), doc.recipient ? h('span', { text: doc.recipient }) : vMuted('—')),
        /**
         * How it leaves, and where to.
         *
         * Shown to everybody rather than only the sender: a head approving a
         * letter should be able to see at a glance whether it is going out by
         * email and to which address, because a wrong address is the kind of
         * mistake that is cheap now and expensive later.
         */
        vRow(t('docWhoSends'), h('span', {}, [
          doc.sendMode === 'self'
            ? h('span', {}, [t('docSendMyself'), ' \u00b7 ', nameOf(doc.createdBy)])
            : h('span', { text: t('docSendBySecretary') }),
          doc.internalUnit ? h('span', { class: 'chip unit', style: 'margin-left:6px', text: t('docInsideChula') }) : null,
        ])),
        doc.recipientEmail
          ? vRow(t('docRecipientEmail'), h('a', {
              class: 'chip dept', href: 'mailto:' + doc.recipientEmail + '?subject=' +
                encodeURIComponent((doc.docNumber ? doc.docNumber + ' ' : '') + doc.title),
              text: doc.recipientEmail,
            }))
          : null,
        vRow(t('docUploader'), h('span', { class: 'selected' },
          [h('span', { class: 'chip who' }, [avatarNode(doc.createdBy, 'sm'), nameOf(doc.createdBy)])])),
        vRow(t('docFiles'), h('span', { class: 'selected' }, data.files.map(function (f) {
          /**
           * The Word original downloads under its own name. A PDF opens in
           * the reader inside this app — see openPdfViewer: handing it to the
           * phone's own viewer leaves people with no way back.
           */
          var isSource = f.kind === 'source';
          var label = isSource ? t('docSource')
            : f.kind === 'signed' ? t('docSignedCopy') : t('docOriginal');
          var size = ' \u00b7 ' + Math.round(f.size / 1024) + ' KB';
          if (isSource) {
            return h('a', {
              class: 'chip dept src',
              href: '/api/documents?id=' + encodeURIComponent(doc.id) + '&file=' + f.kind,
              title: f.name, text: label + size,
            });
          }
          return h('button', {
            type: 'button', class: 'chip dept as-btn', title: t('docOpenReader'),
            onclick: function () { openPdfViewer(doc, f.kind, label); },
            text: label + size,
          });
        }).concat(doc.driveUrl ? [h('a', {
          // Once a finished document has been filed in Drive, that copy is the
          // one that lasts — so the link to it is shown here rather than
          // leaving people to hunt through a folder for it.
          class: 'chip dept', target: '_blank', rel: 'noopener',
          href: doc.driveUrl, text: t('docInDrive'),
        })] : []))),
        vRow(t('notifyThis'), notifyControl('doc', doc.id, 'document')),
      ]));

      /**
       * Where my signature will land, and how big.
       *
       * Asked for by the people doing the signing: until now the first sight
       * anybody had of their own signature on a letter was the finished PDF,
       * by which point a box drawn too big or too small is somebody else's
       * problem to fix. This draws the page with the real signature in the
       * real place, before แก้ไข or อนุมัติ is pressed. Offered to whoever has
       * a box on this letter — the writer who placed them included, since
       * they are usually the one who has to put it right.
       */
      var mySteps = (data.steps || []).filter(function (st) {
        return st.username === S.user.username && (st.marks || []).length;
      });
      if (mySteps.length && doc.stage !== 'rejected') {
        bodyBox.appendChild(signaturePreview(doc, data, mySteps));
      }
      bodyBox.appendChild(pane);

      /* ---- what this person can do ---- */
      if (data.myTurn) {
        footer.appendChild(h('button', {
          class: 'btn primary', text: t('docApprove'),
          onclick: function () { act('approve'); },
        }));

        /**
         * Approving without your signature on the letter.
         *
         * Only offered where there is a signature to withhold. Agreeing to a
         * letter and putting your name on its face are different things, and
         * some heads want the first without the second.
         */
        var mine = (data.steps || []).filter(function (s) {
          return s.state === 'waiting' && s.username === S.user.username;
        })[0];
        if (mine && mine.signs) {
          footer.appendChild(h('button', {
            class: 'btn', text: t('docApproveNoSign'),
            onclick: function () {
              if (!confirm(t('docApproveNoSignSure'))) return;
              act('approve', { withoutSignature: true });
            },
          }));
        }
        footer.appendChild(h('button', {
          class: 'btn danger', text: t('docReject'),
          onclick: function () {
            var why = prompt(t('docRejectWhy'));
            if (why === null) return;
            if (!why.trim()) { alert(t('docRejectWhy')); return; }
            act('reject', { comment: why.trim() });
          },
        }));
      }

      if (data.maySend) {
        footer.appendChild(h('button', {
          class: 'btn primary',
          text: doc.sendMode === 'self' ? t('docConfirmSent') : t('docMarkSent'),
          onclick: function () {
            if (!confirm(t('docMarkSentSure'))) return;
            act('send', { to: doc.recipient });
          },
        }));
      }

      /**
       * Sending it back, for whoever is holding it and has not been offered
       * the button already with the approve/reject pair above — in practice
       * เลขานุการ, who get the letter to post and were the ones spotting the
       * mistakes with no way to say so.
       */
      if (data.mayBounce && !data.myTurn) {
        footer.appendChild(h('button', {
          class: 'btn danger', text: t('docReject'),
          onclick: function () {
            var why = prompt(t('docRejectWhy'));
            if (why === null) return;
            if (!why.trim()) { alert(t('docRejectWhy')); return; }
            act('reject', { comment: why.trim() });
          },
        }));
      }

      if (data.mayReplace) {
        var replaceInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none' });
        replaceInput.addEventListener('change', function () {
          var file = replaceInput.files && replaceInput.files[0];
          if (!file) return;
          if (file.size > 3 * 1024 * 1024) { alert(t('docTooBig')); return; }
          fileToBase64(file).then(function (b64) {
            return api('/api/documents?do=replace', {
              method: 'POST', body: { id: doc.id, pdf: b64 },
            });
          }).then(load).catch(function (err) { alert(errText(err.code)); });
        });
        footer.appendChild(replaceInput);
        footer.appendChild(h('button', {
          class: 'btn', text: t('docReplace'), onclick: function () { replaceInput.click(); },
        }));
      }

      /**
       * Bringing a letter back after it was sent back.
       *
       * A ตีกลับ used to be the end of it: the PDFs go, and a corrected letter
       * meant a new document and everybody signing the same page twice. The
       * chain and every signature's place survived the rejection, so putting
       * the corrected file in is enough — the signatures already given are
       * stamped back onto it and the person who sent it back gets it again.
       */
      if (data.mayRevive) {
        var revivePick = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none' });
        var reviveBtn = h('button', {
          class: 'btn primary', text: t('docRevive'),
          onclick: function () { revivePick.click(); },
        });
        revivePick.addEventListener('change', function () {
          var file = revivePick.files && revivePick.files[0];
          if (!file) return;
          if (file.size > 3 * 1024 * 1024) { alert(t('docTooBig')); return; }
          reviveBtn.disabled = true;
          reviveBtn.textContent = t('docSending');
          fileToBase64(file).then(function (b64) {
            return api('/api/documents?do=revive', { method: 'POST', body: { id: doc.id, pdf: b64 } });
          }).then(function (res) {
            // Said out loud: the whole point is that the signatures came back.
            if (res && res.signaturesRestored) {
              alert(t('docReviveDone').replace('%n', String(res.signaturesRestored)));
            }
            load();
          }).catch(function (err) {
            reviveBtn.disabled = false;
            reviveBtn.textContent = t('docRevive');
            var code = err.data && err.data.error;
            alert(code === 'MARK_OFF_PAGE'
              ? t('docReviveShort').replace('%n', String((err.data && err.data.needs) || '?'))
              : errText(err.code));
          });
        });
        footer.appendChild(revivePick);
        footer.appendChild(reviveBtn);
        // What is waiting to come back, so the button is not a leap of faith.
        if ((data.revivable || []).length) {
          footer.appendChild(h('span', { class: 'hint',
            text: t('docReviveKeeps').replace('%s',
              data.revivable.map(function (u) { return nameOf(u); }).join(', ')) }));
        }
      }

      /**
       * The editable original, attached or swapped after the fact — including
       * on a letter that has just been sent back, which is exactly when
       * somebody realises they never attached it.
       */
      var bouncedMine = doc.stage === 'rejected' && doc.createdBy === S.user.username;
      if (data.mayReplace || bouncedMine) {
        var hasSource = data.files.some(function (f) { return f.kind === 'source'; });
        var srcPick = h('input', {
          type: 'file', style: 'display:none',
          accept: '.docx,.doc,.odt,.rtf,.pages,application/msword,' +
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        srcPick.addEventListener('change', function () {
          var file = srcPick.files && srcPick.files[0];
          if (!file) return;
          if (file.size > MAX_SOURCE_BYTES) { alert(t('docTooBig')); return; }
          // Over about two megabytes it goes up in pieces — see sendSourceInParts.
          var work = file.size > 2 * 1024 * 1024
            ? sendSourceInParts(doc.id, { name: file.name, file: file })
            : fileToBase64(file).then(function (b64) {
              return api('/api/documents?do=source', {
                method: 'POST', body: { id: doc.id, source: { name: file.name, data: b64 } },
              });
            });
          work.then(load).catch(function (err) { alert(errText(err.code)); });
        });
        footer.appendChild(srcPick);
        footer.appendChild(h('button', {
          class: 'btn', text: hasSource ? t('docSourceReplace') : t('docSourceAdd'),
          onclick: function () { srcPick.click(); },
        }));
      }

      /**
       * Moving it to a different secretary. Only while it is still with them:
       * once a document has been sent, who handled it is history.
       */
      if (data.mayAssign) {
        var secStep = data.steps.filter(function (s) { return s.role === 'secretary'; })[0];
        if (secStep && secStep.state === 'waiting') {
          api('/api/documents?do=secretaries').then(function (list) {
            var pick = h('select', {
              class: 'add-dept',
              onchange: function (e) {
                if (!e.target.value || e.target.value === secStep.username) return;
                api('/api/documents?do=assign', {
                  method: 'POST', body: { id: doc.id, username: e.target.value },
                }).then(load).catch(function (err) { alert(errText(err.code)); });
              },
            }, list.secretaries.map(function (s) {
              return h('option', {
                value: s.username, selected: s.username === secStep.username,
                text: s.displayName || s.username,
              });
            }));
            pane.appendChild(h('div', { class: 'view-rows' }, [vRow(t('docSecretary'), pick)]));
          }).catch(function () {});
        }
      }

      /**
       * Withdrawing it. The uploader may while nobody above them has acted;
       * after that it is not theirs alone to erase. Everything goes — the file
       * with it — so the confirmation says so plainly.
       */
      if (data.mayDelete) {
        footer.appendChild(h('button', {
          class: 'btn danger', text: t('docDelete'),
          onclick: function () {
            if (!confirm(t('docDeleteSure'))) return;
            api('/api/documents?id=' + encodeURIComponent(doc.id), { method: 'DELETE' })
              .then(function () {
                veil.remove();
                return api('/api/documents').then(function (fresh) {
                  S.docs = fresh.documents || [];
                  renderPage();
                });
              })
              .catch(function (err) { alert(errText(err.code)); });
          },
        }));
      }

      footer.appendChild(h('span', { class: 'grow' }));
      footer.appendChild(h('button', { class: 'btn', text: t('close'), onclick: function () { veil.remove(); } }));
    }

    function act(what, extra) {
      api('/api/documents?do=' + what, {
        method: 'POST', body: Object.assign({ id: id }, extra || {}),
      }).then(function () {
        return api('/api/documents').then(function (fresh) {
          S.docs = fresh.documents || [];
          renderPage();
        });
      }).then(load).catch(function (err) {
        // A head with no signature on file gets told exactly that, and where
        // to fix it, rather than a generic failure.
        if (err.data && err.data.error === 'NO_SIGNATURE') { alert(t('docNoSignature')); return; }
        alert(errText(err.code));
      });
    }

    load();
  }

  /**
   * A person's signature, drawn or uploaded once.
   *
   * Drawing is the path that works on a phone with no scanner, uploading is
   * the path that looks right for anyone who already has one. Both end up as
   * the same PNG with a transparent background, because the signature is
   * stamped over a printed page and a white rectangle would cover the text.
   */
  function signatureBox() {
    var box = h('div', { class: 'push-box' });

    function draw(state) {
      clear(box);
      if (state && state.has) {
        box.appendChild(h('p', { class: 'ok-line', text: '✓ ' + t('sigSaved') }));
      } else {
        box.appendChild(h('p', { class: 'hint', text: t('sigNone') }));
      }
      box.appendChild(h('p', { class: 'hint', text: t('sigHelp') }));

      var pad = h('canvas', { class: 'sig-pad', width: '600', height: '200' });
      var ctx = pad.getContext('2d');
      var drawing = false;
      var used = false;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111111';

      function at(e) {
        var rect = pad.getBoundingClientRect();
        var point = e.touches && e.touches[0] ? e.touches[0] : e;
        return {
          x: (point.clientX - rect.left) * (pad.width / rect.width),
          y: (point.clientY - rect.top) * (pad.height / rect.height),
        };
      }
      function start(e) { e.preventDefault(); drawing = true; used = true; var p = at(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
      function move(e) { if (!drawing) return; e.preventDefault(); var p = at(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
      function stop() { drawing = false; }
      pad.addEventListener('mousedown', start); pad.addEventListener('mousemove', move);
      window.addEventListener('mouseup', stop);
      pad.addEventListener('touchstart', start, { passive: false });
      pad.addEventListener('touchmove', move, { passive: false });
      pad.addEventListener('touchend', stop);

      box.appendChild(pad);

      var upload = h('input', { type: 'file', accept: 'image/png,image/jpeg', style: 'display:none' });
      upload.addEventListener('change', function () {
        var file = upload.files && upload.files[0];
        if (!file) return;
        var img = new Image();
        img.onload = function () {
          // Redrawn through a canvas so an uploaded JPEG becomes the PNG the
          // stamper expects, at a sane size.
          var scale = Math.min(600 / img.width, 200 / img.height, 1);
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          save(c.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = function () { alert(t('errGeneric')); };
        img.src = URL.createObjectURL(file);
      });

      var row = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
        h('button', {
          class: 'btn sm primary', text: t('sigSave'),
          onclick: function () {
            if (!used) { alert(t('sigDrawFirst')); return; }
            save(pad.toDataURL('image/png').split(',')[1]);
          },
        }),
        h('button', {
          class: 'btn sm', text: t('sigClear'),
          onclick: function () { ctx.clearRect(0, 0, pad.width, pad.height); used = false; },
        }),
        h('button', { class: 'btn sm', text: t('sigUpload'), onclick: function () { upload.click(); } }),
        upload,
      ]);
      box.appendChild(row);
      box.appendChild(delegateBox());
    }

    function save(base64) {
      api('/api/documents?do=signature', { method: 'POST', body: { png: base64 } })
        .then(function () { draw({ has: true }); })
        .catch(function (err) { alert(errText(err.code)); });
    }

    api('/api/documents?do=signature').then(draw).catch(function () { draw({ has: false }); });
    return box;
  }

  /**
   * Letting somebody else sign as me.
   *
   * Anybody in a letter's chain can already approve at any stage, and when
   * they do it is their own signature that goes on — which is right, because
   * the letter should show who approved it. This is the other case: a
   * ประธานฝ่าย away for a fortnight who wants their own signature to go on
   * the letters that reach their step while they are gone. Arranged once,
   * applies to every letter, and only the owner of the signature can arrange
   * it.
   */
  function delegateBox() {
    var box = h('div', { class: 'deleg-box' });
    var state = { delegates: [], actingFor: [] };

    function send(list) {
      return api('/api/documents?do=delegates', { method: 'POST', body: { delegates: list } })
        .then(function (d) { state = d; draw(); })
        .catch(function (err) { alert(errText(err.code)); });
    }

    function draw() {
      clear(box);
      box.appendChild(h('h4', { class: 'free-head', text: t('sigDelegTitle') }));
      box.appendChild(h('p', { class: 'hint', text: t('sigDelegHow') }));

      var names = state.delegates.map(function (d) { return d.username; });
      box.appendChild(h('div', { class: 'selected' }, names.length
        ? names.map(function (u) {
          return h('span', {
            class: 'chip who x', title: t('remove'),
            onclick: function () { send(names.filter(function (x) { return x !== u; })); },
          }, [avatarNode(u, 'sm'), nameOf(u), ' ✕']);
        })
        : [h('span', { class: 'hint', text: t('sigDelegNone') })]));

      var pick = h('select', {}, [h('option', { value: '', text: t('sigDelegAdd') })].concat(
        groupedPeopleOptions(S.users.filter(function (u) {
          return u.active && !u.suspended && u.username !== S.user.username &&
            names.indexOf(u.username) === -1;
        }))));
      pick.addEventListener('change', function () {
        if (!pick.value) return;
        send(names.concat([pick.value]));
      });
      box.appendChild(pick);

      if (state.actingFor.length) {
        box.appendChild(h('p', { class: 'hint', text: t('sigDelegFor') + ' ' +
          state.actingFor.map(function (d) { return nameOf(d.username); }).join(', ') }));
      }
    }

    api('/api/documents?do=delegates').then(function (d) { state = d; draw(); })
      .catch(function () { draw(); });
    return box;
  }

  /* ======================================================================
     Pages
     ====================================================================== */
  /**
   * Draw the current page — and never leave the screen empty if it cannot.
   *
   * The order here is the trap: `main` is cleared FIRST and the page drawn
   * second, so anything thrown in between leaves a blank page with no way
   * back except reloading the tab. That is not a theoretical shape — it is
   * what R0002 looked like from the outside, and it is the reason a bug in
   * any one page reads as "the whole app died".
   *
   * So the dispatch is wrapped. A page that throws now says so, with the
   * message, which turns an unreportable blank screen into something
   * somebody can send in.
   */
  function renderPage() {
    var main = clear($('main'));
    main.classList.remove('board-wide');
    paintFab();
    // A page is always opened from its top. Without this, moving between
    // tabs on a phone kept the old scroll position and landed mid-list.
    if (isPhone() && S.lastPainted !== S.page) window.scrollTo(0, 0);
    S.lastPainted = S.page;
    main.classList.remove('wide');
    try {
      return drawPage(main);
    } catch (err) {
      console.error('[render]', S.page, err);
      clear(main).appendChild(h('div', { class: 'notice err broke' }, [
        h('b', { text: t('pageBroke') }),
        h('p', { text: t('pageBrokeWhy') }),
        h('code', { text: String((err && err.message) || err).slice(0, 200) }),
        h('button', {
          class: 'btn', text: t('pageBrokeReload'), onclick: function () { location.reload(); },
        }),
      ]));
      return null;
    }
  }

  function drawPage(main) {
    if (S.page === 'home') return pageHome(main);
    if (S.page === 'schedule') return pageSchedule(main);
    if (S.page === 'space') return pageSpace(main);
    if (S.page === 'work') return pageTasks(main);
    if (S.page === 'calendar') return pageCalendar(main);
    if (S.page === 'docs') return pageDocs(main);
    if (S.page === 'profile') return pageProfile(main);
    if (S.page === 'links') return pageLinks(main);
    if (S.page === 'reports') return pageReports(main);
    if (S.page === 'shelf') return pageShelf(main);
    if (S.page === 'feed') return pageFeed(main);
    if (S.page === 'admin') return pageAdmin(main);
    if (S.page === 'announce') return pageAnnounce(main);
    if (S.page === 'requests') return pageRequests(main);
    return null;
  }

  /**
   * Does this task or event match what was typed in the search box?
   *
   * The code is matched on its own so that typing T0042 finds exactly that one
   * and not every task whose description happens to contain those characters.
   */
  function matchesQuery(item) {
    var q = (S.q || '').trim().toLowerCase();
    if (!q) return true;
    if ((item.code || '').toLowerCase() === q) return true;
    return [item.code, item.title, item.description, item.place]
      .filter(Boolean)
      .some(function (field) { return String(field).toLowerCase().indexOf(q) !== -1; });
  }

  /* ---------- tasks ----------------------------------------------------- */
  /**
   * "My tasks": the ones I am doing, and the ones I was asked to follow — the
   * point of being made a viewer is to have it in front of you. The card says
   * which is which (see taskRow).
   */
  /**
   * What a task is to me, in three kinds plus none:
   *   named — I am on it by name, or hold a piece of it: it is my job
   *   dept  — my department was tagged, which put me on it
   *   watch — I was tagged to follow it, view only
   */
  function roleOf(task) {
    var r = task.myRole;
    if (r === undefined) {
      // A task drawn before the server answered (just created here).
      r = task.assignees.indexOf(S.user.username) !== -1 ? 'named'
        : (task.viewers || []).indexOf(S.user.username) !== -1 ? 'watch' : null;
    }
    return r === 'part' ? 'named' : (r || null);
  }

  var ROLE_KEYS = { named: 'roleNamed', dept: 'roleDept', watch: 'roleWatch' };

  /** The label on the card. `part` reads as responsible, with its own wording. */
  function roleBadge(task) {
    var role = roleOf(task);
    if (!role) return null;
    var key = task.myRole === 'part' ? 'rolePart' : ROLE_KEYS[role];
    return h('span', { class: 'role-badge role-' + role, title: t(key + 'Hint') }, [
      icon(role === 'watch' ? 'eye' : role === 'dept' ? 'people' : 'check'),
      // The phone gets a shorter word, so the badge never pushes the title down a line.
      h('span', { class: 'rb-long', text: t(key) }),
      h('span', { class: 'rb-short', text: t(key + 'Short') }),
    ]);
  }

  function isMine(task) {
    return task.assignees.indexOf(S.user.username) !== -1 ||
      (task.viewers || []).indexOf(S.user.username) !== -1;
  }

  function visibleTasks(mineOnly, anyStatus) {
    return S.tasks.filter(function (task) {
      if (mineOnly && !isMine(task)) return false;
      // On the board the columns ARE the statuses, so the status tab does
      // not narrow anything — every status has a column to sit in.
      if (anyStatus) {
        // fall through to the other filters
      } else if (S.filter === 'open' && task.status === 'done') return false;
      /**
       * Every status, from the one list.
       *
       * This used to name three of them by hand, so รอตรวจ and ตรวจแล้ว
       * matched nothing and fell through with no filter applied at all —
       * picking either tab showed the whole list, including finished work,
       * while the count beside the tab was right. Reading the statuses from
       * STATUS_LIST means a status can never be forgotten here again.
       */
      if (!anyStatus && STATUS_LIST.indexOf(S.filter) !== -1 && task.status !== S.filter) return false;
      if (!matchesQuery(task)) return false;
      if (S.who && task.assignees.indexOf(S.who) === -1) return false;
      if (S.role && (roleOf(task) || 'none') !== S.role) return false;
      if (S.prio && task.priority !== S.prio) return false;
      if (S.unit && task.unit !== S.unit) return false;
      // My own label, which nobody else's copy of this task carries.
      if (S.tag && (task.tags || []).indexOf(S.tag) === -1) return false;
      if (S.dept) {
        var inDept = task.department === S.dept ||
          (task.departments || []).some(function (d) { return d.key === S.dept; });
        if (!inDept) return false;
      }
      return true;
    }).sort(function (a, b) {
      /**
       * Most urgent first, not most recently touched.
       *
       * The server orders by status so the work in progress is findable, but
       * the question someone opens this page with is "what is about to bite
       * me" — so the list is re-sorted here by the same scale that colours
       * the cards. Within one band the earlier deadline wins, then the louder
       * priority, so two things due Friday do not swap places on every load.
       */
      var byUrgency = urgencyRank(a) - urgencyRank(b);
      if (byUrgency) return byUrgency;

      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      var byPrio = PRIORITY_LIST.indexOf(b.priority || 'medium') - PRIORITY_LIST.indexOf(a.priority || 'medium');
      if (byPrio) return byPrio;
      return (a.dueTime || '99:99') < (b.dueTime || '99:99') ? -1 : 1;
    });
  }

  /**
   * The four ways to narrow the task list — priority, department, section and
   * person — as dropdowns.
   *
   * Built in one place because there are two places they appear: in a row on a
   * computer, and in a sheet on a phone, where four dropdowns across the top of
   * the page were most of the reason it looked too big. `after` is what to do
   * once one has changed: redraw the page, and on a phone redraw the sheet as
   * well, because picking a department changes which sections and people the
   * other two can offer.
   */
  function taskFilterSelects(after) {
    /**
     * Department first, person second.
     *
     * A flat list of every person stops working the moment the roster grows
     * past the heads, which it is about to. Picking a department narrows the
     * person list to that department, so the second dropdown stays short.
     */
    var deptSelect = h('select', {
      onchange: function (e) { S.dept = e.target.value; S.who = ''; S.unit = ''; after(); },
      // Filtering follows what is on screen, not what may be filed: an Editor
      // sees every ฝ่าย's work, so every ฝ่าย is worth offering here.
    }, [h('option', { value: '', text: t('allDepartments') })].concat(
      (seesAllTasks() ? (S.departments || []) : myDepartments()).map(function (d) {
        return h('option', { value: d.key, text: deptOptionLabel(d), selected: S.dept === d.key });
      })
    ));

    /**
     * Sections, narrowed to the chosen department when there is one.
     *
     * With no department picked this lists every section on offer, prefixed by
     * its department so two called "Stage" could never be confused. It hides
     * itself when there is nothing to choose between.
     */
    var unitChoices = S.dept
      ? unitsOf(S.dept).map(function (u) { return { dept: S.dept, unit: u, label: u }; })
      : myUnits().map(function (x) { return { dept: x.dept, unit: x.unit, label: deptLabel(x.dept) + ' · ' + x.unit }; });
    var unitSelect = unitChoices.length
      ? h('select', {
          onchange: function (e) { S.unit = e.target.value; after(); },
        }, [h('option', { value: '', text: t('allUnits') })].concat(
          unitChoices.map(function (x) {
            return h('option', { value: x.unit, text: x.label, selected: S.unit === x.unit });
          })
        ))
      : null;

    var peopleForPicker = S.users.filter(function (u) {
      return u.active && (!S.dept || (u.departments || []).indexOf(S.dept) !== -1);
    });
    var whoSelect = h('select', {
      onchange: function (e) { S.who = e.target.value; after(); },
    }, [h('option', { value: '', text: t('everyone') })].concat(
      groupedPeopleOptions(peopleForPicker)
    ));

    var prioSelect = h('select', {
      onchange: function (e) { S.prio = e.target.value; after(); },
    }, [h('option', { value: '', text: t('priority') })].concat(
      PRIORITY_LIST.map(function (p) {
        return h('option', { value: p, text: prioLabel(p), selected: S.prio === p });
      })
    ));

    return { prio: prioSelect, dept: deptSelect, unit: unitSelect, who: whoSelect };
  }

  /**
   * The four dropdowns, in a sheet, on a phone.
   *
   * Redrawn in place after each change, because picking a department changes
   * what the section and person dropdowns can offer — and the list behind it
   * redraws too, so the count on each status chip is right the moment the
   * sheet closes.
   */
  function openTaskFilterSheet() {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var body = h('div', { class: 'body' });
    var clearBtn = h('button', {
      class: 'btn', text: t('phClearFilters'),
      onclick: function () { S.prio = ''; S.dept = ''; S.unit = ''; S.who = ''; renderPage(); draw(); },
    });
    function draw() {
      clear(body);
      var picks = taskFilterSelects(function () { renderPage(); draw(); });
      [[t('priority'), picks.prio], [t('departments'), picks.dept],
       [t('phUnit'), picks.unit], [t('assignTo'), picks.who]].forEach(function (pair) {
        if (pair[1]) body.appendChild(h('div', { class: 'field' }, [h('label', { text: pair[0] }), pair[1]]));
      });
      clearBtn.disabled = !taskFilterCount();
    }
    draw();
    veil.appendChild(h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h2', { text: t('phFilters') }),
        h('button', { class: 'btn ghost sm', text: '\u2715', onclick: function () { veil.remove(); } }),
      ]),
      body,
      h('footer', {}, [
        clearBtn,
        h('button', { class: 'btn primary', text: t('phDone'), onclick: function () { veil.remove(); } }),
      ]),
    ]));
    $('modal-root').appendChild(veil);
  }

  /** How many of the four are narrowing the list right now. */
  function taskFilterCount() {
    return [S.prio, S.dept, S.unit, S.who, S.tag].filter(Boolean).length;
  }

  /**
   * My labels as a row of chips above the list.
   *
   * A row rather than another dropdown: these are the person's own words for
   * their own work, there are at most twenty of them, and one tap is the
   * whole point. Drawn only once they have made one — an empty row of
   * nothing would be a permanent reminder of a feature nobody asked for.
   */
  function tagChips() {
    if (!(S.myTags || []).length) return null;
    return h('div', { class: 'tag-row' }, S.myTags.map(function (tag) {
      var n = S.tasks.filter(function (x) { return (x.tags || []).indexOf(tag.name) !== -1; }).length;
      return h('button', {
        type: 'button', class: 'chip' + (S.tag === tag.name ? ' on' : ''),
        onclick: function () { S.tag = S.tag === tag.name ? '' : tag.name; renderPage(); },
      }, [tag.name, h('span', { class: 'n', text: String(n) })]);
    }));
  }

  /* ---------- the board ------------------------------------------------- */

  /**
   * Board or list — remembered on this device.
   *
   * The board is the default: it answers "where does everything stand" at a
   * glance, which is the question the committee meets to ask. The list stays
   * one tap away because it answers a different one — "what is about to bite
   * me" — better, sorted by urgency across every status at once.
   */
  function workView() {
    if (S.workView) return S.workView;
    // The compact list is the default since the redesign — a fresh key, so
    // everybody sees it once and can then pick the board again if they prefer.
    try { S.workView = localStorage.getItem('fair-work-view2') || 'list'; } catch (e) { S.workView = 'list'; }
    if (['board', 'list', 'gantt'].indexOf(S.workView) === -1) S.workView = 'list';
    return S.workView;
  }
  function setWorkView(v) {
    S.workView = v;
    try { localStorage.setItem('fair-work-view2', v); } catch (e) {}
    renderPage();
  }

  /**
   * Moving a card, shown at once and confirmed after.
   *
   * The same optimistic pattern as the rest of the page: the card lands in its
   * new column the moment it is dropped, and goes back with a message if the
   * server says no — which it only does to somebody who is not on the task.
   */
  function moveTask(task, status) {
    if (!task || task.status === status) return;
    var before = task.status;
    task.status = status;
    renderPage();
    api('/api/tasks', { method: 'PATCH', body: { id: task.id, status: status } })
      .then(function (d) { S.tasks = d.tasks; renderPage(); refreshNotifications(); })
      .catch(function (err) { task.status = before; renderPage(); alert(errText(err.code)); });
  }

  /** On a phone the status box opens a sheet rather than a tiny dropdown. */
  function openStatusSheet(task) {
    actionSheet(t('kbMoveTo'), STATUS_LIST.map(function (st) {
      return {
        label: (MARK[st] ? MARK[st] + '  ' : '') + statusLabel(st),
        sub: st === task.status ? t('kbNow') : null,
        onclick: function () { moveTask(task, st); },
      };
    }));
  }

  /**
   * The finished column is cut short.
   *
   * It only ever grows — a month into the fair it would be the tallest column
   * by far, pushing nothing useful down the page. The most recent dozen show;
   * the rest are a tap away.
   */
  var DONE_SHOWN = 12;

  function kanbanBoard(rows, phone) {
    var board = h('div', { class: 'kanban' + (phone ? ' kb-phone' : '') });

    STATUS_LIST.forEach(function (st) {
      var items = rows.filter(function (r) { return r.status === st; });
      var shown = items;
      var hidden = 0;
      if (st === 'done' && !S.kbAllDone && items.length > DONE_SHOWN) {
        shown = items.slice(0, DONE_SHOWN);
        hidden = items.length - DONE_SHOWN;
      }

      var list = h('ul', { class: 'tasks kb-list' }, shown.map(function (task) {
        var card = taskRow(task);
        /**
         * Dragging is for a mouse. On a phone a long press is already "select
         * text" or "scroll", and HTML drag-and-drop does not exist on iOS at
         * all — so there the status box on each card opens a sheet instead.
         */
        if (!phone && task.maySetStatus && !task.pending) {
          card.draggable = true;
          card.addEventListener('dragstart', function (e) {
            S.dragId = task.id;
            card.classList.add('dragging');
            try { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
          });
          card.addEventListener('dragend', function () {
            S.dragId = null;
            card.classList.remove('dragging');
            board.querySelectorAll('.drop-on').forEach(function (c) { c.classList.remove('drop-on'); });
          });
        }
        return card;
      }));

      var col = h('section', { class: 'kb-col', dataset: { status: st } }, [
        h('div', { class: 'kb-head' }, [
          h('i', { class: 'kb-dot s-' + st }),
          h('span', { text: statusLabel(st) }),
          h('span', { class: 'n', text: String(items.length) }),
        ]),
        items.length ? list : h('div', { class: 'kb-empty', text: phone ? t('kbEmptyPhone') : t('kbEmpty') }),
        hidden ? h('button', {
          type: 'button', class: 'kb-more', text: t('kbMore').replace('%n', String(hidden)),
          onclick: function () { S.kbAllDone = true; renderPage(); },
        }) : null,
      ]);

      if (!phone) {
        col.addEventListener('dragover', function (e) {
          if (!S.dragId) return;
          e.preventDefault();
          try { e.dataTransfer.dropEffect = 'move'; } catch (x) {}
          col.classList.add('drop-on');
        });
        col.addEventListener('dragleave', function (e) {
          if (!col.contains(e.relatedTarget)) col.classList.remove('drop-on');
        });
        col.addEventListener('drop', function (e) {
          e.preventDefault();
          col.classList.remove('drop-on');
          var task = S.tasks.filter(function (x) { return x.id === S.dragId; })[0];
          S.dragId = null;
          moveTask(task, st);
        });
      }
      board.appendChild(col);
    });

    /**
     * On a phone the columns sit side by side and swipe, one to a screen with
     * the edge of the next showing so it is obvious there is more. Redrawing
     * after a move would otherwise snap back to the first column, so where
     * the board was scrolled to is kept and restored.
     */
    if (phone) {
      requestAnimationFrame(function () { board.scrollLeft = S.kbScroll || 0; });
      board.addEventListener('scroll', function () {
        S.kbScroll = board.scrollLeft;
        var cols = board.querySelectorAll('.kb-col');
        var w = cols.length > 1 ? cols[1].offsetLeft - cols[0].offsetLeft : 1;
        var at = Math.max(0, Math.min(cols.length - 1, Math.round(board.scrollLeft / w)));
        document.querySelectorAll('.ph-chips button').forEach(function (b, i) {
          b.classList.toggle('on', i === at);
        });
      }, { passive: true });
    }
    return board;
  }

  /**
   * One page for everything that has a date on it.
   *
   * Mine, everyone's, and the events used to be three tabs, which meant
   * checking three places to know what was going on — and the same task
   * appeared in two of them. Now it is one page with a switch at the top, and
   * the events sit above the work because that is the order they matter in:
   * a rehearsal on Friday changes what you do about Friday's deadlines.
   */
  /**
   * Narrow "my tasks" to one kind: the ones that are my job, the ones my
   * department was tagged on, the ones I follow. Each with how many.
   */
  function roleSeg(mineOnly) {
    var base = S.tasks.filter(function (x) { return !mineOnly || isMine(x); });
    var n = function (role) { return base.filter(function (x) { return (roleOf(x) || 'none') === role; }).length; };
    var choices = [['', t('roleAll'), base.length], ['named', t('roleNamed'), n('named')],
      ['dept', t('roleDept'), n('dept')], ['watch', t('roleWatch'), n('watch')]];
    if (!mineOnly) choices.push(['none', t('roleNone'), n('none')]);
    return h('div', { class: 'seg role-seg' }, choices.map(function (c) {
      return h('button', {
        class: (S.role || '') === c[0] ? 'on' : '', 'data-role': c[0] || 'all',
        onclick: function () { S.role = c[0]; renderPage(); },
      }, [c[1], h('span', { class: 'n', text: String(c[2]) })]);
    }));
  }

  function pageTasks(main) {
    var mineOnly = S.scope !== 'all';
    var phone = isPhone();
    var view = workView();
    var board = view === 'board';
    var gantt = view === 'gantt';
    // The board wants the width of the window, not the width of a column of
    // text; every other page keeps the narrower measure.
    main.classList.toggle('board-wide', (board || gantt) && !phone);

    /**
     * On a phone: one line. Mine / everyone, then search and filters as two
     * round buttons. Making things is the + button in the corner.
     */
    if (phone) {
      var nFilters = taskFilterCount();
      main.appendChild(h('div', { class: 'ph-toolbar' }, [
        h('div', { class: 'seg scope-seg' }, [['mine', 'scopeMine'], ['all', 'scopeAll']].map(function (pair) {
          return h('button', {
            class: S.scope === pair[0] ? 'on' : '', text: t(pair[1]),
            onclick: function () { S.scope = pair[0]; if (S.role === 'none') S.role = ''; renderPage(); },
          });
        })),
        h('span', { class: 'grow' }),
        // Board → list → timeline. The icon shows what you will GET, not what you have.
        h('button', {
          type: 'button', class: 'ph-ibtn ph-view',
          'aria-label': t({ board: 'viewList', list: 'viewGantt', gantt: 'viewBoard' }[view] || 'viewList'),
          onclick: function () { setWorkView({ board: 'list', list: 'gantt', gantt: 'board' }[view] || 'board'); },
        }, [icon({ board: 'list', list: 'gantt', gantt: 'board' }[view] || 'list')]),
        h('button', {
          type: 'button', class: 'ph-ibtn ph-find' + (S.phSearch || S.q ? ' on' : ''),
          'aria-label': t('searchPlaceholder'),
          onclick: function () {
            S.phSearch = !(S.phSearch || S.q);
            if (!S.phSearch) S.q = '';
            renderPage();
            if (S.phSearch) { var box = document.querySelector('.ph-search input'); if (box) box.focus(); }
          },
        }, [icon('search')]),
        h('button', {
          type: 'button', class: 'ph-ibtn ph-filter' + (nFilters ? ' on' : ''),
          'aria-label': t('phFilters'),
          onclick: openTaskFilterSheet,
        }, [icon('filter'), nFilters ? h('span', { class: 'badge-n', text: String(nFilters) }) : null]),
      ]));
    }

    if (!phone) main.appendChild(h('div', { class: 'page-head' }, [
      h('div', { class: 'seg scope-seg' }, [['mine', 'scopeMine'], ['all', 'scopeAll']].map(function (pair) {
        return h('button', {
          class: S.scope === pair[0] ? 'on' : '',
          text: t(pair[1]),
          onclick: function () { S.scope = pair[0]; if (S.role === 'none') S.role = ''; renderPage(); },
        });
      })),
      h('div', { class: 'seg view-seg' }, [['board', 'viewBoard', 'board'], ['list', 'viewList', 'list'], ['gantt', 'viewGantt', 'gantt']].map(function (x) {
        return h('button', {
          class: workView() === x[0] ? 'on' : '', title: t(x[1]),
          onclick: function () { setWorkView(x[0]); },
        }, [icon(x[2]), h('span', { text: t(x[1]) })]);
      })),
      h('span', { class: 'grow' }),
      /**
       * A member sees no way to create work, because there is none: the
       * server refuses it either way, and offering a button that always ends
       * in an error is worse than not offering it.
       */
      mayCreate() ? h('button', { class: 'btn', text: '\u2191 ' + t('importTasks'), onclick: openImport }) : null,
      mayCallMeeting() ? h('button', { class: 'btn', text: t('mtgNew'), onclick: function () { openMeeting(null); } }) : null,
      mayCreate() ? h('button', { class: 'btn', text: t('newEvent'), onclick: function () { openEvent(null); } }) : null,
      mayCreate() ? h('button', { class: 'btn primary', text: t('newTask'), onclick: function () { openTask(null); } }) : null,
    ]));

    upcomingList(main, mineOnly);
    // Mine to do / my department's / following — the tabs over the list.
    if (!phone) {
      var roleTabs = roleSeg(mineOnly);
      roleTabs.className = 'ph-roles role-tabs';
      main.appendChild(roleTabs);
    }

    var pool = S.tasks.filter(function (x) {
      if (S.role && (roleOf(x) || 'none') !== S.role) return false;
      return !mineOnly || isMine(x);
    });
    var counts = {
      all: pool.length,
      open: pool.filter(function (x) { return x.status !== 'done'; }).length,
      todo: pool.filter(function (x) { return x.status === 'todo'; }).length,
      doing: pool.filter(function (x) { return x.status === 'doing'; }).length,
      review: pool.filter(function (x) { return x.status === 'review'; }).length,
      feedback: pool.filter(function (x) { return x.status === 'feedback'; }).length,
      done: pool.filter(function (x) { return x.status === 'done'; }).length,
    };

    var seg = h('div', { class: 'seg' }, [
      // Named for what it does. It was labelled ทั้งหมด ("everything") while
      // quietly leaving out finished work, so its count never matched the sum
      // of the tabs beside it and people reasonably read that as a bug.
      ['open', t('filterOpen')], ['todo', statusLabel('todo')], ['doing', statusLabel('doing')],
      ['review', statusLabel('review')], ['feedback', statusLabel('feedback')], ['done', statusLabel('done')],
    ].map(function (pair) {
      return h('button', {
        class: S.filter === pair[0] ? 'on' : '',
        onclick: function () { S.filter = pair[0]; renderPage(); },
      }, [pair[1], h('span', { class: 'n', text: String(counts[pair[0]]) })]);
    }));

    var picks = taskFilterSelects(renderPage);
    var prioSelect = picks.prio, deptSelect = picks.dept, unitSelect = picks.unit, whoSelect = picks.who;

    // The three dropdowns are one group, so they wrap together onto a second
    // line rather than splitting up awkwardly on a narrow window.
    /**
     * Search.
     *
     * Matches the short code, the title and the description, so "T0042" finds
     * one thing and "เวที" finds everything about the stage. A code is matched
     * whole and case-insensitively, which is what makes it something people
     * can read out over the phone.
     *
     * Deliberately filters what is already loaded rather than asking the
     * server: the whole list is here anyway, and a round trip per keystroke
     * would make it feel slower, not faster.
     */
    var searchBox = h('input', {
      type: 'search', class: 'search', value: S.q,
      placeholder: t('searchPlaceholder'), 'aria-label': t('searchPlaceholder'),
    });
    searchBox.addEventListener('input', function () {
      S.q = searchBox.value;
      clearTimeout(searchBox._t);
      // Redrawing on every keystroke loses focus and feels jumpy; a short
      // pause is the difference between searching and fighting the box.
      searchBox._t = setTimeout(function () {
        renderPage();
        var again = document.querySelector('input.search');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      }, 220);
    });

    if (phone) {
      if (S.phSearch || S.q) {
        main.appendChild(h('div', { class: 'ph-search' }, [searchBox]));
      }
      var roles = roleSeg(mineOnly);
      roles.className = 'ph-roles';
      main.appendChild(roles);
      if (gantt) {
        // The timeline has its own controls; the status chips would only narrow it.
      } else if (board) {
        /**
         * On the board the chips are a map of the columns: tapping one swipes
         * the board to it, and the one lit up follows the swipe.
         */
        main.appendChild(h('div', { class: 'ph-chips' }, STATUS_LIST.map(function (st, i) {
          return h('button', {
            type: 'button', class: i === 0 ? 'on' : '',
            onclick: function () {
              var col = document.querySelector('.kanban .kb-col[data-status="' + st + '"]');
              var rail = document.querySelector('.kanban');
              if (col && rail) rail.scrollTo({ left: col.offsetLeft - rail.offsetLeft - 14, behavior: 'smooth' });
            },
          }, [statusLabel(st), h('span', { class: 'n', text: String(counts[st]) })]);
        })));
      } else {
        // The same tabs, as a line of chips that scrolls instead of wrapping.
        seg.className = 'ph-chips';
        main.appendChild(seg);
      }

      /**
       * What is narrowing the list, said where the list starts.
       *
       * With the dropdowns tucked into a sheet, a filter set yesterday would
       * otherwise be invisible today — and "where did half my tasks go" is
       * the question that follows. One line names them and clears them.
       */
      if (taskFilterCount()) {
        var named = [];
        if (S.prio) named.push(prioLabel(S.prio));
        if (S.dept) named.push(deptLabel(S.dept));
        if (S.unit) named.push(S.unit);
        if (S.who) named.push(nameOf(S.who));
        if (S.tag) named.push(S.tag);
        main.appendChild(h('div', { class: 'ph-active' }, named.map(function (x) {
          return h('span', { class: 'chip', text: x });
        }).concat([h('button', {
          type: 'button', text: t('phClearFilters'),
          onclick: function () { S.prio = ''; S.dept = ''; S.unit = ''; S.who = ''; S.tag = ''; renderPage(); },
        })])));
      }
    } else {
      main.appendChild(h('div', { class: 'filters' }, [
        board || gantt ? null : seg, board || gantt ? null : h('span', { class: 'grow' }),
        searchBox,
        h('div', { class: 'filter-selects' }, [prioSelect, deptSelect, unitSelect, whoSelect]),
      ]));
    }

    var chips = tagChips();
    if (chips) main.appendChild(chips);

    // On a phone this line cost two lines above the first task; the role tabs
    // say the same thing more usefully.
    if (!seesAllTasks() && !phone) {
      main.appendChild(h('p', {
        style: 'margin:-6px 0 12px;font-size:12.5px;color:var(--ink-faint)',
        text: t('deptOnlyNote'),
      }));
    }

    var rows = visibleTasks(mineOnly, board || gantt);
    if (gantt && pool.length) {
      main.appendChild(ganttChart(rows, { phone: phone }));
      return;
    }
    if (board && pool.length) {
      main.appendChild(kanbanBoard(rows, phone));
      return;
    }
    if (!rows.length) {
      main.appendChild(h('div', { class: 'empty' }, [
        h('strong', { text: pool.length ? t('emptyFilter') : (mineOnly ? t('emptyMine') : t('emptyAll')) }),
        pool.length ? '' : (mineOnly ? t('emptyMineSub') : t('emptyAllSub')),
      ]));
      return;
    }
    main.appendChild(groupedList(rows));
  }

  /**
   * The next few events, as a band across the top.
   *
   * Only the ones still ahead, and only a handful — this is a reminder of
   * what is coming, not the events page it replaced. Everything is still
   * there, in the calendar and behind "see all".
   */
  /**
   * What is coming up: events and meetings, in one rail.
   *
   * Meetings used to live on a tab of their own, which meant the one thing
   * somebody needed to see on a Tuesday morning was the one thing they had to
   * go and look for. They are dates like any other and belong here, marked so
   * that a meeting still reads as a meeting.
   */
  /** The events still ahead, that this view should show. */
  /**
   * Is this still ahead of us, by the clock rather than by the date?
   *
   * "ที่กำลังจะถึง" kept listing the 17:00 meeting all evening, because the
   * filter only compared dates — so at nine o'clock the first thing on the
   * page was two meetings that had already happened. Something with no time
   * on it belongs to the whole day; something with a start but no end is
   * counted as over an hour after it starts.
   */
  var RUNS_FOR = 60;
  function stillAhead(on, at, to) {
    var today = todayIso();
    if (!on || on > today) return true;
    if (on < today) return false;
    if (!at) return true;
    var start = minutesOfClock(at);
    if (start === null) return true;
    var ends = (to !== undefined && to !== null && minutesOfClock(to) !== null)
      ? minutesOfClock(to) : start + RUNS_FOR;
    return nowMinutes() < ends;
  }

  /**
   * Can this invitation still be answered?
   *
   * Mirrors canReply on the server exactly: until the meeting starts, and a
   * meeting with no time on it counts as starting at midnight. Kept here
   * rather than read off the meeting, so the answer is right on a page that
   * has been open since yesterday.
   */
  function rsvpStillOpen(m) {
    if (!m || m.status === 'cancelled') return false;
    var today = todayIso();
    if (!m.meetsOn || m.meetsOn > today) return true;
    if (m.meetsOn < today) return false;
    var start = minutesOfClock(m.meetsAt || '00:00');
    return start !== null && nowMinutes() < start;
  }

  function comingEvents(mineOnly) {
    var today = todayIso();
    return S.events.filter(function (e) {
      if ((e.endsOn || e.startsOn) < today) return false;
      // A single-day event that has finished is no longer "coming up".
      if ((e.endsOn || e.startsOn) === today && !e.allDay
        && !stillAhead(e.startsOn, e.startsAt, e.endsAt)) return false;
      if (mineOnly && (e.people || []).length && e.people.indexOf(S.user.username) === -1) return false;
      // A search covers events as well as tasks — asking for E0007 and being
      // shown the whole calendar would not be a search.
      return matchesQuery(e);
    });
  }

  function eventCard(event) {
    return h('button', {
      class: 'event-card' + (event.pending ? ' pending' : ''),
      style: '--c:' + colourHex(event.colour),
      onclick: function () { openEvent(event); },
    }, [
      h('div', { class: 'ec-when', text: eventWhen(event) }),
      h('div', { class: 'ec-title', text: event.title }),
      event.place ? h('div', { class: 'ec-where', text: event.place }) : null,
    ]);
  }

  function eventStrip(main, mineOnly) {
    var coming = comingEvents(mineOnly);
    if (!coming.length) return;

    var shown = coming.slice(0, 6);
    main.appendChild(h('div', { class: 'event-strip' }, [
      h('div', { class: 'strip-head' }, [
        h('b', { text: t('upcoming') }),
        coming.length > shown.length
          ? h('small', { text: '+' + (coming.length - shown.length) })
          : null,
      ]),
      h('div', { class: 'strip-rail' }, shown.map(eventCard)),
    ]));
  }

  /**
   * Meetings and events in one rail, by date, on a phone.
   *
   * Two rails were two headings and two rows of cards — about 230px, more than
   * a quarter of the screen, before the first task. One rail sorted by when
   * keeps everything that is coming and gives the work back its space. The
   * meeting cards keep their indigo, so the two kinds are still told apart at
   * a glance.
   */
  function phoneStrip(main, mineOnly) {
    var all = comingMeetings(mineOnly).map(function (m) {
      return { on: m.meetsOn, at: m.meetsAt || '', card: function () { return meetingCard(m, true); } };
    }).concat(comingEvents(mineOnly).map(function (e) {
      return { on: e.startsOn, at: e.allDay ? '' : (e.startsAt || ''), card: function () { return eventCard(e); } };
    })).sort(function (a, b) {
      if (a.on !== b.on) return a.on < b.on ? -1 : 1;
      return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
    });
    if (!all.length) return;
    var shown = all.slice(0, 8);
    main.appendChild(h('div', { class: 'event-strip' }, [
      h('div', { class: 'strip-head' }, [
        h('b', { text: t('upcoming') }),
        all.length > shown.length ? h('small', { text: '+' + (all.length - shown.length) }) : null,
      ]),
      h('div', { class: 'strip-rail' }, shown.map(function (x) { return x.card(); })),
    ]));
  }


  /**
   * The meetings that are coming, in a rail of their own.
   *
   * They were folded in with the events at first, which looked tidier and was
   * worse: the rail stops at six, the events are sooner, and the committee's
   * next meeting fell off the end of a list it was supposed to be on. A
   * meeting is a different kind of thing from a rehearsal anyway — somebody
   * has to answer it.
   */
  /** The meetings still ahead, that this view should show. */
  function comingMeetings(mineOnly) {
    var today = todayIso();
    return (S.meetings || []).filter(function (m) {
      if (m.meetsOn < today || m.status === 'cancelled') return false;
      if (!stillAhead(m.meetsOn, m.meetsAt, m.endsAt)) return false;
      if (mineOnly && !(m.people || []).some(function (x) {
        return x.username === S.user.username;
      })) return false;
      return matchesQuery({ code: m.code, title: m.title, place: m.place });
    }).sort(function (a, b) { return a.meetsOn < b.meetsOn ? -1 : 1; });
  }

  /**
   * One meeting as a card in a rail.
   *
   * `friendlyDate` prints "18 พ.ย." instead of 2026-11-18 — used by the phone,
   * whose rail mixes meetings and events and would otherwise show two date
   * styles side by side.
   */
  function meetingCard(m, friendlyDate) {
    var going = (m.people || []).filter(function (x) {
      return x.username === S.user.username;
    })[0];
    var day = friendlyDate ? fmtDate(m.meetsOn, { day: 'numeric', month: 'short' }) : m.meetsOn;
    return h('button', {
      class: 'event-card meeting',
      onclick: function () { openMeeting(m); },
    }, [
      h('div', { class: 'ec-when', text: day + (m.meetsAt ? ' · ' + m.meetsAt : '') }),
      h('div', { class: 'ec-title', text: m.title }),
      h('div', { class: 'ec-where' }, [
        h('span', { class: 'chip ' + replyClass(going && going.reply),
          text: going
            ? (going.reply === 'accepted' ? t('rsvpGoing')
              : going.reply === 'declined' ? t('rsvpNotGoing') : t('rsvpAsk'))
            : (m.place || '') }),
        outrankedNote(m),
      ].filter(Boolean)),
    ]);
  }

  function meetingStrip(main, mineOnly) {
    var coming = comingMeetings(mineOnly);
    if (!coming.length) return;
    var shown = coming.slice(0, 6);

    main.appendChild(h('div', { class: 'event-strip' }, [
      h('div', { class: 'strip-head' }, [
        h('b', { text: t('navMeetings') }),
        coming.length > shown.length
          ? h('small', { text: '+' + (coming.length - shown.length) })
          : null,
      ]),
      h('div', { class: 'strip-rail' }, shown.map(function (m) { return meetingCard(m); })),
    ]));
  }


  /**
   * What is coming up, as an agenda: one slim row per meeting or event,
   * grouped under วันนี้ / พรุ่งนี้ / สัปดาห์นี้ / ถัดไป.
   *
   * This replaced two rails of cards that took a quarter of the screen before
   * the first task, and that she found too big to take in. A row says the
   * date, the name, the time and what kind of thing it is; anything else is
   * one tap away. Four rows show; the rest fold behind ดูทั้งหมด.
   */
  var UP_SHOWN = 4;
  function upcomingList(main, mineOnly) {
    var today = todayIso();
    var weekEnd = addDays(today, 7);
    var items = comingMeetings(mineOnly).map(function (m) {
      var me = (m.people || []).filter(function (x) { return x.username === S.user.username; })[0];
      return {
        kind: 'meeting', on: m.meetsOn, at: m.meetsAt || '', title: m.title, place: m.place || '',
        colour: null, open: function () { openMeeting(m); },
        // An invitation still waiting for an answer is the one thing worth flagging.
        flag: me && me.reply !== 'accepted' && me.reply !== 'declined' ? t('upNeedsReply') : '',
        extra: outrankedNote(m),
      };
    }).concat(comingEvents(mineOnly).map(function (e) {
      var ongoing = e.startsOn < today;
      return {
        kind: 'event', on: ongoing ? today : e.startsOn, at: e.allDay ? '' : (e.startsAt || ''),
        title: e.title, place: e.place || '', colour: colourHex(e.colour),
        until: e.endsOn && e.endsOn !== e.startsOn ? e.endsOn : null,
        allDay: e.allDay || !e.startsAt, pending: e.pending,
        open: function () { openEvent(e); },
      };
    })).sort(function (a, b) {
      if (a.on !== b.on) return a.on < b.on ? -1 : 1;
      return (a.at || '') < (b.at || '') ? -1 : (a.at || '') > (b.at || '') ? 1 : 0;
    });
    if (!items.length) return;

    var open = Boolean(S.upOpen);
    /**
     * A phone has room for three rows before the work starts, and no room for
     * day headings: the date column says วันนี้ / พรุ่งนี้ itself instead.
     */
    var phone = isPhone();
    var limit = phone ? 3 : UP_SHOWN;
    var shown = open ? items : items.slice(0, limit);
    var groupOf = function (iso) {
      if (iso <= today) return t('today');
      if (iso === addDays(today, 1)) return t('tomorrow');
      if (iso <= weekEnd) return t('upThisWeek');
      return t('upLater');
    };

    var list = h('div', { class: 'up-list' });
    var last = null;
    shown.forEach(function (x) {
      var g = groupOf(x.on);
      if (!phone && g !== last) { list.appendChild(h('div', { class: 'up-group', text: g })); last = g; }
      var time = x.kind === 'event' && x.allDay ? t('allDay') : (x.at || '');
      if (x.until) time = t('upUntil').replace('%d', fmtDate(x.until, { day: 'numeric', month: 'short' }));
      list.appendChild(h('button', {
        type: 'button',
        class: 'up-row ' + x.kind + (x.pending ? ' pending' : ''),
        style: x.colour ? '--c:' + x.colour : '',
        onclick: x.open,
      }, [
        h('span', { class: 'up-date', text: (phone && relativeDay(x.on)) || fmtDate(x.on, { day: 'numeric', month: 'short' }) }),
        h('span', { class: 'up-main' }, [
          h('span', { class: 'up-title', text: x.title }),
          x.place ? h('span', { class: 'up-place', text: x.place }) : null,
        ]),
        x.flag ? h('span', { class: 'up-flag', text: x.flag }) : null,
        x.extra || null,
        h('span', { class: 'up-time', text: time }),
        h('span', { class: 'up-kind', text: x.kind === 'meeting' ? t('upMeeting') : t('upEvent') }),
      ]));
    });

    main.appendChild(h('section', { class: 'upcoming' }, [
      h('div', { class: 'up-head' }, [
        h('b', { text: t('upcoming') }),
        h('span', { class: 'grow' }),
        items.length > limit ? h('button', {
          type: 'button', class: 'up-more',
          text: open ? t('phShowLess') : t('upSeeAll').replace('%n', String(items.length)),
          onclick: function () { S.upOpen = !open; renderPage(); },
        }) : null,
      ]),
      list,
    ]));
  }

  function taskRow(task, mode) {
    if (mode === 'list') return listRow(task);
    var meta = [];
    var prio = task.priority || 'medium';
    // Only show a chip when it is not the default — otherwise every card
    // carries the same badge and the urgent ones stop standing out.
    // How far the pieces have got, and how much work has been handed in.
    var parts = task.parts || [];
    if (parts.length) {
      var done = parts.filter(function (p) { return p.done; }).length;
      meta.push(h('span', {
        class: 'chip parts' + (done === parts.length ? ' done' : ''),
        text: '\u2713 ' + done + '/' + parts.length,
      }));
    }
    if ((task.links || []).length) {
      meta.push(h('span', { class: 'chip', text: '\u2197 ' + task.links.length }));
    }

    if (prio !== 'medium') {
      meta.push(h('span', { class: 'chip prio prio-' + prio, text: prioLabel(prio) }));
    }
    if ((task.viewers || []).length && task.mayEdit) {
      // To whoever set it up: how many are following along.
      meta.push(h('span', { class: 'chip viewers-n', title: t('viewers') }, [icon('eye'), String(task.viewers.length)]));
    }
    // Shown only to the person who is actually double-booked — see
    // outrankedNote. To everybody else it is somebody else's scheduling.
    var beaten = outrankedNote(task);
    if (beaten) meta.push(beaten);
    if (task.dueDate) {
      var rel = relativeDay(task.dueDate);
      meta.push(h('span', { class: 'chip' + (isOverdue(task) ? ' overdue' : '') }, [
        (isOverdue(task) ? t('overdue') + ' · ' : '') + (rel || fmtDate(task.dueDate)) +
        (task.dueTime ? ' ' + task.dueTime : ''),
      ]));
    }
    // The section it is filed under, which is finer-grained than the tags and
    // therefore worth more than they are on a crowded card.
    if (task.unit) {
      meta.push(h('span', { class: 'chip unit', text: task.unit }));
    }
    task.departments.forEach(function (d) {
      meta.push(h('span', { class: 'chip dept', text: deptLabel(d.key) + (d.scope === 'heads' ? ' · ' + t('scopeHeads') : d.scope === 'members' ? ' · ' + t('scopeMembers') : '') }));
    });

    var stack = h('span', { class: 'stack' }, task.assignees.slice(0, 4).map(function (u) { return avatarNode(u, 'sm'); }));
    if (task.assignees.length > 4) stack.appendChild(h('span', { class: 'avatar sm', text: '+' + (task.assignees.length - 4) }));

    var sp = task.spaceId ? spaceBy(task.spaceId) : null;
    if (sp) meta.push(h('span', { class: 'chip space-chip', style: '--sp:' + spaceHex(sp) }, [sp.name]));

    return h('li', {
      class: 'task' + (task.pending ? ' pending' : ''),
      dataset: { status: task.status, st: task.status, prio: task.priority || 'medium', urgency: urgencyOf(task) },
      onclick: function () { openTask(task); },
    }, [
      h('button', {
        class: 'status-btn' + (task.maySetStatus ? '' : ' locked'),
        text: MARK[task.status],
        title: statusLabel(task.status) + (task.maySetStatus ? '' : ' \u00b7 ' + t('statusLocked')),
        onclick: function (e) {
          e.stopPropagation();
          if (!task.maySetStatus) return;
          if (isPhone()) openStatusSheet(task);
          else openStatusMenu(e.currentTarget, task);
        },
      }),
      h('div', { class: 't-title' }, [
        /**
         * What this is to me, before anything else on the card: mine to do,
         * my department's, or one I only follow. Asked for in so many words —
         * a list mixing all three read as though it were all one kind.
         */
        roleBadge(task),
        // The code first, small and grey: something to quote, not to read.
        task.code ? h('span', { class: 't-code', text: task.code }) : null,
        task.title,
        /**
         * The person's own piece, on the card.
         *
         * Without this, someone on a five-part task has to open it to find
         * out which part is theirs — which is the whole reason for splitting
         * a task up in the first place.
         */
        task.myPart ? h('div', {
          class: 'my-part' + (task.myPart.done ? ' done' : ''),
          text: (task.myPart.done ? '\u2713 ' : '\u25B8 ') + t('yourPart') + ': ' + task.myPart.title,
        }) : null,
      ]),
      h('div', { class: 't-side' }, [stack]),
      meta.length ? h('div', { class: 't-meta' }, meta) : null,
    ]);
  }

  /**
   * A small menu of the five states.
   *
   * Clicking through a five-step ladder to reach "done" would take four
   * clicks; picking it takes one.
   */
  function openStatusMenu(anchor, task) {
    var existing = document.getElementById('status-menu');
    if (existing) existing.remove();

    var menu = h('div', { class: 'pop', id: 'status-menu', style: 'width:12rem' },
      [h('div', { class: 'items' }, STATUS_LIST.map(function (st) {
        return h('div', {
          class: 'item' + (task.status === st ? ' unread' : ''),
          onclick: function (e) {
            e.stopPropagation();
            menu.remove();
            if (st !== task.status) patchTask(task.id, { status: st });
          },
        }, [h('b', {}, [(MARK[st] || '\u00B7') + '  ' + statusLabel(st)])]);
      }))]);

    var box = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (box.bottom + 6) + 'px';
    menu.style.left = Math.min(box.left, window.innerWidth - 210) + 'px';
    menu.style.right = 'auto';
    document.body.appendChild(menu);

    setTimeout(function () {
      document.addEventListener('click', function close() {
        menu.remove();
        document.removeEventListener('click', close);
      }, { once: true });
    }, 0);
  }

  /**
   * A fold-out preview of one page with this person's signature on it.
   *
   * Closed to start with: most people open a document to read it, and
   * fetching and rendering a PDF for everybody who does would be a wasted
   * download. The signature is drawn with the same object-fit: contain that
   * the server stamps with, so the preview and the letter agree.
   */
  function signaturePreview(doc, data, mySteps) {
    var marks = [];
    mySteps.forEach(function (st) {
      (st.marks || []).forEach(function (m) { marks.push(Object.assign({}, m, { step: st })); });
    });
    marks.sort(function (a, b) { return a.page - b.page; });

    var box = h('div', { class: 'sig-check' });
    var body = h('div', { class: 'sig-check-body', hidden: true });
    var open = false;
    var shown = marks[0] ? marks[0].page : 1;
    var loaded = null;

    var head = h('button', {
      type: 'button', class: 'sig-check-head',
      onclick: function () {
        open = !open;
        body.hidden = !open;
        head.classList.toggle('on', open);
        if (open && !loaded) draw();
      },
    }, [
      icon('eye'),
      h('b', { text: t('docCheckMySignature') }),
      h('small', { text: t('docCheckMySignatureN').replace('%n', String(marks.length)) }),
      h('span', { class: 'grow' }),
      h('span', { class: 'sc-caret', text: '\u25be' }),
    ]);
    box.appendChild(head);
    box.appendChild(body);

    function draw() {
      clear(body);
      var canvas = h('canvas', { class: 'pdf-canvas' });
      var overlay = h('div', { class: 'pdf-overlay' });
      var sheet = h('div', { class: 'pdf-sheet' }, [canvas, overlay]);
      var note = h('p', { class: 'hint', text: t('loading') });
      var pager = h('div', { class: 'pdf-pager' });
      body.appendChild(note);
      body.appendChild(pager);
      body.appendChild(sheet);

      var step = mySteps[0];
      if (!step.hasSignature) {
        note.className = 'notice warn';
        note.textContent = t('docNoSignatureMine');
      }

      /**
       * The unsigned original, because that is what the box was placed on.
       * Once a letter has been archived the file is gone from here; the
       * preview says so rather than spinning.
       */
      loaded = fetch('/api/documents?id=' + encodeURIComponent(doc.id) + '&file=original', { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error(String(res.status));
          return res.arrayBuffer();
        })
        .then(function (buf) {
          var bytes = new Uint8Array(buf);
          return withPdfJs().then(function (lib) {
            function show() {
              return renderPdfPage(lib, bytes, shown, canvas, 760).then(function (info) {
                if (note.className === 'hint') note.textContent = t('docCheckHint');
                clear(pager);
                if (info.pages > 1) {
                  pager.appendChild(h('button', { class: 'btn sm', text: '\u2039', disabled: shown <= 1,
                    onclick: function () { shown -= 1; show(); } }));
                  pager.appendChild(h('span', { text: t('docPage') + ' ' + shown + ' / ' + info.pages }));
                  pager.appendChild(h('button', { class: 'btn sm', text: '\u203a', disabled: shown >= info.pages,
                    onclick: function () { shown += 1; show(); } }));
                }
                clear(overlay);
                marks.forEach(function (m) {
                  if (m.page !== shown) return;
                  overlay.appendChild(h('div', {
                    class: 'sig-box real mine on',
                    style: 'left:' + (m.x * 100) + '%;top:' + (m.y * 100) + '%;' +
                           'width:' + (m.w * 100) + '%;height:' + (m.h * 100) + '%',
                  }, [
                    m.step.hasSignature ? signatureImg(m.step.username) : null,
                    h('span', { class: 'sig-name', text: nameOf(m.step.username) }),
                  ]));
                });
              });
            }
            return show();
          });
        })
        .catch(function () {
          clear(body);
          body.appendChild(h('p', { class: 'hint', text: t('docCheckUnavailable') }));
        });
    }
    return box;
  }


  /**
   * Moving a signature that is already on the letter.
   *
   * The same canvas the boxes were placed on in the first place, opened on
   * one signer at a time and on a letter that is already part-signed. It is
   * here because the alternative was ตีกลับ: a box two centimetres too low
   * meant the whole chain had to approve the letter again, which is a lot of
   * people's afternoon spent on something nobody disagreed about.
   *
   * Only the rectangle moves. The approval, its time and its author are
   * untouched, and the stamped copy is rebuilt from the untouched original —
   * see canMoveMark and moveMark on the server.
   */
  function openMoveSignature(doc, step, onSaved) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var bodyBox = h('div', { class: 'body' });
    var footer = h('footer', {});
    var modal = h('div', { class: 'modal wide' }, [
      h('header', {}, [
        h('h2', { text: t('docMoveSig') + ' · ' + nameOf(step.username) }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      bodyBox, footer,
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);

    // Worked on as a copy, so cancelling really does leave the letter alone.
    var marks = (step.marks || []).map(function (m) {
      return { page: m.page, x: m.x, y: m.y, w: m.w, h: m.h };
    });
    var shown = marks[0] ? marks[0].page : 1;
    var pages = 1;
    var bytes = null;

    var canvas = h('canvas', { class: 'pdf-canvas' });
    var overlay = h('div', { class: 'pdf-overlay' });
    var sheet = h('div', { class: 'pdf-sheet' }, [canvas, overlay]);
    var pager = h('div', { class: 'pdf-pager' });
    var note = h('p', { class: 'hint', text: t('loading') });

    var sizePct = h('span', { class: 'sig-size-n' });
    var sizeIn = h('input', {
      type: 'range', min: '8', max: '45', step: '1', class: 'sig-size',
      value: String(Math.round((marks[0] ? marks[0].w : 0.26) * 100)),
    });
    var sizeRow = h('div', { class: 'sig-size-row' }, [h('label', { text: t('docSigSize') }), sizeIn, sizePct]);

    bodyBox.appendChild(h('div', { class: 'pane' }, [
      note,
      h('p', { class: 'hint', text: t('docMarkAdd') }),
      step.hasSignature ? null : h('div', { class: 'notice warn', text: t('docNoSignatureFor').replace('%s', nameOf(step.username)) }),
      sizeRow, pager, sheet,
    ]));

    var pageAspect = function () {
      return (canvas.width && canvas.height) ? (canvas.width / canvas.height) : 0.707;
    };

    function paintOverlay() {
      clear(overlay);
      marks.forEach(function (m) {
        if (m.page !== shown) return;
        overlay.appendChild(h('div', {
          class: 'sig-box on ' + (step.hasSignature ? 'real' : 'empty'),
          style: 'left:' + (m.x * 100) + '%;top:' + (m.y * 100) + '%;' +
                 'width:' + (m.w * 100) + '%;height:' + (m.h * 100) + '%',
        }, [
          step.hasSignature ? signatureImg(step.username) : null,
          h('span', { class: 'sig-name', text: nameOf(step.username) }),
        ]));
      });
    }

    function paintSize() {
      sizePct.textContent = sizeIn.value + '%';
      sizeIn.disabled = !marks.length;
    }
    sizeIn.addEventListener('input', function () {
      var box = sigBoxSize(step, pageAspect(), Number(sizeIn.value) / 100);
      marks.forEach(function (m) {
        // About its own centre, so resizing does not walk it across the page.
        m.x = Math.max(0, Math.min(1 - box.w, m.x + (m.w - box.w) / 2));
        m.y = Math.max(0, Math.min(1 - box.h, m.y + (m.h - box.h) / 2));
        m.w = box.w; m.h = box.h;
      });
      paintSize(); paintOverlay();
    });

    sheet.addEventListener('click', function (e) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      var point = e.touches && e.touches[0] ? e.touches[0] : e;
      var fx = (point.clientX - rect.left) / rect.width;
      var fy = (point.clientY - rect.top) / rect.height;
      var hit = -1;
      marks.forEach(function (m, i) {
        if (m.page === shown && fx >= m.x && fx <= m.x + m.w && fy >= m.y && fy <= m.y + m.h) hit = i;
      });
      if (hit >= 0) {
        marks.splice(hit, 1);
      } else {
        var size = sigBoxSize(step, pageAspect(), Number(sizeIn.value) / 100);
        marks.push({
          page: shown,
          x: Math.max(0, Math.min(1 - size.w, fx - size.w / 2)),
          y: Math.max(0, Math.min(1 - size.h, fy - size.h / 2)),
          w: size.w, h: size.h,
        });
      }
      paintSize(); paintOverlay(); drawFooter();
    });

    function drawPager() {
      clear(pager);
      if (pages < 2) return;
      pager.appendChild(h('button', { class: 'btn sm', text: '‹', disabled: shown <= 1,
        onclick: function () { shown -= 1; show(); } }));
      pager.appendChild(h('span', { text: t('docPage') + ' ' + shown + ' / ' + pages }));
      pager.appendChild(h('button', { class: 'btn sm', text: '›', disabled: shown >= pages,
        onclick: function () { shown += 1; show(); } }));
    }

    function show() {
      return withPdfJs().then(function (lib) {
        return renderPdfPage(lib, bytes, shown, canvas, 860);
      }).then(function (info) {
        pages = info.pages;
        note.className = 'hint';
        note.textContent = t('docMoveSigHint');
        drawPager(); paintOverlay();
      });
    }

    /** The unsigned original: it is the sheet the box is measured against. */
    fetch('/api/documents?id=' + encodeURIComponent(doc.id) + '&file=original', { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.arrayBuffer();
      })
      .then(function (buf) { bytes = new Uint8Array(buf); return show(); })
      .catch(function () {
        note.className = 'notice err';
        note.textContent = t('docCheckUnavailable');
      });

    var saving = false;
    function drawFooter() {
      clear(footer);
      footer.appendChild(h('button', {
        class: 'btn primary', text: t('save'), disabled: !marks.length || saving,
        onclick: function () {
          saving = true; drawFooter();
          api('/api/documents?do=move-mark', {
            method: 'POST',
            body: { id: doc.id, stepId: step.id, marks: marks },
          }).then(function () {
            veil.remove();
            if (onSaved) onSaved();
          }).catch(function (err) {
            saving = false; drawFooter();
            alert(errText(err.code));
          });
        },
      }));
      footer.appendChild(h('button', {
        class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); },
      }));
      if (!marks.length) footer.appendChild(h('span', { class: 'hint', text: t('docMoveSigNeedOne') }));
    }
    paintSize();
    drawFooter();
  }


  /**
   * Saving whatever is at a URL, under a name we choose.
   *
   * `<a download href="/api/…">` only honours the name for a same-origin URL
   * and, on a phone, often hands the file to a viewer instead of the
   * downloads folder. Fetching the bytes and handing over a blob behaves the
   * same way everywhere — the lesson the QR download already taught us.
   */
  function saveUrl(url, filename, onDone) {
    var give = function (href, revoke) {
      var a = document.createElement('a');
      a.download = filename;
      a.href = href;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        a.remove();
        if (revoke) URL.revokeObjectURL(href);
        if (onDone) onDone(null);
      }, 4000);
    };
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.blob();
    }).then(function (blob) {
      give(URL.createObjectURL(blob), true);
    }).catch(function (err) {
      // Nothing saved is better than a zero-byte file with the right name.
      if (onDone) onDone(err);
      else alert(t('docFileUnavailable'));
    });
  }

  /**
   * Reading a letter without leaving the app.
   *
   * The file chips used to be ordinary links with target="_blank". On a
   * computer that opens the browser's PDF viewer, which is fine. On a phone —
   * and especially on a phone where somebody installed this to their home
   * screen — it hands the PDF to whatever reader the system picks, and there
   * is no way back: no address bar, no back button, no app. People were
   * closing the whole thing and signing in again.
   *
   * So the PDF opens here instead: the page, a pager, a real ดาวน์โหลด that
   * puts the file in the downloads folder, and a ปิด big enough for a thumb.
   * Opening it in a tab is still offered for anyone who wants the browser's
   * own viewer.
   */
  function openPdfViewer(doc, kind, label) {
    var base = '/api/documents?id=' + encodeURIComponent(doc.id) + '&file=' + encodeURIComponent(kind);
    var fileName = ((doc.docNumber ? doc.docNumber + ' ' : '') + (doc.title || 'document') + '.pdf')
      .replace(/[\\/:*?"<>|]/g, '-');

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) close(); } });
    var canvas = h('canvas', { class: 'pdf-canvas' });
    var sheet = h('div', { class: 'pdf-sheet plain' }, [canvas]);
    var pager = h('div', { class: 'pdf-pager' });
    var note = h('p', { class: 'hint', text: t('loading') });
    /**
     * The browser's own viewer, for anyone who wants it, sits up here as a
     * quiet link rather than a third button in the footer: on a phone a third
     * button wraps onto its own row and pushes ปิด off the bottom of the
     * screen, which is the exact trap this reader exists to avoid.
     */
    var tabLink = h('a', {
      class: 'pdf-tab-link', target: '_blank', rel: 'noopener',
      href: base, text: t('docOpenTab'),
    });
    var topRow = h('div', { class: 'pdf-read-top' }, [pager, h('span', { class: 'grow' }), tabLink]);
    var bodyBox = h('div', { class: 'body pdf-read' }, [note, topRow, sheet]);
    var footer = h('footer', {});
    var modal = h('div', { class: 'modal wide pdf-modal' }, [
      h('header', {}, [
        h('h2', { text: label + (doc.docNumber ? ' · ' + doc.docNumber : '') }),
        h('button', { class: 'btn ghost sm', text: '✕', title: t('close'), onclick: function () { close(); } }),
      ]),
      bodyBox, footer,
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);

    function close() { veil.remove(); }

    var shown = 1;
    var pages = 1;
    var bytes = null;

    function drawPager() {
      clear(pager);
      if (pages < 2) return;
      pager.appendChild(h('button', {
        class: 'btn sm', text: '‹', disabled: shown <= 1,
        onclick: function () { shown -= 1; show(); },
      }));
      pager.appendChild(h('span', { text: t('docPage') + ' ' + shown + ' / ' + pages }));
      pager.appendChild(h('button', {
        class: 'btn sm', text: '›', disabled: shown >= pages,
        onclick: function () { shown += 1; show(); },
      }));
    }

    function show() {
      return withPdfJs().then(function (lib) {
        return renderPdfPage(lib, bytes, shown, canvas, 1100);
      }).then(function (info) {
        pages = info.pages;
        note.hidden = true;
        drawPager();
      });
    }

    /**
     * Download works even when the page cannot be drawn.
     *
     * pdf.js failing is a rendering problem; the bytes are still there and
     * still worth saving, so the button is built before the render is tried
     * and stays whatever happens.
     */
    function drawFooter() {
      clear(footer);
      var save = h('button', {
        class: 'btn primary', text: t('docDownload'),
        onclick: function () {
          save.disabled = true;
          save.textContent = t('docDownloading');
          saveUrl(base + '&download=1', fileName, function (err) {
            save.disabled = false;
            save.textContent = t('docDownload');
            if (err) alert(t('docFileUnavailable'));
          });
        },
      });
      footer.appendChild(save);
      footer.appendChild(h('button', { class: 'btn', text: t('close'), onclick: function () { close(); } }));
    }
    drawFooter();

    fetch(base, { credentials: 'same-origin' })
      .then(function (res) {
        if (res.ok) return res.arrayBuffer();
        return res.json().catch(function () { return {}; }).then(function (body) {
          var e = new Error(body.error || String(res.status));
          e.body = body;
          throw e;
        });
      })
      .then(function (buf) { bytes = new Uint8Array(buf); return show(); })
      .catch(function (err) {
        clear(bodyBox);
        var code = err && err.body && err.body.error;
        var driveUrl = err && err.body && err.body.driveUrl;
        bodyBox.appendChild(h('div', { class: 'notice warn', text:
          code === 'ARCHIVED' ? t('docFileInDrive')
            : code === 'REJECTED_FILE_REMOVED' ? t('docFileRejected')
              : t('docFileUnavailable') }));
        if (driveUrl) {
          bodyBox.appendChild(h('a', {
            class: 'btn primary', target: '_blank', rel: 'noopener',
            href: driveUrl, text: t('docInDrive'),
          }));
        }
        clear(footer);
        footer.appendChild(h('button', { class: 'btn', text: t('close'), onclick: function () { close(); } }));
      });
  }

  function patchTask(id, changes) {
    return api('/api/tasks', { method: 'PATCH', body: Object.assign({ id: id }, changes) })
      .then(function (data) { S.tasks = data.tasks; renderPage(); return data.task; })
      .catch(function (err) { alert(errText(err.code)); });
  }

  /* ---------- task modal ------------------------------------------------ */
  function openTask(task) {
    var isNew = !task;
    var draft = {
      title: task ? task.title : '',
      description: task ? task.description : '',
      dueDate: task ? task.dueDate : '',
      dueTime: task ? task.dueTime : '',
      status: task ? task.status : 'todo',
      priority: task ? (task.priority || 'medium') : 'medium',
      department: task ? (task.department || null) : (S.user.department || null),
      unit: task ? (task.unit || null) : null,
      // The names only: the people the department tags or the pieces put on it
      // come back on their own when it is saved — see writeTags on the server.
      assignees: task ? (task.named || task.assignees).slice() : [S.user.username],
      viewers: task ? (task.viewers || []).slice() : [],
      departments: task ? task.departments.map(function (d) { return { key: d.key, scope: d.scope }; }) : [],
      notify: task ? task.notify.slice() : ['created', '7d', '3d', '24h', 'due'],
    };

    /**
     * What this person may do here.
     *
     * A new task is always fully editable — you are writing it. An existing
     * one is editable by its creator and the admins; anyone else who is
     * tagged in it may move the status and nothing more. Fields they cannot
     * change are shown disabled rather than hidden, so the task still reads
     * as a whole and it is obvious why a control will not respond.
     */
    var mayEdit = isNew || task.mayEdit;
    var maySetStatus = isNew || task.maySetStatus;

    /**
     * Read first, edit on purpose.
     *
     * Most of the time a task is opened to find something out — when it is
     * due, who is on it, what has been handed in — and a screen of form
     * fields is a poor way to answer that. So an existing task opens as
     * something to read, and anyone allowed to change it presses แก้ไข to
     * turn the same pop-up into the form. A new task skips straight to the
     * form: there is nothing to read yet.
     */
    var mode = isNew ? 'edit' : 'view';

    var titleInput = h('input', {
      type: 'text', value: draft.title, maxlength: '200',
      placeholder: t('taskTitlePlaceholder'), disabled: !mayEdit,
    });
    var descInput = h('textarea', { maxlength: '4000', placeholder: t('description'), disabled: !mayEdit });
    descInput.value = draft.description;
    var dateInput = h('input', { type: 'date', value: draft.dueDate || '', disabled: !mayEdit });
    var timeInput = h('input', { type: 'time', value: draft.dueTime || '', disabled: !mayEdit });
    // Where the bar starts on the timeline. Optional; without it the task is a point on its due date.
    var startInput = h('input', { type: 'date', value: (task && task.startDate) || '', disabled: !mayEdit });
    /**
     * The space it is filed in. Offered from the spaces this person is in,
     * and opened from a space's own page the space is already chosen.
     */
    var spaceChoices = (S.spaces || []).filter(function (sp) { return sp.mine || S.seesEverything; });
    var presetSpace = task ? (task.spaceId || '') : (S.newTaskSpace || '');
    S.newTaskSpace = null;
    var spaceSelect = h('select', { disabled: !mayEdit }, [h('option', { value: '', text: t('spaceNone') })]
      .concat(spaceChoices.map(function (sp) {
        return h('option', { value: sp.id, text: sp.name, selected: sp.id === presetSpace });
      })));

    var peopleBox = h('div', { class: 'picker' + (mayEdit ? '' : ' readonly') });
    /**
     * Saying yes or no to being put on something.
     *
     * Being named on a task and having agreed to it are different facts, and
     * the system used to record only the first. This is shown to everybody so
     * that whoever created it can see who has actually answered — an accepted
     * task and a silent one look identical otherwise.
     */
    var replyBox = h('div', { class: 'rsvp' });
    function drawReplies() {
      clear(replyBox);
      if (isNew || !task) return;
      var replies = task.replies || [];
      var mine = replies.filter(function (x) { return x.username === S.user.username; })[0];

      /**
       * Once you have answered, the question stops being asked.
       *
       * Leaving both buttons sitting there afterwards reads as though nothing
       * was recorded — so an answer is shown as an answer, and changing it is
       * a deliberate second act rather than something a stray tap can do.
       */
      if (mine) {
        var answered = mine.reply === 'accepted' || mine.reply === 'declined';

        function askButtons() {
          [['accepted', 'rsvpAccept'], ['declined', 'rsvpDecline']].forEach(function (pair) {
            replyBox.appendChild(h('button', {
              type: 'button',
              class: 'btn sm rsvp-' + pair[0] + (mine.reply === pair[0] ? ' on' : ''),
              text: t(pair[1]),
              onclick: function () {
                api('/api/events?do=reply', {
                  method: 'POST',
                  body: { kind: 'task', id: task.id, reply: pair[0] },
                }).then(function () {
                  mine.reply = pair[0];
                  drawReplies();
                  api('/api/tasks').then(function (d) { S.tasks = d.tasks; });
                }).catch(function (err) { alert(errText(err.code)); });
              },
            }));
          });
        }

        if (answered && !S.rsvpOpen) {
          replyBox.appendChild(h('span', { class: 'chip ' + replyClass(mine.reply),
            text: mine.reply === 'accepted' ? t('rsvpYouAccepted') : t('rsvpYouDeclined') }));
          replyBox.appendChild(h('button', {
            type: 'button', class: 'btn sm', text: t('rsvpChange'),
            onclick: function () { S.rsvpOpen = true; drawReplies(); },
          }));
        } else {
          replyBox.appendChild(h('span', { class: 'hint', text: t('rsvpAsk') }));
          askButtons();
        }
      }

      // The tally, so the person who set it up can see who is missing.
      var counted = { accepted: 0, declined: 0, invited: 0 };
      replies.forEach(function (x) { counted[x.reply === 'accepted' ? 'accepted'
        : x.reply === 'declined' ? 'declined' : 'invited'] += 1; });
      if (replies.length) {
        replyBox.appendChild(h('span', { class: 'rsvp-count', text:
          t('rsvpTally').replace('%a', String(counted.accepted))
            .replace('%d', String(counted.declined))
            .replace('%w', String(counted.invited)) }));
      }
    }
    drawReplies();

    var deptBox = h('div', { class: 'picker' + (mayEdit ? '' : ' readonly') });
    /**
     * Viewers: people who should see how it is going without doing it.
     *
     * A separate list from the people on it, because everything else keys off
     * that one — reminders, "my tasks", who may move the status. Somebody put
     * on the task drops off this list: doing it already includes seeing it.
     */
    var viewerBox = h('div', { class: 'picker viewers' + (mayEdit ? '' : ' readonly') });
    if (mayEdit) {
      var redrawViewers = null;
      buildPeoplePicker(peopleBox, draft, {
        changed: function () {
          draft.viewers = draft.viewers.filter(function (u) { return draft.assignees.indexOf(u) === -1; });
          if (redrawViewers) redrawViewers();
        },
      });
      redrawViewers = buildPeoplePicker(viewerBox, draft, {
        field: 'viewers',
        compact: true,
        placeholder: t('viewersSearch'),
        empty: t('noViewers'),
        skip: function (u) { return draft.assignees.indexOf(u) !== -1; },
      });
      buildDeptPicker(deptBox, draft);
    } else {
      viewerBox.appendChild(draft.viewers.length
        ? peopleList(draft.viewers)
        : h('div', { class: 'selected' }, [h('span', { class: 'chip', text: t('noViewers') })]));
      // Read-only: who is on it still matters to the person doing the work.
      peopleBox.appendChild(draft.assignees.length
        ? peopleList(draft.assignees)
        : h('div', { class: 'selected' }, [h('span', { class: 'chip', text: t('noOne') })]));
      deptBox.appendChild(h('div', { class: 'selected' }, draft.departments.length
        ? draft.departments.map(function (d) {
            return h('span', { class: 'chip dept', text: deptLabel(d.key) });
          })
        : [h('span', { class: 'chip', text: '\u2014' })]));
    }

    var notifyBox = h('div', { class: 'checks' }, [
      ['created', 'notifyCreated'], ['7d', 'notify7d'], ['3d', 'notify3d'],
      ['24h', 'notify24h'], ['due', 'notifyDue'],
    ].map(function (pair) {
      var cb = h('input', {
        type: 'checkbox', checked: draft.notify.indexOf(pair[0]) !== -1, disabled: !mayEdit,
      });
      cb.addEventListener('change', function () {
        draft.notify = draft.notify.filter(function (k) { return k !== pair[0]; });
        if (cb.checked) draft.notify.push(pair[0]);
      });
      return h('label', {}, [cb, t(pair[1])]);
    }));

    var statusSeg = h('div', { class: 'seg wrap' }, STATUS_LIST.map(function (st) {
      var b = h('button', {
        type: 'button', class: draft.status === st ? 'on' : '', text: statusLabel(st),
        disabled: !maySetStatus,
        onclick: function () {
          draft.status = st;
          statusSeg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
        },
      });
      return b;
    }));

    var prioSeg = h('div', { class: 'seg wrap' }, PRIORITY_LIST.slice().reverse().map(function (p) {
      var b = h('button', {
        type: 'button', class: 'prio-btn prio-' + p + (draft.priority === p ? ' on' : ''),
        text: prioLabel(p), disabled: !mayEdit,
        onclick: function () {
          draft.priority = p;
          prioSeg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
        },
      });
      return b;
    }));

    /**
     * Which teamspace the task lives in — this decides who can see it.
     * Editors may only file into their own department, which is why the
     * control is disabled for them rather than hidden: silently ignoring a
     * choice is worse than showing it is not available.
     */
    var choices = myDepartments();
    var deptSelect = h('select', {
      disabled: !mayEdit || (!S.seesEverything && choices.length < 2),
      onchange: function (e) {
        draft.department = e.target.value || null;
        // The sections belong to the department, so changing one empties the
        // other rather than leaving a task filed under a section its new
        // department does not have.
        draft.unit = null;
        drawUnits();
      },
    }, [h('option', { value: '', text: t('noDepartment') })].concat(
      choices.map(function (d) {
        return h('option', { value: d.key, text: deptOptionLabel(d), selected: draft.department === d.key });
      })
    ));

    /**
     * The section within that teamspace.
     *
     * Hidden entirely when the department has no sections — an empty dropdown
     * is a question with no answers. Filing here is optional: plenty of work
     * belongs to a department as a whole.
     */
    var unitBox = h('div', { class: 'field' });
    function drawUnits() {
      clear(unitBox);
      var units = draft.department ? unitsOf(draft.department) : [];
      unitBox.hidden = units.length === 0;
      if (!units.length) return;
      unitBox.appendChild(h('label', { text: t('unit') }));
      unitBox.appendChild(h('select', {
        disabled: !mayEdit,
        onchange: function (e) { draft.unit = e.target.value || null; },
      }, [h('option', { value: '', text: t('wholeDepartment') })].concat(
        units.map(function (u) {
          return h('option', { value: u, text: u, selected: draft.unit === u });
        })
      )));
    }
    drawUnits();

    /**
     * Three tabs rather than one long scroll.
     *
     * The detail pane is what the task IS; the parts pane is who does which
     * piece of it; the work pane is what has been handed in. They are
     * different questions asked at different moments, and stacking them into
     * one column meant scrolling past the whole form to find an attachment.
     */
    var TABS = [
      ['detail', t('tabDetails')],
      ['parts', t('tabParts')],
      ['links', t('tabWork')],
    ];
    var pane = 'detail';

    var detailPane = h('div', {});
    var partsPane = h('div', {});
    var linksPane = h('div', {});

    var tabBar = h('div', { class: 'seg tabs-seg' }, TABS.map(function (pair) {
      var count = pair[0] === 'parts' ? (task ? task.parts.length : 0)
        : pair[0] === 'links' ? (task ? task.links.length : 0)
          : 0;
      return h('button', {
        type: 'button', class: pane === pair[0] ? 'on' : '',
        // A new task has nothing to break up or hand in yet — save it first.
        disabled: isNew && pair[0] !== 'detail',
        onclick: function () { pane = pair[0]; paintPanes(); },
      }, [pair[1], count ? h('span', { class: 'n', text: String(count) }) : null]);
    }));

    function paintPanes() {
      tabBar.querySelectorAll('button').forEach(function (b, i) {
        var key = TABS[i][0];
        b.classList.toggle('on', key === pane);
        // Rebuilt rather than patched: a tab that had no badge grows one the
        // moment the first sub-task or attachment is added.
        var count = key === 'parts' ? (task ? task.parts.length : 0)
          : key === 'links' ? (task ? task.links.length : 0) : 0;
        clear(b);
        b.appendChild(document.createTextNode(TABS[i][1]));
        if (count) b.appendChild(h('span', { class: 'n', text: String(count) }));
      });
      detailPane.hidden = pane !== 'detail';
      partsPane.hidden = pane !== 'parts';
      linksPane.hidden = pane !== 'links';
      if (pane === 'detail') {
        clear(detailPane);
        detailPane.appendChild(mode === 'view' ? buildViewPane() : buildDetailPane());
      }
      if (pane === 'parts') drawParts();
      if (pane === 'links') drawLinks();
      paintFooter();
    }

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) close(); } });
    var modal = h('div', { class: 'modal' }, [
      h('header', {}, [
        // An existing task is named by its own title, not by the word "task".
        h('h2', { text: isNew ? t('newTask') : task.title }),
        // The code, where somebody can copy it to paste into a chat.
        (!isNew && task.code) ? codeChip(task.code) : null,
        h('button', { class: 'btn ghost sm', text: '✕', onclick: close }),
      ]),
      h('div', { class: 'body' }, [
        tabBar,
        detailPane,
        partsPane,
        linksPane,
      ]),
    ]);

    /**
     * The task as something to read.
     *
     * Ordered by what people come here to find out: how it stands and when it
     * is due, then what it actually is, then who is on it. Sub-tasks and work
     * handed in get a line each with a count, because knowing there are three
     * attachments is half the reason to open the other tabs.
     */
    /** My labels, as chips that save on the tap. */
    function taskTagRow() {
      var row = h('span', { class: 'selected tag-pick' });
      (S.myTags || []).forEach(function (tag) {
        var on = (task.tags || []).indexOf(tag.name) !== -1;
        row.appendChild(h('button', {
          type: 'button', class: 'chip' + (on ? ' on' : ''), text: tag.name,
          onclick: function (e) {
            e.target.disabled = true;
            api('/api/tasks?do=tag', {
              method: on ? 'DELETE' : 'POST',
              body: { id: task.id, name: tag.name },
            }).then(function (d) {
              task.tags = d.tags || [];
              var inList = (S.tasks || []).filter(function (x) { return x.id === task.id; })[0];
              if (inList) inList.tags = task.tags;
              paintPanes();
            }).catch(function (err) { e.target.disabled = false; alert(errText(err.code)); });
          },
        }));
      });
      return row;
    }

    function buildViewPane() {
      var parts = task.parts || [];
      var links = task.links || [];
      var doneParts = parts.filter(function (p) { return p.done; }).length;

      var band = h('div', { class: 'view-band' }, [
        statusPill(task.status),
        (task.priority && task.priority !== 'medium')
          ? h('span', { class: 'vb-prio prio-' + task.priority, text: prioLabel(task.priority) })
          : null,
        h('span', { class: 'grow' }),
        h('span', {
          class: 'vb-due u-' + urgencyOf(task),
          text: whenWording(task.dueDate, task.dueTime),
        }),
      ]);

      var roles = task.roles || {};
      var byDept = task.assignees.filter(function (u) { return roles[u] === 'dept'; });
      var doing = task.assignees.filter(function (u) { return roles[u] !== 'dept'; });
      var rows = [
        // What it is to me, first — see roleBadge.
        roleBadge(task) ? vRow(t('roleYours'), h('span', {}, [roleBadge(task),
          h('small', { class: 'role-why', text: t((task.myRole === 'part' ? 'rolePart' : ROLE_KEYS[roleOf(task)]) + 'Hint') })])) : null,
        // Folds to a row of faces on a phone when it is a crowd — see peopleList.
        vRow(t('roleNamedPeople'), doing.length
          ? peopleList(doing)
          : vMuted(t('noOne'))),
        byDept.length ? vRow(t('roleDeptPeople'), peopleList(byDept)) : null,
        (task.viewers || []).length
          ? vRow(t('roleWatchPeople'), peopleList(task.viewers))
          : null,
        vRow(t('viewDepartments'), task.departments.length
          ? h('span', { class: 'selected' }, task.departments.map(function (d) {
              return h('span', { class: 'chip dept', text: deptLabel(d.key) });
            }))
          : vMuted('—')),
        vRow(t('viewTeamspace'), task.department
          ? h('span', {}, [
              deptLabel(task.department),
              task.unit ? h('span', { class: 'chip unit', style: 'margin-left:6px', text: task.unit }) : null,
            ])
          : vMuted('—')),
        task.spaceId && spaceBy(task.spaceId) ? vRow(t('space'), h('a', { class: 'where-chip', href: '#/space/' + encodeURIComponent(task.spaceId),
          style: '--sp:' + spaceHex(spaceBy(task.spaceId)), onclick: function () { close(); } }, [h('i'), spaceBy(task.spaceId).name])) : null,
        task.startDate ? vRow(t('startDate'), document.createTextNode(whenWording(task.startDate))) : null,
      ];

      // Sub-tasks and attachments, each a line that takes you to its tab.
      if (parts.length) {
        rows.push(vRow(t('tabParts'), h('button', {
          class: 'vlink', onclick: function () { pane = 'parts'; paintPanes(); },
        }, [
          h('span', { class: 'vbar' }, [h('i', { style: 'width:' + Math.round(doneParts / parts.length * 100) + '%' })]),
          t('partsDone').replace('{n}', String(doneParts)).replace('{of}', String(parts.length)),
        ])));
      }
      if (links.length) {
        rows.push(vRow(t('tabWork'), h('button', {
          class: 'vlink', onclick: function () { pane = 'links'; paintPanes(); },
          text: t('linksCount').replace('{n}', String(links.length)),
        })));
      }
      rows.push(vRow(t('createdBy'), h('span', { class: 'selected' },
        [h('span', { class: 'chip who' }, [avatarNode(task.createdBy, 'sm'), nameOf(task.createdBy)])])));
      /**
       * My own labels on this task.
       *
       * On the read pane rather than in the form, and saved the moment they
       * are tapped, because a label is not part of the task: nobody else can
       * see it, and putting it behind แก้ไข would mean somebody who is not
       * allowed to change the task could not label it — which is exactly the
       * person waiting on work that is not theirs.
       */
      if ((S.myTags || []).length) rows.push(vRow(t('tagMine'), taskTagRow()));
      // What this person hears about this one task.
      rows.push(vRow(t('notifyThis'), notifyControl('task', task.id, taskCategory(task))));

      /**
       * Moving the status is the one change almost everyone is allowed to
       * make, and it is the change they make most often. Putting it here,
       * saving the moment it is pressed, means the common case never has to
       * go near the form at all.
       */
      var quick = null;
      if (maySetStatus) {
        var seg = h('div', { class: 'seg wrap' }, STATUS_LIST.map(function (st) {
          return h('button', {
            type: 'button', class: task.status === st ? 'on' : '', text: statusLabel(st),
            onclick: function () { setStatusNow(st); },
          });
        }));
        quick = h('div', { class: 'field view-quick' }, [h('label', { text: t('changeStatus') }), seg]);
      }

      return h('div', { class: 'pane view-pane' }, [
        band,
        task.description
          ? h('p', { class: 'view-desc', text: task.description })
          : h('p', { class: 'view-desc empty', text: t('noDescription') }),
        h('div', { class: 'view-rows' }, rows),
        quick,
        (!mayEdit && !maySetStatus)
          ? h('div', { class: 'notice' + (task.watching ? ' watching-note' : ''),
              text: task.watching ? t('watchingNote') : t('viewOnlyNote') })
          : null,
      ]);
    }

    /** Saves a status change straight from the read view, with no form. */
    function setStatusNow(st) {
      if (st === task.status) return;
      var previous = S.tasks;
      var before = task.status;
      task.status = st;
      S.tasks = S.tasks.map(function (x) {
        return x.id === task.id ? Object.assign({}, x, { status: st }) : x;
      });
      renderPage();
      paintPanes();
      api('/api/tasks', { method: 'PATCH', body: { id: task.id, status: st } })
        .then(refreshFrom)
        .catch(function (err) {
          task.status = before;
          S.tasks = previous;
          renderPage();
          paintPanes();
          alert(errText(err.code));
        });
    }

    // Kept out of the markup above so the three panes read as three things.
    function buildDetailPane() { return h('div', { class: 'pane' }, [
        h('div', { class: 'field' }, [h('label', { text: t('taskTitle') }), titleInput]),
        h('div', { class: 'field' }, [h('label', { text: t('description') }), descInput]),
        h('div', { class: 'two three' }, [
          h('div', { class: 'field' }, [h('label', { text: t('dueDate') }), dateInput]),
          h('div', { class: 'field' }, [h('label', { text: t('dueTime') }), timeInput]),
          h('div', { class: 'field' }, [h('label', { text: t('startDate') }), startInput]),
        ]),
        spaceChoices.length || presetSpace ? h('div', { class: 'field' }, [h('label', { text: t('space') }), spaceSelect]) : null,
        h('div', { class: 'field' }, [h('label', { text: t('assignTo') }), peopleBox, replyBox]),
        h('div', { class: 'field' }, [
          h('label', { text: t('viewers') }),
          h('small', { class: 'field-hint', text: t('viewersHint') }),
          viewerBox,
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('departments') }), deptBox]),
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('teamspace') }), deptSelect,
            (!S.seesEverything && choices.length < 2)
              ? h('small', { style: 'color:var(--ink-faint);font-size:11.5px', text: t('lockedToDept') })
              : null]),
          unitBox,
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('priority') }), prioSeg]),
        h('div', { class: 'field' }, [h('label', { text: statusLabel('todo') + ' \u2192 ' + statusLabel('done') }), statusSeg]),
        h('div', { class: 'field' }, [h('label', { text: t('notifyWhen') }), notifyBox]),
        task ? h('p', { class: 'hint', style: 'font-size:12.5px;color:var(--ink-faint);margin:0' },
          [t('createdBy') + ': ' + nameOf(task.createdBy)]) : null,
        (task && !mayEdit) ? h('div', { class: 'notice' , style: 'margin-top:8px' },
          [maySetStatus ? t('statusOnlyNote') : t('viewOnlyNote')]) : null,
      ]); }

    /**
     * The buttons follow the mode, because the two modes are asking different
     * things. Reading offers a way out and a way in — close, or edit. Editing
     * offers a way to commit and a way to back out without committing.
     */
    var footer = h('footer', {});
    function paintFooter() {
      clear(footer);

      if (mode === 'view') {
        footer.appendChild(h('button', { class: 'btn primary', text: t('close'), onclick: close }));
        if (mayEdit) {
          footer.appendChild(h('button', {
            class: 'btn', text: '✎ ' + t('editTask'),
            onclick: function () { mode = 'edit'; pane = 'detail'; paintPanes(); },
          }));
        }
        if (task.dueDate) {
          footer.appendChild(h('a', {
            class: 'btn', target: '_blank', rel: 'noopener',
            // Shorter on a phone, where the footer gives each button half a
            // line and the full wording was cut off mid-word.
            href: googleCalUrl(task), text: '📅 ' + (isPhone() ? 'Google Calendar' : t('addToCalendar')),
          }));
        }
        return;
      }

      // Someone who may only move the status still gets a save button — it
      // just saves less. Removing it entirely would leave them with no way to
      // commit the one change they are allowed to make.
      if (mayEdit || maySetStatus) {
        footer.appendChild(h('button', {
          class: 'btn primary',
          text: isNew ? t('addTask') : (mayEdit ? t('saveTask') : t('saveStatus')),
          onclick: save,
        }));
      }
      footer.appendChild(h('button', {
        class: 'btn', text: t('cancel'),
        // Backing out of an edit returns to the task, not out of it entirely.
        onclick: isNew ? close : function () { mode = 'view'; paintPanes(); },
      }));
      // Deleting is the creator's and the admins', not everybody who may edit.
      if (task && task.mayDelete) {
        footer.appendChild(h('span', { class: 'grow' }));
        footer.appendChild(h('button', {
          class: 'btn danger', text: t('deleteTask'),
          onclick: function () {
            if (!confirm(t('confirmDelete'))) return;
            api('/api/tasks?id=' + encodeURIComponent(task.id), { method: 'DELETE' })
              .then(function (d) { S.tasks = d.tasks; close(); renderPage(); })
              .catch(function (err) { alert(errText(err.code)); });
          },
        }));
      }
    }
    modal.appendChild(footer);

    paintPanes();

    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
    setTimeout(function () { if (isNew) titleInput.focus(); }, 30);

    function close() { veil.remove(); }

    /** Replaces the task in hand after any change, so the panes stay honest. */
    function refreshFrom(data) {
      S.tasks = data.tasks;
      if (data.task) task = data.task;
      renderPage();
      paintPanes();
    }

    function callTask(path, options) {
      return api(path, options)
        .then(refreshFrom)
        .catch(function (err) { alert(errText(err.code)); });
    }

    /* ---- sub-tasks: who does which piece ---- */
    function drawParts() {
      clear(partsPane);
      if (!task) return;

      var parts = task.parts || [];
      var done = parts.filter(function (p) { return p.done; }).length;

      partsPane.appendChild(h('p', { class: 'hint' }, [
        parts.length ? t('partsProgress').replace('{d}', String(done)).replace('{n}', String(parts.length))
          : t('partsEmpty'),
      ]));

      if (parts.length) {
        partsPane.appendChild(h('ul', { class: 'parts' }, parts.map(function (part) {
          // Only the person it belongs to, or whoever runs the task, may tick it.
          var mayTick = task.mayEdit || part.assignee === S.user.username;
          var mine = part.assignee === S.user.username;

          var box = h('input', { type: 'checkbox', checked: part.done, disabled: !mayTick });
          box.addEventListener('change', function () {
            callTask('/api/tasks?do=part', { method: 'PATCH', body: { id: part.id, done: box.checked } });
          });

          return h('li', { class: (part.done ? 'done ' : '') + (mine ? 'mine' : '') }, [
            box,
            h('div', { class: 'grow' }, [
              h('div', { class: 'p-title', text: part.title }),
              h('div', { class: 'p-who' }, part.assignee
                ? [avatarNode(part.assignee, 'sm'), nameOf(part.assignee), mine ? ' \u00b7 ' + t('yours') : '']
                : [h('span', { class: 'chip', text: t('unassigned') })]),
            ]),
            task.mayEdit ? h('button', {
              class: 'btn ghost sm', title: t('removePart'), text: '\u2715',
              onclick: function () {
                if (!confirm(t('confirmRemovePart'))) return;
                callTask('/api/tasks?do=part&id=' + encodeURIComponent(part.id), { method: 'DELETE' });
              },
            }) : null,
          ]);
        })));
      }

      if (!task.mayEdit) return;   // only the owner hands pieces out

      var titleIn = h('input', { type: 'text', maxlength: '200', placeholder: t('partPlaceholder') });
      var whoSel = h('select', {}, [h('option', { value: '', text: t('unassigned') })].concat(
        groupedPeopleOptions(S.users.filter(function (u) { return u.active && !u.suspended; }))
      ));
      var add = h('button', {
        class: 'btn', text: '+ ' + t('addPart'),
        onclick: function () {
          var title = titleIn.value.trim();
          if (!title) { titleIn.focus(); return; }
          callTask('/api/tasks?do=part', {
            method: 'POST',
            body: { taskId: task.id, title: title, assignee: whoSel.value || null },
          });
        },
      });
      titleIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') add.click(); });

      partsPane.appendChild(h('div', { class: 'add-row' }, [titleIn, whoSel, add]));
    }

    /* ---- work handed in ---- */
    var LINK_MARK = {
      drive: '\u25B3', doc: '\u25A4', sheet: '\u25A6', slide: '\u25B7',
      form: '\u2261', figma: '\u25C7', canva: '\u25CB', video: '\u25B6', link: '\u2197',
    };

    function drawLinks() {
      clear(linksPane);
      if (!task) return;

      var links = task.links || [];
      linksPane.appendChild(h('p', { class: 'hint', text: links.length ? t('workHint') : t('workEmpty') }));

      if (links.length) {
        linksPane.appendChild(h('ul', { class: 'links' }, links.map(function (link) {
          var part = (task.parts || []).filter(function (p) { return p.id === link.partId; })[0];
          var mayRemove = task.mayEdit || link.addedBy === S.user.username;

          return h('li', {}, [
            h('span', { class: 'l-mark ' + link.kind, text: LINK_MARK[link.kind] || LINK_MARK.link }),
            h('div', { class: 'grow' }, [
              h('a', {
                href: link.url, target: '_blank', rel: 'noopener noreferrer',
                text: link.label || link.url,
              }),
              h('div', { class: 'l-who' }, [
                nameOf(link.addedBy) + ' \u00b7 ' + fmtWhen(link.createdAt),
                part ? h('span', { class: 'chip', text: part.title }) : null,
              ]),
            ]),
            mayRemove ? h('button', {
              class: 'btn ghost sm', title: t('removeLink'), text: '\u2715',
              onclick: function () {
                if (!confirm(t('confirmRemoveLink'))) return;
                callTask('/api/tasks?do=link&id=' + encodeURIComponent(link.id), { method: 'DELETE' });
              },
            }) : null,
          ]);
        })));
      }

      if (!task.mayAttach) {
        linksPane.appendChild(h('div', { class: 'notice', text: t('cannotAttach') }));
        return;
      }

      var urlIn = h('input', { type: 'url', placeholder: 'https://…  ' + t('orDriveLink') });
      var labelIn = h('input', { type: 'text', maxlength: '120', placeholder: t('linkLabel') });
      var partSel = (task.parts || []).length
        ? h('select', {}, [h('option', { value: '', text: t('wholeTask') })].concat(
            task.parts.map(function (p) { return h('option', { value: p.id, text: p.title }); })
          ))
        : null;

      var attach = h('button', {
        class: 'btn primary', text: t('attachWork'),
        onclick: function () {
          var value = urlIn.value.trim();
          if (!value) { urlIn.focus(); return; }
          callTask('/api/tasks?do=link', {
            method: 'POST',
            body: {
              taskId: task.id, url: value,
              label: labelIn.value.trim(),
              partId: partSel ? (partSel.value || null) : null,
            },
          });
        },
      });
      urlIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') attach.click(); });

      linksPane.appendChild(h('div', { class: 'field attach-form' }, [
        urlIn, labelIn, partSel, attach,
        h('small', { class: 'hint', text: t('driveHint') }),
      ]));
    }

    function save() {
      // Someone who may only move the status sends only the status. Sending
      // the untouched fields as well would be refused by the server, which
      // rightly treats "everything, unchanged" as an edit attempt.
      if (!mayEdit) {
        api('/api/tasks', { method: 'PATCH', body: { id: task.id, status: draft.status } })
          .then(function (data) { S.tasks = data.tasks; close(); renderPage(); })
          .catch(function (err) { alert(errText(err.code)); });
        return;
      }

      var body = {
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        dueDate: dateInput.value || null,
        dueTime: timeInput.value || null,
        startDate: startInput.value || null,
        spaceId: spaceSelect.value || null,
        status: draft.status,
        priority: draft.priority,
        department: draft.department,
        unit: draft.unit,
        assignees: draft.assignees,
        viewers: draft.viewers.filter(function (u) { return draft.assignees.indexOf(u) === -1; }),
        departments: draft.departments,
        notify: draft.notify,
      };
      if (!body.title) { titleInput.focus(); return; }

      /**
       * Show it immediately, confirm afterwards.
       *
       * The server has to write the task, work out who to tell, and push a
       * notification to several phones — a second or so, all of it after the
       * only decision the person cares about has been made. So the list is
       * updated from what they typed, the form closes, and the real answer
       * replaces the stand-in when it arrives. If the save fails the
       * stand-in is removed and they are told, which is the one case where
       * this is worse than waiting, and it is rare.
       */
      var optimistic = Object.assign({}, task || {}, body, {
        id: isNew ? 'pending_' + Date.now().toString(36) : task.id,
        createdBy: isNew ? S.user.username : task.createdBy,
        parts: task ? task.parts : [],
        links: task ? task.links : [],
        mayEdit: true,
        maySetStatus: true,
        mayAttach: true,
        pending: true,
      });

      /**
       * Checked BEFORE the optimistic update, not after.
       *
       * The usual pattern here is to show the change at once and confirm it
       * afterwards, which is right when the only question is whether the
       * server is quick. This question is whether the person wants to do it at
       * all — closing the form and putting the task on the board first, then
       * asking, would be asking after the fact.
       */
      askAboutClashes({ on: body.dueDate, at: body.dueTime },
        body.assignees, isNew ? null : task.id).then(function (answer) {
        if (!answer.go) return;
        if (answer.prioritise) body.prioritise = true;

        var previous = S.tasks;
        S.tasks = isNew
          ? [optimistic].concat(S.tasks)
          : S.tasks.map(function (x) { return x.id === task.id ? optimistic : x; });
        close();
        renderPage();

        var call = isNew
          ? api('/api/tasks', { method: 'POST', body: body })
          : api('/api/tasks', { method: 'PATCH', body: Object.assign({ id: task.id }, body) });

        call.then(function (data) { S.tasks = data.tasks; renderPage(); refreshNotifications(); })
          .catch(function (err) {
            S.tasks = previous;   // put the list back exactly as it was
            renderPage();
            alert(errText(err.code));
          });
      });
    }
  }

  /**
   * `opts.field` is which list on the draft it edits — the people doing the
   * task by default, or its viewers. `opts.skip` names people to leave out of
   * the choices (the viewer picker skips whoever is already on the task), and
   * `opts.changed` runs after each pick, so the other picker can follow.
   */
  function buildPeoplePicker(box, draft, opts) {
    opts = opts || {};
    var key = opts.field || 'assignees';
    var skip = opts.skip || function () { return false; };
    function changed() { redraw(); if (opts.changed) opts.changed(); }
    function redraw() {
      clear(box);
      var selected = h('div', { class: 'selected' }, draft[key].length
        ? draft[key].map(function (u) {
            return h('span', {
              class: 'chip who x',
              onclick: function () {
                draft[key] = draft[key].filter(function (x) { return x !== u; });
                changed();
              },
            }, [avatarNode(u, 'sm'), nameOf(u), ' ✕']);
          })
        : [h('span', { class: 'chip', text: opts.empty || t('noOne') })]);

      /**
       * The circles, above the search box.
       *
       * Naming eleven heads one at a time before every meeting is how people
       * stop using a system. Tapping a circle adds everyone in it; tapping it
       * again takes them all back out, so it is a shortcut rather than a trap.
       */
      var circleRow = h('div', { class: 'seg wrap circles' });
      circleChoices().forEach(function (c) {
        // Whoever this picker leaves out (the people already doing the task,
        // when picking viewers) is left out of the circle too.
        var members = c.members.filter(function (u) { return !skip(u); });
        if (!members.length) return;
        c = { label: c.label, note: c.note, members: members };
        var allIn = c.members.every(function (u) {
          return draft[key].indexOf(u) !== -1;
        });
        circleRow.appendChild(h('button', {
          type: 'button', class: allIn ? 'on' : '',
          title: c.note || '',
          text: c.label + ' (' + c.members.length + ')',
          onclick: function () {
            if (allIn) {
              /**
               * Turning a circle off never removes you from your own work.
               *
               * You are almost always inside the circle you just picked, so a
               * plain "remove everyone in it" quietly takes the organiser off
               * their own meeting — and the server puts them back anyway, so
               * the page would be showing something that was not going to
               * happen.
               */
              draft[key] = draft[key].filter(function (u) {
                return c.members.indexOf(u) === -1 || (key === 'assignees' && u === S.user.username);
              });
            } else {
              c.members.forEach(function (u) {
                if (draft[key].indexOf(u) === -1) draft[key].push(u);
              });
            }
            changed();
          },
        }));
      });

      var search = h('input', { type: 'text', placeholder: opts.placeholder || t('assignTo') });
      var options = h('div', { class: 'options' });

      function fill() {
        clear(options);
        var q = search.value.trim().toLowerCase();
        // A compact picker (viewers, which most tasks leave empty) lists
        // nobody until a name is typed, rather than doubling the form's length.
        options.hidden = Boolean(opts.compact) && !q;
        if (options.hidden) return;
        // Everybody active, in every department: see assignableTo.
        var matches = S.users.filter(function (u) { return u.active && assignableTo(u) && !skip(u.username); })
          .filter(function (u) {
          return !q || u.displayName.toLowerCase().indexOf(q) !== -1 ||
            u.username.toLowerCase().indexOf(q) !== -1 ||
            (u.nickname || '').toLowerCase().indexOf(q) !== -1 ||
            (u.unit || '').toLowerCase().indexOf(q) !== -1;
        });

        // My departments first, everyone else after — see groupPeople. Keeps
        // this usable when the roster grows from 18 heads to the whole committee.
        var groups = groupPeople(matches);

        groups.forEach(function (g) {
          options.appendChild(h('div', { class: 'group-label', text: g.label }));
          g.people.forEach(function (u) {
            var on = draft[key].indexOf(u.username) !== -1;
            options.appendChild(h('div', {
              class: 'opt' + (on ? ' on' : ''),
              onclick: function () {
                if (on) draft[key] = draft[key].filter(function (x) { return x !== u.username; });
                else draft[key].push(u.username);
                changed();
              },
            }, [avatarNode(u.username, 'sm'), (u.unit ? u.unit + ' \u00B7 ' : '') + u.displayName,
                h('small', { text: u.position || u.username })]));
          });
        });
      }
      search.addEventListener('input', fill);
      fill();

      box.appendChild(selected);
      if (circleRow.childNodes.length) box.appendChild(circleRow);
      box.appendChild(h('div', { class: 'search' }, [search]));
      box.appendChild(options);
    }
    redraw();
    return redraw;
  }

  function buildDeptPicker(box, draft) {
    function has(key, scope) {
      return draft.departments.some(function (d) { return d.key === key && d.scope === scope; });
    }
    function toggle(key, scope) {
      if (has(key, scope)) {
        draft.departments = draft.departments.filter(function (d) { return !(d.key === key && d.scope === scope); });
      } else {
        draft.departments = draft.departments.filter(function (d) { return d.key !== key; });
        draft.departments.push({ key: key, scope: scope });
      }
      redraw();
    }
    function everyone(scope) {
      var reachable = myDepartments();
      var full = reachable.every(function (d) { return has(d.key, scope); });
      draft.departments = draft.departments.filter(function (d) { return d.scope !== scope; });
      if (!full) reachable.forEach(function (d) { draft.departments.push({ key: d.key, scope: scope }); });
      redraw();
    }

    function redraw() {
      clear(box);
      box.appendChild(h('div', { class: 'selected' }, draft.departments.length
        ? draft.departments.map(function (d) {
            return h('span', {
              class: 'chip dept x', onclick: function () { toggle(d.key, d.scope); },
            }, [deptLabel(d.key) + (d.scope === 'all' ? '' : ' · ' + t(d.scope === 'heads' ? 'scopeHeads' : 'scopeMembers')) + ' ✕']);
          })
        : [h('span', { class: 'chip', text: '—' })]));

      box.appendChild(h('div', { class: 'search' }, [
        h('button', { type: 'button', class: 'btn sm', text: t('allHeads'), onclick: function () { everyone('heads'); } }),
        ' ',
        h('button', { type: 'button', class: 'btn sm', text: t('allMembers'), onclick: function () { everyone('members'); } }),
      ]));

      var options = h('div', { class: 'options' });
      myDepartments().forEach(function (d) {
        options.appendChild(h('div', { class: 'group-label', text: deptOptionLabel(d) }));
        [['all', 'scopeAll'], ['heads', 'scopeHeads'], ['members', 'scopeMembers']].forEach(function (pair) {
          options.appendChild(h('div', {
            class: 'opt' + (has(d.key, pair[0]) ? ' on' : ''),
            onclick: function () { toggle(d.key, pair[0]); },
          }, [t(pair[1])]));
        });
      });
      box.appendChild(options);
    }
    redraw();
  }

  /* ---------- bulk import ----------------------------------------------- */
  /**
   * The task template.
   *
   * Every column the importer understands, in the order they make sense to
   * fill in. Only `title` is required; leave anything else blank and a
   * sensible default is used. Sub-tasks and links live in one cell each —
   * "what@who" and "label|url" — separated by semicolons, because a
   * spreadsheet cannot nest and asking people to keep two files in step is
   * worse than one slightly dense column.
   */
  var TEMPLATE_CSV =
    'title,description,assignees,departments,teamspace,unit,due date,due time,priority,status,parts,links,notify\n' +
    'จองเวทีกลาง,ติดต่อฝ่ายอาคารขอใช้พื้นที่,Jade_Pres;Kaew_VP,content:heads,content,Stage,2026-10-05,18:30,high,todo,' +
      '"ทำหนังสือขอใช้สถานที่@Jade_Pres; ยืนยันผังเวที@Kaew_VP","ผังเวที|https://drive.google.com/file/d/xxx/view",' +
      '"created,7d,24h,due"\n' +
    'Confirm sponsor banners,,Yam_HeadSpon,sponsor,sponsor,,2026-10-12,,highest,doing,,,"created,24h"\n' +
    'ประชุมใหญ่คณะกรรมการ,วาระ: สรุปงบประมาณ,,oper1:all,oper1,VR,2026-10-20,14:00,medium,todo,,,\n' +
    'ส่งไฟล์โปสเตอร์ให้ตรวจ,,Kungking_HeadCon,pr,pr,Graphic Design,2026-11-01,,medium,review,,,"created,due"\n';

  /**
   * The event template.
   *
   * An event has a start and an end rather than a deadline, and nobody owes
   * anything on it — so no status, no priority, no sub-tasks. "who" and
   * "departments" narrow who it concerns; leave both blank and it is for the
   * whole committee.
   */
  var EVENT_TEMPLATE_CSV =
    'title,description,starts on,starts at,ends on,ends at,all day,place,who,departments,colour,notify\n' +
    'ซ้อมใหญ่บนเวที,ซ้อมคิวพิธีกรและลำดับการแสดง,2026-11-20,14:00,,17:00,no,หอประชุมจุฬาฯ,,content,blue,"7d,24h,due"\n' +
    'งานจุฬาฯแฟร์ 2569,,2026-11-25,,2026-11-29,,yes,สนามหน้าพระบรมรูปสองรัชกาล,,,amber,"7d,24h,due"\n' +
    'ประชุมหัวหน้าฝ่าย,สรุปความคืบหน้าทุกฝ่าย,2026-10-15,17:00,,19:00,no,ห้องประชุมชั้น 4,Jade_Pres;Kaew_VP,,plum,"24h,due"\n';

  function openImport(startKind) {
    var mode = 'paste';
    // Which of the two things is being imported. They share the whole dialog
    // because the steps are identical — only the columns differ.
    var kind = startKind === 'events' ? 'events' : 'tasks';
    var rows = null;
    var notice = h('div', { class: 'notice err', hidden: true });

    var textarea = h('textarea', { placeholder: t('pasteCsv'), style: 'min-height:9rem' });
    var sheetInput = h('input', { type: 'text', placeholder: 'https://docs.google.com/spreadsheets/d/...' });
    var fileInput = h('input', { type: 'file', accept: '.csv,text/csv' });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { textarea.value = reader.result; mode = 'paste'; paintTabs(); };
      reader.readAsText(file, 'utf-8');
    });

    var tabs = h('div', { class: 'imp-tabs' });
    var input = h('div');
    var previewBox = h('div');

    function paintTabs() {
      clear(tabs);
      [['paste', t('pasteCsv')], ['sheet', t('sheetLink')], ['file', t('chooseFile')]].forEach(function (pair) {
        tabs.appendChild(h('button', {
          type: 'button', class: 'btn sm' + (mode === pair[0] ? ' primary' : ''), text: pair[1],
          onclick: function () { mode = pair[0]; paintTabs(); },
        }));
      });
      clear(input);
      input.appendChild(mode === 'paste' ? textarea : mode === 'sheet' ? sheetInput : fileInput);
    }
    paintTabs();

    function showError(code, message) {
      notice.hidden = false;
      notice.className = 'notice err';
      notice.textContent = message || errText(code);
    }

    function doPreview() {
      notice.hidden = true;
      var payload = mode === 'sheet' ? { sheetUrl: sheetInput.value.trim() } : { csv: textarea.value };
      if (!payload.csv && !payload.sheetUrl) { showError('EMPTY'); return; }
      payload.kind = kind;

      api('/api/import?do=preview', { method: 'POST', body: payload })
        .then(function (data) { rows = data.rows; paintPreview(data); })
        .catch(function (err) { showError(err.code, err.data && err.data.message); });
    }

    function paintPreview(data) {
      clear(previewBox);
      if (!rows || !rows.length) { showError('EMPTY'); return; }

      var good = rows.filter(function (r) { return !r.problems.length; });
      previewBox.appendChild(h('p', { style: 'margin:10px 0 6px;font-size:13.5px' },
        [t('rowsFound') + ' ' + rows.length + ' ' + t('rowsUnit') + ' \u00B7 ' + t('willCreate') + ' ' + good.length]));

      var body = rows.map(function (r) {
        var flags = [];
        (r.unknownPeople || []).forEach(function (n) { flags.push(h('div', { class: 'imp-warn', text: t('nameNotFound') + ': ' + n })); });
        (r.unknownDepts || []).forEach(function (n) { flags.push(h('div', { class: 'imp-warn', text: t('deptNotFound') + ': ' + n })); });
        if (r.problems.indexOf('BAD_DATE') !== -1) flags.push(h('div', { class: 'imp-bad', text: t('badDate') }));
        if (r.problems.indexOf('BAD_TIME') !== -1) flags.push(h('div', { class: 'imp-bad', text: t('badTime') }));
        if (r.problems.indexOf('ENDS_BEFORE_START') !== -1) flags.push(h('div', { class: 'imp-bad', text: t('errEndsBeforeStart') }));
        if (r.notes.indexOf('DAY_FIRST_ASSUMED') !== -1) flags.push(h('div', { class: 'imp-warn', text: t('dayFirstNote') }));
        if (r.notes.indexOf('BAD_LINK') !== -1) flags.push(h('div', { class: 'imp-warn', text: t('errBadLink') }));

        if (kind === 'events') {
          return h('tr', { class: r.problems.length ? 'off' : '' }, [
            h('td', {}, [
              h('span', { class: 'chip dept', style: 'background:' + colourHex(r.colour) + ';color:#fff;border:none', text: ' ' }),
              ' ' + r.title,
            ]),
            h('td', { dataset: { label: t('startsOn') }, text: (r.startsOn || '\u2014') + (r.startsAt ? ' ' + r.startsAt : '') +
              (r.endsOn && r.endsOn !== r.startsOn ? ' \u2013 ' + r.endsOn : '') }),
            h('td', { dataset: { label: t('place') }, text: r.place || '\u2014' }),
            h('td', { dataset: { label: t('departments') } }, (r.departments || []).map(function (k) { return h('span', { class: 'chip dept', text: deptLabel(k) }); })),
            h('td', {}, flags),
          ]);
        }

        return h('tr', { class: r.problems.length ? 'off' : '' }, [
          h('td', {}, [
            r.title,
            (r.parts || []).length ? h('div', { class: 'imp-sub', text: '\u2713 ' + r.parts.length + ' ' + t('tabParts') }) : null,
            (r.links || []).length ? h('div', { class: 'imp-sub', text: '\u2197 ' + r.links.length + ' ' + t('tabWork') }) : null,
          ]),
          h('td', { dataset: { label: t('assignTo') } }, [h('span', { class: 'stack' }, (r.assignees || []).map(function (u) { return avatarNode(u, 'sm'); }))]),
          h('td', { dataset: { label: t('departments') } }, (r.departments || []).map(function (d) { return h('span', { class: 'chip dept', text: deptLabel(d.key) }); })),
          h('td', { dataset: { label: t('dueDate') }, text: (r.dueDate || '\u2014') + (r.dueTime ? ' ' + r.dueTime : '') }),
          h('td', {}, flags),
        ]);
      });

      previewBox.appendChild(h('div', { class: 'imp-rows' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, kind === 'events'
            ? [h('th', { text: t('eventTitle') }), h('th', { text: t('startsOn') }),
               h('th', { text: t('place') }), h('th', { text: t('departments') }), h('th', { text: '' })]
            : [h('th', { text: t('taskTitle') }), h('th', { text: t('assignTo') }),
               h('th', { text: t('departments') }), h('th', { text: t('dueDate') }), h('th', { text: '' })])]),
          h('tbody', {}, body),
        ]),
      ]));

      footer.hidden = false;
      importBtn.textContent = t('importNow') + ' (' + good.length + ')';
      importBtn.disabled = good.length === 0;
    }

    var importBtn = h('button', {
      class: 'btn primary', text: t('importNow'),
      onclick: function () {
        var good = rows.filter(function (r) { return !r.problems.length; });
        importBtn.disabled = true;
        api('/api/import?do=commit', { method: 'POST', body: { rows: good, kind: kind } })
          .then(function (data) {
            var reload = kind === 'events'
              ? api('/api/events').then(function (fresh) { S.events = fresh.events; })
              : api('/api/tasks').then(function (fresh) { S.tasks = fresh.tasks; });
            return reload.then(function () {
              notice.hidden = false; notice.className = 'notice ok';
              notice.textContent = t('importedOk') + ': ' + data.created + ' ' + t('rowsUnit');
              clear(previewBox); footer.hidden = true;
              renderPage();
            });
          })
          .catch(function (err) { showError(err.code); importBtn.disabled = false; });
      },
    });
    var footer = h('div', { style: 'display:flex;gap:8px;align-items:center', hidden: true }, [importBtn]);

    // The column list belongs to whichever kind is selected — a person reading
    // "due date" while importing events is being told the wrong thing.
    var columnHelp = h('p', {
      style: 'margin:0;font-size:12.5px;color:var(--ink-faint)',
      text: t(kind === 'events' ? 'templateHelpEvents' : 'templateHelp'),
    });

    // Switching kind throws away any preview: the columns mean different things.
    var kindSeg = h('div', { class: 'seg' }, [['tasks', 'importTasksKind'], ['events', 'importEventsKind']]
      .map(function (pair) {
        return h('button', {
          type: 'button', class: kind === pair[0] ? 'on' : '', text: t(pair[1]),
          onclick: function () {
            kind = pair[0];
            rows = null;
            clear(previewBox);
            footer.hidden = true;
            notice.hidden = true;
            columnHelp.textContent = t(kind === 'events' ? 'templateHelpEvents' : 'templateHelp');
            kindSeg.querySelectorAll('button').forEach(function (b, i) {
              b.classList.toggle('on', ['tasks', 'events'][i] === kind);
            });
          },
        });
      }));

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    veil.appendChild(h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h2', { text: t('importTitle') }),
        h('button', { class: 'btn ghost sm', text: '\u2715', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice,
        kindSeg,
        h('p', { style: 'margin:0;font-size:13.5px;color:var(--ink-soft)', text: t('importHelp') }),
        columnHelp,
        h('button', {
          class: 'btn sm', style: 'align-self:flex-start', text: '\u2193 ' + t('downloadTemplate'),
          onclick: function () {
            // A BOM makes Excel open Thai text correctly instead of as mojibake.
            var text = kind === 'events' ? EVENT_TEMPLATE_CSV : TEMPLATE_CSV;
            var blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = kind === 'events' ? 'fair-events-template.csv' : 'fair-tasks-template.csv';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
          },
        }),
        tabs, input,
        h('button', { class: 'btn', style: 'align-self:flex-start', text: t('preview'), onclick: doPreview }),
        previewBox,
        footer,
      ]),
    ]));
    $('modal-root').appendChild(veil);
  }

  /* ---------- calendar -------------------------------------------------- */
  /* ---------- events ------------------------------------------------------ */

  /**
   * Dates to know about, with no work attached.
   *
   * Kept as its own page rather than a filter on the task list, because the
   * question "what is happening next week" is not the question "what do I owe
   * anyone" — and mixing them is how a rehearsal ends up with a status.
   */
  /** "20 Nov" · "20–25 Nov" · "20 Nov 14:00–17:00" — whichever fits. */
  function eventWhen(event) {
    var from = fmtDate(event.startsOn, { day: 'numeric', month: 'short' });
    if (event.endsOn && event.endsOn !== event.startsOn) {
      return from + ' – ' + fmtDate(event.endsOn, { day: 'numeric', month: 'short' });
    }
    if (event.allDay || !event.startsAt) return from + ' \u00b7 ' + t('allDay');
    return from + ' \u00b7 ' + event.startsAt + (event.endsAt ? '–' + event.endsAt : '');
  }

  /** Create or edit one. */
  function openEvent(event) {
    var isNew = !event;
    var mayEdit = isNew || event.mayEdit;

    var draft = {
      colour: event ? event.colour : 'plum',
      people: event ? (event.people || []).slice() : [],
      departments: event ? (event.departments || []).slice() : [],
      notify: event ? event.notify.slice() : ['7d', '3d', '24h', 'due'],
      allDay: event ? event.allDay : true,
    };

    var titleIn = h('input', { type: 'text', maxlength: '200', value: event ? event.title : '',
      placeholder: t('eventTitlePlaceholder'), disabled: !mayEdit });
    var descIn = h('textarea', { maxlength: '4000', rows: '2', placeholder: t('description'), disabled: !mayEdit });
    descIn.value = event ? event.description : '';
    var placeIn = h('input', { type: 'text', maxlength: '200', value: event ? event.place : '',
      placeholder: t('placePlaceholder'), disabled: !mayEdit });

    var startOn = h('input', { type: 'date', value: event ? event.startsOn : todayIso(), disabled: !mayEdit });
    var endOn = h('input', { type: 'date', value: event && event.endsOn ? event.endsOn : '', disabled: !mayEdit });
    var startAt = h('input', { type: 'time', value: event && event.startsAt ? event.startsAt : '', disabled: !mayEdit });
    var endAt = h('input', { type: 'time', value: event && event.endsAt ? event.endsAt : '', disabled: !mayEdit });

    var allDayCb = h('input', { type: 'checkbox', checked: draft.allDay, disabled: !mayEdit });
    function paintTimes() {
      startAt.disabled = endAt.disabled = !mayEdit || allDayCb.checked;
      timeRow.style.opacity = allDayCb.checked ? '.45' : '1';
    }
    allDayCb.addEventListener('change', function () { draft.allDay = allDayCb.checked; paintTimes(); });

    var timeRow = h('div', { class: 'two' }, [
      h('div', { class: 'field' }, [h('label', { text: t('startsAt') }), startAt]),
      h('div', { class: 'field' }, [h('label', { text: t('endsAt') }), endAt]),
    ]);

    var swatches = h('div', { class: 'swatches' }, S.colours.map(function (c) {
      var b = h('button', {
        type: 'button', class: 'swatch' + (draft.colour === c.key ? ' on' : ''),
        style: 'background:' + c.hex, title: c.key, disabled: !mayEdit,
        onclick: function () {
          draft.colour = c.key;
          swatches.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
        },
      });
      return b;
    }));

    var whoBox = h('div', { class: 'picker' + (mayEdit ? '' : ' readonly') });
    function drawWho() {
      clear(whoBox);
      whoBox.appendChild(h('div', { class: 'selected' },
        (draft.people.length || draft.departments.length)
          ? draft.people.map(function (u) {
              return h('span', {
                class: 'chip who' + (mayEdit ? ' x' : ''),
                onclick: mayEdit ? function () {
                  draft.people = draft.people.filter(function (x) { return x !== u; });
                  drawWho();
                } : null,
              }, [avatarNode(u, 'sm'), nameOf(u), mayEdit ? ' \u2715' : '']);
            }).concat(draft.departments.map(function (k) {
              return h('span', {
                class: 'chip dept' + (mayEdit ? ' x' : ''),
                onclick: mayEdit ? function () {
                  draft.departments = draft.departments.filter(function (x) { return x !== k; });
                  drawWho();
                } : null,
              }, [deptLabel(k) + (mayEdit ? ' \u2715' : '')]);
            }))
          : [h('span', { class: 'chip', text: t('everyoneInFair') })]));

      if (!mayEdit) return;

      var pick = h('select', {
        onchange: function (e) {
          var v = e.target.value;
          e.target.value = '';
          if (!v) return;
          if (v.indexOf('d:') === 0) {
            var key = v.slice(2);
            if (draft.departments.indexOf(key) === -1) draft.departments.push(key);
          } else if (draft.people.indexOf(v) === -1) draft.people.push(v);
          drawWho();
        },
      }, [h('option', { value: '', text: '+ ' + t('addPerson') })]
        .concat(S.departments.map(function (d) {
          return h('option', { value: 'd:' + d.key, text: deptOptionLabel(d) });
        }))
        .concat(groupedPeopleOptions(S.users.filter(function (u) {
          return u.active && !u.suspended && draft.people.indexOf(u.username) === -1;
        }))));
      whoBox.appendChild(pick);
    }
    drawWho();

    var notifyBox = h('div', { class: 'checks' }, [
      ['7d', 'notify7d'], ['3d', 'notify3d'], ['24h', 'notify24h'], ['due', 'notifyEventDay'],
    ].map(function (pair) {
      var cb = h('input', { type: 'checkbox', checked: draft.notify.indexOf(pair[0]) !== -1, disabled: !mayEdit });
      cb.addEventListener('change', function () {
        draft.notify = draft.notify.filter(function (k) { return k !== pair[0]; });
        if (cb.checked) draft.notify.push(pair[0]);
      });
      return h('label', {}, [cb, t(pair[1])]);
    }));

    /**
     * An event read rather than filled in.
     *
     * Almost nobody opens an event to change it \u2014 they open it to find out
     * when and where. So that is what this says, in the order it is asked,
     * and the form stays behind a button for the handful of people who own it.
     */
    function buildEventView() {
      /**
       * A run of days is said as two dates; a single day with hours is said
       * as one date and a time range. Both keep "in eleven days" at the end,
       * where it finishes the sentence rather than interrupting it.
       */
      var when;
      if (event.endsOn && event.endsOn !== event.startsOn) {
        when = whenWording(event.startsOn, event.allDay ? null : event.startsAt,
          fmtDate(event.endsOn, { day: 'numeric', month: 'long', year: 'numeric' }));
      } else {
        when = whenWording(event.startsOn, event.allDay ? null : event.startsAt,
          event.allDay ? null : (event.endsAt || null));
      }

      var audience = (event.people || []).length || (event.departments || []).length
        ? h('div', { class: 'ppl-wrap' }, [
            (event.people || []).length ? peopleList(event.people) : null,
            (event.departments || []).length
              ? h('span', { class: 'selected' }, event.departments.map(function (k) {
                  return h('span', { class: 'chip dept', text: deptLabel(k) });
                }))
              : null,
          ])
        : vMuted(t('everyoneInFair'));

      return h('div', { class: 'pane view-pane' }, [
        h('div', { class: 'view-band' }, [
          h('span', { class: 'vb-dot', style: 'background:' + colourHex(event.colour) }),
          h('span', { class: 'vb-when', text: when }),
          h('span', { class: 'grow' }),
          event.allDay ? h('span', { class: 'vb-prio', text: t('allDay') }) : null,
        ]),
        event.description
          ? h('p', { class: 'view-desc', text: event.description })
          : h('p', { class: 'view-desc empty', text: t('noDescription') }),
        h('div', { class: 'view-rows' }, [
          vRow(t('place'), event.place ? h('span', { text: event.place }) : vMuted('\u2014')),
          vRow(t('whoIsItFor'), audience),
          vRow(t('createdBy'), h('span', { class: 'selected' },
            [h('span', { class: 'chip who' }, [avatarNode(event.createdBy, 'sm'), nameOf(event.createdBy)])])),
          event.id && !event.pending ? vRow(t('notifyThis'), notifyControl('event', event.id, 'event')) : null,
        ]),
        !mayEdit ? h('div', { class: 'notice', text: t('eventViewOnly') }) : null,
      ]);
    }

    function buildEventForm() {
      return h('div', { class: 'pane' }, [
        h('div', { class: 'field' }, [h('label', { text: t('eventTitle') }), titleIn]),
        h('div', { class: 'field' }, [h('label', { text: t('description') }), descIn]),
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('startsOn') }), startOn]),
          h('div', { class: 'field' }, [h('label', { text: t('endsOn') }), endOn]),
        ]),
        h('label', { class: 'inline-check' }, [allDayCb, t('allDay')]),
        timeRow,
        h('div', { class: 'field' }, [h('label', { text: t('place') }), placeIn]),
        h('div', { class: 'field' }, [h('label', { text: t('whoIsItFor') }), whoBox]),
        h('div', { class: 'field' }, [h('label', { text: t('colour') }), swatches]),
        h('div', { class: 'field' }, [h('label', { text: t('remindWhen') }), notifyBox]),
      ]);
    }

    var mode = isNew ? 'edit' : 'view';
    var bodyBox = h('div', { class: 'body' });
    var footer = h('footer', {});

    function paintEvent() {
      clear(bodyBox);
      bodyBox.appendChild(mode === 'view' ? buildEventView() : buildEventForm());
      paintTimes();

      clear(footer);
      if (mode === 'view') {
        footer.appendChild(h('button', { class: 'btn primary', text: t('close'), onclick: close }));
        if (mayEdit) {
          footer.appendChild(h('button', {
            class: 'btn', text: '\u270e ' + t('editEvent'),
            onclick: function () { mode = 'edit'; paintEvent(); },
          }));
        }
        return;
      }
      footer.appendChild(h('button', {
        class: 'btn primary', text: isNew ? t('addEvent') : t('save'), onclick: save,
      }));
      footer.appendChild(h('button', {
        class: 'btn', text: t('cancel'),
        onclick: isNew ? close : function () { mode = 'view'; paintEvent(); },
      }));
      if (event) {
        footer.appendChild(h('span', { class: 'grow' }));
        footer.appendChild(h('button', {
          class: 'btn danger', text: t('deleteEvent'),
          onclick: function () {
            if (!confirm(t('confirmDeleteEvent'))) return;
            api('/api/events?id=' + encodeURIComponent(event.id), { method: 'DELETE' })
              .then(function (d) { S.events = d.events; close(); renderPage(); })
              .catch(function (err) { alert(errText(err.code)); });
          },
        }));
      }
    }

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) close(); } });
    var modal = h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h2', { text: isNew ? t('newEvent') : event.title }),
        (!isNew && event.code) ? codeChip(event.code) : null,
        h('button', { class: 'btn ghost sm', text: '\u2715', onclick: close }),
      ]),
      bodyBox,
      footer,
    ]);

    paintEvent();
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
    setTimeout(function () { if (isNew) titleIn.focus(); }, 30);

    function close() { veil.remove(); }

    function save() {
      var body = {
        title: titleIn.value.trim(),
        description: descIn.value.trim(),
        startsOn: startOn.value,
        endsOn: endOn.value || null,
        allDay: allDayCb.checked,
        startsAt: allDayCb.checked ? null : (startAt.value || null),
        endsAt: allDayCb.checked ? null : (endAt.value || null),
        place: placeIn.value.trim(),
        colour: draft.colour,
        people: draft.people,
        departments: draft.departments,
        notify: draft.notify,
      };
      if (!body.title) { titleIn.focus(); return; }
      if (!body.startsOn) { startOn.focus(); return; }

      // Same as tasks: show it now, reconcile when the server answers.
      var optimistic = Object.assign({}, event || {}, body, {
        id: isNew ? 'pending_' + Date.now().toString(36) : event.id,
        createdBy: isNew ? S.user.username : event.createdBy,
        mayEdit: true,
        pending: true,
      });

      // An all-day event cannot clash with an hour, so it is not worth asking.
      askAboutClashes(
        body.allDay ? null : { on: body.startsOn, at: body.startsAt, to: body.endsAt },
        body.people, isNew ? null : event.id,
      ).then(function (answer) {
        if (!answer.go) return;
        if (answer.prioritise) body.prioritise = true;

        var previous = S.events;
        S.events = isNew
          ? S.events.concat([optimistic])
          : S.events.map(function (x) { return x.id === event.id ? optimistic : x; });
        close();
        renderPage();

        var call = isNew
          ? api('/api/events', { method: 'POST', body: body })
          : api('/api/events', { method: 'PATCH', body: Object.assign({ id: event.id }, body) });

        call.then(function (d) { S.events = d.events; renderPage(); })
          .catch(function (err) {
            S.events = previous;
            renderPage();
            alert(errText(err.code));
          });
      });
    }
  }

  /* ---------- calendar ---------------------------------------------------- */

  /**
   * A month grid, the way a calendar actually looks.
   *
   * The old version was a list of the next N days, which answered "what is
   * coming up" but never "what does November look like" — and a committee
   * planning a fair needs the second one. Month, week and day share the same
   * cell renderer so a chip means the same thing in all three.
   */
  function pageCalendar(main) {
    if (isPhone()) return phoneCalendar(main);
    var view = S.calView || 'month';
    var anchor = S.calAnchor || todayIso();

    function shift(step) {
      if (view === 'month') S.calAnchor = addMonths(anchor, step);
      else if (view === 'week') S.calAnchor = addDays(anchor, step * 7);
      else S.calAnchor = addDays(anchor, step);
      renderPage();
    }

    var title = view === 'month'
      ? fmtDate(anchor, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? fmtDate(startOfWeek(anchor), { day: 'numeric', month: 'short' }) + ' – ' +
          fmtDate(addDays(startOfWeek(anchor), 6), { day: 'numeric', month: 'short', year: 'numeric' })
        : fmtDate(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    main.appendChild(h('div', { class: 'cal-bar' }, [
      h('div', { class: 'cal-nav' }, [
        h('button', { class: 'btn sm', text: '\u2039', title: t('previous'), onclick: function () { shift(-1); } }),
        h('button', { class: 'btn sm', text: t('today'), onclick: function () { S.calAnchor = todayIso(); renderPage(); } }),
        h('button', { class: 'btn sm', text: '\u203A', title: t('next'), onclick: function () { shift(1); } }),
      ]),
      h('h1', { class: 'cal-title', text: title }),
      h('span', { class: 'grow' }),
      h('div', { class: 'seg' }, [['month', 'viewMonth'], ['week', 'viewWeek'], ['day', 'viewDay']].map(function (pair) {
        return h('button', {
          class: view === pair[0] ? 'on' : '', text: t(pair[1]),
          onclick: function () { S.calView = pair[0]; renderPage(); },
        });
      })),
    ]));

    var mineCb = h('input', { type: 'checkbox', checked: S.calMineOnly });
    mineCb.addEventListener('change', function () { S.calMineOnly = mineCb.checked; renderPage(); });
    var eventsCb = h('input', { type: 'checkbox', checked: S.calShowEvents !== false });
    eventsCb.addEventListener('change', function () { S.calShowEvents = eventsCb.checked; renderPage(); });

    main.appendChild(h('div', { class: 'cal-legend' }, [
      h('label', {}, [mineCb, t('mineOnly')]),
      h('label', {}, [eventsCb, t('showEvents')]),
      h('span', { class: 'grow' }),
      h('span', { class: 'key' }, [h('i', { class: 'dot task' }), t('navAll')]),
      h('span', { class: 'key' }, [h('i', { class: 'dot event' }), t('navEvents')]),
      h('span', { class: 'key' }, [h('i', { class: 'dot meeting' }), t('navMeetings')]),
    ]));

    if (view === 'month') main.appendChild(monthGrid(anchor));
    else if (view === 'week') main.appendChild(weekStrip(startOfWeek(anchor), 7));
    else main.appendChild(weekStrip(anchor, 1));
  }

  /**
   * The calendar, on a phone.
   *
   * Two views instead of three. The month is a grid of dots — a 52px-wide day
   * cannot hold a readable title, so it does not try — with the chosen day's
   * items listed underneath as full rows. The week is the same rows, a day at
   * a time down the page. "Day" is not a view of its own any more: it is
   * simply the month with that day chosen.
   */
  function phoneCalendar(main) {
    var view = S.calView === 'week' ? 'week' : 'month';
    var anchor = S.calAnchor || todayIso();

    function shift(step) {
      S.calAnchor = view === 'month' ? addMonths(anchor, step) : addDays(anchor, step * 7);
      renderPage();
    }

    var title = view === 'month'
      ? fmtDate(anchor, { month: 'long', year: 'numeric' })
      : fmtDate(startOfWeek(anchor), { day: 'numeric', month: 'short' }) + ' – ' +
        fmtDate(addDays(startOfWeek(anchor), 6), { day: 'numeric', month: 'short' });

    main.appendChild(h('div', { class: 'cal-bar' }, [
      h('h1', { class: 'cal-title', text: title }),
      h('div', { class: 'cal-nav' }, [
        h('button', { class: 'btn sm', text: '‹', 'aria-label': t('previous'), onclick: function () { shift(-1); } }),
        h('button', { class: 'btn sm', text: t('today'), onclick: function () { S.calAnchor = todayIso(); renderPage(); } }),
        h('button', { class: 'btn sm', text: '›', 'aria-label': t('next'), onclick: function () { shift(1); } }),
      ]),
    ]));

    var mineCb = h('input', { type: 'checkbox', checked: S.calMineOnly });
    mineCb.addEventListener('change', function () { S.calMineOnly = mineCb.checked; renderPage(); });
    var eventsCb = h('input', { type: 'checkbox', checked: S.calShowEvents !== false });
    eventsCb.addEventListener('change', function () { S.calShowEvents = eventsCb.checked; renderPage(); });

    main.appendChild(h('div', { class: 'cal-legend' }, [
      h('div', { class: 'seg' }, [['month', 'viewMonth'], ['week', 'viewWeek']].map(function (pair) {
        return h('button', {
          class: view === pair[0] ? 'on' : '', text: t(pair[1]),
          onclick: function () { S.calView = pair[0]; renderPage(); },
        });
      })),
      h('label', {}, [mineCb, t('mineOnly')]),
      h('label', {}, [eventsCb, t('showEvents')]),
      h('span', { class: 'key' }, [h('i', { class: 'dot task' }), t('navAll')]),
      h('span', { class: 'key' }, [h('i', { class: 'dot event' }), t('navEvents')]),
      h('span', { class: 'key' }, [h('i', { class: 'dot meeting' }), t('navMeetings')]),
    ]));

    if (view === 'week') {
      var from = startOfWeek(anchor);
      var days = [];
      for (var i = 0; i < 7; i++) days.push(phoneDayBlock(addDays(from, i), true));
      main.appendChild(h('div', { class: 'ph-agenda' }, days));
      return;
    }

    main.appendChild(phoneMonthGrid(anchor));
    main.appendChild(h('div', { class: 'ph-agenda' }, [phoneDayBlock(anchor, false)]));
  }

  function phoneMonthGrid(anchor) {
    var first = anchor.slice(0, 8) + '01';
    var gridStart = startOfWeek(first);
    var today = todayIso();
    var month = anchor.slice(0, 7);
    // Day 0 of the following month is the last day of this one.
    var daysInMonth = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0).getDate();
    var lead = Math.round((new Date(first + 'T00:00:00') - new Date(gridStart + 'T00:00:00')) / 86400000);
    // As many weeks as the month needs, not always six: on a phone the empty
    // sixth row is a sixth of the screen spent on next month.
    var weeks = Math.ceil((lead + daysInMonth) / 7);

    var head = h('div', { class: 'ph-wk' }, weekdayNames().map(function (name) {
      return h('div', { class: 'ph-wd', text: name });
    }));
    var cells = [];
    for (var i = 0; i < weeks * 7; i++) {
      (function () {
        var day = addDays(gridStart, i);
        var entries = entriesOn(day);
        cells.push(h('button', {
          type: 'button',
          class: 'ph-day' + (day.slice(0, 7) !== month ? ' out' : '') +
            (day === today ? ' today' : '') + (day === anchor ? ' sel' : ''),
          'aria-label': fmtDate(day, { day: 'numeric', month: 'long' }) +
            (entries.length ? ' · ' + entries.length : ''),
          onclick: function () { S.calAnchor = day; renderPage(); },
        }, [
          h('span', { class: 'dn', text: String(Number(day.slice(8, 10))) }),
          // One dot per thing, up to three, coloured by what kind of thing it is.
          h('span', { class: 'ph-dots' }, entries.slice(0, 3).map(function (e) {
            return h('i', { class: e.kind });
          })),
        ]));
      })();
    }
    return h('div', { class: 'ph-month' }, [head, h('div', { class: 'ph-wk' }, cells)]);
  }

  /** One day's items as rows; `compact` leaves an empty day as a short line. */
  function phoneDayBlock(day, compact) {
    var entries = entriesOn(day);
    var today = todayIso();
    return h('section', {}, [
      h('div', { class: 'ph-dayhead' + (day === today ? ' today' : '') }, [
        fmtDate(day, { weekday: 'long', day: 'numeric', month: 'long' }),
        day === today ? h('small', { text: t('today') }) : null,
      ]),
      entries.length
        ? h('div', { class: 'ph-rows' }, entries.map(phoneRow))
        : (compact ? h('div', { class: 'ph-none', style: 'padding:8px', text: '—' })
                   : h('div', { class: 'ph-none', text: t('phNothingThisDay') })),
    ]);
  }

  function phoneRow(entry) {
    var at = entry.at || t('phAllDay');
    if (entry.kind === 'meeting') {
      var m = entry.meeting;
      return h('button', { type: 'button', class: 'ph-row k-meeting', onclick: function () { openMeeting(m); } }, [
        h('span', { class: 'at', text: at }), h('span', { class: 'bar' }),
        h('span', { class: 'tx' }, [
          h('b', { text: m.title }),
          h('small', { text: [t('navMeetings'), m.code, m.place].filter(Boolean).join(' · ') }),
        ]),
      ]);
    }
    if (entry.kind === 'event') {
      var ev = entry.event;
      return h('button', {
        type: 'button', class: 'ph-row k-event', style: '--c:' + colourHex(ev.colour),
        onclick: function () { openEvent(ev); },
      }, [
        h('span', { class: 'at', text: at }), h('span', { class: 'bar' }),
        h('span', { class: 'tx' }, [
          h('b', { text: ev.title }),
          h('small', { text: [t('navEvents'), ev.code, ev.place].filter(Boolean).join(' · ') }),
        ]),
      ]);
    }
    var task = entry.task;
    return h('button', {
      type: 'button', class: 'ph-row k-task' + (task.status === 'done' ? ' done' : ''),
      style: '--c:var(--u-' + (urgencyOf(task) === 'none' ? 'ahead' : urgencyOf(task)) + ', var(--accent))',
      onclick: function () { openTask(task); },
    }, [
      h('span', { class: 'at', text: at }), h('span', { class: 'bar' }),
      h('span', { class: 'tx' }, [
        h('b', { text: task.title }),
        h('small', { text: [task.code, statusLabel(task.status)].filter(Boolean).join(' · ') }),
      ]),
    ]);
  }

  /** Everything happening on one day, tasks first, then events. */
  function entriesOn(iso) {
    var out = [];

    S.tasks.forEach(function (task) {
      if (task.dueDate !== iso) return;
      if (S.calMineOnly && task.assignees.indexOf(S.user.username) === -1) return;
      out.push({ kind: 'task', at: task.dueTime || '', task: task, title: task.title });
    });

    /**
     * A meeting is a date people have to keep, so it belongs on the calendar
     * next to the events — not on a page of its own that nobody thinks to
     * open on a Tuesday morning.
     */
    S.meetings.forEach(function (m) {
      if (m.meetsOn !== iso) return;
      if (m.status === 'cancelled') return;
      if (S.calMineOnly && !(m.people || []).some(function (x) {
        return x.username === S.user.username;
      })) return;
      out.push({ kind: 'meeting', at: m.meetsAt || '', meeting: m, title: m.title });
    });

    if (S.calShowEvents !== false) {
      S.events.forEach(function (event) {
        if (!coversDay(event, iso)) return;
        if (S.calMineOnly && (event.people || []).length &&
            event.people.indexOf(S.user.username) === -1) return;
        out.push({ kind: 'event', at: event.allDay ? '' : (event.startsAt || ''), event: event, title: event.title });
      });
    }

    // All-day things first, then by time — the order a day actually runs in.
    return out.sort(function (a, b) {
      if (!a.at && b.at) return -1;
      if (a.at && !b.at) return 1;
      return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
    });
  }

  /** A multi-day event covers every day between its ends. */
  function coversDay(event, iso) {
    var from = event.startsOn;
    var to = event.endsOn || event.startsOn;
    return iso >= from && iso <= to;
  }

  function chipFor(entry) {
    if (entry.kind === 'meeting') {
      return h('button', {
        class: 'cal-chip meeting',
        title: entry.meeting.title,
        onclick: function (e) { e.stopPropagation(); openMeeting(entry.meeting); },
      }, [
        entry.at ? h('span', { class: 'at', text: entry.at }) : null,
        entry.meeting.title,
      ]);
    }
    if (entry.kind === 'event') {
      var colour = colourHex(entry.event.colour);
      return h('button', {
        class: 'cal-chip event',
        style: 'border-left-color:' + colour + ';--cc:' + colour,
        title: entry.event.title,
        onclick: function (e) { e.stopPropagation(); openEvent(entry.event); },
      }, [
        entry.at ? h('span', { class: 'at', text: entry.at }) : null,
        entry.event.title,
      ]);
    }
    return h('button', {
      class: 'cal-chip task s-' + entry.task.status,
      // Same urgency ramp as the list, so a red day in the calendar and a red
      // card in the list mean the same thing.
      dataset: { urgency: urgencyOf(entry.task) },
      title: entry.task.title,
      onclick: function (e) { e.stopPropagation(); openTask(entry.task); },
    }, [
      entry.at ? h('span', { class: 'at', text: entry.at }) : null,
      entry.task.title,
    ]);
  }

  function monthGrid(anchor) {
    var first = anchor.slice(0, 8) + '01';
    var gridStart = startOfWeek(first);
    var today = todayIso();
    var month = anchor.slice(0, 7);

    var head = h('div', { class: 'cal-head' }, weekdayNames().map(function (name) {
      return h('div', { text: name });
    }));

    var cells = [];
    // Six rows always: a grid that changes height as you page through months
    // makes the whole page jump about.
    for (var i = 0; i < 42; i++) {
      (function () {
        var day = addDays(gridStart, i);
        var entries = entriesOn(day);
        var outside = day.slice(0, 7) !== month;

        cells.push(h('div', {
          class: 'cal-cell' + (outside ? ' outside' : '') + (day === today ? ' today' : ''),
          onclick: function () { S.calAnchor = day; S.calView = 'day'; renderPage(); },
        }, [
          h('div', { class: 'd-num', text: String(Number(day.slice(8, 10))) }),
          h('div', { class: 'd-items' }, entries.slice(0, 3).map(chipFor)),
          entries.length > 3
            ? h('div', { class: 'more', text: '+' + (entries.length - 3) })
            : null,
        ]));
      })();
    }

    return h('div', { class: 'cal-month' }, [head, h('div', { class: 'cal-grid' }, cells)]);
  }

  /** Week and day share this: the same column, one or seven times. */
  function weekStrip(from, count) {
    var today = todayIso();
    var columns = [];

    for (var i = 0; i < count; i++) {
      (function () {
        var day = addDays(from, i);
        var entries = entriesOn(day);
        columns.push(h('div', { class: 'cal-col' + (day === today ? ' today' : '') }, [
          h('div', { class: 'col-head' }, [
            h('small', { text: fmtDate(day, { weekday: 'short' }) }),
            h('b', { text: String(Number(day.slice(8, 10))) }),
          ]),
          h('div', { class: 'col-body' }, entries.length
            ? entries.map(chipFor)
            : [h('div', { class: 'col-empty', text: '\u00b7' })]),
        ]));
      })();
    }

    return h('div', { class: 'cal-week' + (count === 1 ? ' single' : '') }, columns);
  }

  /* ---------- date helpers used only by the calendar ---------------------- */
  function startOfWeek(iso) {
    var d = new Date(iso + 'T00:00:00');
    // Monday first: the committee's week starts then, not on Sunday.
    var back = (d.getDay() + 6) % 7;
    return addDays(iso, -back);
  }

  function addMonths(iso, n) {
    var y = Number(iso.slice(0, 4));
    var m = Number(iso.slice(5, 7)) - 1 + n;
    var day = Number(iso.slice(8, 10));
    var target = new Date(y, m, 1);
    // Clamp: the 31st of a month with 30 days is the 30th, not the 1st of next.
    var last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, last));
    return [
      target.getFullYear(),
      String(target.getMonth() + 1).padStart(2, '0'),
      String(target.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function weekdayNames() {
    var names = [];
    // 5 January 2026 was a Monday; any known Monday would do. Dates are built
    // by adding days rather than by pasting numbers into a string, which
    // produced "2026-01-010" for the last two and printed INVALID DATE.
    var monday = Date.UTC(2026, 0, 5);
    for (var i = 0; i < 7; i++) {
      names.push(new Date(monday + i * 86400000)
        .toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB',
          { weekday: 'short', timeZone: 'UTC' }));
    }
    return names;
  }

  function colourHex(key) {
    for (var i = 0; i < S.colours.length; i++) {
      if (S.colours[i].key === key) return S.colours[i].hex;
    }
    return S.colours.length ? S.colours[0].hex : '#b51e64';
  }

  /**
   * Which version is running, said where somebody can read it out.
   *
   * The page and the server each report their own. They should be the same
   * string; when they are not, the site has been updated in halves and the
   * page says so rather than leaving somebody to work it out from a feature
   * that is mysteriously missing.
   */
  function versionBox() {
    var mismatch = S.serverVersion && S.serverVersion !== APP_VERSION;
    return h('div', { class: 'field version-box' }, [
      h('label', { text: t('appVersion') }),
      h('p', { class: 'hint' }, [
        h('code', { text: APP_VERSION }),
        S.serverVersion ? h('span', { text: ' \u00b7 ' + t('appVersionServer') + ' ' }) : null,
        S.serverVersion ? h('code', { text: S.serverVersion }) : null,
      ]),
      mismatch ? h('div', { class: 'notice warn', text: t('appVersionMismatch') }) : null,
    ]);
  }

  function pageProfile(main) {
    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('profile') })]));

    var nameInput = h('input', { type: 'text', value: S.user.displayName, maxlength: '80' });
    // firstname lastname, as it appears on a document rather than on a card.
    var fullNameInput = h('input', {
      type: 'text', value: S.user.fullName || '', maxlength: '120',
      placeholder: t('fullNamePlaceholder'),
    });
    var avatarPreview = h('span', { class: 'avatar lg' });
    var pendingAvatar;

    function paintAvatar(src) {
      clear(avatarPreview);
      if (src) avatarPreview.appendChild(h('img', { src: src, alt: '' }));
      else avatarPreview.textContent = initials(S.user.displayName);
    }
    paintAvatar(S.user.avatar);

    var fileInput = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      // The picture is shown as it will be saved, and the person decides which
      // part of it that is. A blind centre crop takes the top of somebody's
      // head off often enough that it was worth a dialog.
      openCropper(file, function (dataUrl) {
        pendingAvatar = dataUrl;
        paintAvatar(dataUrl);
      });
      fileInput.value = '';
    });

    var notice = h('div', { class: 'notice ok', hidden: true });

    /**
     * Two columns on a computer.
     *
     * This was one 34rem column in the middle of a 1400px page: who you are,
     * then nine settings boxes stacked below it, and two thirds of the window
     * empty beside them. The split is by kind — who you are on the left, what
     * the app does for you on the right — and it folds back to one column on
     * anything narrow.
     */
    var pfLeft = h('div', { class: 'pf-col' });
    var pfRight = h('div', { class: 'pf-col' });

    main.appendChild(h('div', { class: 'modal profile-page', style: 'width:100%;margin:0' }, [
      h('div', { class: 'body pf-grid' }, [
        notice,
        pfLeft, pfRight,
      ]),
      h('footer', {}, [
        h('button', {
          class: 'btn primary', text: t('save'),
          onclick: function () {
            var body = {
              displayName: nameInput.value.trim(),
              fullName: fullNameInput.value.trim(),
            };
            if (pendingAvatar !== undefined) body.avatar = pendingAvatar;
            api('/api/users?do=me', { method: 'PATCH', body: body }).then(function (data) {
              S.user.displayName = data.user.displayName;
              S.user.fullName = data.user.fullName;
              S.user.avatar = data.user.avatar;
              var i = S.users.findIndex(function (u) { return u.username === S.user.username; });
              if (i !== -1) S.users[i] = data.user;
              notice.hidden = false; notice.textContent = t('saved');
              renderShell();
            }).catch(function (err) { notice.hidden = false; notice.className = 'notice err'; notice.textContent = errText(err.code); });
          },
        }),
      ]),
    ]));

    [
        h('div', { style: 'display:flex;gap:16px;align-items:center' }, [
          avatarPreview,
          h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [
            h('button', { class: 'btn sm', text: t('changePicture'), onclick: function () { fileInput.click(); } }),
            S.user.avatar || pendingAvatar ? h('button', {
              class: 'btn sm ghost', text: t('removePicture'),
              onclick: function () { pendingAvatar = null; paintAvatar(null); },
            }) : null,
            fileInput,
          ]),
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('displayName') }), nameInput]),
        h('div', { class: 'field' }, [
          h('label', { text: t('fullName') }),
          fullNameInput,
          h('small', { style: 'color:var(--ink-faint);font-size:12px', text: t('fullNameWhy') }),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: t('username') }),
          h('input', { type: 'text', value: S.user.username, disabled: true }),
          h('small', { style: 'color:var(--ink-faint);font-size:12px', text: t('usernameFixed') }),
        ]),
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [
            h('label', { text: t('position') }),
            h('input', { type: 'text', value: S.user.position || '—', disabled: true }),
          ]),
          h('div', { class: 'field' }, [
            h('label', { text: t('accessLevel') }),
            h('input', { type: 'text', value: t('access' + S.user.access.charAt(0).toUpperCase() + S.user.access.slice(1)), disabled: true }),
          ]),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: t('deptAccess') }),
          h('input', {
            type: 'text', disabled: true,
            value: S.user.allDepartments
              ? t('allDepartments')
              : ((S.user.departments || []).map(deptLabel).join(', ') || '—'),
          }),
        ]),

        h('div', { class: 'field' }, [
          h('label', { text: t('theme') }),
          h('div', { class: 'seg' }, [['system', 'themeSystem'], ['light', 'themeLight'], ['dark', 'themeDark']]
            .map(function (pair) {
              return h('button', {
                type: 'button', class: S.theme === pair[0] ? 'on' : '', text: t(pair[1]),
                onclick: function () { setTheme(pair[0]); renderPage(); },
              });
            })),
        ]),

    ].filter(Boolean).forEach(function (el) { pfLeft.appendChild(el); });

    [
        h('div', { class: 'field' }, [h('label', { text: t('phoneAlerts') }), pushBox()]),
        h('div', { class: 'field', id: 'notify-settings' }, [h('label', { text: t('notifySettings') }), notifyBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('lineAlerts') }), lineBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('grpMine') }), myGroupsBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('tagMine') }), myTagsBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('sigTitle') }), signatureBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('freeTitle') }), availabilityBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('calendarFeed') }), calendarBox()]),
        versionBox(),
    ].filter(Boolean).forEach(function (el) { pfRight.appendChild(el); });
  }


  /**
   * The groups I am in, and the open ones I could walk into.
   *
   * Only the ones the committee invented are shown as joinable. คณะกรรมการ
   * บริหาร is not a thing somebody joins by saying so, and offering a button
   * that the server will refuse is the mistake that cost two ประธานฝ่าย an
   * evening on the meeting form.
   */
  function myGroupsBox() {
    var box = h('div', { class: 'grp-mine' });
    draw();
    return box;

    function draw() {
      clear(box);
      var made = (S.circles || []).filter(function (c) { return c.made; });
      var born = (S.circles || []).filter(function (c) { return !c.made && inCircle(c.key); });

      if (born.length) {
        box.appendChild(h('div', { class: 'org-units' }, born.map(function (c) {
          return h('span', { class: 'chip', title: c.note || '',
            text: S.lang === 'en' ? c.en : c.th });
        })));
        box.appendChild(h('small', { class: 'hint', text: t('grpBornWhy') }));
      }

      if (!made.length) {
        box.appendChild(h('small', { class: 'hint', text: t('grpNoneYet') }));
        return;
      }

      box.appendChild(h('div', { class: 'org-units' }, made.map(function (c) {
        var mine = inCircle(c.key);
        // A closed group still shows, because being in one is worth knowing;
        // it simply does not offer a button that would be refused.
        if (!c.selfJoin) {
          return h('span', { class: 'chip' + (mine ? ' on' : ''), title: c.note || '',
            text: (S.lang === 'en' ? c.en : c.th) + (mine ? '' : ' ·') });
        }
        return h('button', {
          type: 'button', class: 'chip' + (mine ? ' on' : ''), title: c.note || '',
          text: (mine ? '✓ ' : '+ ') + (S.lang === 'en' ? c.en : c.th),
          onclick: function () {
            api('/api/users?do=groups', {
              method: mine ? 'DELETE' : 'POST',
              body: { kind: 'member', circle: c.key },
            })
              .then(function () { return api('/api/users'); })
              .then(function (d) { S.users = d.users; draw(); })
              .catch(function (err) { alert(errText(err.code)); });
          },
        });
      })));
    }
  }

  /**
   * Labels I keep for my own work, which nobody else can see.
   *
   * Not a second ฝ่าย system and deliberately private: a ฝ่าย says who you
   * answer to and who may see what; "รอของ" means something only to the
   * person who wrote it. A shared label would have to be agreed on, which is
   * the thing people reach for a private one to avoid.
   */
  function myTagsBox() {
    var box = h('div', { class: 'tag-mine' });
    draw();
    return box;

    function draw() {
      clear(box);
      var chips = h('div', { class: 'org-units' });
      (S.myTags || []).forEach(function (tag) {
        chips.appendChild(h('span', { class: 'chip unit' }, [
          h('span', { text: tag.name }),
          h('button', {
            type: 'button', class: 'chip-act danger', text: '✕', title: t('tagRemove'),
            onclick: function () {
              if (!confirm(t('tagRemoveAsk').replace('%s', tag.name))) return;
              api('/api/users?do=tags&name=' + encodeURIComponent(tag.name), { method: 'DELETE' })
                .then(function (d) {
                  S.myTags = d.tags || [];
                  draw();
                  // The rows on tasks went with it, so the page's copy is stale.
                  return api('/api/tasks').then(function (x) { S.tasks = x.tasks; });
                })
                .catch(function (err) { alert(errText(err.code)); });
            },
          }),
        ]));
      });

      var input = h('input', { type: 'text', maxlength: '40', placeholder: t('tagNew') });
      function add() {
        var name = input.value.trim();
        if (!name) return;
        api('/api/users?do=tags', { method: 'POST', body: { name: name } })
          .then(function (d) { S.myTags = d.tags || []; draw(); })
          .catch(function (err) { alert(errText(err.code)); });
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); add(); }
      });

      box.appendChild(chips);
      box.appendChild(h('div', { class: 'tag-add' }, [
        input, h('button', { class: 'btn sm', text: t('tagAdd'), onclick: add }),
      ]));
      box.appendChild(h('small', { class: 'hint', text: t('tagWhy') }));
    }
  }

  /**
   * When I am free, and when I am away.
   *
   * Lives on the profile rather than in a page of its own because it is the
   * same kind of thing as a phone number: a fact about you that other people's
   * work depends on. Both halves are optional and the whole thing is skippable
   * — somebody who fills in nothing is treated as always available, which with
   * four hundred people is most of them, and a system that nagged all of them
   * would be switched off in a week.
   */
  /**
   * Monday to Sunday as chips you can tick several of.
   *
   * "Tuesday and Thursday, 15:00–17:00" was three trips through the form —
   * pick a day, pick the times, save, start again — and people gave up after
   * the first one. One row, several days, same hours.
   */
  function dayPicker(picked, onChange) {
    var chosen = (picked || []).slice();
    var row = h('div', { class: 'day-pick' });
    WEEK_KEYS.forEach(function (d) {
      var on = chosen.indexOf(d) !== -1;
      var btn = h('button', {
        type: 'button', class: 'day-chip' + (on ? ' on' : ''), text: t('dayShort_' + d),
        title: t('day_' + d),
        onclick: function () {
          var at = chosen.indexOf(d);
          if (at === -1) chosen.push(d); else chosen.splice(at, 1);
          btn.classList.toggle('on', at === -1);
          if (onChange) onChange(chosen.slice());
        },
      });
      row.appendChild(btn);
    });
    row.chosen = function () {
      // Monday first, so "ศ, จ" reads back as "จ, ศ".
      return chosen.slice().sort(function (a, b) { return WEEK_KEYS.indexOf(a) - WEEK_KEYS.indexOf(b); });
    };
    return row;
  }

  function availabilityBox() {
    var box = h('div', { class: 'push-box' });
    var state = { windows: [], blocks: [] };
    var notice = h('div', { class: 'notice err', hidden: true });

    function fail(code) {
      notice.hidden = false;
      notice.textContent = errText(code);
    }

    function saveWindows() {
      notice.hidden = true;
      return api('/api/users?do=free', { method: 'PUT', body: { windows: state.windows } })
        .then(function (d) { state = d; draw(); })
        .catch(function (err) { fail(err.code); });
    }

    function draw() {
      clear(box);
      box.appendChild(notice);
      box.appendChild(h('p', { class: 'hint', text: t('freeHow') }));

      /**
       * The week, as rows somebody adds to rather than a grid of 7 × 24 boxes.
       *
       * A grid looks thorough and is miserable on a phone, which is where most
       * of this committee will open it. Three rows saying "Monday 17:00–22:00"
       * is the same fact in a form somebody will actually finish.
       */
      var list = h('div', { class: 'free-list' });
      if (!state.windows.length) {
        list.appendChild(h('p', { class: 'free-none', text: t('freeNone') }));
      }
      state.windows.forEach(function (w, i) {
        list.appendChild(h('div', { class: 'free-row' }, [
          h('span', { class: 'free-day', text: t('day_' + w.day) }),
          h('span', { class: 'free-when', text: w.from + '–' + w.to }),
          h('button', {
            class: 'btn ghost sm', text: t('freeRemove'),
            onclick: function () {
              state.windows = state.windows.filter(function (_, j) { return j !== i; });
              saveWindows();
            },
          }),
        ]));
      });
      box.appendChild(list);

      var dayRow = dayPicker(['mon']);
      var fromIn = h('input', { type: 'time', value: '17:00' });
      var toIn = h('input', { type: 'time', value: '22:00' });
      box.appendChild(h('div', { class: 'free-add multi' }, [
        dayRow,
        h('span', { class: 'free-times' }, [fromIn, h('span', { class: 'free-dash', text: '–' }), toIn]),
        h('button', {
          class: 'btn sm', text: t('freeAdd'),
          onclick: function () {
            var days = dayRow.chosen();
            if (!days.length) { fail('BAD_DAY'); return; }
            if (!fromIn.value || !toIn.value) { fail('BAD_TIME'); return; }
            if (toIn.value <= fromIn.value) { fail('ENDS_BEFORE_IT_STARTS'); return; }
            // The same hours on every day ticked, and a day already covered
            // by an identical window is not added twice.
            var added = days.filter(function (d) {
              return !state.windows.some(function (w) {
                return w.day === d && w.from === fromIn.value && w.to === toIn.value;
              });
            }).map(function (d) { return { day: d, from: fromIn.value, to: toIn.value }; });
            if (!added.length) return;
            state.windows = state.windows.concat(added);
            saveWindows();
          },
        }),
      ]));

      // ---- days away ----
      box.appendChild(h('h4', { class: 'free-head', text: t('awayTitle') }));
      box.appendChild(h('p', { class: 'hint', text: t('awayHow') }));

      var away = h('div', { class: 'free-list' });
      if (!state.blocks.length) {
        away.appendChild(h('p', { class: 'free-none', text: t('awayNone') }));
      }
      state.blocks.forEach(function (b) {
        away.appendChild(h('div', { class: 'free-row' }, [
          h('span', { class: 'free-when',
            text: b.fromOn + (b.toOn !== b.fromOn ? ' – ' + b.toOn : '') +
                  (b.fromAt ? ' · ' + b.fromAt + '–' + b.toAt : '') }),
          h('span', { class: 'free-why', text: b.reason || '' }),
          h('button', {
            class: 'btn ghost sm', text: t('freeRemove'),
            onclick: function () {
              api('/api/users?do=block&id=' + encodeURIComponent(b.id), { method: 'DELETE' })
                .then(function (d) { state = d; draw(); })
                .catch(function (err) { fail(err.code); });
            },
          }),
        ]));
      });
      box.appendChild(away);

      var fromOn = h('input', { type: 'date' });
      var toOn = h('input', { type: 'date' });
      var why = h('input', { type: 'text', maxlength: '200', placeholder: t('awayWhy') });
      box.appendChild(h('div', { class: 'free-add away' }, [
        fromOn, h('span', { class: 'free-dash', text: '–' }), toOn, why,
        h('button', {
          class: 'btn sm', text: t('awayAdd'),
          onclick: function () {
            if (!fromOn.value) { fail('BAD_DATE'); return; }
            notice.hidden = true;
            api('/api/users?do=block', {
              method: 'POST',
              body: { fromOn: fromOn.value, toOn: toOn.value || fromOn.value,
                      reason: why.value.trim() },
            }).then(function (d) { state = d; draw(); })
              .catch(function (err) { fail(err.code); });
          },
        }),
      ]));
      // Said out loud, because it is the thing people assume the other way
      // round: the dates are visible to everybody, the reason is not.
      box.appendChild(h('p', { class: 'hint', text: t('awayPrivacy') }));
    }

    api('/api/users?do=free').then(function (d) { state = d; draw(); })
      .catch(function () { draw(); });
    return box;
  }

  /**
   * The calendar subscription panel.
   *
   * The URL carries a token rather than a cookie, because Google's fetcher
   * cannot sign in. That makes the link itself the secret, which the warning
   * here says plainly, and the "new link" button is the remedy.
   */
  /**
   * Turning phone notifications on, and explaining honestly when that is not
   * possible yet.
   *
   * The iPhone branch is the important one. Apple only delivers push to a site
   * that has been added to the Home Screen, so on an iPhone still in a Safari
   * tab there is no permission to grant — showing a dead "allow" button there
   * would just look broken.
   */
  /**
   * Connecting a personal LINE account.
   *
   * The code is the whole security of this: it lives for fifteen minutes, is
   * used once, and only ever binds the account that asked for it — so it can
   * be read off a screen and typed into a chat without being a password.
   *
   * What arrives afterwards is one message a morning, addressed to that person
   * alone and listing only their own work. Never a broadcast, and the switch
   * below belongs to them, not to an admin.
   */
  function lineBox() {
    var box = h('div', { class: 'push-box' });

    function draw(state) {
      clear(box);

      if (state && state.configured === false) {
        box.appendChild(h('p', { class: 'hint', text: t('lineNotSetUp') }));
        return;
      }

      if (!state) {
        box.appendChild(h('p', { class: 'hint', text: '…' }));
        return;
      }

      if (state.linked) {
        box.appendChild(h('p', { class: 'ok-line', text: '\u2713 ' + t('lineConnected') }));

        /**
         * The morning digest is off (see sendDigests in api/cron.js), so the
         * switch for it is gone rather than left there promising a message
         * that will not arrive. What LINE is still for is said instead.
         */
        box.appendChild(h('p', { class: 'hint', text: t('lineWhatFor') }));

        // Admins also get the one-click menu install. It changes what every
        // member sees, so it is deliberately not offered to everyone.
        if (state.canManageMenu) {
          box.appendChild(h('p', { class: 'hint', text: t('lineMenuHelp') }));
          if (state.menuOutdated) box.appendChild(h('div', { class: 'notice warn', text: t('lineMenuOutdated') }));
          box.appendChild(h('button', {
            class: 'btn sm' + (state.menuOutdated || !state.menuInstalled ? ' primary' : ''),
            text: state.menuOutdated ? t('lineMenuUpdate') : state.menuInstalled ? t('lineMenuReinstall') : t('lineMenuInstall'),
            onclick: function (e) {
              var btn = e.target;
              btn.disabled = true;
              btn.textContent = t('lineMenuWorking');
              api('/api/line?do=richmenu', { method: 'POST' })
                .then(function () { state.menuInstalled = true; state.menuOutdated = false; draw(state); })
                .catch(function (err) {
                  btn.disabled = false;
                  alert(err.data && err.data.message ? err.data.message : errText(err.code));
                  draw(state);
                });
            },
          }));
        }

        box.appendChild(h('button', {
          class: 'btn sm', text: t('lineDisconnect'),
          onclick: function () {
            if (!confirm(t('lineDisconnectSure'))) return;
            api('/api/line?do=link', { method: 'DELETE' })
              .then(function () { draw({ configured: true, linked: false }); })
              .catch(function (err) { alert(errText(err.code)); });
          },
        }));
        return;
      }

      box.appendChild(h('p', { class: 'hint', text: t('lineHowTo') }));
      box.appendChild(h('button', {
        class: 'btn sm primary', text: t('lineGetCode'),
        onclick: function () {
          api('/api/line?do=code', { method: 'POST' })
            .then(function (d) { showCode(d); })
            .catch(function (err) { alert(errText(err.code)); });
        },
      }));
    }

    function showCode(d) {
      clear(box);
      box.appendChild(h('p', { class: 'hint', text: t('lineCodeSteps') }));
      box.appendChild(h('div', { class: 'line-code', text: d.code }));
      box.appendChild(h('p', { class: 'hint', text: t('lineCodeExpires').replace('{n}', String(d.minutes)) }));
      box.appendChild(h('button', {
        class: 'btn sm', text: t('lineCheckAgain'),
        onclick: function () { api('/api/line?do=status').then(draw); },
      }));
    }

    api('/api/line?do=status').then(draw).catch(function () {
      draw({ configured: false });
    });
    return box;
  }

  function pushBox() {
    var box = h('div', { class: 'push-box' });

    function draw() {
      clear(box);
      pushState();

      // Ask the server once per render when permission is granted, so the
      // panel reflects what can actually be delivered to.
      if (S.push.permission === 'granted' && !S.push.serverKnown) {
        checkServer().then(draw);
      }

      if (S.push.needsInstall) {
        box.appendChild(h('div', { class: 'notice warn install-steps' }, [
          h('b', { text: t('iosInstallTitle') }),
          h('ol', {}, [t('iosStep1'), t('iosStep2'), t('iosStep3')].map(function (line) {
            return h('li', { text: line });
          })),
        ]));
        return;
      }

      if (!S.push.supported) {
        box.appendChild(h('div', { class: 'notice warn', text: t('pushUnsupported') }));
        return;
      }

      if (S.push.permission === 'denied') {
        box.appendChild(h('div', { class: 'notice warn', text: t('pushBlocked') }));
        return;
      }

      /**
       * "On" means the server holds a device for this person — not merely that
       * the browser said yes. The two came apart in testing: the panel read
       * เปิดอยู่ while the server had nothing to send to, which sent everyone
       * looking in the wrong place.
       */
      var on = S.push.permission === 'granted' && S.push.subscribed;
      var halfway = S.push.permission === 'granted' && !S.push.subscribed;

      box.appendChild(h('div', { class: 'row' }, [
        h('span', { class: 'chip ' + (on ? 'done' : ''), text: on ? t('pushOn') : t('pushOff') }),
        h('span', { class: 'grow' }),
        h('button', {
          class: 'btn ' + (on ? '' : 'primary'),
          text: on ? t('turnOff') : t('turnOn'),
          onclick: function (e) {
            e.target.disabled = true;
            var job = on ? disablePush() : enablePush();
            job.then(function () { draw(); })
              .catch(function (err) {
                draw();
                box.appendChild(h('div', {
                  class: 'notice err',
                  text: err.message === 'DENIED' ? t('pushBlocked') : t('pushFailed'),
                }));
              });
          },
        }),
        on ? h('button', {
          class: 'btn sm', text: t('sendTest'),
          onclick: function (e) {
            var btn = e.target;
            btn.disabled = true;
            api('/api/push?do=test', { method: 'POST' })
              .then(function () {
                btn.disabled = false;
                report(h('div', { class: 'notice ok' }, [
                  h('b', { text: t('testSent') }),
                  h('div', { text: t('testSentHint') }),
                ]));
              })
              .catch(function (err) {
                btn.disabled = false;
                showFailure(err);
              });
          },
        }) : null,
      ]));

      box.appendChild(h('p', { class: 'hint', text: t('pushExplained') }));

      /**
       * macOS has a second switch.
       *
       * Chrome can have permission from the website and still show nothing,
       * because macOS itself decides whether Chrome may post notifications at
       * all — and its default for a freshly installed browser is often "no".
       * Nothing in the browser can detect or change that, so it is spelled
       * out here for anyone on a Mac rather than left as a mystery.
       */
      if (isMac && on) {
        box.appendChild(h('details', { class: 'mac-help' }, [
          h('summary', { text: t('macNoBanner') }),
          h('ol', {}, [t('macStep1'), t('macStep2'), t('macStep3'), t('macStep4')].map(function (line) {
            return h('li', { text: line });
          })),
          isChrome ? h('p', { class: 'hint', text: t('macChromeNote') }) : null,
        ]));
      }

      // Permission granted, but the server has no device: the registration
      // did not complete. One button fixes it, and says so if it cannot.
      if (halfway) {
        box.appendChild(h('div', { class: 'notice warn' }, [
          h('b', { text: t('notRegistered') }),
          h('div', { text: t('notRegisteredHint') }),
          h('button', {
            class: 'btn sm', style: 'margin-top:8px',
            text: t('registerAgain'),
            onclick: function (e) {
              e.target.disabled = true;
              enablePush().then(draw).catch(function (err) { draw(); showFailure(err); });
            },
          }),
        ]));
      }

      // What the server is holding, in plain terms — one line per device.
      if (on && S.push.devices.length) {
        box.appendChild(h('div', { class: 'devices' }, S.push.devices.map(function (d) {
          return h('div', { class: 'raw' }, [
            d.service + (d.lastDeliveredAt ? ' \u00b7 ' + t('lastDelivered') + ' ' + fmtWhen(d.lastDeliveredAt) : ''),
            d.lastError ? h('div', { class: 'raw err-text', text: d.lastError }) : null,
          ]);
        })));
      }

      /**
       * What went wrong, in the words of the service that refused it.
       *
       * Deliberately shows the raw message alongside the plain-language line:
       * "BadJwtToken" means nothing to most people, but it is the difference
       * between fixing this in a minute and guessing for an afternoon.
       */
      function showFailure(err) {
        var data = (err && err.data) || {};
        var lines = [h('b', { text: data.error === 'NO_DEVICE' ? t('pushNoDevice') : t('pushRefused') })];

        (data.errors || []).forEach(function (e) {
          lines.push(h('div', { class: 'raw', text: e.host + ' · HTTP ' + e.status }));
          if (e.message) lines.push(h('div', { class: 'raw', text: e.message }));
        });
        if (data.subject) lines.push(h('div', { class: 'raw', text: 'sub: ' + data.subject }));

        report(h('div', { class: 'notice err diag' }, lines));
      }

      function report(node) {
        var old = box.querySelector('.notice.ok, .notice.err');
        if (old) old.remove();
        box.appendChild(node);
      }
    }

    draw();
    return box;
  }

  function calendarBox() {
    var box = h('div', { class: 'cal-box' });

    function paint() {
      clear(box);
      if (!S.user.calendarToken) {
        box.appendChild(h('p', { class: 'hint', style: 'margin:0 0 8px;color:var(--ink-soft);font-size:13px', text: t('calendarHelp') }));
        box.appendChild(h('button', {
          class: 'btn sm primary', text: t('createCalendarLink'),
          onclick: function (e) {
            e.target.disabled = true;
            api('/api/users?do=calendar-token', { method: 'POST' }).then(function (d) {
              S.user.calendarToken = d.calendarToken; paint();
            }).catch(function () { e.target.disabled = false; });
          },
        }));
        return;
      }

      /**
       * Four feeds, not one.
       *
       * Google paints a subscribed calendar in a single colour, so the only
       * way to have committee dates in one colour and your own deadlines in
       * another is to subscribe to them separately. Each row here becomes its
       * own calendar in Google, which the person then colours as they like.
       */
      var FEEDS = [
        ['mine', 'feedMine', 'feedMineSub'],
        ['dept', 'feedDept', 'feedDeptSub'],
        ['events', 'feedEvents', 'feedEventsSub'],
        ['all', 'feedAll', 'feedAllSub'],
      ];

      box.appendChild(h('div', { class: 'feeds' }, FEEDS.map(function (feed) {
        var url = location.origin + '/api/calendar?token=' +
          S.user.calendarToken + '&scope=' + feed[0];
        var field = h('input', { type: 'text', class: 'mono', value: url, readonly: true,
          onclick: function (e) { e.target.select(); } });

        return h('div', { class: 'feed-row' }, [
          h('div', { class: 'feed-head' }, [
            h('b', { text: t(feed[1]) }),
            h('small', { text: t(feed[2]) }),
          ]),
          field,
          h('div', { class: 'feed-actions' }, [
            h('button', {
              class: 'btn sm', text: t('copyLink'),
              onclick: function (e) {
                var btn = e.target;
                field.select();
                var done = function () {
                  btn.textContent = t('copied');
                  setTimeout(function () { btn.textContent = t('copyLink'); }, 1600);
                };
                if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
                else done();
              },
            }),
            // Google's own "add by URL" page, pre-filled. One tap on a
            // computer; on a phone Google asks you to use a browser.
            h('a', {
              class: 'btn sm', target: '_blank', rel: 'noopener',
              href: 'https://calendar.google.com/calendar/u/0/r/settings/addbyurl?cid=' +
                encodeURIComponent(url),
              text: t('addToGoogle'),
            }),
          ]),
        ]);
      })));

      box.appendChild(h('div', { class: 'notice', style: 'margin-top:10px' }, [
        h('b', { text: t('howToSubscribe') }),
        h('ol', {}, [t('subStep1'), t('subStep2'), t('subStep3'), t('subStep4')].map(function (line) {
          return h('li', { text: line });
        })),
      ]));

      var url = location.origin + '/api/calendar?token=' + S.user.calendarToken;
      box.appendChild(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' }, [
        h('button', {
          class: 'btn sm ghost', text: t('newCalendarLink'),
          onclick: function () {
            api('/api/users?do=calendar-token', { method: 'POST' }).then(function (d) {
              S.user.calendarToken = d.calendarToken; paint();
            });
          },
        }),
      ]));
      box.appendChild(h('p', { style: 'margin:8px 0 0;font-size:12.5px;color:var(--ink-soft)', text: t('calendarHelp') }));
      box.appendChild(h('p', { style: 'margin:6px 0 0;font-size:12.5px;color:var(--ink-faint)', text: t('calendarDelay') }));
      box.appendChild(h('p', { style: 'margin:6px 0 0;font-size:12.5px;color:var(--doing)', text: '\u26A0 ' + t('calendarWarn') }));
    }

    paint();
    return box;
  }

  /**
   * Squares and shrinks a chosen photo in the browser before it is sent.
   * A phone photo is several megabytes; this makes it roughly 10 KB, which is
   * small enough to live in the database and means no file storage to set up.
   */
  /**
   * Choosing which part of a picture becomes the avatar.
   *
   * A square window over the image, which the person drags to move and a
   * slider zooms. Everything outside the window is dimmed, so what will be
   * kept is what is bright — no separate preview to compare against, and no
   * guessing.
   *
   * Built by hand rather than pulled from a library: this is one canvas, two
   * event handlers and a bit of arithmetic, and a dependency loaded from a
   * CDN would also be one more thing that stops working on a university
   * network that blocks it.
   */
  function openCropper(file, done) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var canvas = h('canvas', { class: 'crop-canvas', width: '320', height: '320' });
    var zoom = h('input', { type: 'range', min: '100', max: '400', value: '100', class: 'crop-zoom' });
    var hint = h('p', { class: 'hint', text: t('cropHint') });

    var img = new Image();
    var view = { scale: 1, x: 0, y: 0, min: 1 };
    var BOX = 320;

    img.onerror = function () { veil.remove(); alert(t('errGeneric')); };
    img.onload = function () {
      // The smallest zoom that still covers the square — anything less would
      // leave a transparent edge, which is never what anybody wants.
      view.min = Math.max(BOX / img.width, BOX / img.height);
      view.scale = view.min;
      view.x = (BOX - img.width * view.scale) / 2;
      view.y = (BOX - img.height * view.scale) / 2;
      zoom.min = '100';
      zoom.max = '400';
      zoom.value = '100';
      draw();
    };

    var reader = new FileReader();
    reader.onerror = function () { veil.remove(); alert(t('errGeneric')); };
    reader.onload = function () { img.src = reader.result; };
    reader.readAsDataURL(file);

    function clamp() {
      var w = img.width * view.scale;
      var h2 = img.height * view.scale;
      view.x = Math.min(0, Math.max(BOX - w, view.x));
      view.y = Math.min(0, Math.max(BOX - h2, view.y));
    }

    function draw() {
      clamp();
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, BOX, BOX);
      ctx.drawImage(img, view.x, view.y, img.width * view.scale, img.height * view.scale);

      // A round window, because that is the shape an avatar is shown in.
      ctx.save();
      ctx.fillStyle = 'rgba(20,12,16,.55)';
      ctx.beginPath();
      ctx.rect(0, 0, BOX, BOX);
      ctx.arc(BOX / 2, BOX / 2, BOX / 2 - 6, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.restore();
    }

    zoom.addEventListener('input', function () {
      var before = view.scale;
      view.scale = view.min * (Number(zoom.value) / 100);
      // Zoom towards the middle of the window rather than the corner, so the
      // face somebody has just centred stays centred.
      view.x = BOX / 2 - (BOX / 2 - view.x) * (view.scale / before);
      view.y = BOX / 2 - (BOX / 2 - view.y) * (view.scale / before);
      draw();
    });

    var dragging = null;
    var start = function (e) {
      var p = e.touches ? e.touches[0] : e;
      dragging = { x: p.clientX - view.x, y: p.clientY - view.y };
      e.preventDefault();
    };
    var move = function (e) {
      if (!dragging) return;
      var p = e.touches ? e.touches[0] : e;
      view.x = p.clientX - dragging.x;
      view.y = p.clientY - dragging.y;
      draw();
      e.preventDefault();
    };
    var end = function () { dragging = null; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('mousemove', move);
    canvas.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchend', end);

    function close() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      veil.remove();
    }

    var modal = h('div', { class: 'modal', style: 'width:min(24rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: t('cropTitle') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: close }),
      ]),
      h('div', { class: 'body', style: 'align-items:center' }, [canvas, zoom, hint]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: close }),
        h('button', {
          class: 'btn primary', text: t('usePicture'),
          onclick: function () {
            // Saved at 192px from the window as it stands, so what was on
            // screen is exactly what is stored.
            var out = document.createElement('canvas');
            out.width = 192; out.height = 192;
            var ctx = out.getContext('2d');
            var k = 192 / BOX;
            ctx.drawImage(img, view.x * k, view.y * k,
              img.width * view.scale * k, img.height * view.scale * k);
            close();
            done(out.toDataURL('image/jpeg', 0.82));
          },
        }),
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
  }

  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () {
          var size = 192;
          var canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          var ctx = canvas.getContext('2d');
          var side = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- short links ------------------------------------------------ */

  /**
   * Short links on the fair's own address.
   *
   * A committee spends its year handing out addresses — a form on a poster, a
   * Drive folder in a LINE message, a sign-up page read out at a meeting — and
   * a forty-character Google URL cannot be typed off a poster or said across a
   * room. This makes cu-ftm.vercel.app/s/CUFAIR instead, with a QR code beside
   * it, and counts how many people followed it.
   */
  function pageLinks(main) {
    var state = { links: [], site: '', mayCreate: false, mayManageAll: false, remaining: 0 };
    var notice = h('div', { class: 'notice', hidden: true });
    var list = h('div', { class: 'link-list' });

    function say(kind, text) {
      notice.hidden = false;
      notice.className = 'notice ' + kind;
      notice.textContent = text;
    }

    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('navLinks') })]));
    main.appendChild(h('p', { class: 'hint', text: t('linksIntro') }));
    /**
     * What Google said, for somebody who has just come back from its
     * consent screen. Read once and taken out of the address, so a reload
     * does not keep announcing a thing that happened ten minutes ago.
     */
    var saidDrive = (location.hash.match(/[?&]drive=([^&]+)/) || [])[1];
    if (saidDrive) {
      location.hash = '#/admin';
      var ok = saidDrive === 'ok';
      S.adminNotice = {
        kind: ok ? 'ok' : 'err',
        text: ok ? t('driveLinked') : t('driveLinkFailed') + ' (' + decodeURIComponent(saidDrive) + ')',
      };
      notice.hidden = false;
      notice.className = 'notice ' + S.adminNotice.kind;
      notice.textContent = S.adminNotice.text;
    }

    main.appendChild(notice);

    /* ---- the form ---- */
    var target = h('input', { type: 'url', placeholder: t('linkTargetPlaceholder') });
    var label = h('input', { type: 'text', maxlength: '120', placeholder: t('linkTitlePlaceholder') });
    var custom = h('input', {
      type: 'text', maxlength: '32', placeholder: t('linkCodePlaceholder'), class: 'code-input',
    });

    var makeBtn = h('button', {
      class: 'btn primary', text: t('linkMake'),
      onclick: function () {
        var body = { url: target.value.trim(), title: label.value.trim() };
        if (custom.value.trim()) body.code = custom.value.trim();
        if (!body.url) { say('err', t('linkNeedTarget')); target.focus(); return; }

        makeBtn.disabled = true;
        api('/api/meta?do=link', { method: 'POST', body: body })
          .then(function (d) {
            target.value = ''; label.value = ''; custom.value = '';
            say('ok', t('linkMade').replace('%s', absoluteShort(d.link)));
            load();
            // Straight to the QR code, since that is what it is usually for.
            openQr(d.link);
          })
          .catch(function (err) { say('err', errText(err.code)); })
          .then(function () { makeBtn.disabled = false; });
      },
    });

    var form = h('div', { class: 'link-form' }, [
      h('div', { class: 'field' }, [h('label', { text: t('linkTarget') }), target]),
      h('div', { class: 'two' }, [
        h('div', { class: 'field' }, [h('label', { text: t('linkTitle') }), label]),
        h('div', { class: 'field' }, [
          h('label', { text: t('linkCode') }),
          h('div', { class: 'code-row' }, [
            h('span', { class: 'code-prefix', text: '/s/' }),
            custom,
          ]),
          h('small', { style: 'color:var(--ink-faint);font-size:12px', text: t('linkCodeHint') }),
        ]),
      ]),
      h('div', {}, [makeBtn]),
    ]);
    main.appendChild(form);
    main.appendChild(list);

    /* ---- the list ---- */
    function draw() {
      clear(list);
      form.hidden = !state.mayCreate;

      if (!state.links.length) {
        list.appendChild(h('div', { class: 'empty' }, [h('strong', { text: t('linkNone') })]));
        return;
      }

      state.links.forEach(function (link) {
        var mayEdit = link.mine || state.mayManageAll;

        var row = h('div', { class: 'link-row' + (link.active ? '' : ' off') }, [
          h('div', { class: 'lr-main' }, [
            h('div', { class: 'lr-short' }, [
              h('code', { text: '/s/' + link.code }),
              link.active ? null : h('span', { class: 'chip', text: t('linkOff') }),
            ]),
            link.title ? h('div', { class: 'lr-title', text: link.title }) : null,
            h('a', {
              class: 'lr-target', href: link.url, target: '_blank', rel: 'noopener noreferrer',
              text: link.url,
            }),
            h('div', { class: 'lr-by', text: nameOf(link.createdBy) }),
          ]),
          h('div', { class: 'lr-hits' }, [
            h('b', { text: String(link.hits) }),
            h('small', { text: t('linkClicks') }),
          ]),
          h('div', { class: 'lr-acts' }, [
            h('button', {
              class: 'btn sm', text: t('linkCopy'),
              onclick: function (e) { copyText(absoluteShort(link), e.target); },
            }),
            h('button', { class: 'btn sm', text: t('linkQr'), onclick: function () { openQr(link); } }),
            mayEdit ? h('button', {
              class: 'btn sm', text: link.active ? t('linkTurnOff') : t('linkTurnOn'),
              onclick: function () { change(link, { active: !link.active }); },
            }) : null,
            mayEdit ? h('button', {
              class: 'btn sm', text: t('linkRetarget'),
              onclick: function () {
                var next = prompt(t('linkRetargetAsk'), link.url);
                if (next === null || !next.trim()) return;
                change(link, { url: next.trim() });
              },
            }) : null,
            mayEdit ? h('button', {
              class: 'btn sm danger', text: t('linkDelete'),
              onclick: function () {
                if (!confirm(t('linkDeleteSure').replace('%s', '/s/' + link.code))) return;
                api('/api/meta?do=link&code=' + encodeURIComponent(link.code), { method: 'DELETE' })
                  .then(function () { say('ok', t('linkDeleted')); load(); })
                  .catch(function (err) { say('err', errText(err.code)); });
              },
            }) : null,
          ]),
        ]);
        list.appendChild(row);
      });
    }

    function change(link, patch) {
      api('/api/meta?do=link', { method: 'PATCH', body: Object.assign({ code: link.code }, patch) })
        .then(function () { load(); })
        .catch(function (err) { say('err', errText(err.code)); });
    }

    function load() {
      api('/api/meta?do=links').then(function (d) {
        state = d;
        draw();
      }).catch(function (err) {
        clear(list);
        list.appendChild(h('div', { class: 'notice err', text: errText(err.code) }));
      });
    }

    draw();
    load();
  }

  /**
   * The QR code, drawn here rather than fetched from a service.
   *
   * A QR image from an outside generator means the committee's addresses pass
   * through somebody else's server, and a poster is printed once — if that
   * service disappears, so does every future code. This draws it in the page
   * from a vendored library and hands over a PNG big enough to print.
   */
  /**
   * The full address of a short link, always absolute.
   *
   * The server knows the site's address only when SITE_URL is configured, and
   * without it `shortUrl` comes back as a bare /s/CODE. A relative path is
   * fine in a browser and useless in a QR code — a camera has no idea what
   * site it came from. The page is already AT the address, so it fills in
   * what the server could not.
   */
  function absoluteShort(link) {
    var short = link.shortUrl || ('/s/' + link.code);
    if (/^https?:\/\//i.test(short)) return short;
    return window.location.origin + (short.charAt(0) === '/' ? '' : '/') + short;
  }

  /**
   * Saving a canvas as a file.
   *
   * `a.href = canvas.toDataURL()` with an anchor that was never added to the
   * page works in Chrome on a computer and in almost nothing else: Safari
   * opens the data URL as a page instead — the code on a white background,
   * flush to the top-left corner, which is what "not centred when I download
   * it" turned out to be. A blob, a real anchor in the document, and the URL
   * released afterwards behave the same way everywhere.
   */
  function saveCanvas(canvas, filename) {
    var finish = function (href, revoke) {
      var a = document.createElement('a');
      a.download = filename;
      a.href = href;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        a.remove();
        if (revoke) URL.revokeObjectURL(href);
      }, 4000);
    };
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) { finish(canvas.toDataURL('image/png'), false); return; }
        finish(URL.createObjectURL(blob), true);
      }, 'image/png');
      return;
    }
    finish(canvas.toDataURL('image/png'), false);
  }

  /**
   * The same code on a sheet of A4, ready to print.
   *
   * What people actually do with these is stick them on a wall, and a bare
   * PNG means somebody then fights Word to get it centred on a page with the
   * address under it. This is that page: the title at the top, the code in
   * the middle of the paper, and the address under it in type big enough to
   * read from where the poster is standing.
   *
   * 2480 × 3508 is A4 at 300 dpi, which is what a laser printer wants.
   */
  function qrSheet(code, link, short) {
    var W = 2480;
    var H = 3508;
    var sheet = document.createElement('canvas');
    sheet.width = W; sheet.height = H;
    var g = sheet.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);

    /**
     * The whole block is centred, not the code.
     *
     * Centring the code alone and hanging the title above it and the address
     * below leaves the printed page bottom-heavy — measured on the first
     * version: 595px of paper above the title and 855px below the last line.
     */
    var side = Math.round(W * 0.62);            // ~13 cm, a comfortable scan
    var above = link.title ? 260 : 0;            // the title and its air
    var below = 300;                             // the address and the caption
    var x = Math.round((W - side) / 2);
    var y = Math.round((H - (above + side + below)) / 2 + above);
    // Nearest-neighbour: a QR resampled smoothly is a QR with soft edges.
    g.imageSmoothingEnabled = false;
    g.drawImage(code, x, y, side, side);

    g.fillStyle = '#14121a';
    g.textAlign = 'center';
    var font = '"Anuphan", "IBM Plex Sans Thai", system-ui, sans-serif';
    if (link.title) {
      g.font = '600 110px ' + font;
      g.fillText(String(link.title).slice(0, 48), W / 2, y - 150);
    }
    g.font = '500 78px ' + font;
    g.fillText(short, W / 2, y + side + 170);
    g.font = '400 56px ' + font;
    g.fillStyle = '#6b6875';
    g.fillText(t('qrSheetScan'), W / 2, y + side + 270);
    return sheet;
  }

  /** qrcode.js is only needed here, so it is fetched the first time a QR is opened rather than on every page load. */
  function openQr(link) {
    if (window.qrcode) { openQrNow(link); return; }
    loadScript('./vendor/qrcode.js?v=' + APP_VERSION, function () { openQrNow(link); });
  }

  function openQrNow(link) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var holder = h('div', { class: 'qr-holder' });
    var short = absoluteShort(link);

    /**
     * Error correction level H — the most redundant.
     *
     * A QR code on a poster gets rained on, taped over a corner and
     * photographed at an angle. H survives about 30% of the code being
     * unreadable; the lower levels do not, and the code is small either way at
     * this length.
     */
    var canvas = null;
    try {
      var qr = window.qrcode(0, 'H');
      qr.addData(short);
      qr.make();

      var count = qr.getModuleCount();
      // 16 pixels a module puts a 5 cm printed code at roughly 270 dpi, which
      // survives a laser printer and a phone camera at arm's length. Twelve
      // was fine on screen and marginal on paper.
      var scale = 16;
      var quiet = 4;               // the blank margin the spec requires
      var size = (count + quiet * 2) * scale;

      canvas = h('canvas', { width: String(size), height: String(size), class: 'qr-canvas' });
      var ctx = canvas.getContext('2d');
      // White, always — a QR code inverted or on a coloured ground is a QR
      // code half the scanners will refuse.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000000';
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
          }
        }
      }
      holder.appendChild(canvas);
    } catch (e) {
      holder.appendChild(h('div', { class: 'notice err', text: t('qrFailed') }));
    }

    var modal = h('div', { class: 'modal', style: 'width:min(26rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: t('linkQr') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body', style: 'align-items:center' }, [
        holder,
        h('code', { class: 'qr-url', text: short }),
        link.title ? h('p', { class: 'hint', text: link.title }) : null,
      ]),
      h('footer', {}, [
        h('button', {
          class: 'btn', text: t('linkCopy'),
          onclick: function (e) { copyText(short, e.target); },
        }),
        h('span', { class: 'grow' }),
        canvas ? h('button', {
          class: 'btn', text: t('qrDownloadSheet'), title: t('qrDownloadSheetWhy'),
          onclick: function () { saveCanvas(qrSheet(canvas, link, short), 'qr-' + link.code + '-a4.png'); },
        }) : null,
        canvas ? h('button', {
          class: 'btn primary', text: t('qrDownload'),
          onclick: function () { saveCanvas(canvas, 'qr-' + link.code + '.png'); },
        }) : null,
        h('button', { class: 'btn', text: t('close'), onclick: function () { veil.remove(); } }),
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
  }

  /** Copy, with the fallback for browsers that refuse the clipboard. */
  function copyText(text, button) {
    var done = function () {
      var was = button.textContent;
      button.textContent = t('codeCopied');
      setTimeout(function () { button.textContent = was; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { prompt(t('linkCopy'), text); });
    } else prompt(t('linkCopy'), text);
  }

  /* ---------- admin ----------------------------------------------------- */
  function pageAdmin(main) {
    /**
     * The message survives the redraw.
     *
     * Every change here re-renders the whole page, so a notice built as a
     * local element would be thrown away in the same breath as it was set —
     * which is why an admin could change something and see nothing said about
     * it, success or failure. It lives in the page state instead.
     */
    var notice = h('div', { class: 'notice', hidden: true });
    if (S.adminNotice) {
      notice.hidden = false;
      notice.className = 'notice ' + S.adminNotice.kind;
      notice.textContent = S.adminNotice.text;
    }
    var say = function (kind, text) {
      S.adminNotice = { kind: kind, text: text };
      notice.hidden = false;
      notice.className = 'notice ' + kind;
      notice.textContent = text;
    };

    main.appendChild(h('div', { class: 'page-head' }, [
      h('h1', { text: t('adminTitle') }),
    ]));

    main.appendChild(notice);

    /**
     * Why notifications are or are not arriving.
     *
     * "Notifications don't work" covers three completely different problems
     * that look identical from a phone — nothing calls the hourly endpoint,
     * nothing is due, or nobody has switched notifications on — so this says
     * which one it is instead of leaving people to guess.
     */
    var health = h('div', { class: 'notice' , hidden: true });
    main.appendChild(health);

    api('/api/users?do=health').then(function (d) {
      clear(health);
      health.hidden = false;

      var last = d.lastCron ? new Date(d.lastCron) : null;
      var hoursAgo = last ? (Date.now() - last.getTime()) / 3600000 : Infinity;
      var dead = hoursAgo > 2;
      health.className = 'notice ' + (dead ? 'err' : 'ok');

      var lines = [h('strong', { text: t('healthTitle') })];

      lines.push(h('div', { text: t('healthLastRun') + ': ' + (last
        ? last.toLocaleString(S.lang === 'th' ? 'th-TH' : 'en-GB') +
          (dead ? '  —  ' + t('healthStale') : '')
        : t('healthNeverRun')) }));

      if (dead) lines.push(h('div', { text: '⚠ ' + t('healthNoPinger') }));

      lines.push(h('div', { text: d.pushPeople
        ? d.pushPeople + ' ' + t('healthPeople') + ' ' + t('healthPush') +
          ' (' + d.pushSubscriptions + ' ' + t('healthDevices') + ')'
        : '⚠ ' + t('healthPushNone') }));

      lines.push(h('div', { text: d.lineConfigured
        ? d.lineLinked + ' ' + t('healthLine')
        : '⚠ ' + t('healthLineOff') }));

      /**
       * What LINE has cost this month, against the plan's limit.
       *
       * The limit is a hard stop rather than an overage, so it has to be
       * visible before it is hit. Replies are free and are not counted here —
       * only the messages that are actually billed.
       */
      if (d.lineConfigured && d.lineCharged) {
        var used = d.lineCharged.total;
        var pct = d.lineQuota ? Math.round((used / d.lineQuota) * 100) : 0;
        lines.push(h('div', {
          style: pct >= 80 ? 'color:var(--danger);font-weight:600' : '',
          text: t('healthLineCost')
            .replace('%u', String(used))
            .replace('%q', String(d.lineQuota))
            .replace('%p', String(pct)) +
            '  ·  ' + t('healthLineSplit')
              .replace('%d', String(d.lineCharged.documents))
              .replace('%g', String(d.lineCharged.digests)),
        }));
        lines.push(h('div', {
          style: 'color:var(--ink-faint)',
          text: t('healthDigestOptIn').replace('%n', String(d.lineDigestOptIn)),
        }));
      }

      /**
       * Where the PDFs are, and whether they are leaving.
       *
       * Documents live in the database while they are being signed and move to
       * Drive once they are finished. With Drive off, the second half never
       * happens, so the size of what is being held is shown either way — it is
       * the only number that turns into money if this is left alone.
       */
      var mb = (d.pdfBytes || 0) / 1048576;
      var size = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round((d.pdfBytes || 0) / 1024) + ' KB';

      if (d.driveConfigured) {
        // When a folder id is pinned by hand that id is what is used, so
        // naming a folder here would name the wrong one.
        lines.push(h('div', { text: d.drivePinnedFolder
          ? t('healthDrivePinned')
          : t('healthDrive').replace('%f', d.driveFolder) }));
        lines.push(h('div', {
          style: 'color:var(--ink-faint)',
          text: t('healthDriveFlow')
            .replace('%a', String(d.docsArchived))
            .replace('%w', String(d.docsWaitingToArchive))
            .replace('%g', String(d.archiveGraceDays)),
        }));
        if (d.driveByButton) {
          lines.push(h('div', { class: 'health-act' }, [
            h('small', { class: 'hint', text: t('driveLinkedBy') +
              (d.driveLinkedAt ? ' · ' + new Date(d.driveLinkedAt).toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB') : '') }),
            d.driveMayConnect ? h('button', {
              class: 'btn ghost sm danger', text: t('driveDisconnect'),
              onclick: function (e) {
                e.stopPropagation();
                if (!confirm(t('driveDisconnectAsk'))) return;
                api('/api/users?do=drive-unlink', { method: 'POST' })
                  .then(function () { renderPage(); })
                  .catch(function (err) { alert(errText(err.code)); });
              },
            }) : null,
          ].filter(Boolean)));
        }
      } else {
        // Missing one half of the credentials is a different mistake from
        // having set none of them, and a much easier one to not notice.
        lines.push(h('div', {
          style: 'color:var(--danger);font-weight:600',
          text: '⚠ ' + (d.driveHasClient || d.driveHasRefreshToken
            ? t('healthDrivePartial') : t('healthDriveOff')),
        }));
        /**
         * The button that used to be an OAuth playground.
         *
         * Only offered once the OAuth client is set, because without it
         * Google has nothing to send the person to — and that is a Vercel
         * variable, not something a page can fix. Signing in here is the
         * committee's archive account, not the admin's own.
         */
        if (d.driveMayConnect && d.driveHasClient) {
          lines.push(h('div', { class: 'health-act' }, [
            h('a', {
              class: 'btn sm', href: './api/auth?do=drive-start',
              text: t('driveConnect'),
              onclick: function (e) { e.stopPropagation(); },
            }),
            h('small', { class: 'hint', text: t('driveConnectWhy') }),
          ]));
        } else if (d.driveMayConnect) {
          lines.push(h('small', { class: 'hint', text: t('driveNeedsClient') }));
        }
      }

      lines.push(h('div', {
        style: d.driveConfigured ? 'color:var(--ink-faint)' : 'color:var(--danger)',
        text: t('healthPdfHeld')
          .replace('%s', size)
          .replace('%n', String(d.pdfDocs || 0)) +
          (d.driveConfigured
            ? (d.docsNotYetPurged
              ? '  ·  ' + t('healthPdfClearing').replace('%n', String(d.docsNotYetPurged))
              : '')
            : '  ·  ' + t('healthPdfGrowing')),
      }));

      /**
       * Meeting papers, counted separately from documents.
       *
       * Different cause, so a different line: a document in the database is
       * mid-signature and leaves by itself, whereas an attachment is here only
       * because Drive was off or refused it when somebody uploaded it, and
       * nothing comes back later to move it. Shown only once there is something
       * to say, so the page does not grow a row of zeros.
       */
      if ((d.papersHere || 0) + (d.papersInDrive || 0) + (d.paperLinks || 0) > 0) {
        var pmb = (d.paperBytes || 0) / 1048576;
        var psize = pmb >= 1 ? pmb.toFixed(1) + ' MB'
          : Math.round((d.paperBytes || 0) / 1024) + ' KB';
        lines.push(h('div', {
          style: (d.papersHere ? 'color:var(--danger)' : 'color:var(--ink-faint)'),
          text: t('healthPapers')
            .replace('%d', String(d.papersInDrive || 0))
            .replace('%l', String(d.paperLinks || 0))
            .replace('%h', String(d.papersHere || 0))
            .replace('%s', psize),
        }));
      }

      // The most common answer, and the least obvious one: nothing is due.
      if (d.remindingToday) {
        lines.push(h('div', { text: t('healthRemindToday') + ': ' + d.remindingToday }));
      } else {
        lines.push(h('div', { text: t('healthNothingDue') }));
      }

      var upcoming = (d.dueSoon || []).slice(0, 6).map(function (x) {
        return h('div', { style: 'color:var(--ink-faint)', text:
          '· ' + x.title + ' — ' +
          (x.days < 0 ? t('healthOverdue') + ' ' + Math.abs(x.days) + ' ' + t('healthDays')
            : x.days + ' ' + t('healthDays')) +
          ' · ' + x.people + ' ' + t('healthPeople') +
          (x.remindsToday ? '  ✓' : '') });
      });
      /**
       * On a phone it folds to its heading and a one-line verdict.
       *
       * A dozen lines of diagnostics, often in red, were the whole first
       * screen of this page on a phone — above the list of people, which is
       * what an admin opens it for nine days out of ten. The verdict counts
       * the lines that start with a warning, which is what decides whether
       * the rest is worth opening.
       */
      if (isPhone()) {
        var warnings = lines.filter(function (n) { return /^\u26a0/.test(n.textContent || ''); }).length + (dead ? 1 : 0);
        lines.splice(1, 0, h('small', { class: 'fold-sum', text: warnings
          ? t('phHealthWarn').replace('%n', String(warnings))
          : t('phHealthOk') }));
        health.classList.add('fold');
        health.addEventListener('click', function () { health.classList.toggle('open'); });
      }
      health.appendChild(h('div', {}, lines.concat(upcoming)));
    }).catch(function () { health.hidden = true; });

    /**
     * The list, in the committee's own order.
     *
     * Alphabetical put a สมาชิก from ประชาสัมพันธ์ above the ประธานโครงการ,
     * which is not how anybody looks for a person: you look by where they sit
     * in the chart first. So it goes by access level, then whether they run a
     * ฝ่าย, then the department's order in the chart (ประธานโครงการ, เลขานุการ,
     * … as lib/departments.js lists them), and only then by name — which is
     * what settles the twenty people inside one unit.
     */
    var ACCESS_RANK = { admin: 0, coadmin: 1, editor: 2, unitlead: 3, inner: 4 };
    var byHierarchy = function (a, b) {
      // Anybody who has left the committee goes to the bottom whatever rank.
      var live = function (u) { return (u.active ? 0 : 1) + (u.suspended ? 1 : 0); };
      if (live(a) !== live(b)) return live(a) - live(b);
      var ra = ACCESS_RANK[a.access] === undefined ? 5 : ACCESS_RANK[a.access];
      var rb = ACCESS_RANK[b.access] === undefined ? 5 : ACCESS_RANK[b.access];
      if (ra !== rb) return ra - rb;
      // "All departments" is the board, which sits above any one ฝ่าย.
      if (Boolean(a.allDepartments) !== Boolean(b.allDepartments)) return a.allDepartments ? -1 : 1;
      if (Boolean(a.isHead) !== Boolean(b.isHead)) return a.isHead ? -1 : 1;
      var da = chartOrder(a.department || (a.departments || [])[0]);
      var db = chartOrder(b.department || (b.departments || [])[0]);
      if (da !== db) return da - db;
      return String(a.displayName || a.username)
        .localeCompare(String(b.displayName || b.username), S.lang === 'th' ? 'th' : 'en');
    };

    var rows = S.users.slice().sort(byHierarchy).map(function (u) {
      var blocked = blockedReason(u);
      var status = [];
      if (!u.active) status.push(h('span', { class: 'chip', text: t('inactive') }));
      if (u.suspended) status.push(h('span', { class: 'chip overdue', text: t('suspended') }));
      if (u.resetAllowed) status.push(h('span', { class: 'chip', text: t('pendingReset') }));
      if (!u.hasPassword && !u.resetAllowed) status.push(h('span', { class: 'chip', text: t('noPassword') }));

      var deptCell = accessCell(u, blocked);

      var headCb = h('input', { type: 'checkbox', checked: u.isHead, disabled: !!blocked });
      headCb.addEventListener('change', function () { manage(u, { isHead: headCb.checked }); });

      /**
       * On a phone each person folds to one line: name, then a short summary
       * of level, home department and flags. Tapping the line opens the
       * controls. Which row is open is kept in S.userOpen so a change (which
       * redraws the page) does not snap it shut under the admin's thumb.
       */
      var open = S.userOpen === u.username;
      var nDepts = u.allDepartments ? 0 : (u.departments || []).length;
      var sum = h('div', { class: 'u-sum' }, [
        h('span', { class: 'badge ' + u.access,
          text: t('access' + u.access.charAt(0).toUpperCase() + u.access.slice(1)) }),
        h('span', { class: 'u-sum-dept', text: u.allDepartments ? t('allDepartments')
          : (u.department ? '\u2605 ' + deptLabel(u.department) : (nDepts ? deptLabel(u.departments[0]) : t('noAccess'))) +
            (nDepts > 1 ? ' +' + (nDepts - 1) : '') }),
        u.isHead ? h('span', { class: 'u-sum-flag', text: t('headShort') }) : null,
      ].concat(status.map(function (n) { return n.cloneNode(true); })));
      var tr = h('tr', {
        class: 'urow' + (u.active ? '' : ' off') + (open ? ' open' : ''),
        dataset: {
          find: [u.displayName, u.username, u.position || '',
            (u.departments || []).map(deptLabel).join(' ')].join(' ').toLowerCase(),
          access: u.access,
          depts: (u.allDepartments ? S.departments.map(function (d) { return d.key; })
            : (u.departments || [])).join(' '),
          state: [u.active ? 'active' : 'inactive', u.suspended ? 'suspended' : '',
            u.resetAllowed ? 'reset' : '',
            (!u.hasPassword && !u.resetAllowed) ? 'nopassword' : '',
            u.isHead ? 'head' : ''].filter(Boolean).join(' '),
        },
      }, [
        h('td', { class: 'u-head', onclick: function (e) {
          if (!isPhone() || e.target.closest('select,button,input,a')) return;
          S.userOpen = open ? null : u.username;
          open = !open;
          Array.prototype.forEach.call(tr.parentNode.children, function (r) {
            if (r !== tr) r.classList.remove('open');
          });
          tr.classList.toggle('open', open);
        } }, [h('div', { class: 'who-cell' }, [
          avatarNode(u.username), h('div', { class: 'u-who' }, [
            h('div', { class: 'u-name', text: u.displayName }),
            h('small', { style: 'color:var(--ink-faint)', text: u.username }),
            u.email !== undefined ? h('small', {
              class: 'u-email', style: 'display:block;color:var(--ink-faint)',
              text: u.email ? u.email + (u.emailVerified ? ' \u2713' : '') : t('noEmailYet'),
            }) : null,
            sum,
          ]),
          h('span', { class: 'u-caret', 'aria-hidden': 'true', text: '\u203a' }),
        ])]),
        // The labels are for a phone, where each row becomes a card and the
        // column headings are gone — see .tablewrap in phone.css.
        h('td', { dataset: { label: t('accessLevel') } }, [accessLevelCell(u, blocked)]),
        h('td', { dataset: { label: t('position') }, text: u.position || '—' }),
        h('td', { dataset: { label: t('deptAccess') } }, [deptCell]),
        h('td', { dataset: { label: t('isHead') }, style: 'text-align:center' }, [headCb]),
        status.length
          ? h('td', {}, [h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, status)])
          : h('td', {}),
        h('td', {}, [h('div', { style: 'display:flex;gap:5px;flex-wrap:wrap' }, blocked
          ? [h('small', { style: 'color:var(--ink-faint)', text: errText(blocked) })]
          : [
            h('button', {
              class: 'btn sm', text: t('renameUser'),
              onclick: function () { openRename(u); },
            }),
            h('button', {
              class: 'btn sm', text: u.resetAllowed ? t('cancelReset') : t('allowReset'),
              onclick: function () { manage(u, { allowReset: !u.resetAllowed }); },
            }),
            h('button', {
              class: 'btn sm ' + (u.suspended ? '' : 'danger'), text: u.suspended ? t('restore') : t('suspend'),
              onclick: function () { manage(u, { suspended: !u.suspended }); },
            }),
            /**
             * Only offered once somebody is already out — off the sheet or
             * suspended. There is no undo, and an active member is removed by
             * taking them off the sheet, which is where membership is decided.
             */
            (!u.active || u.suspended) ? h('button', {
              class: 'btn sm danger', text: t('deleteUser'),
              onclick: function () { removeUser(u); },
            }) : null,
          ])]),
      ]);
      return tr;
    });

    /**
     * Find a person without scrolling past four hundred others.
     *
     * The search box alone meant knowing the name you were after; the three
     * dropdowns answer the other question an admin comes here with — "show me
     * everyone in ฝ่ายร้านค้า", "who is still without a password". Everything
     * filters in place so typing never loses focus, and the choices are kept
     * in S so a change that redraws the page does not reset them.
     */
    S.userFilter = S.userFilter || { dept: '', access: '', state: '' };
    function filterUsers() {
      S.userQuery = findBox.value;
      S.userFilter = { dept: deptPick.value, access: accessPick.value, state: statePick.value };
      var q = findBox.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (r) {
        var d = r.dataset;
        var hide = (!!q && d.find.indexOf(q) === -1)
          || (S.userFilter.dept && (' ' + d.depts + ' ').indexOf(' ' + S.userFilter.dept + ' ') === -1)
          || (S.userFilter.access && d.access !== S.userFilter.access)
          || (S.userFilter.state && (' ' + d.state + ' ').indexOf(' ' + S.userFilter.state + ' ') === -1);
        r.hidden = hide;
        if (!hide) shown += 1;
      });
      count.textContent = t('userShowing').replace('%n', String(shown)).replace('%a', String(rows.length));
    }
    var findBox = h('input', {
      type: 'search', class: 'user-find', placeholder: t('userFind'), value: S.userQuery || '',
      oninput: filterUsers,
    });
    var deptPick = h('select', { onchange: filterUsers }, [h('option', { value: '', text: t('allDepts') })]
      .concat(S.departments.map(function (d) {
        return h('option', { value: d.key, text: deptOptionLabel(d), selected: d.key === S.userFilter.dept });
      })));
    var accessPick = h('select', { onchange: filterUsers }, [h('option', { value: '', text: t('allAccess') })]
      .concat(['admin', 'coadmin', 'editor', 'unitlead', 'inner'].map(function (lv) {
        return h('option', { value: lv, selected: lv === S.userFilter.access,
          text: t('access' + lv.charAt(0).toUpperCase() + lv.slice(1)) });
      })));
    var statePick = h('select', { onchange: filterUsers }, [h('option', { value: '', text: t('allStates') })]
      .concat([['active', 'userOnlyActive'], ['head', 'userOnlyHeads'], ['nopassword', 'userNoPassword'],
        ['reset', 'pendingReset'], ['suspended', 'suspended'], ['inactive', 'inactive']].map(function (pair) {
        return h('option', { value: pair[0], selected: pair[0] === S.userFilter.state, text: t(pair[1]) });
      })));
    var count = h('small', { class: 'user-count' });
    main.appendChild(h('div', { class: 'user-filters' }, [findBox, deptPick, accessPick, statePick, count]));
    filterUsers();

    main.appendChild(h('div', { class: 'tablewrap users-table' }, [
      h('table', {}, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: t('displayName') }), h('th', { text: t('accessLevel') }),
          h('th', { text: t('position') }), h('th', { text: t('deptAccess') }),
          h('th', { text: t('isHead'), style: 'text-align:center' }),
          h('th', { text: '' }), h('th', { text: '' }),
        ])]),
        h('tbody', {}, rows),
      ]),
    ]));

    if (S.canManage) orgSection(main, say);
    if (S.canManage) groupSection(main, say);

    /**
     * The access level — Admin, Co-Admin or Editor.
     *
     * Only an admin sees a dropdown here; everyone else sees the badge, which
     * is what the server enforces anyway. Changing it writes back to the
     * Google Sheet, so the two do not drift apart — and when that write cannot
     * be made, the row says so rather than letting an admin believe the sheet
     * was updated.
     */
    function accessLevelCell(u, blocked) {
      var badge = h('span', {
        class: 'badge ' + u.access,
        text: t('access' + u.access.charAt(0).toUpperCase() + u.access.slice(1)),
      });
      if (blocked || !S.canSetAccess) return badge;

      var box = h('div', { class: 'access-cell' });
      var pick = h('select', {
        class: 'add-dept',
        onchange: function (e) {
          var want = e.target.value;
          if (want === u.access) return;
          manage(u, { access: want });
        },
      }, ['admin', 'coadmin', 'editor', 'unitlead', 'inner'].map(function (level) {
        return h('option', {
          value: level, selected: level === u.access,
          text: t('access' + level.charAt(0).toUpperCase() + level.slice(1)),
        });
      }));
      box.appendChild(pick);

      return box;
    }

    /**
     * Department access for one person.
     *
     * Each granted department is a chip that removes itself when clicked, and
     * the dropdown beside them adds one. Both send the whole list the person
     * should end up with, so adding, removing and clearing are the same call
     * and two admins editing at once cannot leave a half-applied state.
     */
    function accessCell(u, blocked) {
      var box = h('div', { class: 'access-cell' });
      var granted = (u.departments || []).slice().sort(function (a, b) {
        return chartOrder(a) - chartOrder(b);
      });

      function send(changes) { manage(u, changes); }

      if (u.allDepartments) {
        box.appendChild(h('span', {
          class: 'chip dept all' + (blocked ? '' : ' x'),
          title: blocked ? '' : t('removeAccess'),
          onclick: blocked ? null : function () { send({ allDepartments: false, departments: [] }); },
        }, [t('allDepartments') + (blocked ? '' : ' \u2715')]));
      } else if (granted.length) {
        granted.forEach(function (key) {
          var home = key === u.department;
          box.appendChild(h('span', {
            class: 'chip dept' + (home ? ' home' : '') + (blocked ? '' : ' x'),
            title: home ? t('homeIs') : (blocked ? '' : t('removeAccess')),
            onclick: blocked ? null : function () {
              send({ departments: granted.filter(function (k) { return k !== key; }) });
            },
          }, [(home ? '\u2605 ' : '') + deptLabel(key) + (blocked ? '' : ' \u2715')]));
        });
      } else {
        box.appendChild(h('span', { class: 'chip', text: t('noAccess') }));
      }

      if (blocked) return box;

      var choices = S.departments.filter(function (d) {
        return !u.allDepartments && granted.indexOf(d.key) === -1;
      });

      var add = h('select', {
        class: 'add-dept',
        onchange: function (e) {
          var key = e.target.value;
          e.target.value = '';
          if (!key) return;
          if (key === '*') send({ allDepartments: true, departments: [] });
          else send({ departments: granted.concat([key]) });
        },
      }, [h('option', { value: '', text: '+ ' + t('addAccess') })]
        .concat(choices.map(function (d) {
          return h('option', { value: d.key, text: deptOptionLabel(d) });
        }))
        .concat(u.allDepartments ? [] : [h('option', { value: '*', text: t('allDepartments') })]));
      box.appendChild(add);

      /**
       * Where this person's access came from. Once it has been set here the
       * sheet stops overriding it — which has to be visible, or an admin would
       * edit the sheet, see nothing change, and have no way to find out why.
       */
      /**
       * The section, after the departments and only once there are some.
       *
       * It is offered from the departments this person has actually been
       * granted, so a section can never be set to one belonging to a
       * department they cannot see — which is what a unit editor's whole
       * scope is measured against.
       */
      var sections = [];
      (u.allDepartments ? S.departments.map(function (d) { return d.key; }) : granted)
        .forEach(function (key) {
          var dept = S.departments.filter(function (d) { return d.key === key; })[0];
          (dept && dept.units ? dept.units : []).forEach(function (name) {
            if (sections.indexOf(name) === -1) sections.push(name);
          });
        });

      if (sections.length) {
        var unitSel = h('select', {
          class: 'add-dept unit',
          title: t('unitPickerHint'),
          onchange: function (e) { send({ unit: e.target.value || null }); },
        }, [h('option', { value: '', text: t('noUnit'), selected: !u.unit })]
          .concat(sections.map(function (name) {
            return h('option', { value: name, text: name, selected: u.unit === name });
          })));
        box.appendChild(unitSel);
      }

      return box;
    }

    function removeUser(target) {
      // Two sentences, then the name typed out. Deleting somebody is rare
      // enough that a moment's friction costs nothing and a mistaken click
      // costs an account.
      if (!confirm(t('deleteUserSure').replace('%s', target.displayName))) return;
      var typed = prompt(t('deleteUserType').replace('%s', target.username));
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== target.username.toLowerCase()) {
        say('err', t('deleteUserMismatch'));
        renderPage();
        return;
      }

      api('/api/users?do=user&username=' + encodeURIComponent(target.username), { method: 'DELETE' })
        .then(function (data) {
          S.users = data.users;
          var moved = data.kept.tasks + data.kept.events + data.kept.documents;
          say('ok', t('deleteUserDone').replace('%s', data.removed) +
            (moved ? '  \u00b7  ' + t('deleteUserKept').replace('%n', String(moved)) : ''));
          renderPage();
        })
        .catch(function (err) { say('err', errText(err.code)); renderPage(); });
    }

    function manage(target, changes) {
      api('/api/users?do=manage', { method: 'PATCH', body: Object.assign({ username: target.username }, changes) })
        .then(function (data) {
          var i = S.users.findIndex(function (u) { return u.username === data.user.username; });
          if (i !== -1) S.users[i] = data.user;
          // Say what happened to the sheet, every time something was meant to
          // reach it. Silence here is how an admin ends up trusting a change
          // that only exists in one of the two places.
          if (data.sheet) say(data.sheet.ok ? 'ok' : 'warn', data.sheet.ok ? t('sheetWrote') : t('sheetNotWrote'));
          renderPage();
        })
        .catch(function (err) {
          say('err', errText(err.code));
          renderPage();
        });
    }
  }

  /**
   * Mirrors the server's rule so the interface doesn't offer buttons that
   * would be refused. The server decides; this only keeps the UI honest.
   */
  /**
   * Mirrors lib/auth.js canEditTasks. The server is what enforces it; this is
   * only so the page does not offer what would be refused.
   */
  /**
   * Who may write work down: anybody signed in.
   *
   * It used to exclude a สมาชิกฝ่าย, which meant the person who noticed the
   * posters had not been ordered had to message somebody senior to type it
   * for them. That is how a tracker becomes a thing people work around.
   */
  function mayCreate() { return Boolean(S.user); }

  /**
   * Who may call a meeting: everybody, which is now also what mayCreate()
   * answers. Kept as its own name because the two are different questions
   * that happen to have the same answer, and the next rule that changes one
   * of them should not have to untangle them first.
   */
  function mayCallMeeting() { return Boolean(S.user); }

  /** The people a unit editor may put work on: their own section, and themselves. */
  /**
   * Who is in a circle, read off the roster the page already holds.
   *
   * This used to work the access ladder out here, which was the same rule
   * the server used and is no longer the whole rule: an admin can put
   * somebody into คณะกรรมการบริหาร or keep them out of it, and a group the
   * committee invented derives nothing from access at all. So the server
   * stamps every directory row with the circles that person is actually in,
   * and the page reads rather than recomputes — one answer, from the side
   * that owns it.
   */
  function circleMembers(key) {
    return (S.users || [])
      .filter(function (u) { return (u.circles || []).indexOf(key) !== -1; })
      .map(function (u) { return u.username; });
  }

  /** Am I in this one? */
  function inCircle(key) {
    var me = (S.users || []).filter(function (u) { return u.username === S.user.username; })[0];
    return Boolean(me && (me.circles || []).indexOf(key) !== -1);
  }

  /**
   * Which circles a chosen list of people completely covers.
   *
   * Asked at save time rather than tracked as the organiser clicks, because
   * what matters is the end state: a circle tapped on and then one person
   * removed is no longer that circle, and saying it is would quietly put that
   * person back at the next roster sync.
   */
  function circlesCovered(usernames) {
    var chosen = usernames || [];
    return (S.circles || []).map(function (c) { return c.key; }).filter(function (key) {
      var members = circleMembers(key);
      if (!members.length) return false;
      return members.every(function (u) { return chosen.indexOf(u) !== -1; });
    });
  }

  /** The circles a picker should offer, with how many people are in each. */
  function circleChoices() {
    return (S.circles || []).map(function (c) {
      return { key: c.key, label: S.lang === 'en' ? c.en : c.th,
               note: c.note, members: circleMembers(c.key) };
    }).filter(function (c) { return c.members.length > 0; });
  }

  /**
   * Anybody may be appointed, by anybody who may create work at all.
   *
   * This used to offer a unit head only their own section, mirroring a server
   * rule that has since gone: the fair works across departments constantly, and
   * needing somebody more senior to ask สถานที่ for one person for an afternoon
   * was slower than the rule was worth. What keeps it honest now is that the
   * person appointed gets an invitation to accept or decline, and whoever is
   * appointing is warned first if they are not free.
   *
   * Kept as a function rather than deleted at its two call sites: it is where
   * the next rule about who may be offered belongs.
   */
  function assignableTo() { return true; }

  function blockedReason(target) {
    if (S.user.access === 'admin') return null;
    if (S.user.access === 'coadmin') {
      if (target.access === 'admin') return 'COADMIN_CANNOT_TOUCH_ADMIN';
      if (target.access === 'coadmin') return 'COADMIN_CANNOT_TOUCH_COADMIN';
      return null;
    }
    return 'EDITORS_CANNOT_MANAGE_ACCOUNTS';
  }


  /* ---------- is everybody actually free? -------------------------------- */

  /**
   * Asks the server who is not free for this, and lets the person decide.
   *
   * Never refuses to save anything. Jade asked for the person handing out the
   * work to be TOLD — a hard block would only teach people to put the wrong
   * time in to get past it, and then the calendar lies about something that
   * matters instead of something that does not.
   *
   * Resolves to { go, prioritise }. `go: false` only when they pressed cancel.
   * A check that fails for any other reason — offline, server down — resolves
   * to go:true, because being unable to warn somebody is not a reason to stop
   * them working.
   */
  function askAboutClashes(when, people, ignoreId) {
    if (!when || !when.on || !(people || []).length) {
      return Promise.resolve({ go: true, prioritise: false });
    }
    return api('/api/users?do=clashes', {
      method: 'POST',
      body: { on: when.on, at: when.at || null, to: when.to || null,
              people: people, ignoreId: ignoreId || null },
    }).then(function (d) {
      var clashes = (d && d.clashes) || [];
      if (!clashes.length) return { go: true, prioritise: false };
      return showClashes(clashes);
    }).catch(function () { return { go: true, prioritise: false }; });
  }

  /** How one clash reads, in a sentence rather than a field name. */
  function clashLine(c) {
    if (c.kind === 'away') {
      return t('clashAway')
        .replace('%f', c.from || '')
        .replace('%t', c.to || '')
        + (c.reason ? ' · ' + c.reason : '');
    }
    if (c.kind === 'offDay') return t('clashOffDay').replace('%d', t('day_' + c.day));
    if (c.kind === 'outsideHours') {
      return t('clashOutsideHours')
        .replace('%d', t('day_' + c.day))
        .replace('%w', (c.windows || []).join(', '));
    }
    var what = c.what === 'meeting' ? t('navMeetings')
      : c.what === 'event' ? t('navEvents') : t('navAll');
    return t('clashBooked')
      .replace('%a', c.at || '')
      .replace('%k', what)
      .replace('%s', (c.code ? c.code + ' ' : '') + c.title);
  }

  function showClashes(clashes) {
    return new Promise(function (resolve) {
      var answered = false;
      var done = function (answer) {
        if (answered) return;
        answered = true;
        veil.remove();
        resolve(answer);
      };

      var veil = h('div', { class: 'veil' });
      var body = h('div', { class: 'body' }, [
        h('p', { class: 'hint', text: t('clashIntro') }),
        h('div', { class: 'clash-list' }, clashes.map(function (p) {
          return h('div', { class: 'clash' }, [
            h('div', { class: 'clash-who' }, [
              avatarNode(p.username, 'sm'),
              h('b', { text: p.displayName || p.username }),
            ]),
            h('ul', { class: 'clash-why' }, p.clashes.map(function (c) {
              return h('li', { class: c.kind === 'booked' ? 'booked' : 'away',
                               text: clashLine(c) });
            })),
          ]);
        })),
      ]);

      /**
       * The override is offered only when it would really apply to every clash.
       *
       * One button cannot half-mean something. If a person is both in an exam
       * week and double-booked, no rank in the committee makes the exam go
       * away — so the button is not shown, rather than shown and then quietly
       * doing less than it says.
       */
      var mayAll = clashes.every(function (p) { return p.mayPrioritiseAll; });

      var footer = h('footer', {}, [
        h('button', { class: 'btn', text: t('clashBack'),
          onclick: function () { done({ go: false }); } }),
        h('button', { class: 'btn', text: t('clashAnyway'),
          onclick: function () { done({ go: true, prioritise: false }); } }),
        mayAll ? h('button', { class: 'btn primary', text: t('clashPrioritise'),
          onclick: function () { done({ go: true, prioritise: true }); } }) : null,
      ].filter(Boolean));

      if (mayAll) body.appendChild(h('p', { class: 'hint', text: t('clashPrioritiseHow') }));

      veil.appendChild(h('div', { class: 'modal' }, [
        h('header', {}, [
          h('h2', { text: t('clashTitle') }),
          h('button', { class: 'btn ghost sm', text: '✕',
            onclick: function () { done({ go: false }); } }),
        ]),
        body, footer,
      ]));
      // Clicking the veil is "I did not mean to", which is going back.
      veil.addEventListener('click', function (e) { if (e.target === veil) done({ go: false }); });
      $('modal-root').appendChild(veil);
    });
  }

  /** The note on something that has been outranked, or nothing. */
  function outrankedNote(item) {
    var beaten = item && item.outrankedBy;
    if (!beaten || !beaten.length) return null;
    // Only ever about the person reading it: being told that somebody else was
    // pulled off this is noise to everybody but them.
    var mine = beaten.filter(function (b) { return b.username === S.user.username; });
    if (!mine.length) return null;
    return h('span', { class: 'chip outranked', title: t('outrankedWhy'),
                       text: t('outranked') });
  }

  /* ---------- meetings --------------------------------------------------- */

  /**
   * The committee's five วาระ, as they appear in every set of its minutes.
   *
   * Repeated here rather than fetched so that the agenda can be filled in
   * while the meeting is still being typed, before anything has been saved.
   * The server holds the same list and is what a template actually produces;
   * this copy only decides what the page shows first.
   */
  /**
   * `kind` is what makes one of these a HEADING rather than an ordinary line.
   *
   * It was missing here, so every agenda built on this page was saved as five
   * plain items: no sub-numbering, no add box under each วาระ, and anything
   * proposed landed at the top level instead of under a heading. The server
   * keeps the same five kinds and they have to match.
   */
  var STANDARD_AGENDA = [
    { kind: 'chair', title: 'วาระที่ 1 วาระประธานแจ้งให้ที่ประชุมทราบ' },
    { kind: 'inform', title: 'วาระที่ 2 วาระเรื่องแจ้งเพื่อทราบ' },
    { kind: 'carried', title: 'วาระที่ 3 เรื่องสืบเนื่อง' },
    { kind: 'decide', title: 'วาระที่ 4 เรื่องเสนอเพื่อพิจารณา' },
    { kind: 'other', title: 'วาระที่ 5 เรื่องอื่น ๆ' },
  ];

  /** Where a start time plus a run of minutes lands, as a clock reading. */
  function endingAt(startsAt, minutes) {
    if (!/^\d{1,2}:\d{2}$/.test(startsAt || '')) return '—';
    var parts = startsAt.split(':');
    var total = Number(parts[0]) * 60 + Number(parts[1]) + minutes;
    return String(Math.floor(total / 60) % 24).padStart(2, '0') + ':' +
           String(total % 60).padStart(2, '0');
  }

  /**
   * การประชุม.
   *
   * A meeting is not an event and not a task: it has an agenda that the people
   * attending propose items to, a link to join, and minutes that only exist
   * afterwards. It gets its own page for that reason rather than another set of
   * fields hanging off the calendar.
   */
  /**
   * Re-reads the meetings and redraws whatever page is showing.
   *
   * There is no meetings page any more — they appear in the strip at the top
   * of the work page and on the calendar — so saving one has to refresh the
   * page the person is actually looking at.
   */
  /**
   * Refreshes the meetings without redrawing the page underneath.
   *
   * renderPage() rebuilds the work page, which is fine when the dialog is
   * closing and wrong when it is staying open — the dialog would be left
   * floating over a page that had been torn down and rebuilt beneath it.
   */
  function reloadMeetingsQuietly() {
    return api('/api/events?do=meetings').then(function (d) {
      S.meetings = d.meetings || [];
    }).catch(function () {});
  }

  function reloadMeetings() {
    return api('/api/events?do=meetings').then(function (d) {
      S.meetings = d.meetings || [];
      renderPage();
    }).catch(function () {});
  }

  /** The colour of an answer, which is the whole point of showing it. */
  function replyClass(reply) {
    return reply === 'accepted' ? 'yes' : reply === 'declined' ? 'no' : 'maybe';
  }

  function openMeeting(meeting, preset) {
    var isNew = !meeting;
    preset = preset || {};
    var draft = {
      title: meeting ? meeting.title : (preset.title || ''),
      note: meeting ? meeting.note : '',
      meetsOn: meeting ? meeting.meetsOn : (preset.meetsOn || ''),
      meetsAt: meeting ? (meeting.meetsAt || '') : (preset.meetsAt || ''),
      endsAt: meeting ? (meeting.endsAt || '') : (preset.endsAt || ''),
      spaceId: meeting ? (meeting.spaceId || '') : (preset.spaceId || ''),
      repeat: { freq: 'none', count: 4, until: '' },
      place: meeting ? meeting.place : '',
      joinUrl: meeting ? meeting.joinUrl : '',
      agendaUrl: meeting ? meeting.agendaUrl : '',
      minutesUrl: meeting ? meeting.minutesUrl : '',
      assignees: meeting ? meeting.people.map(function (p) { return p.username; })
        : [S.user.username].concat((preset.people || []).filter(function (u) { return u !== S.user.username; })),
      departments: [],
      // People with no account here, invited by email through Google.
      guests: meeting ? meeting.guests.map(function (g) { return g.email; }).join(', ') : '',
      template: 'standard',
      notify: meeting ? (meeting.notify || ['1d', '1h']).slice() : ['1d', '1h'],
    };
    var mayEdit = isNew || meeting.mayEdit;

    var veil = h('div', { class: 'veil' });
    /**
     * The same markup every other dialog in this app uses.
     *
     * This was written with class names of its own — modal-head, modal-body,
     * modal-foot — none of which the stylesheet has ever heard of, so the
     * dialog came out with no padding, no gaps, and a people picker running
     * off into the rest of the form. The shell is <header>/<div class="body">/
     * <footer>, and dialogs that use it get scrolling and spacing for free.
     */
    var bodyBox = h('div', { class: 'body' });
    var footer = h('footer', {});
    var notice = h('div', { class: 'notice err', hidden: true });

    function fail(text) { notice.hidden = false; notice.textContent = text; }

    var field = function (label, node) {
      return h('div', { class: 'field' }, [h('label', { text: label }), node]);
    };
    var input = function (key, type) {
      var el = h('input', { type: type || 'text', value: draft[key] || '', disabled: !mayEdit });
      el.addEventListener('input', function () { draft[key] = el.value; });
      return el;
    };

    var peopleBox = h('div', { class: 'picker' + (mayEdit ? '' : ' readonly') });
    if (mayEdit) buildPeoplePicker(peopleBox, draft);

    /**
     * Guests from outside the committee.
     *
     * A plain box rather than another picker: these people have no account to
     * pick from, and the address usually arrives pasted out of an email.
     */
    var guestsIn = h('textarea', { rows: '2', disabled: !mayEdit,
      placeholder: 'ajarn@chula.ac.th, supplier@example.co.th' });
    guestsIn.value = draft.guests;
    guestsIn.addEventListener('input', function () { draft.guests = guestsIn.value; });

    bodyBox.appendChild(notice);

    /**
     * What somebody opened the meeting to look at comes first.
     *
     * For a meeting that already exists, that is who is coming and what is on
     * the agenda — not seven form fields they have to scroll past. The details
     * are still there, underneath, for the organiser who came to change them.
     */
    /**
     * What the meeting is about, in somebody's own words.
     *
     * The column has existed since meetings were added and nothing ever wrote
     * to it: there was no box for it anywhere in this form, so every meeting
     * was a title, a time and a place with no room to say "bring last month's
     * figures". A textarea rather than another one-line input, because the
     * useful version of this is three sentences.
     */
    var noteIn = h('textarea', { rows: '3', disabled: !mayEdit,
      placeholder: t('mtgNoteHint') });
    noteIn.value = draft.note || '';
    noteIn.addEventListener('input', function () { draft.note = noteIn.value; });

    /**
     * Repeating, for a new meeting: how often, and until when. Every
     * occurrence becomes a meeting of its own (see lib/meetingstore.js), so
     * this is only asked once, at the start.
     */
    var repeatBox = null;
    if (isNew) {
      var freqSel = h('select', {}, [['none', 'repeatNone'], ['daily', 'repeatDaily'], ['weekdays', 'repeatWeekdays'],
        ['weekly', 'repeatWeekly'], ['biweekly', 'repeatBiweekly'], ['monthly', 'repeatMonthly']].map(function (x) {
        return h('option', { value: x[0], text: t(x[1]) });
      }));
      var endKind = h('select', {}, [h('option', { value: 'count', text: t('repeatTimes') }), h('option', { value: 'until', text: t('repeatUntil') })]);
      var countIn = h('input', { type: 'number', min: '2', max: '52', value: '4', style: 'max-width:6rem' });
      var untilIn = h('input', { type: 'date', hidden: true });
      var endRow = h('div', { class: 'repeat-end', hidden: true }, [endKind, countIn, untilIn]);
      var repeatNote = h('small', { class: 'field-hint' });
      var syncRepeat = function () {
        draft.repeat.freq = freqSel.value;
        endRow.hidden = freqSel.value === 'none';
        countIn.hidden = endKind.value !== 'count';
        untilIn.hidden = endKind.value !== 'until';
        draft.repeat.count = endKind.value === 'count' ? Number(countIn.value) || 0 : null;
        draft.repeat.until = endKind.value === 'until' ? untilIn.value : '';
        repeatNote.textContent = freqSel.value === 'none' ? '' : t('repeatHint');
      };
      [freqSel, endKind, countIn, untilIn].forEach(function (el) {
        el.addEventListener('change', syncRepeat); el.addEventListener('input', syncRepeat);
      });
      repeatBox = h('div', { class: 'field repeat-box' }, [h('label', { text: t('repeat') }),
        h('div', { class: 'repeat-row' }, [freqSel, endRow]), repeatNote]);
    }
    /**
     * The reminders this meeting sends.
     *
     * An invitation always goes out, and so does a change of day, time or
     * place, and a cancellation — those are news. These are the nudges
     * before it, and they are per meeting because a weekly stand-up does not
     * need the same warning as the ประชุมสามัญ.
     */
    var notifyBox = h('div', { class: 'checks' }, [
      ['3d', 'mtgRemind3d'], ['1d', 'mtgRemind1d'], ['1h', 'mtgRemind1h'],
    ].map(function (pair) {
      var cb = h('input', { type: 'checkbox', checked: draft.notify.indexOf(pair[0]) !== -1, disabled: !mayEdit });
      cb.addEventListener('change', function () {
        draft.notify = draft.notify.filter(function (k) { return k !== pair[0]; });
        if (cb.checked) draft.notify.push(pair[0]);
      });
      return h('label', {}, [cb, t(pair[1])]);
    }));

    var spaceOpts = (S.spaces || []).filter(function (sp) { return sp.mine || S.seesEverything; });
    var spaceSel = h('select', { disabled: !mayEdit }, [h('option', { value: '', text: t('spaceNone') })].concat(
      spaceOpts.map(function (sp) { return h('option', { value: sp.id, text: sp.name, selected: sp.id === draft.spaceId }); })));
    spaceSel.addEventListener('change', function () { draft.spaceId = spaceSel.value; });

    var detailPane = h('div', { class: 'pane' }, [
      field(t('mtgTitle'), input('title')),
      field(t('mtgDate'), input('meetsOn', 'date')),
      h('div', { class: 'two' }, [field(t('mtgStart'), input('meetsAt', 'time')), field(t('mtgEnd'), input('endsAt', 'time'))]),
      repeatBox,
      spaceOpts.length ? field(t('space'), spaceSel) : null,
      field(t('mtgPlace'), input('place')),
      field(t('mtgNote'), noteIn),
      field(t('mtgJoin'), input('joinUrl', 'url')),
      field(t('mtgAgendaUrl'), input('agendaUrl', 'url')),
      isNew ? null : field(t('mtgMinutesUrl'), input('minutesUrl', 'url')),
      field(t('mtgWho'), peopleBox),
      h('div', { class: 'field' }, [
        h('label', { text: t('mtgGuests') }),
        guestsIn,
        h('p', { class: 'hint', text: t('mtgGuestsHow') }),
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: t('mtgRemind') }),
        notifyBox,
        h('p', { class: 'hint', text: t('mtgRemindHow') }),
      ]),
    ].filter(Boolean));
    if (isNew) bodyBox.appendChild(detailPane);

    /**
     * A meeting opens as something to read, not something to edit.
     *
     * Most people opening a meeting have come to find out when it is and what
     * is on it. Showing them a form — greyed out, with an empty box where the
     * attendee picker would be — made the page look broken for everybody who
     * is not running the meeting, and looked editable to people who are not
     * allowed to edit. The facts come first; the form arrives when somebody
     * who may change them asks for it.
     */
    var summaryPane = h('div', { class: 'pane mtg-summary' });
    function drawSummary() {
      clear(summaryPane);
      var line = function (label, value, href) {
        if (!value) return;
        summaryPane.appendChild(h('div', { class: 'sum-row' }, [
          h('span', { class: 'sum-label', text: label }),
          href
            ? h('a', { class: 'chip dept', target: '_blank', rel: 'noopener', href: href, text: value })
            : h('span', { class: 'sum-value', text: value }),
        ]));
      };
      line(t('mtgDate'), meeting.meetsOn + (meeting.meetsAt ? ' · ' + meeting.meetsAt + (meeting.endsAt ? '–' + meeting.endsAt : '') : ''));
      if (meeting.repeatRule) line(t('repeat'), t({ daily: 'repeatDaily', weekdays: 'repeatWeekdays', weekly: 'repeatWeekly', biweekly: 'repeatBiweekly', monthly: 'repeatMonthly' }[meeting.repeatRule] || 'repeat'));
      if (meeting.spaceId && spaceBy(meeting.spaceId)) line(t('space'), spaceBy(meeting.spaceId).name);
      line(t('mtgPlace'), meeting.place);
      /**
       * The description was being shown under the label "หัวข้อการประชุม" —
       * the TITLE's label — which is the one wrong place for it, since the
       * title is already the heading of the dialog. It has its own label now,
       * and keeps its line breaks, because people type paragraphs in there.
       */
      if (meeting.note) {
        summaryPane.appendChild(h('div', { class: 'sum-row' }, [
          h('span', { class: 'sum-label', text: t('mtgNote') }),
          h('span', { class: 'sum-value', style: 'white-space:pre-wrap', text: meeting.note }),
        ]));
      }
      line(t('mtgJoin'), meeting.joinUrl ? t('mtgOpenJoin') : '', meeting.joinUrl);
      line(t('mtgAgendaUrl'), meeting.agendaUrl ? t('mtgOpenAgenda') : '', meeting.agendaUrl);
      line(t('mtgMinutesUrl'), meeting.minutesUrl ? t('mtgOpenMinutes') : '', meeting.minutesUrl);

      /**
       * Into somebody's own Google Calendar, in one click.
       *
       * The subscribed feed covers people who have set it up; most people
       * have not, and a meeting they cannot get into their own calendar is a
       * meeting they will miss. The link carries the joining address and the
       * agenda, not just a title and a time.
       */
      if ((meeting.guests || []).length) {
        summaryPane.appendChild(h('div', { class: 'sum-row' }, [
          h('span', { class: 'sum-label', text: t('mtgGuests') }),
          h('span', {}, [
            h('span', { class: 'mtg-people' }, meeting.guests.map(function (g) {
              return h('span', { class: 'chip dept', text: g.email });
            })),
            // Said plainly, because it is the one thing about this that
            // surprises people: nothing here emails them.
            h('p', { class: 'hint', text: t('mtgGuestsSend') }),
          ]),
        ]));
      }

      if (meeting.googleUrl) {
        summaryPane.appendChild(h('div', { class: 'sum-row' }, [
          h('span', { class: 'sum-label', text: t('mtgAddToCalendar') }),
          h('a', { class: 'chip dept', target: '_blank', rel: 'noopener',
            href: meeting.googleUrl, text: t('mtgGoogleCalendar') }),
        ]));
      }

      /**
       * The notice, as a letter.
       *
       * Written by the server from this meeting — the date, the place and the
       * whole ระเบียบวาระ — in TH Sarabun New, so it can be printed, signed
       * and sent as it is instead of being retyped in Word every time.
       */
      // How loudly this one meeting speaks to me, over my own settings.
      summaryPane.appendChild(h('div', { class: 'sum-row' }, [
        h('span', { class: 'sum-label', text: t('mtgNotifyThis') }),
        notifyControl('meeting', meeting.id, 'meeting'),
      ]));

      summaryPane.appendChild(h('div', { class: 'sum-row' }, [
        h('span', { class: 'sum-label', text: t('mtgNotice') }),
        h('a', {
          class: 'btn sm', target: '_blank', rel: 'noopener',
          href: '/api/events?do=notice&id=' + encodeURIComponent(meeting.id),
          text: t('mtgNoticeOpen'),
        }),
        h('small', { class: 'hint', text: t('mtgNoticeWhy') }),
      ]));
    }
    if (!isNew) { drawSummary(); bodyBox.appendChild(summaryPane); }

    /**
     * Which agenda a new meeting starts with.
     *
     * The committee's five วาระ are what every set of its minutes uses, so
     * they are offered as a starting point — but a working session of three
     * people does not need เรื่องสืบเนื่อง, and a blank agenda is as valid.
     */
    if (isNew) {
      /**
       * The agenda, while the meeting is still being created.
       *
       * It used to be impossible to touch the agenda until after the meeting
       * had been saved and reopened, which is not how anybody plans one — you
       * decide what the meeting is FOR at the same moment you decide when it
       * is. Picking a template fills this list; items can then be added,
       * removed and re-timed before anything is saved.
       */
      draft.agenda = [];
      var agendaDraft = h('div', { class: 'agenda-draft' });

      /**
       * The agenda being built, with the same shape it will have once saved.
       *
       * Headings and the things under them: an item proposed here is 4.1, and
       * there is no way to make a sixth วาระ, because the committee's minutes
       * only ever have five. Durations belong to the items; a heading shows
       * the sum of what is under it.
       */
      function drawDraftAgenda() {
        clear(agendaDraft);
        var heads = draft.agenda.filter(function (x) { return x.heading; });

        function subsOf(headIndex) {
          return draft.agenda.filter(function (x) { return !x.heading && x.under === headIndex; });
        }

        /** One bar for the whole agenda — the วาระ is picked in it. */
        function addBox(headList) {
          var pick = headList.length ? h('select', { class: 'agenda-under' },
            headList.map(function (x, i) {
              return h('option', { value: String(i), text: (i + 1) + '. ' + x.title });
            })) : null;
          var newTitle = h('input', { type: 'text', placeholder: t('mtgItemTitle') });
          // Deliberately empty: the duration is the proposer's to state.
          var newMins = h('input', { type: 'number', min: '1', max: '600', value: '',
            placeholder: t('mtgMinutesAsk'), style: 'max-width:7rem' });
          var addBtn = h('button', { class: 'btn', text: t('mtgAddItem') });
          var why = h('span', { class: 'hint add-why', hidden: true });
          function add() {
            why.hidden = true;
            if (!newTitle.value.trim()) {
              why.hidden = false; why.textContent = t('errItemTitleRequired');
              newTitle.focus(); return;
            }
            if (!(Number(newMins.value) > 0)) {
              why.hidden = false; why.textContent = t('errMinutesRequired');
              newMins.focus(); return;
            }
            draft.agenda.push({ title: newTitle.value.trim(),
              minutes: Number(newMins.value),
              under: pick ? Number(pick.value) : null, heading: false });
            drawDraftAgenda();
          }
          [newTitle, newMins].forEach(function (el) {
            el.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') { e.preventDefault(); add(); }
            });
          });
          addBtn.addEventListener('click', add);
          return h('div', { class: 'agenda-add one' }, [
            pick ? h('label', { class: 'agenda-under-l' }, [t('mtgUnderWhich'), pick]) : null,
            newTitle, newMins, addBtn, why,
          ].filter(Boolean));
        }

        function row(item, number, depth) {
          return h('div', { class: 'agenda-row d' + depth }, [
            h('span', { class: 't-code', text: number }),
            h('span', { class: 'grow', text: item.title }),
            item.minutes
              ? h('span', { class: 'chip', text: item.minutes + ' ' + t('mtgItemMinutes') })
              : null,
            depth ? h('button', {
              class: 'btn sm danger', text: '\u2715', title: t('mtgRemoveItem'),
              onclick: function () {
                draft.agenda.splice(draft.agenda.indexOf(item), 1);
                drawDraftAgenda();
              },
            }) : null,
          ].filter(Boolean));
        }

        if (heads.length) {
          heads.forEach(function (head, i) {
            var subs = subsOf(i);
            var mins = subs.reduce(function (n, x) { return n + (x.minutes || 0); }, 0);
            agendaDraft.appendChild(row(
              { title: head.title, minutes: mins }, String(i + 1), 0));
            if (!subs.length) {
              agendaDraft.appendChild(h('div', { class: 'agenda-empty', text: t('mtgNoSub') }));
            }
            subs.forEach(function (sub, j) {
              agendaDraft.appendChild(row(sub, (i + 1) + '.' + (j + 1), 1));
            });
          });
          agendaDraft.appendChild(addBox(heads));
        } else {
          draft.agenda.forEach(function (item, i) {
            agendaDraft.appendChild(row(item, String(i + 1), 1));
          });
          agendaDraft.appendChild(addBox([]));
        }

        var total = draft.agenda.reduce(function (n, x) {
          return n + (x.heading ? 0 : (x.minutes || 0));
        }, 0);
        if (total) {
          agendaDraft.appendChild(h('p', { class: 'hint', text: t('mtgLength')
            .replace('%m', String(total))
            .replace('%e', endingAt(draft.meetsAt, total)) }));
        }
      }

      var templateSeg = h('div', { class: 'seg wrap' }, [
        ['standard', 'mtgTemplateStandard'], ['blank', 'mtgTemplateBlank'],
      ].map(function (pair) {
        var b = h('button', {
          type: 'button', class: draft.template === pair[0] ? 'on' : '', text: t(pair[1]),
          onclick: function () {
            draft.template = pair[0];
            [...templateSeg.childNodes].forEach(function (n) { n.className = ''; });
            b.className = 'on';
            draft.agenda = pair[0] === 'standard' ? STANDARD_AGENDA.map(function (x) {
              return { title: x.title, kind: x.kind, minutes: 0, heading: true, under: null };
            }) : [];
            drawDraftAgenda();
          },
        });
        return b;
      }));
      bodyBox.appendChild(h('div', { class: 'pane' }, [
        field(t('mtgTemplate'), templateSeg),
        field(t('mtgAgenda'), agendaDraft),
      ]));
      // Open on the standard agenda, which is the one that was chosen.
      draft.agenda = STANDARD_AGENDA.map(function (x) {
        return { title: x.title, kind: x.kind, minutes: 0, heading: true, under: null };
      });
      drawDraftAgenda();
    }

    // ---- an existing meeting: who is coming, and the agenda ----
    if (!isNew) {
      var whoPane = h('div', { class: 'pane' });
      var mine = meeting.people.filter(function (p) { return p.username === S.user.username; })[0];

      /**
       * Your answer, and only then the means to change it.
       *
       * Both buttons left standing after you had answered made it look as
       * though the click had not registered. Now the answer is stated, and
       * เปลี่ยนคำตอบ brings the buttons back — one deliberate step, so a stray
       * tap on a phone cannot quietly turn a yes into a no.
       */
      if (mine) {
        var rsvp = h('div', { class: 'rsvp' });
        /**
         * The buttons go when the meeting starts, because the answer does.
         *
         * The server stops taking replies the moment a meeting begins (see
         * canReply in lib/meeting.js — an answer afterwards is not an RSVP,
         * it is a claim about attendance). The page did not know that, so it
         * kept offering จะเข้าร่วม on a meeting from last night and answered
         * the press with "เกิดข้อผิดพลาด กรุณาลองใหม่", which is both wrong
         * and the least helpful thing it could have said. Same rule, said
         * plainly, before the press.
         */
        var started = !rsvpStillOpen(meeting);
        var closed = meeting.status !== 'planned' || started;
        var answeredMtg = mine.reply === 'accepted' || mine.reply === 'declined';
        var changing = false;

        function paintRsvp() {
          clear(rsvp);
          if (answeredMtg && !changing) {
            rsvp.appendChild(h('span', { class: 'chip ' + replyClass(mine.reply),
              text: mine.reply === 'accepted' ? t('rsvpYouGoing') : t('rsvpYouNotGoing') }));
            // Once the meeting has begun the answer is whatever it was, so
            // there is nothing to offer beyond saying what it is.
            if (!closed) {
              rsvp.appendChild(h('button', {
                type: 'button', class: 'btn sm', text: t('rsvpChange'),
                onclick: function () { changing = true; paintRsvp(); },
              }));
            } else {
              rsvp.appendChild(h('span', { class: 'hint', text: t('rsvpClosed') }));
            }
            return;
          }

          if (started && meeting.status === 'planned') {
            rsvp.appendChild(h('span', { class: 'hint', text: t('mtgRsvpClosed') }));
            return;
          }

          [['accepted', 'rsvpGoing'], ['declined', 'rsvpNotGoing']].forEach(function (pair) {
            rsvp.appendChild(h('button', {
              type: 'button', disabled: closed,
              class: 'btn sm rsvp-' + pair[0] + (mine.reply === pair[0] ? ' on' : ''),
              text: t(pair[1]),
              onclick: function () {
                api('/api/events?do=reply', {
                  method: 'POST', body: { kind: 'meeting', id: meeting.id, reply: pair[0] },
                }).then(function () {
                  // Answered in place rather than closing the whole dialog —
                  // saying you are coming is no reason to be thrown out of
                  // the agenda you were reading.
                  mine.reply = pair[0];
                  answeredMtg = true;
                  changing = false;
                  paintRsvp();
                  reloadMeetingsQuietly();
                }).catch(function (err) { fail(errText(err.code)); });
              },
            }));
          });
        }
        paintRsvp();
        whoPane.appendChild(rsvp);
      }

      // Everybody, colour-coded, so a glance answers "who is actually coming".
      /**
       * `.selected` is only styled inside a .picker, and this list is not in
       * one — so the chips fell back to baseline alignment and a chip holding
       * a photograph sat higher than one holding initials. Its own class, with
       * its own row layout.
       */
      var replyOf = {};
      meeting.people.forEach(function (p) { replyOf[p.username] = p.reply; });
      whoPane.appendChild(h('div', { class: 'mtg-people' }, [
        peopleList(meeting.people.map(function (p) { return p.username; }),
          function (u) { return replyClass(replyOf[u]); }),
      ]));
      bodyBox.appendChild(whoPane);

      var agendaPane = h('div', { class: 'pane' });
      agendaPane.appendChild(h('h3', { text: t('mtgAgenda') }));
      if (meeting.length && meeting.length.minutes) {
        agendaPane.appendChild(h('p', { class: 'hint', text: t('mtgLength')
          .replace('%m', String(meeting.length.minutes))
          .replace('%e', meeting.length.endsAt || '—') }));
      }

      var canPropose = mine && meeting.status === 'planned';
      // Headings are the standing วาระ from the template — identified by
      // their kind, exactly as the server identifies them. A plain item on a
      // blank agenda is not a heading just because it sits at the top.
      var headings = meeting.agenda.filter(function (x) {
        return x.depth === 0 && x.kind && x.kind !== 'item';
      });

      /**
       * One row per item, nested under its วาระ.
       *
       * A proposal belongs UNDER one of the standing headings — 4.1, not a
       * sixth วาระ, because วาระที่ 6 would be wrong in the minutes. So each
       * heading carries its own "add" control and the add box asks which
       * heading it is for only when there is a choice to make.
       */
      function agendaRow(item) {
        /**
         * How many papers are filed under this วาระ.
         *
         * Shown on the row rather than only in the papers list, because the
         * agenda is what somebody reads while the meeting runs: "4.2 has two
         * documents" is the thing worth knowing at the moment 4.2 comes up,
         * and scrolling back to the list to find out is the friction this
         * whole change exists to remove. It is a link, so it jumps there.
         */
        var papers = (meeting.files || []).filter(function (f) { return f.agendaId === item.id; });
        return h('div', { class: 'agenda-row d' + item.depth }, [
          h('span', { class: 't-code', text: item.number }),
          h('span', { class: 'grow', text: item.title }),
          h('button', {
            type: 'button', class: 'chip paper', title: t('mtgFileSeeThese'),
            dataset: { papersFor: item.id },
            hidden: !papers.length,
            text: '\uD83D\uDCCE ' + papers.length,
            onclick: function () {
              var headings = fileList.querySelectorAll('.mtg-file-head');
              var want = item.number + '. ' + item.title;
              for (var i = 0; i < headings.length; i++) {
                if (headings[i].textContent === want) {
                  headings[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
                  headings[i].classList.add('flash');
                  setTimeout(function (el) { return function () { el.classList.remove('flash'); }; }(headings[i]), 1400);
                  return;
                }
              }
              fileList.scrollIntoView({ behavior: 'smooth', block: 'center' });
            },
          }),
          item.minutes
            ? h('span', { class: 'chip' + (item.hasChildren ? ' sum' : ''),
                text: item.minutes + ' ' + t('mtgItemMinutes') })
            : null,
          item.depth ? h('small', { text: t('mtgProposedBy') + ' ' + nameOf(item.proposedBy) }) : null,
          (item.depth && (item.proposedBy === S.user.username || meeting.mayEdit)) ? h('button', {
            class: 'btn sm danger', text: '✕', title: t('mtgRemoveItem'),
            onclick: function () {
              api('/api/events?do=agenda&id=' + encodeURIComponent(item.id), { method: 'DELETE' })
                .then(function () { veil.remove(); reloadMeetings(); })
                .catch(function (err) { fail(errText(err.code)); });
            },
          }) : null,
        ].filter(Boolean));
      }

      /**
       * One bar, not one per heading.
       *
       * Every standing วาระ carried its own add box, so a meeting with five
       * headings showed five identical rows of "title · minutes · เสนอวาระ"
       * down the page and you had to work out which one you were typing into
       * from how far down it was. There is one bar now, at the end, and the
       * วาระ is the first thing you choose in it.
       */
      function addBox(headings) {
        var pick = headings.length ? h('select', { class: 'agenda-under' },
          headings.map(function (x) {
            return h('option', { value: x.id, text: x.number + '. ' + x.title });
          })) : null;
        var itemTitle = h('input', { type: 'text', placeholder: t('mtgItemTitle') });
        // No default: a made-up ten minutes against every item produces a
        // total nobody chose. The button stays dead until a number is given.
        var itemMins = h('input', { type: 'number', min: '1', max: '600', value: '',
          placeholder: t('mtgMinutesAsk'), style: 'max-width:7rem' });
        /**
         * The button stays alive and SAYS what is missing.
         *
         * It used to disable itself until a duration was typed, which from
         * the other side of the screen looks exactly like a broken page: you
         * type an item, press the button, and nothing happens, with nothing
         * on screen explaining why. A refusal that explains itself is the
         * whole difference.
         */
        var addBtn = h('button', { class: 'btn', text: t('mtgAddItem') });
        var why = h('span', { class: 'hint add-why', hidden: true });
        addBtn.addEventListener('click', function () {
          why.hidden = true;
          if (!itemTitle.value.trim()) {
            why.hidden = false; why.textContent = t('errItemTitleRequired');
            itemTitle.focus(); return;
          }
          if (!(Number(itemMins.value) > 0)) {
            why.hidden = false; why.textContent = t('errMinutesRequired');
            itemMins.focus(); return;
          }
          addBtn.disabled = true;
          api('/api/events?do=agenda', {
            method: 'POST',
            body: { meetingId: meeting.id, title: itemTitle.value.trim(),
                    minutes: Number(itemMins.value), parentId: (pick && pick.value) || null },
          }).then(function () { veil.remove(); reloadMeetings(); })
            .catch(function (err) { addBtn.disabled = false; fail(errText(err.code)); });
        });
        // Enter is how anybody types a list, so it has to work here too.
        [itemTitle, itemMins].forEach(function (el) {
          el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
          });
        });
        return h('div', { class: 'agenda-add one' }, [
          pick ? h('label', { class: 'agenda-under-l' }, [t('mtgUnderWhich'), pick]) : null,
          itemTitle, itemMins, addBtn, why,
        ].filter(Boolean));
      }

      meeting.agenda.forEach(function (item) {
        agendaPane.appendChild(agendaRow(item));
        var isHeading = item.depth === 0 && item.kind && item.kind !== 'item';
        if (!item.hasChildren && isHeading) {
          agendaPane.appendChild(h('div', { class: 'agenda-empty', text: t('mtgNoSub') }));
        }
      });

      if (canPropose) agendaPane.appendChild(addBox(headings));

      /**
       * The papers.
       *
       * Open to anybody invited, not just the organiser: the person holding the
       * budget spreadsheet is usually not the person who called the meeting, and
       * making them email it round is how a meeting ends up with half the room
       * reading a different version.
       *
       * Two ways in, side by side, because they are genuinely different jobs. A
       * link is free and is the right answer when the document already lives in
       * Drive. A file is for the thing on somebody's laptop that is nowhere else
       * yet — and it goes to Drive on the way in, so it does not sit in the
       * database being paid for by the gigabyte.
       */
      var filesPane = h('div', { class: 'pane' }, [h('h3', { text: t('mtgFiles') })]);
      var fileList = h('div', { class: 'mtg-files' });
      var fileNotice = h('div', { class: 'notice err', hidden: true });
      var mayAttach = Boolean(mine) || meeting.mayEdit;

      function fileFail(text) { fileNotice.hidden = false; fileNotice.textContent = text; }

      function sizeText(bytes) {
        if (!bytes) return '';
        return bytes >= 1024 * 1024
          ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
          : Math.round(bytes / 1024) + ' KB';
      }

      /**
       * The วาระ a paper can be filed under, as the picker offers them.
       *
       * Every item, headings included: the minutes of วาระที่ 1 belong to
       * วาระที่ 1, and a paper for 4.2 belongs to 4.2. The number is part of
       * the label because that is how people refer to them out loud.
       */
      function agendaChoices() {
        return (meeting.agenda || []).map(function (x) {
          return { id: x.id, label: x.number + '. ' + x.title, depth: x.depth || 0 };
        });
      }
      function agendaLabel(id) {
        var hit = agendaChoices().filter(function (x) { return x.id === id; })[0];
        return hit ? hit.label : null;
      }
      /** A select of วาระ, with "the whole meeting" first and chosen by default. */
      function agendaSelect(value, cls) {
        var sel = h('select', { class: cls || null }, [
          h('option', { value: '', text: t('mtgFileWholeMeeting') }),
        ].concat(agendaChoices().map(function (x) {
          return h('option', {
            value: x.id,
            // Indented, so a sub-item reads as sitting under its heading.
            text: (x.depth ? '\u00A0\u00A0\u00A0' : '') + x.label,
            selected: value === x.id ? true : null,
          });
        })));
        return sel;
      }

      function drawFiles() {
        clear(fileList);
        if (!(meeting.files || []).length) {
          fileList.appendChild(h('p', { class: 'mtg-file-none', text: t('mtgFilesNone') }));
          return;
        }

        /**
         * Grouped by วาระ, with the meeting's own papers first.
         *
         * A flat list was right while everything belonged to the meeting. Once
         * some papers belong to วาระที่ 4.2, a flat list is the thing it was
         * meant to fix: you are looking for the one document for the item
         * being discussed, and it is somewhere among eleven.
         *
         * A group only appears when it has something in it — an empty heading
         * per วาระ would be longer than the list it organises.
         */
        var groups = [{ id: null, label: t('mtgFileWholeMeeting'), files: [] }];
        agendaChoices().forEach(function (x) {
          groups.push({ id: x.id, label: x.label, depth: x.depth, files: [] });
        });
        var byId = {};
        groups.forEach(function (g) { byId[g.id || ''] = g; });
        meeting.files.forEach(function (f) {
          // A paper whose วาระ was deleted falls back to the meeting rather
          // than disappearing — the column is ON DELETE SET NULL for this.
          (byId[f.agendaId || ''] || groups[0]).files.push(f);
        });

        var shown = groups.filter(function (g) { return g.files.length; });
        /**
         * Headings appear unless the only group is the meeting's own.
         *
         * "More than one group" is not quite the rule: when every paper sits
         * under วาระ 4.1 there is still only one group, and saying nothing
         * leaves the reader unable to tell they are filed at all. The heading
         * is redundant in exactly one case — everything belongs to the
         * meeting, which is what the list meant before any of this existed.
         */
        var manyGroups = shown.length > 1 || (shown.length === 1 && shown[0].id);

        /**
         * The counts on the agenda rows are part of this list, not a separate
         * fact about it — so they are recomputed here rather than only when
         * the dialog is built. Moving a paper to another วาระ changes two
         * places on screen, and one of them going stale is how somebody ends
         * up looking for a document under the wrong heading.
         */
        if (typeof agendaPane !== 'undefined' && agendaPane) {
          agendaPane.querySelectorAll('[data-papers-for]').forEach(function (chip) {
            var n = (meeting.files || []).filter(function (f) {
              return f.agendaId === chip.dataset.papersFor;
            }).length;
            chip.hidden = !n;
            chip.textContent = '\uD83D\uDCCE ' + n;
          });
        }

        shown.forEach(function (g) {
          if (manyGroups) {
            fileList.appendChild(h('div', {
              class: 'mtg-file-head' + (g.id ? '' : ' whole'),
              text: g.label,
            }));
          }
          g.files.forEach(function (f) { drawOneFile(f); });
        });
      }

      function drawOneFile(f) {
          /**
           * A link and a Drive copy open directly; a file still held here is
           * fetched back through this app. `where` says which, so the page
           * never offers an "open" that lands on nothing.
           */
          var open = f.where === 'here'
            ? '/api/events?do=mtgfile&id=' + encodeURIComponent(f.id)
            : f.url;
          var mayDrop = f.addedBy === S.user.username || meeting.mayEdit;

          fileList.appendChild(h('div', { class: 'mtg-file' }, [
            h('span', { class: 'f-kind',
              text: f.where === 'link' ? t('mtgFileKindLink') : (f.kind || 'file') }),
            open
              ? h('a', { class: 'f-name', href: open, target: '_blank', rel: 'noopener',
                  text: f.name })
              : h('span', { class: 'f-name', text: f.name + ' · ' + t('mtgFileGone') }),
            h('span', { class: 'f-meta',
              text: [sizeText(f.size), nameOf(f.addedBy)].filter(Boolean).join(' · ') }),
            /**
             * Re-filing, inline.
             *
             * A committee that has been attaching everything to the meeting
             * has a list to sort out, and the alternative to this control is
             * detaching and re-uploading — which loses a file held here and
             * leaves a second copy in Drive for one that is not.
             */
            (mayDrop && (meeting.agenda || []).length) ? (function () {
              var move = agendaSelect(f.agendaId, 'f-under');
              move.title = t('mtgFileUnderWhich');
              move.addEventListener('change', function () {
                move.disabled = true;
                api('/api/events?do=mtgfile', {
                  method: 'PATCH',
                  body: { id: f.id, agendaId: move.value || null },
                })
                  .then(function () { return reloadMeetingsQuietly(); })
                  .then(function () {
                    var fresh = (S.meetings || []).filter(function (x) { return x.id === meeting.id; })[0];
                    if (fresh) meeting.files = fresh.files;
                    drawFiles();
                  })
                  .catch(function (err) { move.disabled = false; fileFail(errText(err.code)); });
              });
              return move;
            }()) : null,
            mayDrop ? h('button', {
              class: 'btn ghost sm', text: t('mtgFileRemove'),
              onclick: function () {
                if (!confirm(t('mtgFileRemoveSure'))) return;
                api('/api/events?do=mtgfile&id=' + encodeURIComponent(f.id), { method: 'DELETE' })
                  .then(function () { return reloadMeetingsQuietly(); })
                  .then(function () {
                    var fresh = (S.meetings || []).filter(function (x) { return x.id === meeting.id; })[0];
                    if (fresh) meeting.files = fresh.files;
                    drawFiles();
                  })
                  .catch(function (err) { fileFail(errText(err.code)); });
              },
            }) : null,
          ].filter(Boolean)));
      }
      drawFiles();
      filesPane.appendChild(fileNotice);
      filesPane.appendChild(fileList);

      if (mayAttach) {
        var fileIn = h('input', {
          type: 'file', style: 'display:none',
          accept: '.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip',
        });
        var pickBtn = h('button', { class: 'btn sm', text: t('mtgAddFile'),
          onclick: function () { fileIn.click(); } });
        var linkIn = h('input', { type: 'url', placeholder: t('mtgLinkPlaceholder') });

        /**
         * Which วาระ the next paper is for.
         *
         * One picker above both buttons rather than one each, because it is
         * one question — and it defaults to ทั้งการประชุม, which is what
         * every paper was before today and what most of them still should be.
         * Nobody who liked the old behaviour has to do anything differently.
         *
         * Hidden entirely when the agenda is empty: a choice between one
         * thing is not a choice, and an empty dropdown above the attach
         * buttons would just be something else to read.
         */
        var underPick = agendaSelect('', 'mtg-file-under');
        var underRow = h('label', { class: 'mtg-under-row' }, [
          h('span', { text: t('mtgFileUnderWhich') }),
          underPick,
        ]);

        function afterAttach(answer) {
          return reloadMeetingsQuietly().then(function () {
            var fresh = (S.meetings || []).filter(function (x) { return x.id === meeting.id; })[0];
            if (fresh) meeting.files = fresh.files;
            drawFiles();
            /**
             * Said out loud when it happens, not discovered later.
             *
             * An upload that reached the database but not Drive is a thing
             * worth knowing while it is still true — the file works either way,
             * so this is a note rather than an error.
             */
            if (answer && answer.driveProblem) {
              fileNotice.hidden = false;
              fileNotice.textContent = 'Drive: ' + answer.driveProblem;
            }
          });
        }

        fileIn.addEventListener('change', function () {
          var file = fileIn.files && fileIn.files[0];
          if (!file) return;
          fileNotice.hidden = true;
          pickBtn.disabled = true;
          pickBtn.textContent = t('mtgFileSending');
          fileToBase64(file).then(function (base64) {
            return api('/api/events?do=mtgfile', {
              method: 'POST',
              body: {
                meetingId: meeting.id, name: file.name, mime: file.type, file: base64,
                agendaId: underPick.value || null,
              },
            });
          })
            .then(afterAttach)
            .catch(function (err) { fileFail(errText(err.code)); })
            .then(function () {
              pickBtn.disabled = false;
              pickBtn.textContent = t('mtgAddFile');
              fileIn.value = '';
            });
        });

        if ((meeting.agenda || []).length) filesPane.appendChild(underRow);
        filesPane.appendChild(h('div', { class: 'mtg-file-add' }, [
          pickBtn, fileIn,
          linkIn,
          h('button', { class: 'btn sm', text: t('mtgAddLink'),
            onclick: function () {
              if (!linkIn.value.trim()) { fileFail(t('errNothingToAttach')); return; }
              fileNotice.hidden = true;
              api('/api/events?do=mtgfile', {
                method: 'POST',
                body: {
                  meetingId: meeting.id, linkUrl: linkIn.value.trim(),
                  agendaId: underPick.value || null,
                },
              })
                .then(function (answer) { linkIn.value = ''; return afterAttach(answer); })
                .catch(function (err) { fileFail(errText(err.code)); });
            } }),
        ]));
        filesPane.appendChild(h('p', { class: 'hint', text: t('mtgFileLimit') }));
      }
      /**
       * Papers above the agenda, deliberately.
       *
       * The standard agenda is five headings, each with an empty line and its
       * own add box, so it runs to most of a screen before anything else gets a
       * look in — and the papers ended up below all of it. They are reference
       * material somebody opens the meeting to find, like the joining link, not
       * something to scroll past five วาระ to reach.
       */
      bodyBox.appendChild(filesPane);
      bodyBox.appendChild(agendaPane);

      // The form is built either way, but stays out of the page until
      // somebody who may change these details asks for it.
      detailPane.hidden = true;
      bodyBox.appendChild(detailPane);
    }

    /**
     * Editing is a deliberate act, and only for the people who run meetings.
     *
     * `mayEdit` comes from the server, which allows an admin, a co-admin, a
     * secretary, or whoever called the meeting. Everybody else gets the same
     * dialog without this button — and, since the form is never put into the
     * page for them, without a row of greyed-out inputs suggesting they might
     * be one click away from changing the committee's calendar.
     */
    var saveBtn = h('button', {
      class: 'btn primary', text: t('save'), hidden: !isNew,
      onclick: function () {
          if (!draft.title.trim()) { fail(t('mtgTitle')); return; }
          if (!draft.meetsOn) { fail(t('mtgDate')); return; }
          var body = {
            title: draft.title, note: draft.note, meetsOn: draft.meetsOn,
            meetsAt: draft.meetsAt || null, endsAt: draft.endsAt || null, place: draft.place,
            joinUrl: draft.joinUrl, agendaUrl: draft.agendaUrl,
            people: draft.assignees,
            /**
             * The circles the guest list adds up to, sent as well as the names.
             *
             * The names are what the organiser looked at and approved; the
             * circles are what they meant. Only the circles survive as a rule,
             * so somebody who joins the committee next week is on a meeting
             * invited as "ทุกคน" without anybody re-opening it.
             */
            circles: circlesCovered(draft.assignees),
            guests: draft.guests,
            spaceId: draft.spaceId || null,
            notify: draft.notify,
          };
          if (isNew) {
            body.template = 'blank'; body.agenda = draft.agenda;
            if (draft.repeat.freq !== 'none') {
              if (!draft.repeat.count && !draft.repeat.until) { fail(t('repeatNeedsEnd')); return; }
              body.repeat = { freq: draft.repeat.freq, count: draft.repeat.count || undefined, until: draft.repeat.until || undefined };
            }
          }
          else { body.id = meeting.id; body.minutesUrl = draft.minutesUrl; }

          // A meeting with no start time cannot clash with an hour.
          askAboutClashes(
            draft.meetsAt ? { on: draft.meetsOn, at: draft.meetsAt } : null,
            draft.assignees, isNew ? null : meeting.id,
          ).then(function (answer) {
            if (!answer.go) return;
            if (answer.prioritise) body.prioritise = true;

            (isNew || !meeting.seriesId ? Promise.resolve('one') : askSeriesScope(t('seriesEditWhich')))
              .then(function (scope) { body.scope = scope; return api('/api/events?do=meeting', { method: isNew ? 'POST' : 'PATCH', body: body }); })
              .then(function (d) {
                // An address that could not be read is named rather than
                // silently dropped — the meeting saves either way.
                if (d && (d.guestsRejected || []).length) {
                  alert(t('mtgGuestsBad').replace('%s', d.guestsRejected.join(', ')));
                }
                veil.remove(); reloadMeetings();
              })
              .catch(function (err) { fail(errText(err.code)); });
          });
      },
    });

    // Switches the dialog from reading to changing. Shown to nobody else.
    var editBtn = h('button', {
      class: 'btn', text: t('mtgEdit'), hidden: isNew || !mayEdit,
      onclick: function () {
        detailPane.hidden = false;
        summaryPane.hidden = true;
        editBtn.hidden = true;
        saveBtn.hidden = false;
        delBtn.hidden = false;
        detailPane.scrollIntoView({ block: 'nearest' });
      },
    });

    var delBtn = h('button', {
      class: 'btn danger', text: t('mtgDelete'), hidden: true,
      onclick: function () {
        var go = function (scope) {
          return api('/api/events?do=meeting&id=' + encodeURIComponent(meeting.id) + '&scope=' + scope, { method: 'DELETE' });
        };
        var asked = meeting.seriesId ? askSeriesScope(t('seriesDeleteWhich')) : Promise.resolve(confirm(t('mtgDeleteSure')) ? 'one' : null);
        asked.then(function (scope) { return scope ? go(scope).then(function () { return true; }) : false; })
          .then(function (done) { if (done) { veil.remove(); reloadMeetings(); } })
          .catch(function (err) { fail(errText(err.code)); });
      },
    });

    footer.appendChild(editBtn);
    footer.appendChild(saveBtn);
    footer.appendChild(delBtn);
    footer.appendChild(h('button', { class: 'btn', text: t('close'),
      onclick: function () { veil.remove(); } }));

    veil.appendChild(h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h2', { text: isNew ? t('mtgNew') : meeting.title }),
        (!isNew && meeting.code) ? codeChip(meeting.code) : null,
        h('button', { class: 'btn ghost sm', text: '\u2715',
          onclick: function () { veil.remove(); } }),
      ].filter(Boolean)),
      bodyBox, footer,
    ]));
    veil.addEventListener('click', function (e) { if (e.target === veil) veil.remove(); });
    // Every other dialog lives here; appending to <body> put this one outside
    // the container that the Escape key and the phone layout both look at.
    $('modal-root').appendChild(veil);
  }

  /* ---------- announcements (admin / co-admin) --------------------------- */
  function pageAnnounce(main) {
    var notice = h('div', { class: 'notice', hidden: true });

    var draft = {
      title: '',
      body: '',
      level: 'normal',
      audience: { kind: 'everyone', departments: [], people: [], includeAll: false },
      includeSelf: false,
    };

    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('navAnnounce') })]));
    main.appendChild(notice);

    var titleInput = h('input', { type: 'text', maxlength: '120', placeholder: t('announceTitlePlaceholder') });
    var bodyInput = h('textarea', { maxlength: '2000', rows: '4', placeholder: t('announceBodyPlaceholder') });

    /**
     * Who it goes to. Three choices rather than a free-form picker, because
     * the mistake to design against is sending an urgent 2 am alert to 200
     * people when you meant to tell one department something.
     */
    var audienceBox = h('div', { class: 'picker' });
    var countLine = h('p', { class: 'hint' });

    /**
     * Mirrors the server's rule exactly, self-exclusion included — a count
     * that says 8 and then sends to 7 makes everything else on the page look
     * untrustworthy.
     */
    /** Somebody whose access is "ทุกฝ่าย": the board and the secretaries. */
    function boardish(u) { return Boolean(u.allDepartments); }
    /** Ticking an umbrella covers the departments under it, as the server does. */
    function expandDeptKeys(keys) {
      var out = [];
      (keys || []).forEach(function (key) {
        if (out.indexOf(key) === -1) out.push(key);
        (S.departments || []).forEach(function (d) {
          if (d.parent === key && out.indexOf(d.key) === -1) out.push(d.key);
        });
      });
      return out;
    }

    function recipientCount() {
      var live = S.users.filter(function (u) {
        if (!u.active || u.suspended) return false;
        return draft.includeSelf || u.username !== S.user.username;
      });

      if (draft.audience.kind === 'people') {
        return draft.audience.people.filter(function (n) {
          return live.some(function (u) { return u.username === n; });
        }).length;
      }

      if (draft.audience.kind === 'board') return live.filter(boardish).length;

      if (draft.audience.kind === 'departments') {
        var keys = expandDeptKeys(draft.audience.departments);
        if (!keys.length) return 0;
        return live.filter(function (u) {
          // In the department, not merely able to see it — see resolveAudience
          // in api/push.js for why the board is no longer swept in.
          if (draft.audience.includeAll && boardish(u)) return true;
          return (u.departments || []).some(function (k) { return keys.indexOf(k) !== -1; });
        }).length;
      }

      return live.length;
    }

    function paintCount() {
      var n = recipientCount();
      countLine.textContent = t('willReach').replace('{n}', String(n));
      sendBtn.disabled = n === 0 || !titleInput.value.trim();
    }

    function drawAudience() {
      clear(audienceBox);

      var seg = h('div', { class: 'seg wrap' }, [
        ['everyone', t('audEveryone')],
        ['departments', t('audDepartments')],
        ['board', t('audBoard')],
        ['people', t('audPeople')],
      ].map(function (pair) {
        return h('button', {
          type: 'button', class: draft.audience.kind === pair[0] ? 'on' : '', text: pair[1],
          onclick: function () { draft.audience.kind = pair[0]; drawAudience(); paintCount(); },
        });
      }));
      audienceBox.appendChild(seg);

      if (draft.audience.kind === 'departments') {
        var opts = h('div', { class: 'options' });
        S.departments.forEach(function (d) {
          var on = draft.audience.departments.indexOf(d.key) !== -1;
          opts.appendChild(h('div', {
            class: 'opt' + (on ? ' on' : ''),
            onclick: function () {
              draft.audience.departments = on
                ? draft.audience.departments.filter(function (k) { return k !== d.key; })
                : draft.audience.departments.concat([d.key]);
              drawAudience(); paintCount();
            },
          }, [deptOptionLabel(d)]));
        });
        audienceBox.appendChild(opts);

        /**
         * The board is nobody's ฝ่าย, so ticking departments never reaches
         * them — and until this release every department announcement reached
         * them whether or not it was meant to. Off by default, with the count
         * said out loud so it is a decision rather than a surprise.
         */
        var boardN = S.users.filter(function (u) {
          return u.active && !u.suspended && boardish(u) &&
            (draft.includeSelf || u.username !== S.user.username);
        }).length;
        var alsoBoard = h('input', { type: 'checkbox', checked: draft.audience.includeAll });
        alsoBoard.addEventListener('change', function () {
          draft.audience.includeAll = alsoBoard.checked;
          paintCount();
        });
        audienceBox.appendChild(h('label', { class: 'inline-check also-board' }, [
          alsoBoard,
          h('span', {}, [
            t('audAlsoBoard'),
            h('small', { text: t('audAlsoBoardWho').replace('%n', String(boardN)) }),
          ]),
        ]));
      }

      if (draft.audience.kind === 'board') {
        audienceBox.appendChild(h('p', { class: 'hint', text: t('audBoardWho') }));
      }

      if (draft.audience.kind === 'people') {
        audienceBox.appendChild(h('div', { class: 'selected' }, draft.audience.people.length
          ? draft.audience.people.map(function (u) {
              return h('span', {
                class: 'chip who x',
                onclick: function () {
                  draft.audience.people = draft.audience.people.filter(function (x) { return x !== u; });
                  drawAudience(); paintCount();
                },
              }, [avatarNode(u, 'sm'), nameOf(u), ' \u2715']);
            })
          : [h('span', { class: 'chip', text: t('noOne') })]));

        var pick = h('select', {
          onchange: function (e) {
            if (e.target.value && draft.audience.people.indexOf(e.target.value) === -1) {
              draft.audience.people.push(e.target.value);
            }
            drawAudience(); paintCount();
          },
        }, [h('option', { value: '', text: '+ ' + t('addPerson') })].concat(
          groupedPeopleOptions(S.users.filter(function (u) {
            return u.active && !u.suspended && draft.audience.people.indexOf(u.username) === -1;
          }))
        ));
        audienceBox.appendChild(pick);
      }
    }

    var levelSeg = h('div', { class: 'seg wrap' }, [
      ['normal', t('levelNormal')], ['urgent', t('levelUrgent')],
    ].map(function (pair) {
      return h('button', {
        type: 'button',
        class: (draft.level === pair[0] ? 'on ' : '') + (pair[0] === 'urgent' ? 'prio-highest' : ''),
        text: pair[1],
        onclick: function () {
          draft.level = pair[0];
          levelSeg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          this.classList.add('on');
          urgentNote.hidden = draft.level !== 'urgent';
        },
      });
    }));

    var urgentNote = h('p', { class: 'hint urgent-note', hidden: true, text: t('urgentExplained') });

    var sendBtn = h('button', {
      class: 'btn primary', text: t('sendAnnouncement'), disabled: true,
      onclick: function () {
        var payload = {
          title: titleInput.value.trim(),
          body: bodyInput.value.trim(),
          level: draft.level,
          audience: draft.audience,
          includeSelf: draft.includeSelf,
        };
        var n = recipientCount();
        var ask = draft.level === 'urgent'
          ? t('confirmUrgent').replace('{n}', String(n))
          : t('confirmSend').replace('{n}', String(n));
        if (!confirm(ask)) return;

        sendBtn.disabled = true;
        api('/api/push?do=announce', { method: 'POST', body: payload })
          .then(function (d) {
            notice.hidden = false;
            notice.className = 'notice ok';
            notice.textContent = t('sentTo')
              .replace('{n}', String(d.recipients))
              .replace('{p}', String(d.reached));
            titleInput.value = ''; bodyInput.value = '';
            loadSent();
            paintCount();
          })
          .catch(function (err) {
            notice.hidden = false; notice.className = 'notice err';
            notice.textContent = errText(err.code);
            sendBtn.disabled = false;
          });
      },
    });

    titleInput.addEventListener('input', paintCount);

    main.appendChild(h('div', { class: 'modal', style: 'width:min(46rem,100%);margin:0 0 18px' }, [
      h('div', { class: 'body' }, [
        h('div', { class: 'field' }, [h('label', { text: t('announceTitle') }), titleInput]),
        h('div', { class: 'field' }, [h('label', { text: t('announceBody') }), bodyInput]),
        h('div', { class: 'field' }, [h('label', { text: t('audience') }), audienceBox, countLine]),
        h('div', { class: 'field' }, [h('label', { text: t('level') }), levelSeg, urgentNote]),
      ]),
      h('footer', {}, [sendBtn]),
    ]));

    /**
     * The pop-up section goes directly under the announcement form, above the
     * log of what has already been sent.
     *
     * It was below that log, which grows without limit — after a few weeks of
     * announcements the one control for putting a notice in front of the whole
     * committee was several screens down, and Jade could not find it. The two
     * things an admin comes to this page to DO belong together at the top; the
     * record of what was done belongs underneath.
     */
    popupSection(main);

    /* ---- what has been sent, and who has read it ---- */
    var sentBox = h('div', {});
    main.appendChild(h('h2', { class: 'section-head', text: t('recentAnnouncements') }));
    main.appendChild(sentBox);

    function loadSent() {
      api('/api/push?do=sent').then(function (d) {
        S.announcements = d.announcements;
        drawSent();
      }).catch(function () {});
    }

    function drawSent() {
      clear(sentBox);
      if (!S.announcements.length) {
        sentBox.appendChild(h('div', { class: 'empty', text: t('noAnnouncements') }));
        return;
      }
      S.announcements.forEach(function (a) {
        var stat = a.level === 'urgent'
          ? t('ackStat').replace('{a}', String(a.ackCount)).replace('{n}', String(a.recipients))
          : t('readStat').replace('{r}', String(a.readCount)).replace('{n}', String(a.recipients));

        sentBox.appendChild(h('div', { class: 'sent-row' + (a.level === 'urgent' ? ' urgent' : '') }, [
          h('div', { class: 'grow' }, [
            h('b', {}, [
              a.level === 'urgent' ? h('span', { class: 'chip urgent-dot', text: t('urgent') }) : null,
              a.title,
            ]),
            h('div', { class: 'sub', text: a.body }),
            h('small', { text: nameOf(a.sentBy) + ' \u00B7 ' + fmtWhen(a.createdAt) + ' \u00B7 ' + t('pushedTo').replace('{p}', String(a.pushed)) }),
          ]),
          h('div', { class: 'stat' }, [
            h('b', { text: stat }),
            h('button', {
              class: 'btn ghost sm', text: t('whoRead'),
              onclick: function () { openWhoRead(a); },
            }),
          ]),
        ]));
      });
    }

    function openWhoRead(a) {
      api('/api/push?do=who&id=' + encodeURIComponent(a.id)).then(function (d) {
        var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
        var waiting = d.people.filter(function (p) { return a.level === 'urgent' ? !p.acked : !p.read; });
        var done = d.people.filter(function (p) { return a.level === 'urgent' ? p.acked : p.read; });

        veil.appendChild(h('div', { class: 'modal' }, [
          h('header', {}, [
            h('h2', { text: a.title }),
            h('button', { class: 'btn ghost sm', text: '\u2715', onclick: function () { veil.remove(); } }),
          ]),
          h('div', { class: 'body' }, [
            h('div', { class: 'field' }, [
              h('label', { text: t('notYet') + ' (' + waiting.length + ')' }),
              h('div', { class: 'selected' }, waiting.length
                ? waiting.map(function (p) { return h('span', { class: 'chip who' }, [avatarNode(p.username, 'sm'), p.displayName]); })
                : [h('span', { class: 'chip', text: t('everyoneHasSeen') })]),
            ]),
            h('div', { class: 'field' }, [
              h('label', { text: (a.level === 'urgent' ? t('acknowledged') : t('read')) + ' (' + done.length + ')' }),
              h('div', { class: 'selected' }, done.length
                ? done.map(function (p) { return h('span', { class: 'chip who done' }, [avatarNode(p.username, 'sm'), p.displayName]); })
                : [h('span', { class: 'chip', text: '\u2014' })]),
            ]),
          ]),
        ]));
        $('modal-root').appendChild(veil);
      }).catch(function () {});
    }

    drawAudience();
    paintCount();
    loadSent();
  }

  /* ======================================================================
     Push notifications
     ====================================================================== */

  /** The VAPID key arrives base64url-encoded; the browser wants raw bytes. */
  function urlBase64ToUint8Array(base64) {
    var padded = (base64 + '='.repeat((4 - base64.length % 4) % 4))
      .replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(padded);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** True when the app is running from a Home Screen icon rather than a tab. */
  function isStandalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;
    } catch (e) { return false; }
  }

  var isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isMac = /Mac/.test(navigator.platform || '') && !isIos;
  var isChrome = /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent);

  /**
   * Works out what this device can actually do.
   *
   * Reported honestly rather than optimistically: on an iPhone still in a
   * Safari tab, the Push API is simply absent, and telling someone to "allow
   * notifications" when no prompt can ever appear is worse than telling them
   * to add the app to their Home Screen first.
   */
  function pushState() {
    var hasApi = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    S.push.standalone = isStandalone();
    S.push.supported = hasApi;
    S.push.needsInstall = isIos && !S.push.standalone;
    S.push.permission = hasApi ? Notification.permission : 'unsupported';
    return S.push;
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () { return null; });
  }

  /**
   * Compares the key a subscription was created with against the one the
   * server is signing with now.
   *
   * They can drift — the app generated its keys after some browsers had
   * already subscribed, and a subscription made with the wrong key is
   * accepted by the browser and then refused by Apple or Google forever.
   * Catching it here is the difference between silence and a notification.
   */
  function keyMatches(sub, wanted) {
    try {
      var applied = sub.options && sub.options.applicationServerKey;
      if (!applied) return true; // nothing to compare against; assume fine
      var a = new Uint8Array(applied);
      var b = urlBase64ToUint8Array(wanted);
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    } catch (e) { return true; }
  }

  /**
   * Gets this browser a subscription and makes sure the SERVER has it.
   *
   * The server is the authority throughout: the browser having a subscription
   * object proves nothing if the row never arrived, and a panel that says
   * "on" in that state is worse than one that says nothing, because it sends
   * someone off to look for a problem that is not where they think it is.
   */
  function subscribeNow(reg, publicKey) {
    return reg.pushManager.getSubscription()
      .then(function (existing) {
        if (existing && keyMatches(existing, publicKey)) return existing;
        // Stale or mismatched: drop it and start again rather than keep a
        // subscription that can never be delivered to.
        var gone = existing ? existing.unsubscribe().catch(function () {}) : Promise.resolve();
        return gone.then(function () {
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        });
      })
      .then(function (sub) {
        return api('/api/push?do=subscribe', { method: 'POST', body: { subscription: sub.toJSON() } })
          .then(function () { return sub; });
      });
  }

  /** Asks for permission and registers this browser. Must be called from a tap. */
  function enablePush() {
    pushState();
    if (!S.push.supported) return Promise.reject(new Error('UNSUPPORTED'));

    return Notification.requestPermission().then(function (permission) {
      S.push.permission = permission;
      if (permission !== 'granted') throw new Error('DENIED');
      return api('/api/push?do=key');
    }).then(function (info) {
      S.push.key = info.publicKey;
      return registerWorker();
    }).then(function (reg) {
      if (!reg) throw new Error('NO_WORKER');
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return subscribeNow(reg, S.push.key);
    }).then(function () {
      return checkServer();   // only the server's answer sets this to on
    });
  }

  /**
   * Asks the server what it actually holds for this person.
   *
   * This is what the panel reports, rather than what the browser believes.
   */
  function checkServer() {
    return api('/api/push?do=diagnose')
      .then(function (d) {
        S.push.devices = d.devices || [];
        S.push.subscribed = S.push.devices.length > 0;
        S.push.serverKnown = true;
        return S.push.subscribed;
      })
      .catch(function () {
        S.push.serverKnown = false;
        return false;
      });
  }

  function disablePush() {
    return navigator.serviceWorker.ready
      .then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) {
        var endpoint = sub ? sub.endpoint : null;
        var stop = sub ? sub.unsubscribe() : Promise.resolve();
        return stop.then(function () {
          return api('/api/push?do=unsubscribe', { method: 'POST', body: { endpoint: endpoint } });
        });
      })
      .then(function () { S.push.subscribed = false; })
      .catch(function () { S.push.subscribed = false; });
  }

  /**
   * Quietly re-registers on every visit when permission is already granted.
   *
   * Browsers — Safari especially — drop push subscriptions after a spell of
   * inactivity without telling anyone. Without this, notifications would stop
   * one day and nobody would know why.
   */
  function refreshSubscription() {
    pushState();
    if (!S.push.supported || S.push.permission !== 'granted') return Promise.resolve();

    return registerWorker()
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function (reg) {
        return api('/api/push?do=key').then(function (info) {
          S.push.key = info.publicKey;
          return subscribeNow(reg, info.publicKey);
        });
      })
      .then(checkServer)
      .catch(function () {
        // A failed refresh must never block the app loading — but it must not
        // leave the panel claiming everything is fine either.
        S.push.subscribed = false;
      });
  }

  /* ======================================================================
     Notification detail
     ====================================================================== */

  function fmtWhen(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(S.lang === 'th' ? 'th-TH' : 'en-GB',
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
    } catch (e) { return ''; }
  }

  /**
   * The popup behind a notification.
   *
   * Opened from the bell, and from a push the person tapped on their phone.
   * It carries the whole message, because a lock-screen notification truncates
   * anything longer than a line and there has to be somewhere to read the rest.
   */
  function openNotification(id) {
    var n = S.notifs.filter(function (x) { return x.id === id; })[0];
    if (!n) {
      // Arrived from a push before the list had loaded — fetch, then retry once.
      return refreshNotifications().then(function () {
        var found = S.notifs.filter(function (x) { return x.id === id; })[0];
        if (found) openNotification(id);
      });
    }

    var urgent = n.level === 'urgent';
    var task = S.tasks.filter(function (x) { return x.id === n.taskId; })[0];

    var veil = h('div', {
      class: 'veil',
      onclick: function (e) {
        // An urgent message cannot be dismissed by tapping past it: the
        // acknowledge button is the only way out, which is what makes the
        // read receipt on the sender's side mean something.
        if (e.target === veil && !(urgent && !n.acked)) close();
      },
    });

    var modal = h('div', { class: 'modal notice-modal' + (urgent ? ' urgent' : '') }, [
      h('header', {}, [
        h('h2', {}, [
          urgent ? h('span', { class: 'chip urgent-dot', text: t('urgent') }) : null,
          n.title,
        ]),
        (urgent && !n.acked) ? null : h('button', { class: 'btn ghost sm', text: '\u2715', onclick: close }),
      ]),
      h('div', { class: 'body' }, [
        h('p', { class: 'notice-body', text: n.body || '' }),
        h('p', { class: 'hint', text: t('notifKind' + (n.kind === 'announce' ? 'Announce' : 'Task')) + ' \u00B7 ' + fmtWhen(n.createdAt) }),
      ]),
      h('footer', {}, [
        (urgent && !n.acked) ? h('button', {
          class: 'btn primary', text: t('acknowledge'),
          onclick: function () {
            api('/api/notifications?do=ack', { method: 'PATCH', body: { id: n.id } })
              .then(function (d) {
                n.acked = true; n.read = true; S.unread = d.unread;
                renderShell(); close();
              })
              .catch(function () { close(); });
          },
        }) : null,
        task ? h('button', {
          class: 'btn', text: t('openTask'),
          onclick: function () { close(); openTask(task); },
        }) : null,
        h('span', { class: 'grow' }),
        (urgent && !n.acked) ? null : h('button', { class: 'btn', text: t('close'), onclick: close }),
      ]),
    ]);

    veil.appendChild(modal);
    $('modal-root').appendChild(veil);

    // Opening it counts as reading it; acknowledging is the separate, deliberate act.
    if (!n.read) {
      api('/api/notifications', { method: 'PATCH', body: { ids: [n.id] } })
        .then(function (d) { n.read = true; S.unread = d.unread; renderShell(); })
        .catch(function () {});
    }

    function close() { veil.remove(); }
  }

  /** Urgent messages waiting to be acknowledged, shown one after another. */
  function showPending() {
    var waiting = S.notifs.filter(function (n) { return n.level === 'urgent' && !n.acked; });
    if (!waiting.length) return;
    if ($('modal-root').querySelector('.notice-modal')) return; // one at a time
    openNotification(waiting[waiting.length - 1].id);
  }

  /* ======================================================================
     Boot
     ====================================================================== */
  function refreshNotifications() {
    return api('/api/notifications').then(function (d) {
      S.notifs = d.notifications; S.unread = d.unread;
      $('bell-count').hidden = S.unread === 0;
      $('bell-count').textContent = S.unread;
      setBadge(S.unread);
    }).catch(function () {});
  }

  /** The number on the Home Screen icon, where the platform supports one. */
  function setBadge(n) {
    try {
      if (!navigator.setAppBadge) return;
      if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge();
    } catch (e) {}
  }

  /* ---------- getting set up ---------------------------------------------- */

  /**
   * Three things every member should have done, and a guide that keeps asking
   * until they have.
   *
   *   1. The app on the home screen. On an iPhone this is not a nicety: Apple
   *      delivers no notifications at all to a website still in a Safari tab.
   *   2. Notifications on, on this device.
   *   3. Their tasks, events and meetings in Google Calendar, via the feed.
   *
   * It opens by itself whenever someone enters with any of these undone — on
   * their first sign-in and every visit after, until they are — and "later"
   * only puts it off until the next visit. Each step is checked, not assumed:
   * running from the home screen, a push subscription on this browser, and
   * Google actually having fetched the feed.
   */
  /* ---------- what to be told about ------------------------------------ */
  /**
   * Three levels, the same everywhere: แจ้งเตือน (phone alert + bell), เงียบ
   * (the bell only) and ปิด (nothing). A category is set on the profile page;
   * one task, event or document can be set differently from inside it. The
   * server applies these — see lib/notifyprefs.js — so this is only the switch.
   */
  var NOTIFY_LEVELS = [['all', 'notifyAll', 'bell'], ['quiet', 'notifyQuiet', 'bellQuiet'], ['off', 'notifyOff', 'bellOff']];
  var NOTIFY_CATEGORIES = ['task_named', 'task_dept', 'task_reminder', 'task_work', 'task_watch', 'event', 'document', 'announce'];

  function loadNotify() {
    return api('/api/users?do=notify').then(function (d) { S.notify = d; return d; })
      .catch(function () { return null; });
  }

  function setNotify(scope, id, level) {
    return api('/api/users?do=notify', { method: 'POST', body: { scope: scope, id: id || '', level: level || null } })
      .then(function (d) { S.notify = d; return d; });
  }

  function itemLevel(scope, id) {
    var hit = ((S.notify && S.notify.items) || []).filter(function (x) { return x.scope === scope && x.id === id; })[0];
    return hit ? hit.level : '';
  }

  function categoryLevel(cat) {
    return (S.notify && S.notify.categories && S.notify.categories[cat]) || (cat === 'task_watch' ? 'quiet' : 'all');
  }

  /** Which category a task's messages fall under, for this person. */
  function taskCategory(task) {
    var r = task.myRole;
    if (r === 'dept') return 'task_dept';
    if (r === 'watch') return 'task_watch';
    if (!r && task.createdBy === S.user.username) return 'task_work';
    return 'task_named';
  }

  /**
   * The switch inside a task, event or document: "as my settings say" first,
   * naming what that currently means, then the three levels.
   */
  function notifyControl(scope, id, category) {
    var box = h('div', { class: 'notify-ctl' });
    function draw() {
      clear(box);
      var current = itemLevel(scope, id);
      var choices = [['', t('notifyDefault') + ' · ' + t(NOTIFY_LEVELS.filter(function (l) {
        return l[0] === categoryLevel(category);
      })[0][1]), null]].concat(NOTIFY_LEVELS);
      box.appendChild(h('div', { class: 'seg wrap notify-seg' }, choices.map(function (c) {
        return h('button', {
          type: 'button', class: current === c[0] ? 'on' : '', 'data-level': c[0] || 'default',
          onclick: function () {
            if (current === c[0]) return;
            setNotify(scope, id, c[0]).then(draw).catch(function (err) { alert(errText(err.code)); });
          },
        }, [c[2] ? icon(c[2]) : null, h('span', { text: c[0] ? t(c[1]) : c[1] })]);
      })));
    }
    if (S.notify) draw(); else loadNotify().then(draw);
    return box;
  }

  /** The notifications section of the profile page. */
  function notifyBox() {
    var box = h('div', { class: 'notify-box' });
    function draw() {
      clear(box);
      if (!S.notify) { box.appendChild(h('p', { class: 'hint', text: t('loading') })); return; }
      box.appendChild(h('p', { class: 'hint notify-help', text: t('notifyHelp') }));
      // On a phone the buttons are icons only, so the key comes first.
      box.appendChild(h('div', { class: 'notify-legend' }, NOTIFY_LEVELS.map(function (l) {
        return h('span', { class: 'lv-' + l[0] }, [icon(l[2]), h('b', { text: t(l[1]) }), h('small', { text: t(l[1] + 'Means') })]);
      })));
      box.appendChild(h('div', { class: 'notify-cats' }, NOTIFY_CATEGORIES.map(function (cat) {
        var level = categoryLevel(cat);
        var now = NOTIFY_LEVELS.filter(function (l) { return l[0] === level; })[0];
        return h('div', { class: 'notify-cat', 'data-cat': cat }, [
          h('div', { class: 'nc-text' }, [
            h('b', {}, [t('notifyCat_' + cat), h('span', { class: 'nc-now lv-' + level, text: t(now[1]) })]),
            h('small', { text: t('notifyCatSub_' + cat) }),
          ]),
          h('div', { class: 'seg notify-seg' }, NOTIFY_LEVELS.map(function (l) {
            return h('button', {
              type: 'button', class: level === l[0] ? 'on' : '', 'data-level': l[0], title: t(l[1]),
              onclick: function () {
                if (level === l[0]) return;
                setNotify(cat, '', l[0]).then(draw).catch(function (err) { alert(errText(err.code)); });
              },
            }, [icon(l[2]), h('span', { text: t(l[1]) })]);
          })),
        ]);
      })));


      // One-off settings on single tasks, events and documents.
      var items = S.notify.items || [];
      box.appendChild(h('div', { class: 'notify-items' }, [
        h('b', { text: t('notifyItemsTitle') }),
        items.length ? h('ul', {}, items.map(function (it) {
          var lv = NOTIFY_LEVELS.filter(function (l) { return l[0] === it.level; })[0];
          return h('li', {}, [
            h('span', { class: 'ni-kind', text: t('notifyScope_' + it.scope) }),
            h('span', { class: 'ni-title' }, [it.code ? h('span', { class: 't-code', text: it.code }) : null, it.title]),
            h('span', { class: 'ni-level lv-' + it.level }, [icon(lv[2]), t(lv[1])]),
            h('button', {
              type: 'button', class: 'btn ghost sm', title: t('notifyReset'), text: '✕',
              onclick: function () { setNotify(it.scope, it.id, null).then(draw); },
            }),
          ]);
        })) : h('p', { class: 'hint', text: t('notifyItemsEmpty') }),
      ]));
    }
    draw();
    loadNotify().then(draw);
    return box;
  }

  var GUIDE_LATER = 'fair-guide-later';

  window.addEventListener('beforeinstallprompt', function (e) {
    // Chrome's own install bar is replaced by the button in the guide, which
    // says what installing is for.
    e.preventDefault();
    S.installPrompt = e;
  });
  window.addEventListener('appinstalled', function () {
    try { localStorage.setItem('fair-guide-installed', '1'); } catch (e) {}
    S.installPrompt = null;
  });

  var ua = navigator.userAgent || '';
  var isAndroid = /Android/i.test(ua);
  // LINE, Facebook and Instagram open links in a browser of their own, which
  // can neither install an app nor receive notifications.
  var inAppBrowser = /\bLine\/|FBAN|FBAV|Instagram/i.test(ua);

  function localFlag(key) { try { return localStorage.getItem(key) === '1'; } catch (e) { return false; } }

  /** Does this browser itself hold a push subscription? Not "does the account". */
  function deviceSubscribed() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);
    return navigator.serviceWorker.getRegistration().then(function (reg) {
      return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
    }).then(function (sub) { return Boolean(sub); }).catch(function () { return false; });
  }

  /**
   * Which steps are still to do, in order, each with whether it is done.
   *
   * Installing is only a step on a phone or tablet — "home screen" means
   * nothing on a laptop, and asking would be noise.
   */
  function guideStatus() {
    pushState();
    var touch = isPhone() || isIos || isAndroid;
    var calendarClaimed = (function () {
      try { return Number(localStorage.getItem('fair-guide-cal-claimed') || 0) > Date.now() - 3 * 864e5; }
      catch (e) { return false; }
    }());
    /**
     * LINE is where this committee actually talks, so adding the fair's
     * account is the step that makes every reminder arrive somewhere people
     * already look. It is only offered when LINE is set up on the server.
     */
    var lineState = api('/api/line?do=status').catch(function () { return { configured: false }; });
    return Promise.all([deviceSubscribed(), lineState]).then(function (res) {
      var subscribed = res[0];
      var line = res[1] || {};
      S.lineOa = line.oa || null;
      var steps = [];
      if (touch) {
        steps.push({ key: 'install', done: S.push.standalone || localFlag('fair-guide-installed') });
      }
      if (line.configured) {
        steps.push({ key: 'line', done: Boolean(line.linked) });
      }
      if (S.push.supported || S.push.needsInstall) {
        steps.push({ key: 'notify', done: S.push.permission === 'granted' && subscribed });
      }
      steps.push({ key: 'calendar', done: Boolean(S.user && S.user.calendarSeenAt) || calendarClaimed });
      return steps;
    });
  }

  /**
   * Opens by itself once the page has settled — never on top of an urgent
   * announcement or a task somebody followed a link to, which are what they
   * came for. It waits for those to be closed rather than giving up.
   */
  function maybeShowGuide() {
    try { if (sessionStorage.getItem(GUIDE_LATER) === '1') return; } catch (e) {}
    var tries = 0;
    (function attempt() {
      tries += 1;
      if (!S.user || tries > 40) return;
      if (document.querySelector('#modal-root .veil')) { setTimeout(attempt, 1500); return; }
      guideStatus().then(function (steps) {
        if (steps.some(function (x) { return !x.done; })) openGuide(steps, false);
      });
    }());
  }

  function guideIcon(name) {
    var paths = {
      install: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M12 7v7M9 11l3 3 3-3M10 18.5h4"/>',
      notify: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
      calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4M8 13.5h3M8 17h6"/>',
      share: '<path d="M12 3v11M8 7l4-4 4 4"/><path d="M6 11v8.5h12V11"/>',
      plus: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
      dots: '<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
      check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
      line: '<path d="M21 10.2c0-4-4-7.2-9-7.2s-9 3.2-9 7.2c0 3.6 3.2 6.6 7.5 7.1.3.1.7.2.8.5.1.3 0 .8 0 1.1l-.1.9c0 .3-.2 1 .9.6s5.9-3.5 8-6c1.3-1.4 1.9-2.9 1.9-4.2z"/><path d="M8 8.5v3.4M8 8.5h-.1M11 11.9V8.5l2.4 3.4V8.5M16 8.5h2M16 8.5v3.4h2M16 10.2h1.7"/>',
    };
    var span = document.createElement('span');
    span.className = 'gd-ic';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24">' + (paths[name] || '') + '</svg>';
    return span;
  }

  /** A numbered instruction, with the icon somebody is looking for on screen. */
  function gStep(n, textKey, iconName) {
    return h('li', { class: 'gd-li' }, [
      h('span', { class: 'gd-n', text: String(n) }),
      h('span', { class: 'gd-tx', text: t(textKey) }),
      iconName ? guideIcon(iconName) : null,
    ]);
  }

  /**
   * The guide. `all` is true when opened from the menu, which shows every step
   * — done ones too, ticked — so it can be used to check, not only to nag.
   */
  function openGuide(steps, all) {
    var existing = document.querySelector('#modal-root .guide-modal');
    if (existing) existing.closest('.veil').remove();

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) later(); } });
    var body = h('div', { class: 'body' });
    var footer = h('footer', {});
    var current = null;

    function later() {
      // Put off until the next visit, not for ever — she asked for anybody who
      // has not done these to be reminded each time they come in.
      if (!all) { try { sessionStorage.setItem(GUIDE_LATER, '1'); } catch (e) {} }
      veil.remove();
    }

    function refresh() {
      return guideStatus().then(function (fresh) { steps = fresh; draw(); });
    }

    function draw() {
      clear(body); clear(footer);
      var todo = steps.filter(function (x) { return !x.done; });
      current = todo[0] || null;

      // The checklist: what is done and what is left, at a glance.
      body.appendChild(h('ol', { class: 'gd-list' }, steps.map(function (x) {
        return h('li', { class: 'gd-item' + (x.done ? ' done' : '') + (x === current ? ' now' : '') }, [
          x.done ? guideIcon('check') : h('span', { class: 'gd-dot' }),
          h('span', { text: t('guideStep_' + x.key) }),
        ]);
      })));

      if (!current) {
        body.appendChild(h('div', { class: 'gd-card done' }, [
          guideIcon('check'),
          h('b', { text: t('guideAllDone') }),
          h('p', { text: t('guideAllDoneSub') }),
        ]));
        footer.appendChild(h('button', { class: 'btn primary', text: t('phDone'), onclick: function () { veil.remove(); } }));
        return;
      }

      var card = h('div', { class: 'gd-card' }, [
        guideIcon(current.key),
        h('b', { text: t('guideTitle_' + current.key) }),
        h('p', { text: t('guideWhy_' + current.key) }),
      ]);
      body.appendChild(card);
      var say = h('div', { class: 'notice', hidden: true });
      body.appendChild(say);
      var tell = function (kind, key) { say.hidden = false; say.className = 'notice ' + kind; say.textContent = t(key); };

      footer.appendChild(h('button', { class: 'btn', text: t('guideLater'), onclick: later }));

      if (current.key === 'install') {
        if (inAppBrowser) {
          card.appendChild(h('ol', { class: 'gd-steps' }, [
            gStep(1, 'guideInApp1', 'dots'), gStep(2, 'guideInApp2'), gStep(3, 'guideInApp3'),
          ]));
        } else if (isIos) {
          card.appendChild(h('ol', { class: 'gd-steps' }, [
            gStep(1, 'guideIos1', 'share'), gStep(2, 'guideIos2', 'plus'),
            gStep(3, 'guideIos3'), gStep(4, 'guideIos4'),
          ]));
        } else if (S.installPrompt) {
          card.appendChild(h('p', { class: 'hint', text: t('guideAndroidOneTap') }));
          footer.appendChild(h('button', {
            class: 'btn primary', text: t('guideInstallNow'),
            onclick: function () {
              var prompt = S.installPrompt;
              prompt.prompt();
              prompt.userChoice.then(function (choice) {
                if (choice && choice.outcome === 'accepted') {
                  try { localStorage.setItem('fair-guide-installed', '1'); } catch (e) {}
                  S.installPrompt = null;
                  refresh();
                }
              });
            },
          }));
        } else {
          card.appendChild(h('ol', { class: 'gd-steps' }, [
            gStep(1, 'guideAndroid1', 'dots'), gStep(2, 'guideAndroid2'), gStep(3, 'guideAndroid3'),
          ]));
        }
        if (!S.installPrompt) {
          footer.appendChild(h('button', {
            class: 'btn primary', text: t('guideInstalled'),
            onclick: function () {
              try { localStorage.setItem('fair-guide-installed', '1'); } catch (e) {}
              refresh();
            },
          }));
        }
        return;
      }

      if (current.key === 'line') {
        var oa = S.lineOa || {};
        card.appendChild(h('ol', { class: 'gd-steps' }, [
          gStep(1, 'guideLine1', 'line'), gStep(2, 'guideLine2'), gStep(3, 'guideLine3'),
        ]));
        if (oa.basicId) {
          card.appendChild(h('div', { class: 'gd-oa' }, [
            // The LINE QR, drawn by LINE itself, so it is always the right one.
            h('img', { class: 'gd-qr', alt: '',
              src: 'https://qr-official.line.me/gs/M_' + encodeURIComponent(String(oa.basicId).replace(/^@/, '')) + '_GW.png' }),
            h('div', {}, [
              h('b', { text: oa.displayName || t('guideStep_line') }),
              h('div', { class: 'line-code', text: oa.basicId }),
            ]),
          ]));
          footer.appendChild(h('a', {
            class: 'btn primary', target: '_blank', rel: 'noopener',
            href: oa.addUrl, text: t('guideLineAdd'),
          }));
        }
        footer.appendChild(h('button', {
          class: 'btn' + (oa.basicId ? '' : ' primary'), text: t('guideLineCode'),
          onclick: function (e) {
            e.target.disabled = true;
            api('/api/line?do=code', { method: 'POST' }).then(function (d) {
              clear(say); say.hidden = false; say.className = 'notice';
              say.appendChild(h('div', { text: t('lineCodeSteps') }));
              say.appendChild(h('div', { class: 'line-code', text: d.code }));
              say.appendChild(h('div', { class: 'hint', text: t('lineCodeExpires').replace('{n}', String(d.minutes)) }));
              e.target.disabled = false;
            }).catch(function (err) { e.target.disabled = false; tell('err', 'errOffline'); });
          },
        }));
        footer.appendChild(h('button', { class: 'btn', text: t('guideCheckAgain'), onclick: refresh }));
        return;
      }

      if (current.key === 'notify') {
        pushState();
        if (S.push.needsInstall) {
          // An iPhone in a Safari tab: there is no permission to ask for.
          card.appendChild(h('div', { class: 'notice warn', text: t('guideNotifyNeedsInstall') }));
          return;
        }
        if (S.push.permission === 'denied') {
          card.appendChild(h('div', { class: 'notice warn', text: t('guideNotifyBlocked') }));
          card.appendChild(h('ol', { class: 'gd-steps' }, isIos
            ? [gStep(1, 'guideUnblockIos1'), gStep(2, 'guideUnblockIos2'), gStep(3, 'guideUnblockIos3')]
            : [gStep(1, 'guideUnblock1'), gStep(2, 'guideUnblock2'), gStep(3, 'guideUnblock3')]));
          footer.appendChild(h('button', { class: 'btn primary', text: t('guideCheckAgain'), onclick: refresh }));
          return;
        }
        card.appendChild(h('p', { class: 'hint', text: t('guideNotifyHow') }));
        footer.appendChild(h('button', {
          class: 'btn primary', text: t('turnOn'),
          onclick: function (e) {
            e.target.disabled = true;
            enablePush().then(refresh).catch(function (err) {
              e.target.disabled = false;
              tell('err', err && err.message === 'DENIED' ? 'pushBlocked' : 'pushFailed');
            });
          },
        }));
        return;
      }

      // ---- Google Calendar ----
      var start = function () {
        if (S.user.calendarToken) return Promise.resolve();
        return api('/api/users?do=calendar-token', { method: 'POST' })
          .then(function (d) { S.user.calendarToken = d.calendarToken; });
      };
      var feed = function () { return location.origin + '/api/calendar?token=' + S.user.calendarToken + '&scope=mine'; };

      card.appendChild(h('ol', { class: 'gd-steps' }, [
        gStep(1, 'guideCal1'), gStep(2, 'guideCal2'), gStep(3, 'guideCal3'),
      ]));
      if (isPhone()) card.appendChild(h('p', { class: 'hint', text: t('guideCalPhone') }));

      var actions = h('div', { class: 'gd-actions' });
      card.appendChild(actions);
      function paintActions() {
        clear(actions);
        if (!S.user.calendarToken) {
          actions.appendChild(h('button', {
            class: 'btn primary', text: t('guideCalMake'),
            onclick: function (e) { e.target.disabled = true; start().then(paintActions); },
          }));
          return;
        }
        actions.appendChild(h('a', {
          class: 'btn primary', target: '_blank', rel: 'noopener',
          href: 'https://calendar.google.com/calendar/u/0/r/settings/addbyurl?cid=' + encodeURIComponent(feed()),
          text: t('guideCalOpen'),
        }));
        actions.appendChild(h('button', {
          class: 'btn', text: t('copyLink'),
          onclick: function (e) {
            var btn = e.target;
            var done = function () { btn.textContent = t('copied'); setTimeout(function () { btn.textContent = t('copyLink'); }, 1600); };
            if (navigator.clipboard) navigator.clipboard.writeText(feed()).then(done, done); else done();
          },
        }));
        // On an iPhone its own Calendar app subscribes in one tap, which is
        // the next best thing when Google sends a phone off to a computer.
        if (isIos) {
          actions.appendChild(h('a', {
            class: 'btn ghost', href: feed().replace(/^https?:/, 'webcal:'), text: t('guideCalIphone'),
          }));
        }
      }
      paintActions();

      footer.appendChild(h('button', {
        class: 'btn primary', text: t('guideCalDone'),
        onclick: function (e) {
          e.target.disabled = true;
          // Google fetches a feed the moment it is added, so this usually
          // already knows. If not yet, it takes their word for three days and
          // asks again after that.
          api('/api/auth').then(function (d) {
            if (d.user) S.user.calendarSeenAt = d.user.calendarSeenAt;
            if (!S.user.calendarSeenAt) {
              try { localStorage.setItem('fair-guide-cal-claimed', String(Date.now())); } catch (x) {}
              tell('warn', 'guideCalNotYet');
            }
            setTimeout(refresh, S.user.calendarSeenAt ? 0 : 1800);
          }).catch(function () { e.target.disabled = false; });
        },
      }));
    }

    draw();
    veil.appendChild(h('div', { class: 'modal guide-modal' }, [
      h('header', {}, [
        h('h2', { text: t('guideHeading') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: later }),
      ]),
      body, footer,
    ]));
    $('modal-root').appendChild(veil);
  }


  /* ======================================================================
     The 2026-10 redesign: list, timeline, home, schedule, spaces.
     ====================================================================== */

  /* ---------- drawing ----------------------------------------------------- */

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, kids) {
    var node = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(kid); });
    return node;
  }
  var STATUS_HEX = { todo: '#8b8fa0', doing: '#2f7ff0', review: '#f0a020', feedback: '#8b5cf6', done: '#12a36b' };
  var CHART = ['#e0457b', '#5b5bd6', '#0fa5a0', '#f59e0b', '#8b5cf6'];

  /** A ring of coloured arcs. `parts` is [{ value, colour, label }]. */
  function donut(parts, opts) {
    opts = opts || {};
    var size = opts.size || 140;
    var stroke = opts.stroke || 18;
    var r = (size - stroke) / 2;
    var c = 2 * Math.PI * r;
    var total = parts.reduce(function (a, p) { return a + p.value; }, 0);
    var g = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size, class: 'donut', role: 'img',
      'aria-label': opts.label || '' });
    g.appendChild(svgEl('circle', { cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': stroke }));
    var at = 0;
    parts.forEach(function (p) {
      if (!total || !p.value) return;
      var len = (p.value / total) * c;
      g.appendChild(svgEl('circle', {
        cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: p.colour, 'stroke-width': stroke,
        'stroke-dasharray': Math.max(0, len - 2) + ' ' + (c - Math.max(0, len - 2)),
        'stroke-dashoffset': String(-at), transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
        'stroke-linecap': 'butt',
      }));
      at += len;
    });
    if (opts.center !== undefined) {
      var t1 = svgEl('text', { x: size / 2, y: size / 2 + (opts.sub ? -2 : 6), 'text-anchor': 'middle', class: 'donut-big' });
      t1.textContent = String(opts.center);
      g.appendChild(t1);
      if (opts.sub) {
        var t2 = svgEl('text', { x: size / 2, y: size / 2 + 16, 'text-anchor': 'middle', class: 'donut-sub' });
        t2.textContent = opts.sub;
        g.appendChild(t2);
      }
    }
    return g;
  }

  /** Vertical bars with labels underneath. */
  function barChart(values, labels, opts) {
    opts = opts || {};
    var w = opts.width || 320;
    var hgt = opts.height || 140;
    var pad = 22;
    var max = Math.max.apply(null, values.concat([1]));
    var bw = (w - 8) / values.length;
    var g = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + hgt, class: 'bars', preserveAspectRatio: 'none', role: 'img', 'aria-label': opts.label || '' });
    values.forEach(function (v, i) {
      var bh = Math.round(((hgt - pad - 14) * v) / max);
      var x = 4 + i * bw + bw * 0.18;
      var y = hgt - pad - bh;
      var hi = opts.highlight === i;
      g.appendChild(svgEl('rect', { x: x, y: y, width: bw * 0.64, height: Math.max(bh, v ? 3 : 1.5), rx: 5,
        fill: hi ? (opts.hiColour || '#e0457b') : (opts.colour || 'color-mix(in srgb, #e0457b 35%, transparent)') }));
      if (v) {
        var tv = svgEl('text', { x: x + bw * 0.32, y: y - 4, 'text-anchor': 'middle', class: 'bar-val' });
        tv.textContent = String(v);
        g.appendChild(tv);
      }
      var tl = svgEl('text', { x: x + bw * 0.32, y: hgt - 6, 'text-anchor': 'middle', class: 'bar-lab' + (hi ? ' hi' : '') });
      tl.textContent = labels[i];
      g.appendChild(tl);
    });
    return g;
  }

  function statusPill(st) { return h('span', { class: 'st-pill', dataset: { st: st }, text: statusLabel(st) }); }

  /* ---------- the list, ClickUp style ------------------------------------ */

  /** A flag in the priority's colour, or nothing for an ordinary one. */
  function prioFlag(prio) {
    if (!prio || prio === 'medium') return null;
    return h('span', { class: 'prio-flag p-' + prio, title: prioLabel(prio) }, [icon('flag'), h('span', { text: prioLabel(prio) })]);
  }
  function dueChip(task) {
    if (!task.dueDate) return h('span', { class: 'due-chip none', text: '—' });
    var rel = relativeDay(task.dueDate);
    return h('span', { class: 'due-chip u-' + urgencyOf(task), title: whenWording(task.dueDate, task.dueTime) },
      [(isOverdue(task) ? t('overdue') + ' · ' : '') + (rel || fmtDate(task.dueDate)) + (task.dueTime ? ' ' + task.dueTime : '')]);
  }
  function whereChip(task) {
    var sp = task.spaceId ? spaceBy(task.spaceId) : null;
    if (sp) return h('span', { class: 'where-chip', style: '--sp:' + spaceHex(sp) }, [h('i'), sp.name]);
    var dept = task.department || (task.departments[0] && task.departments[0].key);
    if (dept) return h('span', { class: 'where-chip dept', style: '--sp:' + deptHue(dept) }, [h('i'), deptLabel(dept)]);
    return h('span', { class: 'where-chip none', text: '' });
  }

  /**
   * One task as a slim row: status, title, then columns for who, when,
   * priority and where. The whole row opens the task; the round button on
   * the left changes the status, as it does on the board.
   */
  function listRow(task) {
    var extra = [];
    var parts = task.parts || [];
    if (parts.length) {
      var done = parts.filter(function (p) { return p.done; }).length;
      extra.push(h('span', { class: 'mini parts' + (done === parts.length ? ' done' : ''), text: '✓ ' + done + '/' + parts.length }));
    }
    if ((task.links || []).length) extra.push(h('span', { class: 'mini', text: '↗ ' + task.links.length }));
    if ((task.viewers || []).length && task.mayEdit) {
      extra.push(h('span', { class: 'mini chip viewers-n', title: t('viewers') }, [icon('eye'), String(task.viewers.length)]));
    }
    var beaten = outrankedNote(task);
    if (beaten) extra.push(beaten);

    var stack = h('span', { class: 'stack' }, task.assignees.slice(0, 3).map(function (u) { return avatarNode(u, 'sm'); }));
    if (task.assignees.length > 3) stack.appendChild(h('span', { class: 'avatar sm more', text: '+' + (task.assignees.length - 3) }));

    return h('li', {
      class: 'task lrow' + (task.pending ? ' pending' : ''),
      dataset: { status: task.status, st: task.status, prio: task.priority || 'medium', urgency: urgencyOf(task) },
      onclick: function () { openTask(task); },
    }, [
      h('button', {
        class: 'status-btn' + (task.maySetStatus ? '' : ' locked'),
        text: MARK[task.status],
        title: statusLabel(task.status) + (task.maySetStatus ? '' : ' · ' + t('statusLocked')),
        onclick: function (e) {
          e.stopPropagation();
          if (!task.maySetStatus) return;
          if (isPhone()) openStatusSheet(task);
          else openStatusMenu(e.currentTarget, task);
        },
      }),
      h('div', { class: 't-title' }, [
        // What it is to me leads, as on the board (see roleBadge).
        isPhone() ? null : roleBadge(task),
        task.code ? h('span', { class: 't-code', text: task.code }) : null,
        h('span', { class: 't-name', text: task.title }),
        extra.length ? h('span', { class: 'lr-extra' }, extra) : null,
        task.myPart ? h('div', {
          class: 'my-part' + (task.myPart.done ? ' done' : ''),
          text: (task.myPart.done ? '✓ ' : '▸ ') + t('yourPart') + ': ' + task.myPart.title,
        }) : null,
      ]),
      h('div', { class: 'lr-due' }, [dueChip(task)]),
      // One box on a phone (a single line under the title); on a computer
      // display:contents lets each part sit in its own column.
      h('div', { class: 'lr-meta' }, [
        isPhone() ? roleBadge(task) : null,
        h('div', { class: 'lr-who' }, [stack]),
        h('div', { class: 'lr-prio' }, [prioFlag(task.priority)]),
        h('div', { class: 'lr-where' }, [whereChip(task)]),
      ]),
    ]);
  }

  /**
   * The list, in groups by status, each under a header in its colour with
   * a count — so "how much is waiting for review" is answered by looking,
   * not by counting. A group folds on a click, and stays folded.
   */
  function groupedList(rows) {
    S.groupFold = S.groupFold || {};
    var box = h('div', { class: 'glist' });
    if (!isPhone()) {
      box.appendChild(h('div', { class: 'glist-head' }, [
        h('span', { class: 'gh-name', text: t('colTask') }),
        h('span', { class: 'gh-who', text: t('colWho') }),
        h('span', { class: 'gh-due', text: t('colDue') }),
        h('span', { class: 'gh-prio', text: t('colPrio') }),
        h('span', { class: 'gh-where', text: t('colWhere') }),
      ]));
    }
    STATUS_LIST.forEach(function (st) {
      var items = rows.filter(function (r) { return r.status === st; });
      if (!items.length) return;
      var folded = Boolean(S.groupFold[st]);
      var group = h('section', { class: 'lgroup' + (folded ? ' folded' : ''), dataset: { st: st } });
      group.appendChild(h('button', { type: 'button', class: 'lg-head', onclick: function () {
        S.groupFold[st] = !S.groupFold[st];
        group.classList.toggle('folded', S.groupFold[st]);
      } }, [
        h('i', { class: 'lg-caret', text: '▾' }),
        statusPill(st),
        h('span', { class: 'lg-n', text: String(items.length) }),
      ]));
      group.appendChild(h('ul', { class: 'tasks list-view' }, items.map(function (task) { return listRow(task); })));
      box.appendChild(group);
    });
    return box;
  }

  /* ---------- the timeline (Gantt) --------------------------------------- */

  /**
   * Every task as a bar from its start to its deadline, coloured by status,
   * against a ruler of days with today marked. A task with no start is a
   * diamond on its deadline; one with no deadline is left off and counted.
   *
   * On a computer a bar can be dragged to move the task, or its right end
   * dragged to move the deadline, when you may edit it. Scrolls sideways on
   * a phone; the names stay pinned on the left.
   */
  function ganttChart(rows, opts) {
    opts = opts || {};
    var phone = Boolean(opts.phone);
    var zoom = S.ganttZoom || 'week';
    var DAY = zoom === 'month' ? (phone ? 14 : 18) : (phone ? 30 : 40);
    var showDone = Boolean(S.ganttDone);
    var group = S.ganttGroup || 'status';

    var dated = rows.filter(function (x) { return x.dueDate && (showDone || x.status !== 'done'); });
    var undated = rows.filter(function (x) { return !x.dueDate && (showDone || x.status !== 'done'); }).length;
    var today = todayIso();

    // The ruler: from a few days before the earliest start (or today) to after the last deadline.
    var first = today;
    var last = addDays(today, 21);
    dated.forEach(function (x) {
      var s = x.startDate && x.startDate <= x.dueDate ? x.startDate : x.dueDate;
      if (s < first) first = s;
      if (x.dueDate > last) last = x.dueDate;
    });
    first = addDays(first, -3);
    last = addDays(last, 5);
    // Start the ruler on a Monday so the week lines fall on week boundaries.
    var wd = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
    first = addDays(first, -wd);
    var days = [];
    for (var d = first; d <= last && days.length < 400; d = addDays(d, 1)) days.push(d);
    var col = function (iso) { return daysFromToday(iso) - daysFromToday(first); };

    var wrap = h('div', { class: 'gantt' + (phone ? ' g-phone' : '') });

    // Controls.
    wrap.appendChild(h('div', { class: 'g-bar' }, [
      h('div', { class: 'seg' }, [['week', 'ganttWeek'], ['month', 'ganttMonth']].map(function (z) {
        return h('button', { class: zoom === z[0] ? 'on' : '', text: t(z[1]), onclick: function () { S.ganttZoom = z[0]; renderPage(); } });
      })),
      h('div', { class: 'seg' }, [['status', 'ganttByStatus'], ['where', 'ganttByWhere'], ['none', 'ganttFlat']].map(function (z) {
        return h('button', { class: group === z[0] ? 'on' : '', text: t(z[1]), onclick: function () { S.ganttGroup = z[0]; renderPage(); } });
      })),
      h('label', { class: 'inline-check' }, [
        h('input', { type: 'checkbox', checked: showDone, onchange: function (e) { S.ganttDone = e.target.checked; renderPage(); } }),
        t('ganttShowDone'),
      ]),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', text: t('today'), onclick: function () {
        var sc = wrap.querySelector('.g-scroll');
        if (sc) sc.scrollTo({ left: Math.max(0, col(today) * DAY - 120), behavior: 'smooth' });
      } }),
    ]));

    if (!dated.length) {
      wrap.appendChild(h('div', { class: 'empty' }, [h('strong', { text: t('ganttEmpty') }), t('ganttEmptySub')]));
      return wrap;
    }

    // Groups.
    var groups = [];
    if (group === 'status') {
      STATUS_LIST.forEach(function (st) {
        var items = dated.filter(function (x) { return x.status === st; });
        if (items.length) groups.push({ key: st, label: statusLabel(st), colour: STATUS_HEX[st], items: items });
      });
    } else if (group === 'where') {
      var map = {};
      dated.forEach(function (x) {
        var sp = x.spaceId ? spaceBy(x.spaceId) : null;
        var key = sp ? 'sp:' + sp.id : 'd:' + (x.department || '');
        if (!map[key]) map[key] = { key: key, label: sp ? sp.name : (x.department ? deptLabel(x.department) : t('noDept')),
          colour: sp ? spaceHex(sp) : (x.department ? deptHue(x.department) : '#94849b'), items: [] };
        map[key].items.push(x);
      });
      groups = Object.keys(map).map(function (k) { return map[k]; });
    } else {
      groups.push({ key: 'all', label: '', items: dated });
    }
    groups.forEach(function (g) {
      g.items.sort(function (a, b) {
        var sa = a.startDate || a.dueDate; var sb = b.startDate || b.dueDate;
        return sa < sb ? -1 : sa > sb ? 1 : (a.dueDate < b.dueDate ? -1 : 1);
      });
    });

    var width = days.length * DAY;
    var scroll = h('div', { class: 'g-scroll' });
    var grid = h('div', { class: 'g-grid', style: '--day:' + DAY + 'px;--days:' + days.length + ';width:calc(var(--g-label) + ' + width + 'px)' });

    // Ruler: months on top, days below.
    var months = h('div', { class: 'g-months' });
    var dayRow = h('div', { class: 'g-days' });
    var runStart = 0;
    days.forEach(function (iso, i) {
      var next = days[i + 1];
      if (!next || next.slice(0, 7) !== iso.slice(0, 7)) {
        months.appendChild(h('div', { class: 'g-month', style: 'left:' + runStart * DAY + 'px;width:' + (i - runStart + 1) * DAY + 'px',
          text: fmtDate(iso, { month: 'long', year: 'numeric' }) }));
        runStart = i + 1;
      }
      var dow = (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;
      var label = zoom === 'month' ? (dow === 0 ? String(Number(iso.slice(8))) : '') : String(Number(iso.slice(8)));
      dayRow.appendChild(h('div', {
        class: 'g-day' + (iso === today ? ' today' : '') + (dow >= 5 ? ' wkend' : '') + (dow === 0 ? ' mon' : ''),
        style: 'left:' + i * DAY + 'px;width:' + DAY + 'px',
      }, [h('b', { text: label }), zoom === 'week' && !phone ? h('small', { text: fmtDate(iso, { weekday: 'narrow' }) }) : null]));
    });
    grid.appendChild(h('div', { class: 'g-head' }, [
      h('div', { class: 'g-corner', text: t('colTask') }),
      h('div', { class: 'g-ruler' }, [months, dayRow]),
    ]));

    // Background: weekend columns and the today line, once for the whole body.
    var body = h('div', { class: 'g-body' });
    var bg = h('div', { class: 'g-bg' });
    days.forEach(function (iso, i) {
      var dow = (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;
      if (dow >= 5) bg.appendChild(h('i', { class: 'g-wk', style: 'left:' + i * DAY + 'px;width:' + DAY + 'px' }));
      if (dow === 0) bg.appendChild(h('i', { class: 'g-wline', style: 'left:' + i * DAY + 'px' }));
    });
    bg.appendChild(h('i', { class: 'g-today', style: 'left:' + (col(today) * DAY + DAY / 2) + 'px' }));
    body.appendChild(bg);

    groups.forEach(function (g) {
      if (g.label) {
        body.appendChild(h('div', { class: 'g-group' }, [
          h('div', { class: 'g-glabel' }, [h('i', { style: 'background:' + g.colour }), g.label, h('span', { class: 'n', text: String(g.items.length) })]),
          h('div', { class: 'g-gfill' }),
        ]));
      }
      g.items.forEach(function (task) {
        var start = task.startDate && task.startDate <= task.dueDate ? task.startDate : null;
        var from = col(start || task.dueDate);
        var to = col(task.dueDate);
        var late = isOverdue(task);
        var label = h('button', { type: 'button', class: 'g-label', onclick: function () { openTask(task); } }, [
          h('span', { class: 'st-dot', dataset: { st: task.status } }),
          task.code ? h('span', { class: 't-code', text: task.code }) : null,
          h('span', { class: 'g-name', text: task.title }),
        ]);
        var bar;
        if (start) {
          bar = h('div', {
            class: 'g-barline' + (late ? ' late' : ''), dataset: { st: task.status },
            style: 'left:' + (from * DAY + 2) + 'px;width:' + Math.max(DAY - 4, (to - from + 1) * DAY - 4) + 'px',
            title: task.title + ' · ' + fmtDate(start) + ' – ' + fmtDate(task.dueDate),
          }, [
            h('span', { class: 'g-bartext', text: (to - from + 1) * DAY > 90 ? task.title : '' }),
            h('span', { class: 'g-stack' }, task.assignees.slice(0, 2).map(function (u) { return avatarNode(u, 'sm'); })),
            task.mayEdit && !phone ? h('i', { class: 'g-grip' }) : null,
          ]);
        } else {
          bar = h('div', {
            class: 'g-milestone' + (late ? ' late' : ''), dataset: { st: task.status },
            style: 'left:' + (to * DAY + DAY / 2 - 8) + 'px',
            title: task.title + ' · ' + fmtDate(task.dueDate),
          });
        }
        bar.addEventListener('click', function (e) { if (!bar._dragged) openTask(task); e.stopPropagation(); });
        if (task.mayEdit && !phone && !task.pending) dragBar(bar, task, DAY, Boolean(start));
        body.appendChild(h('div', { class: 'g-row', dataset: { st: task.status } }, [label, h('div', { class: 'g-track' }, [bar])]));
      });
    });
    grid.appendChild(body);
    scroll.appendChild(grid);
    wrap.appendChild(scroll);
    if (undated) wrap.appendChild(h('p', { class: 'g-note', text: t('ganttUndated').replace('%n', String(undated)) }));

    // Open on today, not on the first of three months ago.
    requestAnimationFrame(function () {
      if (S.ganttScroll !== undefined && S.ganttScrollFor === zoom) scroll.scrollLeft = S.ganttScroll;
      else scroll.scrollLeft = Math.max(0, col(today) * DAY - (phone ? 40 : 160));
    });
    scroll.addEventListener('scroll', function () { S.ganttScroll = scroll.scrollLeft; S.ganttScrollFor = zoom; }, { passive: true });
    return wrap;
  }

  /**
   * Dragging a bar along the ruler moves both dates by whole days; dragging
   * its grip moves only the deadline. Saved on release, through the same
   * PATCH as the form, and put back if the server refuses.
   */
  function dragBar(bar, task, DAY, ranged) {
    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var grip = e.target.classList.contains('g-grip');
      var x0 = e.clientX;
      var left0 = parseFloat(bar.style.left);
      var width0 = bar.offsetWidth;
      var moved = 0;
      bar._dragged = false;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      function move(ev) {
        moved = Math.round((ev.clientX - x0) / DAY);
        if (Math.abs(ev.clientX - x0) > 4) bar._dragged = true;
        if (grip) bar.style.width = Math.max(DAY - 4, width0 + moved * DAY) + 'px';
        else bar.style.left = (left0 + moved * DAY) + 'px';
      }
      function up() {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.classList.remove('dragging');
        if (!moved) { setTimeout(function () { bar._dragged = false; }, 0); return; }
        var change = {};
        if (grip) {
          var due = addDays(task.dueDate, moved);
          if (ranged && task.startDate && due < task.startDate) due = task.startDate;
          change.dueDate = due;
        } else {
          change.dueDate = addDays(task.dueDate, moved);
          if (ranged && task.startDate) change.startDate = addDays(task.startDate, moved);
        }
        patchTask(task.id, change);
        setTimeout(function () { bar._dragged = false; }, 0);
      }
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
  }

  /** "This one" or "this and every one after" — asked of a meeting in a series. */
  function askSeriesScope(title) {
    return new Promise(function (resolve) {
      actionSheet(title, [
        { icon: 'meeting', label: t('seriesOne'), sub: t('seriesOneSub'), onclick: function () { resolve('one'); } },
        { icon: 'repeat', label: t('seriesFollowing'), sub: t('seriesFollowingSub'), onclick: function () { resolve('following'); } },
      ]);
    });
  }

  /* ---------- home: a personal brief, as pictures ------------------------ */

  /** A timestamp as a Bangkok calendar date. */
  function localDay(stamp) {
    if (!stamp) return null;
    var d = new Date(stamp);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  }
  function mondayOf(iso) {
    var wd = (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;
    return addDays(iso, -wd);
  }
  function greetingWord() {
    var hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
    return hour < 12 ? t('helloMorning') : hour < 17 ? t('helloAfternoon') : t('helloEvening');
  }
  function firstName() {
    var u = S.user || {};
    if (u.nickname) return u.nickname;
    return String(u.displayName || u.username || '').split(/[\s\-–]/)[0];
  }

  /**
   * Everything the home page draws, worked out from what is already loaded.
   * Kept apart from the drawing so the numbers can be read (and tested) on
   * their own.
   */
  function homeStats() {
    var me = S.user.username;
    var today = todayIso();
    var mine = S.tasks.filter(function (x) { return x.assignees.indexOf(me) !== -1; });
    var open = mine.filter(function (x) { return x.status !== 'done'; });
    var done = mine.filter(function (x) { return x.status === 'done'; });
    var weekEnd = addDays(today, 6);
    var dueSoon = open.filter(function (x) { return x.dueDate && x.dueDate >= today && x.dueDate <= weekEnd; });
    var late = open.filter(isOverdue);
    var doneDay = function (x) { return localDay(x.doneAt) || localDay(x.updatedAt); };
    var doneMonth = done.filter(function (x) { var d = doneDay(x); return d && d >= addDays(today, -29); });
    var doneWeek = done.filter(function (x) { var d = doneDay(x); return d && d >= mondayOf(today); });

    // Finished per week, the last eight weeks.
    var weeks = [];
    var thisMonday = mondayOf(today);
    for (var i = 7; i >= 0; i -= 1) weeks.push(addDays(thisMonday, -7 * i));
    var perWeek = weeks.map(function (w) {
      var end = addDays(w, 6);
      return done.filter(function (x) { var d = doneDay(x); return d && d >= w && d <= end; }).length;
    });

    // On time: finished on or before the deadline.
    var judged = done.filter(function (x) { return x.dueDate && doneDay(x); });
    var onTime = judged.filter(function (x) { return doneDay(x) <= x.dueDate; });
    var onTimePct = judged.length ? Math.round((onTime.length / judged.length) * 100) : null;
    var recent = judged.slice().sort(function (a, b) { return doneDay(a) < doneDay(b) ? 1 : -1; }).slice(0, 5);
    var streakOnTime = recent.length === 5 && recent.every(function (x) { return doneDay(x) <= x.dueDate; });

    // Which weekday things get finished on.
    var byWeekday = [0, 0, 0, 0, 0, 0, 0];
    done.forEach(function (x) {
      var d = doneDay(x);
      if (d) byWeekday[(new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7] += 1;
    });
    var bestDay = byWeekday.indexOf(Math.max.apply(null, byWeekday));

    // Days in a row with something finished, up to today (or yesterday).
    var daysDone = {};
    done.forEach(function (x) { var d = doneDay(x); if (d) daysDone[d] = true; });
    var streak = 0;
    var cursor = daysDone[today] ? today : addDays(today, -1);
    while (daysDone[cursor] && streak < 365) { streak += 1; cursor = addDays(cursor, -1); }

    // Who I work with most.
    var withWhom = {};
    mine.forEach(function (x) {
      x.assignees.forEach(function (u) { if (u !== me) withWhom[u] = (withWhom[u] || 0) + 1; });
    });
    var team = Object.keys(withWhom).sort(function (a, b) { return withWhom[b] - withWhom[a]; })
      .slice(0, 6).map(function (u) { return { username: u, n: withWhom[u] }; });

    var statusCount = {};
    STATUS_LIST.forEach(function (st) { statusCount[st] = mine.filter(function (x) { return x.status === st; }).length; });

    var meetingsToday = (S.meetings || []).filter(function (m) {
      return m.meetsOn === today && m.status !== 'cancelled' && (m.people || []).some(function (p) { return p.username === me && p.reply !== 'declined'; });
    });
    var accepted = (S.meetings || []).filter(function (m) {
      return (m.people || []).some(function (p) { return p.username === me && p.reply === 'accepted'; });
    }).length;
    var eventsToday = (S.events || []).filter(function (e) {
      return e.startsOn <= today && (e.endsOn || e.startsOn) >= today &&
        (!(e.people || []).length || e.people.indexOf(me) !== -1);
    });

    return {
      mine: mine, open: open, done: done, dueSoon: dueSoon, late: late, doneMonth: doneMonth, doneWeek: doneWeek,
      weeks: weeks, perWeek: perWeek, judged: judged.length, onTime: onTime.length, onTimePct: onTimePct,
      streakOnTime: streakOnTime, byWeekday: byWeekday, bestDay: bestDay, streak: streak, team: team,
      statusCount: statusCount, meetingsToday: meetingsToday, eventsToday: eventsToday, accepted: accepted,
      dueToday: open.filter(function (x) { return x.dueDate === today; }),
    };
  }

  /** The achievements, each either earned or showing how far off it is. */
  function badgesFor(st) {
    return [
      { key: 'first', icon: 'spark', label: t('badgeFirst'), have: Math.min(st.done.length, 1), need: 1, colour: '#e0457b' },
      { key: 'ten', icon: 'trophy', label: t('badgeTen'), have: Math.min(st.done.length, 10), need: 10, colour: '#f59e0b' },
      { key: 'ontime', icon: 'clock', label: t('badgeOnTime'), have: st.streakOnTime ? 5 : Math.min(st.onTime, 4), need: 5, colour: '#0fa5a0' },
      { key: 'week', icon: 'flame', label: t('badgeWeek'), have: Math.min(st.doneWeek.length, 5), need: 5, colour: '#e5484d' },
      { key: 'team', icon: 'people', label: t('badgeTeam'), have: Math.min(st.team.length, 5), need: 5, colour: '#5b5bd6' },
      { key: 'meet', icon: 'meeting', label: t('badgeMeet'), have: Math.min(st.accepted, 5), need: 5, colour: '#8b5cf6' },
      { key: 'clear', icon: 'check', label: t('badgeClear'), have: st.open.length && !st.late.length ? 1 : 0, need: 1, colour: '#12a36b' },
    ];
  }

  function kpi(iconName, colour, value, label, sub, onclick) {
    return h(onclick ? 'button' : 'div', { class: 'kpi', style: '--k:' + colour, onclick: onclick || null, type: onclick ? 'button' : null }, [
      h('span', { class: 'kpi-ic' }, [icon(iconName)]),
      h('span', { class: 'kpi-tx' }, [
        h('b', { class: 'kpi-n', text: String(value) }),
        h('span', { class: 'kpi-l', text: label }),
        sub ? h('small', { class: 'kpi-s', text: sub }) : null,
      ]),
    ]);
  }

  function pageHome(main) {
    main.classList.add('wide');
    var st = homeStats();
    var phone = isPhone();
    var today = todayIso();

    // The band: hello, and the day in one sentence.
    var brief = [];
    if (st.meetingsToday.length) brief.push(t('briefMeetings').replace('%n', String(st.meetingsToday.length)));
    if (st.dueToday.length) brief.push(t('briefDueToday').replace('%n', String(st.dueToday.length)));
    if (st.late.length) brief.push(t('briefLate').replace('%n', String(st.late.length)));
    var weekGoal = Math.max(5, st.doneWeek.length);
    main.appendChild(h('section', { class: 'hello' }, [
      h('div', { class: 'hello-tx' }, [
        h('small', { text: fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long' }) }),
        h('h2', { text: greetingWord() + ', ' + firstName() }),
        h('p', { text: brief.length ? brief.join(' · ') : t('briefClear') }),
        h('div', { class: 'hello-actions' }, [
          h('a', { class: 'btn hello-btn', href: '#/schedule' }, [icon('clock'), t('navSchedule')]),
          h('a', { class: 'btn hello-btn ghosty', href: '#/work' }, [icon('task'), t('homeMyWork')]),
        ]),
      ]),
      h('div', { class: 'hello-art' }, [
        h('div', { class: 'hello-ring' }, [donut([
          { value: st.doneWeek.length, colour: '#ffffff' },
          { value: Math.max(0, weekGoal - st.doneWeek.length), colour: 'rgba(255,255,255,.22)' },
        ], { size: phone ? 92 : 124, stroke: phone ? 10 : 13, center: st.doneWeek.length, sub: t('homeThisWeek') })]),
        st.streak ? h('div', { class: 'hello-streak' }, [icon('flame'), t('homeStreak').replace('%n', String(st.streak))]) : null,
      ]),
    ]));

    // Four numbers.
    main.appendChild(h('section', { class: 'kpis' }, [
      kpi('task', '#5b5bd6', st.open.length, t('kpiOpen'), t('kpiOpenSub'), function () { S.scope = 'mine'; S.role = ''; S.filter = 'open'; location.hash = '#/work'; }),
      kpi('clock', '#f59e0b', st.dueSoon.length, t('kpiWeek'), t('kpiWeekSub')),
      kpi('alert', '#e5484d', st.late.length, t('kpiLate'), st.late.length ? t('kpiLateSub') : t('kpiLateNone')),
      kpi('trophy', '#12a36b', st.doneMonth.length, t('kpiDone'), t('kpiDoneSub')),
    ]));

    var grid = h('div', { class: 'home-grid' });
    main.appendChild(grid);

    // Today, as a timeline.
    var todayCard = h('section', { class: 'card hc-today' }, [
      h('div', { class: 'card-head' }, [icon('sun'), h('h3', { text: t('homeToday') }), h('span', { class: 'grow' }),
        h('a', { class: 'card-link', href: '#/schedule', text: t('homeOpenSchedule') })]),
    ]);
    var todayList = h('ul', { class: 'today-list' });
    todayCard.appendChild(todayList);
    function drawToday(appts) {
      clear(todayList);
      var items = [];
      st.meetingsToday.forEach(function (m) { items.push({ at: m.meetsAt || '', to: m.endsAt || '', kind: 'meeting', title: m.title, sub: m.place, open: function () { openMeeting(m); } }); });
      st.eventsToday.forEach(function (e) { items.push({ at: e.allDay ? '' : (e.startsAt || ''), to: e.allDay ? '' : (e.endsAt || ''), kind: 'event', title: e.title, sub: e.place, open: function () { openEvent(e); } }); });
      st.dueToday.forEach(function (x) { items.push({ at: x.dueTime || '', kind: 'task', st: x.status, title: x.title, sub: t('dueWord'), open: function () { openTask(x); } }); });
      (appts || []).forEach(function (a) { if (a.on === today) items.push({ at: a.at, to: a.to, kind: a.kind, title: a.title, sub: a.with ? nameOf(a.with) : a.place, open: function () { openAppointment(a); } }); });
      items.sort(function (a, b) { return (a.at || '00') < (b.at || '00') ? -1 : 1; });
      if (!items.length) {
        todayList.appendChild(h('li', { class: 'today-empty' }, [icon('sun'), h('span', { text: t('homeTodayEmpty') })]));
        return;
      }
      items.forEach(function (it) {
        todayList.appendChild(h('li', { class: 'today-item k-' + it.kind, dataset: it.st ? { st: it.st } : {}, onclick: it.open }, [
          h('span', { class: 'ti-time' }, [h('b', { text: it.at || t('allDayShort') }), it.to ? h('small', { text: it.to }) : null]),
          h('span', { class: 'ti-bar' }),
          h('span', { class: 'ti-tx' }, [h('b', { text: it.title }), h('small', { text: t('kind_' + it.kind) + (it.sub ? ' · ' + it.sub : '') })]),
        ]));
      });
    }
    drawToday([]);
    api('/api/calendar?do=schedule&from=' + today + '&to=' + today)
      .then(function (d) { if (S.page === 'home') drawToday(d.appointments || []); })
      .catch(function () {});
    grid.appendChild(todayCard);

    /**
     * Somebody with no tasks yet — usually their first day — gets a card that
     * says where work will appear and what to do now, instead of four charts of
     * zeros that fill a phone screen and explain nothing.
     */
    if (!st.mine.length) {
      // First in the grid, so on a phone it is the first thing under the numbers.
      grid.insertBefore(h('section', { class: 'card hc-start' }, [
        h('div', { class: 'card-head' }, [icon('spark'), h('h3', { text: t('homeStartTitle') })]),
        h('ol', { class: 'start-list' }, [
          h('li', {}, [h('span', { text: t('homeStartWork') }),
            h('a', { class: 'btn sm', href: '#/work', text: t('homeStartWorkBtn') })]),
          h('li', {}, [h('span', { text: t('homeStartSetup') }),
            h('button', { class: 'btn sm', type: 'button', text: t('homeStartSetupBtn'),
              onclick: function () { guideStatus().then(function (steps) { openGuide(steps, true); }); } })]),
          mayCreate() ? h('li', {}, [h('span', { text: t('homeStartCreate') }),
            h('button', { class: 'btn sm primary', type: 'button', text: t('homeStartCreateBtn'), onclick: function () { openCreateSheet(); } })]) : null,
        ]),
      ]), grid.firstChild);
    } else {
      // Finished per week.
      var wkLabels = st.weeks.map(function (w, i) { return i === st.weeks.length - 1 ? t('thisWeekShort') : fmtDate(w, { day: 'numeric', month: 'short' }); });
      grid.appendChild(h('section', { class: 'card hc-trend' }, [
        h('div', { class: 'card-head' }, [icon('chart'), h('h3', { text: t('homeTrend') }), h('span', { class: 'grow' }),
          h('small', { text: t('homeTrendTotal').replace('%n', String(st.done.length)) })]),
        h('div', { class: 'chart-box' }, [barChart(st.perWeek, wkLabels, { width: 420, height: 160, highlight: st.perWeek.length - 1, label: t('homeTrend') })]),
      ]));

      // Where my work stands.
      var stParts = STATUS_LIST.map(function (s) { return { value: st.statusCount[s], colour: STATUS_HEX[s], label: statusLabel(s) }; });
      grid.appendChild(h('section', { class: 'card hc-status' }, [
        h('div', { class: 'card-head' }, [icon('pie'), h('h3', { text: t('homeStatus') })]),
        h('div', { class: 'donut-row' }, [
          donut(stParts, { size: 132, stroke: 20, center: st.mine.length, sub: t('homeTasks') }),
          h('ul', { class: 'legend' }, STATUS_LIST.map(function (s) {
            return h('li', {}, [h('i', { style: 'background:' + STATUS_HEX[s] }), h('span', { text: statusLabel(s) }), h('b', { text: String(st.statusCount[s]) })]);
          })),
        ]),
      ]));

      // On time.
      var pct = st.onTimePct;
      grid.appendChild(h('section', { class: 'card hc-ontime' }, [
        h('div', { class: 'card-head' }, [icon('target'), h('h3', { text: t('homeOnTime') })]),
        h('div', { class: 'donut-row' }, [
          donut([{ value: pct || 0, colour: pct === null ? 'var(--surface-3)' : (pct >= 80 ? '#12a36b' : pct >= 50 ? '#f59e0b' : '#e5484d') },
            { value: 100 - (pct || 0), colour: 'transparent' }], { size: 132, stroke: 14, center: pct === null ? '—' : pct + '%', sub: t('homeOnTimeSub') }),
          h('div', { class: 'ot-tx' }, [
            h('b', { text: pct === null ? t('homeOnTimeNone') : t('homeOnTimeOf').replace('%a', String(st.onTime)).replace('%b', String(st.judged)) }),
            h('small', { text: pct === null ? '' : pct >= 80 ? t('homeOnTimeGreat') : pct >= 50 ? t('homeOnTimeOk') : t('homeOnTimeLow') }),
          ]),
        ]),
      ]));

      // The day things get done.
      var wdLabels = WEEK_KEYS.map(function (k) { return t('wd_' + k); });
      var anyDone = st.byWeekday.some(function (v) { return v > 0; });
      grid.appendChild(h('section', { class: 'card hc-days' }, [
        h('div', { class: 'card-head' }, [icon('bolt'), h('h3', { text: t('homeBestDay') }), h('span', { class: 'grow' }),
          anyDone ? h('span', { class: 'chip best-day', text: t('wdl_' + WEEK_KEYS[st.bestDay]) }) : null]),
        h('div', { class: 'chart-box' }, [barChart(st.byWeekday, wdLabels, { width: 320, height: 140, highlight: anyDone ? st.bestDay : -1,
          hiColour: '#8b5cf6', colour: 'color-mix(in srgb, #8b5cf6 30%, transparent)', label: t('homeBestDay') })]),
      ]));

    }

    // Coming up.
    var next = st.open.filter(function (x) { return x.dueDate; }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1; }).slice(0, phone ? 4 : 6);
    grid.appendChild(h('section', { class: 'card hc-next' }, [
      h('div', { class: 'card-head' }, [icon('flag'), h('h3', { text: t('homeNext') }), h('span', { class: 'grow' }),
        h('a', { class: 'card-link', href: '#/work', text: t('seeAll') })]),
      next.length ? h('ul', { class: 'next-list' }, next.map(function (x) {
        return h('li', { dataset: { st: x.status }, onclick: function () { openTask(x); } }, [
          h('span', { class: 'st-dot', dataset: { st: x.status } }),
          h('span', { class: 'nx-title', text: x.title }),
          dueChip(x),
        ]);
      })) : h('p', { class: 'muted-line', text: t('homeNextNone') }),
    ]));

    // Badges.
    var badges = badgesFor(st);
    var earned = badges.filter(function (b) { return b.have >= b.need; }).length;
    grid.appendChild(h('section', { class: 'card hc-badges' }, [
      h('div', { class: 'card-head' }, [icon('trophy'), h('h3', { text: t('homeBadges') }), h('span', { class: 'grow' }),
        h('small', { text: earned + '/' + badges.length })]),
      h('div', { class: 'badges' }, badges.map(function (b) {
        var got = b.have >= b.need;
        return h('div', { class: 'badge-item' + (got ? ' got' : ''), style: '--b:' + b.colour, title: b.label },
          [h('span', { class: 'bd-ic' }, [icon(b.icon)]), h('b', { text: b.label }),
            h('small', { text: got ? t('badgeGot') : b.have + '/' + b.need }),
            got ? null : h('span', { class: 'bd-bar' }, [h('i', { style: 'width:' + Math.round((b.have / b.need) * 100) + '%' })])]);
      })),
    ]));

    // The people I work with.
    grid.appendChild(h('section', { class: 'card hc-team' }, [
      h('div', { class: 'card-head' }, [icon('people'), h('h3', { text: t('homeTeam') })]),
      st.team.length ? h('ul', { class: 'team-list' }, st.team.map(function (p) {
        var max = st.team[0].n;
        return h('li', {}, [avatarNode(p.username, 'sm'), h('span', { class: 'tm-name', text: nameOf(p.username) }),
          h('span', { class: 'tm-bar' }, [h('i', { style: 'width:' + Math.round((p.n / max) * 100) + '%' })]),
          h('b', { text: String(p.n) })]);
      })) : h('p', { class: 'muted-line', text: t('homeTeamNone') }),
    ]));

    // Spaces I am in.
    var spaces = (S.spaces || []).filter(function (sp) { return sp.mine; });
    grid.appendChild(h('section', { class: 'card hc-spaces' }, [
      h('div', { class: 'card-head' }, [icon('grid'), h('h3', { text: t('spaces') }), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', text: '+ ' + t('spaceNew'), onclick: function () { openSpace(null); } })]),
      spaces.length ? h('div', { class: 'space-tiles' }, spaces.slice(0, 6).map(function (sp) {
        var total = sp.openTasks + sp.doneTasks;
        return h('a', { class: 'space-tile', href: '#/space/' + encodeURIComponent(sp.id), style: '--sp:' + spaceHex(sp) }, [
          spaceBadge(sp, 'sp-ico'),
          h('span', { class: 'sp-tx' }, [h('b', { text: sp.name }), h('small', { text: t('spaceOpenN').replace('%n', String(sp.openTasks)) })]),
          h('span', { class: 'sp-bar' }, [h('i', { style: 'width:' + (total ? Math.round((sp.doneTasks / total) * 100) : 0) + '%' })]),
        ]);
      })) : h('p', { class: 'muted-line', text: t('spacesNone') }),
    ]));
  }

  /* ---------- my schedule ------------------------------------------------ */

  var KIND_COLOUR = {
    meeting: '#5b5bd6', event: '#f59e0b', task: '#e0457b', personal: '#d9468f',
    focus: '#8b5cf6', booking: '#12a36b', office: '#0fa5a0', google: '#2f7ff0',
  };
  function minutesOfClock(v) {
    var m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  function clockOfMinutes(n) {
    n = Math.max(0, Math.min(24 * 60 - 1, Math.round(n)));
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }

  function schedRange() {
    var phone = isPhone();
    var view = S.schedView || (phone ? 'day' : 'week');
    var anchor = S.schedAnchor || todayIso();
    if (view === 'week') { var mon = mondayOf(anchor); return { view: view, from: mon, to: addDays(mon, 6) }; }
    return { view: view, from: anchor, to: anchor };
  }

  function loadSchedule(from, to) {
    var key = from + '|' + to;
    S.schedKey = key;
    return api('/api/calendar?do=schedule&from=' + from + '&to=' + to).then(function (d) {
      if (S.schedKey !== key) return null;
      S.sched = d;
      S.schedLoaded = key;
      return d;
    });
  }

  /**
   * Everything that has a place on my time between two dates, as one list:
   * meetings I am asked to, events that concern me, my deadlines, my own
   * appointments and bookings, my office hours, and my Google events.
   */
  function schedItems(from, to) {
    var me = S.user.username;
    var out = [];
    var data = S.sched || {};
    (S.meetings || []).forEach(function (m) {
      if (m.meetsOn < from || m.meetsOn > to || m.status === 'cancelled') return;
      var mine = (m.people || []).filter(function (p) { return p.username === me; })[0];
      if (!mine) return;
      out.push({ kind: 'meeting', on: m.meetsOn, at: m.meetsAt, to: m.endsAt, title: m.title, sub: m.place,
        faded: mine.reply === 'declined', reply: mine.reply, open: function () { openMeeting(m); } });
    });
    (S.events || []).forEach(function (e) {
      var a = e.startsOn; var b = e.endsOn || e.startsOn;
      if (b < from || a > to) return;
      if ((e.people || []).length && e.people.indexOf(me) === -1) return;
      var span = a === b ? [a] : (function () { var d = []; for (var x = a > from ? a : from; x <= b && x <= to; x = addDays(x, 1)) d.push(x); return d; }());
      span.forEach(function (on) {
        out.push({ kind: 'event', on: on, at: e.allDay ? null : (on === a ? e.startsAt : null), to: e.allDay ? null : (on === b ? e.endsAt : null),
          title: e.title, sub: e.place, colour: colourHex(e.colour), everyone: !(e.people || []).length, open: function () { openEvent(e); } });
      });
    });
    S.tasks.forEach(function (x) {
      if (!x.dueDate || x.dueDate < from || x.dueDate > to || x.assignees.indexOf(me) === -1) return;
      out.push({ kind: 'task', on: x.dueDate, at: x.dueTime, to: x.dueTime ? clockOfMinutes(minutesOfClock(x.dueTime) + 30) : null,
        title: x.title, sub: statusLabel(x.status), st: x.status, point: true, faded: x.status === 'done', open: function () { openTask(x); } });
    });
    (data.appointments || []).forEach(function (a) {
      out.push({ kind: a.kind, on: a.on, at: a.at, to: a.toOn === a.on ? a.to : '23:59', title: a.title,
        sub: a.with ? nameOf(a.with) : a.place, open: function () { openAppointment(a); } });
    });
    (data.officeDays || []).forEach(function (o) {
      out.push({ kind: 'office', on: o.on, at: o.at, to: o.to, title: t('officeHours'), sub: o.place, background: true,
        open: function () { openOfficeHours(); } });
    });
    (data.google || []).forEach(function (g) {
      var a = g.on; var b = g.toOn || g.on;
      for (var on = a < from ? from : a; on <= b && on <= to; on = addDays(on, 1)) {
        out.push({ kind: 'google', on: on, at: g.at ? (on === a ? g.at : '00:00') : null, to: g.at ? (on === b ? g.to : '23:59') : null,
          title: g.title, sub: g.place, link: g.link, open: g.link ? (function (link) { return function () { window.open(link, '_blank', 'noopener'); }; }(g.link)) : null });
      }
    });
    return out;
  }

  /** Hours spent, by kind, in this range — and the free working hours left. */
  function allocation(items, from, to) {
    var mins = {};
    items.forEach(function (it) {
      if (it.background || it.faded || !it.at || it.point) return;
      var a = minutesOfClock(it.at); var b = minutesOfClock(it.to) || a + 60;
      if (b <= a) return;
      mins[it.kind] = (mins[it.kind] || 0) + (b - a);
    });
    var days = 0;
    for (var d = from; d <= to; d = addDays(d, 1)) { var wd = (new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7; if (wd < 5) days += 1; }
    var busy = Object.keys(mins).reduce(function (a, k) { return a + mins[k]; }, 0);
    return { mins: mins, busy: busy, free: Math.max(0, days * 9 * 60 - busy), tasks: items.filter(function (i) { return i.kind === 'task'; }).length };
  }
  /** 8.5 rather than "8 ชม. 30 นาที" — for the middle of a ring. */
  var shortHours = function (m) {
    var h1 = m / 60;
    return (Math.round(h1 * 10) % 10 === 0 ? String(Math.round(h1)) : h1.toFixed(1));
  };
  var hoursText = function (m) { var hh = Math.floor(m / 60); var mm = m % 60; return (hh ? hh + t('hrsUnit') : '') + (mm ? ' ' + mm + t('minUnit') : (hh ? '' : '0' + t('hrsUnit'))); };

  function pageSchedule(main) {
    main.classList.add('wide');
    var phone = isPhone();
    var r = schedRange();
    var key = r.from + '|' + r.to;

    if (S.googleNotice) {
      var gn = S.googleNotice;
      S.googleNotice = null;
      var good = gn === 'ok';
      main.appendChild(h('div', { class: 'notice ' + (good ? 'ok' : 'warn') }, [t('google_' + gn) !== 'google_' + gn ? t('google_' + gn) : t('google_error')]));
    }
    if (S.bookHost) { var host = S.bookHost; S.bookHost = null; setTimeout(function () { openBooking(host); }, 50); }

    // Toolbar.
    var label = r.view === 'week'
      ? fmtDate(r.from, { day: 'numeric', month: 'short' }) + ' – ' + fmtDate(r.to, { day: 'numeric', month: 'short', year: 'numeric' })
      : fmtDate(r.from, { weekday: 'long', day: 'numeric', month: 'long' });
    var step = r.view === 'week' ? 7 : 1;
    main.appendChild(h('div', { class: 'sched-bar' }, [
      h('div', { class: 'sched-nav' }, [
        h('button', { class: 'btn sm icon-btn', 'aria-label': '‹', onclick: function () { S.schedAnchor = addDays(r.from, -step); renderPage(); } }, ['‹']),
        h('button', { class: 'btn sm', text: t('today'), onclick: function () { S.schedAnchor = todayIso(); renderPage(); } }),
        h('button', { class: 'btn sm icon-btn', 'aria-label': '›', onclick: function () { S.schedAnchor = addDays(r.from, step); renderPage(); } }, ['›']),
      ]),
      h('b', { class: 'sched-label', text: label }),
      h('div', { class: 'seg' }, [['day', 'schedDay'], ['week', 'schedWeek']].map(function (v) {
        return h('button', { class: r.view === v[0] ? 'on' : '', text: t(v[1]), onclick: function () { S.schedView = v[0]; if (v[0] === 'day' && r.view === 'week') S.schedAnchor = r.from <= todayIso() && todayIso() <= r.to ? todayIso() : r.from; renderPage(); } });
      })),
      h('span', { class: 'grow' }),
      h('div', { class: 'sched-actions' }, [
        h('button', { class: 'btn', onclick: function () { openFindTime(); } }, [icon('search'), h('span', { text: t('findTime') })]),
        h('button', { class: 'btn', onclick: function () { openBooking(null); } }, [icon('calplus'), h('span', { text: t('bookSlot') })]),
        h('button', { class: 'btn', onclick: function () { openOfficeHours(); } }, [icon('door'), h('span', { text: t('officeHours') })]),
        h('button', { class: 'btn primary', onclick: function () { openAppointment(null, { on: r.view === 'day' ? r.from : todayIso() }); } }, [icon('plus'), h('span', { text: t('apptNew') })]),
      ]),
    ]));

    var layout = h('div', { class: 'sched-layout' });
    var side = h('aside', { class: 'sched-side' });
    var body = h('div', { class: 'sched-main' });
    layout.appendChild(body);
    layout.appendChild(side);
    main.appendChild(layout);

    function draw() {
      clear(body); clear(side);
      var items = schedItems(r.from, r.to);
      if (phone && r.view === 'week') {
        // A week on a phone: each day that has something, as a short list.
        for (var dd = r.from; dd <= r.to; dd = addDays(dd, 1)) {
          var some = items.some(function (it) { return it.on === dd && !it.background; });
          if (!some && dd !== todayIso()) continue;
          body.appendChild(h('h4', { class: 'wk-day-head' + (dd === todayIso() ? ' today' : '') }, [fmtDate(dd, { weekday: 'long', day: 'numeric', month: 'short' })]));
          body.appendChild(dayTimeline(items, dd));
        }
      } else if (phone || r.view === 'day') {
        if (phone) body.appendChild(dayStrip(r));
        body.appendChild(dayTimeline(items, r.from));
      } else {
        body.appendChild(weekGrid(items, r.from, r.to));
      }
      if (S.schedLoaded !== key) body.appendChild(h('div', { class: 'sched-loading', text: t('loading') }));
      drawSide(side, items, r);
    }
    draw();
    if (S.schedLoaded !== key) {
      loadSchedule(r.from, r.to).then(function (d) { if (d && S.page === 'schedule') { draw(); maybeAutoSync(d.googleStatus); } })
        .catch(function () { if (S.page === 'schedule') draw(); });
    }
  }

  /** Seven day buttons across the top of the phone's day view. */
  function dayStrip(r) {
    var mon = mondayOf(r.from);
    var strip = h('div', { class: 'day-strip' });
    for (var i = 0; i < 7; i += 1) {
      (function (iso) {
        strip.appendChild(h('button', {
          type: 'button', class: 'ds-day' + (iso === r.from ? ' on' : '') + (iso === todayIso() ? ' today' : ''),
          onclick: function () { S.schedAnchor = iso; renderPage(); },
        }, [h('small', { text: fmtDate(iso, { weekday: 'short' }) }), h('b', { text: String(Number(iso.slice(8))) })]));
      }(addDays(mon, i)));
    }
    return strip;
  }

  /** Overlapping blocks share the width of their day, side by side. */
  function lanes(timed) {
    timed.sort(function (a, b) { return a._a - b._a || b._b - a._b; });
    var groups = []; var cur = []; var end = -1;
    timed.forEach(function (it) {
      if (it._a >= end && cur.length) { groups.push(cur); cur = []; end = -1; }
      cur.push(it); end = Math.max(end, it._b);
    });
    if (cur.length) groups.push(cur);
    groups.forEach(function (g) {
      var laneEnds = [];
      g.forEach(function (it) {
        var lane = laneEnds.findIndex(function (e) { return e <= it._a; });
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(it._b); } else laneEnds[lane] = it._b;
        it._lane = lane;
      });
      g.forEach(function (it) { it._lanes = laneEnds.length; });
    });
  }

  function blockFor(it, HOUR, startHour) {
    var top = ((it._a - startHour * 60) / 60) * HOUR;
    var height = Math.max(it.point ? 20 : 22, ((it._b - it._a) / 60) * HOUR - 2);
    var w = 100 / (it._lanes || 1);
    var el = h(it.open ? 'button' : 'div', {
      type: it.open ? 'button' : null,
      class: 'sb-block k-' + it.kind + (it.faded ? ' faded' : '') + (it.point ? ' point' : '') + (height < 34 ? ' short' : ''),
      style: 'top:' + top + 'px;height:' + height + 'px;left:calc(' + (it._lane || 0) * w + '% + 2px);width:calc(' + w + '% - 4px);--c:' + (it.colour || KIND_COLOUR[it.kind]),
      dataset: it.st ? { st: it.st } : {},
      title: (it.at ? it.at + (it.to && !it.point ? '–' + it.to : '') + ' · ' : '') + it.title + (it.sub ? ' · ' + it.sub : ''),
      onclick: it.open ? function (e) { e.stopPropagation(); it.open(); } : null,
    }, [
      h('b', { text: it.title }),
      height >= 34 ? h('small', { text: (it.at || '') + (it.to && !it.point ? '–' + it.to : '') + (it.sub ? ' · ' + it.sub : '') }) : null,
    ]);
    return el;
  }

  function weekGrid(items, from, to) {
    var HOUR = 46;
    var days = []; for (var d = from; d <= to; d = addDays(d, 1)) days.push(d);
    var startHour = 7; var endHour = 22;
    items.forEach(function (it) {
      if (!it.at) return;
      var a = minutesOfClock(it.at); var b = minutesOfClock(it.to);
      if (a !== null) startHour = Math.min(startHour, Math.floor(a / 60));
      if (b !== null) endHour = Math.max(endHour, Math.ceil(b / 60));
    });
    endHour = Math.min(24, endHour);
    var today = todayIso();

    var grid = h('div', { class: 'wk', style: '--hour:' + HOUR + 'px;--cols:' + days.length });
    grid.appendChild(h('div', { class: 'wk-head' }, [h('div', { class: 'wk-gutter' })].concat(days.map(function (iso) {
      return h('div', { class: 'wk-dh' + (iso === today ? ' today' : '') }, [
        h('small', { text: fmtDate(iso, { weekday: 'short' }) }), h('b', { text: String(Number(iso.slice(8))) }),
      ]);
    }))));
    // Things with no time sit in a row of their own above the hours.
    var allDay = h('div', { class: 'wk-allday' }, [h('div', { class: 'wk-gutter', text: t('allDayShort') })].concat(days.map(function (iso) {
      var mine = items.filter(function (it) { return it.on === iso && !it.at && !it.background; });
      return h('div', { class: 'wk-ad' }, mine.map(function (it) {
        return h('button', { type: 'button', class: 'ad-chip k-' + it.kind + (it.faded ? ' faded' : ''), style: '--c:' + (it.colour || KIND_COLOUR[it.kind]),
          dataset: it.st ? { st: it.st } : {}, title: it.title, onclick: it.open }, [it.title]);
      }));
    })));
    grid.appendChild(allDay);

    var scroller = h('div', { class: 'wk-scroll' });
    var bodyRow = h('div', { class: 'wk-body', style: 'height:' + (endHour - startHour) * HOUR + 'px' });
    var gutter = h('div', { class: 'wk-gutter wk-hours' });
    for (var hr = startHour; hr < endHour; hr += 1) {
      gutter.appendChild(h('span', { style: 'top:' + (hr - startHour) * HOUR + 'px', text: String(hr).padStart(2, '0') + ':00' }));
    }
    bodyRow.appendChild(gutter);
    days.forEach(function (iso) {
      var colEl = h('div', { class: 'wk-col' + (iso === today ? ' today' : ''), dataset: { on: iso } });
      for (var hr2 = startHour; hr2 < endHour; hr2 += 1) colEl.appendChild(h('i', { class: 'wk-line', style: 'top:' + (hr2 - startHour) * HOUR + 'px' }));
      var timed = items.filter(function (it) { return it.on === iso && it.at; }).map(function (it) {
        var a = minutesOfClock(it.at); var b = minutesOfClock(it.to);
        if (b === null || b <= a) b = a + (it.point ? 30 : 60);
        return Object.assign({}, it, { _a: a, _b: b });
      });
      timed.filter(function (it) { return it.background; }).forEach(function (it) {
        colEl.appendChild(h('div', { class: 'wk-office', style: 'top:' + ((it._a - startHour * 60) / 60) * HOUR + 'px;height:' + ((it._b - it._a) / 60) * HOUR + 'px',
          title: t('officeHours') + (it.sub ? ' · ' + it.sub : '') }, [h('span', { text: t('officeHours') })]));
      });
      var fore = timed.filter(function (it) { return !it.background; });
      lanes(fore);
      fore.forEach(function (it) { colEl.appendChild(blockFor(it, HOUR, startHour)); });
      if (iso === today) {
        var now = nowMinutes();
        if (now >= startHour * 60 && now <= endHour * 60) colEl.appendChild(h('i', { class: 'wk-now', style: 'top:' + ((now - startHour * 60) / 60) * HOUR + 'px' }));
      }
      // A click on an empty half hour starts an appointment there.
      colEl.addEventListener('click', function (e) {
        if (e.target !== colEl && !e.target.classList.contains('wk-line')) return;
        var box = colEl.getBoundingClientRect();
        var m = Math.floor((((e.clientY - box.top) / HOUR) * 60 + startHour * 60) / 30) * 30;
        openAppointment(null, { on: iso, at: clockOfMinutes(m), to: clockOfMinutes(m + 60) });
      });
      bodyRow.appendChild(colEl);
    });
    scroller.appendChild(bodyRow);
    grid.appendChild(scroller);
    requestAnimationFrame(function () {
      var target = Math.max(0, ((Math.max(8 * 60, nowMinutes() - 90) - startHour * 60) / 60) * HOUR);
      scroller.scrollTop = target;
    });
    return grid;
  }
  function nowMinutes() {
    var p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    return minutesOfClock(p);
  }

  /** One day, as a list down the page: all-day things first, then by the clock. */
  function dayTimeline(items, iso) {
    var mine = items.filter(function (it) { return it.on === iso; });
    var box = h('div', { class: 'day-tl' });
    var untimed = mine.filter(function (it) { return !it.at && !it.background; });
    var timed = mine.filter(function (it) { return it.at; }).sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    if (!untimed.length && !timed.length) {
      box.appendChild(h('div', { class: 'empty sched-empty' }, [icon('sun'), h('strong', { text: t('schedEmptyDay') }),
        h('button', { class: 'btn sm', text: '+ ' + t('apptNew'), onclick: function () { openAppointment(null, { on: iso }); } })]));
      return box;
    }
    if (untimed.length) {
      box.appendChild(h('div', { class: 'dtl-allday' }, untimed.map(function (it) {
        return h('button', { type: 'button', class: 'ad-chip k-' + it.kind, style: '--c:' + (it.colour || KIND_COLOUR[it.kind]), dataset: it.st ? { st: it.st } : {}, onclick: it.open },
          [h('small', { text: t('kind_' + it.kind) }), it.title]);
      })));
    }
    var now = iso === todayIso() ? nowMinutes() : null;
    var nowShown = false;
    var list = h('ul', { class: 'dtl-list' });
    timed.forEach(function (it) {
      if (now !== null && !nowShown && minutesOfClock(it.at) > now) {
        list.appendChild(h('li', { class: 'dtl-now' }, [h('span', { text: clockOfMinutes(now) })]));
        nowShown = true;
      }
      list.appendChild(h('li', { class: 'dtl-item k-' + it.kind + (it.faded ? ' faded' : '') + (it.background ? ' bg' : ''), style: '--c:' + (it.colour || KIND_COLOUR[it.kind]),
        dataset: it.st ? { st: it.st } : {}, onclick: it.open }, [
        h('span', { class: 'dtl-time' }, [h('b', { text: it.at }), it.to && !it.point ? h('small', { text: it.to }) : null]),
        h('span', { class: 'dtl-card' }, [
          h('small', { class: 'dtl-kind', text: t('kind_' + it.kind) + (it.reply === 'invited' ? ' · ' + t('rsvpAsk') : '') }),
          h('b', { text: it.title }),
          it.sub ? h('small', { text: it.sub }) : null,
        ]),
      ]));
    });
    if (now !== null && !nowShown) list.appendChild(h('li', { class: 'dtl-now' }, [h('span', { text: clockOfMinutes(now) })]));
    box.appendChild(list);
    return box;
  }

  function drawSide(side, items, r) {
    // Where the time goes.
    var al = allocation(items, r.from, r.to);
    var kinds = ['meeting', 'event', 'focus', 'personal', 'booking', 'google'];
    var parts = kinds.map(function (k) { return { value: al.mins[k] || 0, colour: KIND_COLOUR[k] }; });
    side.appendChild(h('section', { class: 'card alloc' }, [
      h('div', { class: 'card-head' }, [icon('pie'), h('h3', { text: r.view === 'week' ? t('allocWeek') : t('allocDay') })]),
      h('div', { class: 'donut-row' }, [
        /**
         * "8 ชม. 30 นาที" does not fit inside a 112px ring — on a computer it
         * ran out over the stroke on both sides and sat on top of the legend.
         * The ring says the number, the line under it says what it is.
         */
        h('div', { class: 'alloc-ring' }, [
          donut(parts, { size: 104, stroke: 15, center: shortHours(al.busy), sub: t('hrsUnit') }),
          h('small', { text: t('allocBooked') }),
        ]),
        h('ul', { class: 'legend' }, kinds.filter(function (k) { return al.mins[k]; }).map(function (k) {
          return h('li', {}, [h('i', { style: 'background:' + KIND_COLOUR[k] }), h('span', { text: t('kind_' + k) }), h('b', { text: hoursText(al.mins[k]) })]);
        }).concat([
          h('li', { class: 'free' }, [h('i', { style: 'background:var(--surface-3)' }),
            h('span', {}, [t('allocFree'), h('small', { text: t('allocFreeHow') })]),
            h('b', { text: hoursText(al.free) })]),
          al.tasks ? h('li', {}, [h('i', { style: 'background:' + KIND_COLOUR.task }), h('span', { text: t('allocDeadlines') }), h('b', { text: String(al.tasks) })]) : null,
        ])),
      ]),
    ]));

    // Google.
    var g = (S.sched && S.sched.googleStatus) || null;
    var gCard = h('section', { class: 'card gcard' }, [h('div', { class: 'card-head' }, [h('span', { class: 'g-logo', text: 'G' }), h('h3', { text: 'Google Calendar' })])]);
    if (!g) gCard.appendChild(h('p', { class: 'muted-line', text: t('loading') }));
    else if (!g.configured) gCard.appendChild(h('p', { class: 'muted-line', text: t('googleNotSetUp') }));
    else if (!g.linked) {
      gCard.appendChild(h('p', { class: 'muted-line', text: t('googleWhy') }));
      gCard.appendChild(h('a', { class: 'btn primary', href: '/api/auth?do=google-start', text: t('googleConnect') }));
    } else {
      gCard.appendChild(h('div', { class: 'g-who' }, [h('span', { class: 'g-ok' + (g.broken ? ' bad' : ''), text: g.broken ? '!' : '✓' }),
        h('span', {}, [h('b', { text: g.email || t('googleLinked') }), h('small', { text: g.broken ? t('googleBroken') : t('googleTwoWay') })])]));
      if (g.broken) gCard.appendChild(h('a', { class: 'btn primary sm', href: '/api/auth?do=google-start', text: t('googleReconnect') }));
      var pushBox = h('input', { type: 'checkbox', checked: g.pushEvents });
      pushBox.addEventListener('change', function () {
        api('/api/calendar?do=google', { method: 'PATCH', body: { pushEvents: pushBox.checked } })
          .then(function (d) { S.sched.googleStatus = d; if (d.pushEvents) syncGoogleNow(); }).catch(function () {});
      });
      gCard.appendChild(h('label', { class: 'inline-check g-push' }, [pushBox, t('googlePushEvents')]));
      gCard.appendChild(h('div', { class: 'g-actions' }, [
        h('button', { class: 'btn sm', text: t('googleSyncNow'), onclick: function (e) { syncGoogleNow(e.currentTarget); } }),
        h('button', { class: 'btn sm ghost', text: t('googleDisconnect'), onclick: function () {
          if (!confirm(t('googleDisconnectSure'))) return;
          api('/api/calendar?do=google', { method: 'DELETE' }).then(function () { S.schedLoaded = null; renderPage(); });
        } }),
      ]));
    }
    side.appendChild(gCard);

    // My office hours.
    var oh = (S.sched && S.sched.officeHours) || [];
    side.appendChild(h('section', { class: 'card ohcard' }, [
      h('div', { class: 'card-head' }, [icon('door'), h('h3', { text: t('officeHours') }), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', text: oh.length ? t('edit') : t('officeSet'), onclick: function () { openOfficeHours(); } })]),
      oh.length ? h('ul', { class: 'oh-list' }, oh.map(function (w) {
        return h('li', {}, [h('b', { text: t('wdl_' + w.day) }), h('span', { text: w.from + '–' + w.to }), h('small', { text: w.slot + ' ' + t('minUnit') + (w.place ? ' · ' + w.place : '') })]);
      })) : h('p', { class: 'muted-line', text: t('officeNone') }),
      oh.length ? h('button', { class: 'btn sm ghost copy-book', text: t('officeCopyLink'), onclick: function (e) {
        var link = location.origin + '/#/schedule?book=' + encodeURIComponent(S.user.username);
        var btn = e.currentTarget;
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () {
          btn.textContent = t('codeCopied'); setTimeout(function () { btn.textContent = t('officeCopyLink'); }, 1400);
        }).catch(function () { prompt(t('officeCopyLink'), link); });
      } }) : null,
    ]));

    // Legend.
    side.appendChild(h('section', { class: 'card legend-card' }, [
      h('ul', { class: 'kind-legend' }, ['meeting', 'event', 'task', 'focus', 'personal', 'booking', 'office', 'google'].map(function (k) {
        return h('li', {}, [h('i', { style: 'background:' + KIND_COLOUR[k] }), t('kind_' + k)]);
      })),
    ]));
  }

  function syncGoogleNow(btn) {
    if (btn) { btn.disabled = true; btn.textContent = t('googleSyncing'); }
    return api('/api/calendar?do=google-sync', { method: 'POST' }).then(function (d) {
      try { localStorage.setItem('fair-gsync', String(Date.now())); } catch (e) {}
      if (btn) { btn.textContent = d.ok ? t('googleSynced').replace('%n', String(d.sent || 0)) : t('googleSyncFail'); setTimeout(function () { btn.disabled = false; btn.textContent = t('googleSyncNow'); }, 2200); }
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = t('googleSyncFail'); } });
  }
  /** With "send meetings too" on, opening the page keeps Google current — at most hourly. */
  function maybeAutoSync(status) {
    if (!status || !status.linked || !status.pushEvents) return;
    var last = 0;
    try { last = Number(localStorage.getItem('fair-gsync')) || 0; } catch (e) {}
    if (Date.now() - last > 3600000) syncGoogleNow(null);
  }

  /* ---- appointments ---- */

  function formModal(title, bodyNodes, buttons, opts) {
    var veil = h('div', { class: 'veil' });
    var footer = h('footer', {}, buttons.concat([h('button', { class: 'btn', text: t('close'), onclick: function () { veil.remove(); } })]));
    veil.appendChild(h('div', { class: 'modal' + (opts && opts.wide ? ' wide' : '') + (opts && opts.cls ? ' ' + opts.cls : '') }, [
      h('header', {}, [h('h2', { text: title }), h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } })]),
      h('div', { class: 'body' }, bodyNodes),
      footer,
    ]));
    veil.addEventListener('click', function (e) { if (e.target === veil) veil.remove(); });
    $('modal-root').appendChild(veil);
    return veil;
  }
  function fieldOf(label, node, hint) {
    return h('div', { class: 'field' }, [h('label', { text: label }), node, hint ? h('small', { class: 'field-hint', text: hint }) : null]);
  }
  function refreshSchedule() { S.schedLoaded = null; if (S.page === 'schedule' || S.page === 'home') renderPage(); }

  function openAppointment(appt, preset) {
    if (appt) {
      var veil = formModal(appt.title, [
        h('div', { class: 'view-rows' }, [
          vRow(t('kind'), h('span', { class: 'kind-pill', style: '--c:' + KIND_COLOUR[appt.kind], text: t('kind_' + appt.kind) })),
          vRow(t('when'), document.createTextNode(whenWording(appt.on, appt.at, appt.to))),
          appt.with ? vRow(t('withWhom'), h('span', { class: 'chip who' }, [avatarNode(appt.with, 'sm'), nameOf(appt.with)])) : null,
          appt.place ? vRow(t('mtgPlace'), document.createTextNode(appt.place)) : null,
          appt.note ? vRow(t('note'), h('span', { style: 'white-space:pre-wrap', text: appt.note })) : null,
        ].filter(Boolean)),
      ], appt.mine ? [h('button', { class: 'btn danger', text: appt.bookingId ? t('bookingCancel') : t('apptDelete'), onclick: function () {
        if (!confirm(appt.bookingId ? t('bookingCancelSure') : t('apptDeleteSure'))) return;
        api('/api/calendar?do=appt&id=' + encodeURIComponent(appt.id), { method: 'DELETE' })
          .then(function () { veil.remove(); refreshSchedule(); }).catch(function (err) { alert(errText(err.code)); });
      } })] : []);
      return;
    }
    preset = preset || {};
    var kind = preset.kind || 'personal';
    var kindSeg = h('div', { class: 'seg' }, [['personal', 'kind_personal'], ['focus', 'kind_focus']].map(function (k) {
      return h('button', { type: 'button', class: kind === k[0] ? 'on' : '', text: t(k[1]), onclick: function (e) {
        kind = k[0]; kindSeg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === e.currentTarget); });
      } });
    }));
    var title = h('input', { type: 'text', maxlength: '200', placeholder: t('apptTitleHint') });
    var on = h('input', { type: 'date', value: preset.on || todayIso() });
    var at = h('input', { type: 'time', value: preset.at || '10:00' });
    var to = h('input', { type: 'time', value: preset.to || '11:00' });
    var place = h('input', { type: 'text', maxlength: '200' });
    var note = h('textarea', { rows: '2', maxlength: '2000' });
    var err = h('div', { class: 'notice err', hidden: true });
    at.addEventListener('change', function () {
      var a = minutesOfClock(at.value); var b = minutesOfClock(to.value);
      if (a !== null && (b === null || b <= a)) to.value = clockOfMinutes(a + 60);
    });
    var v = formModal(t('apptNew'), [err, fieldOf(t('kind'), kindSeg), fieldOf(t('apptTitle'), title),
      fieldOf(t('when'), on), h('div', { class: 'two' }, [fieldOf(t('from'), at), fieldOf(t('to'), to)]),
      fieldOf(t('mtgPlace'), place), fieldOf(t('note'), note),
      h('p', { class: 'hint', text: t('apptPrivate') })],
    [h('button', { class: 'btn primary', text: t('save'), onclick: function () {
      api('/api/calendar?do=appt', { method: 'POST', body: { kind: kind, title: title.value, on: on.value, at: at.value, to: to.value, place: place.value, note: note.value } })
        .then(function () { v.remove(); refreshSchedule(); })
        .catch(function (e) { err.hidden = false; err.textContent = errText(e.code); });
    } })]);
    setTimeout(function () { title.focus(); }, 30);
  }

  /* ---- office hours ---- */

  function openOfficeHours() {
    var rows = [];
    var list = h('div', { class: 'oh-edit' });
    var err = h('div', { class: 'notice err', hidden: true });

    /**
     * One row can be several days at the same hours.
     *
     * Office hours are nearly always "Tuesday and Thursday afternoon", and
     * setting that up a day at a time — four fields each — is why most people
     * never set any up at all. A row saves one window per day ticked.
     */
    function addRow(w) {
      w = w || { days: ['mon'], from: '13:00', to: '15:00', slot: 30, place: '' };
      var days = dayPicker(w.days || [w.day || 'mon']);
      var from = h('input', { type: 'time', value: w.from });
      var to = h('input', { type: 'time', value: w.to });
      var slot = h('select', {}, [15, 20, 30, 45, 60, 90].map(function (n) { return h('option', { value: String(n), text: n + ' ' + t('minUnit'), selected: n === Number(w.slot) }); }));
      var place = h('input', { type: 'text', value: w.place || '', placeholder: t('officePlaceHint'), maxlength: '200' });
      var row = h('div', { class: 'oh-row' }, [
        days,
        h('span', { class: 'oh-times' }, [from, h('span', { text: '–' }), to]),
        slot, place,
        h('button', { type: 'button', class: 'btn ghost sm', text: '✕', 'aria-label': t('remove'), onclick: function () {
          rows = rows.filter(function (r) { return r.row !== row; }); row.remove();
        } }),
      ]);
      rows.push({
        row: row,
        get: function () {
          return days.chosen().map(function (d) {
            return { day: d, from: from.value, to: to.value, slot: Number(slot.value), place: place.value };
          });
        },
      });
      list.appendChild(row);
    }

    /**
     * Rows gathered back up: the same hours on several days arrive from the
     * server as one window each, and showing seven identical rows for
     * "every weekday 15:00–17:00" would undo the point of the day chips.
     */
    function fill(windows) {
      var groups = [];
      (windows || []).forEach(function (w) {
        var same = groups.filter(function (g) {
          return g.from === w.from && g.to === w.to && Number(g.slot) === Number(w.slot) && (g.place || '') === (w.place || '');
        })[0];
        if (same) same.days.push(w.day);
        else groups.push({ days: [w.day], from: w.from, to: w.to, slot: w.slot, place: w.place });
      });
      if (!groups.length) addRow();
      else groups.forEach(addRow);
    }

    /**
     * "Use the hours I already said I am free."
     *
     * Most people have filled in ว่างประจำสัปดาห์ on their profile for the
     * clash warnings, and then been asked the same question again here. This
     * copies it across; they can then trim it, because being free is not
     * quite the same as inviting people to turn up.
     */
    var useFree = h('button', {
      type: 'button', class: 'btn sm',
      onclick: function () {
        useFree.disabled = true;
        api('/api/users?do=free').then(function (d) {
          var got = (d && d.windows) || [];
          if (!got.length) { err.hidden = false; err.textContent = t('officeNoAvailability'); useFree.disabled = false; return; }
          err.hidden = true;
          rows = [];
          clear(list);
          fill(got.map(function (w) { return { day: w.day, from: w.from, to: w.to, slot: 30, place: '' }; }));
          useFree.disabled = false;
        }).catch(function () { useFree.disabled = false; });
      },
    }, [icon('clock'), h('span', { text: t('officeFromAvailability') })]);

    var v = formModal(t('officeHours'), [
      h('p', { class: 'hint', text: t('officeHowTo') }), err, list,
      h('div', { class: 'oh-actions' }, [
        h('button', { type: 'button', class: 'btn sm', text: '+ ' + t('officeAdd'), onclick: function () { addRow(); } }),
        useFree,
      ]),
      h('p', { class: 'hint', text: t('officeFromAvailabilityWhy') }),
    ], [h('button', { class: 'btn primary', text: t('save'), onclick: function () {
      var windows = rows.reduce(function (all, r) { return all.concat(r.get()); }, []);
      api('/api/calendar?do=office', { method: 'PUT', body: { windows: windows } })
        .then(function () { v.remove(); refreshSchedule(); })
        .catch(function (e) { err.hidden = false; err.textContent = errText(e.code); });
    } })], { wide: true });

    var mineNow = (S.sched && S.sched.officeHours) || null;
    if (mineNow) fill(mineNow);
    else api('/api/calendar?do=office').then(function (d) { fill(d.windows); }).catch(function () { addRow(); });
  }

  /* ---- booking someone's office hours ---- */

  function openBooking(host) {
    var body = h('div', { class: 'book' });
    var v = formModal(t('bookSlot'), [body], [], { wide: true });
    function chooseHost() {
      clear(body);
      body.appendChild(h('p', { class: 'hint', text: t('bookPickHost') }));
      var box = h('div', { class: 'host-list' }, [h('p', { class: 'muted-line', text: t('loading') })]);
      body.appendChild(box);
      api('/api/calendar?do=hosts').then(function (d) {
        clear(box);
        var hosts = d.hosts.filter(function (x) { return x.username !== S.user.username; });
        if (!hosts.length) { box.appendChild(h('p', { class: 'muted-line', text: t('bookNoHosts') })); return; }
        hosts.forEach(function (x) {
          var u = userBy(x.username);
          box.appendChild(h('button', { type: 'button', class: 'host', onclick: function () { showSlots(x.username); } }, [
            avatarNode(x.username), h('span', {}, [h('b', { text: nameOf(x.username) }), h('small', { text: (u && u.position) || '' })]), h('span', { class: 'grow' }), h('span', { text: '›' }),
          ]));
        });
      }).catch(function () { clear(box); box.appendChild(h('p', { class: 'muted-line', text: t('errOffline') })); });
    }
    function showSlots(who) {
      clear(body);
      body.appendChild(h('div', { class: 'book-head' }, [
        h('button', { type: 'button', class: 'btn ghost sm', text: '‹ ' + t('back'), onclick: chooseHost }),
        avatarNode(who), h('b', { text: nameOf(who) }),
      ]));
      var slotsBox = h('div', { class: 'slot-days' }, [h('p', { class: 'muted-line', text: t('loading') })]);
      body.appendChild(slotsBox);
      var from = todayIso();
      api('/api/calendar?do=slots&host=' + encodeURIComponent(who) + '&from=' + from + '&to=' + addDays(from, 20)).then(function (d) {
        clear(slotsBox);
        if (!d.slots.length) { slotsBox.appendChild(h('p', { class: 'muted-line', text: d.windows.length ? t('bookFull') : t('bookNoHours') })); return; }
        if (d.slots.some(function (sl) { return sl.taken; })) {
          slotsBox.appendChild(h('p', { class: 'hint', text: t('bookTakenHint') }));
        }
        var byDay = {};
        d.slots.forEach(function (sl) { (byDay[sl.on] = byDay[sl.on] || []).push(sl); });
        Object.keys(byDay).sort().forEach(function (on) {
          slotsBox.appendChild(h('div', { class: 'slot-day' }, [
            h('div', { class: 'sd-date' }, [h('b', { text: fmtDate(on, { weekday: 'short', day: 'numeric', month: 'short' }) }), byDay[on][0].place ? h('small', { text: byDay[on][0].place }) : null]),
            h('div', { class: 'sd-times' }, byDay[on].map(function (sl) {
              /**
               * A busy slot is shown, not hidden. Hiding it read as "she is
               * closed then", so nobody asked; now it says the host has
               * something — never what — and the ask is still possible.
               */
              return h('button', {
                type: 'button', class: 'slot' + (sl.taken ? ' taken' : ''),
                title: sl.taken ? t(sl.reason === 'booking' ? 'bookTakenBooked' : 'bookTakenBusy') : '',
                onclick: function () { confirmSlot(who, sl); },
              }, [sl.at, sl.taken ? h('small', { text: t('bookBusyShort') }) : null]);
            })),
          ]));
        });
      }).catch(function () { clear(slotsBox); slotsBox.appendChild(h('p', { class: 'muted-line', text: t('errOffline') })); });
    }
    function confirmSlot(who, sl) {
      clear(body);
      var note = h('textarea', { rows: '3', maxlength: '1000', placeholder: t('bookNoteHint') });
      var err = h('div', { class: 'notice err', hidden: true });
      body.appendChild(h('div', { class: 'book-confirm' }, [
        h('div', { class: 'bc-card' + (sl.taken ? ' busy' : '') }, [avatarNode(who, 'lg'), h('div', {}, [
          h('b', { text: nameOf(who) }),
          h('span', { text: whenWording(sl.on, sl.at, sl.to) }),
          sl.place ? h('small', { text: sl.place }) : null,
        ])]),
        // Said before they press, rather than refused after.
        sl.taken ? h('div', { class: 'notice warn', text: t(sl.reason === 'booking' ? 'bookTakenBooked' : 'bookTakenBusy') }) : null,
        err, fieldOf(t('bookNote'), note),
        h('div', { class: 'bc-actions' }, [
          h('button', { class: 'btn', text: '‹ ' + t('back'), onclick: function () { showSlots(who); } }),
          h('button', { class: 'btn primary', text: t('bookConfirm'), onclick: function (e) {
            e.currentTarget.disabled = true;
            api('/api/calendar?do=book', { method: 'POST', body: { host: who, on: sl.on, at: sl.at, note: note.value, anyway: Boolean(sl.taken) } })
              .then(function () {
                clear(body);
                body.appendChild(h('div', { class: 'book-done' }, [h('span', { class: 'bd-tick', text: '✓' }),
                  h('b', { text: t('bookDone') }), h('span', { text: nameOf(who) + ' · ' + whenWording(sl.on, sl.at, sl.to) }),
                  sl.taken ? h('small', { text: t('bookDoneBusy') }) : null]));
                refreshSchedule();
              })
              .catch(function (x) {
                err.hidden = false; err.textContent = errText(x.code);
                // Somebody took it in the meantime: back to the list, which
                // will now show it as taken rather than simply losing it.
                if (x.code === 'SLOT_TAKEN' || x.code === 'NOT_OFFERED') setTimeout(function () { showSlots(who); }, 1400);
              });
          } }),
        ]),
      ]));
    }
    if (host) showSlots(host); else chooseHost();
    return v;
  }

  /* ---- finding a time for several people ---- */

  /**
   * Who is free when, Outlook-style: pick people, a length and a range; the
   * answer is the times when nobody is busy, and a row per person showing
   * their busy blocks on the day picked, so it is plain why a time is or is
   * not on the list. Picking a time opens a new meeting already filled in.
   */
  function openFindTime(preset) {
    preset = preset || {};
    var draft = { assignees: (preset.people || []).slice() };
    var pickBox = h('div', { class: 'picker' });
    buildPeoplePicker(pickBox, draft, { compact: true });
    var dur = h('select', {}, [30, 45, 60, 90, 120, 180].map(function (n) { return h('option', { value: String(n), text: hoursText(n), selected: n === 60 }); }));
    var from = h('input', { type: 'date', value: preset.fromOn || todayIso() });
    var span = h('select', {}, [[3, 'findNext3'], [7, 'findNext7'], [14, 'findNext14']].map(function (x) { return h('option', { value: String(x[0]), text: t(x[1]), selected: x[0] === 7 }); }));
    var dayFrom = h('input', { type: 'time', value: '09:00' });
    var dayTo = h('input', { type: 'time', value: '20:00' });
    var weekends = h('input', { type: 'checkbox' });
    var out = h('div', { class: 'find-out' });
    var go = h('button', { class: 'btn primary', text: t('findGo') });
    var v = formModal(t('findTime'), [
      fieldOf(t('findWho'), pickBox, t('findWhoHint')),
      h('div', { class: 'find-opts' }, [fieldOf(t('findLength'), dur), fieldOf(t('findFrom'), from), fieldOf(t('findSpan'), span),
        fieldOf(t('findHours'), h('div', { class: 'two-inline' }, [dayFrom, h('span', { text: '–' }), dayTo]))]),
      h('label', { class: 'inline-check' }, [weekends, t('findWeekends')]),
      out,
    ], [go], { wide: true, cls: 'find-modal' });

    go.addEventListener('click', function () {
      clear(out);
      out.appendChild(h('p', { class: 'muted-line', text: t('findLooking') }));
      var body = { people: draft.assignees, duration: Number(dur.value), fromOn: from.value, toOn: addDays(from.value, Number(span.value) - 1),
        dayFrom: dayFrom.value, dayTo: dayTo.value, weekends: weekends.checked };
      api('/api/calendar?do=find', { method: 'POST', body: body }).then(function (d) { drawFound(d); })
        .catch(function (e) { clear(out); out.appendChild(h('div', { class: 'notice err', text: errText(e.code) })); });
    });

    function drawFound(d) {
      clear(out);
      out.appendChild(h('div', { class: 'notice ' + (d.allFree ? 'ok' : 'warn'),
        text: (d.allFree ? t('findAllFree').replace('%n', String(d.people.length)) : t('findNoneFree')) +
          ' · ' + t('findPickAnyway') }));
      if (d.google.length) out.appendChild(h('p', { class: 'hint', text: t('findGoogleCounted').replace('%n', String(d.google.length)) }));
      var chosen = d.slots[0];
      var listBox = h('div', { class: 'found' });
      var assist = h('div', { class: 'assist' });
      out.appendChild(listBox);
      out.appendChild(assist);
      function drawList() {
        clear(listBox);
        var byDay = {};
        d.slots.forEach(function (sl) { (byDay[sl.on] = byDay[sl.on] || []).push(sl); });
        Object.keys(byDay).sort().forEach(function (on) {
          listBox.appendChild(h('div', { class: 'slot-day' }, [
            h('div', { class: 'sd-date' }, [h('b', { text: fmtDate(on, { weekday: 'short', day: 'numeric', month: 'short' }) })]),
            h('div', { class: 'sd-times' }, byDay[on].map(function (sl) {
              /**
               * Busy times are on the list and can be picked. The committee
               * meets when it has to; whoever is calling it can see who they
               * are pulling away from something and decide.
               */
              var cls = 'slot' + (sl === chosen ? ' on' : '') +
                (sl.busy.length ? ' partial' : (sl.outside.length ? ' outside' : ''));
              var why = sl.busy.length ? t('findBusyNames') + ': ' + sl.busy.map(nameOf).join(', ')
                : sl.outside.length ? t('findOutsideNames') + ': ' + sl.outside.map(nameOf).join(', ') : '';
              return h('button', { type: 'button', class: cls, title: why,
                onclick: function () { chosen = sl; drawList(); drawAssist(); } },
              [sl.at + '–' + sl.to,
                sl.busy.length ? h('small', { text: ' ' + sl.busy.length + ' ' + t('findBusyN') })
                  : sl.outside.length ? h('small', { text: ' ' + t('findOutsideShort') }) : null]);
            })),
          ]));
        });
      }
      function drawAssist() {
        clear(assist);
        if (!chosen) return;
        var a0 = minutesOfClock(dayFrom.value) || 480; var a1 = minutesOfClock(dayTo.value) || 1200;
        var spanMin = a1 - a0;
        var pos = function (m) { return Math.max(0, Math.min(100, ((m - a0) / spanMin) * 100)); };
        var ruler = h('div', { class: 'as-ruler' });
        for (var hr = Math.ceil(a0 / 60); hr <= Math.floor(a1 / 60); hr += 1) ruler.appendChild(h('span', { style: 'left:' + pos(hr * 60) + '%', text: String(hr) }));
        assist.appendChild(h('div', { class: 'as-head' }, [h('b', { text: fmtDate(chosen.on, { weekday: 'long', day: 'numeric', month: 'long' }) }),
          chosen.busy.length ? h('span', { class: 'as-warn', text: t('findWillClash').replace('%n', String(chosen.busy.length)) }) : null,
          h('span', { class: 'grow' }),
          h('button', { class: 'btn primary sm', text: t('findMakeMeeting'), onclick: function () {
            v.remove();
            openMeeting(null, { meetsOn: chosen.on, meetsAt: chosen.at, endsAt: chosen.to, people: d.people });
          } })]));
        var rowsBox = h('div', { class: 'as-rows' }, [h('div', { class: 'as-row as-ruler-row' }, [h('span', { class: 'as-name' }), ruler])]);
        var slotA = minutesOfClock(chosen.at); var slotB = minutesOfClock(chosen.to);
        d.people.forEach(function (u) {
          var track = h('div', { class: 'as-track' });
          (d.busy[u] || []).filter(function (b) { return b.on === chosen.on; }).forEach(function (b) {
            track.appendChild(h('i', { class: 'as-busy k-' + b.kind, style: 'left:' + pos(b.from) + '%;width:' + Math.max(0.6, pos(b.to) - pos(b.from)) + '%' }));
          });
          track.appendChild(h('i', { class: 'as-slot' + (chosen.busy.indexOf(u) !== -1 ? ' clash' : ''), style: 'left:' + pos(slotA) + '%;width:' + (pos(slotB) - pos(slotA)) + '%' }));
          rowsBox.appendChild(h('div', { class: 'as-row' + (chosen.busy.indexOf(u) !== -1 ? ' busy' : '') }, [
            h('span', { class: 'as-name' }, [avatarNode(u, 'sm'), h('span', { text: nameOf(u) }), d.google.indexOf(u) !== -1 ? h('small', { class: 'g-tag', text: 'G' }) : null]),
            track,
          ]));
        });
        assist.appendChild(rowsBox);
        assist.appendChild(h('div', { class: 'as-key' }, [h('i', { class: 'as-busy' }), t('findKeyBusy'), h('i', { class: 'as-slot' }), t('findKeySlot')]));
      }
      drawList();
      drawAssist();
    }
    if (preset.people && preset.people.length) go.click();
  }

  /* ---------- spaces ----------------------------------------------------- */

  function reloadSpaces() {
    return api('/api/tasks?do=spaces').then(function (d) { S.spaces = d.spaces || []; renderShell(); return S.spaces; });
  }

  /** People in a space, as usernames: by name, and through their department. */
  function spaceMembers(sp) {
    var names = {};
    names[sp.createdBy] = true;
    (sp.members || []).forEach(function (m) { names[m.username] = true; });
    S.users.forEach(function (u) {
      if (!u.active) return;
      if ((sp.departments || []).some(function (d) { return d.key === u.department && (!d.unit || d.unit === (u.unit || '')); })) names[u.username] = true;
    });
    return Object.keys(names);
  }

  function pageSpace(main) {
    var sp = spaceBy(S.spaceId);
    if (!sp) {
      main.appendChild(h('div', { class: 'empty' }, [h('strong', { text: t('spaceGone') }),
        h('a', { class: 'btn', href: '#/home', text: t('navHome') })]));
      return;
    }
    var phone = isPhone();
    var view = S.spaceView || 'list';
    main.classList.toggle('board-wide', (view === 'board' || view === 'gantt') && !phone);
    var rows = S.tasks.filter(function (x) { return x.spaceId === sp.id && matchesQuery(x); });
    var open = rows.filter(function (x) { return x.status !== 'done'; }).length;
    var done = rows.length - open;
    var people = spaceMembers(sp);

    // The band, in the space's colour.
    main.appendChild(h('section', { class: 'space-band', style: '--sp:' + spaceHex(sp) }, [
      spaceBadge(sp, 'sp-big'),
      h('div', { class: 'sp-band-tx' }, [
        h('h2', { text: sp.name }),
        sp.description ? h('p', { text: sp.description }) : null,
        h('div', { class: 'sp-meta' }, [
          h('span', { class: 'stack' }, people.slice(0, 7).map(function (u) { return avatarNode(u, 'sm'); })),
          h('small', { text: t('spacePeopleN').replace('%n', String(people.length)) }),
          (sp.departments || []).length ? h('small', { text: '· ' + sp.departments.map(function (d) { return deptLabel(d.key) + (d.unit ? ' / ' + d.unit : ''); }).join(', ') }) : null,
        ]),
      ]),
      h('div', { class: 'sp-band-stats' }, [
        donut([{ value: done, colour: '#ffffff' }, { value: open, colour: 'rgba(255,255,255,.25)' }],
          { size: phone ? 64 : 84, stroke: phone ? 8 : 10, center: rows.length ? Math.round((done / rows.length) * 100) + '%' : '—' }),
      ]),
    ]));

    // What can be done here.
    main.appendChild(h('div', { class: 'page-head space-head' }, [
      h('div', { class: 'seg view-seg' }, [['list', 'viewList', 'list'], ['board', 'viewBoard', 'board'], ['gantt', 'viewGantt', 'gantt']].map(function (x) {
        return h('button', { class: view === x[0] ? 'on' : '', title: t(x[1]), onclick: function () { S.spaceView = x[0]; renderPage(); } },
          [icon(x[2]), phone ? null : h('span', { text: t(x[1]) })]);
      })),
      h('span', { class: 'grow' }),
      sp.mayManage ? h('button', { class: 'btn', onclick: function () { openSpace(sp); } }, [icon('gear'), phone ? null : h('span', { text: t('spaceManage') })]) : null,
      !sp.mayManage && sp.mine && sp.createdBy !== S.user.username ? h('button', { class: 'btn ghost', text: t('spaceLeave'), onclick: function () {
        if (!confirm(t('spaceLeaveSure'))) return;
        api('/api/tasks?do=space-leave', { method: 'POST', body: { id: sp.id } }).then(function (d) { S.spaces = d.spaces; location.hash = '#/home'; })
          .catch(function (e) { alert(errText(e.code)); });
      } }) : null,
      mayCallMeeting() ? h('button', { class: 'btn', onclick: function () { openMeeting(null, { spaceId: sp.id, people: people.slice(0, 40) }); } }, [icon('meeting'), phone ? null : h('span', { text: t('mtgNew') })]) : null,
      mayCreate() ? h('button', { class: 'btn primary', onclick: function () { S.newTaskSpace = sp.id; openTask(null); } }, [icon('plus'), h('span', { text: t('newTask') })]) : null,
    ]));

    // Meetings in this space that are still ahead.
    var meetings = (S.meetings || []).filter(function (m) { return m.spaceId === sp.id && m.meetsOn >= todayIso() && m.status !== 'cancelled'; })
      .sort(function (a, b) { return a.meetsOn < b.meetsOn ? -1 : 1; }).slice(0, 4);
    if (meetings.length) {
      main.appendChild(h('div', { class: 'sp-meetings' }, meetings.map(function (m) {
        return h('button', { type: 'button', class: 'sp-mtg', onclick: function () { openMeeting(m); } }, [
          icon('meeting'), h('span', {}, [h('b', { text: m.title }), h('small', { text: fmtDate(m.meetsOn, { weekday: 'short', day: 'numeric', month: 'short' }) + (m.meetsAt ? ' · ' + m.meetsAt : '') })]),
        ]);
      })));
    }

    if (!rows.length) {
      main.appendChild(h('div', { class: 'empty' }, [h('strong', { text: t('spaceEmpty') }), t('spaceEmptySub')]));
      return;
    }
    if (view === 'board') main.appendChild(kanbanBoard(rows, phone));
    else if (view === 'gantt') main.appendChild(ganttChart(rows, { phone: phone }));
    else main.appendChild(groupedList(rows));
  }

  /** Starting a space, or changing one: name, colour, a letter or emoji, who is in it. */
  function openSpace(sp) {
    var isNew = !sp;
    var draft = {
      name: sp ? sp.name : '',
      description: sp ? sp.description : '',
      colour: sp ? sp.colour : 'pink',
      icon: sp ? sp.icon : '',
      members: sp ? (sp.members || []).map(function (m) { return m.username; }).filter(function (u) { return u !== sp.createdBy; }) : [],
      departments: sp ? (sp.departments || []).map(function (d) { return d.key; }) : [],
    };
    var err = h('div', { class: 'notice err', hidden: true });
    var name = h('input', { type: 'text', maxlength: '80', value: draft.name, placeholder: t('spaceNameHint') });
    var desc = h('textarea', { rows: '2', maxlength: '500', placeholder: t('spaceDescHint') });
    desc.value = draft.description;
    var iconIn = h('input', { type: 'text', maxlength: '4', value: draft.icon, placeholder: 'A', class: 'icon-in' });
    var preview = h('span', { class: 'sp-preview' });
    function paintPreview() {
      clear(preview);
      preview.appendChild(spaceBadge({ name: name.value || '?', icon: iconIn.value, colour: draft.colour }, 'sp-big'));
    }
    var swatches = h('div', { class: 'swatches sp-swatches' }, Object.keys(SPACE_HEX).map(function (c) {
      return h('button', { type: 'button', class: 'swatch' + (draft.colour === c ? ' on' : ''), style: 'background:' + SPACE_HEX[c], 'aria-label': c,
        onclick: function (e) {
          draft.colour = c;
          swatches.querySelectorAll('.swatch').forEach(function (b) { b.classList.toggle('on', b === e.currentTarget); });
          paintPreview();
        } });
    }));
    name.addEventListener('input', paintPreview);
    iconIn.addEventListener('input', paintPreview);
    paintPreview();

    var pickBox = h('div', { class: 'picker' });
    var owner = sp ? sp.createdBy : S.user.username;
    buildPeoplePicker(pickBox, draft, { field: 'members', skip: function (u) { return u === owner; }, compact: true });
    var deptBox = h('div', { class: 'checks sp-depts' }, (S.departments || []).map(function (d) {
      var cb = h('input', { type: 'checkbox', checked: draft.departments.indexOf(d.key) !== -1 });
      cb.addEventListener('change', function () {
        draft.departments = draft.departments.filter(function (k) { return k !== d.key; });
        if (cb.checked) draft.departments.push(d.key);
      });
      return h('label', {}, [cb, deptLabel(d.key)]);
    }));

    var buttons = [h('button', { class: 'btn primary', text: isNew ? t('spaceCreate') : t('save'), onclick: function () {
      var body = { name: name.value, description: desc.value, colour: draft.colour, icon: iconIn.value.trim(),
        members: draft.members, departments: draft.departments.map(function (k) { return { key: k }; }) };
      if (!isNew) body.id = sp.id;
      api('/api/tasks?do=space', { method: isNew ? 'POST' : 'PATCH', body: body }).then(function (d) {
        S.spaces = d.spaces || S.spaces;
        v.remove();
        if (isNew && d.id) location.hash = '#/space/' + encodeURIComponent(d.id);
        renderShell(); renderPage();
      }).catch(function (e) { err.hidden = false; err.textContent = errText(e.code); });
    } })];
    if (!isNew && sp.mayManage) {
      buttons.push(h('button', { class: 'btn danger', text: t('spaceArchive'), onclick: function () {
        if (!confirm(t('spaceArchiveSure'))) return;
        api('/api/tasks?do=space&id=' + encodeURIComponent(sp.id), { method: 'DELETE' }).then(function (d) {
          S.spaces = d.spaces || [];
          v.remove();
          api('/api/tasks').then(function (x) { S.tasks = x.tasks; location.hash = '#/home'; renderShell(); renderPage(); });
        }).catch(function (e) { alert(errText(e.code)); });
      } }));
    }
    var v = formModal(isNew ? t('spaceNew') : t('spaceManage'), [
      h('p', { class: 'hint', text: t('spaceWhat') }), err,
      h('div', { class: 'sp-ident' }, [preview, h('div', { class: 'grow' }, [fieldOf(t('spaceName'), name)]), fieldOf(t('spaceIcon'), iconIn)]),
      fieldOf(t('spaceColour'), swatches),
      fieldOf(t('spaceDesc'), desc),
      fieldOf(t('spaceMembers'), pickBox, t('spaceMembersHint')),
      fieldOf(t('spaceDepts'), deptBox, t('spaceDeptsHint')),
    ], buttons, { wide: true });
    setTimeout(function () { name.focus(); }, 30);
  }

  /**
   * A page left open all evening.
   *
   * "ที่กำลังจะถึง" and today's timeline are worked out from the clock, so a
   * tab opened at five in the afternoon still showed the five o'clock meeting
   * at nine. Every five minutes, if nothing is open on top and nobody is
   * typing, the page is drawn again — cheap, because it uses the data already
   * loaded and never asks the server for anything.
   */
  var clockWatch = null;
  function watchTheClock() {
    if (clockWatch) return;
    clockWatch = setInterval(function () {
      if (!S.user) return;
      if (document.hidden) return;
      if ($('modal-root') && $('modal-root').childElementCount) return;
      var el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      renderPage();
    }, 5 * 60 * 1000);
  }

  function boot() {
    // Somebody in English waits the moment it takes to fetch the English table, rather than seeing Thai flash first.
    if (S.lang === 'en' && !window.STRINGS.en) { ensureLang('en', boot); return; }
    return Promise.all([
      api('/api/meta'),
      api('/api/users'),
      api('/api/tasks'),
      api('/api/notifications'),
      api('/api/events'),
      api('/api/events?do=meetings').catch(function () { return { meetings: [] }; }),
      api('/api/tasks?do=spaces').catch(function () { return { spaces: [] }; }),
      // My own labels. Caught rather than awaited hard: a page that will not
      // load because somebody's private tags would not come back is absurd.
      api('/api/users?do=tags').catch(function () { return { tags: [] }; }),
    ]).then(function (res) {
      S.spaces = (res[6] && res[6].spaces) || [];
      S.myTags = (res[7] && res[7].tags) || [];
      S.serverVersion = res[0].version || null;
      S.departments = res[0].departments;
      S.circles = res[0].circles || [];
      S.accessOrder = res[0].accessOrder || [];
      S.users = res[1].users;
      S.canManage = res[1].canManage;
      S.canApprove = ['editor', 'coadmin', 'admin'].indexOf(S.user.access) !== -1;
      S.canSetAccess = Boolean(res[1].canSetAccess);
      S.sheetWritable = Boolean(res[1].sheetWritable);
      S.lastSync = res[1].lastSync;
      S.sheetId = res[1].sheetId;
      S.tasks = res[2].tasks;
      S.seesEverything = Boolean(res[2].seesEverything);
      S.myDepartments = res[2].myDepartments || [];
      S.notifs = res[3].notifications;
      S.unread = res[3].unread;
      S.events = res[4].events;
      S.meetings = (res[5] && res[5].meetings) || [];
      S.colours = res[4].colours;
      routeFromHash();
      renderShell();
      renderPage();
      // The list is loaded by now, so a link followed from LINE can open.
      flushPendingTask();
      refreshSubscription();
      showPending();
      // After whatever they came for has had its turn — see maybeShowGuide.
      setTimeout(maybeShowGuide, 1200);
      // And the committee's own notice, which waits for the guide to be done
      // with somebody before it interrupts them — see maybeShowPopup.
      setTimeout(maybeShowPopup, 2600);
      // What this person wants to be told about, for the switches inside tasks.
      loadNotify();
      watchTheClock();
    }).catch(function (err) {
      if (err.code === 'NOT_SIGNED_IN') { S.user = null; renderAuth(); return; }
      alert(err.code === 'NO_DATABASE' ? t('noDatabase') : t('errOffline'));
    });
  }

  try {
    var saved = localStorage.getItem('fair-lang');
    if (saved) S.lang = saved;
  } catch (e) {}
  // Start fetching English now, alongside the sign-in check, so it is usually here before anything draws.
  if (S.lang === 'en') ensureLang('en');

  // Read the theme before the first paint so the page never flashes the wrong one.
  try { applyTheme(localStorage.getItem('fair-theme') || 'system'); } catch (e) { applyTheme('system'); }

  /**
   * Who is this, and is the system open yet.
   *
   * Asked together because the answer to the second only matters to somebody
   * with no session, and waiting for it in series would add a round trip to
   * every cold start. If the flag cannot be fetched the sign-in is shown — a
   * holding page that appears because a request failed would lock the
   * committee out of their own system.
   */
  Promise.all([
    api('/api/auth'),
    api('/api/meta').catch(function () { return {}; }),
  ]).then(function (res) {
    var data = res[0];
    S.comingSoon = Boolean(res[1] && res[1].comingSoon);
    S.opensAt = (res[1] && res[1].opensAt) || null;

    if (data.user) {
      S.user = data.user;
      S.lang = data.user.lang || S.lang;
      if (data.user.theme) applyTheme(data.user.theme);
      if (data.user.emailRequired) renderEmailGate(); else boot();
    }
    else renderAuth();
  }).catch(function (err) {
    renderAuth();
    if (err.code === 'NO_DATABASE') showAuthNotice(t('noDatabase'), 'warn');
    else if (err.code === 'SHEET_UNREADABLE') showAuthNotice((err.data && err.data.message) || t('errGeneric'), 'warn');
  });


  /* ======================================================================
     The pop-up that greets people when they open the app
     ====================================================================== */

  /**
   * Shows the committee's notice, once, if there is one.
   *
   * One interruption per visit, and the getting-started guide wins it.
   *
   * The rule is simply "is a dialog already up when my turn comes" — not "has
   * this person finished the guide". That distinction matters: the guide's
   * steps are optional and plenty of people will leave LINE unlinked for
   * good, so gating on a FINISHED guide would mean a large part of the
   * committee never saw a notice at all. Checking what is actually on screen
   * gets the behaviour that was wanted — the guide first on a first visit,
   * the notice from the next one — without quietly excluding anybody.
   *
   * And it gives up rather than queueing behind whatever is open. A box that
   * appears the instant somebody closes something else is a box they dismiss
   * with the same movement, having read none of it.
   */
  function maybeShowPopup() {
    if (!S.user) return;
    if (document.querySelector('#modal-root .veil')) return;
    api('/api/push?do=popup').then(function (d) {
      // Checked again on the way back: a dialog may have opened while the
      // request was in flight, and this one must never land on top of it.
      if (d.popup && !document.querySelector('#modal-root .veil')) openPopup(d.popup);
    }).catch(function () {});
  }

  /**
   * The box itself.
   *
   * Deliberately not dismissible by clicking the background. Every other
   * dialog in the app is, because every other dialog is something the person
   * asked for — this one they did not, and a notice that vanishes on a stray
   * tap near the edge has not been read. The ✕, the button and Escape all
   * close it; a click on the veil does not.
   *
   * It is recorded as seen when it CLOSES, not when it draws, so a box that
   * flashed up while the page was still settling comes back next time.
   */
  function openPopup(popup) {
    var veil = h('div', { class: 'veil pop-veil' });
    var done = false;

    function finish(clicked) {
      if (done) return;
      done = true;
      veil.remove();
      document.removeEventListener('keydown', onKey);
      api('/api/push?do=popup-seen', { method: 'POST', body: { id: popup.id, clicked: Boolean(clicked) } })
        .catch(function () {});
    }
    function onKey(e) { if (e.key === 'Escape') finish(false); }
    document.addEventListener('keydown', onKey);

    var parts = [];

    /**
     * The picture, with its own aspect ratio reserved before it arrives.
     *
     * The server read the real pixel size out of the file's header for exactly
     * this: without it the box is short, then grows when the image lands, and
     * the close button moves out from under a thumb already on its way down.
     */
    if (popup.hasImage) {
      var frame = h('div', { class: 'pop-img' });
      if (popup.imageW && popup.imageH) {
        frame.style.aspectRatio = popup.imageW + ' / ' + popup.imageH;
      }
      frame.appendChild(h('img', {
        src: '/api/push?do=popup-image&id=' + encodeURIComponent(popup.id),
        alt: popup.title,
        loading: 'eager',
      }));
      parts.push(frame);
    }

    parts.push(h('h2', { class: 'pop-title', text: popup.title }));
    // The body keeps the line breaks whoever wrote it typed, and nothing else:
    // one <p> per line rather than innerHTML, so a notice can never carry markup.
    if (popup.body) {
      parts.push(h('div', { class: 'pop-body' }, String(popup.body).split('\n').map(function (line) {
        return line.trim() ? h('p', { text: line }) : h('br', {});
      })));
    }

    var footer = [];
    if (popup.linkUrl) {
      footer.push(h('a', {
        class: 'btn primary grow', href: popup.linkUrl, target: '_blank', rel: 'noopener noreferrer',
        text: popup.linkLabel || t('popOpen'),
        onclick: function () { finish(true); },
      }));
    }
    footer.push(h('button', {
      type: 'button', class: 'btn' + (popup.linkUrl ? '' : ' primary grow'),
      text: t('popDismiss'), onclick: function () { finish(false); },
    }));

    var modal = h('div', { class: 'modal pop-modal', role: 'dialog', 'aria-modal': 'true' }, [
      h('header', {}, [
        h('span', { class: 'pop-tag', text: t('popTag') }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost sm', text: '✕', 'aria-label': t('close'),
          onclick: function () { finish(false); } }),
      ]),
      h('div', { class: 'body pop-content' }, parts),
      h('footer', {}, footer),
    ]);

    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
  }

  /* ======================================================================
     The shelf: important links, in folders
     ====================================================================== */

  /**
   * One page, one fetch, and the folders are walked in the browser.
   *
   * The whole shelf arrives at once — a few hundred titles is a few kilobytes
   * — so opening a folder, going back and following a breadcrumb cost nothing.
   * That is the difference between a filing system people browse and one they
   * learn to avoid, which is the thing this page exists to fix.
   */
  function pageShelf(main) {
    var state = { nodes: [], mayAdd: false, maxDepth: 6, myDepartments: [] };
    var notice = h('div', { class: 'notice', hidden: true });
    var crumbs = h('nav', { class: 'shelf-crumbs', 'aria-label': t('shelfWhere') });
    var grid = h('div', { class: 'shelf-grid' });

    function say(kind, text) {
      notice.hidden = false;
      notice.className = 'notice ' + kind;
      notice.textContent = text;
    }

    var byId = function (id) {
      return state.nodes.filter(function (n) { return n.id === id; })[0] || null;
    };
    var childrenOf = function (id) {
      return state.nodes.filter(function (n) { return (n.parentId || null) === (id || null); })
        .sort(function (a, b) {
          // Folders above links, then the order somebody put them in.
          if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
          return (a.position - b.position) || a.title.localeCompare(b.title, 'th');
        });
    };
    var trail = function (id) {
      var out = [];
      var at = id;
      var guard = 0;
      while (at && guard++ < 20) {
        var node = byId(at);
        if (!node) break;
        out.unshift(node);
        at = node.parentId;
      }
      return out;
    };
    /** How deep the folder we are looking at sits, so "add folder" can stop. */
    var depthHere = function () { return trail(S.shelfAt).length; };

    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('navShelf') })]));
    main.appendChild(h('p', { class: 'hint', text: t('shelfIntro') }));
    main.appendChild(notice);
    main.appendChild(crumbs);

    var addLinkBtn = h('button', {
      class: 'btn primary', text: t('shelfAddLink'),
      onclick: function () { openShelfEditor(null, 'link', S.shelfAt, load); },
    });
    var addFolderBtn = h('button', {
      class: 'btn', text: t('shelfAddFolder'),
      onclick: function () { openShelfEditor(null, 'folder', S.shelfAt, load); },
    });
    var bar = h('div', { class: 'shelf-bar' }, [addLinkBtn, addFolderBtn]);
    main.appendChild(bar);
    main.appendChild(grid);

    function drawCrumbs() {
      clear(crumbs);
      var path = trail(S.shelfAt);
      crumbs.appendChild(h('button', {
        type: 'button', class: 'crumb' + (path.length ? '' : ' on'),
        text: t('shelfRoot'),
        onclick: function () { S.shelfAt = null; draw(); },
      }));
      path.forEach(function (node, i) {
        crumbs.appendChild(h('span', { class: 'crumb-sep', text: '›', 'aria-hidden': 'true' }));
        crumbs.appendChild(h('button', {
          type: 'button', class: 'crumb' + (i === path.length - 1 ? ' on' : ''),
          text: node.title,
          onclick: function () { S.shelfAt = node.id; draw(); },
        }));
      });
    }

    function card(node) {
      var isFolder = node.kind === 'folder';
      var head = [
        h('span', {
          class: 'shelf-ico' + (isFolder ? ' folder' : ''),
          style: node.colour ? 'background:' + shelfHex(node.colour) : null,
          text: node.icon || (isFolder ? '📁' : '🔗'),
        }),
        h('span', { class: 'shelf-name', text: node.title }),
      ];

      var meta = [];
      if (isFolder) {
        meta.push(h('span', { class: 'shelf-count', text: t('shelfItems').replace('%s', node.count) }));
      } else {
        // The host, not the whole address: "docs.google.com" tells somebody
        // what they are about to open; 90 characters of query string does not.
        meta.push(h('span', { class: 'shelf-host', text: hostOfUrl(node.url) }));
      }
      if (node.department) {
        meta.push(h('span', { class: 'chip dept', text: deptLabel(node.department) }));
      }

      var body = [
        h('div', { class: 'shelf-head' }, head),
        node.note ? h('p', { class: 'shelf-note', text: node.note }) : null,
        h('div', { class: 'shelf-meta' }, meta),
      ];

      /**
       * A folder is a button, a link is an anchor.
       *
       * Not cosmetic: an anchor is what gives "open in a new tab" on a
       * middle-click and a long-press menu on a phone, which is how people
       * actually use a page of links. A folder is not a destination, so it
       * must not pretend to be one.
       */
      var tile = isFolder
        ? h('button', {
          type: 'button', class: 'shelf-card folder',
          onclick: function () { S.shelfAt = node.id; draw(); window.scrollTo(0, 0); },
        }, body)
        : h('a', {
          class: 'shelf-card', href: node.url, target: '_blank', rel: 'noopener noreferrer',
        }, body);

      var tools = [];
      if (node.mayEdit) {
        tools.push(h('button', {
          type: 'button', class: 'btn ghost sm', text: t('edit'), title: t('edit'),
          onclick: function () { openShelfEditor(node, node.kind, node.parentId, load); },
        }));
      }
      if (node.mayDelete) {
        tools.push(h('button', {
          type: 'button', class: 'btn ghost sm danger', text: t('remove'), title: t('remove'),
          onclick: function () { removeNode(node); },
        }));
      }

      return h('div', { class: 'shelf-slot' }, [tile, tools.length ? h('div', { class: 'shelf-tools' }, tools) : null]);
    }

    function removeNode(node) {
      /**
       * A folder with things in it says how many are about to go.
       *
       * "ลบโฟลเดอร์นี้ไหม" is a question somebody says yes to; "ลบโฟลเดอร์นี้
       * และ 19 รายการข้างในไหม" is a question they read.
       */
      var question = node.kind === 'folder' && node.count
        ? t('shelfDeleteFolder').replace('%1', node.title).replace('%2', node.count)
        : t('shelfDeleteOne').replace('%s', node.title);
      if (!window.confirm(question)) return;

      api('/api/meta?do=shelf-delete&id=' + encodeURIComponent(node.id), { method: 'DELETE' })
        .then(function (d) {
          say('ok', d.alsoRemoved
            ? t('shelfDeletedWith').replace('%s', d.alsoRemoved)
            : t('shelfDeleted'));
          load();
        })
        .catch(function (err) {
          say('err', err.code === 'FOLDER_NOT_EMPTY'
            ? t('errFolderNotEmpty').replace('%s', (err.data && err.data.inside) || '')
            : errText(err.code));
        });
    }

    function draw() {
      drawCrumbs();
      clear(grid);
      bar.hidden = !state.mayAdd;
      // Six levels deep, "new folder" stops being offered rather than being
      // offered and refused by the server.
      addFolderBtn.hidden = depthHere() >= state.maxDepth;

      var here = childrenOf(S.shelfAt);
      if (!here.length) {
        grid.appendChild(h('div', { class: 'empty' }, [
          h('strong', { text: S.shelfAt ? t('shelfFolderEmpty') : t('shelfNone') }),
          h('p', { text: state.mayAdd ? t('shelfEmptyAdd') : t('shelfEmptyAsk') }),
        ]));
        return;
      }
      here.forEach(function (node) { grid.appendChild(card(node)); });
    }

    function load() {
      return api('/api/meta?do=shelf').then(function (d) {
        state = d;
        // A folder somebody else deleted while this page was open would
        // otherwise leave the page looking at nothing, with a breadcrumb to
        // a folder that is gone.
        if (S.shelfAt && !byId(S.shelfAt)) S.shelfAt = null;
        draw();
      }).catch(function (err) { say('err', errText(err.code)); });
    }

    load();
  }

  var SHELF_HEX = {
    pink: '#e0457b', indigo: '#5b5bd6', teal: '#0fa5a0', amber: '#f59e0b',
    violet: '#8b5cf6', green: '#12a36b', blue: '#2f7ff0', red: '#e5484d',
  };
  var SHELF_COLOURS = Object.keys(SHELF_HEX);
  function shelfHex(key) { return SHELF_HEX[key] || SHELF_HEX.pink; }

  /** The host of an address, for a label somebody can read at a glance. */
  function hostOfUrl(url) {
    try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return url; }
  }

  /**
   * Making or changing one.
   *
   * The same dialog for a folder and a link, because they differ in one field
   * — a link has an address and a folder does not — and two dialogs that are
   * nine tenths identical drift apart.
   */



  /**
   * Correcting a username, with the account left where it is.
   *
   * The username is shown everywhere and editable nowhere, because it is the
   * key every assignment, signature and invitation hangs off — so the only
   * way to fix "Mochi_HeadOrganizer" for somebody called Moji used to be to
   * delete the account and make another one, losing all of it. This moves
   * the key instead, and says afterwards what moved with it.
   */
  function openRename(user) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });
    var input = h('input', {
      type: 'text', maxlength: '64', value: user.username,
      autocapitalize: 'off', spellcheck: 'false',
    });

    function say(cls, text) {
      notice.hidden = false; notice.className = 'notice ' + cls; notice.textContent = text;
    }

    var saveBtn = h('button', {
      class: 'btn primary', text: t('save'),
      onclick: function () {
        var want = input.value.trim();
        if (want === user.username) { veil.remove(); return; }
        if (!/^[A-Za-z0-9_.-]{3,64}$/.test(want)) { say('err', t('errBadUsername')); input.focus(); return; }
        saveBtn.disabled = true;
        api('/api/users?do=rename', { method: 'POST', body: { username: user.username, newUsername: want } })
          .then(function (d) {
            /**
             * Renaming yourself leaves this page holding a name that no
             * longer exists, and everything it does next would be about
             * nobody. Start again rather than patch it up.
             */
            if (d.itWasMe) { location.reload(); return; }
            S.users = d.users;
            veil.remove();
            var carried = (d.moved || []).reduce(function (n, x) { return n + x.rows; }, 0);
            S.adminNotice = {
              kind: 'ok',
              text: t('renameDone').replace('%a', d.from).replace('%b', d.to)
                .replace('%n', String(carried)),
            };
            renderPage();
          })
          .catch(function (err) {
            saveBtn.disabled = false;
            say('err', err.code === 'USERNAME_TAKEN' ? t('errUsernameTaken') : errText(err.code));
          });
      },
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    });

    veil.appendChild(h('div', { class: 'modal', style: 'width:min(28rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: t('renameUser') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice,
        h('p', { class: 'hint', text: user.displayName }),
        h('div', { class: 'field' }, [h('label', { text: t('username') }), input]),
        h('small', { class: 'hint', text: t('renameWhy') }),
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]));
    $('modal-root').appendChild(veil);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /**
   * The committee's groups, and who is in them.
   *
   * Four of these are questions asked of the roster — "who is at least an
   * editor right now" — which was treated as the whole answer and is only a
   * good first one. ต๊อดติ is a co-admin because he manages people; the
   * ผู้ช่วยประธาน who sits on the board without that access level could not
   * be on it at all. Both are decisions now, on top of the rule rather than
   * instead of it, which is why a pinned person is marked as pinned.
   */
  function groupSection(main, say) {
    var box = h('section', { class: 'org-admin' });
    main.appendChild(box);
    var state = { circles: [] };
    load();

    function load() {
      return api('/api/users?do=groups').then(function (d) {
        state.circles = d.circles || [];
        draw();
      }).catch(function (err) { say('err', errText(err.code)); });
    }

    function draw() {
      clear(box);
      box.appendChild(h('div', { class: 'page-head sub' }, [
        h('h2', { text: t('grpTitle') }),
        h('button', { class: 'btn', text: t('grpAdd'), onclick: function () { openGroupEditor(null, load, say); } }),
      ]));
      box.appendChild(h('p', { class: 'hint', text: t('grpWhy') }));

      var list = h('div', { class: 'org-list' });
      state.circles.forEach(function (c) {
        list.appendChild(h('div', { class: 'org-dept' }, [
          h('div', { class: 'org-dept-head' }, [
            h('b', { text: S.lang === 'en' ? c.en : c.th }),
            h('code', { class: 'org-key', text: c.key }),
            c.made
              ? h('span', { class: 'chip sm', text: c.selfJoin ? t('grpOpen') : t('grpClosed') })
              : h('small', { class: 'hint', text: t('grpDerived') + ' ' + accessLabel(c.floor) }),
            h('span', { class: 'grow' }),
            h('span', { class: 'chip sm', text: String(c.members.length) }),
            c.made ? h('button', { class: 'btn ghost sm', text: t('rename'),
              onclick: function () { openGroupEditor(c, load, say); } }) : null,
            c.made ? h('button', { class: 'btn ghost sm danger', text: t('orgPutAway'),
              onclick: function () { hideGroup(c, load, say); } }) : null,
            h('button', { class: 'btn ghost sm', text: t('grpWho'),
              onclick: function () { openGroupPeople(c, load, say); } }),
          ].filter(Boolean)),
          h('div', { class: 'org-units' }, c.members.slice(0, 24).map(function (u) {
            var pinned = c.pinnedIn.indexOf(u) !== -1;
            return h('span', { class: 'chip unit' + (pinned ? ' pinned' : '') },
              [h('span', { text: nameOfUser(u) }), pinned ? h('span', { class: 'pin-dot', text: '•' }) : null]
                .filter(Boolean));
          }).concat(c.members.length > 24
            ? [h('span', { class: 'chip sm', text: '+' + (c.members.length - 24) })] : [])),
        ]));
      });
      box.appendChild(list);
    }
  }

  function accessLabel(level) {
    if (!level) return '';
    return t('access' + String(level).charAt(0).toUpperCase() + String(level).slice(1));
  }

  function nameOfUser(username) {
    var u = (S.users || []).filter(function (x) { return x.username === username; })[0];
    return u ? (u.nickname || u.displayName || u.username) : username;
  }

  function hideGroup(group, reload, say) {
    if (!confirm(t('orgPutAwayAsk').replace('%s', S.lang === 'en' ? group.en : group.th))) return;
    api('/api/users?do=groups', { method: 'PATCH', body: { kind: 'group', key: group.key, hidden: true } })
      .then(refreshOrg).then(reload)
      .then(function () { say('ok', t('orgSaved')); })
      .catch(function (err) { say('err', errText(err.code)); });
  }

  /** A group the committee invented: its name, and whether people may walk in. */
  function openGroupEditor(group, reload, say) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var th = h('input', { type: 'text', maxlength: '60', value: (group && group.th) || '' });
    var en = h('input', { type: 'text', maxlength: '60', value: (group && group.en) || '' });
    var note = h('input', { type: 'text', maxlength: '200', value: (group && group.note) || '' });
    var open = h('input', { type: 'checkbox' });
    open.checked = group ? group.selfJoin !== false : true;

    var saveBtn = h('button', {
      class: 'btn primary', text: t('save'),
      onclick: function () {
        if (!th.value.trim() && !en.value.trim()) { th.focus(); return; }
        saveBtn.disabled = true;
        var body = { kind: 'group', th: th.value.trim(), en: en.value.trim(),
          note: note.value.trim(), selfJoin: open.checked };
        if (group) body.key = group.key;
        api('/api/users?do=groups', { method: group ? 'PATCH' : 'POST', body: body })
          .then(refreshOrg).then(reload)
          .then(function () { veil.remove(); say('ok', t('orgSaved')); })
          .catch(function (err) { saveBtn.disabled = false; say('err', errText(err.code)); });
      },
    });

    veil.appendChild(h('div', { class: 'modal', style: 'width:min(28rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: group ? t('grpRename') : t('grpAdd') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        h('div', { class: 'field' }, [h('label', { text: t('orgNameTh') }), th]),
        h('div', { class: 'field' }, [h('label', { text: t('orgNameEn') }), en]),
        h('div', { class: 'field' }, [h('label', { text: t('grpNote') }), note]),
        h('label', { class: 'check' }, [open, h('span', { text: t('grpSelfJoin') })]),
        h('small', { class: 'hint', text: t('grpSelfJoinWhy') }),
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]));
    $('modal-root').appendChild(veil);
    th.focus();
  }

  /**
   * Who is in one, with each name saying how it got there.
   *
   * Three states rather than a tick box, because "in it because they are a
   * co-admin" and "in it because somebody said so" are different facts and
   * only the second is anybody's to take back.
   */
  function openGroupPeople(group, reload, say) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var find = h('input', { type: 'search', placeholder: t('findPerson') });
    var rows = h('div', { class: 'grp-people' });

    function paint() {
      clear(rows);
      var q = find.value.trim().toLowerCase();
      (S.users || []).filter(function (u) {
        if (!u.active) return false;
        if (!q) return true;
        return (u.displayName + ' ' + u.username + ' ' + (u.nickname || '')).toLowerCase().indexOf(q) !== -1;
      }).forEach(function (u) {
        var isIn = group.members.indexOf(u.username) !== -1;
        var pinnedIn = group.pinnedIn.indexOf(u.username) !== -1;
        var pinnedOut = group.pinnedOut.indexOf(u.username) !== -1;
        var derived = isIn && !pinnedIn;

        function set(what) {
          var call = what === null
            ? api('/api/users?do=groups', { method: 'DELETE', body: { kind: 'member', circle: group.key, username: u.username } })
            : api('/api/users?do=groups', { method: 'POST', body: { kind: 'member', circle: group.key, username: u.username, state: what } });
          call.then(refreshOrg).then(reload).then(function () { veil.remove(); say('ok', t('orgSaved')); })
            .catch(function (err) { say('err', errText(err.code)); });
        }

        rows.appendChild(h('div', { class: 'grp-row' }, [
          avatarNode(u.username, 'sm'),
          h('span', { class: 'grow', text: nameOfUser(u.username) }),
          derived ? h('small', { class: 'hint', text: t('grpByRule') }) : null,
          pinnedIn ? h('small', { class: 'hint', text: t('grpByHand') }) : null,
          pinnedOut ? h('small', { class: 'hint', text: t('grpKeptOut') }) : null,
          isIn
            ? h('button', { class: 'btn ghost sm', text: t('grpTakeOut'),
                onclick: function () { set(group.made || pinnedIn ? null : 'out'); } })
            : h('button', { class: 'btn ghost sm', text: t('grpPutIn'),
                onclick: function () { set(pinnedOut ? null : 'in'); } }),
        ].filter(Boolean)));
      });
    }
    find.addEventListener('input', paint);
    paint();

    veil.appendChild(h('div', { class: 'modal', style: 'width:min(32rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: (S.lang === 'en' ? group.en : group.th) }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        h('div', { class: 'field' }, [find]),
        h('small', { class: 'hint', text: group.made ? t('grpMadeWhy') : t('grpPinWhy') }),
        rows,
      ]),
    ]));
    $('modal-root').appendChild(veil);
    find.focus();
  }

  /**
   * The roster and the org chart, as things an admin can change here.
   *
   * Both used to mean editing something outside the app: a person meant a row
   * in the Google Sheet and a wait for the next sync, and a ฝ่าย or a หน่วย
   * meant editing lib/departments.js and a deployment — เสื้อโครงการ existed
   * in the committee for a month before it existed in here. Neither is a
   * decision anybody outside the committee should be in the middle of.
   */
  function orgSection(main, say) {
    var box = h('section', { class: 'org-admin' });
    main.appendChild(box);
    drawOrg();

    function drawOrg() {
      clear(box);
      box.appendChild(h('div', { class: 'page-head sub' }, [
        h('h2', { text: t('orgTitle') }),
        h('button', { class: 'btn', text: t('orgAddMember'), onclick: function () { openAddMember(say); } }),
        h('button', { class: 'btn', text: t('orgAddDept'), onclick: function () { openDeptEditor(null, drawOrg, say); } }),
      ]));
      box.appendChild(h('p', { class: 'hint', text: t('orgWhy') }));

      var list = h('div', { class: 'org-list' });
      (S.departments || []).forEach(function (d) {
        var units = h('div', { class: 'org-units' });
        (d.units || []).forEach(function (name) { units.appendChild(unitChip(d, name, drawOrg, say)); });
        units.appendChild(h('button', {
          type: 'button', class: 'chip add', text: '+ ' + t('orgAddUnit'),
          onclick: function () { addUnit(d, drawOrg, say); },
        }));

        list.appendChild(h('div', { class: 'org-dept' }, [
          h('div', { class: 'org-dept-head' }, [
            h('b', { text: S.lang === 'en' ? d.en : d.th }),
            h('code', { class: 'org-key', text: d.key }),
            d.parent ? h('small', { class: 'hint', text: t('orgUnder') + ' ' + deptLabel(d.parent) }) : null,
            d.added ? h('span', { class: 'chip sm', text: t('orgAddedHere') }) : null,
            h('span', { class: 'grow' }),
            h('button', { class: 'btn ghost sm', text: t('rename'),
              onclick: function () { openDeptEditor(d, drawOrg, say); } }),
            h('button', { class: 'btn ghost sm danger', text: t('orgPutAway'),
              onclick: function () { hideDept(d, drawOrg, say); } }),
          ].filter(Boolean)),
          units,
        ]));
      });
      box.appendChild(list);
    }
  }

  /**
   * One หน่วย: the sub-category of a ฝ่าย.
   *
   * Tapping it offers the thing a หน่วย is usually wanted for — a teamspace
   * of its own, which everybody filed under that section joins automatically
   * rather than being added to by hand.
   */
  function unitChip(dept, name, redraw, say) {
    return h('span', { class: 'chip unit' }, [
      h('span', { text: name }),
      h('button', {
        type: 'button', class: 'chip-act', title: t('orgUnitSpace'), text: '⌸',
        onclick: function () { makeUnitSpace(dept, name, say); },
      }),
      h('button', {
        type: 'button', class: 'chip-act danger', title: t('orgPutAway'), text: '✕',
        onclick: function () { hideUnit(dept, name, redraw, say); },
      }),
    ]);
  }

  function addUnit(dept, redraw, say) {
    var name = prompt(t('orgUnitName') + ' — ' + (S.lang === 'en' ? dept.en : dept.th));
    if (!name || !name.trim()) return;
    api('/api/users?do=org', { method: 'POST', body: { kind: 'unit', department: dept.key, name: name.trim() } })
      .then(function () { return refreshOrg(); })
      .then(function () { say('ok', t('orgSaved')); redraw(); })
      .catch(function (err) { say('err', errText(err.code)); });
  }

  function hideUnit(dept, name, redraw, say) {
    if (!confirm(t('orgPutAwayAsk').replace('%s', name))) return;
    api('/api/users?do=org', { method: 'DELETE', body: { kind: 'unit', department: dept.key, name: name } })
      .then(function (d) { return refreshOrg().then(function () { return d; }); })
      .then(function (d) {
        // Said rather than hidden: the label stays on everybody already filed
        // there, and an admin should know that before wondering where it went.
        say('ok', d && d.stillFiledHere
          ? t('orgPutAwayStill').replace('%n', String(d.stillFiledHere))
          : t('orgSaved'));
        redraw();
      })
      .catch(function (err) { say('err', errText(err.code)); });
  }

  function hideDept(dept, redraw, say) {
    if (!confirm(t('orgPutAwayAsk').replace('%s', S.lang === 'en' ? dept.en : dept.th))) return;
    api('/api/users?do=org', { method: 'PATCH', body: { kind: 'department', key: dept.key, hidden: true } })
      .then(function () { return refreshOrg(); })
      .then(function () { say('ok', t('orgSaved')); redraw(); })
      .catch(function (err) { say('err', errText(err.code)); });
  }

  /** Re-read the chart so every picker on the page agrees with the change. */
  function refreshOrg() {
    return api('/api/meta').then(function (d) {
      if (d && d.departments) S.departments = d.departments;
    });
  }

  /** A teamspace for one หน่วย, with that หน่วย as its membership rule. */
  function makeUnitSpace(dept, name, say) {
    api('/api/tasks?do=space', {
      method: 'POST',
      body: { name: name, departments: [{ key: dept.key, unit: name }] },
    })
      .then(function () { say('ok', t('orgUnitSpaceMade').replace('%s', name)); reloadSpaces(); })
      .catch(function (err) { say('err', errText(err.code)); });
  }

  /** New ฝ่าย, or the labels of one that exists. */
  function openDeptEditor(dept, redraw, say) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var th = h('input', { type: 'text', maxlength: '80', value: (dept && dept.th) || '' });
    var en = h('input', { type: 'text', maxlength: '80', value: (dept && dept.en) || '' });

    var parent = h('select', {});
    parent.appendChild(h('option', { value: '', text: t('orgNoParent') }));
    (S.departments || []).forEach(function (d) {
      if (dept && d.key === dept.key) return;
      parent.appendChild(h('option', { value: d.key, text: S.lang === 'en' ? d.en : d.th }));
    });
    parent.value = (dept && dept.parent) || '';

    var saveBtn = h('button', {
      class: 'btn primary', text: t('save'),
      onclick: function () {
        if (!th.value.trim() && !en.value.trim()) { th.focus(); return; }
        saveBtn.disabled = true;
        var body = { kind: 'department', th: th.value.trim(), en: en.value.trim(), parent: parent.value || null };
        if (dept) body.key = dept.key;
        api('/api/users?do=org', { method: dept ? 'PATCH' : 'POST', body: body })
          .then(function () { return refreshOrg(); })
          .then(function () { veil.remove(); say('ok', t('orgSaved')); redraw(); })
          .catch(function (err) { saveBtn.disabled = false; say('err', errText(err.code)); });
      },
    });

    veil.appendChild(h('div', { class: 'modal', style: 'width:min(28rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: dept ? t('orgRenameDept') : t('orgAddDept') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        h('div', { class: 'field' }, [h('label', { text: t('orgNameTh') }), th]),
        h('div', { class: 'field' }, [h('label', { text: t('orgNameEn') }), en]),
        h('div', { class: 'field' }, [
          h('label', { text: t('orgUnder') }), parent,
          h('small', { class: 'hint', text: t('orgUnderWhy') }),
        ]),
        dept ? h('small', { class: 'hint', text: t('orgKeyFixed').replace('%s', dept.key) }) : null,
      ].filter(Boolean)),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]));
    $('modal-root').appendChild(veil);
    th.focus();
  }

  /**
   * Somebody who has joined, before the sheet has caught up.
   *
   * No password is asked for and none is set: the person claims the account
   * themselves the first time they sign in, which is the rule everywhere
   * else here and the reason no admin ever knows anybody else's password.
   */
  function openAddMember(say) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });

    var nickname = h('input', { type: 'text', maxlength: '60' });
    var username = h('input', { type: 'text', maxlength: '64', autocapitalize: 'off', spellcheck: 'false' });
    var displayName = h('input', { type: 'text', maxlength: '120' });
    var position = h('input', { type: 'text', maxlength: '120' });

    var access = h('select', {}, ['inner', 'unitlead', 'editor', 'coadmin', 'admin']
      .filter(function (lv) { return S.canSetAccess || (lv !== 'admin' && lv !== 'coadmin'); })
      .map(function (lv) {
        return h('option', { value: lv, selected: lv === 'inner',
          text: t('access' + lv.charAt(0).toUpperCase() + lv.slice(1)) });
      }));

    var dept = h('select', {});
    var unit = h('select', {});
    function fillDepts() {
      clear(dept);
      dept.appendChild(h('option', { value: '', text: t('orgPickDept') }));
      (S.departments || []).forEach(function (d) {
        dept.appendChild(h('option', { value: d.key, text: S.lang === 'en' ? d.en : d.th }));
      });
    }
    function fillUnits() {
      clear(unit);
      unit.appendChild(h('option', { value: '', text: t('orgNoUnit') }));
      var d = (S.departments || []).filter(function (x) { return x.key === dept.value; })[0];
      (d ? d.units || [] : []).forEach(function (name) {
        unit.appendChild(h('option', { value: name, text: name }));
      });
      unit.disabled = !dept.value;
    }
    fillDepts(); fillUnits();
    dept.addEventListener('change', fillUnits);

    /**
     * The username, suggested from the nickname and the ตำแหน่ง, in the shape
     * the roster already uses — Nickname_Role. Suggested, never imposed: it
     * is the key every task assignment hangs off and the sheet owns it.
     */
    nickname.addEventListener('blur', function () {
      if (username.value.trim()) return;
      var base = nickname.value.trim().replace(/[^A-Za-z0-9]/g, '');
      if (base) username.value = base.charAt(0).toUpperCase() + base.slice(1);
    });

    function say2(cls, text) {
      notice.hidden = false; notice.className = 'notice ' + cls; notice.textContent = text;
    }

    var saveBtn = h('button', {
      class: 'btn primary', text: t('orgAddMember'),
      onclick: function () {
        if (!nickname.value.trim()) { say2('err', t('orgNeedNickname')); nickname.focus(); return; }
        if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username.value.trim())) {
          say2('err', t('errBadUsername')); username.focus(); return;
        }
        saveBtn.disabled = true;
        api('/api/users?do=add', { method: 'POST', body: {
          username: username.value.trim(),
          nickname: nickname.value.trim(),
          displayName: displayName.value.trim(),
          position: position.value.trim(),
          access: access.value,
          department: dept.value || null,
          unit: unit.value || null,
        } })
          .then(function (d) {
            S.users = d.users;
            veil.remove();
            /**
             * Whether the roster sheet got the row as well. Said rather than
             * assumed: an account the sheet has never heard of is one that
             * falls out of every printed list and every ฝ่าย count.
             */
            say('ok', t('orgMemberAdded').replace('%s', d.username));
            renderPage();
          })
          .catch(function (err) {
            saveBtn.disabled = false;
            say2('err', err.code === 'USERNAME_TAKEN'
              ? t('errUsernameTaken') : errText(err.code));
          });
      },
    });

    veil.appendChild(h('div', { class: 'modal', style: 'width:min(32rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: t('orgAddMember') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice,
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('nickname') }), nickname]),
          h('div', { class: 'field' }, [h('label', { text: t('username') }), username]),
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('displayName') }), displayName]),
        h('div', { class: 'field' }, [h('label', { text: t('position') }), position]),
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('department') }), dept]),
          h('div', { class: 'field' }, [h('label', { text: t('orgUnit') }), unit]),
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('access') }), access]),
        h('small', { class: 'hint', text: t('orgAddMemberWhy') }),
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]));
    $('modal-root').appendChild(veil);
    nickname.focus();
  }

  /**
   * Shelf editor: one folder or one link.
   */
  function openShelfEditor(node, kind, parentId, onSaved) {
    var isFolder = kind === 'folder';
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });

    var title = h('input', { type: 'text', maxlength: '120', value: (node && node.title) || '' });
    var url = h('input', {
      type: 'url', maxlength: '1000', placeholder: t('shelfUrlPlaceholder'),
      value: (node && node.url) || '',
    });
    var note = h('textarea', { rows: '2', maxlength: '600' });
    note.value = (node && node.note) || '';

    var iconIn = h('input', {
      type: 'text', maxlength: '8', class: 'shelf-icon-in',
      placeholder: isFolder ? '📁' : '🔗', value: (node && node.icon) || '',
    });

    /** Who the branch is for. Blank means the whole committee. */
    var dept = h('select', {});
    dept.appendChild(h('option', { value: '', text: t('shelfEveryone') }));
    (myDeptKeys()).forEach(function (key) {
      dept.appendChild(h('option', { value: key, text: deptLabel(key) }));
    });
    dept.value = (node && node.department) || '';

    var swatches = h('div', { class: 'shelf-swatches' });
    var chosen = (node && node.colour) || '';
    SHELF_COLOURS.forEach(function (key) {
      var b = h('button', {
        type: 'button', class: 'swatch' + (chosen === key ? ' on' : ''),
        style: 'background:' + shelfHex(key), title: key, 'aria-label': key,
        onclick: function () {
          chosen = chosen === key ? '' : key;
          Array.prototype.forEach.call(swatches.children, function (el) {
            el.classList.toggle('on', el.title === chosen);
          });
        },
      });
      swatches.appendChild(b);
    });

    var saveBtn = h('button', {
      class: 'btn primary',
      text: node ? t('save') : (isFolder ? t('shelfAddFolder') : t('shelfAddLink')),
      onclick: function () {
        var body = {
          kind: kind,
          title: title.value.trim(),
          note: note.value,
          icon: iconIn.value.trim(),
          colour: chosen,
          department: dept.value,
        };
        if (!isFolder) body.url = url.value.trim();
        if (!body.title) { say('err', t('shelfNeedTitle')); title.focus(); return; }
        if (!isFolder && !body.url) { say('err', t('shelfNeedUrl')); url.focus(); return; }

        saveBtn.disabled = true;
        var call = node
          ? api('/api/meta?do=shelf-edit', { method: 'PATCH', body: Object.assign({ id: node.id }, body) })
          : api('/api/meta?do=shelf-add', { method: 'POST', body: Object.assign({ parentId: parentId || '' }, body) });

        call.then(function () { veil.remove(); if (onSaved) onSaved(); })
          .catch(function (err) { say('err', errText(err.code)); })
          .then(function () { saveBtn.disabled = false; });
      },
    });

    function say(cls, text) {
      notice.hidden = false;
      notice.className = 'notice ' + cls;
      notice.textContent = text;
    }

    var modal = h('div', { class: 'modal', style: 'width:min(32rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: node ? t('shelfEdit') : (isFolder ? t('shelfNewFolder') : t('shelfNewLink')) }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice,
        h('div', { class: 'field' }, [h('label', { text: t('shelfTitle') }), title]),
        isFolder ? null : h('div', { class: 'field' }, [h('label', { text: t('shelfUrl') }), url]),
        h('div', { class: 'field' }, [
          h('label', { text: t('shelfNote') }), note,
          h('small', { class: 'hint', text: t('shelfNoteWhy') }),
        ]),
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('shelfIcon') }), iconIn]),
          h('div', { class: 'field' }, [h('label', { text: t('shelfColour') }), swatches]),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: t('shelfWho') }), dept,
          h('small', { class: 'hint', text: t('shelfWhoWhy') }),
        ]),
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
    title.focus();
  }

  /**
   * The ฝ่าย this person may scope a branch to.
   *
   * Taken from what the task API already told the page about this person
   * rather than asked for again — it is the same list, and the shelf should
   * not be able to disagree with the rest of the app about which ฝ่าย
   * somebody is in.
   */
  function myDeptKeys() {
    if (S.seesEverything) return (S.departments || []).map(function (d) { return d.key; });
    return (S.myDepartments || []).filter(function (k) { return k && k !== 'all'; });
  }

  /* ======================================================================
     Reporting a bug, suggesting a feature
     ====================================================================== */

  var REPORT_SEVS = ['urgent', 'high', 'normal'];
  var REPORT_STATES = ['new', 'planned', 'fixed', 'declined', 'duplicate'];

  /**
   * What the page can say about the browser, without asking anybody.
   *
   * Nobody knows their own user agent, and a report filed against a build
   * from last week usually explains itself — so the page fills this in. It is
   * SHOWN to the person before they send it, in plain words, because quietly
   * attaching facts about somebody's device to something they wrote is not a
   * thing to do behind their back.
   */
  function deviceLine() {
    var ua = navigator.userAgent || '';
    var browser = /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari'
      : 'เบราว์เซอร์อื่น';
    var os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
      : /Mac OS X/.test(ua) ? 'macOS'
      : /Windows/.test(ua) ? 'Windows'
      : /Linux/.test(ua) ? 'Linux'
      : '';
    var screenSize = window.innerWidth + 'x' + window.innerHeight;
    // Whether they are in the installed app rather than a browser tab: half
    // the phone-only faults in this project have turned out to be that.
    var installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    return [os, browser, screenSize, installed ? t('repInstalled') : null]
      .filter(Boolean).join(' · ');
  }

  function severityLabel(key) {
    return t({ urgent: 'repSevUrgent', high: 'repSevHigh', normal: 'repSevNormal' }[key] || 'repSevNormal');
  }
  function stateLabel(key) {
    return t({
      new: 'repStateNew', planned: 'repStatePlanned', fixed: 'repStateFixed',
      declined: 'repStateDeclined', duplicate: 'repStateDuplicate',
    }[key] || 'repStateNew');
  }

  function pageReports(main) {
    var state = { reports: [], mayReport: false, mayTriage: false, maySetTeam: false, nudgeAt: 5 };
    var notice = h('div', { class: 'notice', hidden: true });
    var list = h('div', { class: 'rep-list' });
    var tabs = h('div', { class: 'seg rep-tabs' });

    function say(kind, text) {
      notice.hidden = false;
      notice.className = 'notice ' + kind;
      notice.textContent = text;
    }

    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('navReports') })]));
    main.appendChild(h('p', { class: 'hint', text: t('repIntro') }));
    main.appendChild(notice);

    var newBtn = h('button', {
      class: 'btn primary', text: t('repNew'),
      onclick: function () { openReportForm(state, load); },
    });
    main.appendChild(h('div', { class: 'shelf-bar' }, [newBtn]));
    main.appendChild(tabs);
    main.appendChild(list);

    /**
     * The tabs, which differ by who is looking.
     *
     * Everyone gets ทั้งหมด and ของฉัน. The rota also gets ยังไม่ได้ดู — the
     * queue they actually work from — and สรุปรายวัน. Somebody who is not on
     * the rota is not shown a tab that would be empty of meaning to them.
     */
    function drawTabs() {
      clear(tabs);
      var items = [['open', t('repTabOpen')], ['all', t('repTabAll')], ['mine', t('repTabMine')]];
      if (state.mayTriage) items.push(['digest', t('repTabDigest')]);
      items.forEach(function (pair) {
        tabs.appendChild(h('button', {
          type: 'button', class: S.repTab === pair[0] ? 'on' : '',
          text: pair[1],
          onclick: function () { S.repTab = pair[0]; draw(); },
        }));
      });
    }

    function row(rep) {
      var sev = h('span', { class: 'rep-sev sev-' + rep.severity, text: severityLabel(rep.severity) });
      var st = h('span', { class: 'rep-state st-' + rep.state, text: stateLabel(rep.state) });
      var kind = h('span', {
        class: 'rep-kind k-' + rep.kind,
        text: rep.kind === 'bug' ? t('repKindBug') : t('repKindIdea'),
      });

      /**
       * "เจอเหมือนกัน", with the count on the button itself.
       *
       * One control rather than a count beside a button: the number IS how
       * many people pressed it, so putting them apart invites the reader to
       * wonder whether they mean the same thing.
       */
      var meToo = h('button', {
        type: 'button', class: 'rep-metoo' + (rep.voted ? ' on' : ''),
        title: rep.voted ? t('repMeTooUndo') : t('repMeToo'),
        onclick: function (e) {
          e.preventDefault();
          e.stopPropagation();
          meToo.disabled = true;
          api('/api/meta?do=report-vote', { method: 'POST', body: { id: rep.id } })
            .then(function (d) {
              rep.voted = d.voted;
              rep.votes = d.votes;
              meToo.classList.toggle('on', d.voted);
              count.textContent = String(d.votes);
              if (d.nudged) say('ok', t('repNudged').replace('%s', state.nudgeAt));
            })
            .catch(function (err) { say('err', errText(err.code)); })
            .then(function () { meToo.disabled = false; });
        },
      });
      var count = h('b', { text: String(rep.votes) });
      meToo.appendChild(h('span', { class: 'rep-metoo-ic', text: '👋', 'aria-hidden': 'true' }));
      meToo.appendChild(count);

      var line2 = [kind, sev, st];
      if (rep.shots) line2.push(h('span', { class: 'rep-shots', text: '🖼 ' + rep.shots }));
      if (rep.dupOf) line2.push(h('span', { class: 'chip', text: t('repDupOf').replace('%s', rep.dupOf) }));

      return h('div', { class: 'rep-row' + (rep.severity === 'urgent' && rep.state === 'new' ? ' hot' : '') }, [
        h('button', {
          type: 'button', class: 'rep-open',
          onclick: function () { openReport(rep, state, load); },
        }, [
          h('div', { class: 'rep-top' }, [
            h('code', { class: 'rep-code', text: rep.code || '' }),
            h('span', { class: 'rep-title', text: rep.title }),
          ]),
          h('div', { class: 'rep-tags' }, line2),
          h('div', { class: 'rep-by' }, [
            avatarNode(rep.createdBy),
            h('span', { text: nameOf(rep.createdBy) }),
            h('span', { class: 'rep-when', text: fmtStamp(rep.createdAt) }),
          ]),
        ]),
        meToo,
      ]);
    }

    function visible() {
      var all = state.reports;
      if (S.repTab === 'mine') return all.filter(function (r) { return r.mine; });
      if (S.repTab === 'open') {
        return all.filter(function (r) { return r.state === 'new' || r.state === 'planned'; });
      }
      return all;
    }

    function draw() {
      drawTabs();
      clear(list);
      newBtn.hidden = !state.mayReport;

      if (S.repTab === 'digest') { drawDigest(list, state); return; }

      var rows = visible();
      if (!rows.length) {
        list.appendChild(h('div', { class: 'empty' }, [
          h('strong', { text: S.repTab === 'mine' ? t('repNoneMine') : t('repNone') }),
          h('p', { text: t('repNoneWhy') }),
        ]));
        return;
      }
      /**
       * Worst first, and a crowd counts.
       *
       * The same rule the daily summary uses, for the same reason — and
       * because a list ordered differently from the summary it feeds would
       * make the two look like they disagree.
       */
      rows.slice().sort(function (a, b) {
        var rank = function (r) {
          var sev = REPORT_SEVS.indexOf(r.severity);
          var crowded = r.votes >= state.nudgeAt;
          var open = r.state === 'new' || r.state === 'planned' ? 0 : 1;
          return open * 10000 + Math.max(0, sev - (crowded ? 1 : 0)) * 1000 - r.votes;
        };
        return rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt));
      }).forEach(function (rep) { list.appendChild(row(rep)); });
    }

    function load() {
      return api('/api/meta?do=reports').then(function (d) {
        state = d;
        if (!state.mayTriage && S.repTab === 'digest') S.repTab = 'open';
        draw();
      }).catch(function (err) { say('err', errText(err.code)); });
    }

    if (!S.repTab) S.repTab = 'open';
    load();
  }

  /**
   * The day's summary, as one block to copy.
   *
   * The whole point of this tab is the copy button: the text is assembled by
   * the server so that what gets pasted is the same whoever pastes it, and
   * the page's job is to hand it over in one press.
   */
  function drawDigest(into, state) {
    var box = h('pre', { class: 'rep-digest', text: t('loading') });
    var when = h('input', { type: 'date', value: todayIso() });
    var counts = h('div', { class: 'rep-digest-counts' });

    var copyBtn = h('button', {
      class: 'btn primary', text: t('repCopy'),
      onclick: function (e) { copyText(box.textContent, e.target); },
    });
    var saveBtn = h('button', {
      class: 'btn', text: t('repSaveTxt'),
      onclick: function () {
        var blob = new Blob([box.textContent], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = h('a', { href: url, download: 'cuftm-reports-' + when.value + '.txt' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      },
    });

    function fetchDay() {
      box.textContent = t('loading');
      api('/api/meta?do=report-digest&day=' + encodeURIComponent(when.value))
        .then(function (d) {
          box.textContent = d.text;
          clear(counts);
          counts.appendChild(h('span', { class: 'chip', text: t('repCountToday').replace('%s', d.counts.today) }));
          counts.appendChild(h('span', { class: 'chip', text: t('repCountOpen').replace('%s', d.counts.open) }));
          if (d.counts.urgent) {
            counts.appendChild(h('span', { class: 'chip danger', text: t('repCountUrgent').replace('%s', d.counts.urgent) }));
          }
        })
        .catch(function (err) { box.textContent = errText(err.code); });
    }
    when.addEventListener('change', fetchDay);

    into.appendChild(h('div', { class: 'rep-digest-bar' }, [
      h('div', { class: 'field' }, [h('label', { text: t('repDigestDay') }), when]),
      h('span', { class: 'grow' }),
      saveBtn, copyBtn,
    ]));
    into.appendChild(h('p', { class: 'hint', text: t('repDigestWhy') }));
    into.appendChild(counts);
    into.appendChild(box);

    if (state.maySetTeam) {
      into.appendChild(h('div', { class: 'rep-team-link' }, [
        h('button', {
          class: 'btn', text: t('repTeamOpen'),
          onclick: function () { openReportTeam(state); },
        }),
        h('small', { class: 'hint', text: t('repTeamWhy') }),
      ]));
    }

    fetchDay();
  }

  /**
   * Who else gets woken by an urgent report.
   *
   * Admins are listed but not tickable: they are always told, and a checkbox
   * that cannot be unticked is worse than a sentence saying so.
   */
  function openReportTeam(state) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });
    var rota = state.rota || { chosen: [], candidates: [], always: [] };
    var picked = {};
    rota.chosen.forEach(function (u) { picked[u] = true; });

    var boxes = h('div', { class: 'rep-team' }, rota.candidates.map(function (person) {
      var cb = h('input', { type: 'checkbox', checked: picked[person.username] || null });
      cb.addEventListener('change', function () { picked[person.username] = cb.checked; });
      return h('label', { class: 'rep-team-row' }, [
        cb,
        avatarNode(person.username),
        h('span', { class: 'grow', text: person.name || person.username }),
      ]);
    }));

    var saveBtn = h('button', {
      class: 'btn primary', text: t('save'),
      onclick: function () {
        var names = Object.keys(picked).filter(function (u) { return picked[u]; });
        saveBtn.disabled = true;
        api('/api/meta?do=report-team', { method: 'POST', body: { usernames: names } })
          .then(function () { veil.remove(); renderPage(); })
          .catch(function (err) {
            notice.hidden = false;
            notice.className = 'notice err';
            notice.textContent = errText(err.code);
          })
          .then(function () { saveBtn.disabled = false; });
      },
    });

    var modal = h('div', { class: 'modal', style: 'width:min(30rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: t('repTeamTitle') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice,
        h('p', { class: 'hint', text: t('repTeamHelp') }),
        rota.always.length ? h('div', { class: 'rep-always' }, [
          h('small', { text: t('repTeamAlways') }),
          h('div', { class: 'rep-team' }, rota.always.map(function (p) {
            return h('div', { class: 'rep-team-row fixed' }, [
              avatarNode(p.username),
              h('span', { class: 'grow', text: p.name || p.username }),
              h('span', { class: 'chip', text: t('repTeamFixed') }),
            ]);
          })),
        ]) : null,
        rota.candidates.length
          ? h('div', {}, [h('small', { text: t('repTeamPick') }), boxes])
          : h('p', { class: 'hint', text: t('repTeamNoCoadmins') }),
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
  }

  /**
   * Filing one.
   *
   * The order of the fields is the argument of this whole feature. "ตอนนั้น
   * กำลังทำอะไรอยู่" comes BEFORE the description, because it is the single
   * most useful sentence in any bug report and the one people leave out when
   * the form is a blank box — asked first, it gets answered; asked last, it
   * gets skipped.
   *
   * The duplicate check is live: as somebody types a title, anything already
   * reported that matches appears underneath with a เจอเหมือนกัน button. That
   * is the point — five people reporting one fault becomes one report with
   * five people on it, which is both less work to read and better evidence.
   */
  function openReportForm(state, onSaved) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });
    var kind = 'bug';
    var severity = 'high';
    var shots = [];

    function say(cls, text) {
      notice.hidden = false;
      notice.className = 'notice ' + cls;
      notice.textContent = text;
    }

    var title = h('input', { type: 'text', maxlength: '160', placeholder: t('repTitlePlaceholder') });
    var doing = h('textarea', { rows: '2', maxlength: '1000', placeholder: t('repDoingPlaceholder') });
    var body = h('textarea', { rows: '4', maxlength: '4000', placeholder: t('repBodyPlaceholder') });

    /* ---- bug or idea ---- */
    var kindSeg = h('div', { class: 'seg rep-kindseg' });
    var sevField = h('div', { class: 'field' });

    function drawKind() {
      clear(kindSeg);
      [['bug', t('repKindBug'), t('repKindBugWhy')], ['idea', t('repKindIdea'), t('repKindIdeaWhy')]]
        .forEach(function (k) {
          kindSeg.appendChild(h('button', {
            type: 'button', class: kind === k[0] ? 'on' : '', title: k[2],
            onclick: function () {
              kind = k[0];
              // A suggestion is never urgent — the server enforces it, and the
              // form should not offer a choice that is about to be overruled.
              if (kind === 'idea' && severity === 'urgent') severity = 'high';
              drawKind();
              drawSeverity();
              drawLabels();
            },
          }, [h('b', { text: k[1] }), h('small', { text: k[2] })]));
        });
    }

    function drawSeverity() {
      clear(sevField);
      sevField.appendChild(h('label', { text: kind === 'bug' ? t('repHowBad') : t('repHowSoon') }));
      var seg = h('div', { class: 'seg rep-sevseg' });
      REPORT_SEVS.forEach(function (key) {
        if (kind === 'idea' && key === 'urgent') return;
        seg.appendChild(h('button', {
          type: 'button', class: (severity === key ? 'on ' : '') + 'sev-' + key,
          onclick: function () { severity = key; drawSeverity(); },
        }, [
          h('b', { text: severityLabel(key) }),
          h('small', { text: t('repSev' + key.charAt(0).toUpperCase() + key.slice(1) + 'Why') }),
        ]));
      });
      sevField.appendChild(seg);
      if (kind === 'bug' && severity === 'urgent') {
        /**
         * Said plainly, because it is true: this wakes people up. Somebody
         * who knows that ticks it when they mean it, and the alert stays
         * worth answering.
         */
        sevField.appendChild(h('p', { class: 'notice warn', text: t('repUrgentWarns') }));
      }
    }

    var labels = { doing: h('label', {}), body: h('label', {}) };
    function drawLabels() {
      labels.doing.textContent = t('repDoing');
      labels.body.textContent = kind === 'bug' ? t('repBodyBug') : t('repBodyIdea');
      body.placeholder = kind === 'bug' ? t('repBodyPlaceholder') : t('repIdeaPlaceholder');
      doing.parentNode.hidden = kind === 'idea';
    }

    /* ---- the duplicate check ---- */
    var dupBox = h('div', { class: 'rep-dups', hidden: true });
    function checkDups() {
      var q = title.value.trim().toLowerCase();
      clear(dupBox);
      if (q.length < 4) { dupBox.hidden = true; return; }

      // Word overlap rather than a substring match: "กดปุ่มบันทึกไม่ได้" and
      // "ปุ่มบันทึกกดไม่ติด" are the same fault and share no substring.
      var words = q.split(/\s+/).filter(function (w) { return w.length > 2; });
      var hits = (state.reports || []).filter(function (r) {
        if (r.state === 'fixed' || r.state === 'declined' || r.state === 'duplicate') return false;
        var hay = r.title.toLowerCase();
        if (hay.indexOf(q) !== -1 || q.indexOf(hay) !== -1) return true;
        return words.length > 1 && words.filter(function (w) { return hay.indexOf(w) !== -1; }).length >= 2;
      }).slice(0, 4);

      if (!hits.length) { dupBox.hidden = true; return; }
      dupBox.hidden = false;
      dupBox.appendChild(h('small', { class: 'rep-dups-head', text: t('repMaybeDup') }));
      hits.forEach(function (r) {
        var btn = h('button', {
          type: 'button', class: 'btn sm' + (r.voted ? ' on' : ''),
          text: r.voted ? t('repMeTooDone') : t('repMeTooShort'),
          onclick: function () {
            btn.disabled = true;
            api('/api/meta?do=report-vote', { method: 'POST', body: { id: r.id } })
              .then(function (d) {
                r.voted = d.voted;
                r.votes = d.votes;
                btn.textContent = d.voted ? t('repMeTooDone') : t('repMeTooShort');
                btn.classList.toggle('on', d.voted);
                if (d.voted) say('ok', t('repMeTooThanks').replace('%s', r.code));
              })
              .catch(function (err) { say('err', errText(err.code)); })
              .then(function () { btn.disabled = false; });
          },
        });
        dupBox.appendChild(h('div', { class: 'rep-dup-row' }, [
          h('code', { text: r.code || '' }),
          h('span', { class: 'grow', text: r.title }),
          h('span', { class: 'rep-dup-votes', text: '👋 ' + r.votes }),
          btn,
        ]));
      });
    }
    title.addEventListener('input', debounceDup(checkDups));

    /* ---- screenshots ---- */
    var shotStrip = h('div', { class: 'rep-shotstrip' });
    var fileIn = h('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, id: 'rep-shots',
    });
    fileIn.addEventListener('change', function () {
      var chosen = Array.prototype.slice.call(fileIn.files || []);
      fileIn.value = '';
      chosen.forEach(function (file) {
        if (shots.length >= (state.maxShots || 3)) { say('err', t('repTooManyShots').replace('%s', state.maxShots || 3)); return; }
        if (file.size > (state.maxShot || 2097152)) { say('err', t('repShotTooBig').replace('%s', Math.round((state.maxShot || 2097152) / 1048576 * 10) / 10)); return; }
        fileToBase64(file).then(function (b64) {
          shots.push({ data: b64, name: file.name, url: URL.createObjectURL(file) });
          drawShots();
        });
      });
    });

    function drawShots() {
      clear(shotStrip);
      shots.forEach(function (shot, i) {
        shotStrip.appendChild(h('div', { class: 'rep-shot' }, [
          h('img', { src: shot.url, alt: shot.name }),
          h('button', {
            type: 'button', class: 'rep-shot-x', text: '✕', 'aria-label': t('remove'),
            onclick: function () {
              URL.revokeObjectURL(shot.url);
              shots.splice(i, 1);
              drawShots();
            },
          }),
        ]));
      });
      if (shots.length < (state.maxShots || 3)) {
        shotStrip.appendChild(h('label', { class: 'rep-shot-add', for: 'rep-shots' }, [
          h('span', { text: '+' }),
          h('small', { text: t('repAddShot') }),
        ]));
      }
    }

    /* ---- what the page is sending about this device ---- */
    var device = deviceLine();
    var where = (location.hash || '#/home');
    var auto = h('details', { class: 'rep-auto' }, [
      h('summary', { text: t('repAutoHead') }),
      h('ul', {}, [
        h('li', { text: t('repAutoPage') + ': ' + where }),
        h('li', { text: t('repAutoDevice') + ': ' + device }),
        h('li', { text: t('repAutoVersion') + ': ' + APP_VERSION }),
      ]),
      h('small', { class: 'hint', text: t('repAutoWhy') }),
    ]);

    var sendBtn = h('button', {
      class: 'btn primary', text: t('repSend'),
      onclick: function () {
        if (!title.value.trim()) { say('err', t('repNeedTitle')); title.focus(); return; }
        sendBtn.disabled = true;
        api('/api/meta?do=report', {
          method: 'POST',
          body: {
            kind: kind,
            title: title.value.trim(),
            severity: severity,
            doing: kind === 'bug' ? doing.value : '',
            body: body.value,
            page: where,
            device: device,
            appVersion: APP_VERSION,
            shots: shots.map(function (s) { return s.data; }),
          },
        }).then(function (d) {
          shots.forEach(function (s) { URL.revokeObjectURL(s.url); });
          veil.remove();
          if (onSaved) onSaved();
          /**
           * The code goes in the confirmation, because it is the handle
           * people use with each other — "R0042 ยังไม่ได้แก้เหรอ" is a
           * question somebody can answer.
           */
          openReportSent(d.report);
        }).catch(function (err) { say('err', errText(err.code)); })
          .then(function () { sendBtn.disabled = false; });
      },
    });

    var modal = h('div', { class: 'modal', style: 'width:min(38rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: t('repNew') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice,
        kindSeg,
        h('div', { class: 'field' }, [
          h('label', { text: t('repTitle') }), title,
          h('small', { class: 'hint', text: t('repTitleWhy') }),
        ]),
        dupBox,
        sevField,
        h('div', { class: 'field' }, [labels.doing, doing, h('small', { class: 'hint', text: t('repDoingWhy') })]),
        h('div', { class: 'field' }, [labels.body, body]),
        h('div', { class: 'field' }, [
          h('label', { text: t('repShots') }),
          shotStrip, fileIn,
          h('small', { class: 'hint', text: t('repShotsWhy') }),
        ]),
        auto,
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        sendBtn,
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
    drawKind();
    drawSeverity();
    drawLabels();
    drawShots();
    title.focus();
  }

  /** A short debounce, so the duplicate check runs on pauses rather than keystrokes. */
  function debounceDup(fn) {
    var timer = null;
    return function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, 250);
    };
  }

  function openReportSent(rep) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var modal = h('div', { class: 'modal', style: 'width:min(26rem,100%)' }, [
      h('header', {}, [h('h2', { text: t('repSentTitle') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } })]),
      h('div', { class: 'body' }, [
        h('p', { class: 'rep-sent-code' }, [h('code', { text: rep.code || '' })]),
        h('p', { text: rep.severity === 'urgent' ? t('repSentUrgent') : t('repSentNormal') }),
        h('small', { class: 'hint', text: t('repSentTold') }),
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn primary', text: t('close'), onclick: function () { veil.remove(); } }),
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
  }

  /**
   * One report, opened.
   *
   * What everybody sees: the words, who reported it, how many others hit it,
   * and what became of it. What only the rota and the reporter see: the
   * screenshots, the browser line and the triage note — a screenshot is
   * whatever was on somebody's screen at the time, which may be a letter or a
   * private message.
   */
  function openReport(rep, state, onChanged) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });
    var bodyBox = h('div', { class: 'body' });

    function say(cls, text) {
      notice.hidden = false;
      notice.className = 'notice ' + cls;
      notice.textContent = text;
    }

    function draw() {
      clear(bodyBox);
      bodyBox.appendChild(notice);

      bodyBox.appendChild(h('div', { class: 'rep-tags' }, [
        h('span', { class: 'rep-kind k-' + rep.kind, text: rep.kind === 'bug' ? t('repKindBug') : t('repKindIdea') }),
        h('span', { class: 'rep-sev sev-' + rep.severity, text: severityLabel(rep.severity) }),
        h('span', { class: 'rep-state st-' + rep.state, text: stateLabel(rep.state) }),
        h('span', { class: 'rep-shots', text: '👋 ' + t('repPeopleHit').replace('%s', rep.votes) }),
      ]));

      bodyBox.appendChild(h('h3', { class: 'rep-detail-title', text: rep.title }));
      bodyBox.appendChild(h('div', { class: 'rep-by' }, [
        avatarNode(rep.createdBy),
        h('span', { text: nameOf(rep.createdBy) }),
        h('span', { class: 'rep-when', text: fmtStamp(rep.createdAt) }),
      ]));

      if (rep.doing) {
        bodyBox.appendChild(field(t('repDoing'), rep.doing));
      }
      if (rep.body) {
        bodyBox.appendChild(field(rep.kind === 'bug' ? t('repBodyBug') : t('repBodyIdea'), rep.body));
      }

      /* ---- the private half ----
       * Gated on the DETAIL having come back, not on the screenshot count.
       * The count is in the open half of the payload so the list can show
       * it, but the images themselves are closed — drawing the strip for
       * somebody who may not fetch them is a row of broken pictures and a
       * row of 403s in their console.
       */
      var maySeeDetail = rep.device !== undefined;
      if (maySeeDetail && rep.shots) {
        var strip = h('div', { class: 'rep-shotstrip' });
        for (var i = 0; i < rep.shots; i++) {
          (function (n) {
            var src = '/api/meta?do=report-shot&id=' + encodeURIComponent(rep.id) + '&i=' + n;
            strip.appendChild(h('a', { class: 'rep-shot', href: src, target: '_blank', rel: 'noopener' }, [
              h('img', { src: src, alt: t('repShots') + ' ' + (n + 1), loading: 'lazy' }),
            ]));
          }(i));
        }
        bodyBox.appendChild(h('div', { class: 'field' }, [h('label', { text: t('repShots') }), strip]));
      }

      if (maySeeDetail) {
        bodyBox.appendChild(h('div', { class: 'rep-tech' }, [
          rep.page ? h('div', {}, [h('b', { text: t('repAutoPage') + ': ' }), h('code', { text: rep.page })]) : null,
          rep.device ? h('div', {}, [h('b', { text: t('repAutoDevice') + ': ' }), h('span', { text: rep.device })]) : null,
          rep.appVersion ? h('div', {}, [h('b', { text: t('repAutoVersion') + ': ' }), h('code', { text: rep.appVersion })]) : null,
        ]));
      }

      if (rep.note) {
        bodyBox.appendChild(h('div', { class: 'rep-note' }, [
          h('small', { text: t('repNoteFrom').replace('%s', nameOf(rep.triagedBy || '')) }),
          h('p', { text: rep.note }),
        ]));
      }

      if (state.mayTriage) bodyBox.appendChild(triageBox());
    }

    function field(label, value) {
      return h('div', { class: 'field' }, [
        h('label', { text: label }),
        h('div', { class: 'rep-pre' }, String(value).split('\n').map(function (line) {
          return line.trim() ? h('p', { text: line }) : h('br', {});
        })),
      ]);
    }

    /* ---- triage, for the rota only ---- */
    function triageBox() {
      var stateSel = h('select', {}, REPORT_STATES.map(function (k) {
        return h('option', { value: k, text: stateLabel(k), selected: rep.state === k ? true : null });
      }));
      var sevSel = h('select', {}, REPORT_SEVS.filter(function (k) {
        return !(rep.kind === 'idea' && k === 'urgent');
      }).map(function (k) {
        return h('option', { value: k, text: severityLabel(k), selected: rep.severity === k ? true : null });
      }));
      var noteIn = h('textarea', { rows: '2', maxlength: '2000', placeholder: t('repNotePlaceholder') });
      noteIn.value = rep.note || '';
      var dupIn = h('input', {
        type: 'text', maxlength: '16', placeholder: 'R0001', class: 'code-input',
        value: rep.dupOf || '',
      });

      var apply = h('button', {
        class: 'btn primary', text: t('repTriageSave'),
        onclick: function () {
          apply.disabled = true;
          var patch = { id: rep.id };
          if (stateSel.value !== rep.state) patch.state = stateSel.value;
          if (sevSel.value !== rep.severity) patch.severity = sevSel.value;
          if (noteIn.value !== (rep.note || '')) patch.note = noteIn.value;
          if (dupIn.value.trim() !== (rep.dupOf || '')) patch.dupOf = dupIn.value.trim();

          api('/api/meta?do=report', { method: 'PATCH', body: patch })
            .then(function (d) {
              rep = d.report;
              say('ok', t('repTriaged'));
              draw();
              if (onChanged) onChanged();
            })
            .catch(function (err) { say('err', errText(err.code)); })
            .then(function () { apply.disabled = false; });
        },
      });

      return h('div', { class: 'rep-triage' }, [
        h('h4', { text: t('repTriage') }),
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('repTriageState') }), stateSel]),
          h('div', { class: 'field' }, [h('label', { text: t('repTriageSev') }), sevSel]),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: t('repTriageNote') }), noteIn,
          h('small', { class: 'hint', text: t('repTriageNoteWhy') }),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: t('repTriageDup') }), dupIn,
          h('small', { class: 'hint', text: t('repTriageDupWhy') }),
        ]),
        h('div', {}, [apply]),
      ]);
    }

    var modal = h('div', { class: 'modal', style: 'width:min(38rem,100%)' }, [
      h('header', {}, [
        h('code', { class: 'rep-code', text: rep.code || '' }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      bodyBox,
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('close'), onclick: function () { veil.remove(); } }),
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
    draw();
  }


  /* ======================================================================
     Composing the pop-up — on the announce page, where admins already are
     ====================================================================== */

  /**
   * The list of pop-ups, under the announcement form.
   *
   * Put here rather than on a page of its own because it is the same job: an
   * admin deciding how loudly to say something. A pop-up and an announcement
   * differ only in how hard they interrupt, and seeing both in one place is
   * what makes that a choice rather than two separate habits.
   */
  function popupSection(main) {
    var box = h('div', {});
    var notice = h('div', { class: 'notice', hidden: true });
    var state = { popups: [], maxLive: 3, liveNow: 0, people: 0, maxImage: 1572864 };

    function say(cls, text) {
      notice.hidden = false;
      notice.className = 'notice ' + cls;
      notice.textContent = text;
    }

    main.appendChild(h('h2', { class: 'section-head', text: t('popManage') }));
    main.appendChild(h('p', { class: 'hint', text: t('popManageWhy') }));
    main.appendChild(notice);
    var newBtn = h('button', {
      class: 'btn primary', text: t('popNew'),
      onclick: function () { openPopupEditor(null, state, load); },
    });
    main.appendChild(h('div', { class: 'shelf-bar' }, [newBtn]));
    main.appendChild(box);

    function draw() {
      clear(box);
      // Offered only while there is room, rather than offered and refused.
      newBtn.disabled = state.liveNow >= state.maxLive;
      newBtn.title = newBtn.disabled ? t('errTooManyLive').replace('%s', state.maxLive) : '';

      if (!state.popups.length) {
        box.appendChild(h('div', { class: 'empty' }, [
          h('strong', { text: t('popNoneYet') }),
          h('p', { text: t('popNoneWhy') }),
        ]));
        return;
      }

      state.popups.forEach(function (p) {
        var when = [
          p.startsAt ? fmtStamp(p.startsAt) : null,
          p.endsAt ? '→ ' + fmtStamp(p.endsAt) : null,
        ].filter(Boolean).join(' ');

        box.appendChild(h('div', { class: 'sent-row' + (p.live ? ' urgent' : '') }, [
          p.hasImage ? h('img', {
            class: 'pop-thumb',
            src: '/api/push?do=popup-image&id=' + encodeURIComponent(p.id),
            alt: '',
          }) : null,
          h('div', { class: 'grow' }, [
            h('b', {}, [
              p.live ? h('span', { class: 'chip urgent-dot', text: t('popLiveNow') }) : null,
              p.title,
            ]),
            p.body ? h('div', { class: 'sub', text: p.body }) : null,
            h('small', {
              text: [
                nameOf(p.createdBy),
                when || t('popWhenWhy').split('—')[0].trim(),
                t('popSeenBy').replace('%1', p.stats.shown).replace('%2', state.people),
                p.linkUrl ? t('popClicked').replace('%s', p.stats.clicked) : null,
                !p.active ? t('popActive') + ': ✕' : null,
              ].filter(Boolean).join(' · '),
            }),
          ]),
          h('div', { class: 'stat' }, [
            h('button', {
              class: 'btn ghost sm', text: t('edit'),
              onclick: function () { openPopupEditor(p, state, load); },
            }),
            h('button', {
              class: 'btn ghost sm danger', text: t('remove'),
              onclick: function () {
                if (!confirm(t('popDeleteAsk').replace('%s', p.title))) return;
                api('/api/push?do=popup-delete&id=' + encodeURIComponent(p.id), { method: 'DELETE' })
                  .then(function () { say('ok', t('popDeleted')); load(); })
                  .catch(function (err) { say('err', errText(err.code)); });
              },
            }),
          ]),
        ]));
      });
    }

    function load() {
      return api('/api/push?do=popups').then(function (d) {
        state = d;
        draw();
      }).catch(function (err) { say('err', errText(err.code)); });
    }

    load();
  }

  /**
   * Writing one.
   *
   * The preview is the important part of this dialog: a pop-up is the only
   * thing in the app that appears over somebody's work, so whoever writes one
   * should see exactly what lands — including how much of the screen it takes
   * on a phone, which is the thing people get wrong.
   */
  function openPopupEditor(popup, state, onSaved) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });

    var title = h('input', { type: 'text', maxlength: '120', placeholder: t('popTitlePlaceholder'), value: (popup && popup.title) || '' });
    var body = h('textarea', { rows: '4', maxlength: '1200', placeholder: t('popBodyPlaceholder') });
    body.value = (popup && popup.body) || '';
    var linkUrl = h('input', { type: 'url', maxlength: '1000', value: (popup && popup.linkUrl) || '' });
    var linkLabel = h('input', { type: 'text', maxlength: '40', placeholder: t('popLinkLabelPlaceholder'), value: (popup && popup.linkLabel) || '' });
    var startsAt = h('input', { type: 'datetime-local', value: toLocalInput(popup && popup.startsAt) });
    var endsAt = h('input', { type: 'datetime-local', value: toLocalInput(popup && popup.endsAt) });
    var activeCb = h('input', { type: 'checkbox', checked: popup ? (popup.active ? true : null) : true });

    var repeat = (popup && popup.repeat) || 'once';
    var repSeg = h('div', { class: 'seg wrap' });
    [['once', t('popRepeatOnce'), t('popRepeatOnceWhy')],
      ['daily', t('popRepeatDaily'), t('popRepeatDailyWhy')],
      ['always', t('popRepeatAlways'), t('popRepeatAlwaysWhy')]].forEach(function (r) {
      repSeg.appendChild(h('button', {
        type: 'button', class: repeat === r[0] ? 'on' : '', title: r[2],
        onclick: function () {
          repeat = r[0];
          repSeg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          this.classList.add('on');
        },
      }, [h('b', { text: r[1] }), h('small', { text: r[2] })]));
    });

    /* ---- the poster ---- */
    var image; // undefined = leave as it is · null = remove · {data} = replace
    var imgBox = h('div', { class: 'pop-img-pick' });
    var imgIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', id: 'pop-img' });
    imgIn.addEventListener('change', function () {
      var file = (imgIn.files || [])[0];
      imgIn.value = '';
      if (!file) return;
      if (file.size > state.maxImage) {
        say('err', t('popImageWhy').replace('%s', Math.round(state.maxImage / 1048576 * 10) / 10));
        return;
      }
      fileToBase64(file).then(function (b64) {
        image = { data: b64, url: URL.createObjectURL(file) };
        drawImage();
        drawPreview();
      });
    });

    function currentImageSrc() {
      if (image === null) return null;
      if (image) return image.url;
      if (popup && popup.hasImage) return '/api/push?do=popup-image&id=' + encodeURIComponent(popup.id);
      return null;
    }

    function drawImage() {
      clear(imgBox);
      var src = currentImageSrc();
      if (src) {
        imgBox.appendChild(h('img', { src: src, alt: '' }));
        imgBox.appendChild(h('button', {
          type: 'button', class: 'btn ghost sm danger', text: t('popImageRemove'),
          onclick: function () {
            if (image && image.url) URL.revokeObjectURL(image.url);
            image = null;
            drawImage();
            drawPreview();
          },
        }));
      }
      imgBox.appendChild(h('label', { class: 'btn', for: 'pop-img', text: src ? t('edit') : t('popImage') }));
      imgBox.appendChild(imgIn);
    }

    /* ---- who sees it ---- */
    var audKind = (popup && popup.audience && popup.audience.kind) || 'everyone';
    var audDepts = (popup && popup.audience && popup.audience.departments) || [];
    var audBox = h('div', { class: 'picker' });

    function drawAud() {
      clear(audBox);
      var seg = h('div', { class: 'seg wrap' }, [
        ['everyone', t('everyone')], ['departments', t('departments')],
      ].map(function (pair) {
        return h('button', {
          type: 'button', class: audKind === pair[0] ? 'on' : '', text: pair[1],
          onclick: function () { audKind = pair[0]; drawAud(); },
        });
      }));
      audBox.appendChild(seg);

      if (audKind === 'departments') {
        var chips = h('div', { class: 'chips' }, (S.departments || []).map(function (d) {
          var on = audDepts.indexOf(d.key) !== -1;
          return h('button', {
            type: 'button', class: 'chip dept' + (on ? ' on' : ''),
            text: deptLabel(d.key),
            onclick: function () {
              var at = audDepts.indexOf(d.key);
              if (at === -1) audDepts.push(d.key); else audDepts.splice(at, 1);
              drawAud();
            },
          });
        }));
        audBox.appendChild(chips);
      }
    }

    /* ---- the preview ---- */
    var preview = h('div', { class: 'pop-preview' });
    function drawPreview() {
      clear(preview);
      var src = currentImageSrc();
      var card = h('div', { class: 'pop-preview-card' }, [
        h('div', { class: 'pop-preview-tag', text: t('popTag') }),
        src ? h('img', { src: src, alt: '' }) : null,
        h('b', { text: title.value || t('popTitlePlaceholder') }),
        body.value ? h('div', { class: 'pop-preview-body' }, body.value.split('\n').map(function (l) {
          return l.trim() ? h('p', { text: l }) : h('br', {});
        })) : null,
        h('div', { class: 'pop-preview-btns' }, [
          linkUrl.value ? h('span', { class: 'btn primary sm', text: linkLabel.value || t('popOpen') }) : null,
          h('span', { class: 'btn sm', text: t('popDismiss') }),
        ]),
      ]);
      preview.appendChild(card);
    }
    [title, body, linkUrl, linkLabel].forEach(function (el) {
      el.addEventListener('input', drawPreview);
    });

    var resetCb = h('input', { type: 'checkbox' });

    function say(cls, text) {
      notice.hidden = false;
      notice.className = 'notice ' + cls;
      notice.textContent = text;
    }

    var saveBtn = h('button', {
      class: 'btn primary', text: popup ? t('save') : t('popNew'),
      onclick: function () {
        if (!title.value.trim()) { say('err', t('shelfNeedTitle')); title.focus(); return; }
        var payload = {
          title: title.value.trim(),
          body: body.value,
          linkUrl: linkUrl.value.trim(),
          linkLabel: linkLabel.value.trim(),
          repeat: repeat,
          startsAt: startsAt.value ? new Date(startsAt.value).toISOString() : null,
          endsAt: endsAt.value ? new Date(endsAt.value).toISOString() : null,
          active: activeCb.checked,
          audience: audKind === 'everyone'
            ? { kind: 'everyone' }
            : { kind: 'departments', departments: audDepts },
        };
        if (popup) {
          payload.id = popup.id;
          payload.resetSeen = resetCb.checked;
        }
        if (image !== undefined) payload.image = image === null ? null : image.data;

        saveBtn.disabled = true;
        api('/api/push?do=popup-save', { method: 'POST', body: payload })
          .then(function () {
            if (image && image.url) URL.revokeObjectURL(image.url);
            veil.remove();
            if (onSaved) onSaved();
          })
          .catch(function (err) {
            say('err', err.code === 'TOO_MANY_LIVE'
              ? t('errTooManyLive').replace('%s', (err.data && err.data.limit) || state.maxLive)
              : errText(err.code));
          })
          .then(function () { saveBtn.disabled = false; });
      },
    });

    var modal = h('div', { class: 'modal pop-editor', style: 'width:min(52rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: popup ? t('popEdit') : t('popNew') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body pop-editor-body' }, [
        notice,
        h('div', { class: 'pop-editor-cols' }, [
          h('div', { class: 'pop-editor-form' }, [
            h('div', { class: 'field' }, [h('label', { text: t('popTitle') }), title]),
            h('div', { class: 'field' }, [h('label', { text: t('popBody') }), body]),
            h('div', { class: 'field' }, [
              h('label', { text: t('popImage') }), imgBox,
              h('small', { class: 'hint', text: t('popImageWhy').replace('%s', Math.round(state.maxImage / 1048576 * 10) / 10) }),
            ]),
            h('div', { class: 'two' }, [
              h('div', { class: 'field' }, [h('label', { text: t('popLink') }), linkUrl]),
              h('div', { class: 'field' }, [h('label', { text: t('popLinkLabel') }), linkLabel]),
            ]),
            h('div', { class: 'field' }, [h('label', { text: t('popWho') }), audBox]),
            h('div', { class: 'field' }, [
              h('label', { text: t('popWhen') }),
              h('div', { class: 'two' }, [
                h('div', { class: 'field' }, [h('small', { text: t('popFrom') }), startsAt]),
                h('div', { class: 'field' }, [h('small', { text: t('popTo') }), endsAt]),
              ]),
              h('small', { class: 'hint', text: t('popWhenWhy') }),
            ]),
            h('div', { class: 'field' }, [h('label', { text: t('popRepeat') }), repSeg]),
            h('label', { class: 'rep-team-row' }, [activeCb, h('span', { text: t('popActive') })]),
            popup ? h('label', { class: 'rep-team-row' }, [
              resetCb,
              h('span', {}, [
                h('span', { text: t('popResetSeen') }),
                h('small', { class: 'hint', text: t('popResetSeenWhy') }),
              ]),
            ]) : null,
          ]),
          h('div', { class: 'pop-editor-prev' }, [
            h('small', { class: 'hint', text: t('popTag') }),
            preview,
          ]),
        ]),
      ]),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]);
    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
    drawImage();
    drawAud();
    drawPreview();
    title.focus();
  }

  /** An ISO stamp as the local wall time a datetime-local input wants. */
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }


  /* ======================================================================
     The feed
     ====================================================================== */

  /**
   * What the committee says to itself.
   *
   * Everything else in this app is work with an owner and a deadline. This is
   * the page where somebody puts up a photo of last night's build, and that
   * is worth a page of its own — two hundred people were already doing it in
   * a LINE group where it scrolled away by morning.
   */
  function pageFeed(main) {
    var state = { posts: [], pinned: [], mayPost: false, myDepartments: [], maxImages: 4 };
    var notice = h('div', { class: 'notice', hidden: true });
    var stream = h('div', { class: 'feed-stream' });
    var moreBtn = h('button', { class: 'btn feed-more', text: t('feedMore'), hidden: true });
    var scopes = h('div', { class: 'seg feed-scopes' });

    function say(kind, text) {
      notice.hidden = false;
      notice.className = 'notice ' + kind;
      notice.textContent = text;
    }

    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('navFeed') })]));
    main.appendChild(notice);
    main.appendChild(scopes);

    var composer = h('div', { class: 'feed-composer' });
    main.appendChild(composer);
    main.appendChild(stream);
    main.appendChild(moreBtn);

    /* ---- which slice of it ---- */
    /**
     * Three tabs and a ฝ่าย picker — not a tab per ฝ่าย.
     *
     * An admin is in all fourteen, so one tab each produced seventeen
     * buttons wrapping over three lines, which is not a choice anybody can
     * make at a glance. The three real modes are tabs; which ฝ่าย is a
     * separate question and gets a dropdown, which also stays one line on a
     * phone however many ฝ่าย somebody belongs to.
     */
    function drawScopes() {
      clear(scopes);
      var at = S.feedScope || 'all';
      [['all', t('feedScopeAll')], ['main', t('feedWhole')], ['mentions', t('feedMentions')]]
        .forEach(function (pair) {
          scopes.appendChild(h('button', {
            type: 'button', class: at === pair[0] ? 'on' : '', text: pair[1],
            onclick: function () { S.feedScope = pair[0]; load(); },
          }));
        });

      var depts = state.myDepartments || [];
      if (!depts.length) return;

      var pick = h('select', { class: 'feed-dept-pick' }, [
        h('option', { value: '', text: t('feedByDept') }),
      ].concat(depts.map(function (key) {
        return h('option', {
          value: 'dept:' + key, text: deptLabel(key),
          selected: at === 'dept:' + key ? true : null,
        });
      })));
      pick.addEventListener('change', function () {
        // Back to ทั้งหมด when the blank row is chosen, rather than showing
        // a feed of nothing with no tab looking selected.
        S.feedScope = pick.value || 'all';
        load();
      });
      scopes.appendChild(h('div', { class: 'feed-dept-wrap' + (at.indexOf('dept:') === 0 ? ' on' : '') }, [pick]));
    }

    function scopeQuery() {
      var at = S.feedScope || 'all';
      if (at.indexOf('dept:') === 0) {
        return 'scope=dept&department=' + encodeURIComponent(at.slice(5));
      }
      return 'scope=' + encodeURIComponent(at);
    }

    /* ---- writing one ---- */
    function drawComposer() {
      clear(composer);
      if (!state.mayPost) return;

      var box = h('textarea', { rows: '2', maxlength: '4000', placeholder: t('feedSay') });
      var shots = [];
      var strip = h('div', { class: 'feed-shots' });
      var fileIn = h('input', {
        type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, id: 'feed-img',
      });

      /**
       * Where it goes. Defaults to the whole committee, which is the honest
       * default for a feed — a post nobody can find is worse than one a few
       * extra people scroll past.
       */
      var where = h('select', { class: 'feed-where' }, [
        h('option', { value: '', text: t('feedWhole') }),
      ].concat((state.myDepartments || []).map(function (key) {
        return h('option', { value: key, text: deptLabel(key) });
      })));
      // Posting from inside a ฝ่าย tab starts on that ฝ่าย, which is almost
      // always what was meant by going there first.
      if ((S.feedScope || '').indexOf('dept:') === 0) where.value = S.feedScope.slice(5);

      function drawShots() {
        clear(strip);
        shots.forEach(function (shot, i) {
          strip.appendChild(h('div', { class: 'feed-shot' }, [
            h('img', { src: shot.url, alt: '' }),
            h('button', {
              type: 'button', class: 'rep-shot-x', text: '✕', 'aria-label': t('remove'),
              onclick: function () {
                URL.revokeObjectURL(shot.url);
                shots.splice(i, 1);
                drawShots();
              },
            }),
          ]));
        });
        if (shots.length < (state.maxImages || 4)) {
          strip.appendChild(h('label', { class: 'rep-shot-add', for: 'feed-img' }, [
            h('span', { text: '+' }), h('small', { text: t('feedAddImage') }),
          ]));
        }
      }

      fileIn.addEventListener('change', function () {
        var chosen = Array.prototype.slice.call(fileIn.files || []);
        fileIn.value = '';
        chosen.forEach(function (file) {
          if (shots.length >= (state.maxImages || 4)) {
            say('err', t('feedTooManyImages').replace('%s', state.maxImages || 4));
            return;
          }
          if (file.size > (state.maxImage || 2097152)) {
            say('err', t('feedImageTooBig').replace('%s', Math.round((state.maxImage || 2097152) / 1048576 * 10) / 10));
            return;
          }
          fileToBase64(file).then(function (b64) {
            shots.push({ data: b64, url: URL.createObjectURL(file) });
            drawShots();
          });
        });
      });

      var sendBtn = h('button', {
        class: 'btn primary', text: t('feedPost'),
        onclick: function () {
          if (!box.value.trim() && !shots.length) { say('err', t('feedNeedSomething')); box.focus(); return; }
          sendBtn.disabled = true;
          api('/api/notifications?do=feed-post', {
            method: 'POST',
            body: {
              body: box.value,
              department: where.value || null,
              images: shots.map(function (s) { return s.data; }),
            },
          }).then(function () {
            shots.forEach(function (s) { URL.revokeObjectURL(s.url); });
            notice.hidden = true;
            load();
          }).catch(function (err) { say('err', errText(err.code)); })
            .then(function () { sendBtn.disabled = false; });
        },
      });

      composer.appendChild(h('div', { class: 'feed-compose-row' }, [
        avatarNode(S.user.username),
        h('div', { class: 'grow' }, [
          box, strip, fileIn,
          h('div', { class: 'feed-compose-foot' }, [
            where, h('span', { class: 'grow' }), sendBtn,
          ]),
        ]),
      ]));
      drawShots();
    }

    /* ---- one card ---- */
    function card(post, isPinned) {
      var head = h('div', { class: 'feed-head' }, [
        avatarNode(post.createdBy),
        h('div', { class: 'grow' }, [
          h('b', { text: nameOf(post.createdBy) }),
          h('div', { class: 'feed-when' }, [
            h('span', { text: fmtStamp(post.createdAt) }),
            post.editedAt ? h('span', { text: ' · ' + t('feedEdited') }) : null,
            post.department ? h('span', { class: 'chip dept', text: deptLabel(post.department) }) : null,
            isPinned ? h('span', { class: 'chip pin', text: '📌 ' + t('feedPinned') }) : null,
          ].filter(Boolean)),
        ]),
        postMenu(post, isPinned),
      ]);

      var body = post.body
        ? h('div', { class: 'feed-body' }, String(post.body).split('\n').map(function (line) {
          return line.trim() ? h('p', { text: line }) : h('br', {});
        }))
        : null;

      /**
       * The pictures, laid out by how many there are.
       *
       * One photo gets the full width at its own shape; two sit side by side;
       * three or four become a grid. A fixed grid would letterbox a single
       * portrait photo into a thin strip, which is what most phone photos are.
       */
      var shots = null;
      if (post.images.length) {
        shots = h('div', { class: 'feed-images n' + post.images.length });
        post.images.forEach(function (img, i) {
          var src = '/api/notifications?do=feed-image&id=' + encodeURIComponent(post.id) + '&i=' + img.idx;
          var frame = h('a', {
            class: 'feed-img', href: src, target: '_blank', rel: 'noopener',
            title: t('feedOpenImage'),
          }, [h('img', { src: src, alt: '', loading: i ? 'lazy' : 'eager' })]);
          if (post.images.length === 1 && img.width && img.height) {
            frame.style.aspectRatio = img.width + ' / ' + img.height;
          }
          shots.appendChild(frame);
        });
      }

      var links = post.links.length
        ? h('div', { class: 'feed-links' }, post.links.map(function (l) {
          return h('a', { class: 'feed-link', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, [
            h('b', { text: l.title || hostOfUrl(l.url) }),
            h('small', { text: hostOfUrl(l.url) }),
          ]);
        }))
        : null;

      /* ---- like and reply counts ---- */
      var likeBtn = h('button', {
        type: 'button', class: 'feed-act' + (post.liked ? ' on' : ''),
        onclick: function () {
          likeBtn.disabled = true;
          api('/api/notifications?do=feed-like', { method: 'POST', body: { id: post.id } })
            .then(function (d) {
              post.liked = d.liked;
              post.likes = d.likes;
              likeBtn.classList.toggle('on', d.liked);
              likeCount.textContent = d.likes ? String(d.likes) : '';
            })
            .catch(function (err) { say('err', errText(err.code)); })
            .then(function () { likeBtn.disabled = false; });
        },
      });
      var likeCount = h('b', { text: post.likes ? String(post.likes) : '' });
      likeBtn.appendChild(h('span', { text: '❤' }));
      likeBtn.appendChild(h('span', { text: t('feedLike') }));
      likeBtn.appendChild(likeCount);

      var replies = h('div', { class: 'feed-replies' });
      var replyBtn = h('button', {
        type: 'button', class: 'feed-act',
        onclick: function () {
          replies.hidden = !replies.hidden;
          if (!replies.hidden) {
            var inp = replies.querySelector('input');
            if (inp) inp.focus();
          }
        },
      }, [
        h('span', { text: '💬' }),
        h('span', { text: t('feedReply') }),
        h('b', { text: post.comments.length ? String(post.comments.length) : '' }),
      ]);

      drawReplies(replies, post);
      // Replies start open when there are a few, because a conversation
      // hidden behind a button is a conversation nobody joins.
      replies.hidden = post.comments.length === 0;

      return h('article', { class: 'feed-card' + (isPinned ? ' pinned' : '') }, [
        head, body, shots, links,
        h('div', { class: 'feed-acts' }, [likeBtn, replyBtn]),
        replies,
      ].filter(Boolean));
    }

    /* ---- the ••• menu ---- */
    function postMenu(post, isPinned) {
      var items = [];
      if (state.mayModerate) {
        items.push([isPinned ? t('feedUnpin') : t('feedPin'), function () {
          api('/api/notifications?do=feed-post', {
            method: 'PATCH', body: { id: post.id, pinned: !isPinned },
          }).then(load).catch(function (err) {
            say('err', err.code === 'TOO_MANY_PINNED'
              ? t('feedTooManyPinned').replace('%s', (err.data && err.data.limit) || 5)
              : errText(err.code));
          });
        }]);
      }
      if (post.mayEdit) {
        items.push([t('edit'), function () { openPostEditor(post, load); }]);
      }
      if (post.mayDelete) {
        items.push([t('remove'), function () {
          if (!confirm(t('feedDeleteSure'))) return;
          api('/api/notifications?do=feed-post&id=' + encodeURIComponent(post.id), { method: 'DELETE' })
            .then(load).catch(function (err) { say('err', errText(err.code)); });
        }]);
      }
      if (!post.mine) {
        items.push([t('feedReport'), function () {
          if (!confirm(t('feedReportSure'))) return;
          api('/api/notifications?do=feed-report', { method: 'POST', body: { postId: post.id } })
            .then(function () { say('ok', t('feedReported')); })
            .catch(function (err) { say('err', errText(err.code)); });
        }]);
      }
      if (!items.length) return null;

      var pop = h('div', { class: 'feed-menu-pop', hidden: true }, items.map(function (it) {
        return h('button', { type: 'button', text: it[0], onclick: function () { pop.hidden = true; it[1](); } });
      }));
      var btn = h('button', {
        type: 'button', class: 'btn ghost sm feed-menu', text: '⋯', 'aria-label': t('feedMenu'),
        onclick: function (e) {
          e.stopPropagation();
          var was = pop.hidden;
          // Only ever one open: a second menu over the first is two lists of
          // actions with no way to tell which post either belongs to.
          document.querySelectorAll('.feed-menu-pop').forEach(function (x) { x.hidden = true; });
          pop.hidden = !was;
        },
      });
      return h('div', { class: 'feed-menu-wrap' }, [btn, pop]);
    }

    /* ---- replies ---- */
    function drawReplies(into, post) {
      clear(into);
      post.comments.forEach(function (c) {
        into.appendChild(h('div', { class: 'feed-reply' }, [
          avatarNode(c.createdBy, 'sm'),
          h('div', { class: 'grow' }, [
            h('b', { text: nameOf(c.createdBy) }),
            h('span', { class: 'feed-reply-body', text: c.body }),
            h('div', { class: 'feed-when', text: fmtStamp(c.createdAt) }),
          ]),
          c.mayDelete ? h('button', {
            type: 'button', class: 'btn ghost sm', text: '✕', 'aria-label': t('remove'),
            onclick: function () {
              api('/api/notifications?do=feed-comment&id=' + encodeURIComponent(c.id), { method: 'DELETE' })
                .then(load).catch(function (err) { say('err', errText(err.code)); });
            },
          }) : null,
        ].filter(Boolean)));
      });

      var inp = h('input', { type: 'text', maxlength: '1500', placeholder: t('feedReplyPlaceholder') });
      var send = function () {
        if (!inp.value.trim()) return;
        inp.disabled = true;
        api('/api/notifications?do=feed-comment', {
          method: 'POST', body: { postId: post.id, body: inp.value.trim() },
        }).then(load).catch(function (err) {
          inp.disabled = false;
          say('err', errText(err.code));
        });
      };
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); send(); }
      });
      into.appendChild(h('div', { class: 'feed-reply-add' }, [
        avatarNode(S.user.username, 'sm'),
        inp,
        h('button', { class: 'btn sm', text: t('feedSend'), onclick: send }),
      ]));
    }

    /* ---- drawing it ---- */
    function draw() {
      drawScopes();
      drawComposer();
      clear(stream);

      (state.pinned || []).forEach(function (p) { stream.appendChild(card(p, true)); });

      if (!state.posts.length && !(state.pinned || []).length) {
        stream.appendChild(h('div', { class: 'empty' }, [
          h('strong', { text: t('feedNone') }),
          h('p', { text: state.mayPost ? t('feedNoneSay') : t('feedNoneWait') }),
        ]));
        return;
      }
      state.posts.forEach(function (p) { stream.appendChild(card(p, false)); });
      moreBtn.hidden = !state.more;
    }

    moreBtn.addEventListener('click', function () {
      if (!state.next) return;
      moreBtn.disabled = true;
      api('/api/notifications?do=feed&' + scopeQuery() + '&before=' + encodeURIComponent(state.next))
        .then(function (d) {
          // Appended rather than redrawn, so the page does not jump back to
          // the top of a feed somebody has been scrolling through.
          d.posts.forEach(function (p) { stream.appendChild(card(p, false)); });
          state.posts = state.posts.concat(d.posts);
          state.more = d.more;
          state.next = d.next;
          moreBtn.hidden = !d.more;
        })
        .catch(function (err) { say('err', errText(err.code)); })
        .then(function () { moreBtn.disabled = false; });
    });

    function load() {
      return api('/api/notifications?do=feed&' + scopeQuery())
        .then(function (d) { state = d; draw(); })
        .catch(function (err) { say('err', errText(err.code)); });
    }

    if (!S.feedScope) S.feedScope = 'all';
    load();
  }

  /** Closing an open ••• menu by clicking anywhere else. */
  document.addEventListener('click', function () {
    document.querySelectorAll('.feed-menu-pop').forEach(function (x) { x.hidden = true; });
  });

  /** Editing the words of a post. The pictures are deliberately not editable. */
  function openPostEditor(post, onSaved) {
    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    var notice = h('div', { class: 'notice', hidden: true });
    var box = h('textarea', { rows: '5', maxlength: '4000' });
    box.value = post.body || '';

    var saveBtn = h('button', {
      class: 'btn primary', text: t('save'),
      onclick: function () {
        saveBtn.disabled = true;
        api('/api/notifications?do=feed-post', { method: 'PATCH', body: { id: post.id, body: box.value } })
          .then(function () { veil.remove(); if (onSaved) onSaved(); })
          .catch(function (err) {
            notice.hidden = false;
            notice.className = 'notice err';
            notice.textContent = errText(err.code);
            saveBtn.disabled = false;
          });
      },
    });

    veil.appendChild(h('div', { class: 'modal', style: 'width:min(34rem,100%)' }, [
      h('header', {}, [
        h('h2', { text: t('feedEdit') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice, box,
        post.images.length ? h('small', { class: 'hint', text: t('feedEditImagesWhy') }) : null,
      ].filter(Boolean)),
      h('footer', {}, [
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', text: t('cancel'), onclick: function () { veil.remove(); } }),
        saveBtn,
      ]),
    ]));
    $('modal-root').appendChild(veil);
    box.focus();
  }

  /**
   * A last resort for the splash.
   *
   * Everything above takes it down on success and on failure, but a thrown
   * error somewhere unexpected would leave it covering the page forever. After
   * twenty seconds it comes down regardless, so the worst case is a visible
   * sign-in box rather than a screen nobody can get past.
   */
  setTimeout(bootDone, 20000);

  /**
   * Coming back to the tab after looking at something else.
   *
   * Two jobs, and they used to be one. Catching up on what other people
   * changed is the obvious one. The other is R0002: somebody switched to a
   * spreadsheet for two minutes, came back, and found the app blank every
   * single time, with closing the tab the only way out.
   *
   * What emptied it is still not reproducible outside Safari — so rather
   * than guess at a cause, this checks the one thing that is always true of
   * the symptom: signed in, and nothing on screen. If that is where the tab
   * is, it is drawn again. Whatever did it, the tab heals itself.
   */
  function backFromAway() {
    if (!S.user) return;

    var app = $('app-view');
    var main = $('main');
    var blank = (app && app.hidden) || !main || main.childElementCount === 0;
    if (blank) {
      console.warn('[recover] came back to an empty page — drawing it again');
      renderShell();
      renderPage();
    }

    /**
     * Then the catching up. One redraw at the end rather than one per
     * answer: two calls each calling renderPage() meant the page was built
     * twice, and a throw inside either left it cleared with the error
     * swallowed by an empty catch — which is how a blank page stays blank
     * and unexplained.
     */
    Promise.all([
      api('/api/tasks').then(function (d) { S.tasks = d.tasks; }).catch(function () {}),
      api('/api/events').then(function (d) { S.events = d.events; }).catch(function () {}),
    ]).then(function () { if (S.user) renderPage(); });

    refreshNotifications().then(showPending).catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') backFromAway();
  });
  /**
   * `visibilitychange` covers a tab switch; `focus` covers switching to
   * another window or app, which on some browsers does not fire it. And
   * `pageshow` with `persisted` is a page brought back from the browser's
   * own cache, where the DOM may be anything at all.
   */
  window.addEventListener('focus', function () {
    if (document.visibilityState !== 'hidden') backFromAway();
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) backFromAway(); });

  /**
   * A notification tapped while the app is already open. The service worker
   * focuses the existing window and tells it which one, rather than opening a
   * second copy of the app.
   */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'open-notification' || !S.user) return;
      refreshNotifications().then(function () {
        if (event.data.id) openNotification(event.data.id);
      });
    });
  }
})();
