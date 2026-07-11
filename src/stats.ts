import { REGIONS, type ActivityEvent, type ClientData, type IssueCategory, type ModelMention, type RefundEvent } from "./data/store.js";

export function formatRegionStats(clients: ClientData[]): string {
  const counts = new Map<string, number>();
  for (const region of REGIONS) counts.set(region, 0);

  let noRegion = 0;
  for (const c of clients) {
    if (c.region && c.region.trim()) {
      const key = c.region.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      noRegion++;
    }
  }

  const total = clients.length;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.map(([region, count], i) => {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `${i + 1}. ${region} — ${count} ta (${pct}%)`;
  });

  let text = `Joylashuv statistikasi (jami ${total} mijoz):\n\n${lines.join("\n")}`;
  if (noRegion > 0) text += `\n\nJoylashuvi noma'lum: ${noRegion} ta`;
  return text;
}

export function formatGeneralStats(clients: ClientData[]): string {
  const total = clients.length;
  const greeted = clients.filter((c) => c.hasGreeted).length;
  const withModel = clients.filter((c) => c.lastModelName).length;
  const reviewsSent = clients.filter((c) => c.reviewSent).length;
  const feedbackDone = clients.filter((c) => c.feedbackStage === "done").length;

  const modelCounts = new Map<string, number>();
  for (const c of clients) {
    if (c.lastModelName) {
      modelCounts.set(c.lastModelName, (modelCounts.get(c.lastModelName) ?? 0) + 1);
    }
  }
  const topModels = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines = [
    "Umumiy statistika:",
    "",
    `Jami mijozlar: ${total} ta`,
    `Muloqot qilganlar: ${greeted} ta`,
    `Model aniqlanganlar: ${withModel} ta`,
    `Sharh yuborilganlar: ${reviewsSent} ta`,
    `So'rovnoma to'liq to'ldirganlar: ${feedbackDone} ta`,
  ];

  if (topModels.length > 0) {
    lines.push("", "Eng ko'p aniqlangan modellar:");
    topModels.forEach(([name, count], i) => {
      lines.push(`${i + 1}. ${name} — ${count} ta`);
    });
  }

  return lines.join("\n");
}

// ─── Muammolar/istaklar reytingi ───────────────────────────────────────────────

export function formatIssueRanking(
  categories: IssueCategory[],
  totalConversations: number,
  options: { since?: Date; modelName?: string } = {}
): string {
  const { since, modelName } = options;

  const rows: { label: string; count: number }[] = [];
  for (const cat of categories) {
    const uniqueChatIds = new Set<string>();
    for (const m of cat.mentions) {
      if (since && new Date(m.timestamp).getTime() < since.getTime()) continue;
      if (modelName && m.modelName !== modelName) continue;
      uniqueChatIds.add(m.chatId);
    }
    if (uniqueChatIds.size > 0) rows.push({ label: cat.label, count: uniqueChatIds.size });
  }

  if (rows.length === 0) {
    return "Hali muammo/istak ma'lumotlari to'planmagan.";
  }

  rows.sort((a, b) => b.count - a.count);
  return rows
    .map((r, i) => {
      const pct = totalConversations > 0 ? Math.round((r.count / totalConversations) * 100) : 0;
      return `${i + 1}. ${r.label} — ${r.count} ta (${pct}%)`;
    })
    .join("\n");
}

// ─── Model reytingi ─────────────────────────────────────────────────────────

export function formatModelRanking(modelMentions: ModelMention[]): string {
  const byModel = new Map<string, Set<string>>();
  for (const m of modelMentions) {
    if (!byModel.has(m.modelName)) byModel.set(m.modelName, new Set());
    byModel.get(m.modelName)!.add(m.chatId);
  }

  if (byModel.size === 0) {
    return "Hali model ma'lumotlari to'planmagan.";
  }

  const rows = [...byModel.entries()].map(([name, chatIds]) => ({ name, count: chatIds.size }));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  rows.sort((a, b) => b.count - a.count);

  const lines = rows.map((r, i) => {
    const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
    return `${i + 1}. ${r.name} — ${r.count} ta (${pct}%)`;
  });

  return `Model reytingi (aniqlangan mijozlar bo'yicha, jami ${total} ta):\n\n${lines.join("\n")}`;
}

// ─── Faollik vaqtlari ───────────────────────────────────────────────────────

const DAY_NAMES_UZ = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

