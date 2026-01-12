# Telegram Bot для кадров

## Возможности
- Регистрация: ФИО → телефон → должность → отдел.
- Проверка сотрудников в таблице SQL Server `Lexema_Кадры_ЛичнаяКарточка` (или `Lexema_Kadry_LichnayaKartochka`).
- Персональные инвайт-ссылки в новостной канал с TTL.
- Авто-ЧС: разбан работающих, бан уволенных.
- Ночная проверка статусов (00:00–05:00 МСК) с логами в admin log chat и meta-БД.
- Отдельная meta-БД (SQLite) для каналов, админов, логов.
- Деплой на Windows/Linux, работа 24/7 через PM2.

## Таблица в SQL Server (обязательные поля)
- `VCode` (PK, int)
- `Фамилия`, `Имя`, `Отчество` (nvarchar)
- `Подразделение` (int)
- `Должность` (int)
- `Сотовый` (nvarchar)
- `ДатаУвольнения` (datetime, NULL если работает)
- `ТелеграмID` (bigint, NULL)
- `ТелеграмЮзернейм` (nvarchar, NULL)
- `ЧерныйСписок` (bit, default 0)

Логика:  
`ДатаУвольнения = NULL` → работает; если `ЧерныйСписок = 1`, бот снимет из ЧС.  
`ДатаУвольнения != NULL` → уволен; бот занесёт в ЧС и забанит в каналах.

## Настройка .env
Скопируй `env.example` в `.env` и заполни:
```
BOT_TOKEN=...
CHANNEL_ID=@fallback_channel
DB_URL="sqlserver://localhost:1433;database=lktest;user=EmployeAdmin;password=123456;encrypt=true;trustServerCertificate=true"
META_DB_URL="file:./prisma/meta.db"
LINK_TTL_HOURS=24
OWNER_ID=твой_telegram_id
ADMIN_LOG_CHAT_ID=...   # можно задать командой /set_admin_log_chat
NODE_ENV=production
```

## Установка и Prisma
```
npm install
npm run prisma:generate
npm run prisma:generate:meta
npm run prisma:push:meta   # инициализация meta-БД (SQLite)
```

## Запуск
```
npm start
```

## Работа 24/7 (PM2)
```
npm install -g pm2
pm2 start src/index.js --name telegram-bot
pm2 save
pm2 startup   # выполнить команду, которую покажет PM2
```
Полезное: `pm2 list`, `pm2 logs telegram-bot`, `pm2 restart telegram-bot`, `pm2 stop telegram-bot`.

## Особенности и фоновые задачи
- Ночная проверка 00:00–05:00 МСК: разбан работающих (ДатаУвольнения = NULL, ЧС=1), бан уволенных (ДатаУвольнения != NULL) + ЧС.
- Логи ночной проверки и действий админов уходят в admin log chat (если задан) и в meta-БД.
- Персональные одноразовые инвайты с TTL; просроченные удаляются.
- Meta-БД хранит каналы отделов, админов, логи, настройки.

## Команды (кратко)
Пользователи: `/start`, `/reset`, `/help`  
Админ: `/test_data`, `/user_status`, `/check_hist`, `/news`, `/remove_user`, `/bind_department`  
Владелец: `/add_admin`, `/unadd_admin`, `/list_employees`, `/set_admin_log_chat`, `/set_news_channel`, `/check_fired`, `/test_unban`, `/unbind_all`, `/bind_department`

## Структура
- `src/bot.js` — команды и логика
- `src/index.js` — вход, фоновые задачи, ночная проверка
- `src/config.js` — конфиг из `.env`
- `src/db.js` — основная БД (LexemaCard, SQL Server)
- `src/dbMeta.js` — meta-БД (SQLite)
- `src/services/employeeService.js` — поиск/сопоставление сотрудников
- `src/services/inviteService.js` — инвайт-ссылки
- `prisma/schema.prisma` — схема основной БД
- `prisma/meta.prisma` — схема meta-БД

## Деплой в двух словах
1) Настроить `.env`  
2) `npm install`  
3) `npm run prisma:generate && npm run prisma:generate:meta`  
4) `npm run prisma:push:meta`  
5) `npm start` или PM2