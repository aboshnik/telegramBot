
Функции
- Принимает ФИО, должность, отдел одной строкой (или через `|`) и сверяет со справочником `employees_ref`.
- Генерирует/переиспользует персональную инвайт-ссылку в канал отдела с TTL.
- Привязка сотрудников к Telegram ID/username в базе.
- Отдельная meta-БД для каналов отделов и списка админов.
- Логирование действий админов (удаления, ошибки) в meta-БД и в выбранный чат.
- Команды статуса/удаления пользователя с обязательной причиной.

Установка
1) Скопировать `env.example` в `.env` и заполнить:
```
BOT_TOKEN=...
CHANNEL_ID=@fallback_channel   # запасной канал, если нет привязки отдела
DB_URL="file:./dev.db"
META_DB_URL="file:./meta.db"
LINK_TTL_HOURS=24
OWNER_ID=...
ADMIN_LOG_CHAT_ID=...         # можно настроить командой
NODE_ENV=development
```
2) `npm install`
3) Основная БД: `npx prisma db push` (или `prisma migrate` для Postgres)
4) Meta-БД: `npm run prisma:push:meta`
5) (Опционально) сид сотрудников: `npm run seed`

Запуск

Локально:
- `npm start`

На сервере (VPS):
1) Установи Node.js (версия 20+):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

2) Установи зависимости:
   ```bash
   npm install
   ```

3) Сгенерируй Prisma клиенты:
   ```bash
   npm run prisma:generate
   npm run prisma:generate:meta
   ```

4) Инициализируй БД:
   ```bash
   npm run prisma:push
   npm run prisma:push:meta
   ```

5) Запусти бота:
   ```bash
   npm start
   ```

Для работы 24/7 используй PM2:
```bash
npm install -g pm2
pm2 start src/index.js --name telegram-bot
pm2 save
pm2 startup  # для автозапуска при перезагрузке сервера
```

Привязки и админы
- `/bind_department <Отдел>` — выполнить в канале отдела; сохраняется `chat.id` (создать может админ, менять только владелец).
- `/add_admin <id|@username>` — добавить админа (только владелец).
- `/unadd_admin <id|@username>` — убрать админа (только владелец).
- `/set_admin_log_chat` — выполнить в чате для логов (только владелец); лог-чат сохранится в meta-БД.

Статусы и удаление
- `/user_status <id|@username>` — статус пользователя в канале его отдела.
- `/remove_user <id|@username> причина` — бан в канале отдела с логом и уведомлением в чат логов.
- `/check_hist [id|@username]` — последние 10 записей из журнала админов (фильтр по цели).

Структура
- `src/bot.js` — команды и сценарии.
- `prisma/schema.prisma` — основная БД (сотрудники, пользователи, инвайты, аудит).
- `prisma/meta.prisma` — meta-БД (каналы отделов, админы, лог админов, настройки лог-чата).

Под прод
- Перейти на Postgres для основной БД (`DB_URL`), использовать `prisma migrate`.
- META_DB_URL можно оставить SQLite (небольшая БД).
- Поднять вебхук вместо long polling.
- Дать боту права админа в каналах отделов.

### Миграция на PostgreSQL (только для основной БД)

1. Установи PostgreSQL на сервере:
   ```bash
   sudo apt install postgresql postgresql-contrib -y
   sudo systemctl start postgresql
   ```

2. Создай БД и пользователя:
   ```bash
   sudo -u postgres psql
   CREATE DATABASE telegram_bot;
   CREATE USER telegram_user WITH PASSWORD 'твой_пароль';
   GRANT ALL PRIVILEGES ON DATABASE telegram_bot TO telegram_user;
   \q
   ```

3. Обнови `.env`:
   ```
   DB_URL=postgresql://telegram_user:твой_пароль@localhost:5432/telegram_bot
   META_DB_URL=file:./meta.db  # Оставляем SQLite
   ```

4. Примени схему:
   ```bash
   npm run prisma:push
   ```

5. Импортируй данные из SQLite (если нужно) или используй seed.

