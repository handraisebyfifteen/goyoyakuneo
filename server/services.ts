/**
 * 予約を入れる・取り消すときの一連の流れ。
 * 画面の予約ページ、オーナーの声（AI のツール）、どちらからも同じ関数を呼ぶ。
 */
import type { Owner, Menu, Language } from "@shared/schema";
import * as storage from "./storage";
import { checkBookable, availableSlots, refundEligible, BookingError, type Busy } from "./lib/booking";
import { candidatesFor, busyFor, orderCandidates } from "./lib/staffing";
import { fromLocal, addDays, nowLocal, isValidDate, isValidTime, isValidCloseTime, weekdayOf, timeToMinutes } from "./lib/time";
import { money } from "@shared/money";
import { ApiError } from "./errors";
import { normalizeCode, couponProblem, discountFor } from "./lib/coupon";
import { createPaymentLink, cardPayable } from "./payments";
import { notifyReservation } from "./push";
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
    reservations: rs.map((r) => ({ id: r.id, startAt: r.startAt, endAt: r.endAt, label: r.customer.name, staffId: r.staffId })),
    blocked: bs.map((b) => ({ id: b.id, startAt: b.startAt, endAt: b.endAt, label: b.reason, staffId: b.staffId })),
  };
}

// ---------- スタッフの割り当て ----------

/** 施術するスタッフ（いなければ、今までどおりオーナーひとりの店として扱う） */
async function treatingStaff(owner: Owner) {
  return (await storage.listStaff(owner.id)).filter((s) => s.active && s.treats);
}

/** 重なりで断られた理由か（スタッフを変えれば入るかもしれない理由） */
const staffSpecific = (e: BookingError) => e.code === "overlap" || e.code === "day_off";

export type AssignInput = {
  date: string; time: string; minutes: number; menuId: number | null; source: "web" | "owner";
  /** 指名・担当を決めて入れるとき */
  staffId?: number;
  /** フリーのとき、先に試したい人（日時を変えるときの今の担当） */
  preferStaffId?: number | null;
  ignoreId?: number;
};

/** その日時に入れられるかを確かめて、担当を決める。スタッフのいない店では担当なし */
export async function assignStaff(owner: Owner, input: AssignInput): Promise<{ startAt: Date; endAt: Date; staffId: number | null; staffName: string }> {
  const busy = await busyAround(owner, input.date);
  const base = { settings: bookingSettings(owner), date: input.date, time: input.time, minutes: input.minutes, source: input.source, ignoreId: input.ignoreId };
  const team = await treatingStaff(owner);
  if (!team.length) {
    if (input.staffId !== undefined) throw new ApiError("staff_not_found", 404);
    return { ...checkBookable({ ...base, ...busy }), staffId: null, staffName: "" };
  }
  const cands = candidatesFor(team, { menuId: input.menuId, staffId: input.staffId, source: input.source });
  if (!cands.length) {
    if (input.staffId === undefined) throw new ApiError("no_staff_for_menu");
    throw new ApiError(team.some((s) => s.id === input.staffId) ? "staff_cannot_take" : "staff_not_found");
  }
  const day = busy.reservations.filter((r) => r.id !== input.ignoreId);
  let first: BookingError | null = null;
  for (const s of orderCandidates(cands, day, input.preferStaffId)) {
    try {
      return { ...checkBookable({ ...base, ...busyFor(s.id, busy) }), staffId: s.id, staffName: s.name };
    } catch (e) {
      if (!(e instanceof BookingError)) throw e;
      // 営業時間外・過去など、誰でも同じ理由ならそのまま返す
      if (!staffSpecific(e)) throw e;
      first ??= e;
    }
  }
  if (cands.length === 1 && first) throw first;
  throw new ApiError("no_staff_available");
}

