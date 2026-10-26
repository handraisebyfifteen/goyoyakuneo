/**
 * お客さんへの予約確認メール、前日のお知らせメール、来店のお礼メール（Resend）。
 * - 日英はオーナーの言語設定に合わせる
 * - 1日の送信数に上限（EMAIL_DAILY_LIMIT、初期値 20）
 * - キーがないときは送らず、サーバーのログに中身を出す
 * - 支払い完了の領収書は Stripe に任せる（ここでは送らない）
 */
import type { Owner, Customer, CustomerTicket } from "@shared/schema";
import { cancelPolicyText, normalizeLang, WEEKDAY_LABELS } from "@shared/i18n";
import { WEEKDAY_KEYS } from "@shared/schema";
import * as storage from "./storage";
import { nowLocal, weekdayOf } from "./lib/time";

/** unregistered: お店を登録する前は、だれにもメールを送らない（名前のないお店からのメールにしないため） */
export type EmailNote = "sent" | "logged" | "limit" | "failed" | "no_email" | "unregistered";

const TEXT = {
  ja: {
    subject: (shop: string, date: string, time: string) => `【${shop}】ご予約を承りました（${date} ${time}）`,
    hello: (name: string) => `${name} 様`,
    intro: "ご予約ありがとうございます。以下の内容で承りました。",
    when: "日時", duration: "所要時間", menu: "メニュー", price: "料金", pay: "お支払い",
    card: "カード（事前のお支払い）", onsite: "当日、店舗でのお支払い",
    link: "お支払いはこちらから", hold: "30分以内にお支払いがない場合、ご予約は自動で取り消しとなります。", where: "場所", phone: "お電話", info: "ご案内", cancel: "キャンセルについて",
    number: "予約番号", keep: "予約の確認や取り消しには、この番号とお電話番号が必要です。",
    minutes: (n: number) => `${n}分`,
    remindSubject: (shop: string, date: string, time: string) => `【${shop}】明日のご予約のお知らせ（${date} ${time}）`,
    remindIntro: "明日のご予約のお知らせです。お気をつけてお越しください。",
    remindChange: "ご都合が悪くなったときは、予約番号とお電話番号で取り消しができます。お早めにご連絡ください。",
    thanksSubject: (shop: string) => `【${shop}】ご来店ありがとうございました`,
    thanks: (name: string) => [`${name} 様`, "", "このたびはご来店いただき、ありがとうございました。", "よろしければ、ご感想をお聞かせください。今後の励みになります。"],
    review: "口コミはこちらから",
    again: "またのご予約をお待ちしております",
  },
  en: {
    subject: (shop: string, date: string, time: string) => `[${shop}] Your booking is confirmed (${date} ${time})`,
    hello: (name: string) => `Dear ${name},`,
    intro: "Thank you for your booking. Here are the details.",
    when: "Date and time", duration: "Duration", menu: "Service", price: "Price", pay: "Payment",
    card: "Card (pay in advance)", onsite: "Pay at the shop",
    link: "Pay here", hold: "If payment is not completed within 30 minutes, the booking is cancelled automatically.", where: "Address", phone: "Phone", info: "Notes", cancel: "Cancellation policy",
    number: "Booking number", keep: "You need this number and your phone number to look up or cancel the booking.",
    minutes: (n: number) => `${n} min`,
    remindSubject: (shop: string, date: string, time: string) => `[${shop}] Reminder: your booking tomorrow (${date} ${time})`,
    remindIntro: "This is a reminder of your booking tomorrow. We look forward to seeing you.",
    remindChange: "If you can no longer make it, you can cancel with your booking number and phone number. Please let us know as early as possible.",
    thanksSubject: (shop: string) => `[${shop}] Thank you for visiting`,
    thanks: (name: string) => [`Dear ${name},`, "", "Thank you for visiting us.", "If you have a moment, we would love to hear what you thought."],
    review: "Leave a review",
    again: "Book again",
  },
};

export function composeConfirmation(owner: Owner, r: storage.ReservationRow): { subject: string; text: string } {
  return compose(owner, r, "confirm");
}

