import type { Context } from "telegraf";
import axios from "axios";

// Faqat o'zbek kirillchasida uchraydigan harflar (rus alifbosida yo'q): Q, G', H, O' harflarining kirillchasi
const UZ_CYRILLIC_CHARS = /[\u049A\u049B\u0492\u0493\u04B2\u04B3\u040E\u045E]/;
// Kirillcha yozilgan bo'lsa ham, bu so'zlar odatda o'zbekcha (ruscha emas)
const UZ_CYRILLIC_WORDS = /(\u0430\u0441\u0441\u0430\u043B\u043E\u043C\u0443|\u0430\u043B\u0435\u0439\u043A\u0443\u043C|\u0430\u043B\u0430\u0439\u043A\u0443\u043C|\u0440\u0430\u0445\u043C\u0430\u0442|\u0440\u0430\u04B3\u043C\u0430\u0442|\u044F\u0445\u0448\u0438\u043C\u0438\u0441\u0438\u0437|\u044F\u0445\u0448\u0438|\u0445\u0430\u0439\u0440|\u049B\u0430\u043D\u0434\u0430\u0439|\u043A\u0430\u043D\u0430\u043A\u0430|\u043D\u0438\u043C\u0430|\u049B\u0430\u0447\u043E\u043D|\u043A\u0430\u0447\u043E\u043D|\u043A\u0435\u0440\u0430\u043A|\u0431\u0443\u043B\u0430\u0434\u0438)/i;

export function detectLanguage(text: string): "uz" | "uz-cyrl" | "ru" {
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicCount > 0 && (UZ_CYRILLIC_CHARS.test(text) || UZ_CYRILLIC_WORDS.test(text))) {
    return "uz-cyrl";
  }
  if (/o['\u2018\u2019 ]/i.test(text)) return "uz";
  if (cyrillicCount > 3) return "ru";
  return "uz";
}

export function getAdminIds(): string[] {
  const raw = process.env["ADMIN_IDS"] || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdmin(userId: number | string): boolean {
  return getAdminIds().includes(String(userId));
}

// ai.ts kabi bot/ctx obyektiga ega bo'lmagan modullardan ham adminlarga
// to'g'ridan-to'g'ri Telegram Bot API orqali xabar yuborish uchun.
export async function notifyAdmins(text: string): Promise<void> {
  const token = process.env["BOT_TOKEN"] || process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return;
  for (const adminId of getAdminIds()) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: adminId,
        text,
      });
    } catch {
      // adminga yetkazib bo'lmasa ham botning asosiy oqimi to'xtamasin
    }
  }
}

export async function downloadFileAsBase64(
  ctx: Context,
  fileId: string
): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const file = await ctx.telegram.getFile(fileId);
    const token = process.env["BOT_TOKEN"] || process.env["TELEGRAM_BOT_TOKEN"]!;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data as ArrayBuffer);
    const base64 = buffer.toString("base64");
    const fp = file.file_path || "";
    let mimeType = "image/jpeg";
    if (fp.endsWith(".png")) mimeType = "image/png";
    else if (fp.endsWith(".gif")) mimeType = "image/gif";
    else if (fp.endsWith(".webp")) mimeType = "image/webp";
    return { base64, mimeType };
  } catch {
    return null;
  }
}

// Telegram file_id lar o'zgarmas — base64 ni xotirada keshlaymiz
const fileCache = new Map<string, { base64: string; mimeType: string }>();

export async function downloadFileCached(
  ctx: Context,
  fileId: string
): Promise<{ base64: string; mimeType: string } | null> {
  const cached = fileCache.get(fileId);
  if (cached) return cached;
  const dl = await downloadFileAsBase64(ctx, fileId);
  if (dl) fileCache.set(fileId, dl);
  return dl;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}

export async function sendSplitMessages(
  ctx: Context,
  text: string,
  chatId?: number | string
): Promise<void> {
  const parts = text.split("###").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (chatId) {
      await ctx.telegram.sendMessage(chatId, part);
    } else {
      await ctx.reply(part);
    }
    if (parts.length > 1) {
      await sleep(800);
    }
  }
}
