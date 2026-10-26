/**
 * 今できること。登録や設定、使い始めたものによって、できることが増えていく。それを一覧にする。
 * - ready：登録・設定してあるからできること（何が決まっているかを detail に添える）
 * - always：いつでも話しかければできること
 * - next：設定するとできること（多すぎると負担なので3つまで。「聞かないで」と言われた項目は出さない）
 * 画面の「今できること」と、声の「何ができる？」（get_capabilities）で同じものを使う。
 * say は話しかけるときの言い方の例。自動で動くものは null。section は画面の欄（開くボタンの行き先）。
 */
import type { Express } from "express";
import type { Owner, Language } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import { money } from "@shared/money";
import * as storage from "./storage";
import { requireOwner, type AuthedRequest } from "./auth";
import { sendError } from "./errors";
import { todayFor } from "./services";
import { stripeConfigured } from "./payments";
import { emailConfigured } from "./email";
import { couponProblem } from "./lib/coupon";
import { hoursText } from "./ai/setup";

export type Ability = { key: string; title: string; detail: string; say: string | null; section: string | null };
export type Abilities = { ready: Ability[]; always: Ability[]; next: Ability[] };

const MAX_NEXT = 3;

export async function capabilitiesFor(owner: Owner, lang: Language): Promise<Abilities> {
  const ja = lang === "ja";
  const today = todayFor(owner);
  const cur = owner.currency;
  const registered = !!owner.email;
  const menus = await storage.listMenus(owner.id, true);
  const staff = (await storage.listStaff(owner.id)).filter((s) => !s.isOwner && s.active);
  const types = await storage.listTicketTypes(owner.id, true);
  const tickets = (await storage.listTickets(owner.id)).filter((t) => t.active && t.remaining > 0 && (!t.expiresOn || today <= t.expiresOn));
  const coupons = (await storage.listCoupons(owner.id)).filter((c) => !couponProblem(c, today));
  const customers = await storage.listCustomers(owner.id);
  const memories = await storage.listMemories(owner.id);
  const keys = (await storage.listApiKeys(owner.id)).filter((k) => !k.revokedAt);
  const group = owner.groupId ? await storage.getShopGroup(owner.groupId) : undefined;
  const skipped = owner.setupState?.skipped ?? [];
  const until = (d: string) => (ja ? `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日まで` : `until ${d}`);
  const join = (xs: string[]) => xs.join(ja ? "、" : ", ");

  const ready: Ability[] = [];
  if (registered && menus.length) ready.push({
    key: "booking_page", section: "share",
    title: ja ? "お客さんがネットで予約できる" : "Customers can book online",
    detail: ja ? `予約ページを送る・QRコードで渡す。メニュー${menus.length}つ、営業時間は${hoursText(owner, lang)}` : `Send the booking page or show its QR code. ${menus.length} services; hours ${hoursText(owner, lang)}`,
    say: ja ? "予約のリンクを送って" : "Send the booking link",
  });
  if (registered && emailConfigured()) ready.push({
    key: "emails", section: null,
    title: ja ? "予約の確認メールと、前日のお知らせ" : "Confirmation emails and day-before reminders",
    detail: ja ? "メールのわかるお客さんに自動で送ります。メールのないお客さんは、前の日に電話する人としてお伝えします" : "Sent automatically to customers with an email. Customers without one are listed for you to call the day before",
    say: null,
  });
  if (owner.allowCardPayment && stripeConfigured() && owner.cardReady) ready.push({
    key: "card", section: "cardpay",
    title: ja ? "カードで前払いしてもらう" : "Take card payment in advance",
    detail: ja
      ? `予約ページでカード払いを選べます（来店の${owner.cardMinHoursBefore}時間前までの予約）。お金はお店の口座に入ります。声で支払いのリンクも作れます`
      : `Customers can pay by card on the booking page (bookings at least ${owner.cardMinHoursBefore} hours ahead). The money goes to your account. You can also make a payment link by voice`,
    say: ja ? "田中さんの予約の支払いリンクを作って" : "Make a payment link for Tanaka's booking",
  });
  if (registered && owner.reviewUrl) ready.push({
    key: "review", section: null,
    title: ja ? "来てくれたお客さんに、お礼と口コミのお願い" : "Thank customers and ask for a review",
    detail: ja ? "施術のあと、口コミのページのリンクをつけてお礼のメールを送ります" : "After a visit, a thank-you email goes out with your review page link",
    say: null,
  });
  if (registered && owner.followupAfterDays > 0) ready.push({
    key: "followup", section: "followup",
    title: ja ? "しばらく来ていないお客さんに声をかける" : "Invite back customers who haven't visited",
    detail: ja ? `前回から${owner.followupAfterDays}日あいたら、メールでお誘いします` : `An email goes out ${owner.followupAfterDays} days after the last visit`,
    say: ja ? "声かけを60日にして" : "Change the follow-up to 60 days",
  });
  if (staff.length) ready.push({
    key: "staff", section: "staff",
    title: ja ? "スタッフの打刻の確認と、給与の計算" : "Check staff clock-ins and work out pay",
    detail: ja ? `スタッフ${staff.length}人${owner.allowNomination ? "。予約のときに指名もできます" : ""}` : `${staff.length} staff${owner.allowNomination ? ". Customers can choose who they book with" : ""}`,
    say: ja ? "打刻を確認して" : "Check the clock-ins",
  });
  if (types.length || tickets.length) ready.push({
    key: "tickets", section: "tickets",
    title: ja ? "回数券・前払いを売る、使う" : "Sell and use multi-visit tickets and prepaid",
    detail: join([
      ...types.slice(0, 2).map((t) => `${t.name} ${money(t.price, cur, lang).display}`),
      ...(tickets.length ? [ja ? `使える券がお客さんの手元に${tickets.length}枚` : `${tickets.length} in customers' hands`] : []),
      ja ? "お客さんの券の QR コードをカメラで読み取れます" : "Scan the customer's QR code with the camera",
    ]),
    say: types.length ? (ja ? `田中さんに${types[0].name}を売ったよ` : `I sold Tanaka a ${types[0].name}`) : (ja ? "田中さんの回数券を1回使った" : "Use one of Tanaka's tickets"),
  });
  if (coupons.length) ready.push({
    key: "coupons", section: "coupons",
    title: ja ? "クーポンで割り引く" : "Give discounts with coupons",
    detail: join(coupons.slice(0, 2).map((c) => `${c.code} ${c.kind === "percent" ? `${c.value}%` : money(c.value, cur, lang).display}${ja ? "引き" : " off"}${c.expiresOn ? `（${until(c.expiresOn)}）` : ""}`)),
    say: ja ? "今使えるクーポンは？" : "Which coupons can be used now?",
  });
  if (group) ready.push({
    key: "group", section: "group",
    title: ja ? "ほかの店の集計を見る" : "See your other shops' totals",
    detail: ja ? `店舗グループ「${group.name}」（${(await storage.listGroupOwners(group.id)).length}店）の売り上げと件数` : `Sales and bookings across "${group.name}" (${(await storage.listGroupOwners(group.id)).length} shops)`,
    say: ja ? "グループの今月の売り上げは？" : "What are the group's sales this month?",
  });
  if (keys.length) ready.push({
    key: "api", section: "api",
    title: ja ? "外の道具からデータを読む" : "Read your data from other tools",
    detail: ja ? `APIキー${keys.length}本。読むだけで、書き込みはできません` : `${keys.length} API key${keys.length > 1 ? "s" : ""}. Read only`,
    say: null,
  });
  if (registered) ready.push({
    key: "calendar", section: "calendar",
    title: ja ? "いつものカレンダーに予約を出す" : "Show bookings in your own calendar",
    detail: ja ? "iPhone や Google のカレンダーで予約を見られます" : "See bookings in your iPhone or Google calendar",
    say: null,
  });

  const always: Ability[] = [
    { key: "reserve", section: "today",
      title: ja ? "予約を入れる・変える・取り消す" : "Add, change or cancel bookings",
      detail: menus.length ? (ja ? `メニュー${menus.length}つから。時間だけでも入れられます` : `From ${menus.length} services, or just a time range`) : (ja ? "時間だけで入れられます" : "Just a time range is enough"),
      say: ja ? "田中さん、明日の2時から3時半" : "Tanaka, tomorrow from 2 to 3:30" },
    { key: "slots", section: null,
      title: ja ? "空いている時間を答える" : "Tell you when you're free",
      detail: ja ? `営業時間は${hoursText(owner, lang)}` : `Hours ${hoursText(owner, lang)}`,
      say: ja ? "明日の空きは？" : "When am I free tomorrow?" },
    { key: "recurring", section: null,
      title: ja ? "毎週の予約をまとめて入れる" : "Book the same slot every week",
      detail: ja ? "空いていない日は飛ばして知らせます" : "Days that are taken are skipped and reported",
      say: ja ? "田中さん、毎週火曜の10時に4回" : "Tanaka, every Tuesday at 10, four times" },
    { key: "customers", section: null,
      title: ja ? "お客さんのことを覚えておく" : "Keep notes on customers",
      detail: customers.length ? (ja ? `お客さん${customers.length}人の記録。来店の回数や前回も答えます` : `${customers.length} customers on record, with visits and last visit`) : (ja ? "来店の回数や前回も答えます" : "Visits and last visit too"),
      say: ja ? "田中さんは腰が悪いとメモして" : "Note that Tanaka has a bad back" },
    { key: "sales", section: "sales",
      title: ja ? "売り上げを聞く" : "Hear your sales",
      detail: ja ? "カードと現地払いの内訳、未払いも" : "Card and pay-at-shop breakdown, and unpaid",
      say: ja ? "今月の売り上げは？" : "What are this month's sales?" },
    { key: "books", section: "books",
      title: ja ? "経費をつけて、利益を見る" : "Record expenses and see profit",
      detail: ja ? "科目は自動で分けます。帳簿は確定申告用に書き出せます" : "Categories are filled in for you. Export the ledger for your tax return",
      say: ja ? "タオル代3000円" : "Towels, 3000 yen" },
    { key: "advice", section: null,
      title: ja ? "お店のことを相談する" : "Talk things through",
      detail: ja ? "値段や回数券・クーポンの案も、お店の数字から出します" : "Pricing and ticket or coupon ideas, based on your numbers",
      say: ja ? "回数券、いくらがいいかな" : "What should a multi-visit ticket cost?" },
    { key: "memory", section: "memory",
      title: ja ? "好みや決まりごとを覚えてもらう" : "Have it remember how you like things",
      detail: memories.length ? (ja ? `今${memories.length}件覚えています` : `${memories.length} things remembered`) : (ja ? "「次から〜して」と言えば覚えます" : 'Say "from now on, ..." and it remembers'),
      say: ja ? "予定どおりの打刻は言わなくていい" : "No need to tell me about on-time clock-ins" },
  ];

  const next: Ability[] = [];
  if (!registered) next.push({
    key: "register", section: "register",
    title: ja ? "お店を登録する" : "Register your shop",
    detail: ja ? "予約ページをお客さんに渡せて、確認のメールも送れます。記録もこの端末だけに縛られなくなります" : "Share the booking page and send confirmation emails. Your records stop depending on this one device",
    say: ja ? "お店を登録して" : "Register my shop",
  });
  if (!menus.length) next.push({
    key: "menu", section: "menus",
    title: ja ? "メニューを1つ決める" : "Add one service",
    detail: ja ? "お客さんがネットから予約できるようになります" : "Customers can then book online",
    say: ja ? "60分6000円のメニューを作って" : "Add a 60-minute service for 6000 yen",
  });
  if (!(await storage.listPushSubscriptions(owner.id)).length) next.push({
    key: "push", section: "push",
    title: ja ? "スマホに通知を出す" : "Turn on phone notifications",
    detail: ja ? "アプリを閉じていても、新しい予約やカード払いの知らせが届きます" : "Get booking and payment news even when the app is closed",
    say: null,
  });
  if (registered && stripeConfigured() && !owner.cardReady) next.push({
    key: "cardpay", section: "cardpay",
    title: ja ? "カード払いの入金先を登録する" : "Set up card payment",
    detail: ja ? "お客さんが予約のときにカードで前払いできます。お金は Stripe からお店の口座に直接入ります" : "Customers can prepay by card when they book. Stripe pays the money straight into your account",
    say: null,
  });
  if (registered && !owner.followupAfterDays && !skipped.includes("followup")) next.push({
    key: "followup", section: "followup",
    title: ja ? "声かけの日数を決める" : "Set when to invite customers back",
    detail: ja ? "しばらく来ていないお客さんに、メールでお誘いします" : "Customers who haven't come for a while get an email",
    say: ja ? "45日あいたら声をかけて" : "Invite them back after 45 days",
  });
  if (registered && !owner.reviewUrl) next.push({
    key: "review", section: null,
    title: ja ? "口コミのページを教える" : "Add your review page",
    detail: ja ? "来てくれたお客さんに、口コミのリンクつきのお礼メールを送ります" : "Customers get a thank-you email with your review link",
    say: ja ? "口コミのページを登録したい" : "I want to add my review page",
  });
  if (!types.length && !tickets.length) next.push({
    key: "tickets", section: "tickets",
    title: ja ? "回数券を作る" : "Create a multi-visit ticket",
    detail: ja ? "まとめて買ってもらえます。値段は相談できます" : "Customers pay ahead for several visits. Ask for a suggested price",
    say: ja ? "回数券、いくらがいいかな" : "What should a multi-visit ticket cost?",
  });

  return { ready, always, next: next.slice(0, MAX_NEXT) };
}

export function registerCapabilityRoutes(app: Express) {
  app.get("/api/owner/capabilities", requireOwner, async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(req.query.lang ?? owner.language);
    try { res.json({ ok: true, ...(await capabilitiesFor(owner, lang)) }); }
    catch (e) { sendError(res, lang, e); }
  });
}
