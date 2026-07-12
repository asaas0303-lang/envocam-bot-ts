import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { Context } from "telegraf";
import sharp from "sharp";
import { DATA_DIR, modelsStore, type CameraModel } from "./data/store.js";
import { downloadFileCached } from "./helpers.js";
import { logger } from "./lib/logger.js";

// "Rasmlar" kategoriyasidan qancha rasm taqqoslash kollajiga kiritiladi.
// Admin bundan ko'proq yuklashi mumkin, lekin faqat birinchi shuncha
// (yuklangan tartibda) kollajga qo'shiladi.
export const COLLAGE_MAX_IMAGES = 12;

const CELL_SIZE = 400;
const COLLAGE_DIR = path.join(DATA_DIR, "collages");

export interface CollageImage {
  base64: string;
  mimeType: string;
}

function sourceHashOf(fileIds: string[]): string {
  return createHash("sha1").update(fileIds.join("|")).digest("hex").slice(0, 16);
}

function collageFilePath(modelName: string): string {
  const safe = modelName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(COLLAGE_DIR, `${safe}.jpg`);
}

function gridDims(n: number): { cols: number; rows: number } {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

// strict=true bo'lsa xatoni yutmaydi, aniq xabar bilan tashlaydi
// (diagnostika uchun). strict=false bo'lsa avvalgidek jim o'tkazib yuboradi.
async function toCellBuffer(base64: string, strict: boolean, label: string): Promise<Buffer | null> {
  try {
    const input = Buffer.from(base64, "base64");
    return await sharp(input)
      .resize(CELL_SIZE, CELL_SIZE, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
      .toBuffer();
  } catch (err) {
    if (strict) throw new Error(`${label}: sharp qayta ishlay olmadi — ${(err as Error).message}`);
    return null;
  }
}

async function buildGrid(cellBuffers: Buffer[]): Promise<Buffer> {
  const { cols, rows } = gridDims(cellBuffers.length);
  const composites = cellBuffers.map((buf, i) => ({
    input: buf,
    left: (i % cols) * CELL_SIZE,
    top: Math.floor(i / cols) * CELL_SIZE,
  }));

  return sharp({
    create: {
      width: cols * CELL_SIZE,
      height: rows * CELL_SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toBuffer();
}

// Model uchun taqqoslash kollaji — bir nechta namuna rasmni bitta grid
// rasmga birlashtiradi. strict=false (odatiy, mijozlarga xizmat ko'rsatish
// yo'li) — har qanday muammoda jim o'tkazib yuboradi/null qaytaradi.
// strict=true (diagnostika) — birinchi muammoda aniq xabar bilan xato
// tashlaydi, hech narsa yutilmaydi.
async function buildCollageInternal(
  ctx: Context,
  model: CameraModel,
  strict: boolean
): Promise<CollageImage | null> {
  const refs = (model.images || []).slice(0, COLLAGE_MAX_IMAGES);
  if (refs.length === 0) {
    if (strict) throw new Error("Bu model uchun 'Rasmlar' kategoriyasida hech qanday rasm yo'q.");
    return null;
  }

  const fileIds = refs.map((r) => r.file_id);
  const sourceHash = sourceHashOf(fileIds);
  const filePath = collageFilePath(model.name);

  if (model.refCollage && model.refCollage.sourceHash === sourceHash && existsSync(filePath)) {
    try {
      const buf = readFileSync(filePath);
      return { base64: buf.toString("base64"), mimeType: "image/jpeg" };
    } catch {
      // fayl o'qilmasa — pastda qaytadan yasaymiz
    }
  }

  const downloads = await Promise.all(refs.map((r) => downloadFileCached(ctx, r.file_id)));
  const cellBuffers: Buffer[] = [];
  for (let i = 0; i < downloads.length; i++) {
    const dl = downloads[i];
    const ref = refs[i]!;
    const label = `${i + 1}-rasm (file_id: ${ref.file_id.slice(0, 20)}...)`;
    if (!dl) {
      if (strict) throw new Error(`${label}: Telegram'dan yuklab olinmadi.`);
      continue;
    }
    const cell = await toCellBuffer(dl.base64, strict, label);
    if (cell) cellBuffers.push(cell);
  }

  if (cellBuffers.length === 0) {
    if (strict) throw new Error("Hech qanday rasm muvaffaqiyatli qayta ishlanmadi.");
    return null;
  }

  const gridBuffer = await buildGrid(cellBuffers);

  if (cellBuffers.length === refs.length) {
    // Faqat barcha rasmlar muvaffaqiyatli yuklab olinganda keshlaymiz —
    // aks holda keyingi safar qayta urinib ko'rsin.
    if (!existsSync(COLLAGE_DIR)) mkdirSync(COLLAGE_DIR, { recursive: true });
    writeFileSync(filePath, gridBuffer);
    model.refCollage = { path: filePath, sourceHash, generatedAt: new Date().toISOString() };
    modelsStore.save(model);
  }

  return { base64: gridBuffer.toString("base64"), mimeType: "image/jpeg" };
}

export async function getModelCollage(
  ctx: Context,
  model: CameraModel
): Promise<CollageImage | null> {
  try {
    return await buildCollageInternal(ctx, model, false);
  } catch (err) {
    logger.error({ err, model: model.name }, "getModelCollage failed");
    return null;
  }
}

// /diag buyrug'i uchun — xatoni yutmaydi, sabab aniq ko'rinsin deb.
export async function rebuildModelCollageForDiagnostics(
  ctx: Context,
  model: CameraModel
): Promise<CollageImage | null> {
  return buildCollageInternal(ctx, model, true);
}
