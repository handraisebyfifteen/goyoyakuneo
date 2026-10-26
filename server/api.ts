/**
 * API キーと、外の道具から読むための API（/api/v1、読み取り専用）。
 * - キーはオーナーが管理画面で発行する。キーそのものは発行したときに一度だけ返し、保存するのはハッシュだけ
 * - 使うときは「Authorization: Bearer <キー>」。取り消したキーは使えない
 * - 読めるのはそのキーの店のデータと、店舗グループのほかの店の集計（売り上げと件数）だけ
 * - 書き込みはできない（外から予約を入れる・消すのは事故のもとなので、要るときに改めて考える）
 */
import type { Express, Request, Response, NextFunction } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Owner, Language } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import { money } from "@shared/money";
import * as storage from "./storage";
import { requireOwner, requireRegistered, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { salesSummaryFor, todayFor } from "./services";
import { timesheetFor, payrollFor } from "./staff";
import { groupSummaryFor } from "./groups";
import { entryView } from "./attendance";
import { profitFor, ledgerFor, categoryLabel } from "./books";
import { ticketView } from "./tickets";
import { addDays, fromLocal, isValidDate, monthRange } from "./lib/time";

const MAX_KEYS = 10;
const MAX_DAYS = 92;
const RATE_PER_MINUTE = 120;

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export async function issueApiKey(owner: Owner, name: string): Promise<{ key: string; id: number; prefix: string }> {
  const live = (await storage.listApiKeys(owner.id)).filter((k) => !k.revokedAt);
  if (live.length >= MAX_KEYS) throw new ApiError("validation");
  const key = `gyk_${randomBytes(24).toString("base64url")}`;
  const prefix = key.slice(0, 10);
  const row = await storage.createApiKey({ ownerId: owner.id, name: name.trim().slice(0, 60) || prefix, prefix, keyHash: hashKey(key) });
  return { key, id: row.id, prefix };
}

// ---------- キーの確かめと、使いすぎの歯止め ----------

type KeyRequest = Request & { owner: Owner; lang: Language };
const hits = new Map<number, { minute: number; count: number }>();

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const lang = normalizeLang(req.query.lang);
  const m = /^Bearer\s+(gyk_[A-Za-z0-9_-]{20,})$/.exec(req.header("authorization") ?? "");
  if (!m) return sendError(res, lang, new ApiError("unauthorized", 401));
  storage.getApiKeyByHash(hashKey(m[1])).then(async (k) => {
    if (!k || k.revokedAt) return sendError(res, lang, new ApiError("unauthorized", 401));
    const minute = Math.floor(Date.now() / 60000);
    const h = hits.get(k.id);
    if (h && h.minute === minute && h.count >= RATE_PER_MINUTE) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ ok: false, code: "rate_limited", message: "Too many requests. Try again in a minute." });
    }
    hits.set(k.id, h && h.minute === minute ? { minute, count: h.count + 1 } : { minute, count: 1 });
    const owner = await storage.getOwner(k.ownerId);
    if (!owner) return sendError(res, lang, new ApiError("unauthorized", 401));
    // 最後に使った時刻（書き込みを減らすため、1分に1回まで）
    if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60000) await storage.updateApiKey(owner.id, k.id, { lastUsedAt: new Date() });
    Object.assign(req, { owner, lang: normalizeLang(req.query.lang ?? owner.language) });
    next();
  }).catch(next);
}

/** from / to（YYYY-MM-DD）。省けば今月。長すぎる期間は断る */
function period(owner: Owner, q: Record<string, unknown>): { from: string; to: string } {
  const m = monthRange(todayFor(owner));
  const from = String(q.from ?? m.from), to = String(q.to ?? m.to);
  if (!isValidDate(from) || !isValidDate(to) || from > to) throw new ApiError("invalid_date");
  if (to > addDays(from, MAX_DAYS)) throw new ApiError("validation");
  return { from, to };
}

function handle(fn: (req: KeyRequest, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const r = req as KeyRequest;
    try { await fn(r, res); }
    catch (e) { sendError(res, r.lang ?? "ja", e instanceof z.ZodError ? new ApiError("validation") : e); }
  };
}

