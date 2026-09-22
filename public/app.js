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
    page: 'mine',
    filter: 'open',
    who: '',
    dept: '',            // teamspace filter; '' = everything I can see
    prio: '',            // priority filter
    seesEverything: false,
    myDepartments: [],   // every teamspace I may work in
    push: { supported: false, permission: 'default', subscribed: false, key: null, standalone: false },
    announcements: [],
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
  function fmtDate(iso, opts) {
    if (!iso) return t('noDue');
    var d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB',
      Object.assign({ day: 'numeric', month: 'short', timeZone: 'UTC' }, opts || {}));
  }
  function relativeDay(iso) {
    var today = todayIso();
    if (iso === today) return t('today');
    if (iso === addDays(today, 1)) return t('tomorrow');
    return null;
  }
  var isOverdue = function (task) {
    return task.dueDate && task.status !== 'done' && task.dueDate < todayIso();
  };

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
    if (['mine', 'all', 'calendar', 'profile', 'admin', 'announce'].indexOf(page) === -1) page = 'mine';
    if ((page === 'admin' || page === 'announce') && !S.canManage) page = 'mine';
    S.page = page;
  }

  /* ======================================================================
     Pages
     ====================================================================== */
  function renderPage() {
    var main = clear($('main'));
    if (S.page === 'mine') return pageTasks(main, true);
    if (S.page === 'all') return pageTasks(main, false);
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
      if (S.dept) {
        var inDept = task.department === S.dept ||
          (task.departments || []).some(function (d) { return d.key === S.dept; });
        if (!inDept) return false;
      }
      return true;
    });
  }

  function pageTasks(main, mineOnly) {
    main.appendChild(h('div', { class: 'page-head' }, [
      h('h1', { text: mineOnly ? t('navMine') : t('navAll') }),
      mineOnly ? null : h('button', { class: 'btn', text: '\u2191 ' + t('importTasks'), onclick: openImport }),
      h('button', { class: 'btn primary', text: t('newTask'), onclick: function () { openTask(null); } }),
    ]));

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
      onchange: function (e) { S.dept = e.target.value; S.who = ''; renderPage(); },
    }, [h('option', { value: '', text: t('allDepartments') })].concat(
      myDepartments().map(function (d) {
        return h('option', { value: d.key, text: deptOptionLabel(d), selected: S.dept === d.key });
      })
    ));

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
      h('div', { class: 'filter-selects' }, [prioSelect, deptSelect, whoSelect]),
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

  function taskRow(task) {
    var meta = [];
    var prio = task.priority || 'medium';
    // Only show a chip when it is not the default — otherwise every card
    // carries the same badge and the urgent ones stop standing out.
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
    task.departments.forEach(function (d) {
      meta.push(h('span', { class: 'chip dept', text: deptLabel(d.key) + (d.scope === 'heads' ? ' · ' + t('scopeHeads') : d.scope === 'members' ? ' · ' + t('scopeMembers') : '') }));
    });

    var stack = h('span', { class: 'stack' }, task.assignees.slice(0, 4).map(function (u) { return avatarNode(u, 'sm'); }));
    if (task.assignees.length > 4) stack.appendChild(h('span', { class: 'avatar sm', text: '+' + (task.assignees.length - 4) }));

    return h('li', {
      class: 'task', dataset: { status: task.status, prio: task.priority || 'medium' },
      onclick: function () { openTask(task); },
    }, [
      h('button', {
        class: 'status-btn', text: MARK[task.status], title: statusLabel(task.status),
        onclick: function (e) { e.stopPropagation(); openStatusMenu(e.currentTarget, task); },
      }),
      h('div', { class: 't-title', text: task.title }),
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
      assignees: task ? task.assignees.slice() : [S.user.username],
      departments: task ? task.departments.map(function (d) { return { key: d.key, scope: d.scope }; }) : [],
      notify: task ? task.notify.slice() : ['created', '7d', '24h', 'due'],
    };

    var titleInput = h('input', { type: 'text', value: draft.title, maxlength: '200', placeholder: t('taskTitlePlaceholder') });
    var descInput = h('textarea', { maxlength: '4000', placeholder: t('description') });
    descInput.value = draft.description;
    var dateInput = h('input', { type: 'date', value: draft.dueDate || '' });
    var timeInput = h('input', { type: 'time', value: draft.dueTime || '' });

    var peopleBox = h('div', { class: 'picker' });
    var deptBox = h('div', { class: 'picker' });
    buildPeoplePicker(peopleBox, draft);
    buildDeptPicker(deptBox, draft);

    var notifyBox = h('div', { class: 'checks' }, [
      ['created', 'notifyCreated'], ['7d', 'notify7d'], ['24h', 'notify24h'], ['due', 'notifyDue'],
    ].map(function (pair) {
      var cb = h('input', { type: 'checkbox', checked: draft.notify.indexOf(pair[0]) !== -1 });
      cb.addEventListener('change', function () {
        draft.notify = draft.notify.filter(function (k) { return k !== pair[0]; });
        if (cb.checked) draft.notify.push(pair[0]);
      });
      return h('label', {}, [cb, t(pair[1])]);
    }));

    var statusSeg = h('div', { class: 'seg wrap' }, STATUS_LIST.map(function (st) {
      var b = h('button', {
        type: 'button', class: draft.status === st ? 'on' : '', text: statusLabel(st),
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
        text: prioLabel(p),
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
      disabled: !S.seesEverything && choices.length < 2,
      onchange: function (e) { draft.department = e.target.value || null; },
    }, [h('option', { value: '', text: t('noDepartment') })].concat(
      choices.map(function (d) {
        return h('option', { value: d.key, text: deptOptionLabel(d), selected: draft.department === d.key });
      })
    ));

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) close(); } });
    var modal = h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h2', { text: isNew ? t('newTask') : t('taskTitle') }),
        h('button', { class: 'btn ghost sm', text: '✕', onclick: close }),
      ]),
      h('div', { class: 'body' }, [
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
          h('div', { class: 'field' }, [h('label', { text: t('priority') }), prioSeg]),
        ]),
        h('div', { class: 'field' }, [h('label', { text: statusLabel('todo') + ' \u2192 ' + statusLabel('done') }), statusSeg]),
        h('div', { class: 'field' }, [h('label', { text: t('notifyWhen') }), notifyBox]),
        task ? h('p', { class: 'hint', style: 'font-size:12.5px;color:var(--ink-faint);margin:0' },
          [t('createdBy') + ': ' + nameOf(task.createdBy)]) : null,
      ]),
      h('footer', {}, [
        h('button', { class: 'btn primary', text: isNew ? t('addTask') : t('saveTask'), onclick: save }),
        h('button', { class: 'btn', text: t('cancel'), onclick: close }),
        // Only for a saved task with a date — there is nothing to add otherwise.
        task && task.dueDate ? h('a', {
          class: 'btn', target: '_blank', rel: 'noopener',
          href: googleCalUrl(task), text: '📅 ' + t('addToCalendar'),
        }) : null,
        h('span', { class: 'grow' }),
        task ? h('button', {
          class: 'btn danger', text: t('deleteTask'),
          onclick: function () {
            if (!confirm(t('confirmDelete'))) return;
            api('/api/tasks?id=' + encodeURIComponent(task.id), { method: 'DELETE' })
              .then(function (d) { S.tasks = d.tasks; close(); renderPage(); });
          },
        }) : null,
      ]),
    ]);

    veil.appendChild(modal);
    $('modal-root').appendChild(veil);
    setTimeout(function () { titleInput.focus(); }, 30);

    function close() { veil.remove(); }

    function save() {
      var body = {
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        dueDate: dateInput.value || null,
        dueTime: timeInput.value || null,
        status: draft.status,
        priority: draft.priority,
        department: draft.department,
        assignees: draft.assignees,
        departments: draft.departments,
        notify: draft.notify,
      };
      if (!body.title) { titleInput.focus(); return; }

      var call = isNew
        ? api('/api/tasks', { method: 'POST', body: body })
        : api('/api/tasks', { method: 'PATCH', body: Object.assign({ id: task.id }, body) });

      call.then(function (data) { S.tasks = data.tasks; close(); renderPage(); refreshNotifications(); })
        .catch(function (err) { alert(errText(err.code)); });
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
  var TEMPLATE_CSV =
    'title,description,assignees,departments,due date,due time,status,notify\n' +
    'จองเวทีกลาง,ติดต่อฝ่ายอาคาร,Jade_Pres;Kaew_VP,content:heads,2026-10-05,18:30,todo,"created,7d,24h,due"\n' +
    'Confirm sponsor banners,,Yam_HeadSpon,sponsor,2026-10-12,,doing,"created,24h"\n' +
    'ประชุมใหญ่คณะกรรมการ,วาระ: สรุปงบประมาณ,,operations:all,2026-10-20,14:00,todo,\n';

  function openImport() {
    var mode = 'paste';
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
        r.unknownPeople.forEach(function (n) { flags.push(h('div', { class: 'imp-warn', text: t('nameNotFound') + ': ' + n })); });
        r.unknownDepts.forEach(function (n) { flags.push(h('div', { class: 'imp-warn', text: t('deptNotFound') + ': ' + n })); });
        if (r.problems.indexOf('BAD_DATE') !== -1) flags.push(h('div', { class: 'imp-bad', text: t('badDate') }));
        if (r.problems.indexOf('BAD_TIME') !== -1) flags.push(h('div', { class: 'imp-bad', text: t('badTime') }));
        if (r.notes.indexOf('DAY_FIRST_ASSUMED') !== -1) flags.push(h('div', { class: 'imp-warn', text: t('dayFirstNote') }));

        return h('tr', { class: r.problems.length ? 'off' : '' }, [
          h('td', { text: r.title }),
          h('td', {}, [h('span', { class: 'stack' }, r.assignees.map(function (u) { return avatarNode(u, 'sm'); }))]),
          h('td', {}, r.departments.map(function (d) { return h('span', { class: 'chip dept', text: deptLabel(d.key) }); })),
          h('td', { text: (r.dueDate || '\u2014') + (r.dueTime ? ' ' + r.dueTime : '') }),
          h('td', {}, flags),
        ]);
      });

      previewBox.appendChild(h('div', { class: 'imp-rows' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: t('taskTitle') }), h('th', { text: t('assignTo') }),
            h('th', { text: t('departments') }), h('th', { text: t('dueDate') }), h('th', { text: '' }),
          ])]),
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
        api('/api/import?do=commit', { method: 'POST', body: { rows: good } })
          .then(function (data) {
            return api('/api/tasks').then(function (fresh) {
              S.tasks = fresh.tasks;
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

    var veil = h('div', { class: 'veil', onclick: function (e) { if (e.target === veil) veil.remove(); } });
    veil.appendChild(h('div', { class: 'modal' }, [
      h('header', {}, [
        h('h2', { text: t('importTasks') }),
        h('button', { class: 'btn ghost sm', text: '\u2715', onclick: function () { veil.remove(); } }),
      ]),
      h('div', { class: 'body' }, [
        notice,
        h('p', { style: 'margin:0;font-size:13.5px;color:var(--ink-soft)', text: t('importHelp') }),
        h('p', { style: 'margin:0;font-size:12.5px;color:var(--ink-faint)', text: t('templateHelp') }),
        h('button', {
          class: 'btn sm', style: 'align-self:flex-start', text: '\u2193 ' + t('downloadTemplate'),
          onclick: function () {
            // A BOM makes Excel open Thai text correctly instead of as mojibake.
            var blob = new Blob(['\uFEFF' + TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'fair-tasks-template.csv';
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
  function pageCalendar(main) {
    main.appendChild(h('div', { class: 'page-head' }, [h('h1', { text: t('navCalendar') })]));

    var seg = h('div', { class: 'seg' }, [[1, 'view1'], [7, 'view7'], [30, 'view30']].map(function (pair) {
      return h('button', {
        class: S.calRange === pair[0] ? 'on' : '', text: t(pair[1]),
        onclick: function () { S.calRange = pair[0]; renderPage(); },
      });
    }));
    var mineCb = h('input', { type: 'checkbox', checked: S.calMineOnly });
    mineCb.addEventListener('change', function () { S.calMineOnly = mineCb.checked; renderPage(); });

    main.appendChild(h('div', { class: 'filters' }, [
      seg, h('span', { class: 'grow' }),
      h('label', { style: 'display:flex;gap:7px;align-items:center;font-size:13.5px' }, [mineCb, t('mineOnly')]),
    ]));

    var start = todayIso();
    var pool = S.tasks.filter(function (task) {
      if (!task.dueDate) return false;
      if (S.calMineOnly && task.assignees.indexOf(S.user.username) === -1) return false;
      return true;
    });

    var days = [];
    for (var i = 0; i < S.calRange; i++) {
      var day = addDays(start, i);
      days.push({ day: day, tasks: pool.filter(function (x) { return x.dueDate === day; }) });
    }
    var any = days.some(function (d) { return d.tasks.length > 0; });

    // Nothing at all in range: say so once, rather than stacking empty cards
    // under a message that contradicts them.
    if (!any) {
      main.appendChild(h('div', { class: 'empty' }, [h('strong', { text: t('calEmpty') })]));
      return;
    }

    days.forEach(function (entry) {
      // Over a month, empty days are pure noise. Over a day or a week they are
      // useful scaffolding, so keep the header but drop the filler row.
      if (!entry.tasks.length && S.calRange > 7) return;

      main.appendChild(h('div', { class: 'cal-day' + (entry.day === start ? ' is-today' : '') }, [
        h('h3', {}, [
          relativeDay(entry.day) || fmtDate(entry.day, { weekday: 'short' }),
          h('small', { text: entry.tasks.length ? String(entry.tasks.length) : '—' }),
        ]),
        entry.tasks.length ? h('ul', {}, entry.tasks.map(function (task) {
          return h('li', { onclick: (function (x) { return function () { openTask(x); }; })(task) }, [
            h('span', { class: 'status-btn', text: MARK[task.status], style: 'pointer-events:none' }),
            h('span', { style: 'flex:1', text: task.title }),
            task.dueTime ? h('span', { class: 'time', text: task.dueTime }) : null,
            h('span', { class: 'stack' }, task.assignees.slice(0, 3).map(function (u) { return avatarNode(u, 'sm'); })),
          ]);
        })) : null,
      ]));
    });
  }

  /* ---------- profile --------------------------------------------------- */
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
  function pushBox() {
    var box = h('div', { class: 'push-box' });

    function draw() {
      clear(box);
      pushState();

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

      var on = S.push.permission === 'granted' && S.push.subscribed;

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
            e.target.disabled = true;
            api('/api/push?do=test', { method: 'POST' })
              .then(function () { e.target.disabled = false; })
              .catch(function () {
                e.target.disabled = false;
                box.appendChild(h('div', { class: 'notice err', text: t('pushNoDevice') }));
              });
          },
        }) : null,
      ]));

      box.appendChild(h('p', { class: 'hint', text: t('pushExplained') }));
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

      var url = location.origin + '/api/calendar?token=' + S.user.calendarToken;
      var field = h('input', { type: 'text', class: 'mono', value: url, readonly: true,
        onclick: function (e) { e.target.select(); } });

      box.appendChild(field);
      box.appendChild(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' }, [
        h('button', {
          class: 'btn sm', text: t('copyLink'),
          onclick: function (e) {
            var btn = e.target;
            field.select();
            var done = function () { btn.textContent = t('copied'); setTimeout(function () { btn.textContent = t('copyLink'); }, 1600); };
            if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
            else done();
          },
        }),
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
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(S.push.key),
        });
      });
    }).then(function (sub) {
      return api('/api/push?do=subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    }).then(function () {
      S.push.subscribed = true;
      return true;
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
          return reg.pushManager.getSubscription().then(function (sub) {
            if (sub) return sub;
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(info.publicKey),
            });
          });
        });
      })
      .then(function (sub) {
        S.push.subscribed = true;
        return api('/api/push?do=subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      })
      .catch(function () { /* a failed refresh must never block the app loading */ });
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
