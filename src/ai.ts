import Anthropic from "@anthropic-ai/sdk";
import {
  REGIONS,
  usageStore,
  type AiFunctionName,
  type CameraModel,
  type ClientFeedback,
  type MessageRecord,
  type Region,
} from "./data/store.js";
import { notifyAdmins } from "./helpers.js";
import { logger } from "./lib/logger.js";

const anthropic = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

const MODEL = "claude-sonnet-5";

// ─── Narx konfiguratsiyasi va xarajat kuzatuvi ─────────────────────────────────
//
// Manba: https://platform.claude.com/docs/en/about-claude/pricing (tekshirilgan: 2026-07-12)
// Claude Sonnet 5 — "introductory" narx, 2026-08-31 gacha amal qiladi:
//   Input:  $2  / 1M token
//   Output: $10 / 1M token
//   Keshdan o'qish (cache hit): $0.20 / 1M token (bazaviy input narxining 0.1x)
// 2026-09-01 dan boshlab standart narx: input $3, output $15 / 1M token —
// shu sanadan keyin quyidagi qiymatlarni yangilash kerak.
const MODEL_PRICING = {
  inputPerMTok: 2,
  outputPerMTok: 10,
  cacheReadPerMTok: 0.2,
};

function tashkentDateStr(): string {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function checkBalanceThresholds(): void {
  const balance = usageStore.getBalance();
  if (!balance) return;

  if (balance.amountUsd < 0.2) {
    if (!balance.criticalAlertSent) {
      usageStore.markCriticalAlertSent();
      usageStore.markLowAlertSent();
      notifyAdmins(
        `JIDDIY OGOHLANTIRISH — EnvoCam bot API balansi $${balance.amountUsd.toFixed(2)} ga tushdi!\n\nBot TEZ ORADA javob bera olmay qolishi mumkin. Anthropic Console'da balansni to'ldiring, so'ng admin panel → "API balans" bo'limidan yangi summani kiriting.`
      ).catch(() => {});
    }
  } else if (balance.amountUsd < 1) {
    if (!balance.lowAlertSent) {
      usageStore.markLowAlertSent();
      notifyAdmins(
        `Ogohlantirish — EnvoCam bot API balansi $${balance.amountUsd.toFixed(2)} ga tushdi.\n\nBalansni to'ldirishni unutmang.`
      ).catch(() => {});
    }
  }
}

function recordUsage(fn: AiFunctionName, usage: Anthropic.Usage): void {
  // O'rnatilgan SDK (0.30.1) tipi hali "cache_read_input_tokens" maydonini
  // e'lon qilmaydi, lekin API javobida haqiqatda mavjud — shuning uchun
  // xavfsiz cast bilan o'qiymiz.
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const costUsd =
    (inputTokens / 1_000_000) * MODEL_PRICING.inputPerMTok +
    (outputTokens / 1_000_000) * MODEL_PRICING.outputPerMTok +
    (cacheReadTokens / 1_000_000) * MODEL_PRICING.cacheReadPerMTok;

  usageStore.record({ date: tashkentDateStr(), fn, inputTokens, outputTokens, cacheReadTokens, costUsd });
  checkBalanceThresholds();
}

// Anthropic balans tugaganda shu xabar bilan xato qaytaradi — bu holatda
// mijozga (mavjud fallback orqali) xushmuomala javob ketadi, lekin adminga
// DARHOL xabar berish kerak, kunlik hisobotni kutmasdan. Spam bo'lmasligi
// uchun bir xil xato uchun 30 daqiqada bir martadan ko'p yubormaymiz.
let lastLowCreditNotifyAt = 0;
const LOW_CREDIT_NOTIFY_THROTTLE_MS = 30 * 60 * 1000;

function isLowCreditError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /credit balance is too low/i.test(message);
}

async function notifyLowCreditIfNeeded(err: unknown): Promise<void> {
  if (!isLowCreditError(err)) return;
  const now = Date.now();
  if (now - lastLowCreditNotifyAt < LOW_CREDIT_NOTIFY_THROTTLE_MS) return;
  lastLowCreditNotifyAt = now;
  logger.error({ err }, "Anthropic API: kredit balansi tugadi");
  await notifyAdmins(
    "DIQQAT — Anthropic API kredit balansi TUGADI. Bot mijozlarga AI javob bera olmayapti!\n\nDarhol balansni to'ldiring: https://console.anthropic.com/settings/billing"
  ).catch(() => {});
}

