/* IvanovService Mini App v2 — клиентская логика.
   Здесь НЕТ секретов: токен бота живёт только на сервере (переменная окружения BOT_TOKEN).
   Данные пользователя из Telegram используются только для удобства (имя, аватар, подставить контакт).
   Достоверность проверяет сервер по подписи initData. Успех заявки показывается только после ответа сервера. */
(function () {
  'use strict';

  var tg = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined)
    ? window.Telegram.WebApp : null;
  var inTelegram = !!(tg && tg.initData);           // initData пустая, если страница открыта не из Telegram
  var reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var cfg = null;
  var submitting = false;
  var idempotencyKey = newKey();
  var currentScreen = 'home';
  var successOrderId = null;                          // экран успеха доступен только после подтверждения сервером
  var SCREENS = ['login', 'home', 'prices', 'works', 'contacts', 'about', 'collabs', 'howto', 'faq', 'profile', 'order', 'success', 'error'];
  var MENU_SCREENS = ['about', 'collabs', 'howto', 'faq', 'profile'];
  var menuOpen = false;
  var TAB_SCREENS = ['home', 'prices', 'works', 'contacts'];
  var HUE = { profile: 12, home: 0, prices: 0, works: 14, contacts: -10, about: -8, collabs: -22, howto: 8, faq: 4, order: 0, success: 0, error: 0, login: 0 };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var easeOut = function (t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); };
  var easeInOut = function (t) { t = clamp(t, 0, 1); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'style') n.setAttribute('style', attrs[k]);
      else if (k.indexOf('data-') === 0 || k.indexOf('aria-') === 0 || ['type', 'href', 'src', 'alt', 'loading', 'role', 'tabindex', 'value', 'label'].indexOf(k) >= 0) n.setAttribute(k, attrs[k]);
      else n[k] = attrs[k];
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function icon(id, cls) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); if (cls) s.setAttribute('class', cls);
    var u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + id); s.appendChild(u); return s;
  }

  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function num(n) { return Number(n).toLocaleString('ru-RU').replace(/[\s  ]/g, ' '); }
  function formatPrice(s) {
    if (s.price === null || s.price === undefined) return 'Индивидуально';
    return (s.from ? 'от ' : '') + num(s.price) + ' ' + (cfg.currency || '₽');
  }
  function svc(id) { return cfg.services.filter(function (s) { return s.id === id; })[0]; }
  function catOf(id) { var s = svc(id); return s ? (s.cat || 'montage') : 'montage'; }
  /* ---------- Подписки: все цифры — в config.json → subscriptions ---------- */
  function SUBS() { return cfg.subscriptions || { plans: [], levels: [] }; }
  function planOf(id) { return SUBS().plans.filter(function (p) { return p.id === id; })[0]; }
  function levelOf(id) { return SUBS().levels.filter(function (l) { return l.id === id; })[0]; }
  function subPrice(planId, level) { var p = planOf(planId); return p && p.price ? num(p.price[level]) + ' ' + (cfg.currency || '₽') + '/' + (SUBS().period || 'мес') : ''; }
  function parseSubId(id) { var m = /^sub:([a-z0-9_-]+):([a-z0-9_-]+)$/.exec(id || ''); return m ? { planId: m[1], level: m[2] } : null; }
  function subTitle(sub) { var p = planOf(sub.planId), l = levelOf(sub.level); return p && l ? 'Подписка ' + p.title + ' · ' + l.title : 'Подписка'; }
  function servicesOf(cat) { return cfg.services.filter(function (s) { return (s.cat || 'montage') === cat; }); }

  function haptic(type) {
    try {
      if (!tg || !tg.HapticFeedback || !tg.isVersionAtLeast || !tg.isVersionAtLeast('6.1')) return;
      if (type === 'success' || type === 'error' || type === 'warning') tg.HapticFeedback.notificationOccurred(type);
      else if (type === 'select') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred(type || 'light');
    } catch (e) { /* не критично */ }
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  var store = {   // localStorage/sessionStorage могут быть недоступны — приложение работает и без них
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };

  /* ---------- Открытие ссылок ---------- */
  function openTelegramPath(path) {
    if (!/^[A-Za-z0-9_]{3,64}(\/[A-Za-z0-9_]{1,64})?$/.test(path)) return;
    var url = 'https://t.me/' + path;
    if (tg && tg.openTelegramLink) { try { tg.openTelegramLink(url); return; } catch (e) {} }
    window.open(url, '_blank', 'noopener');
  }
  function openExternal(url) {
    if (/^https:\/\/t\.me\/[A-Za-z0-9_\/]+$/.test(url)) return openTelegramPath(url.replace('https://t.me/', ''));
    if (tg && tg.openLink) { try { tg.openLink(url); return; } catch (e) {} }
    window.open(url, '_blank', 'noopener');
  }

  /* =====================================================================
     3D-ЛОГОТИП: два стеклянных клипа и плейхед собираются из граней (CSS 3D)
     ===================================================================== */
  var logos = [];
  function buildBox(node) {
    var d = node.getAttribute('data-box').split(',').map(Number), w = d[0], h = d[1], z = d[2];
    node.style.width = w + 'px'; node.style.height = h + 'px'; node.style.left = -w / 2 + 'px'; node.style.top = -h / 2 + 'px';
    [['', w, h, 0, 0, 'translateZ(' + z / 2 + 'px)'],
     ['', w, h, 0, 0, 'rotateY(180deg) translateZ(' + z / 2 + 'px)'],
     ['side', z, h, (w - z) / 2, 0, 'rotateY(90deg) translateZ(' + w / 2 + 'px)'],
     ['side', z, h, (w - z) / 2, 0, 'rotateY(-90deg) translateZ(' + w / 2 + 'px)'],
     ['top', w, z, 0, (h - z) / 2, 'rotateX(90deg) translateZ(' + h / 2 + 'px)'],
     ['side', w, z, 0, (h - z) / 2, 'rotateX(-90deg) translateZ(' + h / 2 + 'px)']
    ].forEach(function (f) {
      var i = document.createElement('i'); if (f[0]) i.className = f[0];
      i.style.width = f[1] + 'px'; i.style.height = f[2] + 'px'; i.style.left = f[3] + 'px'; i.style.top = f[4] + 'px'; i.style.transform = f[5];
      node.appendChild(i);
    });
  }
  function mountLogo(slot, opts) {
    var frag = $('#logo3dTpl').content.cloneNode(true);
    slot.appendChild(frag);
    $$('[data-box]', slot).forEach(buildBox);
    var L = { slot: slot, root: $('.l3d', slot), a: $('.clip-a', slot), b: $('.clip-b', slot), ph: $('.playhead', slot),
      shadow: $('.l3d-shadow', slot), scale: opts.scale || 1, intro: opts.intro ? performance.now() : 0, drag: 0, dragV: 0, pressed: false };
    // перетаскивание пальцем — логотип крутится и плавно возвращается
    var lastX = 0;
    slot.addEventListener('pointerdown', function (e) { L.pressed = true; lastX = e.clientX; L.dragV = 0; });
    window.addEventListener('pointermove', function (e) { if (!L.pressed) return; var dx = e.clientX - lastX; lastX = e.clientX; L.drag += dx * 0.6; L.dragV = dx * 0.6; });
    window.addEventListener('pointerup', function () { L.pressed = false; });
    logos.push(L);
    return L;
  }
  var tilt = { x: 0, y: 0 };      // наклон телефона (если доступен)
  function poseLogo(L, t, scrollP) {
    var introP = L.intro ? easeOut((performance.now() - L.intro) / 1400) : 1;
    if (!L.pressed) { L.drag *= 0.92; }
    var ry = (reduceMotion ? -18 : Math.sin(t * 0.55) * 24 - 10) + L.drag + tilt.y * 18;
    var rx = (reduceMotion ? -10 : -10 + Math.sin(t * 0.8) * 4) + tilt.x * 10;
    var fy = reduceMotion ? 0 : Math.sin(t * 1.2) * 6;
    var sep = (1 - introP) * 140 + (scrollP || 0) * 22;
    var sc = L.scale * (1 - (scrollP || 0) * 0.22);
    L.root.style.transform = 'translateY(' + (fy - (scrollP || 0) * 40) + 'px) scale(' + sc + ') rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
    L.a.style.transform = 'translate3d(' + (-70 - sep) + 'px,' + ((1 - introP) * -30) + 'px,0) rotateZ(' + ((1 - introP) * -25) + 'deg)';
    L.b.style.transform = 'translate3d(' + (72 + sep) + 'px,' + ((1 - introP) * 30) + 'px,0) rotateZ(' + ((1 - introP) * 25) + 'deg)';
    L.ph.style.transform = 'translate3d(' + (reduceMotion ? 0 : Math.sin(t * 0.9) * 6) + 'px,' + ((1 - introP) * -160) + 'px,24px)';
    L.ph.style.opacity = introP;
    L.slot.style.opacity = 1 - (scrollP || 0) * 0.5;
    L.shadow.style.transform = 'scale(' + (1 - fy / 60) + ')';
  }

  function initTilt() {
    if (reduceMotion) return;
    try {
      if (tg && tg.DeviceOrientation && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0')) {
        tg.DeviceOrientation.start({ refresh_rate: 60 });
        tg.onEvent('deviceOrientationChanged', function () {
          var o = tg.DeviceOrientation;            // радианы
          tilt.y = clamp((o.gamma || 0) / 0.8, -1, 1); tilt.x = clamp(((o.beta || 0) - 0.7) / 0.8, -1, 1);
        });
        return;
      }
    } catch (e) {}
    window.addEventListener('deviceorientation', function (e) {
      if (e.gamma == null) return;
      tilt.y = clamp(e.gamma / 45, -1, 1); tilt.x = clamp(((e.beta || 0) - 40) / 45, -1, 1);
    });
  }

  /* =====================================================================
     РАБОТЫ: 3D-телефон с роликами, свайп и переворот
     ===================================================================== */
  var works = { list: [], idx: 0, filter: 'all', flip: null, drag: 0, pressed: false, startX: 0 };
  function filteredWorks() {
    return cfg.portfolio.filter(function (w) { return works.filter === 'all' || w.cat === works.filter; });
  }
  function setWorkMedia(w) {
    var front = $('.p-front'), v = $('#phoneVideo'), img = $('#phoneImg');
    var poster = w.preview ? w.preview.replace(/\.mp4$/, '.jpg') : '';
    img.src = poster || w.cover || 'assets/icon.png';
    v.poster = poster;
    img.onerror = function () { img.onerror = null; img.src = 'assets/icon.png'; };
    if (w.preview && !reduceMotion) {
      front.classList.remove('no-video');
      if (v.getAttribute('src') !== w.preview) { v.src = w.preview; }
      if (currentScreen === 'works') { var p = v.play(); if (p && p.catch) p.catch(function () { front.classList.add('no-video'); }); }
    } else {
      front.classList.add('no-video'); v.pause(); v.removeAttribute('src'); try { v.load(); } catch (e) {}
    }
  }
  function renderWorkInfo(w, animate) {
    $('#wTag').textContent = w.tag || '';
    $('#wTitle').textContent = w.title;
    $('#wDesc').textContent = w.description || '';
    var b = $('#wOpen'), has = /^https?:\/\//i.test(w.url || '');
    b.disabled = !has; b.textContent = has ? (/t\.me\//.test(w.url) ? 'Открыть в Telegram' : /youtu/.test(w.url) ? 'Смотреть на YouTube' : 'Смотреть') : 'Скоро';
    b.className = 'btn btn-wide ' + (has ? 'btn-primary' : 'btn-glass');
    var info = $('#workInfo');
    if (animate) { info.classList.remove('swap'); void info.offsetWidth; info.classList.add('swap'); }
    $$('#workDots i').forEach(function (d, i) { d.classList.toggle('on', i === works.idx); });
    $$('#workGrid .tile').forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-id') === w.id); });
  }
  function selectWork(i, dir) {
    var list = works.list; if (!list.length) return;
    i = (i + list.length) % list.length;
    if (i === works.idx && !dir) { renderWorkInfo(list[i], false); return; }
    var w = list[i]; works.idx = i;
    haptic('select');
    if (reduceMotion || !dir) { setWorkMedia(w); renderWorkInfo(w, !reduceMotion); return; }
    works.flip = { start: performance.now(), dir: dir, swapped: false, w: w };
    renderWorkInfo(w, true);
  }
  function rebuildWorks(keepId) {
    works.list = filteredWorks();
    var dots = $('#workDots'); dots.textContent = '';
    works.list.forEach(function () { dots.appendChild(el('i')); });
    var idx = 0; works.list.forEach(function (w, i) { if (w.id === keepId) idx = i; });
    works.idx = idx;
    $$('#workGrid .tile').forEach(function (t) {
      var w = cfg.portfolio.filter(function (x) { return x.id === t.getAttribute('data-id'); })[0];
      t.hidden = !(works.filter === 'all' || w.cat === works.filter);
    });
    if (works.list.length) { setWorkMedia(works.list[idx]); renderWorkInfo(works.list[idx], true); }
  }
  function poseWorks(t) {
    var ph = $('#phone3d'); if (!ph) return;
    var ry = reduceMotion ? -14 : Math.sin(t * 0.5) * 16 - 6 + tilt.y * 14;
    var rx = reduceMotion ? 4 : 4 + Math.sin(t * 0.7) * 3 + tilt.x * 6;
    var fy = reduceMotion ? 0 : Math.sin(t * 1.1) * 7;
    if (!works.pressed) works.drag *= 0.88;
    var flipA = 0, sc = 1;
    if (works.flip) {
      var p = (performance.now() - works.flip.start) / 750;
      flipA = easeInOut(p) * 360 * works.flip.dir;
      sc = 1 - Math.sin(clamp(p, 0, 1) * Math.PI) * 0.12;
      if (p >= 0.5 && !works.flip.swapped) { works.flip.swapped = true; setWorkMedia(works.flip.w); }
      if (p >= 1) works.flip = null;
    }
    ph.style.transform = 'translateY(' + fy + 'px) scale(' + sc + ') rotateX(' + rx + 'deg) rotateY(' + (ry + works.drag + flipA) + 'deg)';
    var sh = $('.stage-shadow'); sh.style.transform = 'scale(' + (1 - fy / 70) * sc + ')'; sh.style.opacity = 0.9 - fy / 40;
  }
  function bindVideoFallback() {
    // если видео не может играть (нет кодека, экономия трафика) — показываем обложку
    $('#phoneVideo').addEventListener('error', function () { $('.p-front').classList.add('no-video'); });
  }
  function bindStage() {
    bindVideoFallback();
    var st = $('#stage');
    st.addEventListener('pointerdown', function (e) { if (e.target.closest('.nav-btn')) return; works.pressed = true; works.startX = e.clientX; works.lastX = e.clientX; });
    window.addEventListener('pointermove', function (e) { if (!works.pressed) return; works.drag += (e.clientX - works.lastX) * 0.5; works.lastX = e.clientX; });
    window.addEventListener('pointerup', function (e) {
      if (!works.pressed) return; works.pressed = false;
      var dx = e.clientX - works.startX;
      if (Math.abs(dx) > 50) selectWork(works.idx + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    });
  }

  /* ---------- главный цикл анимации (работает только когда виден 3D) ---------- */
  var rafOn = false;
  function frame(now) {
    var t = now / 1000;
    var scrollP = currentScreen === 'home' ? clamp(window.scrollY / 260, 0, 1) : 0;
    logos.forEach(function (L) { if (L.slot.offsetParent !== null) poseLogo(L, t, L.slot.classList.contains('hero-logo') ? scrollP : 0); });
    if (currentScreen === 'works') poseWorks(t);
    if (!reduceMotion && !document.hidden && needsLoop()) requestAnimationFrame(frame); else rafOn = false;
  }
  function needsLoop() { return currentScreen === 'home' || currentScreen === 'works' || currentScreen === 'login'; }
  function kick() {
    if (reduceMotion) { requestAnimationFrame(frame); return; }   // одна статичная поза
    if (!rafOn && needsLoop()) { rafOn = true; requestAnimationFrame(frame); }
  }
  document.addEventListener('visibilitychange', kick);

  /* ---------- появление при прокрутке + счётчики цен ---------- */
  var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { show_(e.target); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' }) : null;
  function show_(n) {
    n.classList.add('in');
    $$('[data-count]', n).concat(n.hasAttribute('data-count') ? [n] : []).forEach(countUp);
  }
  function observe(root) {
    $$('.reveal:not(.in)', root || document).forEach(function (n) { if (io && !reduceMotion) io.observe(n); else show_(n); });
  }
  function countUp(n) {
    if (n.__counted) return; n.__counted = true;
    var to = Number(n.getAttribute('data-count')), pre = n.getAttribute('data-pre') || '', suf = ' ' + (cfg.currency || '₽');
    if (reduceMotion) { n.textContent = pre + num(to) + suf; return; }
    var t0 = performance.now();
    (function step(now) {
      var p = easeOut((now - t0) / 800);
      n.textContent = pre + num(Math.round(to * p / 10) * 10) + suf;
      if (p < 1) requestAnimationFrame(step); else n.textContent = pre + num(to) + suf;
    })(t0);
  }

  /* =====================================================================
     Рендер из config.json
     ===================================================================== */
  var selectedMontage = null, currentCat = 'montage';

  function priceSpan(s, cls) {
    var sp = el('span', { class: cls || 'pr', text: formatPrice(s) });
    if (s.price != null) { sp.setAttribute('data-count', s.price); if (s.from) sp.setAttribute('data-pre', 'от '); }
    return sp;
  }

  function render() {
    var b = cfg.brand;
    $('#heroText').textContent = b.description;
    $$('.botName').forEach(function (n) { n.textContent = b.bot; });

    // приветствие (данные только для отображения)
    var h = new Date().getHours();
    var greet = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
    var u = inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user;
    $('#greet').textContent = greet + ' 👋';
    if (u) {
      $('#userName').textContent = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'друг';
      var av = $('#avatar'); av.textContent = (u.first_name || '?').charAt(0).toUpperCase();
      if (/^https:\/\//.test(u.photo_url || '')) { var im = new Image(); im.onload = function () { av.textContent = ''; av.style.backgroundImage = 'url("' + u.photo_url.replace(/"/g, '') + '")'; }; im.src = u.photo_url; }
    } else { $('#userName').textContent = 'IvanovService'; }

    // категории на главной
    var cl = $('#catList'); cl.textContent = '';
    cfg.categories.forEach(function (c, i) {
      var list = servicesOf(c.id); if (!list.length) return;
      var min = list.reduce(function (m, s) { return s.price != null && s.price < m ? s.price : m; }, Infinity);
      var tile = el('span', { class: 'ico-tile' + (i === 1 ? ' c-gold' : i === 2 ? ' c-sky' : '') }, [icon(c.home.icon)]);
      var pr = el('span', { class: 'pr', text: 'от ' + num(min) + ' ₽', 'data-count': min, 'data-pre': 'от ' });
      cl.appendChild(el('button', { class: 'row' + (i === 0 ? ' on' : ''), type: 'button', 'data-cat': c.id }, [tile,
        el('span', { class: 'rt' }, [el('b', { text: c.home.title }), el('small', { text: c.home.sub })]), pr, el('span', { class: 'chev', text: '›' })]));
    });
    if (SUBS().plans.length) {
      var minSub = SUBS().plans.reduce(function (m, p) { return Math.min(m, p.price.standard); }, Infinity);
      cl.appendChild(el('button', { class: 'row', type: 'button', 'data-mode-open': 'subs' }, [el('span', { class: 'ico-tile blue' }, [icon('subs')]),
        el('span', { class: 'rt' }, [el('b', { text: 'Подписки на монтаж' }), el('small', { text: 'Ролики каждый месяц' })]),
        el('span', { class: 'pr', text: 'от ' + num(minSub) + ' ₽' }), el('span', { class: 'chev', text: '›' })]));
    }

    // работы на главной
    var hw = $('#homeWorks'); hw.textContent = '';
    cfg.portfolio.forEach(function (w) {
      var img = el('img', { src: w.cover, alt: '', loading: 'lazy' });
      img.addEventListener('error', function () { img.src = 'assets/icon.png'; }, { once: true });
      hw.appendChild(el('button', { class: 'hcard glass', type: 'button', 'data-work': w.id }, [img, el('span', { text: w.title })]));
    });
    renderReviews();

    // что входит
    var f = $('#featuresList'); f.textContent = '';
    cfg.features.forEach(function (x, i) {
      f.appendChild(el('div', { class: 'glass feature reveal', style: '--d:' + i }, [el('span', { class: 'ico-tile' }, [icon(x.icon)]), el('b', { text: x.title }), el('small', { text: x.text })]));
    });

    // цены: сегменты
    var seg = $('#seg'); $$('button', seg).forEach(function (n) { n.remove(); });
    cfg.categories.forEach(function (c) { seg.appendChild(el('button', { type: 'button', role: 'tab', 'data-seg': c.id, 'aria-selected': 'false', text: c.title })); });

    // монтаж
    var ml = $('#montageList'); ml.textContent = '';
    var montage = servicesOf('montage');
    selected.montage = selectedMontage = (montage.filter(function (s) { return s.id === 's30'; })[0] || montage[0] || {}).id;
    montage.forEach(function (s, i) {
      ml.appendChild(el('button', { class: 'row reveal', style: '--d:' + i, type: 'button', role: 'radio', 'data-pick': s.id, 'aria-checked': 'false' }, [
        el('span', { class: 'ico-tile' }, [icon('clock')]),
        el('span', { class: 'rt' }, [el('b', { text: s.duration }), el('small', { text: s.title })]), priceSpan(s)]));
    });
    $('#extrasNote').textContent = cfg.extras.map(function (x) { return x.title; }).join(', ') + ' — по договорённости.';
    pick(selectedMontage, true);

    // логотип
    var lg = $('#logoList'); lg.textContent = '';
    var logoS = servicesOf('logo');
    selected.logo = (logoS[0] || {}).id;
    logoS.forEach(function (s, i) {
      lg.appendChild(el('button', { class: 'row reveal', style: '--d:' + i, type: 'button', role: 'radio', 'data-pick': s.id, 'aria-checked': 'false' }, [
        el('span', { class: 'ico-tile' }, [icon('clock')]),
        el('span', { class: 'rt' }, [el('b', { text: s.duration }), el('small', { text: s.description })]), priceSpan(s)]));
    });
    pick(selected.logo, true);

    // разработка
    var dev = servicesOf('dev'), bundle = dev.filter(function (s) { return s.oldPrice; })[0];
    var bc = $('#bundleCard'); bc.textContent = '';
    if (bundle) {
      bc.appendChild(el('div', { class: 'top' }, [el('span', { class: 'pill gold', text: 'Выгода ' + num(bundle.oldPrice - bundle.price) + ' ₽' }), el('small', { text: bundle.duration })]));
      bc.appendChild(el('h3', { text: bundle.title }));
      bc.appendChild(el('div', { class: 'prices' }, [priceSpan(bundle, 'big-price'), el('s', { text: num(bundle.oldPrice) + ' ₽' })]));
      (bundle.features || []).forEach(function (t) { bc.appendChild(el('div', { class: 'feat' }, [el('i'), t])); });
      bc.appendChild(el('button', { class: 'btn btn-light', type: 'button', 'data-service': bundle.id, text: 'Обсудить проект →' }));
    }
    bc.hidden = !bundle;
    var dl = $('#devList'); dl.textContent = '';
    dev.filter(function (s) { return s !== bundle; }).forEach(function (s) {
      dl.appendChild(el('button', { class: 'row', type: 'button', 'data-service': s.id }, [
        el('span', { class: 'ico-tile c-sky' }, [icon(s.id === 'bot' ? 'bot' : 'app')]),
        el('span', { class: 'rt' }, [el('b', { text: s.title }), el('small', { text: s.duration })]), priceSpan(s), el('span', { class: 'chev', text: '›' })]));
    });

    renderSubs();

    // работы
    var fl = $('#workFilters'); fl.textContent = '';
    (cfg.workFilters || [{ id: 'all', title: 'Все' }]).forEach(function (x) {
      var has = x.id === 'all' || cfg.portfolio.some(function (w) { return w.cat === x.id; });
      if (has) fl.appendChild(el('button', { class: 'chip', type: 'button', role: 'tab', 'data-filter': x.id, 'aria-selected': x.id === 'all' ? 'true' : 'false', text: x.title }));
    });
    var g = $('#workGrid'); g.textContent = '';
    cfg.portfolio.forEach(function (w, i) {
      var img = el('img', { src: w.cover, alt: '', loading: 'lazy' });
      img.addEventListener('error', function () { img.src = 'assets/icon.png'; }, { once: true });
      var kids = [img, el('span', { class: 'tt' }, [w.title, el('small', { text: w.tag || '' })])];
      if (w.isNew) kids.push(el('span', { class: 'pill blue badge', text: 'Новое' }));
      else if (!/^https?:\/\//.test(w.url || '')) kids.push(el('span', { class: 'pill st badge', text: 'Скоро' }));
      g.appendChild(el('button', { class: 'tile glass reveal', style: '--d:' + (i % 2), type: 'button', 'data-id': w.id }, kids));
    });
    rebuildWorks(cfg.portfolio[0] && cfg.portfolio[0].id);

    // меню и новые разделы
    $('#drOwner').textContent = b.ownerName || 'IvanovService';
    $('#ownerName').textContent = b.ownerName || 'IvanovService';
    $('#drWorks').textContent = cfg.portfolio.length;
    $('#drCollabs').textContent = (cfg.collabs || []).length;
    $$('#drawer .dr-head, #drawer .dr-lbl, #drawer .row, #drawer .dr-social, #drawer .dr-cta').forEach(function (n, i) { n.style.setProperty('--i', i); });
    var pages = cfg.pages || {};
    var at = $('#aboutText'); at.textContent = '';
    (pages.about || []).forEach(function (t, i) { at.appendChild(el('p', { class: 'about-p reveal', style: '--d:' + (i + 1), text: t })); });
    var hl = $('#howtoList'); hl.textContent = '';
    (pages.howto || []).forEach(function (st, i) {
      hl.appendChild(el('li', { class: 'step reveal', style: '--d:' + i }, [el('span', { class: 'n', text: String(i + 1) }), el('span', { class: 'tx' }, [el('b', { text: st[0] }), el('small', { text: st[1] })])]));
    });
    var fq = $('#faqList'); fq.textContent = '';
    ((cfg.bot && cfg.bot.faq) || []).forEach(function (qa, i) {
      fq.appendChild(el('details', { class: 'qa glass reveal', style: '--d:' + i }, [el('summary', { text: qa[0] }), el('p', { text: qa[1] })]));
    });
    var clist = $('#collabList'); clist.textContent = '';
    (cfg.collabs || []).forEach(function (cb, i) {
      var v = el('video', { 'aria-label': 'Анимация коллаборации: ' + cb.name });
      v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.preload = 'metadata';
      if (cb.poster) v.poster = cb.poster;
      v.setAttribute('data-src', cb.video || '');
      var kids = [el('div', { class: 'vid' }, [v]), el('div', { class: 'body' }, [
        el('h3', { text: cb.name }), cb.sub ? el('p', { class: 'sub', text: cb.sub }) : null,
        (cb.did && cb.did.length) ? el('div', { class: 'tags' }, cb.did.map(function (d) { return el('span', { class: 'pill', text: d }); })) : null,
        /^https?:\/\//.test(cb.url || '') ? el('button', { class: 'btn btn-primary', type: 'button', 'data-url': cb.url, text: 'Смотреть ролик' }) : null])];
      clist.appendChild(el('article', { class: 'collab glass reveal', style: '--d:' + i }, kids));
    });

    // контакты
    $('#cTelegram').href = 'https://t.me/' + b.ownerTelegram; $('#cTelegramText').textContent = '@' + b.ownerTelegram;
    $('#cBot').href = 'https://t.me/' + b.bot; $('#cBotText').textContent = '@' + b.bot;
    $('#cInsta').href = 'https://www.instagram.com/' + b.instagram + '/'; $('#cInstaText').textContent = '@' + b.instagram;

    // форма
    var sel = $('#fService'); sel.textContent = '';
    cfg.categories.forEach(function (c) {
      var og = el('optgroup', { label: c.title });
      servicesOf(c.id).forEach(function (s) { og.appendChild(el('option', { value: s.id, text: s.title + (s.cat === 'montage' ? ' · ' + s.duration : '') + ' — ' + formatPrice(s) })); });
      sel.appendChild(og);
    });
    var dd = $('#fDeadline'); dd.textContent = '';
    cfg.deadlines.forEach(function (d) { dd.appendChild(el('option', { value: d, text: d })); });
    var fx = $('#fExtras'); fx.textContent = '';
    cfg.extras.forEach(function (x) {
      var cb = el('input', { type: 'checkbox', name: 'extras', value: x.id });
      fx.appendChild(el('label', { class: 'check' }, [cb, el('span', { text: x.title }), el('small', { text: x.price == null ? 'По договорённости' : formatPrice(x) })]));
    });
    onServiceChange();
    observe();
  }

  /* ---------- Подписки: карточки тарифов ---------- */
  var priceMode = 'once';
  var subSel = {};           // planId -> выбранный уровень анимации
  var orderSub = null;       // { planId, level } — если оформляется подписка
  function renderSubs() {
    var S = SUBS(), list = $('#planList'); if (!list) return; list.textContent = '';
    $('#modeSeg').hidden = !S.plans.length;
    $('#subsSub').textContent = S.subtitle || '';
    var lg = $('#lvlLegend'); lg.textContent = '';
    S.levels.forEach(function (l) { lg.appendChild(el('div', { class: 'lvl-note' }, [el('b', { text: l.title }), el('small', { text: l.short || '' })])); });
    S.plans.forEach(function (p, i) {
      if (!subSel[p.id]) subSel[p.id] = S.levels[0].id;
      var lvl = el('div', { class: 'lvl-seg', role: 'radiogroup', 'aria-label': 'Уровень Motion Design для ' + p.title }, S.levels.map(function (l) {
        return el('button', { type: 'button', role: 'radio', 'data-plan': p.id, 'data-lvl': l.id, 'aria-checked': 'false', text: l.title });
      }));
      var card = el('article', { class: 'plan glass reveal', style: '--d:' + i, 'data-plan-card': p.id }, [
        el('div', { class: 'plan-top' }, [el('h3', { text: p.title }), el('span', { class: 'pill', text: p.videos + ' роликов/' + (S.period || 'мес') })]),
        el('p', { class: 'plan-meta', text: 'До ' + p.maxSec + ' секунд каждый ролик' }),
        lvl,
        el('div', { class: 'plan-price' }, [el('b', { class: 'pp' }), el('small', { text: 'в месяц' })]),
        el('ul', { class: 'plan-feat' }),
        el('div', { class: 'plan-terms' }),
        el('button', { class: 'btn btn-primary btn-wide', type: 'button', 'data-sub-order': p.id, text: 'Оформить заказ' })
      ]);
      list.appendChild(card);
      setLevel(p.id, subSel[p.id], true);
    });
  }
  function setLevel(planId, level, silent) {
    var p = planOf(planId), l = levelOf(level); if (!p || !l) return;
    subSel[planId] = level;
    var card = $('[data-plan-card="' + planId + '"]'); if (!card) return;
    $$('.lvl-seg button', card).forEach(function (b) { var on = b.getAttribute('data-lvl') === level; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.classList.toggle('on', on); });
    card.classList.toggle('adv', level !== SUBS().levels[0].id);
    $('.pp', card).textContent = num(p.price[level]) + ' ' + (cfg.currency || '₽');
    var ul = $('.plan-feat', card); ul.textContent = '';
    l.features.forEach(function (f) { ul.appendChild(el('li', null, [icon('check'), el('span', { text: f })])); });
    $('.plan-terms', card).textContent = 'Итого: ' + p.title + ' · ' + l.title + ' — ' + p.videos + ' роликов до ' + p.maxSec + ' с за ' + subPrice(planId, level) + '.';
    if (!silent) haptic('select');
  }
  function setMode(mode) {
    if (!SUBS().plans.length) mode = 'once';
    priceMode = mode;
    $$('#modeSeg button').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-mode') === mode ? 'true' : 'false'); });
    $('.mode-thumb').style.transform = 'translateX(' + (mode === 'subs' ? 100 : 0) + '%)';
    $('#oncePane').hidden = mode !== 'once';
    $('#subsPane').hidden = mode !== 'subs';
    $('#priceCta').hidden = mode === 'subs' || currentCat === 'dev';
    if (mode === 'subs') { $('#logoVideo').pause(); observe($('#subsPane')); document.documentElement.style.setProperty('--hue', '0deg'); }
    else selectCat(currentCat, false);
  }
  function openSubOrder(planId) {
    var level = subSel[planId]; if (!planOf(planId) || !levelOf(level)) return;
    orderSub = { planId: planId, level: level };
    applyOrderMode();
    go('order');
  }
  function applyOrderMode() {
    var box = $('#subSummary');
    $('#serviceField').hidden = !!orderSub;
    if (!orderSub) { box.hidden = true; onServiceChange(); return; }
    var p = planOf(orderSub.planId), l = levelOf(orderSub.level);
    box.textContent = '';
    box.appendChild(el('div', { class: 'ss-top' }, [el('span', { class: 'label', text: 'Выбранная подписка' }), el('button', { class: 'link-btn', type: 'button', 'data-mode-open': 'subs', text: 'Изменить' })]));
    box.appendChild(el('b', { text: p.title + ' · ' + l.title }));
    box.appendChild(el('small', { text: p.videos + ' роликов в месяц, до ' + p.maxSec + ' секунд каждый' }));
    box.appendChild(el('div', { class: 'ss-price', text: subPrice(p.id, l.id) }));
    box.hidden = false;
    $('#sourceLabel').textContent = 'Ссылка на материалы (если уже есть)'; $('#fSource').placeholder = 'необязательно'; $('#sourceReq').hidden = true;
    $('#fDesc').placeholder = 'О чём ваши ролики, для какой площадки, что важно';
    var ef = $('#extrasField'); ef.hidden = true; $$('input[name="extras"]', ef).forEach(function (c) { c.checked = false; });
    $('#servicePrice').textContent = '';
    setError('sourceUrl', '');
  }

  /* ---------- Мой план (включается после оплаты — кнопкой владельца в боте) ---------- */
  var PLAN_KEY = 'plan_v1';
  function showPlan(plan) {
    var ok = plan && plan.until > Date.now() && planOf(plan.planId) && levelOf(plan.level);
    var hb = $('#homePlan'), pc = $('#planCard');
    if (!ok) { hb.hidden = true; pc.hidden = true; return; }
    var p = planOf(plan.planId), l = levelOf(plan.level);
    hb.textContent = p.title; hb.hidden = false;
    pc.textContent = '';
    pc.appendChild(el('div', { class: 'pl-top' }, [el('span', { class: 'plan-badge big', text: p.title }), el('span', { class: 'pill', text: l.title })]));
    pc.appendChild(el('b', { text: 'Подписка активна' }));
    pc.appendChild(el('small', { text: p.videos + ' роликов в месяц, до ' + p.maxSec + ' с · до ' + fmtDate(plan.until) }));
    pc.hidden = false;
  }
  function cachedPlan() { try { return JSON.parse(localStorage.getItem(PLAN_KEY) || 'null'); } catch (e) { return null; } }
  function storePlan(plan) { try { if (plan) localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); else localStorage.removeItem(PLAN_KEY); } catch (e) {} }

  var selected = { montage: null, logo: null };
  function updateCta() {
    var s = svc(selected[currentCat] || selected.montage);
    if (s) $('#priceCtaBtn').textContent = 'Оформить · ' + formatPrice(s);
  }
  function pick(id, silent) {
    var cat = catOf(id); selected[cat] = id; if (cat === 'montage') selectedMontage = id;
    $$('#' + (cat === 'logo' ? 'logoList' : 'montageList') + ' .row').forEach(function (r) { var on = r.getAttribute('data-pick') === id; r.classList.toggle('on', on); r.setAttribute('aria-checked', on ? 'true' : 'false'); r.querySelector('.ico-tile').replaceChildren(icon(on ? 'check' : 'clock')); });
    updateCta();
    if (!silent) haptic('select');
  }

  function selectCat(id, animate) {
    var cats = cfg.categories.map(function (c) { return c.id; });
    if (cats.indexOf(id) < 0) id = cats[0];
    var dir = cats.indexOf(id) >= cats.indexOf(currentCat) ? 1 : -1;
    currentCat = id;
    var i = cats.indexOf(id);
    $('.seg-thumb').style.transform = 'translateX(' + (i * 100) + '%)';
    $$('#seg button').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-seg') === id ? 'true' : 'false'); });
    $$('.cat-pane').forEach(function (p) {
      var on = p.getAttribute('data-pane') === id; p.hidden = !on;
      if (on && animate) { p.style.setProperty('--dx', (dir * 28) + 'px'); p.style.animation = 'none'; void p.offsetWidth; p.style.animation = ''; observe(p); $$('[data-count]', p).forEach(function (n) { n.__counted = false; if (n.closest('.reveal') === null || n.closest('.reveal').classList.contains('in')) countUp(n); }); }
    });
    var c = cfg.categories[i]; $('#catSub').textContent = c.subtitle;
    $('#priceCta').hidden = id === 'dev' || priceMode === 'subs';
    updateCta();
    document.documentElement.style.setProperty('--hue', (id === 'logo' ? -18 : id === 'dev' ? 16 : 0) + 'deg');
    var v = $('#logoVideo'); if (id === 'logo' && currentScreen === 'prices' && !reduceMotion) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause();
  }

  function onServiceChange() {
    if (orderSub) return;
    var s = svc($('#fService').value); if (!s) return;
    $('#fDesc').placeholder = 'Что нужно сделать, для какой площадки, что важно';
    var cat = s.cat || 'montage';
    $('#servicePrice').textContent = 'Предварительная стоимость: ' + formatPrice(s);
    var L = { montage: ['Ссылка на исходное видео или материалы', 'https://disk.yandex.ru/...', true],
      logo: ['Ссылка на ваш логотип (файл или профиль)', 'https://disk.yandex.ru/... или instagram.com/...', true],
      dev: ['Ссылка на пример или ТЗ', 'необязательно', false] }[cat];
    $('#sourceLabel').textContent = L[0]; $('#fSource').placeholder = L[1]; $('#sourceReq').hidden = !L[2];
    var ef = $('#extrasField'); ef.hidden = cat !== 'montage';
    if (cat !== 'montage') $$('input[name="extras"]', ef).forEach(function (c) { c.checked = false; });
    setError('sourceUrl', '');
  }


  /* =====================================================================
     Отзывы
     ===================================================================== */
  function renderReviews() {
    var list = $('#reviewList'); if (!list) return; list.textContent = '';
    var rv = cfg.reviews || [];
    $('#reviewsLbl').hidden = !rv.length;
    rv.forEach(function (r, i) {
      var head = el('div', { class: 'rv-head' }, [
        r.logo ? el('img', { src: r.logo, alt: '', width: 44, height: 44 }) : null,
        el('span', { class: 'rt' }, [el('b', { text: r.name }), r.sub ? el('small', { text: r.sub }) : null])]);
      var meta = el('div', { class: 'rv-meta' }, [
        r.work ? el('span', { class: 'pill', text: r.work }) : null,
        r.price != null ? el('span', { class: 'pill gold', text: num(r.price) + ' ' + (cfg.currency || '₽') }) : null]);
      var kids = [head, el('p', { class: 'rv-text', text: '«' + r.text + '»' }), meta];
      if (/^https?:\/\//.test(r.url || '')) kids.push(el('button', { class: 'link-btn rv-link', type: 'button', 'data-url': r.url, text: 'Смотреть этот ролик →' }));
      list.appendChild(el('article', { class: 'review glass reveal', style: '--d:' + i }, kids));
    });
  }

  /* =====================================================================
     Профиль: мои заказы
     Список хранится у пользователя в облаке Telegram (CloudStorage) — он не теряется
     при перезапуске сервера. Статусы сервер отдаёт только по проверенной подписи initData.
     ===================================================================== */
  var ORDERS_KEY = 'orders_v1';
  var STATUS = {
    sent: { t: 'Отправлена', c: 'st-sent' },
    work: { t: 'В работе', c: 'st-work' },
    done: { t: 'Готово', c: 'st-done' },
    cancel: { t: 'Отменена', c: 'st-cancel' }
  };
  var orders = [];
  function cloud() { return inTelegram && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null; }
  function loadOrders(cb) {
    var cs = cloud();
    var fromLocal = function () { try { return JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]'); } catch (e) { return []; } };
    if (!cs) { cb(fromLocal()); return; }
    try {
      cs.getItem(ORDERS_KEY, function (err, v) {
        var arr = []; try { arr = JSON.parse(v || '[]'); } catch (e) { arr = []; }
        cb(Array.isArray(arr) && arr.length ? arr : fromLocal());
      });
    } catch (e) { cb(fromLocal()); }
  }
  function persistOrders() {
    var data = JSON.stringify(orders.slice(0, 25));           // у CloudStorage лимит 4096 символов на ключ
    while (data.length > 4000 && orders.length > 1) { orders.pop(); data = JSON.stringify(orders.slice(0, 25)); }
    try { localStorage.setItem(ORDERS_KEY, data); } catch (e) {}
    var cs = cloud(); if (cs) try { cs.setItem(ORDERS_KEY, data, function () {}); } catch (e) {}
  }
  function saveOrder(o) {
    loadOrders(function (arr) {
      orders = (arr || []).filter(function (x) { return x.id !== o.id; });
      orders.unshift(o); persistOrders(); updateOrderBadge();
    });
  }
  function updateOrderBadge() {
    var b = $('#drOrders'); if (!b) return;
    var act = orders.filter(function (o) { return o.status === 'sent' || o.status === 'work'; }).length;
    b.textContent = act; b.hidden = !act;
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); } catch (e) { return ''; }
  }
  function drawOrders() {
    var list = $('#orderList'); list.textContent = '';
    $('#pEmpty').hidden = orders.length > 0;
    $('#pTotal').textContent = orders.length;
    $('#pActive').textContent = orders.filter(function (o) { return o.status === 'work'; }).length;
    $('#pDone').textContent = orders.filter(function (o) { return o.status === 'done'; }).length;
    orders.forEach(function (o, i) {
      var s = svc(o.serviceId), st = STATUS[o.status] || STATUS.sent, sb = parseSubId(o.serviceId);
      var title = sb ? subTitle(sb) : s ? s.title + (s.cat === 'montage' || !s.cat ? ' · ' + s.duration : '') : 'Заказ';
      var steps = el('div', { class: 'o-steps' }, ['sent', 'work', 'done'].map(function (k, n) {
        var order = { sent: 0, work: 1, done: 2, cancel: -1 }[o.status] || 0;
        return el('i', { class: n <= order ? 'on' : '' });
      }));
      list.appendChild(el('article', { class: 'order-card glass reveal', style: '--d:' + i }, [
        el('div', { class: 'o-top' }, [el('span', { class: 'o-id', text: '№' + o.id }), el('span', { class: 'o-st ' + st.c, text: st.t })]),
        el('b', { class: 'o-title', text: title }),
        el('div', { class: 'o-sub' }, [el('span', { text: fmtDate(o.at) }), sb ? el('span', { text: subPrice(sb.planId, sb.level) }) : s ? el('span', { text: formatPrice(s) }) : null]),
        o.status === 'cancel' ? null : steps
      ]));
    });
    updateOrderBadge(); observe($('#screen-profile'));
  }
  function renderProfile(refresh) {
    var u = inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user;
    var av = $('#pAvatar');
    if (u) {
      $('#pName').textContent = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Клиент';
      $('#pSub').textContent = u.username ? '@' + u.username : 'Аккаунт Telegram';
      av.textContent = (u.first_name || '?').charAt(0).toUpperCase();
      if (/^https:\/\//.test(u.photo_url || '')) { av.textContent = ''; av.style.backgroundImage = 'url("' + u.photo_url.replace(/"/g, '') + '")'; }
    }
    showPlan(cachedPlan());
    loadOrders(function (arr) {
      orders = Array.isArray(arr) ? arr : []; drawOrders();
      if (!refresh || !inTelegram) return;
      fetch((cfg.apiBase || '') + '/api/my-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || !j.ok || !Array.isArray(j.orders)) return;
          storePlan(j.plan || null); showPlan(j.plan || null);
          var byId = {}; orders.forEach(function (o) { byId[o.id] = o; });
          j.orders.forEach(function (so) {
            if (byId[so.id]) byId[so.id].status = so.status;
            else orders.push({ id: so.id, serviceId: so.serviceId, at: so.at, status: so.status });
          });
          orders.sort(function (a, b) { return b.at - a.at; });
          persistOrders(); drawOrders();
        }).catch(function () { /* без сети показываем последнее известное */ });
    });
  }

  /* ---------- меню ☰ ---------- */
  function setMenu(open) {
    if (open === menuOpen) return;
    menuOpen = open;
    document.body.classList.toggle('menu-open', open);
    var d = $('#drawer');
    d.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) { d.removeAttribute('inert'); haptic('light'); setTimeout(function () { var c = $('.dr-close'); if (c) c.focus({ preventScroll: true }); }, 50); }
    else { d.setAttribute('inert', ''); }
    syncTelegramButtons();
  }
  function syncMenuActive() {
    $$('.dr-item').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-go') === currentScreen); });
  }
  function playCollabs(on) {
    $$('#collabList video').forEach(function (v) {
      if (on && !reduceMotion) {
        if (!v.getAttribute('src') && v.getAttribute('data-src')) v.src = v.getAttribute('data-src');
        var p = v.play(); if (p && p.catch) p.catch(function () {});
      } else v.pause();
    });
  }

  /* =====================================================================
     Навигация (hash-роутер, без перезагрузки)
     ===================================================================== */
  function go(name, opts) {
    if (SCREENS.indexOf(name) < 0) name = 'home';
    if (location.hash !== '#' + name && !(opts && opts.fromHash)) {
      if (opts && opts.replace) history.replaceState(null, '', '#' + name); else history.pushState(null, '', '#' + name);
    }
    show(name);
  }
  function show(name) {
    var prev = currentScreen;
    currentScreen = name;
    $$('.screen').forEach(function (s) { s.hidden = s.getAttribute('data-screen') !== name; });
    var ti = TAB_SCREENS.indexOf(name);
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-go') === name); });
    if (ti >= 0) $('.tab-ind').style.transform = 'translateX(' + (ti * 100) + '%)';
    $('.tabbar').classList.toggle('no-tab', ti < 0);
    setMenu(false); syncMenuActive(); playCollabs(name === 'collabs');
    document.body.classList.toggle('hide-tabbar', name === 'order' || name === 'success' || name === 'error' || name === 'login');
    document.body.classList.toggle('on-login', name === 'login');
    if (name !== 'prices') document.documentElement.style.setProperty('--hue', (HUE[name] || 0) + 'deg');
    else if (cfg) selectCat(currentCat, false);
    if (prev !== name) window.scrollTo(0, 0);
    var v = $('#phoneVideo');
    if (name === 'works' && cfg && works.list.length) { var p = v.getAttribute('src') ? v.play() : null; if (p && p.catch) p.catch(function () {}); } else v.pause();
    if (name !== 'prices') $('#logoVideo').pause();
    if (name === 'profile' && cfg) renderProfile(true);
    var scr = $('#screen-' + name); if (scr) observe(scr);
    syncTelegramButtons();
    kick();
  }
  window.addEventListener('popstate', function () {
    var name = location.hash.slice(1) || 'home';
    if ((name === 'success' && !successOrderId) || name === 'error' || SCREENS.indexOf(name) < 0) { go('home', { replace: true }); return; }
    show(name);
  });

  function openOrder(serviceId) {
    orderSub = null; applyOrderMode();
    if (serviceId && svc(serviceId)) { $('#fService').value = serviceId; onServiceChange(); }
    go('order');
  }

  /* ---------- Кнопки Telegram ---------- */
  function syncTelegramButtons() {
    if (!tg) return;
    try {
      if (tg.BackButton && tg.isVersionAtLeast('6.1')) {
        if (currentScreen === 'home' && !menuOpen) tg.BackButton.hide(); else tg.BackButton.show();
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
      if (tg.isVersionAtLeast('7.7') && tg.disableVerticalSwipes) tg.disableVerticalSwipes();   // свайп по 3D не закрывает приложение
      document.body.setAttribute('data-scheme', tg.colorScheme || 'dark');
      tg.onEvent('themeChanged', function () { document.body.setAttribute('data-scheme', tg.colorScheme || 'dark'); });
      if (tg.BackButton) tg.BackButton.onClick(function () {
        if (menuOpen) { setMenu(false); return; }
        if (currentScreen === 'success') go('home', { replace: true });
        else if (history.length > 1) history.back();
        else go('home', { replace: true });
      });
      if (tg.MainButton) tg.MainButton.onClick(function () { submitOrder(); });
    } catch (e) { /* продолжаем работать как обычная страница */ }

    if (!inTelegram) { $('#envBadge').hidden = false; return; }
    // В Telegram основная кнопка — системная MainButton, дублирующую кнопку в форме прячем
    $('#submitBtn').hidden = true;
    var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u) {
      initTelegramContact();
      $('#contactReq').hidden = true;
      $('#contactHint').textContent = 'Необязательно: я и так увижу ваш Telegram-аккаунт в заявке.';
    }
  }
  function initTelegramContact() {
    var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u) $('#fContact').value = u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ');
  }

  /* =====================================================================
     Форма: валидация и отправка
     ===================================================================== */
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
      serviceId: orderSub ? '' : f.serviceId.value,
      sourceUrl: f.sourceUrl.value.trim(),
      exampleUrl: f.exampleUrl.value.trim(),
      description: f.description.value.trim(),
      deadline: f.deadline.value,
      extras: $$('input[name="extras"]:checked', f).map(function (x) { return x.value; }),
      contact: f.contact.value.trim(),
      subscription: orderSub ? { planId: orderSub.planId, level: orderSub.level } : undefined
    };
  }

  function validate(d) {
    var errs = {};
    var optional = !!d.subscription || catOf(d.serviceId) === 'dev';
    if (!d.sourceUrl) { if (!optional) errs.sourceUrl = 'Добавьте ссылку (Яндекс Диск, Google Drive, облако).'; }
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
    box.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
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
        saveOrder({ id: r.body.orderId, serviceId: d.subscription ? 'sub:' + d.subscription.planId + ':' + d.subscription.level : d.serviceId, at: Date.now(), status: 'sent' });
        $('#successText').textContent = 'Заявка №' + r.body.orderId + ' доставлена мне в Telegram. Я отвечу вам в личных сообщениях, обычно в течение дня.';
        $('#orderForm').reset(); $('#descCounter').textContent = '0 / 1000';
        if (inTelegram) initTelegramContact();
        idempotencyKey = newKey();
        orderSub = null; applyOrderMode();
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

  /* ---------- События ---------- */
  function bind() {
    document.addEventListener('click', function (e) {
      if (!cfg) return;
      var t = e.target.closest('[data-go],[data-action],[data-service],[data-cat],[data-seg],[data-mode],[data-mode-open],[data-lvl],[data-sub-order],[data-pick],[data-work],[data-filter],[data-url],.tile');
      if (!t) return;
      if (t.hasAttribute('data-service')) { haptic('light'); openOrder(t.getAttribute('data-service')); return; }
      if (t.hasAttribute('data-cat')) { haptic('light'); currentCat = t.getAttribute('data-cat'); go('prices'); setMode('once'); return; }
      if (t.hasAttribute('data-seg')) { haptic('select'); selectCat(t.getAttribute('data-seg'), true); return; }
      if (t.hasAttribute('data-mode')) { haptic('select'); setMode(t.getAttribute('data-mode')); return; }
      if (t.hasAttribute('data-mode-open')) { haptic('light'); if (currentScreen !== 'prices') go('prices'); setMode(t.getAttribute('data-mode-open')); return; }
      if (t.hasAttribute('data-lvl')) { setLevel(t.getAttribute('data-plan'), t.getAttribute('data-lvl')); return; }
      if (t.hasAttribute('data-sub-order')) { haptic('light'); openSubOrder(t.getAttribute('data-sub-order')); return; }
      if (t.hasAttribute('data-pick')) { pick(t.getAttribute('data-pick')); return; }
      if (t.hasAttribute('data-filter')) {
        haptic('select'); works.filter = t.getAttribute('data-filter');
        $$('#workFilters .chip').forEach(function (c) { c.setAttribute('aria-selected', c === t ? 'true' : 'false'); });
        rebuildWorks(works.list[works.idx] && works.list[works.idx].id); return;
      }
      if (t.hasAttribute('data-work')) {
        haptic('light'); works.filter = 'all';
        $$('#workFilters .chip').forEach(function (c) { c.setAttribute('aria-selected', c.getAttribute('data-filter') === 'all' ? 'true' : 'false'); });
        rebuildWorks(t.getAttribute('data-work')); go('works'); return;
      }
      if (t.classList.contains('tile')) {
        var id = t.getAttribute('data-id'), i = -1; works.list.forEach(function (w, k) { if (w.id === id) i = k; });
        if (i >= 0 && i !== works.idx) selectWork(i, i > works.idx ? 1 : -1);
        $('#stage').scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' }); return;
      }
      if (t.hasAttribute('data-url')) { var u = t.getAttribute('data-url'); if (/^https?:\/\//.test(u)) openExternal(u); return; }
      var a = t.getAttribute('data-action');
      if (a === 'menu') { setMenu(true); return; }
      if (a === 'menu-close') { setMenu(false); return; }
      if (a === 'insta') { openExternal('https://www.instagram.com/' + cfg.brand.instagram + '/'); return; }
      if (a === 'channel') { if (cfg.brand.channel) openTelegramPath(cfg.brand.channel); return; }
      if (a === 'order') { haptic('light'); openOrder(selectedMontage); return; }
      if (a === 'order-selected') { haptic('light'); openOrder(selected[currentCat] || selectedMontage); return; }
      if (a === 'telegram') { openTelegramPath(cfg.brand.ownerTelegram); return; }
      if (a === 'open-bot') { openTelegramPath(cfg.brand.bot); return; }
      if (a === 'tg-login') { haptic('light'); openTelegramPath(cfg.brand.bot + '/app'); return; }
      if (a === 'guest') { store.set('guest', '1'); go('home', { replace: true }); return; }
      if (a === 'refresh-orders') { haptic('light'); renderProfile(true); return; }
      if (a === 'work-prev') { selectWork(works.idx - 1, -1); return; }
      if (a === 'work-next') { selectWork(works.idx + 1, 1); return; }
      var g = t.getAttribute('data-go');
      if (g) { e.preventDefault(); haptic('light'); go(g); }
    });
    $('#wOpen').addEventListener('click', function () { var w = works.list[works.idx]; if (w && /^https?:\/\//.test(w.url || '')) openExternal(w.url); });
    $$('.contact').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var href = a.getAttribute('href');
        if (/^https:\/\/t\.me\//.test(href)) openTelegramPath(href.replace('https://t.me/', '')); else openExternal(href);
      });
    });
    $('#fService').addEventListener('change', onServiceChange);
    $('#fDesc').addEventListener('input', function () { $('#descCounter').textContent = this.value.length + ' / 1000'; });
    ['fSource', 'fExample', 'fDesc', 'fContact'].forEach(function (id) {
      $('#' + id).addEventListener('input', function () { setError(this.name, ''); });
    });
    $('#orderForm').addEventListener('submit', function (e) { e.preventDefault(); submitOrder(); });
    $('#reloadBtn').addEventListener('click', function () { location.reload(); });
    $('#pRefresh').addEventListener('click', function () { haptic('light'); renderProfile(true); });
    $('#closeBtn').addEventListener('click', function () {
      if (inTelegram && tg.close) tg.close(); else go('home', { replace: true });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menuOpen) setMenu(false); });
    var dx0 = null;
    $('#drawer').addEventListener('pointerdown', function (e) { dx0 = e.clientX; });
    $('#drawer').addEventListener('pointerup', function (e) { if (dx0 !== null && dx0 - e.clientX > 60) setMenu(false); dx0 = null; });
    window.addEventListener('scroll', function () { if (currentScreen === 'home' && reduceMotion) kick(); }, { passive: true });
    bindStage();
  }

  /* ---------- Старт ---------- */
  bind();
  initTelegram();
  mountLogo($('.hero-logo'), { scale: 0.92 });
  mountLogo($('.login-logo'), { scale: 0.78, intro: true });
  initTilt();
  fetch('config.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('config ' + r.status); return r.json(); })
    .then(function (c) {
      cfg = c;
      render();
      loadOrders(function (arr) { orders = Array.isArray(arr) ? arr : []; updateOrderBadge(); });
      showPlan(cachedPlan());
      if (inTelegram) renderProfile(true);   // статусы и активный план с сервера (по подписи Telegram)
      var start = location.hash.slice(1);
      // экран успеха нельзя открыть по ссылке — только после ответа сервера
      if (start === 'success' || start === 'error' || TAB_SCREENS.concat('order', MENU_SCREENS).indexOf(start) < 0) start = '';
      if (!start) start = (!inTelegram && !store.get('guest')) ? 'login' : 'home';
      if (start === 'login') logos.forEach(function (L) { if (L.slot.classList.contains('login-logo')) L.intro = performance.now(); });
      go(start, { replace: true });
    })
    .catch(function () { show('error'); });
})();
