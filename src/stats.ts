import type { ClientData } from "./data/store.js";

export function formatRegionStats(clients: ClientData[]): string {
  const counts = new Map<string, number>();
  let noRegion = 0;
  for (const c of clients) {
    if (c.region && c.region.trim()) {
      const key = c.region.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      noRegion++;
    }
  }

  if (counts.size === 0) {
    return "Hali hech qanday viloyat ma'lumoti to'planmagan.";
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
