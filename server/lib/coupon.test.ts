import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCode, couponProblem, discountFor } from "./coupon";
import type { Coupon } from "@shared/schema";

const base: Coupon = { id: 1, ownerId: 1, code: "SPRING10", kind: "percent", value: 10, active: true, expiresOn: "2026-11-30", createdAt: new Date() };

test("コードは全角・小文字・空白を気にしない", () => {
  assert.equal(normalizeCode(" ｓｐｒｉｎｇ １０ "), "SPRING10");
});

test("割引率と割引額。料金より大きくは割り引かない", () => {
  assert.equal(discountFor(base, 6000), 600);
  assert.equal(discountFor({ kind: "percent", value: 15 }, 999), 149);
  assert.equal(discountFor({ kind: "amount", value: 1000 }, 6000), 1000);
  assert.equal(discountFor({ kind: "amount", value: 9000 }, 6000), 6000);
});

test("止めたもの・期限切れは使えない（期限の日は使える）", () => {
  assert.equal(couponProblem(base, "2026-11-30"), null);
  assert.equal(couponProblem(base, "2026-12-01"), "coupon_expired");
  assert.equal(couponProblem({ ...base, active: false }, "2026-11-01"), "coupon_invalid");
  assert.equal(couponProblem(undefined, "2026-11-01"), "coupon_invalid");
  assert.equal(couponProblem({ ...base, expiresOn: null }, "2099-01-01"), null);
});
