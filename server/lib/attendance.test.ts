import { test } from "node:test";
import assert from "node:assert/strict";
import { clockFlag, windowText, describeFlag } from "./attendance";

const plan = new Date("2026-10-26T01:00:00Z"); // 日本時間 10:00

test("予定の前後30分のうちなら予定どおり（ちょうど30分も含む）", () => {
  assert.equal(clockFlag("in", new Date("2026-10-26T00:30:00Z"), plan, 30), null);
  assert.equal(clockFlag("in", new Date("2026-10-26T01:30:00Z"), plan, 30), null);
  assert.equal(clockFlag("out", new Date("2026-10-26T01:05:00Z"), plan, 30), null);
});

test("外れたら、早い・遅いと分数の印が付く", () => {
  assert.deepEqual(clockFlag("in", new Date("2026-10-26T01:45:00Z"), plan, 30), { code: "in_late", minutes: 45 });
  assert.deepEqual(clockFlag("out", new Date("2026-10-26T00:20:00Z"), plan, 30), { code: "out_early", minutes: 40 });
  assert.deepEqual(clockFlag("in", new Date("2026-10-26T01:10:00Z"), plan, 0), { code: "in_late", minutes: 10 });
});

test("予定どおりの幅と、印の文", () => {
  assert.equal(windowText("10:00", 30), "9:30〜10:30");
  assert.equal(windowText("00:15", 30), "23:45〜0:45");
  assert.equal(describeFlag({ code: "out_late", minutes: 50 }, "ja"), "退勤が予定より50分遅い");
  assert.equal(describeFlag({ code: "no_plan" }, "en"), "no plan was set");
});
