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
  classifyLongRangeAnswer,
  answerLongRangeStep,
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
  from: { id: number; first_name?: string; username?: string },
  chatId: string,
  businessConnectionId?: string
): Promise<void> {
  if (isAdmin(from.id)) return;

  const firstName = from.first_name || undefined;
  const username = from.username || undefined;
  const msgId = (msg.message_id as number) || 0;
  const client = getOrCreateClient(chatId, firstName);

  // Dublikat tekshirish
  if (client.lastProcessedMessageId === msgId) return;
  client.lastProcessedMessageId = msgId;
  client.lastSeen = new Date().toISOString();
  if (businessConnectionId) client.businessConnectionId = businessConnectionId;
  if (firstName && !client.firstName) client.firstName = firstName;
  if (username) client.username = username;

  clientsStore.save(client);
  activityStore.record(chatId);

  // Mijoz yangi xabar yozdi — dedup oynasini tozalaymiz, aks holda oldingi
  // javob bilan bir xil matn bloklanib, mijoz javobsiz qolishi mumkin edi.
  clearDedupForChat(chatId);

  // To'liq iz (trace) — jim qolish sabablarini keyinchalik topish uchun.
  const msgType = msg.voice ? "voice" : msg.photo ? "photo" : msg.text ? "text" : "other";
  const textPreview = typeof msg.text === "string" ? (msg.text as string).slice(0, 80) : undefined;
  logger.info(
    {
      chatId,
      type: msgType,
      text: textPreview,
      feedbackStage: client.feedbackStage ?? null,
      awaitingConnectionMethod: !!client.awaitingConnectionMethod,
      awaitingModelName: !!client.awaitingModelName,
      lastModelName: client.lastModelName ?? null,
    },
    "mijoz xabari keldi"
  );

  // Tur bo'yicha yo'naltirish
  if (msg.voice) {
    await handleVoice(ctx, client, businessConnectionId);
    return;
  }
  if (msg.photo) {
    const photos = msg.photo as Array<{ file_id: string }>;
    const caption = typeof msg.caption === "string" ? msg.caption : undefined;
    // Rasm kelgan vaqtni belgilaymiz — matn oqimi "rasm yuboring" deb
    // so'ramasligi uchun (poyga holati: matn va rasm oqimlari bir-birini bilmaydi).
    lastPhotoAtMap.set(chatId, Date.now());
    bufferPhoto(ctx, chatId, photos[photos.length - 1].file_id, businessConnectionId, caption);
    return;
  }
  if (msg.text) {
    const text = msg.text as string;
    // Matn xabarlarini qisqa bufer bilan yig'amiz — mijoz ketma-ket bir necha
    // qisqa xabar yozsa (masalan "yoq", "bowidan", "boshidan"), ularni
    // BIRLASHTIRIB bitta kontekst sifatida ishlaymiz va BITTA javob beramiz.
    // Yo'naltirish (routeText) bufer to'lgach, ENG YANGI holat bilan bajariladi.
    bufferText(ctx, chatId, text, businessConnectionId);
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

// Mijoz oxirgi marta qachon rasm yuborgani (poyga holatini oldini olish uchun).
const lastPhotoAtMap = new Map<string, number>();

// Mijozdan rasm so'rash o'rinlimi — agar u hozirgina rasm yuborgan bo'lsa
// (oxirgi 60 soniyada) yoki rasm hozir buferda/navbatda ishlanayotgan bo'lsa,
// "rasm yuboring" deb so'ramaymiz (absurd bo'lardi).
function shouldAskForPhoto(chatId: string): boolean {
  if (photoBuffers.has(chatId)) return false;
  const last = lastPhotoAtMap.get(chatId);
  if (last && Date.now() - last < 60_000) return false;
  return true;
}

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
  // guardReply mijoz rasmga ham javobsiz qolmasligini kafolatlaydi.
  runSerialized(chatId, async () => {
    const client = clientsStore.getById(chatId);
    if (!client) return;
    await guardReply(buf.ctx, client, buf.businessConnectionId, "handlePhotos", buf.caption ?? "(rasm)", () =>
      handlePhotos(buf.ctx, client, buf.fileIds, buf.businessConnectionId, buf.caption)
    );
  });
}

// ─── Matn bufferi (ketma-ket kelgan qisqa xabarlar) ───────────────────────────

const TEXT_DEBOUNCE_MS = 6000;

interface TextBuffer {
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
  ctx: BotContext;
  businessConnectionId?: string;
}

const textBuffers = new Map<string, TextBuffer>();

function bufferText(
  ctx: BotContext,
  chatId: string,
  text: string,
  businessConnectionId?: string
): void {
  const existing = textBuffers.get(chatId);
  if (existing) {
    existing.texts.push(text);
    existing.ctx = ctx;
    if (businessConnectionId) existing.businessConnectionId = businessConnectionId;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flushText(chatId), TEXT_DEBOUNCE_MS);
  } else {
    textBuffers.set(chatId, {
      texts: [text],
      ctx,
      businessConnectionId,
      timer: setTimeout(() => void flushText(chatId), TEXT_DEBOUNCE_MS),
    });
  }
}

