/**
 * 回数券・前払い。
 * - 売る：回数券（例：60分コース5回券）か、前払い（例：3万円分）。売った金額をその日の売り上げにする
 * - 使う：予約の支払いに充てる。回数券は1回、前払いは料金分を減らす。予約は「券で支払い済み」になり、売り上げには数えない
 * - 予約を取り消したら、使った分を券に戻す（services.ts の cancelReservationFor）
 * - 券ごとに QR コードのページ（/t/:token）を作り、メールがわかればお客さんに送る。お会計でオーナーがその QR を読み取って使う
 * - クーポンの QR は予約ページのリンク（?coupon=コード）。お客さんが読めばクーポン入りで予約でき、オーナーが読めば店頭で使える
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Owner, Language, CustomerTicket, TicketType } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import { money, toMinor } from "@shared/money";
import { randomBytes } from "node:crypto";
import { requireOwner, type AuthedRequest } from "./auth";
import { sendError } from "./errors";
import { appBaseUrl } from "./payments";
import { sendTicketPass } from "./email";
import { normalizeCode, couponProblem, discountFor } from "./lib/coupon";
import { parseScan } from "./lib/scan";
import * as storage from "./storage";
import { ApiError } from "./errors";
import { todayFor } from "./services";
import { isValidDate, addDays } from "./lib/time";

export function ticketView(t: CustomerTicket, owner: Owner, lang: Language, today: string) {
  const cur = owner.currency;
  return {
    id: t.id, customerId: t.customerId, kind: t.kind, name: t.name, menuId: t.menuId,
    remaining: t.kind === "count" ? t.remaining : money(t.remaining, cur, lang), total: t.kind === "count" ? t.total : money(t.total, cur, lang),
    price: money(t.price, cur, lang), soldDate: t.soldDate, expiresOn: t.expiresOn,
    usable: t.active && t.remaining > 0 && (!t.expiresOn || today <= t.expiresOn),
  };
}

export async function sellTicketFor(owner: Owner, input: { customerId: number; kind: "count" | "credit"; name: string; total: number; priceMinor: number; menuId?: number | null; expiresOn?: string | null; typeId?: number | null }) {
  if (!(input.total > 0) || !(input.priceMinor >= 0)) throw new ApiError("validation");
  if (input.expiresOn && !isValidDate(input.expiresOn)) throw new ApiError("invalid_date");
  const name = input.name.trim().slice(0, 60) || (input.kind === "count" ? `${input.total}回券` : "前払い");
  const t = await storage.createTicket({
    ownerId: owner.id, customerId: input.customerId, kind: input.kind, name, menuId: input.menuId ?? null,
    total: Math.round(input.total), remaining: Math.round(input.total), price: input.priceMinor, soldDate: todayFor(owner), expiresOn: input.expiresOn ?? null,
    token: randomBytes(18).toString("base64url"), typeId: input.typeId ?? null,
  });
  // メールのわかるお客さんには、QR コードのページを送る（失敗しても売ったことは残す）
  const c = await storage.getCustomer(owner.id, t.customerId);
  if (c?.email) { try { await sendTicketPass(owner, c, t, ticketPassUrl(t)); } catch (e) { console.error("[email]", e); } }
  return t;
}

/** 種類から売る：回数・金額・コース・有効日数は種類のとおり。期限は売った日から validDays 日 */
export async function sellFromType(owner: Owner, customerId: number, type: TicketType) {
  if (!type.active) throw new ApiError("validation");
  const expiresOn = type.validDays ? addDays(todayFor(owner), type.validDays) : null;
  return sellTicketFor(owner, { customerId, kind: type.kind === "credit" ? "credit" : "count", name: type.name, total: type.total, priceMinor: type.price, menuId: type.menuId, expiresOn, typeId: type.id });
}

