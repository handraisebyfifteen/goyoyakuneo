import type { Express, Request, Response } from "express";
import { z } from "zod";
import * as storage from "./storage";
import { registerAuthRoutes, requireOwner, requireRegistered, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { settingsPatchSchema, type Owner, type Language } from "@shared/schema";
import { cancelPolicyText, normalizeLang } from "@shared/i18n";
import { money, toMinor } from "@shared/money";
import { availableSlots, refundEligible } from "./lib/booking";
import { isValidTimeZone, nowLocal, fromLocal, isValidDate, monthRange, addDays } from "./lib/time";
import { bookingSettings, busyAround, slotsFor, cardOpenFrom, createReservationFor, cancelReservationFor, updateReservationFor, couponDiscount, todayFor, salesSummaryFor, addBlockedSlotFor } from "./services";
import { registerVoiceRoutes } from "./ai/routes";
import { confirmSession, stripeConfigured, cardPayable, CARD_HOLD_MINUTES } from "./payments";
import { registerCardPayRoutes } from "./cardpay";
import { registerPushRoutes, notifyReservation } from "./push";
import { emailConfigured, sendBookingConfirmation } from "./email";
import { calendarFeed, calendarTokenFor } from "./calendar";
import { registerStaffRoutes } from "./staff";
import { registerGroupRoutes } from "./groups";
import { registerAttendanceRoutes } from "./attendance";
import { registerApiRoutes } from "./api";
import { registerBooksRoutes } from "./books";
import { registerFollowupRoutes } from "./followup";
import { registerBillingRoutes } from "./billing";
import { registerTicketRoutes, registerPassRoutes } from "./tickets";
import { registerCapabilityRoutes } from "./capabilities";

type Handler = (req: Request, res: Response, lang: Language) => Promise<void>;

/** エラーをまとめて処理する。lang は query → body → オーナー設定の順で決める */
function wrap(handler: Handler, ownerLang = false) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner as Owner | undefined;
    const lang = ownerLang && owner ? normalizeLang(owner.language) : normalizeLang(req.query.lang ?? req.body?.lang ?? owner?.language);
    try {
      await handler(req, res, lang);
    } catch (e) {
      sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e);
    }
  };
}

const ownerOf = (req: Request) => (req as AuthedRequest).owner;

function settingsPayload(owner: Owner, lang: Language) {
  const now = nowLocal(owner.timezone);
  return {
    owner: storage.publicOwner(owner),
    cancelPolicy: cancelPolicyText(owner.freeCancelHoursBefore, lang),
    now,
    bookingUrl: `/book/${owner.slug}`,
  };
}