// Javobdagi BARCHA matn bloklarini birlashtiradi. MUHIM: model bir nechta
// content bloki qaytarishi mumkin va birinchisi matn bo'lmasligi mumkin —
// shuning uchun response.content[0] ga tayanish XATO (matnni yo'qotadi va
// mijoz javobsiz qoladi). Bu yordamchi barcha "text" bloklarini yig'adi.
function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Suhbat tarixini Anthropic API talablariga moslaydi va AI'ga uzatiladigan
// xabarlar ro'yxatini quradi. Anthropic BIRINCHI xabar role="user" bo'lishini
// TALAB qiladi — aks holda 400 xato → bo'sh javob → mijoz jim qoladi.
// (assistant xabar mijoz xabarisiz ham qo'shilishi mumkin, masalan
// sendLongRangeIntro'da — shuning uchun bu tozalash zarur.)
function buildMessages(
  history: MessageRecord[],
  question: string
): { role: "user" | "assistant"; content: string }[] {
  const cleaned = history
    .filter((m) => typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Boshidagi barcha "assistant" xabarlarni tashlaymiz — birinchi "user" dan boshlanadi.
  let start = 0;
  while (start < cleaned.length && cleaned[start].role !== "user") start++;
  const trimmed = cleaned.slice(start);

  // Oxiridagi user xabari aynan savolning o'zi bo'lsa — takrorlamaymiz.
  const last = trimmed[trimmed.length - 1];
  if (last && last.role === "user" && last.content === question) return trimmed;
  return [...trimmed, { role: "user", content: question }];
}

// Barcha Anthropic chaqiruvlari shu orqali o'tadi — har bir chaqiruvdan
// keyin token/narx qayd etiladi, xato bo'lsa (masalan kredit tugagan bo'lsa)
// adminga darhol xabar beriladi. Javobda matn bloki umuman bo'lmasa —
// strukturani loglab, BIR MARTA qayta urinadi (bo'sh javob = mijoz jim qoladi).
async function callClaude(
  fn: AiFunctionName,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  try {
    let response = await anthropic.messages.create(params);
    recordUsage(fn, response.usage);

    if (extractText(response) === "") {
      logger.error(
        { fn, stopReason: response.stop_reason, content: JSON.stringify(response.content).slice(0, 500) },
        "callClaude: javobda matn bloki yo'q — qayta urinilyapti"
      );
      response = await anthropic.messages.create(params);
      recordUsage(fn, response.usage);
      if (extractText(response) === "") {
        logger.error(
          { fn, stopReason: response.stop_reason, content: JSON.stringify(response.content).slice(0, 500) },
          "callClaude: qayta urinishdan keyin ham matn yo'q"
        );
      }
    }
    return response;
  } catch (err) {
    await notifyLowCreditIfNeeded(err);
    throw err;
  }
}

// Haqiqiy mijozlar ko'pincha qisqartma o'zbekchada yozadi — buni AI ga har
// safar eslatamiz, aks holda javoblarni noto'g'ri tushunadi.
const SHORTHAND_UZ_NOTE =
  `MUHIM: Mijozlar ko'pincha qisqartma/xato o'zbekchada yozadi — 'sh' o'rniga 'w' (bowidan=boshidan, iwxona=ishxona, tuwunasz=tushunasiz), unlilar tushib qoladi (kop=ko'p, korib=ko'rib), maxsus harflar oddiy yoziladi. Shuni hisobga olib ma'noni to'g'ri tushun.`;

// Do'kon o'zligi + haydab yubormaslik + fayl yubora olmaslik + bilim yo'q
// bo'lsa [NEED_ADMIN] belgisi. BARCHA mijozga javob beradigan AI chaqiruvlari
// (answerQuestion, answerLongRangeStep) shu qoidalarga bo'ysunishi kerak —
// aks holda ba'zi oqimlarda bot "sotuvchidan so'rang" deb yuborishi yoki
// yubora olmaydigan faylni "hozir yuboraman" deb va'da qilishi mumkin edi.
function buildStoreRules(isUz: boolean): string {
  return isUz
    ? `\n\nMUHIM QOIDALAR:\n- Sen EnvoCam kamera do'konining RASMIY yordamchisisan — SEN O'ZING do'konsan.\n- HECH QACHON mijozni "do'konga murojaat qiling", "sotuvchidan so'rang", "texnik xizmatga murojaat qiling" yoki boshqa joyga yuborma. Bu QAT'IY TAQIQLANGAN.\n- Sen video/rasm/fayl O'ZING yubora OLMAYSAN — buni alohida tizim boshqaradi. Shuning uchun "yuboraman", "hozir yuboraman", "qaytadan yuboraman" deb HECH QACHON VA'DA BERMA. Agar mijoz video/fayl so'rasa, shunchaki bor-yo'qligini ayt yoki savoliga matn bilan javob ber — yuborish harakatini SEN emas, tizim bajaradi.\n- Javobni ANIQ bilmasang (ma'lumot bazangda yo'q bo'lsa) — iliq ayt: "Buni aniqlab, sizga tez orada javob beraman", va butun javobingni AYNAN shu belgi bilan boshla: [NEED_ADMIN] (bu belgi mijozga ko'rsatilmaydi, admin xabardor bo'lishi uchun).`
    : `\n\nВАЖНЫЕ ПРАВИЛА:\n- Ты ОФИЦИАЛЬНЫЙ помощник магазина камер EnvoCam — ты САМ и есть магазин.\n- НИКОГДА не отправляй клиента "обратитесь в магазин", "спросите у продавца", "в техподдержку" и т.п. Это СТРОГО запрещено.\n- Ты САМ не можешь отправить видео/фото/файл — это делает отдельная система. Поэтому НИКОГДА не обещай "сейчас пришлю", "отправлю ещё раз" — просто скажи, есть ли это, или ответь текстом на вопрос.\n- Если точного ответа не знаешь (нет в базе) — тепло скажи: "Уточню и скоро вам отвечу" и начни весь ответ РОВНО с метки [NEED_ADMIN] (она не видна клиенту, для уведомления администратора).`;
}

// ─── Rasm tahlili ─────────────────────────────────────────────────────────────

export interface ImageInput {
  base64: string;
  mimeType: string;
}

function toImageBlock(img: ImageInput): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data: img.base64,
    },
  };
}

// ─── Barcode raqamini o'qish (QR dekod ishlamasa, OCR fallback) ───────────────

// "full" — stikerdagi to'liq uzun raqamni o'qishga harakat qiladi.
// "last4" — faqat oxirgi (odatda kattaroq/qalinroq shriftdagi) 4 raqamni
// o'qishga harakat qiladi, to'liq raqam o'qib bo'lmaganda ishlatiladi.
export async function readBarcodeDigits(
  image: ImageInput,
  mode: "full" | "last4"
): Promise<string | null> {
  const instruction = mode === "full"
    ? `Bu rasmda kamera qutisidagi oq stikerda vertikal yoki gorizontal yozilgan uzun barcode raqami bor (masalan 1000077693951, odatda 10 tadan ortiq xonali). Faqat shu raqamni yoz, boshqa hech narsa yozma — izoh, tushuntirish kerak emas. Aniq o'qiy olmasang yoki bunday raqam umuman ko'rinmasa, faqat "null" deb yoz.`
    : `Bu rasmda kamera qutisidagi barcode raqamining OXIRGI 4 ta raqami bo'lishi mumkin — ular odatda qolgan raqamlarga qaraganda KATTAROQ va QALINROQ shriftda, alohida ajratib yozilgan bo'ladi. Faqat shu 4 ta raqamni yoz, boshqa hech narsa yozma. Aniq topolmasang faqat "null" deb yoz.`;

  const response = await callClaude("readBarcodeDigits", {
    model: MODEL,
    max_tokens: 32,
    messages: [
      {
        role: "user",
        content: [toImageBlock(image), { type: "text", text: instruction }],
      },
    ],
  });

  const raw = extractText(response);
  if (!raw) return null;
  // Xom natijani (AI aynan nima yozganini) loglaymiz — Railway logida
  // qanday o'qilayotganini aniq ko'rish uchun.
  logger.info({ mode, rawOcr: raw }, "barcode: AI-OCR xom natijasi");
  const digits = raw.replace(/\D/g, "");
  if (mode === "full") return digits.length >= 8 ? digits : null;
  return digits.length === 4 ? digits : null;
}

