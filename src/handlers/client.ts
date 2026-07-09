import { Telegraf } from "telegraf";
import type { BotContext } from "../types.js";
import { modelsStore, clientsStore, samplesStore, type ClientData, type MessageRecord } from "../data/store.js";
import {
  detectLanguage,
  isAdmin,
  downloadFileAsBase64,
  getModelRefImages,
  randomDelay,
  sendSplitMessages,
  sleep,
} from "../helpers.js";
import { identifyModelFromImages, detectIntent, answerQuestion } from "../ai.js";
import type { ClientFeedback } from "../data/store.js";

const MAX_HISTORY = 20;
const GREETING_PAUSE_HOURS = 8;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function shouldGreetBack(client: ClientData): boolean {
  if (!client.hasGreeted) return true;
  if (!client.lastInteractionDate) return false;
  const last = new Date(client.lastInteractionDate + "T00:00:00Z").getTime();
  const now = Date.now();
  const hoursPassed = (now - last) / (1000 * 60 * 60);
  return hoursPassed >= GREETING_PAUSE_HOURS;
}

function addToHistory(client: ClientData, role: "user" | "assistant", content: string): void {
  if (!client.messageHistory) client.messageHistory = [];
  const record: MessageRecord = { role, content, timestamp: new Date().toISOString() };
  client.messageHistory.push(record);
  if (client.messageHistory.length > MAX_HISTORY) {
    client.messageHistory = client.messageHistory.slice(-MAX_HISTORY);
  }
}

function getOrCreateClient(chatId: string, firstName?: string): ClientData {
  const existing = clientsStore.getById(chatId);
  if (existing) {
    if (firstName && !existing.firstName) existing.firstName = firstName;
    return existing;
  }
  return {
    chatId,
    language: "uz",
    firstName,
    hasGreeted: false,
    askedForPhotoOnce: false,
    awaitingConnectionConfirm: false,
    connectionFollowupSentAt: null,
    reviewSent: false,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    voiceSent: false,
    gratitudeSent: false,
    lastVideoSentAt: null,
    messageHistory: [],
  };
}

// ─── Xabarni qayta ishlash ────────────────────────────────────────────────────

async function processIncomingMessage(
  ctx: BotContext,
  msg: Record<string, unknown>,
  from: { id: number; first_name?: string },
  chatId: string,
  businessConnectionId?: string
): Promise<void> {
  if (isAdmin(from.id)) return;

  const firstName = from.first_name || undefined;
  const msgId = (msg.message_id as number) || 0;
  const client = getOrCreateClient(chatId, firstName);

  // Dublikat tekshirish
  if (client.lastProcessedMessageId === msgId) return;
  client.lastProcessedMessageId = msgId;
  client.lastSeen = new Date().toISOString();
  if (businessConnectionId) client.businessConnectionId = businessConnectionId;
  if (firstName && !client.firstName) client.firstName = firstName;

  clientsStore.save(client);

  // Tur bo'yicha yo'naltirish
  if (msg.voice) {
    await handleVoice(ctx, client, businessConnectionId);
    return;
  }
  if (msg.photo) {
    const photos = msg.photo as Array<{ file_id: string }>;
    bufferPhoto(ctx, chatId, photos[photos.length - 1].file_id, businessConnectionId);
    return;
  }
  if (msg.text) {
    if (client.feedbackStage && client.feedbackStage !== "done") {
      await handleFeedback(ctx, client, msg.text as string, businessConnectionId);
      return;
    }
    await handleText(ctx, client, msg.text as string, businessConnectionId);
    return;
  }
}

// ─── Handler ro'yxatga olish ──────────────────────────────────────────────────

