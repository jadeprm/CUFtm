/* ==========================================================================
   Fair Tasks — the whole client.
   Plain JavaScript on purpose: no build step, no framework to upgrade, and
   anyone on the committee next year can open this file and read it.
   ========================================================================== */
(function () {
  'use strict';

  var S = {
    lang: 'th',
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
    filter: 'open',      // open | todo | doing | done | all
    who: '',
    calRange: 7,
    calMineOnly: false,
  };

  var t = function (key) {
    var table = window.STRINGS[S.lang] || window.STRINGS.th;
    return table[key] !== undefined ? table[key] : key;
  };
  var errText = function (code) {
    var key = window.ERROR_KEYS[code];
    return key ? t(key) : t('errGeneric');
  };

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
  function deptLabel(key) {
    for (var i = 0; i < S.departments.length; i++) {
      if (S.departments[i].key === key) return S.departments[i][S.lang] || S.departments[i].en;
    }
    return key;
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
        .then(function (data) { S.user = data.user; S.lang = data.user.lang || S.lang; boot(); })
        .catch(function (err) { showAuthNotice(errText(err.code)); });
    } else {
      api('/api/auth?do=login', { method: 'POST', body: { username: authState.username, password: password } })
        .then(function (data) { S.user = data.user; S.lang = data.user.lang || S.lang; boot(); })
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
        class: 'item' + (n.read ? '' : ' unread'),
        onclick: function () {
          $('bell-pop').hidden = true;
          var task = S.tasks.filter(function (x) { return x.id === n.taskId; })[0];
          if (task) openTask(task);
        },
      }, [
        h('b', { text: n.title }),
        h('span', { text: n.body }),
      ]));
    });
  }

  window.addEventListener('hashchange', function () { routeFromHash(); renderShell(); renderPage(); });
  function routeFromHash() {
    var page = (location.hash || '#/mine').replace('#/', '');
    if (['mine', 'all', 'calendar', 'profile', 'admin'].indexOf(page) === -1) page = 'mine';
    if (page === 'admin' && !S.canManage) page = 'mine';
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
  }

  /* ---------- tasks ----------------------------------------------------- */
  function visibleTasks(mineOnly) {
    return S.tasks.filter(function (task) {
      if (mineOnly && task.assignees.indexOf(S.user.username) === -1) return false;
      if (S.filter === 'open' && task.status === 'done') return false;
      if (['todo', 'doing', 'done'].indexOf(S.filter) !== -1 && task.status !== S.filter) return false;
      if (S.who && task.assignees.indexOf(S.who) === -1) return false;
      return true;
    });
  }

  function pageTasks(main, mineOnly) {
    main.appendChild(h('div', { class: 'page-head' }, [
      h('h1', { text: mineOnly ? t('navMine') : t('navAll') }),
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
      done: pool.filter(function (x) { return x.status === 'done'; }).length,
    };

    var seg = h('div', { class: 'seg' }, [
      ['open', t('all')], ['todo', t('statusTodo')], ['doing', t('statusDoing')], ['done', t('statusDone')],
    ].map(function (pair) {
      return h('button', {
        class: S.filter === pair[0] ? 'on' : '',
        onclick: function () { S.filter = pair[0]; renderPage(); },
      }, [pair[1], h('span', { class: 'n', text: String(counts[pair[0]]) })]);
    }));

    var whoSelect = h('select', {
      onchange: function (e) { S.who = e.target.value; renderPage(); },
    }, [h('option', { value: '', text: t('everyone') })].concat(
      S.users.filter(function (u) { return u.active; }).map(function (u) {
        return h('option', { value: u.username, text: u.displayName, selected: S.who === u.username });
      })
    ));

    main.appendChild(h('div', { class: 'filters' }, [seg, h('span', { class: 'grow' }), whoSelect]));

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

  var NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
  var MARK = { todo: '', doing: '●', done: '✓' };

  function taskRow(task) {
    var meta = [];
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
      class: 'task', dataset: { status: task.status },
      onclick: function () { openTask(task); },
    }, [
      h('button', {
        class: 'status-btn', text: MARK[task.status],
        title: t('status' + task.status.charAt(0).toUpperCase() + task.status.slice(1)),
        onclick: function (e) { e.stopPropagation(); patchTask(task.id, { status: NEXT[task.status] }); },
      }),
      h('div', { class: 't-title', text: task.title }),
      h('div', { class: 't-side' }, [stack]),
      meta.length ? h('div', { class: 't-meta' }, meta) : null,
    ]);
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

    var statusSeg = h('div', { class: 'seg' }, ['todo', 'doing', 'done'].map(function (st) {
      var b = h('button', {
        type: 'button', class: draft.status === st ? 'on' : '',
        text: t('status' + st.charAt(0).toUpperCase() + st.slice(1)),
        onclick: function () {
          draft.status = st;
          statusSeg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
        },
      });
      return b;
    }));

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
        h('div', { class: 'field' }, [h('label', { text: t('statusTodo') + ' / ' + t('statusDone') }), statusSeg]),
        h('div', { class: 'field' }, [h('label', { text: t('notifyWhen') }), notifyBox]),
        task ? h('p', { class: 'hint', style: 'font-size:12.5px;color:var(--ink-faint);margin:0' },
          [t('createdBy') + ': ' + nameOf(task.createdBy)]) : null,
      ]),
      h('footer', {}, [
        h('button', { class: 'btn primary', text: isNew ? t('addTask') : t('saveTask'), onclick: save }),
        h('button', { class: 'btn', text: t('cancel'), onclick: close }),
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
        S.users.filter(function (u) { return u.active; })
          .filter(function (u) {
            return !q || u.displayName.toLowerCase().indexOf(q) !== -1 ||
              u.username.toLowerCase().indexOf(q) !== -1 ||
              (u.nickname || '').toLowerCase().indexOf(q) !== -1;
          })
          .forEach(function (u) {
            var on = draft.assignees.indexOf(u.username) !== -1;
            options.appendChild(h('div', {
              class: 'opt' + (on ? ' on' : ''),
              onclick: function () {
                if (on) draft.assignees = draft.assignees.filter(function (x) { return x !== u.username; });
                else draft.assignees.push(u.username);
                redraw();
              },
            }, [avatarNode(u.username, 'sm'), u.displayName, h('small', { text: u.position || u.username })]));
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
      var full = S.departments.every(function (d) { return has(d.key, scope); });
      draft.departments = draft.departments.filter(function (d) { return d.scope !== scope; });
      if (!full) S.departments.forEach(function (d) { draft.departments.push({ key: d.key, scope: scope }); });
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
      S.departments.forEach(function (d) {
        options.appendChild(h('div', { class: 'group-label', text: d[S.lang] || d.en }));
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
          h('label', { text: t('department') }),
          h('input', { type: 'text', value: S.user.department ? deptLabel(S.user.department) : '—', disabled: true }),
        ]),
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
            notice.hidden = false; notice.className = 'notice ok';
            notice.textContent = '+' + data.added + ' / ~' + data.updated +
              (data.deactivated.length ? ' / -' + data.deactivated.length : '');
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

      var deptSelect = h('select', {
        disabled: !!blocked,
        onchange: function (e) { manage(u, { department: e.target.value || null }); },
      }, [h('option', { value: '', text: '—' })].concat(
        S.departments.map(function (d) {
          return h('option', { value: d.key, text: d[S.lang] || d.en, selected: u.department === d.key });
        })
      ));

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
        h('td', {}, [deptSelect]),
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
          h('th', { text: t('position') }), h('th', { text: t('setDepartment') }),
          h('th', { text: t('isHead'), style: 'text-align:center' }),
          h('th', { text: '' }), h('th', { text: '' }),
        ])]),
        h('tbody', {}, rows),
      ]),
    ]));

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

  /* ======================================================================
     Boot
     ====================================================================== */
  function refreshNotifications() {
    return api('/api/notifications').then(function (d) {
      S.notifs = d.notifications; S.unread = d.unread;
      $('bell-count').hidden = S.unread === 0;
      $('bell-count').textContent = S.unread;
    }).catch(function () {});
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
      S.notifs = res[3].notifications;
      S.unread = res[3].unread;
      routeFromHash();
      renderShell();
      renderPage();
    }).catch(function (err) {
      if (err.code === 'NOT_SIGNED_IN') { S.user = null; renderAuth(); return; }
      alert(err.code === 'NO_DATABASE' ? t('noDatabase') : t('errOffline'));
    });
  }

  try {
    var saved = localStorage.getItem('fair-lang');
    if (saved) S.lang = saved;
  } catch (e) {}

  api('/api/auth').then(function (data) {
    if (data.user) { S.user = data.user; S.lang = data.user.lang || S.lang; boot(); }
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
      refreshNotifications();
    }
  });
})();
