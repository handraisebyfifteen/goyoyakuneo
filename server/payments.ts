/**
 * 支払い（Stripe Checkout、テストモードのみ）。
 * - カード情報はこのアプリを一切通らない（Stripe の画面で入力する）
 * - 支払いはお店の Stripe アカウントで直接受ける（Stripe Connect のダイレクト支払い）。お金はご予約ちゃんを通らない。
 *   入金先を登録していないお店は、カード払いを使えない（cardpay.ts）
 * - ネットからの予約は、支払いの画面の期限を約30分にする。払われなければ予約を取り消して枠を戻す（cardpay.ts）
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
import { ApiError } from "./errors";
import { sendPaymentNotice } from "./email";
import { notifyReservation } from "./push";

/** ネットのカード払いの予約を、払われるまで押さえておく時間（分）。お客さんにはこの分数で伝える */
export const CARD_HOLD_MINUTES = 30;

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

/** お店のアカウントで支払いを受けるための指定（入金先を登録していなければ undefined） */
export function onShop(owner: Pick<Owner, "stripeAccountId">): Stripe.RequestOptions | undefined {
  return owner.stripeAccountId ? { stripeAccount: owner.stripeAccountId } : undefined;
}

/** カード払いを受けられるか。Stripe の設定がない開発環境では、仮のリンクで一周できるよう受ける */
export function cardPayable(owner: Pick<Owner, "stripeAccountId" | "cardReady">): boolean {
  return !stripeConfigured() || (!!owner.stripeAccountId && owner.cardReady);
}

export async function createPaymentLink(owner: Owner, reservation: Reservation): Promise<PaymentLink> {
  assertStripeTestKeys();
  if (!stripeConfigured()) {
    return { url: `https://example.com/pay/${reservation.id}`, sessionId: null, placeholder: true };
  }
  if (!cardPayable(owner)) throw new ApiError("card_not_ready");
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
    // ネットの予約は約30分（Stripe の最短）で期限切れ。オーナーが入れた予約は、電話で伝えたりするので24時間
    expires_at: Math.floor(Date.now() / 1000) + (reservation.source === "web" ? (CARD_HOLD_MINUTES + 1) * 60 : 60 * 60 * 24),
  }, onShop(owner));
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url, sessionId: session.id, placeholder: false };
}

/** 支払い済みにする（二度呼ばれても壊れない）。見つからなければ null。初めて支払い済みにしたときは、オーナーにメールでも知らせる */
export async function markCardPaid(sessionId: string, paymentIntentId?: string | null): Promise<Reservation | null> {
  const r = await storage.getReservationByStripeSession(sessionId);
  if (!r) return null;
  if (r.paymentStatus === "paid") return r;
  if (r.paymentMethod !== "card" || r.paymentStatus !== "unpaid") return r;
  const updated = await storage.updateReservation(r.ownerId, r.id, {
    paymentStatus: "paid", amountReceived: r.price, paidAt: new Date(), stripePaymentIntentId: paymentIntentId ?? r.stripePaymentIntentId,
  });
  const owner = await storage.getOwner(r.ownerId);
  if (owner && updated) {
    notifyReservation(owner, updated, "paid");
    if (owner.noticePrefs?.paymentEmail ?? true) await sendPaymentNotice(owner, updated, "paid").catch((e) => console.error("[email]", e));
  }
  return updated ?? r;
}

const intentId = (s: Stripe.Checkout.Session) => (typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null);

/** 署名を確かめる。お店のアカウントで起きた知らせ（Connect）は、別の署名の鍵で届く */
function verify(rawBody: Buffer, signature: string): Stripe.Event {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter((x): x is string => !!x);
  if (!secrets.length) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  let last: unknown;
  for (const secret of secrets) {
    try { return stripe().webhooks.constructEvent(rawBody, signature, secret); } catch (e) { last = e; }
  }
  throw last;
}

/** Webhook。署名を確かめてから、支払い済み・期限切れ・お店のアカウントの状態を反映する */
export async function handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ received: boolean; type?: string }> {
  if (!signature) throw new Error("missing stripe-signature header");
  const event = verify(rawBody, signature);
  // 月額の請求（定期課金）の知らせは billing.ts、お店のアカウントと期限切れは cardpay.ts で受ける
  const { handleBillingEvent } = await import("./billing");
  await handleBillingEvent(event);
  const { handleCardPayEvent } = await import("./cardpay");
  await handleCardPayEvent(event);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "subscription" && session.payment_status === "paid") await markCardPaid(session.id, intentId(session));
  }
  return { received: true, type: event.type };
}

/** 支払いの画面の今の状態を Stripe に聞く（お店のアカウントで作ったものは、お店のアカウントに聞く） */
export async function retrieveSession(owner: Pick<Owner, "stripeAccountId">, sessionId: string): Promise<Stripe.Checkout.Session> {
  return stripe().checkout.sessions.retrieve(sessionId, {}, onShop(owner));
}

/** 戻り先ページからの照会：Stripe に直接聞いて、支払い済みなら反映する（Webhook が届かない開発環境の保険） */
export async function confirmSession(sessionId: string): Promise<{ paid: boolean; reservation: Reservation | null }> {
  if (!stripeConfigured()) return { paid: false, reservation: null };
  const found = await storage.getReservationByStripeSession(sessionId);
  const owner = found ? await storage.getOwner(found.ownerId) : undefined;
  if (!found || !owner) return { paid: false, reservation: null };
  const session = await retrieveSession(owner, sessionId);
  const paid = session.payment_status === "paid";
  const reservation = paid ? await markCardPaid(session.id, intentId(session)) : found;
  return { paid, reservation };
}
