import { Telegraf, Markup } from "telegraf";
import type { BotContext } from "../types.js";
import { clientsStore, modelRequestsStore, modelsStore, type CameraModel } from "../data/store.js";
import { isAdmin } from "../helpers.js";
import {
  formatBusiestDay,
  formatCoverageRate,
  formatGeneralStats,
  formatHopelessClients,
  formatHourlyActivity,
  formatMissingModelsRanking,
  formatModelRanking,
  formatNewClientsStats,
  formatReturningRate,
  formatSilentStarters,
  formatWeekdayActivity,
  formatWeeklyNewClientsTrend,
} from "../stats.js";

type AdminState =
  | { step: "idle" }
  | { step: "awaiting_model_name" }
  | { step: "awaiting_video"; modelName: string; chain: boolean }
  | { step: "awaiting_setup_link"; modelName: string; chain: boolean }
  | { step: "awaiting_description"; modelName: string; chain: boolean };

const adminState = new Map<number, AdminState>();
function getState(uid: number): AdminState { return adminState.get(uid) || { step: "idle" }; }
function setState(uid: number, s: AdminState): void { adminState.set(uid, s); }
function clearState(uid: number): void { adminState.set(uid, { step: "idle" }); }

function short(text: string | undefined, max = 40): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function videoStatusLabel(model: CameraModel): string {
  if (model.videoFileId) return "fayl bor";
  if (model.videoLink) return short(model.videoLink, 25);
  return "yo'q";
}

