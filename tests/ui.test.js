// Тест интерфейса в настоящем браузере (Chromium). Нужен Playwright: npm i -D playwright && npx playwright install chromium
// Запуск: node tests/ui.test.js  — скриншоты появятся в tests/screens/
const { chromium } = require('playwright');
const http = require('http'), crypto = require('crypto'), { spawn } = require('child_process');
const APP=require('path').resolve(__dirname,'..'), OUT=__dirname+'/screens';
const cfg=require(APP+'/public/config.json');
require('fs').mkdirSync(OUT,{recursive:true});
const TOKEN='123456:TEST_TOKEN_not_real', PORT=3921, MPORT=3922, received=[];
const mock=http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{received.push(JSON.parse(b||'{}'));s.writeHead(200,{'Content-Type':'application/json'});s.end('{"ok":true,"result":{}}')})});
function sign(user){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'AAE',user:JSON.stringify(user)});
 const d=[...p].sort((a,b)=>a[0]<b[0]?-1:1).map(([k,v])=>k+'='+v).join('\n');const sec=crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();
 p.set('hash',crypto.createHmac('sha256',sec).update(d).digest('hex'));return p.toString();}
const user={id:42,first_name:'Иван',username:'ivan_client'};
const stub=(scheme)=>`window.__mb={};window.Telegram={WebApp:{initData:${JSON.stringify(sign(user))},initDataUnsafe:{user:${JSON.stringify(user)}},colorScheme:'${scheme}',version:'8.0',
 isVersionAtLeast:v=>true,ready(){window.__ready=1},expand(){window.__expanded=1},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},
 close(){window.__closed=1},openTelegramLink(u){window.__tglink=u},openLink(u){window.__link=u},
 HapticFeedback:{impactOccurred(){},notificationOccurred(){}},
 BackButton:{visible:false,show(){this.visible=true},hide(){this.visible=false},onClick(f){this.f=f}},
 MainButton:{params:{},setParams(p){Object.assign(this.params,p)},show(){this.params.is_visible=true},hide(){this.params.is_visible=false},onClick(f){this.f=f},
  showProgress(){this.progress=true},hideProgress(){this.progress=false},enable(){this.params.is_active=true},disable(){this.params.is_active=false}}}};`;
