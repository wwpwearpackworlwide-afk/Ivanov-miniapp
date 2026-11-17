'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeOrder } = require('./order-state');

const SCHEMA_VERSION = 2;
const REPLY_TTL_MS = 90 * 24 * 3600 * 1000;
const MAX_REPLY_LINKS = 10000;

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    orders: [], idempotency: {}, telegramUpdates: {}, outbox: {},
    runtime: { awaitingChecks: {}, replyMap: {} }
  };
}

function parseState(raw, source) {
  let value;
  try { value = JSON.parse(raw); }
  catch (e) { throw Object.assign(new Error(`Повреждён JSON-хранилище: ${source}`), { code: 'CORRUPT_STORE', cause: e }); }
  if (Array.isArray(value)) {
    const state = emptyState();
    state.orders = value;
    state.legacyImported = true;
    return state;
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.orders)) {
    throw Object.assign(new Error(`Некорректная схема хранилища: ${source}`), { code: 'CORRUPT_STORE' });
  }
  const state = { ...emptyState(), ...value };
  state.idempotency = value.idempotency && typeof value.idempotency === 'object' ? value.idempotency : {};
  state.telegramUpdates = value.telegramUpdates && typeof value.telegramUpdates === 'object' ? value.telegramUpdates : {};
  state.outbox = value.outbox && typeof value.outbox === 'object' ? value.outbox : {};
  state.runtime = value.runtime && typeof value.runtime === 'object' ? value.runtime : {};
  state.runtime.awaitingChecks = state.runtime.awaitingChecks || {};
  state.runtime.replyMap = state.runtime.replyMap || {};
  return state;
}

function atomicWrite(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
    try { const dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); fs.closeSync(dfd); } catch { /* не все ФС позволяют fsync каталога */ }
  } catch (e) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function safeError(e) { return String(e && e.message || e).replace(/(bot)?\d{5,}:[A-Za-z0-9_-]+/g, '$1***').slice(0, 500); }
function updateKey(up) {
  const id = up && up.update_id;
  const digest = crypto.createHash('sha256').update(JSON.stringify(up)).digest('hex').slice(0, 16);
  return `${id}:${digest}`;
}