// ─── So'rovnoma javobini tasniflash ───────────────────────────────────────────

// Mijoz so'rovnoma savoliga JAVOB bermoqdami, yoki umuman boshqa narsa
// (savol, yordam so'rovi, salomlashish, muammo) demoqdami — shuni aniqlaydi,
// shunda so'rovnoma mijozning haqiqiy so'rovini "yutib" yubormaydi.
export async function classifySurveyReply(
  question: string,
  reply: string
): Promise<"survey_answer" | "other"> {
  try {
    const response = await callClaude("classifySurveyReply", {
      model: MODEL,
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: `Bot mijozga so'rovnoma savolini berdi: "${question}"
Mijoz javobi: "${reply}"

Bu javob AYNAN shu so'rovnoma savoliga javobmi, yoki mijoz butunlay boshqa narsa (salomlashish, yordam so'rovi, kamerani ulash/sozlash muammosi, boshqa savol, pul qaytarish) demoqdami?

- Agar mijoz shu savolga javob berayotgan bo'lsa (hatto qisqa, noaniq yoki shikoyat shaklida bo'lsa ham) — "survey_answer".
- Agar mijoz javob bermay, bir narsa SO'RAYOTGAN, yordam kutayotgan yoki salomlashayotgan bo'lsa — "other".

Faqat JSON qaytar: {"kind":"survey_answer|other"}`,
        },
      ],
    });

    const jsonMatch = extractText(response).match(/\{[\s\S]*\}/);
    if (!jsonMatch) return "survey_answer";
    const parsed = JSON.parse(jsonMatch[0]) as { kind?: string };
    return parsed.kind === "other" ? "other" : "survey_answer";
  } catch {
    // Tasnif ishlamasa — hozirgi xatti-harakatni saqlaymiz (so'rovnoma davom etadi).
    return "survey_answer";
  }
}

// ─── Uzoq masofa: "ilovada qo'shilganmi/boshidanmi?" javobini tasniflash ──────

// Mijoz javobini UMUMIY detectIntent bilan emas, aynan SO'RALGAN SAVOL
// kontekstida tushunamiz — aks holda "ha boshidan" kabi javob "gratitude"
// deb noto'g'ri tushuniladi.
export async function classifyLongRangeAnswer(
  answer: string
): Promise<"start_over" | "already_added" | "unclear"> {
  try {
    const response = await callClaude("classifyLongRangeAnswer", {
      model: MODEL,
      max_tokens: 24,
      messages: [
        {
          role: "user",
          content: `Bot mijozdan so'radi: "Kamerangiz telefon ilovasiga allaqachon qo'shilganmi, yoki boshidan boshlab qo'shamizmi?"
Mijoz javobi: "${answer}"

${SHORTHAND_UZ_NOTE}

Mijoz nimani nazarda tutyapti?
- "start_over": boshidan boshlash kerak / hali qo'shilmagan / qo'sha olmadi / ulanmagan ("boshidan", "bowidan", "yo'q", "yoq", "qo'sholmadim", "ulab bo'lmadi", "ulanmagan", "ulanmayapti", "qo'shilmagan", "qo'shila olmadim", "hali yo'q")
- "already_added": kamera ilovaga allaqachon qo'shilgan ("ha", "qo'shilgan", "bor", "qo'shdim", "ulangan")
- "unclear": aniq emas

Faqat JSON: {"kind":"start_over|already_added|unclear"}`,
        },
      ],
    });
    const jsonMatch = extractText(response).match(/\{[\s\S]*\}/);
    if (!jsonMatch) return "unclear";
    const parsed = JSON.parse(jsonMatch[0]) as { kind?: string };
    if (parsed.kind === "start_over" || parsed.kind === "already_added") return parsed.kind;
    return "unclear";
  } catch {
    return "unclear";
  }
}

// ─── Video (qisqa masofa) qayta so'ralganini tasniflash ───────────────────────

// Bot AI orqali matn javob bera oladi, lekin video yubora OLMAYDI (buni
// alohida tizim bajaradi). Shuning uchun mijoz videoni (qayta) so'raganda,
// buni AI'ga emas, to'g'ridan-to'g'ri video yuboruvchi funksiyaga yo'naltirish
// kerak. Arzon regex-filtr orqali faqat shubhali xabarlarda chaqiriladi.
export async function classifyVideoRequest(text: string): Promise<boolean> {
  try {
    const response = await callClaude("classifyVideoRequest", {
      model: MODEL,
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: `Mijozga kamera ulash video-qo'llanmasi avval yuborilgan. Mijoz keyingi xabari: "${text}"

Mijoz shu video-qo'llanmani (QAYTA) yuborishni so'ramoqdami — masalan video kelmadi/ko'rinmadi/ochilmadi degani, yoki "video bormi", "qachon yuborasiz", "qayta yubor", "yana yubor" kabi so'rov? Yoki bu BOSHQA narsa — kamera haqida savol/muammo, minnatdorchilik, umuman boshqa mavzu?

Faqat JSON qaytar: {"wantsVideo": true|false}`,
        },
      ],
    });
    const jsonMatch = extractText(response).match(/\{[\s\S]*\}/);
    if (!jsonMatch) return false;
    const parsed = JSON.parse(jsonMatch[0]) as { wantsVideo?: boolean };
    return parsed.wantsVideo === true;
  } catch {
    return false;
  }
}

// ─── Uzoq masofa: bosqichma-bosqich yordam ────────────────────────────────────

export interface LongRangeStepOptions {
  question: string;                 // mijozning oxirgi xabari
  language: "uz" | "uz-cyrl" | "ru";
  modelName: string;
  longRangeGuide: string;           // admin kiritgan uzoq masofa yo'riqnomasi (bo'sh bo'lishi mumkin)
  history: MessageRecord[];
  fromStart: boolean;               // boshidan boshlanyaptimi (true) yoki allaqachon qo'shilgan (false)
}

