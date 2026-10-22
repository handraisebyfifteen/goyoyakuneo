/**
 * 日常モデルに渡すツール。仕様（名前・引数）と、実行（services / storage を呼ぶ）をここにまとめる。
 *
 * - 読むだけのツールは確認なしで実行する
 * - 書き込むツールは、本人が「はい」と言うまで実行しない（判定は agent.ts がコードで行う）
 * - ★ GUARDED のツールは、さらに合言葉が合うまで実行しない。合言葉そのものは AI に渡らない
 * - すべての金額は { amount, display } の形で返す。AI は display を読み上げる
 */
import type OpenAI from "openai";
import type { Owner, Language, WeekdayKey, BusinessHours } from "@shared/schema";
import { WEEKDAY_KEYS, settingsPatchSchema } from "@shared/schema";
import { cancelPolicyText, errorMessage, WEEKDAY_LABELS } from "@shared/i18n";
import { money, toMinor } from "@shared/money";
import * as storage from "../storage";
import { ApiError } from "../errors";
import { BookingError, availableSlots } from "../lib/booking";
import { isValidDate, isValidTime, isValidTimeZone, nowLocal, weekdayOf, addDays, monthRange, fromLocal, toLocal } from "../lib/time";
import {
  bookingSettings, busyAround, createReservationFor, cancelReservationFor, updateReservationFor,
  recordOnsitePaymentFor, salesSummaryFor, addBlockedSlotFor, reservationsOutsideHours, todayFor,
} from "../services";
import { createPaymentLink } from "../payments";

export const READ_TOOLS = new Set([
  "get_settings", "get_today_reservations", "get_reservations_by_date", "find_reservations_by_customer",
  "get_available_slots", "get_menus", "get_sales_summary", "get_cancel_policy", "check_cash",
]);
export const WRITE_TOOLS = new Set([
  "update_settings", "update_business_info", "set_business_hours", "update_booking_rules",
  "create_menu", "update_menu", "create_reservation", "update_reservation", "cancel_reservation",
  "add_blocked_slot", "delete_blocked_slot", "create_payment_link", "record_onsite_payment",
]);
/** お金や決まりに関わるもの → 合言葉も必要 */
export const GUARDED_TOOLS = new Set(["update_settings", "update_booking_rules", "cancel_reservation", "record_onsite_payment"]);
/** 相談モデルへの切り替え（日常モデルが判定して呼ぶ） */
export const ADVISOR_TOOL = "ask_advisor";

type Spec = OpenAI.Chat.Completions.ChatCompletionTool;
type Props = Record<string, Record<string, unknown>>;

function fn(name: string, description: string, properties: Props = {}, required: string[] = []): Spec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const DATE = { type: "string", description: "日付 YYYY-MM-DD / date YYYY-MM-DD" };
const TIME = { type: "string", description: "時刻 HH:MM（24時間）/ time HH:MM (24h)" };
const RID = { type: "integer", description: "予約の id（get_today_reservations などの結果にある id）/ reservation id from a listing" };
const STR = { type: "string" };
const INT = { type: "integer" };
const MONEY = { type: "number", description: "設定した通貨での普通の金額（5000円なら5000、49.99ドルなら49.99）/ amount in major units" };

