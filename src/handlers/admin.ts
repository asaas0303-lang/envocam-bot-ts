import { Telegraf, Markup } from "telegraf";
import { existsSync } from "fs";
import type { BotContext } from "../types.js";
import {
  DATA_DIR,
  modelsStore,
  clientsStore,
  samplesStore,
  reportsStore,
  issuesStore,
  modelMentionsStore,
  refundEventsStore,
  activityStore,
  settingsStore,
  usageStore,
  type CameraModel,
} from "../data/store.js";
import { isAdmin, downloadFileAsBase64, sleep } from "../helpers.js";
import { extractTextFromImage, analyzeInsights } from "../ai.js";
import { COLLAGE_MAX_IMAGES, rebuildModelCollageForDiagnostics } from "../collage.js";
import { sendReportNow } from "../tasks.js";
import {
  formatRegionStats,
  formatGeneralStats,
  formatIssueRanking,
  formatModelRanking,
  formatPeakActivity,
  formatReturningCustomerRate,
  formatRefundStats,
  formatNewVsReturningPerWeek,
  formatCostReport,
} from "../stats.js";

type AdminState =
  | { step: "idle" }
  | { step: "awaiting_model_name" }
  | { step: "adding_content"; modelName: string; category: string }
  | { step: "broadcast_text" }
  | { step: "broadcast_confirm"; text: string }
  | { step: "awaiting_sample_title" }
  | { step: "awaiting_sample_text"; title: string }
  | { step: "awaiting_sticker_sample" }
  | { step: "awaiting_api_balance" };

const adminState = new Map<number, AdminState>();
function getState(uid: number): AdminState { return adminState.get(uid) || { step: "idle" }; }
function setState(uid: number, s: AdminState): void { adminState.set(uid, s); }
function clearState(uid: number): void { adminState.set(uid, { step: "idle" }); }

// ─── Kategoriya nomini chiqarish ──────────────────────────────────────────────

const CAT_LABELS: Record<string, string> = {
  images: "Rasmlar", manual: "Yo'riqnoma (uzoq masofa)", app: "Ilova",
  video: "Video (qisqa masofa)", review_voice: "Sharh ovoz", review_video: "Sharh video",
  barcodes: "Barcode raqamlari",
};
const CAT_INSTRUCTIONS: Record<string, string> = {
  images: "Rasm yuboring.",
  manual: "Uzoq masofadan ulash yo'riqnomasi matnini yozing. Uzun bo'lsa bir necha xabarga bo'lib yuborishingiz mumkin.",
  app: "Ilova skrinshot rasmini yuboring (AI matnni o'qib saqlaydi).",
  video: "Video yuboring.",
  review_voice: "Sharh uchun ovozli xabar yuboring.",
  review_video: "Sharh uchun video yuboring.",
  barcodes: "Quti stikeridagi barcode raqamini yuboring (masalan: 1000077693951). Bir nechta bo'lsa, har birini alohida qatorga yozib, bitta xabarda yuborishingiz mumkin.",
};

function getCategoryCount(model: CameraModel | undefined, category: string): number {
  if (!model) return 0;
  if (category === "images") return model.images.length;
  if (category === "manual") return model.longRangeGuides.length;
  if (category === "app") return model.appScreenshots.length;
  if (category === "video") return model.videoGuides.length;
  if (category === "review_voice") return model.reviewVoiceFileId ? 1 : 0;
  if (category === "review_video") return model.reviewVideoFileId ? 1 : 0;
  if (category === "barcodes") return model.barcodes.length;
  return 0;
}

