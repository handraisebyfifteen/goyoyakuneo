/**
 * 次回の声かけ。前回の来店から owners.followupAfterDays 日あいたお客さんに、「そろそろいかがですか」のメールを一度だけ送る。
 * - 送るのは：メールがある・配信を止めていない・次の予約がない・前回の来店のあとにまだ送っていない人
 * - メールには配信を止めるリンクを入れる（押すとそのお客さんには二度と送らない）
 * - 自動で回すのは本番だけ（reminders.ts の見回りから呼ぶ）
 */
import type { Express } from "express";
import { randomBytes } from "node:crypto";
import type { Owner, Customer, Language } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import * as storage from "./storage";
import { sendFollowup } from "./email";
import { appBaseUrl } from "./payments";
import { nowLocal } from "./lib/time";

const SEND_FROM = "10:00";

/** 声をかける相手と、前回の来店からの日数 */
export async function dueFollowups(owner: Owner, now = new Date()): Promise<{ customer: Customer; days: number }[]> {
  if (!owner.followupAfterDays) return [];
  const out: { customer: Customer; days: number }[] = [];
  for (const c of await storage.listCustomers(owner.id)) {
    if (!c.email || c.followupOptOut) continue;
    const rows = await storage.listReservationsOfCustomer(owner.id, c.id);
    if (rows.some((r) => r.status === "confirmed" && r.endAt > now)) continue; // 次の予約がある
    const visits = rows.filter((r) => (r.status === "confirmed" || r.status === "completed") && r.endAt <= now);
    const last = visits[visits.length - 1];
    if (!last) continue;
    const days = Math.floor((now.getTime() - last.endAt.getTime()) / 86400000);
    if (days < owner.followupAfterDays) continue;
    if (c.followedUpAt && c.followedUpAt > last.endAt) continue; // この間あきには、もう送った
    out.push({ customer: c, days });
  }
  return out;
}

export async function runFollowups(owner: Owner, now = new Date()): Promise<number> {
  if (!owner.followupAfterDays || nowLocal(owner.timezone, now).time < SEND_FROM) return 0;
  let sent = 0;
  for (const { customer, days } of await dueFollowups(owner, now)) {
    const token = customer.unsubscribeToken ?? randomBytes(18).toString("base64url");
    if (!customer.unsubscribeToken) await storage.updateCustomer(owner.id, customer.id, { unsubscribeToken: token });
    const note = await sendFollowup(owner, customer, days, `${appBaseUrl()}/book/${owner.slug}`, `${appBaseUrl()}/api/public/unsubscribe?token=${token}`);
    if (note === "limit") break;
    if (note === "sent" || note === "logged") { await storage.updateCustomer(owner.id, customer.id, { followedUpAt: now }); sent += 1; }
  }
  return sent;
}

/** 前回伝えたあとに声をかけたお客さんの人数（管理画面を開いたときに伝える） */
export async function followupsSince(owner: Owner, since: Date): Promise<number> {
  return (await storage.listCustomers(owner.id)).filter((c) => c.followedUpAt && c.followedUpAt > since).length;
}

export function registerFollowupRoutes(app: Express) {
  // 配信を止めるリンク。メールから開くので、画面の部品を使わずにそのまま HTML を返す
  app.get("/api/public/unsubscribe", async (req, res) => {
    const token = String(req.query.token ?? "");
    const c = /^[A-Za-z0-9_-]{20,}$/.test(token) ? await storage.getCustomerByUnsubscribe(token) : undefined;
    const owner = c ? await storage.getOwner(c.ownerId) : undefined;
    const lang: Language = normalizeLang(owner?.language ?? req.query.lang);
    const ja = lang === "ja";
    if (c && owner) await storage.updateCustomer(owner.id, c.id, { followupOptOut: true });
    const shop = owner ? storage.shopName(owner, lang) : "";
    const msg = c ? (ja ? `${shop}からのご案内メールを止めました。ご予約の確認や前日のお知らせは、これまでどおりお送りします。` : `You will no longer receive suggestion emails from ${shop}. Booking confirmations and reminders will still be sent.`)
      : (ja ? "リンクが正しくありません。" : "This link is not valid.");
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    res.type("html").send(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(shop || "GoYoyaku")}</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.7"><h1 style="font-size:1.3rem">${esc(shop)}</h1><p role="status">${esc(msg)}</p></body></html>`);
  });
}
