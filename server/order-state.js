'use strict';

/**
 * Контролируемые состояния заказа. Старые поля status/pay остаются только
 * проекцией для Mini App и интеграций первой версии.
 */
const PAYMENT_STATES = new Set([
  'pending_payment', 'payment_submitted', 'payment_review', 'payment_rejected',
  'paid', 'in_progress', 'completed', 'cancelled'
]);
const WORK_STATES = new Set(['not_started', 'in_progress', 'completed', 'cancelled']);
const LEGACY_STATUS = {
  pending_payment: 'sent', payment_submitted: 'sent', payment_review: 'sent',
  payment_rejected: 'sent', paid: 'sent', in_progress: 'work', completed: 'done', cancelled: 'cancel'
};
const LEGACY_PAY = {
  pending_payment: 'wait', payment_submitted: 'wait', payment_review: 'check',
  payment_rejected: 'wait', paid: 'paid', in_progress: 'paid', completed: 'paid', cancelled: null
};
const PAYMENT_TRANSITIONS = {
  pending_payment: new Set(['payment_submitted', 'payment_review', 'payment_rejected', 'paid', 'cancelled']),
  payment_submitted: new Set(['payment_review', 'payment_rejected', 'paid', 'pending_payment', 'cancelled']),
  payment_review: new Set(['paid', 'payment_rejected', 'pending_payment', 'cancelled']),
  payment_rejected: new Set(['payment_submitted', 'payment_review', 'paid', 'pending_payment', 'cancelled']),
  paid: new Set(['in_progress', 'completed', 'cancelled']),
  in_progress: new Set(['completed', 'cancelled']),
  completed: new Set([]),
  cancelled: new Set([])
};

function nowIso() { return new Date().toISOString(); }
function actorOf(meta) {
  const actor = meta && meta.actor ? meta.actor : { type: 'system', id: 'system' };
  return { type: String(actor.type || 'system'), id: String(actor.id || 'system') };
}
function append(list, event) { list.push(event); return event; }

function syncLegacy(o) {
  const state = o.state || o.paymentStatus || 'pending_payment';
  const workState = state === 'in_progress' || state === 'completed';
  o.paymentStatus = workState && (o.paidAt || o.paymentStatus === 'paid' || o.pay === 'paid') ? 'paid' : state;
  o.status = LEGACY_STATUS[state] || 'sent';
  o.pay = state === 'cancelled' && o.paidAt ? 'paid' : (LEGACY_PAY[o.paymentStatus] === undefined ? null : LEGACY_PAY[o.paymentStatus]);
  if (state === 'in_progress') o.workStatus = 'in_progress';
  else if (state === 'completed') o.workStatus = 'completed';
  else if (state === 'cancelled') o.workStatus = 'cancelled';
  else if (!o.workStatus) o.workStatus = 'not_started';
  return o;
}

function normalizeOrder(input) {
  const o = input && typeof input === 'object' ? input : {};
  o.userId = Number(o.userId);
  o.at = Number(o.at) || Date.now();
  o.createdAt = o.createdAt || new Date(o.at).toISOString();
  o.updatedAt = o.updatedAt || o.createdAt;
  o.paymentHistory = Array.isArray(o.paymentHistory) ? o.paymentHistory : [];
  o.paymentAttempts = Array.isArray(o.paymentAttempts) ? o.paymentAttempts : [];
  o.statusEvents = Array.isArray(o.statusEvents) ? o.statusEvents : [];
  o.auditLog = Array.isArray(o.auditLog) ? o.auditLog : [];
  o.items = Array.isArray(o.items) ? o.items : [];
  if (!PAYMENT_STATES.has(o.state)) {
    if (o.status === 'work') o.state = 'in_progress';
    else if (o.status === 'done') o.state = 'completed';
    else if (o.status === 'cancel') o.state = 'cancelled';
    else if (o.pay === 'check') o.state = 'payment_review';
    else if (o.pay === 'paid') o.state = 'paid';
    else o.state = 'pending_payment';
  }
  if (!o.paymentHistory.length) {
    o.paymentHistory.push({
      from: null, to: o.state, at: o.createdAt,
      actor: { type: 'system', id: 'legacy_import' },
      reason: o.legacyImported ? 'Импортировано из orders.json первой версии' : 'Заказ создан'
    });
  }
  if (!o.statusEvents.length) {
    o.statusEvents.push({ to: o.workStatus || LEGACY_STATUS[o.state], at: o.createdAt, actor: { type: 'system', id: 'legacy_import' } });
  }
  return syncLegacy(o);
}