function short(text: string | undefined, max = 28): string {
  if (!text) return "izohsiz";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function onlyDigits(s: string): string {
  return s.replace(/\D/g, "");
}

// ─── Kategoriya ro'yxat menyu ─────────────────────────────────────────────────

function buildCategoryKeyboard(modelName: string, category: string) {
  const model = modelsStore.getByName(modelName);
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  if (category === "review_voice" || category === "review_video") {
    const has = category === "review_voice" ? !!model?.reviewVoiceFileId : !!model?.reviewVideoFileId;
    if (has) {
      buttons.push([
        Markup.button.callback("1. Mavjud material", "admin_noop"),
        Markup.button.callback("O'chirish", `admin_item_del_${modelName}__${category}__0`),
      ]);
    }
    buttons.push([Markup.button.callback(has ? "Almashtirish" : "Qo'shish", `admin_addto_${modelName}__${category}`)]);
  } else {
    const items =
      category === "images" ? model?.images ?? [] :
      category === "manual" ? model?.longRangeGuides ?? [] :
      category === "app" ? model?.appScreenshots ?? [] :
      category === "video" ? model?.videoGuides ?? [] :
      category === "barcodes" ? model?.barcodes ?? [] : [];

    (items as Array<{ caption?: string; extractedText?: string; text?: string } | string>).forEach((item, i) => {
      const label = typeof item === "string" ? short(item, 26) : short(item.caption || item.extractedText || item.text, 26);
      buttons.push([
        Markup.button.callback(`${i + 1}. ${label}`, "admin_noop"),
        Markup.button.callback("O'chirish", `admin_item_del_${modelName}__${category}__${i}`),
      ]);
    });
    buttons.push([Markup.button.callback("+ Qo'shish", `admin_addto_${modelName}__${category}`)]);
  }

  buttons.push([
    Markup.button.callback("⬅️ Orqaga", `admin_model_${modelName}`),
  ]);
  return Markup.inlineKeyboard(buttons);
}

function categoryMenuText(modelName: string, category: string): string {
  const model = modelsStore.getByName(modelName);
  const count = getCategoryCount(model, category);
  const label = CAT_LABELS[category] ?? category;
  let text = `${modelName} — ${label}\nJami: ${count} ta material`;
  if (category === "images" && count > COLLAGE_MAX_IMAGES) {
    text += `\n\n⚠️ ${COLLAGE_MAX_IMAGES} tadan ortiq rasm bor — model aniqlashda faqat birinchi ${COLLAGE_MAX_IMAGES} tasi ishlatiladi. Eng farqli burchaklarni qoldirib, ortiqchalarini o'chirishni tavsiya qilamiz.`;
  }
  return text;
}

// ─── Asosiy handler ro'yxati ──────────────────────────────────────────────────

export function registerAdminHandlers(bot: Telegraf<BotContext>): void {

  bot.command("panel", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    clearState(ctx.from.id);
    await showMainMenu(ctx);
  });

  // Diagnostika: jonli botda aynan qaysi commit ishlab turganini tekshirish uchun.
  bot.command("version", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const sha = process.env["RAILWAY_GIT_COMMIT_SHA"];
    const msg = sha
      ? `Joriy commit: ${sha.slice(0, 7)}\nTo'liq: ${sha}`
      : "RAILWAY_GIT_COMMIT_SHA topilmadi (lokal muhitda ishlayapsizmi?).";
    await ctx.reply(msg);
  });

  // Diagnostika: model rasm-aniqlash bilan bog'liq muammolarni tekshirish uchun.
  // /diag — umumiy holat. /diag <model nomi> — shu model uchun batafsil va
  // kollajni qaytadan yasashga urinib ko'radi (xato bo'lsa aniq sababini ko'rsatadi).
  bot.command("diag", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;

    const rawText = ("text" in ctx.message ? ctx.message.text : "") as string;
    const modelNameArg = rawText.replace(/^\/diag(@\S+)?\s*/i, "").trim();

    const volumeMounted = !!process.env["RAILWAY_VOLUME_MOUNT_PATH"];
    const models = modelsStore.getAll();

    const generalLines = [
      `DATA_DIR: ${DATA_DIR}`,
      `RAILWAY_VOLUME_MOUNT_PATH: ${volumeMounted ? "bor (Volume ulangan)" : "yo'q (doimiy bo'lmagan papka ishlatilyapti)"}`,
      `Jami modellar: ${models.length} ta`,
    ];

    if (!modelNameArg) {
      // Har bir model uchun BO'SH kontent kategoriyalarini ko'rsatamiz — admin
      // qaysi model uchun qanday yo'riqnoma yetishmayotganini darhol ko'rsin.
      generalLines.push("", "Kontent bo'shliqlari (yetishmayotgan yo'riqnomalar):");
      for (const m of models) {
        const gaps: string[] = [];
        if (m.longRangeGuides.length === 0) gaps.push("uzoq-masofa");
        if (m.videoGuides.length === 0) gaps.push("video-qisqa");
        if (m.appScreenshots.length === 0) gaps.push("ilova");
        if (m.barcodes.length === 0) gaps.push("barcode");
        generalLines.push(gaps.length === 0 ? `✅ ${m.name} — hammasi bor` : `⚠️ ${m.name} — bo'sh: ${gaps.join(", ")}`);
      }
      generalLines.push("", "Model haqida batafsil ma'lumot uchun: /diag <model nomi>  (masalan: /diag A9)");
      await ctx.reply(generalLines.join("\n"));
      return;
    }

    await ctx.reply(generalLines.join("\n"));

    const model = models.find((m) => m.name.toLowerCase() === modelNameArg.toLowerCase());
    if (!model) {
      const names = models.map((m) => m.name).join(", ") || "(hech qanday model yo'q)";
      await ctx.reply(`"${modelNameArg}" nomli model topilmadi.\nMavjud modellar: ${names}`);
      return;
    }

    const imageLines = model.images.map((img, i) => `${i + 1}. ${img.file_id.slice(0, 20)}...`);
    const collageInfo = model.refCollage
      ? [
          `sourceHash: ${model.refCollage.sourceHash}`,
          `generatedAt: ${model.refCollage.generatedAt}`,
          `path: ${model.refCollage.path}`,
          `Diskda mavjud: ${existsSync(model.refCollage.path) ? "ha" : "YO'Q"}`,
        ].join("\n")
      : "mavjud emas (hali hech qachon yasalmagan)";

    await ctx.reply(
      `Model: ${model.name}\n` +
      `Rasmlar soni: ${model.images.length} ta\n\n` +
      `file_id lar:\n${imageLines.length > 0 ? imageLines.join("\n") : "(rasm yo'q)"}\n\n` +
      `refCollage:\n${collageInfo}`
    );

    await ctx.reply("Kollajni hozir qayta yasashga urinilmoqda...");
    try {
      const result = await rebuildModelCollageForDiagnostics(ctx, model);
      if (result) {
        const sizeKb = Math.round((result.base64.length * 0.75) / 1024);
        await ctx.reply(`✅ Kollaj muvaffaqiyatli yasaldi. Taxminiy hajmi: ${sizeKb} KB.`);
      } else {
        await ctx.reply("⚠️ Kollaj yasalmadi (rasm topilmadi), lekin aniq xatolik ham chiqmadi.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Kollaj yasashda xatolik:\n${message}`);
    }
  });

  // Diagnostika: bazada aynan qaysi barcode raqamlari saqlanganini ko'rsatadi —
  // shunda admin nima kiritilganini (va nima yetishmayotganini) aniq ko'radi.
  bot.command("diagbarcode", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const models = modelsStore.getAll();
    if (models.length === 0) {
      await ctx.reply("Hech qanday model yo'q.");
      return;
    }

    // Bir xil raqam bir necha modelda uchrasa — TO'QNASHUV. Har bir normalizatsiya
    // qilingan raqam qaysi modellarda borligini yig'amiz.
    const byCode = new Map<string, string[]>();
    for (const m of models) {
      for (const b of m.barcodes) {
        const d = onlyDigits(b);
        if (!d) continue;
        if (!byCode.has(d)) byCode.set(d, []);
        if (!byCode.get(d)!.includes(m.name)) byCode.get(d)!.push(m.name);
      }
    }
    const collisions = [...byCode.entries()].filter(([, names]) => names.length > 1);

    const lines = models.map((m) => {
      const codes = m.barcodes.length > 0 ? m.barcodes.join(", ") : "(barcode yo'q)";
      return `${m.name} (${m.barcodes.length} ta):\n${codes}`;
    });

    let text = `Bazadagi barcode raqamlari (jami ${models.length} ta model):\n\n` + lines.join("\n\n");
    if (collisions.length > 0) {
      text += "\n\n⚠️ TO'QNASHUV (bir xil raqam bir necha modelda):";
      for (const [code, names] of collisions) {
        text += `\n${code} → ${names.join(", ")}`;
      }
    }
    await sendChunkedReply(ctx, text);
  });

  bot.command("hisobot", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await sendReportNow(bot, String(ctx.from.id));
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.reply("Statistika bo'limi:", buildStatsMenu());
  });

  bot.command("xarajat", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const text = formatCostReport(usageStore.getAll(), usageStore.getBalance());
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback("API balans", "admin_api_balance")],
    ]));
  });

  // ── Statistika ──
  bot.action("admin_stats", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText("Statistika bo'limi:", buildStatsMenu());
  });

  bot.action("admin_stats_region", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const clients = clientsStore.getAll();
    const text = formatRegionStats(clients);
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  bot.action("admin_stats_insights", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();

    // Cache tekshirish (6 soat)
    const cached = reportsStore.getCachedInsights();
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (cached && Date.now() - new Date(cached.cachedAt).getTime() < SIX_HOURS) {
      const ts = new Date(cached.cachedAt).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" });
      await sendChunkedReply(
        ctx,
        `${cached.text}\n\nOxirgi yangilanish: ${ts}`,
        Markup.inlineKeyboard([[Markup.button.callback("Qayta tahlil", "admin_stats_insights_refresh"), Markup.button.callback("⬅️ Orqaga", "admin_stats")]])
      );
      return;
    }

    await ctx.reply("Tahlil qilinmoqda...");
    await performInsightsAnalysis(ctx);
  });

  bot.action("admin_stats_insights_refresh", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.reply("Tahlil qilinmoqda...");
    await performInsightsAnalysis(ctx);
  });

  bot.action("admin_stats_general", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const clients = clientsStore.getAll();
    const text = formatGeneralStats(clients);
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  // ── Muammolar reytingi (davr bo'yicha) ──
  bot.action("admin_stats_issues", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText("Qaysi davr uchun ko'rsatilsin?", Markup.inlineKeyboard([
      [Markup.button.callback("Oxirgi 1 oy", "admin_stats_issues__30"),
       Markup.button.callback("Oxirgi 3 oy", "admin_stats_issues__90")],
      [Markup.button.callback("Oxirgi 6 oy", "admin_stats_issues__180"),
       Markup.button.callback("Oxirgi 1 yil", "admin_stats_issues__365")],
      [Markup.button.callback("Hammasi", "admin_stats_issues__all")],
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  bot.action(/^admin_stats_issues__(30|90|180|365|all)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const windowKey = ctx.match[1];
    const { since, label } = resolveStatsWindow(windowKey);
    const clients = clientsStore.getAll();
    const totalConversations = clients.filter(
      (c) => !since || new Date(c.lastSeen).getTime() >= since.getTime()
    ).length;
    const text = formatIssueRanking(issuesStore.getAll(), totalConversations, { since });
    await sendChunkedReply(
      ctx,
      `Muammolar reytingi — ${label}:\n\n${text}`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Davrlar", "admin_stats_issues")]])
    );
  });

  // ── Model reytingi ──
  bot.action("admin_stats_models", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatModelRanking(modelMentionsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  // ── Faollik vaqtlari ──
  bot.action("admin_stats_activity", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatPeakActivity(activityStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  // ── Qaytgan mijozlar foizi ──
  bot.action("admin_stats_returning", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatReturningCustomerRate(clientsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  // ── Pul qaytarish statistikasi ──
  bot.action("admin_stats_refunds", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatRefundStats(refundEventsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  // ── Haftalik yangi/qaytgan mijozlar ──
  bot.action("admin_stats_weekly", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatNewVsReturningPerWeek(clientsStore.getAll(), activityStore.getAll());
    await sendChunkedReply(ctx, text, Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
    ]));
  });

  // ── Model bo'yicha muammolar ──
  bot.action("admin_stats_model_issues", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const models = modelsStore.getAll();
    if (models.length === 0) {
      await ctx.editMessageText("Hozircha modellar yo'q.",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")]]));
      return;
    }
    const buttons = models.map((m) => [Markup.button.callback(m.name, `admin_stats_model_issues__${m.name}`)]);
    buttons.push([Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")]);
    await ctx.editMessageText("Qaysi model uchun ko'rsatilsin?", Markup.inlineKeyboard(buttons));
  });

  bot.action(/^admin_stats_model_issues__(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    const totalConversations = clientsStore.getAll().filter((c) => c.lastModelName === modelName).length;
    const text = formatIssueRanking(issuesStore.getAll(), totalConversations, { modelName });
    await sendChunkedReply(
      ctx,
      `${modelName} — muammolar reytingi:\n\n${text}`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Modellarga qaytish", "admin_stats_model_issues")]])
    );
  });

  // ── Bosh menyu ──
  bot.action("admin_models_list", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const models = modelsStore.getAll();
    if (models.length === 0) {
      await ctx.editMessageText("Hozircha modellar yo'q.",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_back_main")]]));
      return;
    }
    const buttons = models.map((m) => [Markup.button.callback(m.name, `admin_model_${m.name}`)]);
    buttons.push([Markup.button.callback("⬅️ Orqaga", "admin_back_main")]);
    await ctx.editMessageText("Modellar ro'yxati:", Markup.inlineKeyboard(buttons));
  });

  bot.action("admin_add_model", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: "awaiting_model_name" });
    await ctx.editMessageText("Yangi model nomini yozing:\n(Bekor — /panel)");
  });

  bot.action("admin_clients_count", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Mijozlar soni: ${clientsStore.count()}`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_back_main")]]));
  });

  bot.action("admin_broadcast", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: "broadcast_text" });
    await ctx.editMessageText("Hammaga yuboriladigan xabarni yozing:\n(Bekor — /panel)");
  });

  bot.action("admin_samples", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await showSamplesMenu(ctx);
  });

  // ── Namuna rasm (barcha modellar uchun umumiy — stiker joyini ko'rsatadi) ──
  bot.action("admin_sticker_sample", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await showStickerSampleMenu(ctx, false);
  });

  bot.action("admin_sticker_sample_add", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: "awaiting_sticker_sample" });
    await ctx.editMessageText(
      "Stiker joyi strelka/doira bilan belgilangan namuna rasmni yuboring. Bu rasm mijozga \"stikerni yaqinroq suratga oling\" deganda ko'rsatiladi.\n(Bekor — /panel)"
    );
  });

  bot.action("admin_sticker_sample_delete", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    settingsStore.clearStickerSample();
    await showStickerSampleMenu(ctx, false);
  });

  // ── API balans (Anthropic kredit balansini o'zi hisoblab boradi) ──
  bot.action("admin_api_balance", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await showApiBalanceMenu(ctx, false);
  });

  bot.action("admin_api_balance_set", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: "awaiting_api_balance" });
    await ctx.editMessageText(
      "Hozirgi Anthropic balansini USD da kiriting (masalan: 5 yoki 5.50):\n(Bekor — /panel)"
    );
  });

  bot.action("admin_back_main", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    await showMainMenuEdit(ctx);
  });

  bot.action("admin_noop", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
  });

  // ── Model menyusi ──
  bot.action(/^admin_model_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await showModelMenuEdit(ctx, ctx.match[1]);
  });

  // ── Kategoriya — ro'yxat ko'rinishi ──
  bot.action(/^admin_cat_([^_].+)__([a-z_]+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    const modelName = ctx.match[1];
    const category = ctx.match[2];
    await ctx.editMessageText(
      categoryMenuText(modelName, category),
      buildCategoryKeyboard(modelName, category)
    );
  });

  // ── Kategoriyaga qo'shish rejimi ──
  bot.action(/^admin_addto_(.+)__([a-z_]+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    const category = ctx.match[2];
    setState(ctx.from.id, { step: "adding_content", modelName, category });
    const label = CAT_LABELS[category] ?? category;
    const instruction = CAT_INSTRUCTIONS[category] ?? "Material yuboring.";
    await ctx.editMessageText(
      `${modelName} — ${label}\n\n${instruction}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Tayyor", `admin_catdone_${modelName}__${category}`)],
        [Markup.button.callback("⬅️ Orqaga", `admin_cat_${modelName}__${category}`)],
      ])
    );
  });

  bot.action(/^admin_catdone_(.+)__([a-z_]+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    const modelName = ctx.match[1];
    const category = ctx.match[2];
    await ctx.editMessageText(
      categoryMenuText(modelName, category),
      buildCategoryKeyboard(modelName, category)
    );
  });

  // ── Material o'chirish — tasdiq ──
  bot.action(/^admin_item_del_(.+)__([a-z_]+)__(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    const category = ctx.match[2];
    const idx = ctx.match[3];
    const label = CAT_LABELS[category] ?? category;
    await ctx.editMessageText(
      `${modelName} — ${label}\n${Number(idx) + 1}-materialni o'chirishni tasdiqlaysizmi?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Ha, o'chirish", `admin_item_confirm_${modelName}__${category}__${idx}`)],
        [Markup.button.callback("⬅️ Bekor", `admin_cat_${modelName}__${category}`)],
      ])
    );
  });

  // ── Material o'chirish — amalga oshirish ──
  bot.action(/^admin_item_confirm_(.+)__([a-z_]+)__(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    const category = ctx.match[2];
    const idx = Number(ctx.match[3]);
    const model = modelsStore.getByName(modelName);

    if (model) {
      if (category === "images") model.images.splice(idx, 1);
      else if (category === "manual") model.longRangeGuides.splice(idx, 1);
      else if (category === "app") model.appScreenshots.splice(idx, 1);
      else if (category === "video") model.videoGuides.splice(idx, 1);
      else if (category === "review_voice") model.reviewVoiceFileId = undefined;
      else if (category === "review_video") model.reviewVideoFileId = undefined;
      else if (category === "barcodes") model.barcodes.splice(idx, 1);
      modelsStore.save(model);
    }

    await ctx.editMessageText(
      categoryMenuText(modelName, category),
      buildCategoryKeyboard(modelName, category)
    );
  });

  // ── Model o'chirish ──
  bot.action(/^admin_delete_model_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    await ctx.editMessageText(
      `"${modelName}" modelini o'chirishni tasdiqlaysizmi?\nBarcha materiallari ham o'chadi.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Ha, o'chirish", `admin_confirm_delete_${modelName}`)],
        [Markup.button.callback("⬅️ Bekor", `admin_model_${modelName}`)],
      ])
    );
  });

  bot.action(/^admin_confirm_delete_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    modelsStore.delete(ctx.match[1]);
    clearState(ctx.from.id);
    await showMainMenuEdit(ctx);
  });

  // ── Broadcast ──
  bot.action("admin_confirm_broadcast", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const state = getState(ctx.from.id);
    if (state.step !== "broadcast_confirm") return;
    const { text } = state;
    clearState(ctx.from.id);

    const clients = clientsStore.getAll();
    await ctx.editMessageText(`Xabar ${clients.length} ta mijozga yuborilmoqda...`);

    let sent = 0, failed = 0;
    for (const client of clients) {
      try {
        if (client.businessConnectionId) {
          await ctx.telegram.sendMessage(client.chatId, text, {
            business_connection_id: client.businessConnectionId,
          } as Parameters<typeof ctx.telegram.sendMessage>[2]);
        } else {
          await ctx.telegram.sendMessage(client.chatId, text);
        }
        sent++;
      } catch { failed++; }
      await sleep(2000 + Math.random() * 1000);
    }
    await ctx.reply(`Broadcast tugadi. Yuborildi: ${sent}, xatolik: ${failed}`);
  });

  // ── Namuna ──
  bot.action("admin_sample_add", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: "awaiting_sample_title" });
    await ctx.editMessageText(
      "Namuna yozishma sarlavhasini kiriting (masalan: \"WiFi ulanish muammosi\"):\n(Bekor — /panel)"
    );
  });

  bot.action(/^admin_sample_delete_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    samplesStore.delete(ctx.match[1]);
    await showSamplesMenu(ctx);
  });

  bot.action("admin_samples_back", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    await showMainMenuEdit(ctx);
  });

  // ── Xabar handleri ──
  bot.on("message", async (ctx, next) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return next();
    const state = getState(ctx.from.id);
    const msg = ctx.message;

    // Model nomi
    if (state.step === "awaiting_model_name" && "text" in msg) {
      const name = msg.text.trim();
      if (!name || name.startsWith("/")) { clearState(ctx.from.id); await showMainMenu(ctx); return; }
      if (modelsStore.getByName(name)) { await ctx.reply(`"${name}" allaqachon bor. Boshqa nom:`); return; }
      modelsStore.save({ name, images: [], appScreenshots: [], videoGuides: [], longRangeGuides: [], barcodes: [] });
      clearState(ctx.from.id);
      await ctx.reply(`"${name}" modeli qo'shildi.`);
      await showModelMenuNew(ctx, name);
      return;
    }

    // Broadcast
    if (state.step === "broadcast_text" && "text" in msg) {
      const text = msg.text.trim();
      if (!text || text.startsWith("/")) { clearState(ctx.from.id); await showMainMenu(ctx); return; }
      setState(ctx.from.id, { step: "broadcast_confirm", text });
      await ctx.reply(
        `Quyidagi xabar barcha mijozlarga yuboriladi:\n\n${text}\n\nTasdiqlaysizmi?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Yuborish", "admin_confirm_broadcast")],
          [Markup.button.callback("Bekor", "admin_back_main")],
        ])
      );
      return;
    }

    // Namuna sarlavhasi
    if (state.step === "awaiting_sample_title" && "text" in msg) {
      const title = msg.text.trim();
      if (!title || title.startsWith("/")) { clearState(ctx.from.id); await showMainMenu(ctx); return; }
      setState(ctx.from.id, { step: "awaiting_sample_text", title });
      await ctx.reply(
        `"${title}" uchun namuna yozishma matnini yuboring.\n\nFormat:\nMijoz: ...\nMen: ...\n\n(Bekor — /panel)`
      );
      return;
    }

    // Namuna matni
    if (state.step === "awaiting_sample_text" && "text" in msg) {
      const text = msg.text.trim();
      if (!text || text.startsWith("/")) { clearState(ctx.from.id); await showMainMenu(ctx); return; }
      const { title } = state;
      samplesStore.add(title, text);
      clearState(ctx.from.id);
      await ctx.reply(`Namuna saqlandi. Jami: ${samplesStore.count()} ta.`);
      await showSamplesMenuNew(ctx);
      return;
    }

    // Namuna rasm (stiker joyi ko'rsatilgan)
    if (state.step === "awaiting_sticker_sample" && "photo" in msg && msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      settingsStore.setStickerSample(photo.file_id);
      clearState(ctx.from.id);
      await ctx.reply("Namuna rasm saqlandi.");
      await showStickerSampleMenu(ctx, true);
      return;
    }

    // API balans kiritish
    if (state.step === "awaiting_api_balance" && "text" in msg) {
      const raw = msg.text.trim().replace(",", ".");
      if (!raw || raw.startsWith("/")) { clearState(ctx.from.id); await showMainMenu(ctx); return; }
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) {
        await ctx.reply("Noto'g'ri summa. Faqat musbat son kiriting (masalan: 5 yoki 5.50):");
        return;
      }
      usageStore.setBalance(amount);
      clearState(ctx.from.id);
      await ctx.reply(`Balans saqlandi: $${amount.toFixed(2)}`);
      await showApiBalanceMenu(ctx, true);
      return;
    }

    // Kontent qo'shish
    if (state.step === "adding_content") {
      const { modelName, category } = state;
      const model = modelsStore.getByName(modelName);
      if (!model) return next();

      if (category === "images" && "photo" in msg && msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        model.images.push({ file_id: photo.file_id, caption: msg.caption });
        modelsStore.save(model);
        await ctx.reply(`Saqlandi. Jami: ${model.images.length} ta rasm.`);
        return;
      }

      if (category === "manual" && "text" in msg && msg.text) {
        const text = msg.text.trim();
        if (text) {
          model.longRangeGuides.push({ text });
          modelsStore.save(model);
          await ctx.reply(`Saqlandi. Jami: ${model.longRangeGuides.length} ta uzoq masofa yo'riqnomasi.`);
        }
        return;
      }

      if (category === "barcodes" && "text" in msg && msg.text) {
        const raw = msg.text.trim();
        const codes = raw
          .split(/[\s,;]+/)
          .map((c) => onlyDigits(c))
          .filter((c) => c.length >= 6);
        if (codes.length === 0) {
          await ctx.reply("Barcode raqami topilmadi. Faqat raqamlardan iborat kod(lar)ni yuboring (kamida 6 xonali).");
          return;
        }

        const allModels = modelsStore.getAll();
        let added = 0;
        const errors: string[] = [];
        const warnings: string[] = [];
        const alreadyHere: string[] = [];

        for (const code of codes) {
          // Bu barcode boshqa modelda allaqachon ro'yxatdami? Bo'lsa — QO'SHMAYMIZ.
          const conflictModel = allModels.find(
            (m) => m.name !== model.name && m.barcodes.some((b) => onlyDigits(b) === code)
          );
          if (conflictModel) {
            errors.push(`${code} — bu barcode allaqachon "${conflictModel.name}" modelida bor. Avval u yerdan o'chiring, keyin bu yerga qo'shing.`);
            continue;
          }
          if (model.barcodes.some((b) => onlyDigits(b) === code)) {
            alreadyHere.push(code); // allaqachon shu modelda bor
            continue;
          }

          // Oxirgi 4 raqami boshqa modelning biror barcode'i bilan bir xilmi?
          // (OCR "oxirgi 4 raqam" fallback'ida chalkashishi mumkin — qo'shamiz,
          // lekin ogohlantiramiz.)
          const last4 = code.slice(-4);
          const collisionModel = allModels.find(
            (m) => m.name !== model.name && m.barcodes.some((b) => onlyDigits(b).slice(-4) === last4)
          );
          if (collisionModel) {
            warnings.push(`${code} — oxirgi 4 raqami ("${last4}") "${collisionModel.name}" modelinikiga to'g'ri keladi. Baribir qo'shildi, lekin chalkashlik bo'lishi mumkin.`);
          }

          model.barcodes.push(code);
          added++;
        }
        modelsStore.save(model);

        // Xabar aniq bo'lsin: qaysi model, nima qo'shildi, nima qo'shilmadi.
        const lines: string[] = [];
        if (added > 0) {
          lines.push(`✅ "${model.name}" modeliga ${added} ta barcode qo'shildi. Jami: ${model.barcodes.length} ta.`);
        } else {
          lines.push(`Hech qanday yangi barcode qo'shilmadi. "${model.name}" modelida jami: ${model.barcodes.length} ta.`);
        }
        if (alreadyHere.length > 0) {
          lines.push("", `Allaqachon shu modelda bor edi: ${alreadyHere.join(", ")}`);
        }
        if (warnings.length > 0) lines.push("", "⚠️ Ogohlantirishlar:", ...warnings);
        if (errors.length > 0) lines.push("", "❌ Qo'shilmadi (to'qnashuv):", ...errors);
        await ctx.reply(lines.join("\n"));
        return;
      }

      if (category === "app" && "photo" in msg && msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        await ctx.reply("Rasm matnini o'qiyapman...");
        const dl = await downloadFileAsBase64(ctx, photo.file_id);
        let extractedText = "";
        if (dl) extractedText = await extractTextFromImage(dl.base64, dl.mimeType);
        model.appScreenshots.push({ file_id: photo.file_id, caption: msg.caption, extractedText });
        modelsStore.save(model);
        await ctx.reply(`Saqlandi. Jami: ${model.appScreenshots.length} ta ilova tasviri.`);
        return;
      }

      if (category === "video" && "video" in msg && msg.video) {
        model.videoGuides.push({ file_id: msg.video.file_id, caption: msg.caption });
        modelsStore.save(model);
        await ctx.reply(`Saqlandi. Jami: ${model.videoGuides.length} ta video.`);
        return;
      }

      if (category === "review_voice" && "voice" in msg && msg.voice) {
        model.reviewVoiceFileId = msg.voice.file_id;
        modelsStore.save(model);
        await ctx.reply("Sharh ovozi saqlandi.");
        return;
      }

      if (category === "review_video" && "video" in msg && msg.video) {
        model.reviewVideoFileId = msg.video.file_id;
        modelsStore.save(model);
        await ctx.reply("Sharh videosi saqlandi.");
        return;
      }

      await ctx.reply("Kutilgan turdagi material yuboring.");
      return;
    }

    return next();
  });
}

