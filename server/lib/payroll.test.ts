import { test } from "node:test";
import assert from "node:assert/strict";
import { computePay } from "./payroll";

test("時給・指名料・歩合を足す（時給は分単位で按分して四捨五入）", () => {
  assert.deepEqual(computePay({ minutes: 450, hourlyWage: 1200, nominations: 3, nominationFee: 500, sales: 60000, commissionPercent: 10 }),
    { base: 9000, nominationPay: 1500, commission: 6000, total: 16500 });
  assert.equal(computePay({ minutes: 50, hourlyWage: 1000, nominations: 0, nominationFee: 0, sales: 0, commissionPercent: 0 }).base, 833);
  assert.equal(computePay({ minutes: 0, hourlyWage: 0, nominations: 0, nominationFee: 0, sales: 999, commissionPercent: 15 }).commission, 150);
});
