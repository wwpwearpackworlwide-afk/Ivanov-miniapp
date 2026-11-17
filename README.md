# IvanovService — Telegram Mini App 2.0 alpha

Mini App для **@IvanovServiceBot**: каталог услуг и портфолио, оформление заказа, ручная оплата по серверным реквизитам, проверка чека владельцем, статусы в профиле и сохраняемый аудит.

Проект обновлён без смены логотипа, портфолио, фирменного стиля и существующих цен. Автоматический эквайринг не подключён: бот никогда не считает скриншот доказательством оплаты.

## Архитектура

```text
Telegram Mini App (Vanilla JS, HTML/CSS, CSS 3D)
  │ initData + форма + idempotencyKey
  ▼
Node.js HTTP server
  ├─ config-schema  — проверка env и config.json при запуске
  ├─ order-state    — контролируемые статусы и append-only история
  ├─ store          — atomic JSON, backup, idempotency, inbox/outbox
  ├─ bot            — webhook, чеки, owner actions, уведомления
  └─ public         — существующий интерфейс и RU/EN-словарь новых полей
```

Runtime-зависимостей нет. Требуется **Node.js 24 LTS** (`.nvmrc`). Playwright нужен только для browser-тестов.

### Основные файлы

| Путь | Назначение |
|---|---|
| `public/config.json` | Услуги, текущие цены, подписки, портфолио, контакты |
| `public/app.js` | Навигация, форма, профиль, Telegram SDK |
| `public/i18n.js` | Стартовый RU/EN-словарь новых полей заказа |
| `server/server.js` | HTTP, initData, серверный расчёт, snapshot заказа |
| `server/store.js` | Версионированное хранилище и восстановление |
| `server/order-state.js` | Payment/work state machine и legacy projection |
| `server/bot.js` | Telegram inbox/outbox, ручная оплата, CRM-кнопки |
| `docs/architecture-2.0.md` | ERD и целевой модульный монолит |
| `docs/api.md` | API и платёжный протокол |
| `docs/migration-2.0.md` | PostgreSQL, Fastify, React, S3/R2, RU/EN и rollback |

## Быстрый запуск

```bash
nvm use
npm ci
cp .env.example .env
npm start
```

Откройте `http://localhost:3000`. Без `BOT_TOKEN` и `OWNER_CHAT_ID` интерфейс доступен, но создание заказа честно возвращает `503 not_configured`. Без валидной Telegram initData заказ не принимается, если специально не включён `ALLOW_BROWSER_ORDERS=true`.

Не коммитьте `.env`. Токены, банковские реквизиты и персональные данные не выводятся в логи.

## Настройки

Обязательные для рабочего бота:

- `BOT_TOKEN` — только в секретах окружения;
- `OWNER_CHAT_ID` — числовой ID владельца;
- `APP_URL` — публичный HTTPS URL без завершающего `/`;
- `WEBHOOK_SECRET` — независимая случайная строка; если пусто, используется производное значение для обратной совместимости;
- `PAY_DETAILS` — реквизиты только в серверной конфигурации; `\n` обозначает перенос строки.

Если `PAY_DETAILS` пуст, заказ сохраняется, а клиент получает сумму, `pending_payment` и инструкцию связаться с владельцем. Никакие реквизиты не добавляются в `public/`, Git или логи.

`TRUST_PROXY=false` по умолчанию. Ставьте `true` только когда сервер доступен через управляемый reverse proxy и прямые клиенты не могут подменить `X-Forwarded-For`.

### Хранение

По умолчанию используется `data/runtime/orders.json`. При первом запуске старый `data/orders.json` импортируется полностью, исходник не изменяется, его содержимое сохраняется в runtime `.bak` до записи новой схемы. Для production задайте абсолютный `ORDERS_FILE` на приватном persistent volume.

Запись: temp file → `fsync` → atomic `rename`; предыдущее валидное состояние сохраняется в `.bak`. Повреждённый main восстанавливается из backup с quarantine-копией. Если валидного backup нет, запуск отклоняется — пустая база поверх данных не создаётся. Старые заказы не обрезаются по лимиту.

**До PostgreSQL поддерживается только один активный instance/writer.** Не запускайте replicas на общем JSON-файле. Нужны внешние backup и проверка восстановления.

## Ручная оплата

1. Сервер проверяет initData, сам считает сумму и сохраняет `pending_payment` со snapshot услуги/items/цены.
2. Бот отправляет номер, услугу, сумму, статус и реквизиты либо безопасную инструкцию.
3. Клиент нажимает «Я оплатил» → `payment_submitted` и отправляет JPG/PNG/WEBP или Telegram photo.
4. Чек добавляется в историю того же заказа → `payment_review`; владелец получает изображение и кнопки.
5. Владелец проверяет банк и выбирает: подтвердить, отклонить, запросить повторный чек или открыть информацию.
6. Подтверждение идемпотентно записывает actor/time/reason, `paid`, затем `in_progress` и outbox-уведомление.
7. Отклонение сохраняет причину; новый чек не удаляет предыдущие.

Подробнее: [`docs/api.md`](docs/api.md).

## Тесты

```bash
npm run check
npm run scan:secrets
npm test                 # storage + API + bot + legacy payment + payment/recovery 2.0
npx playwright install chromium
npm run test:ui          # настоящий Chromium, 320/390 px, Telegram stub
# или всё:
npm run test:all
```

`npm run test:legacy` запускает исходные API/bot/pay/UI regression suites. Все тесты используют уникальные временные `ORDERS_FILE`; UI гарантированно закрывает browser/server/mock в `finally` и не меняет реальные заказы или репозиторные screenshots.

CI: `.github/workflows/ci.yml`, Node.js 24, server и browser jobs, syntax/config/secret scan. Локальный scanner дополняет GitHub secret scanning, но не заменяет его.

## Изменение цен и портфолио

Редактируйте `public/config.json` отдельным согласованным изменением. Число в `price` — фиксированная цена, `null` — индивидуально, `"from": true` — «от». Существующие заказы содержат собственный snapshot, поэтому после перехода на новый формат изменение прайса не меняет их стоимость и состав.

После изменения config перезапустите server. Schema validation отклонит неизвестные дубли ID и некорректные цены при запуске.

## Production

- HTTPS, приватные секреты hosting, отдельный webhook secret.
- Persistent private disk, один writer, внешние backup и restore drill.
- Мониторинг накопления Telegram inbox/outbox и `last_error` без секретов.
- Не включать `ALLOW_BROWSER_ORDERS` без необходимости.
- Не делать merge/deploy без согласования владельца.

План безопасного перехода на PostgreSQL, TypeScript/Fastify, React/Vite, приватные S3/R2 и полную RU/EN: [`docs/migration-2.0.md`](docs/migration-2.0.md).

## SRT-план ролика для владельца

Владелец может прислать `.srt` из CapCut или вставить SRT текстом. Бот ответит файлом плана для montazh-remotion: слова с таймкодами, iPhone-выделение, сцены P/D/сплит и логотип. Подпись `16:9`, `клиент`, `петля` меняет параметры. Команда `/plan` доступна только владельцу; клиентские SRT по-прежнему просто пересылаются владельцу. Файл ограничен 1 МБ.
