import { Telegraf } from "telegraf";
import type { BotContext } from "../types.js";
import {
  modelsStore,
  clientsStore,
  samplesStore,
  issuesStore,
  modelMentionsStore,
  refundEventsStore,
  activityStore,
  type ClientData,
  type MessageRecord,
} from "../data/store.js";
import {
  detectLanguage,
  isAdmin,
  downloadFileAsBase64,
  randomDelay,
  sendSplitMessages,
  sleep,
} from "../helpers.js";
import { identifyModelFromImages, detectIntent, answerQuestion, classifyProductFeedback, classifyRegion } from "../ai.js";
import { getModelCollage } from "../collage.js";
import type { ClientFeedback } from "../data/store.js";
import { logger } from "../lib/logger.js";

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

// ─── Mijoz bo'yicha navbat ────────────────────────────────────────────────────
// handleText/handleFeedback bir mijoz uchun bir vaqtning o'zida faqat bittadan
// ishlashi kerak (aks holda ikkita ketma-ket xabar bir xil client obyektini
// parallel o'zgartirib, aralash tilda/ikki marta javob yuborilishiga olib
// keladi). Boshqa mijozlarni BLOKLAMAYDI — har bir chatId o'z navbatiga ega.

const chatQueues = new Map<string, Promise<void>>();

function runSerialized(chatId: string, task: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const run = prev.then(task).catch((err) => {
    logger.error({ err, chatId }, "queued chat task failed");
  }).finally(() => {
    if (chatQueues.get(chatId) === run) chatQueues.delete(chatId);
  });
  chatQueues.set(chatId, run);
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
  activityStore.record(chatId);

  // Tur bo'yicha yo'naltirish
  if (msg.voice) {
    await handleVoice(ctx, client, businessConnectionId);
    return;
  }
  if (msg.photo) {
    const photos = msg.photo as Array<{ file_id: string }>;
    const caption = typeof msg.caption === "string" ? msg.caption : undefined;
    bufferPhoto(ctx, chatId, photos[photos.length - 1].file_id, businessConnectionId, caption);
    return;
  }
  if (msg.text) {
    const text = msg.text as string;
    // handleText/handleFeedback/handleConnectionMethodAnswer ataylab kechikadi
    // (AI javobi + "inson kabi yozayapti" pauzasi, 15-70 soniyagacha). Telegraf
    // keyingi yangilanishlarni shu update to'liq tugagach so'raydi, shuning
    // uchun bularni KUTMASDAN ishga tushiramiz — aks holda shu vaqt ichida
    // yozgan boshqa mijozlarning xabarlari umuman olinmay qoladi. runSerialized
    // shu mijoz uchun xabarlar ketma-ket (parallel emas) ishlanishini
    // kafolatlaydi.
    if (client.feedbackStage && client.feedbackStage !== "done") {
      runSerialized(chatId, () =>
        handleFeedback(ctx, client, text, businessConnectionId).catch(async (err) => {
          logger.error({ err, chatId }, "handleFeedback failed");
          await sendFallbackError(ctx, client, businessConnectionId);
        })
      );
      return;
    }
    if (client.awaitingConnectionMethod) {
      runSerialized(chatId, () =>
        handleConnectionMethodAnswer(ctx, client, text, businessConnectionId).catch(async (err) => {
          logger.error({ err, chatId }, "handleConnectionMethodAnswer failed");
          await sendFallbackError(ctx, client, businessConnectionId);
        })
      );
      return;
    }
    runSerialized(chatId, () =>
      handleText(ctx, client, text, businessConnectionId).catch(async (err) => {
        logger.error({ err, chatId }, "handleText failed");
        await sendFallbackError(ctx, client, businessConnectionId);
      })
    );
    return;
  }

  // Boshqa turdagi xabar (stiker, GIF, hujjat va h.k.) — yuqoridagi
  // hech biriga mos kelmadi, aks holda javobsiz qolib ketardi.
  if (!client.hasGreeted) {
    // Mijozning birinchi murojaati — xuddi "salom" yozgandek qabul qilamiz.
    runSerialized(chatId, () =>
      handleFirstContactNonText(ctx, client, businessConnectionId).catch(async (err) => {
        logger.error({ err, chatId }, "handleFirstContactNonText failed");
        await sendFallbackError(ctx, client, businessConnectionId);
      })
    );
    return;
  }

  runSerialized(chatId, () =>
    handleUnsupportedMessage(ctx, client, businessConnectionId).catch((err) => {
      logger.error({ err, chatId }, "handleUnsupportedMessage failed");
    })
  );
}

