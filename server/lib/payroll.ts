/**
 * 給与の計算。AI は使わない純粋な計算。金額はすべて最小単位の整数。
 * 給与 = 勤務時間 × 時給 ＋ 指名の件数 × 指名料 ＋ 担当した施術の売り上げ × 歩合
 */
export type PayInput = { minutes: number; hourlyWage: number; nominations: number; nominationFee: number; sales: number; commissionPercent: number };
export type PayResult = { base: number; nominationPay: number; commission: number; total: number };

export function computePay(p: PayInput): PayResult {
  const base = Math.round((p.minutes * p.hourlyWage) / 60);
  const nominationPay = p.nominations * p.nominationFee;
  const commission = Math.round((p.sales * Math.min(Math.max(p.commissionPercent, 0), 100)) / 100);
  return { base, nominationPay, commission, total: base + nominationPay + commission };
}