// Mijozga uzoq masofa (router orqali) ulashda BITTA qadamni tushuntiradi va
// mijoz bajarganini so'raydi — butun yo'riqnomani bir yo'la tashlamaydi.
export async function answerLongRangeStep(opts: LongRangeStepOptions): Promise<string> {
  const { question, language, modelName, longRangeGuide, history, fromStart } = opts;
  const isUz = language === "uz" || language === "uz-cyrl";

  const guideBlock = longRangeGuide.trim()
    ? `Do'kon tayyorlagan uzoq masofa yo'riqnomasi (shunga tayan):\n${longRangeGuide}`
    : `Bu model uchun maxsus yo'riqnoma hali kiritilmagan — umumiy IP/WiFi kamera bilimingdan foydalanib yordam ber (kamerani uy WiFi routeriga ulash, ilovada qurilma qo'shish, QR/kod orqali).`;

  const systemPrompt = isUz
    ? `Sen EnvoCam kamera do'konining samimiy yordamchisisan. Mijozga ${modelName} kamerasini UZOQ MASOFADAN (uy WiFi routeri orqali, istalgan joydan ko'rish) ulashda yordam beryapsan.

QOIDALAR:
- Hech qachon emoji ishlatma. Iliq, sodda, inson kabi gapir.
- BOSQICHMA-BOSQICH yordam ber: BITTA qadamni ayt, keyin mijoz bajarganini so'ra ("shu bo'ldimi?"). Butun yo'riqnomani bir yo'la TASHLAMA.
- Har bir javob 1-3 qisqa jumladan oshmasin.
- ${fromStart ? "Mijoz BOSHIDAN boshlayapti — birinchi qadamdan boshla." : "Mijoz kamerani ilovaga allaqachon qo'shgan — u aynan nimada qiynalayotganini so'ra va o'sha joydan davom et."}
- Mijoz "bo'ldi/ha" desa — keyingi qadamga o't. Tushunmasa — o'sha qadamni BOSHQACHA, SODDAROQ tushuntir (bir xil so'zni takrorlama).
- Mijoz keyinroq/ertaga qilmoqchi bo'lsa yoki "hozir WiFi yo'q" desa — MAJBURLAMA. Iliq javob ber ("Albatta, tayyor bo'lganingizda yozing, davom etamiz") va shu bilan to'xta. Uzoq masofa uy WiFi routeri BO'LISHINI talab qiladi — buni eslatib qo'y.
- ${SHORTHAND_UZ_NOTE}

${guideBlock}`
    : `Ты дружелюбный помощник магазина камер EnvoCam. Помогаешь клиенту подключить камеру ${modelName} НА ДАЛЬНЕМ расстоянии (через домашний WiFi роутер).

ПРАВИЛА:
- Без эмодзи. Тепло, просто, по-человечески.
- ПОШАГОВО: назови ОДИН шаг, затем спроси, получилось ли. Не выкладывай всю инструкцию сразу.
- Каждый ответ — 1-3 коротких предложения.
- ${fromStart ? "Клиент начинает С НАЧАЛА — начни с первого шага." : "Камера уже добавлена — спроси, что именно не получается, и продолжи оттуда."}
- Если не понял — объясни ИНАЧЕ, ПРОЩЕ (не повторяй те же слова).
- Если клиент хочет позже/завтра или говорит «сейчас нет WiFi» — НЕ дави. Ответь тепло («Конечно, напишите, когда будете готовы») и остановись. Дальнее подключение требует домашнего WiFi роутера — напомни об этом.

${guideBlock}`;

  const finalSystemPrompt = systemPrompt + buildStoreRules(isUz);

  const response = await callClaude("answerLongRange", {
    model: MODEL,
    max_tokens: 700,
    system: finalSystemPrompt,
    messages: buildMessages(history.slice(-16), question),
  });

  return extractText(response);
}

// Mijoz rasm(lar)idan kamera modelini aniqlaydi. ENG ISHONCHLI belgi —
// quti stikeridagi BARCODE raqami (model nomi qutida hech qachon
// yozilmaydi). Barcode topilmasa/mos kelmasa, namuna rasmlar bilan vizual
// solishtirishga o'tadi, lekin ehtiyotkorlik bilan (kameralar bir-biriga
// juda o'xshash).
export async function identifyModelFromImages(
  clientImages: ImageInput[],
  models: { name: string; barcodes: string[]; refCollage: ImageInput | null }[]
): Promise<{ status: "matched" | "unclear" | "no_match"; model: string | null }> {
  if (clientImages.length === 0) return { status: "unclear", model: null };

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  const modelNames = models.map((m) => m.name);

  const withBarcodes = models.filter((m) => m.barcodes.length > 0);
  if (withBarcodes.length > 0) {
    const barcodeList = withBarcodes
      .map((m) => `Model: ${m.name} — barcode(lar): ${m.barcodes.join(", ")}`)
      .join("\n");
    content.push({
      type: "text",
      text: `Har bir modelning quti stikeridagi BARCODE raqam(lar)i — bu modelni aniqlashning ENG ISHONCHLI yo'li:\n${barcodeList}`,
    });
  }

  const withRefs = models.filter((m) => m.refCollage !== null);
  if (withRefs.length > 0) {
    content.push({
      type: "text",
      text: "Qo'shimcha (barcode topilmasa yoki mos kelmasa ishlatiladigan) — do'kondagi kameralarning namuna rasmlari: har bir model uchun bitta rasm, unda o'sha modelning bir nechta burchakdan olingan suratlari grid (jadval) shaklida birlashtirilgan. Har bir rasm model nomi bilan belgilangan:",
    });
    const sorted = [...withRefs].sort((a, b) => a.name.localeCompare(b.name));
    for (const m of sorted) {
      content.push({ type: "text", text: `Model: ${m.name}` });
      content.push(toImageBlock(m.refCollage!));
    }
  }

  content.push({
    type: "text",
    text: `Mijoz yuborgan rasm(lar) — ${clientImages.length} ta:`,
  });
  for (const ci of clientImages) content.push(toImageBlock(ci));

  content.push({
    type: "text",
    text: `Mavjud modellar: ${modelNames.join(", ")}.

MUHIM KONTEKST: Bu kameralarning qutisida MODEL NOMI hech qachon yozilmaydi — quti stikerida faqat "CAMERA / HD VIDEO CAMERA" umumiy yozuvi va BARCODE raqami bor, "Model:" maydoni bo'sh qoldirilgan. Kameralarning o'zi (kichik WiFi kameralar) bir-biriga juda o'xshash, shuning uchun faqat tashqi ko'rinishga tayanib xulosa chiqarish ko'pincha noto'g'ri bo'ladi.

VAZIFA (shu tartibda bajar):
1. Avval mijoz rasmidagi BARCHA raqamlarni diqqat bilan o'qi — ayniqsa stikerda (ko'pincha vertikal yozilgan) uzun raqamni (masalan 1000077693951 kabi 10+ xonali raqam).
2. O'qilgan raqamlardan birortasi yuqoridagi barcode ro'yxatidagi biror modelga ANIQ (raqam-raqam) mos kelsa — "matched" de va o'sha modelni qaytar. Bu ENG ISHONCHLI usul, shunga ustunlik ber.
3. Agar barcode o'qilmasa yoki ro'yxatdagi hech biriga mos kelmasa — namuna rasmlar bilan vizual solishtir, LEKIN faqat juda ishonchli bo'lsang "matched" de. Kameralar bir-biriga o'xshash bo'lgani uchun ozgina shubhang bo'lsa "unclear" de — noto'g'ri taxmin qilishdan ko'ra "unclear" deyish yaxshiroq.
Ro'yxatdagi hech bir modelga to'g'ri kelmasa "no_match" de.
Faqat JSON qaytar: {"status": "matched|unclear|no_match", "model": "nom yoki null"}`,
  });

  const response = await callClaude("identifyModelFromImages", {
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content }],
  });

  const raw = extractText(response);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: "no_match", model: null };
    return JSON.parse(jsonMatch[0]) as { status: "matched" | "unclear" | "no_match"; model: string | null };
  } catch {
    return { status: "no_match", model: null };
  }
}

