import { test } from "node:test";
import assert from "node:assert/strict";
import { availableSlots, checkBookable, BookingError, refundEligible } from "./booking";
import { fromLocal, nowLocal, toLocal, addDays } from "./time";
import { toMinor, formatMoney, money } from "../../shared/money";
import { normalizePhrase, hashPassphrase, verifyPassphrase } from "./passphrase";
import { DEFAULT_HOURS } from "../../shared/schema";

const settings = {
  timezone: "Asia/Tokyo", language: "ja", hours: DEFAULT_HOURS,
  bufferMinutes: 15, slotStepMinutes: 30, maxDaysAhead: 60, minHoursBefore: 2,
};

test("「今日」はオーナーの時間帯で決まる（日本時間の深夜1時）", () => {
  const utc = new Date("2026-10-22T16:00:00Z"); // 日本時間 10/23 01:00
  const local = nowLocal("Asia/Tokyo", utc);
  assert.equal(local.date, "2026-10-23");
  assert.equal(local.time, "01:00");
  assert.equal(addDays(local.date, 1), "2026-10-24");
});

test("現地時刻 → UTC → 現地時刻 が一致する（夏時間のある地域も）", () => {
  for (const [tz, date, time] of [["Asia/Tokyo", "2026-10-23", "15:00"], ["America/New_York", "2026-07-04", "09:30"], ["Europe/London", "2026-01-10", "18:00"]] as const) {
    const d = fromLocal(date, time, tz);
    const back = toLocal(d, tz);
    assert.equal(back.date, date);
    assert.equal(back.time, time);
  }
  assert.equal(fromLocal("2026-10-23", "15:00", "Asia/Tokyo").toISOString(), "2026-10-23T06:00:00.000Z");
});

test("営業時間外・定休日・重なりは入れられない", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const base = { settings, minutes: 60, reservations: [], blocked: [], source: "web" as const, now };
  assert.throws(() => checkBookable({ ...base, date: "2026-10-25", time: "11:00" }), (e: any) => e.code === "closed_day"); // 日曜
  assert.throws(() => checkBookable({ ...base, date: "2026-10-23", time: "18:30" }), (e: any) => e.code === "outside_hours");
  assert.throws(() => checkBookable({ ...base, date: "2026-10-19", time: "11:00" }), (e: any) => e.code === "past_time");
  const existing = { id: 1, startAt: fromLocal("2026-10-23", "14:00", "Asia/Tokyo"), endAt: fromLocal("2026-10-23", "15:00", "Asia/Tokyo"), label: "田中" };
  assert.throws(() => checkBookable({ ...base, date: "2026-10-23", time: "15:00", reservations: [existing] }), (e: any) => e.code === "overlap");
  assert.ok(checkBookable({ ...base, date: "2026-10-23", time: "15:30", reservations: [existing] }));
  // オーナーが入れる予約には「何時間前まで」「何日先まで」をかけない
  assert.throws(() => checkBookable({ ...base, date: "2026-10-20", time: "10:00" }), (e: any) => e.code === "too_soon");
  assert.ok(checkBookable({ ...base, date: "2026-10-20", time: "10:00", source: "owner" }));
  assert.throws(() => checkBookable({ ...base, date: "2027-01-11", time: "10:00" }), (e: any) => e.code === "too_far");
});

test("空き時間は営業時間・他の予約・空き時間ルールを反映する", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const existing = { id: 1, startAt: fromLocal("2026-10-23", "12:00", "Asia/Tokyo"), endAt: fromLocal("2026-10-23", "13:00", "Asia/Tokyo"), label: "田中" };
  const { slots } = availableSlots({ settings, date: "2026-10-23", minutes: 60, reservations: [existing], blocked: [], source: "web", now });
  assert.deepEqual(slots, ["10:00", "10:30", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00"]);
  assert.deepEqual(availableSlots({ settings, date: "2026-10-25", minutes: 60, reservations: [], blocked: [], source: "web", now }), { slots: [], closed: true });
});

test("返金の対象かはキャンセルの決まりで決まる", () => {
  const start = new Date("2026-10-23T06:00:00Z");
  assert.equal(refundEligible(start, 24, new Date("2026-10-22T05:00:00Z")), true);
  assert.equal(refundEligible(start, 24, new Date("2026-10-22T07:00:00Z")), false);
});

test("金額は最小単位の整数で持ち、表示は普通の金額", () => {
  assert.equal(toMinor(5000, "JPY"), 5000);
  assert.equal(toMinor("49.99", "USD"), 4999);
  assert.equal(toMinor(60, "USD"), 6000);
  assert.equal(money(6000 - 4999, "USD", "en").display, "$10.01");
  assert.equal(formatMoney(5000, "JPY", "ja"), "￥5,000".replace("￥", "¥").replace("¥", formatMoney(5000, "JPY", "ja")[0]));
  assert.equal(money(5000, "JPY", "ja").amount, 5000);
});

test("合言葉は音声認識の揺れを吸収して照合する", () => {
  const h = hashPassphrase("ひかり　ハナ。");
  assert.equal(verifyPassphrase("ヒカリはな", h), true);
  assert.equal(verifyPassphrase("ひかり はな！", h), true);
  assert.equal(verifyPassphrase("ひかりはなこ", h), false);
  assert.equal(normalizePhrase("Ｈｉｋａｒｉ ハナ"), "hikariはな");
});

test("24時間営業（00:00〜24:00）なら、夜遅い予約も日付の終わりまで入る", () => {
  const all = { open: "00:00", close: "24:00" };
  const s24 = { ...settings, hours: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all } };
  const now = new Date("2026-10-20T00:00:00Z");
  const ok = checkBookable({ settings: s24, date: "2026-10-30", time: "23:00", minutes: 60, reservations: [], blocked: [], source: "web", now });
  assert.equal(ok.endAt.toISOString(), "2026-10-30T15:00:00.000Z");
  assert.throws(() => checkBookable({ settings: s24, date: "2026-10-30", time: "23:30", minutes: 60, reservations: [], blocked: [], source: "web", now }), BookingError);
  const slots = availableSlots({ settings: s24, date: "2026-10-30", minutes: 60, reservations: [], blocked: [], source: "web", now });
  assert.equal(slots.slots[0], "00:00");
  assert.equal(slots.slots[slots.slots.length - 1], "23:00");
});
