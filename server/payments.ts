/**
 * 支払い（Stripe Checkout、テストモードのみ）。
 * - カード情報はこのアプリを一切通らない（Stripe の画面で入力する）
 * - 本番用のキー（sk_live_ / pk_live_）が入っていたら起動時に止める
 * - キーがないときは https://example.com/pay/{予約ID} の仮リンクで一周できる
 * - 支払い済みへの反映は Webhook（checkout.session.completed）と、戻り先ページからの照会の両方で行う
 * - 返金はこのアプリでは行わない（オーナーが Stripe で行う）
 */
import Stripe from "stripe";
import type { Owner, Reservation } from "@shared/schema";
import { cancelPolicyText, normalizeLang } from "@shared/i18n";
import * as storage from "./storage";
import { toLocal } from "./lib/time";

export function assertStripeTestKeys() {
  const sk = process.env.STRIPE_SECRET_KEY;
  const pk = process.env.VITE_STRIPE_PUBLISHABLE_KEY;
  if (sk && !sk.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a TEST key (sk_test_...). Refusing to start with a live key.");
  if (pk && !pk.startsWith("pk_test_")) throw new Error("VITE_STRIPE_PUBLISHABLE_KEY must be a TEST key (pk_test_...). Refusing to start with a live key.");
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

let _stripe: Stripe | null = null;
export function stripe(): Stripe {
  assertStripeTestKeys();
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe is not configured");
  if (!_stripe) _stripe = new Stripe(key, { timeout: 20_000 });
  return _stripe;
}

/** 戻り先の URL のもと。Replit の開発ドメイン → APP_BASE_URL → localhost の順 */
export function appBaseUrl(): string {
  const env = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (env) return env;
  const dom = (process.env.REPLIT_DOMAINS ?? process.env.REPLIT_DEV_DOMAIN ?? "").split(",")[0].trim();
  if (dom) return `https://${dom}`;
  return `http://localhost:${process.env.PORT || 5000}`;
}

export type PaymentLink = { url: string; sessionId: string | null; placeholder: boolean };

export async function createPaymentLink(owner: Owner, reservation: Reservation): Promise<PaymentLink> {
  assertStripeTestKeys();
  if (!stripeConfigured()) {
    return { url: `https://example.com/pay/${reservation.id}`, sessionId: null, placeholder: true };
  }
  const lang = normalizeLang(owner.language);
  const customer = await storage.getReservation(owner.id, reservation.id);
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  const menuName = lang === "ja" ? reservation.menuNameJa || reservation.menuNameEn : reservation.menuNameEn || reservation.menuNameJa;
  const when = toLocal(reservation.startAt, owner.timezone);
  const base = appBaseUrl();
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: reservation.currency.toLowerCase(),
        unit_amount: reservation.price, // 最小単位の整数（円なら円、ドルならセント）。Stripe の決まりと同じ
        product_data: { name: `${shop} ${menuName} (${when.date} ${when.time})` },
      },
    }],
    customer_email: customer?.customer.email || undefined,
    success_url: `${base}/pay/result?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pay/result?status=cancel&r=${reservation.number}`,
    metadata: { reservation_id: String(reservation.id), owner_id: String(owner.id) },
    custom_text: { submit: { message: cancelPolicyText(owner.freeCancelHoursBefore, lang).slice(0, 1200) } },
    locale: lang === "ja" ? "ja" : "en",
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24時間で期限切れ
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url, sessionId: session.id, placeholder: false };
}

/** 支払い済みにする（二度呼ばれても壊れない）。見つからなければ null */
export async function markCardPaid(sessionId: string, paymentIntentId?: string | null): Promise<Reservation | null> {
  const r = await storage.getReservationByStripeSession(sessionId);
  if (!r) return null;
  if (r.paymentStatus === "paid") return r;
  if (r.paymentMethod !== "card" || r.paymentStatus !== "unpaid") return r;
  const updated = await storage.updateReservation(r.ownerId, r.id, {
    paymentStatus: "paid", amountReceived: r.price, stripePaymentIntentId: paymentIntentId ?? r.stripePaymentIntentId,
  });
  return updated ?? r;
}

/** Webhook（checkout.session.completed）。署名を確かめてから支払い済みにする */
export async function handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ received: boolean; type?: string }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  if (!signature) throw new Error("missing stripe-signature header");
  const event = stripe().webhooks.constructEvent(rawBody, signature, secret);
  // 月額の請求（定期課金）の知らせは billing.ts で受ける
  const { handleBillingEvent } = await import("./billing");
  await handleBillingEvent(event);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "subscription" && session.payment_status === "paid") {
      await markCardPaid(session.id, typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null);
    }
  }
  return { received: true, type: event.type };
}

/** 戻り先ページからの照会：Stripe に直接聞いて、支払い済みなら反映する（Webhook が届かない開発環境の保険） */
export async function confirmSession(sessionId: string): Promise<{ paid: boolean; reservation: Reservation | null }> {
  if (!stripeConfigured()) return { paid: false, reservation: null };
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const paid = session.payment_status === "paid";
  const reservation = paid
    ? await markCardPaid(session.id, typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null)
    : await storage.getReservationByStripeSession(session.id) ?? null;
  return { paid, reservation };
}