// ─── Rasm turini aniqlash (kamera/quti / ilova skrinshoti / qo'llanma / boshqa) ──

export interface ImageClassification {
  kind: "camera_or_box" | "app_screenshot" | "manual_page" | "other";
  description: string;
}

// Mijoz kamera/quti o'rniga ko'pincha ilova skrinshoti yoki qo'llanma
// varag'ini yuboradi — bularni model-aniqlashga tiqishtirish behuda va
// chalkash javobga olib keladi. Shu funksiya bilan avval rasm turini
// bilib olamiz.
export async function classifyImage(image: ImageInput): Promise<ImageClassification> {
  const response = await callClaude("classifyImage", {
    model: MODEL,
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          toImageBlock(image),
          {
            type: "text",
            text: `Bu rasmda aynan nima ko'rinayotganini aniqla.

Faqat JSON qaytar: {"kind": "camera_or_box|app_screenshot|manual_page|other", "description": "rasmda aynan nima ko'rinayotgani, 1 qisqa jumla"}

- camera_or_box: kameraning o'zi va/yoki uning qutisi (stiker, barcode va h.k.)
- app_screenshot: telefon ilovasi ekrani (QR kod, sozlamalar, xato xabari va h.k.)
- manual_page: bosma yo'riqnoma/qog'oz varag'i surati
- other: yuqoridagilarga mos kelmaydigan boshqa narsa`,
          },
        ],
      },
    ],
  });

  const fallback: ImageClassification = { kind: "other", description: "" };
  const raw = extractText(response);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as { kind?: string; description?: string };
    const validKinds = ["camera_or_box", "app_screenshot", "manual_page", "other"];
    const kind = validKinds.includes(parsed.kind ?? "")
      ? (parsed.kind as ImageClassification["kind"])
      : "other";
    return { kind, description: parsed.description?.trim() ?? "" };
  } catch {
    return fallback;
  }
}

// ─── Niyat aniqlash ───────────────────────────────────────────────────────────

export interface IntentResult {
  intent: "greeting" | "gratitude" | "question" | "cannot_send_photo" | "connect_camera" | "refund_request";
  connectionMethod: "short" | "long" | null;
  productFeedback: string | null;
}

export async function detectIntent(text: string): Promise<IntentResult> {
  const response = await callClaude("detectIntent", {
    model: MODEL,
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: `Faqat JSON qaytar: {"intent": "greeting|gratitude|question|cannot_send_photo|connect_camera|refund_request", "connectionMethod": "short|long|null", "productFeedback": "qisqa tavsif yoki null"}

INTENT (bittasini tanla):
- greeting: salom, assalomu alaykum, hi, hello, privjet, zdravstvujte
- gratitude: FAQAT aniq minnatdorchilik so'zlari — "rahmat", "tashakkur", "raxmat", "barakalla", "spasibo". BOSHQA HECH NARSA.
- cannot_send_photo: rasm yubora olmayotganini aytmoqda
- connect_camera: kamerani ulash/sozlashda yordam so'ramoqda (masalan: "kamerani qanday ulashman", "ulashga yordam bering", "sozlab bera olasizmi")
- refund_request: pulini yoki mahsulotni qaytarib berishni so'ramoqda (masalan: "pulimni qaytaring", "mahsulotni qaytarmoqchiman", "refund", "vozvrat")
- question: yuqoridagilarga to'g'ri kelmaydigan boshqa har qanday savol yoki muammo

MUHIM: "Ha", "Yo'q", "Bo'ldi", "OK", "Xo'p", "Ishladi", "Uladim", "Zo'r", "Yaxshi" kabi QISQA TASDIQ/RAD javoblari MINNATDORCHILIK EMAS — ular oldingi savolga javob. Bularni "question" deb belgila (kontekstda tushuniladi). Minnatdorchilik faqat "rahmat/tashakkur/spasibo" so'zlari bilan bo'ladi.

CONNECTION METHOD — faqat xabarda ANIQ tilga olingan bo'lsa ko'rsat, aks holda null:
- "short": qisqa masofa, kamera WiFi'siga to'g'ridan-to'g'ri ulanish, yaqin masofadan
- "long": uzoq masofa, uy/router WiFi'si orqali, istalgan joydan (uzoqdan) ko'rish

PRODUCT FEEDBACK — agar xabarda kamera haqida shikoyat, istak/xususiyat so'rovi yoki yoqtirish/yoqtirmaslik bo'lsa, buni 2-5 so'zda qisqa ifodada yoz (masalan: "video sifati past", "tungi ko'rish yo'q", "batareya tez tugaydi", "narxi qimmat"). Aks holda null.

${SHORTHAND_UZ_NOTE}

Xabar: "${text}"`,
      },
    ],
  });

  const fallback: IntentResult = { intent: "question", connectionMethod: null, productFeedback: null };
  const raw = extractText(response);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as {
      intent?: string;
      connectionMethod?: string | null;
      productFeedback?: string | null;
    };
    const validIntents = ["greeting", "gratitude", "cannot_send_photo", "connect_camera", "refund_request", "question"];
    const intent = validIntents.includes(parsed.intent ?? "")
      ? (parsed.intent as IntentResult["intent"])
      : "question";
    const connectionMethod =
      parsed.connectionMethod === "short" || parsed.connectionMethod === "long"
        ? parsed.connectionMethod
        : null;
    const productFeedback =
      typeof parsed.productFeedback === "string" &&
      parsed.productFeedback.trim() &&
      parsed.productFeedback.trim().toLowerCase() !== "null"
        ? parsed.productFeedback.trim()
        : null;
    return { intent, connectionMethod, productFeedback };
  } catch {
    return fallback;
  }
}