async function flushText(chatId: string): Promise<void> {
  const buf = textBuffers.get(chatId);
  if (!buf) return;
  textBuffers.delete(chatId);
  const combined = buf.texts.join("\n").trim();
  if (!combined) return;

  runSerialized(chatId, async () => {
    const client = clientsStore.getById(chatId);
    if (!client) return;
    await routeText(buf.ctx, client, combined, buf.businessConnectionId);
  });
}

// Bufer to'lgach chaqiriladi — ENG YANGI mijoz holati asosida to'g'ri handlerni
// tanlaydi. USTUVORLIK: mijozning JORIY ehtiyoji har doim so'rovnomadan ustun.
async function routeText(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;

  // 1) Faqat raqamdan iborat (uzun) matn — barcode.
  if (isLikelyBarcodeText(text, client.feedbackStage)) {
    await guardReply(ctx, client, businessConnectionId, "handleTypedBarcode", text, () =>
      handleTypedBarcode(ctx, client, text, businessConnectionId)
    );
    return;
  }
  // 2) Ulanish usuli (qisqa/uzoq) kutilyapti.
  if (client.awaitingConnectionMethod) {
    await guardReply(ctx, client, businessConnectionId, "handleConnectionMethodAnswer", text, () =>
      handleConnectionMethodAnswer(ctx, client, text, businessConnectionId)
    );
    return;
  }
  // 3) Uzoq masofa yo'riqnomasi davom etyapti (holat mashinasi).
  if (client.longRangeStage) {
    await guardReply(ctx, client, businessConnectionId, "handleLongRange", text, () =>
      handleLongRange(ctx, client, text, businessConnectionId)
    );
    return;
  }
  // 4) Model nomi kutilyapti.
  if (client.awaitingModelName) {
    await guardReply(ctx, client, businessConnectionId, "handleModelNameAnswer", text, () =>
      handleModelNameAnswer(ctx, client, text, businessConnectionId)
    );
    return;
  }
  // 5) So'rovnoma davom etyaptimi? (eng past ustuvorlik)
  if (client.feedbackStage && client.feedbackStage !== "done") {
    await guardReply(ctx, client, businessConnectionId, "routeDuringFeedback", text, () =>
      routeDuringFeedback(ctx, client, text, businessConnectionId)
    );
    return;
  }
  // 6) Oddiy suhbat.
  await guardReply(ctx, client, businessConnectionId, "handleText", text, () =>
    handleText(ctx, client, text, businessConnectionId)
  );
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

// Mijoz YANGI xabar yozganda dedup oynasini tozalaymiz — "mijoz yozdi = yangi
// javob kerak". Dedup faqat BITTA mijoz kirishiga bir nechta oqim bir xil
// javobni yuborishini to'sish uchun; u mijozning yangi savoliga javobni
// bloklamasligi kerak.
function clearDedupForChat(chatId: string): void {
  const prefix = `${chatId}|`;
  for (const k of recentSends.keys()) {
    if (k.startsWith(prefix)) recentSends.delete(k);
  }
}

// Har bir mijozga HAQIQATAN yuborilgan xabarni sanaymiz (dedup tomonidan
// bloklangani sanalmaydi). guardReply shu hisob orqali "handler mijozga hech
// narsa yubormadimi" degan holatni aniqlaydi va majburiy fallback beradi.
const sendCounts = new Map<string, number>();
function noteSent(chatId: string): void {
  sendCounts.set(chatId, (sendCounts.get(chatId) ?? 0) + 1);
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
  noteSent(chatId);
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
    await sendMsg(ctx, client.chatId, msg, businessConnectionId, { allowRepeat: true });
  } catch {
    // fallback ham yuborilmasa, qila oladigan narsa yo'q
  }
}

