/**
 * 予約を入れる・取り消すときの一連の流れ。
 * 画面の予約ページ、オーナーの声（AI のツール）、どちらからも同じ関数を呼ぶ。
 */
import type { Owner, Menu, Language } from "@shared/schema";
import * as storage from "./storage";
import { checkBookable, refundEligible, type Busy } from "./lib/booking";
import { fromLocal, addDays, nowLocal, isValidDate, isValidTime, weekdayOf, timeToMinutes } from "./lib/time";
import { money } from "@shared/money";
import { ApiError } from "./errors";
import { createPaymentLink } from "./payments";
import { sendBookingConfirmation, type EmailNote } from "./email";

export function bookingSettings(owner: Owner) {
  return {
    timezone: owner.timezone, language: owner.language, hours: owner.hours,
    bufferMinutes: owner.bufferMinutes, slotStepMinutes: owner.slotStepMinutes,
    maxDaysAhead: owner.maxDaysAhead, minHoursBefore: owner.minHoursBefore,
  };
}

/** その日の前後も含めて、重なりの判定に使う予約と休みの枠を集める */
export async function busyAround(owner: Owner, date: string): Promise<{ reservations: Busy[]; blocked: Busy[] }> {
  const from = fromLocal(addDays(date, -1), "00:00", owner.timezone);
  const to = fromLocal(addDays(date, 2), "00:00", owner.timezone);
  const rs = await storage.listReservationsBetween(owner.id, from, to);
  const bs = await storage.listBlockedSlots(owner.id, from, to);
  return {
    reservations: rs.map((r) => ({ id: r.id, startAt: r.startAt, endAt: r.endAt, label: r.customer.name })),
    blocked: bs.map((b) => ({ id: b.id, startAt: b.startAt, endAt: b.endAt, label: b.reason })),
  };
}

export type CreateReservationInput = {
  menu: Menu;
  date: string;
  time: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string | null;
  paymentMethod: "card" | "onsite";
  source: "web" | "owner";
  lang: Language;
};

export async function createReservationFor(owner: Owner, input: CreateReservationInput) {
  const name = storage.cleanName(input.customerName);
  if (!name) throw new ApiError("name_required");
  const phone = storage.cleanPhone(input.customerPhone ?? "");
  if (input.source === "web" && !phone) throw new ApiError("phone_required");
  const email = (input.customerEmail ?? "").trim() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError("invalid_email");
  if (input.paymentMethod === "card" && !owner.allowCardPayment && input.source === "web") throw new ApiError("card_not_allowed");

  const busy = await busyAround(owner, input.date);
  const { startAt, endAt } = checkBookable({
    settings: bookingSettings(owner), date: input.date, time: input.time, minutes: input.menu.minutes,
    reservations: busy.reservations, blocked: busy.blocked, source: input.source,
  });

  const customer = await storage.upsertCustomer(owner.id, name, phone, email);
  let row = await storage.createReservation({
    ownerId: owner.id, customerId: customer.id, menuId: input.menu.id,
    menuNameJa: input.menu.nameJa, menuNameEn: input.menu.nameEn, minutes: input.menu.minutes,
    price: input.menu.price, currency: input.menu.currency, startAt, endAt,
    status: "confirmed", source: input.source, paymentMethod: input.paymentMethod,
    paymentStatus: input.paymentMethod === "card" ? "unpaid" : "onsite_pending",
  });

  let paymentNote: string | null = null;
  if (input.paymentMethod === "card") {
    // カード払いなら支払いリンクを自動で作る（失敗しても予約は残す。理由はログへ）
    try {
      const link = await createPaymentLink(owner, row);
      row = (await storage.updateReservation(owner.id, row.id, { paymentUrl: link.url, stripeSessionId: link.sessionId })) ?? row;
      if (link.placeholder) paymentNote = "placeholder";
    } catch (e) {
      console.error("[payment_link]", e);
      paymentNote = "failed";
    }
  }
  // メールがあれば確認メールを自動で送る（本人の確認は予約の時点で済んでいる）。失敗しても予約は残す
  let emailNote: EmailNote = "no_email";
  try {
    emailNote = await sendBookingConfirmation(owner, row);
  } catch (e) {
    console.error("[email]", e);
    emailNote = "failed";
  }
  return { reservation: storage.reservationView(row, owner.timezone, input.lang), paymentNote, emailNote };
}

export async function cancelReservationFor(owner: Owner, row: storage.ReservationRow, lang: Language) {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  const wasPaid = row.paymentStatus === "paid";
  const updated = await storage.updateReservation(owner.id, row.id, { status: "cancelled", cancelledAt: new Date() });
  const eligible = wasPaid ? refundEligible(row.startAt, owner.freeCancelHoursBefore) : null;
  return { reservation: storage.reservationView(updated ?? row, owner.timezone, lang), refundEligible: eligible, wasPaid };
}

export function todayFor(owner: Owner): string {
  return nowLocal(owner.timezone).date;
}

// ---------- 予約の変更・現地払いの記録（AI のツールと画面の両方から使う） ----------

export type UpdateReservationInput = { date?: string; time?: string; menu?: Menu; lang: Language };