// ─── Menyular ─────────────────────────────────────────────────────────────────

function buildStatsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Joylashuv (viloyatlar)", "admin_stats_region")],
    [Markup.button.callback("Muammolar reytingi", "admin_stats_issues"),
     Markup.button.callback("Model reytingi", "admin_stats_models")],
    [Markup.button.callback("Faollik vaqtlari", "admin_stats_activity"),
     Markup.button.callback("Qaytgan mijozlar", "admin_stats_returning")],
    [Markup.button.callback("Pul qaytarish", "admin_stats_refunds"),
     Markup.button.callback("Yangi/qaytgan (haftalik)", "admin_stats_weekly")],
    [Markup.button.callback("Model bo'yicha muammolar", "admin_stats_model_issues")],
    [Markup.button.callback("Mijoz istaklari (AI tahlil)", "admin_stats_insights")],
    [Markup.button.callback("Umumiy statistika", "admin_stats_general")],
    [Markup.button.callback("⬅️ Asosiy menyu", "admin_back_main")],
  ]);
}

const STATS_WINDOWS: Record<string, { days: number | null; label: string }> = {
  "30": { days: 30, label: "Oxirgi 1 oy" },
  "90": { days: 90, label: "Oxirgi 3 oy" },
  "180": { days: 180, label: "Oxirgi 6 oy" },
  "365": { days: 365, label: "Oxirgi 1 yil" },
  all: { days: null, label: "Hammasi" },
};