export function registerApiRoutes(app: Express) {
  // ---------- オーナー：キーの発行・一覧・取り消し ----------
  app.get("/api/owner/api-keys", requireOwner, async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const keys = await storage.listApiKeys(owner.id);
    res.json({ ok: true, keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revoked: !!k.revokedAt })) });
  });
  app.post("/api/owner/api-keys", requireOwner, requireRegistered, async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    try {
      const { name } = z.object({ name: z.string().max(60).default("") }).parse(req.body ?? {});
      res.status(201).json({ ok: true, ...(await issueApiKey(owner, name)) });
    } catch (e) { sendError(res, normalizeLang(owner.language), e instanceof z.ZodError ? new ApiError("validation") : e); }
  });
  app.delete("/api/owner/api-keys/:id", requireOwner, async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const k = await storage.updateApiKey(owner.id, Number(req.params.id), { revokedAt: new Date() });
    if (!k) return sendError(res, normalizeLang(owner.language), new ApiError("not_found", 404));
    res.json({ ok: true });
  });

  // ---------- 外の道具から読む（/api/v1） ----------
  app.use("/api/v1", requireApiKey);

  app.get("/api/v1/shop", handle(async (req, res) => {
    const o = req.owner;
    res.json({ ok: true, shop: {
      name: storage.shopName(o, req.lang), slug: o.slug, address: o.address, phone: o.phone, info: o.info,
      country: o.country, currency: o.currency, timezone: o.timezone, language: o.language, hours: o.hours,
      rules: { bufferMinutes: o.bufferMinutes, slotStepMinutes: o.slotStepMinutes, maxDaysAhead: o.maxDaysAhead, minHoursBefore: o.minHoursBefore, freeCancelHoursBefore: o.freeCancelHoursBefore, allowCardPayment: o.allowCardPayment, allowNomination: o.allowNomination },
      menus: (await storage.listMenus(o.id)).map((m) => { const v = storage.menuView(m, req.lang); return { id: v.id, name: v.name, minutes: v.minutes, price: v.price, active: v.active }; }),
    } });
  }));

  app.get("/api/v1/reservations", handle(async (req, res) => {
    const { from, to } = period(req.owner, req.query);
    const rows = await storage.listReservationsByDates(req.owner.id, req.owner.timezone, from, to, req.query.include_cancelled === "true");
    res.json({ ok: true, from, to, reservations: rows.map((r) => {
      const { paymentUrl: _p, ...v } = storage.reservationView(r, req.owner.timezone, req.lang);
      return { ...v, customerId: r.customerId };
    }) });
  }));

  app.get("/api/v1/sales", handle(async (req, res) => {
    const { from, to } = period(req.owner, req.query);
    res.json({ ok: true, sales: await salesSummaryFor(req.owner, from, to, req.lang) });
  }));

  app.get("/api/v1/customers", handle(async (req, res) => {
    const rows = await storage.listCustomers(req.owner.id);
    res.json({ ok: true, customers: rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone || null, email: c.email, notes: c.notes || null, createdAt: c.createdAt.toISOString() })) });
  }));

  app.get("/api/v1/staff", handle(async (req, res) => {
    const all = await storage.listStaff(req.owner.id);
    res.json({ ok: true, staff: all.map((s) => ({ id: s.id, name: s.name, isOwner: s.isOwner, treats: s.treats, acceptNominated: s.acceptNominated, acceptFree: s.acceptFree, menuIds: s.menuIds, role: s.role, active: s.active })) });
  }));

  app.get("/api/v1/attendance", handle(async (req, res) => {
    const o = req.owner;
    const month = String(req.query.month ?? todayFor(o).slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError("validation");
    const { from, to } = monthRange(`${month}-01`);
    const names = new Map((await storage.listStaff(o.id)).map((s) => [s.id, s.name]));
    const entries = await storage.listTimeEntries(o.id, fromLocal(from, "00:00", o.timezone), fromLocal(addDays(to, 1), "00:00", o.timezone));
    res.json({ ok: true, month, totals: await timesheetFor(o, month), entries: entries.map((e) => entryView(o, e, names.get(e.staffId) ?? "", req.lang)) });
  }));

  app.get("/api/v1/payroll", handle(async (req, res) => {
    const month = String(req.query.month ?? todayFor(req.owner).slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError("validation");
    const r = await payrollFor(req.owner, month, req.lang);
    res.json({ ok: true, month, total: r.total, staff: r.staff.map(({ totalMinor: _t, ...rest }) => rest) });
  }));

  app.get("/api/v1/tickets", handle(async (req, res) => {
    const today = todayFor(req.owner);
    res.json({ ok: true, tickets: (await storage.listTickets(req.owner.id)).map((t) => ticketView(t, req.owner, req.lang, today)) });
  }));

  app.get("/api/v1/expenses", handle(async (req, res) => {
    const { from, to } = period(req.owner, req.query);
    const list = await storage.listExpenses(req.owner.id, from, to);
    res.json({ ok: true, from, to, expenses: list.map((e) => ({ id: e.id, date: e.date, amount: money(e.amount, req.owner.currency, req.lang), category: e.category, label: categoryLabel(e.category, req.lang), memo: e.memo })),
      profit: await profitFor(req.owner, from, to, req.lang) });
  }));

  app.get("/api/v1/ledger", handle(async (req, res) => {
    const year = Number(req.query.year ?? todayFor(req.owner).slice(0, 4));
    if (!(year >= 2000 && year <= 2100)) throw new ApiError("validation");
    res.json({ ok: true, year, rows: (await ledgerFor(req.owner, year, req.lang)).map((r) => ({ ...r, amount: money(r.amount, req.owner.currency, req.lang) })) });
  }));

  // 店舗グループのほかの店の集計（売り上げと件数だけ）
  app.get("/api/v1/group", handle(async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const r = await groupSummaryFor(req.owner, req.lang, q.from, q.to);
    res.json({ ok: true, ...(r ?? { group: null, shops: [] }) });
  }));
}
