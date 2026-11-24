// Jeans Day Tracker - Cloudflare Worker (API) + static frontend in /public

const enc = new TextEncoder();
const SESSION_DAYS = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_SETTINGS = {
  school_name: 'Meadowlark',
  year_start: '2026-08-12',
  year_end: '2027-05-21',
  price_regular_cents: '200',
  price_swag_cents: '100',
};

// ---------- helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (error, status = 400) => json({ error }, status);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hashPassword(password, saltHex = randomHex(16), iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations },
    key,
    256
  );
  return `pbkdf2$${iterations}$${saltHex}$${hex(bits)}`;
}
async function verifyPassword(password, stored) {
  const [, iter, salt] = stored.split('$');
  return safeEqual(await hashPassword(password, salt, Number(iter)), stored);
}

function todayIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
const weekday = (d) => new Date(d + 'T12:00:00Z').getUTCDay(); // 0 Sun .. 6 Sat
const prettyDate = (d) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const money = (c) => '$' + (c / 100).toFixed(2);

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function adminEmails(env) {
  return (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of results) s[r.key] = r.value;
  return {
    school_name: s.school_name,
    year_start: s.year_start,
    year_end: s.year_end,
    price_regular_cents: Number(s.price_regular_cents),
    price_swag_cents: Number(s.price_swag_cents),
  };
}

function paymentMode(env) {
  const k = env.STRIPE_SECRET_KEY || '';
  if (!k) return 'demo';
  return k.startsWith('sk_live') || k.startsWith('rk_live') ? 'live' : 'test';
}

// ---------- sessions ----------
function cookieHeader(token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function createSession(env, userId) {
  const token = randomHex(32);
  const expires = Date.now() + SESSION_DAYS * 86400000;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, expires)
    .run();
  return cookieHeader(token, SESSION_DAYS * 86400);
}
async function currentUser(request, env) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.is_admin, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  )
    .bind(await sha256(m[1]))
    .first();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, name: row.name, email: row.email, is_admin: !!row.is_admin };
}

// ---------- day validation ----------
async function validateDays(env, userId, days, { allowPast = false } = {}) {
  const settings = await getSettings(env);
  const today = todayIn(env.TIMEZONE);
  if (!Array.isArray(days) || days.length === 0) return { error: 'Pick at least one day.' };
  if (days.length > 200) return { error: 'Too many days at once.' };

  const { results: noSchool } = await env.DB.prepare('SELECT date FROM no_school_days').all();
  const closed = new Set(noSchool.map((r) => r.date));
  const { results: already } = await env.DB.prepare('SELECT date FROM jean_days WHERE user_id = ?').bind(userId).all();
  const paid = new Set(already.map((r) => r.date));

  const seen = new Set();
  const items = [];
  for (const d of days) {
    const date = String(d?.date || '');
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: `Invalid date: ${date}` };
    if (seen.has(date)) continue;
    seen.add(date);
    const wd = weekday(date);
    if (wd === 0 || wd === 6) return { error: `${prettyDate(date)} is a weekend.` };
    if (!allowPast && date < today) return { error: `${prettyDate(date)} has already passed.` };
    if (date < settings.year_start || date > settings.year_end) return { error: `${prettyDate(date)} is outside the school year.` };
    if (closed.has(date)) return { error: `${prettyDate(date)} is not a school day.` };
    if (paid.has(date)) return { error: `${prettyDate(date)} is already paid for.` };
    const swag = d.swag ? 1 : 0;
    items.push({ date, swag, price_cents: swag ? settings.price_swag_cents : settings.price_regular_cents });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { items, total: items.reduce((s, i) => s + i.price_cents, 0), settings };
}

async function createOrder(env, userId, method, items, total, extra = {}) {
  const order = await env.DB.prepare(
    `INSERT INTO orders (user_id, method, status, amount_cents, note, recorded_by) VALUES (?, ?, 'pending', ?, ?, ?) RETURNING id`
  )
    .bind(userId, method, total, extra.note || null, extra.recorded_by || null)
    .first();
  await env.DB.batch(
    items.map((i) =>
      env.DB.prepare('INSERT INTO order_items (order_id, date, swag, price_cents) VALUES (?, ?, ?, ?)').bind(
        order.id,
        i.date,
        i.swag,
        i.price_cents
      )
    )
  );
  return order.id;
}

