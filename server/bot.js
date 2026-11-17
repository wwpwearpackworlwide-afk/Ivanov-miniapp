'use strict';
/* Telegram-бот: меню, переписка, заказы и ручная оплата. Секреты приходят только из env.
   Webhook использует durable inbox: update сохраняется до HTTP 200 и восстанавливается после restart. */
const crypto = require('crypto');
const montage = require('./montage-plan');
const { transitionPayment, transitionWork } = require('./order-state');

function createBot({ env, config, appUrl, orders }) {
  const B = config.bot || {}, brand = config.brand;
  const owner = String(env.OWNER_CHAT_ID || '');
  const SECRET = env.WEBHOOK_SECRET || crypto.createHash('sha256').update('webhook:' + env.BOT_TOKEN).digest('hex').slice(0, 48);
  const WEBHOOK_PATH = '/tg/webhook';
  const photoUrl = appUrl + '/assets/welcome.jpg';
  const durable = !!(orders && orders.enqueueTelegramUpdate);
  let photoId = null;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  async function api(method, payload) {
    const res = await fetch(`${env.TELEGRAM_API_BASE}/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(15000)
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || res.status}`);
    return j.result;
  }
  async function sendFile(chatId, filename, content, caption) {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('document', new Blob([content], { type: 'text/javascript' }), filename);
    if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    const res = await fetch(`${env.TELEGRAM_API_BASE}/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error('sendDocument: ' + (j.description || res.status));
    return j.result;
  }
  async function downloadFile(fileId, maxBytes = 1024 * 1024) {
    const f = await api('getFile', { file_id: fileId });
    if (!f.file_path || (f.file_size && f.file_size > maxBytes)) throw new Error('файл слишком большой');
    const res = await fetch(`${env.TELEGRAM_API_BASE}/file/bot${env.BOT_TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('не скачался: ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('файл слишком большой');
    return buf.toString('utf8');
  }

  /* ---------- SRT → черновик плана (только владелец) ---------- */
  const PLAN_HELP = '<b>План ролика из субтитров</b>\n\n1. В CapCut: Текст → Автосубтитры → Экспорт → <b>SRT</b>.\n2. Пришли сюда файл <code>.srt</code> (или вставь текст субтитров сообщением).\n3. Получишь файл плана для движка montazh-remotion: слова с таймкодами, выделение iPhone, сцены P/D/сплит, лого в конце.\n\nПодпись к файлу меняет настройки: <code>16:9</code> — YouTube, <code>клиент</code> — без моего лого, <code>петля</code> — без лого для рилса-петли.\n\nФайл положи в <code>src/plans/</code>, проверь: <code>npm run check src/plans/имя.js</code>.';
  async function makePlan(m, srtText, baseName) {
    const flags = String(m.caption || m.text || '').toLowerCase();
    const cues = montage.parseSrt(srtText);
    if (!cues.length) return api('sendMessage', { chat_id: m.chat.id, text: 'Не нашёл в файле ни одной фразы с таймкодом. Нужен формат SRT: 00:00:01,000 --> 00:00:02,500.' });
    const plan = montage.autoPlan(cues, { format: /16[:x×]9|youtube|ютуб/.test(flags) ? '16x9' : '9x16', client: /клиент/.test(flags), loop: /петл/.test(flags) });
    const sm = montage.summary(plan);
    const name = (baseName || 'plan').replace(/\.[^.]+$/, '').replace(/[^a-z0-9а-яё_-]+/gi, '-').slice(0, 40) || 'plan';
    const caption = `🎬 <b>Черновик плана</b> · ${esc(plan.format.replace('x', ':'))}\nФраз ${cues.length} · сцен ${sm.scenes} · ${sm.total.toFixed(1)} с\nВаше видео ${Math.round(100 - sm.share * 100)}% / motion ${Math.round(sm.share * 100)}%\n${sm.d.length ? `D-сцены: ${esc(sm.d.join(', '))}\n` : ''}\nПроверь хук, тексты D-сцен и цифры — это черновик.`;
    await sendFile(m.chat.id, name + '.js', montage.planToModule(plan), caption);
  }
  async function onOwnerMontage(m) {
    const doc = m.document;
    try {
      if (doc) { await api('sendChatAction', { chat_id: m.chat.id, action: 'upload_document' }).catch(() => {}); return await makePlan(m, await downloadFile(doc.file_id), doc.file_name); }
      return await makePlan(m, m.text, 'plan-' + new Date().toISOString().slice(0, 10));
    } catch (e) { console.error('[bot] plan:', e.message); return api('sendMessage', { chat_id: m.chat.id, text: '⚠️ Не получилось сделать план: ' + e.message }); }
  }

  /* ---------- Тексты и клавиатуры ---------- */
  const price = s => s.price == null ? 'индивидуально' : (s.from ? 'от ' : '') + s.price.toLocaleString('ru-RU').replace(/[\u00a0\u202f ]/g, ' ') + ' ' + config.currency;
  const sections = {
    menu: u => (B.welcome || '').replace('{name}', esc(u.first_name || 'друг')),
    prices: () => {
      const of = cat => config.services.filter(s => (s.cat || 'montage') === cat);
      const old = s => s.oldPrice ? ` <s>${esc(s.oldPrice.toLocaleString('ru-RU').replace(/\u00a0| /g, ' '))} ${esc(config.currency)}</s>` : '';
      const dev = of('dev'), logo = of('logo'), yt = of('youtube');
      return '<b>Цены на монтаж</b>\n\n' + of('montage').map(s => `▸ ${esc(s.duration)} — <b>${esc(price(s))}</b>`).join('\n') +
        '\n\n<b>Дополнительно</b> (по договорённости):\n' + config.extras.map(x => '▸ ' + esc(x.title)).join('\n') +
        (yt.length ? '\n\n<b>YouTube (горизонтальные видео 16:9)</b>\n' + yt.map(s => `▸ ${esc(s.duration)} — <b>${esc(price(s))}</b>`).join('\n') : '') +
        (logo.length ? '\n\n<b>Анимация логотипа</b>\n' + logo.map(s => `▸ ${esc(s.duration)} — <b>${esc(price(s))}</b>`).join('\n') : '') +
        (dev.length ? '\n\n<b>Боты и мини-приложения</b>\n' + dev.map(s => `▸ ${esc(s.title)} — <b>${esc(price(s))}</b>${old(s)}`).join('\n') : '') +
        '\n\nМонтаж зависит только от длины ролика. Подписки на рилсы и YouTube — в Магазине, раздел «Цены» 👇';
    },
    works: () => {
      const real = (config.portfolio || []).filter(w => /^https?:\/\//.test(w.url || ''));
      return '<b>Мои работы</b>\n\n' + (real.length ? real.map(w => `▸ <a href="${esc(w.url)}">${esc(w.title)}</a>`).join('\n') : 'Подборка роликов скоро появится здесь.') + `\n\nСвежие работы — в Instagram <a href="https://www.instagram.com/${esc(brand.instagram)}/">@${esc(brand.instagram)}</a>`;
    },
    howto: () => B.howto || '',
    faq: () => '<b>Частые вопросы</b>\n\n' + (B.faq || []).map(([q, a]) => `<b>${esc(q)}</b>\n${esc(a)}`).join('\n\n'),
    about: () => B.about || '',
    contacts: () => '<b>Контакты</b>\n\n' + `💬 Telegram: @${esc(brand.ownerTelegram)}\n📸 Instagram: @${esc(brand.instagram)}\n\nМожешь написать вопрос прямо сюда, в чат с ботом — я получу его и отвечу.`
  };
  const shopBtn = { text: B.shopButton || '🛍 Магазин', web_app: { url: appUrl } };
  const back = [{ text: '← Назад в меню', callback_data: 'menu' }];
  const keyboards = {
    menu: [[shopBtn], [{ text: '💰 Цены', callback_data: 'prices' }, { text: '🎞 Работы', callback_data: 'works' }], [{ text: '🧭 Как заказать', callback_data: 'howto' }, { text: '❓ Вопросы', callback_data: 'faq' }], [{ text: '👤 Обо мне', callback_data: 'about' }, { text: '📞 Контакты', callback_data: 'contacts' }]],
    prices: [[shopBtn], back], works: [[{ text: '📸 Открыть Instagram', url: `https://www.instagram.com/${brand.instagram}/` }], [shopBtn], back],
    howto: [[shopBtn], back], faq: [[shopBtn], back], about: [[shopBtn], back],
    contacts: [[{ text: '💬 Написать Ивану', url: `https://t.me/${brand.ownerTelegram}` }], [shopBtn], back]
  };
  const markup = name => ({ inline_keyboard: keyboards[name] || keyboards.menu });
  async function sendCard(chatId, name, user) {
    const p = { chat_id: chatId, caption: sections[name](user || {}), parse_mode: 'HTML', reply_markup: markup(name) };
    try { const r = await api('sendPhoto', { ...p, photo: photoId || photoUrl }); if (!photoId && r.photo) photoId = r.photo[r.photo.length - 1].file_id; }
    catch (e) { console.error('[bot] sendPhoto:', e.message, '— отправляю текстом'); await api('sendMessage', { chat_id: chatId, text: p.caption, parse_mode: 'HTML', reply_markup: p.reply_markup, link_preview_options: { is_disabled: true } }); }
  }
  async function showSection(cq, name) {
    const msg = cq.message, caption = sections[name](cq.from);
    try {
      if (msg.photo) await api('editMessageCaption', { chat_id: msg.chat.id, message_id: msg.message_id, caption, parse_mode: 'HTML', reply_markup: markup(name) });
      else await api('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: caption, parse_mode: 'HTML', reply_markup: markup(name), link_preview_options: { is_disabled: true } });
    } catch (e) { if (!/not modified/.test(e.message)) await sendCard(msg.chat.id, name, cq.from); }
  }

  /* ---------- Переписка: только rate-limit Map живёт в памяти ---------- */
  const hits = new Map(), fallbackReplyMap = new Map(), fallbackAwaiting = new Map();
  function limited(id) {
    const now = Date.now(), a = (hits.get(id) || []).filter(t => now - t < 600000);
    if (!hits.has(id) && hits.size >= 5000) {
      for (const [key, values] of hits) if (!values.some(t => now - t < 600000)) hits.delete(key);
      if (hits.size >= 5000) return true;
    }
    a.push(now); hits.set(id, a); return a.length > 15;
  }
  const replyTarget = id => durable ? orders.getReplyTarget(id) : fallbackReplyMap.get(id);
  async function relayToOwner(m) {
    const u = m.from; if (limited(u.id)) return;
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    const head = `✉️ <b>Сообщение от клиента</b>\n${esc(name)}${u.username ? ' (@' + esc(u.username) + ')' : ''}\n<code>#u${u.id}</code>\n\n<i>Ответь на это сообщение (свайп влево → Ответить) — бот перешлёт ответ клиенту.</i>`;
    await api('sendMessage', { chat_id: owner, text: head, parse_mode: 'HTML' });
    const fwd = await api('forwardMessage', { chat_id: owner, from_chat_id: m.chat.id, message_id: m.message_id });
    if (durable) orders.setReplyTarget(fwd.message_id, u.id); else fallbackReplyMap.set(fwd.message_id, u.id);
    await api('sendMessage', { chat_id: m.chat.id, text: '✅ Сообщение передано Ивану. Он ответит здесь или в личных сообщениях.', reply_markup: { inline_keyboard: [[shopBtn], [{ text: '← Меню', callback_data: 'menu_new' }]] } });
  }
  async function ownerReply(m) {
    const r = m.reply_to_message;
    let target = replyTarget(r.message_id) || (r.forward_origin && r.forward_origin.sender_user && r.forward_origin.sender_user.id) || (r.forward_from && r.forward_from.id);
    if (!target) { const mm = String(r.text || r.caption || '').match(/#u(\d+)/); if (mm) target = Number(mm[1]); }
    if (!target) return api('sendMessage', { chat_id: owner, text: 'Не понял, кому ответить. Ответь на сообщение клиента, которое переслал бот.' });
    try { await api('copyMessage', { chat_id: target, from_chat_id: owner, message_id: m.message_id }); await api('sendMessage', { chat_id: owner, text: '✅ Отправлено клиенту', reply_to_message_id: m.message_id }); }
    catch { await api('sendMessage', { chat_id: owner, text: '⚠️ Не удалось отправить: клиент мог остановить бота.' }); }
  }

  /* ---------- Выполнение заказа и подписка ---------- */
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
    if (o && /^sub:/.test(o.serviceId || '') && o.planUntil > Date.now()) rows.push([{ text: '⏹ Отключить план', callback_data: `sp:off:${orderId}:${userId}` }]);
    else if (o && o.pay && o.pay !== 'paid') rows.push([{ text: '💳 Оплата пришла', callback_data: `pay:ok:${orderId}:${userId}` }]);
    else if (isSubOrder(orderId)) rows.push([{ text: '💳 Оплачено — включить план', callback_data: `sp:on:${orderId}:${userId}` }]);
    return { inline_keyboard: rows };
  }
  const PLAN_DAYS = 30;
  function planFor(o, on) {
    const [, planId, level] = o.serviceId.split(':');
    const plan = (SUBS.plans || []).find(p => p.id === planId), lvl = (SUBS.levels || []).find(l => l.id === level);
    const name = plan && lvl ? `${plan.label || plan.title} · ${lvl.title}` : 'подписка';
    const until = on ? Math.max(Date.now(), o.planUntil || 0) + PLAN_DAYS * 86400000 : 0;
    o.planUntil = until;
    return { name, until };
  }
  function applyPlan(o, on) { const result = planFor(o, on); orders.setPlan(o.id, result.until); return result; }
  async function onPlan(cq) {
    const m = String(cq.data).match(/^sp:(on|off):([A-Z0-9]{5,16}):(\d{1,15})$/);
    if (!m || String(cq.from.id) !== owner) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Недоступно' }).catch(() => {});
    const [, act, id, uid] = m, o = orders && orders.get(id);
    if (!o || !/^sub:/.test(o.serviceId || '') || String(o.userId) !== uid) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Заявка не найдена на сервере (мог быть перезапуск). Включить план не получится.', show_alert: true }).catch(() => {});
    const { name, until } = applyPlan(o, act === 'on');
    const date = new Date(until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Novokuznetsk' });
    const text = act === 'on' ? `🎉 Подписка <b>${esc(name)}</b> активна до ${esc(date)}.\n\nПлан виден в приложении: Меню → «Мои заказы».` : `Подписка <b>${esc(name)}</b> отключена. Если это ошибка — просто напишите сюда.`;
    let notified = true;
    try { await api('sendMessage', { chat_id: Number(uid), text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '👤 Мой план', web_app: { url: appUrl + '/#profile' } }]] } }); } catch { notified = false; }
    api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: statusKb(id, uid, o.status) }).catch(() => {});
    api('answerCallbackQuery', { callback_query_id: cq.id, text: (act === 'on' ? `План включён до ${date}` : 'План отключён') + (notified ? ' — клиент уведомлён' : ' — клиенту не дошло') }).catch(() => {});
  }
  async function onStatus(cq) {
    const m = String(cq.data).match(/^st:(work|done|cancel):([A-Z0-9]{5,16}):(\d{1,15})$/);
    if (!m || String(cq.from.id) !== owner) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Недоступно' }).catch(() => {});
    const [, st, id, uid] = m, prev = orders && orders.get(id);
    if (prev && String(prev.userId) !== uid) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Клиент не совпадает с заказом', show_alert: true }).catch(() => {});
    if (prev && prev.status === st) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Статус уже: ' + ST_TEXT[st] }).catch(() => {});
    if (orders) orders.setStatus(id, st, uid);
    let notified = true;
    try { await api('sendMessage', { chat_id: Number(uid), text: ST_CLIENT[st](id), reply_markup: { inline_keyboard: [[{ text: '📋 Мои заказы', web_app: { url: appUrl + '/#profile' } }]] } }); } catch { notified = false; }
    api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: statusKb(id, uid, st) }).catch(() => {});
    api('answerCallbackQuery', { callback_query_id: cq.id, text: `№${id}: ${ST_TEXT[st]}` + (notified ? ' — клиент уведомлён' : ' — клиенту не дошло (бот остановлен)') }).catch(() => {});
  }

  /* ---------- Ручная оплата и append-only аудит ---------- */
  const rub = n => Number(n).toLocaleString('ru-RU') + ' ₽';
  const payBtn = id => ({ inline_keyboard: [[{ text: '💳 Я оплатил', callback_data: `pay:sent:${id}` }]] });
  const reviewKb = (id, uid) => ({ inline_keyboard: [
    [{ text: '✅ Оплата пришла', callback_data: `pay:ok:${id}:${uid}` }, { text: '✖ Не пришла', callback_data: `pay:no:${id}:${uid}` }],
    [{ text: '↻ Запросить чек повторно', callback_data: `pay:again:${id}:${uid}` }, { text: 'ℹ️ Заказ', callback_data: `pay:info:${id}:${uid}` }]
  ] });
  async function requestPayment(id, uid, amount, what) {
    if (!env.PAY_DETAILS) {
      return api('sendMessage', { chat_id: Number(uid), text: `✅ Заявка №${id} получена.\n${esc(what)}\n\n💳 <b>Сумма: ${rub(amount)}</b>\nСтатус: ожидает оплаты.\n\nРеквизиты временно не настроены. Заказ сохранён — свяжитесь с владельцем: @${esc(brand.ownerTelegram)}. Не переводите деньги по реквизитам из непроверенных сообщений.`, parse_mode: 'HTML' });
    }
    const text = `✅ Заявка №${id} получена.\n${esc(what)}\nСтатус: ожидает оплаты.\n\n💳 <b>К оплате: ${rub(amount)}</b>\n\n${esc(env.PAY_DETAILS)}\n\nВ комментарии к переводу укажите: <code>${id}</code>\n\nПосле перевода нажмите «Я оплатил» и пришлите фото или скриншот чека. Скриншот не подтверждает оплату сам по себе — владелец проверит поступление в банке.`;
    return api('sendMessage', { chat_id: Number(uid), text, parse_mode: 'HTML', reply_markup: payBtn(id) });
  }
  function awaitingFor(uid) { return durable ? orders.getAwaitingCheck(uid) : (fallbackAwaiting.has(uid) ? { orderId: fallbackAwaiting.get(uid) } : null); }
  function setAwaiting(uid, id) { if (durable) orders.setAwaitingCheck(uid, id); else fallbackAwaiting.set(uid, id); }
  function clearAwaiting(uid) { if (durable) orders.clearAwaitingCheck(uid); else fallbackAwaiting.delete(uid); }

  async function onPay(cq) {
    const m = String(cq.data).match(/^pay:(sent|ok|no|again|info):([A-Z0-9]{5,16})(?::(\d{1,15}))?$/);
    const ack = (text, alert) => api('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert }).catch(() => {});
    if (!m) return ack('Недоступно');
    const [, act, id, uidS] = m, o = orders && orders.get(id);
    if (act === 'sent') {
      if (!o || o.userId !== cq.from.id) return ack('Заказ не найден. Напишите сюда — разберёмся.', true);
      if (['paid', 'in_progress', 'completed'].includes(o.state)) return ack('Этот заказ уже оплачен ✅');
      if (o.state === 'cancelled') return ack('Заказ отменён. Свяжитесь с владельцем.', true);
      if (o.state !== 'payment_review') orders.update(id, draft => { transitionPayment(draft, 'payment_submitted', { actor: { type: 'customer', id: cq.from.id }, reason: 'Клиент нажал «Я оплатил»; поступление ещё не подтверждено' }); return draft; });
      setAwaiting(cq.from.id, id); ack();
      return api('sendMessage', { chat_id: cq.from.id, text: `Пришлите фото или скриншот чека по заказу №${id} одним сообщением 👇\nJPG, PNG или WEBP, до ${Math.round(env.MAX_RECEIPT_BYTES / 1048576)} МБ.` });
    }
    if (String(cq.from.id) !== owner) return ack('Недоступно');
    const uid = Number(uidS || (o && o.userId));
    if (!o) return ack('Заказ не найден на сервере. Напишите клиенту вручную.', true);
    if (String(o.userId) !== String(uid)) return ack('ID клиента не совпадает с заказом', true);

    if (act === 'info') {
      const title = o.serviceSnapshot ? o.serviceSnapshot.title : o.serviceId;
      await api('sendMessage', { chat_id: owner, text: `ℹ️ <b>Заказ №${id}</b>\n${esc(title || 'Услуга')}\nКлиент: <code>${uid}</code>\nСумма: ${o.amount == null ? 'не согласована' : rub(o.amount)}\nОплата: ${esc(o.paymentStatus)}\nВыполнение: ${esc(o.workStatus)}\nЧеков: ${o.paymentAttempts.length}`, parse_mode: 'HTML' });
      return ack('Информация отправлена');
    }
    if (act === 'ok') {
      if (['paid', 'in_progress', 'completed'].includes(o.state)) return ack('Уже подтверждено');
      if (o.state === 'cancelled') return ack('Отменённый заказ нельзя оплатить', true);
      let extra = '';
      const latest = o.paymentAttempts[o.paymentAttempts.length - 1];
      const message = { idempotencyKey: `payment-paid:${id}`, payload: null };
      orders.updateWithOutbox(id, draft => {
        transitionPayment(draft, 'paid', { actor: { type: 'owner', id: cq.from.id }, reason: latest ? 'Владелец проверил поступление в банке и подтвердил оплату' : 'Владелец подтвердил поступление в банке вручную', receiptId: latest && latest.id });
        transitionWork(draft, 'in_progress', { actor: { type: 'owner', id: cq.from.id }, reason: 'Автоматический переход после подтверждения оплаты' });
        if (/^sub:/.test(draft.serviceId || '')) {
          const p = planFor(draft, true);
          extra = `\n\n🎉 Подписка <b>${esc(p.name)}</b> активна до ${esc(new Date(p.until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Novokuznetsk' }))}.`;
        }
        message.payload = { chat_id: uid, text: `✅ Оплата по заказу №${id} получена${draft.amount ? ' (' + rub(draft.amount) + ')' : ''}. Спасибо!\n\n🛠 Заказ уже в работе — напишу, как только будет готово.${extra}`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📋 Мои заказы', web_app: { url: appUrl + '/#profile' } }]] } };
        return draft;
      }, [message]);
      const notified = await flushOutbox();
      api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✅ Оплачено · в работе', callback_data: 'noop' }]] } }).catch(() => {});
      return ack(`№${id}: оплачено, в работе` + (notified ? ' — клиент уведомлён' : ' — клиенту не дошло; повторим автоматически'));
    }
    if (act === 'no' || act === 'again') {
      if (['paid', 'in_progress', 'completed', 'cancelled'].includes(o.state)) return ack('Статус заказа уже изменён', true);
      const repeat = act === 'again';
      if (o.state === 'payment_rejected' && o.reviewDecision === (repeat ? 'repeat_requested' : 'rejected')) return ack('Решение уже сохранено');
      const reason = repeat ? 'Владелец запросил повторный чек' : 'Платёж не найден в банке; требуется проверка или новый чек';
      const message = { idempotencyKey: `payment-${act}:${id}:${o.paymentHistory.length + 1}`, payload: null };
      orders.updateWithOutbox(id, draft => {
        transitionPayment(draft, 'payment_rejected', { actor: { type: 'owner', id: cq.from.id }, reason, action: repeat ? 'payment.repeat_requested' : 'payment.rejected' });
        draft.reviewDecision = repeat ? 'repeat_requested' : 'rejected';
        message.payload = { chat_id: uid, text: repeat ? `Иван запросил повторный чек по заказу №${id}. Нажмите «Я оплатил» и пришлите новое фото или скриншот.` : `Пока не вижу перевод по заказу №${id}. Проверьте, что он прошёл, и нажмите «Я оплатил» ещё раз — или напишите сюда.`, reply_markup: payBtn(id) };
        return draft;
      }, [message]);
      const notified = await flushOutbox();
      api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: repeat ? '↻ Запрошен новый чек' : '✖ Не подтверждено', callback_data: 'noop' }]] } }).catch(() => {});
      return ack((repeat ? 'Запрошен повторный чек' : 'Оплата отклонена') + (notified ? '' : ' — уведомление в очереди'));
    }
  }

  function receiptFromMessage(m) {
    const max = env.MAX_RECEIPT_BYTES;
    if (Array.isArray(m.photo) && m.photo.length) {
      const p = m.photo[m.photo.length - 1];
      if (!p.file_id || (p.file_size && p.file_size > max)) return { error: 'Фото чека слишком большое.' };
      return { kind: 'photo', fileId: p.file_id, fileUniqueId: p.file_unique_id || null, size: p.file_size || null, width: p.width || null, height: p.height || null, mimeType: 'image/jpeg' };
    }
    const d = m.document;
    if (d) {
      const image = /^image\/(jpeg|png|webp)$/i.test(d.mime_type || '') || /\.(jpe?g|png|webp)$/i.test(d.file_name || '');
      if (!image) return { error: 'Нужен файл изображения JPG, PNG или WEBP.' };
      if (!d.file_id || (d.file_size && d.file_size > max)) return { error: 'Файл чека слишком большой.' };
      return { kind: 'document', fileId: d.file_id, fileUniqueId: d.file_unique_id || null, size: d.file_size || null, mimeType: d.mime_type || 'image/*' };
    }
    return { error: 'Пришлите именно фото/скриншот чека или изображение файлом. Текст и другие документы не принимаются как чек.' };
  }
  async function onCheck(m, id) {
    const o = orders.get(id);
    if (!o || o.userId !== m.from.id) { clearAwaiting(m.from.id); return api('sendMessage', { chat_id: m.chat.id, text: 'Заказ не найден или недоступен.' }); }
    const extracted = receiptFromMessage(m);
    if (extracted.error) return api('sendMessage', { chat_id: m.chat.id, text: extracted.error + ' Ожидание чека сохранено.' });
    const receipt = { id: crypto.randomUUID(), ...extracted, orderId: id, userId: m.from.id, messageId: m.message_id, chatId: m.chat.id, submittedAt: new Date().toISOString(), status: 'submitted' };
    orders.update(id, draft => {
      const duplicate = draft.paymentAttempts.some(r => r.chatId === m.chat.id && r.messageId === m.message_id);
      if (!duplicate) {
        draft.paymentAttempts.push(receipt);
        if (draft.state !== 'payment_review') transitionPayment(draft, 'payment_review', { actor: { type: 'customer', id: m.from.id }, reason: 'Получено изображение чека; требуется проверка владельцем', receiptId: receipt.id });
        else draft.auditLog.push({ at: receipt.submittedAt, actor: { type: 'customer', id: String(m.from.id) }, action: 'payment.receipt_added', reason: 'Дополнительный чек к тому же заказу', receiptId: receipt.id });
      }
      return draft;
    });
    const saved = orders.get(id), savedReceipt = saved.paymentAttempts.find(r => r.chatId === m.chat.id && r.messageId === m.message_id) || receipt;
    const u = m.from, name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    await api('sendMessage', { chat_id: owner, parse_mode: 'HTML',
      text: `💳 <b>Чек по заказу №${id}</b>${saved.amount ? ' · ' + rub(saved.amount) : ''}\n${esc(name)}${u.username ? ' (@' + esc(u.username) + ')' : ''}\nID чека: <code>${savedReceipt.id}</code>\n\nСкриншот — не доказательство оплаты. Проверь поступление в банке (комментарий <code>${id}</code>) и нажми кнопку 👇`,
      reply_markup: reviewKb(id, u.id) });
    await api('forwardMessage', { chat_id: owner, from_chat_id: m.chat.id, message_id: m.message_id });
    await api('sendMessage', { chat_id: m.chat.id, text: `🧾 Чек по заказу №${id} получен и передан на проверку. Как только Иван подтвердит поступление в банке, я напишу.` });
    clearAwaiting(m.from.id);
  }
  async function ownerPayCmd(m, text) {
    const mm = text.match(/^\/pay\s+([A-Z0-9]{5,16})\s+(\d{2,7})$/i);
    if (!mm) return api('sendMessage', { chat_id: m.chat.id, text: 'Формат: /pay НОМЕР_ЗАКАЗА СУММА\nНапример: /pay LX3K9A1B2 4500' });
    if (!env.PAY_DETAILS) return api('sendMessage', { chat_id: m.chat.id, text: '⚠️ Реквизиты не заданы: добавь переменную PAY_DETAILS в настройках Render.' });
    const id = mm[1].toUpperCase(), amount = Number(mm[2]), o = orders.get(id);
    if (!o) return api('sendMessage', { chat_id: m.chat.id, text: 'Заказ не найден (мог быть перезапуск сервера).' });
    orders.update(id, draft => { draft.amount = amount; draft.pricing = { ...(draft.pricing || {}), total: amount, manuallyAgreed: true, agreedAt: new Date().toISOString(), agreedBy: String(m.from.id) }; if (draft.state !== 'pending_payment') transitionPayment(draft, 'pending_payment', { actor: { type: 'owner', id: m.from.id }, reason: 'Владелец обновил согласованную сумму' }); return draft; });
    try { await requestPayment(id, o.userId, amount, 'Сумма к оплате согласована'); }
    catch { return api('sendMessage', { chat_id: m.chat.id, text: '⚠️ Клиенту не дошло: он мог остановить бота.' }); }
    return api('sendMessage', { chat_id: m.chat.id, text: `✅ Счёт на ${rub(amount)} по заказу №${id} отправлен клиенту.` });
  }

  /* ---------- Durable outbox: финансовые уведомления не теряются ---------- */
  let flushing = null;
  async function flushOutbox() {
    if (!durable) return true;
    if (flushing) return flushing;
    flushing = (async () => {
      let all = true;
      for (const item of orders.dueOutbox()) {
        try { await api(item.method, item.payload); orders.markOutboxSent(item.id); }
        catch (e) { all = false; orders.markOutboxFailed(item.id, e); }
      }
      return all;
    })();
    try { return await flushing; } finally { flushing = null; }
  }

  /* ---------- Обработка updates ---------- */
  const COMMANDS = { '/start': 'menu', '/menu': 'menu', '/price': 'prices', '/prices': 'prices', '/portfolio': 'works', '/works': 'works', '/order': 'howto', '/howto': 'howto', '/faq': 'faq', '/about': 'about', '/contacts': 'contacts' };
  async function onUpdate(up) {
    if (up.callback_query) {
      const cq = up.callback_query;
      if (/^st:/.test(cq.data || '')) return onStatus(cq);
      if (/^sp:/.test(cq.data || '')) return onPlan(cq);
      if (/^pay:/.test(cq.data || '')) return onPay(cq);
      if (cq.data === 'noop') return api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      if (cq.data === 'menu_new') return sendCard(cq.message.chat.id, 'menu', cq.from);
      if (sections[cq.data]) return showSection(cq, cq.data);
      return;
    }
    const m = up.message;
    if (!m || !m.from || m.chat.type !== 'private') return;
    const isOwner = String(m.from.id) === owner, text = (m.text || '').trim();
    const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : null;
    if (cmd === '/shop') return api('sendMessage', { chat_id: m.chat.id, text: '🛍 Магазин открывается по кнопке ниже:', reply_markup: { inline_keyboard: [[shopBtn]] } });
    if (cmd && COMMANDS[cmd]) return sendCard(m.chat.id, COMMANDS[cmd], m.from);
    if (m.web_app_data) return;
    if (isOwner) {
      if (cmd === '/plan') return api('sendMessage', { chat_id: m.chat.id, text: PLAN_HELP, parse_mode: 'HTML' });
      if (cmd === '/pay') return ownerPayCmd(m, text);
      const isSrtDoc = m.document && (/\.srt$/i.test(m.document.file_name || '') || /subrip/i.test(m.document.mime_type || ''));
      if (!m.reply_to_message && (isSrtDoc || montage.looksLikeSrt(text))) return onOwnerMontage(m);
      if (m.reply_to_message) return ownerReply(m);
      return api('sendMessage', { chat_id: m.chat.id, text: 'Это вы — владелец бота 🙂 Чтобы ответить клиенту, ответьте (Reply) на его пересланное сообщение.\n\n🎬 Пришлите субтитры .srt из CapCut — сделаю черновик плана ролика. Подробнее: /plan' });
    }
    if (cmd) return sendCard(m.chat.id, 'menu', m.from);
    const awaiting = awaitingFor(m.from.id);
    if (awaiting) return onCheck(m, awaiting.orderId);
    return relayToOwner(m);
  }

  const scheduled = new Set();
  async function processTelegramUpdate(key) {
    scheduled.delete(key);
    const current = orders.getTelegramRecord(key);
    if (!current || current.status === 'done') return;
    try {
      const record = orders.markUpdateProcessing(key);
      await onUpdate(record.update);
      orders.markUpdateDone(key);
    } catch (e) {
      try { orders.markUpdateFailed(key, e); } catch (storeError) { orders.releaseUpdate(key); console.error('[bot] inbox persist:', storeError.message); }
      console.error('[bot] update будет повторён:', String(e.message || e).replace(env.BOT_TOKEN, '***'));
    }
  }
  function scheduleUpdate(key) { if (!scheduled.has(key)) { scheduled.add(key); setImmediate(() => processTelegramUpdate(key)); } }
  function recoverTelegramUpdates() { if (durable) for (const record of orders.dueTelegramUpdates()) scheduleUpdate(record.key); }

  function handleWebhook(req, res) {
    const given = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || '')), want = Buffer.from(SECRET);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { res.writeHead(401); return res.end(); }
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size <= 512 * 1024) chunks.push(c); });
    req.on('end', () => {
      if (size > 512 * 1024) { res.writeHead(413); return res.end(); }
      let up; try { up = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"ok":false}'); }
      if (!durable) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
        onUpdate(up).catch(e => console.error('[bot]', e.message)); return;
      }
      try {
        const saved = orders.enqueueTelegramUpdate(up); // sync + fsync + rename ДО ACK
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
        scheduleUpdate(saved.key);
      } catch (e) {
        console.error('[bot] inbox не сохранён, ACK не отправлен:', e.message);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); }
      }
    });
  }

  async function setup() {
    const url = appUrl + WEBHOOK_PATH, info = await api('getWebhookInfo');
    await api('setWebhook', { url, secret_token: SECRET, allowed_updates: ['message', 'callback_query'], max_connections: 20 });
    if (info.url !== url) console.log('[bot] webhook установлен:', url);
    await api('setMyCommands', { commands: [
      { command: 'start', description: 'Главное меню' }, { command: 'shop', description: 'Магазин — заказать монтаж' },
      { command: 'price', description: 'Цены' }, { command: 'portfolio', description: 'Мои работы' },
      { command: 'order', description: 'Как заказать' }, { command: 'faq', description: 'Частые вопросы' },
      { command: 'about', description: 'Обо мне' }, { command: 'contacts', description: 'Контакты' }
    ] });
    if (owner) await api('setMyCommands', { scope: { type: 'chat', chat_id: Number(owner) }, commands: [
      { command: 'plan', description: '🎬 План ролика из субтитров .srt' }, { command: 'pay', description: '💳 Выставить счёт: /pay НОМЕР СУММА' },
      { command: 'start', description: 'Главное меню' }, { command: 'shop', description: 'Магазин' }
    ] }).catch(e => console.error('[bot] команды владельца:', e.message));
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: appUrl } } });
    console.log('[bot] команды и кнопка «Магазин» настроены');
  }

  if (durable) {
    setImmediate(() => { recoverTelegramUpdates(); flushOutbox(); });
    setInterval(() => { recoverTelegramUpdates(); flushOutbox(); }, 2000).unref();
  }
  return { WEBHOOK_PATH, handleWebhook, setup, onUpdate, statusKb, requestPayment, recoverTelegramUpdates, flushOutbox, _secret: SECRET };
}

module.exports = { createBot };
