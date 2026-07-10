import Anthropic from "@anthropic-ai/sdk";
import type { CameraModel, ClientFeedback, MessageRecord } from "./data/store.js";

const anthropic = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

const MODEL = "claude-sonnet-5";

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

// Mijoz rasm(lar)ini namuna rasmlar bilan solishtirib model aniqlaydi
export async function identifyModelFromImages(
  clientImages: ImageInput[],
  models: { name: string; refImages: ImageInput[] }[]
): Promise<{ status: "matched" | "unclear" | "no_match"; model: string | null }> {
  if (clientImages.length === 0) return { status: "unclear", model: null };

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  const modelNames = models.map((m) => m.name);
  const withRefs = models.filter((m) => m.refImages.length > 0);

  if (withRefs.length > 0) {
    content.push({
      type: "text",
      text: "Quyida do'kondagi kameralarning NAMUNA rasmlari, har biri model nomi bilan belgilangan:",
    });
    const sorted = [...withRefs].sort((a, b) => a.name.localeCompare(b.name));
    for (const m of sorted) {
      for (let i = 0; i < m.refImages.length; i++) {
        content.push({ type: "text", text: `Model: ${m.name} — namuna ${i + 1}` });
        content.push(toImageBlock(m.refImages[i]!));
      }
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

Vazifa:
1. Avval mijoz rasmidagi karobka yoki kamera ustidagi YOZUVLARNI o'qi — model raqami ko'pincha karobkada yozilgan bo'ladi, bu eng ishonchli belgi.
2. Keyin mijoz rasmini yuqoridagi namuna rasmlar bilan vizual solishtir.
3. Bir nechta rasm bo'lsa, hammasidan foydalanib eng aniq javobni ber.
Mos modelni topishga imkon qadar harakat qil. Faqat haqiqatan aniqlab bo'lmasa "unclear" de. Ro'yxatdagi hech bir modelga to'g'ri kelmasa "no_match" de.
Faqat JSON qaytar: {"status": "matched|unclear|no_match", "model": "nom yoki null"}`,
  });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content }],
  });

  const block = response.content[0];
  if (block.type !== "text") return { status: "no_match", model: null };
  try {
    const jsonMatch = block.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: "no_match", model: null };
    return JSON.parse(jsonMatch[0]) as { status: "matched" | "unclear" | "no_match"; model: string | null };
  } catch {
    return { status: "no_match", model: null };
  }
}

// ─── Niyat aniqlash ───────────────────────────────────────────────────────────

export interface IntentResult {
  intent: "greeting" | "gratitude" | "question" | "cannot_send_photo" | "connect_camera";
  connectionMethod: "short" | "long" | null;
}

export async function detectIntent(text: string): Promise<IntentResult> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 96,
    messages: [
      {
        role: "user",
        content: `Faqat JSON qaytar: {"intent": "greeting|gratitude|question|cannot_send_photo|connect_camera", "connectionMethod": "short|long|null"}

INTENT (bittasini tanla):
- greeting: salom, assalomu alaykum, hi, hello, privjet, zdravstvujte
- gratitude: rahmat, xo'p, ok, yaxshi, bo'ldi, ishladi, uladim, barakalla, zo'r, spasibo
- cannot_send_photo: rasm yubora olmayotganini aytmoqda
- connect_camera: kamerani ulash/sozlashda yordam so'ramoqda (masalan: "kamerani qanday ulashman", "ulashga yordam bering", "sozlab bera olasizmi")
- question: yuqoridagilarga to'g'ri kelmaydigan boshqa har qanday savol yoki muammo

CONNECTION METHOD — faqat xabarda ANIQ tilga olingan bo'lsa ko'rsat, aks holda null:
- "short": qisqa masofa, kamera WiFi'siga to'g'ridan-to'g'ri ulanish, yaqin masofadan
- "long": uzoq masofa, uy/router WiFi'si orqali, istalgan joydan (uzoqdan) ko'rish

Xabar: "${text}"`,
      },
    ],
  });

  const fallback: IntentResult = { intent: "question", connectionMethod: null };
  const block = response.content[0];
  if (block.type !== "text") return fallback;
  try {
    const jsonMatch = block.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as { intent?: string; connectionMethod?: string | null };
    const validIntents = ["greeting", "gratitude", "cannot_send_photo", "connect_camera", "question"];
    const intent = validIntents.includes(parsed.intent ?? "")
      ? (parsed.intent as IntentResult["intent"])
      : "question";
    const connectionMethod =
      parsed.connectionMethod === "short" || parsed.connectionMethod === "long"
        ? parsed.connectionMethod
        : null;
    return { intent, connectionMethod };
  } catch {
    return fallback;
  }
}

// ─── Matndan rasm matnini o'qish ──────────────────────────────────────────────

export async function extractTextFromImage(
  imageBase64: string,
  mimeType: string
): Promise<string> {
  const response = await anthropic.messages.create({
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
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

// ─── Savollarga javob ─────────────────────────────────────────────────────────

export interface AnswerOptions {
  question: string;
  language: "uz" | "uz-cyrl" | "ru";
  cameraModel: CameraModel | undefined;
  connectionMethod?: "short" | "long"; // aniqlangan bo'lsa: uzoq/qisqa masofa
  firstName?: string;
  shouldGreet: boolean;       // bu xabarda salom berish kerakmi
  history: MessageRecord[];   // oldingi xabarlar
  samples: string[];          // namuna yozishmalar
}

export async function answerQuestion(opts: AnswerOptions): Promise<string> {
  const { question, language, cameraModel, connectionMethod, firstName, shouldGreet, history, samples } = opts;

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
${samples.length > 0
      ? "\n\n=== Примеры общения (придерживайся этого стиля) ===\n" + samples.join("\n\n---\n\n")
      : ""}`;

  const finalSystemPrompt = language === "uz-cyrl"
    ? systemPrompt + `\n\nMUHIM: Mijoz sizga kirill yozuvida yozmoqda. Javobingizni FAQAT kirill yozuvida yozing (lotin emas) — masalan "Assalomu alaykum" emas "Ассалому алайкум", "Rahmat" emas "Раҳмат" deb yozing.`
    : systemPrompt;

  // ─ Tarix ─
  const historyMessages = history.slice(-16).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: finalSystemPrompt,
    messages: [
      ...historyMessages,
      { role: "user", content: question },
    ],
  });

  const block = response.content[0];
  return block.type === "text" ? block.text : "";
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

  const response = await anthropic.messages.create({
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

  const block = response.content[0];
  return block.type === "text" ? block.text : "Tahlil qilishda xatolik yuz berdi.";
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

  const response = await anthropic.messages.create({
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

  const answerBlock = response.content[0];
  return answerBlock.type === "text" ? answerBlock.text : "Tahlil qilishda xatolik yuz berdi.";
}
