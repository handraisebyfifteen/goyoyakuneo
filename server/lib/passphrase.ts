/**
 * 合言葉とパスワードのハッシュ（scrypt）。
 * 合言葉は AI に一切渡さない。サーバーのコードが直接聞いて、ここで直接照合する。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** 音声認識の揺れを吸収する：全角→半角、小文字、カタカナ→ひらがな、空白と句読点を除く */
export function normalizePhrase(p: string): string {
  let s = (p || "").normalize("NFKC").toLowerCase();
  s = s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return s.replace(/[\s、。，．,.!?！？・ー\-_]/g, "");
}

export function hashSecret(value: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(value, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifySecret(value: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(value, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashPassphrase(p: string): string {
  return hashSecret(normalizePhrase(p));
}

export function verifyPassphrase(p: string, stored: string | null | undefined): boolean {
  return verifySecret(normalizePhrase(p), stored);
}

export function passphraseLongEnough(p: string): boolean {
  return normalizePhrase(p).length >= 4;
}
