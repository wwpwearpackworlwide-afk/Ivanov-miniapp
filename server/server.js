'use strict';
/* IvanovService Mini App — сервер без внешних зависимостей (только Node.js 18+).
   1) раздаёт папку public/
   2) принимает заявки POST /api/order, проверяет подпись Telegram initData,
      валидирует данные, ограничивает частоту и отправляет заявку владельцу через Bot API.
   Токен бота берётся ТОЛЬКО из переменной окружения BOT_TOKEN и никогда не уходит в браузер. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------- .env (простой загрузчик, переменные окружения хостинга важнее) ---------- */
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const env = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  OWNER_CHAT_ID: process.env.OWNER_CHAT_ID || '',
  PORT: Number(process.env.PORT) || 3000,
  ALLOW_BROWSER_ORDERS: process.env.ALLOW_BROWSER_ORDERS === 'true',
  INITDATA_MAX_AGE: Number(process.env.INITDATA_MAX_AGE) || 86400,
  TELEGRAM_API_BASE: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '',
  TRUST_PROXY: process.env.TRUST_PROXY !== 'false'
};

const config = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'config.json'), 'utf8'));

/* Бот (команды, меню, пересылка сообщений). Включается, если известен публичный адрес:
   на Render он есть автоматически в RENDER_EXTERNAL_URL, иначе задайте APP_URL. */
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

/* ---------- Заказы и их статусы ----------
   Храним в памяти и в data/orders.json. На бесплатном Render диск временный: после перезапуска
   файл может пропасть — поэтому список заказов клиента дублируется у него в облаке Telegram (CloudStorage),
   а о каждой смене статуса клиент получает сообщение от бота. */
const DATA_FILE = process.env.ORDERS_FILE || path.join(ROOT, 'data', 'orders.json');
const STATUSES = new Set(['sent', 'work', 'done', 'cancel']);
const orders = (function () {
  const map = new Map();
  try { for (const o of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) if (o && o.id) map.set(o.id, o); } catch { /* файла ещё нет */ }
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        const all = [...map.values()].sort((a, b) => b.at - a.at).slice(0, 5000);
        fs.writeFileSync(DATA_FILE, JSON.stringify(all));
      } catch (e) { console.error('[orders] не удалось сохранить:', e.message); }
    }, 300);
    if (timer.unref) timer.unref();
  };
  return {
    add(o) { map.set(o.id, o); save(); },
    get(id) { return map.get(id) || null; },
    setStatus(id, status, userId) {
      if (!STATUSES.has(status)) return null;
      let o = map.get(id);
      if (!o) { if (!userId) return null; o = { id, userId: Number(userId), serviceId: null, at: Date.now() }; }
      o.status = status; o.updatedAt = Date.now(); map.set(id, o); save(); return o;
    },
    ofUser(userId) { return [...map.values()].filter(o => o.userId === userId).sort((a, b) => b.at - a.at).slice(0, 25); },
    // План подписки включает владелец кнопкой «Оплачено» под заявкой: до этого момента план не активен
    setPlan(id, until) {
      const o = map.get(id);
      if (!o || !/^sub:/.test(o.serviceId || '')) return null;
      o.planUntil = until; o.updatedAt = Date.now(); map.set(id, o); save(); return o;
    },
    activePlan(userId) {
      const now = Date.now();
      const act = [...map.values()].filter(o => o.userId === userId && o.planUntil > now).sort((a, b) => b.planUntil - a.planUntil)[0];
      if (!act) return null;
      const [, planId, level] = act.serviceId.split(':');
      return { planId, level, until: act.planUntil, orderId: act.id };
    }
  };
})();

const bot = (env.BOT_TOKEN && env.OWNER_CHAT_ID && APP_URL && process.env.ENABLE_BOT !== 'false')
  ? require('./bot').createBot({ env, config, appUrl: APP_URL, orders }) : null;
const SERVICES = new Map(config.services.map(s => [s.id, s]));
const EXTRAS = new Map(config.extras.map(x => [x.id, x]));
const DEADLINES = new Set(config.deadlines);
// Подписки: тарифы и уровни анимации — из того же config.json, что и у страницы
const SUBS = config.subscriptions || { plans: [], levels: [] };
const PLANS = new Map((SUBS.plans || []).map(p => [p.id, p]));
const LEVELS = new Map((SUBS.levels || []).map(l => [l.id, l]));
function subLabel(sub) {
  const p = PLANS.get(sub.planId), l = LEVELS.get(sub.level);
  return p && l ? `Подписка ${p.label || p.title} · ${l.title}` : 'Подписка';
}
function subPrice(sub) {
  const p = PLANS.get(sub.planId);
  if (!p || !p.price) return '';
  const v = p.price[sub.level];
  return typeof v === 'number' ? v.toLocaleString('ru-RU') + ' ' + config.currency + '/' + (SUBS.period || 'мес') : 'цена по запросу';
}

