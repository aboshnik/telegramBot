import { createBot } from "./bot.js";
import { disconnectDb } from "./db.js";
import { disconnectMetaDb } from "./dbMeta.js";

const bot = createBot();

bot.launch().then(() => {
  console.log("Bot is running...");
});

process.once("SIGINT", async () => {
  await Promise.all([disconnectDb(), disconnectMetaDb()]);
  await bot.stop("SIGINT");
});

process.once("SIGTERM", async () => {
  await Promise.all([disconnectDb(), disconnectMetaDb()]);
  await bot.stop("SIGTERM");
});

