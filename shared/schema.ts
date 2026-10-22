/**
 * ご予約ちゃん Neo — データの形（Drizzle ORM）
 *
 * 金額はすべて「最小単位の整数」（円なら1円、ドルなら1セント）で持つ。
 * 日時は UTC の timestamptz で持ち、表示や「今日」の判定はオーナーの時間帯で行う。
 */
import {
  pgTable, serial, text, integer, boolean, timestamp, jsonb, varchar, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
export type DayHours = { open: string; close: string } | null;
export type BusinessHours = Record<WeekdayKey, DayHours>;

export const DEFAULT_HOURS: BusinessHours = {
  mon: { open: "10:00", close: "19:00" },
  tue: { open: "10:00", close: "19:00" },
  wed: { open: "10:00", close: "19:00" },
  thu: { open: "10:00", close: "19:00" },
  fri: { open: "10:00", close: "19:00" },
  sat: { open: "10:00", close: "19:00" },
  sun: null,
};

export const LOGIN_METHODS = ["password", "passphrase", "both"] as const;
export const RESERVATION_STATUSES = ["confirmed", "cancelled", "completed", "no_show"] as const;
export const SOURCES = ["web", "owner"] as const;
export const PAYMENT_METHODS = ["card", "onsite"] as const;
export const PAYMENT_STATUSES = ["unpaid", "paid", "onsite_pending", "onsite_received", "refunded"] as const;
export const LANGUAGES = ["ja", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const owners = pgTable("owners", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  passphraseHash: text("passphrase_hash"),
  loginMethod: text("login_method").notNull().default("both"),
  shopNameJa: text("shop_name_ja").notNull().default(""),
  shopNameEn: text("shop_name_en").notNull().default(""),
  address: text("address").notNull().default(""),
  phone: text("phone").notNull().default(""),
  info: text("info").notNull().default(""),
  businessType: text("business_type").notNull().default("massage"),
  country: text("country").notNull().default("JP"),
  currency: text("currency").notNull().default("JPY"),
  timezone: text("timezone").notNull().default("Asia/Tokyo"),
  language: text("language").notNull().default("ja"),
  hours: jsonb("hours").$type<BusinessHours>().notNull(),
  bufferMinutes: integer("buffer_minutes").notNull().default(15),
  slotStepMinutes: integer("slot_step_minutes").notNull().default(30),
  maxDaysAhead: integer("max_days_ahead").notNull().default(60),
  minHoursBefore: integer("min_hours_before").notNull().default(2),
  freeCancelHoursBefore: integer("free_cancel_hours_before").notNull().default(24),
  allowCardPayment: boolean("allow_card_payment").notNull().default(true),
  slug: text("slug").notNull().unique(),
  onboardingDone: boolean("onboarding_done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ ownerPhone: uniqueIndex("customers_owner_phone").on(t.ownerId, t.phone).where(sql`${t.phone} <> ''`) }),
);

export const menus = pgTable("menus", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  nameJa: text("name_ja").notNull(),
  nameEn: text("name_en").notNull(),
  minutes: integer("minutes").notNull(),
  price: integer("price").notNull(),
  currency: text("currency").notNull(),
  descriptionJa: text("description_ja").notNull().default(""),
  descriptionEn: text("description_en").notNull().default(""),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const reservations = pgTable(
  "reservations",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    number: varchar("number", { length: 4 }).notNull(),
    customerId: integer("customer_id").notNull().references(() => customers.id),
    menuId: integer("menu_id").notNull().references(() => menus.id),
    menuNameJa: text("menu_name_ja").notNull(),
    menuNameEn: text("menu_name_en").notNull(),
    minutes: integer("minutes").notNull(),
    price: integer("price").notNull(),
    currency: text("currency").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("confirmed"),
    source: text("source").notNull().default("web"),
    paymentMethod: text("payment_method").notNull(),
    paymentStatus: text("payment_status").notNull(),
    amountReceived: integer("amount_received").notNull().default(0),
    stripeSessionId: text("stripe_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    paymentUrl: text("payment_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => ({
    ownerNumber: uniqueIndex("reservations_owner_number").on(t.ownerId, t.number),
    ownerStart: index("reservations_owner_start").on(t.ownerId, t.startAt),
  }),
);

export const blockedSlots = pgTable("blocked_slots", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voiceSessions = pgTable("voice_sessions", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id).unique(),
  unlockedUntil: timestamp("unlocked_until", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export const emailLog = pgTable(
  "email_log",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    date: text("date").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({ ownerDate: uniqueIndex("email_log_owner_date").on(t.ownerId, t.date) }),
);

export type Owner = typeof owners.$inferSelect;
export type InsertOwner = typeof owners.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type Menu = typeof menus.$inferSelect;
export type InsertMenu = typeof menus.$inferInsert;
export type Reservation = typeof reservations.$inferSelect;
export type InsertReservation = typeof reservations.$inferInsert;
export type BlockedSlot = typeof blockedSlots.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type VoiceSession = typeof voiceSessions.$inferSelect;

/** 画面やAIに渡すオーナー情報（ハッシュを含まない） */
export type PublicOwner = Omit<Owner, "passwordHash" | "passphraseHash"> & { hasPassphrase: boolean; hasPassword: boolean };

export const insertMenuSchema = createInsertSchema(menus).omit({ id: true, ownerId: true, currency: true });

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
export const dayHoursSchema = z.union([z.null(), z.object({ open: z.string().regex(timeRe), close: z.string().regex(timeRe) })]);
export const hoursSchema = z.object({
  mon: dayHoursSchema, tue: dayHoursSchema, wed: dayHoursSchema, thu: dayHoursSchema,
  fri: dayHoursSchema, sat: dayHoursSchema, sun: dayHoursSchema,
});

export const settingsPatchSchema = z.object({
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  timezone: z.string().min(1).optional(),
  language: z.enum(LANGUAGES).optional(),
  shopNameJa: z.string().max(100).optional(),
  shopNameEn: z.string().max(100).optional(),
  address: z.string().max(300).optional(),
  phone: z.string().max(40).optional(),
  info: z.string().max(1000).optional(),
  businessType: z.string().max(40).optional(),
  hours: hoursSchema.optional(),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
  slotStepMinutes: z.number().int().min(5).max(120).optional(),
  maxDaysAhead: z.number().int().min(1).max(365).optional(),
  minHoursBefore: z.number().int().min(0).max(720).optional(),
  freeCancelHoursBefore: z.number().int().min(0).max(720).optional(),
  allowCardPayment: z.boolean().optional(),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
  onboardingDone: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