/** 前日のお知らせ。確認メールと同じ中身に、取り消しの案内を添える */
export function composeReminder(owner: Owner, r: storage.ReservationRow): { subject: string; text: string } {
  return compose(owner, r, "remind");
}

function compose(owner: Owner, r: storage.ReservationRow, kind: "confirm" | "remind"): { subject: string; text: string } {
  const lang = normalizeLang(owner.language);
  const t = TEXT[lang];
  const v = storage.reservationView(r, owner.timezone, lang);
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  const weekday = WEEKDAY_LABELS[lang][WEEKDAY_KEYS.indexOf(weekdayOf(v.date))];
  const lines = [
    t.hello(v.customerName), "",
    kind === "remind" ? t.remindIntro : t.intro, "",
    `${t.when}: ${v.date} (${weekday}) ${v.time}`,
    `${t.duration}: ${t.minutes(v.minutes)}`,
    // メニューなしの予約は、メニューと料金の行を出さない
    ...(v.menuName ? [`${t.menu}: ${v.menuName}`] : []),
    ...(v.price ? [`${t.price}: ${v.price.display}${v.couponCode && v.discount ? (lang === "ja" ? `（クーポン ${v.couponCode} で ${v.discount.display} 引き）` : ` (coupon ${v.couponCode}: ${v.discount.display} off)`) : ""}`] : []),
    `${t.pay}: ${v.paymentMethod === "card" ? t.card : t.onsite}`,
  ];
  if (v.paymentMethod === "card" && v.paymentUrl && v.paymentStatus === "unpaid") {
    lines.push(`${t.link}: ${v.paymentUrl}`);
    if (kind === "confirm" && r.source === "web") lines.push(t.hold);
  }
  lines.push("", `${t.number}: ${v.number}`, kind === "remind" ? t.remindChange : t.keep, "");
  if (owner.address) lines.push(`${t.where}: ${owner.address}`);
  if (owner.phone) lines.push(`${t.phone}: ${owner.phone}`);
  if (owner.info) lines.push(`${t.info}: ${owner.info}`);
  lines.push("", `${t.cancel}: ${cancelPolicyText(owner.freeCancelHoursBefore, lang)}`, "", shop);
  return { subject: (kind === "remind" ? t.remindSubject : t.subject)(shop, v.date, v.time), text: lines.join("\n") };
}

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM;
}

