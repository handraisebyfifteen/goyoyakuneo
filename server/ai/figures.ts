/**
 * 相談役（ask_advisor）に渡す、お店の数字。回数券やクーポン、値決めの相談に答えられるよう、
 * メニューの料金、お客さんの来店の回数と間隔、取り消し・無断キャンセルの割合、月ごとの売り上げ、
 * 今の券の種類とクーポンの使われ方をまとめる。名前や連絡先は渡さない。
 */
import type { Owner, Language } from "@shared/schema";
import { money } from "@shared/money";
import * as storage from "../storage";
import { salesSummaryFor, todayFor } from "../services";
import { addDays, monthRange } from "../lib/time";

const DAYS = 180;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export async function shopFigures(owner: Owner, lang: Language) {
  const today = todayFor(owner);
  const cur = owner.currency;
  const now = Date.now();
  const rows = await storage.listReservationsByDates(owner.id, owner.timezone, addDays(today, -DAYS), today, true);
  const past = rows.filter((r) => r.endAt.getTime() <= now);
  const visits = past.filter((r) => r.status === "confirmed" || r.status === "completed");

  // お客さんごとの来店の回数と、来店と来店のあいだの日数
  const byCustomer = new Map<number, number[]>();
  for (const r of visits) byCustomer.set(r.customerId, [...(byCustomer.get(r.customerId) ?? []), r.startAt.getTime()]);
  const intervals: number[] = [];
  for (const ts of Array.from(byCustomer.values())) for (let i = 1; i < ts.length; i++) intervals.push(Math.round((ts[i] - ts[i - 1]) / 86400000));
  const counts = Array.from(byCustomer.values()).map((ts) => ts.length);

  // 直近3か月の売り上げ
  const months: { month: string; total: string; bookings: number }[] = [];
  let m = today;
  for (let i = 0; i < 3; i++) {
    const r = monthRange(m);
    const s = await salesSummaryFor(owner, r.from, r.to, lang);
    months.push({ month: r.from.slice(0, 7), total: s.total.display, bookings: s.reservationCount });
    m = addDays(r.from, -1);
  }

  const menus = await storage.listMenus(owner.id, true);
  const types = await storage.listTicketTypes(owner.id);
  const tickets = await storage.listTickets(owner.id);
  const coupons = await storage.listCoupons(owner.id);
  const menuName = (id: number | null) => (id ? menus.find((x) => x.id === id) : undefined);

  // 数字の読み違いを防ぐため、要点をそのまま引用できる文にしておく
  const ja = lang === "ja";
  const repeaters = counts.filter((n) => n >= 2).length;
  const mid = median(intervals);
  const summary = ja
    ? `直近3か月の売り上げは、${months.map((x) => `${Number(x.month.slice(5))}月が${x.total}（${x.bookings}件）`).join("、")}。過去${DAYS}日に来店したお客さんは${byCustomer.size}人で、そのうち2回以上来た人は${repeaters}人。${mid !== null ? `来店と来店の間はおよそ${mid}日。` : "来店の間隔はまだわかりません。"}`
    : `Sales for the last three months: ${months.map((x) => `${x.month} ${x.total} (${x.bookings} bookings)`).join(", ")}. ${byCustomer.size} customers visited in the last ${DAYS} days, ${repeaters} of them more than once. ${mid !== null ? `About ${mid} days between visits.` : "Not enough visits to know the interval yet."}`;

  return {
    summary,
    period: `${addDays(today, -DAYS)}〜${today}`,
    menus: menus.map((x) => { const v = storage.menuView(x, lang); return { name: v.name, minutes: v.minutes, price: v.price.display }; }),
    customers: {
      withVisits: byCustomer.size,
      repeaters: counts.filter((n) => n >= 2).length,
      averageVisits: counts.length ? Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10 : null,
      medianDaysBetweenVisits: median(intervals),
    },
    visits: visits.length,
    cancelRate: past.length ? Math.round((past.filter((r) => r.status === "cancelled").length / past.length) * 100) : null,
    noShowRate: past.length ? Math.round((past.filter((r) => r.status === "no_show").length / past.length) * 100) : null,
    salesByMonth: months,
    ticketTypes: types.map((t) => ({
      name: t.name, kind: t.kind, active: t.active, menu: menuName(t.menuId) ? storage.menuView(menuName(t.menuId)!, lang).name : null,
      size: t.kind === "count" ? `${t.total}` : money(t.total, cur, lang).display, price: money(t.price, cur, lang).display, validDays: t.validDays,
      sold: tickets.filter((x) => x.typeId === t.id).length,
    })),
    ticketsInUse: tickets.filter((x) => x.active && x.remaining > 0 && (!x.expiresOn || today <= x.expiresOn)).length,
    coupons: coupons.map((c) => ({
      code: c.code, off: c.kind === "percent" ? `${c.value}%` : money(c.value, cur, lang).display, expiresOn: c.expiresOn, active: c.active,
      used: rows.filter((r) => r.couponCode === c.code && r.status !== "cancelled").length,
    })),
  };
}
