import { Telegraf } from "telegraf";
import type { BotContext } from "../types.js";
import { clientsStore, modelRequestsStore, modelsStore, type ClientData } from "../data/store.js";
import { isAdmin, sleep } from "../helpers.js";
import { logger } from "../lib/logger.js";

const GREETING_TEXT =
  "Salom! Kamerangizga mos video qo'llanma yuborishimiz uchun kamera modelini yozib yuboring (masalan: S5, X11, A19).";

const NOT_FOUND_TEXT =
  "Bu turdagi model hozircha bazamizda mavjud emas. Iltimos, kamera qutisidagi qo'llanmada yozilgan model nomini tekshirib qayta yuboring.";

const NON_TEXT_HINT =
  "Iltimos, kamera modelini matn ko'rinishida yozib yuboring (masalan: S5, X11, A19).";

function normalizeModelNameInput(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "");
}

function getOrCreateClient(chatId: string, firstName?: string, username?: string): ClientData {
  const existing = clientsStore.getById(chatId);
  const now = new Date().toISOString();
  if (existing) {
    existing.lastSeen = now;
    if (firstName) existing.firstName = firstName;
    if (username) existing.username = username;
    clientsStore.save(existing);
    return existing;
  }
  const fresh: ClientData = { chatId, firstName, username, firstSeen: now, lastSeen: now };
  clientsStore.save(fresh);
  return fresh;
}

// Mijoz yozgan matnni ODDIY STRING SOLISHTIRISH orqali (katta-kichik harf va
// bo'shliqqa sezgir bo'lmagan holda) bazadan qidiradi — hech qanday
// tashqi API/AI chaqiruvi yo'q.
async function handleModelQuery(ctx: BotContext, chatId: string, text: string): Promise<void> {
  const requested = text.trim();
  const normalized = normalizeModelNameInput(requested);
  const matched = modelsStore.getAll().find((m) => normalizeModelNameInput(m.name) === normalized);

  modelRequestsStore.record(requested, chatId, !!matched, matched?.name);

  if (!matched) {
    await ctx.reply(NOT_FOUND_TEXT);
    return;
  }

  await ctx.reply("Modelingiz topildi, ma'lumotlarni tayyorlayapman...");
  await sleep(5000);

  if (matched.videoFileId) {
    await ctx.telegram.sendVideo(
      chatId,
      matched.videoFileId,
      matched.videoCaption ? { caption: matched.videoCaption } : {}
    );
  } else if (matched.videoLink) {
    await ctx.reply(`Video qo'llanma: ${matched.videoLink}`);
  }

  if (matched.setupLink) {
    await sleep(5000);
    await ctx.reply(`Sozlash uchun ilova/portal havolasi: ${matched.setupLink}`);
  }
}

export function registerClientHandlers(bot: Telegraf<BotContext>): void {
  bot.start(async (ctx) => {
    logger.info({ chatId: ctx.chat ? String(ctx.chat.id) : null }, "bot.start: /start qabul qilindi");
    if (!ctx.from || isAdmin(ctx.from.id)) return;
    getOrCreateClient(String(ctx.chat.id), ctx.from.first_name, ctx.from.username);
    await ctx.reply(GREETING_TEXT);
  });

  bot.on("message", async (ctx) => {
    const from = ctx.from;
    const chatIdForLog = ctx.chat ? String(ctx.chat.id) : null;
    const rawMsg = ctx.message as unknown as Record<string, unknown>;
    const rawText = typeof rawMsg["text"] === "string" ? (rawMsg["text"] as string) : undefined;
    logger.info(
      { chatId: chatIdForLog, textPreview: rawText ? rawText.slice(0, 20) : null },
      "bot.on(message): xabar qabul qilindi"
    );

    if (!from || isAdmin(from.id)) return;

    const chatId = String(ctx.chat.id);
    getOrCreateClient(chatId, from.first_name, from.username);

    const msg = ctx.message as unknown as Record<string, unknown>;
    const text = typeof msg["text"] === "string" ? (msg["text"] as string) : undefined;
    if (!text || text.startsWith("/")) {
      if (!text) await ctx.reply(NON_TEXT_HINT);
      return;
    }

    try {
      await handleModelQuery(ctx, chatId, text);
    } catch (err) {
      logger.error({ err, chatId }, "handleModelQuery xatolik");
      await ctx.reply("Kechirasiz, xatolik yuz berdi. Birozdan so'ng qayta yozib ko'ring.");
    }
  });
}
