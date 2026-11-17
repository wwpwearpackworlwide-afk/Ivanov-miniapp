/* RU/EN foundation for new CRM/profile fields. Legacy marketing content remains in config.json. */
(function () {
  'use strict';
  var user = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user;
  var locale = user && /^en\b/i.test(user.language_code || '') ? 'en' : 'ru';
  var dict = {
    ru: {
      'payment.pending_payment': 'Ожидает оплаты', 'payment.payment_submitted': 'Клиент сообщил об оплате',
      'payment.payment_review': 'Чек на проверке', 'payment.payment_rejected': 'Оплата отклонена — нужен новый чек',
      'payment.paid': 'Оплачено', 'payment.in_progress': 'Оплачено', 'payment.completed': 'Оплачено', 'payment.cancelled': 'Заказ отменён',
      'work.not_started': 'Ожидает начала', 'work.in_progress': 'В работе', 'work.completed': 'Готово', 'work.cancelled': 'Отменён',
      'order.composition': 'Состав заказа', 'order.total': 'Итого', 'order.payment': 'Оплата', 'order.work': 'Выполнение',
      'order.paidAt': 'Оплата подтверждена', 'order.createdAt': 'Создан', 'order.notAgreed': 'сумма согласовывается',
      'order.receipts': 'Чеков отправлено', 'order.empty': 'Состав появится после синхронизации с сервером'
    },
    en: {
      'payment.pending_payment': 'Awaiting payment', 'payment.payment_submitted': 'Payment reported by customer',
      'payment.payment_review': 'Receipt under review', 'payment.payment_rejected': 'Payment rejected — new receipt required',
      'payment.paid': 'Paid', 'payment.in_progress': 'Paid', 'payment.completed': 'Paid', 'payment.cancelled': 'Order cancelled',
      'work.not_started': 'Not started', 'work.in_progress': 'In progress', 'work.completed': 'Completed', 'work.cancelled': 'Cancelled',
      'order.composition': 'Order items', 'order.total': 'Total', 'order.payment': 'Payment', 'order.work': 'Fulfilment',
      'order.paidAt': 'Payment confirmed', 'order.createdAt': 'Created', 'order.notAgreed': 'price to be agreed',
      'order.receipts': 'Receipts submitted', 'order.empty': 'Order details will appear after server synchronisation'
    }
  };
  window.IvanovI18n = {
    locale: locale,
    t: function (key) { return (dict[locale] && dict[locale][key]) || dict.ru[key] || key; }
  };
})();
