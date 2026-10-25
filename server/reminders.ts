/**
 * 前日のお知らせ。すっぽかしを防ぐ。
 * - メールのあるお客さんには、前日の REMIND_FROM（オーナーの時間帯）を過ぎたら、お知らせのメールを送る
 * - メールのないお客さんには送れないので、オーナーが管理画面を開いたときに「電話してください」と伝える（ai/briefing.ts）
 * - 前日のうちに入った予約（確認メールが届いたばかり、または電話で話したばかり）は対象にしない
 * - 口コミのページが登録されていれば、来店の2時間後から2日以内に、お礼のメールに口コミのリンクを添えて送る
 * 自動で回すのは本番だけ（開発中に本物のメールを送らないため）。REMINDERS=on なら開発でも回る。
 */
import type { Owner } from "@shared/schema";
import * as storage from "./storage";
import { sendReminder, sendThanks } from "./email";
import { appBaseUrl } from "./payments";
import { nowLocal, fromLocal, addDays } from "./lib/time";

const REMIND_FROM = "10:00";
const INTERVAL_MS = 10 * 60 * 1000;

/** 明日の予約のうち、まだお知らせしていないもの */
export async function dueReminders(owner: Owner, now: Date = new Date()): Promise<storage.ReservationRow[]> {
  const today = nowLocal(owner.timezone, now).date;
  const tomorrow = addDays(today, 1);
  const startOfToday = fromLocal(today, "00:00", owner.timezone);
  const rows = await storage.listReservationsByDates(owner.id, owner.timezone, tomorrow, tomorrow);
  return rows.filter((r) => r.status === "confirmed" && !r.remindedAt && r.createdAt < startOfToday);
}

/** 来店のお礼を送る予約：終わってから2時間〜2日、来店した（無断キャンセル・取り消しでない）、まだ送っていない */
export async function dueThanks(owner: Owner, now: Date = new Date()): Promise<storage.ReservationRow[]> {
  if (!owner.reviewUrl) return [];
  const rows = await storage.listReservationsBetween(owner.id, new Date(now.getTime() - 3 * 86400000), now);
  return rows.filter((r) => (r.status === "confirmed" || r.status === "completed") && !r.thankedAt && r.customer.email
    && r.endAt.getTime() <= now.getTime() - 2 * 3600000 && r.endAt.getTime() >= now.getTime() - 2 * 86400000);
}

/** 1回分の見回り。送った件数を返す */
export async function runReminders(now: Date = new Date()): Promise<number> {
  let sent = 0;
  for (const owner of await storage.listOwners()) {
    if (nowLocal(owner.timezone, now).time < REMIND_FROM) continue;
    for (const r of await dueReminders(owner, now)) {
      if (!r.customer.email) continue;
      const note = await sendReminder(owner, r);
      if (note === "limit") break; // その日の上限。残りは送らない（オーナーへのお知らせは別にある）
      if (note === "sent" || note === "logged") {
        await storage.updateReservation(owner.id, r.id, { remindedAt: now });
        sent += 1;
      }
    }
    for (const r of await dueThanks(owner, now)) {
      const note = await sendThanks(owner, r, `${appBaseUrl()}/book/${owner.slug}`);
      if (note === "limit") break;
      if (note === "sent" || note === "logged") {
        await storage.updateReservation(owner.id, r.id, { thankedAt: now });
        sent += 1;
      }
    }
  }
  return sent;
}

export function startReminders() {
  if (process.env.NODE_ENV !== "production" && process.env.REMINDERS !== "on") return;
  const tick = () => runReminders().then((n) => { if (n) console.log(`[reminders] sent ${n}`); }).catch((e) => console.error("[reminders]", e));
  setTimeout(tick, 30_000);
  setInterval(tick, INTERVAL_MS);
}
