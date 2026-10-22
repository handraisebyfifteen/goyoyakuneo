/**
 * 時間の道具。サーバーの時計は UTC なので、「今日」「明日」はオーナーの時間帯で計算する。
 * 外部ライブラリを使わず Intl だけで時間帯を扱う。
 */
import { WEEKDAY_KEYS, type WeekdayKey } from "@shared/schema";

export type LocalClock = { date: string; time: string; weekday: WeekdayKey; minutes: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

function parts(d: Date, tz: string) {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(tz).formatToParts(d)) if (type !== "literal") p[type] = parseInt(value, 10);
  return p;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** UTC の瞬間 → オーナーの時間帯での日付・時刻 */
export function toLocal(d: Date, tz: string): LocalClock {
  const p = parts(d, tz);
  const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  const hour = p.hour === 24 ? 0 : p.hour;
  return { date, time: `${pad2(hour)}:${pad2(p.minute)}`, weekday: weekdayOf(date), minutes: hour * 60 + p.minute };
}

export function nowLocal(tz: string, now: Date = new Date()): LocalClock {
  return toLocal(now, tz);
}

/** 時間帯のオフセット（分）。その瞬間に、壁時計が UTC からどれだけずれているか */
function offsetMinutes(d: Date, tz: string): number {
  const p = parts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** オーナーの時間帯での日付・時刻 → UTC の瞬間（夏時間の切り替えも Intl に任せる） */
export function fromLocal(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - offsetMinutes(new Date(guess), tz) * 60000;
  result = guess - offsetMinutes(new Date(result), tz) * 60000;
  return new Date(result);
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function weekdayOf(date: string): WeekdayKey {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return WEEKDAY_KEYS[(js + 6) % 7];
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(n: number): string {
  return `${pad2(Math.floor(n / 60))}:${pad2(n % 60)}`;
}

/** 月の初日と末日 */
export function monthRange(date: string): { from: string; to: string } {
  const [y, m] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(last)}` };
}
