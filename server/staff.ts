/**
 * スタッフ：登録と権限（オーナー）、招待とログイン、自分の予定と打刻（スタッフ本人）。
 * - 権限はかんたんに：施術するか・指名を受けるか・フリーを受けるか・受けられるコース、ログインしたときの役割（staff / manager）
 * - ログインできる人の数（オーナー＋招待中・ログインできるスタッフ）が、料金の人数になる
 * - スタッフ本人が触れるのは、自分の予定（manager は全員の予定）と自分の打刻だけ
 */
import type { Express, Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Owner, Staff, Language } from "@shared/schema";
import { STAFF_ROLES } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import * as storage from "./storage";
import { requireOwner, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { hashSecret } from "./lib/passphrase";
import { ensureStaffMode, todayFor } from "./services";
import { sendStaffInvite } from "./email";
import { appBaseUrl } from "./payments";
import { fromLocal, addDays, monthRange, toLocal } from "./lib/time";
import { clockFor, clockOutlook, setShiftFor } from "./attendance";

const INVITE_DAYS = 7;

/** 料金の人数：オーナー本人＋ログインできる・招待中のスタッフ（オーナー本人の枠は数えない） */
export async function seatsFor(ownerId: number): Promise<{ seats: number; staffSeats: number }> {
  const all = await storage.listStaff(ownerId);
  const staffSeats = all.filter((s) => !s.isOwner && s.active && (s.passwordHash || s.inviteToken)).length;
  return { seats: 1 + staffSeats, staffSeats };
}

export type StaffInput = {
  name?: string; email?: string | null; treats?: boolean; acceptNominated?: boolean; acceptFree?: boolean;
  menuIds?: number[] | null; role?: (typeof STAFF_ROLES)[number]; active?: boolean;
};

async function checkEmail(email: string, selfId?: number) {
  const e = email.toLowerCase().trim();
  // ログインの画面と同じ決まりで確かめる（ここで通ってもログインで弾かれる、を起こさないため）
  if (!z.string().email().safeParse(e).success) throw new ApiError("invalid_email");
  const other = await storage.getStaffByEmail(e);
  if ((other && other.id !== selfId) || (await storage.getOwnerByEmail(e))) throw new ApiError("staff_email_in_use", 409);
  return e;
}

async function checkMenus(owner: Owner, ids: number[] | null | undefined) {
  if (!ids) return ids;
  const mine = new Set((await storage.listMenus(owner.id)).map((m) => m.id));
  if (ids.some((id) => !mine.has(id))) throw new ApiError("menu_not_found", 404);
  return ids;
}

/** 招待のリンクを作り直して、メールがあれば送る */
export async function inviteStaff(owner: Owner, member: Staff): Promise<{ path: string; email: string }> {
  const token = randomBytes(18).toString("base64url");
  const path = `/staff/join?token=${token}`;
  await storage.updateStaff(owner.id, member.id, { inviteToken: token, inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86400000) });
  let email = "no_email";
  if (member.email) {
    try { email = await sendStaffInvite(owner, member.email, member.name, appBaseUrl() + path); }
    catch (e) { console.error("[email]", e); email = "failed"; }
  }
  return { path, email };
}

export async function createStaffFor(owner: Owner, input: StaffInput, lang: Language) {
  const name = storage.cleanName(input.name ?? "");
  if (!name) throw new ApiError("name_required");
  const email = input.email ? await checkEmail(input.email) : null;
  await ensureStaffMode(owner, lang);
  const count = (await storage.listStaff(owner.id)).length;
  const member = await storage.createStaff({
    ownerId: owner.id, name, email, treats: input.treats ?? true, acceptNominated: input.acceptNominated ?? true,
    acceptFree: input.acceptFree ?? true, menuIds: await checkMenus(owner, input.menuIds ?? null), role: input.role ?? "staff", sortOrder: count,
  });
  const invite = email ? await inviteStaff(owner, member) : null;
  return { staff: storage.publicStaff((await storage.getStaff(owner.id, member.id)) ?? member), invite };
}