export function registerRoutes(app: Express) {
  registerAuthRoutes(app);

  // ---------- オーナー：設定 ----------

  app.get("/api/owner/settings", requireOwner, wrap(async (req, res, lang) => {
    res.json({ ok: true, ...settingsPayload(ownerOf(req), lang) });
  }));

  app.patch("/api/owner/settings", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    const patch = settingsPatchSchema.parse(req.body);
    if (patch.country) patch.country = patch.country.toUpperCase();
    if (patch.currency) {
      patch.currency = patch.currency.toUpperCase();
      if (patch.currency !== owner.currency && (await storage.ownerHasMenusOrReservations(owner.id))) throw new ApiError("currency_locked");
    }
    if (patch.timezone && !isValidTimeZone(patch.timezone)) throw new ApiError("invalid_timezone");
    if (patch.slug && patch.slug !== owner.slug && (await storage.getOwnerBySlug(patch.slug))) throw new ApiError("slug_in_use", 409);
    const updated = await storage.updateOwner(owner.id, patch);
    res.json({ ok: true, ...settingsPayload(updated, normalizeLang(updated.language)) });
  }));

  // ---------- オーナー：メニュー ----------

  const menuBody = z.object({
    nameJa: z.string().max(100).optional(),
    nameEn: z.string().max(100).optional(),
    minutes: z.number().int().min(5).max(600),
    price: z.union([z.number(), z.string()]),
    descriptionJa: z.string().max(500).optional(),
    descriptionEn: z.string().max(500).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  });

  app.get("/api/owner/menus", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    res.json({ ok: true, menus: (await storage.listMenus(owner.id)).map((m) => storage.menuView(m, lang)) });
  }));

  app.post("/api/owner/menus", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    const b = menuBody.parse(req.body);
    const nameJa = (b.nameJa ?? b.nameEn ?? "").trim();
    const nameEn = (b.nameEn ?? b.nameJa ?? "").trim();
    if (!nameJa && !nameEn) throw new ApiError("validation");
    const price = toMinor(b.price, owner.currency);
    if (price < 0) throw new ApiError("validation");
    const all = await storage.listMenus(owner.id);
    const m = await storage.createMenu({
      ownerId: owner.id, nameJa, nameEn, minutes: b.minutes, price, currency: owner.currency,
      descriptionJa: b.descriptionJa ?? "", descriptionEn: b.descriptionEn ?? "", active: b.active ?? true,
      sortOrder: b.sortOrder ?? all.length,
    });
    res.status(201).json({ ok: true, menu: storage.menuView(m, lang) });
  }));

  app.patch("/api/owner/menus/:id", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    const b = menuBody.partial().parse(req.body);
    const patch: Record<string, unknown> = { ...b };
    if (b.price !== undefined) patch.price = toMinor(b.price, owner.currency);
    const m = await storage.updateMenu(owner.id, Number(req.params.id), patch);
    if (!m) throw new ApiError("menu_not_found", 404);
    res.json({ ok: true, menu: storage.menuView(m, lang) });
  }));

  // ---------- オーナー：予約 ----------

  app.get("/api/owner/reservations", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    const q = req.query as Record<string, string | undefined>;
    const includeCancelled = q.includeCancelled === "1";
    let rows;
    if (q.customer) rows = await storage.listReservationsByCustomer(owner.id, q.customer);
    else {
      const from = q.from ?? q.date ?? todayFor(owner);
      const to = q.to ?? q.date ?? from;
      if (!isValidDate(from) || !isValidDate(to)) throw new ApiError("invalid_date");
      rows = await storage.listReservationsByDates(owner.id, owner.timezone, from, to, includeCancelled);
    }
    res.json({ ok: true, reservations: rows.map((r) => storage.reservationView(r, owner.timezone, lang)) });
  }));

  app.post("/api/owner/reservations", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    const b = z.object({
      menuId: z.number().int().optional(), menuName: z.string().optional(),
      date: z.string(), time: z.string(), endTime: z.string().optional(), customerName: z.string(),
      customerPhone: z.string().optional(), customerEmail: z.string().optional(),
      paymentMethod: z.enum(["card", "onsite"]).default("onsite"),
    }).parse(req.body);
    // メニューは任意（終わりの時刻だけでも入れられる）。指定されたのに見つからないときは止める
    const wanted = b.menuId !== undefined || !!b.menuName;
    const menu = b.menuId ? await storage.getMenu(owner.id, b.menuId) : b.menuName ? await storage.findMenuByName(owner.id, b.menuName) : undefined;
    if (wanted && !menu) throw new ApiError("menu_not_found", 404);
    const result = await createReservationFor(owner, { ...b, menu, source: "owner", lang });
    res.status(201).json({ ok: true, ...result });
  }));

  app.post("/api/owner/reservations/:id/cancel", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    const row = await storage.getReservation(owner.id, Number(req.params.id));
    if (!row) throw new ApiError("reservation_not_found", 404);
    res.json({ ok: true, ...(await cancelReservationFor(owner, row, lang)) });
  }));

  // ご予約ちゃんが会話で覚えたこと（見る・消す）
  app.get("/api/owner/memories", requireOwner, wrap(async (req, res) => {
    const owner = ownerOf(req);
    res.json({ ok: true, memories: (await storage.listMemories(owner.id)).map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt.toISOString() })).reverse() });
  }));
  app.delete("/api/owner/memories/:id", requireOwner, wrap(async (req, res) => {
    if (!(await storage.deleteMemory(ownerOf(req).id, Number(req.params.id)))) throw new ApiError("not_found", 404);
    res.json({ ok: true });
  }));

  // カレンダー購読用の URL（Google・iPhone・Outlook に予約を映す。一方通行）
  app.get("/api/owner/calendar-link", requireOwner, requireRegistered, wrap(async (req, res) => {
    const token = await calendarTokenFor(ownerOf(req));
    res.json({ ok: true, path: `/api/public/calendar/${token}.ics` });
  }));

  app.get("/api/owner/slots", requireOwner, wrap(async (req, res) => {
    const owner = ownerOf(req);
    const q = req.query as Record<string, string | undefined>;
    const menu = q.menuId ? await storage.getMenu(owner.id, Number(q.menuId)) : undefined;
    if (!menu) throw new ApiError("menu_not_found", 404);
    const date = q.date ?? todayFor(owner);
    res.json({ ok: true, date, ...(await slotsFor(owner, { date, minutes: menu.minutes, menuId: menu.id, source: "owner", staffId: q.staffId ? Number(q.staffId) : undefined })) });
  }));

  // ---------- オーナー：売り上げ ----------

  app.get("/api/owner/summary", requireOwner, wrap(async (req, res, lang) => {
    const owner = ownerOf(req);
    const q = req.query as Record<string, string | undefined>;
    const today = todayFor(owner);
    const from = q.from ?? monthRange(today).from;
    const to = q.to ?? monthRange(today).to;
    if (!isValidDate(from) || !isValidDate(to)) throw new ApiError("invalid_date");
    res.json({ ok: true, ...(await salesSummaryFor(owner, from, to, lang)) });
  }));

  // ---------- オーナー：臨時休業・休憩 ----------

  app.get("/api/owner/blocked-slots", requireOwner, wrap(async (req, res) => {
    const owner = ownerOf(req);
    const rows = await storage.listBlockedSlots(owner.id, new Date(Date.now() - 86400000));
    res.json({ ok: true, blockedSlots: rows.map((b) => ({ ...b, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString() })) });
  }));

  app.post("/api/owner/blocked-slots", requireOwner, wrap(async (req, res) => {
    const owner = ownerOf(req);
    const b = z.object({ date: z.string(), start: z.string().optional(), end: z.string().optional(), reason: z.string().max(200).optional() }).parse(req.body);
    const row = await addBlockedSlotFor(owner, b);
    res.status(201).json({ ok: true, blockedSlot: row });
  }));

  app.delete("/api/owner/blocked-slots/:id", requireOwner, wrap(async (req, res) => {
    const ok = await storage.deleteBlockedSlot(ownerOf(req).id, Number(req.params.id));
    if (!ok) throw new ApiError("not_found", 404);
    res.json({ ok: true });
  }));

  // ---------- お客さん向け（ログイン不要） ----------

  async function shopBySlug(slug: string): Promise<Owner> {
    const owner = await storage.getOwnerBySlug(slug);
    // 登録前のお店は、お客さんに予約ページを見せない（端末をなくすと、お客さんの予約ごと消えてしまうため）
    if (!owner || !owner.email) throw new ApiError("not_found", 404);
    return owner;
  }

  app.get("/api/public/shop/:slug", wrap(async (req, res, lang) => {
    const owner = await shopBySlug(req.params.slug);
    const menusList = await storage.listMenus(owner.id, true);
    const today = todayFor(owner);
    res.json({
      ok: true,
      shop: {
        slug: owner.slug, name: storage.shopName(owner, lang), shopNameJa: owner.shopNameJa, shopNameEn: owner.shopNameEn,
        address: owner.address, phone: owner.phone, info: owner.info, language: owner.language, currency: owner.currency,
        timezone: owner.timezone, hours: owner.hours, allowCardPayment: owner.allowCardPayment && cardPayable(owner),
        cardMinHoursBefore: owner.cardMinHoursBefore, cardHoldMinutes: CARD_HOLD_MINUTES,
        maxDaysAhead: owner.maxDaysAhead, minHoursBefore: owner.minHoursBefore,
        cancelPolicy: cancelPolicyText(owner.freeCancelHoursBefore, lang), freeCancelHoursBefore: owner.freeCancelHoursBefore,
        today, lastDate: addDays(today, owner.maxDaysAhead), allowNomination: owner.allowNomination,
      },
      menus: menusList.map((m) => storage.menuView(m, lang)),
      // 指名を受け付ける店なら、指名できるスタッフ（名前と、受けられるコース）
      staff: owner.allowNomination
        ? (await storage.listStaff(owner.id)).filter((s) => s.active && s.treats && s.acceptNominated).map((s) => ({ id: s.id, name: s.name, menuIds: s.menuIds }))
        : [],
    });
  }));

  app.get("/api/public/shop/:slug/slots", wrap(async (req, res) => {
    const owner = await shopBySlug(req.params.slug);
    const q = req.query as Record<string, string | undefined>;
    const menu = q.menuId ? await storage.getMenu(owner.id, Number(q.menuId)) : undefined;
    if (!menu || !menu.active) throw new ApiError("menu_not_found", 404);
    const date = q.date ?? "";
    const staffId = owner.allowNomination && q.staffId ? Number(q.staffId) : undefined;
    const r = await slotsFor(owner, { date, minutes: menu.minutes, menuId: menu.id, source: "web", staffId });
    // カード払いを選べる時間（来店の cardMinHoursBefore 時間前より先のもの）
    const from = cardOpenFrom(owner);
    const cardSlots = isValidDate(date) ? r.slots.filter((t) => fromLocal(date, t, owner.timezone) >= from) : [];
    res.json({ ok: true, date, ...r, cardSlots });
  }));

  // 予約の前に、クーポンで料金がいくらになるかを見る
  app.get("/api/public/shop/:slug/coupon", wrap(async (req, res, lang) => {
    const owner = await shopBySlug(req.params.slug);
    const q = req.query as Record<string, string | undefined>;
    const menu = q.menuId ? await storage.getMenu(owner.id, Number(q.menuId)) : undefined;
    if (!menu || !menu.active) throw new ApiError("menu_not_found", 404);
    const c = await couponDiscount(owner, q.code ?? "", menu);
    if (!c) throw new ApiError("coupon_invalid");
    res.json({ ok: true, code: c.code, discount: money(c.discount, menu.currency, lang), price: money(menu.price - c.discount, menu.currency, lang) });
  }));

  app.post("/api/public/shop/:slug/reservations", wrap(async (req, res, lang) => {
    const owner = await shopBySlug(req.params.slug);
    const b = z.object({
      menuId: z.number().int(), date: z.string(), time: z.string(),
      name: z.string().min(1).max(100), phone: z.string().min(1).max(40), email: z.string().max(200).optional(),
      paymentMethod: z.enum(["card", "onsite"]), couponCode: z.string().max(40).optional(), staffId: z.number().int().optional(),
    }).parse(req.body);
    const menu = await storage.getMenu(owner.id, b.menuId);
    if (!menu || !menu.active) throw new ApiError("menu_not_found", 404);
    const result = await createReservationFor(owner, {
      menu, date: b.date, time: b.time, customerName: b.name, customerPhone: b.phone, customerEmail: b.email,
      paymentMethod: b.paymentMethod, source: "web", lang, couponCode: b.couponCode,
      staffId: owner.allowNomination ? b.staffId : undefined,
    });
    res.status(201).json({ ok: true, ...result, shopName: storage.shopName(owner, lang) });
  }));

  const lookupBody = z.object({ number: z.string().regex(/^\d{4}$/), phone: z.string().min(1), slug: z.string().optional() });

  async function lookup(body: z.infer<typeof lookupBody>) {
    const owner = body.slug ? await storage.getOwnerBySlug(body.slug) : undefined;
    const rows = await storage.findReservationsForLookup(body.number, storage.cleanPhone(body.phone), owner?.id);
    if (!rows.length) throw new ApiError("reservation_not_found", 404);
    return rows[0];
  }

  /** Stripe から戻ってきたページが、支払い済みかを確かめる（Webhook が届かない環境の保険） */
  app.get("/api/public/pay/confirm", wrap(async (req, res, lang) => {
    const sessionId = String(req.query.session_id ?? "");
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new ApiError("validation");
    const r = await confirmSession(sessionId);
    if (!r.reservation) throw new ApiError("reservation_not_found", 404);
    const owner = await storage.getOwner(r.reservation.ownerId);
    const row = await storage.getReservation(r.reservation.ownerId, r.reservation.id);
    if (!owner || !row) throw new ApiError("reservation_not_found", 404);
    res.json({ ok: true, paid: r.paid, reservation: storage.reservationView(row, owner.timezone, lang), shopName: storage.shopName(owner, lang) });
  }));

  app.get("/api/public/calendar/:token.ics", wrap(async (req, res) => {
    const owner = /^[A-Za-z0-9_-]{20,}$/.test(req.params.token) ? await storage.getOwnerByCalendarToken(req.params.token) : undefined;
    if (!owner) throw new ApiError("not_found", 404);
    res.type("text/calendar; charset=utf-8").setHeader("Cache-Control", "no-store");
    res.send(await calendarFeed(owner));
  }));

  app.get("/api/public/config", (_req, res) => {
    res.json({ ok: true, stripe: stripeConfigured(), email: emailConfigured() });
  });

  app.post("/api/public/lookup", wrap(async (req, res, lang) => {
    const row = await lookup(lookupBody.parse(req.body));
    res.json({
      ok: true,
      reservation: storage.reservationView(row, row.owner.timezone, lang),
      shop: { name: storage.shopName(row.owner, lang), slug: row.owner.slug, address: row.owner.address, phone: row.owner.phone,
        cancelPolicy: cancelPolicyText(row.owner.freeCancelHoursBefore, lang),
        today: todayFor(row.owner), maxDaysAhead: row.owner.maxDaysAhead, freeCancelHours: row.owner.freeCancelHoursBefore, canReschedule: reschedulable(row) },
    });
  }));

  // ---------- お客さん：日時の変更（無料で取り消せる期限までなら、自分で変えられる） ----------

  function reschedulable(row: storage.ReservationRow & { owner: Owner }): boolean {
    return row.status === "confirmed" && refundEligible(row.startAt, row.owner.freeCancelHoursBefore);
  }
  function assertReschedulable(row: storage.ReservationRow & { owner: Owner }) {
    if (row.status !== "confirmed") throw new ApiError("not_confirmed");
    if (!reschedulable(row)) throw new ApiError("reschedule_too_late", 400, { hours: row.owner.freeCancelHoursBefore });
  }

  app.post("/api/public/lookup/slots", wrap(async (req, res) => {
    const b = lookupBody.extend({ date: z.string() }).parse(req.body);
    const row = await lookup(b);
    assertReschedulable(row);
    // 自分の予約は空きを邪魔しないので外す。指名の予約なら、その人の空きだけ
    const staffId = row.nominated && row.staffId !== null ? row.staffId : undefined;
    res.json({ ok: true, date: b.date, ...(await slotsFor(row.owner, { date: b.date, minutes: row.minutes, menuId: row.menuId, source: "web", staffId, ignoreId: row.id })) });
  }));

  app.post("/api/public/lookup/reschedule", wrap(async (req, res, lang) => {
    const b = lookupBody.extend({ date: z.string(), time: z.string() }).parse(req.body);
    const row = await lookup(b);
    assertReschedulable(row);
    const r = await updateReservationFor(row.owner, row, { date: b.date, time: b.time, lang, source: "web" });
    const updated = await storage.updateReservation(row.owner.id, row.id, { changedByCustomerAt: new Date() });
    // 新しい日時の確認メールを送る（失敗しても変更は残す）
    if (updated) {
      notifyReservation(row.owner, updated, "moved");
      await sendBookingConfirmation(row.owner, updated).catch((e) => console.error("[email]", e));
    }
    res.json({ ok: true, reservation: updated ? storage.reservationView(updated, row.owner.timezone, lang) : r.reservation });
  }));

  app.post("/api/public/lookup/cancel", wrap(async (req, res, lang) => {
    const row = await lookup(lookupBody.parse(req.body));
    const result = await cancelReservationFor(row.owner, row, lang, "customer");
    notifyReservation(row.owner, row, "cancelled");
    res.json({ ok: true, ...result });
  }));

  registerVoiceRoutes(app);
  registerStaffRoutes(app);
  registerGroupRoutes(app);
  registerAttendanceRoutes(app);
  registerApiRoutes(app);
  registerBooksRoutes(app);
  registerFollowupRoutes(app);
  registerBillingRoutes(app);
  registerCardPayRoutes(app);
  registerPushRoutes(app);
  registerTicketRoutes(app);
  registerPassRoutes(app);
  registerCapabilityRoutes(app);

  app.use("/api", (_req, res) => {
    res.status(404).json({ ok: false, code: "not_found" });
  });
}
