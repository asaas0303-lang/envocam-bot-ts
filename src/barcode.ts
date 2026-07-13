import sharp from "sharp";
import { createRequire } from "module";
import { readBarcodeDigits, type ImageInput } from "./ai.js";
import { logger } from "./lib/logger.js";

// jsqr'ning .d.ts fayli ESM "export default" sintaksisidan foydalanadi,
// lekin haqiqiy paket UMD/CJS bundle (module.exports = funksiya). Bu
// nomuvofiqlik "moduleResolution: NodeNext" ostida oddiy default importni
// chaqirib bo'lmaydigan qilib qo'yadi — shuning uchun to'g'ridan-to'g'ri
// CJS require orqali yuklaymiz.
const require = createRequire(import.meta.url);
type JsQRFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }
) => { data: string } | null;
const jsQR = require("jsqr") as JsQRFn;

export type BarcodeMethod = "qr" | "ocr_full" | "ocr_last4";

// Bir usul bazadagi modelga mos kelganda qaytadi.
export interface BarcodeMatch {
  method: BarcodeMethod;
  value: string;       // moslashtirilgan raqam (faqat raqamlar; last4 uchun 4 xonali)
  isPartial: boolean;  // last4 (oxirgi 4 raqam) bo'lsa true
}

export interface BarcodeReadOutcome {
  match: BarcodeMatch | null;                          // birinchi mos kelgan usul (bo'lmasa null)
  bestRead: { value: string; method: BarcodeMethod } | null; // mos kelmasa ham, o'qilgan eng yaxshi TO'LIQ raqam (admin xabari uchun)
  qrRaw: string | null;                                // QR ning xom mazmuni (URL ham bo'lishi mumkin) — loglash/diagnostika uchun
}

// Bazadagi modellarga mos-mosligini tekshiruvchi callback — moslik topilgan
// zahoti qimmat AI-OCR chaqiruvlarini to'xtatish uchun ishlatiladi.
export type BarcodeMatcher = (digits: string, isPartial: boolean) => boolean;

// Matn ichidan (masalan QR dagi URL dan) uzun raqam ketma-ketliklarini
// ajratib oladi — eng uzuni birinchi bo'lib qaytadi (barcode odatda eng uzun).
function extractDigitRuns(text: string, minLen: number): string[] {
  const runs = text.match(/\d+/g) ?? [];
  return [...new Set(runs.filter((r) => r.length >= minLen))].sort((a, b) => b.length - a.length);
}

// ─── QR kod dekodlash (AI chaqirmaydi, eng arzon va eng ishonchli usul) ───────

async function decodeQrFromBuffer(buffer: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    return result?.data?.trim() || null;
  } catch {
    return null;
  }
}

async function tryDecodeQR(base64: string): Promise<string | null> {
  const original = Buffer.from(base64, "base64");
  const meta = await sharp(original).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return null;

  // Turli variantlarda urinib ko'ramiz — stiker kichik/burchakda bo'lishi mumkin.
  const variantBuffers: Promise<Buffer>[] = [
    sharp(original).toBuffer(), // original
    sharp(original).resize(w * 2, h * 2).toBuffer(), // 2x kattalashtirilgan
    sharp(original).extract({ // markaz
      left: Math.floor(w * 0.25), top: Math.floor(h * 0.25),
      width: Math.floor(w * 0.5), height: Math.floor(h * 0.5),
    }).resize(w, h).toBuffer(),
    sharp(original).extract({ // past yarmi (stiker ko'pincha pastda)
      left: Math.floor(w * 0.1), top: Math.floor(h * 0.5),
      width: Math.floor(w * 0.8), height: Math.floor(h * 0.5),
    }).resize(w, h).toBuffer(),
    sharp(original).extract({ left: 0, top: 0, width: Math.floor(w * 0.5), height: h }).resize(w, h).toBuffer(), // chap
    sharp(original).extract({ left: Math.floor(w * 0.5), top: 0, width: Math.ceil(w * 0.5), height: h }).resize(w, h).toBuffer(), // o'ng
  ];

  for (const variantPromise of variantBuffers) {
    try {
      const buf = await variantPromise;
      const found = await decodeQrFromBuffer(buf);
      if (found) return found;
    } catch {
      continue;
    }
  }
  return null;
}