export function registerAdminHandlers(bot: Telegraf<BotContext>): void {
  bot.command("panel", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    clearState(ctx.from.id);
    await ctx.reply("Admin panel:", buildMainMenu());
  });

  bot.action("admin_back_main", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    await ctx.editMessageText("Admin panel:", buildMainMenu());
  });

  bot.action("admin_noop", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
  });

  // ── Model qo'shish ──
  bot.action("admin_add_model", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: "awaiting_model_name" });
    await ctx.editMessageText("Yangi model nomini yozing:\n(Bekor — /panel)");
  });

  // ── Modellar ro'yxati ──
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

  bot.action(/^admin_model_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await showModelMenu(ctx, ctx.match[1], true);
  });

  // ── Model maydonlarini tahrirlash (video/sozlash havolasi/izoh) ──
  bot.action(/^admin_edit_video_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    setState(ctx.from.id, { step: "awaiting_video", modelName, chain: false });
    await ctx.editMessageText(
      `${modelName} — video qo'llanma yuboring (video fayl) yoki havolasini matn qilib yozing.\nO'tkazib yuborish uchun /skip yozing. (Bekor — /panel)`
    );
  });

  bot.action(/^admin_edit_setuplink_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    setState(ctx.from.id, { step: "awaiting_setup_link", modelName, chain: false });
    await ctx.editMessageText(
      `${modelName} — sozlash ilovasi/portal havolasini yozing.\nO'tkazib yuborish uchun /skip yozing. (Bekor — /panel)`
    );
  });

  bot.action(/^admin_edit_description_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    setState(ctx.from.id, { step: "awaiting_description", modelName, chain: false });
    await ctx.editMessageText(
      `${modelName} — qo'shimcha izoh yozing.\nO'tkazib yuborish uchun /skip yozing. (Bekor — /panel)`
    );
  });

  // ── Model o'chirish ──
  bot.action(/^admin_delete_model_(.+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const modelName = ctx.match[1];
    await ctx.editMessageText(
      `"${modelName}" modelini o'chirishni tasdiqlaysizmi?`,
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
    await ctx.editMessageText("Admin panel:", buildMainMenu());
  });

  // ── Statistika ──
  bot.action("admin_stats", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText("Statistika bo'limi:", buildStatsMenu());
  });

  bot.action("admin_stats_general", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatGeneralStats(clientsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")]]));
  });

  bot.action("admin_stats_models", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatModelRanking(modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")]]));
  });

  bot.action("admin_stats_missing_models", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatMissingModelsRanking(modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")]]));
  });

  bot.action("admin_stats_new_clients", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatNewClientsStats(clientsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")]]));
  });

  // ── Faollik statistikasi ──
  bot.action("admin_stats_activity_menu", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText("Faollik statistikasi:", buildActivityStatsMenu());
  });

  bot.action("admin_stats_hourly", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatHourlyActivity(modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_activity_menu")]]));
  });

  bot.action("admin_stats_weekday", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatWeekdayActivity(modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_activity_menu")]]));
  });

  bot.action("admin_stats_busiest_day", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatBusiestDay(modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_activity_menu")]]));
  });

  // ── Mijozlar statistikasi ──
  bot.action("admin_stats_customers_menu", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText("Mijozlar statistikasi:", buildCustomerStatsMenu());
  });

  bot.action("admin_stats_weekly_trend", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatWeeklyNewClientsTrend(clientsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_customers_menu")]]));
  });

  bot.action("admin_stats_returning", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatReturningRate(modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_customers_menu")]]));
  });

  bot.action("admin_stats_coverage", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatCoverageRate(modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_customers_menu")]]));
  });

  bot.action("admin_stats_hopeless", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatHopelessClients(modelRequestsStore.getAll(), clientsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_customers_menu")]]));
  });

  bot.action("admin_stats_silent", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    const text = formatSilentStarters(clientsStore.getAll(), modelRequestsStore.getAll());
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "admin_stats_customers_menu")]]));
  });

  // ── Matn/media orqali FSM qadamlarini qayta ishlash ──
  bot.on("message", async (ctx, next) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return next();
    const state = getState(ctx.from.id);
    if (state.step === "idle") return next();

    const msg = ctx.message as unknown as Record<string, unknown>;
    const text = typeof msg["text"] === "string" ? (msg["text"] as string).trim() : undefined;

    if (state.step === "awaiting_model_name") {
      if (!text) { await ctx.reply("Model nomini matn qilib yozing."); return; }
      const exists = modelsStore.getAll().some((m) => m.name.toLowerCase() === text.toLowerCase());
      if (exists) { await ctx.reply(`"${text}" nomli model allaqachon bor. Boshqa nom yozing.`); return; }
      modelsStore.save({ name: text });
      setState(ctx.from.id, { step: "awaiting_video", modelName: text, chain: true });
      await ctx.reply(
        `"${text}" model sifatida saqlandi.\n\nVideo qo'llanma yuboring (video fayl) yoki havolasini matn qilib yozing.\nO'tkazib yuborish uchun /skip yozing.`
      );
      return;
    }

    if (state.step === "awaiting_video") {
      const model = modelsStore.getByName(state.modelName);
      if (!model) { clearState(ctx.from.id); return; }

      if ("video" in msg && msg["video"]) {
        const video = msg["video"] as { file_id: string };
        model.videoFileId = video.file_id;
        model.videoCaption = typeof msg["caption"] === "string" ? (msg["caption"] as string) : undefined;
        model.videoLink = undefined;
        modelsStore.save(model);
        await ctx.reply("Video saqlandi.");
      } else if (text === "/skip") {
        // o'tkazib yuborildi — hech narsa o'zgarmaydi
      } else if (text) {
        model.videoLink = text;
        model.videoFileId = undefined;
        model.videoCaption = undefined;
        modelsStore.save(model);
        await ctx.reply("Video havolasi saqlandi.");
      } else {
        await ctx.reply("Video fayl, havola (matn), yoki /skip yuboring.");
        return;
      }

      if (state.chain) {
        setState(ctx.from.id, { step: "awaiting_setup_link", modelName: state.modelName, chain: true });
        await ctx.reply("Sozlash ilovasi/portal havolasini yozing (ixtiyoriy).\nO'tkazib yuborish uchun /skip yozing.");
      } else {
        clearState(ctx.from.id);
        await showModelMenuNew(ctx, state.modelName);
      }
      return;
    }

    if (state.step === "awaiting_setup_link") {
      const model = modelsStore.getByName(state.modelName);
      if (!model) { clearState(ctx.from.id); return; }

      if (text === "/skip") {
        // o'tkazib yuborildi
      } else if (text) {
        model.setupLink = text;
        modelsStore.save(model);
        await ctx.reply("Sozlash havolasi saqlandi.");
      } else {
        await ctx.reply("Havolani matn qilib yozing, yoki /skip yuboring.");
        return;
      }

      if (state.chain) {
        setState(ctx.from.id, { step: "awaiting_description", modelName: state.modelName, chain: true });
        await ctx.reply("Qo'shimcha izoh yozing (ixtiyoriy).\nO'tkazib yuborish uchun /skip yozing.");
      } else {
        clearState(ctx.from.id);
        await showModelMenuNew(ctx, state.modelName);
      }
      return;
    }

    if (state.step === "awaiting_description") {
      const model = modelsStore.getByName(state.modelName);
      if (!model) { clearState(ctx.from.id); return; }

      if (text === "/skip") {
        // o'tkazib yuborildi
      } else if (text) {
        model.description = text;
        modelsStore.save(model);
        await ctx.reply("Izoh saqlandi.");
      } else {
        await ctx.reply("Izohni matn qilib yozing, yoki /skip yuboring.");
        return;
      }

      clearState(ctx.from.id);
      await ctx.reply("Model saqlandi.");
      await showModelMenuNew(ctx, state.modelName);
      return;
    }

    return next();
  });
}

