/**
 * 月額の請求（Stripe の定期課金、テストモード）。基本料金 ＋ ログインできるスタッフの人数分。
 * - 料金そのものは Stripe の「価格」で決める（STRIPE_PRICE_BASE：基本料金、STRIPE_PRICE_SEAT：スタッフ1人あたり）。アプリに金額は書かない
 * - 設定がなければ「準備中」として人数だけ見せる。請求していなくても、アプリの機能は止めない
 * - スタッフの人数が変わったら、契約中の請求の人数も合わせる（Stripe が日割りで調整する）
 * - カードの変更や解約は Stripe の画面（カスタマーポータル）で行う
 */
import type { Express, Request, Response } from "express";
import type Stripe from "stripe";
import type { Owner, Language } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import { money } from "@shared/money";
import * as storage from "./storage";
import { requireOwner, requireRegistered, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { stripe, stripeConfigured, appBaseUrl } from "./payments";
import { seatsFor } from "./staff";

const BASE = () => process.env.STRIPE_PRICE_BASE ?? "";
const SEAT = () => process.env.STRIPE_PRICE_SEAT ?? "";
export const billingConfigured = () => stripeConfigured() && !!BASE();
const LIVE = new Set(["active", "trialing", "past_due"]);

const priceCache = new Map<string, { at: number; price: Stripe.Price }>();
async function price(id: string): Promise<Stripe.Price | null> {
  if (!id) return null;
  const hit = priceCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.price;
  const p = await stripe().prices.retrieve(id);
  priceCache.set(id, { at: Date.now(), price: p });
  return p;
}

/** 今の契約と、今の人数での月額の目安 */
export async function billingStatus(owner: Owner, lang: Language) {
  const { seats, staffSeats } = await seatsFor(owner.id);
  if (!billingConfigured()) return { configured: false, status: owner.subscriptionStatus, seats, staffSeats, base: null, perSeat: null, estimate: null };
  const [b, s] = await Promise.all([price(BASE()), price(SEAT())]);
  const cur = (b?.currency ?? "jpy").toUpperCase();
  const baseAmt = b?.unit_amount ?? 0, seatAmt = s?.unit_amount ?? 0;
  return {
    configured: true, status: owner.subscriptionStatus, seats, staffSeats,
    base: money(baseAmt, cur, lang), perSeat: s ? money(seatAmt, cur, lang) : null, estimate: money(baseAmt + seatAmt * staffSeats, cur, lang),
  };
}

async function ensureCustomer(owner: Owner): Promise<string> {
  if (owner.stripeCustomerId) return owner.stripeCustomerId;
  const c = await stripe().customers.create({ email: owner.email ?? undefined, name: storage.shopName(owner, "ja") || undefined, metadata: { owner_id: String(owner.id) } });
  await storage.updateOwner(owner.id, { stripeCustomerId: c.id });
  return c.id;
}

/** 契約の手続き（Stripe の支払い画面の URL） */
export async function startSubscription(owner: Owner): Promise<string> {
  if (!billingConfigured()) throw new ApiError("billing_not_ready", 503);
  if (owner.subscriptionStatus && LIVE.has(owner.subscriptionStatus)) throw new ApiError("already_subscribed", 409);
  const customer = await ensureCustomer(owner);
  const { staffSeats } = await seatsFor(owner.id);
  const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: BASE(), quantity: 1 }];
  if (SEAT() && staffSeats > 0) items.push({ price: SEAT(), quantity: staffSeats });
  const base = appBaseUrl();
  const session = await stripe().checkout.sessions.create({
    mode: "subscription", customer, line_items: items,
    success_url: `${base}/admin?billing=success`, cancel_url: `${base}/admin?billing=cancel`,
    metadata: { owner_id: String(owner.id) }, subscription_data: { metadata: { owner_id: String(owner.id) } },
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

/** カードの変更・解約の画面（Stripe のカスタマーポータル） */
export async function portalUrl(owner: Owner): Promise<string> {
  if (!billingConfigured() || !owner.stripeCustomerId) throw new ApiError("billing_not_ready", 503);
  const s = await stripe().billingPortal.sessions.create({ customer: owner.stripeCustomerId, return_url: `${appBaseUrl()}/admin` });
  return s.url;
}

/** Stripe の契約の状態を、オーナーに写す */
async function applySubscription(ownerId: number, sub: Stripe.Subscription) {
  const seatItem = sub.items.data.find((i) => i.price.id === SEAT());
  await storage.updateOwner(ownerId, { subscriptionId: sub.id, subscriptionStatus: sub.status, subscriptionSeats: seatItem?.quantity ?? 0 });
}

/** 戻ってきたときや画面を開いたときに、Stripe に直接聞いて写す（Webhook が届かない開発環境の保険） */
export async function refreshSubscription(owner: Owner): Promise<Owner> {
  if (!billingConfigured() || !owner.stripeCustomerId) return owner;
  const list = await stripe().subscriptions.list({ customer: owner.stripeCustomerId, status: "all", limit: 1 });
  if (list.data[0]) await applySubscription(owner.id, list.data[0]);
  return (await storage.getOwner(owner.id)) ?? owner;
}

/** スタッフの人数が変わったら、契約中の請求の人数を合わせる（失敗しても止めない。ログに残す） */
export async function syncSeats(ownerId: number) {
  try {
    const owner = await storage.getOwner(ownerId);
    if (!owner || !billingConfigured() || !SEAT() || !owner.subscriptionId || !owner.subscriptionStatus || !LIVE.has(owner.subscriptionStatus)) return;
    const { staffSeats } = await seatsFor(owner.id);
    if (staffSeats === owner.subscriptionSeats) return;
    const sub = await stripe().subscriptions.retrieve(owner.subscriptionId);
    const item = sub.items.data.find((i) => i.price.id === SEAT());
    const items: Stripe.SubscriptionUpdateParams.Item[] = item
      ? [staffSeats > 0 ? { id: item.id, quantity: staffSeats } : { id: item.id, deleted: true }]
      : staffSeats > 0 ? [{ price: SEAT(), quantity: staffSeats }] : [];
    if (!items.length) return;
    await applySubscription(owner.id, await stripe().subscriptions.update(sub.id, { items }));
  } catch (e) {
    console.error("[billing_seats]", e);
  }
}

/** Webhook のうち、定期課金の分（payments.ts の handleWebhook から呼ぶ） */
export async function handleBillingEvent(event: Stripe.Event) {
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.mode !== "subscription" || !s.subscription) return;
    const ownerId = Number(s.metadata?.owner_id);
    if (ownerId) await applySubscription(ownerId, await stripe().subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id));
  }
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const ownerId = Number(sub.metadata?.owner_id);
    if (ownerId) await applySubscription(ownerId, sub);
  }
}

function handle(fn: (req: Request, res: Response, owner: Owner, lang: Language) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(req.query.lang ?? owner.language);
    try { await fn(req, res, owner, lang); }
    catch (e) { sendError(res, lang, e); }
  };
}

export function registerBillingRoutes(app: Express) {
  app.get("/api/owner/billing", requireOwner, handle(async (req, res, owner, lang) => {
    const fresh = req.query.refresh === "1" ? await refreshSubscription(owner) : owner;
    res.json({ ok: true, ...(await billingStatus(fresh, lang)) });
  }));
  app.post("/api/owner/billing/checkout", requireOwner, requireRegistered, handle(async (_req, res, owner) => {
    res.json({ ok: true, url: await startSubscription(owner) });
  }));
  app.post("/api/owner/billing/portal", requireOwner, requireRegistered, handle(async (_req, res, owner) => {
    res.json({ ok: true, url: await portalUrl(owner) });
  }));
}
