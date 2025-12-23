import { Telegraf, Markup } from "telegraf";
import { formatISO9075 } from "date-fns";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { prismaMeta } from "./dbMeta.js";
import { findEmployee } from "./services/employeeService.js";
import { getOrCreateInviteLink } from "./services/inviteService.js";

const isPrivate = (ctx) => ctx.chat?.type === "private";
const isOwner = (ctx) =>
  ctx.from && config.ownerId && String(ctx.from.id) === String(config.ownerId);

// Хранилище состояний пользователей для поэтапного заполнения
const userStates = new Map(); // telegramId -> { step, data: { fullName, phoneNumber, position, department } }

// Регулярное выражение для валидации номера телефона (разрешаем +7, цифры и разделители)
const phoneRegex = /^\+?[\d\s\-\(\)]+$/;

// Нормализация телефона: обрабатываем все возможные форматы (+7, 8, прямой ввод с 9)
// Результат: всегда 10 цифр, начинающихся с 9 (код оператора)
const normalizePhone = (text) => {
  const digits = text.replace(/\D/g, "");
  
  // Если номер начинается с 7 (11 цифр): +7 900 111-22-33 или 79001112233
  // Убираем первую 7, оставляем 10 цифр
  if (digits.length === 11 && digits.startsWith("7")) {
    return digits.slice(1);
  }
  
  // Если номер начинается с 8 (11 цифр): 8 900 111-22-33 или 89001112233
  // Убираем первую 8, оставляем 10 цифр
  if (digits.length === 11 && digits.startsWith("8")) {
    return digits.slice(1);
  }
  
  // Если номер 10 цифр и начинается с 9: 900 111-22-33 или 9001112233
  // Оставляем как есть
  if (digits.length === 10 && digits.startsWith("9")) {
    return digits;
  }
  
  // Если номер 10 цифр и начинается с 8: 8805353341
  // Убираем первую 8, оставляем 9 цифр (добавим 9 в начале)
  if (digits.length === 10 && digits.startsWith("8")) {
    return "9" + digits.slice(1);
  }
  
  // Если номер 9 цифр: 805353341
  // Добавляем 9 в начало
  if (digits.length === 9) {
    return "9" + digits;
  }
  
  // Возвращаем как есть (на случай других форматов)
  return digits;
};

// Временные сессии подтверждения при попытке входа с чужим Telegram
const pendingSessions = new Map(); // sessionId -> { requesterId, form, expiresAt }
const createSessionId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function hasAdminAccess(ctx) {
  if (isOwner(ctx)) return true;
  if (!ctx.from?.id) return false;
  const existing = await prismaMeta.admin.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
  });
  return Boolean(existing);
}