// ─── OCR uchun rasmni kattalashtirish + kontrastni oshirish ───────────────────

async function enhanceForOcr(base64: string): Promise<ImageInput> {
  const input = Buffer.from(base64, "base64");
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 800;
  const h = meta.height ?? 600;

  const buffer = await sharp(input)
    .resize(Math.round(w * 2.5), Math.round(h * 2.5))
    .normalize()
    .sharpen()
    .jpeg({ quality: 90 })
    .toBuffer();

  return { base64: buffer.toString("base64"), mimeType: "image/jpeg" };
}

// ─── Asosiy oqim: QR → OCR (to'liq) → OCR (oxirgi 4) ──────────────────────────

// Mijoz rasmidan barcode raqamini avtomatik o'qishga harakat qiladi — mijozdan
// HECH QACHON raqamni qo'lda yozib yuborish so'ralmaydi. Har bir bosqich
// Railway loglariga XOM holda yoziladi. QR dan raqam ajratib olinadi (QR ichida
// URL/serial bo'lishi mumkin), va agar QR raqami bazaga mos kelmasa — to'xtamay,
// bosma raqamni AI-OCR bilan o'qishga o'tadi (chunki QR ba'zan boshqa narsani,
// bosma raqam esa aynan admin kiritgan raqamni bildiradi).
export async function readBarcodeFromImage(
  image: ImageInput,
  chatId: string,
  isKnown: BarcodeMatcher
): Promise<BarcodeReadOutcome> {
  let bestFull: { value: string; method: BarcodeMethod } | null = null;

  // ─ QADAM 1: QR ─
  const qrRaw = await tryDecodeQR(image.base64);
  logger.info({ chatId, qrRaw: qrRaw ?? null }, "barcode: QR dekod xom natijasi");
  const qrRuns = qrRaw ? extractDigitRuns(qrRaw, 8) : [];
  logger.info({ chatId, qrRuns }, "barcode: QR ichidan ajratilgan raqamlar");
  for (const digits of qrRuns) {
    if (!bestFull) bestFull = { value: digits, method: "qr" };
    if (isKnown(digits, false)) {
      logger.info({ chatId, digits }, "barcode: QR raqami bazadagi modelga MOS keldi");
      return { match: { method: "qr", value: digits, isPartial: false }, bestRead: bestFull, qrRaw };
    }
  }

  // ─ OCR uchun rasmni tayyorlash ─
  let enhanced: ImageInput;
  try {
    enhanced = await enhanceForOcr(image.base64);
  } catch (err) {
    logger.error({ err, chatId }, "barcode: OCR uchun rasm tayyorlashda xatolik");
    return { match: null, bestRead: bestFull, qrRaw };
  }

  // ─ QADAM 2: OCR (to'liq raqam) ─
  const full = await readBarcodeDigits(enhanced, "full");
  logger.info({ chatId, full: full ?? null }, "barcode: OCR (to'liq raqam) natijasi");
  if (full) {
    if (!bestFull || bestFull.method === "qr") bestFull = { value: full, method: "ocr_full" };
    if (isKnown(full, false)) {
      logger.info({ chatId, full }, "barcode: OCR to'liq raqami bazadagi modelga MOS keldi");
      return { match: { method: "ocr_full", value: full, isPartial: false }, bestRead: bestFull, qrRaw };
    }
  }

  // ─ QADAM 3: OCR (oxirgi 4 raqam) ─
  const last4 = await readBarcodeDigits(enhanced, "last4");
  logger.info({ chatId, last4: last4 ?? null }, "barcode: OCR (oxirgi 4 raqam) natijasi");
  if (last4 && isKnown(last4, true)) {
    logger.info({ chatId, last4 }, "barcode: OCR oxirgi-4 raqami bazadagi modelga MOS keldi");
    return { match: { method: "ocr_last4", value: last4, isPartial: true }, bestRead: bestFull, qrRaw };
  }

  logger.info(
    { chatId, bestRead: bestFull?.value ?? null },
    "barcode: hech qaysi usul bilan MOS model topilmadi"
  );
  return { match: null, bestRead: bestFull, qrRaw };
}