// MUTLAQ QOIDA: bot HECH QACHON mijoz xabariga javobsiz qolmasin. Handler
// biror sababga ko'ra mijozga hech narsa yubormasa — bu yerda majburiy javob
// beramiz (avval AI orqali, u ham bo'lmasa statik xabar).
async function sendGuaranteedFallback(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  // Ketma-ket bir necha marta tushunolmagan bo'lsak — bir xil "tushunmadim"
  // ni takrorlamaymiz, mijozni operatorga yo'naltiramiz (admin allaqachon
  // xabardor qilingan).
  if ((client.unresolvedCount ?? 0) >= 2) {
    const msg = client.language !== "ru"
      ? "Kechirasiz, buni to'g'ri hal qilishim uchun hamkasbim tez orada siz bilan bog'lanadi. Biroz kuting, iltimos."
      : "Извините, чтобы решить это правильно, с вами скоро свяжется наш сотрудник. Немного подождите.";
    await sendMsg(ctx, client.chatId, msg, businessConnectionId, { allowRepeat: true });
    return;
  }
  try {
    const samples = samplesStore.getAll().map((s) => s.text);
    const reply = await answerQuestion({
      question: text || "Salom",
      language: client.language,
      cameraModel: client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined,
      connectionMethod: client.connectionMethod,
      refundRequested: client.refundRequested,
      firstName: client.firstName,
      shouldGreet: false,
      history: client.messageHistory || [],
      samples,
      rephraseHint: (client.unresolvedCount ?? 0) >= 1,
    });
    const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      addToHistory(client, "user", text);
      addToHistory(client, "assistant", reply);
      client.hasGreeted = true;
      client.lastInteractionDate = todayStr();
      clientsStore.save(client);
      for (const part of parts) {
        await sendMsg(ctx, client.chatId, part, businessConnectionId, { allowRepeat: true });
        if (parts.length > 1) await sleep(800);
      }
      return;
    }
  } catch (err) {
    logger.error({ err, chatId: client.chatId }, "sendGuaranteedFallback: AI javob bermadi");
  }
  const msg = client.language !== "ru"
    ? "Kechirasiz, savolingizni to'liq tushunmadim. Muammoni biroz batafsilroq yozib bera olasizmi?"
    : "Извините, я не совсем понял. Опишите, пожалуйста, проблему подробнее.";
  await sendMsg(ctx, client.chatId, msg, businessConnectionId, { allowRepeat: true });
}

// Har bir mijoz xabari uchun handlerni o'rab ishlatadi: xatoni ushlaydi,
// handler tugagach mijozga BIRORTA ham xabar yuborilmaganini tekshiradi va
// bunday holatni ERROR sifatida loglab, majburiy fallback yuboradi. Shunday
// qilib mijoz hech qachon javobsiz qolmaydi (P1 kafolati).
async function guardReply(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId: string | undefined,
  label: string,
  text: string,
  fn: () => Promise<void>
): Promise<void> {
  const chatId = client.chatId;
  const before = sendCounts.get(chatId) ?? 0;
  try {
    await fn();
  } catch (err) {
    logger.error({ err, chatId, label }, `${label}: xatolik`);
    await sendFallbackError(ctx, client, businessConnectionId);
    return;
  }
  const after = sendCounts.get(chatId) ?? 0;
  if (after === before) {
    // Handler mijozga hech narsa yubormadi — bu jiddiy holat.
    const fresh = clientsStore.getById(chatId) ?? client;
    fresh.unresolvedCount = (fresh.unresolvedCount ?? 0) + 1;
    clientsStore.save(fresh);
    logger.error(
      { chatId, label, text, unresolvedCount: fresh.unresolvedCount },
      `${label}: mijozga HECH NARSA yuborilmadi — majburiy fallback`
    );
    if (fresh.unresolvedCount >= 2) {
      await notifyAdminsClientStuck(ctx, fresh, `Bot ketma-ket javob berolmayapti (${label}).`);
    }
    await sendGuaranteedFallback(ctx, fresh, text, businessConnectionId);
  } else {
    logger.info({ chatId, label }, `${label}: javob yuborildi`);
    // Bot mijozga BIRINCHI marta biror narsa yubordi — qaysi oqim orqali
    // bo'lishidan qat'i nazar (matn, rasm, barcode, video) hasGreeted=true
    // qilamiz. Aks holda salomlashish keyinroq, suhbat o'rtasida noo'rin
    // ishga tushardi (XATO 4).
    if (!client.hasGreeted) {
      const fresh = clientsStore.getById(chatId);
      if (fresh && !fresh.hasGreeted) {
        fresh.hasGreeted = true;
        clientsStore.save(fresh);
      }
    }
    // Eslatma: tiqilish hisoblagichini (unresolvedCount) BU YERDA tozalamaymiz —
    // "tushunmadim, qayta so'rayman" kabi yumshoq-nosozlik ham xabar yuboradi,
    // shuning uchun har qanday yuborishni "muvaffaqiyat" deb hisoblab bo'lmaydi.
    // Hisoblagich HAQIQIY yordam berilgan joylarda aniq tozalanadi
    // (resetStuck): handleText javobi, uzoq masofa qadami, model aniqlanishi.
  }
}

