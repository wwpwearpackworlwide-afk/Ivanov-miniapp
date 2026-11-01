'use strict';
/* Автоплан ролика из субтитров (SRT из CapCut / Whisper).
   SRT → слова с таймкодами → черновик плана для движка montazh-remotion (R00-Reel).
   Логика по brand-guide: 8.2–8.3 (где вставка и какая), 3.1 (пропорция ~50/50), 4.4 (выделение iPhone),
   18.1 (хук с кадра 0). Без зависимостей. Копия scripts/autoplan.cjs из библиотеки montazh-remotion — менять в обоих местах.
   Это ЧЕРНОВИК: смысл сцен и тексты Иван проверяет и правит руками. */

// ---------- SRT ----------
const toSec = (s) => {
  const m = String(s).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000 : NaN;
};
function parseSrt(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const start = toSec(a), end = toSec(z);
    const txt = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!isNaN(start) && !isNaN(end) && end > start && txt) cues.push({ start, end, text: txt });
  }
  return cues.sort((x, y) => x.start - y.start);
}
const looksLikeSrt = (t) => /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}/.test(String(t));

// ---------- Слова: время внутри фразы по слогам (гласным) ----------
const VOW = /[аеёиоуыэюяaeiouy]/gi;
const syl = (w) => Math.max(1, (w.match(VOW) || []).length);
function cuesToWords(cues) {
  const words = [];
  for (const c of cues) {
    const ws = c.text.split(' ').filter(Boolean);
    const weights = ws.map((w) => syl(w) + (/[,.!?;:…]$/.test(w) ? 0.6 : 0) + 0.4);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = c.start;
    const span = c.end - c.start;
    ws.forEach((w, i) => {
      const d = (weights[i] / total) * span;
      words.push({ w, t: +t.toFixed(2), e: +(t + d * 0.92).toFixed(2), cue: cues.indexOf(c) });
      t += d;
    });
  }
  return words;
}

