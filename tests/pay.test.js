'use strict';
/* Автотест оплаты по реквизитам: node tests/pay.test.js */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const TOKEN = '123456:TEST_TOKEN_not_real', OWNER = '777', APP_PORT = 3951, MOCK_PORT = 3952;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const SECRET = crypto.createHash('sha256').update('webhook:' + TOKEN).digest('hex').slice(0, 48);
const calls = [];
let nextId = 1000;

const SRT = '1\n00:00:00,200 --> 00:00:02,300\nТри ошибки монтажа, из-за которых рилс листают.\n\n2\n00:00:02,400 --> 00:00:05,000\nМонтаж это не халтура, а инструмент.\n\n3\n00:00:05,100 --> 00:00:07,600\nПишите в бот, отвечу сегодня.\n';
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/file/')) { calls.push({ method: 'FILE', body: { url: req.url } }); res.writeHead(200); return res.end(SRT); }
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    const method = req.url.split('/').pop();
    const multipart = /multipart/.test(req.headers['content-type'] || '');
    const body = multipart ? { raw: b } : JSON.parse(b || '{}');
    calls.push({ method, body });
    let result = true;
    if (method === 'getWebhookInfo') result = { url: '' };
    if (method === 'sendPhoto') result = { message_id: ++nextId, photo: [{ file_id: 'small' }, { file_id: 'PHOTO_FILE_ID' }] };
    if (['sendMessage', 'forwardMessage', 'copyMessage', 'sendDocument'].includes(method)) result = { message_id: ++nextId };
    if (method === 'getFile') result = { file_id: body.file_id, file_size: 400, file_path: 'documents/file_1.srt' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

const wait = ms => new Promise(r => setTimeout(r, ms));
const hook = (update, secret = SECRET) => fetch(APP_URL + '/tg/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update)
}).then(r => r.status);
const client = { id: 42, first_name: 'Аня <script>', username: 'anya' };
const msg = (from, text, extra = {}) => ({ update_id: Date.now(), message: { message_id: ++nextId, from, chat: { id: from.id, type: 'private' }, text, ...extra } });
const since = n => calls.slice(n);

const results = [];
async function t(name, fn) { try { await fn(); results.push('✅ ' + name); } catch (e) { results.push('❌ ' + name + ' — ' + e.message); } }

