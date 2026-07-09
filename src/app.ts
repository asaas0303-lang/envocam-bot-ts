import { Telegraf } from "telegraf";
import type { BotContext } from "./types.js";
import { registerAdminHandlers } from "./handlers/admin.js";
import { registerClientHandlers } from "./handlers/client.js";
import { startBackgroundTasks } from "./tasks.js";
import { logger } from "./lib/logger.js";

const token = process.env["BOT_TOKEN"] || process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("BOT_TOKEN (yoki TELEGRAM_BOT_TOKEN) environment variable talab qilinadi");

const bot = new Telegraf<BotContext>(token, {
  handlerTimeout: Infinity,
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});

// Global handler xatolarini yutamiz — bitta xato (masalan eskirgan tugma bosilishi)
// butun long-polling siklini to'xtatib qo'ymasligi uchun
bot.catch((err, ctx) => {
  logger.error(
    { err, updateId: ctx.update?.update_id, updateType: ctx.updateType },
    "Bot handler error (ignored, bot keeps running)"
  );
});

registerAdminHandlers(bot);
registerClientHandlers(bot);
startBackgroundTasks(bot);

bot.launch({ dropPendingUpdates: true }).then(() => {
  logger.info("EnvoCam bot started (long polling)");
}).catch((err) => {
  logger.error({ err }, "Bot launch failed");
});
