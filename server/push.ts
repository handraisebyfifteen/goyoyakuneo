/**
 * スマホへの通知（Web Push）。アプリを閉じていても、画面がロックされていても届く（読み上げ機能が読む）。
 * - 鍵（VAPID）は環境変数 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY があればそれを、なければ初回に作ってデータベースに持つ
 * - 通知を許可した端末だけに送る。送れなくなった宛先は消す
 * - iPhone は、ホーム画面に追加したアプリから許可したときだけ届く（Safari の決まり）
 * - 件名だけで中身がわかるように書く（ロック画面では件名と本文の頭しか読まれないことがある）
 */
import type { Express, Request, Response } from "express";
import webpush from "web-push";
import { z } from "zod";
import type { Owner, Language } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import * as storage from "./storage";
import { requireOwner, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { appBaseUrl } from "./payments";
import { spokenWhen } from "./ai/tools";

type Vapid = { publicKey: string; privateKey: string };
let vapidP: Promise<Vapid> | null = null;

function vapid(): Promise<Vapid> {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) return Promise.resolve({ publicKey: pub, privateKey: priv });
  vapidP ??= storage.serverKey("vapid", () => JSON.stringify(webpush.generateVAPIDKeys())).then((v) => JSON.parse(v) as Vapid);
  return vapidP;
}

/** 送り主の連絡先。https の URL か mailto: が要る */
function subject(): string {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  const base = appBaseUrl();
  return base.startsWith("https://") ? base : "mailto:noreply@goyoyaku.invalid";
}

export type PushMessage = { title: string; body: string; url?: string; tag?: string };

/** オーナーの端末すべてに送る。届けた数を返す。失敗しても止めない */
export async function sendPush(ownerId: number, msg: PushMessage): Promise<number> {
  const subs = await storage.listPushSubscriptions(ownerId);
  if (!subs.length) return 0;
  const keys = await vapid();
  const payload = JSON.stringify({ url: "/admin", ...msg });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
        { vapidDetails: { subject: subject(), ...keys }, TTL: 60 * 60 * 24, urgency: "high", timeout: 15_000 });
      sent += 1;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404・410：ブラウザがその宛先を捨てた（許可の取り消し、アプリの削除など）
      if (code === 404 || code === 410) await storage.dropPushEndpoint(s.endpoint);
      else console.error("[push]", code ?? "", e instanceof Error ? e.message : e);
    }
  }));
  return sent;
}

export type PushKind = "booked" | "paid" | "expired" | "cancelled" | "moved";

/** 予約の知らせを通知の文にする。件名に何が起きたかとお客さんの名前、本文に日時とメニュー */
export function pushText(owner: Owner, r: storage.ReservationRow, kind: PushKind): PushMessage {
  const lang: Language = normalizeLang(owner.language);
  const ja = lang === "ja";
  const v = storage.reservationView(r, owner.timezone, lang);
  const who = ja ? `${v.customerName}様` : v.customerName;
  const head: Record<PushKind, string> = ja
    ? { booked: `新しい予約：${who}`, paid: `カード払い完了：${who}`, expired: `未払いで取り消し：${who}`, cancelled: `お客さんの取り消し：${who}`, moved: `日時の変更：${who}` }
    : { booked: `New booking: ${who}`, paid: `Card payment received: ${who}`, expired: `Cancelled, not paid: ${who}`, cancelled: `Cancelled by customer: ${who}`, moved: `Time changed: ${who}` };
  const pay = v.paymentMethod === "card" && v.paymentStatus === "unpaid" ? (ja ? "（カード払い待ち）" : " (awaiting card payment)") : "";
  const tail = kind === "expired" ? (ja ? "。その時間はまた空いています" : ". That time is open again") : kind === "paid" && v.price ? (ja ? `。${v.price.display}` : `. ${v.price.display}`) : pay;
  return { title: head[kind], body: `${spokenWhen(v.date, v.time, lang)}${v.menuName ? (ja ? `、${v.menuName}` : `, ${v.menuName}`) : ""}${tail}`, tag: `r${r.id}-${kind}` };
}

/** 予約の知らせを送る（待たない。失敗はログだけ） */
export function notifyReservation(owner: Owner, r: storage.ReservationRow, kind: PushKind): void {
  sendPush(owner.id, pushText(owner, r, kind)).catch((e) => console.error("[push]", e));
}

/** User-Agent から、画面で見分けるための端末の名前 */
function deviceName(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "";
}

function handle(fn: (req: Request, res: Response, owner: Owner, lang: Language) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(req.query.lang ?? req.body?.lang ?? owner.language);
    try { await fn(req, res, owner, lang); }
    catch (e) { sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e); }
  };
}

const subBody = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }) });

export function registerPushRoutes(app: Express) {
  app.get("/api/owner/push", requireOwner, handle(async (_req, res, owner) => {
    const subs = await storage.listPushSubscriptions(owner.id);
    res.json({ ok: true, publicKey: (await vapid()).publicKey, devices: subs.map((s) => ({ id: s.id, device: s.device, endpoint: s.endpoint, createdAt: s.createdAt.toISOString() })) });
  }));
  app.post("/api/owner/push", requireOwner, handle(async (req, res, owner) => {
    const b = subBody.parse(req.body);
    const s = await storage.savePushSubscription({ ownerId: owner.id, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, device: deviceName(req.get("user-agent") ?? "") });
    res.status(201).json({ ok: true, id: s.id });
  }));
  app.post("/api/owner/push/remove", requireOwner, handle(async (req, res, owner) => {
    const b = z.object({ endpoint: z.string().optional(), id: z.number().int().optional() }).parse(req.body);
    const ok = b.id !== undefined ? await storage.deletePushSubscriptionById(owner.id, b.id) : b.endpoint ? await storage.deletePushSubscription(owner.id, b.endpoint) : false;
    res.json({ ok: true, removed: ok });
  }));
  app.post("/api/owner/push/test", requireOwner, handle(async (_req, res, owner, lang) => {
    const ja = lang === "ja";
    const sent = await sendPush(owner.id, { title: ja ? "通知のテスト" : "Test notification", body: ja ? "この通知が届けば、予約やカード払いのお知らせがスマホに届きます" : "If you got this, booking and payment news will reach this phone", tag: "test" });
    res.json({ ok: true, sent });
  }));
}
