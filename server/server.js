'use strict';
/* IvanovService Mini App — модульный Node.js backend без внешних runtime-зависимостей.
   Node.js 24 LTS рекомендован; заявки проверяются по Telegram initData, сумма рассчитывается
   только на сервере, финансовые события и Telegram inbox сохраняются до ACK. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openStore } = require('./store');
const { loadConfig, validateEnv } = require('./config-schema');
const { publicOrder, normalizeOrder } = require('./order-state');

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

const env = validateEnv(process.env);
const config = loadConfig(path.join(PUBLIC_DIR, 'config.json'));

/* Бот (команды, меню, пересылка сообщений). Включается, если известен публичный адрес:
   на Render он есть автоматически в RENDER_EXTERNAL_URL, иначе задайте APP_URL. */
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

/* ---------- Версионированное JSON-хранилище ----------
   Запись atomic (temp + fsync + rename), предыдущая валидная копия — в .bak.
   Старый массив orders.json импортируется без удаления записей. Один активный инстанс. */
const LEGACY_DATA_FILE = path.join(ROOT, 'data', 'orders.json');
const DATA_FILE = process.env.ORDERS_FILE || path.join(ROOT, 'data', 'runtime', 'orders.json');
const orders = openStore({ file: DATA_FILE, legacyFile: process.env.ORDERS_FILE ? null : LEGACY_DATA_FILE });

const bot = (env.BOT_TOKEN && env.OWNER_CHAT_ID && APP_URL && env.ENABLE_BOT)
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

/* Сумма к оплате: только для фиксированной цены (без «от» и без доп. услуг) — иначе сумму называет Иван (/pay) */
function orderAmount(o) {
  if (o.subscription) { const p = PLANS.get(o.subscription.planId); const v = p && p.price && p.price[o.subscription.level]; return typeof v === 'number' ? v : null; }
  const s = SERVICES.get(o.serviceId);
  return s && !s.from && typeof s.price === 'number' && !o.extras.length ? s.price : null;
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
  if (!hits.has(key) && hits.size >= 10000) {
    for (const [k, values] of hits) if (!values.some(t => now - t < WINDOW_MS)) hits.delete(k);
    if (hits.size >= 10000) return true; // fail closed, без неограниченного роста Map
  }
  if (arr.length >= limit) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k);
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
  const extras = o.extras.map(x => (typeof x === 'string' ? EXTRAS.get(x).title : x.title)).join(', ') || 'нет';
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

function makeOrderId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = Date.now().toString(36).toUpperCase().slice(-5) + crypto.randomBytes(3).toString('hex').toUpperCase();
    if (!orders.has(id)) return id;
  }
  throw new Error('Не удалось выделить уникальный номер заказа');
}

function snapshotOrder(id, o, user, amount) {
  const at = Date.now();
  const service = SERVICES.get(o.serviceId);
  let serviceSnapshot, item;
  if (o.subscription) {
    const plan = PLANS.get(o.subscription.planId), level = LEVELS.get(o.subscription.level);
    serviceSnapshot = {
      type: 'subscription', planId: plan.id, level: level.id,
      title: subLabel(o.subscription), videos: plan.videos, maxSec: plan.maxSec,
      unitPrice: amount, currency: config.currency, period: SUBS.period || 'мес'
    };
    item = {
      type: 'subscription', refId: `${plan.id}:${level.id}`, title: serviceSnapshot.title,
      parameters: { level: level.title, videos: plan.videos, maxSec: plan.maxSec, deadline: o.deadline },
      quantity: 1, unitPrice: amount, totalPrice: amount
    };
  } else {
    serviceSnapshot = {
      type: 'service', serviceId: service.id, title: service.title, duration: service.duration,
      listPrice: service.price, from: !!service.from, currency: config.currency
    };
    item = {
      type: 'service', refId: service.id, title: service.title,
      parameters: { duration: service.duration, deadline: o.deadline, sourceUrl: o.sourceUrl, exampleUrl: o.exampleUrl },
      quantity: 1, unitPrice: service.price, totalPrice: amount
    };
  }
  const extras = o.extras.map(extraId => {
    const x = EXTRAS.get(extraId);
    return { id: x.id, title: x.title, price: x.price == null ? null : x.price, currency: config.currency };
  });
  const items = [item, ...extras.map(x => ({ type: 'extra', refId: x.id, title: x.title, parameters: {}, quantity: 1, unitPrice: x.price, totalPrice: null }))];
  return normalizeOrder({
    id, userId: user.id, serviceId: o.subscription ? `sub:${o.subscription.planId}:${o.subscription.level}` : o.serviceId,
    at, createdAt: new Date(at).toISOString(), state: 'pending_payment', amount: amount == null ? null : amount,
    serviceIdOriginal: o.serviceId || null, subscription: o.subscription,
    sourceUrl: o.sourceUrl, exampleUrl: o.exampleUrl, description: o.description,
    deadline: o.deadline, contact: o.contact, extras,
    serviceSnapshot, items,
    pricing: { currency: config.currency, total: amount, calculatedAt: new Date(at).toISOString(), source: 'server-config-snapshot' },
    telegramUser: { id: user.id, first_name: user.first_name || '', last_name: user.last_name || '', username: user.username || '' }
  });
}