// ─── Muammo/istak kategoriyasini aniqlash (mavjudga moslash yoki yangi ochish) ──

export async function classifyProductFeedback(
  feedbackText: string,
  existingLabels: string[]
): Promise<string | null> {
  const response = await callClaude("classifyProductFeedback", {
    model: MODEL,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: `Mijoz kamera haqida shunday dedi: "${feedbackText}"

Mavjud muammo/istak kategoriyalari:
${existingLabels.length > 0 ? existingLabels.map((l) => `- ${l}`).join("\n") : "(hali kategoriya yo'q)"}

Vazifa: agar bu fikr yuqoridagi kategoriyalardan biriga MA'NO jihatdan mos kelsa, o'sha kategoriya nomini AYNAN o'zidek qaytar (harfma-harf bir xil). Aks holda yangi qisqa kategoriya nomi taklif qil (2-4 so'z, masalan "Video sifati past").

Faqat JSON qaytar: {"label": "kategoriya nomi"}`,
      },
    ],
  });

  const raw = extractText(response);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { label?: string };
    const label = parsed.label?.trim();
    return label ? label : null;
  } catch {
    return null;
  }
}

// ─── Viloyatni ro'yxatdagi nomga moslashtirish ──────────────────────────────

export async function classifyRegion(text: string): Promise<Region | null> {
  const response = await callClaude("classifyRegion", {
    model: MODEL,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: `Mijoz javobi: "${text}"

Quyidagi ro'yxatdan mijoz aytgan hududga ENG yaqin mos kelganini tanla:
${REGIONS.join(", ")}

Agar hech biriga ishonch bilan mos kelmasa, "null" qaytar.
Faqat JSON qaytar: {"region": "ro'yxatdagi aynan nom yoki null"}`,
      },
    ],
  });

  const raw = extractText(response);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { region?: string | null };
    const region = parsed.region;
    return (REGIONS as readonly string[]).includes(region ?? "") ? (region as Region) : null;
  } catch {
    return null;
  }
}

// ─── Matndan rasm matnini o'qish ──────────────────────────────────────────────

export async function extractTextFromImage(
  imageBase64: string,
  mimeType: string
): Promise<string> {
  const response = await callClaude("extractTextFromImage", {
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: "Bu rasmdagi barcha matnni to'liq o'qi va qaytarib ber. Faqat matn, boshqa hech narsa yo'q.",
          },
        ],
      },
    ],
  });
  return extractText(response);
}

// ─── Savollarga javob ─────────────────────────────────────────────────────────

export interface AnswerOptions {
  question: string;
  language: "uz" | "uz-cyrl" | "ru";
  cameraModel: CameraModel | undefined;
  connectionMethod?: "short" | "long"; // aniqlangan bo'lsa: uzoq/qisqa masofa
  refundRequested?: boolean;  // mijoz pul/mahsulot qaytarishni so'ragan (shu yoki oldingi xabarda)
  firstName?: string;
  shouldGreet: boolean;       // bu xabarda salom berish kerakmi
  history: MessageRecord[];   // oldingi xabarlar
  samples: string[];          // namuna yozishmalar
  rephraseHint?: boolean;     // mijoz oldingi javobni tushunmadi — boshqacha, soddaroq tushuntir
}