export function createBot() {
  const bot = new Telegraf(config.botToken);

  bot.start(async (ctx) => {
    if (!isPrivate(ctx)) return;
    
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("Не удалось получить твой Telegram ID.");
      return;
    }

    // Сбрасываем состояние и начинаем заново
    userStates.set(telegramId, {
      step: "waiting_lastName",
      data: {}
    });

    await ctx.reply(
      "Добро пожаловать! Введите следующие данные, соблюдая этапы:\n\n" +
      "1. Фамилия"
    );
  });

  bot.command("reset", async (ctx) => {
    if (!isPrivate(ctx)) return;
    
    const telegramId = ctx.from?.id;
    if (telegramId) {
      userStates.delete(telegramId);
    }
    
    await ctx.reply(
      "Начинаем заново. Введите следующие данные, соблюдая этапы:\n\n" +
      "1. Фамилия"
    );
    
    if (telegramId) {
      userStates.set(telegramId, {
        step: "waiting_lastName",
        data: {}
      });
    }
  });

  bot.command("bind_department", async (ctx) => {
    if (!(await hasAdminAccess(ctx))) {
      await ctx.reply("Нет прав для выполнения этой команды.");
      return;
    }

    const args = ctx.message?.text?.split(" ").slice(1).join(" ").trim();
    if (!args) {
      await ctx.reply(
        "Укажи отдел: /bind_department Отдел разработки (команду надо выполнять в нужном чате/канале)"
      );
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply("Не удалось определить chat_id.");
      return;
    }

    const existing = await prismaMeta.departmentChannel.findUnique({
      where: { department: args },
    });

    if (existing && existing.channelId && !isOwner(ctx)) {
      await ctx.reply(
        "Для этого отдела канал уже привязан. Изменить может только владелец."
      );
      return;
    }

    await prismaMeta.departmentChannel.upsert({
      where: { department: args },
      update: isOwner(ctx)
        ? { channelId: String(chatId) }
        : existing
        ? {} // should not happen due to guard, but keep safe
        : { channelId: String(chatId) },
      create: { department: args, channelId: String(chatId) },
    });

    await ctx.reply(
      `Связал отдел "${args}" с chat_id=${chatId}. Теперь ссылки будут генерироваться сюда.`
    );
  });

  bot.command("add_admin", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Нет прав для выполнения этой команды (только владелец).");
      return;
    }
    const target = resolveTarget(ctx);
    let targetId = target?.telegramId;
    let targetUsername = target?.username;
    if (!targetId && target?.username) {
      const user = await findUserByTarget(target);
      if (user) {
        targetId = String(user.telegramId);
        targetUsername = user.telegramUsername || target.username;
      }
    }
    if (!targetId || !/^-?\d+$/.test(targetId)) {
      await ctx.reply(
        "Укажи telegram id или @username: /add_admin 123456789 или /add_admin @username (можно ответом на его сообщение)."
      );
      return;
    }

    await prismaMeta.admin.upsert({
      where: { telegramId: BigInt(targetId) },
      update: { telegramUsername: targetUsername || null },
      create: { telegramId: BigInt(targetId), telegramUsername: targetUsername || null },
    });

    await ctx.reply(
      `Администратор добавлен: ${targetId}${targetUsername ? ` (@${targetUsername})` : ""}`
    );
  });

  bot.command("unadd_admin", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Нет прав для выполнения этой команды (только владелец).");
      return;
    }
    const target = resolveTarget(ctx);
    let targetId = target?.telegramId;
    let targetUsername = target?.username;
    if (!targetId && target?.username) {
      const user = await findUserByTarget(target);
      if (user) targetId = String(user.telegramId);
    }

    const hasId = targetId && /^-?\d+$/.test(targetId);
    if (!hasId && !targetUsername) {
      await ctx.reply(
        "Укажи telegram id или @username: /unadd_admin 123456789 или /unadd_admin @username (можно ответом на сообщение)."
      );
      return;
    }

    try {
      const byId = hasId
        ? await prismaMeta.admin.deleteMany({
            where: { telegramId: BigInt(targetId) },
          })
        : { count: 0 };

      const byUsername =
        !hasId && targetUsername
          ? await prismaMeta.admin.deleteMany({
              where: { telegramUsername: targetUsername },
            })
          : { count: 0 };

      const removed = (byId?.count || 0) + (byUsername?.count || 0);
      if (removed > 0) {
        await ctx.reply(`Администратор снят: ${hasId ? targetId : "@" + targetUsername}`);
      } else {
        await ctx.reply("Такого администратора нет или не удалось удалить.");
      }
    } catch (err) {
      console.error(err);
      await ctx.reply("Такого администратора нет или не удалось удалить.");
    }
  });

  bot.command("list_employees", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Нет прав для выполнения этой команды (только владелец).");
      return;
    }
    try {
      const employees = await prismaMeta.employeeRef.findMany({
        where: { active: true },
        orderBy: [{ department: "asc" }, { fullName: "asc" }],
        take: 200,
      });

      if (!employees.length) {
        await ctx.reply("Список сотрудников пуст.");
        return;
      }

      const lines = employees.map(
        (e, idx) => `${idx + 1}. ${e.fullName} — ${e.position} — ${e.department}`
      );

      const chunkSize = 40;
      for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize).join("\n");
        await ctx.reply(chunk);
      }
    } catch (err) {
      console.error(err);
      await ctx.reply("Не удалось выгрузить сотрудников. Попробуй позже.");
    }
  });

  bot.command("test_data", async (ctx) => {
    if (!(await hasAdminAccess(ctx))) {
      await ctx.reply("Нет прав для выполнения этой команды.");
      return;
    }
    try {
      const employees = await prisma.lexemaCard.findMany({
        take: 10,
        orderBy: { code: 'asc' }
      });
      if (!employees.length) {
        await ctx.reply("Список сотрудников пуст.");
        return;
      }
      const lines = employees.flatMap((e) => [
        `Код: ${e.code}`,
        `Фамилия: ${e.lastName || '—'}`,
        `Имя: ${e.firstName || '—'}`,
        `Отчество: ${e.middleName || '—'}`,
        `Подразделение: ${e.departmentId || '—'}`,
        `Должность: ${e.positionId || '—'}`,
        `ДатаУвольнения: ${e.terminationDate ? e.terminationDate.toISOString() : '—'}`,
        `Сотовый: ${e.phone || '—'}`,
        `ТелеграмЮзернейм: ${e.telegramUsername || '—'}`,
        `ТелеграмID: ${e.telegramId || '—'}`,
        `ЧерныйСписок: ${e.blacklisted === true ? 'Да' : e.blacklisted === false ? 'Нет' : '—'}`,
        '' // empty line
      ]);
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      console.error(err);
      await ctx.reply("Ошибка при получении данных.");
    }
  });

  bot.command("user_status", async (ctx) => {
    if (!(await hasAdminAccess(ctx))) {
      await ctx.reply("Нет прав для выполнения этой команды.");
      return;
    }
    const target = resolveTarget(ctx);
    if (!target) {
      await ctx.reply(
        "Укажи telegram id или @username: /user_status 123456789 или /user_status @username (можно ответом на сообщение)."
      );
      return;
    }

    const user = await findUserByTarget(target);
    if (!user) {
      await ctx.reply("Пользователь не найден в базе бота.");
      return;
    }

    // Проверяем статус "уволен" из БД через связь с EmployeeRef
    let employmentStatus = "активен";
    if (user.empId) {
      try {
        const employee = await prismaMeta.employeeRef.findUnique({
          where: { id: user.empId },
          select: { fired: true, blacklisted: true },
        });
        if (employee) {
          if (employee.fired) {
            employmentStatus = "уволен";
          } else if (employee.blacklisted) {
            employmentStatus = "в чёрном списке";
          }
        }
    } catch (err) {
        console.error("Failed to check employee status", err);
      }
    }

      await ctx.reply(
      `Пользователь: ${user.fullName}\nID: ${user.telegramId}\nДолжность: ${user.position}\nОтдел: ${user.department}\nСтатус: ${employmentStatus}`
      );
  });

  bot.command("check_hist", async (ctx) => {
    if (!(await hasAdminAccess(ctx))) {
      await ctx.reply("Нет прав для выполнения этой команды.");
      return;
    }
    const target = resolveTarget(ctx);
    let filter = {};
    if (target?.telegramId) {
      filter = { targetTelegramId: BigInt(target.telegramId) };
    } else if (target?.username) {
      filter = { targetUsername: target.username };
    }

    const logs = await prismaMeta.adminLog.findMany({
      where: Object.keys(filter).length ? filter : undefined,
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    if (!logs.length) {
      await ctx.reply("Записей не найдено.");
      return;
    }

    const lines = logs.map((l) => {
      const actor = `${l.actorTelegramId}${l.actorUsername ? ` (@${l.actorUsername})` : ""}`;
      const targetLine = l.targetTelegramId
        ? `${l.targetTelegramId}${l.targetUsername ? ` (@${l.targetUsername})` : ""}`
        : l.targetUsername
        ? `@${l.targetUsername}`
        : "—";
      const channelLine = l.channelId
        ? l.channelName
          ? `${l.channelName} (${l.channelId})`
          : l.channelId
        : "—";
      return `• ${l.action} | actor: ${actor} | target: ${targetLine} | channel: ${channelLine} | dept: ${l.department || "—"} | reason: ${l.reason || "—"} | at ${l.createdAt.toISOString()}`;
    });

    const chunk = lines.join("\n");
    await ctx.reply(chunk);
  });

  bot.command("news", async (ctx) => {
    await handleNewsCommand(ctx);
  });

  bot.command("set_admin_log_chat", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Нет прав для выполнения этой команды (только владелец).");
      return;
    }
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply("Не удалось определить chat_id.");
      return;
    }

    await prismaMeta.adminSettings.upsert({
      where: { id: 1 },
      update: { adminLogChatId: String(chatId) },
      create: { id: 1, adminLogChatId: String(chatId) },
    });

    adminLogChatIdCache = String(chatId);
    await ctx.reply(`Admin log chat установлен: ${chatId}`);
  });

  // Обработка /news с фото в подписи
  bot.on("photo", async (ctx) => {
    const caption = ctx.message?.caption || "";
    if (!/^\/news(@\w+)?\b/i.test(caption)) return;
    await handleNewsCommand(ctx);
  });

  // Подтверждение/блокировка сессии при попытке входа под чужим Telegram
  bot.action(/^session_(allow|block)_(.+)$/, async (ctx) => {
    const action = ctx.match[1]; // allow | block
    const sessionId = ctx.match[2];
    const session = pendingSessions.get(sessionId);

    if (!session) {
      await ctx.answerCbQuery("Сессия не найдена или истекла.");
      return;
    }

    // Проверка истечения
    if (session.expiresAt && Date.now() > session.expiresAt) {
      pendingSessions.delete(sessionId);
      await ctx.answerCbQuery("Сессия истекла.");
      return;
    }

    pendingSessions.delete(sessionId);

    if (action === "block") {
      await ctx.answerCbQuery("Сессию заблокировали.");
      try {
        await ctx.telegram.sendMessage(
          Number(session.requesterId),
          "Произошла ошибка."
        );
      } catch (err) {
        console.error("Failed to notify requester (block)", err);
      }
      return;
    }

    // allow
    await ctx.answerCbQuery("Доступ разрешён. Попросите повторить попытку.");
    try {
      await ctx.telegram.sendMessage(
        Number(session.requesterId),
        "Доступ подтверждён. Отправь /start ещё раз, чтобы продолжить."
      );
    } catch (err) {
      console.error("Failed to notify requester (allow)", err);
    }
  });

  bot.command("set_news_channel", async (ctx) => {
    const chatType = ctx.chat?.type;
    const isChannelContext = chatType === "channel" || chatType === "supergroup";

    // В личке ограничиваем только владельцем, в канале разрешаем без проверки (у бота и так должны быть права админа)
    if (!isChannelContext && !isOwner(ctx)) {
      await ctx.reply("Нет прав для выполнения этой команды (только владелец).");
      return;
    }

    
  


    let targetChannelId;

    if (isChannelContext) {
      // Если команда вызвана прямо в канале — используем его chat.id
      targetChannelId = ctx.chat?.id;
    } else {
      // В личке ждём chat_id/username канала аргументом: /set_news_channel -100..., /set_news_channel @channel
      const arg = ctx.message?.text?.split(" ").slice(1).join(" ").trim();
      if (!arg) {
        await ctx.reply(
          "Используй команду так:\n" +
            "1) В самом новостном канале: просто /set_news_channel\n" +
            "или\n" +
            "2) В личке с ботом: /set_news_channel -1001234567890 или /set_news_channel @username_канала"
        );
        return;
      }
      targetChannelId = arg;
    }

    if (!targetChannelId) {
      await ctx.reply("Не удалось определить идентификатор канала.");
      return;
    }

    await prismaMeta.adminSettings.upsert({
      where: { id: 1 },
      update: { newsChannelId: String(targetChannelId) },
      create: { id: 1, newsChannelId: String(targetChannelId) },
    });

    newsChannelIdCache = String(targetChannelId);
    await ctx.reply(`Новостной канал установлен: ${targetChannelId}`);
  });

  // Временная команда для ручной проверки БД и кика уволенных/в ЧС
  bot.command("check_fired", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Нет прав для выполнения этой команды (только владелец).");
      return;
    }

    try {
      const employees = await prismaMeta.employeeRef.findMany({
        where: {
          OR: [{ fired: true }, { blacklisted: true }],
          telegramId: { not: null },
        },
      });

      if (!employees.length) {
        await ctx.reply("Нет сотрудников со статусом 'уволен' или в чёрном списке.");
        return;
      }

      const newsChannelId = await getNewsChannelId();
      let processed = 0;

      for (const emp of employees) {
        const tgId = Number(emp.telegramId);

        // Канал отдела
        try {
          const channelId = await resolveChannelId(emp.department);
          await ctx.telegram.banChatMember(channelId, tgId);
        } catch (err) {
          console.error("check_fired: failed to ban from department channel", err);
        }

        // Новостной канал
        if (newsChannelId) {
          try {
            await ctx.telegram.banChatMember(newsChannelId, tgId);
          } catch (err) {
            console.error("check_fired: failed to ban from news channel", err);
          }
        }

        try {
          await prismaMeta.employeeRef.update({
            where: { id: emp.id },
            data: { blacklisted: true },
          });
        } catch (err) {
          console.error("check_fired: failed to mark blacklisted", err);
        }

        try {
          await prismaMeta.auditLog.create({
            data: {
              telegramId: BigInt(emp.telegramId),
              action: "manual_check_block",
              payloadJson: JSON.stringify({
                empId: emp.id,
                fired: emp.fired,
                blacklisted: emp.blacklisted,
              }),
            },
          });
        } catch (err) {
          console.error("check_fired: failed to write audit log", err);
        }

        processed += 1;
      }

      await ctx.reply(`Проверка завершена. Обработано сотрудников: ${processed}.`);
    } catch (err) {
      console.error("check_fired failed", err);
      await ctx.reply("Не удалось выполнить проверку. Попробуй позже.");
    }
  });

  // Полный сброс привязок: EmployeeRef.telegramId/telegramUsername + очистка таблицы User
  bot.command("unbind_all", async (ctx) => {
    if (!isOwner(ctx)) {
      await ctx.reply("Нет прав для выполнения этой команды (только владелец).");
      return;
    }

    try {
      // Удаляем ссылки, потом пользователей, потом обнуляем привязки сотрудников — чтобы не ловить FK ошибки
      const linksResult = await prismaMeta.inviteLink.deleteMany({});
      const userResult = await prismaMeta.user.deleteMany({});
      const empResult = await prismaMeta.employeeRef.updateMany({
        data: { telegramId: null, telegramUsername: null },
      });

      await ctx.reply(
        [
          `Удалено invite ссылок: ${linksResult.count}.`,
          `Удалено записей пользователей (User): ${userResult.count}.`,
          `Сброшены привязки Telegram ID/username у ${empResult.count} сотрудников.`,
        ].join("\n")
      );
    } catch (err) {
      console.error(err);
      await ctx.reply("Не удалось сбросить привязки. Попробуй позже.");
    }
  });

  bot.command("check_hist", async (ctx) => {
    if (!(await hasAdminAccess(ctx))) {
      await ctx.reply("Нет прав для выполнения этой команды.");
      return;
    }
    const target = resolveTarget(ctx);
    let filter = {};
    if (target?.telegramId) {
      filter = { targetTelegramId: BigInt(target.telegramId) };
    } else if (target?.username) {
      filter = { targetUsername: target.username };
    }

    const logs = await prismaMeta.adminLog.findMany({
      where: Object.keys(filter).length ? filter : undefined,
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    if (!logs.length) {
      await ctx.reply("Записей не найдено.");
      return;
    }

    const lines = logs.map((l) => {
      const actor = `${l.actorTelegramId}${l.actorUsername ? ` (@${l.actorUsername})` : ""}`;
      const targetLine = l.targetTelegramId
        ? `${l.targetTelegramId}${l.targetUsername ? ` (@${l.targetUsername})` : ""}`
        : l.targetUsername
        ? `@${l.targetUsername}`
        : "—";
      return `• ${l.action} | actor: ${actor} | target: ${targetLine} | dept: ${l.department || "—"} | reason: ${l.reason || "—"} | at ${l.createdAt.toISOString()}`;
    });

    const chunk = lines.join("\n");
    await ctx.reply(chunk);
  });

  bot.command("remove_user", async (ctx) => {
    if (!(await hasAdminAccess(ctx))) {
      await ctx.reply("Нет прав для выполнения этой команды.");
      return;
    }
    const parsed = parseRemoveArgs(ctx);
    if (!parsed.target) {
      await ctx.reply(
        "Укажи telegram id или @username и причину: /remove_user 123456789 спам или /remove_user @username нарушил правила (можно ответом на сообщение)."
      );
      return;
    }
    if (!parsed.reason) {
      await ctx.reply("Укажи причину удаления после идентификатора пользователя.");
      return;
    }

    const user = await findUserByTarget(parsed.target);
    if (!user) {
      await ctx.reply("Пользователь не найден в базе бота.");
      return;
    }

    let channelId;
    try {
      channelId = await resolveChannelId(user.department);
    } catch (err) {
      console.error(err);
      await ctx.reply("Не найден канал для отдела пользователя.");
      return;
    }

    try {
      await ctx.telegram.banChatMember(channelId, Number(user.telegramId));
      await prismaMeta.auditLog.create({
        data: {
          telegramId: BigInt(ctx.from.id),
          action: "remove_user",
          payloadJson: JSON.stringify({
            targetId: Number(user.telegramId),
            channelId: String(channelId),
            department: user.department,
            reason: parsed.reason,
          }),
        },
      });
      await logAdminAction(ctx, {
        action: "remove_user",
        actorId: ctx.from.id,
        actorUsername: ctx.from.username,
        targetId: Number(user.telegramId),
        targetUsername: user.telegramUsername || null,
        department: user.department,
        channelId: String(channelId),
        reason: parsed.reason,
      });
      await ctx.reply(
        `Пользователь ${user.fullName} (ID: ${user.telegramId}) удалён из канала отдела. Причина: ${parsed.reason}`
      );
    } catch (err) {
      console.error(err);
      await prismaMeta.auditLog.create({
        data: {
          telegramId: BigInt(ctx.from.id),
          action: "remove_user_failed",
          payloadJson: JSON.stringify({
            targetId: Number(user.telegramId),
            channelId: String(channelId),
            error: err.response?.description || err.message,
            reason: parsed.reason,
          }),
        },
      });
      await logAdminAction(ctx, {
        action: "remove_user_failed",
        actorId: ctx.from.id,
        actorUsername: ctx.from.username,
        targetId: Number(user.telegramId),
        targetUsername: user.telegramUsername || null,
        department: user.department,
        channelId: String(channelId),
        reason: parsed.reason,
        error: err.response?.description || err.message,
      });
      await ctx.reply(
        `Не удалось удалить пользователя: ${err.response?.description || err.message}`
      );
    }
  });

  bot.on("text", async (ctx) => {
    // Игнорируем произвольные сообщения в группах/каналах, кроме админ-команд
    if (!isPrivate(ctx)) return;

    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("Не удалось получить твой Telegram ID.");
      return;
    }

    const text = ctx.message.text.trim();
    
    // Проверяем, есть ли у пользователя активное состояние заполнения
    const userState = userStates.get(telegramId);
    
    if (!userState) {
      // Если состояния нет, предлагаем начать с /start
      await ctx.reply("Для начала работы используйте команду /start");
      return;
    }

    try {
      // Обрабатываем каждый этап
      switch (userState.step) {
        case "waiting_lastName":
          if (!text || text.length < 2) {
            await ctx.reply("Пожалуйста, введите фамилию (минимум 2 символа).");
            return;
          }
          userState.data.lastName = text.trim();
          userState.step = "waiting_firstName";
          await ctx.reply("2. Имя");
          break;

        case "waiting_firstName":
          if (!text || text.length < 2) {
            await ctx.reply("Пожалуйста, введите имя (минимум 2 символа).");
            return;
          }
          userState.data.firstName = text.trim();
          userState.step = "waiting_middleName";
          await ctx.reply("3. Отчество (если нет, введите \"-\")");
          break;

        case "waiting_middleName":
          userState.data.middleName = text.trim() === "-" ? null : text.trim();
          userState.step = "waiting_positionId";
          await ctx.reply("4. Должность (ID - число)");
          break;

        case "waiting_positionId":
          const positionId = parseInt(text.trim());
          if (isNaN(positionId)) {
            await ctx.reply("Пожалуйста, введите корректный ID должности (число).");
            return;
          }
          userState.data.positionId = positionId;
          userState.step = "waiting_departmentId";
          await ctx.reply("5. Подразделение (ID - число)");
          break;

        case "waiting_departmentId":
          const departmentId = parseInt(text.trim());
          if (isNaN(departmentId)) {
            await ctx.reply("Пожалуйста, введите корректный ID подразделения (число).");
            return;
          }
          userState.data.departmentId = departmentId;
          userState.step = "waiting_phone";
          await ctx.reply("6. Номер телефона");
          break;

        case "waiting_phone":
          // Валидация: принимаем все форматы (+7, 8, прямой ввод с 9)
          if (!phoneRegex.test(text)) {
            await ctx.reply("Пожалуйста, введите номер телефона в любом формате:\n+7 900 111-22-33\n8 900 111-22-33\n900-111-22-33\n89001112233");
            return;
          }
          const phoneDigits = normalizePhone(text);
          // После нормализации должно быть 10 цифр, начинающихся с 9
          if (phoneDigits.length !== 10 || !phoneDigits.startsWith("9")) {
            await ctx.reply("Пожалуйста, введите корректный номер телефона в любом формате:\n+7 900 111-22-33\n8 900 111-22-33\n900-111-22-33\n89001112233");
            return;
          }
          userState.data.phoneNumber = phoneDigits;
          
          // Все данные собраны, показываем подтверждение
          await showDataConfirmation(ctx, userState.data);
          userState.step = "confirming_data";
          break;

        case "editing_lastName":
          if (!text || text.length < 2) {
            await ctx.reply("Пожалуйста, введите фамилию (минимум 2 символа).");
            return;
          }
          userState.data.lastName = text.trim();
          await showDataConfirmation(ctx, userState.data);
          userState.step = "confirming_data";
          break;

        case "editing_firstName":
          if (!text || text.length < 2) {
            await ctx.reply("Пожалуйста, введите имя (минимум 2 символа).");
            return;
          }
          userState.data.firstName = text.trim();
          await showDataConfirmation(ctx, userState.data);
          userState.step = "confirming_data";
          break;

        case "editing_middleName":
          userState.data.middleName = text.trim() === "-" ? null : text.trim();
          await showDataConfirmation(ctx, userState.data);
          userState.step = "confirming_data";
          break;

        case "editing_positionId":
          const editPositionId = parseInt(text.trim());
          if (isNaN(editPositionId)) {
            await ctx.reply("Пожалуйста, введите корректный ID должности (число).");
            return;
          }
          userState.data.positionId = editPositionId;
          await showDataConfirmation(ctx, userState.data);
          userState.step = "confirming_data";
          break;

        case "editing_departmentId":
          const editDepartmentId = parseInt(text.trim());
          if (isNaN(editDepartmentId)) {
            await ctx.reply("Пожалуйста, введите корректный ID подразделения (число).");
            return;
          }
          userState.data.departmentId = editDepartmentId;
          await showDataConfirmation(ctx, userState.data);
          userState.step = "confirming_data";
          break;

        case "editing_phone":
          if (!phoneRegex.test(text)) {
            await ctx.reply("Пожалуйста, введите номер телефона в любом формате:\n+7 900 111-22-33\n8 900 111-22-33\n900-111-22-33\n89001112233");
            return;
          }
          const editPhoneDigits = normalizePhone(text);
          // После нормализации должно быть 10 цифр, начинающихся с 9
          if (editPhoneDigits.length !== 10 || !editPhoneDigits.startsWith("9")) {
            await ctx.reply("Пожалуйста, введите корректный номер телефона в любом формате:\n+7 900 111-22-33\n8 900 111-22-33\n900-111-22-33\n89001112233");
            return;
          }
          userState.data.phoneNumber = editPhoneDigits;
          await showDataConfirmation(ctx, userState.data);
          userState.step = "confirming_data";
          break;

        case "confirming_data":
          // В состоянии подтверждения ожидаем только нажатия кнопок
          await ctx.reply("Пожалуйста, используйте кнопки для подтверждения или изменения данных.");
          break;

        default:
          await ctx.reply("Произошла ошибка. Используйте /start для начала.");
          userStates.delete(telegramId);
      }
    } catch (err) {
      console.error(err);
      await ctx.reply("Произошла ошибка. Попробуй ещё раз или позже.");
      userStates.delete(telegramId);
    }
  });

  // Обработчик callback-кнопок для подтверждения и изменения
  bot.action("confirm", async (ctx) => {
    if (!isPrivate(ctx)) return;
    
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const userState = userStates.get(telegramId);
    if (!userState) {
      await ctx.answerCbQuery("Сессия истекла. Используйте /start для начала.");
      return;
    }

    try {
      await ctx.answerCbQuery("Проверяю данные...");
      await handleVerificationAndLink(ctx, userState.data);
      userStates.delete(telegramId);
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery("Произошла ошибка. Попробуйте позже.");
    }
  });

  bot.action("edit", async (ctx) => {
    if (!isPrivate(ctx)) return;
    
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const userState = userStates.get(telegramId);
    if (!userState) {
      await ctx.answerCbQuery("Сессия истекла. Используйте /start для начала.");
      return;
    }

    try {
      await ctx.answerCbQuery();
      await showEditMenu(ctx);
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery("Произошла ошибка. Попробуйте позже.");
    }
  });

  // Обработчик для выбора конкретного поля для изменения
  bot.action(/^change_(lastName|firstName|middleName|positionId|departmentId|phone)$/, async (ctx) => {
    if (!isPrivate(ctx)) return;
    
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const userState = userStates.get(telegramId);
    if (!userState) {
      await ctx.answerCbQuery("Сессия истекла. Используйте /start для начала.");
      return;
    }

    try {
      const field = ctx.match[1];
      await ctx.answerCbQuery();
      await handleFieldChange(ctx, field, userState);
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery("Произошла ошибка. Попробуйте позже.");
    }
  });

  return bot;
}

