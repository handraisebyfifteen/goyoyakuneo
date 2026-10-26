import { test } from "node:test";
import assert from "node:assert/strict";
import { composeConfirmation, composeReminder, composeHoldExpired } from "../email";
import type { Owner } from "@shared/schema";
import { DEFAULT_HOURS } from "@shared/schema";
import type { ReservationRow } from "../storage";

const owner: Owner = {
  id: 1, email: "o@example.com", passwordHash: null, passphraseHash: null, deviceKeyHash: null, loginMethod: "both",
  shopNameJa: "ひかり治療院", shopNameEn: "Hikari Massage", address: "東京都架空区1-2-3", phone: "03-0000-0000", info: "駐車場あり", businessType: "massage",
  country: "JP", currency: "JPY", timezone: "Asia/Tokyo", language: "ja", hours: DEFAULT_HOURS,
  bufferMinutes: 15, slotStepMinutes: 30, maxDaysAhead: 60, minHoursBefore: 2, freeCancelHoursBefore: 24,
  allowCardPayment: true, cardMinHoursBefore: 24, stripeAccountId: null, cardReady: false, slug: "hikari", onboardingDone: true, lastBriefedAt: null, calendarToken: null, reviewUrl: "", allowNomination: false, clockToleranceMinutes: 30, planHorizonDays: 31, followupAfterDays: 0, stripeCustomerId: null, subscriptionId: null, subscriptionStatus: null, subscriptionSeats: 0, noticePrefs: null, groupId: null, setupState: { done: [], skipped: [], asks: {} }, createdAt: new Date(),
};
const row: ReservationRow = {
  id: 1, ownerId: 1, number: "1234", customerId: 1, menuId: 1, menuNameJa: "60分コース", menuNameEn: "60 min", minutes: 60, price: 6000, currency: "JPY",
  startAt: new Date("2026-10-30T06:00:00Z"), endAt: new Date("2026-10-30T07:00:00Z"), status: "confirmed", source: "web", paymentMethod: "card", paymentStatus: "unpaid",
  amountReceived: 0, stripeSessionId: null, stripePaymentIntentId: null, paidAt: null, paymentUrl: "https://example.com/pay/1", createdAt: new Date(), cancelledAt: null, cancelledBy: null, remindedAt: null, changedByCustomerAt: null, thankedAt: null, couponCode: null, discount: 0, staffId: null, staffName: "", nominated: false, ticketId: null, ticketUsed: 0,
  customer: { id: 1, ownerId: 1, name: "田中", phone: "09000000000", email: "delivered@resend.dev", notes: "", followedUpAt: null, followupOptOut: false, unsubscribeToken: null, createdAt: new Date() },
};

test("確認メールは店名・日時・所要時間・メニュー・料金・支払い方法・リンク・住所・電話・案内・キャンセルの決まりを含む（日本語）", () => {
  const { subject, text } = composeConfirmation(owner, row);
  assert.ok(subject.includes("ひかり治療院") && subject.includes("2026-10-30 15:00"));
  for (const s of ["田中 様", "2026-10-30 (金曜日) 15:00", "60分", "60分コース", "¥6,000", "カード", "https://example.com/pay/1", "東京都架空区", "03-0000-0000", "駐車場あり", "24時間前", "予約番号: 1234"]) {
    assert.ok(text.includes(s), `本文に「${s}」がない:\n${text}`);
  }
});

test("確認メールはオーナーの言語設定で英語になる", () => {
  const { subject, text } = composeConfirmation({ ...owner, language: "en" }, { ...row, paymentMethod: "onsite", paymentUrl: null });
  assert.ok(subject.startsWith("[Hikari Massage]"));
  assert.ok(text.includes("Dear 田中,") && text.includes("(Friday)") && text.includes("Pay at the shop") && text.includes("24 hours"));
  assert.ok(!text.includes("Pay here"));
});

test("メニューなしの予約の確認メールには、メニューと料金の行が出ない", () => {
  const { text } = composeConfirmation(owner, { ...row, menuId: null, menuNameJa: "", menuNameEn: "", price: 0, paymentMethod: "onsite", paymentStatus: "onsite_pending", paymentUrl: null });
  assert.ok(text.includes("60分") && !text.includes("メニュー:") && !text.includes("料金:"), text);
});

test("前日のお知らせは件名と書き出しが変わり、取り消しの案内が入る", () => {
  const { subject, text } = composeReminder(owner, row);
  assert.ok(subject.includes("明日のご予約のお知らせ") && subject.includes("2026-10-30 15:00"));
  assert.ok(text.includes("明日のご予約のお知らせです") && text.includes("取り消しができます") && text.includes("予約番号: 1234"), text);
  assert.ok(composeReminder({ ...owner, language: "en" }, row).subject.includes("Reminder"));
});

test("ネットのカード払いの確認メールには、30分で取り消しになることを添える。支払い済みや前日のお知らせには支払いのリンクを出さない", () => {
  assert.ok(composeConfirmation(owner, row).text.includes("30分以内にお支払いがない場合"));
  assert.ok(!composeConfirmation(owner, { ...row, source: "owner" }).text.includes("30分以内"));
  assert.ok(!composeConfirmation(owner, { ...row, paymentStatus: "paid" }).text.includes("https://example.com/pay/1"));
  assert.ok(!composeReminder(owner, row).text.includes("30分以内"));
});

test("払われずに取り消したお知らせは、料金をいただいていないことと、予約し直すページを伝える", () => {
  const { subject, text } = composeHoldExpired(owner, row, "https://example.com/book/hikari");
  assert.ok(subject.includes("ひかり治療院") && subject.includes("取り消し"));
  assert.ok(text.includes("2026-10-30 15:00") && text.includes("料金はいただいていません") && text.includes("https://example.com/book/hikari"), text);
  assert.ok(composeHoldExpired({ ...owner, language: "en" }, row, "u").text.includes("not been charged"));
});
