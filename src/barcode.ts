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

export interface BarcodeReadResult {
  barcode: string | null;
  method: BarcodeMethod | null;
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
// Railway loglariga yoziladi, shunda keyinchalik qaysi usul qanchalik
// ishlayotganini ko'rish mumkin.
export async function readBarcodeFromImage(
  image: ImageInput,
  chatId: string
): Promise<BarcodeReadResult> {
  const qr = await tryDecodeQR(image.base64);
  logger.info({ chatId, qr: qr ?? null }, "barcode: QR dekod urinildi");
  if (qr) return { barcode: qr, method: "qr" };

  let enhanced: ImageInput;
  try {
    enhanced = await enhanceForOcr(image.base64);
  } catch (err) {
    logger.error({ err, chatId }, "barcode: OCR uchun rasm tayyorlashda xatolik");
    return { barcode: null, method: null };
  }

  const full = await readBarcodeDigits(enhanced, "full");
  logger.info({ chatId, full: full ?? null }, "barcode: OCR (to'liq raqam) urinildi");
  if (full) return { barcode: full, method: "ocr_full" };

  const last4 = await readBarcodeDigits(enhanced, "last4");
  logger.info({ chatId, last4: last4 ?? null }, "barcode: OCR (oxirgi 4 raqam) urinildi");
  if (last4) return { barcode: last4, method: "ocr_last4" };

  logger.info({ chatId }, "barcode: hech qanday usul bilan topilmadi");
  return { barcode: null, method: null };
}