function resolveStatsWindow(key: string): { since: Date | undefined; label: string } {
  const w = STATS_WINDOWS[key] ?? STATS_WINDOWS["all"]!;
  const since = w.days ? new Date(Date.now() - w.days * 24 * 60 * 60 * 1000) : undefined;
  return { since, label: w.label };
}

async function sendChunkedReply(
  ctx: BotContext,
  text: string,
  keyboard?: ReturnType<typeof Markup.inlineKeyboard>
): Promise<void> {
  const MAX = 4000;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf("\n", MAX);
    if (cut < MAX * 0.5) cut = MAX;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  chunks.push(remaining);
  for (let i = 0; i < chunks.length; i++) {
    if (i === chunks.length - 1 && keyboard) {
      await ctx.reply(chunks[i], keyboard);
    } else {
      await ctx.reply(chunks[i]);
      await sleep(400);
    }
  }
}

async function performInsightsAnalysis(ctx: BotContext): Promise<void> {
  const clients = clientsStore.getAll();
  const feedbacks = clients
    .filter((c) => c.feedback && c.lastModelName)
    .map((c) => ({
      modelName: c.lastModelName!,
      satisfaction: c.feedback!.satisfaction,
      wishlist: c.feedback!.wishlist,
      location: c.feedback!.location,
      purpose: c.feedback!.purpose,
    }));

  if (feedbacks.length === 0) {
    await ctx.reply(
      "Hali so'rovnoma ma'lumotlari to'planmagan.\nVideo yuborilib 3 soat o'tgach so'rovnoma yuboriladi.",
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Statistika", "admin_stats")]])
    );
    return;
  }

  const text = await analyzeInsights(feedbacks);
  reportsStore.setCachedInsights(text);
  const ts = new Date().toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" });
  await sendChunkedReply(
    ctx,
    `${text}\n\nTahlil qilingan: ${ts} | Jami so'rovnoma: ${feedbacks.length} ta`,
    Markup.inlineKeyboard([[Markup.button.callback("Qayta tahlil", "admin_stats_insights_refresh"), Markup.button.callback("⬅️ Orqaga", "admin_stats")]])
  );
}

