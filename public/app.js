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
    lastSync: null,
    sheetId: null,
    page: 'work',
    scope: 'mine',      // 'mine' | 'all' — which half of the one work page
    filter: 'open',
    who: '',
    dept: '',            // teamspace filter; '' = everything I can see
    unit: '',            // section-within-a-department filter
    prio: '',            // priority filter
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
    if (S.user) api('/api/users?do=me', { method: 'PATCH', body: { theme: S.theme } }).catch(function () {});
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

    $('bell-count').hidden = S.unread === 0;
    $('bell-count').textContent = S.unread;
  }

  $('sign-out').addEventListener('click', function () {
    api('/api/auth?do=logout', { method: 'POST' }).then(function () { location.reload(); });
  });

  $('bell-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    var pop = $('bell-pop');
    pop.hidden = !pop.hidden;
    if (!pop.hidden) renderBell();
  });
  document.addEventListener('click', function (e) {
    var pop = $('bell-pop');
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $('bell-btn')) pop.hidden = true;
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

  window.addEventListener('hashchange', function () { routeFromHash(); renderShell(); renderPage(); });
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

    var page = raw;

    // The old addresses still work: they pick the scope and land on the one
    // page, so a bookmark or a link someone shared does not break.
    if (page === 'all') { S.scope = 'all'; page = 'work'; }
    else if (page === 'mine') { S.scope = 'mine'; page = 'work'; }
    else if (page === 'events') page = 'work';

    if (['work', 'calendar', 'profile', 'admin', 'announce'].indexOf(page) === -1) page = 'work';
    if ((page === 'admin' || page === 'announce') && !S.canManage) page = 'work';
    S.page = page;
  }

  /* ======================================================================
     Pages
     ====================================================================== */
  function renderPage() {
    var main = clear($('main'));
    if (S.page === 'work') return pageTasks(main);
    if (S.page === 'calendar') return pageCalendar(main);
    if (S.page === 'profile') return pageProfile(main);
    if (S.page === 'admin') return pageAdmin(main);
    if (S.page === 'announce') return pageAnnounce(main);
  }

  /* ---------- tasks ----------------------------------------------------- */
  function visibleTasks(mineOnly) {
    return S.tasks.filter(function (task) {
      if (mineOnly && task.assignees.indexOf(S.user.username) === -1) return false;
      if (S.filter === 'open' && task.status === 'done') return false;
      if (['todo', 'doing', 'done'].indexOf(S.filter) !== -1 && task.status !== S.filter) return false;
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
      h('button', { class: 'btn', text: '\u2191 ' + t('importTasks'), onclick: openImport }),
      h('button', { class: 'btn', text: t('newEvent'), onclick: function () { openEvent(null); } }),
      h('button', { class: 'btn primary', text: t('newTask'), onclick: function () { openTask(null); } }),
    ]));

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
      ['open', t('all')], ['todo', statusLabel('todo')], ['doing', statusLabel('doing')],
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
    main.appendChild(h('div', { class: 'filters' }, [
      seg, h('span', { class: 'grow' }),
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
  function eventStrip(main, mineOnly) {
    var today = todayIso();
    var coming = S.events.filter(function (e) {
      if ((e.endsOn || e.startsOn) < today) return false;
      if (mineOnly && (e.people || []).length && e.people.indexOf(S.user.username) === -1) return false;
      return true;
    });

    if (!coming.length) return;

    var shown = coming.slice(0, 6);
    main.appendChild(h('div', { class: 'event-strip' }, [
      h('div', { class: 'strip-head' }, [
        h('b', { text: t('upcoming') }),
        coming.length > shown.length
          ? h('small', { text: '+' + (coming.length - shown.length) })
          : null,
      ]),
      h('div', { class: 'strip-rail' }, shown.map(function (event) {
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
      notify: task ? task.notify.slice() : ['created', '7d', '24h', 'due'],
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
      ['created', 'notifyCreated'], ['7d', 'notify7d'], ['24h', 'notify24h'], ['due', 'notifyDue'],
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
        h('div', { class: 'field' }, [h('label', { text: t('assignTo') }), peopleBox]),
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

      var search = h('input', { type: 'text', placeholder: t('assignTo') });
      var options = h('div', { class: 'options' });

      function fill() {
        clear(options);
        var q = search.value.trim().toLowerCase();
        var matches = S.users.filter(function (u) { return u.active; }).filter(function (u) {
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
      notify: event ? event.notify.slice() : ['7d', '24h', 'due'],
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
      ['7d', 'notify7d'], ['24h', 'notify24h'], ['due', 'notifyEventDay'],
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
      shrinkImage(file).then(function (dataUrl) {
        pendingAvatar = dataUrl;
        paintAvatar(dataUrl);
      }).catch(function () { alert(t('errGeneric')); });
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
        h('div', { class: 'field' }, [h('label', { text: t('calendarFeed') }), calendarBox()]),
      ]),
      h('footer', {}, [
        h('button', {
          class: 'btn primary', text: t('save'),
          onclick: function () {
            var body = { displayName: nameInput.value.trim() };
            if (pendingAvatar !== undefined) body.avatar = pendingAvatar;
            api('/api/users?do=me', { method: 'PATCH', body: body }).then(function (data) {
              S.user.displayName = data.user.displayName;
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

  /* ---------- admin ----------------------------------------------------- */
  function pageAdmin(main) {
    var notice = h('div', { class: 'notice', hidden: true });

    main.appendChild(h('div', { class: 'page-head' }, [
      h('h1', { text: t('adminTitle') }),
      h('button', {
        class: 'btn', text: t('syncNow'),
        onclick: function (e) {
          e.target.disabled = true;
          api('/api/users?do=sync', { method: 'POST' }).then(function (data) {
            S.users = data.users;
            notice.hidden = false;
            var parts = ['+' + data.added + ' / ~' + data.updated +
              (data.deactivated.length ? ' / -' + data.deactivated.length : '')];
            if (data.pinned) parts.push(data.pinned + ' ' + t('syncPinned'));
            (data.unreadable || []).forEach(function (u) {
              parts.push(u.username + ': ' + t('syncUnreadable') + ' \u2014 ' + u.cells.join(', '));
            });
            notice.className = 'notice ' + ((data.unreadable || []).length ? 'warn' : 'ok');
            notice.textContent = parts.join('  \u00b7  ');
            renderPage();
          }).catch(function (err) {
            notice.hidden = false; notice.className = 'notice err';
            notice.textContent = (err.data && err.data.message) || errText(err.code);
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
    main.appendChild(notice);

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
        h('td', {}, [h('span', { class: 'badge ' + u.access, text: t('access' + u.access.charAt(0).toUpperCase() + u.access.slice(1)) })]),
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

      return box;
    }

    function manage(target, changes) {
      api('/api/users?do=manage', { method: 'PATCH', body: Object.assign({ username: target.username }, changes) })
        .then(function (data) {
          var i = S.users.findIndex(function (u) { return u.username === data.user.username; });
          if (i !== -1) S.users[i] = data.user;
          renderPage();
        })
        .catch(function (err) {
          notice.hidden = false; notice.className = 'notice err'; notice.textContent = errText(err.code);
          renderPage();
        });
    }
  }

  /**
   * Mirrors the server's rule so the interface doesn't offer buttons that
   * would be refused. The server decides; this only keeps the UI honest.
   */
  function blockedReason(target) {
    if (S.user.access === 'admin') return null;
    if (S.user.access === 'coadmin') {
      if (target.access === 'admin') return 'COADMIN_CANNOT_TOUCH_ADMIN';
      if (target.access === 'coadmin') return 'COADMIN_CANNOT_TOUCH_COADMIN';
      return null;
    }
    return 'EDITORS_CANNOT_MANAGE_ACCOUNTS';
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
    ]).then(function (res) {
      S.departments = res[0].departments;
      S.users = res[1].users;
      S.canManage = res[1].canManage;
      S.lastSync = res[1].lastSync;
      S.sheetId = res[1].sheetId;
      S.tasks = res[2].tasks;
      S.seesEverything = Boolean(res[2].seesEverything);
      S.myDepartments = res[2].myDepartments || [];
      S.notifs = res[3].notifications;
      S.unread = res[3].unread;
      S.events = res[4].events;
      S.colours = res[4].colours;
      routeFromHash();
      renderShell();
      renderPage();
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
