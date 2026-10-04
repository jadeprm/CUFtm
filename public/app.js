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

  var t = function (key) {
    var table = window.STRINGS[S.lang] || window.STRINGS.th;
    return table[key] !== undefined ? table[key] : key;
  };
  var errText = function (code) {
    var key = window.ERROR_KEYS[code];
    return key ? t(key) : t('errGeneric');
  };

  /* ---------- task vocabulary --------------------------------------------
     Mirrors lib/scope.js. Listed in the order work actually moves, which is
     also the order every menu and segmented control shows them in.
     ---------------------------------------------------------------------- */
  var STATUS_LIST = ['todo', 'doing', 'review', 'feedback', 'done'];
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
  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || 'SERVER'); e.code = data.error; e.data = data; throw e; }
        return data;
      });
    });
  }

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

  function renderAuth() {
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
  }

  $('auth-form').addEventListener('submit', function (e) {
    e.preventDefault();
    showAuthNotice('');

    if (authState.mode === 'ask') {
      var name = $('in-username').value.trim();
      if (!name) return;
      api('/api/auth?do=check', { method: 'POST', body: { username: name } })
        .then(function (data) {
          if (!data.known) { showAuthNotice(t('errNoSuchUser')); return; }
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
          boot();
        })
        .catch(function (err) { showAuthNotice(errText(err.code)); });
    } else {
      api('/api/auth?do=login', { method: 'POST', body: { username: authState.username, password: password } })
        .then(function (data) {
          S.user = data.user; S.lang = data.user.lang || S.lang;
          if (data.user.theme) applyTheme(data.user.theme);
          boot();
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
     Shell
     ====================================================================== */
  function setLang(lang) {
    S.lang = lang === 'en' ? 'en' : 'th';
    try { localStorage.setItem('fair-lang', S.lang); } catch (e) {}
    document.documentElement.lang = S.lang;
    if (S.user) {
      api('/api/users?do=me', { method: 'PATCH', body: { lang: S.lang } }).catch(function () {});
      renderShell(); renderPage();
    } else renderAuth();
  }
  document.querySelectorAll('.lang-toggle button').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.dataset.lang); });
  });
  document.querySelectorAll('.theme-toggle button').forEach(function (b) {
    b.addEventListener('click', function () { setTheme(b.dataset.theme); });
  });

  function renderShell() {
    $('auth-view').hidden = true;
    $('app-view').hidden = false;
    $('brand-name').textContent = t('appName');
    $('brand-sub').textContent = t('appSub');
    document.querySelectorAll('#app-view [data-t]').forEach(function (n) { n.textContent = t(n.dataset.t); });
    document.querySelectorAll('.lang-toggle button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.lang === S.lang);
    });
    document.querySelectorAll('#tabs a').forEach(function (a) {
      a.classList.toggle('on', a.dataset.page === S.page);
    });
    $('tab-admin').hidden = !S.canManage;
    $('tab-announce').hidden = !S.canManage;

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
    var raw = (location.hash || '#/mine').replace('#/', '');

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
    if (['work', 'calendar', 'docs', 'profile', 'links', 'admin', 'announce'].indexOf(page) === -1) page = 'work';
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
      h('button', { class: 'btn primary', text: t('docNew'), onclick: function () { openDocUpload(); } }),
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
        list.appendChild(h('div', { class: 'empty' }, [h('strong', {
          text: S.docs.length ? t('docNoneMatch') : t('docNone') })]));
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
        ' · ' + fmtDate(String(doc.createdAt).slice(0, 10)) }),
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
                  department: S.user.department || null, unit: S.user.unit || null };
    var pdfBase64 = null;
    var pdfBytes = null;
    var pages = 0;
    var chain = [];
    var people = [];
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

      var fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf' });
      var fileNote = h('p', { class: 'hint', text: t('docPdfHelp') });
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
        h('div', { class: 'field' }, [h('label', { text: t('docPdf') }), fileInput, fileNote]),
      ]));
      fillUnits();

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
        method: 'POST', body: { department: draft.department, unit: draft.unit },
      }).then(function (data) {
        chain = data.steps.map(function (s) {
          return { role: s.role, roleLabel: s.roleLabel, username: s.username,
                   options: s.options, signs: s.signs, marks: [] };
        });
        people = data.people;
        stage = 'who';
        drawWho();
      }).catch(function (err) { fail(errText(err.code)); });
    }

    /* ---- stage 2: who signs ---- */
    function drawWho() {
      clear(bodyBox); clear(footer);
      var rows = chain.map(function (step, i) {
        var choices = step.options.length ? step.options : people.map(function (p) { return p.username; });
        var select = h('select', {
          onchange: function (e) { step.username = e.target.value || null; },
        }, [h('option', { value: '', text: t('docPickPerson') })].concat(
          choices.map(function (u) {
            var p = people.filter(function (x) { return x.username === u; })[0];
            var label = (p ? (p.displayName || p.username) : u) + (p && p.position ? ' · ' + p.position : '');
            return h('option', { value: u, text: label, selected: step.username === u });
          })));

        return h('div', { class: 'chain-row' }, [
          h('span', { class: 'chain-n', text: String(i + 1) }),
          h('div', { class: 'chain-main' }, [
            h('label', {}, [step.roleLabel, step.signs
              ? h('span', { class: 'chip unit', style: 'margin-left:6px', text: t('docSigns') }) : null]),
            select,
          ]),
        ]);
      });

      bodyBox.appendChild(h('div', { class: 'pane' }, [
        notice,
        h('p', { class: 'hint', text: t('docChainHelp') }),
        h('div', { class: 'chain' }, rows),
      ]));

      footer.appendChild(h('button', {
        class: 'btn primary', text: t('docNext'),
        onclick: function () {
          var blank = chain.filter(function (s) { return !s.username; });
          if (blank.length) { fail(t('docPickEveryone')); return; }
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

      marking = marking || needMarks[0];
      var canvas = h('canvas', { class: 'pdf-canvas' });
      var overlay = h('div', { class: 'pdf-overlay' });
      var sheet = h('div', { class: 'pdf-sheet' }, [canvas, overlay]);
      var pager = h('div', { class: 'pdf-pager' });

      var who = h('div', { class: 'seg wrap' }, needMarks.map(function (step) {
        return h('button', {
          type: 'button', class: marking === step ? 'on' : '',
          text: (step.marks.length ? '✓' + step.marks.length + ' ' : '') + nameOf(step.username),
          onclick: function () { marking = step; drawMarks(); },
        });
      }));

      function paintOverlay() {
        clear(overlay);
        chain.forEach(function (s) {
          (s.marks || []).forEach(function (m) {
            if (m.page !== pageShown) return;
            overlay.appendChild(h('div', {
              class: 'sig-box' + (s === marking ? ' on' : ''),
              style: 'left:' + (m.x * 100) + '%;top:' + (m.y * 100) + '%;' +
                     'width:' + (m.w * 100) + '%;height:' + (m.h * 100) + '%',
            }, [h('span', { text: nameOf(s.username) })]));
          });
        });
      }

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
        var w = 0.26;
        var hh = 0.075;
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
        drawFooter();
      }
      sheet.addEventListener('click', place);

      bodyBox.appendChild(h('div', { class: 'pane' }, [
        notice,
        h('p', { class: 'hint', text: t('docMarkHelp') }),
        h('p', { class: 'hint', text: t('docMarkAdd') }),
        who,
        pager,
        sheet,
      ]));

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
          pdf: pdfBase64,
          steps: chain.map(function (s) {
            return { role: s.role, username: s.username, marks: s.marks };
          }),
        },
      }).then(function (data) {
        veil.remove();
        api('/api/documents').then(function (fresh) {
          S.docs = fresh.documents || [];
          renderPage();
          openDoc(data.id);
        });
      }).catch(function (err) {
        fail(err.data && err.data.error === 'FILE_TOO_BIG' ? t('docTooBig') : errText(err.code));
        drawMarks();
      });
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
          fmtDate(String(doc.createdAt).slice(0, 10), { day: 'numeric', month: 'long', year: 'numeric' }) }),
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
        var when = p.at ? fmtDate(String(p.at).slice(0, 10), { day: 'numeric', month: 'short' }) +
          ' ' + String(p.at).slice(11, 16) + ' น.' : '';
        return h('li', { class: 'ds ' + p.state }, [
          h('span', { class: 'ds-dot' }),
          h('div', { class: 'ds-main' }, [
            h('div', { class: 'ds-label' }, [
              p.label,
              p.signs ? h('span', { class: 'chip unit', text: t('docSigns') }) : null,
            ]),
            p.username ? h('div', { class: 'ds-who' }, [avatarNode(p.username, 'sm'), nameOf(p.username)]) : null,
            when ? h('div', { class: 'ds-when', text: when }) : null,
            p.comment ? h('div', { class: 'ds-note', text: '“' + p.comment + '”' }) : null,
          ]),
        ]);
      }));
      pane.appendChild(steps);

      pane.appendChild(h('div', { class: 'view-rows' }, [
        vRow(t('docRecipient'), doc.recipient ? h('span', { text: doc.recipient }) : vMuted('—')),
        vRow(t('docUploader'), h('span', { class: 'selected' },
          [h('span', { class: 'chip who' }, [avatarNode(doc.createdBy, 'sm'), nameOf(doc.createdBy)])])),
        vRow(t('docFiles'), h('span', { class: 'selected' }, data.files.map(function (f) {
          return h('a', {
            class: 'chip dept', target: '_blank', rel: 'noopener',
            href: '/api/documents?id=' + encodeURIComponent(doc.id) + '&file=' + f.kind,
            text: (f.kind === 'signed' ? t('docSignedCopy') : t('docOriginal')) +
              ' · ' + Math.round(f.size / 1024) + ' KB',
          });
        }).concat(doc.driveUrl ? [h('a', {
          // Once a finished document has been filed in Drive, that copy is the
          // one that lasts — so the link to it is shown here rather than
          // leaving people to hunt through a folder for it.
          class: 'chip dept', target: '_blank', rel: 'noopener',
          href: doc.driveUrl, text: t('docInDrive'),
        })] : []))),
      ]));

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
          class: 'btn primary', text: t('docMarkSent'),
          onclick: function () {
            if (!confirm(t('docMarkSentSure'))) return;
            act('send', { to: doc.recipient });
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
    }

    function save(base64) {
      api('/api/documents?do=signature', { method: 'POST', body: { png: base64 } })
        .then(function () { draw({ has: true }); })
        .catch(function (err) { alert(errText(err.code)); });
    }

    api('/api/documents?do=signature').then(draw).catch(function () { draw({ has: false }); });
    return box;
  }

  /* ======================================================================
     Pages
     ====================================================================== */
  function renderPage() {
    var main = clear($('main'));
    if (S.page === 'work') return pageTasks(main);
    if (S.page === 'calendar') return pageCalendar(main);
    if (S.page === 'docs') return pageDocs(main);
    if (S.page === 'profile') return pageProfile(main);
    if (S.page === 'links') return pageLinks(main);
    if (S.page === 'admin') return pageAdmin(main);
    if (S.page === 'announce') return pageAnnounce(main);
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
  function visibleTasks(mineOnly) {
    return S.tasks.filter(function (task) {
      if (mineOnly && task.assignees.indexOf(S.user.username) === -1) return false;
      if (S.filter === 'open' && task.status === 'done') return false;
      /**
       * Every status, from the one list.
       *
       * This used to name three of them by hand, so รอตรวจ and ตรวจแล้ว
       * matched nothing and fell through with no filter applied at all —
       * picking either tab showed the whole list, including finished work,
       * while the count beside the tab was right. Reading the statuses from
       * STATUS_LIST means a status can never be forgotten here again.
       */
      if (STATUS_LIST.indexOf(S.filter) !== -1 && task.status !== S.filter) return false;
      if (!matchesQuery(task)) return false;
      if (S.who && task.assignees.indexOf(S.who) === -1) return false;
      if (S.prio && task.priority !== S.prio) return false;
      if (S.unit && task.unit !== S.unit) return false;
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
   * One page for everything that has a date on it.
   *
   * Mine, everyone's, and the events used to be three tabs, which meant
   * checking three places to know what was going on — and the same task
   * appeared in two of them. Now it is one page with a switch at the top, and
   * the events sit above the work because that is the order they matter in:
   * a rehearsal on Friday changes what you do about Friday's deadlines.
   */
  function pageTasks(main) {
    var mineOnly = S.scope !== 'all';

    main.appendChild(h('div', { class: 'page-head' }, [
      h('div', { class: 'seg scope-seg' }, [['mine', 'scopeMine'], ['all', 'scopeAll']].map(function (pair) {
        return h('button', {
          class: S.scope === pair[0] ? 'on' : '',
          text: t(pair[1]),
          onclick: function () { S.scope = pair[0]; renderPage(); },
        });
      })),
      h('span', { class: 'grow' }),
      /**
       * A member sees no way to create work, because there is none: the
       * server refuses it either way, and offering a button that always ends
       * in an error is worse than not offering it.
       */
      mayCreate() ? h('button', { class: 'btn', text: '\u2191 ' + t('importTasks'), onclick: openImport }) : null,
      mayCreate() ? h('button', { class: 'btn', text: t('mtgNew'), onclick: function () { openMeeting(null); } }) : null,
      mayCreate() ? h('button', { class: 'btn', text: t('newEvent'), onclick: function () { openEvent(null); } }) : null,
      mayCreate() ? h('button', { class: 'btn primary', text: t('newTask'), onclick: function () { openTask(null); } }) : null,
    ]));

    meetingStrip(main, mineOnly);
    eventStrip(main, mineOnly);

    var pool = S.tasks.filter(function (x) {
      return !mineOnly || x.assignees.indexOf(S.user.username) !== -1;
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

    /**
     * Department first, person second.
     *
     * A flat list of every person stops working the moment the roster grows
     * past the heads, which it is about to. Picking a department narrows the
     * person list to that department, so the second dropdown stays short.
     */
    var deptSelect = h('select', {
      onchange: function (e) { S.dept = e.target.value; S.who = ''; S.unit = ''; renderPage(); },
    }, [h('option', { value: '', text: t('allDepartments') })].concat(
      myDepartments().map(function (d) {
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
          onchange: function (e) { S.unit = e.target.value; renderPage(); },
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
      onchange: function (e) { S.who = e.target.value; renderPage(); },
    }, [h('option', { value: '', text: t('everyone') })].concat(
      groupedPeopleOptions(peopleForPicker)
    ));

    var prioSelect = h('select', {
      onchange: function (e) { S.prio = e.target.value; renderPage(); },
    }, [h('option', { value: '', text: t('priority') })].concat(
      PRIORITY_LIST.map(function (p) {
        return h('option', { value: p, text: prioLabel(p), selected: S.prio === p });
      })
    ));

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

    main.appendChild(h('div', { class: 'filters' }, [
      seg, h('span', { class: 'grow' }),
      searchBox,
      h('div', { class: 'filter-selects' }, [prioSelect, deptSelect, unitSelect, whoSelect]),
    ]));

    if (!S.seesEverything) {
      main.appendChild(h('p', {
        style: 'margin:-6px 0 12px;font-size:12.5px;color:var(--ink-faint)',
        text: t('deptOnlyNote'),
      }));
    }

    var rows = visibleTasks(mineOnly);
    if (!rows.length) {
      main.appendChild(h('div', { class: 'empty' }, [
        h('strong', { text: pool.length ? t('emptyFilter') : (mineOnly ? t('emptyMine') : t('emptyAll')) }),
        pool.length ? '' : (mineOnly ? t('emptyMineSub') : t('emptyAllSub')),
      ]));
      return;
    }
    main.appendChild(h('ul', { class: 'tasks' }, rows.map(taskRow)));
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
  function eventStrip(main, mineOnly) {
    var today = todayIso();
    var coming = S.events.filter(function (e) {
      if ((e.endsOn || e.startsOn) < today) return false;
      if (mineOnly && (e.people || []).length && e.people.indexOf(S.user.username) === -1) return false;
      // A search covers events as well as tasks — asking for E0007 and being
      // shown the whole calendar would not be a search.
      return matchesQuery(e);
    }).map(function (e) { return { kind: 'event', on: e.startsOn, item: e }; });

    if (!coming.length) return;

    var shown = coming.slice(0, 6);
    main.appendChild(h('div', { class: 'event-strip' }, [
      h('div', { class: 'strip-head' }, [
        h('b', { text: t('upcoming') }),
        coming.length > shown.length
          ? h('small', { text: '+' + (coming.length - shown.length) })
          : null,
      ]),
      h('div', { class: 'strip-rail' }, shown.map(function (entry) {
        var event = entry.item;
        return h('button', {
          class: 'event-card' + (event.pending ? ' pending' : ''),
          style: '--c:' + colourHex(event.colour),
          onclick: function () { openEvent(event); },
        }, [
          h('div', { class: 'ec-when', text: eventWhen(event) }),
          h('div', { class: 'ec-title', text: event.title }),
          event.place ? h('div', { class: 'ec-where', text: event.place }) : null,
        ]);
      })),
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
  function meetingStrip(main, mineOnly) {
    var today = todayIso();
    var coming = (S.meetings || []).filter(function (m) {
      if (m.meetsOn < today || m.status === 'cancelled') return false;
      if (mineOnly && !(m.people || []).some(function (x) {
        return x.username === S.user.username;
      })) return false;
      return matchesQuery({ code: m.code, title: m.title, place: m.place });
    }).sort(function (a, b) { return a.meetsOn < b.meetsOn ? -1 : 1; });

    if (!coming.length) return;
    var shown = coming.slice(0, 6);

    main.appendChild(h('div', { class: 'event-strip' }, [
      h('div', { class: 'strip-head' }, [
        h('b', { text: t('navMeetings') }),
        coming.length > shown.length
          ? h('small', { text: '+' + (coming.length - shown.length) })
          : null,
      ]),
      h('div', { class: 'strip-rail' }, shown.map(function (m) {
        var going = (m.people || []).filter(function (x) {
          return x.username === S.user.username;
        })[0];
        return h('button', {
          class: 'event-card meeting',
          onclick: function () { openMeeting(m); },
        }, [
          h('div', { class: 'ec-when', text: m.meetsOn + (m.meetsAt ? ' · ' + m.meetsAt : '') }),
          h('div', { class: 'ec-title', text: m.title }),
          h('div', { class: 'ec-where' }, [
            h('span', { class: 'chip ' + replyClass(going && going.reply),
              text: going
                ? (going.reply === 'accepted' ? t('rsvpGoing')
                  : going.reply === 'declined' ? t('rsvpNotGoing') : t('rsvpAsk'))
                : (m.place || '') }),
          ]),
        ]);
      })),
    ]));
  }

  function taskRow(task) {
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

    return h('li', {
      class: 'task' + (task.pending ? ' pending' : ''),
      dataset: { status: task.status, prio: task.priority || 'medium', urgency: urgencyOf(task) },
      onclick: function () { openTask(task); },
    }, [
      h('button', {
        class: 'status-btn' + (task.maySetStatus ? '' : ' locked'),
        text: MARK[task.status],
        title: statusLabel(task.status) + (task.maySetStatus ? '' : ' \u00b7 ' + t('statusLocked')),
        onclick: function (e) {
          e.stopPropagation();
          if (task.maySetStatus) openStatusMenu(e.currentTarget, task);
        },
      }),
      h('div', { class: 't-title' }, [
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
      assignees: task ? task.assignees.slice() : [S.user.username],
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

      if (mine) {
        replyBox.appendChild(h('span', { class: 'hint', text: t('rsvpAsk') }));
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
    if (mayEdit) {
      buildPeoplePicker(peopleBox, draft);
      buildDeptPicker(deptBox, draft);
    } else {
      // Read-only: who is on it still matters to the person doing the work.
      peopleBox.appendChild(h('div', { class: 'selected' }, draft.assignees.length
        ? draft.assignees.map(function (u) {
            return h('span', { class: 'chip who' }, [avatarNode(u, 'sm'), nameOf(u)]);
          })
        : [h('span', { class: 'chip', text: t('noOne') })]));
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
    function buildViewPane() {
      var parts = task.parts || [];
      var links = task.links || [];
      var doneParts = parts.filter(function (p) { return p.done; }).length;

      var band = h('div', { class: 'view-band' }, [
        h('span', { class: 'vb-status st-' + task.status, text: statusLabel(task.status) }),
        (task.priority && task.priority !== 'medium')
          ? h('span', { class: 'vb-prio prio-' + task.priority, text: prioLabel(task.priority) })
          : null,
        h('span', { class: 'grow' }),
        h('span', {
          class: 'vb-due u-' + urgencyOf(task),
          text: whenWording(task.dueDate, task.dueTime),
        }),
      ]);

      var rows = [
        vRow(t('assignTo'), task.assignees.length
          ? h('span', { class: 'selected' }, task.assignees.map(function (u) {
              return h('span', { class: 'chip who' }, [avatarNode(u, 'sm'), nameOf(u)]);
            }))
          : vMuted(t('noOne'))),
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
        (!mayEdit && !maySetStatus) ? h('div', { class: 'notice', text: t('viewOnlyNote') }) : null,
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
        h('div', { class: 'two' }, [
          h('div', { class: 'field' }, [h('label', { text: t('dueDate') }), dateInput]),
          h('div', { class: 'field' }, [h('label', { text: t('dueTime') }), timeInput]),
        ]),
        h('div', { class: 'field' }, [h('label', { text: t('assignTo') }), peopleBox, replyBox]),
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
            href: googleCalUrl(task), text: '📅 ' + t('addToCalendar'),
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
      if (task && task.mayEdit) {
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
        status: draft.status,
        priority: draft.priority,
        department: draft.department,
        unit: draft.unit,
        assignees: draft.assignees,
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
    }
  }

  function buildPeoplePicker(box, draft) {
    function redraw() {
      clear(box);
      var selected = h('div', { class: 'selected' }, draft.assignees.length
        ? draft.assignees.map(function (u) {
            return h('span', {
              class: 'chip who x',
              onclick: function () {
                draft.assignees = draft.assignees.filter(function (x) { return x !== u; });
                redraw();
              },
            }, [avatarNode(u, 'sm'), nameOf(u), ' ✕']);
          })
        : [h('span', { class: 'chip', text: t('noOne') })]);

      /**
       * The circles, above the search box.
       *
       * Naming eleven heads one at a time before every meeting is how people
       * stop using a system. Tapping a circle adds everyone in it; tapping it
       * again takes them all back out, so it is a shortcut rather than a trap.
       */
      var circleRow = h('div', { class: 'seg wrap circles' });
      circleChoices().forEach(function (c) {
        var allIn = c.members.every(function (u) {
          return draft.assignees.indexOf(u) !== -1;
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
              draft.assignees = draft.assignees.filter(function (u) {
                return c.members.indexOf(u) === -1 || u === S.user.username;
              });
            } else {
              c.members.forEach(function (u) {
                if (draft.assignees.indexOf(u) === -1) draft.assignees.push(u);
              });
            }
            redraw();
          },
        }));
      });

      var search = h('input', { type: 'text', placeholder: t('assignTo') });
      var options = h('div', { class: 'options' });

      function fill() {
        clear(options);
        var q = search.value.trim().toLowerCase();
        // A unit editor is only offered their own section — the server
        // refuses the rest, so listing them would be an invitation to fail.
        var matches = S.users.filter(function (u) { return u.active && assignableTo(u); })
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
            var on = draft.assignees.indexOf(u.username) !== -1;
            options.appendChild(h('div', {
              class: 'opt' + (on ? ' on' : ''),
              onclick: function () {
                if (on) draft.assignees = draft.assignees.filter(function (x) { return x !== u.username; });
                else draft.assignees.push(u.username);
                redraw();
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
            h('td', { text: (r.startsOn || '\u2014') + (r.startsAt ? ' ' + r.startsAt : '') +
              (r.endsOn && r.endsOn !== r.startsOn ? ' \u2013 ' + r.endsOn : '') }),
            h('td', { text: r.place || '\u2014' }),
            h('td', {}, (r.departments || []).map(function (k) { return h('span', { class: 'chip dept', text: deptLabel(k) }); })),
            h('td', {}, flags),
          ]);
        }

        return h('tr', { class: r.problems.length ? 'off' : '' }, [
          h('td', {}, [
            r.title,
            (r.parts || []).length ? h('div', { class: 'imp-sub', text: '\u2713 ' + r.parts.length + ' ' + t('tabParts') }) : null,
            (r.links || []).length ? h('div', { class: 'imp-sub', text: '\u2197 ' + r.links.length + ' ' + t('tabWork') }) : null,
          ]),
          h('td', {}, [h('span', { class: 'stack' }, (r.assignees || []).map(function (u) { return avatarNode(u, 'sm'); }))]),
          h('td', {}, (r.departments || []).map(function (d) { return h('span', { class: 'chip dept', text: deptLabel(d.key) }); })),
          h('td', { text: (r.dueDate || '\u2014') + (r.dueTime ? ' ' + r.dueTime : '') }),
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
        ? h('span', { class: 'selected' }, (event.people || []).map(function (u) {
            return h('span', { class: 'chip who' }, [avatarNode(u, 'sm'), nameOf(u)]);
          }).concat((event.departments || []).map(function (k) {
            return h('span', { class: 'chip dept', text: deptLabel(k) });
          })))
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

    main.appendChild(h('div', { class: 'modal', style: 'width:min(34rem,100%);margin:0' }, [
      h('div', { class: 'body' }, [
        notice,
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

        h('div', { class: 'field' }, [h('label', { text: t('phoneAlerts') }), pushBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('lineAlerts') }), lineBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('sigTitle') }), signatureBox()]),
        h('div', { class: 'field' }, [h('label', { text: t('calendarFeed') }), calendarBox()]),
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

        var toggle = h('input', { type: 'checkbox', checked: state.digest !== false });
        toggle.addEventListener('change', function () {
          api('/api/line?do=digest', { method: 'PATCH', body: { digest: toggle.checked } })
            .then(function (d) { state.digest = d.digest; })
            .catch(function (err) { toggle.checked = !toggle.checked; alert(errText(err.code)); });
        });
        box.appendChild(h('label', { class: 'inline-check' }, [toggle, t('lineDigestOn')]));
        box.appendChild(h('p', { class: 'hint', text: t('lineDigestHelp') }));

        // Admins also get the one-click menu install. It changes what every
        // member sees, so it is deliberately not offered to everyone.
        if (state.canManageMenu) {
          box.appendChild(h('p', { class: 'hint', text: t('lineMenuHelp') }));
          box.appendChild(h('button', {
            class: 'btn sm', text: state.menuInstalled ? t('lineMenuReinstall') : t('lineMenuInstall'),
            onclick: function (e) {
              var btn = e.target;
              btn.disabled = true;
              btn.textContent = t('lineMenuWorking');
              api('/api/line?do=richmenu', { method: 'POST' })
                .then(function () { state.menuInstalled = true; draw(state); })
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

  function openQr(link) {
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
          class: 'btn primary', text: t('qrDownload'),
          onclick: function () {
            var a = document.createElement('a');
            a.download = 'qr-' + link.code + '.png';
            a.href = canvas.toDataURL('image/png');
            a.click();
          },
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
      h('button', {
        class: 'btn', text: t('syncNow'),
        onclick: function (e) {
          e.target.disabled = true;
          api('/api/users?do=sync', { method: 'POST' }).then(function (data) {
            S.users = data.users;
            var parts = ['+' + data.added + ' / ~' + data.updated +
              (data.deactivated.length ? ' / -' + data.deactivated.length : '')];
            if (data.pinned) parts.push(data.pinned + ' ' + t('syncPinned'));
            (data.unreadable || []).forEach(function (u) {
              parts.push(u.username + ': ' + t('syncUnreadable') + ' \u2014 ' + u.cells.join(', '));
            });
            say((data.unreadable || []).length ? 'warn' : 'ok', parts.join('  \u00b7  '));
            renderPage();
          }).catch(function (err) {
            say('err', (err.data && err.data.message) || errText(err.code));
            e.target.disabled = false;
          });
        },
      }),
      S.sheetId ? h('a', {
        class: 'btn', target: '_blank', rel: 'noopener',
        href: 'https://docs.google.com/spreadsheets/d/' + S.sheetId + '/edit',
        text: t('openSheet'),
      }) : null,
    ]));

    main.appendChild(h('div', { class: 'notice warn' }, [
      t('adminSheetNote') + '  ·  ' + t('lastSync') + ': ' +
      (S.lastSync ? new Date(S.lastSync).toLocaleString(S.lang === 'th' ? 'th-TH' : 'en-GB') : t('never')),
    ]));
    // Said once, up front: without the write-back set up, an access change
    // here never reaches the spreadsheet everyone else reads.
    if (S.canSetAccess && !S.sheetWritable) {
      main.appendChild(h('div', { class: 'notice warn', text: t('sheetNotLinked') }));
    }
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
      } else {
        // Missing one half of the credentials is a different mistake from
        // having set none of them, and a much easier one to not notice.
        lines.push(h('div', {
          style: 'color:var(--danger);font-weight:600',
          text: '⚠ ' + (d.driveHasClient || d.driveHasRefreshToken
            ? t('healthDrivePartial') : t('healthDriveOff')),
        }));
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
      health.appendChild(h('div', {}, lines.concat(upcoming)));
    }).catch(function () { health.hidden = true; });

    var rows = S.users.map(function (u) {
      var blocked = blockedReason(u);
      var status = [];
      if (!u.active) status.push(h('span', { class: 'chip', text: t('inactive') }));
      if (u.suspended) status.push(h('span', { class: 'chip overdue', text: t('suspended') }));
      if (u.resetAllowed) status.push(h('span', { class: 'chip', text: t('pendingReset') }));
      if (!u.hasPassword && !u.resetAllowed) status.push(h('span', { class: 'chip', text: t('noPassword') }));

      var deptCell = accessCell(u, blocked);

      var headCb = h('input', { type: 'checkbox', checked: u.isHead, disabled: !!blocked });
      headCb.addEventListener('change', function () { manage(u, { isHead: headCb.checked }); });

      return h('tr', { class: u.active ? '' : 'off' }, [
        h('td', {}, [h('div', { class: 'who-cell' }, [
          avatarNode(u.username), h('div', {}, [
            h('div', { text: u.displayName }),
            h('small', { style: 'color:var(--ink-faint)', text: u.username }),
          ]),
        ])]),
        h('td', {}, [accessLevelCell(u, blocked)]),
        h('td', { text: u.position || '—' }),
        h('td', {}, [deptCell]),
        h('td', { style: 'text-align:center' }, [headCb]),
        h('td', {}, [h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, status)]),
        h('td', {}, [h('div', { style: 'display:flex;gap:5px;flex-wrap:wrap' }, blocked
          ? [h('small', { style: 'color:var(--ink-faint)', text: errText(blocked) })]
          : [
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
    });

    main.appendChild(h('div', { class: 'tablewrap' }, [
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

      if (u.accessPinned) {
        box.appendChild(h('small', {
          class: 'from-sheet', style: 'color:var(--warn,#b26a00)',
          text: t('pinnedHere'), title: t('accessPinnedHint'),
        }));
      }
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
      box.appendChild(u.deptsPinned
        ? h('button', {
            class: 'btn sm ghost pin', text: t('pinnedHere') + ' \u21ba',
            title: t('pinnedHint'),
            onclick: function () { send({ followSheet: true }); },
          })
        : h('small', { class: 'from-sheet', text: t('fromSheet') }));

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
  function mayCreate() { return S.user && S.user.access !== 'inner'; }

  /** The people a unit editor may put work on: their own section, and themselves. */
  /**
   * Who is in a circle, worked out from the roster the page already holds.
   *
   * The same rule as the server's: a circle is everybody at or above a floor
   * on the access ladder, minus closed and suspended accounts. The server
   * expands every circle again when anything is saved, so this list decides
   * what the picker shows and never what is stored.
   */
  function circleMembers(key) {
    var circle = (S.circles || []).filter(function (c) { return c.key === key; })[0];
    if (!circle || !S.accessOrder) return [];
    var floor = S.accessOrder.indexOf(circle.floor);
    if (floor < 0) return [];
    return (S.users || []).filter(function (u) {
      if (!u.active || u.suspended) return false;
      var mine = S.accessOrder.indexOf(u.access);
      return mine >= 0 && mine >= floor;
    }).map(function (u) { return u.username; });
  }

  /** The circles a picker should offer, with how many people are in each. */
  function circleChoices() {
    return (S.circles || []).map(function (c) {
      return { key: c.key, label: S.lang === 'en' ? c.en : c.th,
               note: c.note, members: circleMembers(c.key) };
    }).filter(function (c) { return c.members.length > 0; });
  }

  function assignableTo(person) {
    if (!S.user || S.user.access !== 'unitlead') return true;
    if (person.username === S.user.username) return true;
    return Boolean(S.user.unit) && person.unit === S.user.unit;
  }

  function blockedReason(target) {
    if (S.user.access === 'admin') return null;
    if (S.user.access === 'coadmin') {
      if (target.access === 'admin') return 'COADMIN_CANNOT_TOUCH_ADMIN';
      if (target.access === 'coadmin') return 'COADMIN_CANNOT_TOUCH_COADMIN';
      return null;
    }
    return 'EDITORS_CANNOT_MANAGE_ACCOUNTS';
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

  function openMeeting(meeting) {
    var isNew = !meeting;
    var draft = {
      title: meeting ? meeting.title : '',
      note: meeting ? meeting.note : '',
      meetsOn: meeting ? meeting.meetsOn : '',
      meetsAt: meeting ? (meeting.meetsAt || '') : '',
      place: meeting ? meeting.place : '',
      joinUrl: meeting ? meeting.joinUrl : '',
      agendaUrl: meeting ? meeting.agendaUrl : '',
      minutesUrl: meeting ? meeting.minutesUrl : '',
      assignees: meeting ? meeting.people.map(function (p) { return p.username; }) : [S.user.username],
      departments: [],
      template: 'standard',
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

    bodyBox.appendChild(notice);

    /**
     * What somebody opened the meeting to look at comes first.
     *
     * For a meeting that already exists, that is who is coming and what is on
     * the agenda — not seven form fields they have to scroll past. The details
     * are still there, underneath, for the organiser who came to change them.
     */
    var detailPane = h('div', { class: 'pane' }, [
      field(t('mtgTitle'), input('title')),
      field(t('mtgDate'), input('meetsOn', 'date')),
      field(t('mtgStart'), input('meetsAt', 'time')),
      field(t('mtgPlace'), input('place')),
      field(t('mtgJoin'), input('joinUrl', 'url')),
      field(t('mtgAgendaUrl'), input('agendaUrl', 'url')),
      isNew ? null : field(t('mtgMinutesUrl'), input('minutesUrl', 'url')),
      field(t('mtgWho'), peopleBox),
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
      line(t('mtgDate'), meeting.meetsOn + (meeting.meetsAt ? ' · ' + meeting.meetsAt : ''));
      line(t('mtgPlace'), meeting.place);
      line(t('mtgJoin'), meeting.joinUrl ? t('mtgOpenJoin') : '', meeting.joinUrl);
      line(t('mtgAgendaUrl'), meeting.agendaUrl ? t('mtgOpenAgenda') : '', meeting.agendaUrl);
      line(t('mtgMinutesUrl'), meeting.minutesUrl ? t('mtgOpenMinutes') : '', meeting.minutesUrl);
      if (meeting.note) line(t('mtgTitle'), meeting.note);

      /**
       * Into somebody's own Google Calendar, in one click.
       *
       * The subscribed feed covers people who have set it up; most people
       * have not, and a meeting they cannot get into their own calendar is a
       * meeting they will miss. The link carries the joining address and the
       * agenda, not just a title and a time.
       */
      if (meeting.googleUrl) {
        summaryPane.appendChild(h('div', { class: 'sum-row' }, [
          h('span', { class: 'sum-label', text: t('mtgAddToCalendar') }),
          h('a', { class: 'chip dept', target: '_blank', rel: 'noopener',
            href: meeting.googleUrl, text: t('mtgGoogleCalendar') }),
        ]));
      }
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

        function addBox(headIndex) {
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
              minutes: Number(newMins.value), under: headIndex, heading: false });
            drawDraftAgenda();
          }
          [newTitle, newMins].forEach(function (el) {
            el.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') { e.preventDefault(); add(); }
            });
          });
          addBtn.addEventListener('click', add);
          return h('div', { class: 'agenda-add' }, [newTitle, newMins, addBtn, why]);
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
            agendaDraft.appendChild(addBox(i));
          });
        } else {
          draft.agenda.forEach(function (item, i) {
            agendaDraft.appendChild(row(item, String(i + 1), 1));
          });
          agendaDraft.appendChild(addBox(null));
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

      if (mine) {
        var rsvp = h('div', { class: 'rsvp' });
        var closed = meeting.status !== 'planned';
        [['accepted', 'rsvpGoing'], ['declined', 'rsvpNotGoing']].forEach(function (pair) {
          rsvp.appendChild(h('button', {
            type: 'button', disabled: closed,
            class: 'btn sm rsvp-' + pair[0] + (mine.reply === pair[0] ? ' on' : ''),
            text: t(pair[1]),
            onclick: function () {
              api('/api/events?do=reply', {
                method: 'POST', body: { kind: 'meeting', id: meeting.id, reply: pair[0] },
              }).then(function () { veil.remove(); reloadMeetings(); })
                .catch(function (err) { fail(errText(err.code)); });
            },
          }));
        });
        whoPane.appendChild(rsvp);
      }

      // Everybody, colour-coded, so a glance answers "who is actually coming".
      /**
       * `.selected` is only styled inside a .picker, and this list is not in
       * one — so the chips fell back to baseline alignment and a chip holding
       * a photograph sat higher than one holding initials. Its own class, with
       * its own row layout.
       */
      whoPane.appendChild(h('div', { class: 'mtg-people' }, meeting.people.map(function (p) {
        return h('span', { class: 'chip who ' + replyClass(p.reply) },
          [avatarNode(p.username, 'sm'), nameOf(p.username)]);
      })));
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
        return h('div', { class: 'agenda-row d' + item.depth }, [
          h('span', { class: 't-code', text: item.number }),
          h('span', { class: 'grow', text: item.title }),
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

      function addBox(parentId) {
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
                    minutes: Number(itemMins.value), parentId: parentId || null },
          }).then(function () { veil.remove(); reloadMeetings(); })
            .catch(function (err) { addBtn.disabled = false; fail(errText(err.code)); });
        });
        // Enter is how anybody types a list, so it has to work here too.
        [itemTitle, itemMins].forEach(function (el) {
          el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
          });
        });
        return h('div', { class: 'agenda-add' }, [itemTitle, itemMins, addBtn, why]);
      }

      meeting.agenda.forEach(function (item) {
        agendaPane.appendChild(agendaRow(item));
        var isHeading = item.depth === 0 && item.kind && item.kind !== 'item';
        if (!item.hasChildren && isHeading) {
          agendaPane.appendChild(h('div', { class: 'agenda-empty', text: t('mtgNoSub') }));
        }
        // The add box sits under the heading it will add to, so nobody has to
        // be told which วาระ they are proposing into.
        if (canPropose && isHeading) agendaPane.appendChild(addBox(item.id));
      });

      // A blank agenda has no headings, so items go straight on it.
      if (canPropose && !headings.length) agendaPane.appendChild(addBox(null));

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
            meetsAt: draft.meetsAt || null, place: draft.place,
            joinUrl: draft.joinUrl, agendaUrl: draft.agendaUrl,
            people: draft.assignees,
          };
          if (isNew) { body.template = 'blank'; body.agenda = draft.agenda; }
          else { body.id = meeting.id; body.minutesUrl = draft.minutesUrl; }
          api('/api/events?do=meeting', { method: isNew ? 'POST' : 'PATCH', body: body })
            .then(function () { veil.remove(); reloadMeetings(); })
          .catch(function (err) { fail(errText(err.code)); });
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
        if (!confirm(t('mtgDeleteSure'))) return;
        api('/api/events?do=meeting&id=' + encodeURIComponent(meeting.id), { method: 'DELETE' })
          .then(function () { veil.remove(); reloadMeetings(); })
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
      audience: { kind: 'everyone', departments: [], people: [] },
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

      if (draft.audience.kind === 'departments') {
        var keys = draft.audience.departments;
        if (!keys.length) return 0;
        return live.filter(function (u) {
          return u.allDepartments || (u.departments || []).some(function (k) {
            return keys.indexOf(k) !== -1;
          });
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
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

  function boot() {
    return Promise.all([
      api('/api/meta'),
      api('/api/users'),
      api('/api/tasks'),
      api('/api/notifications'),
      api('/api/events'),
      api('/api/events?do=meetings').catch(function () { return { meetings: [] }; }),
    ]).then(function (res) {
      S.departments = res[0].departments;
      S.circles = res[0].circles || [];
      S.accessOrder = res[0].accessOrder || [];
      S.users = res[1].users;
      S.canManage = res[1].canManage;
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
    }).catch(function (err) {
      if (err.code === 'NOT_SIGNED_IN') { S.user = null; renderAuth(); return; }
      alert(err.code === 'NO_DATABASE' ? t('noDatabase') : t('errOffline'));
    });
  }

  try {
    var saved = localStorage.getItem('fair-lang');
    if (saved) S.lang = saved;
  } catch (e) {}

  // Read the theme before the first paint so the page never flashes the wrong one.
  try { applyTheme(localStorage.getItem('fair-theme') || 'system'); } catch (e) { applyTheme('system'); }

  api('/api/auth').then(function (data) {
    if (data.user) {
      S.user = data.user;
      S.lang = data.user.lang || S.lang;
      if (data.user.theme) applyTheme(data.user.theme);
      boot();
    }
    else renderAuth();
  }).catch(function (err) {
    renderAuth();
    if (err.code === 'NO_DATABASE') showAuthNotice(t('noDatabase'), 'warn');
    else if (err.code === 'SHEET_UNREADABLE') showAuthNotice((err.data && err.data.message) || t('errGeneric'), 'warn');
  });

  // Someone else may have changed things while this tab sat idle.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.user) {
      api('/api/tasks').then(function (d) { S.tasks = d.tasks; renderPage(); }).catch(function () {});
      api('/api/events').then(function (d) { S.events = d.events; renderPage(); }).catch(function () {});
      refreshNotifications().then(showPending);
    }
  });

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