function openStore({ file, legacyFile, logger = console }) {
  if (!file) throw new Error('ORDERS_FILE обязателен');
  const backupFile = file + '.bak';
  let state = emptyState();
  let recovered = false, legacyRaw = null;
  const mainExists = fs.existsSync(file);
  const backupExists = fs.existsSync(backupFile);

  if (mainExists) {
    const raw = fs.readFileSync(file, 'utf8');
    try { state = parseState(raw, file); }
    catch (mainError) {
      if (!backupExists) throw mainError; // повреждённый файл остаётся на месте для ручного восстановления
      let backupState;
      try { backupState = parseState(fs.readFileSync(backupFile, 'utf8'), backupFile); }
      catch { throw mainError; }
      const quarantine = `${file}.corrupted-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, quarantine);
      fs.chmodSync(quarantine, 0o600);
      state = backupState;
      recovered = true;
      logger.warn(`[store] основной файл повреждён; восстановлен backup. Копия: ${path.basename(quarantine)}`);
    }
  } else if (backupExists) {
    state = parseState(fs.readFileSync(backupFile, 'utf8'), backupFile);
    recovered = true;
    logger.warn('[store] основной файл отсутствует; восстановлен backup');
  } else {
    const abandoned = fs.existsSync(path.dirname(file))
      ? fs.readdirSync(path.dirname(file)).some(n => n.startsWith(path.basename(file) + '.corrupted-')) : false;
    if (abandoned) throw Object.assign(new Error('Найден повреждённый файл без основного хранилища; пустая база не создана'), { code: 'CORRUPT_STORE' });
    if (legacyFile && fs.existsSync(legacyFile)) {
      legacyRaw = fs.readFileSync(legacyFile, 'utf8');
      state = parseState(legacyRaw, legacyFile);
      logger.warn('[store] legacy orders.json импортирован в отдельный runtime-файл; источник не изменён');
    }
  }

  const map = new Map();
  for (const value of state.orders) {
    if (!value || !value.id || !Number.isSafeInteger(Number(value.userId))) continue;
    const o = normalizeOrder({ ...value, legacyImported: !!state.legacyImported });
    map.set(String(o.id), o);
  }
  const awaitingChecks = new Map(Object.entries(state.runtime.awaitingChecks));
  const replyMap = new Map(Object.entries(state.runtime.replyMap));
  const processing = new Set();
  let writeSequence = 0;

  function snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      writeSequence: ++writeSequence,
      orders: [...map.values()],
      idempotency: state.idempotency,
      telegramUpdates: state.telegramUpdates,
      outbox: state.outbox,
      runtime: {
        awaitingChecks: Object.fromEntries(awaitingChecks),
        replyMap: Object.fromEntries(replyMap)
      }
    };
  }
  function persist() {
    const serialized = JSON.stringify(snapshot());
    if (fs.existsSync(file)) {
      const previous = fs.readFileSync(file, 'utf8');
      parseState(previous, file); // никогда не заменяем нечитаемый основной файл молча
      atomicWrite(backupFile, previous);
    }
    atomicWrite(file, serialized);
  }
  if (recovered) atomicWrite(file, JSON.stringify(snapshot())); // не делаем backup из уже повреждённого main
  if (legacyRaw != null) {
    atomicWrite(backupFile, legacyRaw); // резервная копия ДО первой записи новой схемы
    atomicWrite(file, JSON.stringify(snapshot()));
  }

  function add(o) {
    const id = String(o && o.id || '');
    if (!id || map.has(id)) throw Object.assign(new Error('Заказ уже существует или имеет пустой номер'), { code: 'DUPLICATE_ORDER' });
    const value = normalizeOrder({ ...o });
    map.set(id, value);
    try { persist(); } catch (e) { map.delete(id); throw e; }
    return value;
  }
  function addWithIdempotency(o, key) {
    const existing = state.idempotency[key];
    if (existing) return { order: map.get(String(existing.orderId)), duplicate: true };
    const value = normalizeOrder({ ...o });
    const id = String(value.id || '');
    if (!id || map.has(id)) throw Object.assign(new Error('Заказ уже существует или имеет пустой номер'), { code: 'DUPLICATE_ORDER' });
    const old = state.idempotency[key];
    map.set(id, value); state.idempotency[key] = { orderId: id, at: Date.now() };
    try { persist(); } catch (e) {
      map.delete(id); if (old) state.idempotency[key] = old; else delete state.idempotency[key]; throw e;
    }
    return { order: value, duplicate: false };
  }
  function update(id, mutator) {
    const key = String(id);
    const previous = map.get(key);
    if (!previous) return null;
    const draft = normalizeOrder(JSON.parse(JSON.stringify(previous)));
    const result = mutator(draft) || draft;
    const value = normalizeOrder(result);
    map.set(key, value);
    try { persist(); } catch (e) { map.set(key, previous); throw e; }
    return value;
  }
  function updateWithOutbox(id, mutator, messages) {
    const key = String(id);
    const previous = map.get(key);
    if (!previous) return null;
    const oldOutbox = state.outbox;
    const draft = normalizeOrder(JSON.parse(JSON.stringify(previous)));
    const value = normalizeOrder(mutator(draft) || draft);
    const nextOutbox = { ...oldOutbox };
    for (const message of messages || []) {
      if (!message || !message.idempotencyKey || nextOutbox[message.idempotencyKey]) continue;
      nextOutbox[message.idempotencyKey] = {
        id: message.idempotencyKey, method: message.method || 'sendMessage', payload: message.payload,
        status: 'pending', attempts: 0, createdAt: new Date().toISOString(), nextAttemptAt: 0
      };
    }
    map.set(key, value); state.outbox = nextOutbox;
    try { persist(); } catch (e) { map.set(key, previous); state.outbox = oldOutbox; throw e; }
    return value;
  }
  function setStatus(id, status, userId) {
    const states = { sent: 'pending_payment', work: 'in_progress', done: 'completed', cancel: 'cancelled' };
    if (!states[status]) return null;
    let o = map.get(String(id));
    if (!o) {
      if (!userId) return null;
      o = add({ id: String(id), userId: Number(userId), serviceId: null, at: Date.now(), state: 'pending_payment' });
    }
    const before = o.state;
    return update(id, draft => {
      const meta = { actor: { type: 'owner', id: 'legacy_status' }, reason: `legacy status: ${status}` };
      if (status === 'work') require('./order-state').transitionWork(draft, 'in_progress', meta);
      else if (status === 'done') require('./order-state').transitionWork(draft, 'completed', meta);
      else if (status === 'cancel') require('./order-state').transitionWork(draft, 'cancelled', meta);
      else require('./order-state').transitionPayment(draft, 'pending_payment', meta);
      if (before === draft.state && status === 'work') require('./order-state').transitionWork(draft, 'in_progress', meta);
      return draft;
    });
  }
  function setPay(id, pay, amount) {
    const states = { wait: 'pending_payment', check: 'payment_review', paid: 'paid' };
    if (!states[pay]) return null;
    return update(id, draft => {
      if (amount != null) draft.amount = Number(amount);
      if (draft.state !== states[pay]) require('./order-state').transitionPayment(draft, states[pay], { actor: { type: 'owner', id: 'legacy_pay' }, reason: `legacy pay: ${pay}` });
      return draft;
    });
  }
  function getIdempotency(key) { return state.idempotency[key] || null; }
  function setIdempotency(key, orderId) {
    const old = state.idempotency[key];
    state.idempotency[key] = { orderId, at: old ? old.at : Date.now() };
    try { persist(); } catch (e) { if (old) state.idempotency[key] = old; else delete state.idempotency[key]; throw e; }
  }
  function enqueueTelegramUpdate(up) {
    if (!up || !Number.isSafeInteger(up.update_id)) throw Object.assign(new Error('update_id обязателен'), { code: 'INVALID_UPDATE' });
    const key = updateKey(up);
    if (state.telegramUpdates[key]) return { key, duplicate: true };
    state.telegramUpdates[key] = {
      key, updateId: up.update_id, update: up, status: 'pending', attempts: 0,
      receivedAt: new Date().toISOString(), nextAttemptAt: 0
    };
    try { persist(); } catch (e) { delete state.telegramUpdates[key]; throw e; }
    return { key, duplicate: false };
  }
  function dueTelegramUpdates() {
    const now = Date.now();
    return Object.values(state.telegramUpdates)
      .filter(r => (r.status === 'pending' || r.status === 'processing') && !processing.has(r.key) && Number(r.nextAttemptAt || 0) <= now)
      .sort((a, b) => a.updateId - b.updateId);
  }
  function markUpdateProcessing(key) {
    const r = state.telegramUpdates[key]; if (!r) return null;
    r.status = 'processing'; r.attempts = Number(r.attempts || 0) + 1; r.startedAt = new Date().toISOString();
    processing.add(key);
    try { persist(); } catch (e) { processing.delete(key); throw e; }
    return r;
  }
  function markUpdateDone(key) {
    const r = state.telegramUpdates[key]; processing.delete(key); if (!r) return;
    const done = { key, updateId: r.updateId, status: 'done', attempts: r.attempts, receivedAt: r.receivedAt, processedAt: new Date().toISOString() };
    state.telegramUpdates[key] = done; persist();
  }
  function markUpdateFailed(key, error) {
    const r = state.telegramUpdates[key]; processing.delete(key); if (!r) return;
    r.status = 'pending'; r.lastError = safeError(error); r.failedAt = new Date().toISOString();
    r.nextAttemptAt = Date.now() + Math.min(30000, 500 * Math.pow(2, Math.min(r.attempts, 6)));
    persist();
  }
  function releaseUpdate(key) { processing.delete(key); }
  function enqueueOutbox(message) {
    if (!message || !message.idempotencyKey) throw new Error('outbox idempotencyKey обязателен');
    if (state.outbox[message.idempotencyKey]) return state.outbox[message.idempotencyKey];
    const old = state.outbox[message.idempotencyKey];
    state.outbox[message.idempotencyKey] = {
      id: message.idempotencyKey, method: message.method || 'sendMessage', payload: message.payload,
      status: 'pending', attempts: 0, createdAt: new Date().toISOString(), nextAttemptAt: 0
    };
    try { persist(); } catch (e) { if (old) state.outbox[message.idempotencyKey] = old; else delete state.outbox[message.idempotencyKey]; throw e; }
    return state.outbox[message.idempotencyKey];
  }
  function dueOutbox() {
    const now = Date.now();
    return Object.values(state.outbox).filter(r => r.status === 'pending' && Number(r.nextAttemptAt || 0) <= now);
  }
  function markOutboxSent(id) {
    const r = state.outbox[id]; if (!r || r.status === 'sent') return;
    r.status = 'sent'; r.sentAt = new Date().toISOString(); delete r.payload; persist();
  }
  function markOutboxFailed(id, error) {
    const r = state.outbox[id]; if (!r) return;
    r.attempts = Number(r.attempts || 0) + 1; r.lastError = safeError(error);
    r.nextAttemptAt = Date.now() + Math.min(60000, 1000 * Math.pow(2, Math.min(r.attempts, 6)));
    persist();
  }

  const api = {
    file, backupFile, persist, add, addWithIdempotency, update, updateWithOutbox,
    get: id => map.get(String(id)) || null,
    has: id => map.has(String(id)),
    setStatus, setPay,
    ofUser(userId) { return [...map.values()].filter(o => o.userId === Number(userId)).sort((a, b) => b.at - a.at); },
    setPlan(id, until) { return update(id, o => { if (!/^sub:/.test(o.serviceId || '')) return o; o.planUntil = until; o.updatedAt = new Date().toISOString(); return o; }); },
    activePlan(userId) {
      const now = Date.now();
      const act = [...map.values()].filter(o => o.userId === Number(userId) && o.planUntil > now).sort((a, b) => b.planUntil - a.planUntil)[0];
      if (!act) return null;
      const [, planId, level] = act.serviceId.split(':');
      return { planId, level, until: act.planUntil, orderId: act.id };
    },
    getIdempotency, setIdempotency,
    getAwaitingCheck(userId) {
      const value = awaitingChecks.get(String(userId));
      if (!value) return null;
      const o = map.get(String(value.orderId));
      if (!o || o.userId !== Number(userId) || ['paid', 'in_progress', 'completed', 'cancelled'].includes(o.state)) {
        awaitingChecks.delete(String(userId)); return null;
      }
      return value;
    },
    setAwaitingCheck(userId, orderId) {
      const old = awaitingChecks.get(String(userId));
      awaitingChecks.set(String(userId), { orderId: String(orderId), at: Date.now() });
      try { persist(); } catch (e) { if (old) awaitingChecks.set(String(userId), old); else awaitingChecks.delete(String(userId)); throw e; }
    },
    clearAwaitingCheck(userId) {
      if (!awaitingChecks.has(String(userId))) return;
      const old = awaitingChecks.get(String(userId)); awaitingChecks.delete(String(userId));
      try { persist(); } catch (e) { awaitingChecks.set(String(userId), old); throw e; }
    },
    getReplyTarget(messageId) {
      const value = replyMap.get(String(messageId));
      if (!value) return null;
      if (Date.now() - value.at > REPLY_TTL_MS) { replyMap.delete(String(messageId)); return null; }
      return value.userId;
    },
    setReplyTarget(messageId, userId) {
      replyMap.set(String(messageId), { userId: Number(userId), at: Date.now() });
      const now = Date.now();
      for (const [key, value] of replyMap) if (now - value.at > REPLY_TTL_MS) replyMap.delete(key);
      while (replyMap.size > MAX_REPLY_LINKS) replyMap.delete(replyMap.keys().next().value);
      persist();
    },
    enqueueTelegramUpdate, dueTelegramUpdates, markUpdateProcessing, markUpdateDone, markUpdateFailed, releaseUpdate,
    enqueueOutbox, dueOutbox, markOutboxSent, markOutboxFailed,
    enqueueOwnerMessage(payload, key) { return enqueueOutbox({ idempotencyKey: key, method: 'sendMessage', payload }); },
    getTelegramRecord(key) { return state.telegramUpdates[key] || null; },
    getOutboxRecord(key) { return state.outbox[key] || null; },
    _map: map
  };
  return api;
}

module.exports = { openStore, parseState, atomicWrite, emptyState, SCHEMA_VERSION };
