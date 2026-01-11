import { createBot } from "./bot.js";
import { prisma, disconnectDb } from "./db.js";
import { prismaMeta, disconnectMetaDb } from "./dbMeta.js";
import { config } from "./config.js";

const bot = createBot();

// Периодическая очистка устаревших инвайтов (expiresAt < now)
const INVITE_CLEANUP_MS = 60 * 60 * 1000; // раз в час
const NIGHT_CHECK_MS = 15 * 60 * 1000; // проверка статусов раз в 15 минут

async function cleanupExpiredInvites() {
  try {
    const now = new Date();
    const res = await prismaMeta.inviteLink.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    if (res.count > 0) {
      console.log(`Invite cleanup: удалено ${res.count} просроченных ссылок`);
    }
  } catch (err) {
    // Игнорируем ошибку, если таблица не существует (P2021)
    if (err.code === 'P2021') {
      console.log("InviteLink table does not exist, skipping cleanup");
    } else {
    console.error("Invite cleanup failed", err);
    }
  }
}

// Час по Москве (UTC+3)
function getMoscowHour(date) {
  const utcHour = date.getUTCHours();
  return (utcHour + 3 + 24) % 24;
}

function isWithinMoscowNightWindow(date) {
  const h = getMoscowHour(date);
  return h >= 0 && h < 5;
}

async function getNewsChannelIdForCron() {
  try {
    const settings = await prismaMeta.adminSettings.findUnique({ where: { id: 1 } });
    return settings?.newsChannelId || config.newsChannelId || null;
  } catch (err) {
    console.error("Failed to load news channel id for cron", err);
    return config.newsChannelId || null;
  }
}

async function processFiredAndBlacklisted() {
  const now = new Date();
  if (!isWithinMoscowNightWindow(now)) return;

  try {
    // Проверяем LexemaCard: всех пользователей без даты увольнения - разбаниваем в каналах
    // Это нужно, чтобы разбанить пользователей, которые забанены в канале, но не уволены
    const activeEmployees = await prisma.lexemaCard.findMany({
      where: {
        terminationDate: null, // Нет даты увольнения = работает
        telegramId: { not: null },
      },
    });

    const newsChannelId = await getNewsChannelIdForCron();

    for (const emp of activeEmployees) {
      const tgId = Number(emp.telegramId);
      
      // Если в черном списке - убираем из ЧС в БД
      if (emp.blacklisted) {
        try {
          await prisma.$executeRaw`
            UPDATE [Лексема_Кадры_ЛичнаяКарточка] 
            SET ЧерныйСписок = 0 
            WHERE VCode = ${emp.code}
          `;
        } catch (err) {
          console.error("Night check: failed to remove from blacklist", err);
        }
      }

      // Разбаниваем в каналах (независимо от статуса blacklisted в БД)
      // Это разбанит пользователей, которые забанены в канале, но не уволены
      try {
        // Пытаемся найти канал по departmentId
        const mapping = await prismaMeta.departmentChannel.findFirst({
          where: { department: String(emp.departmentId || "") },
        });
        const deptChannelId = mapping?.channelId || config.channelId || null;
        if (deptChannelId) {
          try {
            await bot.telegram.unbanChatMember(deptChannelId, tgId, { only_if_banned: true });
          } catch (unbanErr) {
            if (!unbanErr?.response?.description?.includes("not found") && 
                !unbanErr?.response?.description?.includes("not in the chat")) {
              console.log("Night check: cannot unban from department channel:", unbanErr.response?.description);
            }
          }
        }
      } catch (err) {
        console.error("Night check: failed to unban from department channel", err);
      }

      // Новостной канал
      if (newsChannelId) {
        try {
          await bot.telegram.unbanChatMember(newsChannelId, tgId, { only_if_banned: true });
        } catch (unbanErr) {
          if (!unbanErr?.response?.description?.includes("not found") && 
              !unbanErr?.response?.description?.includes("not in the chat")) {
            console.log("Night check: cannot unban from news channel:", unbanErr.response?.description);
          }
        }
      }

      // Логируем только если был в черном списке
      if (emp.blacklisted) {
        try {
          await prismaMeta.auditLog.create({
            data: {
              telegramId: BigInt(emp.telegramId),
              action: "night_auto_unblacklist",
              payloadJson: JSON.stringify({
                code: emp.code,
                reason: "terminationDate is null",
              }),
            },
          });
        } catch (err) {
          console.error("Night check: failed to write audit log", err);
        }
      }
    }

    // Обрабатываем EmployeeRef (старая логика для совместимости)
    const employees = await prismaMeta.employeeRef.findMany({
      where: {
        OR: [{ fired: true }, { blacklisted: true }],
        telegramId: { not: null },
      },
    });

    if (!employees.length) return;

    for (const emp of employees) {
      const tgId = Number(emp.telegramId);

      // Канал отдела
      try {
        const mapping = await prismaMeta.departmentChannel.findFirst({
          where: { department: emp.department },
        });
        const deptChannelId = mapping?.channelId || config.channelId || null;
        if (deptChannelId) {
          await bot.telegram.banChatMember(deptChannelId, tgId);
        }
      } catch (err) {
        console.error("Night check: failed to ban from department channel", err);
      }

      // Новостной канал
      if (newsChannelId) {
        try {
          await bot.telegram.banChatMember(newsChannelId, tgId);
        } catch (err) {
          console.error("Night check: failed to ban from news channel", err);
        }
      }

      try {
        await prismaMeta.employeeRef.update({
          where: { id: emp.id },
          data: { blacklisted: true },
        });
      } catch (err) {
        console.error("Night check: failed to mark blacklisted", err);
      }

      try {
        await prismaMeta.auditLog.create({
          data: {
            telegramId: BigInt(emp.telegramId),
            action: "night_auto_block",
            payloadJson: JSON.stringify({
              empId: emp.id,
              fired: emp.fired,
              blacklisted: emp.blacklisted,
            }),
          },
        });
      } catch (err) {
        console.error("Night check: failed to write audit log", err);
      }
    }
  } catch (err) {
    console.error("Night check failed", err);
  }
}

// Логи ошибок, чтобы процесс не "падал молча"
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

async function startBot() {
  try {
    await bot.launch();
    console.log("Bot is running...");
    // Стартуем очистку инвайтов
    cleanupExpiredInvites();
    setInterval(cleanupExpiredInvites, INVITE_CLEANUP_MS);
    // Стартуем ночную проверку статусов
    processFiredAndBlacklisted();
    setInterval(processFiredAndBlacklisted, NIGHT_CHECK_MS);
  } catch (err) {
    console.error("Bot launch failed:", err);
    // На Replit платформа часто сама перезапускает процесс, но лучше явно упасть с кодом ошибки.
    process.exitCode = 1;
  }
}

startBot();

process.once("SIGINT", async () => {
  await Promise.all([disconnectDb(), disconnectMetaDb()]);
  await bot.stop("SIGINT");
});

process.once("SIGTERM", async () => {
  await Promise.all([disconnectDb(), disconnectMetaDb()]);
  await bot.stop("SIGTERM");
});

