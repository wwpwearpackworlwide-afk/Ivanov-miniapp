'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert');
const { openStore } = require('../server/store');

const TOKEN = '123456:TEST_TOKEN_not_real', OWNER = '777', SECRET = 'explicit_TEST_secret-002';
const PORT = 3961, MPORT = 3962, URL = 'http://127.0.0.1:' + PORT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivanov-pay-v2-')), DATA = path.join(tmp, 'orders.json');
const calls = []; let updateId = 5000, messageId = 100, app = null, failPaid = false;
const buyer = { id: 6262, first_name: 'Плательщик', username: 'payer2' };
const stranger = { id: 31337, first_name: 'Чужой' };
const owner = { id: 777, first_name: 'Владелец' };
const results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function t(name, fn) { try { await fn(); results.push('✅ ' + name); } catch (e) { results.push('❌ ' + name + ' — ' + e.stack); } }
function sign(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE_v2', user: JSON.stringify(user) });
  const dcs = [...p].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => k + '=' + v).join('\n');
  const sec = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', sec).update(dcs).digest('hex')); return p.toString();
}
const mock = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const method = req.url.split('/').pop(); let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    calls.push({ method, body });
    if (failPaid && method === 'sendMessage' && String(body.text || '').includes('Оплата по заказу')) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"description":"temporary test failure"}');
    }
    let result = { message_id: ++messageId };
    if (method === 'getWebhookInfo') result = { url: '' };
    if (method === 'sendPhoto') result = { message_id: ++messageId, photo: [{ file_id: 'PHOTO' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result }));
  });
});
function start(extra = {}) {
  return new Promise((resolve, reject) => {
    app = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: { PATH: process.env.PATH, ORDERS_FILE: DATA, PORT: String(PORT), BOT_TOKEN: TOKEN, OWNER_CHAT_ID: OWNER,
        APP_URL: URL, TELEGRAM_API_BASE: 'http://127.0.0.1:' + MPORT, PAY_DETAILS: 'TEST ONLY\\nСБП 000', WEBHOOK_SECRET: SECRET, MAX_RECEIPT_BYTES: '1024', ...extra },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    app.stderr.on('data', d => process.stderr.write('  [server] ' + d));
    app.stdout.on('data', d => String(d).includes('localhost') && resolve(app));
    app.once('error', reject);
  });
}
function stop() { return new Promise(r => { if (!app) return r(); app.once('exit', () => { app = null; r(); }); app.kill(); setTimeout(r, 3000).unref(); }); }
async function hook(up, secret = SECRET) {
  const update = { update_id: ++updateId, ...up };
  const res = await fetch(URL + '/tg/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) });
  return res.status;
}
const cb = (from, data) => hook({ callback_query: { id: 'cq' + (++messageId), from, data, message: { message_id: 9, chat: { id: from.id } } } });
const msg = (from, text, extra = {}) => hook({ message: { message_id: ++messageId, from, chat: { id: from.id, type: 'private' }, text, ...extra } });
async function create(user = buyer, key = crypto.randomUUID(), extra = {}) {
  const res = await fetch(URL + '/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    serviceId: 's30', sourceUrl: 'https://disk.yandex.ru/d/test', exampleUrl: '', description: 'Полный тест ручной оплаты',
    deadline: 'В течение недели', extras: [], contact: '', idempotencyKey: key, initData: sign(user), amount: 1, ...extra }) });
  return { status: res.status, body: await res.json() };
}
async function my(user = buyer) { const r = await fetch(URL + '/api/my-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: sign(user) }) }); return r.json(); }
async function receipt(user, orderId, receiptId) {
  const r = await fetch(URL + '/api/receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: sign(user), orderId, receiptId }) });
  return { status: r.status, body: await r.json() };
}
const getOrder = async id => (await my()).orders.find(o => o.id === id);
const photo = () => [{ file_id: 'small-' + (++messageId) }, { file_id: 'receipt-' + messageId, file_unique_id: 'unique-' + messageId, file_size: 400 }];

(async () => {
  await new Promise(r => mock.listen(MPORT, r)); await start(); await wait(300);
  let id, idem = crypto.randomUUID(), firstReceipt;
  await t('явный WEBHOOK_SECRET установлен в Telegram и принимает positive request', async () => {
    assert.ok(calls.some(c => c.method === 'setWebhook' && c.body.secret_token === SECRET));
    const n = calls.length; assert.strictEqual(await msg({ id: 4545, first_name: 'Secret' }, '/start'), 200); await wait(120);
    assert.ok(calls.slice(n).some(c => c.method === 'sendPhoto'));
  });
  await t('WEBHOOK_SECRET negative: чужой и пустой секрет → 401 без обработки', async () => {
    const n = calls.length;
    assert.strictEqual(await hook({ message: { from: buyer, chat: { id: buyer.id, type: 'private' }, text: '/start' } }, 'wrong'), 401);
    assert.strictEqual(await hook({ message: { from: buyer, chat: { id: buyer.id, type: 'private' }, text: '/start' } }, ''), 401);
    assert.strictEqual(calls.length, n);
  });
  await t('одинаковый Telegram update после ACK дедуплицируется', async () => {
    const up = { update_id: ++updateId, message: { message_id: ++messageId, from: { id: 4546, first_name: 'D' }, chat: { id: 4546, type: 'private' }, text: '/start' } };
    const send = () => fetch(URL + '/tg/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(up) });
    await send(); await wait(150); const n = calls.filter(c => c.method === 'sendPhoto' && c.body.chat_id === 4546).length;
    await send(); await send(); await wait(150); assert.strictEqual(calls.filter(c => c.method === 'sendPhoto' && c.body.chat_id === 4546).length, n);
  });
  await t('сервер игнорирует amount=1 клиента, рассчитывает 1600 и хранит snapshot/items', async () => {
    const r = await create(buyer, idem); id = r.body.orderId; await wait(150);
    const o = await getOrder(id); assert.strictEqual(r.status, 200); assert.strictEqual(o.amount, 1600);
    assert.strictEqual(o.state, 'pending_payment'); assert.strictEqual(o.serviceSnapshot.listPrice, 1600);
    assert.ok(o.items.length && o.items[0].totalPrice === 1600 && o.items[0].title);
  });
  await t('клиент не может сам подтвердить оплату', async () => {
    await cb(buyer, `pay:ok:${id}:${buyer.id}`); await wait(100); assert.strictEqual((await getOrder(id)).state, 'pending_payment');
  });
  await t('чужой пользователь не может объявить оплату по заказу', async () => {
    await cb(stranger, `pay:sent:${id}`); await wait(100); assert.strictEqual((await getOrder(id)).state, 'pending_payment');
  });
  await t('«Я оплатил» → payment_submitted, но это ещё не paid', async () => {
    await cb(buyer, `pay:sent:${id}`); await wait(100); const o = await getOrder(id); assert.strictEqual(o.state, 'payment_submitted'); assert.strictEqual(o.pay, 'wait');
  });
  await t('текст вместо чека отклоняется, ожидание сохраняется', async () => {
    await msg(buyer, 'вот номер операции'); await wait(100); assert.strictEqual((await getOrder(id)).state, 'payment_submitted');
    assert.ok(calls.some(c => c.method === 'sendMessage' && String(c.body.text).includes('именно фото')));
  });
  await t('слишком большое изображение не создаёт receipt', async () => {
    await msg(buyer, '', { photo: [{ file_id: 'huge', file_size: 2048 }] }); await wait(100);
    assert.strictEqual((await getOrder(id)).paymentAttempts.length, 0);
  });
  await t('валидное фото → payment_review + защищённые Telegram metadata', async () => {
    await msg(buyer, '', { photo: photo() }); await wait(180); const o = await getOrder(id);
    assert.strictEqual(o.state, 'payment_review'); assert.strictEqual(o.paymentAttempts.length, 1); firstReceipt = o.paymentAttempts[0].id;
    assert.ok(calls.some(c => c.method === 'forwardMessage' && String(c.body.chat_id) === OWNER));
    assert.ok(calls.some(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER && String(c.body.text).includes('не доказательство')));
  });
  await t('владелец получает confirm/reject/repeat/info controls', async () => {
    const own = calls.filter(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER && String(c.body.text).includes('ID чека')).pop();
    const data = own.body.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    for (const action of ['ok', 'no', 'again', 'info']) assert.ok(data.includes(`pay:${action}:${id}:${buyer.id}`));
  });
  await t('просмотр чека: владелец и свой клиент — 200, чужой — 403', async () => {
    assert.strictEqual((await receipt(buyer, id, firstReceipt)).status, 200);
    assert.strictEqual((await receipt(owner, id, firstReceipt)).status, 200);
    assert.strictEqual((await receipt(stranger, id, firstReceipt)).status, 403);
  });
  await t('order info не меняет финансовое состояние', async () => {
    await cb(owner, `pay:info:${id}:${buyer.id}`); await wait(100); assert.strictEqual((await getOrder(id)).state, 'payment_review');
  });
  await t('отклонение сохраняет причину и статус payment_rejected', async () => {
    await cb(owner, `pay:no:${id}:${buyer.id}`); await wait(120); const o = await getOrder(id);
    assert.strictEqual(o.state, 'payment_rejected'); assert.ok(o.paymentHistory.some(e => e.reason.includes('не найден')));
  });
  await t('новый чек привязан к тому же заказу, первый не удалён', async () => {
    await cb(buyer, `pay:sent:${id}`); await wait(80); await msg(buyer, '', { photo: photo() }); await wait(150);
    const o = await getOrder(id); assert.strictEqual(o.state, 'payment_review'); assert.strictEqual(o.paymentAttempts.length, 2);
    assert.strictEqual(o.paymentAttempts[0].id, firstReceipt);
  });
  await t('owner repeat request → отдельная причина и возможность третьего чека', async () => {
    await cb(owner, `pay:again:${id}:${buyer.id}`); await wait(100); let o = await getOrder(id); assert.strictEqual(o.state, 'payment_rejected');
    await cb(buyer, `pay:sent:${id}`); await wait(80); await msg(buyer, '', { document: { file_id: 'doc-image', file_name: 'check.png', mime_type: 'image/png', file_size: 400 } }); await wait(150);
    o = await getOrder(id); assert.strictEqual(o.paymentAttempts.length, 3); assert.strictEqual(o.state, 'payment_review');
  });
  await t('посторонний owner action не меняет payment_review', async () => {
    await cb(stranger, `pay:ok:${id}:${buyer.id}`); await wait(100); assert.strictEqual((await getOrder(id)).state, 'payment_review');
  });
  await t('подтверждение сохраняется даже при сбое клиентского уведомления', async () => {
    failPaid = true; await cb(owner, `pay:ok:${id}:${buyer.id}`); await wait(180); const o = await getOrder(id);
    assert.strictEqual(o.state, 'in_progress'); assert.strictEqual(o.paymentStatus, 'paid'); assert.ok(o.paymentConfirmedAt);
  });
  await t('restart: durable outbox повторяет уведомление, история не дублируется', async () => {
    const before = (await getOrder(id)).paymentHistory.length; await stop(); failPaid = false;
    const n = calls.filter(c => c.method === 'sendMessage' && String(c.body.text).includes('Оплата по заказу')).length;
    await start(); await wait(2600); // сохранённый backoff переживает restart; повтор из outbox
    assert.ok(calls.filter(c => c.method === 'sendMessage' && String(c.body.text).includes('Оплата по заказу')).length > n);
    assert.strictEqual((await getOrder(id)).paymentHistory.length, before);
  });
  await t('restart: повторный idempotency key возвращает тот же заказ без дубля', async () => {
    const before = (await my()).orders.length, r = await create(buyer, idem); await wait(100);
    assert.strictEqual(r.body.orderId, id); assert.strictEqual(r.body.duplicate, true); assert.strictEqual((await my()).orders.length, before);
  });
  await t('повторное нажатие confirm не добавляет событие и сообщение', async () => {
    const o = await getOrder(id), n = calls.length; await cb(owner, `pay:ok:${id}:${buyer.id}`); await wait(100);
    assert.strictEqual((await getOrder(id)).paymentHistory.length, o.paymentHistory.length);
    assert.ok(!calls.slice(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id));
  });
  await t('все старые чеки доступны после paid/in_progress', async () => {
    const o = await getOrder(id); assert.strictEqual(o.paymentAttempts.length, 3);
    for (const r of o.paymentAttempts) assert.strictEqual((await receipt(buyer, id, r.id)).status, 200);
  });
  let id2;
  await t('awaiting check переживает restart и принимает чек без повторного нажатия', async () => {
    id2 = (await create()).body.orderId; await wait(100); await cb(buyer, `pay:sent:${id2}`); await wait(100);
    await stop(); await start(); await wait(250); await msg(buyer, '', { photo: photo() }); await wait(180);
    assert.strictEqual((await getOrder(id2)).state, 'payment_review');
  });
  await t('финансовый audit содержит владельца, время и причины всех переходов', async () => {
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf8')), o = raw.orders.find(x => x.id === id);
    const paid = o.paymentHistory.find(e => e.to === 'paid'); assert.ok(paid && paid.actor.id === '777' && paid.at && paid.reason);
    assert.ok(o.auditLog.some(e => e.action === 'payment.repeat_requested'));
    assert.strictEqual(o.pricing.total, 1600); assert.strictEqual(o.pricing.source, 'server-config-snapshot');
  });
  await t('processing update восстанавливается при старте после аварии', async () => {
    await stop(); const store = openStore({ file: DATA });
    const up = { update_id: ++updateId, message: { message_id: ++messageId, from: { id: 4547, first_name: 'Recovery' }, chat: { id: 4547, type: 'private' }, text: '/start' } };
    const saved = store.enqueueTelegramUpdate(up); store.markUpdateProcessing(saved.key);
    await start(); await wait(500); assert.ok(calls.some(c => c.method === 'sendPhoto' && c.body.chat_id === 4547));
  });
  await t('без PAY_DETAILS заказ сохраняется, клиент получает безопасную инструкцию', async () => {
    await stop(); await start({ PAY_DETAILS: '' }); await wait(250); const r = await create({ id: 6263, first_name: 'No details' }); await wait(150);
    const o = (await my({ id: 6263 })).orders.find(x => x.id === r.body.orderId); assert.ok(o && o.state === 'pending_payment');
    assert.ok(calls.some(c => c.method === 'sendMessage' && c.body.chat_id === 6263 && String(c.body.text).includes('Реквизиты временно не настроены')));
    assert.ok(!calls.some(c => c.method === 'sendMessage' && c.body.chat_id === 6263 && String(c.body.text).includes('TEST ONLY')));
  });

  await stop(); mock.close();
  console.log(results.join('\n')); const failed = results.filter(x => x.startsWith('❌')).length;
  console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
  fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = failed ? 1 : 0;
})().catch(async e => { console.error(e); await stop(); mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = 1; });