/** 空いている開始時刻。スタッフのいる店では、受けられる人のだれかが空いていれば空き */
export async function slotsFor(owner: Owner, input: { date: string; minutes: number; menuId: number | null; source: "web" | "owner"; staffId?: number; ignoreId?: number }) {
  if (!isValidDate(input.date)) throw new ApiError("invalid_date");
  const busy = await busyAround(owner, input.date);
  busy.reservations = busy.reservations.filter((r) => r.id !== input.ignoreId);
  const base = { settings: bookingSettings(owner), date: input.date, minutes: input.minutes, source: input.source };
  const team = await treatingStaff(owner);
  if (!team.length) return availableSlots({ ...base, ...busy });
  const cands = candidatesFor(team, { menuId: input.menuId, staffId: input.staffId, source: input.source });
  const all = new Set<string>();
  let closed = false;
  for (const s of cands) {
    const r = availableSlots({ ...base, ...busyFor(s.id, busy) });
    closed = r.closed;
    r.slots.forEach((t) => all.add(t));
  }
  return { slots: Array.from(all).sort(), closed };
}

/**
 * スタッフを初めて登録するとき、オーナー本人の枠を作り、それまでの予約をそこに割り当てる
 * （そうしないと、今までの予約がだれの時間もふさがなくなる）
 */
export async function ensureStaffMode(owner: Owner, lang: Language) {
  const all = await storage.listStaff(owner.id);
  if (all.length) return;
  const me = await storage.createStaff({ ownerId: owner.id, name: lang === "ja" ? "オーナー" : "Owner", isOwner: true, role: "manager", sortOrder: 0 });
  await storage.assignUnstaffedReservations(owner.id, me.id, me.name);
}

export type CreateReservationInput = {
  /** メニューか終わりの時刻のどちらかは要る。両方あれば時間は終わりの時刻で決める */
  menu?: Menu;
  date: string;
  time: string;
  endTime?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string | null;
  paymentMethod: "card" | "onsite";
  source: "web" | "owner";
  lang: Language;
  /** 確認メールを送るか（毎週の予約をまとめて入れるときは、1件目だけ送る） */
  sendEmail?: boolean;
  couponCode?: string;
  /** 指名・担当（スタッフのいる店だけ） */
  staffId?: number;
};

/** クーポンを確かめて、割り引く額を返す（コードがなければ割引なし） */
export async function couponDiscount(owner: Owner, code: string | undefined, menu: Menu | undefined): Promise<{ code: string; discount: number } | null> {
  const c = code ? normalizeCode(code) : "";
  if (!c) return null;
  if (!menu) throw new ApiError("coupon_needs_menu");
  const coupon = await storage.getCouponByCode(owner.id, c);
  const problem = couponProblem(coupon, todayFor(owner));
  if (problem) throw new ApiError(problem);
  return { code: c, discount: discountFor(coupon!, menu.price) };
}

/** 予約の長さ（分）。終わりの時刻があればそれで、なければメニューの所要時間で */
function minutesFor(time: string, endTime: string | undefined, menu: Menu | undefined): number {
  if (endTime) {
    if (!isValidTime(time) || !isValidCloseTime(endTime)) throw new ApiError("invalid_time");
    const m = timeToMinutes(endTime) - timeToMinutes(time);
    if (m <= 0) throw new ApiError("invalid_time");
    return m;
  }
  if (!menu) throw new ApiError("end_or_menu_required");
  return menu.minutes;
}