export const TOOL_SPECS: Spec[] = [
  fn("get_settings", "国・通貨・時間帯・言語、店舗情報、営業時間、受付ルール、キャンセルの決まりを見る。"),
  fn("get_today_reservations", "今日の予約を見る。"),
  fn("get_reservations_by_date", "指定した日の予約を見る。", { date: DATE }, ["date"]),
  fn("find_reservations_by_customer", "お客さんの名前で今後の予約を探す。取り消しや変更の前に id を調べるのに使う。", { customer_name: STR }, ["customer_name"]),
  fn("get_available_slots", "その日に、そのメニューで予約できる時間を調べる。", { date: DATE, menu_name: STR }, ["date", "menu_name"]),
  fn("get_menus", "メニューの一覧（所要時間と料金）を見る。"),
  fn("get_sales_summary", "期間の売り上げを集計する。カード・現地払いの内訳、未払い、取り消し件数を返す。", { start_date: DATE, end_date: DATE }, ["start_date", "end_date"]),
  fn("get_cancel_policy", "キャンセルの決まりを見る。"),
  fn("check_cash", "現地払いで受け取ったお金をカメラで数え、おつりを計算する。記録はしない。", { reservation_id: RID }, ["reservation_id"]),

  fn("update_settings", "国・通貨・時間帯・言語を変える。", {
    country: { type: "string", description: "国コード2文字（例: JP, US）" },
    currency: { type: "string", description: "通貨コード3文字（例: JPY, USD）" },
    timezone: { type: "string", description: "時間帯（例: Asia/Tokyo, America/New_York）" },
    language: { type: "string", enum: ["ja", "en"] },
  }),
  fn("update_business_info", "店舗の情報（店名、住所、電話、お客さんへの案内、業種）を登録・変更する。言われた項目だけ渡す。", {
    shop_name: STR, address: STR, phone: STR, info: { type: "string", description: "お客さんへの案内（駐車場、持ち物など）" }, business_type: STR,
  }),
  fn("set_business_hours", "営業時間や定休日を決める。", {
    day: { type: "string", enum: [...WEEKDAY_KEYS, "weekdays", "weekend", "all"] },
    open: TIME, close: TIME, closed: { type: "boolean", description: "定休日にするなら true" },
  }, ["day"]),
  fn("update_booking_rules", "受付ルールとキャンセルの決まりを変える。言われた項目だけ渡す。", {
    buffer_minutes: { type: "integer", description: "施術と施術の間の空き時間（分）" },
    slot_step_minutes: { type: "integer", description: "空き時間を案内する刻み（分）" },
    max_days_ahead: { type: "integer", description: "お客さんが何日先まで予約できるか" },
    min_hours_before: { type: "integer", description: "お客さんの予約は何時間前までか" },
    free_cancel_hours_before: { type: "integer", description: "何時間前までのキャンセルなら全額返金か" },
    allow_card_payment: { type: "boolean", description: "予約時のカード前払いを許可するか" },
  }),
  fn("create_menu", "メニューを作る。", { name: STR, minutes: INT, price: MONEY, description: STR }, ["name", "minutes", "price"]),
  fn("update_menu", "メニューの名前・所要時間・料金を変える、または提供をやめる（active=false）。", {
    menu_name: STR, new_name: STR, minutes: INT, price: MONEY, active: { type: "boolean" },
  }, ["menu_name"]),
  fn("create_reservation", "予約を入れる。カード前払いなら支払いリンクが自動で用意される。", {
    date: DATE, time: TIME, menu_name: STR, customer_name: STR,
    payment_method: { type: "string", enum: ["card", "onsite"], description: "card=カード前払い, onsite=当日店舗で払う" },
    customer_phone: { type: "string", description: "お客さんの電話番号（わかれば）" },
    customer_email: { type: "string", description: "お客さんのメールアドレス（わかれば）" },
  }, ["date", "time", "menu_name", "customer_name", "payment_method"]),
  fn("update_reservation", "予約の日時やメニューを変える。", { reservation_id: RID, date: DATE, time: TIME, menu_name: STR }, ["reservation_id"]),
  fn("cancel_reservation", "予約を取り消す。カード支払い済みなら、返金の対象かどうかも返す（返金そのものは行わない）。", { reservation_id: RID }, ["reservation_id"]),
  fn("add_blocked_slot", "臨時休業や休憩の枠を入れる。start と end を省けば終日。", { date: DATE, start: TIME, end: TIME, reason: STR }, ["date"]),
  fn("delete_blocked_slot", "臨時休業や休憩の枠を取り消す。", { blocked_slot_id: { type: "integer" } }, ["blocked_slot_id"]),
  fn("create_payment_link", "カード前払いの予約に、支払いリンクを作り直す。", { reservation_id: RID }, ["reservation_id"]),
  fn("record_onsite_payment", "現地払いでお金を受け取ったことを記録する。", { reservation_id: RID, amount: MONEY }, ["reservation_id", "amount"]),

  fn(ADVISOR_TOOL, "経営の相談、分析、悩みや愚痴、「なぜ」「どうしたら」といった考える必要のある質問のときに呼ぶ。相談役のモデルが答える。予約や金額の操作には使わない。", {
    question: { type: "string", description: "本人の相談の内容（そのまま）" },
  }, ["question"]),
];

export type ToolResult = Record<string, unknown> & { ok: boolean; error?: string };

export class ToolContext {
  constructor(public owner: Owner, public lang: Language) {}
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v).trim());
const int = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number.parseInt(String(v), 10));
const bool = (v: unknown) => (v === undefined || v === null ? undefined : v === true || v === "true");

function weekdayLabel(date: string, lang: Language): string {
  return WEEKDAY_LABELS[lang][WEEKDAY_KEYS.indexOf(weekdayOf(date))];
}

async function requireMenu(ctx: ToolContext, name: unknown) {
  const n = str(name);
  const menu = n ? await storage.findMenuByName(ctx.owner.id, n) : undefined;
  if (!menu) {
    const all = await storage.listMenus(ctx.owner.id, true);
    const names = all.map((m) => storage.menuView(m, ctx.lang).name).join(ctx.lang === "ja" ? "、" : ", ");
    throw new ApiError("menu_not_found", 404, { names });
  }
  return menu;
}

