import type { ClientData, ModelRequestEntry } from "./data/store.js";

// ─── Umumiy statistika ───────────────────────────────────────────────────────

export function formatGeneralStats(clients: ClientData[]): string {
  return `Umumiy statistika:\n\nJami mijozlar: ${clients.length} ta`;
}

// ─── Eng ko'p so'ralgan modellar reytingi ────────────────────────────────────

export function formatModelRanking(requests: ModelRequestEntry[]): string {
  if (requests.length === 0) {
    return "Hali model so'rovlari to'planmagan.";
  }

  const byText = new Map<string, Set<string>>();
  for (const r of requests) {
    const key = r.requestedText.trim();
    if (!key) continue;
    if (!byText.has(key)) byText.set(key, new Set());
    byText.get(key)!.add(r.chatId);
  }

  const rows = [...byText.entries()].map(([text, chatIds]) => ({ text, count: chatIds.size }));
  rows.sort((a, b) => b.count - a.count);

  const lines = rows.slice(0, 10).map((r, i) => `${i + 1}. "${r.text}" — ${r.count} ta mijoz`);
  return `Eng ko'p so'ralgan modellar (top 10):\n\n${lines.join("\n")}`;
}

// ─── Bazada topilmagan modellar (talab bor, mahsulot yo'q) ─────────────────

export function formatMissingModelsRanking(requests: ModelRequestEntry[]): string {
  const notFound = requests.filter((r) => !r.foundInDb && r.requestedText.trim());
  if (notFound.length === 0) {
    return "Bazada topilmagan model so'rovlari hali yo'q.";
  }

  const byText = new Map<string, Set<string>>();
  for (const r of notFound) {
    const key = r.requestedText.trim();
    if (!byText.has(key)) byText.set(key, new Set());
    byText.get(key)!.add(r.chatId);
  }

  const rows = [...byText.entries()].map(([text, chatIds]) => ({ text, count: chatIds.size }));
  rows.sort((a, b) => b.count - a.count);

  const lines = rows.slice(0, 20).map((r, i) => `${i + 1}. "${r.text}" — ${r.count} ta mijoz`);
  return `Bazada topilmagan modellar (talab bor, mahsulot yo'q):\n\n${lines.join("\n")}`;
}

// ─── Kunlik/haftalik yangi mijozlar soni ─────────────────────────────────────

export function formatNewClientsStats(clients: ClientData[]): string {
  if (clients.length === 0) {
    return "Hali mijozlar yo'q.";
  }

  const dayOf = (iso: string) => iso.slice(0, 10);
  const today = dayOf(new Date().toISOString());
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const newToday = clients.filter((c) => dayOf(c.firstSeen) === today).length;
  const newThisWeek = clients.filter((c) => new Date(c.firstSeen).getTime() >= weekAgoMs).length;

  return (
    `Yangi mijozlar:\n\n` +
    `Bugun: ${newToday} ta\n` +
    `Oxirgi 7 kunda: ${newThisWeek} ta`
  );
}

// ─── Yordamchi: Toshkent vaqti ────────────────────────────────────────────────

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_NAMES_UZ = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];

function tashkentDate(iso: string): Date {
  return new Date(new Date(iso).getTime() + TASHKENT_OFFSET_MS);
}

// ─── Soat bo'yicha faollik xaritasi ─────────────────────────────────────────

export function formatHourlyActivity(requests: ModelRequestEntry[]): string {
  if (requests.length === 0) {
    return "Hali so'rovlar to'planmagan.";
  }

  const hourCounts = new Array(24).fill(0);
  for (const r of requests) {
    hourCounts[tashkentDate(r.requestedAt).getUTCHours()]++;
  }

  const rows = hourCounts.map((count, hour) => ({ hour, count })).filter((h) => h.count > 0);
  const busiest = [...rows].sort((a, b) => b.count - a.count || a.hour - b.hour).slice(0, 3);
  const quietest = [...rows].sort((a, b) => a.count - b.count || a.hour - b.hour).slice(0, 3);

  const fmt = (h: { hour: number; count: number }) => `${String(h.hour).padStart(2, "0")}:00-${String((h.hour + 1) % 24).padStart(2, "0")}:00 (${h.count} ta)`;

  return (
    `Soat bo'yicha faollik xaritasi (Toshkent vaqti):\n\n` +
    `Eng faol: ${busiest.map(fmt).join(", ")}\n` +
    `Eng jim: ${quietest.map(fmt).join(", ")}`
  );
}

