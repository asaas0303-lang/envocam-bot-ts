import type { Context } from "telegraf";
import axios from "axios";
import type { CameraModel } from "./data/store.js";

export function detectLanguage(text: string): "uz" | "ru" {
  if (/[\u049B\u0493\u04B3\u04AF]/i.test(text)) return "uz";
  if (/o['\u2018\u2019 ]/i.test(text)) return "uz";
  if ((text.match(/[\u0430-\u044F]/g) || []).length > 3) return "ru";
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

// Model uchun namuna rasmlarni (birinchi `cap` ta) yuklab beradi
export async function getModelRefImages(
  ctx: Context,
  model: CameraModel,
  cap = 3
): Promise<{ base64: string; mimeType: string }[]> {
  const refs = (model.images || []).slice(0, cap);
  const out: { base64: string; mimeType: string }[] = [];
  for (const img of refs) {
    const dl = await downloadFileCached(ctx, img.file_id);
    if (dl) out.push(dl);
  }
  return out;
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
