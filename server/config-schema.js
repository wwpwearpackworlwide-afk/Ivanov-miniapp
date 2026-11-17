'use strict';

const fs = require('fs');

function fail(errors) {
  if (errors.length) throw Object.assign(new Error('Ошибка конфигурации:\n- ' + errors.join('\n- ')), { code: 'INVALID_CONFIG', errors });
}
function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }
function price(v) { return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0); }
function uniqueIds(items, label, errors) {
  const seen = new Set();
  items.forEach((item, i) => {
    if (!object(item) || !nonEmpty(item.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id)) errors.push(`${label}[${i}].id`);
    else if (seen.has(item.id)) errors.push(`${label}: повторяющийся id ${item.id}`);
    else seen.add(item.id);
  });
}

function validateConfig(config) {
  const errors = [];
  if (!object(config)) fail(['config должен быть объектом']);
  if (!object(config.brand)) errors.push('brand обязателен');
  else for (const key of ['name', 'ownerTelegram', 'instagram']) if (!nonEmpty(config.brand[key])) errors.push(`brand.${key}`);
  if (!nonEmpty(config.currency)) errors.push('currency');
  if (!Array.isArray(config.services) || !config.services.length) errors.push('services должен быть непустым массивом');
  else {
    uniqueIds(config.services, 'services', errors);
    config.services.forEach((s, i) => {
      if (!object(s)) return;
      if (!nonEmpty(s.title)) errors.push(`services[${i}].title`);
      if (!price(s.price)) errors.push(`services[${i}].price`);
      if (s.from !== undefined && typeof s.from !== 'boolean') errors.push(`services[${i}].from`);
    });
  }
  if (!Array.isArray(config.extras)) errors.push('extras должен быть массивом');
  else uniqueIds(config.extras, 'extras', errors);
  if (!Array.isArray(config.deadlines) || !config.deadlines.length || config.deadlines.some(x => !nonEmpty(x))) errors.push('deadlines');
  if (!object(config.subscriptions)) errors.push('subscriptions');
  else {
    const sub = config.subscriptions;
    if (!Array.isArray(sub.plans) || !Array.isArray(sub.levels)) errors.push('subscriptions.plans/levels');
    else {
      uniqueIds(sub.plans, 'subscriptions.plans', errors); uniqueIds(sub.levels, 'subscriptions.levels', errors);
      const levels = new Set(sub.levels.map(x => x && x.id));
      sub.plans.forEach((p, i) => {
        if (!object(p) || !object(p.price)) { errors.push(`subscriptions.plans[${i}].price`); return; }
        for (const level of levels) if (!(level in p.price) || !price(p.price[level])) errors.push(`subscriptions.plans[${i}].price.${level}`);
      });
    }
  }
  if (!object(config.bot)) errors.push('bot');
  fail(errors);
  return config;
}

function loadConfig(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw Object.assign(new Error(`Не удалось прочитать ${file}: ${e.message}`), { code: 'INVALID_CONFIG' }); }
  return validateConfig(parsed);
}

function booleanEnv(value, name, defaultValue, errors) {
  if (value == null || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  errors.push(`${name} должен быть true или false`); return defaultValue;
}
function integerEnv(value, name, defaultValue, min, max, errors) {
  if (value == null || value === '') return defaultValue;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) { errors.push(`${name}: целое число ${min}…${max}`); return defaultValue; }
  return n;
}
function validateEnv(raw) {
  const errors = [];
  const env = {
    BOT_TOKEN: String(raw.BOT_TOKEN || '').trim(),
    OWNER_CHAT_ID: String(raw.OWNER_CHAT_ID || '').trim(),
    WEBHOOK_SECRET: String(raw.WEBHOOK_SECRET || '').trim(),
    PAY_DETAILS: String(raw.PAY_DETAILS || '').replace(/\\n/g, '\n').trim(),
    PORT: integerEnv(raw.PORT, 'PORT', 3000, 1, 65535, errors),
    ALLOW_BROWSER_ORDERS: booleanEnv(raw.ALLOW_BROWSER_ORDERS, 'ALLOW_BROWSER_ORDERS', false, errors),
    ENABLE_BOT: booleanEnv(raw.ENABLE_BOT, 'ENABLE_BOT', true, errors),
    INITDATA_MAX_AGE: integerEnv(raw.INITDATA_MAX_AGE, 'INITDATA_MAX_AGE', 86400, 60, 604800, errors),
    MAX_RECEIPT_BYTES: integerEnv(raw.MAX_RECEIPT_BYTES, 'MAX_RECEIPT_BYTES', 10 * 1024 * 1024, 1024, 20 * 1024 * 1024, errors),
    TELEGRAM_API_BASE: String(raw.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
    ALLOWED_ORIGIN: String(raw.ALLOWED_ORIGIN || '').trim(),
    TRUST_PROXY: booleanEnv(raw.TRUST_PROXY, 'TRUST_PROXY', false, errors)
  };
  if (env.BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]{10,}$/.test(env.BOT_TOKEN)) errors.push('BOT_TOKEN имеет некорректный формат');
  if (env.OWNER_CHAT_ID && !/^-?\d{1,20}$/.test(env.OWNER_CHAT_ID)) errors.push('OWNER_CHAT_ID должен быть числовым ID');
  if (env.WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{1,256}$/.test(env.WEBHOOK_SECRET)) errors.push('WEBHOOK_SECRET: 1–256 символов A-Z/a-z/0-9/_/-');
  if (env.PAY_DETAILS.length > 2000) errors.push('PAY_DETAILS слишком длинный');
  try { const u = new URL(env.TELEGRAM_API_BASE); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); }
  catch { errors.push('TELEGRAM_API_BASE должен быть HTTP(S) URL'); }
  if (env.ALLOWED_ORIGIN) { try { new URL(env.ALLOWED_ORIGIN); } catch { errors.push('ALLOWED_ORIGIN должен быть URL'); } }
  fail(errors);
  return env;
}

module.exports = { validateConfig, loadConfig, validateEnv };
