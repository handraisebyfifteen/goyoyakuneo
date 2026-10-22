import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCashJson, cashChange, spokenCash } from "./vision";

test("合計はサーバーで計算し直し、モデルの合計と合わなければ自信なし", () => {
  const r = parseCashJson('<think>…</think>{"items":[{"value":10000,"count":1},{"value":1000,"count":2}],"total":12000,"confident":true,"note":""}', "JPY");
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.total, 12000); assert.equal(r.confident, true); }
  const bad = parseCashJson('{"items":[{"value":10000,"count":1}],"total":20000,"confident":true}', "JPY");
  assert.ok(bad.ok && !bad.confident);
});

test("ドルは小数の額面をセントで持ち、$60 受け取りで $49.99 の料金なら おつり $10.01", () => {
  const r = parseCashJson('{"items":[{"value":20,"count":3}],"total":60,"confident":true,"note":""}', "USD");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.total, 6000);
  const { change, short } = cashChange(4999, r.total);
  assert.equal(change, 1001); assert.equal(short, 0);
  const text = spokenCash(r, 4999, "USD", "en");
  assert.ok(text.includes("$10.01") && text.includes("Nothing has been recorded"), text);
});

test("お金が写っていない・壊れた返事は ok: false", () => {
  assert.deepEqual(parseCashJson('{"items":[],"total":0,"confident":false}', "JPY"), { ok: false, error: "no_cash" });
  assert.deepEqual(parseCashJson("うまく読めません", "JPY"), { ok: false, error: "unreadable" });
});

test("読み上げ文（日本語）に合計・料金・おつり・注意書きが入る", () => {
  const r = parseCashJson('{"items":[{"value":10000,"count":1}],"total":10000,"confident":true}', "JPY");
  assert.ok(r.ok);
  if (!r.ok) return;
  const text = spokenCash(r, 6000, "JPY", "ja");
  for (const s of ["¥10,000が1枚", "合計¥10,000", "料金は¥6,000", "おつりは¥4,000", "手触り", "まだ記録していません"]) assert.ok(text.includes(s), text);
  const shortText = spokenCash(r, 12000, "JPY", "ja");
  assert.ok(shortText.includes("¥2,000足りません"), shortText);
});