export async function answerQuestion(opts: AnswerOptions): Promise<string> {
  const { question, language, cameraModel, connectionMethod, refundRequested, firstName, shouldGreet, history, samples } = opts;

  // ─ Bilim bazasi ─
  const knowledgeBase: string[] = [];
  if (cameraModel) {
    const longRangeTexts = cameraModel.longRangeGuides
      .map((g) => g.text)
      .filter((t) => t.trim());
    if (longRangeTexts.length > 0)
      knowledgeBase.push("=== Uzoq masofadan ulash yo'riqnomasi ===\n" + longRangeTexts.join("\n\n"));

    const appTexts = cameraModel.appScreenshots
      .filter((a) => a.extractedText?.trim())
      .map((a) => a.extractedText as string);
    if (appTexts.length > 0)
      knowledgeBase.push("=== Ilova sozlamalari ===\n" + appTexts.join("\n\n"));

    const videoCaptions = cameraModel.videoGuides
      .filter((v) => v.caption)
      .map((v) => v.caption as string);
    if (videoCaptions.length > 0)
      knowledgeBase.push("=== Video yo'riqnoma mavzulari ===\n" + videoCaptions.join("\n"));

    const imgCaptions = cameraModel.images
      .filter((i) => i.caption)
      .map((i) => i.caption as string);
    if (imgCaptions.length > 0)
      knowledgeBase.push("=== Qo'shimcha izohlar ===\n" + imgCaptions.join("\n"));
  }

  const isUz = language === "uz" || language === "uz-cyrl";

  // ─ Salomlashish ko'rsatmasi ─
  let greetingNote = "";
  if (shouldGreet && firstName) {
    greetingNote = isUz
      ? `Mijozning ismi: "${firstName}". Salomlashishda ismini aniqlash kerak: agar o'zbek erkak ismi bo'lsa "aka", ayol ismi bo'lsa "opa" qo'sh. Agar ism tanib bo'lmasa shunchaki "Assalomu alaykum" de. Misol: "Assalomu alaykum" (1-xabar) va "Yahshimisiz, Abror aka?" (2-xabar) yoki "Yahshimisiz, Laylo opa?" deb ### bilan ikki xabar qilib yoz.`
      : `Имя клиента: "${firstName}". Поздоровайся и спроси как дела, используя имя естественно.`;
  } else if (shouldGreet) {
    greetingNote = isUz
      ? `Qisqa iliq salom bilan boshlang, ismini bilmasangiz shunchaki "Assalomu alaykum" de va yahshimisiz deb so'ra.`
      : `Начни с короткого тёплого приветствия.`;
  } else {
    greetingNote = isUz
      ? `Salomlashma. To'g'ridan-to'g'ri savollarga javob ber.`
      : `Не здоровайся. Сразу отвечай на вопрос.`;
  }

  // ─ Ulash usuli ko'rsatmasi ─
  let connectionMethodNote = "";
  if (connectionMethod === "long") {
    connectionMethodNote = isUz
      ? "\nMijoz kamerani UZOQ MASOFADAN (uy WiFi routeri orqali, istalgan joydan) ulamoqchi. Yuqoridagi \"Uzoq masofadan ulash yo'riqnomasi\"dan foydalanib, bosqichma-bosqich, aniq savol-javob tarzida yordam bering — butun matnni bir yo'la tashlamang, mijoz qayerda qolganini so'rab-bilib boring."
      : "\nКлиент хочет подключить камеру НА ДАЛЬНЕМ РАССТОЯНИИ (через домашний WiFi роутер, просмотр из любой точки). Используй руководство выше, помогай пошагово, конкретными вопросами и ответами — не выкладывай весь текст сразу.";
  } else if (connectionMethod === "short") {
    connectionMethodNote = isUz
      ? "\nMijoz kamerani QISQA MASOFADAN ulayapti (video yo'riqnoma allaqachon yuborilgan). Savollari bo'lsa video asosida yordam bering."
      : "\nКлиент подключает камеру НА БЛИЗКОМ РАССТОЯНИИ (видеоинструкция уже отправлена). Помогай по вопросам на основе видео.";
  }

  // ─ Qaytarish (refund) siyosati ─
  const refundNote = refundRequested
    ? (isUz
      ? "\nMUHIM — QAYTARISH SIYOSATI: Mijoz pul yoki mahsulotni qaytarishni so'ragan (shu yoki oldingi xabarda). HECH QACHON pul qaytarish yoki mahsulotni qaytarib olishga rozi bo'lmang va va'da bermang — bu elektronika, hech qanday holatda qaytarilmaydi. Lekin buni DOIM iliq, tushunish bilan va kechirim so'rab ayting, qo'pol yoki sovuq bo'lmang. Muammosini diqqat bilan tinglang va uni birga hal qilishni taklif qiling (masalan sozlash bosqichlarini qaytadan ko'rib chiqish)."
      : "\nВАЖНО — ПОЛИТИКА ВОЗВРАТА: Клиент попросил вернуть деньги или товар (в этом или предыдущем сообщении). НИКОГДА не соглашайся на возврат и не обещай его — это электроника, возврат невозможен ни при каких условиях. Но говори об этом ВСЕГДА тепло, с пониманием и извинением, не грубо и не холодно. Внимательно выслушай проблему и предложи решить её вместе (например, ещё раз пройти шаги настройки).")
    : "";

  // ─ System prompt ─
  const systemPrompt = isUz
    ? `Sen EnvoCam kamera do'konining do'stona va samimiy yordamchisisan.

QOIDALAR:
- Hech qachon emoji ishlatma
- Inson kabi gapir: issiq, muloyim, samimiy ohangda — xuddi yaxshi tanish odam kabi
- Rasmiy emas, lekin hurmatli bo'l
- Har bir fikr 1-2 jumladan oshmasin
- Bir nechta fikr bo'lsa ### bilan ajrat (har biri alohida xabar yuboriladi)
- ${greetingNote}
- Mijoz savollariga aniq va amaliy javob ber
- Bilmasang — qo'shimcha ma'lumot so'ra yoki ekran tasvirini tavsiya et
${cameraModel ? `\nKamera modeli: ${cameraModel.name}` : "\nKamera modeli hali aniqlanmagan."}
${knowledgeBase.length > 0
      ? "\nSaqlangan ma'lumotlar (faqat shu ma'lumotlarga tayanibing):\n" + knowledgeBase.join("\n\n")
      : cameraModel
        ? "\nBu kamera uchun hali batafsil ma'lumot yuklanmagan. Umumiy kamera bilimingdan yordam ber."
        : "\nHozircha kamera aniqlanmagan. Umumiy yordam ber va kamera rasmini so'ra."}
${connectionMethodNote}
${refundNote}
${samples.length > 0
      ? "\n\n=== Namuna yozishmalar (shu uslubda gapir) ===\n" + samples.join("\n\n---\n\n")
      : ""}`
    : `Ты дружелюбный помощник магазина камер EnvoCam.

ПРАВИЛА:
- Никогда не используй эмодзи
- Говори по-человечески: тепло, мягко, искренне
- Не официально, но уважительно
- Каждая мысль — не более 1-2 предложений
- Если мыслей несколько — разделяй через ### (каждая часть — отдельное сообщение)
- ${greetingNote}
- Отвечай конкретно и практично
- Если не знаешь — попроси уточнение
${cameraModel ? `\nМодель камеры: ${cameraModel.name}` : "\nМодель камеры ещё не определена."}
${knowledgeBase.length > 0
      ? "\nСохранённые данные:\n" + knowledgeBase.join("\n\n")
      : "\nПодробных данных пока нет. Помогай на основе общих знаний."}
${connectionMethodNote}
${refundNote}
${samples.length > 0
      ? "\n\n=== Примеры общения (придерживайся этого стиля) ===\n" + samples.join("\n\n---\n\n")
      : ""}`;

  const rephraseNote = opts.rephraseHint
    ? (isUz
      ? `\n\nMUHIM: Mijoz oldingi javobingizni TUSHUNMADI. Ayni shu narsani BOSHQACHA, ANCHA SODDAROQ so'zlar bilan, boshqa misol yoki boshqa yo'l bilan tushuntir. Oldingi javobingdagi bir xil jumlalarni TAKRORLAMA.`
      : `\n\nВАЖНО: Клиент НЕ ПОНЯЛ предыдущий ответ. Объясни то же самое ИНАЧЕ, гораздо ПРОЩЕ, другими словами. Не повторяй те же фразы.`)
    : "";

  // Mavjud kontent — AI "yo'q" deb yolg'on aytmasligi uchun (masalan video BOR).
  let contentNote = "";
  if (cameraModel) {
    const avail: string[] = [];
    if (cameraModel.videoGuides.length > 0) avail.push(isUz ? "qisqa masofa uchun VIDEO qo'llanma (bot avtomatik yuboradi)" : "ВИДЕО-инструкция для близкого подключения (бот отправляет автоматически)");
    if (cameraModel.longRangeGuides.length > 0) avail.push(isUz ? "uzoq masofa uchun matnli yo'riqnoma" : "текстовая инструкция для дальнего подключения");
    if (cameraModel.appScreenshots.length > 0) avail.push(isUz ? "ilova sozlamalari ma'lumoti" : "данные о настройках приложения");
    if (avail.length > 0) {
      contentNote = isUz
        ? `\n\nBu model uchun MAVJUD kontent: ${avail.join("; ")}. Mijoz shulardan birini (yoki videoni) so'rasa — "yo'q" DEB AYTMA, "bor, hozir yuboraman" deb ayt.`
        : `\n\nДоступный контент для этой модели: ${avail.join("; ")}. Если клиент просит что-то из этого (или видео) — НЕ говори "нет", скажи "есть, сейчас пришлю".`;
    }
  }

  const storeRules = buildStoreRules(isUz);

  const finalSystemPrompt = (language === "uz-cyrl"
    ? systemPrompt + `\n\nMUHIM: Mijoz sizga kirill yozuvida yozmoqda. Javobingizni FAQAT kirill yozuvida yozing (lotin emas) — masalan "Assalomu alaykum" emas "Ассалому алайкум", "Rahmat" emas "Раҳмат" deb yozing.`
    : systemPrompt) + `\n\n${SHORTHAND_UZ_NOTE}` + contentNote + storeRules + rephraseNote;

  const response = await callClaude("answerQuestion", {
    model: MODEL,
    max_tokens: 1024,
    system: finalSystemPrompt,
    messages: buildMessages(history.slice(-16), question),
  });

  return extractText(response);
}