async function notifyOwnerAboutOrder(order) {
  const extra = { reply_markup: statusKeyboard(order.id, order.userId, 'sent', !!order.subscription, order.amount && env.PAY_DETAILS ? 'wait' : null) };
  await tgSend(env.OWNER_CHAT_ID, orderMessage(order.id, order, order.telegramUser), extra);
  orders.update(order.id, draft => { draft.ownerNotifiedAt = new Date().toISOString(); return draft; });
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
  const previous = orders.getIdempotency(idemKey);
  if (previous) {
    const existing = orders.get(previous.orderId);
    if (existing && verified && !existing.ownerNotifiedAt) {
      try { await notifyOwnerAboutOrder(existing); }
      catch { return json(res, 502, { ok: false, error: 'telegram_error', orderId: existing.id }, cors); }
    }
    return json(res, 200, { ok: true, orderId: previous.orderId, duplicate: true }, cors);
  }

  // Браузерные заявки без подписанного пользователя сохраняют прежнее поведение,
  // но не попадают в финансовый workflow Telegram-клиента.
  if (!verified) {
    const orderId = makeOrderId();
    try { await tgSend(env.OWNER_CHAT_ID, orderMessage(orderId, o, null)); }
    catch (e) {
      console.error('[order] не удалось отправить владельцу:', e.message.replace(env.BOT_TOKEN, '***'));
      return json(res, 502, { ok: false, error: 'telegram_error' }, cors);
    }
    return json(res, 200, { ok: true, orderId }, cors);
  }

  const orderId = makeOrderId();
  const amount = orderAmount(o);
  const stored = snapshotOrder(orderId, o, verified.user, amount);
  try {
    orders.addWithIdempotency(stored, idemKey); // заказ и ключ сохраняются одной атомарной записью
    await notifyOwnerAboutOrder(stored);
  } catch (e) {
    console.error('[order] сохранение/уведомление:', e.message.replace(env.BOT_TOKEN, '***'));
    if (orders.get(orderId)) return json(res, 502, { ok: false, error: 'telegram_error', orderId }, cors);
    return json(res, 500, { ok: false, error: 'storage_error' }, cors);
  }
  console.log(`[order] ${orderId} сохранён и отправлен владельцу (tg ${verified.user.id})`);

  if (amount && bot) {
    bot.requestPayment(orderId, verified.user.id, amount, o.subscription ? subLabel(o.subscription) : SERVICES.get(o.serviceId).title).catch(() => {});
  } else {
    tgSend(verified.user.id, `✅ Заявка №${orderId} получена. Я отвечу вам в личных сообщениях.\n\n${o.subscription ? esc(subLabel(o.subscription)) + ' — ' + esc(subPrice(o.subscription)) : 'Услуга: ' + esc(SERVICES.get(o.serviceId).title)}`)
      .catch(() => {});
  }
  return json(res, 200, { ok: true, orderId }, cors);
}

/* Кнопки под заявкой у владельца: callback_data = st:<статус>:<номер>:<id клиента> (до 64 байт) */
function statusKeyboard(orderId, userId, current, isSub, pay) {
  const b = (st, text) => ({ text: (current === st ? '• ' : '') + text, callback_data: `st:${st}:${orderId}:${userId}` });
  const rows = [[b('work', '🛠 В работу'), b('done', '✅ Готово')], [b('cancel', '✖ Отменить')]];
  if (pay && pay !== 'paid') rows.push([{ text: '💳 Оплата пришла', callback_data: `pay:ok:${orderId}:${userId}` }]);
  else if (isSub) rows.push([{ text: '💳 Оплачено — включить план', callback_data: `sp:on:${orderId}:${userId}` }]);
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
  const list = orders.ofUser(v.user.id).map(publicOrder);
  const plan = orders.activePlan(v.user.id);
  return json(res, 200, { ok: true, orders: list, plan });
}

async function handleReceipt(req, res) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'validation_error' });
  if (!env.BOT_TOKEN) return json(res, 503, { ok: false, error: 'not_configured' });
  if (rateLimited('receipt-ip:' + clientIp(req), 60)) return json(res, 429, { ok: false, error: 'rate_limited' });
  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch (e) { return json(res, e.code === 413 ? 413 : 400, { ok: false, error: 'validation_error' }); }
  const v = body && verifyInitData(body.initData, env.BOT_TOKEN, env.INITDATA_MAX_AGE);
  if (!v) return json(res, 401, { ok: false, error: 'invalid_init_data' });
  const order = orders.get(String(body.orderId || '').toUpperCase());
  if (!order) return json(res, 404, { ok: false, error: 'not_found' });
  const isOwner = String(v.user.id) === String(env.OWNER_CHAT_ID);
  if (!isOwner && order.userId !== v.user.id) return json(res, 403, { ok: false, error: 'forbidden' });
  const receipt = order.paymentAttempts.find(r => r.id === String(body.receiptId || ''));
  if (!receipt) return json(res, 404, { ok: false, error: 'receipt_not_found' });
  return json(res, 200, { ok: true, orderId: order.id, receipt: {
    id: receipt.id, kind: receipt.kind, mimeType: receipt.mimeType || null,
    fileId: receipt.fileId, fileUniqueId: receipt.fileUniqueId || null,
    size: receipt.size || null, submittedAt: receipt.submittedAt, status: receipt.status || 'submitted'
  } });
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
    if (url.pathname === '/api/receipt') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
      return await handleReceipt(req, res);
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

module.exports = { server, verifyInitData, validateOrder, orders, statusKeyboard, snapshotOrder, orderAmount };
