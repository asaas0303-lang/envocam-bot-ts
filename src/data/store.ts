import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Railway'da volume ulanganda bu papka doimiy diskka ishora qiladi;
// bo'lmasa (masalan lokal ishga tushirishda) loyiha papkasiga yoziladi.
export const DATA_DIR = process.env["RAILWAY_VOLUME_MOUNT_PATH"] || path.join(__dirname, "..", "..");
const DATA_FILE = path.join(DATA_DIR, "data.json");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export interface CameraModel {
  name: string;
  videoFileId?: string;             // Video qo'llanma — Telegram fayl (file_id)
  videoCaption?: string;
  videoLink?: string;               // Video qo'llanma — havola (videoFileId o'rniga)
  setupLink?: string;               // Kamerani sozlash uchun ilova/portal havolasi
  description?: string;             // Qo'shimcha izoh (ixtiyoriy)
}

export interface ClientData {
  chatId: string;
  firstName?: string;
  username?: string;
  firstSeen: string;
  lastSeen: string;
}

// Mijoz model aniqlashga har bir URINISHI — natijasidan (topildi/topilmadi)
// qat'i nazar. Statistika uchun: eng ko'p so'ralgan modellar va bazada
// yo'q (talab bor-u mahsulot yo'q) modellar ro'yxati shundan hisoblanadi.
export interface ModelRequestEntry {
  chatId: string;
  requestedText: string;
  foundInDb: boolean;
  matchedModelName?: string;
  requestedAt: string;
}

interface DbShape {
  models: CameraModel[];
  clients: ClientData[];
  modelRequests: ModelRequestEntry[];
}

function emptyDb(): DbShape {
  return { models: [], clients: [], modelRequests: [] };
}

function loadDb(): DbShape {
  if (existsSync(DATA_FILE)) {
    try {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DbShape>;
      return {
        models: parsed.models ?? [],
        clients: parsed.clients ?? [],
        modelRequests: parsed.modelRequests ?? [],
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
};

// ponytail: fayl asosida (JSON) saqlanadi, har yozuvda butun DB qayta yoziladi
// — 10,000+ mijozda bu sekinlashadi. Katta hajmda PostgreSQL'ga o'tkazish kerak.
export const modelRequestsStore = {
  getAll(): ModelRequestEntry[] {
    return db.modelRequests;
  },
  record(requestedText: string, chatId: string, foundInDb: boolean, matchedModelName?: string): void {
    db.modelRequests.push({ chatId, requestedText, foundInDb, matchedModelName, requestedAt: new Date().toISOString() });
    persist();
  },
};