async function showMainMenu(ctx: BotContext): Promise<void> {
  const total = clientsStore.count();
  await ctx.reply("Admin panel:", Markup.inlineKeyboard([
    [Markup.button.callback("Modellar ro'yxati", "admin_models_list"),
     Markup.button.callback("Yangi model", "admin_add_model")],
    [Markup.button.callback(`Mijozlar: ${total} ta`, "admin_clients_count"),
     Markup.button.callback("Hammaga xabar", "admin_broadcast")],
    [Markup.button.callback(`Namuna yozishmalar (${samplesStore.count()})`, "admin_samples"),
     Markup.button.callback("Namuna rasm (stiker)", "admin_sticker_sample")],
    [Markup.button.callback("Statistika", "admin_stats"),
     Markup.button.callback("API balans", "admin_api_balance")],
  ]));
}

async function showMainMenuEdit(ctx: BotContext): Promise<void> {
  const total = clientsStore.count();
  await ctx.editMessageText("Admin panel:", Markup.inlineKeyboard([
    [Markup.button.callback("Modellar ro'yxati", "admin_models_list"),
     Markup.button.callback("Yangi model", "admin_add_model")],
    [Markup.button.callback(`Mijozlar: ${total} ta`, "admin_clients_count"),
     Markup.button.callback("Hammaga xabar", "admin_broadcast")],
    [Markup.button.callback(`Namuna yozishmalar (${samplesStore.count()})`, "admin_samples"),
     Markup.button.callback("Namuna rasm (stiker)", "admin_sticker_sample")],
    [Markup.button.callback("Statistika", "admin_stats"),
     Markup.button.callback("API balans", "admin_api_balance")],
  ]));
}