async function requireReservation(ctx: ToolContext, id: unknown) {
  const n = int(id);
  const row = n ? await storage.getReservation(ctx.owner.id, n) : undefined;
  if (!row) throw new ApiError("reservation_not_found", 404);
  return row;
}

function view(ctx: ToolContext, r: storage.ReservationRow) {
  const v = storage.reservationView(r, ctx.owner.timezone, ctx.lang);
  // 読み上げ向けに曜日を足す。予約番号は AI に読ませないので渡さない
  const { number: _n, startAt: _s, endAt: _e, paymentUrl: _p, ...rest } = v;
  return { ...rest, weekday: weekdayLabel(v.date, ctx.lang), hasPaymentLink: !!v.paymentUrl };
}

/** ツールを1つ実行する。ApiError / BookingError は本人向けの文に、それ以外はログにだけ残す */
export async function executeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const impl = IMPL[name];
    if (!impl) return { ok: false, error: errorMessage("unknown_tool", ctx.lang, { name }) };
    return await impl(ctx, args ?? {});
  } catch (e) {
    if (e instanceof ApiError || e instanceof BookingError) return { ok: false, error: errorMessage(e.code, ctx.lang, e.params) };
    if (e instanceof Error && /invalid amount/.test(e.message)) return { ok: false, error: errorMessage("validation", ctx.lang) };
    console.error(`[tool_error] ${name}`, e);
    return { ok: false, error: errorMessage("server_error", ctx.lang) };
  }
}

type Impl = (ctx: ToolContext, a: Record<string, unknown>) => Promise<ToolResult>;

