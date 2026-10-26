/**
 * カメラで読み取った QR コードの中身を見分ける。AI は使わない純粋な計算。
 * 回数券のページ（…/t/<token>）、クーポンのリンク（…?coupon=<コード>）、クーポンのコードそのもの、のどれか
 */
import { normalizeCode } from "./coupon";

export function parseScan(text: string): { kind: "ticket"; token: string } | { kind: "coupon"; code: string } | null {
  const t = text.trim();
  const ticket = /\/t\/([A-Za-z0-9_-]{20,})/.exec(t);
  if (ticket) return { kind: "ticket", token: ticket[1] };
  const coupon = /[?&]coupon=([^&#\s]+)/.exec(t);
  if (coupon) return { kind: "coupon", code: normalizeCode(decodeURIComponent(coupon[1])) };
  if (/^[^\s/:?]{2,40}$/.test(t)) return { kind: "coupon", code: normalizeCode(t) };
  return null;
}