export function ticketTypeView(t: TicketType, owner: Owner, lang: Language, menuName?: string | null) {
  const cur = owner.currency;
  return { id: t.id, name: t.name, kind: t.kind, menuName: menuName ?? null, size: t.kind === "count" ? t.total : money(t.total, cur, lang), price: money(t.price, cur, lang), validDays: t.validDays, active: t.active };
}

/** 券の QR コードのページ。古い券でまだなければ作る */
export function ticketPassUrl(t: CustomerTicket): string {
  return `${appBaseUrl()}/t/${t.token}`;
}
export async function ensureTicketToken(owner: Owner, t: CustomerTicket): Promise<CustomerTicket> {
  if (t.token) return t;
  return (await storage.updateTicket(owner.id, t.id, { token: randomBytes(18).toString("base64url") })) ?? t;
}

/** クーポンの QR コード：予約ページのリンクに、クーポンのコードを添えたもの */
export function couponUrl(owner: Owner, code: string): string {
  return `${appBaseUrl()}/book/${owner.slug}?coupon=${encodeURIComponent(code)}`;
}

/** 当日払いの予約に、店頭でクーポンを当てる（メニューのある予約だけ。すでにクーポンを使っていれば当てない） */
export async function applyCouponToReservation(owner: Owner, row: storage.ReservationRow, code: string) {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  if (row.paymentStatus !== "onsite_pending") throw new ApiError("not_onsite_pending");
  if (row.menuId === null) throw new ApiError("coupon_needs_menu");
  if (row.couponCode) throw new ApiError("coupon_invalid");
  const c = normalizeCode(code);
  const coupon = await storage.getCouponByCode(owner.id, c);
  const problem = couponProblem(coupon, todayFor(owner));
  if (problem) throw new ApiError(problem);
  const menu = await storage.getMenu(owner.id, row.menuId);
  const base = menu?.price ?? row.price;
  const discount = discountFor(coupon!, base);
  return (await storage.updateReservation(owner.id, row.id, { couponCode: c, discount, price: base - discount })) ?? row;
}



/** 予約の支払いに券を充てる。券を言われなければ、そのお客さんの使える券から選ぶ（回数券のコースが合うもの → 前払い） */
export async function useTicketFor(owner: Owner, row: storage.ReservationRow, ticketId?: number, amountMinor?: number) {
  if (row.status === "cancelled") throw new ApiError("already_cancelled");
  if (row.paymentStatus !== "onsite_pending") throw new ApiError("not_onsite_pending");
  const today = todayFor(owner);
  const price = row.menuId === null ? amountMinor ?? 0 : row.price;
  const fits = (t: CustomerTicket) => t.active && t.customerId === row.customerId && (!t.expiresOn || today <= t.expiresOn)
    && (t.kind === "count" ? t.remaining >= 1 && (!t.menuId || t.menuId === row.menuId) : price > 0 && t.remaining >= price);
  const mine = await storage.listTickets(owner.id, row.customerId);
  const ticket = ticketId ? mine.find((t) => t.id === ticketId) : mine.find((t) => t.kind === "count" && fits(t)) ?? mine.find((t) => t.kind === "credit" && fits(t));
  if (!ticket || !fits(ticket)) throw new ApiError("ticket_unusable");
  const used = ticket.kind === "count" ? 1 : price;
  const t = (await storage.updateTicket(owner.id, ticket.id, { remaining: ticket.remaining - used }))!;
  const updated = await storage.updateReservation(owner.id, row.id, {
    paymentStatus: "ticket", status: "completed", ticketId: ticket.id, ticketUsed: used, ...(row.menuId === null ? { price } : {}),
  });
  return { reservation: updated ?? row, ticket: t };
}

// ---------- 画面の API ----------

function handle(fn: (req: Request, res: Response, owner: Owner, lang: Language) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(req.query.lang ?? req.body?.lang ?? owner.language);
    try { await fn(req, res, owner, lang); }
    catch (e) { sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e); }
  };
}