export function registerClientHandlers(bot: Telegraf<BotContext>): void {

  // Oddiy xabarlar (bot to'g'ridan-to'g'ri suhbati uchun, test/admin uchun)
  bot.on("message", async (ctx) => {
    const msg = ctx.message as Record<string, unknown>;
    const from = ctx.from;
    if (!from) return;

    const chatId = String(ctx.chat.id);
    const businessConnectionId =
      "business_connection_id" in ctx.message
        ? (ctx.message.business_connection_id as string | undefined)
        : undefined;

    await processIncomingMessage(ctx, msg, from, chatId, businessConnectionId);
  });

  // Business xabarlar — mijozlar do'kon egasining profiliga yozganda keladi
  // Bu ENG MUHIM handler — oldingi versiyada yo'q edi, shuning uchun bot javob bermadi
  bot.on("business_message", async (ctx) => {
    const update = ctx.update as Record<string, unknown>;
    const msg = update.business_message as Record<string, unknown>;
    if (!msg) return;

    const from = msg.from as { id: number; first_name?: string } | undefined;
    if (!from) return;

    const chat = msg.chat as { id: number } | undefined;
    if (!chat) return;

    const chatId = String(chat.id);
    const businessConnectionId = msg.business_connection_id as string | undefined;

    await processIncomingMessage(ctx, msg, from, chatId, businessConnectionId);
  });

  // Business ulanish o'rnatilganda — do'kon egasining ID'sini saqlaymiz
  bot.on("business_connection", async (ctx) => {
    const update = ctx.update as Record<string, unknown>;
    const conn = update.business_connection as Record<string, unknown> | undefined;
    if (!conn) return;

    const user = conn.user as { id: number } | undefined;
    const connId = conn.id as string | undefined;
    if (!user || !connId) return;

    // Admin ID'sini saqlashni loglash (ixtiyoriy: ADMIN_IDS da bo'lmasa ham)
    console.log(`Business ulanish o'rnatildi. Egasi: ${user.id}, connectionId: ${connId}`);
  });
}

// ─── Rasm bufferi (albom / ketma-ket rasmlar) ─────────────────────────────────

const PHOTO_DEBOUNCE_MS = 3000;
const MAX_CLIENT_PHOTOS = 5;

interface PhotoBuffer {
  fileIds: string[];
  timer: ReturnType<typeof setTimeout>;
  ctx: BotContext;
  businessConnectionId?: string;
}

const photoBuffers = new Map<string, PhotoBuffer>();

function bufferPhoto(ctx: BotContext, chatId: string, fileId: string, businessConnectionId?: string): void {
  const existing = photoBuffers.get(chatId);
  if (existing) {
    if (existing.fileIds.length < MAX_CLIENT_PHOTOS) existing.fileIds.push(fileId);
    existing.ctx = ctx;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flushPhotos(chatId), PHOTO_DEBOUNCE_MS);
  } else {
    photoBuffers.set(chatId, {
      fileIds: [fileId],
      ctx,
      businessConnectionId,
      timer: setTimeout(() => void flushPhotos(chatId), PHOTO_DEBOUNCE_MS),
    });
  }
}

async function flushPhotos(chatId: string): Promise<void> {
  const buf = photoBuffers.get(chatId);
  if (!buf) return;
  photoBuffers.delete(chatId);

  const client = clientsStore.getById(chatId);
  if (!client) return;

  try {
    await handlePhotos(buf.ctx, client, buf.fileIds, buf.businessConnectionId);
  } catch {
    try {
      const errMsg =
        client.language === "ru"
          ? "Не удалось обработать фото, попробуйте ещё раз."
          : "Rasmni qayta ishlab bo'lmadi, birozdan so'ng qayta yuboring.";
      await sendMsg(buf.ctx, chatId, errMsg, buf.businessConnectionId);
    } catch {
      // ignore
    }
  }
}

// ─── Business yoki oddiy xabar yuborish ──────────────────────────────────────

async function sendMsg(
  ctx: BotContext,
  chatId: string,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  if (businessConnectionId) {
    await ctx.telegram.callApi("sendMessage", {
      chat_id: chatId,
      text,
      business_connection_id: businessConnectionId,
    } as Record<string, unknown>);
  } else {
    await ctx.telegram.sendMessage(chatId, text);
  }
}

