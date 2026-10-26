/**
 * 店舗グループ。1店舗1アカウントのまま、グループに入った店どうしで集計だけを見せ合う。
 * - 見せるのは売り上げと件数（取り消し・無断キャンセル）だけ。お客さんの名前や予約の中身は見せない
 * - 入るには参加コードが要る。コードはグループの店だけが見られる
 */
import type { Express, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Owner, Language } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import * as storage from "./storage";
import { requireOwner, requireRegistered, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { salesSummaryFor, todayFor } from "./services";
import { monthRange } from "./lib/time";

const newCode = () => randomBytes(4).toString("hex").toUpperCase();

export async function createGroupFor(owner: Owner, name: string) {
  if (owner.groupId) throw new ApiError("already_in_group", 409);
  const group = await storage.createShopGroup({ name: name.trim() || storage.shopName(owner, "ja") || "Group", joinCode: newCode(), createdBy: owner.id });
  await storage.updateOwner(owner.id, { groupId: group.id });
  return group;
}

export async function joinGroupFor(owner: Owner, code: string) {
  if (owner.groupId) throw new ApiError("already_in_group", 409);
  const group = await storage.getShopGroupByCode(code.normalize("NFKC").trim().toUpperCase());
  if (!group) throw new ApiError("group_not_found", 404);
  await storage.updateOwner(owner.id, { groupId: group.id });
  return group;
}

export async function leaveGroupFor(owner: Owner) {
  await storage.updateOwner(owner.id, { groupId: null });
}

/** グループの店ごとの集計（期間を省けば、それぞれの店の今月） */
export async function groupSummaryFor(owner: Owner, lang: Language, from?: string, to?: string) {
  if (!owner.groupId) return null;
  const group = await storage.getShopGroup(owner.groupId);
  if (!group) return null;
  const shops = await storage.listGroupOwners(group.id);
  const rows = await Promise.all(shops.map(async (o) => {
    const m = monthRange(todayFor(o));
    const s = await salesSummaryFor(o, from ?? m.from, to ?? m.to, lang);
    return { shopName: storage.shopName(o, lang), me: o.id === owner.id, from: s.from, to: s.to, total: s.total, reservationCount: s.reservationCount, cancelledCount: s.cancelledCount, noShowCount: s.noShowCount };
  }));
  return { group: { name: group.name, joinCode: group.joinCode }, shops: rows };
}

function handle(fn: (req: Request, res: Response, owner: Owner, lang: Language) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(req.query.lang ?? owner.language);
    try { await fn(req, res, owner, lang); }
    catch (e) { sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e); }
  };
}

export function registerGroupRoutes(app: Express) {
  app.get("/api/owner/group", requireOwner, handle(async (_req, res, owner, lang) => {
    res.json({ ok: true, ...((await groupSummaryFor(owner, lang)) ?? { group: null, shops: [] }) });
  }));
  app.post("/api/owner/group", requireOwner, requireRegistered, handle(async (req, res, owner) => {
    const { name } = z.object({ name: z.string().max(100).default("") }).parse(req.body ?? {});
    const g = await createGroupFor(owner, name);
    res.status(201).json({ ok: true, group: { name: g.name, joinCode: g.joinCode } });
  }));
  app.post("/api/owner/group/join", requireOwner, requireRegistered, handle(async (req, res, owner) => {
    const { code } = z.object({ code: z.string().min(1).max(40) }).parse(req.body);
    const g = await joinGroupFor(owner, code);
    res.json({ ok: true, group: { name: g.name, joinCode: g.joinCode } });
  }));
  app.post("/api/owner/group/leave", requireOwner, handle(async (_req, res, owner) => {
    await leaveGroupFor(owner);
    res.json({ ok: true });
  }));
}