// ─── Mijoz fikrlarini tahlil qilish ──────────────────────────────────────────

// ─── Mijoz istaklari tahlili (muammolar reytingi) ────────────────────────────

export async function analyzeInsights(
  feedbacks: Array<{
    modelName: string;
    satisfaction?: string;
    wishlist?: string;
    location?: string;
    purpose?: string;
  }>
): Promise<string> {
  if (feedbacks.length === 0) return "Hali so'rovnoma ma'lumotlari to'planmagan.";

  const data = feedbacks
    .map(
      (f, i) =>
        `Mijoz ${i + 1} (${f.modelName}): ` +
        `kamchiliklar="${f.satisfaction ?? ""}" | ` +
        `istaklar="${f.wishlist ?? ""}" | ` +
        `joy="${f.location ?? ""}" | ` +
        `maqsad="${f.purpose ?? ""}"`
    )
    .join("\n");

  const response = await callClaude("analyzeInsights", {
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Quyida ${feedbacks.length} ta mijozdan to'plangan ma'lumotlar bor. Tahlil qil:

VAZIFA:
1. Muammolar reytingi: har bir muammo/shikoyatni aniqlash, nechta odam buni aytganini hisoblash, foizini ko'rsat. Eng ko'p aytilgan muammo YUQORIDA tursin.
2. Istaklari reytingi: har bir istak/xususiyat nechta odam so'raganini, foizini ko'rsat.
3. Joy tahlili: kamera qayerlarga ko'proq o'rnatilmoqda.
4. Maqsad tahlili: asosiy foydalanish maqsadlari.

FORMAT (aynan shu tartibda, o'zbek tilida, emoji yo'q):

Muammolar reytingi (jami ${feedbacks.length} ta so'rov):
1. [Muammo nomi] — [N] ta ([X]%)
2. ...

Istaklari reytingi:
1. [Istak] — [N] ta ([X]%)
2. ...

O'rnatish joylari:
[Joy]: [N] ta ([X]%)
...

Foydalanish maqsadlari:
[Maqsad]: [N] ta ([X]%)
...

MA'LUMOTLAR:
${data}`,
      },
    ],
  });

  return extractText(response) || "Tahlil qilishda xatolik yuz berdi.";
}

// ─── Feedback tahlili (haftalik hisobot) ──────────────────────────────────────

export async function analyzeFeedback(
  feedbacks: Array<ClientFeedback & { modelName: string }>
): Promise<string> {
  const data = feedbacks
    .map(
      (f, i) =>
        `Mijoz ${i + 1} (${f.modelName}):\n` +
        `- Mamnunlik/kamchiliklar: ${f.satisfaction ?? "javob yo'q"}\n` +
        `- Istaklar/xususiyatlar: ${f.wishlist ?? "javob yo'q"}\n` +
        `- O'rnatish joyi: ${f.location ?? "javob yo'q"}\n` +
        `- Foydalanish maqsadi: ${f.purpose ?? "javob yo'q"}\n` +
        `- Narx: ${f.budget ?? "javob yo'q"}`
    )
    .join("\n\n");

  const now = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const dateStr = now.toISOString().slice(0, 10);

  const response = await callClaude("analyzeFeedback", {
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Quyida ${feedbacks.length} ta mijozdan to'plangan kamera bo'yicha fikr-mulohazalar bor. Tahlil qil va do'kon egasiga amaliy haftalik hisobot yoz.

Hisobotda bo'lsin:
1. Eng ko'p uchragan kamchiliklar (kamera modeli bo'yicha guruhlab)
2. Mijozlarning eng ko'p istalgan xususiyatlari
3. Foydalanish joylari va maqsadlari tahlili — mijozlar kamerani qayerga (uy, ofis, bog', ochiq havo) va nima uchun (xavfsizlik, hayvon kuzatish, bola kuzatish va h.k.) ishlatmoqda
4. Narx oralig'i — mijozlar yangi kamera uchun qancha to'lashga tayyor
5. Do'kon uchun AMALIY tavsiyalar: qaysi kamera turlari va modellarni assortimentga qo'shish, qaysilarini olib tashlash, qaysi segmentga (uy/biznes/ochiq havo) e'tibor berish

Sana: ${dateStr}
Jami fikrlar: ${feedbacks.length} ta

Ma'lumotlar:
${data}

Hisobot o'zbek tilida, aniq va amaliy bo'lsin. Emoji ishlatma. Boshida "Haftalik hisobot — ${dateStr}" deb yoz.`,
      },
    ],
  });

  return extractText(response) || "Tahlil qilishda xatolik yuz berdi.";
}