/* ---------- Проверка initData по официальному алгоритму Telegram ----------
   secret_key = HMAC_SHA256(key = "WebAppData", message = bot_token)
   hash       = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
   data_check_string — все поля, кроме hash, отсортированные по ключу, в виде key=value через \n */
function verifyInitData(initData, botToken, maxAgeSec) {
  if (typeof initData !== 'string' || !initData || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  const pairs = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(pairs.map(p => p[0] + '=' + p[1]).join('\n')).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > maxAgeSec) return null;
  let user = null;
  try { user = params.get('user') ? JSON.parse(params.get('user')) : null; } catch { return null; }
  if (!user || typeof user.id !== 'number') return null;
  return { user, authDate };
}

/* ---------- Ограничение частоты: за 10 минут не больше 20 запросов с одного IP
   (у мобильных операторов один IP на многих людей) и 5 запросов от одного пользователя Telegram ---------- */
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();
function rateLimited(key, limit) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= limit) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
// Повторная отправка с тем же ключом не создаёт вторую заявку
const done = new Map(); // idempotencyKey -> { orderId, at }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k);
  for (const [k, v] of done) if (now - v.at > 24 * 3600 * 1000) done.delete(k);
}, 60 * 1000).unref();

/* ---------- Валидация ---------- */
function validUrl(v) {
  if (typeof v !== 'string' || !v || v.length > 500 || /\s/.test(v)) return false;
  try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.'); }
  catch { return false; }
}
const str = v => (typeof v === 'string' ? v.trim() : '');

function validateOrder(b, hasVerifiedUser) {
  const fields = {};
  const o = {
    serviceId: str(b.serviceId),
    sourceUrl: str(b.sourceUrl),
    exampleUrl: str(b.exampleUrl),
    description: str(b.description),
    deadline: str(b.deadline),
    contact: str(b.contact),
    extras: Array.isArray(b.extras) ? [...new Set(b.extras.filter(x => typeof x === 'string'))] : [],
    idempotencyKey: str(b.idempotencyKey),
    subscription: null
  };
  // Заявка на подписку: вместо услуги — тариф и уровень анимации
  if (b.subscription != null) {
    const sb = b.subscription;
    const planId = sb && typeof sb === 'object' ? str(sb.planId) : '', level = sb && typeof sb === 'object' ? str(sb.level) : '';
    const plan = PLANS.get(planId);
    if (!plan || !LEVELS.has(level) || !plan.price || !(typeof plan.price[level] === 'number' || plan.price[level] === null)) fields.subscription = 'Выберите тариф и уровень анимации.';
    else o.subscription = { planId, level };
    o.serviceId = '';
    if (o.extras.length) fields.extras = 'Дополнительные услуги к подписке обсуждаются отдельно.';
  } else if (!SERVICES.has(o.serviceId)) fields.serviceId = 'Выберите услугу из списка.';
  const svc = SERVICES.get(o.serviceId);
  const sourceOptional = !!(svc && svc.cat === 'dev') || b.subscription != null;   // для ботов, мини-приложений и подписок ссылка не обязательна
  if (o.sourceUrl ? !validUrl(o.sourceUrl) : !sourceOptional) fields.sourceUrl = 'Нужна корректная ссылка, начинающаяся с https://';
  if (o.exampleUrl && !validUrl(o.exampleUrl)) fields.exampleUrl = 'Нужна корректная ссылка или пустое поле.';
  if (o.description.length < 5 || o.description.length > 1000) fields.description = 'Описание: от 5 до 1000 символов.';
  if (!DEADLINES.has(o.deadline)) fields.deadline = 'Выберите срок из списка.';
  if (o.extras.length > EXTRAS.size || o.extras.some(x => !EXTRAS.has(x))) fields.extras = 'Неизвестная дополнительная услуга.';
  if (o.contact.length > 100 || (!hasVerifiedUser && o.contact.length < 2)) fields.contact = 'Укажите контакт для связи (до 100 символов).';
  if (!/^[A-Za-z0-9-]{16,64}$/.test(o.idempotencyKey)) fields.idempotencyKey = 'Некорректный ключ заявки.';
  return { o, fields };
}

