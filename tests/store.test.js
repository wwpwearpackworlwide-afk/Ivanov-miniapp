'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore, parseState } = require('../server/store');
const { transitionPayment, transitionWork, normalizeOrder } = require('../server/order-state');
const { validateEnv, loadConfig } = require('../server/config-schema');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivanov-store-test-'));
const results = [];
async function t(name, fn) { try { await fn(); results.push('✅ ' + name); } catch (e) { results.push('❌ ' + name + ' — ' + e.stack); } }
const file = name => path.join(tmp, name + '.json');
const order = id => ({ id, userId: 42, serviceId: 's30', at: Date.now(), state: 'pending_payment', amount: 1600 });

(async () => {
  await t('legacy array импортируется полностью, включая >5000 заказов', () => {
    const f = file('legacy'); const many = Array.from({ length: 5005 }, (_, i) => order('OLD' + i));
    fs.writeFileSync(f, JSON.stringify(many));
    const s = openStore({ file: f, logger: { warn() {} } });
    assert.strictEqual(s._map.size, 5005); assert.ok(s.get('OLD0')); assert.ok(s.get('OLD5004'));
  });
  await t('отдельный runtime импортирует legacy с backup, не изменяя источник', () => {
    const source = file('legacy-source'), runtime = path.join(tmp, 'runtime', 'orders.json');
    const raw = JSON.stringify([order('LEGACY1'), order('LEGACY2')]); fs.writeFileSync(source, raw);
    const s = openStore({ file: runtime, legacyFile: source, logger: { warn() {} } });
    assert.strictEqual(s._map.size, 2); assert.strictEqual(fs.readFileSync(source, 'utf8'), raw);
    assert.strictEqual(fs.readFileSync(runtime + '.bak', 'utf8'), raw); assert.ok(fs.existsSync(runtime));
  });
  await t('atomic save создаёт main/backup и не оставляет temp-файлы', () => {
    const f = file('atomic'), s = openStore({ file: f }); s.add(order('A10001'));
    s.update('A10001', o => { transitionPayment(o, 'payment_submitted', { reason: 'test' }); return o; });
    assert.ok(fs.existsSync(f)); assert.ok(fs.existsSync(f + '.bak'));
    assert.strictEqual(fs.readdirSync(tmp).filter(n => n.includes('.tmp')).length, 0);
    assert.strictEqual(parseState(fs.readFileSync(f, 'utf8'), f).schemaVersion, 2);
  });
  await t('повреждённый main восстанавливается из валидного backup с quarantine', () => {
    const f = file('recovery'), s = openStore({ file: f, logger: { warn() {} } }); s.add(order('R10001'));
    s.update('R10001', o => { o.amount = 2000; return o; });
    fs.writeFileSync(f, '{broken');
    const recovered = openStore({ file: f, logger: { warn() {} } });
    assert.ok(recovered.get('R10001'));
    assert.ok(fs.readdirSync(tmp).some(n => n.startsWith('recovery.json.corrupted-')));
  });
  await t('повреждённый JSON без backup — явный отказ, файл не перезаписан', () => {
    const f = file('fatal'); fs.writeFileSync(f, '{broken');
    assert.throws(() => openStore({ file: f }), e => e.code === 'CORRUPT_STORE');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{broken');
  });
  await t('idempotency key + заказ сохраняются одной операцией после restart', () => {
    const f = file('idem'); let s = openStore({ file: f });
    const first = s.addWithIdempotency(order('I10001'), '42:key'); assert.strictEqual(first.duplicate, false);
    s = openStore({ file: f }); const again = s.addWithIdempotency(order('I10002'), '42:key');
    assert.strictEqual(again.duplicate, true); assert.strictEqual(again.order.id, 'I10001'); assert.strictEqual(s._map.size, 1);
  });
  await t('awaiting check и reply mapping восстанавливаются после restart', () => {
    const f = file('runtime'); let s = openStore({ file: f }); s.add(order('S10001'));
    s.setAwaitingCheck(42, 'S10001'); s.setReplyTarget(900, 42);
    s = openStore({ file: f }); assert.strictEqual(s.getAwaitingCheck(42).orderId, 'S10001'); assert.strictEqual(s.getReplyTarget(900), 42);
  });
  await t('Telegram exact duplicate не создаёт вторую inbox-запись', () => {
    const f = file('inbox'), s = openStore({ file: f }); const up = { update_id: 10, message: { text: '/start' } };
    const a = s.enqueueTelegramUpdate(up), b = s.enqueueTelegramUpdate(up);
    assert.strictEqual(a.duplicate, false); assert.strictEqual(b.duplicate, true); assert.strictEqual(a.key, b.key);
  });
  await t('processing update после restart снова доступен для обработки', () => {
    const f = file('processing'); let s = openStore({ file: f });
    const e = s.enqueueTelegramUpdate({ update_id: 11, message: { text: '/start' } }); s.markUpdateProcessing(e.key);
    s = openStore({ file: f }); assert.ok(s.dueTelegramUpdates().some(r => r.key === e.key));
  });
  await t('paid → in_progress сохраняет paymentStatus=paid и дату подтверждения', () => {
    const o = order('P10001'); transitionPayment(o, 'paid', { actor: { type: 'owner', id: '777' }, reason: 'bank checked' });
    transitionWork(o, 'in_progress', { actor: { type: 'owner', id: '777' } });
    assert.strictEqual(o.state, 'in_progress'); assert.strictEqual(o.paymentStatus, 'paid'); assert.strictEqual(o.pay, 'paid'); assert.ok(o.paidAt);
  });
  await t('повторный переход не перезаписывает и не дублирует финансовую историю', () => {
    const o = order('P10002'); transitionPayment(o, 'payment_review', { reason: 'receipt 1' });
    const first = o.paymentHistory.length; transitionPayment(o, 'payment_review', { reason: 'same' });
    assert.strictEqual(o.paymentHistory.length, first); assert.strictEqual(o.paymentHistory[0].to, 'pending_payment');
  });
  await t('несколько чеков и причины решений остаются append-only', () => {
    const o = normalizeOrder(order('P10003'));
    o.paymentAttempts.push({ id: 'r1' }); transitionPayment(o, 'payment_review', { reason: 'r1', receiptId: 'r1' });
    transitionPayment(o, 'payment_rejected', { reason: 'неразборчиво', actor: { type: 'owner', id: '777' } });
    o.paymentAttempts.push({ id: 'r2' }); transitionPayment(o, 'payment_review', { reason: 'r2', receiptId: 'r2' });
    assert.deepStrictEqual(o.paymentAttempts.map(r => r.id), ['r1', 'r2']);
    assert.ok(o.paymentHistory.some(e => e.reason === 'неразборчиво'));
  });
  await t('недопустимый completed → paid отклоняется', () => {
    const o = order('P10004'); transitionWork(o, 'completed', {});
    assert.throws(() => transitionPayment(o, 'paid', {}), e => e.code === 'INVALID_PAYMENT_TRANSITION');
  });
  await t('TRUST_PROXY по умолчанию false; WEBHOOK_SECRET проходит в env', () => {
    const env = validateEnv({ WEBHOOK_SECRET: 'custom_SECRET-123' });
    assert.strictEqual(env.TRUST_PROXY, false); assert.strictEqual(env.WEBHOOK_SECRET, 'custom_SECRET-123');
  });
  await t('некорректные PORT/TRUST_PROXY/WEBHOOK_SECRET отклоняются схемой', () => {
    assert.throws(() => validateEnv({ PORT: '70000', TRUST_PROXY: 'yes', WEBHOOK_SECRET: 'bad secret!' }), e => e.code === 'INVALID_CONFIG');
  });
  await t('текущий config.json проходит schema validation', () => {
    assert.ok(loadConfig(path.join(__dirname, '..', 'public', 'config.json')));
  });
  await t('legacy normalize не выбрасывает существующие поля заказа', () => {
    const old = { id: 'L1', userId: 42, at: 1, status: 'work', pay: 'paid', custom: 'keep' };
    const o = normalizeOrder(old); assert.strictEqual(o.custom, 'keep'); assert.strictEqual(o.state, 'in_progress'); assert.strictEqual(o.paymentStatus, 'paid');
  });

  console.log(results.join('\n'));
  const failed = results.filter(x => x.startsWith('❌')).length;
  console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = 1; });