const IMPL: Record<string, Impl> = {
  // ---------- 読むだけ ----------
  async get_settings(ctx) {
    const o = ctx.owner;
    return {
      ok: true,
      settings: { country: o.country, currency: o.currency, timezone: o.timezone, language: o.language },
      business: { shopName: storage.shopName(o, ctx.lang), address: o.address, phone: o.phone, info: o.info, businessType: o.businessType },
      hours: o.hours,
      rules: { bufferMinutes: o.bufferMinutes, slotStepMinutes: o.slotStepMinutes, maxDaysAhead: o.maxDaysAhead, minHoursBefore: o.minHoursBefore, freeCancelHoursBefore: o.freeCancelHoursBefore, allowCardPayment: o.allowCardPayment },
      cancelPolicy: cancelPolicyText(o.freeCancelHoursBefore, ctx.lang),
      hasPassphrase: !!o.passphraseHash,
      bookingPath: `/book/${o.slug}`,
    };
  },
  async get_today_reservations(ctx) {
    const date = todayFor(ctx.owner);
    const rows = await storage.listReservationsByDates(ctx.owner.id, ctx.owner.timezone, date, date);
    return { ok: true, date, weekday: weekdayLabel(date, ctx.lang), count: rows.length, reservations: rows.map((r) => view(ctx, r)) };
  },
  async get_reservations_by_date(ctx, a) {
    const date = str(a.date) ?? "";
    if (!isValidDate(date)) throw new ApiError("invalid_date");
    const rows = await storage.listReservationsByDates(ctx.owner.id, ctx.owner.timezone, date, date);
    const tz = ctx.owner.timezone;
    const blocked = await storage.listBlockedSlots(ctx.owner.id, fromLocal(date, "00:00", tz), fromLocal(addDays(date, 1), "00:00", tz));
    return { ok: true, date, weekday: weekdayLabel(date, ctx.lang), count: rows.length, reservations: rows.map((r) => view(ctx, r)),
      blockedSlots: blocked.map((b) => ({ id: b.id, reason: b.reason, start: toLocal(b.startAt, tz).time, end: toLocal(b.endAt, tz).time })) };
  },
  async find_reservations_by_customer(ctx, a) {
    const name = str(a.customer_name) ?? "";
    if (!name) throw new ApiError("name_required");
    const rows = (await storage.listReservationsByCustomer(ctx.owner.id, name)).filter((r) => r.endAt.getTime() > Date.now() - 86400000 * 7);
    return { ok: true, count: rows.length, reservations: rows.map((r) => view(ctx, r)) };
  },
  async get_available_slots(ctx, a) {
    const date = str(a.date) ?? "";
    if (!isValidDate(date)) throw new ApiError("invalid_date");
    const menu = await requireMenu(ctx, a.menu_name);
    const busy = await busyAround(ctx.owner, date);
    const r = availableSlots({ settings: bookingSettings(ctx.owner), date, minutes: menu.minutes, ...busy, source: "owner" });
    return { ok: true, date, weekday: weekdayLabel(date, ctx.lang), menuName: storage.menuView(menu, ctx.lang).name, closed: r.closed, slots: r.slots };
  },
  async get_menus(ctx) {
    const all = await storage.listMenus(ctx.owner.id);
    return { ok: true, menus: all.map((m) => { const v = storage.menuView(m, ctx.lang); return { id: v.id, name: v.name, minutes: v.minutes, price: v.price, active: v.active, description: v.description }; }) };
  },
  async get_sales_summary(ctx, a) {
    const today = todayFor(ctx.owner);
    const from = str(a.start_date) || monthRange(today).from;
    const to = str(a.end_date) || monthRange(today).to;
    if (!isValidDate(from) || !isValidDate(to)) throw new ApiError("invalid_date");
    return { ok: true, ...(await salesSummaryFor(ctx.owner, from, to, ctx.lang)) };
  },
  async get_cancel_policy(ctx) {
    return { ok: true, freeCancelHoursBefore: ctx.owner.freeCancelHoursBefore, cancelPolicy: cancelPolicyText(ctx.owner.freeCancelHoursBefore, ctx.lang) };
  },
  async check_cash(ctx, a) {
    // 写真を撮るのは画面側。ここでは予約が現地払い待ちかを確かめ、画面にカメラを開くよう伝える（読み取りはフェーズ4）
    const row = await requireReservation(ctx, a.reservation_id);
    if (row.paymentStatus !== "onsite_pending") throw new ApiError("not_onsite_pending");
    return { ok: true, action: "open_camera", reservationId: row.id, customerName: row.customer.name, due: money(row.price, row.currency, ctx.lang),
      note: ctx.lang === "ja" ? "カメラを開きます。カメラのボタンを押して、受け取ったお金を写してください。読み取りの結果は別に読み上げます。" : "Opening the camera. Press the camera button and photograph the cash you received. The reading will be read out separately." };
  },

  // ---------- 書き込む（確認あり） ----------
  async update_settings(ctx, a) {
    const patch = settingsPatchSchema.pick({ country: true, currency: true, timezone: true, language: true }).parse({
      country: str(a.country) || undefined, currency: str(a.currency) || undefined, timezone: str(a.timezone) || undefined, language: str(a.language) || undefined,
    });
    if (patch.country) patch.country = patch.country.toUpperCase();
    if (patch.currency) {
      patch.currency = patch.currency.toUpperCase();
      if (patch.currency !== ctx.owner.currency && (await storage.ownerHasMenusOrReservations(ctx.owner.id))) throw new ApiError("currency_locked");
    }
    if (patch.timezone && !isValidTimeZone(patch.timezone)) throw new ApiError("invalid_timezone");
    const o = await storage.updateOwner(ctx.owner.id, patch);
    ctx.owner = o;
    return { ok: true, settings: { country: o.country, currency: o.currency, timezone: o.timezone, language: o.language } };
  },
  async update_business_info(ctx, a) {
    const patch: Record<string, string> = {};
    const name = str(a.shop_name);
    if (name) { if (ctx.lang === "ja") patch.shopNameJa = name; else patch.shopNameEn = name; }
    for (const [from, to] of [["address", "address"], ["phone", "phone"], ["info", "info"], ["business_type", "businessType"]] as const) {
      const v = str(a[from]);
      if (v !== undefined) patch[to] = v;
    }
    const o = await storage.updateOwner(ctx.owner.id, settingsPatchSchema.parse(patch));
    ctx.owner = o;
    return { ok: true, business: { shopName: storage.shopName(o, ctx.lang), address: o.address, phone: o.phone, info: o.info, businessType: o.businessType } };
  },
  async set_business_hours(ctx, a) {
    const day = str(a.day) ?? "";
    const groups: Record<string, readonly WeekdayKey[]> = { all: WEEKDAY_KEYS, weekdays: WEEKDAY_KEYS.slice(0, 5), weekend: WEEKDAY_KEYS.slice(5) };
    const days = groups[day] ?? (WEEKDAY_KEYS.includes(day as WeekdayKey) ? [day as WeekdayKey] : null);
    if (!days) throw new ApiError("validation");
    const closed = bool(a.closed) ?? false;
    const open = str(a.open), close = str(a.close);
    if (!closed && (!open || !close || !isValidTime(open) || !isValidTime(close) || open >= close)) throw new ApiError("invalid_time");
    const hours: BusinessHours = { ...ctx.owner.hours };
    for (const d of days) hours[d] = closed ? null : { open: open!, close: close! };
    const o = await storage.updateOwner(ctx.owner.id, { hours });
    ctx.owner = o;
    const outside = await reservationsOutsideHours(o, ctx.lang);
    return { ok: true, hours, reservationsNowOutsideHours: outside };
  },
  async update_booking_rules(ctx, a) {
    const patch = settingsPatchSchema.pick({ bufferMinutes: true, slotStepMinutes: true, maxDaysAhead: true, minHoursBefore: true, freeCancelHoursBefore: true, allowCardPayment: true }).parse({
      bufferMinutes: int(a.buffer_minutes), slotStepMinutes: int(a.slot_step_minutes), maxDaysAhead: int(a.max_days_ahead),
      minHoursBefore: int(a.min_hours_before), freeCancelHoursBefore: int(a.free_cancel_hours_before), allowCardPayment: bool(a.allow_card_payment),
    });
    const o = await storage.updateOwner(ctx.owner.id, patch);
    ctx.owner = o;
    return { ok: true, rules: { bufferMinutes: o.bufferMinutes, slotStepMinutes: o.slotStepMinutes, maxDaysAhead: o.maxDaysAhead, minHoursBefore: o.minHoursBefore, freeCancelHoursBefore: o.freeCancelHoursBefore, allowCardPayment: o.allowCardPayment },
      cancelPolicy: cancelPolicyText(o.freeCancelHoursBefore, ctx.lang) };
  },
  async create_menu(ctx, a) {
    const name = str(a.name) ?? "";
    const minutes = int(a.minutes) ?? 0;
    if (!name || minutes <= 0) throw new ApiError("validation");
    const price = toMinor(a.price as number, ctx.owner.currency);
    if (price < 0) throw new ApiError("validation");
    if (await storage.findMenuByName(ctx.owner.id, name)) return { ok: false, error: ctx.lang === "ja" ? `「${name}」というメニューはすでにあります` : `A menu called "${name}" already exists.` };
    const all = await storage.listMenus(ctx.owner.id);
    const desc = str(a.description) ?? "";
    const m = await storage.createMenu({ ownerId: ctx.owner.id, nameJa: name, nameEn: name, minutes, price, currency: ctx.owner.currency,
      descriptionJa: desc, descriptionEn: desc, active: true, sortOrder: all.length });
    const v = storage.menuView(m, ctx.lang);
    return { ok: true, menu: { id: v.id, name: v.name, minutes: v.minutes, price: v.price } };
  },
  async update_menu(ctx, a) {
    const menu = await requireMenu(ctx, a.menu_name);
    const patch: Record<string, unknown> = {};
    const nn = str(a.new_name);
    if (nn) { patch.nameJa = nn; patch.nameEn = nn; }
    if (a.minutes !== undefined) { const m = int(a.minutes) ?? 0; if (m <= 0) throw new ApiError("validation"); patch.minutes = m; }
    if (a.price !== undefined) { const p = toMinor(a.price as number, ctx.owner.currency); if (p < 0) throw new ApiError("validation"); patch.price = p; }
    if (a.active !== undefined) patch.active = bool(a.active);
    const m = await storage.updateMenu(ctx.owner.id, menu.id, patch);
    const v = storage.menuView(m ?? menu, ctx.lang);
    return { ok: true, menu: { id: v.id, name: v.name, minutes: v.minutes, price: v.price, active: v.active } };
  },
  async create_reservation(ctx, a) {
    const menu = await requireMenu(ctx, a.menu_name);
    const pm = str(a.payment_method);
    if (pm !== "card" && pm !== "onsite") throw new ApiError("validation");
    const r = await createReservationFor(ctx.owner, {
      menu, date: str(a.date) ?? "", time: str(a.time) ?? "", customerName: str(a.customer_name) ?? "",
      customerPhone: str(a.customer_phone), customerEmail: str(a.customer_email), paymentMethod: pm, source: "owner", lang: ctx.lang,
    });
    const row = await storage.getReservation(ctx.owner.id, r.reservation.id);
    return { ok: true, reservation: row ? view(ctx, row) : r.reservation,
      paymentLink: pm === "card" ? (r.paymentNote === "failed" ? "failed" : r.paymentNote === "placeholder" ? "placeholder_created" : "created") : null,
      email: r.emailNote,
      note: [
        pm === "card" ? (ctx.lang === "ja" ? "支払いリンクを用意しました。" : "A payment link has been prepared.") : "",
        r.emailNote === "sent" ? (ctx.lang === "ja" ? "確認メールを送りました。" : "A confirmation email was sent.")
          : r.emailNote === "logged" ? (ctx.lang === "ja" ? "メールの設定がないため、確認メールは送らずに記録だけしました。" : "Email is not configured, so the confirmation was only logged.")
          : r.emailNote === "limit" ? (ctx.lang === "ja" ? "本日のメール送信の上限に達したため、確認メールは送っていません。" : "Today's email limit was reached, so no confirmation email was sent.")
          : r.emailNote === "failed" ? (ctx.lang === "ja" ? "確認メールを送れませんでした。" : "The confirmation email could not be sent.") : "",
      ].filter(Boolean).join(" ") };
  },
  async update_reservation(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    const menu = a.menu_name ? await requireMenu(ctx, a.menu_name) : undefined;
    const date = str(a.date), time = str(a.time);
    if (date && !isValidDate(date)) throw new ApiError("invalid_date");
    if (time && !isValidTime(time)) throw new ApiError("invalid_time");
    const r = await updateReservationFor(ctx.owner, row, { date, time, menu, lang: ctx.lang });
    const updated = await storage.getReservation(ctx.owner.id, row.id);
    return { ok: true, reservation: updated ? view(ctx, updated) : r.reservation };
  },
  async cancel_reservation(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    const r = await cancelReservationFor(ctx.owner, row, ctx.lang);
    const updated = await storage.getReservation(ctx.owner.id, row.id);
    const note = !r.wasPaid ? "" : r.refundEligible
      ? (ctx.lang === "ja" ? "キャンセルの決まりでは全額返金の対象です。返金はオーナーご本人が Stripe で行ってください。" : "Under the cancellation policy this is eligible for a full refund. Please issue it yourself in Stripe.")
      : (ctx.lang === "ja" ? "キャンセルの期限を過ぎているため、決まりでは返金の対象外です。" : "The cancellation deadline has passed, so this is not refundable under the policy.");
    return { ok: true, reservation: updated ? view(ctx, updated) : r.reservation, wasPaid: r.wasPaid, refundEligible: r.refundEligible, note };
  },
  async add_blocked_slot(ctx, a) {
    const b = await addBlockedSlotFor(ctx.owner, { date: str(a.date) ?? "", start: str(a.start) || undefined, end: str(a.end) || undefined, reason: str(a.reason) });
    return { ok: true, blockedSlot: { id: b.id, date: str(a.date), start: str(a.start) ?? null, end: str(a.end) ?? null, reason: b.reason } };
  },
  async delete_blocked_slot(ctx, a) {
    const ok = await storage.deleteBlockedSlot(ctx.owner.id, int(a.blocked_slot_id) ?? 0);
    if (!ok) throw new ApiError("blocked_slot_not_found", 404);
    return { ok: true };
  },
  async create_payment_link(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    if (row.paymentMethod !== "card" || row.paymentStatus !== "unpaid") throw new ApiError("not_card_unpaid");
    const link = await createPaymentLink(ctx.owner, row);
    await storage.updateReservation(ctx.owner.id, row.id, { paymentUrl: link.url, stripeSessionId: link.sessionId });
    return { ok: true, placeholder: link.placeholder, note: link.placeholder
      ? (ctx.lang === "ja" ? "Stripe のキーが未設定のため仮のリンクです。" : "Stripe is not configured, so this is a placeholder link.") : "" };
  },
  async record_onsite_payment(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    const amount = toMinor(a.amount as number, row.currency);
    const r = await recordOnsitePaymentFor(ctx.owner, row, amount, ctx.lang);
    const note = r.differs ? (ctx.lang === "ja"
      ? `料金${money(row.price, row.currency, ctx.lang).display}と受け取り額${money(amount, row.currency, ctx.lang).display}が違います`
      : `The price ${money(row.price, row.currency, ctx.lang).display} and the amount received ${money(amount, row.currency, ctx.lang).display} differ.`) : "";
    const updated = await storage.getReservation(ctx.owner.id, row.id);
    return { ok: true, reservation: updated ? view(ctx, updated) : r.reservation, note };
  },
};

