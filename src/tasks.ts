import type { Telegraf } from "telegraf";
import type { BotContext } from "./types.js";
import { clientsStore, modelsStore, reportsStore, usageStore } from "./data/store.js";
import { analyzeFeedback } from "./ai.js";
import { formatDailyCostSummary } from "./stats.js";
import { feedbackResumePrompt } from "./handlers/client.js";
import { getAdminIds } from "./helpers.js";
import { logger } from "./lib/logger.js";

const REVIEW_DELAY_MS = 10 * 60 * 60 * 1000;    // 10 soat
const FOLLOWUP_DELAY_MS = 30 * 60 * 1000;        // 30 daqiqa
const FEEDBACK_DELAY_MS = 3 * 60 * 60 * 1000;    // 3 soat

export function startBackgroundTasks(bot: Telegraf<BotContext>): void {
  setInterval(() => checkReviews(bot), 15 * 60 * 1000);
  setInterval(() => checkConnectionFollowups(bot), 5 * 60 * 1000);
  setInterval(() => checkFeedbackCollection(bot), 20 * 60 * 1000);
  setInterval(() => checkWeeklyReport(bot), 60 * 60 * 1000);
  setInterval(() => checkDailyCostReport(bot), 15 * 60 * 1000);
}

// ─── Sharh yuborish ───────────────────────────────────────────────────────────

async function checkReviews(bot: Telegraf<BotContext>): Promise<void> {
  const clients = clientsStore.getAll();
  const now = Date.now();

  for (const client of clients) {
    if (client.reviewSent) continue;
    if (!client.lastModelName) continue;
    if (client.refundRequested) continue;

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

    // Mijoz videodan keyin O'ZI yozgan bo'lsa — follow-up UMUMAN yubormaymiz
    // (u allaqachon suhbatga qaytgan). Belgilab qo'yamiz, qayta tekshirilmasin.
    if (new Date(client.lastSeen).getTime() > videoSentAt + 5000) {
      client.connectionFollowupSentAt = new Date().toISOString();
      clientsStore.save(client);
      continue;
    }

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
    // So'rovnoma boshlangan-u, mijoz oral-da savol/yordam so'rab pauza
    // qilingan bo'lsa — biroz tinchlik o'tgach (muammosi hal bo'lgach) o'sha
    // savolni yumshoqlik bilan qayta beramiz.
    if (client.feedbackStage && client.feedbackStage !== "done" && client.feedbackPausedAt) {
      const idleMs = now - new Date(client.lastSeen).getTime();
      if (idleMs < FEEDBACK_DELAY_MS) continue;
      const prompt = feedbackResumePrompt(client.feedbackStage, client.language);
      if (!prompt) { client.feedbackPausedAt = undefined; clientsStore.save(client); continue; }
      try {
        const opts = client.businessConnectionId
          ? ({ business_connection_id: client.businessConnectionId } as object)
          : {};
        await bot.telegram.sendMessage(client.chatId, prompt, opts as Parameters<typeof bot.telegram.sendMessage>[2]);
        client.feedbackPausedAt = undefined;
        client.feedbackAskedAt = new Date().toISOString();
        clientsStore.save(client);
      } catch {
        // ignore
      }
      continue;
    }
    // Allaqachon boshlangan yoki tugagan
    if (client.feedbackStage) continue;
    // Mijoz bilan hali jiddiy muloqot bo'lmagan (masalan faqat bitta stiker yuborgan)
    if (!client.hasGreeted) continue;

    // MUHIM — so'rovnomani faqat mijoz bilan HAMMASI JOYIDA bo'lganda boshlaymiz.
    // Mijozning ochiq (hal bo'lmagan) muammosi bo'lsa, so'rovnoma bilan bezovta
    // qilmaymiz. Ijobiy yakun belgisi: mijoz "rahmat/bo'ldi/ishladi" degan
    // (gratitudeSent) yoki ulanish tasdiqlangan (connectionConfirmed).
    if (client.refundRequested) continue;            // norozi mijoz — so'ramaymiz
    if (!client.gratitudeSent && !client.connectionConfirmed) continue;

    // Video yuborilgan bo'lsa o'shandan, aks holda (uzoq masofa mijozlari
    // uchun ham) oxirgi ko'rinishdan FEEDBACK_DELAY_MS o'tgan bo'lishi kerak.
    const baseTime = client.lastVideoSentAt
      ? new Date(client.lastVideoSentAt).getTime()
      : new Date(client.lastSeen).getTime();
    if (now - baseTime < FEEDBACK_DELAY_MS) continue;

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

// ─── Kunlik API xarajat hisoboti (soat 21:00, Toshkent vaqti) ─────────────────

async function checkDailyCostReport(bot: Telegraf<BotContext>): Promise<void> {
  const nowUTC5 = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const hour = nowUTC5.getUTCHours();
  if (hour !== 21) return;

  const todayStr = nowUTC5.toISOString().slice(0, 10);
  const meta = reportsStore.getMeta();
  if (meta.lastCostReportDate === todayStr) return; // bugun allaqachon yuborilgan

  reportsStore.setLastCostReportDate(todayStr);

  const adminIds = getAdminIds();
  if (adminIds.length === 0) return;

  const text = formatDailyCostSummary(usageStore.getAll(), usageStore.getBalance());
  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, text);
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