export async function updateStaffFor(owner: Owner, member: Staff, input: StaffInput) {
  const patch: Partial<Staff> = {};
  if (input.name !== undefined) { const n = storage.cleanName(input.name); if (!n) throw new ApiError("name_required"); patch.name = n; }
  if (input.email !== undefined) patch.email = input.email ? await checkEmail(input.email, member.id) : null;
  for (const k of ["treats", "acceptNominated", "acceptFree", "active"] as const) if (input[k] !== undefined) patch[k] = input[k];
  if (input.menuIds !== undefined) patch.menuIds = await checkMenus(owner, input.menuIds);
  if (input.role !== undefined) patch.role = input.role;
  // 在籍をやめたら、ログインと招待も止める（料金の人数から外れる）
  if (input.active === false) Object.assign(patch, { inviteToken: null, passwordHash: null });
  const updated = (await storage.updateStaff(owner.id, member.id, patch)) ?? member;
  if (patch.name && patch.name !== member.name) await storage.renameStaffOnReservations(owner.id, member.id, patch.name);
  return storage.publicStaff(updated);
}

/** 期間の勤務時間（分）をスタッフごとに。退勤していなければ今までを数える */
export async function timesheetFor(owner: Owner, month: string) {
  const { from, to } = monthRange(`${month}-01`);
  const entries = await storage.listTimeEntries(owner.id, fromLocal(from, "00:00", owner.timezone), fromLocal(addDays(to, 1), "00:00", owner.timezone));
  const all = await storage.listStaff(owner.id);
  const now = Date.now();
  return all.filter((s) => entries.some((e) => e.staffId === s.id) || (s.active && !s.isOwner)).map((s) => {
    const mine = entries.filter((e) => e.staffId === s.id);
    const minutes = mine.reduce((a, e) => a + Math.max(0, Math.round(((e.clockOut?.getTime() ?? now) - e.clockIn.getTime()) / 60000)), 0);
    const days = new Set(mine.map((e) => toLocal(e.clockIn, owner.timezone).date)).size;
    return { staffId: s.id, name: s.name, minutes, hours: Math.round((minutes / 60) * 10) / 10, days, working: mine.some((e) => !e.clockOut) };
  });
}

// ---------- 画面の API ----------

type StaffRequest = Request & { member: Staff; shop: Owner };

function requireStaff(req: Request, res: Response, next: NextFunction) {
  const id = req.session.staffId;
  const lang = normalizeLang(req.query.lang);
  if (!id) return sendError(res, lang, new ApiError("unauthorized", 401));
  storage.getStaffById(id).then(async (member) => {
    const shop = member ? await storage.getOwner(member.ownerId) : undefined;
    if (!member || !member.active || !member.passwordHash || !shop) {
      req.session.staffId = undefined;
      return sendError(res, lang, new ApiError("unauthorized", 401));
    }
    Object.assign(req, { member, shop });
    next();
  }).catch(next);
}

const staffBody = z.object({
  name: z.string().max(100).optional(), email: z.string().max(200).nullable().optional(),
  treats: z.boolean().optional(), acceptNominated: z.boolean().optional(), acceptFree: z.boolean().optional(),
  menuIds: z.array(z.number().int()).nullable().optional(), role: z.enum(STAFF_ROLES).optional(), active: z.boolean().optional(),
});

function handle(fn: (req: Request, res: Response, lang: Language) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner ?? (req as StaffRequest).shop;
    const lang = normalizeLang(req.query.lang ?? req.body?.lang ?? owner?.language);
    try { await fn(req, res, lang); }
    catch (e) { sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e); }
  };
}