async function sendVideoMsg(
  ctx: BotContext,
  chatId: string,
  fileId: string,
  caption: string | undefined,
  businessConnectionId?: string
): Promise<void> {
  if (businessConnectionId) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      video: fileId,
      business_connection_id: businessConnectionId,
    };
    if (caption) payload.caption = caption;
    await ctx.telegram.callApi("sendVideo", payload);
  } else {
    await ctx.telegram.sendVideo(chatId, fileId, caption ? { caption } : {});
  }
}

async function sendVoiceMsg(
  ctx: BotContext,
  chatId: string,
  fileId: string,
  businessConnectionId?: string
): Promise<void> {
  if (businessConnectionId) {
    await ctx.telegram.callApi("sendVoice", {
      chat_id: chatId,
      voice: fileId,
      business_connection_id: businessConnectionId,
    } as Record<string, unknown>);
  } else {
    await ctx.telegram.sendVoice(chatId, fileId);
  }
}

// ─── Feedback javoblari ───────────────────────────────────────────────────────

async function handleFeedback(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const isUz = client.language === "uz";
  const chatId = client.chatId;

  if (!client.feedback) {
    client.feedback = { collectedAt: new Date().toISOString() } as ClientFeedback;
  }

  if (client.feedbackStage === "ask_region") {
    client.region = text.trim();
    client.feedbackStage = "ask_satisfaction";
    const q = isUz
      ? "Rahmat. Kamerangizdan qoniqayapsizmi? Nima yoqmaydi yoki qiyin bo'ldi?"
      : "Спасибо. Довольны ли вы камерой? Что не понравилось или показалось сложным?";
    await sendMsg(ctx, chatId, q, businessConnectionId);
  } else if (client.feedbackStage === "ask_satisfaction") {
    client.feedback.satisfaction = text;
    client.feedbackStage = "ask_wishlist";
    const q = isUz
      ? "Tushundim. Qanday xususiyatlar bo'lsa kamerangiz yanada yaxshi bo'lardi?"
      : "Понял. Какие функции сделали бы камеру лучше?";
    await sendMsg(ctx, chatId, q, businessConnectionId);
  } else if (client.feedbackStage === "ask_wishlist") {
    client.feedback.wishlist = text;
    client.feedbackStage = "ask_location";
    const q = isUz
      ? "Kamera qayerga o'rnatilgan yoki o'rnatmoqchisiz?"
      : "Куда установлена или планируется установить камера?";
    await sendMsg(ctx, chatId, q, businessConnectionId);
  } else if (client.feedbackStage === "ask_location") {
    client.feedback.location = text;
    client.feedbackStage = "ask_purpose";
    const q = isUz
      ? "Asosiy maqsad nima? (xavfsizlik, hayvon kuzatish, bola kuzatish va h.k.)"
      : "Какова основная цель? (безопасность, животные, дети, сотрудники)";
    await sendMsg(ctx, chatId, q, businessConnectionId);
  } else if (client.feedbackStage === "ask_purpose") {
    client.feedback.purpose = text;
    client.feedbackStage = "ask_budget";
    const q = isUz
      ? "Yangi kamera uchun taxminan qancha to'lashingiz mumkin?"
      : "Сколько вы готовы заплатить за новую камеру?";
    await sendMsg(ctx, chatId, q, businessConnectionId);
  } else if (client.feedbackStage === "ask_budget") {
    client.feedback.budget = text;
    client.feedback.collectedAt = new Date().toISOString();
    client.feedbackStage = "done";
    const thanks = isUz
      ? "Katta rahmat. Bu ma'lumotlar bizga juda kerak."
      : "Большое спасибо. Эти данные очень помогут нам.";
    await sendMsg(ctx, chatId, thanks, businessConnectionId);
  }

  clientsStore.save(client);
}

// ─── Ovozli xabar ─────────────────────────────────────────────────────────────

async function handleVoice(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  if (client.voiceSent) return;
  client.voiceSent = true;
  clientsStore.save(client);
  const reply =
    client.language === "uz"
      ? "Kechirasiz, hozircha matn ko'rinishida yozsangiz tushunarli bo'ladi."
      : "Извините, пока лучше напишите текстом.";
  await sendMsg(ctx, client.chatId, reply, businessConnectionId);
}