function buildModelKeyboard(modelName: string) {
  const model = modelsStore.getByName(modelName);
  const c = (cat: string) => getCategoryCount(model, cat);
  const rv = model?.reviewVoiceFileId ? "bor" : "yo'q";
  const rvid = model?.reviewVideoFileId ? "bor" : "yo'q";
  return Markup.inlineKeyboard([
    [Markup.button.callback(`🔑 Barcode raqamlari (${c("barcodes")})`, `admin_cat_${modelName}__barcodes`)],
    [Markup.button.callback(`Rasmlar (${c("images")})`, `admin_cat_${modelName}__images`),
     Markup.button.callback(`Yo'riqnoma-uzoq (${c("manual")})`, `admin_cat_${modelName}__manual`)],
    [Markup.button.callback(`Ilova (${c("app")})`, `admin_cat_${modelName}__app`),
     Markup.button.callback(`Video-qisqa (${c("video")})`, `admin_cat_${modelName}__video`)],
    [Markup.button.callback(`Sharh ovoz: ${rv}`, `admin_cat_${modelName}__review_voice`),
     Markup.button.callback(`Sharh video: ${rvid}`, `admin_cat_${modelName}__review_video`)],
    [Markup.button.callback("Modelni o'chirish", `admin_delete_model_${modelName}`),
     Markup.button.callback("⬅️ Orqaga", "admin_models_list")],
  ]);
}

