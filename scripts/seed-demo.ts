/**
 * デモ動画の撮影用のお店を作る（または作り直す）。
 *
 *   npx tsx scripts/seed-demo.ts            日本語のお店
 *   npx tsx scripts/seed-demo.ts --lang en  英語のお店
 *
 * - ログイン：DEMO_EMAIL（なければ demo@example.com）と、下に書いたパスワード・合言葉
 * - 同じメールのお店があれば、そのお店の記録を全部消してから入れ直す（何度でも撮り直せる）
 * - 明日の 14:00〜15:30 は空けてある（「田中さん、明日2時から3時半」の場面のため）
 * - お客さんにはメールを入れない（前日のお知らせや次回の声かけが、撮影中に本物のメールで飛ばないように）
 */
import { eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as storage from "../server/storage";
import { hashSecret, hashPassphrase } from "../server/lib/passphrase";
import { addDays, fromLocal, nowLocal, weekdayOf } from "../server/lib/time";
import { SETUP_ITEMS } from "../server/ai/setup";
import {
  DEFAULT_HOURS, reservations, customerTickets, ticketTypes, customers, menus, coupons,
  blockedSlots, expenses, ownerMemories, chatMessages, voiceSessions, emailLog, pushSubscriptions, apiKeys,
  attendanceEvents, timeEntries, shifts, staff, type Language, type Menu, type Customer,
} from "@shared/schema";

const lang: Language = process.argv.includes("--lang") && process.argv[process.argv.indexOf("--lang") + 1] === "en" ? "en" : "ja";
const ja = lang === "ja";
const EMAIL = (process.env.DEMO_EMAIL ?? "demo@example.com").toLowerCase().trim();
const PASSWORD = "demo-pass-2026";
const PASSPHRASE = ja ? "ひだまり" : "sunny room";
const TZ = "Asia/Tokyo";

const SHOP = {
  shopNameJa: "ひだまり鍼灸マッサージ院",
  shopNameEn: "Hidamari Acupuncture & Massage",
  address: ja ? "東京都杉並区阿佐谷南1-2-3" : "1-2-3 Asagaya-minami, Suginami, Tokyo",
  phone: "03-0000-0000",
  info: ja ? "完全予約制。駅から徒歩5分。タオルはお店で用意しています。" : "By appointment only. 5 minutes from the station. Towels provided.",
};

const MENUS = [
  { nameJa: "全身もみほぐし 60分", nameEn: "Full-body massage 60 min", minutes: 60, price: 6000 },
  { nameJa: "全身もみほぐし 90分", nameEn: "Full-body massage 90 min", minutes: 90, price: 8500 },
  { nameJa: "鍼灸 45分", nameEn: "Acupuncture 45 min", minutes: 45, price: 5000 },
];

const CUSTOMERS = [
  { name: ja ? "田中 一郎" : "Ichiro Tanaka", phone: "09000000001", notes: ja ? "腰が悪い。強めが好み。" : "Bad lower back. Likes firm pressure." },
  { name: ja ? "佐藤 花子" : "Hanako Sato", phone: "09000000002", notes: ja ? "首と肩のこり。" : "Stiff neck and shoulders." },
  { name: ja ? "鈴木 健" : "Ken Suzuki", phone: "09000000003", notes: "" },
  { name: ja ? "高橋 美咲" : "Misaki Takahashi", phone: "09000000004", notes: ja ? "鍼は初めて。やさしめで。" : "New to acupuncture. Gentle, please." },
];

async function resetOwner(ownerId: number) {
  // 外部キーの向きに合わせて、子の表から消す
  for (const t of [reservations, customerTickets, ticketTypes, customers, menus, coupons, blockedSlots, expenses, ownerMemories,
    chatMessages, voiceSessions, emailLog, pushSubscriptions, apiKeys, attendanceEvents, timeEntries, shifts, staff]) {
    await db.delete(t).where(eq(t.ownerId, ownerId));
  }
}

async function main() {
  const ownerFields = {
    email: EMAIL,
    passwordHash: hashSecret(PASSWORD),
    passphraseHash: hashPassphrase(PASSPHRASE),
    deviceKeyHash: null,
    loginMethod: "both",
    ...SHOP,
    businessType: "massage",
    country: "JP", currency: "JPY", timezone: TZ, language: lang,
    hours: DEFAULT_HOURS,
    onboardingDone: true,
    // 撮影中に設定の質問が割り込まないよう、全部決まったことにする
    setupState: { done: [...SETUP_ITEMS], skipped: [], asks: {} },
    noticePrefs: { attendance: "all" as const, attendanceEmail: false, paymentEmail: false },
    followupAfterDays: 0,
    // 開いたときのお知らせは、ここから先の変化だけにする（お客さん側で入れた予約が読み上げられる）
    lastBriefedAt: new Date(),
  };
  const existing = await storage.getOwnerByEmail(EMAIL);
  let owner;
  if (existing) {
    await resetOwner(existing.id);
    owner = await storage.updateOwner(existing.id, ownerFields);
  } else {
    owner = await storage.createOwner({ ...ownerFields, slug: "demo-" + Math.random().toString(16).slice(2, 8) });
  }

  const menuRows: Menu[] = [];
  for (let i = 0; i < MENUS.length; i++) {
    menuRows.push(await storage.createMenu({ ownerId: owner.id, currency: "JPY", sortOrder: i, ...MENUS[i] }));
  }
  const cust: Customer[] = [];
  for (const c of CUSTOMERS) {
    const row = await storage.upsertCustomer(owner.id, c.name, c.phone);
    cust.push(c.notes ? (await storage.updateCustomer(owner.id, row.id, { notes: c.notes }))! : row);
  }

  const today = nowLocal(TZ).date;
  const isOpen = (date: string) => !!DEFAULT_HOURS[weekdayOf(date)];
  const book = (customerIdx: number, menuIdx: number, date: string, time: string, extra: Partial<typeof reservations.$inferInsert>) => {
    const m = menuRows[menuIdx];
    const startAt = fromLocal(date, time, TZ);
    return storage.createReservation({
      ownerId: owner.id, customerId: cust[customerIdx].id, menuId: m.id, menuNameJa: m.nameJa, menuNameEn: m.nameEn,
      minutes: m.minutes, price: m.price, currency: "JPY", startAt, endAt: new Date(startAt.getTime() + m.minutes * 60_000),
      source: "owner", paymentMethod: "onsite", paymentStatus: "onsite_pending", ...extra,
    });
  };
  const paid = (price: number) => ({ status: "completed", paymentStatus: "onsite_received", amountReceived: price });

  // 過去45日の来店（売り上げと来店の記録）。開いている日に2件ずつ、決まった順に回す
  let n = 0;
  for (let d = -45; d <= -2; d++) {
    const date = addDays(today, d);
    if (!isOpen(date)) continue;
    for (const time of ["10:00", "15:00"]) {
      const c = n % 4 === 2 ? 0 : n % 4; // 鈴木さんは最近来ていない（次回の声かけの相手）。その分を田中さんが来る
      const mi = n % 3;
      if (!(c === 2 && d > -40)) await book(c, mi, date, time, { ...paid(MENUS[mi].price), source: n % 3 === 0 ? "web" : "owner" });
      n++;
    }
  }
  // 鈴木さんの最後の来店は40日以上前
  await book(2, 0, addDays(today, -44), "17:00", paid(MENUS[0].price));

  // 昨日：佐藤さんは来たが、まだお金を受け取っていない（「未払いは？」で出る）
  const yesterday = addDays(today, -1);
  await book(1, 1, yesterday, "13:00", { status: "completed" });
  await book(0, 0, yesterday, "16:00", paid(MENUS[0].price));

  // 今日と明日の予定。明日の 14:00〜15:30 は空けておく
  await book(3, 2, today, "11:00", {});
  await book(1, 0, today, "17:00", { source: "web" });
  const tomorrow = addDays(today, 1);
  await book(1, 0, tomorrow, "10:00", {});
  await book(3, 1, tomorrow, "16:00", { source: "web" });

  // 今月の経費（「利益は？」「回数券はいくらに？」の相談の材料）
  const month = today.slice(0, 8);
  for (const e of [
    { date: month + "01", amount: 80000, category: "rent", memo: ja ? "家賃" : "Rent" },
    { date: month + "05", amount: 12000, category: "supplies", memo: ja ? "タオル・オイル" : "Towels and oil" },
    { date: month + "10", amount: 9500, category: "utilities", memo: ja ? "電気・水道" : "Power and water" },
  ]) await storage.createExpense({ ownerId: owner.id, ...e });

  console.log(`\nDemo shop ready (${lang}): ${ja ? SHOP.shopNameJa : SHOP.shopNameEn}`);
  console.log(`  email:      ${EMAIL}`);
  console.log(`  password:   ${PASSWORD}`);
  console.log(`  passphrase: ${PASSPHRASE}`);
  console.log(`  booking page: /book/${owner.slug}`);
  console.log(`  tomorrow (${tomorrow}) is free 14:00-15:30 for the Tanaka booking.`);
  if (!isOpen(tomorrow)) console.log(`  WARNING: tomorrow is a closed day. Film on another day, or say a different date.`);
  console.log(`  Note: email is not sent to customers, and the owner's payment emails are off.`);
}

main().then(() => pool.end()).catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
