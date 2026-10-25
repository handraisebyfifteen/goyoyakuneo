/**
 * 外部のカレンダー（Google・iPhone・Outlook）に予約を映すための、購読用の iCalendar（.ics）。
 * アプリ → カレンダーの一方通行。カレンダー側で入れた予定はアプリに取り込まない。
 * URL に秘密の文字列が入っていて、知っている人だけが読める。ログインや連携の許可は要らない。
 */
import { randomBytes } from "node:crypto";
import type { Owner, Language } from "@shared/schema";
import * as storage from "./storage";
import { addDays } from "./lib/time";
import { todayFor } from "./services";

/** カレンダー用の秘密の文字列。なければ作る */
export async function calendarTokenFor(owner: Owner): Promise<string> {
  if (owner.calendarToken) return owner.calendarToken;
  const token = randomBytes(18).toString("base64url");
  await storage.updateOwner(owner.id, { calendarToken: token });
  return token;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
// 改行・カンマ・セミコロンは iCalendar の決まりで逃がす
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

/** 前後の予約と休みの枠を .ics にする（過去60日〜先1年） */
export async function calendarFeed(owner: Owner): Promise<string> {
  const lang: Language = owner.language === "en" ? "en" : "ja";
  const ja = lang === "ja";
  const today = todayFor(owner);
  const rows = await storage.listReservationsByDates(owner.id, owner.timezone, addDays(today, -60), addDays(today, 365));
  const blocked = await storage.listBlockedSlots(owner.id, new Date(Date.now() - 60 * 86400000), new Date(Date.now() + 365 * 86400000));
  const shop = storage.shopName(owner, lang) || (ja ? "ご予約ちゃん" : "GoYoyaku-chan");
  const now = stamp(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//goyoyaku-neo//ja", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${esc(shop)}`];
  for (const r of rows) {
    const v = storage.reservationView(r, owner.timezone, lang);
    const title = `${v.customerName}${ja ? "さん" : ""}${v.menuName ? ` ${v.menuName}` : ""}`;
    const desc = [v.customerPhone && `${ja ? "電話" : "Phone"}: ${v.customerPhone}`, r.customer.notes && `${ja ? "メモ" : "Notes"}: ${r.customer.notes}`].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:reservation-${r.id}@goyoyaku-neo`, `DTSTAMP:${now}`, `DTSTART:${stamp(r.startAt)}`, `DTEND:${stamp(r.endAt)}`,
      `SUMMARY:${esc(title)}`, ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []), `STATUS:${r.status === "no_show" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT");
  }
  for (const b of blocked) {
    lines.push("BEGIN:VEVENT", `UID:blocked-${b.id}@goyoyaku-neo`, `DTSTAMP:${now}`, `DTSTART:${stamp(b.startAt)}`, `DTEND:${stamp(b.endAt)}`,
      `SUMMARY:${esc(ja ? `お休み${b.reason ? `（${b.reason}）` : ""}` : `Closed${b.reason ? ` (${b.reason})` : ""}`)}`, "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