// ─── Menyular ─────────────────────────────────────────────────────────────────

function buildMainMenu() {
  const total = clientsStore.count();
  return Markup.inlineKeyboard([
    [Markup.button.callback("Modellar ro'yxati", "admin_models_list"),
     Markup.button.callback("Yangi model", "admin_add_model")],
    [Markup.button.callback(`Mijozlar: ${total} ta`, "admin_noop")],
    [Markup.button.callback("Statistika", "admin_stats")],
  ]);
}

function buildStatsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Jami mijozlar", "admin_stats_general")],
    [Markup.button.callback("Eng ko'p so'ralgan modellar", "admin_stats_models")],
    [Markup.button.callback("Bazada yo'q modellar", "admin_stats_missing_models")],
    [Markup.button.callback("Yangi mijozlar (kunlik/haftalik)", "admin_stats_new_clients")],
    [Markup.button.callback("Faollik statistikasi ➜", "admin_stats_activity_menu"),
     Markup.button.callback("Mijozlar statistikasi ➜", "admin_stats_customers_menu")],
    [Markup.button.callback("⬅️ Asosiy menyu", "admin_back_main")],
  ]);
}

function buildActivityStatsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Soat bo'yicha faollik xaritasi", "admin_stats_hourly")],
    [Markup.button.callback("Hafta kuni bo'yicha faollik", "admin_stats_weekday")],
    [Markup.button.callback("Eng band kun (rekord)", "admin_stats_busiest_day")],
    [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
  ]);
}

function buildCustomerStatsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Haftalik yangi mijozlar dinamikasi", "admin_stats_weekly_trend")],
    [Markup.button.callback("Qaytgan mijozlar foizi", "admin_stats_returning"),
     Markup.button.callback("Model qamrov foizi", "admin_stats_coverage")],
    [Markup.button.callback("\"Umidsiz\" mijozlar ro'yxati", "admin_stats_hopeless")],
    [Markup.button.callback("/start bosib-u yozmaganlar", "admin_stats_silent")],
    [Markup.button.callback("⬅️ Statistikaga qaytish", "admin_stats")],
  ]);
}

function buildModelKeyboard(modelName: string) {
  const model = modelsStore.getByName(modelName);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Video: ${model ? videoStatusLabel(model) : "yo'q"}`, `admin_edit_video_${modelName}`)],
    [Markup.button.callback(`Sozlash havolasi: ${model?.setupLink ? short(model.setupLink, 25) : "yo'q"}`, `admin_edit_setuplink_${modelName}`)],
    [Markup.button.callback(`Izoh: ${model?.description ? short(model.description, 25) : "yo'q"}`, `admin_edit_description_${modelName}`)],
    [Markup.button.callback("Modelni o'chirish", `admin_delete_model_${modelName}`),
     Markup.button.callback("⬅️ Orqaga", "admin_models_list")],
  ]);
}

async function showModelMenu(ctx: BotContext, modelName: string, edit: boolean): Promise<void> {
  const text = modelName;
  if (edit) {
    await ctx.editMessageText(text, buildModelKeyboard(modelName));
  } else {
    await ctx.reply(text, buildModelKeyboard(modelName));
  }
}

async function showModelMenuNew(ctx: BotContext, modelName: string): Promise<void> {
  await showModelMenu(ctx, modelName, false);
}
