/**
 * 予約を入れられるかの判定と、空き時間の計算。AI は使わない純粋な計算。
 * 営業時間・定休日・臨時休業・他の予約との重なり（施術間の空き時間を含む）をコードで守る。
 */
import type { BusinessHours } from "@shared/schema";
import { WEEKDAY_LABELS, type ErrorCode } from "@shared/i18n";
import { fromLocal, nowLocal, timeToMinutes, minutesToTime, weekdayOf, addDays, toLocal, isValidDate, isValidTime } from "./time";

export class BookingError extends Error {
  constructor(public code: ErrorCode, public params: Record<string, string | number> = {}, public status = 400) {
    super(code);
  }
}

export type BookingSettings = {
  timezone: string;
  language: string;
  hours: BusinessHours;
  bufferMinutes: number;
  slotStepMinutes: number;
  maxDaysAhead: number;
  minHoursBefore: number;
};

/** 重なりの判定に使う枠。staffId はスタッフのいる店で、その枠が誰のものか（null ならお店全体） */
export type Busy = { id: number; startAt: Date; endAt: Date; label: string; staffId?: number | null };

export type CheckInput = {
  settings: BookingSettings;
  date: string;
  time: string;
  minutes: number;
  reservations: Busy[]; // 取り消し済みは除いて渡す
  blocked: Busy[];
  source: "web" | "owner";
  ignoreId?: number;
  now?: Date;
};

function weekdayLabel(date: string, lang: string): string {
  const idx = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(weekdayOf(date));
  return (WEEKDAY_LABELS[lang === "en" ? "en" : "ja"] ?? WEEKDAY_LABELS.ja)[idx];
}

/** その日時に予約を入れられるか。だめなら理由つきで止める */
export function checkBookable(input: CheckInput): { startAt: Date; endAt: Date } {
  const { settings: s, date, time, minutes, source } = input;
  const now = input.now ?? new Date();
  if (!isValidDate(date)) throw new BookingError("invalid_date");
  if (!isValidTime(time)) throw new BookingError("invalid_time");

  const hours = s.hours[weekdayOf(date)];
  const weekday = weekdayLabel(date, s.language);
  if (!hours) throw new BookingError("closed_day", { date, weekday });

  const startMin = timeToMinutes(time);
  const endMin = startMin + minutes;
  if (startMin < timeToMinutes(hours.open) || endMin > timeToMinutes(hours.close)) {
    throw new BookingError("outside_hours", { weekday, open: hours.open, close: hours.close });
  }

  const startAt = fromLocal(date, time, s.timezone);
  const endAt = new Date(startAt.getTime() + minutes * 60000);
  if (startAt.getTime() < now.getTime()) throw new BookingError("past_time");

  if (source === "web") {
    if (startAt.getTime() < now.getTime() + s.minHoursBefore * 3600000) {
      throw new BookingError("too_soon", { hours: s.minHoursBefore });
    }
    const today = nowLocal(s.timezone, now).date;
    if (date > addDays(today, s.maxDaysAhead)) throw new BookingError("too_far", { days: s.maxDaysAhead });
  }

  // 臨時休業・休憩の枠と重なっていないか（空き時間は入れない）
  for (const b of input.blocked) {
    if (startAt < b.endAt && b.startAt < endAt) {
      throw new BookingError("day_off", { date: `${toLocal(b.startAt, s.timezone).date} ${toLocal(b.startAt, s.timezone).time}` });
    }
  }

  const gap = s.bufferMinutes * 60000;
  for (const r of input.reservations) {
    if (r.id === input.ignoreId) continue;
    if (startAt.getTime() < r.endAt.getTime() + gap && r.startAt.getTime() < endAt.getTime() + gap) {
      throw new BookingError("overlap", {
        time: toLocal(r.startAt, s.timezone).time, name: r.label, buffer: s.bufferMinutes,
      });
    }
  }
  return { startAt, endAt };
}

export type SlotsInput = Omit<CheckInput, "time" | "ignoreId">;

/** その日に、その所要時間で予約できる開始時刻の一覧 */
export function availableSlots(input: SlotsInput): { slots: string[]; closed: boolean } {
  const { settings: s, date } = input;
  if (!isValidDate(date)) throw new BookingError("invalid_date");
  const hours = s.hours[weekdayOf(date)];
  if (!hours) return { slots: [], closed: true };
  const slots: string[] = [];
  const close = timeToMinutes(hours.close);
  for (let t = timeToMinutes(hours.open); t + input.minutes <= close; t += s.slotStepMinutes) {
    try {
      checkBookable({ ...input, time: minutesToTime(t) });
      slots.push(minutesToTime(t));
    } catch (e) {
      if (!(e instanceof BookingError)) throw e;
    }
  }
  return { slots, closed: false };
}

/** キャンセルの決まりで返金の対象か（支払い済みのカード予約のみ意味がある） */
export function refundEligible(startAt: Date, freeCancelHoursBefore: number, now: Date = new Date()): boolean {
  return startAt.getTime() - now.getTime() >= freeCancelHoursBefore * 3600000;
}
