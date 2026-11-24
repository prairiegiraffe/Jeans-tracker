/* Jeans Days - frontend (no framework) */
(() => {
  const $app = document.getElementById('app');
  const S = {
    me: null,
    view: 'mine', // 'mine' | 'admin'
    adminTab: 'roster',
    month: null, // 'YYYY-MM'
    cart: new Map(), // date -> swag(bool)
    banner: null,
    authMode: 'login',
    rosterDate: null,
    rosterFilter: '',
    peopleFilter: '',
    users: null,
  };

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (c / 100).toFixed(2).replace(/\.00$/, '');
  const money2 = (c) => '$' + (c / 100).toFixed(2);
  const d2 = (n) => String(n).padStart(2, '0');
  const toISO = (y, m, d) => `${y}-${d2(m)}-${d2(d)}`;
  const parse = (iso) => new Date(iso + 'T12:00:00');
  const fmt = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => parse(iso).toLocaleDateString('en-US', opts);
  const monthKey = (iso) => iso.slice(0, 7);
  const addMonths = (key, n) => {
    const [y, m] = key.split('-').map(Number);
    const dt = new Date(y, m - 1 + n, 1);
    return `${dt.getFullYear()}-${d2(dt.getMonth() + 1)}`;
  };
  const addDays = (iso, n) => {
    const dt = parse(iso);
    dt.setDate(dt.getDate() + n);
    return toISO(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  };

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2800);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error(data.error || 'Something went wrong.');
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // ---------- calendar ----------
  function isSchoolDay(iso, closedMap, settings) {
    const wd = parse(iso).getDay();
    return wd >= 1 && wd <= 5 && iso >= settings.year_start && iso <= settings.year_end && !closedMap.has(iso);
  }

  function calendarHTML({ month, today, settings, closedMap, paidMap, cart, allowPast }) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const cells = [];
    // leading blanks: weekday of first school-week day
    let first = 1;
    while ([0, 6].includes(new Date(y, m - 1, first).getDay())) first++;
    const lead = new Date(y, m - 1, first).getDay() - 1;
    for (let i = 0; i < lead; i++) cells.push('<div class="day empty"></div>');
    for (let d = first; d <= last; d++) {
      const iso = toISO(y, m, d);
      const wd = new Date(y, m - 1, d).getDay();
      if (wd === 0 || wd === 6) continue;
      const cls = ['day'];
      let tag = '';
      let clickable = false;
      const inYear = iso >= settings.year_start && iso <= settings.year_end;
      if (paidMap.has(iso)) {
        cls.push('paid');
        if (paidMap.get(iso).swag) cls.push('swag');
        tag = '✓ paid';
      } else if (closedMap.has(iso)) {
        cls.push('closed');
        tag = 'no school';
      } else if (!inYear || (!allowPast && iso < today)) {
        cls.push('off');
      } else {
        clickable = true;
        if (cart.has(iso)) {
          cls.push('sel');
          if (cart.get(iso)) cls.push('swag');
          tag = cart.get(iso) ? '★ swag' : 'picked';
        }
      }
      if (iso === today) cls.push('istoday');
      cells.push(
        `<button type="button" class="${cls.join(' ')}" ${clickable ? `data-day="${iso}"` : 'disabled'} aria-label="${fmt(iso, { weekday: 'long', month: 'long', day: 'numeric' })}${tag ? ', ' + tag : ''}">
          <span>${d}</span>${tag ? `<span class="tag">${tag}</span>` : ''}
        </button>`
      );
    }
    const minMonth = monthKey(allowPast ? settings.year_start : today > settings.year_start ? today : settings.year_start);
    const maxMonth = monthKey(settings.year_end);
    const title = parse(month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return `
      <div class="cal-head">
        <button class="navbtn" data-act="prev" ${month <= minMonth ? 'disabled' : ''} aria-label="Previous month">‹</button>
        <h3>${title}</h3>
        <button class="navbtn" data-act="next" ${month >= maxMonth ? 'disabled' : ''} aria-label="Next month">›</button>
      </div>
      <div class="cal">
        <div class="dow">Mon</div><div class="dow">Tue</div><div class="dow">Wed</div><div class="dow">Thu</div><div class="dow">Fri</div>
        ${cells.join('')}
      </div>`;
  }

  function availableInMonth(month, { today, settings, closedMap, paidMap, allowPast }, onlyWeekday) {
    const [y, m] = month.split('-').map(Number);
    const out = [];
    for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
      const iso = toISO(y, m, d);
      if (!isSchoolDay(iso, closedMap, settings)) continue;
      if (!allowPast && iso < today) continue;
      if (paidMap.has(iso)) continue;
      if (onlyWeekday && parse(iso).getDay() !== onlyWeekday) continue;
      out.push(iso);
    }
    return out;
  }

  function cartHTML(cart, settings, { showSwagAll = true } = {}) {
    const items = [...cart.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!items.length) return '<p class="muted small" style="margin:0">Tap days on the calendar to pick them.</p>';
    const allSwag = items.every(([, s]) => s);
    return `
      ${showSwagAll ? `<div class="row between" style="margin-bottom:6px">
        <span class="muted small">${items.length} day${items.length > 1 ? 's' : ''} picked${items.length > 1 ? ` (${fmt(items[0][0], { month: 'short', day: 'numeric' })} – ${fmt(items[items.length - 1][0], { month: 'short', day: 'numeric' })})` : ''}</span>
        <label class="toggle small"><input type="checkbox" data-act="swag-all" ${allSwag ? 'checked' : ''}> Swag every day</label>
      </div>` : ''}
      <div class="${items.length > 8 ? 'cart-scroll' : ''}">${items
        .map(
          ([iso, swag]) => `
        <div class="cart-item">
          <div class="date">${fmt(iso)}</div>
          <label class="toggle grow"><input type="checkbox" data-swag="${iso}" ${swag ? 'checked' : ''}> ${esc(settings.school_name)} swag</label>
          <b>${money(swag ? settings.price_swag_cents : settings.price_regular_cents)}</b>
          <button class="x" data-remove="${iso}" aria-label="Remove ${fmt(iso)}">×</button>
        </div>`
        )
        .join('')}</div>`;
  }
  const cartTotal = (cart, s) => [...cart.values()].reduce((t, swag) => t + (swag ? s.price_swag_cents : s.price_regular_cents), 0);

  // Wire up calendar + cart interactions inside a root element
  function bindPicker(root, ctx, rerender) {
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-day],[data-act],[data-remove]');
      if (!el || !root.contains(el)) return;
      if (el.dataset.day) {
        const iso = el.dataset.day;
        if (ctx.cart.has(iso)) ctx.cart.delete(iso);
        else ctx.cart.set(iso, ctx.defaultSwag());
        rerender();
      } else if (el.dataset.remove) {
        ctx.cart.delete(el.dataset.remove);
        rerender();
      } else if (el.dataset.act === 'prev' || el.dataset.act === 'next') {
        ctx.setMonth(addMonths(ctx.getMonth(), el.dataset.act === 'prev' ? -1 : 1));
        rerender();
      } else if (['fridays', 'all', 'fridays-year', 'all-year'].includes(el.dataset.act)) {
        const act = el.dataset.act;
        const o = ctx.calOpts();
        const months = [ctx.getMonth()];
        if (act.endsWith('-year')) {
          months[0] = monthKey(o.today > o.settings.year_start ? o.today : o.settings.year_start);
          while (months[months.length - 1] < monthKey(o.settings.year_end)) months.push(addMonths(months[months.length - 1], 1));
        }
        const days = months.flatMap((m) => availableInMonth(m, o, act.startsWith('fridays') ? 5 : 0));
        if (!days.length) return toast(act.endsWith('-year') ? 'No open days left this school year.' : 'No open days left this month.');
        const allIn = days.every((d) => ctx.cart.has(d));
        days.forEach((d) => (allIn ? ctx.cart.delete(d) : !ctx.cart.has(d) && ctx.cart.set(d, ctx.defaultSwag())));
        rerender();
      } else if (el.dataset.act === 'clear') {
        ctx.cart.clear();
        rerender();
      }
    });
    root.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.swag) {
        ctx.cart.set(el.dataset.swag, el.checked);
        rerender();
      } else if (el.dataset.act === 'swag-all') {
        for (const k of ctx.cart.keys()) ctx.cart.set(k, el.checked);
        rerender();
      }
    });
  }

  // ---------- auth screens ----------
  function renderAuth() {
    const login = S.authMode === 'login';
    $app.innerHTML = `
      <div class="auth">
        <div class="logo"><img src="/flyer.png" alt="Meadowlark Flyers mascot"></div>
        <h1>${esc(S.pub?.school_name ? S.pub.school_name + ' ' : '')}Jeans Days</h1>
        <p class="lead">Pay for your jeans days in a few taps.</p>
        <p class="tagline">All in, every day!</p>
        <div class="price-pills">
          <span class="pill"><b>${money(S.pub?.price_regular_cents ?? 200)}</b> / day in jeans</span>
          <span class="pill"><b>${money(S.pub?.price_swag_cents ?? 100)}</b> / day with ${esc(S.pub?.school_name || 'school')} swag</span>
        </div>
        ${S.banner ? `<div class="banner ${S.banner.type || ''}">${esc(S.banner.text)}</div>` : ''}
        <form class="card" id="authForm" novalidate>
          <h2>${login ? 'Log in' : 'Create your account'}</h2>
          ${login ? '' : `<label for="name">Your name</label><input id="name" type="text" autocomplete="name" placeholder="First and last name" required>`}
          <label for="email">Email</label>
          <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@school.org" required>
          <label for="pw">Password</label>
          <input id="pw" type="password" autocomplete="${login ? 'current-password' : 'new-password'}" placeholder="${login ? '' : 'At least 6 characters'}" required>
          <div id="authErr" class="banner err" style="display:none;margin:14px 0 0"></div>
          <button class="btn block" style="margin-top:16px" type="submit">${login ? 'Log in' : 'Create account'}</button>
        </form>
        <p style="text-align:center">
          ${login ? 'New here?' : 'Already have an account?'}
          <button class="linkbtn" id="swap" style="color:var(--brand);font-weight:700">${login ? 'Create an account' : 'Log in'}</button>
        </p>
        ${login ? '<p class="muted small" style="text-align:center">Forgot your password? Ask the jeans day admin to reset it.</p>' : ''}
      </div>`;
    document.getElementById('swap').onclick = () => {
      S.authMode = login ? 'signup' : 'login';
      S.banner = null;
      renderAuth();
    };
    document.getElementById('authForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const errEl = document.getElementById('authErr');
      btn.disabled = true;
      try {
        const body = { email: document.getElementById('email').value, password: document.getElementById('pw').value };
        if (!login) body.name = document.getElementById('name').value;
        await api(login ? '/api/login' : '/api/signup', { method: 'POST', body });
        S.banner = null;
        await boot();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        btn.disabled = false;
      }
    };
  }

  // ---------- shell ----------
  function shell(inner, { paybar = '' } = {}) {
    const u = S.me.user;
    const tabs = u.is_admin
      ? `<nav class="tabs">
          <button data-view="mine" class="${S.view === 'mine' ? 'on' : ''}">My Jeans Days</button>
          <button data-view="admin" class="${S.view === 'admin' ? 'on' : ''}">Admin</button>
        </nav>`
      : '';
    $app.innerHTML = `
      <header class="topbar">
        <div class="row" style="gap:10px;min-width:0">
          <img class="mascot" src="/flyer.png" alt="">
          <div style="min-width:0">
            <h1>${esc(S.me.settings.school_name)} Jeans Days</h1>
            <div class="sub">Hi, ${esc(u.name.split(' ')[0])} 👖</div>
          </div>
        </div>
        <div class="row">
          <button class="linkbtn" id="acctBtn">Account</button>
        </div>
      </header>
      ${tabs}
      <main id="main">${inner}</main>
      ${paybar}`;
    $app.querySelectorAll('[data-view]').forEach((b) =>
      (b.onclick = () => {
        S.view = b.dataset.view;
        render();
        window.scrollTo(0, 0);
      })
    );
    document.getElementById('acctBtn').onclick = openAccount;
  }

  function openSheet(title, html, onMount) {
    const bg = document.createElement('div');
    bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}">
      <div class="handle"><h2>${esc(title)}</h2><button class="x" data-close aria-label="Close">×</button></div>
      <div class="sheet-body">${html}</div></div>`;
    const close = () => {
      bg.remove();
      document.body.style.overflow = '';
    };
    bg.addEventListener('click', (e) => {
      if (e.target === bg || e.target.closest('[data-close]')) close();
    });
    document.body.appendChild(bg);
    document.body.style.overflow = 'hidden';
    onMount && onMount(bg.querySelector('.sheet-body'), close);
    return close;
  }

  function openAccount() {
    const u = S.me.user;
    openSheet(
      'Your account',
      `<div class="card">
        <div><b>${esc(u.name)}</b></div>
        <div class="muted">${esc(u.email)}</div>
      </div>
      <form class="card" id="pwForm">
        <h2>Change password</h2>
        <label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password">
        <label for="nw">New password</label><input id="nw" type="password" autocomplete="new-password">
        <button class="btn block" style="margin-top:14px">Update password</button>
      </form>
      <button class="btn ghost block" id="logout">Log out</button>`,
      (root, close) => {
        root.querySelector('#logout').onclick = async () => {
          await api('/api/logout', { method: 'POST' });
          close();
          S.me = null;
          S.cart.clear();
          renderAuth();
        };
        root.querySelector('#pwForm').onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api('/api/account/password', { method: 'POST', body: { current: root.querySelector('#cur').value, next: root.querySelector('#nw').value } });
            toast('Password updated');
            close();
          } catch (err) {
            toast(err.message);
          }
        };
      }
    );
  }

  // ---------- teacher view ----------
  function myCtx() {
    const me = S.me;
    return {
      cart: S.cart,
      getMonth: () => S.month,
      setMonth: (m) => (S.month = m),
      defaultSwag: () => false,
      calOpts: () => ({
        today: me.today,
        settings: me.settings,
        closedMap: new Map(me.noSchool.map((n) => [n.date, n])),
        paidMap: new Map(me.days.map((d) => [d.date, d])),
        allowPast: false,
      }),
    };
  }

  function renderMine() {
    const me = S.me;
    const s = me.settings;
    const ctx = myCtx();
    const opts = ctx.calOpts();
    const todayPaid = opts.paidMap.get(me.today);
    const todaySchool = isSchoolDay(me.today, opts.closedMap, s);
    const upcoming = me.days.filter((d) => d.date >= me.today);
    const total = cartTotal(S.cart, s);

    const todayCard = todayPaid
      ? `<div class="card today yes"><div class="big">✅</div><div><b>You're good to wear jeans today!</b><div class="small muted">${fmt(me.today, { weekday: 'long', month: 'long', day: 'numeric' })}${todayPaid.swag ? ` · with ${esc(s.school_name)} swag` : ''}</div></div></div>`
      : todaySchool
      ? `<div class="card today"><div class="big">👖</div><div class="grow"><b>Not paid for today yet</b><div class="small muted">Want to wear jeans today? Tap today on the calendar.</div></div></div>`
      : '';

    const inner = `
      ${me.paymentMode === 'demo' ? '<div class="banner"><b>Demo mode:</b> payments are not connected yet, so no cards are charged. Days are marked paid right away for testing.</div>' : ''}
      ${S.banner ? `<div class="banner ${S.banner.type || ''}">${esc(S.banner.text)}</div>` : ''}
      ${todayCard}
      <section class="card" id="picker">
        <h2>Pick your jeans days</h2>
        <p class="small muted" style="margin:-4px 0 12px">${money(s.price_regular_cents)}/day, or ${money(s.price_swag_cents)}/day when you also wear ${esc(s.school_name)} swag.</p>
        <div id="calWrap">${calendarHTML({ month: S.month, cart: S.cart, ...opts })}</div>
        <div class="quick" style="margin-top:12px">
          <button class="btn light sm" data-act="fridays">+ Fridays this month</button>
          <button class="btn light sm" data-act="all">+ Every day this month</button>
          <button class="btn light sm" data-act="fridays-year">+ Fridays, all year</button>
          <button class="btn light sm" data-act="all-year">+ Every day, all year</button>
        </div>
        ${S.cart.size ? '<button class="btn ghost sm block" style="margin-top:8px" data-act="clear">Clear picked days</button>' : ''}
        <div class="legend">
          <span style="--sw:var(--green)">Paid</span>
          <span style="--sw:var(--brand)">Picked</span>
          <span style="--sw:#fff;--sh:inset 0 0 0 3px var(--gold)">Swag</span>
          <span style="--sw:#e6e9ee">No school</span>
        </div>
        <div style="margin-top:14px">${cartHTML(S.cart, s)}</div>
      </section>
      <section class="card">
        <h2>My upcoming jeans days</h2>
        ${upcoming.length
          ? `<ul class="list">${upcoming
              .map(
                (d) => `<li><span class="grow"><b>${fmt(d.date)}</b></span>
                  ${d.swag ? `<span class="badge swag">★ swag</span>` : ''}
                  ${d.method === 'cash' ? '<span class="badge cash">cash</span>' : ''}
                  <span class="badge" style="background:var(--green-light);color:var(--green)">✓ paid</span></li>`
              )
              .join('')}</ul>`
          : '<p class="muted small" style="margin:0">None yet. Pick some days above!</p>'}
        ${me.days.length > upcoming.length ? `<p class="small muted" style="margin:10px 0 0">${me.days.length - upcoming.length} past day(s) already worn.</p>` : ''}
      </section>`;

    const paybar = S.cart.size
      ? `<div class="paybar"><div class="inner">
          <div class="grow"><div class="total">${money2(total)}</div><div class="small muted">${S.cart.size} day${S.cart.size > 1 ? 's' : ''}</div></div>
          <button class="btn gold" id="payBtn">💳 Pay now</button>
        </div></div>`
      : '';

    shell(inner, { paybar });
    bindPicker(document.getElementById('picker'), ctx, () => {
      S.banner = null;
      const y = window.scrollY;
      renderMine();
      window.scrollTo(0, y);
    });
    const payBtn = document.getElementById('payBtn');
    if (payBtn) payBtn.onclick = checkout;
  }

  async function checkout() {
    const btn = document.getElementById('payBtn');
    btn.disabled = true;
    btn.textContent = 'Opening checkout…';
    try {
      const days = [...S.cart.entries()].map(([date, swag]) => ({ date, swag }));
      const { url } = await api('/api/checkout', { method: 'POST', body: { days } });
      saveCart(); // restored if they cancel at checkout
      location.href = url;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = '💳 Pay now';
      if (err.status === 401) boot();
    }
  }

  // keep the cart if the page reloads (e.g. returning from a canceled checkout)
  function saveCart() {
    try { sessionStorage.setItem('cart', JSON.stringify([...S.cart.entries()])); } catch {}
  }
  function loadCart() {
    try {
      const c = JSON.parse(sessionStorage.getItem('cart') || '[]');
      c.forEach(([d, s]) => S.cart.set(d, s));
    } catch {}
  }

  // ---------- admin ----------
  function adminTabs() {
    const t = [
      ['roster', 'Who’s in jeans'],
      ['people', 'People'],
      ['money', 'Money'],
      ['settings', 'Settings'],
    ];
    return `<div class="chips" style="margin-bottom:14px">${t
      .map(([k, l]) => `<button class="btn sm ${S.adminTab === k ? '' : 'ghost'}" data-atab="${k}">${l}</button>`)
      .join('')}</div>`;
  }

  async function renderAdmin() {
    shell(adminTabs() + '<div id="adminBody" class="loading">Loading…</div>');
    document.querySelectorAll('[data-atab]').forEach((b) => (b.onclick = () => ((S.adminTab = b.dataset.atab), renderAdmin())));
    const body = document.getElementById('adminBody');
    try {
      if (S.adminTab === 'roster') await adminRoster(body);
      else if (S.adminTab === 'people') await adminPeople(body);
      else if (S.adminTab === 'money') await adminMoney(body);
      else await adminSettings(body);
      body.classList.remove('loading');
    } catch (err) {
      body.innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  }

  function prevSchoolDay(iso, dir) {
    const closed = new Map(S.me.noSchool.map((n) => [n.date, n]));
    let d = iso;
    for (let i = 0; i < 30; i++) {
      d = addDays(d, dir);
      if (isSchoolDay(d, closed, S.me.settings)) return d;
    }
    return addDays(iso, dir);
  }

  async function adminRoster(body) {
    S.rosterDate = S.rosterDate || S.me.today;
    const { people } = await api('/api/admin/roster?date=' + S.rosterDate);
    const swag = people.filter((p) => p.swag).length;
    const draw = () => {
      const f = S.rosterFilter.toLowerCase();
      const list = people.filter((p) => !f || p.name.toLowerCase().includes(f));
      body.querySelector('#rosterList').innerHTML = list.length
        ? list
            .map(
              (p) => `<li><span class="grow"><b>${esc(p.name)}</b></span>
                ${p.swag ? '<span class="badge swag">★ swag</span>' : ''}
                ${p.method === 'cash' ? '<span class="badge cash">cash</span>' : ''}</li>`
            )
            .join('')
        : `<li class="muted">${people.length ? 'No match.' : 'Nobody has paid for this day yet.'}</li>`;
    };
    body.innerHTML = `
      <div class="card">
        <div class="row between">
          <button class="navbtn" id="rPrev" aria-label="Previous school day">‹</button>
          <div style="text-align:center">
            <div><b>${fmt(S.rosterDate, { weekday: 'long', month: 'long', day: 'numeric' })}</b>${S.rosterDate === S.me.today ? ' <span class="badge">Today</span>' : ''}</div>
            <input type="date" id="rDate" value="${S.rosterDate}" style="margin-top:6px;min-height:38px;padding:6px 10px;width:auto">
          </div>
          <button class="navbtn" id="rNext" aria-label="Next school day">›</button>
        </div>
      </div>
      <div class="card">
        <div class="row" style="align-items:flex-end">
          <div class="big-count">${people.length}</div>
          <div class="muted" style="padding-bottom:4px">paid to wear jeans${swag ? ` · ${swag} with swag` : ''}</div>
        </div>
        <input type="search" id="rFilter" placeholder="Search a name…" value="${esc(S.rosterFilter)}" style="margin-top:12px">
        <ul class="list" id="rosterList" style="margin-top:6px"></ul>
        <p class="small muted" style="margin:10px 0 0">Not on this list = hasn’t paid for this day.</p>
      </div>`;
    draw();
    body.querySelector('#rFilter').oninput = (e) => ((S.rosterFilter = e.target.value), draw());
    body.querySelector('#rDate').onchange = (e) => e.target.value && ((S.rosterDate = e.target.value), renderAdmin());
    body.querySelector('#rPrev').onclick = () => ((S.rosterDate = prevSchoolDay(S.rosterDate, -1)), renderAdmin());
    body.querySelector('#rNext').onclick = () => ((S.rosterDate = prevSchoolDay(S.rosterDate, 1)), renderAdmin());
  }

  async function adminPeople(body) {
    const { users } = await api('/api/admin/users');
    const draw = () => {
      const f = S.peopleFilter.toLowerCase();
      const list = users.filter((u) => !f || u.name.toLowerCase().includes(f) || u.email.toLowerCase().includes(f));
      body.querySelector('#pList').innerHTML = list.length
        ? list
            .map(
              (u) => `<li class="clickable" data-uid="${u.id}">
                <div class="grow"><b>${esc(u.name)}</b> ${u.is_admin ? '<span class="badge admin">admin</span>' : ''}<div class="small muted">${esc(u.email)}</div></div>
                <div style="text-align:right"><b>${u.days}</b> <span class="small muted">days</span><div class="small muted">${money2(u.paid_cents)}</div></div>
                <span class="muted">›</span></li>`
            )
            .join('')
        : '<li class="muted">No one found.</li>';
    };
    body.innerHTML = `
      <div class="card">
        <div class="row between"><h2 style="margin:0">${users.length} people</h2></div>
        <p class="small muted" style="margin:4px 0 0">Tap someone to record a cash payment, reset their password, or see their days.</p>
        <input type="search" id="pFilter" placeholder="Search name or email…" value="${esc(S.peopleFilter)}" style="margin-top:12px">
        <ul class="list" id="pList" style="margin-top:6px"></ul>
      </div>`;
    draw();
    body.querySelector('#pFilter').oninput = (e) => ((S.peopleFilter = e.target.value), draw());
    body.querySelector('#pList').onclick = (e) => {
      const li = e.target.closest('[data-uid]');
      if (li) openPerson(Number(li.dataset.uid));
    };
  }

  async function openPerson(id) {
    const { user, days } = await api('/api/admin/users/' + id);
    const s = S.me.settings;
    const cart = new Map();
    let month = monthKey(S.me.today < s.year_start ? s.year_start : S.me.today > s.year_end ? s.year_end : S.me.today);
    const ctx = {
      cart,
      getMonth: () => month,
      setMonth: (m) => (month = m),
      defaultSwag: () => false,
      calOpts: () => ({
        today: S.me.today,
        settings: s,
        closedMap: new Map(S.me.noSchool.map((n) => [n.date, n])),
        paidMap: new Map(days.map((d) => [d.date, d])),
        allowPast: true,
      }),
    };
    openSheet(user.name, '', (root, close) => {
      const draw = () => {
        const total = cartTotal(cart, s);
        root.innerHTML = `
          <div class="card">
            <div class="muted">${esc(user.email)}</div>
            <div class="small" style="margin-top:6px">${days.length} paid day(s)</div>
          </div>
          <section class="card" id="pp">
            <h2>Record a cash / check payment</h2>
            <p class="small muted" style="margin:-4px 0 12px">Pick the days they paid for in person. Past days are allowed here.</p>
            ${calendarHTML({ month, cart, ...ctx.calOpts() })}
            <div style="margin-top:12px">${cartHTML(cart, s, { showSwagAll: false })}</div>
            <label for="cashNote">Note (optional)</label>
            <input type="text" id="cashNote" placeholder="e.g. Cash given to front office">
            <button class="btn block" id="saveCash" style="margin-top:12px" ${cart.size ? '' : 'disabled'}>Mark ${cart.size || ''} day${cart.size === 1 ? '' : 's'} paid · ${money2(total)}</button>
          </section>
          <div class="card">
            <h2>Account</h2>
            <div class="chips">
              <button class="btn ghost sm" id="resetPw">Reset password</button>
              <button class="btn ghost sm" id="toggleAdmin">${user.is_admin ? 'Remove admin' : 'Make admin'}</button>
            </div>
            <div id="tempPw"></div>
          </div>`;
        root.querySelector('#saveCash').onclick = async () => {
          try {
            const r = await api(`/api/admin/users/${id}/cash`, {
              method: 'POST',
              body: { days: [...cart.entries()].map(([date, swag]) => ({ date, swag })), note: root.querySelector('#cashNote').value },
            });
            toast(`Recorded ${money2(r.total)} for ${user.name}`);
            close();
            S.users = null;
            renderAdmin();
            if (id === S.me.user.id) refreshMe();
          } catch (err) {
            toast(err.message);
          }
        };
        root.querySelector('#resetPw').onclick = async () => {
          if (!confirm(`Reset ${user.name}'s password?`)) return;
          const r = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
          root.querySelector('#tempPw').innerHTML = `<div class="banner ok" style="margin:12px 0 0">Temporary password: <b style="font-size:18px">${esc(r.temp)}</b><br>Give this to ${esc(user.name)}. They can change it under Account.</div>`;
        };
        root.querySelector('#toggleAdmin').onclick = async () => {
          try {
            await api(`/api/admin/users/${id}/admin`, { method: 'POST', body: { is_admin: !user.is_admin } });
            user.is_admin = !user.is_admin;
            toast(user.is_admin ? 'Now an admin' : 'Admin removed');
            draw();
            renderAdmin();
          } catch (err) {
            toast(err.message);
          }
        };
      };
      draw();
      bindPicker(root, ctx, draw); // delegated on root, survives re-draws
    });
  }

  async function adminMoney(body) {
    const d = await api('/api/admin/summary');
    const by = Object.fromEntries(d.byMethod.map((r) => [r.method, r]));
    const total = d.byMethod.reduce((t, r) => t + r.cents, 0);
    body.innerHTML = `
      <div class="card">
        <div class="row wrap">
          <div class="stat"><div class="n">${money2(total)}</div><div class="l">Total collected</div></div>
          <div class="stat"><div class="n">${d.days}</div><div class="l">Jeans days sold${d.swagDays ? ` (${d.swagDays} swag)` : ''}</div></div>
        </div>
        <div class="row wrap" style="margin-top:10px">
          <div class="stat"><div class="n">${money2(by.card?.cents || 0)}</div><div class="l">By card</div></div>
          <div class="stat"><div class="n">${money2(by.cash?.cents || 0)}</div><div class="l">Cash / check</div></div>
          ${by.demo ? `<div class="stat"><div class="n">${money2(by.demo.cents)}</div><div class="l">Demo (not real)</div></div>` : ''}
        </div>
        <a class="btn light block" style="margin-top:14px" href="/api/admin/export.csv">⬇ Download spreadsheet (CSV)</a>
        <p class="small muted" style="margin:10px 0 0">Card totals are before Stripe’s processing fees. Payouts and refunds are managed in your Stripe dashboard.</p>
      </div>
      <div class="card">
        <h2>Recent payments</h2>
        <ul class="list">${
          d.recent.length
            ? d.recent
                .map((o) => {
                  const dates = (o.dates || '').split(',').filter(Boolean).sort();
                  return `<li style="align-items:flex-start"><div class="grow"><b>${esc(o.name)}</b>
                    <div class="small muted">${dates.length} day${dates.length > 1 ? 's' : ''}: ${dates.slice(0, 6).map((x) => fmt(x, { month: 'short', day: 'numeric' })).join(', ')}${dates.length > 6 ? '…' : ''}</div>
                    ${o.note ? `<div class="small muted">“${esc(o.note)}”</div>` : ''}</div>
                    <div style="text-align:right"><b>${money2(o.amount_cents)}</b><div><span class="badge ${o.method === 'cash' ? 'cash' : ''}">${esc(o.method)}</span></div></div></li>`;
                })
                .join('')
            : '<li class="muted">No payments yet.</li>'
        }</ul>
      </div>`;
  }

  async function adminSettings(body) {
    const s = S.me.settings;
    const modeText = {
      demo: '<div class="banner"><b>Demo mode.</b> Stripe isn’t connected, so nobody is charged. See the README to connect Stripe.</div>',
      test: '<div class="banner"><b>Stripe TEST mode.</b> Use card 4242 4242 4242 4242 to try it. Switch to live keys before launch.</div>',
      live: '<div class="banner ok"><b>Stripe is live.</b> Real cards are being charged.</div>',
    }[S.me.paymentMode];
    body.innerHTML = `
      ${modeText}
      <form class="card" id="setForm">
        <h2>School year & prices</h2>
        <label for="sName">School name</label>
        <input type="text" id="sName" value="${esc(s.school_name)}">
        <div class="row">
          <div class="grow"><label for="sStart">First day</label><input type="date" id="sStart" value="${s.year_start}"></div>
          <div class="grow"><label for="sEnd">Last day</label><input type="date" id="sEnd" value="${s.year_end}"></div>
        </div>
        <div class="row">
          <div class="grow"><label for="pReg">Jeans price ($)</label><input type="number" step="0.25" min="0.5" id="pReg" value="${(s.price_regular_cents / 100).toFixed(2)}" inputmode="decimal"></div>
          <div class="grow"><label for="pSwag">With swag ($)</label><input type="number" step="0.25" min="0.5" id="pSwag" value="${(s.price_swag_cents / 100).toFixed(2)}" inputmode="decimal"></div>
        </div>
        <button class="btn block" style="margin-top:14px">Save</button>
      </form>
      <div class="card">
        <h2>No-school days</h2>
        <p class="small muted" style="margin:-4px 0 10px">Holidays, breaks, in-service days. These can’t be picked. Weekends are already blocked.</p>
        <form id="nsForm" class="row wrap" style="align-items:flex-end">
          <div style="flex:1 1 150px"><label for="nsDate">Date</label><input type="date" id="nsDate" min="${s.year_start}" max="${s.year_end}"></div>
          <div style="flex:2 1 180px"><label for="nsNote">Reason</label><input type="text" id="nsNote" placeholder="e.g. Thanksgiving break"></div>
          <div style="flex:1 1 100%"><div class="row"><label class="toggle small" style="margin:0"><input type="checkbox" id="nsWeek"> Block the whole week (Mon–Fri)</label></div></div>
          <button class="btn sm" style="flex:1 1 100%">Add</button>
        </form>
        <ul class="list" style="margin-top:12px">${
          S.me.noSchool.length
            ? S.me.noSchool
                .map((n) => `<li><span class="grow"><b>${fmt(n.date)}</b> <span class="muted small">${esc(n.note || '')}</span></span><button class="x" data-del="${n.date}" aria-label="Remove">×</button></li>`)
                .join('')
            : '<li class="muted">None added yet.</li>'
        }</ul>
      </div>`;
    body.querySelector('#setForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/settings', {
          method: 'POST',
          body: {
            school_name: body.querySelector('#sName').value,
            year_start: body.querySelector('#sStart').value,
            year_end: body.querySelector('#sEnd').value,
            price_regular_cents: Math.round(parseFloat(body.querySelector('#pReg').value) * 100),
            price_swag_cents: Math.round(parseFloat(body.querySelector('#pSwag').value) * 100),
          },
        });
        await refreshMe();
        toast('Settings saved');
        renderAdmin();
      } catch (err) {
        toast(err.message);
      }
    };
    body.querySelector('#nsForm').onsubmit = async (e) => {
      e.preventDefault();
      const date = body.querySelector('#nsDate').value;
      const note = body.querySelector('#nsNote').value;
      if (!date) return toast('Pick a date');
      let dates = [date];
      if (body.querySelector('#nsWeek').checked) {
        const wd = parse(date).getDay();
        const mon = addDays(date, wd === 0 ? 1 : 1 - wd);
        dates = [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
      }
      try {
        for (const d of dates) await api('/api/admin/no-school', { method: 'POST', body: { date: d, note } });
        await refreshMe();
        toast(dates.length > 1 ? 'Week blocked' : 'Added');
        renderAdmin();
      } catch (err) {
        toast(err.message);
      }
    };
    body.querySelectorAll('[data-del]').forEach(
      (b) =>
        (b.onclick = async () => {
          await api('/api/admin/no-school', { method: 'DELETE', body: { date: b.dataset.del } });
          await refreshMe();
          renderAdmin();
        })
    );
  }

  // ---------- boot ----------
  async function refreshMe() {
    S.me = await api('/api/me');
  }

  function render() {
    if (!S.me) return renderAuth();
    if (S.view === 'admin' && S.me.user.is_admin) renderAdmin();
    else renderMine();
  }

  async function boot() {
    const q = new URLSearchParams(location.search);
    try {
      await refreshMe();
    } catch (err) {
      if (err.status === 401) {
        S.me = null;
        try { S.pub = await api('/api/public'); } catch {}
        return renderAuth();
      }
      $app.innerHTML = `<div class="auth"><div class="banner err">${esc(err.message)}</div><button class="btn block" onclick="location.reload()">Try again</button></div>`;
      return;
    }
    const s = S.me.settings;
    const start = S.me.today < s.year_start ? s.year_start : S.me.today;
    if (!S.month) S.month = monthKey(start > s.year_end ? s.year_end : start);

    if (q.has('paid')) {
      sessionStorage.removeItem('cart');
      S.cart.clear();
      try {
        if (q.get('session_id')) {
          const r = await api('/api/checkout/confirm?session_id=' + encodeURIComponent(q.get('session_id')));
          S.banner = r.pending
            ? { type: '', text: 'Payment is processing. Your days will show as paid in a moment. Pull to refresh.' }
            : { type: 'ok', text: '🎉 Payment received! Your jeans days are locked in.' };
          await refreshMe();
        } else {
          S.banner = { type: 'ok', text: '🎉 Your jeans days are locked in.' };
        }
      } catch (err) {
        S.banner = { type: 'err', text: err.message };
      }
      history.replaceState(null, '', '/');
    } else if (q.has('canceled')) {
      loadCart();
      S.banner = { type: '', text: 'Payment canceled. Your picked days are still here.' };
      history.replaceState(null, '', '/');
    }
    render();
  }

  window.addEventListener('pagehide', () => S.cart.size && saveCart());
  boot();
})();
