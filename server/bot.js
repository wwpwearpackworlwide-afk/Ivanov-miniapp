'use strict';
/* Бот @IvanovServiceBot: команды, меню-карточка с картинкой, Магазин (Mini App),
   пересылка сообщений клиентов владельцу и ответы владельца клиентам через бота.
   Работает через webhook на этом же сервере. Тексты — в public/config.json → "bot". */
const crypto = require('crypto');

function createBot({ env, config, appUrl, orders }) {
  const B = config.bot || {};
  const brand = config.brand;
  const owner = String(env.OWNER_CHAT_ID || '');
  const SECRET = env.WEBHOOK_SECRET || crypto.createHash('sha256').update('webhook:' + env.BOT_TOKEN).digest('hex').slice(0, 48);
  const WEBHOOK_PATH = '/tg/webhook';
  const photoUrl = appUrl + '/assets/welcome.jpg';
  let photoId = null;               // после первой отправки Telegram даёт file_id — дальше шлём по нему (быстрее)

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function api(method, payload) {
    const res = await fetch(`${env.TELEGRAM_API_BASE}/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(15000)
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || res.status}`);
    return j.result;
  }

  /* ---------- Тексты разделов ---------- */
  const price = s => s.price == null ? 'индивидуально' : (s.from ? 'от ' : '') + s.price.toLocaleString('ru-RU').replace(/ /g, ' ') + ' ' + config.currency;
  const sections = {
    menu: u => (B.welcome || '').replace('{name}', esc(u.first_name || 'друг')),
    prices: () => {
      const of = cat => config.services.filter(s => (s.cat || 'montage') === cat);
      const old = s => s.oldPrice ? ` <s>${esc(s.oldPrice.toLocaleString('ru-RU').replace(/\u00a0| /g, ' '))} ${esc(config.currency)}</s>` : '';
      const dev = of('dev'), logo = of('logo');
      return '<b>Цены на монтаж</b>\n\n' +
        of('montage').map(s => `▸ ${esc(s.duration)} — <b>${esc(price(s))}</b>`).join('\n') +
        '\n\n<b>Дополнительно</b> (по договорённости):\n' + config.extras.map(x => '▸ ' + esc(x.title)).join('\n') +
        (logo.length ? '\n\n<b>Анимация логотипа</b>\n' + logo.map(s => `▸ ${esc(s.duration)} — <b>${esc(price(s))}</b>`).join('\n') : '') +
        (dev.length ? '\n\n<b>Боты и мини-приложения</b>\n' + dev.map(s => `▸ ${esc(s.title)} — <b>${esc(price(s))}</b>${old(s)}`).join('\n') : '') +
        '\n\nМонтаж зависит только от длины ролика. Заказ — в Магазине 👇';
    },
    works: () => {
      const real = (config.portfolio || []).filter(w => /^https?:\/\//.test(w.url || ''));
      return '<b>Мои работы</b>\n\n' + (real.length
        ? real.map(w => `▸ <a href="${esc(w.url)}">${esc(w.title)}</a>`).join('\n')
        : 'Подборка роликов скоро появится здесь.') +
        `\n\nСвежие работы — в Instagram <a href="https://www.instagram.com/${esc(brand.instagram)}/">@${esc(brand.instagram)}</a>`;
    },
    howto: () => B.howto || '',
    faq: () => '<b>Частые вопросы</b>\n\n' + (B.faq || []).map(([q, a]) => `<b>${esc(q)}</b>\n${esc(a)}`).join('\n\n'),
    about: () => B.about || '',
    contacts: () => '<b>Контакты</b>\n\n' +
      `💬 Telegram: @${esc(brand.ownerTelegram)}\n📸 Instagram: @${esc(brand.instagram)}\n\n` +
      'Можешь написать вопрос прямо сюда, в чат с ботом — я получу его и отвечу.'
  };

  /* ---------- Клавиатуры ---------- */
  const shopBtn = { text: B.shopButton || '🛍 Магазин', web_app: { url: appUrl } };
  const back = [{ text: '← Назад в меню', callback_data: 'menu' }];
  const keyboards = {
    menu: [
      [shopBtn],
      [{ text: '💰 Цены', callback_data: 'prices' }, { text: '🎞 Работы', callback_data: 'works' }],
      [{ text: '🧭 Как заказать', callback_data: 'howto' }, { text: '❓ Вопросы', callback_data: 'faq' }],
      [{ text: '👤 Обо мне', callback_data: 'about' }, { text: '📞 Контакты', callback_data: 'contacts' }]
    ],
    prices: [[shopBtn], back],
    works: [[{ text: '📸 Открыть Instagram', url: `https://www.instagram.com/${brand.instagram}/` }], [shopBtn], back],
    howto: [[shopBtn], back],
    faq: [[shopBtn], back],
    about: [[shopBtn], back],
    contacts: [[{ text: '💬 Написать Ивану', url: `https://t.me/${brand.ownerTelegram}` }], [shopBtn], back]
  };
  const markup = name => ({ inline_keyboard: keyboards[name] || keyboards.menu });

  async function sendCard(chatId, name, user) {
    const p = { chat_id: chatId, caption: sections[name](user || {}), parse_mode: 'HTML', reply_markup: markup(name) };
    try {
      const r = await api('sendPhoto', { ...p, photo: photoId || photoUrl });
      if (!photoId && r.photo) photoId = r.photo[r.photo.length - 1].file_id;
    } catch (e) {
      console.error('[bot] sendPhoto:', e.message, '— отправляю текстом');
      await api('sendMessage', { chat_id: chatId, text: p.caption, parse_mode: 'HTML', reply_markup: p.reply_markup, link_preview_options: { is_disabled: true } });
    }
  }

  // Навигация внутри одной карточки: меняем подпись под картинкой
  async function showSection(cq, name) {
    const msg = cq.message;
    const caption = sections[name](cq.from);
    try {
      if (msg.photo) await api('editMessageCaption', { chat_id: msg.chat.id, message_id: msg.message_id, caption, parse_mode: 'HTML', reply_markup: markup(name) });
      else await api('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: caption, parse_mode: 'HTML', reply_markup: markup(name), link_preview_options: { is_disabled: true } });
    } catch (e) {
      if (!/not modified/.test(e.message)) await sendCard(msg.chat.id, name, cq.from);
    }
  }

  /* ---------- Пересылка сообщений ---------- */
  const hits = new Map();
  function limited(id) {
    const now = Date.now(); const a = (hits.get(id) || []).filter(t => now - t < 10 * 60 * 1000);
    a.push(now); hits.set(id, a); return a.length > 15;
  }

  async function relayToOwner(m) {
    const u = m.from;
    if (limited(u.id)) return;
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    const head = `✉️ <b>Сообщение от клиента</b>\n${esc(name)}${u.username ? ' (@' + esc(u.username) + ')' : ''}\n<code>#u${u.id}</code>\n\n` +
      '<i>Ответь на это сообщение (свайп влево → Ответить) — бот перешлёт ответ клиенту.</i>';
    await api('sendMessage', { chat_id: owner, text: head, parse_mode: 'HTML' });
    const fwd = await api('forwardMessage', { chat_id: owner, from_chat_id: m.chat.id, message_id: m.message_id });
    // запоминаем, кому принадлежит пересланное сообщение (на случай скрытого профиля у клиента)
    replyMap.set(fwd.message_id, u.id);
    await api('sendMessage', { chat_id: m.chat.id, text: '✅ Сообщение передано Ивану. Он ответит здесь или в личных сообщениях.', reply_markup: { inline_keyboard: [[shopBtn], [{ text: '← Меню', callback_data: 'menu_new' }]] } });
  }
  const replyMap = new Map();

  async function ownerReply(m) {
    const r = m.reply_to_message;
    let target = replyMap.get(r.message_id) || (r.forward_origin && r.forward_origin.sender_user && r.forward_origin.sender_user.id) || (r.forward_from && r.forward_from.id);
    if (!target) { const mm = String(r.text || r.caption || '').match(/#u(\d+)/); if (mm) target = Number(mm[1]); }
    if (!target) return api('sendMessage', { chat_id: owner, text: 'Не понял, кому ответить. Ответь на сообщение клиента, которое переслал бот.' });
    try {
      await api('copyMessage', { chat_id: target, from_chat_id: owner, message_id: m.message_id });
      await api('sendMessage', { chat_id: owner, text: '✅ Отправлено клиенту', reply_to_message_id: m.message_id });
    } catch (e) {
      await api('sendMessage', { chat_id: owner, text: '⚠️ Не удалось отправить: клиент мог остановить бота.' });
    }
  }

  /* ---------- Статусы заказов (кнопки под заявкой у владельца) ---------- */
  const ST_TEXT = { work: 'В работе', done: 'Готово', cancel: 'Отменён' };
  const ST_CLIENT = {
    work: id => `🛠 Заказ №${id} взят в работу. Я напишу, как только будет готово.`,
    done: id => `✅ Заказ №${id} готов! Ссылку на результат пришлю в личные сообщения.\n\nСтатус виден в приложении: Меню → «Мои заказы».`,
    cancel: id => `Заказ №${id} отменён. Если это ошибка — просто напишите сюда.`
  };
  const SUBS = config.subscriptions || { plans: [], levels: [] };
  const isSubOrder = id => { const o = orders && orders.get(id); return !!(o && /^sub:/.test(o.serviceId || '')); };
  function statusKb(orderId, userId, current) {
    const b = (st, text) => ({ text: (current === st ? '• ' : '') + text, callback_data: `st:${st}:${orderId}:${userId}` });
    const rows = [[b('work', '🛠 В работу'), b('done', '✅ Готово')], [b('cancel', '✖ Отменить')]];
    const o = orders && orders.get(orderId);
    if (isSubOrder(orderId)) {
      rows.push(o.planUntil > Date.now()
        ? [{ text: '⏹ Отключить план', callback_data: `sp:off:${orderId}:${userId}` }]
        : [{ text: '💳 Оплачено — включить план', callback_data: `sp:on:${orderId}:${userId}` }]);
    }
    return { inline_keyboard: rows };
  }

  /* ---------- План подписки: включает только владелец после получения оплаты ---------- */
  const PLAN_DAYS = 30;
  async function onPlan(cq) {
    const m = String(cq.data).match(/^sp:(on|off):([A-Z0-9]{5,16}):(\d{1,15})$/);
    if (!m || String(cq.from.id) !== owner) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Недоступно' }).catch(() => {});
    const [, act, id, uid] = m;
    const o = orders && orders.get(id);
    if (!o || !/^sub:/.test(o.serviceId || '') || String(o.userId) !== uid) {
      return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Заявка не найдена на сервере (мог быть перезапуск). Включить план не получится.', show_alert: true }).catch(() => {});
    }
    const [, planId, level] = o.serviceId.split(':');
    const plan = (SUBS.plans || []).find(p => p.id === planId), lvl = (SUBS.levels || []).find(l => l.id === level);
    const name = plan && lvl ? `${plan.title} · ${lvl.title}` : 'подписка';
    let until = 0;
    if (act === 'on') {
      const base = Math.max(Date.now(), o.planUntil || 0);      // повторная оплата продлевает, а не сбрасывает
      until = base + PLAN_DAYS * 24 * 3600 * 1000;
    }
    orders.setPlan(id, until);
    const date = new Date(until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Novokuznetsk' });
    const text = act === 'on'
      ? `🎉 Подписка <b>${esc(name)}</b> активна до ${esc(date)}.\n\nПлан виден в приложении: Меню → «Мои заказы».`
      : `Подписка <b>${esc(name)}</b> отключена. Если это ошибка — просто напишите сюда.`;
    let notified = true;
    try { await api('sendMessage', { chat_id: Number(uid), text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '👤 Мой план', web_app: { url: appUrl + '/#profile' } }]] } }); }
    catch (e) { notified = false; }
    api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: statusKb(id, uid, o.status) }).catch(() => {});
    api('answerCallbackQuery', { callback_query_id: cq.id, text: (act === 'on' ? `План включён до ${date}` : 'План отключён') + (notified ? ' — клиент уведомлён' : ' — клиенту не дошло') }).catch(() => {});
  }
  async function onStatus(cq) {
    const m = String(cq.data).match(/^st:(work|done|cancel):([A-Z0-9]{5,16}):(\d{1,15})$/);
    if (!m || String(cq.from.id) !== owner) {
      return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Недоступно' }).catch(() => {});
    }
    const [, st, id, uid] = m;
    const prev = orders && orders.get(id);
    if (prev && prev.status === st) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Статус уже: ' + ST_TEXT[st] }).catch(() => {});
    if (orders) orders.setStatus(id, st, uid);
    let notified = true;
    try { await api('sendMessage', { chat_id: Number(uid), text: ST_CLIENT[st](id), reply_markup: { inline_keyboard: [[{ text: '📋 Мои заказы', web_app: { url: appUrl + '/#profile' } }]] } }); }
    catch (e) { notified = false; }
    api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: statusKb(id, uid, st) }).catch(() => {});
    api('answerCallbackQuery', { callback_query_id: cq.id, text: `№${id}: ${ST_TEXT[st]}` + (notified ? ' — клиент уведомлён' : ' — клиенту не дошло (бот остановлен)') }).catch(() => {});
  }

  /* ---------- Обработка обновлений ---------- */
  const COMMANDS = { '/start': 'menu', '/menu': 'menu', '/price': 'prices', '/prices': 'prices', '/portfolio': 'works', '/works': 'works',
    '/order': 'howto', '/howto': 'howto', '/faq': 'faq', '/about': 'about', '/contacts': 'contacts' };

  async function onUpdate(up) {
    if (up.callback_query) {
      const cq = up.callback_query;
      if (/^st:/.test(cq.data || '')) return onStatus(cq);
      if (/^sp:/.test(cq.data || '')) return onPlan(cq);
      api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      if (cq.data === 'menu_new') return sendCard(cq.message.chat.id, 'menu', cq.from);
      if (sections[cq.data]) return showSection(cq, cq.data);
      return;
    }
    const m = up.message;
    if (!m || !m.from || m.chat.type !== 'private') return;
    const isOwner = String(m.from.id) === owner;
    const text = (m.text || '').trim();
    const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : null;

    if (cmd === '/shop') return api('sendMessage', { chat_id: m.chat.id, text: '🛍 Магазин открывается по кнопке ниже:', reply_markup: { inline_keyboard: [[shopBtn]] } });
    if (cmd && COMMANDS[cmd]) return sendCard(m.chat.id, COMMANDS[cmd], m.from);
    if (m.web_app_data) return; // данные из Mini App обрабатывает /api/order
    if (isOwner) {
      if (m.reply_to_message) return ownerReply(m);
      return api('sendMessage', { chat_id: m.chat.id, text: 'Это вы — владелец бота 🙂 Чтобы ответить клиенту, ответьте (Reply) на его пересланное сообщение.' });
    }
    if (cmd) return sendCard(m.chat.id, 'menu', m.from);
    return relayToOwner(m);
  }

  /* ---------- HTTP-вход для Telegram ---------- */
  function handleWebhook(req, res) {
    const given = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
    const want = Buffer.from(SECRET);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { res.writeHead(401); return res.end(); }
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size <= 512 * 1024) chunks.push(c); });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');   // отвечаем сразу, обрабатываем после
      if (size > 512 * 1024) return;
      let up; try { up = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
      onUpdate(up).catch(e => console.error('[bot]', e.message));
    });
  }

  /* ---------- Регистрация в Telegram при запуске ---------- */
  async function setup() {
    const url = appUrl + WEBHOOK_PATH;
    const info = await api('getWebhookInfo');
    if (info.url !== url) {
      await api('setWebhook', { url, secret_token: SECRET, allowed_updates: ['message', 'callback_query'], max_connections: 20 });
      console.log('[bot] webhook установлен:', url);
    } else {
      // секрет мог поменяться — переустанавливаем без сброса очереди
      await api('setWebhook', { url, secret_token: SECRET, allowed_updates: ['message', 'callback_query'], max_connections: 20 });
    }
    await api('setMyCommands', { commands: [
      { command: 'start', description: 'Главное меню' },
      { command: 'shop', description: 'Магазин — заказать монтаж' },
      { command: 'price', description: 'Цены' },
      { command: 'portfolio', description: 'Мои работы' },
      { command: 'order', description: 'Как заказать' },
      { command: 'faq', description: 'Частые вопросы' },
      { command: 'about', description: 'Обо мне' },
      { command: 'contacts', description: 'Контакты' }
    ] });
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: appUrl } } });
    console.log('[bot] команды и кнопка «Магазин» настроены');
  }

  return { WEBHOOK_PATH, handleWebhook, setup, onUpdate, statusKb, _secret: SECRET };
}

module.exports = { createBot };
