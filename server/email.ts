/**
 * お客さんへの予約確認メール（Resend）。
 * - 日英はオーナーの言語設定に合わせる
 * - 1日の送信数に上限（EMAIL_DAILY_LIMIT、初期値 20）
 * - キーがないときは送らず、サーバーのログに中身を出す
 * - 支払い完了の領収書は Stripe に任せる（ここでは送らない）
 */
import type { Owner } from "@shared/schema";
import { cancelPolicyText, normalizeLang, WEEKDAY_LABELS } from "@shared/i18n";
import { WEEKDAY_KEYS } from "@shared/schema";
import * as storage from "./storage";
import { nowLocal, weekdayOf } from "./lib/time";

export type EmailNote = "sent" | "logged" | "limit" | "failed" | "no_email";

const TEXT = {
  ja: {
    subject: (shop: string, date: string, time: string) => `【${shop}】ご予約を承りました（${date} ${time}）`,
    hello: (name: string) => `${name} 様`,
    intro: "ご予約ありがとうございます。以下の内容で承りました。",
    when: "日時", duration: "所要時間", menu: "メニュー", price: "料金", pay: "お支払い",
    card: "カード（事前のお支払い）", onsite: "当日、店舗でのお支払い",
    link: "お支払いはこちらから", where: "場所", phone: "お電話", info: "ご案内", cancel: "キャンセルについて",
    number: "予約番号", keep: "予約の確認や取り消しには、この番号とお電話番号が必要です。",
    minutes: (n: number) => `${n}分`,
  },
  en: {
    subject: (shop: string, date: string, time: string) => `[${shop}] Your booking is confirmed (${date} ${time})`,
    hello: (name: string) => `Dear ${name},`,
    intro: "Thank you for your booking. Here are the details.",
    when: "Date and time", duration: "Duration", menu: "Service", price: "Price", pay: "Payment",
    card: "Card (pay in advance)", onsite: "Pay at the shop",
    link: "Pay here", where: "Address", phone: "Phone", info: "Notes", cancel: "Cancellation policy",
    number: "Booking number", keep: "You need this number and your phone number to look up or cancel the booking.",
    minutes: (n: number) => `${n} min`,
  },
};

export function composeConfirmation(owner: Owner, r: storage.ReservationRow): { subject: string; text: string } {
  const lang = normalizeLang(owner.language);
  const t = TEXT[lang];
  const v = storage.reservationView(r, owner.timezone, lang);
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  const weekday = WEEKDAY_LABELS[lang][WEEKDAY_KEYS.indexOf(weekdayOf(v.date))];
  const lines = [
    t.hello(v.customerName), "",
    t.intro, "",
    `${t.when}: ${v.date} (${weekday}) ${v.time}`,
    `${t.duration}: ${t.minutes(v.minutes)}`,
    `${t.menu}: ${v.menuName}`,
    `${t.price}: ${v.price.display}`,
    `${t.pay}: ${v.paymentMethod === "card" ? t.card : t.onsite}`,
  ];
  if (v.paymentMethod === "card" && v.paymentUrl) lines.push(`${t.link}: ${v.paymentUrl}`);
  lines.push("", `${t.number}: ${v.number}`, t.keep, "");
  if (owner.address) lines.push(`${t.where}: ${owner.address}`);
  if (owner.phone) lines.push(`${t.phone}: ${owner.phone}`);
  if (owner.info) lines.push(`${t.info}: ${owner.info}`);
  lines.push("", `${t.cancel}: ${cancelPolicyText(owner.freeCancelHoursBefore, lang)}`, "", shop);
  return { subject: t.subject(shop, v.date, v.time), text: lines.join("\n") };
}

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM;
}

export function dailyLimit(): number {
  const n = Number.parseInt(process.env.EMAIL_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

/** 予約確認メールを送る。結果は短い記号で返す（本文に失敗の詳細は入れない。詳細はログへ） */
export async function sendBookingConfirmation(owner: Owner, r: storage.ReservationRow): Promise<EmailNote> {
  const to = r.customer.email;
  if (!to) return "no_email";
  const { subject, text } = composeConfirmation(owner, r);
  if (!emailConfigured()) {
    console.log(`\n--- 確認メール（送信の設定がないため表示のみ）---\n宛先: ${to}\n件名: ${subject}\n\n${text}\n---\n`);
    return "logged";
  }
  const today = nowLocal(owner.timezone).date;
  if (!(await storage.takeEmailQuota(owner.id, today, dailyLimit()))) {
    console.warn(`[email_limit] owner=${owner.id} date=${today}`);
    return "limit";
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[email_failed] status=${res.status} body=${(await res.text()).slice(0, 300)}`);
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error("[email_failed]", e);
    return "failed";
  }
}
