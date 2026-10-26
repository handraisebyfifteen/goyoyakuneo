/**
 * 管理画面を開いたときに、最初に伝えること。AI は使わず、決まった文で速く確実に伝える。
 * - 初めてなら、仕事のパートナーとしてのあいさつ
 * - 前回から、ネットで入った新しい予約と、お客さんの取り消し（オーナーは画面を見ないので、こちらから伝える）
 * - 今日の予約の件数と、次のお客さん
 * - 明日のお客さんのうち、メールがなくてお知らせを送れない人（電話してもらう。伝えたら伝え済みにする）
 * - スタッフの打刻と予定の変更（予定どおりは件数だけ、要確認は1件ずつ）と、確認待ちの件数（attendance.ts）
 * - 最後に、まだ決まっていない設定を1つ聞く（初めてなら営業時間。答えてもらえたら続けて次を聞く。ai/setup.ts）
 * 伝えた文は会話の履歴にも残す（「その予約を取り消して」と続けて言えるように）。
 */
import type { Owner, Language } from "@shared/schema";
import * as storage from "../storage";
import { todayFor } from "../services";
import { spokenWhen, spokenTime } from "./tools";
import { MODELS } from "./llm";
import { dueReminders } from "../reminders";
import { takeSetupQuestion } from "./setup";
import { attendanceBriefing } from "../attendance";
import { followupsSince } from "../followup";

const MAX_LISTED = 3;

/** 読み上げやすいよう、電話番号を区切る（09011112222 → 090-1111-2222） */
export function spokenPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

function listOf(rows: storage.ReservationRow[], owner: Owner, lang: Language): string {
  const ja = lang === "ja";
  const items = rows.slice(0, MAX_LISTED).map((r) => {
    const v = storage.reservationView(r, owner.timezone, lang);
    return ja ? `${spokenWhen(v.date, v.time, lang)}の${v.customerName}さん` : `${v.customerName} on ${spokenWhen(v.date, v.time, lang)}`;
  });
  const rest = rows.length - items.length;
  if (rest > 0) items.push(ja ? `ほか${rest}件` : `and ${rest} more`);
  return items.join(ja ? "、" : ", ");
}

export async function briefingFor(owner: Owner, lang: Language): Promise<{ text: string; first: boolean }> {
  const ja = lang === "ja";
  const now = new Date();
  const first = !owner.lastBriefedAt;
  const parts: string[] = [];

  if (first) {
    const shop = storage.shopName(owner, lang);
    parts.push(ja
      ? `はじめまして、ご予約ちゃんです。今日から${shop ? `${shop}の` : ""}仕事のパートナーとして、予約の受付や確認、売り上げの計算、ちょっとした相談までお手伝いします。`
      : `Nice to meet you, I'm GoYoyaku-chan. From today I'm your work partner${shop ? ` at ${shop}` : ""}: I take and check bookings, add up sales, and I'm here if you want to talk things through.`);
    parts.push(ja
      ? `${owner.email ? "" : "登録はあとでかまいません。このまま使い始められます。"}たとえば「田中さん、明日の2時から3時半」と話しかけてくだされば、予約を入れます。マイクのボタンを押して、何でも話しかけてみてください。`
      : `${owner.email ? "" : "You can register later and start right away. "}For example, say "Tanaka, tomorrow from 2 to 3:30" and I will book it. Press the microphone button and try saying anything.`);
  } else {
    const { booked, cancelled, moved } = await storage.listChangesSince(owner.id, owner.lastBriefedAt!);
    if (booked.length) parts.push(ja
      ? `前回から、ネットで新しい予約が${booked.length}件入りました。${listOf(booked, owner, lang)}です。`
      : `Since last time, ${booked.length} new online booking${booked.length > 1 ? "s" : ""}: ${listOf(booked, owner, lang)}.`);
    if (moved.length) parts.push(ja
      ? `お客さんが日時を変えた予約が${moved.length}件あります。新しい日時は、${listOf(moved, owner, lang)}です。`
      : `${moved.length} booking${moved.length > 1 ? "s were" : " was"} moved by customers. New times: ${listOf(moved, owner, lang)}.`);
    if (cancelled.length) parts.push(ja
      ? `お客さんの取り消しが${cancelled.length}件ありました。${listOf(cancelled, owner, lang)}です。`
      : `${cancelled.length} cancellation${cancelled.length > 1 ? "s" : ""} by customers: ${listOf(cancelled, owner, lang)}.`);

    const today = todayFor(owner);
    const rows = await storage.listReservationsByDates(owner.id, owner.timezone, today, today);
    const next = rows.find((r) => r.endAt.getTime() > now.getTime());
    if (!rows.length) parts.push(ja ? "今日の予約はありません。" : "No bookings today.");
    else {
      const v = next ? storage.reservationView(next, owner.timezone, lang) : null;
      // 次のお客さんのメモがあれば、最後の1行だけ添える（施術の前に思い出せるように）
      const note = next?.customer.notes.split("\n").pop()?.replace(/^\d{4}-\d{2}-\d{2}\s*/, "") ?? "";
      parts.push(ja
        ? `今日の予約は${rows.length}件です。${v ? `次は${spokenTime(v.time)}から${v.customerName}さんです。${note ? `メモ：${note}。` : ""}` : "今日の予約はすべて終わっています。"}`
        : `${rows.length} booking${rows.length > 1 ? "s" : ""} today. ${v ? `Next is ${v.customerName} at ${v.time}.${note ? ` Note: ${note}.` : ""}` : "All of today's bookings are done."}`);
    }
  }

  if (!first) {
    const noEmail = (await dueReminders(owner, now)).filter((r) => !r.customer.email);
    if (noEmail.length) {
      const items = noEmail.map((r) => {
        const v = storage.reservationView(r, owner.timezone, lang);
        const tel = v.customerPhone ? (ja ? `、電話は${spokenPhone(v.customerPhone)}` : `, phone ${spokenPhone(v.customerPhone)}`) : "";
        return ja ? `${v.customerName}さん（${spokenTime(v.time)}${tel}）` : `${v.customerName} (${v.time}${tel})`;
      });
      parts.push(ja
        ? `明日のお客さんのうち、メールのない方が${noEmail.length}人います。${items.join("、")}。お電話でお知らせしてください。`
        : `${noEmail.length} of tomorrow's customers have no email: ${items.join(", ")}. Please give them a call.`);
      for (const r of noEmail) await storage.updateReservation(owner.id, r.id, { remindedAt: now });
    }
  }

  if (!first) {
    const att = await attendanceBriefing(owner, lang, now);
    if (att) parts.push(att);
    const f = await followupsSince(owner, owner.lastBriefedAt!);
    if (f) parts.push(ja ? `前回から、${f}人のお客さんに次回の声かけのメールを送りました。` : `Since last time, I sent next-visit suggestions to ${f} customer${f > 1 ? "s" : ""}.`);
  }

  const question = await takeSetupQuestion(owner, lang, todayFor(owner));
  if (question) parts.push((first ? (ja ? "さっそくですが、" : "To start, ") : (ja ? "ところで、" : "By the way, ")) + (ja ? question : question.charAt(0).toLowerCase() + question.slice(1)));

  const text = parts.join(ja ? "" : " ");
  await storage.updateOwner(owner.id, { lastBriefedAt: now });
  await storage.addChatMessage(owner.id, "assistant", text, MODELS.fast);
  return { text, first };
}