export function registerTicketRoutes(app: Express) {
  app.get("/api/owner/tickets", requireOwner, handle(async (_req, res, owner, lang) => {
    const today = todayFor(owner);
    const names = new Map((await storage.listCustomers(owner.id)).map((c) => [c.id, c.name]));
    res.json({ ok: true, tickets: (await storage.listTickets(owner.id)).reverse().map((t) => ({ ...ticketView(t, owner, lang, today), customerName: names.get(t.customerId) ?? "" })) });
  }));
  app.get("/api/owner/ticket-types", requireOwner, handle(async (_req, res, owner, lang) => {
    const menus = await storage.listMenus(owner.id);
    res.json({ ok: true, types: (await storage.listTicketTypes(owner.id)).map((t) => ticketTypeView(t, owner, lang, t.menuId ? (() => { const m = menus.find((x) => x.id === t.menuId); return m ? storage.menuView(m, lang).name : null; })() : null)) });
  }));
  app.post("/api/owner/ticket-types", requireOwner, handle(async (req, res, owner) => {
    const b = z.object({ name: z.string().min(1).max(60), kind: z.enum(["count", "credit"]), count: z.number().int().positive().optional(), amount: z.number().positive().optional(),
      price: z.number().min(0), menuId: z.number().int().nullable().optional(), validDays: z.number().int().positive().max(3650).nullable().optional() }).parse(req.body);
    const total = b.kind === "count" ? b.count ?? 0 : toMinor(b.amount ?? 0, owner.currency);
    if (!(total > 0)) throw new ApiError("validation");
    const t = await storage.createTicketType({ ownerId: owner.id, name: b.name.trim(), kind: b.kind, total, price: toMinor(b.price, owner.currency), menuId: b.menuId ?? null, validDays: b.validDays ?? null });
    res.status(201).json({ ok: true, id: t.id });
  }));
  app.post("/api/owner/ticket-types/:id/stop", requireOwner, handle(async (req, res, owner) => {
    if (!(await storage.updateTicketType(owner.id, Number(req.params.id), { active: false }))) throw new ApiError("not_found", 404);
    res.json({ ok: true });
  }));
  app.post("/api/owner/tickets", requireOwner, handle(async (req, res, owner) => {
    // 種類から売るなら、名前と電話と種類だけ
    if (req.body?.typeId) {
      const b = z.object({ customerName: z.string().min(1).max(100), customerPhone: z.string().max(40).optional(), typeId: z.number().int() }).parse(req.body);
      const type = await storage.getTicketType(owner.id, b.typeId);
      if (!type) throw new ApiError("ticket_type_not_found", 404);
      const customer = await storage.upsertCustomer(owner.id, storage.cleanName(b.customerName), storage.cleanPhone(b.customerPhone ?? ""));
      const t = await sellFromType(owner, customer.id, type);
      res.status(201).json({ ok: true, id: t.id });
      return;
    }
    const b = z.object({
      customerName: z.string().min(1).max(100), customerPhone: z.string().max(40).optional(), kind: z.enum(["count", "credit"]),
      name: z.string().max(60).default(""), count: z.number().int().positive().optional(), amount: z.number().positive().optional(),
      price: z.number().min(0), menuId: z.number().int().nullable().optional(), expiresOn: z.string().nullable().optional(),
    }).parse(req.body);
    const customer = await storage.upsertCustomer(owner.id, storage.cleanName(b.customerName), storage.cleanPhone(b.customerPhone ?? ""));
    const total = b.kind === "count" ? b.count ?? 0 : toMinor(b.amount ?? 0, owner.currency);
    const t = await sellTicketFor(owner, { customerId: customer.id, kind: b.kind, name: b.name, total, priceMinor: toMinor(b.price, owner.currency), menuId: b.menuId ?? null, expiresOn: b.expiresOn || null });
    res.status(201).json({ ok: true, id: t.id });
  }));
  app.post("/api/owner/reservations/:id/use-ticket", requireOwner, handle(async (req, res, owner, lang) => {
    const row = await storage.getReservation(owner.id, Number(req.params.id));
    if (!row) throw new ApiError("reservation_not_found", 404);
    const { ticketId } = z.object({ ticketId: z.number().int().optional() }).parse(req.body ?? {});
    const r = await useTicketFor(owner, row, ticketId);
    res.json({ ok: true, reservation: storage.reservationView(r.reservation, owner.timezone, lang), ticket: ticketView(r.ticket, owner, lang, todayFor(owner)) });
  }));
}

