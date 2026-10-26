import { test } from "node:test";
import assert from "node:assert/strict";
import { guessCategory } from "./expense";

test("内容のことばから科目を当てる。当てられなければ雑費", () => {
  assert.equal(guessCategory("タオル代"), "supplies");
  assert.equal(guessCategory("10月の家賃"), "rent");
  assert.equal(guessCategory("電車代"), "travel");
  assert.equal(guessCategory("セミナー参加費"), "training");
  assert.equal(guessCategory("チラシ印刷"), "advertising");
  assert.equal(guessCategory("なにか"), "other");
});
