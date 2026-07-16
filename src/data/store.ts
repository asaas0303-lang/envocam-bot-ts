import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Railway'da volume ulanganda bu papka doimiy diskka ishora qiladi;
// bo'lmasa (masalan lokal ishga tushirishda) loyiha papkasiga yoziladi.
// Boshqa modullar ham (masalan collage.ts) shu doimiy papkadan foydalanishi
// uchun eksport qilingan.
export const DATA_DIR = process.env["RAILWAY_VOLUME_MOUNT_PATH"] || path.join(__dirname, "..", "..");
const DATA_FILE = path.join(DATA_DIR, "data.json");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export interface ImageItem {
  file_id: string;
  caption?: string;
}

export interface ManualImageItem extends ImageItem {
  extractedText?: string;
}

export interface TextGuideItem {
  text: string;
}

export interface RefCollageMeta {
  path: string;        // DATA_DIR ga nisbatan fayl yo'li
  sourceHash: string;  // qaysi rasmlardan yasalganini aniqlaydi (kesh bekor qilish uchun)
  generatedAt: string;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

export interface CameraModel {
  name: string;
  images: ImageItem[];
  appScreenshots: ManualImageItem[];
  videoGuides: ImageItem[];        // Qisqa masofa — kamera WiFi'siga to'g'ridan-to'g'ri ulanish
  longRangeGuides: TextGuideItem[]; // Uzoq masofa — uy routeri orqali ulanish, matnli yo'riqnoma
  reviewVoiceFileId?: string;
  reviewVideoFileId?: string;
  refCollage?: RefCollageMeta;      // "Rasmlar" kategoriyasidan yasalgan taqqoslash kollaji (keshlangan)
  barcodes: string[];               // Quti stikeridagi barcode raqam(lar)i — modelni ANIQ aniqlaydigan yagona belgi
  faqItems: FaqItem[];              // Shu modelga xos savol-javoblar (FAQ) — AI bilim bazasiga qo'shiladi
}

// O'zbekistonning 14 hududi: 12 viloyat + Toshkent shahri (alohida) + Qoraqalpog'iston Respublikasi
export const REGIONS = [
  "Andijon",
  "Buxoro",
  "Farg'ona",
  "Jizzax",
  "Namangan",
  "Navoiy",
  "Qashqadaryo",
  "Qoraqalpog'iston Respublikasi",
  "Samarqand",
  "Sirdaryo",
  "Surxondaryo",
  "Xorazm",
  "Toshkent shahri",
  "Toshkent viloyati",
] as const;
export type Region = (typeof REGIONS)[number];

export interface IssueMention {
  chatId: string;
  modelName?: string;
  timestamp: string;
}

export interface IssueCategory {
  id: string;
  label: string;
  createdAt: string;
  mentions: IssueMention[];
}

export interface ModelMention {
  modelName: string;
  chatId: string;
  timestamp: string;
}

export interface RefundEvent {
  chatId: string;
  modelName?: string;
  timestamp: string;
}

export interface ActivityEvent {
  chatId: string;
  timestamp: string;
}

export interface MessageRecord {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ClientFeedback {
  collectedAt: string;
  satisfaction?: string;
  wishlist?: string;
  location?: string;
  purpose?: string;
  budget?: string;
}

export type FeedbackStage =
  | "ask_region"
  | "ask_satisfaction"
  | "ask_wishlist"
  | "ask_location"
  | "ask_purpose"
  | "ask_budget"
  | "done";

export interface ClientData {
  chatId: string;
  language: "uz" | "uz-cyrl" | "ru";
  firstName?: string;
  username?: string;             // Telegram @username (bo'lsa) — /testreset qidiruvi uchun
  hasGreeted: boolean;
  askedForPhotoOnce: boolean;
  awaitingConnectionConfirm: boolean;
  connectionConfirmed?: boolean;
  connectionFollowupSentAt: string | null;
  reviewSent: boolean;
  firstSeen: string;
  lastSeen: string;
  voiceSent: boolean;
  gratitudeSent: boolean;
  lastVideoSentAt: string | null;
  messageHistory: MessageRecord[];
  lastProcessedMessageId?: number;
  businessConnectionId?: string;
  lastModelName?: string;
  connectionMethod?: "short" | "long";
  awaitingConnectionMethod?: boolean;
  connectionMethodAsks?: number; // ulanish usuli savoli necha marta so'ralgan (max 2, keyin tashlanadi)
  // Uzoq masofa (router orqali) ulash — video yo'q, bosqichma-bosqich matnli
  // yordam. "asked_status" — "ilovada qo'shilganmi/boshidanmi?" so'raldi;
  // "guiding" — bosqichma-bosqich yordam berilyapti.
  longRangeStage?: "asked_status" | "guiding";
  unresolvedCount?: number;      // ketma-ket "tushunmadim/yordam berolmadim" soni (adminni ogohlantirish uchun)
  stuckAdminNotified?: boolean;  // shu tiqilish uchun admin allaqachon xabardor qilinganmi
  barcodeAttempts?: number;      // nechta marta "yaqinroq rasm" so'ralgan
  awaitingModelName?: boolean;   // barcode aniqlanmagach, oxirgi chora — model nomini matn bilan so'rash
  // Barcode o'qildi-yu bazada topilmadi (yoki model umuman aniqlanmadi) —
  // lekin mijoz YORDAMSIZ qolmasligi kerak. Shu holatda kod umumiy (global)
  // yo'riqnoma/video/reset ko'rsatmalarini fallback sifatida ishlatadi.
  unknownModel?: boolean;
  // Model qanday usulda aniqlangani — statistikada barcode aniqlash
  // sifatini kuzatish uchun ("aniq mos" / "fuzzy (1 xato bilan)" / "mijoz
  // qo'lda model nomini yozdi" / "barcode o'qildi-yu bazada topilmadi").
  modelMatchMethod?: "exact" | "fuzzy" | "manual" | "unknown";
  refundRequested?: boolean;
  unsupportedMessageNoted?: boolean;
  lastInteractionDate?: string;
  region?: string;
  feedbackStage?: FeedbackStage;
  feedback?: ClientFeedback;
  feedbackAskedAt?: string;
  feedbackPausedAt?: string;     // so'rovnoma vaqtida mijoz savol/yordam so'rasa — pauza qilinadi, keyinroq davom ettiriladi
}

export interface Sample {
  id: string;
  title: string;
  text: string;
}

interface CachedInsights {
  text: string;
  cachedAt: string;
}

interface ReportsMeta {
  lastReportDate?: string;
  lastCostReportDate?: string;
  cachedInsights?: CachedInsights;
}

export interface StickerSample {
  file_id: string;
}

export interface GlobalVideoGuide {
  file_id: string;
  caption?: string;
}

interface AppSettings {
  stickerSample?: StickerSample; // barcha modellar uchun umumiy — quti stikeri joyini ko'rsatuvchi namuna rasm
  globalFaqItems?: FaqItem[];    // barcha modellarga tegishli umumiy savol-javoblar (FAQ)
  // "Umumiy yo'riqnoma" — model ANIQLANMAGANDA (masalan noma'lum barcode)
  // fallback sifatida ishlatiladi, chunki bu kameralar deyarli bir xil ulanadi.
  globalLongRangeGuide?: string;      // umumiy uzoq masofa (router orqali) ulash yo'riqnomasi
  globalResetInstructions?: string;   // umumiy reset ko'rsatmasi
  globalShortRangeVideo?: GlobalVideoGuide; // umumiy qisqa masofa ulash videosi
}

// Anthropic API'da qolgan kredit balansini o'qish uchun ochiq endpoint yo'q —
// shuning uchun bot har bir chaqiruv narxini o'zi hisoblab, admin kiritgan
// boshlang'ich balansdan ayirib boradi (taxminiy, aniq emas).
export interface ApiBalance {
  amountUsd: number;
  setAt: string;          // admin oxirgi marta shu summani kiritgan sana (ISO)
  lowAlertSent?: boolean;      // $1 dan past ogohlantirish yuborilganmi (balans qayta kiritilsa reset bo'ladi)
  criticalAlertSent?: boolean; // $0.20 dan past ogohlantirish yuborilganmi
}

export type AiFunctionName =
  | "readBarcodeDigits"
  | "identifyModelFromImages"
  | "classifyImage"
  | "detectIntent"
  | "answerQuestion"
  | "classifyProductFeedback"
  | "classifyRegion"
  | "classifySurveyReply"
  | "classifyLongRangeAnswer"
  | "classifyVideoRequest"
  | "answerLongRange"
  | "analyzeInsights"
  | "analyzeFeedback"
  | "extractTextFromImage"
  | "analyzeQuestionClusters";

export interface UsageRecord {
  date: string;    // YYYY-MM-DD, Toshkent vaqti bo'yicha
  fn: AiFunctionName;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  timestamp: string; // ISO
}

// Mijoz savol berganda (genuine savol — sintetik/avtomatik matn emas) qayd
// etiladi. /savollar buyrug'i shu jurnalni AI bilan tahlil qilib, eng ko'p
// takrorlanadigan mavzularni topadi — bilim bazasini samarali to'ldirish uchun.
export interface QuestionLogEntry {
  id: string;
  chatId: string;
  question: string;
  model: string | null;
  timestamp: string;
  wasAnsweredFromKB: boolean; // AI [NEED_ADMIN] belgisisiz javob berdimi
}

interface DbShape {
  models: CameraModel[];
  clients: ClientData[];
  samples: Sample[];
  reports: ReportsMeta;
  issues: IssueCategory[];
  modelMentions: ModelMention[];
  refundEvents: RefundEvent[];
  activityLog: ActivityEvent[];
  settings: AppSettings;
  usage: UsageRecord[];
  apiBalance?: ApiBalance;
  questionLog: QuestionLogEntry[];
}

function emptyDb(): DbShape {
  return {
    models: [], clients: [], samples: [], reports: {}, issues: [], modelMentions: [],
    refundEvents: [], activityLog: [], settings: {}, usage: [], questionLog: [],
  };
}

function loadDb(): DbShape {
  if (existsSync(DATA_FILE)) {
    try {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DbShape>;
      return {
        // Eski ma'lumotlarda longRangeGuides/barcodes maydoni bo'lmasligi
        // mumkin — bo'sh massiv bilan boshlanadi.
        models: (parsed.models ?? []).map((m) => ({
          ...m,
          longRangeGuides: m.longRangeGuides ?? [],
          barcodes: m.barcodes ?? [],
          faqItems: m.faqItems ?? [],
        })),
        clients: parsed.clients ?? [],
        samples: parsed.samples ?? [],
        reports: parsed.reports ?? {},
        issues: parsed.issues ?? [],
        modelMentions: parsed.modelMentions ?? [],
        refundEvents: parsed.refundEvents ?? [],
        activityLog: parsed.activityLog ?? [],
        settings: parsed.settings ?? {},
        usage: parsed.usage ?? [],
        apiBalance: parsed.apiBalance,
        questionLog: parsed.questionLog ?? [],
      };
    } catch {
      return emptyDb();
    }
  }
  return emptyDb();
}

const db: DbShape = loadDb();

function persist(): void {
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf-8");
}

export const modelsStore = {
  getAll(): CameraModel[] {
    return db.models;
  },
  getByName(name: string): CameraModel | undefined {
    return db.models.find((m) => m.name === name);
  },
  save(model: CameraModel): void {
    const idx = db.models.findIndex((m) => m.name === model.name);
    if (idx >= 0) db.models[idx] = model;
    else db.models.push(model);
    persist();
  },
  delete(name: string): void {
    db.models = db.models.filter((m) => m.name !== name);
    persist();
  },
  addFaqItem(modelName: string, question: string, answer: string): FaqItem | undefined {
    const model = db.models.find((m) => m.name === modelName);
    if (!model) return undefined;
    const item: FaqItem = { id: randomUUID(), question, answer };
    model.faqItems.push(item);
    persist();
    return item;
  },
  deleteFaqItem(modelName: string, id: string): void {
    const model = db.models.find((m) => m.name === modelName);
    if (!model) return;
    model.faqItems = model.faqItems.filter((f) => f.id !== id);
    persist();
  },
};

export const clientsStore = {
  getAll(): ClientData[] {
    return db.clients;
  },
  getById(chatId: string): ClientData | undefined {
    return db.clients.find((c) => c.chatId === chatId);
  },
  save(client: ClientData): void {
    const idx = db.clients.findIndex((c) => c.chatId === client.chatId);
    if (idx >= 0) db.clients[idx] = client;
    else db.clients.push(client);
    persist();
  },
  count(): number {
    return db.clients.length;
  },
  // Sinov uchun: mijozning SUHBAT HOLATINI yangi mijozdek qilib tozalaydi.
  // Kimligi (chatId, ism, username, business ulanishi) va TARIXIY STATISTIKA
  // (firstSeen, viloyat, to'plangan so'rovnoma) saqlanadi — faqat oqim holati
  // (hasGreeted, feedbackStage, connectionMethod, messageHistory va h.k.) nolga
  // qaytadi. Optional holat maydonlari ro'yxatga kiritilmagani uchun undefined
  // bo'ladi (kelajakda yangi holat maydoni qo'shilsa ham avtomatik tozalanadi).
  resetState(chatId: string): ClientData | undefined {
    const idx = db.clients.findIndex((c) => c.chatId === chatId);
    if (idx < 0) return undefined;
    const old = db.clients[idx];
    const fresh: ClientData = {
      chatId: old.chatId,
      firstName: old.firstName,
      username: old.username,
      businessConnectionId: old.businessConnectionId,
      firstSeen: old.firstSeen,
      lastSeen: old.lastSeen,
      region: old.region,       // statistika — saqlanadi
      feedback: old.feedback,   // to'plangan so'rovnoma — statistika, saqlanadi
      // ── quyidagilar yangi mijoz kabi ──
      language: "uz",
      hasGreeted: false,
      askedForPhotoOnce: false,
      awaitingConnectionConfirm: false,
      connectionFollowupSentAt: null,
      reviewSent: false,
      voiceSent: false,
      gratitudeSent: false,
      lastVideoSentAt: null,
      messageHistory: [],
    };
    db.clients[idx] = fresh;
    persist();
    return fresh;
  },
};

export const samplesStore = {
  getAll(): Sample[] {
    return db.samples;
  },
  add(title: string, text: string): void {
    db.samples.push({ id: randomUUID(), title, text });
    persist();
  },
  delete(id: string): void {
    db.samples = db.samples.filter((s) => s.id !== id);
    persist();
  },
  count(): number {
    return db.samples.length;
  },
};

export const reportsStore = {
  getCachedInsights(): CachedInsights | undefined {
    return db.reports.cachedInsights;
  },
  setCachedInsights(text: string): void {
    db.reports.cachedInsights = { text, cachedAt: new Date().toISOString() };
    persist();
  },
  getMeta(): ReportsMeta {
    return db.reports;
  },
  setLastReportDate(date: string): void {
    db.reports.lastReportDate = date;
    persist();
  },
  setLastCostReportDate(date: string): void {
    db.reports.lastCostReportDate = date;
    persist();
  },
};

export const issuesStore = {
  getAll(): IssueCategory[] {
    return db.issues;
  },
  // Mavjud kategoriyaga mos kelsa o'shanga, aks holda yangi kategoriya
  // ochib, shu mijoz uchun bitta eslatma (mention) qo'shadi.
  recordMention(label: string, chatId: string, modelName?: string): void {
    let cat = db.issues.find((c) => c.label === label);
    if (!cat) {
      cat = { id: randomUUID(), label, createdAt: new Date().toISOString(), mentions: [] };
      db.issues.push(cat);
    }
    cat.mentions.push({ chatId, modelName, timestamp: new Date().toISOString() });
    persist();
  },
};

export const modelMentionsStore = {
  getAll(): ModelMention[] {
    return db.modelMentions;
  },
  record(modelName: string, chatId: string): void {
    db.modelMentions.push({ modelName, chatId, timestamp: new Date().toISOString() });
    persist();
  },
};

export const refundEventsStore = {
  getAll(): RefundEvent[] {
    return db.refundEvents;
  },
  record(chatId: string, modelName: string | undefined): void {
    db.refundEvents.push({ chatId, modelName, timestamp: new Date().toISOString() });
    persist();
  },
};

export const activityStore = {
  getAll(): ActivityEvent[] {
    return db.activityLog;
  },
  record(chatId: string): void {
    db.activityLog.push({ chatId, timestamp: new Date().toISOString() });
    persist();
  },
};

export const settingsStore = {
  getStickerSample(): StickerSample | undefined {
    return db.settings.stickerSample;
  },
  setStickerSample(file_id: string): void {
    db.settings.stickerSample = { file_id };
    persist();
  },
  clearStickerSample(): void {
    db.settings.stickerSample = undefined;
    persist();
  },
  getGlobalFaqItems(): FaqItem[] {
    return db.settings.globalFaqItems ?? [];
  },
  addGlobalFaqItem(question: string, answer: string): FaqItem {
    if (!db.settings.globalFaqItems) db.settings.globalFaqItems = [];
    const item: FaqItem = { id: randomUUID(), question, answer };
    db.settings.globalFaqItems.push(item);
    persist();
    return item;
  },
  deleteGlobalFaqItem(id: string): void {
    if (!db.settings.globalFaqItems) return;
    db.settings.globalFaqItems = db.settings.globalFaqItems.filter((f) => f.id !== id);
    persist();
  },
  getGlobalLongRangeGuide(): string | undefined {
    return db.settings.globalLongRangeGuide;
  },
  setGlobalLongRangeGuide(text: string): void {
    db.settings.globalLongRangeGuide = text;
    persist();
  },
  clearGlobalLongRangeGuide(): void {
    db.settings.globalLongRangeGuide = undefined;
    persist();
  },
  getGlobalResetInstructions(): string | undefined {
    return db.settings.globalResetInstructions;
  },
  setGlobalResetInstructions(text: string): void {
    db.settings.globalResetInstructions = text;
    persist();
  },
  clearGlobalResetInstructions(): void {
    db.settings.globalResetInstructions = undefined;
    persist();
  },
  getGlobalShortRangeVideo(): GlobalVideoGuide | undefined {
    return db.settings.globalShortRangeVideo;
  },
  setGlobalShortRangeVideo(file_id: string, caption?: string): void {
    db.settings.globalShortRangeVideo = { file_id, caption };
    persist();
  },
  clearGlobalShortRangeVideo(): void {
    db.settings.globalShortRangeVideo = undefined;
    persist();
  },
};

export const usageStore = {
  getAll(): UsageRecord[] {
    return db.usage;
  },
  // Har bir Anthropic API chaqiruvidan keyin chaqiriladi — token/narxni
  // qayd etadi va (balans kiritilgan bo'lsa) shundan ayirib boradi.
  record(rec: Omit<UsageRecord, "timestamp">): void {
    db.usage.push({ ...rec, timestamp: new Date().toISOString() });
    if (db.apiBalance) db.apiBalance.amountUsd -= rec.costUsd;
    persist();
  },
  getBalance(): ApiBalance | undefined {
    return db.apiBalance;
  },
  // Admin balansni (qayta) kiritganda — ogohlantirish bayroqlari ham
  // tozalanadi, shunda to'ldirilgandan keyin ogohlantirish yana ishlaydi.
  setBalance(amountUsd: number): void {
    db.apiBalance = { amountUsd, setAt: new Date().toISOString(), lowAlertSent: false, criticalAlertSent: false };
    persist();
  },
  markLowAlertSent(): void {
    if (db.apiBalance) { db.apiBalance.lowAlertSent = true; persist(); }
  },
  markCriticalAlertSent(): void {
    if (db.apiBalance) { db.apiBalance.criticalAlertSent = true; persist(); }
  },
};

const QUESTION_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const questionLogStore = {
  getAll(): QuestionLogEntry[] {
    return db.questionLog;
  },
  getSince(sinceMs: number): QuestionLogEntry[] {
    return db.questionLog.filter((q) => new Date(q.timestamp).getTime() >= sinceMs);
  },
  // Mijoz haqiqiy savol berganda chaqiriladi (sintetik/avtomatik matnlar
  // uchun emas). Yozuv qo'shilganda 90 kundan eski yozuvlar ham tozalanadi —
  // ma'lumot bazasi cheksiz o'smasin.
  record(entry: Omit<QuestionLogEntry, "id" | "timestamp">): void {
    const cutoff = Date.now() - QUESTION_LOG_RETENTION_MS;
    db.questionLog = db.questionLog.filter((q) => new Date(q.timestamp).getTime() >= cutoff);
    db.questionLog.push({ ...entry, id: randomUUID(), timestamp: new Date().toISOString() });
    persist();
  },
};
