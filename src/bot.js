import { Telegraf } from "telegraf";
import { formatISO9075 } from "date-fns";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { prismaMeta } from "./dbMeta.js";
import { findEmployee } from "./services/employeeService.js";
import { getOrCreateInviteLink } from "./services/inviteService.js";

const isPrivate = (ctx) => ctx.chat?.type === "private";
const isOwner = (ctx) =>
  ctx.from && config.ownerId && String(ctx.from.id) === String(config.ownerId);

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
    await ctx.reply(
      "Привет! Для ссылки отправь в одном сообщении: ФИО должность отдел.\n" +
        "Пример: Иванов Иван Иванович Менеджер Отдел разработки\n" +
        "Можно через разделитель | : Иванов Иван Иванович | Менеджер | Отдел разработки"
    );
  });

  bot.command("reset", async (ctx) => {
    if (!isPrivate(ctx)) return;
    await ctx.reply(
      "Отправь в одном сообщении: ФИО должность отдел (можно через | )."
    );
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
      const employees = await prisma.employeeRef.findMany({
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

    let channelId;
    try {
      channelId = await resolveChannelId(user.department);
    } catch (err) {
      console.error(err);
      await ctx.reply("Не найден канал для отдела пользователя.");
      return;
    }

    try {
      const member = await ctx.telegram.getChatMember(
        channelId,
        Number(user.telegramId)
      );
      const status = member?.status || "unknown";
      await ctx.reply(
        `Пользователь: ${user.fullName}\nID: ${user.telegramId}\nДолжность: ${user.position}\nОтдел: ${user.department}\nСтатус в канале: ${status}`
      );
    } catch (err) {
      console.error(err);
      await ctx.reply(
        `Не удалось проверить статус: ${err.response?.description || err.message}`
      );
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
      await prisma.auditLog.create({
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
      await prisma.auditLog.create({
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

    const text = ctx.message.text.trim();

    try {
      const parsed = parseSingleMessage(text);
      if (!parsed) {
        await ctx.reply(
          "Формат: ФИО должность отдел в одном сообщении.\n" +
            "Пример: Иванов Иван Иванович Менеджер Отдел разработки\n" +
            "Можно так: ФИО|Должность|Отдел"
        );
        return;
      }

      await handleVerificationAndLink(ctx, parsed);
    } catch (err) {
      console.error(err);
      await ctx.reply("Произошла ошибка. Попробуй ещё раз или позже.");
    }
  });

  return bot;
}

let adminLogChatIdCache = null;

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
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(target.telegramId) },
    });
    if (user) return user;
  }
  if (target.username) {
    const found = await prisma.user.findFirst({
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

  const employee = await findEmployee(prisma, form);

  if (!employee) {
    await ctx.reply(
      "Не нашли тебя в справочнике. Проверь данные или обратись к администратору."
    );
    await prisma.auditLog.create({
      data: {
        telegramId: BigInt(telegramId),
        action: "verification_failed",
        payloadJson: JSON.stringify(form),
      },
    });
    return;
  }

  await prisma.auditLog.create({
    data: {
      telegramId: BigInt(telegramId),
      action: "verification_success",
      payloadJson: JSON.stringify({ ...form, empId: employee.id }),
    },
  });

  // Привязываем telegramId к записи сотрудника, если ещё не привязано
  if (!employee.telegramId || !employee.telegramUsername) {
    try {
      await prisma.employeeRef.update({
        where: { id: employee.id },
        data: {
          telegramId: employee.telegramId ? undefined : BigInt(telegramId),
          telegramUsername: ctx.from?.username || null,
        },
      });
    } catch (err) {
      console.error("Failed to update employee telegramId", err);
    }
  }

  const user = await prisma.user.upsert({
    where: { telegramId: BigInt(telegramId) },
    update: {
      empId: employee.id,
      fullName: employee.fullName,
      position: employee.position,
      department: employee.department,
      telegramUsername: ctx.from?.username || null,
      lastVerifiedAt: new Date(),
    },
    create: {
      telegramId: BigInt(telegramId),
      empId: employee.id,
      fullName: employee.fullName,
      position: employee.position,
      department: employee.department,
      telegramUsername: ctx.from?.username || null,
      lastVerifiedAt: new Date(),
    },
  });

  let invite;
  try {
    invite = await getOrCreateInviteLink({
      telegram: ctx.telegram,
      prisma,
      telegramId,
      fullName: user.fullName,
      channelId: await resolveChannelId(form.department),
    });
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

  await prisma.auditLog.create({
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

  const expiresAtText = formatISO9075(invite.expiresAt);
  await ctx.reply(
    `Твоя персональная ссылка:\n${invite.url}\nДействует до: ${expiresAtText}\nЕсли истечет или будет использована — запусти /start ещё раз.`
  );
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

