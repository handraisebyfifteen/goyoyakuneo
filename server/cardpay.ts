/**
 * カード払いの入金先（Stripe Connect）と、払われなかった予約の後始末。
 * - お店ごとに自分の Stripe アカウントを持ってもらう（Standard）。支払いはお店のアカウントで直接受けるので、お金はご予約ちゃんを通らない
 * - 本人確認や口座の登録は Stripe の画面で行う。ここでは状態（まだ／途中／確認中／使える／止まっている）だけを持つ
 * - 入金と返金の確認は、お店が Stripe の管理画面で行う
 * - ネットから入ったカード払いの予約は、30分たっても払われなければ取り消して枠を戻す（いたずらの予約で枠をふさがれないように）
 */
import type { Express, Request, Response } from "express";
import type Stripe from "stripe";
import { z } from "zod";
import type { Owner, Language } from "@shared/schema";
import { DEFAULT_NOTICE } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import * as storage from "./storage";
import { requireOwner, requireRegistered, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { stripe, stripeConfigured, appBaseUrl, onShop, markCardPaid, retrieveSession, CARD_HOLD_MINUTES } from "./payments";
import { cancelReservationFor } from "./services";
import { sendHoldExpired, sendPaymentNotice, sendOwnerNotice } from "./email";
import { notifyReservation } from "./push";

/**
 * off：Stripe の設定がない（開発中。仮のリンクで一周できる）
 * unregistered：お店の登録がまだ。none：入金先がまだ。incomplete：登録の途中。reviewing：Stripe が確認中
 * ready：カード払いを受けられる。restricted：Stripe から追加の情報を求められていて、止まっている
 */
export type CardState = "off" | "unregistered" | "none" | "incomplete" | "reviewing" | "ready" | "restricted";

export function stateOf(a: Pick<Stripe.Account, "charges_enabled" | "details_submitted" | "requirements">): CardState {
  if (a.charges_enabled) return "ready";
  if (!a.details_submitted) return "incomplete";
  const due = (a.requirements?.currently_due?.length ?? 0) + (a.requirements?.past_due?.length ?? 0);
  return due ? "restricted" : "reviewing";
}

/** Stripe のアカウントの状態をお店に写す。初めて使えるようになったら、オーナーにメールで知らせる */
async function syncAccount(owner: Owner, a: Stripe.Account): Promise<Owner> {
  const ready = !!a.charges_enabled;
  if (ready === owner.cardReady) return owner;
  const updated = await storage.updateOwner(owner.id, { cardReady: ready });
  const ja = owner.language !== "en";
  await sendOwnerNotice(updated, ready ? (ja ? "カード払いが使えるようになりました" : "Card payment is now on") : (ja ? "カード払いが止まっています" : "Card payment is paused"),
    ready
      ? (ja ? "Stripe の確認が終わり、予約ページでお客さんがカードで前払いできるようになりました。" : "Stripe has finished checking. Customers can now pay by card on your booking page.")
      : (ja ? "Stripe から追加の情報を求められているため、カード払いを止めています。管理画面の「カード払い」から続きを入力してください。" : "Stripe needs more information, so card payment is paused. Continue from \"Card payment\" in the admin page."),
    ja ? "管理画面の「カード払い」で状態を確認できます。" : "See \"Card payment\" in the admin page.").catch((e) => console.error("[email]", e));
  return updated;
}

export async function cardStatus(owner: Owner): Promise<{ state: CardState; due: number; owner: Owner }> {
  if (!owner.email) return { state: "unregistered", due: 0, owner };
  if (!stripeConfigured()) return { state: "off", due: 0, owner };
  if (!owner.stripeAccountId) return { state: "none", due: 0, owner };
  const a = await stripe().accounts.retrieve(owner.stripeAccountId);
  const due = (a.requirements?.currently_due?.length ?? 0) + (a.requirements?.past_due?.length ?? 0);
  return { state: stateOf(a), due, owner: await syncAccount(owner, a) };
}

/** 入金先の登録を始める・続ける。アカウントがなければ作り、Stripe の登録画面の URL を返す */
async function onboardingUrl(owner: Owner): Promise<string> {
  let id = owner.stripeAccountId;
  if (!id) {
    const lang = normalizeLang(owner.language);
    const a = await stripe().accounts.create({
      type: "standard", country: owner.country, email: owner.email ?? undefined, default_currency: owner.currency.toLowerCase(),
      // ホームページのないお店も多いので、予約ページを入れておく（Stripe の画面で変えられる）
      business_profile: { name: storage.shopName(owner, lang) || undefined, url: `${appBaseUrl()}/book/${owner.slug}` },
      metadata: { owner_id: String(owner.id) },
    });
    id = a.id;
    await storage.updateOwner(owner.id, { stripeAccountId: id });
  }
  const base = appBaseUrl();
  const link = await stripe().accountLinks.create({
    account: id, type: "account_onboarding",
    return_url: `${base}/admin?cardpay=return`, refresh_url: `${base}/admin?cardpay=refresh`,
  });
  return link.url;
}

// ---------- 払われなかった予約の後始末 ----------

const SWEEP_MS = 60 * 1000;
// Stripe の画面の期限（31分）が切れてから確かめる
const STALE_MS = (CARD_HOLD_MINUTES + 2) * 60 * 1000;

/** 払われなかった予約を取り消して、お客さんとオーナーに知らせる。もう取り消し済み・支払い済みなら何もしない */
async function releaseHold(owner: Owner, reservationId: number): Promise<boolean> {
  const row = await storage.getReservation(owner.id, reservationId);
  if (!row || row.status !== "confirmed" || row.paymentStatus !== "unpaid" || row.source !== "web") return false;
  const lang: Language = normalizeLang(owner.language);
  await cancelReservationFor(owner, row, lang, "unpaid");
  const after = (await storage.getReservation(owner.id, row.id)) ?? row;
  notifyReservation(owner, after, "expired");
  await sendHoldExpired(owner, after, `${appBaseUrl()}/book/${owner.slug}`).catch((e) => console.error("[email]", e));
  if ((owner.noticePrefs ?? DEFAULT_NOTICE).paymentEmail ?? true) await sendPaymentNotice(owner, after, "expired").catch((e) => console.error("[email]", e));
  return true;
}

/** 1件を確かめる：払われていたら支払い済みに、まだ開いている画面は閉じてから取り消す */
async function settleHold(row: storage.ReservationRow & { owner: Owner }): Promise<"paid" | "released" | "skipped"> {
  if (row.stripeSessionId && stripeConfigured()) {
    let s = await retrieveSession(row.owner, row.stripeSessionId);
    // 閉じる前に払われることがある。そのときは閉じられないので、聞き直して支払い済みにする
    if (s.status === "open") {
      try { s = await stripe().checkout.sessions.expire(row.stripeSessionId, {}, onShop(row.owner)); }
      catch { s = await retrieveSession(row.owner, row.stripeSessionId); }
    }
    if (s.payment_status === "paid") { await markCardPaid(s.id, typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null); return "paid"; }
    if (s.status !== "expired") return "skipped";
  }
  return (await releaseHold(row.owner, row.id)) ? "released" : "skipped";
}

/** 1回分の見回り。取り消した件数を返す */
export async function sweepCardHolds(now: Date = new Date()): Promise<number> {
  let released = 0;
  for (const row of await storage.listStaleCardHolds(new Date(now.getTime() - STALE_MS))) {
    try { if ((await settleHold(row)) === "released") released += 1; }
    catch (e) { console.error("[card_hold]", row.id, e instanceof Error ? e.message : e); }
  }
  return released;
}

/** 自動で回すのは本番だけ（開発中にお客さんへ本物のメールを送らないため）。REMINDERS=on なら開発でも回る */
export function startCardHoldSweeper() {
  if (process.env.NODE_ENV !== "production" && process.env.REMINDERS !== "on") return;
  const tick = () => sweepCardHolds().then((n) => { if (n) console.log(`[card_hold] released ${n}`); }).catch((e) => console.error("[card_hold]", e));
  setTimeout(tick, 20_000);
  setInterval(tick, SWEEP_MS);
}

/** Webhook のうち、お店のアカウントの状態と、支払いの画面の期限切れ */
export async function handleCardPayEvent(event: Stripe.Event) {
  if (event.type === "account.updated") {
    const a = event.data.object as Stripe.Account;
    const owner = await storage.getOwnerByStripeAccount(a.id);
    if (owner) await syncAccount(owner, a);
    return;
  }
  if (event.type === "checkout.session.expired") {
    const s = event.data.object as Stripe.Checkout.Session;
    const r = await storage.getReservationByStripeSession(s.id);
    const owner = r ? await storage.getOwner(r.ownerId) : undefined;
    if (r && owner) await releaseHold(owner, r.id);
  }
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

export function registerCardPayRoutes(app: Express) {
  app.get("/api/owner/cardpay", requireOwner, handle(async (_req, res, owner) => {
    const s = await cardStatus(owner);
    const o = s.owner;
    const test = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
    res.json({
      ok: true, state: s.state, due: s.due, holdMinutes: CARD_HOLD_MINUTES,
      allowCardPayment: o.allowCardPayment, cardMinHoursBefore: o.cardMinHoursBefore, minHoursBefore: o.minHoursBefore,
      paymentEmail: (o.noticePrefs ?? DEFAULT_NOTICE).paymentEmail ?? true,
      dashboardUrl: o.stripeAccountId ? `https://dashboard.stripe.com/${test ? "test/" : ""}payments` : null,
    });
  }));
  app.post("/api/owner/cardpay/start", requireOwner, requireRegistered, handle(async (_req, res, owner) => {
    if (!stripeConfigured()) throw new ApiError("card_not_ready");
    res.json({ ok: true, url: await onboardingUrl(owner) });
  }));
}
