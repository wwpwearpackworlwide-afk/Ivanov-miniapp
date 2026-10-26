'use strict';
/* Автотест бота: поддельный Telegram Bot API + сервер с тестовым токеном. Запуск: node tests/bot.test.js */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const TOKEN = '123456:TEST_TOKEN_not_real', OWNER = '777', APP_PORT = 3941, MOCK_PORT = 3942;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const SECRET = crypto.createHash('sha256').update('webhook:' + TOKEN).digest('hex').slice(0, 48);
const calls = [];
let nextId = 1000;

const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    const method = req.url.split('/').pop();
    const body = JSON.parse(b || '{}');
    calls.push({ method, body });
    let result = true;
    if (method === 'getWebhookInfo') result = { url: '' };
    if (method === 'sendPhoto') result = { message_id: ++nextId, photo: [{ file_id: 'small' }, { file_id: 'PHOTO_FILE_ID' }] };
    if (['sendMessage', 'forwardMessage', 'copyMessage'].includes(method)) result = { message_id: ++nextId };
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
    env: { PATH: process.env.PATH, ORDERS_FILE: require('path').join(require('os').tmpdir(), 'ivanov-orders-test-' + process.pid + '.json'), PORT: String(APP_PORT), BOT_TOKEN: TOKEN, OWNER_CHAT_ID: OWNER, APP_URL, TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stderr.on('data', d => process.stderr.write('  [server] ' + d));
  await new Promise(r => app.stdout.on('data', d => String(d).includes('localhost') && r()));
  await wait(400);

  await t('при запуске: webhook с секретом, команды и кнопка «Магазин»', async () => {
    const wh = calls.find(c => c.method === 'setWebhook');
    assert.ok(wh && wh.body.url === APP_URL + '/tg/webhook' && wh.body.secret_token === SECRET);
    const cmds = calls.find(c => c.method === 'setMyCommands');
    assert.ok(cmds && cmds.body.commands.some(c => c.command === 'shop'));
    const mb = calls.find(c => c.method === 'setChatMenuButton');
    assert.ok(mb && mb.body.menu_button.text === 'Магазин' && mb.body.menu_button.web_app.url === APP_URL);
  });
  await t('webhook без секрета или с чужим → 401', async () => {
    assert.strictEqual(await hook(msg(client, '/start'), 'wrong'), 401);
    assert.strictEqual(await hook(msg(client, '/start'), ''), 401);
  });
  let n = calls.length;
  await t('/start → фото с логотипом, приветствие, кнопка Магазин (Mini App)', async () => {
    assert.strictEqual(await hook(msg(client, '/start')), 200); await wait(200);
    const p = since(n).find(c => c.method === 'sendPhoto');
    assert.ok(p, 'нет sendPhoto');
    assert.strictEqual(p.body.photo, APP_URL + '/assets/welcome.jpg');
    assert.ok(p.body.caption.includes('Монтаж, который продаёт') && p.body.caption.includes('Аня &lt;script&gt;'), 'имя не экранировано');
    assert.ok(p.body.caption.length <= 1024, 'подпись длиннее 1024: ' + p.body.caption.length);
    const kb = p.body.reply_markup.inline_keyboard;
    assert.strictEqual(kb[0][0].text, '🛍 Магазин'); assert.strictEqual(kb[0][0].web_app.url, APP_URL);
    assert.strictEqual(kb.flat().length, 7);
  });
  n = calls.length;
  await t('второй /start шлёт фото по file_id (быстрее)', async () => {
    await hook(msg(client, '/start')); await wait(200);
    assert.strictEqual(since(n).find(c => c.method === 'sendPhoto').body.photo, 'PHOTO_FILE_ID');
  });
  for (const [data, must] of [['prices', '2 400 ₽'], ['works', 'Instagram'], ['howto', 'Как проходит заказ'], ['faq', 'Как прислать видео'], ['about', 'Обо мне'], ['contacts', '@ivanovv50'], ['menu', 'Монтаж, который продаёт']]) {
    n = calls.length;
    await t(`кнопка «${data}» меняет подпись карточки`, async () => {
      await hook({ update_id: 1, callback_query: { id: 'cq' + data, from: client, data, message: { message_id: 5, chat: { id: 42 }, photo: [{}] } } }); await wait(150);
      const e = since(n).find(c => c.method === 'editMessageCaption');
      assert.ok(e && e.body.caption.includes(must), 'нет текста ' + must);
      assert.ok(e.body.caption.length <= 1024, 'подпись длиннее 1024');
      assert.ok(since(n).some(c => c.method === 'answerCallbackQuery'));
    });
  }
  await t('все цены в разделе «Цены»', async () => {
    const e = calls.filter(c => c.method === 'editMessageCaption').find(c => c.body.caption.includes('Цены на монтаж'));
    for (const p of ['400 ₽', '800 ₽', '1 200 ₽', '1 600 ₽', '2 000 ₽', '2 400 ₽', 'по договорённости']) assert.ok(e.body.caption.includes(p), p);
  });
  n = calls.length;
  await t('/price, /faq, /contacts, /portfolio — открывают нужный раздел', async () => {
    for (const [c, must] of [['/price', 'Цены на монтаж'], ['/faq', 'Частые вопросы'], ['/contacts', 'Контакты'], ['/portfolio', 'Мои работы']]) {
      const k = calls.length; await hook(msg(client, c)); await wait(150);
      assert.ok(calls.slice(k).find(x => x.method === 'sendPhoto' && x.body.caption.includes(must)), c);
    }
  });
  n = calls.length;
  await t('/shop → кнопка Магазин', async () => {
    await hook(msg(client, '/shop')); await wait(150);
    assert.ok(since(n).find(c => c.method === 'sendMessage' && c.body.reply_markup.inline_keyboard[0][0].web_app));
  });
  n = calls.length;
  let fwdId;
  await t('сообщение клиента пересылается Ивану, клиент получает подтверждение', async () => {
    await hook(msg(client, 'Здравствуйте, сколько стоит ролик на 45 секунд?')); await wait(200);
    const s = since(n);
    const head = s.find(c => c.method === 'sendMessage' && c.body.chat_id === OWNER);
    const fwd = s.find(c => c.method === 'forwardMessage');
    assert.ok(head && head.body.text.includes('#u42') && fwd && fwd.body.chat_id === OWNER);
    fwdId = nextId - 1;
    assert.ok(s.find(c => c.method === 'sendMessage' && c.body.chat_id === 42 && c.body.text.includes('передано')));
  });
  n = calls.length;
  await t('ответ Ивана на пересланное сообщение уходит клиенту', async () => {
    const ownerUser = { id: 777, first_name: 'Иван' };
    await hook(msg(ownerUser, '45 секунд — 1 600 ₽', { reply_to_message: { message_id: fwdId, forward_origin: { type: 'hidden_user' } } })); await wait(200);
    const cp = since(n).find(c => c.method === 'copyMessage');
    assert.ok(cp && cp.body.chat_id === 42 && cp.body.from_chat_id === OWNER);
    assert.ok(since(n).find(c => c.method === 'sendMessage' && c.body.text.includes('Отправлено')));
  });
  n = calls.length;
  await t('ответ Ивана на заголовок с #u тоже доходит (после перезапуска сервера)', async () => {
    await hook(msg({ id: 777, first_name: 'Иван' }, 'Ок', { reply_to_message: { message_id: 1, text: '✉️ Сообщение от клиента\nАня\n#u42' } })); await wait(200);
    assert.ok(since(n).find(c => c.method === 'copyMessage' && c.body.chat_id === 42));
  });
  n = calls.length;
  await t('сообщения в группах бот игнорирует', async () => {
    await hook({ update_id: 9, message: { message_id: 1, from: client, chat: { id: -100, type: 'group' }, text: 'привет' } }); await wait(150);
    assert.strictEqual(since(n).length, 0);
  });
  await t('заказ через Mini App по-прежнему работает (health)', async () => {
    const j = await (await fetch(APP_URL + '/api/health')).json(); assert.ok(j.configured && j.bot);
    const r = await fetch(APP_URL + '/assets/welcome.jpg'); assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
  });
  await t('токен не попадает в логи запросов к клиенту', async () => {
    assert.ok(!calls.some(c => JSON.stringify(c.body).includes(TOKEN)));
  });


  /* ---------- статусы заказов и профиль ---------- */
  const sign = (user) => {
    const q = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE_t', user: JSON.stringify(user) });
    const dcs = [...q].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
    const sec = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    q.set('hash', crypto.createHmac('sha256', sec).update(dcs).digest('hex')); return q.toString();
  };
  const buyer = { id: 4242, first_name: 'Покупатель', username: 'buyer' };
  const myOrders = (initData) => fetch(APP_URL + '/api/my-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  let oid = null;
  await t('заявка из Telegram: у владельца под ней кнопки статуса', async () => {
    const n = calls.length;
    const r = await fetch(APP_URL + '/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      serviceId: 's30', sourceUrl: 'https://disk.yandex.ru/d/x', exampleUrl: '', description: 'Тестовый заказ', deadline: 'В течение недели',
      extras: [], contact: '', idempotencyKey: crypto.randomUUID(), initData: sign(buyer) }) }).then(r => r.json());
    assert.ok(r.ok && r.orderId); oid = r.orderId; await wait(150);
    const toOwner = since(n).find(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
    const kb = toOwner.body.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    assert.ok(kb.includes(`st:work:${oid}:${buyer.id}`) && kb.includes(`st:done:${oid}:${buyer.id}`));
  });
  await t('профиль: /api/my-orders отдаёт заказ со статусом «Отправлена»', async () => {
    const r = await myOrders(sign(buyer)); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.orders[0].id, oid); assert.strictEqual(r.body.orders[0].status, 'sent');
  });
  await t('профиль: без подписи Telegram заказы не отдаются (401)', async () => {
    assert.strictEqual((await myOrders('user=%7B%22id%22%3A4242%7D&hash=' + 'a'.repeat(64))).status, 401);
  });
  await t('профиль: чужие заказы не видны', async () => {
    const r = await myOrders(sign({ id: 999, first_name: 'Чужой' })); assert.strictEqual(r.body.orders.length, 0);
  });
  await t('владелец жмёт «В работу»: клиенту приходит сообщение, статус меняется', async () => {
    const n = calls.length;
    await hook({ update_id: 1, callback_query: { id: 'cq1', from: { id: Number(OWNER) }, data: `st:work:${oid}:${buyer.id}`, message: { message_id: 5, chat: { id: Number(OWNER) } } } });
    await wait(200);
    const toBuyer = since(n).find(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id);
    assert.ok(toBuyer && toBuyer.body.text.includes(oid) && toBuyer.body.text.includes('в работу'));
    assert.ok(since(n).some(c => c.method === 'editMessageReplyMarkup'));
    assert.strictEqual((await myOrders(sign(buyer))).body.orders[0].status, 'work');
  });
  await t('кнопки статуса не работают у постороннего', async () => {
    const n = calls.length;
    await hook({ update_id: 2, callback_query: { id: 'cq2', from: { id: 31337 }, data: `st:done:${oid}:${buyer.id}`, message: { message_id: 5, chat: { id: 31337 } } } });
    await wait(150);
    assert.ok(!since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === buyer.id));
    assert.strictEqual((await myOrders(sign(buyer))).body.orders[0].status, 'work');
  });

  // ---- Подписки и план
  const subBuyer = { id: 5151, first_name: 'Подписчик', username: 'subscriber' };
  let sid = null;
  const subOrder = (sub, extra = {}) => fetch(APP_URL + '/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    serviceId: '', subscription: sub, sourceUrl: '', exampleUrl: '', description: 'Ролики для кофейни', deadline: 'В течение недели',
    extras: [], contact: '', idempotencyKey: crypto.randomUUID(), initData: sign(subBuyer), ...extra }) }).then(async r => ({ status: r.status, body: await r.json() }));
  await t('подписка PRO · Advanced 3D: заявка с тарифом и ценой из config.json, под ней кнопка «Оплачено»', async () => {
    const n = calls.length;
    const r = await subOrder({ planId: 'pro', level: 'advanced' });
    assert.ok(r.status === 200 && r.body.orderId, JSON.stringify(r.body)); sid = r.body.orderId; await wait(150);
    const toOwner = since(n).find(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
    assert.ok(toOwner.body.text.includes('PRO') && toOwner.body.text.includes('Advanced 3D') && /9\s?000/.test(toOwner.body.text.replace(/ /g, ' ')), toOwner.body.text);
    const kb = toOwner.body.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    assert.ok(kb.includes(`sp:on:${sid}:${subBuyer.id}`));
  });
  await t('подписка: неизвестный тариф или уровень → 400', async () => {
    const a = await subOrder({ planId: 'mega', level: 'standard' }); const b = await subOrder({ planId: 'pro', level: 'ultra3d' });
    assert.ok(a.status === 400 && a.body.fields.subscription && b.status === 400 && b.body.fields.subscription);
  });
  await t('до оплаты плана нет', async () => {
    const r = await myOrders(sign(subBuyer)); assert.strictEqual(r.body.plan, null); assert.strictEqual(r.body.orders[0].serviceId, 'sub:pro:advanced');
  });
  await t('посторонний не может включить план', async () => {
    await hook({ update_id: 3, callback_query: { id: 'cq3', from: { id: 31337 }, data: `sp:on:${sid}:${subBuyer.id}`, message: { message_id: 6, chat: { id: 31337 } } } });
    await wait(150); assert.strictEqual((await myOrders(sign(subBuyer))).body.plan, null);
  });
  await t('владелец жмёт «Оплачено»: план PRO активен 30 дней, клиент уведомлён', async () => {
    const n = calls.length;
    await hook({ update_id: 4, callback_query: { id: 'cq4', from: { id: Number(OWNER) }, data: `sp:on:${sid}:${subBuyer.id}`, message: { message_id: 6, chat: { id: Number(OWNER) } } } });
    await wait(200);
    const plan = (await myOrders(sign(subBuyer))).body.plan;
    assert.ok(plan && plan.planId === 'pro' && plan.level === 'advanced');
    assert.ok(Math.abs(plan.until - (Date.now() + 30 * 86400000)) < 60000);
    assert.ok(since(n).some(c => c.method === 'sendMessage' && c.body.chat_id === subBuyer.id && c.body.text.includes('активна')));
    const kb = since(n).find(c => c.method === 'editMessageReplyMarkup').body.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    assert.ok(kb.includes(`sp:off:${sid}:${subBuyer.id}`));
  });
  await t('план виден только своему клиенту', async () => {
    assert.strictEqual((await myOrders(sign(buyer))).body.plan, null);
  });
  await t('владелец жмёт «Отключить план»: плана нет', async () => {
    await hook({ update_id: 5, callback_query: { id: 'cq5', from: { id: Number(OWNER) }, data: `sp:off:${sid}:${subBuyer.id}`, message: { message_id: 6, chat: { id: Number(OWNER) } } } });
    await wait(200); assert.strictEqual((await myOrders(sign(subBuyer))).body.plan, null);
  });
  await t('кнопку «Оплачено» нельзя применить к обычному заказу', async () => {
    await hook({ update_id: 6, callback_query: { id: 'cq6', from: { id: Number(OWNER) }, data: `sp:on:${oid}:${buyer.id}`, message: { message_id: 5, chat: { id: Number(OWNER) } } } });
    await wait(150); assert.strictEqual((await myOrders(sign(buyer))).body.plan, null);
  });

  app.kill(); mock.close();
  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('❌')).length;
  console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
  process.exit(failed ? 1 : 0);
})();
