# Telegram Bot для кадров

## Что умеет
- Пошаговая регистрация сотрудника: ФИО → телефон → должность → отдел.
- Проверка данных в таблице `Лексема_Кадры_ЛичнаяКарточка` (SQL Server).
- Генерация персональных инвайт-ссылок в новостной канал с TTL.
- Авто-управление черным списком: разбан работающих, бан уволенных.
- Ночная проверка статусов (00:00–05:00 МСК).
- Отдельная meta-БД (SQLite) для каналов отделов, админов, логов.
- Логи действий админов в meta-БД и в выбранный чат.
- Готов к установке на сервер завода (Windows/Linux).

## Быстрый старт (локально)
1) Скопируй `env.example` в `.env` и заполни:
```
BOT_TOKEN=...
CHANNEL_ID=@fallback_channel
NEWS_CHANNEL_ID=@news_channel
DB_URL="Driver={ODBC Driver 17 for SQL Server};Server=...;Database=...;Uid=...;Pwd=...;TrustServerCertificate=yes;"
META_DB_URL="file:./prisma/meta.db"
LINK_TTL_HOURS=24
OWNER_ID=твой_telegram_id
ADMIN_LOG_CHAT_ID=...   # можно задать командой
NODE_ENV=production
```
2) Установи зависимости: `npm install`  
3) Сгенерируй Prisma клиенты:
```
npm run prisma:generate
npm run prisma:generate:meta
```
4) Инициализируй meta-БД: `npm run prisma:push:meta`  
5) Запуск: `npm start`

## Подготовка БД (SQL Server)
Таблица: `Лексема_Кадры_ЛичнаяКарточка` (или `Lexema_Kadry_LichnayaKartochka`).

Обязательные поля:
- `VCode` (PK, int)
- `Фамилия`, `Имя`, `Отчество` (nvarchar)
- `Подразделение` (int)
- `Должность` (int)
- `Сотовый` (nvarchar)
- `ДатаУвольнения` (datetime, NULL если работает)
- `ТелеграмID` (bigint, NULL)
- `ТелеграмЮзернейм` (nvarchar, NULL)
- `ЧерныйСписок` (bit, по умолчанию 0)

Логика:
- `ДатаУвольнения = NULL` → считается работающим; если `ЧерныйСписок = 1`, бот снимет из ЧС.
- `ДатаУвольнения != NULL` → считается уволенным; бот занесет в ЧС и забанит в каналах.

## Запуск на сервере
### Windows Server
- Установи Node.js 20+ (с сайта или `choco install nodejs`).
- Поставь ODBC Driver 17 для SQL Server.
- `npm install`
- `npm run prisma:generate && npm run prisma:generate:meta`
- `npm run prisma:push:meta`
- `npm start`

### Linux (Ubuntu/Debian)
- Node.js 20+:  
  `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -`  
  `sudo apt install -y nodejs`
- ODBC Driver 17: добавить репозиторий Microsoft, затем `sudo ACCEPT_EULA=Y apt-get install -y msodbcsql17`
- `npm install`
- `npm run prisma:generate && npm run prisma:generate:meta`
- `npm run prisma:push:meta`
- `npm start`

### Работа 24/7 через PM2
```
npm install -g pm2
pm2 start src/index.js --name telegram-bot
pm2 save
pm2 startup   # выполнить команду, которую покажет PM2
```
Полезное:
- `pm2 list`
- `pm2 logs telegram-bot`
- `pm2 restart/stop/delete telegram-bot`
- `pm2 monit`

## Команды бота
Для всех:
- `/start` — регистрация
- `/reset` — сброс состояния
- `/help` — справка

Админ:
- `/test_data` — проверить данные сотрудника
- `/user_status <id|@username>`
- `/check_hist [id|@username]`
- `/news <текст>` — новость в канал
- `/remove_user <id|@username> <причина>` — бан в канале отдела
- `/bind_department <Отдел>` — привязать канал (выполнить в канале)

Владелец:
- `/add_admin <id|@username>` / `/unadd_admin <...>`
- `/list_employees`
- `/set_admin_log_chat` — чат для логов админов (выполнить в чате)
- `/set_news_channel` — новостной канал (выполнить в канале)
- `/check_fired` — проверить уволенных
- `/test_unban` — тест разбана работающих (removed users)
- `/unbind_all` — отвязать все каналы отделов
- `/bind_department <Отдел>` — привязать/изменить канал (выполнить в канале)

## Ночная проверка (00:00–05:00 МСК)
- Разбан работающих (ДатаУвольнения = NULL, но в ЧС).
- Бан уволенных (ДатаУвольнения != NULL) + добавление в ЧС.
- Логи отправляются в admin log chat (или в консоль, если чат не задан).

## Структура проекта
- `src/bot.js` — команды и логика бота
- `src/index.js` — вход, фоновые задачи, ночная проверка
- `src/config.js` — конфиг из `.env`
- `src/db.js` — основная БД (LexemaCard, SQL Server)
- `src/dbMeta.js` — meta-БД (SQLite)
- `src/services/employeeService.js` — поиск/сопоставление сотрудников
- `src/services/inviteService.js` — инвайт-ссылки
- `prisma/schema.prisma` — схема основной БД
- `prisma/meta.prisma` — схема meta-БД (каналы, админы, логи)

## Особенности
- Автоуправление ЧС: работающие — разбан, уволенные — бан + ЧС.
- Ночные проверки с логами в admin log chat.
- Персональные одноразовые инвайты с TTL.
- Meta-БД хранит каналы отделов, админов, логи, настройки.

## Деплой в двух словах
1) Настроить `.env`  
2) `npm install`  
3) `npm run prisma:generate && npm run prisma:generate:meta`  
4) `npm run prisma:push:meta`  
5) `npm start` или PM2.


