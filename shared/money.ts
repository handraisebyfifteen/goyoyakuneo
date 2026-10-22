/**
 * お金の道具。内部は「最小単位の整数」、外には { amount, display } で渡す。
 */
export const ZERO_DECIMAL = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "UGX", "PYG", "XAF", "XOF", "XPF",
  "BIF", "DJF", "GNF", "KMF", "MGA", "RWF", "VUV",
]);

export type Money = { amount: number; display: string; currency: string };

export function decimalsOf(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** 普通の金額 → 最小単位の整数（5000円→5000、49.99ドル→4999）。浮動小数の誤差を避けるため文字列で扱う */
export function toMinor(amount: number | string, currency: string): number {
  const s = String(amount).trim().replace(/[,，]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${amount}`);
  const n = decimalsOf(currency);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const fracPadded = (frac + "0".repeat(n + 1)).slice(0, n + 1);
  let minor = parseInt(whole, 10) * 10 ** n + parseInt(fracPadded.slice(0, n) || "0", 10);
  if (parseInt(fracPadded[n] || "0", 10) >= 5) minor += 1; // 四捨五入
  return neg ? -minor : minor;
}

export function toMajor(minor: number, currency: string): number {
  const n = decimalsOf(currency);
  return n === 0 ? minor : Number((minor / 10 ** n).toFixed(n));
}

export function formatMoney(minor: number, currency: string, lang: string = "ja"): string {
  const locale = lang === "ja" ? "ja-JP" : "en-US";
  try {
    // 日本語ロケールは全角の「￥」を返すので、読みやすい半角の「¥」にそろえる
    return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(toMajor(minor, currency)).replace("￥", "¥");
  } catch {
    return `${toMajor(minor, currency)} ${currency}`;
  }
}

export function money(minor: number, currency: string, lang: string = "ja"): Money {
  return { amount: toMajor(minor, currency), display: formatMoney(minor, currency, lang), currency };
}