export async function updateReservationFor(owner: Owner, row: storage.ReservationRow, input: UpdateReservationInput) {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  const cur = storage.reservationView(row, owner.timezone, input.lang);
  const date = input.date ?? cur.date;
  const time = input.time ?? cur.time;
  const menu = input.menu;
  if (menu && row.paymentStatus === "paid" && menu.price !== row.price) throw new ApiError("paid_menu_locked");
  const minutes = menu ? menu.minutes : row.minutes;
  const busy = await busyAround(owner, date);
  const { startAt, endAt } = checkBookable({
    settings: bookingSettings(owner), date, time, minutes,
    reservations: busy.reservations, blocked: busy.blocked, source: "owner", ignoreId: row.id,
  });
  const patch: Partial<typeof row> = { startAt, endAt };
  if (menu) Object.assign(patch, { menuId: menu.id, menuNameJa: menu.nameJa, menuNameEn: menu.nameEn, minutes: menu.minutes, price: menu.price });
  const updated = await storage.updateReservation(owner.id, row.id, patch);
  return { reservation: storage.reservationView(updated ?? row, owner.timezone, input.lang) };
}

export async function recordOnsitePaymentFor(owner: Owner, row: storage.ReservationRow, amountMinor: number, lang: Language) {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  if (row.paymentStatus !== "onsite_pending") throw new ApiError("not_onsite_pending");
  if (amountMinor <= 0) throw new ApiError("validation");
  const updated = await storage.updateReservation(owner.id, row.id, { paymentStatus: "onsite_received", amountReceived: amountMinor, status: "completed" });
  return { reservation: storage.reservationView(updated ?? row, owner.timezone, lang), differs: amountMinor !== row.price };
}

/** 期間の売り上げ：カード・現地払いの内訳、未払いの件数と金額、取り消し件数 */
export async function salesSummaryFor(owner: Owner, from: string, to: string, lang: Language) {
  const rows = await storage.listReservationsByDates(owner.id, owner.timezone, from, to, true);
  const cur = owner.currency;
  const sum = (f: (r: storage.ReservationRow) => boolean, pick: (r: storage.ReservationRow) => number) => rows.filter(f).reduce((a, r) => a + pick(r), 0);
  // 取り消し済みの予約は売り上げに入れない。カード支払い済みのまま取り消されたものは「返金待ち」として別に数える
  const live = (r: storage.ReservationRow) => r.status !== "cancelled";
  const card = sum((r) => live(r) && r.paymentStatus === "paid", (r) => r.amountReceived);
  const onsite = sum((r) => live(r) && r.paymentStatus === "onsite_received", (r) => r.amountReceived);
  const waiting = rows.filter((r) => live(r) && (r.paymentStatus === "unpaid" || r.paymentStatus === "onsite_pending"));
  const refundPending = rows.filter((r) => r.status === "cancelled" && r.paymentStatus === "paid");
  return {
    from, to, currency: cur,
    total: money(card + onsite, cur, lang), cardTotal: money(card, cur, lang), onsiteTotal: money(onsite, cur, lang),
    paidCount: rows.filter((r) => live(r) && (r.paymentStatus === "paid" || r.paymentStatus === "onsite_received")).length,
    waitingCount: waiting.length, waitingAmount: money(waiting.reduce((a, r) => a + r.price, 0), cur, lang),
    cancelledCount: rows.filter((r) => r.status === "cancelled").length,
    refundPendingCount: refundPending.length, refundPendingAmount: money(refundPending.reduce((a, r) => a + r.amountReceived, 0), cur, lang),
    reservationCount: rows.filter(live).length,
  };
}

/** 臨時休業・休憩の枠を入れる。予約と重なっていたら止める */
export async function addBlockedSlotFor(owner: Owner, input: { date: string; start?: string; end?: string; reason?: string }) {
  if (!isValidDate(input.date)) throw new ApiError("invalid_date");
  if ((input.start && !isValidTime(input.start)) || (input.end && !isValidTime(input.end))) throw new ApiError("invalid_time");
  const startAt = fromLocal(input.date, input.start ?? "00:00", owner.timezone);
  const endAt = input.end ? fromLocal(input.date, input.end, owner.timezone) : fromLocal(addDays(input.date, 1), "00:00", owner.timezone);
  if (endAt <= startAt) throw new ApiError("invalid_time");
  const clash = await storage.listReservationsBetween(owner.id, startAt, endAt);
  if (clash.length) throw new ApiError("overlap", 409, { time: storage.reservationView(clash[0], owner.timezone, "ja").time, name: clash[0].customer.name, buffer: 0 });
  return storage.createBlockedSlot({ ownerId: owner.id, startAt, endAt, reason: input.reason ?? "" });
}

/** 営業時間を変えたあと、新しい時間から外れる今後の予約を知らせる */
export async function reservationsOutsideHours(owner: Owner, lang: Language): Promise<string[]> {
  const today = todayFor(owner);
  const rows = await storage.listReservationsByDates(owner.id, owner.timezone, today, addDays(today, 90));
  const out: string[] = [];
  for (const r of rows) {
    const v = storage.reservationView(r, owner.timezone, lang);
    const h = owner.hours[weekdayOf(v.date)];
    if (!h || timeToMinutes(v.time) < timeToMinutes(h.open) || timeToMinutes(v.endTime) > timeToMinutes(h.close)) out.push(`${v.date} ${v.time} ${v.customerName}`);
  }
  return out;
}