const res=[];const ok=(c,n)=>{res.push((c?'✅ ':'❌ ')+n)};
(async()=>{
 await new Promise(r=>mock.listen(MPORT,r));
 const srv=spawn(process.execPath,[APP+'/server/server.js'],{env:{PATH:process.env.PATH,PORT:String(PORT),BOT_TOKEN:TOKEN,OWNER_CHAT_ID:'777',TELEGRAM_API_BASE:'http://127.0.0.1:'+MPORT}});
 await new Promise(r=>srv.stdout.on('data',d=>String(d).includes('localhost')&&r()));
 const b=await chromium.launch(); const url='http://127.0.0.1:'+PORT+'/';
 const errors=[];
 async function newPage(mode){ // mode: 'browser' | 'dark' | 'light'
  const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const p=await ctx.newPage(); p.setDefaultTimeout(8000); p.on('pageerror',e=>errors.push(mode+': '+e.message));
  await p.route('https://telegram.org/**',r=> mode==='browser' ? r.abort() : r.fulfill({contentType:'text/javascript',body:stub(mode)}));
  await p.goto(url); await p.waitForSelector('#catList .row',{state:'attached'}); return p; }

 // ---- A: обычный браузер
 let p=await newPage('browser');
 ok(await p.isVisible('#screen-login') && !(await p.isVisible('.tabbar')),'вне Telegram первым открывается экран входа, без нижней навигации');
 ok((await p.$$eval('.login-logo .box > i',e=>e.length))===18,'3D-логотип собран из граней (18)');
 await p.waitForTimeout(1500); await p.screenshot({path:OUT+'/0-login.png'});
 await p.click('[data-action="tg-login"]');
 await p.click('[data-action="guest"]'); await p.waitForSelector('#screen-home:not([hidden])');
 ok(await p.isVisible('#envBadge'),'«Посмотреть без входа» → главная, видна метка «браузер»');
 await p.waitForTimeout(700); await p.screenshot({path:OUT+'/1-home.png'}); await p.screenshot({path:OUT+'/1-home-full.png',fullPage:true});
 ok((await p.$$eval('#catList .row',e=>e.length))===5,'главная: 4 услуги (рилсы, YouTube, логотип, разработка) + подписки');
 ok((await p.$$eval('#homeWorks .hcard',e=>e.length))===cfg.portfolio.length,'главная: все работы в ленте');
 ok((await p.$$eval('#featuresList .feature',e=>e.length))===4,'главная: 4 преимущества');
 for(const tab of ['prices','works','contacts','home']){ await p.click(`.tab[data-go="${tab}"]`); await p.waitForTimeout(120);
   ok(await p.isVisible(`#screen-${tab}`) && (await p.evaluate(()=>location.hash))==='#'+tab,'вкладка '+tab+' открывается без перезагрузки'); }
 await p.click('#catList [data-cat="montage"]'); await p.waitForTimeout(1200);
 const prices=await p.$$eval('#montageList .pr',e=>e.map(x=>x.textContent.replace(/[  ]/g,' ')));
 ok(JSON.stringify(prices)===JSON.stringify(['400 ₽','800 ₽','1 200 ₽','1 600 ₽','2 000 ₽','2 400 ₽']),'цены монтажа из config.json: '+prices.join(' | '));
 ok((await p.textContent('#extrasNote')).includes('по договорённости'),'доп. услуги: «по договорённости»');
 await p.screenshot({path:OUT+'/2-prices.png'});
 await p.click('[data-seg="logo"]'); await p.waitForTimeout(1100);
 const lp=await p.$$eval('#logoList .pr',e=>e.map(x=>x.textContent.replace(/[\u00a0\u202f]/g,' ')));
 ok(JSON.stringify(lp)===JSON.stringify(['800 ₽','1 600 ₽','2 400 ₽']),'логотип: 0–5 с 800, 5–10 с 1600, 10–15 с 2400 ('+lp.join(' | ')+')');
 await p.click('#logoList [data-pick="logo10"]');
 ok(!(await p.isHidden('#priceCta')) && (await p.textContent('#priceCtaBtn')).replace(/[\u00a0\u202f]/g,' ')==='Оформить · 1 600 ₽','логотип: выбор длины меняет кнопку «Оформить · 1 600 ₽»');
 await p.click('[data-seg="dev"]'); await p.waitForTimeout(1100);
 const bt=(await p.textContent('#bundleCard')).replace(/[  ]/g,' ');
 ok(bt.includes('5 000 ₽')&&bt.includes('5 500 ₽')&&bt.includes('Выгода 500 ₽'),'комплект: 5 000 ₽ вместо 5 500 ₽, выгода 500 ₽');
 const dv=(await p.$$eval('#devList .pr',e=>e.map(x=>x.textContent.replace(/[  ]/g,' '))));
 ok(JSON.stringify(dv)===JSON.stringify(['от 2 500 ₽','от 3 000 ₽']),'бот от 2 500 ₽, мини-приложение от 3 000 ₽');
 ok(await p.isHidden('#priceCta'),'кнопка «Оформить» монтажа скрыта на вкладке «Разработка»');
 await p.screenshot({path:OUT+'/2-dev.png'});
 await p.click('[data-seg="montage"]'); await p.click('#montageList [data-pick="s60"]');
 ok((await p.textContent('#priceCtaBtn')).replace(/[  ]/g,' ')==='Оформить · 1 600 ₽','выбор длины меняет кнопку: «Оформить · 1 600 ₽»');
 await p.click('#priceCtaBtn');
 ok(await p.isVisible('#screen-order') && await p.inputValue('#fService')==='s60','кнопка открывает форму с выбранной услугой');
 await p.waitForFunction(()=>getComputedStyle(document.querySelector('.tabbar')).visibility==='hidden',null,{timeout:3000}).catch(()=>{});
 ok(!(await p.isVisible('.tabbar')),'в форме нижняя навигация скрыта (не мешает клавиатуре)');
 await p.click('#submitBtn');
 const errs=await p.$$eval('.error',e=>e.filter(x=>x.textContent).map(x=>x.dataset.for));
 ok(errs.includes('sourceUrl')&&errs.includes('description')&&errs.includes('contact'),'пустая форма: ошибки у обязательных полей ('+errs.join(',')+')');
 await p.fill('#fSource','disk.yandex.ru без https'); await p.fill('#fExample','ftp://x'); await p.fill('#fDesc','Нужен рилс про кофейню'); await p.fill('#fContact','@client');
 await p.click('#submitBtn');
 ok(await p.textContent('.error[data-for="sourceUrl"]')!==''&& await p.textContent('.error[data-for="exampleUrl"]')!=='','неверный формат ссылок ловится');
 await p.screenshot({path:OUT+'/3-form-errors.png',fullPage:true});
 await p.selectOption('#fService','bundle'); await p.fill('#fSource',''); await p.fill('#fExample','');
 ok(await p.isHidden('#extrasField') && await p.isHidden('#sourceReq'),'для разработки: ссылка необязательна, доп. услуги монтажа скрыты');
 const before=received.length;
 await p.click('#submitBtn'); await p.waitForSelector('#formError:not([hidden])');
 ok(await p.textContent('.error[data-for="sourceUrl"]')===''&&!(await p.isVisible('#screen-success')) && (await p.textContent('#formError')).includes('внутри Telegram') && received.length===before,'из браузера без подписи: сервер отказал, успех НЕ показан, ничего не отправлено');
 await p.screenshot({path:OUT+'/4-browser-refused.png',fullPage:true});
 await p.goto(url+'#works'); await p.waitForSelector('#screen-works:not([hidden])');
 const t1=await p.textContent('#wTitle'); await p.click('[data-action="work-next"]'); await p.waitForTimeout(900);
 ok(t1!==await p.textContent('#wTitle'),'работы: стрелка листает 3D-телефон ('+t1+' → '+await p.textContent('#wTitle')+')');
 await p.click('[data-filter="logo"]'); await p.waitForTimeout(300);
 ok((await p.$$eval('#workDots i',e=>e.length))===cfg.portfolio.filter(w=>w.cat==='logo').length && (await p.textContent('#wTitle')).includes('логотип'),'фильтр «Логотипы» работает');
 await p.screenshot({path:OUT+'/5-works.png'});
 await p.click('#screen-works .menu-btn'); await p.waitForTimeout(600);
 ok(await p.evaluate(()=>document.body.classList.contains('menu-open')) && (await p.getAttribute('#drawer','aria-hidden'))==='false','☰ открывает меню');
 ok((await p.textContent('#drCollabs'))===String(cfg.collabs.length) && (await p.textContent('#drWorks'))===String(cfg.portfolio.length),'меню: счётчики коллабораций и работ из config.json');
 await p.screenshot({path:OUT+'/6-menu.png'});
 await p.click('#drawer [data-go="collabs"]'); await p.waitForTimeout(700);
 ok(await p.isVisible('#screen-collabs') && !(await p.evaluate(()=>document.body.classList.contains('menu-open'))),'пункт меню открывает раздел и закрывает меню');
 ok((await p.$$eval('#collabList .collab',e=>e.length))===cfg.collabs.length,'коллаборации: '+cfg.collabs.length+' карточки');
 await p.screenshot({path:OUT+'/7-collabs.png'});
 for(const [scr,sel,n] of [['about','#aboutText p',cfg.pages.about.length],['howto','#howtoList li',cfg.pages.howto.length],['faq','#faqList details',cfg.bot.faq.length]]){
   await p.click('#screen-'+(await p.evaluate(()=>location.hash.slice(1)))+' .menu-btn'); await p.waitForTimeout(500);
   await p.click(`#drawer [data-go="${scr}"]`); await p.waitForTimeout(500);
   ok(await p.isVisible('#screen-'+scr) && (await p.$$eval(sel,e=>e.length))===n,'раздел «'+scr+'» заполнен из config.json');
 }
 await p.click('#screen-faq .menu-btn'); await p.waitForTimeout(500); await p.keyboard.press('Escape'); await p.waitForTimeout(500);
 ok(!(await p.evaluate(()=>document.body.classList.contains('menu-open'))),'Esc закрывает меню');
 await p.goto(url+'#success'); await p.waitForTimeout(200);
 const a1=await p.isVisible('#screen-home')&&!(await p.isVisible('#screen-success'));
 await p.goto('about:blank'); await p.goto(url+'#success'); await p.waitForTimeout(400);
 ok(a1 && !(await p.isVisible('#screen-success')),'экран успеха нельзя открыть ссылкой #success (ни сменой хэша, ни загрузкой)');
 // подписки
 await p.goto(url+'#prices'); await p.waitForSelector('#screen-prices:not([hidden])');
 await p.click('#modeSeg [data-mode="subs"]'); await p.waitForTimeout(300);
 ok(await p.isVisible('#subsPane') && !(await p.isVisible('#oncePane')) && !(await p.isVisible('#priceCta')),'подписки: переключатель «Разовый монтаж / Подписки» работает, нижняя кнопка скрыта');
 ok((await p.$$eval('#planList .plan',e=>e.map(x=>x.querySelector('h3').textContent)).then(x=>x.join(',')))==='START,PRO,PRO PLUS,MAX','подписки: 4 тарифа рилсов из config.json');
 ok(await p.isVisible('#fmtSeg'),'подписки: есть переключатель «Рилсы / YouTube»');
 const pp=async id=>(await p.textContent(`[data-plan-card="${id}"] .pp`)).replace(/[\u00a0\u202f ]/g,' ');
 ok(await pp('pro')==='6 500 ₽','PRO по умолчанию Standard Motion: 6 500 ₽');
 await p.click('[data-plan="pro"][data-lvl="advanced"]'); await p.waitForTimeout(150);
 ok(await pp('pro')==='9 000 ₽' && (await p.getAttribute('[data-plan="pro"][data-lvl="advanced"]','aria-checked'))==='true' && (await p.getAttribute('[data-plan="pro"][data-lvl="standard"]','aria-checked'))==='false','PRO → Advanced 3D: кнопка выделена, цена 9 000 ₽');
 ok((await p.textContent('[data-plan-card="pro"] [data-sub-order]')).replace(/[\u00a0\u202f ]/g,' ').includes('9 000 ₽/мес') && (await p.textContent('[data-plan-card="pro"] .pt-pill'))==='8 роликов/мес','цена и объём видны на кнопке и в карточке');
 ok(await pp('start')==='3 500 ₽','выбор уровня в одном тарифе не меняет другие');
 await p.click('[data-var="max5x"]'); await p.waitForTimeout(100);
 ok((await p.textContent('[data-plan-card="max"] .pt-title'))==='MAX 5X' && (await p.textContent('[data-plan-card="max"] .pt-pill'))==='22 ролика/мес' && await pp('max')==='27 000 ₽' && !(await p.isVisible('[data-plan-card="max"] .lvl-seg')),'MAX 5X: 22 ролика, 27 000 ₽, 2D+3D без выбора уровня');
 await p.click('[data-var="max20x"]'); await p.waitForTimeout(100);
 ok(await pp('max')==='40 000 ₽','MAX 20X: 40 000 ₽');
 await p.screenshot({path:OUT+'/9-subs-max.png',fullPage:true});
 await p.click('[data-var="max"]');
 await p.click('[data-fmt="long"]'); await p.waitForTimeout(150);
 ok((await p.$$eval('#planList .plan',e=>e.map(x=>x.querySelector('h3').textContent)).then(x=>x.join(',')))==='START,PRO,PRO PLUS,MAX' && await pp('yt-pro')==='5 500 ₽','YouTube-подписки: свои тарифы и цены');
 await p.click('[data-var="yt-max20x"]'); await p.waitForTimeout(100);
 ok(await pp('yt-max')==='65 000 ₽' && (await p.textContent('[data-plan-card="yt-max"] .pt-pill'))==='12 видео/мес','YouTube MAX 20X: 12 видео, 65 000 ₽');
 await p.screenshot({path:OUT+'/9-subs-youtube.png',fullPage:true});
 await p.click('[data-var="yt-max"]');
 await p.click('[data-fmt="short"]'); await p.waitForTimeout(150);
 await p.screenshot({path:OUT+'/9-subs.png',fullPage:true});
 await p.click('[data-sub-order="pro"]'); await p.waitForSelector('#screen-order:not([hidden])');
 ok((await p.textContent('#subSummary')).includes('Рилсы PRO · Advanced 3D') && !(await p.isVisible('#serviceField')) && !(await p.isVisible('#extrasField')),'оформление: видна выбранная подписка, выбор услуги скрыт');
 await p.screenshot({path:OUT+'/9-subs-order.png',fullPage:true});
 await p.click('#subSummary [data-mode-open="subs"]'); await p.waitForSelector('#screen-prices:not([hidden])');
 ok(await p.isVisible('#subsPane') && (await p.getAttribute('[data-plan="pro"][data-lvl="advanced"]','aria-checked'))==='true','«Изменить» возвращает к тарифам, выбор сохранён');
 await p.click('#modeSeg [data-mode="once"]'); await p.click('[data-action="order-selected"]'); await p.waitForSelector('#screen-order:not([hidden])');
 ok(await p.isVisible('#serviceField') && !(await p.isVisible('#subSummary')),'разовый заказ после подписки: обычная форма');
 await p.context().close();

 // ---- B: внутри Telegram (заглушка SDK с настоящей подписью тестовым токеном)
 p=await newPage('dark');
 ok(await p.evaluate(()=>window.__ready&&window.__expanded),'Telegram: ready() и expand() вызваны');
 ok(!(await p.isVisible('#envBadge')),'Telegram: метка «браузер» скрыта');
 ok(await p.isVisible('#screen-home') && !(await p.isVisible('#screen-login')),'Telegram: экран входа пропускается, сразу главная');
 ok((await p.textContent('#userName'))==='Иван','Telegram: приветствие по имени');
 await p.route('**/api/my-orders',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,orders:[{id:'AB12CD',serviceId:'sub:pro:advanced',at:Date.now(),status:'work'}],plan:{planId:'pro',level:'advanced',until:Date.now()+20*86400000}})}));
 await p.evaluate(()=>{location.hash='#profile'}); await p.waitForSelector('#planCard:not([hidden])');
 ok((await p.textContent('#planCard')).includes('PRO')&&(await p.textContent('#planCard')).includes('Advanced 3D')&&(await p.textContent('#orderList')).includes('Подписка Рилсы PRO'),'план после оплаты: в профиле карточка PRO · Advanced 3D и заказ-подписка');
 ok((await p.textContent('#homePlan'))==='Рилсы PRO','план после оплаты: бейдж «Рилсы PRO» рядом с именем на главной');
 await p.screenshot({path:OUT+'/9-plan.png',fullPage:true});
 await p.unroute('**/api/my-orders'); await p.evaluate(()=>{location.hash='#home'}); await p.waitForTimeout(200);
 await p.click('.hero [data-action="order"]');
 ok(await p.evaluate(()=>Telegram.WebApp.MainButton.params.is_visible&&Telegram.WebApp.MainButton.params.text==='Отправить заявку'),'Telegram: MainButton «Отправить заявку» на экране формы');
 ok(await p.evaluate(()=>Telegram.WebApp.BackButton.visible),'Telegram: BackButton показан');
 ok(await p.inputValue('#fContact')==='@ivan_client','контакт подставлен из initDataUnsafe');
 ok(!(await p.isVisible('#submitBtn')),'дублирующая кнопка формы скрыта в пользу MainButton');
 await p.fill('#fSource','https://drive.google.com/file/d/1'); await p.fill('#fDesc','Рилс 25 секунд, субтитры'); await p.check('#fExtras input[value="revisions"]');
 // сетевая ошибка
 await p.route('**/api/order',r=>r.abort());
 await p.evaluate(()=>Telegram.WebApp.MainButton.f()); await p.waitForSelector('#formError:not([hidden])');
 ok(!(await p.isVisible('#screen-success'))&&(await p.textContent('#formError')).includes('Нет связи'),'сетевая ошибка: понятный текст, успех не показан');
 await p.screenshot({path:OUT+'/5-network-error.png',fullPage:true});
 await p.unroute('**/api/order');
 // двойное нажатие + медленный ответ
 let calls=0; await p.route('**/api/order',async r=>{calls++; await new Promise(x=>setTimeout(x,700)); r.continue();});
 await p.evaluate(()=>{Telegram.WebApp.MainButton.f();Telegram.WebApp.MainButton.f();Telegram.WebApp.MainButton.f();});
 await p.waitForTimeout(150);
 ok(await p.evaluate(()=>Telegram.WebApp.MainButton.progress===true && Telegram.WebApp.MainButton.params.is_active===false),'во время отправки MainButton показывает прогресс и выключена');
 await p.waitForSelector('#screen-success:not([hidden])');
 ok(calls===1,'тройное нажатие → один запрос (calls='+calls+')');
 const owner=received.filter(m=>m.chat_id==='777').pop();
 ok(owner && owner.text.includes('Дополнительные правки') && owner.text.includes('подтверждён Telegram'),'успех показан только после ответа сервера; сообщение владельцу получено mock-API');
 ok((await p.textContent('#successText')).includes('№'),'экран успеха с номером заявки');
 await p.screenshot({path:OUT+'/6-success.png'});
 await p.click('#closeBtn'); ok(await p.evaluate(()=>window.__closed===1),'«Готово» закрывает Mini App (WebApp.close)');
 await p.context().close();

 // ---- C: светлая тема Telegram
 p=await newPage('light');
 ok(await p.evaluate(()=>document.body.dataset.scheme)==='light','светлая тема Telegram учитывается, стиль остаётся тёмно-синим');
 await p.screenshot({path:OUT+'/7-light-theme.png'});
 await p.context().close();

 // ---- D: reduced motion + узкий экран
 const ctx=await b.newContext({viewport:{width:320,height:640},reducedMotion:'reduce'}); p=await ctx.newPage();
 await p.route('https://telegram.org/**',r=>r.abort()); await p.goto(url+'#home'); await p.waitForSelector('#catList .row');
 ok(await p.evaluate(()=>getComputedStyle(document.querySelector('.screen')).animationName)==='none','prefers-reduced-motion: анимации выключены');
 ok(await p.evaluate(()=>document.documentElement.scrollWidth<=320),'320px: нет горизонтальной прокрутки');
 const tabH=await p.evaluate(()=>Math.min(...[...document.querySelectorAll('.tab')].map(t=>t.getBoundingClientRect().height)));
 ok(tabH>=44,'кнопки навигации ≥44px по высоте ('+tabH+'px), внизу экрана — удобно большим пальцем');
 await p.screenshot({path:OUT+'/8-320px.png'});
 await b.close(); srv.kill(); mock.close();
 ok(errors.length===0,'JS-ошибок на странице нет'+(errors.length?': '+errors.join('; '):''));
 console.log(res.join('\n')); console.log(`\n${res.filter(r=>r[0]==='✅').length}/${res.length}`);
})().catch(e=>{console.error(e);process.exit(1)});
