# Безопасная миграция к 2.0

## Что уже сделано без смены стека

- Сохранены текущие frontend, логотип, портфолио, стиль и цены.
- Backend разделён на `store`, `order-state`, `config-schema`, `bot`, HTTP server.
- JSON стал версионированным, атомарным и восстанавливаемым; legacy fixture отделён от runtime.
- Добавлены snapshot заказа, financial audit, Telegram inbox/outbox и RU/EN-словарь новых полей.

Это подготовительный modular monolith, а не попытка заменить всё приложение.

## Ограничение текущего этапа

JSON допускает **только один активный writer/instance**. Нельзя запускать два server process или несколько replicas на одном файле. Для production нужен приватный persistent volume и регулярные внешние backup. NFS/multi-writer не поддерживается.

Финансовое решение и его outbox сохраняются одной файловой записью, но это не распределённая транзакция и не замена PostgreSQL constraints/row locks.

## Этап 0 — backup и восстановление

1. Зафиксировать checksum и копию `orders.json`, `.bak`, конфигурации и файлов.
2. Зашифровать внешнюю копию; доступ только владельцу.
3. Провести restore drill на отдельном каталоге и проверить число заказов, суммы, историю и чеки.
4. Не выполнять destructive migration без подтверждённой копии и плана rollback.

## Этап 1 — PostgreSQL repository

1. Создать схему из `architecture-2.0.md` через версионные миграции.
2. Скрыть PostgreSQL за интерфейсом текущего repository: orders/idempotency/inbox/outbox.
3. Backfill выполнять идемпотентным скриптом с external legacy ID и checksum; не менять источник.
4. Сверить: counts, public numbers, customer binding, amount/currency, snapshots, paid_at, все events/files.
5. Сначала shadow reads и сравнение ответов; затем короткий maintenance window и переключение writer.
6. JSON перевести в read-only backup. Rollback до cutover — продолжить использовать JSON; после cutover нужен отдельный план обратной репликации, его нельзя импровизировать.

## Этап 2 — TypeScript + Fastify

Переносить HTTP shell и модули по одному, сохраняя API contract tests. Старые endpoint не меняют URL одновременно со сменой framework. Fastify выбран за схемную валидацию, TypeScript и низкий overhead; альтернатива Nest оправдана только при росте команды и необходимости более тяжёлого DI.

Новые модули:

- `catalog`: services/options/price versions;
- `orders`: state machine, snapshots, idempotency;
- `payments`: manual review, audit, owner policy;
- `telegram`: inbox, webhook, Bot API adapter;
- `notifications`: outbox relay;
- `subscriptions`: periods/usage;
- `files`: приватные чеки;
- `crm`: owner queries/actions.

## Этап 3 — приватные файлы S3/R2

1. Проверять MIME и magic bytes, размер, image decode; имя файла не доверять.
2. Приватный bucket, шифрование, lifecycle/retention по согласованию с владельцем.
3. Чеки не отправлять в публичный CDN. Доступ через короткий signed URL после owner/customer ACL.
4. Telegram file ID хранить как чувствительную metadata; не писать в логи.
5. Мигрировать только после подсчёта файлов и проверки hashes; ошибки не пропускать молча.

## Этап 4 — React + TypeScript + Vite

Сначала catalog/profile как отдельные модули с parity screenshots и browser tests. Старый Vanilla JS остаётся fallback до равенства функциональности. Затем форма, подписки и портфолио. Не переписывать CSS 3D и визуальные ассеты ради framework.

## Этап 5 — полная RU/EN

- `customers.locale` и Telegram `language_code` определяют начальный язык; пользователь может изменить выбор.
- Вынести marketing/config/bot тексты в переводимые ресурсы.
- Названия и snapshot сохранять на языке заказа плюс стабильные коды справочника.
- Проверять ru/en длину текста на 320/390 px, plural rules, даты и currency.

## Production checklist

- Node.js 24 LTS, `npm ci`, CI server + browser + secret scan зелёные.
- Один JSON writer либо PostgreSQL с миграциями и backup.
- `BOT_TOKEN`, `OWNER_CHAT_ID`, независимый `WEBHOOK_SECRET`, `APP_URL` заданы.
- `PAY_DETAILS` задан только в секретах hosting; пустое значение безопасно.
- `TRUST_PROXY=true` только за управляемым proxy; иначе false.
- Persistent private storage, restore drill, мониторинг inbox/outbox attempts.
- Нет автоматического эквайринга и ложного auto-paid.
- Ветка проверена владельцем; merge/deploy выполняются отдельно после согласования.