async function showModelMenuEdit(ctx: BotContext, modelName: string): Promise<void> {
  await ctx.editMessageText(modelName, buildModelKeyboard(modelName));
}

async function showModelMenuNew(ctx: BotContext, modelName: string): Promise<void> {
  await ctx.reply(modelName, buildModelKeyboard(modelName));
}

async function showSamplesMenu(ctx: BotContext): Promise<void> {
  const samples = samplesStore.getAll();
  const buttons = samples.map((s) => [
    Markup.button.callback(short(s.title, 30), "admin_noop"),
    Markup.button.callback("O'chirish", `admin_sample_delete_${s.id}`),
  ]);
  buttons.push([Markup.button.callback("+ Yangi namuna qo'shish", "admin_sample_add")]);
  buttons.push([Markup.button.callback("⬅️ Orqaga", "admin_samples_back")]);
  const text = samples.length === 0
    ? "Namuna yozishmalar yo'q.\n\nNamunalar AI ga o'z uslubingizni o'rgatadi."
    : `Namuna yozishmalar: ${samples.length} ta`;
  await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
}

async function showSamplesMenuNew(ctx: BotContext): Promise<void> {
  const samples = samplesStore.getAll();
  const buttons = samples.map((s) => [
    Markup.button.callback(short(s.title, 30), "admin_noop"),
    Markup.button.callback("O'chirish", `admin_sample_delete_${s.id}`),
  ]);
  buttons.push([Markup.button.callback("+ Yangi namuna qo'shish", "admin_sample_add")]);
  buttons.push([Markup.button.callback("⬅️ Orqaga", "admin_samples_back")]);
  await ctx.reply(`Namuna yozishmalar: ${samples.length} ta`, Markup.inlineKeyboard(buttons));
}

