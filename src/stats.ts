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