// ─── Rasmlar ─────────────────────────────────────────────────────────────────

async function handlePhotos(
  ctx: BotContext,
  client: ClientData,
  fileIds: string[],
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;
  const models = modelsStore.getAll();

  if (models.length === 0) {
    const msg = client.language === "uz"
      ? "Hozircha qo'llanmalar mavjud emas."
      : "Пока руководства недоступны.";
    await sendMsg(ctx, chatId, msg, businessConnectionId);
    return;
  }

  const clientImages: { base64: string; mimeType: string }[] = [];
  for (const fid of fileIds.slice(0, MAX_CLIENT_PHOTOS)) {
    const dl = await downloadFileAsBase64(ctx, fid);
    if (dl) clientImages.push(dl);
  }
  if (clientImages.length === 0) {
    const msg = client.language === "uz" ? "Rasmni o'qib bo'lmadi." : "Не удалось прочитать фото.";
    await sendMsg(ctx, chatId, msg, businessConnectionId);
    return;
  }

  const modelRefs = [];
  for (const m of models) {
    modelRefs.push({ name: m.name, refImages: await getModelRefImages(ctx, m) });
  }

  await randomDelay(25000, 70000);

  const result = await identifyModelFromImages(clientImages, modelRefs);
  client = clientsStore.getById(client.chatId) ?? client;

  if (result.status === "matched" && result.model) {
    const model = modelsStore.getByName(result.model);
    client.lastModelName = result.model;
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();

    const isUz = client.language === "uz";

    if (model && model.videoGuides.length > 0) {
      const firstCaption = model.videoGuides[0].caption ||
        (isUz ? `${result.model} kamerasi uchun yo'riqnoma.` : `Руководство для камеры ${result.model}.`);
      await sendVideoMsg(ctx, chatId, model.videoGuides[0].file_id, firstCaption, businessConnectionId);

      for (let i = 1; i < model.videoGuides.length; i++) {
        await sleep(1200);
        const v = model.videoGuides[i];
        const cap = v.caption || (isUz ? `${result.model} — ${i + 1}-qism` : `${result.model} — часть ${i + 1}`);
        await sendVideoMsg(ctx, chatId, v.file_id, cap, businessConnectionId);
      }

      await sleep(1500);
      const connectMsg = isUz
        ? "Kamerani ulashga muvaffaq bo'ldingizmi?"
        : "Вам удалось подключить камеру?";
      await sendMsg(ctx, chatId, connectMsg, businessConnectionId);
      addToHistory(client, "assistant", firstCaption + "\n" + connectMsg);
    } else {
      const confirmText = isUz
        ? `${result.model} kamerasi uchun video yo'riqnoma hali yuklanmagan.`
        : `Видеоруководство для ${result.model} ещё не загружено.`;
      await sendMsg(ctx, chatId, confirmText, businessConnectionId);
      addToHistory(client, "assistant", confirmText);
    }

    client.awaitingConnectionConfirm = true;
    client.connectionFollowupSentAt = null;
    client.lastVideoSentAt = new Date().toISOString();
    clientsStore.save(client);

  } else if (result.status === "unclear") {
    if (!client.askedForPhotoOnce) {
      client.askedForPhotoOnce = true;
      clientsStore.save(client);
      const msg = client.language === "uz"
        ? "Yorug' joyda, model yozuvi ko'rinadigan qilib qayta rasm yuboring."
        : "Пожалуйста, сделайте фото в светлом месте, чтобы была видна модель.";
      await sendMsg(ctx, chatId, msg, businessConnectionId);
    }
  } else {
    const msg = client.language === "uz"
      ? "Bu kamera uchun qo'llanma tez orada tayyorlanadi, biroz sabr qiling."
      : "Руководство для этой камеры скоро будет готово, подождите немного.";
    await sendMsg(ctx, chatId, msg, businessConnectionId);
  }
}

// ─── Matn ─────────────────────────────────────────────────────────────────────

