import { createBot } from "./bot.js";
import { disconnectDb } from "./db.js";
import { disconnectMetaDb } from "./dbMeta.js";

// Keep-alive HTTP сервер: нужен, чтобы Replit показывал Webview URL и чтобы его мог пинговать UptimeRobot.
// Без него Replit пишет "no webpage to preview".
import("../keep-alive.js").catch((e) => {
  console.error("Failed to start keep-alive server:", e);
});

const bot = createBot();

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

