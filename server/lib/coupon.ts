/**
 * クーポンの計算。AI は使わない純粋な計算。
 * コードは全角・半角、大文字・小文字の違いを気にせず扱う（「spring10」でも「ＳＰＲＩＮＧ１０」でも同じ）。
 */
import type { Coupon } from "@shared/schema";

export function normalizeCode(code: string): string {
  return code.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
}

/** 今日使えるか。だめなら理由のコード */
export function couponProblem(c: Coupon | undefined, today: string): "coupon_invalid" | "coupon_expired" | null {
  if (!c || !c.active) return "coupon_invalid";
  if (c.expiresOn && today > c.expiresOn) return "coupon_expired";
  return null;
}

/** 割り引く額（最小単位）。料金より大きくはしない */
export function discountFor(c: Pick<Coupon, "kind" | "value">, price: number): number {
  const d = c.kind === "percent" ? Math.floor((price * Math.min(Math.max(c.value, 0), 100)) / 100) : Math.max(c.value, 0);
  return Math.min(d, price);
}