// ─── Hafta kuni bo'yicha faollik ─────────────────────────────────────────────

export function formatWeekdayActivity(requests: ModelRequestEntry[]): string {
  if (requests.length === 0) {
    return "Hali so'rovlar to'planmagan.";
  }

  const dayCounts = new Array(7).fill(0);
  for (const r of requests) {
    dayCounts[tashkentDate(r.requestedAt).getUTCDay()]++;
  }

  const rows = dayCounts.map((count, day) => ({ day, count })).sort((a, b) => b.count - a.count);
  const lines = rows.map((r, i) => `${i + 1}. ${DAY_NAMES_UZ[r.day]} — ${r.count} ta`);

  return `Hafta kuni bo'yicha faollik (kamayish tartibida):\n\n${lines.join("\n")}`;
}

// ─── Haftalik yangi mijozlar dinamikasi (oxirgi 4 hafta) ────────────────────

function weekStartUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d;
}

function pctChangeLabel(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "0%" : "yangi";
  const pct = Math.round(((cur - prev) / prev) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

export function formatWeeklyNewClientsTrend(clients: ClientData[]): string {
  if (clients.length === 0) {
    return "Hali mijozlar yo'q.";
  }

  const WEEKS_BACK = 5; // 4 tasi ko'rsatiladi, 1 tasi eng eskisi bilan taqqoslash uchun
  const now = new Date();
  const counts: number[] = [];

  for (let i = WEEKS_BACK - 1; i >= 0; i--) {
    const start = weekStartUTC(new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000));
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    const count = clients.filter((c) => {
      const t = new Date(c.firstSeen).getTime();
      return t >= start.getTime() && t < end.getTime();
    }).length;
    counts.push(count);
  }

  const lines: string[] = [];
  for (let i = 1; i < counts.length; i++) {
    const start = weekStartUTC(new Date(now.getTime() - (WEEKS_BACK - 1 - i) * 7 * 24 * 60 * 60 * 1000));
    const label = start.toISOString().slice(0, 10);
    lines.push(`${label}: ${counts[i]} ta (${pctChangeLabel(counts[i], counts[i - 1])})`);
  }

  return `Haftalik yangi mijozlar dinamikasi (dushanbadan boshlab):\n\n${lines.join("\n")}`;
}

// ─── Qaytgan mijozlar foizi ──────────────────────────────────────────────────
// "Qaytgan" — bir martadan ortiq so'rov yuborgan (kamida 2 ta so'rov) noyob chatId.

export function formatReturningRate(requests: ModelRequestEntry[]): string {
  if (requests.length === 0) {
    return "Hali so'rovlar to'planmagan.";
  }

  const byChatId = new Map<string, number>();
  for (const r of requests) {
    byChatId.set(r.chatId, (byChatId.get(r.chatId) ?? 0) + 1);
  }

  const total = byChatId.size;
  const returning = [...byChatId.values()].filter((count) => count > 1).length;
  const pct = total > 0 ? Math.round((returning / total) * 100) : 0;

  return `Qaytgan mijozlar: ${pct}% (${total} tadan ${returning} tasi)`;
}

// ─── "Umidsiz" mijozlar — hech qachon o'z modelini topmagan ─────────────────

export function formatHopelessClients(requests: ModelRequestEntry[], clients: ClientData[]): string {
  if (requests.length === 0) {
    return "Hali so'rovlar to'planmagan.";
  }

  const byChatId = new Map<string, ModelRequestEntry[]>();
  for (const r of requests) {
    if (!byChatId.has(r.chatId)) byChatId.set(r.chatId, []);
    byChatId.get(r.chatId)!.push(r);
  }

  const clientById = new Map(clients.map((c) => [c.chatId, c]));
  const hopeless = [...byChatId.entries()]
    .filter(([, entries]) => entries.every((e) => !e.foundInDb))
    .map(([chatId, entries]) => ({ chatId, attempts: entries.length }))
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, 15);

  if (hopeless.length === 0) {
    return "Hech qachon modelini topolmagan mijoz yo'q — hammasi yaxshi.";
  }

  const lines = hopeless.map((h, i) => {
    const client = clientById.get(h.chatId);
    const name = client?.firstName?.trim() || (client?.username ? "@" + client.username : "...") + h.chatId.slice(-4);
    return `${i + 1}. ${name} — ${h.attempts} marta urindi, hech biri topilmadi`;
  });

  return `"Umidsiz" mijozlar (hech qachon modelini topmagan):\n\n${lines.join("\n")}`;
}