// Функция для показа данных с кнопками подтверждения
async function showDataConfirmation(ctx, data) {
  // Форматируем номер телефона с +7 для отображения
  const formattedPhone = data.phoneNumber 
    ? `+7 ${data.phoneNumber.slice(0, 3)} ${data.phoneNumber.slice(3, 6)}-${data.phoneNumber.slice(6, 8)}-${data.phoneNumber.slice(8)}`
    : "не указано";
  
  const dataText = 
    "Проверь данные:\n\n" +
    `👤 Фамилия: ${data.lastName || "не указано"}\n` +
    `👤 Имя: ${data.firstName || "не указано"}\n` +
    `👤 Отчество: ${data.middleName || "не указано"}\n` +
    `💼 Должность (ID): ${data.positionId || "не указано"}\n` +
    `🏢 Подразделение (ID): ${data.departmentId || "не указано"}\n` +
    `📞 Телефон: ${formattedPhone}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Подтвердить", "confirm")],
    [Markup.button.callback("✏️ Изменить", "edit")]
  ]);

  await ctx.reply(dataText, keyboard);
}

// Функция для показа меню выбора поля для изменения
async function showEditMenu(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("👤 Фамилия", "change_lastName"),
      Markup.button.callback("👤 Имя", "change_firstName"),
    ],
    [
      Markup.button.callback("👤 Отчество", "change_middleName"),
      Markup.button.callback("💼 Должность", "change_positionId"),
    ],
    [
      Markup.button.callback("🏢 Подразделение", "change_departmentId"),
      Markup.button.callback("📞 Телефон", "change_phone"),
    ],
  ]);

  await ctx.reply("Что хотите изменить?", keyboard);
}

// Функция для обработки выбора поля для изменения
async function handleFieldChange(ctx, field, userState) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  let step = "";
  let prompt = "";

  switch (field) {
    case "lastName":
      step = "editing_lastName";
      prompt = "Введите новую фамилию:";
      break;
    case "firstName":
      step = "editing_firstName";
      prompt = "Введите новое имя:";
      break;
    case "middleName":
      step = "editing_middleName";
      prompt = "Введите новое отчество (если нет, введите \"-\"):";
      break;
    case "positionId":
      step = "editing_positionId";
      prompt = "Введите новый ID должности (число):";
      break;
    case "departmentId":
      step = "editing_departmentId";
      prompt = "Введите новый ID подразделения (число):";
      break;
    case "phone":
      step = "editing_phone";
      prompt = "Введите новый номер телефона:";
      break;
    default:
      await ctx.reply("Неизвестное поле.");
      return;
  }

  userState.step = step;
  await ctx.reply(prompt);
}

let adminLogChatIdCache = null;
let newsChannelIdCache = null;
async function getNewsChannelId() {
  if (newsChannelIdCache !== null) return newsChannelIdCache;

  const settings = await prismaMeta.adminSettings.findUnique({ where: { id: 1 } });
  newsChannelIdCache = settings?.newsChannelId || config.newsChannelId || null;

  return newsChannelIdCache;
}

async function handleNewsCommand(ctx) {
  if (!(await hasAdminAccess(ctx))) {
    await ctx.reply("Нет прав для выполнения этой команды.");
    return;
  }

  const newsChannelId = await getNewsChannelId();
  if (!newsChannelId) {
    await ctx.reply(
      "Новостной канал не настроен. Используй /set_news_channel в нужном канале или задай NEWS_CHANNEL_ID в .env."
    );
    return;
  }

  const message = ctx.message;

  const captionFromText = message?.text
    ?.replace(/^\/news(@\w+)?\s*/i, "")
    .trim();

  const isPhoto = Array.isArray(message?.photo) && message.photo.length > 0;
  const photoFileId = isPhoto ? message.photo[message.photo.length - 1].file_id : null;
  const captionFromPhoto = message?.caption
    ?.replace(/^\/news(@\w+)?\s*/i, "")
    .trim();

  const newsText = isPhoto ? captionFromPhoto : captionFromText;

  if (isPhoto && !newsText) {
    await ctx.reply("Добавь текст новости в подпись к фото после команды /news.");
    return;
  }

  if (!isPhoto && !newsText) {
    await ctx.reply("Напиши текст новости после команды: /news текст новости");
    return;
  }

  try {
    if (isPhoto && photoFileId) {
      await ctx.telegram.sendPhoto(newsChannelId, photoFileId, {
        caption: newsText,
        parse_mode: "HTML",
      });
    } else {
      await ctx.telegram.sendMessage(newsChannelId, newsText, {
        parse_mode: "HTML",
      });
    }
    await ctx.reply("Новость отправлена в новостной канал.");
  } catch (err) {
    console.error(err);
    await ctx.reply(
      "Не удалось отправить новость. Проверь, что бот добавлен в канал и имеет права на отправку сообщений."
    );
  }
}

function parseSingleMessage(text) {
  if (!text) return null;

  // Try delimiters first
  const byPipe = text.split("|").map((s) => s.trim()).filter(Boolean);
  if (byPipe.length === 3) {
    const [fullName, position, department] = byPipe;
    return { fullName, position, department };
  }

  const bySemicolon = text.split(";").map((s) => s.trim()).filter(Boolean);
  if (bySemicolon.length === 3) {
    const [fullName, position, department] = bySemicolon;
    return { fullName, position, department };
  }

  // Heuristic: first 3 tokens = ФИО, last 2 tokens = отдел, середина = должность
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 5) {
    const fullName = parts.slice(0, 3).join(" ");
    const department = parts.slice(-2).join(" ");
    const position = parts.slice(3, parts.length - 2).join(" ");
    if (fullName && position && department) {
      return { fullName, position, department };
    }
  }

  return null;
}

function resolveTarget(ctx) {
  const arg = ctx.message?.text?.split(" ").slice(1).join(" ").trim();
  if (arg) {
    if (/^-?\d+$/.test(arg)) return { telegramId: arg };
    if (arg.startsWith("@") && arg.length > 1) return { username: arg.slice(1) };
  }
  const reply = ctx.message?.reply_to_message?.from;
  if (reply?.id) {
    return { telegramId: String(reply.id), username: reply.username };
  }
  return null;
}

async function findUserByTarget(target) {
  if (target.telegramId) {
    const user = await prismaMeta.user.findUnique({
      where: { telegramId: BigInt(target.telegramId) },
    });
    if (user) return user;
  }
  if (target.username) {
    const found = await prismaMeta.user.findFirst({
      where: {
        OR: [
          { telegramUsername: target.username },
          { fullName: { contains: target.username } },
        ],
      },
    });
    if (found) return found;
  }
  return null;
}

function parseRemoveArgs(ctx) {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  let target = null;
  let reason = "";

  const reply = ctx.message?.reply_to_message?.from;
  if (reply?.id) {
    target = { telegramId: String(reply.id), username: reply.username };
    reason = parts.slice(1).join(" ").trim();
  } else {
    const arg = parts[1];
    if (arg) {
      if (/^-?\d+$/.test(arg)) {
        target = { telegramId: arg };
      } else if (arg.startsWith("@") && arg.length > 1) {
        target = { username: arg.slice(1) };
      }
      reason = parts.slice(2).join(" ").trim();
    }
  }

  return { target, reason };
}

async function logAdminAction(ctx, entry) {
  if (!adminLogChatIdCache) {
    const settings = await prismaMeta.adminSettings.findUnique({ where: { id: 1 } });
    adminLogChatIdCache = settings?.adminLogChatId || config.adminLogChatId;
  }

  let channelName = entry.channelName || null;
  if (!channelName && entry.channelId) {
    try {
      const chatInfo = await ctx.telegram.getChat(entry.channelId);
      channelName = chatInfo?.title || chatInfo?.username || null;
    } catch (err) {
      console.error("Failed to fetch channel info for log", err);
    }
  }

  try {
    await prismaMeta.adminLog.create({
      data: {
        action: entry.action,
        actorTelegramId: BigInt(entry.actorId),
        actorUsername: entry.actorUsername || null,
        targetTelegramId: entry.targetId ? BigInt(entry.targetId) : null,
        targetUsername: entry.targetUsername || null,
        department: entry.department || null,
        channelId: entry.channelId || null,
        channelName: channelName,
        reason: entry.reason || entry.error || null,
      },
    });
  } catch (err) {
    console.error("Failed to save admin log", err);
  }

  const dest = adminLogChatIdCache;
  if (dest) {
    const lines = [
      `Действие: ${entry.action}`,
      `Админ: ${entry.actorId}${entry.actorUsername ? ` (@${entry.actorUsername})` : ""}`,
      entry.targetId
        ? `Цель: ${entry.targetId}${entry.targetUsername ? ` (@${entry.targetUsername})` : ""}`
        : entry.targetUsername
        ? `Цель: @${entry.targetUsername}`
        : "Цель: —",
      entry.department ? `Отдел: ${entry.department}` : null,
      entry.channelId
        ? `Канал: ${channelName ? `${channelName} (${entry.channelId})` : entry.channelId}`
        : null,
      entry.reason ? `Причина/детали: ${entry.reason}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await ctx.telegram.sendMessage(dest, lines);
    } catch (err) {
      console.error("Failed to send admin log message", err);
    }
  }
}
async function handleVerificationAndLink(ctx, form) {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    await ctx.reply("Не удалось получить твой Telegram ID.");
    return;
  }

  const employee = await findEmployee(prisma, {
    lastName: form.lastName,
    firstName: form.firstName,
    middleName: form.middleName,
    positionId: form.positionId,
    departmentId: form.departmentId,
    phoneNumber: form.phoneNumber,
  });

  if (!employee) {
    await ctx.reply(
      "Не нашли тебя в справочнике. Проверь данные или обратись к администратору."
    );
    await prismaMeta.auditLog.create({
      data: {
        telegramId: BigInt(telegramId),
        action: "verification_failed",
        payloadJson: JSON.stringify(form),
      },
    });
    return;
  }

  // Блокируем уволенных или уже в чёрном списке
  if (employee.blacklisted) {
    await prismaMeta.auditLog.create({
      data: {
        telegramId: BigInt(telegramId),
        action: "blacklisted_attempt",
        payloadJson: JSON.stringify({ code: employee.code, form }),
      },
    });
    await ctx.reply("Произошла ошибка. Попробуй позже или обратись к администратору.");
    return;
  }

  // Проверяем на уволенных (terminationDate не null)
  if (employee.terminationDate) {
    // Пытаемся выгнать из канала отдела и новостного канала
    try {
      // Используем departmentId как строку для resolveChannelId
      const channelId = await resolveChannelId(String(employee.departmentId || ""));
      // Проверяем, что это канал (начинается с - или @), а не private chat
      if (channelId && (channelId.startsWith("-") || channelId.startsWith("@"))) {
        try {
          await ctx.telegram.banChatMember(channelId, Number(telegramId));
        } catch (banErr) {
          // Игнорируем ошибки "can't ban members in private chats" и "can't remove chat owner"
          if (banErr?.response?.description?.includes("private chats") || 
              banErr?.response?.description?.includes("chat owner")) {
            console.log("Cannot ban user (private chat or owner):", banErr.response?.description);
          } else {
            throw banErr;
          }
        }
      }
    } catch (err) {
      // Игнорируем ошибки "can't ban members in private chats" и "can't remove chat owner"
      if (err?.response?.description?.includes("private chats") || 
          err?.response?.description?.includes("chat owner")) {
        // Это нормально, просто логируем
        console.log("Cannot ban user (private chat or owner):", err.response?.description);
      } else {
        console.error("Failed to ban from department channel for fired user", err);
      }
    }

    try {
      const newsChannelId = await getNewsChannelId();
      if (newsChannelId) {
        await ctx.telegram.banChatMember(newsChannelId, Number(telegramId));
      }
    } catch (err) {
      // Игнорируем ошибки "can't ban members in private chats" и "can't remove chat owner"
      if (err?.response?.description?.includes("private chats") || 
          err?.response?.description?.includes("chat owner")) {
        // Это нормально, просто логируем
        console.log("Cannot ban user (private chat or owner):", err.response?.description);
      } else {
        console.error("Failed to ban from news channel for fired user", err);
      }
    }

    try {
      // Используем raw query для обновления BIT поля в SQL Server
      await prisma.$executeRaw`
        UPDATE Lexema_Kadry_LichnayaKartochka 
        SET ЧерныйСписок = 1 
        WHERE VCode = ${employee.code}
      `;
    } catch (err) {
      console.error("Failed to update blacklisted", err);
    }

    await prismaMeta.auditLog.create({
      data: {
        telegramId: BigInt(telegramId),
        action: "fired_blocked",
        payloadJson: JSON.stringify({ code: employee.code, form }),
      },
    });

    await ctx.reply("Произошла ошибка. Попробуй позже или обратись к администратору.");
    return;
  }

  // Если сотрудник уже привязан к другому Telegram — уведомляем владельца и запрашиваем подтверждение
  if (employee.telegramId && BigInt(telegramId) !== employee.telegramId) {
    const sessionId = createSessionId();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 минут
    pendingSessions.set(sessionId, { requesterId: telegramId, form, expiresAt });

    // Сообщение тому, кто пытается войти
    await ctx.reply(
      "Идет проверка данных..."
    );

    // Уведомление владельцу записи
    try {
      await ctx.telegram.sendMessage(
        Number(employee.telegramId),
        [
          "Под вашими данными кто-то пытается войти!",
          "Если это вы — нажмите «Разрешить», если нет — «Заблокировать сессию».",
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Разрешить", callback_data: `session_allow_${sessionId}` },
                { text: "⛔ Отклонить попытку входа", callback_data: `session_block_${sessionId}` },
              ],
            ],
          },
        }
      );
    } catch (err) {
      console.error("Failed to notify bound user about session", err);
    }

    return; // ждём решения владельца
  }

  // Формируем полное имя из частей
  const fullNameParts = [
    employee.lastName,
    employee.firstName,
    employee.middleName,
  ].filter(Boolean);
  const fullName = fullNameParts.length > 0 ? fullNameParts.join(" ") : "Не указано";

    await prismaMeta.auditLog.create({
      data: {
        telegramId: BigInt(telegramId),
        action: "verification_success",
        payloadJson: JSON.stringify({ ...form, code: employee.code }),
      },
    });

  // Привязываем telegramId к записи сотрудника, если ещё не привязано
  if (!employee.telegramId || !employee.telegramUsername) {
    try {
      // Проверяем, можно ли сохранить telegramId
      const existingByTelegram = await prisma.lexemaCard.findFirst({
        where: { telegramId: BigInt(telegramId) },
      });
      const isSameId =
        employee.telegramId && String(employee.telegramId) === String(telegramId);
      const canSetTelegramId =
        isSameId ||
        (!employee.telegramId && (!existingByTelegram || existingByTelegram.code === employee.code));

      // Если нельзя привязать (уже занято другим сотрудником) и текущая запись без telegramId — останавливаемся
      if (!canSetTelegramId && !employee.telegramId) {
        await ctx.reply(
          "Этот Telegram уже привязан к другому сотруднику. Обратись к администратору."
        );
        return;
      }

      await prisma.lexemaCard.update({
        where: { code: employee.code },
        data: {
          telegramId: canSetTelegramId ? BigInt(telegramId) : undefined,
          telegramUsername: ctx.from?.username || null,
          phone: form.phoneNumber || undefined,
        },
      });
    } catch (err) {
      console.error("Failed to update employee telegramId", err);
    }
  }

  // Сохраняем в User (используем departmentId и positionId как строки для совместимости)
  const user = await prismaMeta.user.upsert({
    where: { telegramId: BigInt(telegramId) },
    update: {
      empId: null, // LexemaCard не связан с EmployeeRef
      fullName: fullName,
      phoneNumber: form.phoneNumber || null,
      position: String(employee.positionId || ""),
      department: String(employee.departmentId || ""),
      telegramUsername: ctx.from?.username || null,
      lastVerifiedAt: new Date(),
    },
    create: {
      telegramId: BigInt(telegramId),
      empId: null,
      fullName: fullName,
      phoneNumber: form.phoneNumber || null,
      position: String(employee.positionId || ""),
      department: String(employee.departmentId || ""),
      telegramUsername: ctx.from?.username || null,
      lastVerifiedAt: new Date(),
    },
  });

  let invite;
  let newsInvite = null;
  try {
    const newsChannelId = await getNewsChannelId();

    invite = await getOrCreateInviteLink({
      telegram: ctx.telegram,
      prisma,
      telegramId,
      fullName: user.fullName,
      channelId: await resolveChannelId(String(form.departmentId || "")),
    });
    if (newsChannelId) {
      newsInvite = await getOrCreateInviteLink({
        telegram: ctx.telegram,
        prisma,
        telegramId,
        fullName: user.fullName,
        channelId: newsChannelId,
      });
    }
  } catch (err) {
    console.error(err);
    if (
      err?.response?.description?.includes("chat not found") ||
      err?.on?.payload?.chat_id
    ) {
      await ctx.reply(
        "Не удалось сгенерировать ссылку: чат отдела не найден или бот не админ. Сообщи администратору."
      );
    } else {
      await ctx.reply(
        "Ошибка при создании ссылки. Попробуй позже или сообщи администратору."
      );
    }
    return;
  }

  await prismaMeta.auditLog.create({
    data: {
      telegramId: BigInt(telegramId),
      action: "invite_issued",
      payloadJson: JSON.stringify({
        inviteLinkId: invite.inviteLinkId,
        expiresAt: invite.expiresAt,
        channelId: invite.channelId,
      }),
    },
  });

  if (newsInvite) {
    await prismaMeta.auditLog.create({
      data: {
        telegramId: BigInt(telegramId),
        action: "news_invite_issued",
        payloadJson: JSON.stringify({
          inviteLinkId: newsInvite.inviteLinkId,
          expiresAt: newsInvite.expiresAt,
          channelId: newsInvite.channelId,
        }),
      },
    });
  }

  const expiresAtText = formatISO9075(invite.expiresAt);
  let reply = `Твоя персональная ссылка в канал отдела:\n${invite.url}\nДействует до: ${expiresAtText}`;

  if (newsInvite) {
    const newsExpiresAtText = formatISO9075(newsInvite.expiresAt);
    reply += `\n\nТвоя персональная ссылка в новостной канал:\n${newsInvite.url}\nДействует до: ${newsExpiresAtText}`;
  }

  reply += `\n\nЕсли ссылка истечет или будет использована — запусти /start ещё раз.`;

  await ctx.reply(reply);
}

async function resolveChannelId(department) {
  const mapping = await prismaMeta.departmentChannel.findFirst({
    where: { department },
  });
  if (mapping?.channelId) {
    return mapping.channelId;
  }
  if (config.channelId) {
    return config.channelId; // fallback
  }
  throw new Error("CHANNEL_ID is not configured for this department");
}