// Haqiqiy yordam berilganda tiqilish hisoblagichini tozalaydi.
function resetStuck(client: ClientData): void {
  if (client.unresolvedCount || client.stuckAdminNotified) {
    client.unresolvedCount = 0;
    client.stuckAdminNotified = false;
  }
}

// ─── Adminni tiqilib qolgan mijoz haqida ogohlantirish ────────────────────────

// Bot mijozga yordam berolmay qolganda adminlarga darhol xabar yuboradi —
// mijoz ismi, chatId va oxirgi 5 xabar bilan, admin darhol aralasha olsin.
// Bir mijoz uchun bir tiqilishda faqat bir marta (stuckAdminNotified) yuboramiz.
async function notifyAdminsClientStuck(
  ctx: BotContext,
  client: ClientData,
  reason: string
): Promise<void> {
  if (client.stuckAdminNotified) return;
  client.stuckAdminNotified = true;
  clientsStore.save(client);

  const last5 = (client.messageHistory || [])
    .slice(-5)
    .map((m) => `${m.role === "user" ? "Mijoz" : "Bot"}: ${m.content}`)
    .join("\n");

  const text =
    `⚠️ Mijozga yordam kerak — bot tiqilib qoldi.\n` +
    `Sabab: ${reason}\n` +
    `Mijoz: ${client.firstName ?? "(ism yo'q)"}\n` +
    `chatId: ${client.chatId}\n` +
    `Model: ${client.lastModelName ?? "(noma'lum)"}\n\n` +
    `Oxirgi xabarlar:\n${last5 || "(yo'q)"}`;

  for (const adminId of getAdminIds()) {
    try {
      await ctx.telegram.sendMessage(adminId, text);
    } catch {
      // ignore
    }
  }
}

// Mijoz javobini split qilib yuboradi; bo'sh bo'lsa hech narsa qilmaydi
// (chaqiruvchi guardReply orqali kafolatlanadi). Yuborilgan matn tarixga
// yoziladi.
async function sendReplyParts(
  ctx: BotContext,
  client: ClientData,
  reply: string,
  businessConnectionId?: string
): Promise<boolean> {
  const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    await sendMsg(ctx, client.chatId, part, businessConnectionId);
    if (parts.length > 1) await sleep(800);
  }
  return true;
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
  noteSent(chatId);
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
  noteSent(chatId);
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
  noteSent(chatId);
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

    // Video yuborilgach DARHOL "ishladimi?" deb so'ramaymiz — mijoz videoni
    // ochib ham ulgurmaydi. Bot jim turadi; kechiktirilgan follow-up
    // (tasks.ts → checkConnectionFollowups) 30 daqiqadan keyin, faqat mijoz
    // o'zi yozmagan bo'lsa, so'raydi.
    addToHistory(client, "assistant", firstCaption);
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