/* ---------- Telegram Bot API ---------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function tgSend(chatId, text, extra) {
  const res = await fetch(`${env.TELEGRAM_API_BASE}/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(extra || {}) }),
    signal: AbortSignal.timeout(10000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error('Telegram API: ' + res.status + ' ' + (j.description || ''));
  return j;
}

function priceText(s) {
  if (s.price == null) return 'индивидуально';
  return (s.from ? 'от ' : '') + s.price.toLocaleString('ru-RU') + ' ' + config.currency;
}

function orderMessage(id, o, user) {
  const s = SERVICES.get(o.serviceId);
  let what;
  if (o.subscription) {
    const p = PLANS.get(o.subscription.planId);
    what = [`<b>Подписка:</b> ${esc(p.title)} · ${esc(LEVELS.get(o.subscription.level).title)} — ${esc(subPrice(o.subscription))}`,
      `<b>Объём:</b> ${p.videos} роликов в месяц, до ${p.maxSec} секунд каждый`];
  } else {
    what = [`<b>Услуга:</b> ${esc(s.title)} (${esc(s.duration)}) — ${esc(priceText(s))}`];
  }
  const extras = o.extras.map(x => EXTRAS.get(x).title).join(', ') || 'нет';
  let who;
  if (user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    who = `${esc(name)}${user.username ? ' (@' + esc(user.username) + ')' : ''}, <a href="tg://user?id=${user.id}">id ${user.id}</a> ✅ подтверждён Telegram`;
  } else {
    who = '⚠️ не подтверждён (отправлено из браузера)';
  }
  return [
    `🎬 <b>Новая заявка №${id}</b>${o.subscription ? ' · подписка' : ''}`,
    '',
    ...what,
    `<b>Доп. услуги:</b> ${esc(extras)}`,
    `<b>Срок:</b> ${esc(o.deadline)}`,
    `<b>Ссылка:</b> ${o.sourceUrl ? esc(o.sourceUrl) : 'не указана'}`,
    `<b>Пример:</b> ${o.exampleUrl ? esc(o.exampleUrl) : 'не указан'}`,
    '',
    `<b>Задача:</b>\n${esc(o.description)}`,
    '',
    `<b>Контакт:</b> ${o.contact ? esc(o.contact) : 'не указан'}`,
    `<b>Telegram:</b> ${who}`
  ].join('\n');
}

/* ---------- HTTP ---------- */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Без X-Frame-Options: Telegram Web открывает Mini App во фрейме
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org 'self'; base-uri 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function json(res, status, obj, extra = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  return {};
}
function clientIp(req) {
  if (env.TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('too large'), { code: 413 });
    if (Number(req.headers['content-length']) > limit) { req.resume(); return reject(tooLarge()); }
    let size = 0, over = false; const chunks = [];
    req.on('data', c => {
      if (over) return;                     // дочитываем и выбрасываем, чтобы успеть ответить 413
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(tooLarge()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function handleOrder(req, res) {
  const cors = corsHeaders(req);
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'validation_error', message: 'Ожидается JSON.' }, cors);
  if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) return json(res, 503, { ok: false, error: 'not_configured', message: 'Сервер не настроен: нет BOT_TOKEN или OWNER_CHAT_ID.' }, cors);

  const ip = clientIp(req);
  if (rateLimited('ip:' + ip, 20)) return json(res, 429, { ok: false, error: 'rate_limited' }, { ...cors, 'Retry-After': '600' });

  let body;
  try { body = JSON.parse(await readBody(req, 10 * 1024)); }
  catch (e) {
    if (e.code === 413) return json(res, 413, { ok: false, error: 'too_large' }, { ...cors, Connection: 'close' });
    return json(res, 400, { ok: false, error: 'validation_error', message: 'Некорректный JSON.' }, cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'validation_error' }, cors);

  // Подпись Telegram: без неё данные пользователя не считаем достоверными
  let verified = null;
  if (body.initData) {
    verified = verifyInitData(body.initData, env.BOT_TOKEN, env.INITDATA_MAX_AGE);
    if (!verified) return json(res, 401, { ok: false, error: 'invalid_init_data' }, cors);
  } else if (!env.ALLOW_BROWSER_ORDERS) {
    return json(res, 401, { ok: false, error: 'init_data_required' }, cors);
  }
  if (verified && rateLimited('user:' + verified.user.id, 5)) return json(res, 429, { ok: false, error: 'rate_limited' }, { ...cors, 'Retry-After': '600' });

  const { o, fields } = validateOrder(body, !!verified);
  if (Object.keys(fields).length) return json(res, 400, { ok: false, error: 'validation_error', fields }, cors);

  const idemKey = (verified ? verified.user.id : 'ip:' + ip) + ':' + o.idempotencyKey;
  const prev = done.get(idemKey);
  if (prev) return json(res, 200, { ok: true, orderId: prev.orderId, duplicate: true }, cors);

  const orderId = Date.now().toString(36).toUpperCase().slice(-5) + crypto.randomBytes(2).toString('hex').toUpperCase();
  try {
    // Кнопки статуса — только для заявок с подтверждённым Telegram-аккаунтом (есть кому сообщить)
    const extra = verified ? { reply_markup: statusKeyboard(orderId, verified.user.id, 'sent', !!o.subscription) } : undefined;
    await tgSend(env.OWNER_CHAT_ID, orderMessage(orderId, o, verified && verified.user), extra);
  } catch (e) {
    console.error('[order] не удалось отправить владельцу:', e.message.replace(env.BOT_TOKEN, '***'));
    return json(res, 502, { ok: false, error: 'telegram_error' }, cors);
  }
  done.set(idemKey, { orderId, at: Date.now() });
  const storedId = o.subscription ? `sub:${o.subscription.planId}:${o.subscription.level}` : o.serviceId;
  if (verified) orders.add({ id: orderId, userId: verified.user.id, serviceId: storedId, at: Date.now(), status: 'sent' });
  console.log(`[order] ${orderId} отправлена владельцу (${verified ? 'tg ' + verified.user.id : 'browser'})`);

  // Подтверждение клиенту — по желанию, не влияет на результат (бот может писать, только если клиент запускал бота)
  if (verified) {
    tgSend(verified.user.id, `✅ Заявка №${orderId} получена. Я отвечу вам в личных сообщениях.\n\n${o.subscription ? esc(subLabel(o.subscription)) + ' — ' + esc(subPrice(o.subscription)) : 'Услуга: ' + esc(SERVICES.get(o.serviceId).title)}`)
      .catch(() => {});
  }
  return json(res, 200, { ok: true, orderId }, cors);
}

/* Кнопки под заявкой у владельца: callback_data = st:<статус>:<номер>:<id клиента> (до 64 байт) */
function statusKeyboard(orderId, userId, current, isSub) {
  const b = (st, text) => ({ text: (current === st ? '• ' : '') + text, callback_data: `st:${st}:${orderId}:${userId}` });
  const rows = [[b('work', '🛠 В работу'), b('done', '✅ Готово')], [b('cancel', '✖ Отменить')]];
  if (isSub) rows.push([{ text: '💳 Оплачено — включить план', callback_data: `sp:on:${orderId}:${userId}` }]);
  return { inline_keyboard: rows };
}

/* Статусы заказов клиента — только по проверенной подписи Telegram */
async function handleMyOrders(req, res) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'validation_error' });
  if (!env.BOT_TOKEN) return json(res, 503, { ok: false, error: 'not_configured' });
  if (rateLimited('ip:' + clientIp(req), 60)) return json(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '600' });
  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { ok: false, error: e.code === 413 ? 'too_large' : 'validation_error' }); }
  const v = body && verifyInitData(body.initData, env.BOT_TOKEN, env.INITDATA_MAX_AGE);
  if (!v) return json(res, 401, { ok: false, error: 'invalid_init_data' });
  if (rateLimited('my:' + v.user.id, 40)) return json(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '600' });
  const list = orders.ofUser(v.user.id).map(o => ({ id: o.id, serviceId: o.serviceId, at: o.at, status: o.status }));
  const plan = orders.activePlan(v.user.id);
  return json(res, 200, { ok: true, orders: list, plan });
}

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return send(res, 400, 'Bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(file).toLowerCase();
    const cache = ext === '.html' || ext === '.json' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, configured: !!(env.BOT_TOKEN && env.OWNER_CHAT_ID), bot: !!bot });
    }
    if (bot && url.pathname === bot.WEBHOOK_PATH && req.method === 'POST') return bot.handleWebhook(req, res);
    if (url.pathname === '/api/order') {
      if (req.method === 'OPTIONS') return send(res, 204, '', corsHeaders(req));
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
      return await handleOrder(req, res);
    }
    if (url.pathname === '/api/my-orders') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
      return await handleMyOrders(req, res);
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[server]', e && e.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'server' });
  }
});

if (require.main === module) {
  server.listen(env.PORT, () => {
    console.log(`IvanovService Mini App: http://localhost:${env.PORT}`);
    if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) console.warn('⚠️  BOT_TOKEN или OWNER_CHAT_ID не заданы — приём заявок отключён (ответ 503). См. .env.example');
    if (bot) bot.setup().catch(e => console.error('[bot] настройка не удалась:', e.message));
    else console.warn('ℹ️  Бот выключен: нужен BOT_TOKEN, OWNER_CHAT_ID и публичный адрес (APP_URL или RENDER_EXTERNAL_URL)');
    if (env.ALLOW_BROWSER_ORDERS) console.warn('⚠️  ALLOW_BROWSER_ORDERS=true — принимаются заявки без подписи Telegram');
  });
}

module.exports = { server, verifyInitData, validateOrder, orders, statusKeyboard };