// ---------- Словари триггеров (8.3) ----------
const NUM = { 'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'двух': 2, 'три': 3, 'трёх': 3, 'трех': 3, 'четыре': 4, 'четырёх': 4, 'пять': 5, 'пяти': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10 };
const STOP = new Set('и в во на но а что это как так же ли не ни по за из к ко у о об от до для то вы мы он она они я ты его её их мой твой ваш наш все всё уже очень просто если когда чтобы потому там тут здесь вот ещё еще бы был была было были есть будет может можно надо нужно только тоже'.split(' '));
const clean = (w) => w.toLowerCase().replace(/[^a-zа-яё0-9-]/gi, '');
const numOf = (w) => { const c = clean(w); if (/^\d+$/.test(c)) return +c; return NUM[c] ?? null; };
// Границы слова для кириллицы (\b в JS работает только с латиницей)
const W = (src, flags = 'i') => new RegExp(src.replace(/\\b/g, '(?<![а-яёa-z0-9])').replace(/\\e/g, '(?![а-яёa-z0-9])'), flags);
const T = {
  list: W('\\b(во-первых|во-вторых|первое|второе|третье|перв(ый|ая|ое)|втор(ой|ая|ое)|трет(ий|ья|ье))\\e|(\\d+|два|две|три|четыре|пять)\\s+(способ|ошиб|шаг|причин|правил|совет|вещ|приём|прием|этап)'),
  vs: W('\\b(или|против|vs)\\e|\\bлучше\\e|\\bхуже\\e'),
  flow: W('\\bсначала\\e|\\bпотом\\e|\\bзатем\\e|\\bв итоге\\e|\\bпосле этого\\e'),
  myth: W('\\bне\\s+[^\\s,]+,?\\s+а\\s+[^\\s.,!?]+'),
  ui: W('нажм|нажим|\\bоткрой|открыва|загрузи|\\bкнопк|\\bссылк|в шапке'),
  bot: W('\\bбот|\\bнапиш|\\bпишите\\e|закаж|\\bзаказ'),
  before: W('\\bдо и после\\e|\\bбыло\\e|\\bстало\\e'),
  emo: W('страшно|круто|\\bвау\\e|бесполезно|опасно|\\bошибк|провал|секрет'),
};
const upper = (s) => s.toUpperCase();
const firstWords = (s, n) => s.replace(/[.,!?;:…]+$/g, '').split(' ').slice(0, n).join(' ');
const stripP = (w) => w.replace(/[.,!?;:…«»"]/g, '');

// Выбор слова для выделения iPhone: цифра > слово-триггер > самое длинное значимое (≥5 букв)
function pickHighlight(ws) {
  let best = -1, score = 0;
  ws.forEach((w, i) => {
    const c = clean(w);
    if (!c || STOP.has(c)) return;
    let sc = numOf(w) !== null ? 10 : 0;
    if (T.emo.test(c)) sc += 6;
    if (c.length >= 5) sc += c.length / 3;
    if (sc > score) { score = sc; best = i; }
  });
  return score >= 2 ? best : -1;
}

// ---------- Автоплан ----------
function autoPlan(cues, opts = {}) {
  const format = opts.format || '9x16';
  const words = cuesToWords(cues);
  // выделение iPhone примерно в 2 из 3 фраз (4.4)
  cues.forEach((c, ci) => {
    if (ci % 3 === 2) return;
    const idx = words.map((w, i) => [w, i]).filter(([w]) => w.cue === ci);
    const h = pickHighlight(idx.map(([w]) => w.w));
    if (h >= 0) idx[h][0].w = '*' + idx[h][0].w;
  });
  const totalEnd = cues.length ? cues[cues.length - 1].end : 0;

  // сегменты 2–4,5 с по границам фраз
  const segs = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) cur = { from: c.start, to: c.end, cues: [c] };
    else if (c.end - cur.from <= 4.5 || cur.to - cur.from < 2) { cur.to = c.end; cur.cues.push(c); }
    else { segs.push(cur); cur = { from: c.start, to: c.end, cues: [c] }; }
  }
  if (cur) segs.push(cur);
  // стыки без дыр: сцена тянется до начала следующей, первая — с 0
  segs.forEach((s, i) => { s.text = s.cues.map((c) => c.text).join(' '); if (i === 0) s.from = 0; if (segs[i + 1]) s.to = segs[i + 1].from; });

  let src = 0, mot = 0;
  const scenes = [];
  segs.forEach((sg, i) => {
    const d = sg.to - sg.from;
    const text = sg.text;
    const last = i === segs.length - 1;
    const prevD = scenes.length && scenes[scenes.length - 1].mode === 'D';
    const segWords = text.split(' ');
    const nums = segWords.map(numOf).filter((n) => n !== null);
    const hlWord = words.find((w) => w.t >= sg.from && w.t < sg.to && w.w.startsWith('*'));
    const key = hlWord ? stripP(hlWord.w.slice(1)) : (segWords.map(stripP).filter((w) => w.length >= 5 && !STOP.has(w.toLowerCase()))[0] || stripP(segWords[0]));
    let d_ = null, why = '';
    const room = mot <= src * 1.1; // не перекашивать в motion (3.1)
    const isList = T.list.test(text);
    const isBefore = T.before.test(text);
    if (i === 0 || isBefore || (isList && !T.myth.test(text))) {
      // P: хук / сплит «до-после» / пункт списка карточкой
    } else if (!room && !(last && T.bot.test(text))) {
      // первая сцена — всегда вы в кадре с хуком (3.1: открывается сценой P)
    } else if (last && T.bot.test(text)) {
      d_ = { scene: 'B28-CTABot', props: {}, submute: true }; why = 'призыв в бот в финале (8.4)';
    } else if (T.myth.test(text)) {
      const m = text.match(W('(.*?)\\bне\\s+([^\\s,]+),?\\s+а\\s+([^\\s.,!?]+)'));
      d_ = { scene: 'M02-StrikeReplace', props: m ? { lead: (firstWords((m[1] || '').trim(), 3) || 'Это').trim(), wrong: stripP(m[2]), right: stripP(m[3]) } : {}, submute: true }; why = 'развенчание мифа «не …, а …» → перечёркивание T2';
    } else if (T.flow.test(text)) {
      const nodes = text.split(T.flow).map((x) => firstWords(x.trim().replace(/^[,—-]\s*/, ''), 3)).filter(Boolean).slice(0, 4);
      d_ = { scene: 'M19-SchemeFlow', props: nodes.length >= 2 ? { nodes } : {} }; why = '«сначала… потом… в итоге» → схема';
    } else if (T.vs.test(text) && !prevD) {
      const m = text.match(/([^\s,?]+)\??\s+(или|против|vs)\s+([^\s,.!?]+)/i);
      d_ = { scene: 'M07-CardFan', props: m ? { cards: [[stripP(m[1]), ''], [stripP(m[3]), '']], activeAt: [1.4, 2.4] } : {} }; why = '«А или Б» → веер карточек';
    } else if (T.ui.test(text)) {
      d_ = { scene: 'M12-ButtonToPanel', props: {} }; why = 'в речи действие («нажми/открой») → интерфейс с курсором 6.2';
    } else if (T.bot.test(text) && !prevD) {
      d_ = { scene: 'U11-BotChat', props: {} }; why = 'речь про бота/заказ → чат бота';
    } else if (nums.length && T.list.test(text) === false && !prevD && nums[0] > 3) {
      d_ = { scene: 'T07-OdometerCounter', props: { value: nums[0], label: firstWords(segWords.slice(segWords.findIndex((w) => numOf(w) !== null) + 1).join(' '), 4) } }; why = 'число в речи → счётчик (проверь, что цифра реальная)';
    } else if (T.emo.test(text) && !prevD && d <= 3.2) {
      const emoW = segWords.map(stripP).find((w) => T.emo.test(w.toLowerCase()));
      d_ = { scene: 'M03-PunchWord', props: { word: (emoW || key).replace(/^./, (c) => c.toUpperCase()) }, submute: true }; why = 'эмоциональный пик → ударное слово T3';
    }
    // баланс 50/50: если motion отстаёт и прошлая сцена не D — даём кинетический тезис
    if (!d_ && i > 0 && !last && !prevD && !isList && !isBefore && mot < src * 0.8) {
      const ws = segWords.map(stripP).filter((w) => !STOP.has(w.toLowerCase()) && w.length > 2);
      d_ = { scene: 'T05-KineticThesis', props: { lines: [upper(ws[0] || key) + (ws[1] ? ',' : ''), upper(ws[1] || '')].filter(Boolean), swap: [upper(key)] }, submute: true };
      why = 'пропорция ~50/50: тезис фразы кинетической типографикой (перепиши строки)';
    }
    if (d_ && d > 8) d_ = null; // слишком длинный кусок — оставляем вам
    if (d_) {
      scenes.push({ from: +sg.from.toFixed(2), to: +sg.to.toFixed(2), mode: 'D', ...d_, why });
      mot += d;
    } else {
      const sc = { from: +sg.from.toFixed(2), to: +sg.to.toFixed(2), mode: 'P', why: i === 0 ? 'хук: вы в кадре + заголовок «Фокус» с кадра 0' : 'вы в кадре' };
      if (nums.length) { sc.big = { text: String(nums[0]), at: +(words.find((w) => w.t >= sg.from && numOf(w.w.replace('*', '')) !== null)?.t ?? sg.from).toFixed(2) }; sc.why += '; цифра за героем'; }
      if (hlWord) sc.punch = [hlWord.t];
      if (isList && i > 0) { sc.cards = [{ num: String(scenes.filter((x) => x.cards).length + 1).padStart(2, '0'), text: firstWords(text, 4), at: +(sg.from + 0.4).toFixed(2), side: scenes.filter((x) => x.cards).length % 2 ? 'right' : 'left' }]; sc.why += '; пункт списка карточкой'; }
      if (isBefore && d >= 2.5) { sc.mode = 'S'; sc.labelA = 'ДО'; sc.labelB = 'ПОСЛЕ'; sc.why = '«до и после» → сплит (CORE 4.1). Укажи srcA/srcB'; }
      scenes.push(sc);
      src += d;
    }
  });
  // логотип в конце своих роликов (8.4); для клиентских и петель — убрать
  if (!opts.client && !opts.loop) scenes.push({ from: +totalEnd.toFixed(2), to: +(totalEnd + 5.6).toFixed(2), mode: 'LOGO', why: 'лого-анимация v4 в конце своих роликов' });
  if (scenes.length && scenes[scenes.length - 1].mode !== 'LOGO' && scenes.length > 1) scenes[scenes.length - 1].to = +totalEnd.toFixed(2);

  const first = cues[0] ? cues[0].text : '';
  const n0 = first.split(' ').map(numOf).find((n) => n !== null);
  const hookText = firstWords(first.split(/[,.:;!?—]/)[0].trim(), 5);
  // пропорция без лого: если в норме — лого и есть причина отклонения
  let s0 = 0, m0 = 0;
  for (const sc of scenes) { if (sc.mode === 'LOGO') continue; const d = sc.to - sc.from; if (sc.mode === 'D') m0 += d; else s0 += d; }
  const shareNoLogo = s0 + m0 ? m0 / (s0 + m0) : 0;
  return {
    ...(shareNoLogo >= 0.4 && shareNoLogo <= 0.55 ? { ratioReason: `без лого motion ${Math.round(shareNoLogo * 100)}%: долю утяжеляет лого-анимация в конце` } : {}),
    format,
    palette: opts.palette || 'signature',
    source: opts.src ? { src: opts.src } : {}, // впиши src: 'clips/твой-дубль.mp4' (без src — заглушка для предпросмотра)
    audio: 'source',
    hook: { text: hookText, accent: n0 != null ? 0 : null, capsuleAt: 2.8 },
    // хук повторяет первую фразу речи → её субтитры глушим, пока заголовок на экране (18.2)
    submute: cues[0] ? [[cues[0].start, Math.min(cues[0].end, 2.8)]] : [],
    words: words.map(({ w, t, e }) => ({ w, t, e })),
    scenes,
  };
}

// ---------- Пропорция и проверки (как scripts/check-plan) ----------
function summary(plan) {
  let s = 0, m = 0;
  for (const sc of plan.scenes) { const d = sc.to - sc.from; if (sc.mode === 'D' || sc.mode === 'LOGO') m += d; else s += d; }
  const total = s + m;
  return { total, source: s, motion: m, share: total ? m / total : 0, scenes: plan.scenes.length, d: plan.scenes.filter((x) => x.mode === 'D').map((x) => x.scene) };
}

// ---------- Файл плана для src/plans/ ----------
function planToModule(plan, name = 'plan') {
  const sm = summary(plan);
  const head = [
    `// Черновик плана из субтитров — сделан автоматически ${new Date().toISOString().slice(0, 10)}.`,
    `// Длина ${sm.total.toFixed(1)} с · ваше видео ${(100 - sm.share * 100).toFixed(0)}% / motion ${(sm.share * 100).toFixed(0)}% · сцен ${sm.scenes}`,
    '// Что проверить руками:',
    '//  1) hook.text — вывод, а не повтор фразы (18.2), до 5 слов;',
    '//  2) props D-сцен — тексты и цифры (только реальные!);',
    '//  3) source.src и вырез героя cutout (matte.py → public/fg/), если нужна графика «за вами»;',
    '//  4) поле why у сцены — почему выбрана; можно удалить.',
    '// Выделение iPhone — слово со «*». Проверка: npm run check src/plans/<файл>.js',
  ].join('\n');
  return `${head}\n\nexport const ${name} = ${JSON.stringify(plan, null, 2)};\n\nexport default ${name};\n`;
}

module.exports = { parseSrt, looksLikeSrt, cuesToWords, autoPlan, summary, planToModule };