// Uzoq masofa — video yo'q, bosqichma-bosqich matnli yordam. Bu yerda holat
// (longRangeStage) O'RNATILADI — aks holda mijozning javobi umumiy handleText'ga
// tushib, noto'g'ri tushunilardi (aynan shu bug mijozni yo'qotgan edi).
async function sendLongRangeIntro(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  const isUz = client.language !== "ru";

  // Bilim bazasi bo'sh bo'lsa — adminni darhol ogohlantiramiz (bot umumiy
  // bilim bilan yordam berishga urinadi, lekin admin aniq yo'riqnoma qo'shsin).
  const model = client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined;
  const guideEmpty = !model || model.longRangeGuides.length === 0;
  if (guideEmpty) {
    await notifyAdminsClientStuck(
      ctx,
      client,
      `"${client.lastModelName ?? "?"}" uchun UZOQ MASOFA yo'riqnomasi (longRangeGuides) BO'SH. Mijoz uzoq masofa yordam so'rayapti.`
    );
  }

  const msg = isUz
    ? "Uzoq masofadan ulashda yordam beraman. Aytingchi — kamerangiz telefon ilovasiga allaqachon qo'shilganmi, yoki boshidan boshlab qo'shamizmi?"
    : "Помогу подключить на дальнем расстоянии. Скажите — камера уже добавлена в приложение, или добавим с начала?";
  client.longRangeStage = "asked_status";
  await sendMsg(ctx, client.chatId, msg, businessConnectionId, { allowRepeat: true });
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
    // MUTLAQ QOIDA: uzoq masofa allaqachon boshlangan bo'lsa (asked_status yoki
    // guiding), INTRO ni QAYTA yubormaymiz — progressni yo'qotib, mijozni
    // boshiga qaytarardi. Buni yuqoridagi routeText ham oldini oladi, lekin bu
    // yerda ham himoya qo'yamiz.
    if (client.longRangeStage === "guiding") {
      await runLongRangeGuiding(ctx, client, "davom etamiz", false, businessConnectionId);
    } else if (client.longRangeStage === "asked_status") {
      // Savol allaqachon berilgan — qayta so'ramaymiz.
      return;
    } else {
      await sendLongRangeIntro(ctx, client, businessConnectionId);
    }
  }
}

// ─── Uzoq masofa holat mashinasi ──────────────────────────────────────────────