export function formatPeakActivity(activityLog: ActivityEvent[]): string {
  if (activityLog.length === 0) {
    return "Hali faollik ma'lumotlari to'planmagan.";
  }

  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0);

  for (const e of activityLog) {
    const d = new Date(new Date(e.timestamp).getTime() + TASHKENT_OFFSET_MS);
    hourCounts[d.getUTCHours()]++;
    dayCounts[d.getUTCDay()]++;
  }

  const total = activityLog.length;

  const topHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const hourLines = topHours.map((h, i) => {
    const pct = Math.round((h.count / total) * 100);
    return `${i + 1}. Soat ${h.hour}:00–${h.hour + 1}:00 — ${h.count} ta (${pct}%)`;
  });

  const dayRows = dayCounts
    .map((count, day) => ({ day, count }))
    .sort((a, b) => b.count - a.count);
  const dayLines = dayRows.map((d, i) => {
    const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
    return `${i + 1}. ${DAY_NAMES_UZ[d.day]} — ${d.count} ta (${pct}%)`;
  });

  return (
    `Eng faol soatlar (Toshkent vaqti):\n${hourLines.join("\n")}\n\n` +
    `Hafta kunlari bo'yicha:\n${dayLines.join("\n")}`
  );
}

// ─── Qaytgan mijozlar foizi ─────────────────────────────────────────────────

export function formatReturningCustomerRate(clients: ClientData[]): string {
  if (clients.length === 0) {
    return "Hali mijozlar yo'q.";
  }

  const dateOf = (iso: string) => iso.slice(0, 10);
  let returning = 0;
  for (const c of clients) {
    if (dateOf(c.lastSeen) !== dateOf(c.firstSeen)) returning++;
  }

  const pct = Math.round((returning / clients.length) * 100);
  return (
    `Qaytgan mijozlar: ${returning} / ${clients.length} ta (${pct}%)\n\n` +
    `(Birinchi murojaatdan boshqa kunda yana yozganlar hisoblanadi)`
  );
}

// ─── Pul qaytarish statistikasi ─────────────────────────────────────────────

export function formatRefundStats(refundEvents: RefundEvent[]): string {
  if (refundEvents.length === 0) {
    return "Hali pul qaytarish so'rovlari qayd etilmagan.";
  }

  const total = refundEvents.length;
  const byModel = new Map<string, number>();
  let noModel = 0;
  for (const e of refundEvents) {
    if (e.modelName) {
      byModel.set(e.modelName, (byModel.get(e.modelName) ?? 0) + 1);
    } else {
      noModel++;
    }
  }

  const lines = [`Jami pul qaytarish so'rovlari: ${total} ta`];

  if (byModel.size > 0) {
    lines.push("", "Model bo'yicha:");
    const sorted = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([name, count], i) => {
      const pct = Math.round((count / total) * 100);
      lines.push(`${i + 1}. ${name} — ${count} ta (${pct}%)`);
    });
  }

  if (noModel > 0) lines.push("", `Modeli noma'lum: ${noModel} ta`);

  return lines.join("\n");
}

// ─── Haftalik yangi/qaytgan mijozlar ────────────────────────────────────────

function weekStartUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Yakshanba
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d;
}

export function formatNewVsReturningPerWeek(
  clients: ClientData[],
  activityLog: ActivityEvent[],
  weeksBack = 8
): string {
  if (clients.length === 0) {
    return "Hali mijozlar yo'q.";
  }

  const clientById = new Map(clients.map((c) => [c.chatId, c]));
  const now = new Date();
  const lines: string[] = [];

  for (let i = weeksBack - 1; i >= 0; i--) {
    const start = weekStartUTC(new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000));
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

    const activeIds = new Set(
      activityLog
        .filter((e) => {
          const t = new Date(e.timestamp).getTime();
          return t >= start.getTime() && t < end.getTime();
        })
        .map((e) => e.chatId)
    );

    let newCount = 0;
    let returningCount = 0;
    for (const chatId of activeIds) {
      const client = clientById.get(chatId);
      if (!client) continue;
      const firstSeenTime = new Date(client.firstSeen).getTime();
      if (firstSeenTime >= start.getTime() && firstSeenTime < end.getTime()) {
        newCount++;
      } else {
        returningCount++;
      }
    }

    lines.push(`${start.toISOString().slice(0, 10)}: yangi ${newCount} ta, qaytgan ${returningCount} ta`);
  }

  return `Haftalik yangi/qaytgan mijozlar (Dushanbadan boshlab):\n\n${lines.join("\n")}`;
}