function transitionPayment(input, to, meta = {}) {
  const o = normalizeOrder(input);
  const from = o.state;
  if (!PAYMENT_STATES.has(to)) throw Object.assign(new Error('Неизвестный статус оплаты'), { code: 'INVALID_PAYMENT_STATE' });
  if (from === to) return { order: o, changed: false };
  if (!PAYMENT_TRANSITIONS[from] || !PAYMENT_TRANSITIONS[from].has(to)) {
    throw Object.assign(new Error(`Недопустимый переход ${from} → ${to}`), { code: 'INVALID_PAYMENT_TRANSITION' });
  }
  const at = meta.at || nowIso();
  const actor = actorOf(meta);
  const reason = String(meta.reason || 'Без причины').slice(0, 500);
  o.state = to;
  o.updatedAt = at;
  if (to === 'paid' && !o.paidAt) o.paidAt = at;
  append(o.paymentHistory, { from, to, at, actor, reason, ...(meta.receiptId ? { receiptId: meta.receiptId } : {}) });
  append(o.auditLog, { at, actor, action: meta.action || `payment.${to}`, reason, ...(meta.receiptId ? { receiptId: meta.receiptId } : {}) });
  syncLegacy(o);
  return { order: o, changed: true };
}

function transitionWork(input, to, meta = {}) {
  const o = normalizeOrder(input);
  if (!WORK_STATES.has(to)) throw Object.assign(new Error('Неизвестный статус выполнения'), { code: 'INVALID_WORK_STATE' });
  if (o.workStatus === to && o.state === to) return { order: o, changed: false };
  const at = meta.at || nowIso();
  const actor = actorOf(meta);
  const from = o.workStatus || 'not_started';
  const reason = String(meta.reason || 'Изменён владельцем').slice(0, 500);
  o.workStatus = to;
  o.state = to;
  o.updatedAt = at;
  append(o.statusEvents, { from, to, at, actor, reason });
  append(o.auditLog, { at, actor, action: `work.${to}`, reason });
  syncLegacy(o);
  return { order: o, changed: true };
}

function publicOrder(input) {
  const o = normalizeOrder(input);
  return {
    id: o.id, serviceId: o.serviceId, at: o.at, createdAt: o.createdAt,
    status: o.status, pay: o.pay || null, amount: o.amount == null ? null : o.amount,
    state: o.state, paymentStatus: o.paymentStatus, workStatus: o.workStatus,
    paymentConfirmedAt: o.paidAt || null,
    serviceSnapshot: o.serviceSnapshot || null, items: o.items || [],
    description: o.description || '', deadline: o.deadline || '',
    extras: o.extras || [], currency: (o.pricing && o.pricing.currency) || 'RUB',
    paymentHistory: o.paymentHistory.map(e => ({ from: e.from, to: e.to, at: e.at, reason: e.reason })),
    paymentAttempts: o.paymentAttempts.map(r => ({ id: r.id, submittedAt: r.submittedAt, status: r.status || 'submitted' }))
  };
}

module.exports = {
  PAYMENT_STATES, WORK_STATES, PAYMENT_TRANSITIONS,
  normalizeOrder, transitionPayment, transitionWork, syncLegacy, publicOrder
};