export async function createReservationFor(owner: Owner, input: CreateReservationInput) {
  const name = storage.cleanName(input.customerName);
  if (!name) throw new ApiError("name_required");
  const phone = storage.cleanPhone(input.customerPhone ?? "");
  if (input.source === "web" && !phone) throw new ApiError("phone_required");
  const email = (input.customerEmail ?? "").trim() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError("invalid_email");
  if (input.paymentMethod === "card" && !owner.allowCardPayment && input.source === "web") throw new ApiError("card_not_allowed");
  if (input.paymentMethod === "card" && !input.menu) throw new ApiError("card_needs_menu");
  if (input.paymentMethod === "card" && !cardPayable(owner)) throw new ApiError("card_not_ready");
  const minutes = minutesFor(input.time, input.endTime, input.menu);
  const coupon = await couponDiscount(owner, input.couponCode, input.menu);

  const { startAt, endAt, staffId, staffName } = await assignStaff(owner, {
    date: input.date, time: input.time, minutes, menuId: input.menu?.id ?? null, source: input.source, staffId: input.staffId,
  });
  if (input.paymentMethod === "card" && input.source === "web" && startAt < cardOpenFrom(owner)) throw new ApiError("card_too_soon", 400, { hours: owner.cardMinHoursBefore });

  const customer = await storage.upsertCustomer(owner.id, name, phone, email);
  let row = await storage.createReservation({
    ownerId: owner.id, customerId: customer.id, menuId: input.menu?.id ?? null,
    menuNameJa: input.menu?.nameJa ?? "", menuNameEn: input.menu?.nameEn ?? "", minutes,
    price: (input.menu?.price ?? 0) - (coupon?.discount ?? 0), currency: input.menu?.currency ?? owner.currency, startAt, endAt,
    couponCode: coupon?.code ?? null, discount: coupon?.discount ?? 0,
    staffId, staffName, nominated: input.staffId !== undefined,
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
    if (input.sendEmail !== false) emailNote = await sendBookingConfirmation(owner, row);
  } catch (e) {
    console.error("[email]", e);
    emailNote = "failed";
  }
  // ネットから入った予約は、オーナーのスマホにも知らせる
  if (input.source === "web") notifyReservation(owner, row, "booked");
  return { reservation: storage.reservationView(row, owner.timezone, input.lang), paymentNote, emailNote };
}

export async function cancelReservationFor(owner: Owner, row: storage.ReservationRow, lang: Language, by: "owner" | "customer" | "unpaid" = "owner") {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  // 回数券・前払いで払っていたら、使った分を戻す
  if (row.paymentStatus === "ticket" && row.ticketId) {
    const t = await storage.getTicket(owner.id, row.ticketId);
    if (t) await storage.updateTicket(owner.id, t.id, { remaining: t.remaining + row.ticketUsed });
  }
  const wasPaid = row.paymentStatus === "paid";
  const updated = await storage.updateReservation(owner.id, row.id, { status: "cancelled", cancelledAt: new Date(), cancelledBy: by });
  const eligible = wasPaid ? refundEligible(row.startAt, owner.freeCancelHoursBefore) : null;
  return { reservation: storage.reservationView(updated ?? row, owner.timezone, lang), refundEligible: eligible, wasPaid };
}

/** ネットのカード払いを受けられるのは、この時刻より後に始まる予約（cardMinHoursBefore が 0 なら締め切りなし） */
export function cardOpenFrom(owner: Pick<Owner, "cardMinHoursBefore">, now: Date = new Date()): Date {
  return new Date(now.getTime() + owner.cardMinHoursBefore * 3600000);
}

export function todayFor(owner: Owner): string {
  return nowLocal(owner.timezone).date;
}

// ---------- 予約の変更・現地払いの記録（AI のツールと画面の両方から使う） ----------

export type UpdateReservationInput = { date?: string; time?: string; endTime?: string; menu?: Menu; lang: Language; source?: "web" | "owner"; staffId?: number };

export async function updateReservationFor(owner: Owner, row: storage.ReservationRow, input: UpdateReservationInput) {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  const cur = storage.reservationView(row, owner.timezone, input.lang);
  const date = input.date ?? cur.date;
  const time = input.time ?? cur.time;
  const menu = input.menu;
  // クーポンで割り引いた額は、メニューを変えてもそのまま引く
  const discount = menu ? Math.min(row.discount, menu.price) : row.discount;
  if (menu && row.paymentStatus === "paid" && menu.price - discount !== row.price) throw new ApiError("paid_menu_locked");
  // 終わりの時刻を言われたらそれで、メニューを変えたらその所要時間で、どちらもなければ今の長さのまま
  const minutes = input.endTime ? minutesFor(time, input.endTime, menu) : menu ? menu.minutes : row.minutes;
  // 担当：言われた人 → 指名の予約なら今の人のまま → フリーなら今の人を先に、だめならほかの人
  const keep = input.staffId === undefined && row.nominated && row.staffId !== null ? row.staffId : undefined;
  const a = await assignStaff(owner, {
    date, time, minutes, menuId: menu ? menu.id : row.menuId, source: input.source ?? "owner", ignoreId: row.id,
    staffId: input.staffId ?? keep, preferStaffId: row.staffId,
  });
  const { startAt, endAt } = a;
  // 日時が変わったら、前日のお知らせはやり直す
  const patch: Partial<typeof row> = { startAt, endAt, minutes, staffId: a.staffId, staffName: a.staffName, ...(input.staffId !== undefined ? { nominated: true } : {}),
    ...(startAt.getTime() !== row.startAt.getTime() ? { remindedAt: null } : {}) };
  if (menu) Object.assign(patch, { menuId: menu.id, menuNameJa: menu.nameJa, menuNameEn: menu.nameEn, price: menu.price - discount, discount });
  const updated = await storage.updateReservation(owner.id, row.id, patch);
  return { reservation: storage.reservationView(updated ?? row, owner.timezone, input.lang) };
}

export async function recordOnsitePaymentFor(owner: Owner, row: storage.ReservationRow, amountMinor: number, lang: Language) {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  if (row.paymentStatus !== "onsite_pending") throw new ApiError("not_onsite_pending");
  if (amountMinor <= 0) throw new ApiError("validation");
  // メニューなしの予約は、受け取った額がそのまま料金になる
  const noMenu = row.menuId === null;
  const updated = await storage.updateReservation(owner.id, row.id, { paymentStatus: "onsite_received", amountReceived: amountMinor, status: "completed", ...(noMenu ? { price: amountMinor } : {}) });
  return { reservation: storage.reservationView(updated ?? row, owner.timezone, lang), differs: !noMenu && amountMinor !== row.price };
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
  // 無断キャンセルは未払いに数えない（別に件数を出す）
  const waiting = rows.filter((r) => live(r) && r.status !== "no_show" && (r.paymentStatus === "unpaid" || r.paymentStatus === "onsite_pending"));
  const refundPending = rows.filter((r) => r.status === "cancelled" && r.paymentStatus === "paid");
  // 回数券・前払いは、売った日の売り上げ
  const ticketSales = (await storage.listTicketsSold(owner.id, from, to)).reduce((a, t) => a + t.price, 0);
  return {
    from, to, currency: cur,
    total: money(card + onsite + ticketSales, cur, lang), cardTotal: money(card, cur, lang), onsiteTotal: money(onsite, cur, lang), ticketTotal: money(ticketSales, cur, lang),
    paidCount: rows.filter((r) => live(r) && (r.paymentStatus === "paid" || r.paymentStatus === "onsite_received" || r.paymentStatus === "ticket")).length,
    waitingCount: waiting.length, waitingAmount: money(waiting.reduce((a, r) => a + r.price, 0), cur, lang),
    cancelledCount: rows.filter((r) => r.status === "cancelled").length,
    noShowCount: rows.filter((r) => r.status === "no_show").length,
    refundPendingCount: refundPending.length, refundPendingAmount: money(refundPending.reduce((a, r) => a + r.amountReceived, 0), cur, lang),
    reservationCount: rows.filter(live).length,
  };
}

/** 臨時休業・休憩の枠を入れる。予約と重なっていたら止める */
export async function addBlockedSlotFor(owner: Owner, input: { date: string; start?: string; end?: string; reason?: string; staffId?: number }) {
  if (!isValidDate(input.date)) throw new ApiError("invalid_date");
  if ((input.start && !isValidTime(input.start)) || (input.end && !isValidCloseTime(input.end))) throw new ApiError("invalid_time");
  const startAt = fromLocal(input.date, input.start ?? "00:00", owner.timezone);
  const endAt = input.end ? fromLocal(input.date, input.end, owner.timezone) : fromLocal(addDays(input.date, 1), "00:00", owner.timezone);
  if (endAt <= startAt) throw new ApiError("invalid_time");
  // スタッフのお休みなら、その人の予約とだけぶつかりを見る
  const clash = (await storage.listReservationsBetween(owner.id, startAt, endAt)).filter((r) => input.staffId === undefined || r.staffId === null || r.staffId === input.staffId);
  if (clash.length) throw new ApiError("overlap", 409, { time: storage.reservationView(clash[0], owner.timezone, "ja").time, name: clash[0].customer.name, buffer: 0 });
  return storage.createBlockedSlot({ ownerId: owner.id, startAt, endAt, reason: input.reason ?? "", staffId: input.staffId ?? null });
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
