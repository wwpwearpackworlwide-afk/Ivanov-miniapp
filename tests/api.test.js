'use strict';
/* Автотест сервера: поднимает поддельный Telegram Bot API и сам сервер с тестовым токеном.
   Настоящий токен не нужен и не используется. Запуск: npm test */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const TOKEN = '123456:TEST_TOKEN_not_real';
const OWNER = '777';
const APP_PORT = 3911, MOCK_PORT = 3912;
const received = [];
let mockFail = false;

function signInitData(user, token = TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE_test', user: JSON.stringify(user) });
  const dcs = [...p].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    const ok = req.url === `/bot${TOKEN}/sendMessage` && !mockFail;
    if (ok) received.push(JSON.parse(b));
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true, result: { message_id: 1 } } : { ok: false, description: 'Bad Request: chat not found' }));
  });
});

function startApp(extraEnv) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: { PATH: process.env.PATH, ORDERS_FILE: require('path').join(require('os').tmpdir(), 'ivanov-orders-test-' + process.pid + '.json'), PORT: String(APP_PORT), TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, TRUST_PROXY: 'true', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    p.stdout.on('data', d => { if (String(d).includes('localhost')) resolve(p); });
    p.stderr.on('data', d => process.stderr.write('  [server] ' + d));
  });
}
const stop = p => new Promise(r => { p.on('exit', r); p.kill(); });

const base = () => `http://127.0.0.1:${APP_PORT}`;
let ipN = 0;
function post(body, { ip, raw } = {}) {
  return fetch(base() + '/api/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `10.0.0.${++ipN}` },
    body: raw !== undefined ? raw : JSON.stringify(body)
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const user = { id: 42, first_name: 'Тест', last_name: '<b>Клиент</b>', username: 'test_client' };
const order = (o = {}) => ({
  serviceId: 's30', sourceUrl: 'https://disk.yandex.ru/d/abc', exampleUrl: '', description: 'Смонтировать рилс про кофе',
  deadline: 'В течение недели', extras: ['urgent'], contact: '', idempotencyKey: crypto.randomUUID(), initData: signInitData(user), ...o
});

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['✅', name]); } catch (e) { results.push(['❌', name + ' — ' + e.message]); }
}

