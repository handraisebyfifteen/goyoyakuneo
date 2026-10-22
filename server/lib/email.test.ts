import { test } from "node:test";
import assert from "node:assert/strict";
import { composeConfirmation } from "../email";
import type { Owner } from "@shared/schema";
import { DEFAULT_HOURS } from "@shared/schema";
import type { ReservationRow } from "../storage";

const owner: Owner = {
  id: 1, email: "o@example.com", passwordHash: null, passphraseHash: null, loginMethod: "both",
  shopNameJa: "ひかり治療院", shopNameEn: "Hikari Massage", address: "東京都架空区1-2-3", phone: "03-0000-0000", info: "駐車場あり", businessType: "massage",
  country: "JP", currency: "JPY", timezone: "Asia/Tokyo", language: "ja", hours: DEFAULT_HOURS,
  bufferMinutes: 15, slotStepMinutes: 30, maxDaysAhead: 60, minHoursBefore: 2, freeCancelHoursBefore: 24,
  allowCardPayment: true, slug: "hikari", onboardingDone: true, createdAt: new Date(),
};
const row: ReservationRow = {
  id: 1, ownerId: 1, number: "1234", customerId: 1, menuId: 1, menuNameJa: "60分コース", menuNameEn: "60 min", minutes: 60, price: 6000, currency: "JPY",
  startAt: new Date("2026-10-30T06:00:00Z"), endAt: new Date("2026-10-30T07:00:00Z"), status: "confirmed", source: "web", paymentMethod: "card", paymentStatus: "unpaid",
  amountReceived: 0, stripeSessionId: null, stripePaymentIntentId: null, paymentUrl: "https://example.com/pay/1", createdAt: new Date(), cancelledAt: null,
  customer: { id: 1, ownerId: 1, name: "田中", phone: "09000000000", email: "delivered@resend.dev", createdAt: new Date() },
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