(async () => {
  await new Promise(r => mock.listen(MOCK_PORT, r));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { PATH: process.env.PATH, ORDERS_FILE: require('path').join(require('os').tmpdir(), 'ivanov-orders-pay-' + process.pid + '.json'), PORT: String(APP_PORT), BOT_TOKEN: TOKEN, OWNER_CHAT_ID: OWNER, APP_URL, TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, PAY_DETAILS: 'СБП: +7 900 000-00-00 (Т-Банк)\\nПолучатель: Иван И.' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', d => process.stderr.write('  [server] ' + d));
  await new Promise(r => app.stdout.on('data', d => String(d).includes('localhost') && r()));
  await wait(400);


  const sign = (user) => {
    const q = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE_t', user: JSON.stringify(user) });
    const dcs = [...q].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
    const sec = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    q.set('hash', crypto.createHmac('sha256', sec).update(dcs).digest('hex')); return q.toString();
  };
  const buyer = { id: 6161, first_name: 'Клиент', username: 'payer' };
  const order = (extra) => fetch(APP_URL + '/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    serviceId: 's30', sourceUrl: 'https://disk.yandex.ru/d/abc', exampleUrl: '', description: 'Рилс для кофейни, 25 секунд', deadline: 'В течение недели',
    extras: [], contact: '', idempotencyKey: crypto.randomUUID(), initData: sign(buyer), ...extra }) }).then(async r => ({ status: r.status, body: await r.json() }));
  const myOrders = () => fetch(APP_URL + '/api/my-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: sign(buyer) }) }).then(r => r.json());
  const cb = (from, data) => hook({ update_id: Date.now(), callback_query: { id: 'cq' + Math.random(), from: { id: from }, data, message: { message_id: 9, chat: { id: from } } } });
  let id = null;

  await t('фикс. цена: клиенту сразу сумма, реквизиты, код заказа и кнопка «Я оплатил»', async () => {
    const n = calls.length; const r = await order(); id = r.body.orderId; await wait(200);
    const m = since(n).find(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id);
    assert.ok(m && /1\s?600 ₽/.test(m.body.text) && m.body.text.includes('Т-Банк') && m.body.text.includes('Получатель') && m.body.text.includes(id), m && m.body.text);
    assert.deepStrictEqual(m.body.reply_markup.inline_keyboard[0][0].callback_data, `pay:sent:${id}`);
    const own = since(n).find(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
    assert.ok(own.body.reply_markup.inline_keyboard.flat().some(b => b.callback_data === `pay:ok:${id}:${buyer.id}`));
  });
  await t('статус оплаты виден в «Мои заказы»: ожидает', async () => {
    const o = (await myOrders()).orders.find(x => x.id === id); assert.ok(o.pay === 'wait' && o.amount === 1600);
  });
  await t('чужой не может нажать «Я оплатил» за клиента', async () => {
    const n = calls.length; await cb(999, `pay:sent:${id}`); await wait(150);
    assert.ok(!since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === 999));
  });
  await t('«Я оплатил» → бот просит чек → чек уходит владельцу с кнопками', async () => {
    let n = calls.length; await cb(buyer.id, `pay:sent:${id}`); await wait(150);
    assert.ok(since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id && /чека/.test(c.body.text)));
    n = calls.length; await hook(msg(buyer, '', { photo: [{ file_id: 'p1' }] })); await wait(200);
    const own = since(n).find(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
    assert.ok(own && own.body.text.includes('Чек по заказу') && own.body.reply_markup.inline_keyboard[0].map(b => b.callback_data).join() === `pay:ok:${id}:${buyer.id},pay:no:${id}:${buyer.id}`);
    assert.ok(since(n).some(c => c.method === 'forwardMessage' && String(c.body.chat_id) === OWNER));
    assert.ok(since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id && /получен/.test(c.body.text)));
  });
  await t('посторонний не может подтвердить оплату', async () => {
    await cb(31337, `pay:ok:${id}:${buyer.id}`); await wait(150);
    assert.notStrictEqual((await myOrders()).orders.find(x => x.id === id).pay, 'paid');
  });
  await t('«Не пришла» → клиенту просьба проверить и снова кнопка', async () => {
    const n = calls.length; await cb(Number(OWNER), `pay:no:${id}:${buyer.id}`); await wait(150);
    const m = since(n).find(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id);
    assert.ok(m && /не вижу/.test(m.body.text) && m.body.reply_markup.inline_keyboard[0][0].callback_data === `pay:sent:${id}`);
  });
  await t('«Оплата пришла» → клиенту «оплата получена», заказ в работе — автоматически', async () => {
    const n = calls.length; await cb(Number(OWNER), `pay:ok:${id}:${buyer.id}`); await wait(200);
    assert.ok(since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id && /Оплата по заказу/.test(c.body.text) && /в работе/.test(c.body.text)));
    const o = (await myOrders()).orders.find(x => x.id === id); assert.ok(o.pay === 'paid' && o.status === 'work', JSON.stringify(o));
  });
  await t('повторное подтверждение ничего не ломает', async () => {
    const n = calls.length; await cb(Number(OWNER), `pay:ok:${id}:${buyer.id}`); await wait(150);
    assert.ok(!since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id));
  });
  await t('после оплаты обычное сообщение клиента идёт как раньше (пересылка), не как чек', async () => {
    const n = calls.length; await hook(msg(buyer, 'Спасибо!')); await wait(150);
    assert.ok(since(n).some(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER && c.body.text.includes('Сообщение от клиента')));
  });
  let id2 = null;
  await t('цена «от» — бот реквизиты не шлёт, Иван выставляет счёт /pay', async () => {
    let n = calls.length; const r = await order({ serviceId: 's100plus' }); id2 = r.body.orderId; await wait(200);
    assert.ok(!since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id && /К оплате/.test(c.body.text)));
    n = calls.length; await hook(msg({ id: Number(OWNER), first_name: 'Иван' }, `/pay ${id2} 4500`)); await wait(200);
    assert.ok(since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id && /4\s?500 ₽/.test(c.body.text)));
    assert.strictEqual((await myOrders()).orders.find(x => x.id === id2).amount, 4500);
  });
  await t('/pay от клиента не работает', async () => {
    const n = calls.length; await hook(msg(buyer, `/pay ${id2} 1`)); await wait(150);
    assert.ok(!since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id && /К оплате/.test(c.body.text)));
  });
  await t('подписка: «Оплата пришла» сразу включает план', async () => {
    const r = await order({ serviceId: '', subscription: { planId: 'start', level: 'standard' }, sourceUrl: '' }); const sid = r.body.orderId; await wait(200);
    await cb(Number(OWNER), `pay:ok:${sid}:${buyer.id}`); await wait(200);
    const res = await myOrders(); assert.ok(res.plan && res.plan.planId === 'start', JSON.stringify(res.plan));
  });

  app.kill(); mock.close();
  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('❌')).length;
  console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
  process.exit(failed ? 1 : 0);
})();