export function dailyLimit(): number {
  const n = Number.parseInt(process.env.EMAIL_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

/** 予約確認メールを送る。結果は短い記号で返す（本文に失敗の詳細は入れない。詳細はログへ） */
/** オーナーへのお知らせ（確認が必要な打刻、カード払いなど）。オーナーのログイン用のメールアドレスに送る。footer がなければ打刻の案内を添える */
export async function sendOwnerNotice(owner: Owner, subject: string, body: string, footer?: string): Promise<EmailNote> {
  const lang = normalizeLang(owner.language);
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  if (!owner.email) return "unregistered";
  const foot = footer ?? (lang === "ja" ? "管理画面の「打刻の確認」で確認できます。" : "You can review it under \"Clock records to confirm\" in the admin page.");
  return deliver(owner, owner.email, { subject: `【${shop}】${subject}`, text: [body, "", foot, "", shop].join("\n") }, "オーナーへのお知らせ");
}

/**
 * カード払いのお知らせをオーナーに（支払いが済んだ／払われずに取り消した）。
 * 画面読み上げで件名から聞くので、件名だけで中身がわかるようにする
 */
export async function sendPaymentNotice(owner: Owner, r: storage.ReservationRow, kind: "paid" | "expired"): Promise<EmailNote> {
  const lang = normalizeLang(owner.language);
  const ja = lang === "ja";
  const v = storage.reservationView(r, owner.timezone, lang);
  const who = ja ? `${v.customerName}様 ${v.date} ${v.time}` : `${v.customerName}, ${v.date} ${v.time}`;
  const subject = kind === "paid"
    ? (ja ? `カード払い完了：${who}` : `Card payment received: ${who}`)
    : (ja ? `未払いのため取り消し：${who}` : `Cancelled, not paid: ${who}`);
  const body = kind === "paid"
    ? (ja ? `${v.customerName}様（${v.date} ${v.time}、${v.menuName}）のカード払い ${v.price?.display ?? ""} が済みました。予約番号は${v.number}です。` : `${v.customerName} (${v.date} ${v.time}, ${v.menuName}) paid ${v.price?.display ?? ""} by card. Booking number ${v.number}.`)
    : (ja ? `${v.customerName}様（${v.date} ${v.time}、${v.menuName}）のカード払いの予約は、30分たってもお支払いがなかったので取り消しました。その時間は、また予約を受けられます。` : `The card booking for ${v.customerName} (${v.date} ${v.time}, ${v.menuName}) was not paid within 30 minutes, so it was cancelled. That time is open again.`);
  const footer = kind === "paid"
    ? (ja ? "入金や返金は Stripe の管理画面で確認できます。" : "Payouts and refunds are in your Stripe dashboard.")
    : (ja ? "お客さんには、取り消したことをメールでお知らせしています（メールのある方のみ）。" : "The customer was told by email (if they gave one).");
  return sendOwnerNotice(owner, subject, body, footer);
}

/** カード払いがなく自動で取り消したことを、お客さんに知らせる。もう一度予約できるページを添える */
export function composeHoldExpired(owner: Owner, r: storage.ReservationRow, bookingUrl: string): { subject: string; text: string } {
  const lang = normalizeLang(owner.language);
  const ja = lang === "ja";
  const v = storage.reservationView(r, owner.timezone, lang);
  const shop = storage.shopName(owner, lang) || (ja ? "ご予約ちゃん" : "GoYoyaku-chan");
  const lines = ja
    ? [`${v.customerName} 様`, "", `${v.date} ${v.time}（${v.menuName}）のご予約は、30分以内にカードのお支払いが確認できなかったため、取り消しとなりました。`,
      "料金はいただいていません。", "", `改めてのご予約はこちらから: ${bookingUrl}`, "", shop]
    : [`Dear ${v.customerName},`, "", `Your booking on ${v.date} at ${v.time} (${v.menuName}) was cancelled because the card payment was not completed within 30 minutes.`,
      "You have not been charged.", "", `You can book again here: ${bookingUrl}`, "", shop];
  return { subject: ja ? `【${shop}】お支払いがなかったため、ご予約を取り消しました` : `[${shop}] Your booking was cancelled (not paid)`, text: lines.join("\n") };
}

export async function sendHoldExpired(owner: Owner, r: storage.ReservationRow, bookingUrl: string): Promise<EmailNote> {
  if (!r.customer.email) return "no_email";
  return deliver(owner, r.customer.email, composeHoldExpired(owner, r, bookingUrl), "未払いの取り消し");
}

/** 次回の声かけ。「そろそろいかがですか」と予約のページ、配信を止めるリンク */
export async function sendFollowup(owner: Owner, c: Customer, days: number, bookingUrl: string, unsubscribeUrl: string): Promise<EmailNote> {
  if (!c.email) return "no_email";
  const lang = normalizeLang(owner.language);
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  const text = lang === "ja"
    ? [`${c.name} 様`, "", `前回のご来店から${days}日ほどたちました。お体の調子はいかがですか。`, "よろしければ、またお待ちしております。", "", `ご予約はこちらから: ${bookingUrl}`, "", shop, "", `このようなご案内が不要な方は、こちらから止められます: ${unsubscribeUrl}`].join("\n")
    : [`Dear ${c.name},`, "", `It has been about ${days} days since your last visit. How are you feeling?`, "We would be glad to see you again.", "", `Book here: ${bookingUrl}`, "", shop, "", `To stop these suggestions: ${unsubscribeUrl}`].join("\n");
  return deliver(owner, c.email, { subject: lang === "ja" ? `【${shop}】そろそろいかがですか` : `[${shop}] Time for your next visit?`, text }, "次回の声かけ");
}

/** 回数券・前払いのご案内。お会計のときに見せる QR コードのページのリンク */
export async function sendTicketPass(owner: Owner, c: Customer, t: CustomerTicket, url: string): Promise<EmailNote> {
  if (!c.email) return "no_email";
  const lang = normalizeLang(owner.language);
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  const text = lang === "ja"
    ? [`${c.name} 様`, "", `${t.name}をお買い上げいただき、ありがとうございます。`, "お会計のときに、下のページの QR コードをお見せください。残りの回数や金額もこのページで確かめられます。", "", url, ...(t.expiresOn ? ["", `期限：${t.expiresOn}まで`] : []), "", shop].join("\n")
    : [`Dear ${c.name},`, "", `Thank you for purchasing ${t.name}.`, "Please show the QR code on this page when you pay. You can also check what is left here.", "", url, ...(t.expiresOn ? ["", `Valid until ${t.expiresOn}`] : []), "", shop].join("\n");
  return deliver(owner, c.email, { subject: lang === "ja" ? `【${shop}】${t.name}のご案内` : `[${shop}] Your ${t.name}`, text }, "回数券のご案内");
}

/** スタッフへの招待。リンクから本人がパスワードを決める */
export async function sendStaffInvite(owner: Owner, to: string, staffName: string, url: string): Promise<EmailNote> {
  const lang = normalizeLang(owner.language);
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  const text = lang === "ja"
    ? [`${staffName} 様`, "", `${shop}のスタッフとして招待されました。`, "下のリンクを開いて、パスワードを決めてください。予定の確認と、出勤・退勤の打刻ができます。", "", url, "", "このリンクは7日間有効です。", "", shop].join("\n")
    : [`Dear ${staffName},`, "", `You have been invited to join ${shop} as staff.`, "Open the link below and choose a password. You can check your schedule and clock in and out.", "", url, "", "This link is valid for 7 days.", "", shop].join("\n");
  return deliver(owner, to, { subject: lang === "ja" ? `【${shop}】スタッフへの招待` : `[${shop}] Staff invitation`, text }, "スタッフへの招待");
}

/** 来店のお礼。口コミのページへのリンクと、次の予約のページを添える */
export function composeThanks(owner: Owner, r: storage.ReservationRow, bookingUrl: string): { subject: string; text: string } {
  const lang = normalizeLang(owner.language);
  const t = TEXT[lang];
  const shop = storage.shopName(owner, lang) || (lang === "ja" ? "ご予約ちゃん" : "GoYoyaku-chan");
  const lines = [...t.thanks(r.customer.name), "", `${t.review}: ${owner.reviewUrl}`, `${t.again}: ${bookingUrl}`, "", shop];
  return { subject: t.thanksSubject(shop), text: lines.join("\n") };
}

export async function sendThanks(owner: Owner, r: storage.ReservationRow, bookingUrl: string): Promise<EmailNote> {
  if (!r.customer.email) return "no_email";
  return deliver(owner, r.customer.email, composeThanks(owner, r, bookingUrl), "お礼のメール");
}

export async function sendBookingConfirmation(owner: Owner, r: storage.ReservationRow): Promise<EmailNote> {
  if (!r.customer.email) return "no_email";
  return deliver(owner, r.customer.email, composeConfirmation(owner, r), "確認メール");
}

export async function sendReminder(owner: Owner, r: storage.ReservationRow): Promise<EmailNote> {
  if (!r.customer.email) return "no_email";
  return deliver(owner, r.customer.email, composeReminder(owner, r), "前日のお知らせ");
}

async function deliver(owner: Owner, to: string, { subject, text }: { subject: string; text: string }, label: string): Promise<EmailNote> {
  if (!owner.email) return "unregistered";
  if (!emailConfigured()) {
    console.log(`\n--- ${label}（送信の設定がないため表示のみ）---\n宛先: ${to}\n件名: ${subject}\n\n${text}\n---\n`);
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
