/* IvanovService Mini App — клиентская логика.
   Здесь НЕТ секретов: токен бота живёт только на сервере (переменная окружения BOT_TOKEN).
   Данные пользователя из Telegram здесь используются только для удобства (подставить контакт).
   Достоверность проверяет сервер по подписи initData. */
(function () {
  'use strict';

  var tg = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined)
    ? window.Telegram.WebApp : null;
  var inTelegram = !!(tg && tg.initData);           // initData пустая, если страница открыта не из Telegram
  var cfg = null;
  var submitting = false;
  var idempotencyKey = newKey();
  var currentScreen = 'home';
  var SCREENS = ['home', 'services', 'portfolio', 'contacts', 'order', 'success', 'error'];
  var TAB_SCREENS = ['home', 'services', 'portfolio', 'contacts'];

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.indexOf('data-') === 0 || k === 'type' || k === 'href' || k === 'src' || k === 'alt' || k === 'loading' || k === 'aria-label') n.setAttribute(k, attrs[k]);
      else n[k] = attrs[k];
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function formatPrice(s) {
    if (s.price === null || s.price === undefined) return 'Индивидуально';
    var n = Number(s.price).toLocaleString('ru-RU').replace(/,/g, ' ');
    return (s.from ? 'от ' : '') + n + ' ' + (cfg.currency || '₽');
  }

  function haptic(type) {
    try {
      if (!tg || !tg.HapticFeedback || !tg.isVersionAtLeast || !tg.isVersionAtLeast('6.1')) return;
      if (type === 'success' || type === 'error' || type === 'warning') tg.HapticFeedback.notificationOccurred(type);
      else tg.HapticFeedback.impactOccurred(type || 'light');
    } catch (e) { /* не критично */ }
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ---------- Открытие ссылок ---------- */
  function openTelegram(username) {
    var url = 'https://t.me/' + encodeURIComponent(username);
    if (tg && tg.openTelegramLink) { try { tg.openTelegramLink(url); return; } catch (e) {} }
    window.open(url, '_blank', 'noopener');
  }
  function openExternal(url) {
    if (tg && tg.openLink) { try { tg.openLink(url); return; } catch (e) {} }
    window.open(url, '_blank', 'noopener');
  }

  /* ---------- Рендер из config.json ---------- */
  var ICONS = {
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/>',
    subs: '<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 14h4M13 14h4M7 10h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    color: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };

  function serviceCard(s) {
    var priceEl = el('span', { class: 'svc-price' + (s.price == null ? ' muted' : ''), text: formatPrice(s) });
    var btn = el('button', { class: 'btn btn-primary', type: 'button', text: 'Выбрать', 'data-service': s.id });
    return el('article', { class: 'glass-card svc' }, [
      el('div', { class: 'svc-top' }, [
        el('div', null, [el('h3', { class: 'svc-title', text: s.title }), el('span', { class: 'svc-dur', text: s.duration })]),
        priceEl
      ]),
      el('p', { class: 'svc-desc', text: s.description }),
      btn
    ]);
  }

  function render() {
    var b = cfg.brand;
    $('#heroText').textContent = b.description;
    $$('.botName').forEach(function (n) { n.textContent = b.bot; });

    var pop = $('#popularList'); pop.textContent = '';
    cfg.services.filter(function (s) { return s.popular; }).forEach(function (s) { pop.appendChild(serviceCard(s)); });

    var all = $('#servicesList'); all.textContent = '';
    cfg.services.forEach(function (s) { all.appendChild(serviceCard(s)); });

    var ex = $('#extrasList'); ex.textContent = '';
    cfg.extras.forEach(function (x) {
      ex.appendChild(el('div', { class: 'extra' }, [el('span', { text: x.title }), el('span', { text: x.price == null ? 'По договорённости' : formatPrice(x) })]));
    });

    var f = $('#featuresList'); f.textContent = '';
    cfg.features.forEach(function (x) {
      var ico = el('span', { class: 'f-ico' }); ico.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[x.icon] || ICONS.bolt) + '</svg>';
      f.appendChild(el('div', { class: 'glass-card feature' }, [ico, el('b', { text: x.title }), el('small', { text: x.text })]));
    });

    var p = $('#portfolioList'); p.textContent = '';
    cfg.portfolio.forEach(function (w) {
      var cover = w.cover
        ? el('img', { class: 'work-cover', src: w.cover, alt: w.title, loading: 'lazy' })
        : el('div', { class: 'work-cover', text: 'Здесь будет обложка' });
      var hasUrl = /^https?:\/\//i.test(w.url || '');
      var btn = el('button', { class: 'btn ' + (hasUrl ? 'btn-primary' : 'btn-glass'), type: 'button', text: hasUrl ? 'Смотреть' : 'Скоро' });
      if (hasUrl) btn.addEventListener('click', function () { openExternal(w.url); });
      else btn.disabled = true;
      p.appendChild(el('article', { class: 'glass-card work' }, [cover, el('div', { class: 'work-body' }, [el('h3', { text: w.title }), el('p', { text: w.description }), btn])]));
    });

    $('#cTelegram').href = 'https://t.me/' + b.ownerTelegram; $('#cTelegramText').textContent = '@' + b.ownerTelegram;
    $('#cBot').href = 'https://t.me/' + b.bot; $('#cBotText').textContent = '@' + b.bot;
    $('#cInsta').href = 'https://www.instagram.com/' + b.instagram + '/'; $('#cInstaText').textContent = '@' + b.instagram;

    var sel = $('#fService'); sel.textContent = '';
    cfg.services.forEach(function (s) { sel.appendChild(el('option', { value: s.id, text: s.title + ' · ' + s.duration })); });
    var dl = $('#fDeadline'); dl.textContent = '';
    cfg.deadlines.forEach(function (d) { dl.appendChild(el('option', { value: d, text: d })); });
    var fx = $('#fExtras'); fx.textContent = '';
    cfg.extras.forEach(function (x) {
      var cb = el('input', { type: 'checkbox', name: 'extras', value: x.id });
      fx.appendChild(el('label', { class: 'check' }, [cb, el('span', { text: x.title }), el('small', { text: x.price == null ? 'По договорённости' : formatPrice(x) })]));
    });
    updateServicePrice();
  }

  function updateServicePrice() {
    var s = cfg.services.filter(function (x) { return x.id === $('#fService').value; })[0];
    $('#servicePrice').textContent = s ? 'Предварительная стоимость: ' + formatPrice(s) : '';
  }

  /* ---------- Навигация (hash-роутер, без перезагрузки) ---------- */
  function go(name, opts) {
    if (SCREENS.indexOf(name) < 0) name = 'home';
    if (location.hash !== '#' + name && !(opts && opts.fromHash)) {
      if (opts && opts.replace) history.replaceState(null, '', '#' + name); else history.pushState(null, '', '#' + name);
    }
    show(name);
  }
  function show(name) {
    currentScreen = name;
    $$('.screen').forEach(function (s) { s.hidden = s.getAttribute('data-screen') !== name; });
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-go') === name); });
    document.body.classList.toggle('hide-tabbar', name === 'order' || name === 'success' || name === 'error');
    window.scrollTo(0, 0);
    syncTelegramButtons();
  }
  var successOrderId = null;   // экран успеха доступен только после подтверждения сервером
  window.addEventListener('popstate', function () {
    var name = location.hash.slice(1) || 'home';
    if ((name === 'success' && !successOrderId) || name === 'error' || SCREENS.indexOf(name) < 0) { go('home', { replace: true }); return; }
    show(name);
  });

  function openOrder(serviceId) {
    if (serviceId) { $('#fService').value = serviceId; updateServicePrice(); }
    go('order');
  }

  /* ---------- Кнопки Telegram ---------- */
  function syncTelegramButtons() {
    if (!tg) return;
    try {
      if (tg.BackButton && tg.isVersionAtLeast('6.1')) {
        if (currentScreen === 'home') tg.BackButton.hide(); else tg.BackButton.show();
      }
      if (tg.MainButton && inTelegram) {
        if (currentScreen === 'order') {
          tg.MainButton.setParams({ text: 'Отправить заявку', color: '#2F6BFF', text_color: '#FFFFFF', is_active: !submitting, is_visible: true });
        } else {
          tg.MainButton.hide();
        }
      }
    } catch (e) { /* старые клиенты */ }
  }

  function initTelegram() {
    if (!tg) { $('#envBadge').hidden = false; return; }
    try {
      tg.ready();
      tg.expand();
      if (tg.isVersionAtLeast('6.1')) { tg.setHeaderColor('#060B1F'); tg.setBackgroundColor('#060B1F'); }
      if (tg.isVersionAtLeast('7.10') && tg.setBottomBarColor) tg.setBottomBarColor('#060B1F');
      document.body.setAttribute('data-scheme', tg.colorScheme || 'dark');
      tg.onEvent('themeChanged', function () { document.body.setAttribute('data-scheme', tg.colorScheme || 'dark'); });
      if (tg.BackButton) tg.BackButton.onClick(function () {
        if (currentScreen === 'success') go('home', { replace: true });
        else if (history.length > 1) history.back();
        else go('home', { replace: true });
      });
      if (tg.MainButton) tg.MainButton.onClick(function () { submitOrder(); });
    } catch (e) { /* продолжаем работать как обычная страница */ }

    if (!inTelegram) { $('#envBadge').hidden = false; return; }
    // В Telegram основная кнопка — системная MainButton, дублирующую кнопку в форме прячем
    $('#submitBtn').hidden = true;

    // Данные пользователя: только для подстановки в поле. Сервер перепроверит подпись.
    var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u) {
      var c = $('#fContact');
      if (!c.value) c.value = u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ');
      $('#contactReq').hidden = true;
      $('#contactHint').textContent = 'Необязательно: я и так увижу ваш Telegram-аккаунт в заявке.';
    }
  }

  /* ---------- Валидация ---------- */
  function validUrl(v) {
    if (!v || v.length > 500) return false;
    try {
      var u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && /\./.test(u.hostname) && !/\s/.test(v);
    } catch (e) { return false; }
  }

  function setError(name, msg) {
    var e = $('.error[data-for="' + name + '"]');
    if (e) { e.textContent = msg || ''; e.closest('.field').classList.toggle('invalid', !!msg); }
  }

  function readForm() {
    var f = $('#orderForm');
    return {
      serviceId: f.serviceId.value,
      sourceUrl: f.sourceUrl.value.trim(),
      exampleUrl: f.exampleUrl.value.trim(),
      description: f.description.value.trim(),
      deadline: f.deadline.value,
      extras: $$('input[name="extras"]:checked', f).map(function (x) { return x.value; }),
      contact: f.contact.value.trim()
    };
  }

  function validate(d) {
    var errs = {};
    if (!d.sourceUrl) errs.sourceUrl = 'Добавьте ссылку на исходники (Яндекс Диск, Google Drive, облако).';
    else if (!validUrl(d.sourceUrl)) errs.sourceUrl = 'Похоже, это не ссылка. Она должна начинаться с https://';
    if (d.exampleUrl && !validUrl(d.exampleUrl)) errs.exampleUrl = 'Ссылка должна начинаться с https:// — или оставьте поле пустым.';
    if (d.description.length < 5) errs.description = 'Опишите задачу хотя бы в нескольких словах.';
    else if (d.description.length > 1000) errs.description = 'Слишком длинно: максимум 1000 символов.';
    var hasTgUser = inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (!hasTgUser && d.contact.length < 2) errs.contact = 'Укажите, как с вами связаться: @username или имя и телефон.';
    if (d.contact.length > 100) errs.contact = 'Максимум 100 символов.';
    ['sourceUrl', 'exampleUrl', 'description', 'contact'].forEach(function (k) { setError(k, errs[k]); });
    return errs;
  }

  /* ---------- Отправка ---------- */
  var ERR_TEXT = {
    network: 'Нет связи с сервером. Проверьте интернет и нажмите «Отправить» ещё раз — заявка не продублируется.',
    timeout: 'Сервер долго не отвечает. Попробуйте ещё раз через минуту.',
    rate_limited: 'Слишком много заявок подряд. Подождите несколько минут.',
    init_data_required: 'Отправка работает только внутри Telegram. Откройте приложение через бота @{bot} или напишите мне напрямую.',
    invalid_init_data: 'Не удалось подтвердить ваш Telegram-аккаунт. Закройте и снова откройте приложение через бота.',
    validation_error: 'Проверьте поля формы.',
    not_configured: 'Приём заявок ещё не настроен. Напишите мне в Telegram напрямую.',
    telegram_error: 'Telegram не принял заявку. Попробуйте ещё раз или напишите мне напрямую.',
    too_large: 'Слишком большой объём текста.',
    server: 'Ошибка на сервере. Попробуйте ещё раз или напишите мне напрямую.'
  };

  function showFormError(code, serverMsg) {
    var t = (ERR_TEXT[code] || serverMsg || ERR_TEXT.server).replace('{bot}', cfg.brand.bot);
    var box = $('#formError'); box.textContent = t; box.hidden = false;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function setLoading(on) {
    submitting = on;
    var b = $('#submitBtn');
    b.classList.toggle('loading', on); b.disabled = on;
    $('.btn-label', b).textContent = on ? 'Отправляю…' : 'Отправить заявку';
    if (tg && inTelegram && tg.MainButton) {
      try { if (on) { tg.MainButton.showProgress(false); tg.MainButton.disable(); } else { tg.MainButton.hideProgress(); tg.MainButton.enable(); } } catch (e) {}
    }
  }

  function submitOrder() {
    if (submitting) return;                    // защита от повторного нажатия
    $('#formError').hidden = true;
    var d = readForm();
    var errs = validate(d);
    var first = Object.keys(errs)[0];
    if (first) {
      haptic('error');
      var inp = $('[name="' + first + '"]'); if (inp) { inp.focus(); inp.scrollIntoView({ block: 'center' }); }
      return;
    }
    d.idempotencyKey = idempotencyKey;
    d.initData = inTelegram ? tg.initData : '';   // подпись Telegram — передаётся как есть, проверяется на сервере

    setLoading(true);
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);

    fetch((cfg.apiBase || '') + '/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, ok: res.ok, body: j }; });
    }).then(function (r) {
      clearTimeout(timer);
      setLoading(false);
      // Успех — ТОЛЬКО когда сервер подтвердил, что Telegram принял сообщение
      if (r.ok && r.body && r.body.ok === true && r.body.orderId) {
        haptic('success');
        successOrderId = r.body.orderId;
        $('#successText').textContent = 'Заявка №' + r.body.orderId + ' доставлена мне в Telegram. Я отвечу вам в личных сообщениях, обычно в течение дня.';
        $('#orderForm').reset(); $('#descCounter').textContent = '0 / 1000';
        if (inTelegram) initTelegramContact();
        idempotencyKey = newKey();
        updateServicePrice();
        go('success', { replace: true });
        return;
      }
      haptic('error');
      var code = (r.body && r.body.error) || (r.status === 429 ? 'rate_limited' : r.status === 413 ? 'too_large' : 'server');
      if (code === 'validation_error' && r.body.fields) Object.keys(r.body.fields).forEach(function (k) { setError(k, r.body.fields[k]); });
      showFormError(code, r.body && r.body.message);
    }).catch(function (e) {
      clearTimeout(timer);
      setLoading(false);
      haptic('error');
      showFormError(e && e.name === 'AbortError' ? 'timeout' : 'network');
    });
  }

  function initTelegramContact() {
    var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u) $('#fContact').value = u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ');
  }

  /* ---------- События ---------- */
  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-go],[data-action],[data-service]');
      if (!t || !cfg) return;
      if (t.hasAttribute('data-service')) { haptic('light'); openOrder(t.getAttribute('data-service')); return; }
      var a = t.getAttribute('data-action');
      if (a === 'order') { haptic('light'); openOrder(); return; }
      if (a === 'telegram') { openTelegram(cfg.brand.ownerTelegram); return; }
      var g = t.getAttribute('data-go');
      if (g) { e.preventDefault(); haptic('light'); go(g); }
    });
    $$('.contact').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var href = a.getAttribute('href');
        if (/^https:\/\/t\.me\//.test(href)) openTelegram(href.replace('https://t.me/', '')); else openExternal(href);
      });
    });
    $('#fService').addEventListener('change', updateServicePrice);
    $('#fDesc').addEventListener('input', function () { $('#descCounter').textContent = this.value.length + ' / 1000'; });
    ['fSource', 'fExample', 'fDesc', 'fContact'].forEach(function (id) {
      $('#' + id).addEventListener('input', function () { setError(this.name, ''); });
    });
    $('#orderForm').addEventListener('submit', function (e) { e.preventDefault(); submitOrder(); });
    $('#reloadBtn').addEventListener('click', function () { location.reload(); });
    $('#closeBtn').addEventListener('click', function () {
      if (inTelegram && tg.close) tg.close(); else go('home', { replace: true });
    });
  }

  /* ---------- Старт ---------- */
  bind();
  initTelegram();
  fetch('config.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('config ' + r.status); return r.json(); })
    .then(function (c) {
      cfg = c;
      render();
      var start = location.hash.slice(1);
      // экран успеха нельзя открыть по ссылке — только после ответа сервера
      if (start === 'success' || start === 'error' || TAB_SCREENS.concat('order').indexOf(start) < 0) start = 'home';
      go(start, { replace: true });
    })
    .catch(function () { show('error'); });
})();
