import dotenv from "dotenv";

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  botToken: process.env.BOT_TOKEN,
  channelId: process.env.CHANNEL_ID,
  newsChannelId: process.env.NEWS_CHANNEL_ID || null,
  dbUrl: process.env.DB_URL || "file:./dev.db",
  metaDbUrl: process.env.META_DB_URL || "file:./meta.db",
  adminLogChatId: process.env.ADMIN_LOG_CHAT_ID || null, // fallback; can be set via command
  linkTtlHours: toInt(process.env.LINK_TTL_HOURS, 24),
  ownerId: process.env.OWNER_ID ? String(process.env.OWNER_ID).trim() : null,
  environment: process.env.NODE_ENV || "development",
};

if (!config.botToken) {
  throw new Error("BOT_TOKEN is required");
}

if (!config.channelId) {
  console.warn("CHANNEL_ID is missing; invite generation will fail until set.");
}

