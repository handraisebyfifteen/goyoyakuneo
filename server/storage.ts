/**
 * データベースの読み書き。計算は lib/ に任せ、ここは保存と取り出しだけ。
 */
import { and, asc, desc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "./db";
import {
  owners, customers, menus, reservations, blockedSlots, chatMessages, voiceSessions, emailLog,
  type Owner, type PublicOwner, type Customer, type Menu, type InsertMenu, type Reservation, type InsertReservation,
  type BlockedSlot, type Language,
} from "@shared/schema";
import { money, type Money } from "@shared/money";
import { toLocal, fromLocal, addDays } from "./lib/time";

export function publicOwner(o: Owner): PublicOwner {
  const { passwordHash, passphraseHash, ...rest } = o;
  return { ...rest, hasPassphrase: !!passphraseHash, hasPassword: !!passwordHash };
}

export function shopName(o: Pick<Owner, "shopNameJa" | "shopNameEn">, lang: Language): string {
  return (lang === "ja" ? o.shopNameJa || o.shopNameEn : o.shopNameEn || o.shopNameJa) || "";
}

// ---------- オーナー ----------

export async function getOwner(id: number): Promise<Owner | undefined> {
  return (await db.select().from(owners).where(eq(owners.id, id)))[0];
}
export async function getOwnerByEmail(email: string): Promise<Owner | undefined> {
  return (await db.select().from(owners).where(eq(owners.email, email.toLowerCase().trim())))[0];
}
export async function getOwnerBySlug(slug: string): Promise<Owner | undefined> {
  return (await db.select().from(owners).where(eq(owners.slug, slug)))[0];
}
export async function createOwner(values: typeof owners.$inferInsert): Promise<Owner> {
  return (await db.insert(owners).values(values).returning())[0];
}
export async function updateOwner(id: number, patch: Partial<typeof owners.$inferInsert>): Promise<Owner> {
  return (await db.update(owners).set(patch).where(eq(owners.id, id)).returning())[0];
}
export async function ownerHasMenusOrReservations(ownerId: number): Promise<boolean> {
  const m = await db.select({ id: menus.id }).from(menus).where(eq(menus.ownerId, ownerId)).limit(1);
  if (m.length) return true;
  const r = await db.select({ id: reservations.id }).from(reservations).where(eq(reservations.ownerId, ownerId)).limit(1);
  return r.length > 0;
}

// ---------- お客さん ----------

const HONORIFICS = ["さん", "様", "さま"];
export function cleanName(name: string): string {
  let n = (name || "").trim();
  for (const h of HONORIFICS) if (n.endsWith(h) && n.length > h.length) return n.slice(0, -h.length).trim();
  return n;
}
export function cleanPhone(phone: string): string {
  return (phone || "").normalize("NFKC").replace(/[^\d+]/g, "");
}

export async function upsertCustomer(ownerId: number, name: string, phone: string, email?: string | null): Promise<Customer> {
  const existing = (await db.select().from(customers).where(and(eq(customers.ownerId, ownerId), eq(customers.phone, phone))))[0];
  if (existing) {
    const patch: Partial<Customer> = {};
    if (name && name !== existing.name) patch.name = name;
    if (email && email !== existing.email) patch.email = email;
    if (Object.keys(patch).length) return (await db.update(customers).set(patch).where(eq(customers.id, existing.id)).returning())[0];
    return existing;
  }
  return (await db.insert(customers).values({ ownerId, name, phone, email: email || null }).returning())[0];
}

export async function findCustomersByName(ownerId: number, name: string): Promise<Customer[]> {
  return db.select().from(customers).where(and(eq(customers.ownerId, ownerId), sql`${customers.name} ILIKE ${"%" + cleanName(name) + "%"}`));
}

// ---------- メニュー ----------

export type MenuView = Omit<Menu, "price"> & { price: Money; name: string; description: string };

export function menuView(m: Menu, lang: Language): MenuView {
  return {
    ...m,
    price: money(m.price, m.currency, lang),
    name: lang === "ja" ? m.nameJa || m.nameEn : m.nameEn || m.nameJa,
    description: lang === "ja" ? m.descriptionJa || m.descriptionEn : m.descriptionEn || m.descriptionJa,
  };
}

export async function listMenus(ownerId: number, activeOnly = false): Promise<Menu[]> {
  const where = activeOnly ? and(eq(menus.ownerId, ownerId), eq(menus.active, true)) : eq(menus.ownerId, ownerId);
  return db.select().from(menus).where(where).orderBy(asc(menus.sortOrder), asc(menus.id));
}
export async function getMenu(ownerId: number, id: number): Promise<Menu | undefined> {
  return (await db.select().from(menus).where(and(eq(menus.ownerId, ownerId), eq(menus.id, id))))[0];
}
export async function findMenuByName(ownerId: number, name: string): Promise<Menu | undefined> {
  const all = await listMenus(ownerId);
  const n = name.trim().toLowerCase();
  return all.find((m) => m.nameJa.toLowerCase() === n || m.nameEn.toLowerCase() === n)
    ?? all.find((m) => m.nameJa.toLowerCase().includes(n) || m.nameEn.toLowerCase().includes(n));
}
export async function createMenu(values: InsertMenu): Promise<Menu> {
  return (await db.insert(menus).values(values).returning())[0];
}
export async function updateMenu(ownerId: number, id: number, patch: Partial<InsertMenu>): Promise<Menu | undefined> {
  return (await db.update(menus).set(patch).where(and(eq(menus.ownerId, ownerId), eq(menus.id, id))).returning())[0];
}

// ---------- 予約 ----------

export type ReservationRow = Reservation & { customer: Customer };

export type ReservationView = {
  id: number; number: string; date: string; time: string; endTime: string; startAt: string; endAt: string;
  customerName: string; customerPhone: string; customerEmail: string | null;
  menuId: number; menuName: string; menuNameJa: string; menuNameEn: string; minutes: number;
  price: Money; amountReceived: Money; currency: string;
  status: string; source: string; paymentMethod: string; paymentStatus: string;
  paymentUrl: string | null; createdAt: string; cancelledAt: string | null;
};

export function reservationView(r: ReservationRow, tz: string, lang: Language): ReservationView {
  const s = toLocal(r.startAt, tz);
  const e = toLocal(r.endAt, tz);
  return {
    id: r.id, number: r.number, date: s.date, time: s.time, endTime: e.time,
    startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(),
    customerName: r.customer.name, customerPhone: r.customer.phone, customerEmail: r.customer.email,
    menuId: r.menuId, menuName: lang === "ja" ? r.menuNameJa || r.menuNameEn : r.menuNameEn || r.menuNameJa,
    menuNameJa: r.menuNameJa, menuNameEn: r.menuNameEn, minutes: r.minutes,
    price: money(r.price, r.currency, lang), amountReceived: money(r.amountReceived, r.currency, lang), currency: r.currency,
    status: r.status, source: r.source, paymentMethod: r.paymentMethod, paymentStatus: r.paymentStatus,
    paymentUrl: r.paymentUrl, createdAt: r.createdAt.toISOString(), cancelledAt: r.cancelledAt?.toISOString() ?? null,
  };
}

function joinRows(rows: { reservations: Reservation; customers: Customer }[]): ReservationRow[] {
  return rows.map((x) => ({ ...x.reservations, customer: x.customers }));
}

export async function listReservationsBetween(ownerId: number, from: Date, to: Date, includeCancelled = false): Promise<ReservationRow[]> {
  const conds = [eq(reservations.ownerId, ownerId), gte(reservations.startAt, from), lt(reservations.startAt, to)];
  if (!includeCancelled) conds.push(ne(reservations.status, "cancelled"));
  const rows = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(...conds)).orderBy(asc(reservations.startAt));
  return joinRows(rows);
}