// ─── Handler ro'yxatga olish ──────────────────────────────────────────────────

export function registerClientHandlers(bot: Telegraf<BotContext>): void {

  // Oddiy xabarlar (bot to'g'ridan-to'g'ri suhbati uchun, test/admin uchun)
  bot.on("message", async (ctx) => {
    const msg = ctx.message as unknown as Record<string, unknown>;
    const from = ctx.from;
    if (!from) return;

    const chatId = String(ctx.chat.id);
    const businessConnectionId =
      "business_connection_id" in ctx.message
        ? (ctx.message.business_connection_id as string | undefined)
        : undefined;

    await processIncomingMessage(ctx, msg, from, chatId, businessConnectionId);
  });

  // Business xabarlar — mijozlar do'kon egasining profiliga yozganda keladi.
  // @telegraf/types@7.1.0 hali business_message update turini bilmaydi, shuning
  // uchun bot.on("business_message", ...) kabi tipli filtr build'ni buzadi —
  // shu sababli xom update'ni o'zimiz bot.use() ichida tekshiramiz.
  bot.use(async (ctx, next) => {
    const update = ctx.update as unknown as Record<string, unknown>;
    const msg = update.business_message as Record<string, unknown> | undefined;
    if (!msg) return next();

    const from = msg.from as { id: number; first_name?: string } | undefined;
    if (!from) return;

    const chat = msg.chat as { id: number } | undefined;
    if (!chat) return;

    const chatId = String(chat.id);
    const businessConnectionId = msg.business_connection_id as string | undefined;

    await processIncomingMessage(ctx, msg, from, chatId, businessConnectionId);
  });

  // Business ulanish o'rnatilganda — do'kon egasining ID'sini saqlaymiz
  bot.use(async (ctx, next) => {
    const update = ctx.update as unknown as Record<string, unknown>;
    const conn = update.business_connection as Record<string, unknown> | undefined;
    if (!conn) return next();

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
  caption?: string;
}

const photoBuffers = new Map<string, PhotoBuffer>();

function bufferPhoto(
  ctx: BotContext,
  chatId: string,
  fileId: string,
  businessConnectionId?: string,
  caption?: string
): void {
  const existing = photoBuffers.get(chatId);
  if (existing) {
    if (existing.fileIds.length < MAX_CLIENT_PHOTOS) existing.fileIds.push(fileId);
    existing.ctx = ctx;
    if (caption && !existing.caption) existing.caption = caption;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flushPhotos(chatId), PHOTO_DEBOUNCE_MS);
  } else {
    photoBuffers.set(chatId, {
      fileIds: [fileId],
      ctx,
      businessConnectionId,
      caption,
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
    await handlePhotos(buf.ctx, client, buf.fileIds, buf.businessConnectionId, buf.caption);
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
    } as any);
  } else {
    await ctx.telegram.sendMessage(chatId, text);
  }
}

// handleText/handleFeedback xatoga uchraganda mijoz butunlay javobsiz
// qolmasligi uchun — avval xatolik logger.error orqali yoziladi, lekin
// mijozning o'ziga hech qanday xabar bormas edi, shuni tuzatadi.
async function sendFallbackError(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  const msg = client.language !== "ru"
    ? "Kechirasiz, xatolik yuz berdi. Birozdan so'ng qayta yozib ko'ring."
    : "Извините, произошла ошибка. Попробуйте написать чуть позже.";
  try {
    await sendMsg(ctx, client.chatId, msg, businessConnectionId);
  } catch {
    // fallback ham yuborilmasa, qila oladigan narsa yo'q
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
    await ctx.telegram.callApi("sendVideo", payload as any);
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
    } as any);
  } else {
    await ctx.telegram.sendVoice(chatId, fileId);
  }
}

// ─── Ulash usuli (qisqa/uzoq masofa) ──────────────────────────────────────────

function connectionMethodQuestion(language: ClientData["language"]): string {
  return language !== "ru"
    ? "Kamerani qanday ulamoqchisiz — uzoq masofadanmi (uy WiFi routeri orqali, istalgan joydan ko'rish) yoki qisqa masofadanmi (kamera WiFi'siga to'g'ridan-to'g'ri ulanib)?"
    : "Как вы хотите подключить камеру — на дальнем расстоянии (через домашний WiFi роутер, просмотр из любой точки) или на близком расстоянии (напрямую к WiFi камеры)?";
}

