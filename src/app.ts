import { Telegraf } from "telegraf";
import type { BotContext } from "./types.js";
import { registerAdminHandlers } from "./handlers/admin.js";
import { registerClientHandlers } from "./handlers/client.js";
import { clientsStore, metaStore, modelRequestsStore } from "./data/store.js";
import { formatWeeklyAdminSummary } from "./stats.js";
import { getAdminIds } from "./helpers.js";
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

// ── Haftalik avtomatik xulosa (dushanba, 09:00 Toshkent vaqti) ───────────────
// Yagona maqsadli, minimal scheduler — boshqa hech qanday background vazifa
// (AI, so'rovnoma, review) yo'q. 15 daqiqada bir tekshiradi; shu hafta
// allaqachon yuborilgan bo'lsa (metaStore orqali), qayta yubormaydi — qayta
// deploy/restart bo'lganda ham dublikat bo'lmaydi.
const WEEKLY_SUMMARY_CHECK_MS = 15 * 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

function checkWeeklySummary(): void {
  const nowTashkent = new Date(Date.now() + TASHKENT_OFFSET_MS);
  const isMonday = nowTashkent.getUTCDay() === 1;
  if (!isMonday || nowTashkent.getUTCHours() !== 9) return;

  const todayStr = nowTashkent.toISOString().slice(0, 10);
  if (metaStore.getLastWeeklySummarySentAt()?.slice(0, 10) === todayStr) return;

  const adminIds = getAdminIds();
  if (adminIds.length === 0) return;

  metaStore.setLastWeeklySummarySentAt(new Date().toISOString());
  const text = formatWeeklyAdminSummary(clientsStore.getAll(), modelRequestsStore.getAll());

  for (const adminId of adminIds) {
    bot.telegram.sendMessage(adminId, text).catch((err) => {
      logger.error({ err, adminId }, "Haftalik xulosa yuborilmadi");
    });
  }
}

setInterval(checkWeeklySummary, WEEKLY_SUMMARY_CHECK_MS);

logger.info("Bot ishga tushirilmoqda — Telegram API bilan bog'lanish tekshirilmoqda...");

// MUHIM: Telegraf'da long-polling rejimida bot.launch() qaytargan Promise
// FAQAT bot TO'XTAGANDA (bot.stop()) resolve bo'ladi — .then() ichiga
// "ishga tushdi" logini qo'yish uni bot normal ishlab turgan holatda ham
// HECH QACHON chiqarmaydi. Shuning uchun avval getMe() bilan ulanishni
// tasdiqlaymiz (bu tezda resolve/reject bo'ladi), so'ng launch'ni chaqirib,
// CHAQIRILGANI haqida darhol log yozamiz — uning yakunlanishini kutmasdan.
bot.telegram.getMe()
  .then((me) => {
    logger.info({ username: me.username }, "Telegram API bilan bog'lanish OK");
    bot.launch({ dropPendingUpdates: true }).catch((err) => {
      logger.error({ err }, "Bot launch xatolik bilan yakunlandi");
    });
    logger.info("Bot polling rejimida ishga tushdi");
  })
  .catch((err) => {
    logger.error({ err }, "Telegram API bilan bog'lanib bo'lmadi (BOT_TOKEN yoki tarmoq muammosi bo'lishi mumkin)");
    process.exit(1);
  });
