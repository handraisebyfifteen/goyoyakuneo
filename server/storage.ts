/**
 * データベースの読み書き。計算は lib/ に任せ、ここは保存と取り出しだけ。
 */
import { and, asc, desc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "./db";
import {
  owners, customers, menus, reservations, blockedSlots, chatMessages, voiceSessions, emailLog, coupons, staff, timeEntries, shopGroups, shifts, attendanceEvents,
  type Owner, type PublicOwner, type Customer, type Menu, type InsertMenu, type Reservation, type InsertReservation,
  type BlockedSlot, type Language, type Coupon, type Staff, type PublicStaff, type TimeEntry, type ShopGroup, type Shift, type AttendanceEvent,
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
export async function getOwnerByCalendarToken(token: string): Promise<Owner | undefined> {
  return (await db.select().from(owners).where(eq(owners.calendarToken, token)))[0];
}
export async function createOwner(values: typeof owners.$inferInsert): Promise<Owner> {
  return (await db.insert(owners).values(values).returning())[0];
}
export async function updateOwner(id: number, patch: Partial<typeof owners.$inferInsert>): Promise<Owner> {
  return (await db.update(owners).set(patch).where(eq(owners.id, id)).returning())[0];
}
export async function listOwners(): Promise<Owner[]> {
  return db.select().from(owners).orderBy(asc(owners.id));
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

/**
 * 同じお客さんを探して使う。なければ作る。
 * 電話番号があれば電話番号で探す。なければ名前で探す（電話番号なしの人を全員ひとりにまとめないため）。
 * 電話番号なしで記録した人に、あとから電話番号つきの予約が来たら、その人に電話番号を足す。
 */
export async function upsertCustomer(ownerId: number, name: string, phone: string, email?: string | null): Promise<Customer> {
  const byName = async (onlyWithoutPhone: boolean) => (await db.select().from(customers)
    .where(and(eq(customers.ownerId, ownerId), eq(customers.name, name), ...(onlyWithoutPhone ? [eq(customers.phone, "")] : [])))
    .orderBy(desc(customers.id)))[0];
  const byPhone = phone ? (await db.select().from(customers).where(and(eq(customers.ownerId, ownerId), eq(customers.phone, phone))))[0] : undefined;
  const existing = phone ? byPhone ?? (await byName(true)) : await byName(false);
  if (existing) {
    const patch: Partial<Customer> = {};
    if (phone && !existing.phone) patch.phone = phone;
    if (name && name !== existing.name) patch.name = name;
    if (email && email !== existing.email) patch.email = email;
    if (Object.keys(patch).length) return (await db.update(customers).set(patch).where(eq(customers.id, existing.id)).returning())[0];
    return existing;
  }
  return (await db.insert(customers).values({ ownerId, name, phone, email: email || null }).returning())[0];
}

export async function getCustomer(ownerId: number, id: number): Promise<Customer | undefined> {
  return (await db.select().from(customers).where(and(eq(customers.ownerId, ownerId), eq(customers.id, id))))[0];
}
export async function updateCustomer(ownerId: number, id: number, patch: Partial<Pick<Customer, "name" | "phone" | "email" | "notes">>): Promise<Customer | undefined> {
  return (await db.update(customers).set(patch).where(and(eq(customers.ownerId, ownerId), eq(customers.id, id))).returning())[0];
}
/** そのお客さんの予約すべて（取り消しも含む、古い順） */
export async function listReservationsOfCustomer(ownerId: number, customerId: number): Promise<ReservationRow[]> {
  const rows = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(eq(reservations.ownerId, ownerId), eq(reservations.customerId, customerId))).orderBy(asc(reservations.startAt));
  return joinRows(rows);
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

// ---------- スタッフ ----------

export function publicStaff(s: Staff): PublicStaff {
  const { passwordHash, inviteToken, ...rest } = s;
  return { ...rest, canLogin: !!passwordHash, invited: !!inviteToken && !passwordHash };
}
export async function listStaff(ownerId: number): Promise<Staff[]> {
  return db.select().from(staff).where(eq(staff.ownerId, ownerId)).orderBy(asc(staff.sortOrder), asc(staff.id));
}
export async function getStaff(ownerId: number, id: number): Promise<Staff | undefined> {
  return (await db.select().from(staff).where(and(eq(staff.ownerId, ownerId), eq(staff.id, id))))[0];
}
export async function getStaffById(id: number): Promise<Staff | undefined> {
  return (await db.select().from(staff).where(eq(staff.id, id)))[0];
}
export async function getStaffByEmail(email: string): Promise<Staff | undefined> {
  return (await db.select().from(staff).where(eq(staff.email, email.toLowerCase().trim())))[0];
}
export async function getStaffByInvite(token: string): Promise<Staff | undefined> {
  return (await db.select().from(staff).where(eq(staff.inviteToken, token)))[0];
}
export async function findStaffByName(ownerId: number, name: string): Promise<Staff | undefined> {
  const n = cleanName(name).toLowerCase();
  const all = (await listStaff(ownerId)).filter((s) => s.active);
  return all.find((s) => s.name.toLowerCase() === n) ?? all.find((s) => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()));
}
export async function createStaff(values: typeof staff.$inferInsert): Promise<Staff> {
  return (await db.insert(staff).values(values).returning())[0];
}
export async function updateStaff(ownerId: number, id: number, patch: Partial<typeof staff.$inferInsert>): Promise<Staff | undefined> {
  return (await db.update(staff).set(patch).where(and(eq(staff.ownerId, ownerId), eq(staff.id, id))).returning())[0];
}
/** 担当の決まっていない予約を、そのスタッフに割り当てる（スタッフを初めて登録したとき） */
export async function assignUnstaffedReservations(ownerId: number, staffId: number, staffName: string) {
  await db.update(reservations).set({ staffId, staffName }).where(and(eq(reservations.ownerId, ownerId), sql`${reservations.staffId} IS NULL`));
}
/** スタッフの名前を変えたら、今後の予約の担当名も変える */
export async function renameStaffOnReservations(ownerId: number, staffId: number, staffName: string) {
  await db.update(reservations).set({ staffName }).where(and(eq(reservations.ownerId, ownerId), eq(reservations.staffId, staffId), gte(reservations.startAt, new Date())));
}

// ---------- 打刻 ----------

export async function openTimeEntry(staffId: number): Promise<TimeEntry | undefined> {
  return (await db.select().from(timeEntries).where(and(eq(timeEntries.staffId, staffId), sql`${timeEntries.clockOut} IS NULL`)).orderBy(desc(timeEntries.clockIn)).limit(1))[0];
}
export async function createTimeEntry(values: typeof timeEntries.$inferInsert): Promise<TimeEntry> {
  return (await db.insert(timeEntries).values(values).returning())[0];
}
export async function updateTimeEntry(ownerId: number, id: number, patch: Partial<typeof timeEntries.$inferInsert>): Promise<TimeEntry | undefined> {
  return (await db.update(timeEntries).set(patch).where(and(eq(timeEntries.ownerId, ownerId), eq(timeEntries.id, id))).returning())[0];
}
export async function getTimeEntry(ownerId: number, id: number): Promise<TimeEntry | undefined> {
  return (await db.select().from(timeEntries).where(and(eq(timeEntries.ownerId, ownerId), eq(timeEntries.id, id))))[0];
}
/** オーナーがまだ確認していない打刻（古い順） */
export async function listUnconfirmedEntries(ownerId: number): Promise<TimeEntry[]> {
  return db.select().from(timeEntries).where(and(eq(timeEntries.ownerId, ownerId), sql`${timeEntries.confirmedAt} IS NULL`)).orderBy(asc(timeEntries.clockIn));
}

// ---------- 勤務の予定 ----------

export async function getShift(staffId: number, date: string): Promise<Shift | undefined> {
  return (await db.select().from(shifts).where(and(eq(shifts.staffId, staffId), eq(shifts.date, date))))[0];
}
export async function getShiftById(id: number): Promise<Shift | undefined> {
  return (await db.select().from(shifts).where(eq(shifts.id, id)))[0];
}
export async function listShifts(staffId: number, from: string, to: string): Promise<Shift[]> {
  return db.select().from(shifts).where(and(eq(shifts.staffId, staffId), gte(shifts.date, from), lte(shifts.date, to))).orderBy(asc(shifts.date));
}
export async function createShift(values: typeof shifts.$inferInsert): Promise<Shift> {
  return (await db.insert(shifts).values(values).returning())[0];
}
export async function updateShift(id: number, patch: Partial<typeof shifts.$inferInsert>): Promise<Shift> {
  return (await db.update(shifts).set(patch).where(eq(shifts.id, id)).returning())[0];
}

// ---------- 勤怠のお知らせ ----------

export async function addAttendanceEvent(values: typeof attendanceEvents.$inferInsert): Promise<AttendanceEvent> {
  return (await db.insert(attendanceEvents).values(values).returning())[0];
}
/** まだオーナーに伝えていないお知らせ（古い順） */
export async function listUnnotifiedEvents(ownerId: number): Promise<AttendanceEvent[]> {
  return db.select().from(attendanceEvents).where(and(eq(attendanceEvents.ownerId, ownerId), sql`${attendanceEvents.notifiedAt} IS NULL`)).orderBy(asc(attendanceEvents.at));
}
export async function markEventsNotified(ownerId: number, ids: number[], at: Date) {
  if (!ids.length) return;
  await db.update(attendanceEvents).set({ notifiedAt: at }).where(and(eq(attendanceEvents.ownerId, ownerId), sql`${attendanceEvents.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
}
export async function listRecentEvents(ownerId: number, limit = 20): Promise<AttendanceEvent[]> {
  return db.select().from(attendanceEvents).where(eq(attendanceEvents.ownerId, ownerId)).orderBy(desc(attendanceEvents.at)).limit(limit);
}
/** 期間に出勤した打刻（店全体、またはひとりのスタッフ） */
export async function listTimeEntries(ownerId: number, from: Date, to: Date, staffId?: number): Promise<TimeEntry[]> {
  const conds = [eq(timeEntries.ownerId, ownerId), gte(timeEntries.clockIn, from), lt(timeEntries.clockIn, to)];
  if (staffId) conds.push(eq(timeEntries.staffId, staffId));
  return db.select().from(timeEntries).where(and(...conds)).orderBy(asc(timeEntries.clockIn));
}

// ---------- 店舗グループ ----------

export async function createShopGroup(values: typeof shopGroups.$inferInsert): Promise<ShopGroup> {
  return (await db.insert(shopGroups).values(values).returning())[0];
}
export async function getShopGroup(id: number): Promise<ShopGroup | undefined> {
  return (await db.select().from(shopGroups).where(eq(shopGroups.id, id)))[0];
}
export async function getShopGroupByCode(code: string): Promise<ShopGroup | undefined> {
  return (await db.select().from(shopGroups).where(eq(shopGroups.joinCode, code)))[0];
}
export async function listGroupOwners(groupId: number): Promise<Owner[]> {
  return db.select().from(owners).where(eq(owners.groupId, groupId)).orderBy(asc(owners.id));
}

// ---------- クーポン ----------

export async function listCoupons(ownerId: number): Promise<Coupon[]> {
  return db.select().from(coupons).where(eq(coupons.ownerId, ownerId)).orderBy(asc(coupons.id));
}
export async function getCouponByCode(ownerId: number, code: string): Promise<Coupon | undefined> {
  return (await db.select().from(coupons).where(and(eq(coupons.ownerId, ownerId), eq(coupons.code, code))))[0];
}
export async function createCoupon(values: typeof coupons.$inferInsert): Promise<Coupon> {
  return (await db.insert(coupons).values(values).returning())[0];
}
export async function updateCoupon(ownerId: number, id: number, patch: Partial<typeof coupons.$inferInsert>): Promise<Coupon | undefined> {
  return (await db.update(coupons).set(patch).where(and(eq(coupons.ownerId, ownerId), eq(coupons.id, id))).returning())[0];
}

// ---------- 予約 ----------

export type ReservationRow = Reservation & { customer: Customer };

export type ReservationView = {
  id: number; number: string; date: string; time: string; endTime: string; startAt: string; endAt: string;
  customerName: string; customerPhone: string; customerEmail: string | null;
  /** メニューなしの予約は menuId と price が null（料金は受け取ったときに決まる） */
  menuId: number | null; menuName: string; menuNameJa: string; menuNameEn: string; minutes: number;
  price: Money | null; amountReceived: Money; currency: string;
  status: string; source: string; paymentMethod: string; paymentStatus: string;
  paymentUrl: string | null; createdAt: string; cancelledAt: string | null;
  couponCode: string | null; discount: Money | null;
  staffId: number | null; staffName: string; nominated: boolean;
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
    price: r.menuId === null && r.paymentStatus === "onsite_pending" ? null : money(r.price, r.currency, lang), amountReceived: money(r.amountReceived, r.currency, lang), currency: r.currency,
    status: r.status, source: r.source, paymentMethod: r.paymentMethod, paymentStatus: r.paymentStatus,
    paymentUrl: r.paymentUrl, createdAt: r.createdAt.toISOString(), cancelledAt: r.cancelledAt?.toISOString() ?? null,
    couponCode: r.couponCode, discount: r.discount ? money(r.discount, r.currency, lang) : null,
    staffId: r.staffId, staffName: r.staffName, nominated: r.nominated,
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

/** ある時刻より後に、ネットから入った予約と、お客さんが取り消した予約・日時を変えた予約 */
export async function listChangesSince(ownerId: number, since: Date): Promise<{ booked: ReservationRow[]; cancelled: ReservationRow[]; moved: ReservationRow[] }> {
  const booked = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(eq(reservations.ownerId, ownerId), eq(reservations.source, "web"), gte(reservations.createdAt, since), ne(reservations.status, "cancelled")))
    .orderBy(asc(reservations.startAt));
  const cancelled = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(eq(reservations.ownerId, ownerId), eq(reservations.cancelledBy, "customer"), gte(reservations.cancelledAt, since)))
    .orderBy(asc(reservations.startAt));
  const moved = await db.select().from(reservations).innerJoin(customers, eq(reservations.customerId, customers.id))
    .where(and(eq(reservations.ownerId, ownerId), ne(reservations.status, "cancelled"), gte(reservations.changedByCustomerAt, since), lt(reservations.createdAt, since)))
    .orderBy(asc(reservations.startAt));
  return { booked: joinRows(booked), cancelled: joinRows(cancelled), moved: joinRows(moved) };
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