function askForCameraPhotoText(language: ClientData["language"]): string {
  return language !== "ru"
    ? "Aniqroq yordam bera olishim uchun kamerangiz rasmini yuboring."
    : "Чтобы помочь точнее — пришлите фото вашей камеры.";
}

// Qisqa masofa — mavjud video yo'riqnomalarni ketma-ket yuboradi (avvalgi xatti-harakat o'zgarmagan)
async function sendShortRangeGuide(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;
  const isUz = client.language !== "ru";
  const modelName = client.lastModelName ?? "";
  const model = client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined;

  if (model && model.videoGuides.length > 0) {
    const firstCaption = model.videoGuides[0].caption ||
      (isUz ? `${modelName} kamerasi uchun yo'riqnoma.` : `Руководство для камеры ${modelName}.`);
    await sendVideoMsg(ctx, chatId, model.videoGuides[0].file_id, firstCaption, businessConnectionId);

    for (let i = 1; i < model.videoGuides.length; i++) {
      await sleep(1200);
      const v = model.videoGuides[i];
      const cap = v.caption || (isUz ? `${modelName} — ${i + 1}-qism` : `${modelName} — часть ${i + 1}`);
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
      ? `${modelName} kamerasi uchun video yo'riqnoma hali yuklanmagan.`
      : `Видеоруководство для ${modelName} ещё не загружено.`;
    await sendMsg(ctx, chatId, confirmText, businessConnectionId);
    addToHistory(client, "assistant", confirmText);
  }

  client.awaitingConnectionConfirm = true;
  client.connectionFollowupSentAt = null;
  client.lastVideoSentAt = new Date().toISOString();
  clientsStore.save(client);
}

// Uzoq masofa — video yo'q, AI matnli yo'riqnomaga tayanib savol-javob tarzida yordam beradi.
// "Ishladimi?" so'rovi va sharh yuborish bosqichi hozircha faqat qisqa masofa uchun ishlaydi.
async function sendLongRangeIntro(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  const isUz = client.language !== "ru";
  const msg = isUz
    ? "Uzoq masofadan ulash bo'yicha yordam beraman. Kamerangiz ilovada qo'shilganmi, yoki boshidan boshlaylikmi?"
    : "Помогу подключить камеру на дальнем расстоянии. Камера уже добавлена в приложении, или начнём с начала?";
  await sendMsg(ctx, client.chatId, msg, businessConnectionId);
  addToHistory(client, "assistant", msg);
  clientsStore.save(client);
}

async function deliverConnectionGuide(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  if (client.connectionMethod === "short") {
    await sendShortRangeGuide(ctx, client, businessConnectionId);
  } else {
    await sendLongRangeIntro(ctx, client, businessConnectionId);
  }
}

// Mijoz "kamerani ulashga yordam bering" desa (model va/yoki usul hali noma'lum bo'lishi mumkin)
async function handleConnectCameraRequest(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;

  if (!client.connectionMethod) {
    client.awaitingConnectionMethod = true;
    clientsStore.save(client);
    await sendMsg(ctx, chatId, connectionMethodQuestion(client.language), businessConnectionId);
    return;
  }

  if (!client.lastModelName) {
    if (!client.askedForPhotoOnce) {
      client.askedForPhotoOnce = true;
      clientsStore.save(client);
      await sendMsg(ctx, chatId, askForCameraPhotoText(client.language), businessConnectionId);
    }
    return;
  }

  await deliverConnectionGuide(ctx, client, businessConnectionId);
}

// "awaitingConnectionMethod" holatida kelgan javobni (qisqa/uzoq) tekshiradi
async function handleConnectionMethodAnswer(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const { connectionMethod } = await detectIntent(text);

  if (!connectionMethod) {
    await sendMsg(ctx, client.chatId, connectionMethodQuestion(client.language), businessConnectionId);
    return;
  }

  client.connectionMethod = connectionMethod;
  client.awaitingConnectionMethod = false;
  clientsStore.save(client);

  if (!client.lastModelName) {
    if (!client.askedForPhotoOnce) {
      client.askedForPhotoOnce = true;
      clientsStore.save(client);
      await sendMsg(ctx, client.chatId, askForCameraPhotoText(client.language), businessConnectionId);
    }
    return;
  }

  await deliverConnectionGuide(ctx, client, businessConnectionId);
}

// ─── Muammo/istak statistikasi ────────────────────────────────────────────────

// Mavjud kategoriyalarga moslashtirib (yoki yangi ochib) mijoz fikrini qayd
// etadi. Javobni kutmaymiz — mijozga yuboriladigan xabarni kechiktirmasin.
function recordProductFeedback(feedbackText: string, client: ClientData): void {
  const existingLabels = issuesStore.getAll().map((c) => c.label);
  classifyProductFeedback(feedbackText, existingLabels)
    .then((label) => {
      if (label) issuesStore.recordMention(label, client.chatId, client.lastModelName);
    })
    .catch((err) => {
      logger.error({ err, chatId: client.chatId }, "recordProductFeedback failed");
    });
}

// ─── Feedback javoblari ───────────────────────────────────────────────────────

async function handleFeedback(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const isUz = client.language !== "ru";
  const chatId = client.chatId;

  if (!client.feedback) {
    client.feedback = { collectedAt: new Date().toISOString() } as ClientFeedback;
  }

  if (client.feedbackStage === "ask_region") {
    // Erkin matnni ro'yxatdagi viloyat nomiga moslashtiramiz —
    // aks holda "Toshkent"/"toshkent shahri"/"TOSHKENT" alohida-alohida
    // hisoblanib, statistikani buzardi.
    client.region = (await classifyRegion(text)) ?? undefined;
    client.feedbackStage = "ask_satisfaction";
    const q = isUz
      ? "Rahmat. Kamerangizdan qoniqayapsizmi? Nima yoqmaydi yoki qiyin bo'ldi?"
      : "Спасибо. Довольны ли вы камерой? Что не понравилось или показалось сложным?";
    await sendMsg(ctx, chatId, q, businessConnectionId);
  } else if (client.feedbackStage === "ask_satisfaction") {
    client.feedback.satisfaction = text;
    recordProductFeedback(text, client);
    client.feedbackStage = "ask_wishlist";
    const q = isUz
      ? "Tushundim. Qanday xususiyatlar bo'lsa kamerangiz yanada yaxshi bo'lardi?"
      : "Понял. Какие функции сделали бы камеру лучше?";
    await sendMsg(ctx, chatId, q, businessConnectionId);
  } else if (client.feedbackStage === "ask_wishlist") {
    client.feedback.wishlist = text;
    recordProductFeedback(text, client);
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
    client.language !== "ru"
      ? "Kechirasiz, hozircha matn ko'rinishida yozsangiz tushunarli bo'ladi."
      : "Извините, пока лучше напишите текстом.";
  await sendMsg(ctx, client.chatId, reply, businessConnectionId);
}

// ─── Boshqa turdagi xabar (stiker, GIF, hujjat va h.k.) ───────────────────────

// Mijozning ENG BIRINCHI murojaati stiker/GIF kabi narsa bo'lsa — xuddi
// "salom" yozgandek qabul qilib, iliq salomlashamiz va kamera rasmini so'raymiz.
async function handleFirstContactNonText(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  const samples = samplesStore.getAll().map((s) => s.text);
  const reply = await answerQuestion({
    question: "Salom",
    language: client.language,
    cameraModel: undefined,
    connectionMethod: client.connectionMethod,
    refundRequested: client.refundRequested,
    firstName: client.firstName,
    shouldGreet: true,
    history: client.messageHistory || [],
    samples,
  });

  addToHistory(client, "assistant", reply);
  client.hasGreeted = true;
  client.lastInteractionDate = todayStr();
  clientsStore.save(client);

  const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    await sendMsg(ctx, client.chatId, part, businessConnectionId);
    if (parts.length > 1) await sleep(800);
  }

  if (!client.askedForPhotoOnce) {
    client.askedForPhotoOnce = true;
    clientsStore.save(client);
    await sleep(800);
    await sendMsg(ctx, client.chatId, askForCameraPhotoText(client.language), businessConnectionId);
  }
}

// Suhbat davomida (birinchi murojaat emas) kelgan stiker/GIF va h.k. uchun —
// bir martagina, matn bilan yozishni so'rab qo'yamiz.
async function handleUnsupportedMessage(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  if (client.unsupportedMessageNoted) return;
  client.unsupportedMessageNoted = true;
  clientsStore.save(client);
  const reply = client.language !== "ru"
    ? "Savolingiz bo'lsa, matn bilan yozing — yordam beraman."
    : "Если есть вопрос, напишите текстом — я помогу.";
  await sendMsg(ctx, client.chatId, reply, businessConnectionId);
}

// ─── Rasmlar ─────────────────────────────────────────────────────────────────

async function handlePhotos(
  ctx: BotContext,
  client: ClientData,
  fileIds: string[],
  businessConnectionId?: string,
  caption?: string
): Promise<void> {
  const chatId = client.chatId;
  const models = modelsStore.getAll();

  if (models.length === 0) {
    const msg = client.language !== "ru"
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
    const msg = client.language !== "ru" ? "Rasmni o'qib bo'lmadi." : "Не удалось прочитать фото.";
    await sendMsg(ctx, chatId, msg, businessConnectionId);
    return;
  }

  // Rasm bilan birga izoh (caption) kelgan bo'lsa, undan ulash usulini
  // aniqlashga harakat qilamiz — mijozga qayta so'ramaslik uchun.
  if (caption && !client.connectionMethod) {
    const { connectionMethod } = await detectIntent(caption);
    if (connectionMethod) {
      client.connectionMethod = connectionMethod;
      clientsStore.save(client);
    }
  }

  const modelRefs = [];
  for (const m of models) {
    modelRefs.push({ name: m.name, refCollage: await getModelCollage(ctx, m) });
  }

  await randomDelay(25000, 70000);

  const result = await identifyModelFromImages(clientImages, modelRefs);
  client = clientsStore.getById(client.chatId) ?? client;

  if (result.status === "matched" && result.model) {
    client.lastModelName = result.model;
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();
    clientsStore.save(client);
    modelMentionsStore.record(result.model, client.chatId);

    if (!client.connectionMethod) {
      client.awaitingConnectionMethod = true;
      clientsStore.save(client);
      await sendMsg(ctx, chatId, connectionMethodQuestion(client.language), businessConnectionId);
    } else {
      await deliverConnectionGuide(ctx, client, businessConnectionId);
    }

  } else if (result.status === "unclear") {
    if (!client.askedForPhotoOnce) {
      client.askedForPhotoOnce = true;
      clientsStore.save(client);
      const msg = client.language !== "ru"
        ? "Yorug' joyda, model yozuvi ko'rinadigan qilib qayta rasm yuboring."
        : "Пожалуйста, сделайте фото в светлом месте, чтобы была видна модель.";
      await sendMsg(ctx, chatId, msg, businessConnectionId);
    }
  } else {
    const msg = client.language !== "ru"
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

  const { intent, connectionMethod, productFeedback } = await detectIntent(text);

  if (connectionMethod && !client.connectionMethod) {
    client.connectionMethod = connectionMethod;
    clientsStore.save(client);
  }

  if (intent === "refund_request" && !client.refundRequested) {
    client.refundRequested = true;
    clientsStore.save(client);
    refundEventsStore.record(client.chatId, client.lastModelName);
  }

  if (productFeedback) {
    recordProductFeedback(productFeedback, client);
  }

  if (intent === "greeting") {
    const greetBack = shouldGreetBack(client);
    if (greetBack) {
      const samples = samplesStore.getAll().map((s) => s.text);
      const reply = await answerQuestion({
        question: text,
        language: client.language,
        cameraModel: client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined,
        connectionMethod: client.connectionMethod,
        refundRequested: client.refundRequested,
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
      const reply = client.language !== "ru"
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
      // Norozi bo'lgan yoki pul qaytarishni so'ragan mijozdan sharh so'ralmaydi —
      // xafa bo'lib salbiy sharh qoldirishi mumkin.
      if (!client.refundRequested) {
        await sendReview(ctx, client, businessConnectionId);
      }
    }
    return;
  }

  if (intent === "cannot_send_photo") {
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();
    const reply = client.language !== "ru"
      ? "Tushunarli, kamerangiz qaysi model ekanini so'z bilan yozing."
      : "Понятно, напишите текстом, какая у вас модель камеры.";
    addToHistory(client, "user", text);
    addToHistory(client, "assistant", reply);
    clientsStore.save(client);
    await sendMsg(ctx, chatId, reply, businessConnectionId);
    return;
  }

  if (intent === "connect_camera") {
    addToHistory(client, "user", text);
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();
    clientsStore.save(client);
    await handleConnectCameraRequest(ctx, client, businessConnectionId);
    return;
  }

  const cameraModel = client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined;
  const samples = samplesStore.getAll().map((s) => s.text);

  await randomDelay(15000, 50000);

  const reply = await answerQuestion({
    question: text,
    language: client.language,
    cameraModel,
    connectionMethod: client.connectionMethod,
    refundRequested: client.refundRequested,
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
    await sendMsg(ctx, chatId, askForCameraPhotoText(client.language), businessConnectionId);
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