/** オーナーの時間帯での日付範囲（両端を含む）で取り出す */
export async function listReservationsByDates(ownerId: number, tz: string, fromDate: string, toDate: string, includeCancelled = false): Promise<ReservationRow[]> {
  return listReservationsBetween(ownerId, fromLocal(fromDate, "00:00", tz), fromLocal(addDays(toDate, 1), "00:00", tz), includeCancelled);
}

export async function listReservationsByCustomer(ownerId: number, name: string): Promise<ReservationRow[]> {
  const rows = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(eq(reservations.ownerId, ownerId), sql`${customers.name} ILIKE ${"%" + cleanName(name) + "%"}`, ne(reservations.status, "cancelled")))
    .orderBy(asc(reservations.startAt));
  return joinRows(rows);
}

export async function getReservation(ownerId: number, id: number): Promise<ReservationRow | undefined> {
  const rows = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(eq(reservations.ownerId, ownerId), eq(reservations.id, id)));
  return joinRows(rows)[0];
}

export async function getReservationByNumber(ownerId: number, number: string): Promise<ReservationRow | undefined> {
  const rows = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(eq(reservations.ownerId, ownerId), eq(reservations.number, number)));
  return joinRows(rows)[0];
}

/** お客さんの照会：予約番号＋電話番号（店舗が指定されなければ全店舗から探す） */
export async function findReservationsForLookup(number: string, phone: string, ownerId?: number): Promise<(ReservationRow & { owner: Owner })[]> {
  const conds = [eq(reservations.number, number), eq(customers.phone, phone)];
  if (ownerId) conds.push(eq(reservations.ownerId, ownerId));
  const rows = await db.select().from(reservations)
    .innerJoin(customers, eq(reservations.customerId, customers.id))
    .innerJoin(owners, eq(reservations.ownerId, owners.id))
    .where(and(...conds)).orderBy(desc(reservations.createdAt));
  return rows.map((x) => ({ ...x.reservations, customer: x.customers, owner: x.owners }));
}