/** お会計で使える、今日の当日払いの予約（お客さんを決めれば、その人の分だけ） */
async function todaysPending(owner: Owner, lang: Language, customerId?: number) {
  const today = todayFor(owner);
  const rows = await storage.listReservationsByDates(owner.id, owner.timezone, today, today);
  return rows.filter((r) => r.paymentStatus === "onsite_pending" && r.status === "confirmed" && (!customerId || r.customerId === customerId))
    .map((r) => { const v = storage.reservationView(r, owner.timezone, lang); return { id: v.id, time: v.time, customerName: v.customerName, menuName: v.menuName, price: v.price, hasMenu: r.menuId !== null, hasCoupon: !!r.couponCode }; });
}

export function registerPassRoutes(app: Express) {
  // お客さん向けの券のページ（QR コードを見せる）。名前は下の名前を伏せずに出すが、電話やメールは出さない
  app.get("/api/public/tickets/:token", async (req, res) => {
    const t = /^[A-Za-z0-9_-]{20,}$/.test(req.params.token) ? await storage.getTicketByToken(req.params.token) : undefined;
    const owner = t ? await storage.getOwner(t.ownerId) : undefined;
    const lang = normalizeLang(req.query.lang ?? owner?.language);
    if (!t || !owner) return sendError(res, lang, new ApiError("not_found", 404));
    const c = await storage.getCustomer(owner.id, t.customerId);
    const { id: _i, customerId: _c, menuId: _m, ...v } = ticketView(t, owner, lang, todayFor(owner));
    res.json({ ok: true, shopName: storage.shopName(owner, lang), customerName: c?.name ?? "", url: ticketPassUrl(t), ticket: v });
  });

  // オーナーがカメラで読み取った QR の中身を見分けて、使い道を返す
  app.post("/api/owner/scan", requireOwner, handle(async (req, res, owner, lang) => {
    const ja = lang === "ja";
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    const hit = parseScan(text);
    if (hit?.kind === "ticket") {
      const t = await storage.getTicketByToken(hit.token);
      if (!t || t.ownerId !== owner.id) throw new ApiError("scan_unknown", 404);
      const c = await storage.getCustomer(owner.id, t.customerId);
      const view = ticketView(t, owner, lang, todayFor(owner));
      const reservations = await todaysPending(owner, lang, t.customerId);
      const left = typeof view.remaining === "number" ? (ja ? `残り${view.remaining}回` : `${view.remaining} left`) : (ja ? `残り${view.remaining.display}` : `${view.remaining.display} left`);
      const speech = ja
        ? `${c?.name ?? ""}さんの${t.name}、${left}。${!view.usable ? "この券は今は使えません。" : reservations.length ? `今日${reservations.map((r) => r.time).join("、")}の予約に使えます。` : "今日の当日払いの予約はありません。"}`
        : `${c?.name ?? ""}'s ${t.name}, ${left}. ${!view.usable ? "This ticket cannot be used now." : reservations.length ? `Can be used for today's booking at ${reservations.map((r) => r.time).join(", ")}.` : "No pay-at-shop booking today."}`;
      res.json({ ok: true, kind: "ticket", ticketId: t.id, customerName: c?.name ?? "", ticket: view, reservations, speech });
      return;
    }
    if (hit?.kind === "coupon") {
      const coupon = await storage.getCouponByCode(owner.id, hit.code);
      if (!coupon) throw new ApiError("scan_unknown", 404);
      const problem = couponProblem(coupon, todayFor(owner));
      const off = coupon.kind === "percent" ? (ja ? `${coupon.value}%引き` : `${coupon.value}% off`) : (ja ? `${money(coupon.value, owner.currency, lang).display}引き` : `${money(coupon.value, owner.currency, lang).display} off`);
      const reservations = problem ? [] : (await todaysPending(owner, lang)).filter((r) => r.hasMenu && !r.hasCoupon);
      const speech = ja
        ? `クーポン${coupon.code}、${off}。${problem ? (problem === "coupon_expired" ? "期限が切れています。" : "今は使えません。") : `${coupon.expiresOn ? `${coupon.expiresOn}まで` : "期限なしで"}使えます。`}`
        : `Coupon ${coupon.code}, ${off}. ${problem ? (problem === "coupon_expired" ? "It has expired." : "It cannot be used now.") : "It can be used."}`;
      res.json({ ok: true, kind: "coupon", code: coupon.code, off, expiresOn: coupon.expiresOn, usable: !problem, reservations, speech });
      return;
    }
    throw new ApiError("scan_unknown", 404);
  }));

  app.post("/api/owner/reservations/:id/apply-coupon", requireOwner, handle(async (req, res, owner, lang) => {
    const row = await storage.getReservation(owner.id, Number(req.params.id));
    if (!row) throw new ApiError("reservation_not_found", 404);
    const { code } = z.object({ code: z.string().min(1).max(40) }).parse(req.body);
    const updated = await applyCouponToReservation(owner, row, code);
    res.json({ ok: true, reservation: storage.reservationView(updated, owner.timezone, lang) });
  }));

  // クーポンの一覧（QR コードのリンクつき）。作る・止めるは声でも画面でも
  app.get("/api/owner/coupons", requireOwner, handle(async (_req, res, owner, lang) => {
    const today = todayFor(owner);
    res.json({ ok: true, coupons: (await storage.listCoupons(owner.id)).reverse().map((c) => ({
      id: c.id, code: c.code, kind: c.kind, off: c.kind === "percent" ? `${c.value}%` : money(c.value, owner.currency, lang).display,
      expiresOn: c.expiresOn, active: c.active, usable: !couponProblem(c, today), url: couponUrl(owner, c.code),
    })) });
  }));
  app.post("/api/owner/coupons", requireOwner, handle(async (req, res, owner) => {
    const b = z.object({ code: z.string().min(1).max(40), percentOff: z.number().int().min(1).max(100).optional(), amountOff: z.number().positive().optional(), expiresOn: z.string().nullable().optional() }).parse(req.body);
    const code = normalizeCode(b.code);
    if ((b.percentOff === undefined) === (b.amountOff === undefined)) throw new ApiError("validation");
    if (await storage.getCouponByCode(owner.id, code)) throw new ApiError("coupon_exists", 409, { code });
    const c = await storage.createCoupon({ ownerId: owner.id, code, kind: b.percentOff !== undefined ? "percent" : "amount", value: b.percentOff ?? toMinor(b.amountOff!, owner.currency), expiresOn: b.expiresOn || null });
    res.status(201).json({ ok: true, id: c.id });
  }));
  app.post("/api/owner/coupons/:id/stop", requireOwner, handle(async (req, res, owner) => {
    if (!(await storage.updateCoupon(owner.id, Number(req.params.id), { active: false }))) throw new ApiError("not_found", 404);
    res.json({ ok: true });
  }));

  // 古い券（QR がまだない）にも QR を作って、お客さんに送るリンクを返す
  app.post("/api/owner/tickets/:id/pass", requireOwner, handle(async (req, res, owner) => {
    const t = await storage.getTicket(owner.id, Number(req.params.id));
    if (!t) throw new ApiError("not_found", 404);
    res.json({ ok: true, url: ticketPassUrl(await ensureTicketToken(owner, t)) });
  }));
}
