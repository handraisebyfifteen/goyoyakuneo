/**
 * 打刻が予定どおりかの判定。AI は使わない純粋な計算。
 * 予定の前後 tolerance 分のうちに打刻すれば「予定どおり」。外れた分は印（flag）を付けて、オーナーの確認に回す。
 */
import type { AttendanceFlag, Language } from "@shared/schema";

/** 予定の時刻と実際の打刻を比べる。外れていれば印、内なら null */
export function clockFlag(kind: "in" | "out", at: Date, planned: Date, tolerance: number): AttendanceFlag | null {
  const diff = Math.round((at.getTime() - planned.getTime()) / 60000);
  if (Math.abs(diff) <= tolerance) return null;
  return { code: `${kind}_${diff < 0 ? "early" : "late"}` as AttendanceFlag["code"], minutes: Math.abs(diff) };
}

/** 予定どおりの時間の幅（「9:30〜10:30」）。24:00 を越えたら翌日の時刻のまま書く */
export function windowText(time: string, tolerance: number): string {
  const [h, m] = time.split(":").map(Number);
  const fmt = (n: number) => { const x = ((n % 1440) + 1440) % 1440; return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`; };
  const base = h * 60 + m;
  return `${fmt(base - tolerance)}〜${fmt(base + tolerance)}`;
}

/** 印を読み上げ向けの文に */
export function describeFlag(f: AttendanceFlag, lang: Language): string {
  const ja = lang === "ja";
  const n = f.minutes ?? 0;
  switch (f.code) {
    case "no_plan": return ja ? "予定が登録されていない" : "no plan was set";
    case "plan_changed": return ja ? "その日に予定を変えた" : "the plan was changed on the day";
    case "in_early": return ja ? `出勤が予定より${n}分早い` : `clocked in ${n} min early`;
    case "in_late": return ja ? `出勤が予定より${n}分遅い` : `clocked in ${n} min late`;
    case "out_early": return ja ? `退勤が予定より${n}分早い` : `clocked out ${n} min early`;
    case "out_late": return ja ? `退勤が予定より${n}分遅い` : `clocked out ${n} min late`;
  }
}