(async () => {
  await new Promise(r => mock.listen(MOCK_PORT, r));

  // 1. Без токена — приём заявок выключен, честный 503
  let app = await startApp({});
  await t('health без настроек: configured=false', async () => {
    const j = await (await fetch(base() + '/api/health')).json(); assert.strictEqual(j.configured, false);
  });
  await t('без BOT_TOKEN заявка → 503 not_configured', async () => {
    const r = await post(order()); assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error, 'not_configured');
  });
  await stop(app);

  app = await startApp({ BOT_TOKEN: TOKEN, OWNER_CHAT_ID: OWNER });
  await t('статика: index.html отдаётся, есть CSP и nosniff', async () => {
    const r = await fetch(base() + '/'); assert.strictEqual(r.status, 200);
    assert.ok(r.headers.get('content-security-policy')); assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('x-frame-options'), null);
  });
  await t('статика: выход за пределы public/ запрещён', async () => {
    for (const u of ['/..%2fserver%2fserver.js', '/%2e%2e/.env.example', '/../package.json']) {
      const r = await fetch(base() + u); assert.ok([403, 404].includes(r.status), u + ' → ' + r.status);
    }
  });
  await t('статика: сервер не отдаёт токен ни в одном ответе', async () => {
    for (const u of ['/', '/app.js', '/config.json', '/styles.css', '/api/health']) {
      const txt = await (await fetch(base() + u)).text(); assert.ok(!txt.includes(TOKEN), u);
    }
  });
  await t('без initData → 401 init_data_required', async () => {
    const r = await post(order({ initData: '' })); assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error, 'init_data_required');
  });
  await t('поддельная подпись (другой токен) → 401', async () => {
    const r = await post(order({ initData: signInitData(user, '999:OTHER') })); assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error, 'invalid_init_data');
  });
  await t('изменённый user в initData → 401', async () => {
    const p = new URLSearchParams(signInitData(user)); p.set('user', JSON.stringify({ ...user, id: 1 }));
    const r = await post(order({ initData: p.toString() })); assert.strictEqual(r.status, 401);
  });
  await t('просроченная подпись (2 суток) → 401', async () => {
    const r = await post(order({ initData: signInitData(user, TOKEN, Math.floor(Date.now() / 1000) - 2 * 86400) })); assert.strictEqual(r.status, 401);
  });
  await t('некорректная ссылка → 400 с полем sourceUrl', async () => {
    const r = await post(order({ sourceUrl: 'javascript:alert(1)' })); assert.strictEqual(r.status, 400); assert.ok(r.body.fields.sourceUrl);
  });
  await t('монтаж без ссылки на исходники → 400', async () => {
    const r = await post(order({ sourceUrl: '', initData: signInitData({ ...user, id: 9002 }) })); assert.strictEqual(r.status, 400); assert.ok(r.body.fields.sourceUrl);
  });
  await t('бот/мини-приложение без ссылки → принимается (ссылка необязательна)', async () => {
    const r = await post(order({ serviceId: 'bundle', sourceUrl: '', idempotencyKey: 'dev-no-link-0000001', initData: signInitData({ ...user, id: 9001 }) })); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.orderId);
  });
  await t('неизвестная услуга/срок/доп.услуга → 400', async () => {
    const r = await post(order({ serviceId: 'free', deadline: 'вчера', extras: ['gift'] }));
    assert.strictEqual(r.status, 400); assert.ok(r.body.fields.serviceId && r.body.fields.deadline && r.body.fields.extras);
  });
  await t('слишком короткое описание → 400', async () => {
    const r = await post(order({ description: 'ok' })); assert.strictEqual(r.status, 400); assert.ok(r.body.fields.description);
  });
  await t('битый JSON → 400', async () => { const r = await post(null, { raw: '{oops' }); assert.strictEqual(r.status, 400); });
  await t('тело больше 10 КБ → 413', async () => {
    const r = await post(order({ description: 'x'.repeat(20000) })); assert.strictEqual(r.status, 413);
  });
  await t('GET /api/order → 405', async () => { assert.strictEqual((await fetch(base() + '/api/order')).status, 405); });

  received.length = 0;
  let firstId, key = crypto.randomUUID();
  await t('корректная заявка → 200, сообщение реально ушло владельцу', async () => {
    const r = await post(order({ idempotencyKey: key, exampleUrl: 'https://www.instagram.com/reel/x' }), { ip: '10.9.9.9' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true); assert.ok(r.body.orderId); firstId = r.body.orderId;
    await new Promise(res => setTimeout(res, 150));
    const toOwner = received.find(m => m.chat_id === OWNER);
    assert.ok(toOwner, 'нет сообщения владельцу');
    assert.ok(toOwner.text.includes(firstId) && toOwner.text.includes('20–30 секунд') && toOwner.text.includes('Срочный монтаж'));
    assert.ok(toOwner.text.includes('&lt;b&gt;Клиент&lt;/b&gt;'), 'HTML пользователя не экранирован');
    assert.ok(toOwner.text.includes('подтверждён Telegram'));
    assert.ok(received.find(m => m.chat_id === 42), 'нет подтверждения клиенту');
  });
  await t('повтор с тем же ключом → тот же номер, второе сообщение не отправлено', async () => {
    const before = received.filter(m => m.chat_id === OWNER).length;
    const r = await post(order({ idempotencyKey: key }), { ip: '10.9.9.9' });
    assert.strictEqual(r.body.orderId, firstId); assert.strictEqual(r.body.duplicate, true);
    assert.strictEqual(received.filter(m => m.chat_id === OWNER).length, before);
  });
  await t('ошибка Telegram API → 502 telegram_error (успех не показывается)', async () => {
    mockFail = true; const r = await post(order({ initData: signInitData({ ...user, id: 43 }) })); mockFail = false;
    assert.strictEqual(r.status, 502); assert.strictEqual(r.body.ok, false);
  });
  await t('лимит: 6-я заявка одного пользователя за 10 минут → 429', async () => {
    const u = { ...user, id: 555 }; const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post(order({ initData: signInitData(u) }))).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429]);
  });
  await t('лимит: 21-й запрос с одного IP → 429', async () => {
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await post(order({ initData: '' }), { ip: '10.7.7.7' })).status);
    assert.strictEqual(codes[20], 429); assert.ok(codes.slice(0, 20).every(c => c === 401));
  });
  await stop(app);

  app = await startApp({ BOT_TOKEN: TOKEN, OWNER_CHAT_ID: OWNER, ALLOW_BROWSER_ORDERS: 'true' });
  await t('ALLOW_BROWSER_ORDERS=true: из браузера нужен контакт', async () => {
    const r = await post(order({ initData: '', contact: '' })); assert.strictEqual(r.status, 400); assert.ok(r.body.fields.contact);
  });
  await t('ALLOW_BROWSER_ORDERS=true: заявка помечена «не подтверждён»', async () => {
    received.length = 0;
    const r = await post(order({ initData: '', contact: '@someone' })); assert.strictEqual(r.status, 200);
    await new Promise(res => setTimeout(res, 100));
    assert.ok(received[0].text.includes('не подтверждён'));
  });
  await stop(app);
  mock.close();

  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(r => r[0] === '❌').length;
  console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
  process.exit(failed ? 1 : 0);
})();