async function showStickerSampleMenu(ctx: BotContext, asNew: boolean): Promise<void> {
  const sample = settingsStore.getStickerSample();
  const text = sample
    ? "Namuna rasm (stiker joyini ko'rsatuvchi) mavjud.\n\nBu barcha modellar uchun umumiy — mijozga \"stikerni yaqinroq suratga oling\" deganda shu rasm yuboriladi."
    : "Namuna rasm hali yuklanmagan.\n\nBu rasm mijozga \"stikerni yaqinroq suratga oling\" deganda ko'rsatiladi (barcha modellar uchun bitta umumiy rasm — chunki quti hamma modelda bir xil).";
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback(sample ? "Almashtirish" : "Yuklash", "admin_sticker_sample_add")],
  ];
  if (sample) buttons.push([Markup.button.callback("O'chirish", "admin_sticker_sample_delete")]);
  buttons.push([Markup.button.callback("⬅️ Orqaga", "admin_back_main")]);
  const keyboard = Markup.inlineKeyboard(buttons);
  if (asNew) {
    await ctx.reply(text, keyboard);
  } else {
    await ctx.editMessageText(text, keyboard);
  }
}

async function showApiBalanceMenu(ctx: BotContext, asNew: boolean): Promise<void> {
  const balance = usageStore.getBalance();
  const text = balance
    ? `Joriy balans: ~$${balance.amountUsd.toFixed(2)}\nOxirgi kiritilgan: ${new Date(balance.setAt).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })}\n\nAnthropic'da qolgan haqiqiy kredit balansini API orqali o'qib bo'lmaydi — bot har bir so'rov narxini o'zi hisoblab shu summadan ayirib boradi (taxminiy). Balansni to'ldirgandan keyin yangi summani shu yerdan qayta kiriting.`
    : `Balans hali kiritilmagan.\n\nAnthropic'da qolgan haqiqiy kredit balansini API orqali o'qib bo'lmaydi — shuning uchun bot buni o'zi hisoblab boradi. Boshlang'ich balansni (masalan, Anthropic Console'dagi summani) shu yerdan kiriting.`;
  const buttons = [
    [Markup.button.callback(balance ? "Balansni qayta kiritish" : "Balansni kiritish", "admin_api_balance_set")],
    [Markup.button.callback("⬅️ Orqaga", "admin_back_main")],
  ];
  const keyboard = Markup.inlineKeyboard(buttons);
  if (asNew) {
    await ctx.reply(text, keyboard);
  } else {
    await ctx.editMessageText(text, keyboard);
  }
}