export function registerStaffRoutes(app: Express) {
  // ---------- オーナー ----------
  app.get("/api/owner/staff", requireOwner, handle(async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const all = await storage.listStaff(owner.id);
    const working = await Promise.all(all.map(async (s) => !!(await storage.openTimeEntry(s.id))));
    res.json({ ok: true, staff: all.map((s, i) => ({ ...storage.publicStaff(s), working: working[i] })), allowNomination: owner.allowNomination, ...(await seatsFor(owner.id)) });
  }));
  app.post("/api/owner/staff", requireOwner, handle(async (req, res, lang) => {
    const owner = (req as AuthedRequest).owner;
    res.status(201).json({ ok: true, ...(await createStaffFor(owner, staffBody.parse(req.body), lang)) });
  }));
  app.patch("/api/owner/staff/:id", requireOwner, handle(async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const member = await storage.getStaff(owner.id, Number(req.params.id));
    if (!member) throw new ApiError("staff_not_found", 404);
    res.json({ ok: true, staff: await updateStaffFor(owner, member, staffBody.parse(req.body)) });
  }));
  app.post("/api/owner/staff/:id/invite", requireOwner, handle(async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const member = await storage.getStaff(owner.id, Number(req.params.id));
    if (!member || member.isOwner || !member.active) throw new ApiError("staff_not_found", 404);
    res.json({ ok: true, ...(await inviteStaff(owner, member)) });
  }));
  app.get("/api/owner/timesheet", requireOwner, handle(async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const month = String(req.query.month ?? todayFor(owner).slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError("validation");
    res.json({ ok: true, month, staff: await timesheetFor(owner, month) });
  }));

  // ---------- 招待を受ける ----------
  const validInvite = async (token: string) => {
    const member = token ? await storage.getStaffByInvite(token) : undefined;
    if (!member || !member.active || !member.inviteExpiresAt || member.inviteExpiresAt.getTime() < Date.now()) throw new ApiError("invite_invalid", 404);
    return member;
  };
  app.get("/api/staff/invite", handle(async (req, res, lang) => {
    const member = await validInvite(String(req.query.token ?? ""));
    const shop = await storage.getOwner(member.ownerId);
    res.json({ ok: true, name: member.name, email: member.email, shopName: shop ? storage.shopName(shop, lang) : "" });
  }));
  app.post("/api/staff/join", handle(async (req, res) => {
    const b = z.object({ token: z.string(), password: z.string().min(8).max(200) }).parse(req.body);
    const member = await validInvite(b.token);
    const updated = await storage.updateStaff(member.ownerId, member.id, { passwordHash: hashSecret(b.password), inviteToken: null, inviteExpiresAt: null });
    req.session.ownerId = undefined;
    req.session.staffId = member.id;
    res.json({ ok: true, staff: storage.publicStaff(updated ?? member) });
  }));

  // ---------- スタッフ本人 ----------
  app.get("/api/staff/me", requireStaff, handle(async (req, res, lang) => {
    const { member, shop } = req as StaffRequest;
    const date = String(req.query.date ?? todayFor(shop));
    const rows = await storage.listReservationsByDates(shop.id, shop.timezone, date, date);
    // staff は自分の予約だけ、manager は全員の予約
    const mine = member.role === "manager" ? rows : rows.filter((r) => r.staffId === member.id);
    const look = await clockOutlook(shop, member);
    const open = look.open;
    const sheet = (await timesheetFor(shop, todayFor(shop).slice(0, 7))).find((x) => x.staffId === member.id);
    const today = todayFor(shop);
    const plans = await storage.listShifts(member.id, today, addDays(today, 13));
    res.json({
      ok: true, staff: storage.publicStaff(member), shopName: storage.shopName(shop, lang), date,
      reservations: mine.map((r) => {
        const v = storage.reservationView(r, shop.timezone, lang);
        return { id: v.id, time: v.time, endTime: v.endTime, customerName: v.customerName, menuName: v.menuName, staffName: v.staffName, status: v.status, notes: r.customer.notes || null };
      }),
      clockedInAt: open ? open.clockIn.toISOString() : null, clockedInTime: open ? toLocal(open.clockIn, shop.timezone).time : null,
      // 次の打刻が予定どおりの幅のうちか（外れていても打刻はできる。オーナーの確認に回る）
      outlook: { next: look.next, planned: look.planned, window: look.window, within: look.within, tolerance: look.tolerance },
      today, plans: plans.map((p) => ({ date: p.date, planStart: p.planStart, planEnd: p.planEnd })),
      monthHours: sheet?.hours ?? 0, monthDays: sheet?.days ?? 0,
    });
  }));
  app.post("/api/staff/clock", requireStaff, handle(async (req, res) => {
    const { member, shop } = req as StaffRequest;
    const { action } = z.object({ action: z.enum(["in", "out"]) }).parse(req.body);
    const entry = await clockFor(shop, member, action);
    const after = await storage.openTimeEntry(member.id);
    res.json({ ok: true, clockedInAt: after ? after.clockIn.toISOString() : null, onPlan: entry ? entry.flags.length === 0 : null });
  }));
  // 勤務の予定（入り・上がり）を決める。打刻の前に決めておけば、その前後の打刻は「予定どおり」
  app.put("/api/staff/shifts", requireStaff, handle(async (req, res) => {
    const { member, shop } = req as StaffRequest;
    const b = z.object({ date: z.string(), planStart: z.string(), planEnd: z.string() }).parse(req.body);
    const s = await setShiftFor(shop, member, b.date, b.planStart, b.planEnd);
    res.json({ ok: true, plan: { date: s.date, planStart: s.planStart, planEnd: s.planEnd } });
  }));
}
