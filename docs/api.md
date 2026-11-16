# API и платёжный протокол

## Текущие endpoint

### GET /api/health

Возвращает `{ ok, configured, bot }`. Не раскрывает token, реквизиты, путь хранилища или персональные данные.

### POST /api/order

Content-Type: `application/json`, тело до 10 КБ.

Обязательные данные: `serviceId` или `subscription`, `sourceUrl` по правилам услуги, `description`, `deadline`, `extras`, `contact`, `idempotencyKey`, `initData`.

Сервер:

1. Проверяет Telegram HMAC initData и `auth_date`.
2. Валидирует справочники и URL.
3. Игнорирует клиентскую сумму и рассчитывает её из `public/config.json`.
4. Создаёт уникальный номер, snapshot услуги/items/цены и `pending_payment`.
5. Атомарно сохраняет заказ вместе с `(telegramUserId, idempotencyKey)`.
6. Отправляет владельцу заявку; клиент получает сумму и реквизиты либо безопасную инструкцию связаться с владельцем.

Ответ: `{ ok: true, orderId }`. Повтор: `{ ok: true, orderId, duplicate: true }`.

Ошибки: `400 validation_error`, `401 init_data_required/invalid_init_data`, `413 too_large`, `415`, `429 rate_limited`, `502 telegram_error`, `503 not_configured`, `500 storage_error`.

### POST /api/my-orders

Тело `{ initData }`. Возвращает только заказы подписанного пользователя и его активный план.

Каждый заказ включает:

- `id`, `createdAt`, `serviceSnapshot`, `items`, `amount`, `currency`;
- `state`, `paymentStatus`, `workStatus`, `paymentConfirmedAt`;
- `paymentHistory` с from/to/time/reason;
- безопасную сводку `paymentAttempts` без чужих Telegram file ID;
- legacy `status` (`sent/work/done/cancel`) и `pay` (`wait/check/paid`) для старого клиента.

### POST /api/receipt

Тело `{ initData, orderId, receiptId }`.

Доступен владельцу и клиенту, которому принадлежит заказ. Чужой пользователь получает `403`, несуществующий чек — `404`. Возвращает только авторизованные metadata и Telegram file ID; публичной ссылки нет. В S3/R2-версии вместо file ID будет короткоживущий signed URL после той же проверки.

### POST /tg/webhook

Требуется `X-Telegram-Bot-Api-Secret-Token`, сравнение `timingSafeEqual`. Явный `WEBHOOK_SECRET` имеет приоритет над производным от token значением.

Update валидируется и синхронно записывается в durable inbox до HTTP 200. Точный повтор дедуплицируется. Ошибка обработки сохраняется с backoff; `processing` восстанавливается после restart. Невалидный JSON получает 400, большой body — 413, сбой записи — 500 без ACK.

## Ручная оплата

```text
pending_payment
  └─ клиент «Я оплатил» → payment_submitted
       └─ валидное изображение → payment_review
            ├─ владелец подтвердил банк → paid → in_progress → completed
            ├─ отклонил → payment_rejected ─┐
            └─ запросил повторный чек → payment_rejected ─┤
                                                         └─ новый чек → payment_review
Любой незавершённый заказ владелец может отменить → cancelled
```

- Принимаются Telegram photo и image document JPG/PNG/WEBP; размер ограничен `MAX_RECEIPT_BYTES`.
- Текст, SRT, PDF и другие документы не считаются чеком в текущей версии.
- Все чеки добавляются к тому же заказу; предыдущие metadata не удаляются.
- Скриншот не является доказательством платежа. Owner подтверждает поступление в банке.
- Owner callbacks проверяют владельца, `orderId`, `userId` и текущий статус.
- Повтор `confirm/reject/repeat` идемпотентен.
- `payment_rejected` всегда имеет причину. Повторный запрос записывается как `payment.repeat_requested`.
- Подтверждение сохраняет paid event, audit и outbox до отправки уведомления. Сбой Telegram не отменяет сохранённое решение.

## Owner/CRM-команды бота

- `pay:ok` — подтвердить после проверки банка.
- `pay:no` — отклонить с зафиксированной причиной.
- `pay:again` — запросить новый чек.
- `pay:info` — номер, услуга, сумма, статусы и число чеков.
- `/pay НОМЕР СУММА` — согласовать сумму для цены «от».
- `st:work/done/cancel` — выполнение заказа.
- `sp:on/off` — legacy управление подпиской.

## Совместимость

Внутренний `state` — источник истины. Старые поля являются проекцией:

| state | status | pay |
|---|---|---|
| pending_payment / submitted / review / rejected | sent | wait / wait / check / wait |
| paid | sent | paid |
| in_progress | work | paid |
| completed | done | paid, если была оплата |
| cancelled | cancel | зависит от paid_at |

Это позволяет сохранить исходные 146 regression-проверок и постепенно обновить клиентов.