async function handleText(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;

  if (!client.hasGreeted) {
    client.language = detectLanguage(text);
  }

  const intent = await detectIntent(text);

  if (intent === "greeting") {
    const greetBack = shouldGreetBack(client);
    if (greetBack) {
      const samples = samplesStore.getAll().map((s) => s.text);
      const reply = await answerQuestion({
        question: text,
        language: client.language,
        cameraModel: client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined,
        firstName: client.firstName,
        shouldGreet: true,
        history: client.messageHistory || [],
        samples,
      });
      addToHistory(client, "user", text);
      addToHistory(client, "assistant", reply);
      client.hasGreeted = true;
      client.lastInteractionDate = todayStr();
      clientsStore.save(client);

      const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        await sendMsg(ctx, chatId, part, businessConnectionId);
        if (parts.length > 1) await sleep(800);
      }
      return;
    }
  }

  if (intent === "gratitude") {
    if (!client.gratitudeSent) {
      client.gratitudeSent = true;
      const reply = client.language === "uz"
        ? "Arzimaydi. Savol bo'lsa yozing."
        : "Не за что. Если есть вопросы, пишите.";
      addToHistory(client, "user", text);
      addToHistory(client, "assistant", reply);
      client.lastInteractionDate = todayStr();
      clientsStore.save(client);
      await sendMsg(ctx, chatId, reply, businessConnectionId);
    } else {
      client.lastInteractionDate = todayStr();
      clientsStore.save(client);
    }

    if (client.awaitingConnectionConfirm) {
      client.awaitingConnectionConfirm = false;
      client.connectionConfirmed = true;
      clientsStore.save(client);
      await sendReview(ctx, client, businessConnectionId);
    }
    return;
  }

  if (intent === "cannot_send_photo") {
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();
    const reply = client.language === "uz"
      ? "Tushunarli, kamerangiz qaysi model ekanini so'z bilan yozing."
      : "Понятно, напишите текстом, какая у вас модель камеры.";
    addToHistory(client, "user", text);
    addToHistory(client, "assistant", reply);
    clientsStore.save(client);
    await sendMsg(ctx, chatId, reply, businessConnectionId);
    return;
  }

  const cameraModel = client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined;
  const samples = samplesStore.getAll().map((s) => s.text);

  await randomDelay(15000, 50000);

  const reply = await answerQuestion({
    question: text,
    language: client.language,
    cameraModel,
    firstName: client.firstName,
    shouldGreet: false,
    history: client.messageHistory || [],
    samples,
  });

  addToHistory(client, "user", text);
  addToHistory(client, "assistant", reply);
  client.hasGreeted = true;
  client.lastInteractionDate = todayStr();
  clientsStore.save(client);

  const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    await sendMsg(ctx, chatId, part, businessConnectionId);
    if (parts.length > 1) await sleep(800);
  }

  if (!cameraModel && !client.askedForPhotoOnce) {
    client.askedForPhotoOnce = true;
    clientsStore.save(client);
    await sendMsg(ctx, chatId,
      client.language === "uz"
        ? "Aniqroq yordam bera olishim uchun kamerangiz rasmini yuboring."
        : "Чтобы помочь точнее — пришлите фото вашей камеры.",
      businessConnectionId
    );
  }
}

// ─── Sharh yuborish ───────────────────────────────────────────────────────────

async function sendReview(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  if (!client.lastModelName) return;
  const model = modelsStore.getByName(client.lastModelName);
  if (!model) return;
  if (!model.reviewVoiceFileId && !model.reviewVideoFileId) return;

  const chatId = client.chatId;
  if (model.reviewVoiceFileId) {
    await sendVoiceMsg(ctx, chatId, model.reviewVoiceFileId, businessConnectionId);
  }
  if (model.reviewVideoFileId) {
    await sleep(1000);
    await sendVideoMsg(ctx, chatId, model.reviewVideoFileId, undefined, businessConnectionId);
  }

  client.reviewSent = true;
  clientsStore.save(client);
}