/**
 * 確認文のもとになる、人が読める要約。参照（メニュー名・予約 id）を実物に解決してから作る。
 * 相談モデルはこれを一文に整える。モデルが使えないときは、この文をそのまま読み上げる。
 */
export async function describeAction(ctx: ToolContext, name: string, a: Record<string, unknown>): Promise<string> {
  const ja = ctx.lang === "ja";
  const o = ctx.owner;
  const when = (date?: string, time?: string) => date ? spokenWhen(date, time, ctx.lang) : "";
  const menuLine = async (n: unknown) => { const m = n ? await storage.findMenuByName(o.id, String(n)) : undefined; return m ? `${storage.menuView(m, ctx.lang).name}（${storage.menuView(m, ctx.lang).price.display}）` : String(n ?? ""); };
  const resLine = async (id: unknown) => { const n = int(id); const r = n ? await storage.getReservation(o.id, n) : undefined; if (!r) return ja ? "見つからない予約" : "an unknown booking"; const v = storage.reservationView(r, o.timezone, ctx.lang); return `${when(v.date, v.time)} ${v.customerName}${ja ? "さん" : ""} ${v.menuName}`; };
  const fmt = (v: unknown) => { try { return money(toMinor(v as number, o.currency), o.currency, ctx.lang).display; } catch { return String(v); } };
  switch (name) {
    case "create_reservation":
      return ja
        ? `${when(str(a.date), str(a.time))}に、${storage.cleanName(str(a.customer_name) ?? "")}さん、${await menuLine(a.menu_name)}、${a.payment_method === "card" ? "カード前払い" : "当日払い"}で予約を入れる`
        : `book ${storage.cleanName(str(a.customer_name) ?? "")} for ${await menuLine(a.menu_name)} on ${when(str(a.date), str(a.time))}, paying ${a.payment_method === "card" ? "by card in advance" : "at the shop"}`;
    case "update_reservation": {
      const parts = [a.date || a.time ? when(str(a.date) ?? "", str(a.time)) : "", a.menu_name ? await menuLine(a.menu_name) : ""].filter(Boolean).join(ja ? "、" : ", ");
      return ja ? `${await resLine(a.reservation_id)}の予約を、${parts}に変更する` : `change the booking for ${await resLine(a.reservation_id)} to ${parts}`;
    }
    case "cancel_reservation": return ja ? `${await resLine(a.reservation_id)}の予約を取り消す` : `cancel the booking for ${await resLine(a.reservation_id)}`;
    case "record_onsite_payment": return ja ? `${await resLine(a.reservation_id)}の現地払いとして、${fmt(a.amount)}を受け取ったと記録する` : `record ${fmt(a.amount)} received on site for ${await resLine(a.reservation_id)}`;
    case "create_payment_link": return ja ? `${await resLine(a.reservation_id)}の支払いリンクを作り直す` : `recreate the payment link for ${await resLine(a.reservation_id)}`;
    case "create_menu": return ja ? `メニュー「${a.name}」を${a.minutes}分、${fmt(a.price)}で作る` : `create the menu "${a.name}", ${a.minutes} minutes, ${fmt(a.price)}`;
    case "update_menu": {
      const ch = [a.new_name ? (ja ? `名前を「${a.new_name}」に` : `rename to "${a.new_name}"`) : "", a.minutes !== undefined ? (ja ? `所要時間を${a.minutes}分に` : `${a.minutes} minutes`) : "",
        a.price !== undefined ? (ja ? `料金を${fmt(a.price)}に` : `price ${fmt(a.price)}`) : "", a.active !== undefined ? (bool(a.active) ? (ja ? "提供を再開" : "make active") : (ja ? "提供をやめる" : "make inactive")) : ""].filter(Boolean).join(ja ? "、" : ", ");
      return ja ? `メニュー「${a.menu_name}」を${ch}変更する` : `change the menu "${a.menu_name}": ${ch}`;
    }
    case "add_blocked_slot": return ja ? `${when(str(a.date), str(a.start))}${a.end ? `から${a.end}まで` : "は終日"}お休みにする${a.reason ? `（${a.reason}）` : ""}` : `block ${when(str(a.date), str(a.start))}${a.end ? ` to ${a.end}` : " all day"}${a.reason ? ` (${a.reason})` : ""}`;
    case "delete_blocked_slot": return ja ? "お休みの枠を取り消す" : "remove the time-off slot";
    case "set_business_hours": {
      const d = String(a.day);
      const label = d === "all" ? (ja ? "毎日" : "every day") : d === "weekdays" ? (ja ? "平日" : "weekdays") : d === "weekend" ? (ja ? "土日" : "weekends") : WEEKDAY_LABELS[ctx.lang][WEEKDAY_KEYS.indexOf(d as WeekdayKey)] ?? d;
      return bool(a.closed) ? (ja ? `${label}を定休日にする` : `make ${label} a closing day`) : (ja ? `${label}の営業時間を${a.open}から${a.close}までにする` : `set ${label} hours to ${a.open}–${a.close}`);
    }
    case "update_booking_rules": {
      const L: Record<string, [string, string, string, string]> = {
        buffer_minutes: ["施術間の空き時間", "gap between sessions", "分", " minutes"], slot_step_minutes: ["案内の刻み", "time step", "分", " minutes"],
        max_days_ahead: ["お客さんが予約できる先", "booking window", "日先まで", " days ahead"], min_hours_before: ["お客さんの予約の締め切り", "booking cutoff", "時間前まで", " hours before"],
        free_cancel_hours_before: ["全額返金の期限", "full-refund deadline", "時間前まで", " hours before"], allow_card_payment: ["カード前払いの許可", "card prepayment", "", ""],
      };
      const ch = Object.entries(a).filter(([k, v]) => k in L && v !== undefined && v !== null).map(([k, v]) => `${L[k][ja ? 0 : 1]}${ja ? "を" : ": "}${typeof v === "boolean" ? (v ? (ja ? "あり" : "allowed") : (ja ? "なし" : "not allowed")) : `${v}${L[k][ja ? 2 : 3]}`}${ja ? "に" : ""}`).join(ja ? "、" : ", ");
      return ja ? `受付ルールを${ch}変更する` : `change booking rules: ${ch}`;
    }
    case "update_settings": {
      const ch = Object.entries(a).filter(([, v]) => v).map(([k, v]) => `${({ country: ja ? "国" : "country", currency: ja ? "通貨" : "currency", timezone: ja ? "時間帯" : "time zone", language: ja ? "言語" : "language" } as Record<string, string>)[k] ?? k}${ja ? "を" : ": "}${v}${ja ? "に" : ""}`).join(ja ? "、" : ", ");
      return ja ? `設定を${ch}変更する` : `change settings: ${ch}`;
    }
    case "update_business_info": {
      const ch = Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${({ shop_name: ja ? "店名" : "shop name", address: ja ? "住所" : "address", phone: ja ? "電話番号" : "phone", info: ja ? "案内" : "notes", business_type: ja ? "業種" : "business type" } as Record<string, string>)[k] ?? k}${ja ? "を「" : ": "}${v}${ja ? "」に" : ""}`).join(ja ? "、" : ", ");
      return ja ? `店舗情報を${ch}変更する` : `change shop details: ${ch}`;
    }
    default: return ja ? `${name} を実行する` : `run ${name}`;
  }
}

/**
 * 書き込むツールの引数を、確認文を作る前に検査する。足りなければ理由を返し、AI に言い直させる
 * （「undefined を記録しますか」のような確認を本人に読み上げないため）
 */
export async function validateToolArgs(ctx: ToolContext, name: string, a: Record<string, unknown>): Promise<string | null> {
  const spec = TOOL_SPECS.find((t) => t.function.name === name);
  const required = (spec?.function.parameters?.required as string[] | undefined) ?? [];
  const missing = required.filter((k) => a[k] === undefined || a[k] === null || String(a[k]).trim() === "");
  if (missing.length) return ctx.lang === "ja" ? `引数が足りません: ${missing.join(", ")}。履歴やツールで調べてから、もう一度呼んでください` : `Missing arguments: ${missing.join(", ")}. Look them up (history or tools) and call again.`;
  try {
    if ("reservation_id" in a) await requireReservation(ctx, a.reservation_id);
    if (name === "create_reservation" || name === "update_menu" || (name === "update_reservation" && a.menu_name)) await requireMenu(ctx, name === "update_menu" ? a.menu_name : a.menu_name);
    if (name === "record_onsite_payment" || name === "create_menu" || (name === "update_menu" && a.price !== undefined)) {
      const key = name === "record_onsite_payment" ? "amount" : "price";
      if (a[key] !== undefined && !(Number(a[key]) >= 0) ) return errorMessage("validation", ctx.lang);
      if (name === "record_onsite_payment" && !(Number(a.amount) > 0)) return errorMessage("validation", ctx.lang);
    }
    if (["create_reservation", "update_reservation", "add_blocked_slot"].includes(name)) {
      if (a.date !== undefined && !isValidDate(String(a.date))) return errorMessage("invalid_date", ctx.lang);
      for (const k of ["time", "start", "end"]) if (a[k] !== undefined && a[k] !== "" && !isValidTime(String(a[k]))) return errorMessage("invalid_time", ctx.lang);
    }
  } catch (e) {
    if (e instanceof ApiError) return errorMessage(e.code, ctx.lang, e.params);
    throw e;
  }
  return null;
}

/** 読み上げ向けの日時：「10月24日（土曜日）15時00分」/ "Saturday, October 24 at 15:00" */
export function spokenWhen(date: string, time: string | undefined, lang: Language): string {
  if (!isValidDate(date)) return `${date}${time ? ` ${time}` : ""}`;
  const [y, m, d] = date.split("-").map(Number);
  const wd = weekdayLabel(date, lang);
  if (lang === "ja") {
    const [hh, mm] = (time ?? "").split(":");
    const t = time ? `${Number(hh)}時${mm === "00" ? "" : `${Number(mm)}分`}` : "";
    return `${m}月${d}日（${wd}）${t}`;
  }
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${wd}, ${month} ${d}${time ? ` at ${time}` : ""}`;
}

/** 今日の日付などを AI に伝えるための、オーナーの時間帯での時計 */
export function clockFor(owner: Owner) {
  const now = nowLocal(owner.timezone);
  return { ...now, tomorrow: addDays(now.date, 1), month: monthRange(now.date) };
}
