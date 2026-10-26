import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScan } from "./scan";

test("回数券のページ、クーポンのリンク、クーポンのコードを見分ける", () => {
  assert.deepEqual(parseScan("https://example.com/t/AbCdEfGhIjKlMnOpQrStUvWx"), { kind: "ticket", token: "AbCdEfGhIjKlMnOpQrStUvWx" });
  assert.deepEqual(parseScan("https://example.com/book/shop-1?coupon=spring10"), { kind: "coupon", code: "SPRING10" });
  assert.deepEqual(parseScan("https://example.com/book/shop-1?coupon=%E5%88%9D%E5%9B%9E500"), { kind: "coupon", code: "初回500" });
  assert.deepEqual(parseScan(" ｓｐｒｉｎｇ１０ "), { kind: "coupon", code: "SPRING10" });
  assert.equal(parseScan("https://example.com/some/page"), null);
  assert.equal(parseScan("https://example.com/t/short"), null);
});
