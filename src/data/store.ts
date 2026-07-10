import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Railway'da volume ulanganda bu papka doimiy diskka ishora qiladi;
// bo'lmasa (masalan lokal ishga tushirishda) loyiha papkasiga yoziladi.
const DATA_DIR = process.env["RAILWAY_VOLUME_MOUNT_PATH"] || path.join(__dirname, "..", "..");
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

export interface CameraModel {
  name: string;
  images: ImageItem[];
  manualImages: ManualImageItem[];
  appScreenshots: ManualImageItem[];
  videoGuides: ImageItem[];
  reviewVoiceFileId?: string;
  reviewVideoFileId?: string;
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
  lastInteractionDate?: string;
  region?: string;
  feedbackStage?: FeedbackStage;
  feedback?: ClientFeedback;
  feedbackAskedAt?: string;
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
  cachedInsights?: CachedInsights;
}

interface DbShape {
  models: CameraModel[];
  clients: ClientData[];
  samples: Sample[];
  reports: ReportsMeta;
}

function loadDb(): DbShape {
  if (existsSync(DATA_FILE)) {
    try {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DbShape>;
      return {
        models: parsed.models ?? [],
        clients: parsed.clients ?? [],
        samples: parsed.samples ?? [],
        reports: parsed.reports ?? {},
      };
    } catch {
      return { models: [], clients: [], samples: [], reports: {} };
    }
  }
  return { models: [], clients: [], samples: [], reports: {} };
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
};
