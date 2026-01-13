import { createBot } from "./bot.js";
import { prisma, disconnectDb, lexemaCard, detectTableName } from "./db.js";
import { prismaMeta, disconnectMetaDb } from "./dbMeta.js";
import { config } from "./config.js";

// Отключаем буферизацию stdout для немедленного вывода
process.stdout.setDefaultEncoding('utf8');
if (process.stdout.isTTY) {
  process.stdout.setBlocking?.(true);
}

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

// Получение admin log chat ID
let adminLogChatIdCache = null;
async function getAdminLogChatId() {
  if (adminLogChatIdCache !== null) return adminLogChatIdCache;
  
  try {
    const settings = await prismaMeta.adminSettings.findUnique({ where: { id: 1 } });
    adminLogChatIdCache = settings?.adminLogChatId || config.adminLogChatId || null;
    return adminLogChatIdCache;
  } catch (err) {
    console.error("Failed to load admin log chat id", err);
    return config.adminLogChatId || null;
  }
}

// Отправка логов в admin log chat
async function sendLogToAdminChat(message) {
  try {
    const chatId = await getAdminLogChatId();
    if (chatId) {
      await bot.telegram.sendMessage(chatId, message);
    } else {
      // Если chat не установлен, выводим в консоль
      logImmediate(message);
    }
  } catch (err) {
    // Если не удалось отправить, выводим в консоль
    logImmediate(`Ошибка отправки лога в admin chat: ${err.message}`);
    logImmediate(message);
  }
}

// Функция для немедленного вывода в консоль (без буферизации)
function logImmediate(...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ') + '\n';
  process.stdout.write(message);
}