// Mijoz muvaffaqiyat/minnatdorchilik bildirsa — uzoq masofani yakunlaymiz.
// (qisqartma o'zbekchani ham hisobga olamiz)
const LONG_RANGE_SUCCESS_RE =
  /(rahmat|raxmat|rahmet|tashakkur|bo'?ldi\b|buldi\b|ishladi|iwladi|zo'?r\b|zur\b|ulandi|ko'?rinyapti|korinyapti|korindi|hammasi joyida)/i;

async function handleLongRange(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  if (client.longRangeStage === "asked_status") {
    await handleLongRangeAnswer(ctx, client, text, businessConnectionId);
  } else {
    await handleLongRangeGuiding(ctx, client, text, businessConnectionId);
  }
}

// "asked_status" — "ilovada qo'shilganmi/boshidanmi?" javobini SO'RALGAN SAVOL
// kontekstida tushunamiz (umumiy detectIntent EMAS).
async function handleLongRangeAnswer(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const kind = await classifyLongRangeAnswer(text);
  logger.info({ chatId: client.chatId, kind, text }, "long-range: asked_status javobi");

  if (kind === "unclear") {
    client.unresolvedCount = (client.unresolvedCount ?? 0) + 1;
    clientsStore.save(client);

    // Ikki marta so'rab ham aniq bo'lmasa — LOOP qilmaymiz: adminni
    // ogohlantirib, boshidan boshlash bilan bosqichma-bosqich davom etamiz
    // (AI baribir yordam beradi).
    if (client.unresolvedCount >= 2) {
      await notifyAdminsClientStuck(ctx, client, "Uzoq masofa: mijoz 'ilovada qo'shilganmi?' savoliga aniq javob bermadi — boshidan davom etyapmiz.");
      client.longRangeStage = "guiding";
      client.unresolvedCount = 0;
      clientsStore.save(client);
      addToHistory(client, "user", text);
      await runLongRangeGuiding(ctx, client, text, true, businessConnectionId);
      return;
    }

    // Savolni SODDALASHTIRIB qayta beramiz (bir xil matnni takrorlamaymiz).
    const q = client.language !== "ru"
      ? "Sodda qilib so'rayman — ilovaga kamerani qo'shib bo'lganmisiz? \"Ha\" yoki \"yo'q\" deb yozing."
      : "Спрошу проще — вы уже добавили камеру в приложение? Напишите \"да\" или \"нет\".";
    addToHistory(client, "user", text);
    addToHistory(client, "assistant", q);
    clientsStore.save(client);
    await sendMsg(ctx, client.chatId, q, businessConnectionId, { allowRepeat: true });
    return;
  }

  // Aniq javob keldi — guiding rejimiga o'tamiz va birinchi qadamni beramiz.
  client.longRangeStage = "guiding";
  client.unresolvedCount = 0;
  client.stuckAdminNotified = false;
  clientsStore.save(client);
  addToHistory(client, "user", text);
  await runLongRangeGuiding(ctx, client, text, kind === "start_over", businessConnectionId);
}

// "guiding" — bosqichma-bosqich yordam.
async function handleLongRangeGuiding(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  // Mijoz ishlaganini/rahmat aytsa — yakunlaymiz.
  if (LONG_RANGE_SUCCESS_RE.test(text)) {
    addToHistory(client, "user", text);
    await finishLongRange(ctx, client, businessConnectionId);
    return;
  }
  addToHistory(client, "user", text);
  await runLongRangeGuiding(ctx, client, text, false, businessConnectionId);
}

async function runLongRangeGuiding(
  ctx: BotContext,
  client: ClientData,
  text: string,
  fromStart: boolean,
  businessConnectionId?: string
): Promise<void> {
  const model = client.lastModelName ? modelsStore.getByName(client.lastModelName) : undefined;
  const guide = model
    ? model.longRangeGuides.map((g) => g.text).filter((t) => t.trim()).join("\n\n")
    : "";

  const reply = await answerLongRangeStep({
    question: text,
    language: client.language,
    modelName: client.lastModelName ?? "",
    longRangeGuide: guide,
    history: client.messageHistory || [],
    fromStart,
  });

  const sent = await sendReplyParts(ctx, client, reply, businessConnectionId);
  if (sent) {
    addToHistory(client, "assistant", reply);
    client.hasGreeted = true;
    client.lastInteractionDate = todayStr();
    client.unresolvedCount = 0;
    clientsStore.save(client);
    return;
  }

  // AI hech narsa qaytarmadi — tiqilish. Adminni ogohlantiramiz, mijozni
  // HALOL xabardor qilamiz (bir xil "tushunmadim" ni takrorlamaymiz).
  client.unresolvedCount = (client.unresolvedCount ?? 0) + 1;
  clientsStore.save(client);
  await notifyAdminsClientStuck(ctx, client, "Uzoq masofa: bot javob berolmadi (bilim bazasi bo'sh bo'lishi mumkin).");
  const msg = client.language !== "ru"
    ? "Bir daqiqa, shu bo'yicha aniq yo'riqnomani tayyorlab, tez orada yuboraman."
    : "Одну минуту, подготовлю точную инструкцию и скоро пришлю.";
  await sendMsg(ctx, client.chatId, msg, businessConnectionId, { allowRepeat: true });
}

async function finishLongRange(
  ctx: BotContext,
  client: ClientData,
  businessConnectionId?: string
): Promise<void> {
  client.longRangeStage = undefined;
  client.awaitingConnectionConfirm = false;
  client.connectionConfirmed = true;
  client.gratitudeSent = true;
  client.unresolvedCount = 0;
  client.stuckAdminNotified = false;
  clientsStore.save(client);

  const msg = client.language !== "ru"
    ? "Zo'r! Endi kamerangizni istalgan joydan ko'ra olasiz. Yana savol bo'lsa, bemalol yozing."
    : "Отлично! Теперь вы можете смотреть камеру откуда угодно. Будут вопросы — пишите.";
  await sendMsg(ctx, client.chatId, msg, businessConnectionId, { allowRepeat: true });
  addToHistory(client, "assistant", msg);
  clientsStore.save(client);

  if (!client.refundRequested) await sendReview(ctx, client, businessConnectionId);
}

// Model aniqlanganda mijozga tabiiy tarzda aytamiz — mijoz bot uni tanidimi
// yo'qmi bilmay qolmasin.
async function announceModel(
  ctx: BotContext,
  client: ClientData,
  modelName: string,
  businessConnectionId?: string
): Promise<void> {
  const msg = client.language !== "ru"
    ? `Rasmga qarab aniqladim — sizda ${modelName} kamerasi ekan.`
    : `По фото определил — у вас камера ${modelName}.`;
  await sendMsg(ctx, client.chatId, msg, businessConnectionId, { allowRepeat: true });
  addToHistory(client, "assistant", msg);
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
    client.connectionMethodAsks = 1;
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
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const chatId = client.chatId;

  // Uzoq masofa allaqachon boshlangan bo'lsa — INTRO ni qayta yubormaymiz,
  // holat mashinasida davom etamiz (progress yo'qolmasin).
  if (client.longRangeStage) {
    await handleLongRange(ctx, client, text, businessConnectionId);
    return;
  }

  if (!client.connectionMethod) {
    const asks = client.connectionMethodAsks ?? 0;
    // Ikki martadan ko'p so'ramaymiz — aks holda mijoz aniq javob bermasa
    // sikl bo'lardi. Chegaradan keyin savolni tashlab, umumiy yordam beramiz.
    if (asks >= 2) {
      client.awaitingConnectionMethod = false;
      clientsStore.save(client);
      const fallback = client.language !== "ru"
        ? "Mayli, keling boshqacha yordam beraman — kamerangizda hozir aniq nima muammo bor yoki nima qilmoqchisiz, shuni yozing."
        : "Хорошо, помогу иначе — напишите, что именно не так с камерой или что вы хотите сделать.";
      await sendMsg(ctx, chatId, fallback, businessConnectionId);
      return;
    }
    client.awaitingConnectionMethod = true;
    client.connectionMethodAsks = asks + 1;
    clientsStore.save(client);
    await sendMsg(ctx, chatId, connectionMethodQuestion(client.language), businessConnectionId, { allowRepeat: true });
    return;
  }

  if (!client.lastModelName) {
    if (!client.askedForPhotoOnce && shouldAskForPhoto(chatId)) {
      client.askedForPhotoOnce = true;
      clientsStore.save(client);
      await sendMsg(ctx, chatId, askForCameraPhotoText(client.language), businessConnectionId);
    }
    return;
  }

  await deliverConnectionGuide(ctx, client, businessConnectionId);
}

// "awaitingConnectionMethod" holatida kelgan javobni tekshiradi. MUHIM:
// mijoz ko'pincha bu savolga javob bermay, o'z muammosini aytadi ("kamera
// o'chib qolayapti", "tasvir xira" va h.k.) — bunday holda savolni QAYTA
// SO'RAMASDAN, muammoga javob beramiz. Savol maksimum 2 marta so'raladi.
const NO_PREFERENCE_RE = /(farqi yo'?q|farqi yoq|baribir|farqsiz|bari bir|без разниц|всё равно|все равно|любой|неважно|не важно)/i;

async function handleConnectionMethodAnswer(
  ctx: BotContext,
  client: ClientData,
  text: string,
  businessConnectionId?: string
): Promise<void> {
  const { connectionMethod, intent, productFeedback } = await detectIntent(text);

  // Mijoz "menga farqi yo'q / без разницы" desa — savolni takrorlamay, standart
  // variantni (uzoq masofa — eng ko'p so'raladigan) tanlab davom etamiz.
  const effectiveMethod = connectionMethod ?? (NO_PREFERENCE_RE.test(text) ? "long" : null);

  // Mijoz aniq qisqa/uzoq javob berdi → davom etamiz.
  if (effectiveMethod) {
    client.connectionMethod = effectiveMethod;
    client.awaitingConnectionMethod = false;
    client.connectionMethodAsks = 0;
    resetStuck(client);
    clientsStore.save(client);

    if (!client.lastModelName) {
      if (!client.askedForPhotoOnce && shouldAskForPhoto(client.chatId)) {
        client.askedForPhotoOnce = true;
        clientsStore.save(client);
        await sendMsg(ctx, client.chatId, askForCameraPhotoText(client.language), businessConnectionId);
      }
      return;
    }

    await deliverConnectionGuide(ctx, client, businessConnectionId);
    return;
  }

  // Javob emas. Agar mijoz JIDDIY narsa aytayotgan bo'lsa (muammo, shikoyat,
  // savol, yordam so'rovi — ya'ni salomdan boshqa har qanday narsa yoki
  // mahsulot haqida fikr) — ulanish savolini TASHLAB, muammoga javob beramiz.
  const isSubstantive = intent !== "greeting" || !!productFeedback;
  if (isSubstantive) {
    client.awaitingConnectionMethod = false;
    // Muammo/savol bo'lsa hisoblagichni nolga qaytaramiz; lekin mijoz yana
    // "ulashga yordam ber" desa (connect_camera) — hisoblagichni saqlaymiz,
    // aks holda savol qayta-qayta so'ralib sikl bo'lishi mumkin.
    if (intent !== "connect_camera") client.connectionMethodAsks = 0;
    clientsStore.save(client);
    await handleText(ctx, client, text, businessConnectionId);
    return;
  }

  // Salom yoki noaniq qisqa narsa — ulanish savolini yana bir marta so'raymiz,
  // lekin JAMI 2 martadan oshirmaymiz. Chegaradan keyin savolni butunlay
  // tashlab, oddiy yordamga o'tamiz — mijoz cheksiz siklda qolmaydi.
  const asks = (client.connectionMethodAsks ?? 1) + 1;
  if (asks > 2) {
    client.awaitingConnectionMethod = false;
    client.connectionMethodAsks = 0;
    clientsStore.save(client);
    await handleText(ctx, client, text, businessConnectionId);
    return;
  }
  client.connectionMethodAsks = asks;
  clientsStore.save(client);
  await sendMsg(ctx, client.chatId, connectionMethodQuestion(client.language), businessConnectionId, { allowRepeat: true });
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
    // Oxirgi 4 raqam bo'yicha qidiruv — agar BIR NECHTA model mos kelsa,
    // bittasini tanlash noto'g'ri bo'lishi mumkin. Bunday holda "unclear"
    // (undefined) qaytaramiz — chaqiruvchi aniqroq rasm so'raydi.
    const matches = models.filter((m) => m.barcodes.some((b) => onlyDigits(b).slice(-4) === d));
    return matches.length === 1 ? matches[0] : undefined;
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
    resetStuck(client);
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
    resetStuck(client);
    clientsStore.save(client);
    modelMentionsStore.record(matched.name, client.chatId);
    await announceModel(ctx, client, matched.name, businessConnectionId);
    await sleep(800);
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
      resetStuck(client);
      clientsStore.save(client);
      modelMentionsStore.record(matchedModel.name, client.chatId);
      await announceModel(ctx, client, matchedModel.name, businessConnectionId);
      await sleep(800);
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
  logger.info(
    { chatId, intent, connectionMethod: connectionMethod ?? null, productFeedback: productFeedback ?? null },
    "handleText: detectIntent natijasi"
  );

  // Mijoz ulanish usulini aytdi/O'ZGARTIRDI (masalan qisqa → uzoq). Modeli
  // aniq bo'lsa — darhol TO'G'RI qo'llanmani yuboramiz (eski qo'llanmani
  // qayta yubormaymiz).
  if (connectionMethod) {
    const changed = client.connectionMethod !== connectionMethod;
    client.connectionMethod = connectionMethod;
    clientsStore.save(client);
    if (client.lastModelName && (changed || intent === "connect_camera")) {
      addToHistory(client, "user", text);
      client.hasGreeted = true;
      client.lastInteractionDate = todayStr();
      clientsStore.save(client);
      logger.info({ chatId, connectionMethod, model: client.lastModelName }, "handleText: ulanish usuli bo'yicha qo'llanma yuborilmoqda");
      await deliverConnectionGuide(ctx, client, businessConnectionId);
      return;
    }
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
      resetStuck(client);
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
      resetStuck(client);
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
    await handleConnectCameraRequest(ctx, client, text, businessConnectionId);
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
  resetStuck(client);
  clientsStore.save(client);

  const parts = reply.split("###").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    await sendMsg(ctx, chatId, part, businessConnectionId);
    if (parts.length > 1) await sleep(800);
  }

  if (!cameraModel && !client.askedForPhotoOnce && shouldAskForPhoto(chatId)) {
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