export async function createReservation(values: Omit<InsertReservation, "number">): Promise<ReservationRow> {
  // 4桁の予約番号。同じ店舗で重なったら引き直す
  for (let attempt = 0; attempt < 20; attempt++) {
    const number = String(1000 + Math.floor(Math.random() * 9000));
    const dup = await db.select({ id: reservations.id }).from(reservations)
      .where(and(eq(reservations.ownerId, values.ownerId), eq(reservations.number, number))).limit(1);
    if (dup.length) continue;
    const row = (await db.insert(reservations).values({ ...values, number }).returning())[0];
    const found = await getReservation(values.ownerId, row.id);
    if (found) return found;
  }
  throw new Error("could not allocate a reservation number");
}

export async function updateReservation(ownerId: number, id: number, patch: Partial<InsertReservation>): Promise<ReservationRow | undefined> {
  await db.update(reservations).set(patch).where(and(eq(reservations.ownerId, ownerId), eq(reservations.id, id)));
  return getReservation(ownerId, id);
}

export async function getReservationByStripeSession(sessionId: string): Promise<Reservation | undefined> {
  return (await db.select().from(reservations).where(eq(reservations.stripeSessionId, sessionId)))[0];
}

// ---------- 臨時休業・休憩 ----------

export async function listBlockedSlots(ownerId: number, from?: Date, to?: Date): Promise<BlockedSlot[]> {
  const conds = [eq(blockedSlots.ownerId, ownerId)];
  if (from) conds.push(gte(blockedSlots.endAt, from));
  if (to) conds.push(lte(blockedSlots.startAt, to));
  return db.select().from(blockedSlots).where(and(...conds)).orderBy(asc(blockedSlots.startAt));
}
export async function createBlockedSlot(values: typeof blockedSlots.$inferInsert): Promise<BlockedSlot> {
  return (await db.insert(blockedSlots).values(values).returning())[0];
}
export async function deleteBlockedSlot(ownerId: number, id: number): Promise<boolean> {
  const rows = await db.delete(blockedSlots).where(and(eq(blockedSlots.ownerId, ownerId), eq(blockedSlots.id, id))).returning();
  return rows.length > 0;
}

// ---------- 会話の履歴 ----------

export async function addChatMessage(ownerId: number, role: string, content: string, model?: string) {
  return (await db.insert(chatMessages).values({ ownerId, role, content, model: model ?? null }).returning())[0];
}
export async function listChatMessages(ownerId: number, limit = 40) {
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.ownerId, ownerId)).orderBy(desc(chatMessages.id)).limit(limit);
  return rows.reverse();
}

// ---------- 合言葉の状態 ----------

export async function getVoiceSession(ownerId: number) {
  const row = (await db.select().from(voiceSessions).where(eq(voiceSessions.ownerId, ownerId)))[0];
  if (row) return row;
  return (await db.insert(voiceSessions).values({ ownerId }).returning())[0];
}
export async function updateVoiceSession(ownerId: number, patch: Partial<typeof voiceSessions.$inferInsert>) {
  return (await db.update(voiceSessions).set(patch).where(eq(voiceSessions.ownerId, ownerId)).returning())[0];
}

// ---------- メール送信数 ----------

/** 今日まだ送れるなら1通分を数えて true。上限に達していたら false */
export async function takeEmailQuota(ownerId: number, date: string, limit: number): Promise<boolean> {
  const row = (await db.insert(emailLog).values({ ownerId, date, count: 0 })
    .onConflictDoNothing().returning())[0]
    ?? (await db.select().from(emailLog).where(and(eq(emailLog.ownerId, ownerId), eq(emailLog.date, date))))[0];
  if (row.count >= limit) return false;
  await db.update(emailLog).set({ count: row.count + 1 }).where(eq(emailLog.id, row.id));
  return true;
}
