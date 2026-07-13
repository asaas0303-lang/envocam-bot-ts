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
  settingsStore,
  type ClientData,
  type CameraModel,
  type MessageRecord,
} from "../data/store.js";
import {
  detectLanguage,
  isAdmin,
  getAdminIds,
  downloadFileAsBase64,
  randomDelay,
  sendSplitMessages,
  sleep,
} from "../helpers.js";
import {
  detectIntent,
  answerQuestion,
  classifyProductFeedback,
  classifyRegion,
  classifyImage,
  classifySurveyReply,
  type ImageClassification,
} from "../ai.js";
import { readBarcodeFromImage } from "../barcode.js";
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
    // FAQAT raqamlardan iborat (uzun) matn — mijoz barcode raqamini qo'lda
    // yozgan. Har qanday holatda (so'rovnoma vaqtida ham) barcode sifatida
    // qabul qilamiz.
    if (isLikelyBarcodeText(text, client.feedbackStage)) {
      runSerialized(chatId, () =>
        handleTypedBarcode(ctx, client, text, businessConnectionId).catch(async (err) => {
          logger.error({ err, chatId }, "handleTypedBarcode failed");
          await sendFallbackError(ctx, client, businessConnectionId);
        })
      );
      return;
    }
    // So'rovnoma davom etyaptimi? Xabar so'rovnoma javobimi yoki mijoz boshqa
    // narsa (savol/yordam/salom) so'rayaptimi — shuni tekshirib yo'naltiramiz.
    if (client.feedbackStage && client.feedbackStage !== "done") {
      runSerialized(chatId, () =>
        routeDuringFeedback(ctx, client, text, businessConnectionId).catch(async (err) => {
          logger.error({ err, chatId }, "routeDuringFeedback failed");
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
    if (client.awaitingModelName) {
      runSerialized(chatId, () =>
        handleModelNameAnswer(ctx, client, text, businessConnectionId).catch(async (err) => {
          logger.error({ err, chatId }, "handleModelNameAnswer failed");
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

  // Rasmni qayta ishlashni ham shu mijozning navbatiga qo'yamiz — aks holda
  // mijoz debounce oynasidan tashqarida bir necha rasm yuborsa, bir nechta
  // handlePhotos parallel ishlab, bir xil javobni takror yuborishi mumkin edi.
  runSerialized(chatId, async () => {
    const client = clientsStore.getById(chatId);
    if (!client) return;
    try {
      await handlePhotos(buf.ctx, client, buf.fileIds, buf.businessConnectionId, buf.caption);
    } catch (err) {
      logger.error({ err, chatId }, "handlePhotos failed");
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
  });
}

// ─── Dublikat yuborishdan himoya ─────────────────────────────────────────────
// Bir nechta oqim (rasm buferi, matn oqimi, barcode oqimi) bir-birini bilmay
// bir xil javobni mustaqil yuborib qo'yishi mumkin. Shu himoya: aynan bir xil
// matn/rasm shu mijozga oxirgi 2 daqiqa ichida yuborilgan bo'lsa — qayta
// yubormaydi. Ataylab takrorlanadigan navigatsion so'rovlar (masalan ulash
// usuli savoli) allowRepeat=true bilan bu himoyani chetlab o'tadi.

const DUP_WINDOW_MS = 2 * 60 * 1000;
const recentSends = new Map<string, number>();

function isDuplicateSend(chatId: string, key: string): boolean {
  const now = Date.now();
  // Vaqti o'tgan yozuvlarni tozalab turamiz (xotira cheksiz o'smasin).
  if (recentSends.size > 500) {
    for (const [k, t] of recentSends) {
      if (now - t > DUP_WINDOW_MS) recentSends.delete(k);
    }
  }
  const mapKey = `${chatId}|${key}`;
  const last = recentSends.get(mapKey);
  if (last !== undefined && now - last < DUP_WINDOW_MS) return true;
  recentSends.set(mapKey, now);
  return false;
}

// ─── Business yoki oddiy xabar yuborish ──────────────────────────────────────

async function sendMsg(
  ctx: BotContext,
  chatId: string,
  text: string,
  businessConnectionId?: string,
  options?: { allowRepeat?: boolean }
): Promise<void> {
  if (!options?.allowRepeat && isDuplicateSend(chatId, "t:" + text)) {
    logger.warn({ chatId }, "sendMsg: dublikat matn bloklandi");
    return;
  }
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

async function sendPhotoMsg(
  ctx: BotContext,
  chatId: string,
  fileId: string,
  caption: string | undefined,
  businessConnectionId?: string,
  options?: { allowRepeat?: boolean }
): Promise<void> {
  if (!options?.allowRepeat && isDuplicateSend(chatId, "p:" + fileId + "|" + (caption ?? ""))) {
    logger.warn({ chatId }, "sendPhotoMsg: dublikat rasm bloklandi");
    return;
  }
  if (businessConnectionId) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      photo: fileId,
      business_connection_id: businessConnectionId,
    };
    if (caption) payload.caption = caption;
    await ctx.telegram.callApi("sendPhoto", payload as any);
  } else {
    await ctx.telegram.sendPhoto(chatId, fileId, caption ? { caption } : {});
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

// Barcode avtomatik o'qilmagach, yaqinroq rasm so'raladi (QADAM 4).
function askForCloserPhotoText(language: ClientData["language"]): string {
  return language !== "ru"
    ? "Kamerangizni aniqlash uchun qutidagi oq stikerni YAQINDAN suratga oling — telefonni stikerga yaqinlashtirib, QR kod va raqam aniq ko'rinadigan qilib."
    : "Чтобы определить камеру, сфотографируйте белый стикер на коробке КРУПНЫМ ПЛАНОМ — поднесите телефон ближе, чтобы QR-код и номер были чётко видны.";
}

// Bir necha marta rasm ham yordam bermagach, oxirgi chora — model nomini
// matn bilan so'raymiz (QADAM 5).
function askForModelNameText(language: ClientData["language"]): string {
  return language !== "ru"
    ? "Qutida stiker yo'qmi yoki hali ham o'qib bo'lmayapti? Unda ayting — qaysi modelni oldingiz? (masalan A9, X5, X6)"
    : "На коробке нет стикера, или его всё ещё не удаётся прочитать? Тогда подскажите, какую модель вы приобрели? (например A9, X5, X6)";
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

// Model aniqlangandan keyin (rasm orqali yoki barcode orqali) ishlatiladi:
// ulash usuli hali noma'lum bo'lsa so'raydi, aks holda darhol yo'riqnoma beradi.
async function askConnectionMethodOrDeliver(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  if (!client.connectionMethod) {
    client.awaitingConnectionMethod = true;
    clientsStore.save(client);
    await sendMsg(ctx, client.chatId, connectionMethodQuestion(client.language), businessConnectionId, { allowRepeat: true });
  } else {
    await deliverConnectionGuide(ctx, client, businessConnectionId);
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
    await sendMsg(ctx, chatId, connectionMethodQuestion(client.language), businessConnectionId, { allowRepeat: true });
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
    await sendMsg(ctx, client.chatId, connectionMethodQuestion(client.language), businessConnectionId, { allowRepeat: true });
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

// ─── Barcode orqali model aniqlash ─────────────────────────────────────────────

// Bir xil mijoz-barcode juftligi uchun adminlarga faqat bir marta xabar
// beramiz — qayta-qayta bezovta qilmaslik uchun (jarayon ishga tushgan
// vaqt davomida, disk ga saqlanmaydi).
const notifiedUnknownBarcodes = new Set<string>();

async function notifyAdminsUnknownBarcode(
  ctx: BotContext,
  barcode: string,
  client: ClientData
): Promise<void> {
  const key = `${client.chatId}:${barcode}`;
  if (notifiedUnknownBarcodes.has(key)) return;
  notifiedUnknownBarcodes.add(key);

  const text =
    `⚠️ Mijoz noma'lum barcode yubordi: ${barcode}\n` +
    `Mijoz: ${client.firstName ?? client.chatId}\n\n` +
    `Agar bu haqiqiy EnvoCam kamerasi bo'lsa, shu barcode'ni tegishli modelga /panel orqali qo'shing.`;

  for (const adminId of getAdminIds()) {
    try {
      await ctx.telegram.sendMessage(adminId, text);
    } catch {
      // ignore
    }
  }
}

// Barcode topilgan-u lekin ro'yxatda yo'q bo'lganda ishlatiladi: adminni
// xabardor qilib, mijozga jim qolmasdan umumiy yordam beradi.
async function handleUnknownBarcode(
  ctx: BotContext,
  client: ClientData,
  barcode: string,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;
  await notifyAdminsUnknownBarcode(ctx, barcode, client);

  const samples = samplesStore.getAll().map((s) => s.text);
  await randomDelay(15000, 50000);
  const question = `Mijoz kamera qutisidagi barcode raqamini yubordi (rasmdan avtomatik o'qildi): ${barcode}. Bu raqam hozircha bizning ro'yxatda yo'q.`;
  const reply = await answerQuestion({
    question,
    language: client.language,
    cameraModel: undefined,
    connectionMethod: client.connectionMethod,
    refundRequested: client.refundRequested,
    firstName: client.firstName,
    shouldGreet: false,
    history: client.messageHistory || [],
    samples,
  });

  addToHistory(client, "assistant", reply);
  client.hasGreeted = true;
  client.lastInteractionDate = todayStr();
  clientsStore.save(client);

  const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    await sendMsg(ctx, chatId, part, businessConnectionId);
    if (parts.length > 1) await sleep(800);
  }
}

function onlyDigits(s: string): string {
  return s.replace(/\D/g, "");
}

// Barcode solishtirish — IKKALA tomon ham faqat raqamlarga keltirilib
// solishtiriladi (bo'sh joy, defis, URL bo'laklari e'tiborsiz qoladi).
// isPartial=true bo'lsa faqat oxirgi 4 raqam solishtiriladi (OCR last4 uchun).
function findModelByDigits(
  models: CameraModel[],
  value: string,
  isPartial: boolean
): CameraModel | undefined {
  const d = onlyDigits(value);
  if (!d) return undefined;

  if (isPartial) {
    if (d.length !== 4) return undefined;
    return models.find((m) => m.barcodes.some((b) => onlyDigits(b).slice(-4) === d));
  }

  return models.find((m) =>
    m.barcodes.some((b) => {
      const bd = onlyDigits(b);
      if (!bd) return false;
      if (bd === d) return true;
      // Boshdagi nol / qo'shimcha prefiks farqiga bardosh: qisqasi kamida
      // 10 xonali bo'lib, uzunining oxirini to'liq qamrasa — mos deb qabul qilamiz.
      const shorter = bd.length <= d.length ? bd : d;
      const longer = bd.length <= d.length ? d : bd;
      return shorter.length >= 10 && longer.endsWith(shorter);
    })
  );
}

// QADAM 4 — barcode avtomatik o'qilmasa, admin yuklagan namuna rasm (stiker
// joyi belgilangan) bilan birga "yaqinroq suratga oling" so'rovi yuboriladi.
async function sendCloserPhotoRequest(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  const text = askForCloserPhotoText(client.language);
  const sample = settingsStore.getStickerSample();
  if (sample) {
    await sendPhotoMsg(ctx, client.chatId, sample.file_id, text, businessConnectionId, { allowRepeat: true });
  } else {
    await sendMsg(ctx, client.chatId, text, businessConnectionId, { allowRepeat: true });
  }
}

// "A9" / "а9" (kirillcha lotinga o'xshash harflar bilan) kabi yozuvlarni bir
// xil deb solishtira olish uchun — lotinga o'xshash kirillcha harflarni
// lotin harfiga almashtiramiz.
const CYRILLIC_LOOKALIKES: Record<string, string> = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x",
};

function normalizeModelNameInput(text: string): string {
  let result = "";
  for (const ch of text.trim()) {
    result += CYRILLIC_LOOKALIKES[ch] ?? ch;
  }
  return result.toLowerCase().replace(/\s+/g, "");
}

// QADAM 5 — "awaitingModelName" holatida kelgan javobni tekshiradi (barcode
// hech qanday usul bilan aniqlanmagach so'raladigan OXIRGI chora).
async function handleModelNameAnswer(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;
  client.awaitingModelName = false;
  client.barcodeAttempts = 0;

  const normalized = normalizeModelNameInput(text);
  const matchedModel = modelsStore.getAll().find((m) => normalizeModelNameInput(m.name) === normalized);

  if (matchedModel) {
    client.lastModelName = matchedModel.name;
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();
    clientsStore.save(client);
    modelMentionsStore.record(matchedModel.name, client.chatId);
    await askConnectionMethodOrDeliver(ctx, client, businessConnectionId);
    return;
  }

  // QADAM 6 — baribir aniqlanmadi. Model aniqlashni to'xtatib, umumiy
  // yordamga o'tamiz — mijoz HECH QACHON javobsiz qolmasligi kerak.
  clientsStore.save(client);

  const samples = samplesStore.getAll().map((s) => s.text);
  await randomDelay(15000, 50000);
  const reply = await answerQuestion({
    question: text,
    language: client.language,
    cameraModel: undefined,
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

// ─── Mijoz qo'lda yozgan barcode raqami ───────────────────────────────────────

// Matn faqat (uzun) raqamdan iboratmi — ya'ni mijoz barcode raqamini yozganmi.
// ask_budget bosqichida qisqa raqam (narx) bo'lishi mumkin, shuning uchun u
// yerda faqat aniq uzun (12+) raqamni barcode deb qabul qilamiz.
function isLikelyBarcodeText(text: string, feedbackStage?: ClientData["feedbackStage"]): boolean {
  const d = text.replace(/[\s-]/g, "");
  if (!/^\d{8,}$/.test(d)) return false;
  if (feedbackStage === "ask_budget" && d.length < 12) return false;
  return true;
}

async function handleTypedBarcode(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const digits = onlyDigits(text);
  const models = modelsStore.getAll();
  const matched = findModelByDigits(models, digits, false);
  logger.info(
    { chatId: client.chatId, digits, matched: matched?.name ?? null },
    "barcode: mijoz qo'lda yozgan raqam"
  );

  // So'rovnoma davom etayotgan bo'lsa — uni pauza qilamiz, keyinroq davom etadi.
  if (client.feedbackStage && client.feedbackStage !== "done") {
    client.feedbackPausedAt = new Date().toISOString();
  }

  if (matched) {
    client.lastModelName = matched.name;
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();
    client.barcodeAttempts = 0;
    client.awaitingModelName = false;
    clientsStore.save(client);
    modelMentionsStore.record(matched.name, client.chatId);
    await askConnectionMethodOrDeliver(ctx, client, businessConnectionId);
    return;
  }

  // Qo'lda yozilgan raqam hech bir modelga mos kelmadi. Bu haqiqiy barcode
  // bo'lmasligi ham mumkin (masalan telefon raqami), shuning uchun adminni
  // bezovta qilmaymiz va "noma'lum barcode" deb javob bermaymiz — oddiy
  // yordam oqimiga o'tamiz, mijoz hech qachon javobsiz qolmaydi.
  clientsStore.save(client);
  await handleText(ctx, client, text, businessConnectionId);
}

// ─── So'rovnoma davomida yo'naltirish ─────────────────────────────────────────

// So'rovnomaning har bir bosqichida mijoz aynan qaysi savolga javob berayotganini
// (tasnif konteksti uchun) qaytaradi.
function currentFeedbackQuestion(
  stage: ClientData["feedbackStage"],
  language: ClientData["language"]
): string {
  const isUz = language !== "ru";
  switch (stage) {
    case "ask_region":
      return isUz ? "Qaysi viloyat yoki shahardan yozyapsiz?" : "Из какого вы города или региона?";
    case "ask_satisfaction":
      return isUz ? "Kamerangizdan qoniqayapsizmi? Nima yoqmaydi yoki qiyin bo'ldi?" : "Довольны ли вы камерой? Что не понравилось?";
    case "ask_wishlist":
      return isUz ? "Qanday xususiyatlar bo'lsa kamerangiz yanada yaxshi bo'lardi?" : "Какие функции сделали бы камеру лучше?";
    case "ask_location":
      return isUz ? "Kamera qayerga o'rnatilgan yoki o'rnatmoqchisiz?" : "Куда установлена или планируется камера?";
    case "ask_purpose":
      return isUz ? "Kameradan asosiy maqsad nima?" : "Какова основная цель использования камеры?";
    case "ask_budget":
      return isUz ? "Yangi kamera uchun taxminan qancha to'lashingiz mumkin?" : "Сколько вы готовы заплатить за новую камеру?";
    default:
      return isUz ? "So'rovnoma savoli" : "Вопрос анкеты";
  }
}

// So'rovnoma pauza qilingach, mijozga qayta yo'naltirilganda ishlatiladigan
// yumshoq qayta-so'rov matni (background task chaqiradi).
export function feedbackResumePrompt(
  stage: ClientData["feedbackStage"],
  language: ClientData["language"]
): string | null {
  if (!stage || stage === "done") return null;
  const isUz = language !== "ru";
  const prefix = isUz ? "Uzr, avvalgi savolimga qaytsak — " : "Извините, вернёмся к вопросу — ";
  return prefix + currentFeedbackQuestion(stage, language);
}

// Mijoz so'rovnoma javobini berayaptimi yoki boshqa narsa (savol/yordam/salom)
// so'rayaptimi — shuni aniqlab, to'g'ri handlerga yo'naltiradi.
async function routeDuringFeedback(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const question = currentFeedbackQuestion(client.feedbackStage, client.language);
  const kind = await classifySurveyReply(question, text);

  if (kind === "other") {
    // So'rovnomani PAUZA qilamiz (bosqich o'zgarmaydi), xabarni to'g'ri
    // handlerga yo'naltiramiz — mijozning haqiqiy so'rovi "yutilib" ketmasin.
    client.feedbackPausedAt = new Date().toISOString();
    clientsStore.save(client);
    logger.info({ chatId: client.chatId, stage: client.feedbackStage }, "so'rovnoma pauza qilindi (mijoz boshqa narsa so'radi)");
    await handleText(ctx, client, text, businessConnectionId);
    return;
  }

  await handleFeedback(ctx, client, text, businessConnectionId);
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

  // Mijoz haqiqiy so'rovnoma javobini berdi — pauza holatini tozalaymiz.
  client.feedbackPausedAt = undefined;

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

// ─── Kamera/quti bo'lmagan rasmlar (ilova skrinshoti, qo'llanma va h.k.) ──────

// Mijoz ko'pincha kamera/quti o'rniga ilova skrinshoti yoki qo'llanma
// varag'ini yuboradi — buni model-aniqlashga tiqishtirish behuda va
// chalkash javobga olib keladi. Shu holatda rasm mazmuniga qarab to'g'ridan
// to'g'ri savol-javob rejimiga o'tamiz.
async function handleNonCameraPhoto(
  ctx: BotContext,
  client: ClientData,
  classification: ImageClassification,
  caption: string | undefined,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;
  const cameraModel = client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined;
  const samples = samplesStore.getAll().map((s) => s.text);

  const question = caption
    ? `${caption}\n\n(Mijoz rasm ham yubordi: ${classification.description})`
    : `Mijoz rasm yubordi (kamera yoki uning qutisi emas): ${classification.description}`;

  await randomDelay(15000, 50000);

  const reply = await answerQuestion({
    question,
    language: client.language,
    cameraModel,
    connectionMethod: client.connectionMethod,
    refundRequested: client.refundRequested,
    firstName: client.firstName,
    shouldGreet: false,
    history: client.messageHistory || [],
    samples,
  });

  addToHistory(client, "user", question);
  addToHistory(client, "assistant", reply);
  client.hasGreeted = true;
  client.lastInteractionDate = todayStr();
  clientsStore.save(client);

  const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    await sendMsg(ctx, chatId, part, businessConnectionId);
    if (parts.length > 1) await sleep(800);
  }
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

  // Avval rasm turini aniqlaymiz — mijoz ko'pincha kamera/quti o'rniga
  // ilova skrinshoti yoki qo'llanma varag'i yuboradi. Bunday holda katta
  // (barcha modellar bo'yicha) model-aniqlash chaqiruvini umuman qilmaymiz —
  // bu ham xarajatni tejaydi, ham mijozga to'g'ri javob beradi.
  const classification = await classifyImage(clientImages[0]!);
  if (classification.kind !== "camera_or_box") {
    await handleNonCameraPhoto(ctx, client, classification, caption, businessConnectionId);
    return;
  }

  // Barcode raqamini AVTOMATIK o'qishga harakat qilamiz — avval QR kod
  // (eng ishonchli, AI chaqirmaydi), keyin AI-OCR fallback. QR raqami bazaga
  // mos kelmasa, to'xtamay bosma raqamni OCR bilan o'qishga o'tadi. Mijozdan
  // hech qachon raqamni qo'lda yozib yuborish so'ralmaydi.
  await randomDelay(15000, 40000);

  const outcome = await readBarcodeFromImage(clientImages[0]!, chatId, (digits, isPartial) =>
    !!findModelByDigits(models, digits, isPartial)
  );
  client = clientsStore.getById(client.chatId) ?? client;

  if (outcome.match) {
    const matchedModel = findModelByDigits(models, outcome.match.value, outcome.match.isPartial);
    if (matchedModel) {
      client.lastModelName = matchedModel.name;
      client.hasGreeted = true;
      client.lastInteractionDate = todayStr();
      client.barcodeAttempts = 0;
      clientsStore.save(client);
      modelMentionsStore.record(matchedModel.name, client.chatId);
      await askConnectionMethodOrDeliver(ctx, client, businessConnectionId);
      return;
    }
  }

  // Mos model topilmadi. Agar TO'LIQ raqam o'qilgan bo'lsa (QR yoki OCR) —
  // bu haqiqiy, lekin ro'yxatda yo'q barcode: adminni xabardor qilamiz va
  // mijozga umumiy yordam beramiz. Rasmni QAYTA SO'RAMAYMIZ (bir marta yordam).
  if (outcome.bestRead && onlyDigits(outcome.bestRead.value).length >= 8) {
    client.barcodeAttempts = 0;
    clientsStore.save(client);
    await handleUnknownBarcode(ctx, client, outcome.bestRead.value, businessConnectionId);
    return;
  }

  // Hech qanday ishonchli raqam o'qilmadi — yaqinroq rasm / model nomi zinapoyasi.
  client.barcodeAttempts = (client.barcodeAttempts ?? 0) + 1;
  clientsStore.save(client);

  if (client.barcodeAttempts <= 2) {
    // QADAM 4 — yaqinroq rasm so'raymiz (namuna rasm bilan birga, mavjud bo'lsa).
    await sendCloserPhotoRequest(ctx, client, businessConnectionId);
  } else {
    // QADAM 5 — ikki marta rasm ham yordam bermadi, oxirgi chora sifatida
    // model nomini matn bilan so'raymiz.
    client.awaitingModelName = true;
    clientsStore.save(client);
    await sendMsg(ctx, chatId, askForModelNameText(client.language), businessConnectionId, { allowRepeat: true });
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