// === ПРОВЕРКА АКТИВНЫХ И УВОЛЕННЫХ СОТРУДНИКОВ (поиск: НОЧНАЯ ПРОВЕРКА) ===
async function processFiredAndBlacklisted() {
  const now = new Date();
  // Проверка времени: только в период 00:00-05:00 МСК
  if (!isWithinMoscowNightWindow(now)) return;
  
  const moscowTime = new Date(now.getTime() + 3 * 60 * 60 * 1000); // UTC+3
  const timeStr = moscowTime.toISOString().slice(0, 19).replace('T', ' ');
  await sendLogToAdminChat(`=== НАЧАЛО НОЧНОЙ ПРОВЕРКИ СОТРУДНИКОВ: ${timeStr} МСК ===`);

  try {
    // Определяем правильное название таблицы для raw SQL запросов
    const tableName = await detectTableName();
    const newsChannelId = await getNewsChannelIdForCron();

    // 1. Обрабатываем АКТИВНЫХ сотрудников (без даты увольнения)
    // Разбаниваем их в каналах и убираем из черного списка, если они там есть
    const activeEmployees = await lexemaCard.findMany({
      where: {
        terminationDate: null, // Нет даты увольнения = работает
        telegramId: { not: null },
      },
    });

    const restoredEmployees = []; // Для логирования восстановленных

    for (const emp of activeEmployees) {
      const tgId = Number(emp.telegramId);
      let wasRestored = false;
      
      // Если в черном списке - убираем из ЧС в БД
      if (emp.blacklisted) {
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE [${tableName}] SET ЧерныйСписок = 0 WHERE VCode = ${emp.code}`
          );
          wasRestored = true;
        } catch (err) {
          // Игнорируем ошибки, логируем только критичные
        }
      }

      // Разбаниваем в каналах (независимо от статуса blacklisted в БД)
      // Это разбанит пользователей, которые забанены в канале, но не уволены
      
      // ЗАКОММЕНТИРОВАНО: Пока отделов нет, убираем работу с каналами отделов
      // try {
      //   // Пытаемся найти канал по departmentId
      //   const mapping = await prismaMeta.departmentChannel.findFirst({
      //     where: { department: String(emp.departmentId || "") },
      //   });
      //   const deptChannelId = mapping?.channelId || config.channelId || null;
      //   if (deptChannelId) {
      //     try {
      //       await bot.telegram.unbanChatMember(deptChannelId, tgId, { only_if_banned: true });
      //     } catch (unbanErr) {
      //       if (!unbanErr?.response?.description?.includes("not found") && 
      //           !unbanErr?.response?.description?.includes("not in the chat")) {
      //         // Игнорируем ошибки
      //       }
      //     }
      //   }
      // } catch (err) {
      //   // Игнорируем ошибки
      // }

      // Новостной канал
      if (newsChannelId) {
        try {
          await bot.telegram.unbanChatMember(newsChannelId, tgId, { only_if_banned: true });
          if (emp.blacklisted) {
            wasRestored = true;
          }
        } catch (unbanErr) {
          // Игнорируем ошибки "not found" и "not in the chat"
        }
      }

      // Если был восстановлен (был в черном списке) - добавляем в список для логирования
      if (wasRestored && emp.blacklisted) {
        restoredEmployees.push(emp);
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
          // Игнорируем ошибки логирования
        }
      }
    }
    
    // Логируем восстановленных сотрудников
    if (restoredEmployees.length > 0) {
      let logMessage = `\nВосстановление в канал (${restoredEmployees.length}):\n`;
      for (const emp of restoredEmployees) {
        const fio = `${emp.lastName || ''} ${emp.firstName || ''} ${emp.middleName || ''}`.trim();
        logMessage += `${fio}, подразделение: ${emp.departmentId || 'не указано'}, должность: ${emp.positionId || 'не указана'}\n`;
      }
      await sendLogToAdminChat(logMessage);
    }

    // 2. Обрабатываем УВОЛЕННЫХ сотрудников (с датой увольнения)
    // Баним их в каналах и добавляем в черный список
    const firedEmployees = await lexemaCard.findMany({
      where: {
        terminationDate: { not: null }, // Есть дата увольнения = уволен
        telegramId: { not: null },
      },
    });

    const firedEmployeesLog = []; // Для логирования уволенных

    for (const emp of firedEmployees) {
      const tgId = Number(emp.telegramId);
      let addedToBlacklist = false;

      // Если не в черном списке - добавляем в ЧС в БД
      if (!emp.blacklisted) {
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE [${tableName}] SET ЧерныйСписок = 1 WHERE VCode = ${emp.code}`
          );
          addedToBlacklist = true;
        } catch (err) {
          // Игнорируем ошибки, логируем только критичные
        }
      }

      // Баним в каналах
      
      // ЗАКОММЕНТИРОВАНО: Пока отделов нет, убираем работу с каналами отделов
      // try {
      //   // Пытаемся найти канал по departmentId
      //   const mapping = await prismaMeta.departmentChannel.findFirst({
      //     where: { department: String(emp.departmentId || "") },
      //   });
      //   const deptChannelId = mapping?.channelId || config.channelId || null;
      //   if (deptChannelId) {
      //     try {
      //       await bot.telegram.banChatMember(deptChannelId, tgId);
      //     } catch (banErr) {
      //       // Игнорируем ошибки
      //     }
      //   }
      // } catch (err) {
      //   // Игнорируем ошибки
      // }

      // Новостной канал
      if (newsChannelId) {
        try {
          await bot.telegram.banChatMember(newsChannelId, tgId);
        } catch (banErr) {
          // Игнорируем ошибки "not found" и "not in the chat"
        }
      }

      // Добавляем в список для логирования
      firedEmployeesLog.push({
        emp,
        addedToBlacklist: addedToBlacklist || emp.blacklisted
      });

      // Логируем действие
      try {
        await prismaMeta.auditLog.create({
          data: {
            telegramId: BigInt(emp.telegramId),
            action: "night_auto_block",
            payloadJson: JSON.stringify({
              code: emp.code,
              terminationDate: emp.terminationDate,
              reason: "terminationDate is not null",
            }),
          },
        });
      } catch (err) {
        // Игнорируем ошибки логирования
      }
    }
    
    // Логируем уволенных сотрудников
    if (firedEmployeesLog.length > 0) {
      let logMessage = `\nУволены (${firedEmployeesLog.length}):\n`;
      for (const { emp, addedToBlacklist } of firedEmployeesLog) {
        const fio = `${emp.lastName || ''} ${emp.firstName || ''} ${emp.middleName || ''}`.trim();
        const blacklistStatus = addedToBlacklist ? 'да' : 'нет';
        logMessage += `${fio}, подразделение: ${emp.departmentId || 'не указано'}, должность: ${emp.positionId || 'не указана'}, занесены в черный список: ${blacklistStatus}\n`;
      }
      await sendLogToAdminChat(logMessage);
    }
    await sendLogToAdminChat(`\n=== ЗАВЕРШЕНИЕ НОЧНОЙ ПРОВЕРКИ ===`);
  } catch (err) {
    const errorMsg = `Ошибка ночной проверки: ${err.message}\nStack trace: ${err.stack}`;
    await sendLogToAdminChat(errorMsg);
    logImmediate("Night check failed", err);
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
    // Сначала определяем таблицу в БД (автоматический поиск по колонкам)
    console.log("🔍 Поиск таблицы сотрудников в базе данных...");
    await detectTableName();
    console.log("✓ Подключение к базе данных установлено\n");
    
    await bot.launch();
    console.log("Bot is running...");
    // Стартуем очистку инвайтов
    cleanupExpiredInvites();
    setInterval(cleanupExpiredInvites, INVITE_CLEANUP_MS);
    
    // Ночная проверка статусов (поиск: НОЧНАЯ ПРОВЕРКА таймер)
    // Запускаем сразу и затем каждые 15 минут
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