// Idempotent: safe to call from both the redirect and the webhook.
async function markOrderPaid(env, orderId) {
  const res = await env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status != 'paid'`)
    .bind(orderId)
    .run();
  if (res.meta.changes > 0) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO jean_days (user_id, date, swag, order_id)
       SELECT o.user_id, i.date, i.swag, o.id FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.id = ?`
    )
      .bind(orderId)
      .run();
  }
}

// ---------- Stripe ----------
async function stripe(env, method, path, params) {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const res = await fetch('https://api.stripe.com/v1' + path, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Stripe error');
  return data;
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).map(([k, ...v]) => [k, v.join('=')]));
  const sigs = header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  const t = parts.t;
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, expected));
}

// ---------- routes ----------
async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Stripe webhook (no session)
  if (path === '/api/stripe/webhook' && method === 'POST') {
    const payload = await request.text();
    const ok = await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return fail('Bad signature', 400);
    const event = JSON.parse(payload);
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const s = event.data.object;
      const orderId = Number(s.metadata?.order_id);
      if (orderId && s.payment_status === 'paid') await markOrderPaid(env, orderId);
    }
    return json({ received: true });
  }

  if (path === '/api/public' && method === 'GET') {
    const { school_name, price_regular_cents, price_swag_cents } = await getSettings(env);
    return json({ school_name, price_regular_cents, price_swag_cents });
  }

  if (path === '/api/signup' && method === 'POST') {
    const { name, email, password } = await readJson(request);
    const n = String(name || '').trim();
    const e = String(email || '').trim().toLowerCase();
    if (n.length < 2) return fail('Please enter your full name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return fail('Please enter a valid email.');
    if (String(password || '').length < 6) return fail('Password must be at least 6 characters.');
    const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(e).first();
    if (exists) return fail('An account with that email already exists. Try logging in.');
    const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
    const isAdmin = adminEmails(env).includes(e) || c === 0 ? 1 : 0; // first account becomes admin
    const user = await env.DB.prepare('INSERT INTO users (name, email, password_hash, is_admin) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(n, e, await hashPassword(password), isAdmin)
      .first();
    return json({ ok: true }, 200, { 'set-cookie': await createSession(env, user.id) });
  }

  if (path === '/api/login' && method === 'POST') {
    const { email, password } = await readJson(request);
    const e = String(email || '').trim().toLowerCase();
    const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?').bind(e).first();
    if (!user || !(await verifyPassword(String(password || ''), user.password_hash)))
      return fail('Email or password is incorrect.', 401);
    if (adminEmails(env).includes(e)) await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
    return json({ ok: true }, 200, { 'set-cookie': await createSession(env, user.id) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(m[1])).run();
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
  }

  // ---- everything below requires login ----
  const user = await currentUser(request, env);
  if (!user) return fail('Please log in.', 401);

  if (path === '/api/me' && method === 'GET') {
    const settings = await getSettings(env);
    const { results: noSchool } = await env.DB.prepare('SELECT date, note FROM no_school_days ORDER BY date').all();
    const { results: days } = await env.DB.prepare(
      `SELECT j.date, j.swag, o.method FROM jean_days j JOIN orders o ON o.id = j.order_id WHERE j.user_id = ? ORDER BY j.date`
    )
      .bind(user.id)
      .all();
    return json({ user, settings, noSchool, days, today: todayIn(env.TIMEZONE), paymentMode: paymentMode(env) });
  }

  if (path === '/api/account/password' && method === 'POST') {
    const { current, next } = await readJson(request);
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
    if (!(await verifyPassword(String(current || ''), row.password_hash))) return fail('Current password is incorrect.');
    if (String(next || '').length < 6) return fail('New password must be at least 6 characters.');
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(next), user.id).run();
    return json({ ok: true });
  }

  if (path === '/api/checkout' && method === 'POST') {
    const { days } = await readJson(request);
    const v = await validateDays(env, user.id, days);
    if (v.error) return fail(v.error);
    const mode = paymentMode(env);
    const orderId = await createOrder(env, user.id, mode === 'demo' ? 'demo' : 'card', v.items, v.total);

    if (mode === 'demo') {
      await markOrderPaid(env, orderId);
      return json({ url: `${url.origin}/?paid=1&demo=1` });
    }

    const regular = v.items.filter((i) => !i.swag);
    const swag = v.items.filter((i) => i.swag);
    const params = {
      mode: 'payment',
      success_url: `${url.origin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${url.origin}/?canceled=1`,
      customer_email: user.email,
      client_reference_id: String(orderId),
      'metadata[order_id]': String(orderId),
      'payment_intent_data[metadata][order_id]': String(orderId),
      'payment_intent_data[description]': `${v.settings.school_name} jeans days for ${user.name}: ${v.items.map((i) => i.date).join(', ')}`.slice(0, 1000),
    };
    let li = 0;
    const addLine = (list, label, price) => {
      if (!list.length) return;
      params[`line_items[${li}][quantity]`] = String(list.length);
      params[`line_items[${li}][price_data][currency]`] = 'usd';
      params[`line_items[${li}][price_data][unit_amount]`] = String(price);
      params[`line_items[${li}][price_data][product_data][name]`] = label;
      params[`line_items[${li}][price_data][product_data][description]`] = list.map((i) => prettyDate(i.date)).join(', ').slice(0, 500);
      li++;
    };
    addLine(regular, 'Jeans day', v.settings.price_regular_cents);
    addLine(swag, `Jeans day + ${v.settings.school_name} swag`, v.settings.price_swag_cents);
    try {
      const session = await stripe(env, 'POST', '/checkout/sessions', params);
      await env.DB.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').bind(session.id, orderId).run();
      return json({ url: session.url });
    } catch (e) {
      return fail('Could not start payment: ' + e.message, 502);
    }
  }

  if (path === '/api/checkout/confirm' && method === 'GET') {
    const sid = url.searchParams.get('session_id') || '';
    if (!sid.startsWith('cs_') || paymentMode(env) === 'demo') return json({ ok: true });
    const order = await env.DB.prepare('SELECT id, user_id, status FROM orders WHERE stripe_session_id = ?').bind(sid).first();
    if (!order || order.user_id !== user.id) return fail('Order not found.', 404);
    if (order.status !== 'paid') {
      const s = await stripe(env, 'GET', `/checkout/sessions/${encodeURIComponent(sid)}`);
      if (s.payment_status === 'paid') await markOrderPaid(env, order.id);
      else return json({ ok: false, pending: true });
    }
    return json({ ok: true });
  }

  // ---- admin ----
  if (path.startsWith('/api/admin/')) {
    if (!user.is_admin) return fail('Admins only.', 403);
    return handleAdmin(request, env, url, user);
  }

  return fail('Not found', 404);
}

async function handleAdmin(request, env, url, admin) {
  const path = url.pathname.slice('/api/admin'.length);
  const method = request.method;

  if (path === '/roster' && method === 'GET') {
    const date = url.searchParams.get('date') || todayIn(env.TIMEZONE);
    if (!DATE_RE.test(date)) return fail('Bad date');
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, j.swag, o.method FROM jean_days j
       JOIN users u ON u.id = j.user_id JOIN orders o ON o.id = j.order_id
       WHERE j.date = ? ORDER BY u.name COLLATE NOCASE`
    )
      .bind(date)
      .all();
    return json({ date, people: results });
  }

  if (path === '/summary' && method === 'GET') {
    const { results: byMethod } = await env.DB.prepare(
      `SELECT method, COUNT(*) AS orders, SUM(amount_cents) AS cents FROM orders WHERE status = 'paid' GROUP BY method`
    ).all();
    const days = await env.DB.prepare('SELECT COUNT(*) AS c, SUM(swag) AS swag FROM jean_days').first();
    const { results: recent } = await env.DB.prepare(
      `SELECT o.id, o.method, o.amount_cents, o.paid_at, o.note, u.name,
              (SELECT GROUP_CONCAT(date, ',') FROM order_items WHERE order_id = o.id) AS dates
       FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.status = 'paid' ORDER BY o.paid_at DESC LIMIT 50`
    ).all();
    return json({ byMethod, days: days.c || 0, swagDays: days.swag || 0, recent });
  }

  if (path === '/export.csv' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT i.date, u.name, u.email, i.swag, i.price_cents, o.method, o.paid_at, o.id AS order_id
       FROM order_items i JOIN orders o ON o.id = i.order_id JOIN users u ON u.id = o.user_id
       WHERE o.status = 'paid' ORDER BY i.date, u.name`
    ).all();
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Name', 'Email', 'Swag', 'Amount', 'Method', 'Paid at (UTC)', 'Order #']];
    for (const r of results)
      rows.push([r.date, r.name, r.email, r.swag ? 'yes' : 'no', (r.price_cents / 100).toFixed(2), r.method, r.paid_at, r.order_id]);
    return new Response(rows.map((r) => r.map(q).join(',')).join('\r\n'), {
      headers: {
        'content-type': 'text/csv',
        'content-disposition': `attachment; filename="jeans-days-${todayIn(env.TIMEZONE)}.csv"`,
      },
    });
  }

  if (path === '/users' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.is_admin,
              (SELECT COUNT(*) FROM jean_days WHERE user_id = u.id) AS days,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE user_id = u.id AND status = 'paid') AS paid_cents
       FROM users u ORDER BY u.name COLLATE NOCASE`
    ).all();
    return json({ users: results });
  }

  let m;
  if ((m = path.match(/^\/users\/(\d+)$/)) && method === 'GET') {
    const id = Number(m[1]);
    const u = await env.DB.prepare('SELECT id, name, email, is_admin FROM users WHERE id = ?').bind(id).first();
    if (!u) return fail('Not found', 404);
    const { results: days } = await env.DB.prepare(
      `SELECT j.date, j.swag, o.method FROM jean_days j JOIN orders o ON o.id = j.order_id WHERE j.user_id = ? ORDER BY j.date`
    )
      .bind(id)
      .all();
    return json({ user: u, days });
  }

  if ((m = path.match(/^\/users\/(\d+)\/cash$/)) && method === 'POST') {
    const id = Number(m[1]);
    const { days, note } = await readJson(request);
    const v = await validateDays(env, id, days, { allowPast: true });
    if (v.error) return fail(v.error);
    const orderId = await createOrder(env, id, 'cash', v.items, v.total, { note: String(note || '').slice(0, 200), recorded_by: admin.id });
    await markOrderPaid(env, orderId);
    return json({ ok: true, total: v.total });
  }

  if ((m = path.match(/^\/users\/(\d+)\/admin$/)) && method === 'POST') {
    const id = Number(m[1]);
    const { is_admin } = await readJson(request);
    if (id === admin.id && !is_admin) return fail("You can't remove your own admin access.");
    await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(is_admin ? 1 : 0, id).run();
    return json({ ok: true });
  }

  if ((m = path.match(/^\/users\/(\d+)\/reset-password$/)) && method === 'POST') {
    const id = Number(m[1]);
    const words = ['denim', 'jeans', 'friday', 'swag', 'lark', 'meadow', 'casual', 'blue'];
    const temp = words[crypto.getRandomValues(new Uint8Array(1))[0] % words.length] + '-' + (1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(temp), id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    ]);
    return json({ ok: true, temp });
  }

  if (path === '/settings' && method === 'POST') {
    const b = await readJson(request);
    const upd = {};
    if (b.school_name !== undefined) upd.school_name = String(b.school_name).trim().slice(0, 60) || 'School';
    for (const k of ['year_start', 'year_end']) {
      if (b[k] !== undefined) {
        if (!DATE_RE.test(b[k])) return fail('Dates must be YYYY-MM-DD.');
        upd[k] = b[k];
      }
    }
    for (const k of ['price_regular_cents', 'price_swag_cents']) {
      if (b[k] !== undefined) {
        const n = Math.round(Number(b[k]));
        if (!(n >= 50 && n <= 10000)) return fail('Prices must be between $0.50 and $100.');
        upd[k] = String(n);
      }
    }
    const merged = { ...(await getSettings(env)), ...upd };
    if (merged.year_start > merged.year_end) return fail('School year start must be before the end.');
    await env.DB.batch(
      Object.entries(upd).map(([k, v]) =>
        env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v)
      )
    );
    return json({ ok: true, settings: await getSettings(env) });
  }

  if (path === '/no-school' && method === 'POST') {
    const { date, note } = await readJson(request);
    if (!DATE_RE.test(date || '')) return fail('Pick a date.');
    await env.DB.prepare('INSERT INTO no_school_days (date, note) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET note = excluded.note')
      .bind(date, String(note || '').slice(0, 80))
      .run();
    return json({ ok: true });
  }
  if (path === '/no-school' && method === 'DELETE') {
    const { date } = await readJson(request);
    await env.DB.prepare('DELETE FROM no_school_days WHERE date = ?').bind(date || '').run();
    return json({ ok: true });
  }

  return fail('Not found', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // Block cross-site form posts (JSON-only API)
      if (request.method !== 'GET' && url.pathname !== '/api/stripe/webhook') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return fail('Bad origin', 403);
      }
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error(e);
        return fail('Something went wrong. Please try again.', 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