// ─── Model qamrov foizi ──────────────────────────────────────────────────────

export function formatCoverageRate(requests: ModelRequestEntry[]): string {
  if (requests.length === 0) {
    return "Hali so'rovlar to'planmagan.";
  }
  const found = requests.filter((r) => r.foundInDb).length;
  const pct = Math.round((found / requests.length) * 100);
  return `Qamrov: ${pct}% (${requests.length} tadan ${found} tasi bazada topilgan)`;
}

// ─── Eng band kun (rekord) ────────────────────────────────────────────────────

export function formatBusiestDay(requests: ModelRequestEntry[]): string {
  if (requests.length === 0) {
    return "Hali so'rovlar to'planmagan.";
  }

  const byDate = new Map<string, number>();
  for (const r of requests) {
    const key = tashkentDate(r.requestedAt).toISOString().slice(0, 10);
    byDate.set(key, (byDate.get(key) ?? 0) + 1);
  }

  const [date, count] = [...byDate.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return `Eng band kun: ${date} — ${count} ta so'rov`;
}

// ─── /start bosib-u so'rov yubormagan mijozlar ──────────────────────────────

export function formatSilentStarters(clients: ClientData[], requests: ModelRequestEntry[]): string {
  if (clients.length === 0) {
    return "Hali mijozlar yo'q.";
  }

  const chatIdsWithRequests = new Set(requests.map((r) => r.chatId));
  const silent = clients.filter((c) => !chatIdsWithRequests.has(c.chatId));
  const pct = Math.round((silent.length / clients.length) * 100);

  return `${clients.length} mijozdan ${silent.length} tasi hech narsa yozmagan — ${pct}%`;
}

// ─── Haftalik avtomatik xulosa (adminga yuboriladigan qisqa matn) ──────────

export function formatWeeklyAdminSummary(clients: ClientData[], requests: ModelRequestEntry[]): string {
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const newThisWeek = clients.filter((c) => new Date(c.firstSeen).getTime() >= weekAgoMs).length;

  const byModel = new Map<string, Set<string>>();
  const byMissing = new Map<string, Set<string>>();
  for (const r of requests) {
    const key = r.requestedText.trim();
    if (!key) continue;
    if (!byModel.has(key)) byModel.set(key, new Set());
    byModel.get(key)!.add(r.chatId);
    if (!r.foundInDb) {
      if (!byMissing.has(key)) byMissing.set(key, new Set());
      byMissing.get(key)!.add(r.chatId);
    }
  }

  const top = (m: Map<string, Set<string>>) =>
    [...m.entries()]
      .map(([text, ids]) => ({ text, count: ids.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((r, i) => `${i + 1}. "${r.text}" — ${r.count} ta`)
      .join("\n") || "(yo'q)";

  const found = requests.filter((r) => r.foundInDb).length;
  const coveragePct = requests.length > 0 ? Math.round((found / requests.length) * 100) : 0;

  return (
    `📊 Haftalik xulosa\n\n` +
    `Yangi mijozlar (oxirgi 7 kun): ${newThisWeek} ta\n\n` +
    `Top-3 eng ko'p so'ralgan model:\n${top(byModel)}\n\n` +
    `Top-3 eng ko'p topilmagan model:\n${top(byMissing)}\n\n` +
    `Qamrov: ${coveragePct}% (${requests.length} tadan ${found} tasi bazada topilgan)`
  );
}
