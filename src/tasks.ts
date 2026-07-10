import type { Telegraf } from "telegraf";
import type { BotContext } from "./types.js";
import { clientsStore, modelsStore, reportsStore } from "./data/store.js";
import { analyzeFeedback } from "./ai.js";
import { logger } from "./lib/logger.js";

const REVIEW_DELAY_MS = 10 * 60 * 60 * 1000;    // 10 soat
const FOLLOWUP_DELAY_MS = 60 * 60 * 1000;        // 1 soat
const FEEDBACK_DELAY_MS = 3 * 60 * 60 * 1000;    // 3 soat

export function startBackgroundTasks(bot: Telegraf<BotContext>): void {
  setInterval(() => checkReviews(bot), 15 * 60 * 1000);
  setInterval(() => checkConnectionFollowups(bot), 5 * 60 * 1000);
  setInterval(() => checkFeedbackCollection(bot), 20 * 60 * 1000);
  setInterval(() => checkWeeklyReport(bot), 60 * 60 * 1000);
}

// ─── Sharh yuborish ───────────────────────────────────────────────────────────

async function checkReviews(bot: Telegraf<BotContext>): Promise<void> {
  const clients = clientsStore.getAll();
  const now = Date.now();

  for (const client of clients) {
    if (client.reviewSent) continue;
    if (!client.lastModelName) continue;

    const lastSeen = new Date(client.lastSeen).getTime();
    if (now - lastSeen < REVIEW_DELAY_MS) continue;

    const model = modelsStore.getByName(client.lastModelName);
    if (!model?.reviewVoiceFileId) continue;

    try {
      if (model.reviewVoiceFileId) {
        await bot.telegram.sendVoice(client.chatId, model.reviewVoiceFileId);
      }
      if (model.reviewVideoFileId) {
        await bot.telegram.sendVideo(client.chatId, model.reviewVideoFileId);
      }
      client.reviewSent = true;
      clientsStore.save(client);
    } catch {
      // mijoz botni bloklagan bo'lishi mumkin
    }
  }
}

// ─── Ulanish followup ─────────────────────────────────────────────────────────

async function checkConnectionFollowups(bot: Telegraf<BotContext>): Promise<void> {
  const clients = clientsStore.getAll();
  const now = Date.now();

  for (const client of clients) {
    if (!client.awaitingConnectionConfirm) continue;
    if (client.connectionFollowupSentAt) continue;
    if (!client.lastVideoSentAt) continue;

    const videoSentAt = new Date(client.lastVideoSentAt).getTime();
    if (now - videoSentAt < FOLLOWUP_DELAY_MS) continue;

    try {
      const msg =
        client.language !== "ru"
          ? "Kamerani ulay oldingizmi? Qiyinchilik bo'lsa yozing."
          : "Удалось подключить камеру? Если есть трудности, напишите.";
      const opts = client.businessConnectionId
        ? ({ business_connection_id: client.businessConnectionId } as object)
        : {};
      await bot.telegram.sendMessage(client.chatId, msg, opts as Parameters<typeof bot.telegram.sendMessage>[2]);
      client.connectionFollowupSentAt = new Date().toISOString();
      clientsStore.save(client);
    } catch {
      // ignore
    }
  }
}

// ─── Fikr-mulohaza to'plash ───────────────────────────────────────────────────

async function checkFeedbackCollection(bot: Telegraf<BotContext>): Promise<void> {
  const clients = clientsStore.getAll();
  const now = Date.now();

  for (const client of clients) {
    // Allaqachon boshlangan yoki tugagan
    if (client.feedbackStage) continue;
    // Video hali yuborilmagan
    if (!client.lastVideoSentAt) continue;

    const videoSentAt = new Date(client.lastVideoSentAt).getTime();
    if (now - videoSentAt < FEEDBACK_DELAY_MS) continue;

    const isUz = client.language !== "ru";
    const msg = isUz
      ? "Bir savol bersam maylimi? Qaysi viloyat yoki shahardan yozyapsiz?"
      : "Позвольте задать вопрос. Из какого вы города или региона?";

    try {
      const opts = client.businessConnectionId
        ? ({ business_connection_id: client.businessConnectionId } as object)
        : {};
      await bot.telegram.sendMessage(client.chatId, msg, opts as Parameters<typeof bot.telegram.sendMessage>[2]);
      client.feedbackStage = "ask_region";
      client.feedbackAskedAt = new Date().toISOString();
      clientsStore.save(client);
    } catch {
      // ignore
    }
  }
}

// ─── Haftalik hisobot ─────────────────────────────────────────────────────────

async function checkWeeklyReport(bot: Telegraf<BotContext>): Promise<void> {
  // UTC+5 (Toshkent vaqti)
  const nowUTC5 = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const dayOfWeek = nowUTC5.getUTCDay();   // 1 = dushanba
  const hour = nowUTC5.getUTCHours();

  if (dayOfWeek !== 1 || hour < 9 || hour >= 10) return;

  const todayStr = nowUTC5.toISOString().slice(0, 10);
  const meta = reportsStore.getMeta();
  if (meta.lastReportDate === todayStr) return; // bu hafta allaqachon yuborilgan

  reportsStore.setLastReportDate(todayStr); // dublikat yuborishni oldini olish

  const clients = clientsStore.getAll();
  const feedbacks = clients
    .filter((c) => c.feedback && c.lastModelName)
    .map((c) => ({ ...c.feedback!, modelName: c.lastModelName! }));

  const adminIds = (process.env["ADMIN_IDS"] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (adminIds.length === 0) return;

  let reportText: string;
  if (feedbacks.length === 0) {
    reportText = "Haftalik hisobot: hali fikr-mulohaza to'planmagan. Mijozlar video olganidan 3 soat o'tgach so'rovnoma yuboriladi.";
  } else {
    try {
      reportText = await analyzeFeedback(feedbacks);
    } catch (err) {
      logger.error({ err }, "analyzeFeedback failed");
      reportText = `Haftalik hisobot tayyorlanishda xatolik yuz berdi. To'plangan fikrlar soni: ${feedbacks.length}`;
    }
  }

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, reportText);
    } catch {
      // ignore
    }
  }
}

// ─── On-demand hisobot (admin buyrug'idan chaqiriladi) ────────────────────────

export async function sendReportNow(bot: Telegraf<BotContext>, adminChatId: string): Promise<void> {
  const clients = clientsStore.getAll();
  const feedbacks = clients
    .filter((c) => c.feedback && c.lastModelName)
    .map((c) => ({ ...c.feedback!, modelName: c.lastModelName! }));

  if (feedbacks.length === 0) {
    await bot.telegram.sendMessage(
      adminChatId,
      "Hali fikr-mulohaza to'planmagan. Mijozlar video olganidan 3 soat o'tgach so'rovnoma yuboriladi."
    );
    return;
  }

  await bot.telegram.sendMessage(adminChatId, "Tahlil qilinmoqda...");
  const reportText = await analyzeFeedback(feedbacks);
  await bot.telegram.sendMessage(adminChatId, reportText);
}
