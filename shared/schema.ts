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

/**
 * 設定の進み具合。最初にまとめて聞かず、パートナー（声のパネル）が使い始めのうちに続けて聞いて埋める。
 * done: 決まった項目 / skipped: 「聞かないで」と言われた項目（"all" なら質問をやめて、残りの数だけ知らせる） / asks: 聞いた回数
 * askedOn: 最後に聞いた日 / askedToday: その日に聞いた項目（同じ日に同じことを聞き直さない）
 * lastAsked: 聞いたまま、まだ答えをもらっていない項目 / postponedOn: 「あとで」と言われた日（その日はもう聞かない）
 * menuSuggested: 「メニューに登録しますか」と勧めた所要時間（分）。同じ長さでは二度勧めない
 */
export type SetupState = { done: string[]; skipped: string[]; asks: Record<string, number>; askedOn?: string; askedToday?: string[]; lastAsked?: string; postponedOn?: string; menuSuggested?: number[] };
export const EMPTY_SETUP: SetupState = { done: [], skipped: [], asks: {} };

/**
 * お知らせの受け取り方。会話の中で決まる（AI が聞いたり、オーナーが言ったりしたときに set_notice_preferences で）。
 * attendance: 打刻のお知らせ（all=全部、checks=確認が必要なものと予定の変更だけ、off=伝えない）
 * attendanceEmail: 確認が必要な打刻を、その場でオーナーにメールでも知らせるか
 */
/** paymentEmail：カード払いが済んだとき・未払いで取り消したときに、オーナーにもメールで知らせるか（古い設定にはないので、なければ送る） */
export type NoticePrefs = { attendance: "all" | "checks" | "off"; attendanceEmail: boolean; paymentEmail?: boolean };
export const DEFAULT_NOTICE: NoticePrefs = { attendance: "all", attendanceEmail: false, paymentEmail: true };
/** 打刻が「予定どおり」とみなせる幅として選べる分数 */
export const CLOCK_TOLERANCES = [15, 30] as const;

export const LOGIN_METHODS = ["password", "passphrase", "both"] as const;
export const RESERVATION_STATUSES = ["confirmed", "cancelled", "completed", "no_show"] as const;
export const SOURCES = ["web", "owner"] as const;
export const PAYMENT_METHODS = ["card", "onsite"] as const;
export const PAYMENT_STATUSES = ["unpaid", "paid", "onsite_pending", "onsite_received", "refunded", "ticket"] as const;
/** 現地払いで受け取った方法。現金のほか、お店の端末のカード、PayPay などの QR 決済、交通系などの電子マネー */
export const ONSITE_METHODS = ["cash", "card", "qr", "emoney", "other"] as const;
export type OnsiteMethod = (typeof ONSITE_METHODS)[number];
export const LANGUAGES = ["ja", "en"] as const;
/** スタッフの権限。staff は自分の予定と打刻だけ、manager は全員の予定も見られる */
export const STAFF_ROLES = ["staff", "manager"] as const;
export type Language = (typeof LANGUAGES)[number];

export const owners = pgTable("owners", {
  id: serial("id").primaryKey(),
  /** 登録する前（この端末だけのお店）は null。登録するとログインに使う */
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  passphraseHash: text("passphrase_hash"),
  /** 登録する前のお店に入るための鍵のハッシュ。鍵そのものは端末にだけ保存する。登録したら消す */
  deviceKeyHash: text("device_key_hash").unique(),
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
  /** ネットのカード払いは、来店の何時間前の予約まで受けるか（0 なら受付の締め切り minHoursBefore と同じ）。いたずらの予約で枠をふさがれないように */
  cardMinHoursBefore: integer("card_min_hours_before").notNull().default(24),
  /** カード払いの入金先（お店の Stripe アカウント、Stripe Connect）。cardReady は Stripe の審査が済んで、決済を受けられる状態か */
  stripeAccountId: text("stripe_account_id"),
  cardReady: boolean("card_ready").notNull().default(false),
  slug: text("slug").notNull().unique(),
  onboardingDone: boolean("onboarding_done").notNull().default(false),
  /** 管理画面を開いたときのお知らせを最後に伝えた時刻。これ以降の新しい予約・取り消しを次に伝える */
  lastBriefedAt: timestamp("last_briefed_at", { withTimezone: true }),
  /** カレンダー購読用の URL に入れる秘密の文字列（知っている人だけが予約の一覧を読める） */
  calendarToken: text("calendar_token").unique(),
  /** 口コミのページ（Google など）。あれば来店のお礼メールに添える */
  reviewUrl: text("review_url").notNull().default(""),
  /** お客さんが予約のときにスタッフを指名できるか */
  allowNomination: boolean("allow_nomination").notNull().default(false),
  /** 打刻が「予定どおり」とみなせる幅（予定の前後、分） */
  clockToleranceMinutes: integer("clock_tolerance_minutes").notNull().default(30),
  /** スタッフが勤務の予定を何日先まで入れられるか */
  planHorizonDays: integer("plan_horizon_days").notNull().default(31),
  /** 次回の声かけ：前回の来店から何日あいたら「そろそろいかがですか」のメールを送るか（0 なら送らない） */
  followupAfterDays: integer("followup_after_days").notNull().default(0),
  /** 月額の請求（Stripe の定期課金）。基本料金＋ログインできるスタッフの人数分 */
  stripeCustomerId: text("stripe_customer_id"),
  subscriptionId: text("subscription_id"),
  subscriptionStatus: text("subscription_status"),
  subscriptionSeats: integer("subscription_seats").notNull().default(0),
  /** お知らせの受け取り方。まだ決まっていなければ null（初期値で動き、AI が一度聞く） */
  noticePrefs: jsonb("notice_prefs").$type<NoticePrefs>(),
  /** 店舗グループ（集計だけを見せ合う店どうし）。1店舗1アカウントのまま */
  groupId: integer("group_id"),
  setupState: jsonb("setup_state").$type<SetupState>().notNull().default(EMPTY_SETUP),
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
    /** オーナーのメモ（「腰が悪い」「強めが好み」など）。日付つきで1行ずつ足していく */
    notes: text("notes").notNull().default(""),
    /** 次回の声かけ：最後に送った時刻、配信を止めたか、止めるためのリンクの文字列 */
    followedUpAt: timestamp("followed_up_at", { withTimezone: true }),
    followupOptOut: boolean("followup_opt_out").notNull().default(false),
    unsubscribeToken: text("unsubscribe_token").unique(),
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
    // メニューなしの予約（「田中さん、5日の2時から3時半」）もある。そのときは menuId が null、料金は受け取ったときに決まる
    menuId: integer("menu_id").references(() => menus.id),
    menuNameJa: text("menu_name_ja").notNull().default(""),
    menuNameEn: text("menu_name_en").notNull().default(""),
    minutes: integer("minutes").notNull(),
    price: integer("price").notNull().default(0),
    currency: text("currency").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("confirmed"),
    source: text("source").notNull().default("web"),
    paymentMethod: text("payment_method").notNull(),
    paymentStatus: text("payment_status").notNull(),
    amountReceived: integer("amount_received").notNull().default(0),
    /** 現地払いを受け取った方法（ONSITE_METHODS）。この項目ができる前の記録と、まだ受け取っていない予約は null */
    onsiteMethod: text("onsite_method"),
    stripeSessionId: text("stripe_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    /** カード払いが済んだ時刻（オーナーに「支払いが済みました」と伝えるため） */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentUrl: text("payment_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** 誰が取り消したか（"owner" / "customer" / "unpaid"＝カード払いが期限までになく自動で取り消した）。オーナー以外の取り消しをオーナーに知らせるため */
    cancelledBy: text("cancelled_by"),
    /** 前日のお知らせを済ませた時刻（メールを送った、またはメールのない人をオーナーに伝えた） */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    /** お客さんが自分で日時を変えた時刻（オーナーに知らせるため） */
    changedByCustomerAt: timestamp("changed_by_customer_at", { withTimezone: true }),
    /** 来店のお礼メールを送った時刻 */
    thankedAt: timestamp("thanked_at", { withTimezone: true }),
    /** 使ったクーポンと、割り引いた額（最小単位）。price は割引後の額 */
    couponCode: text("coupon_code"),
    discount: integer("discount").notNull().default(0),
    /** 担当のスタッフ（スタッフを登録していない店は null）。nominated は指名されたか */
    staffId: integer("staff_id"),
    staffName: text("staff_name").notNull().default(""),
    nominated: boolean("nominated").notNull().default(false),
    /** 回数券・前払いで払ったときの券。使った分（回数券は1回、前払いは金額）を ticketUsed に残す */
    ticketId: integer("ticket_id"),
    ticketUsed: integer("ticket_used").notNull().default(0),
  },
  (t) => ({
    ownerNumber: uniqueIndex("reservations_owner_number").on(t.ownerId, t.number),
    ownerStart: index("reservations_owner_start").on(t.ownerId, t.startAt),
  }),
);

/**
 * スタッフ。施術する人（予約を受ける人）と、ログインできる人を兼ねる。
 * - 簡単な権限：施術するか、指名を受けるか、フリー（指名なし）を受けるか、受けられるコース（menuIds が null なら全部）
 * - ログインは招待のリンクから本人がパスワードを決める。ログインできる人の数が料金の人数になる
 * - isOwner はオーナー本人の枠（スタッフを初めて登録したときに作り、それまでの予約をここに割り当てる）
 */
export const staff = pgTable("staff", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  name: text("name").notNull(),
  isOwner: boolean("is_owner").notNull().default(false),
  treats: boolean("treats").notNull().default(true),
  acceptNominated: boolean("accept_nominated").notNull().default(true),
  acceptFree: boolean("accept_free").notNull().default(true),
  menuIds: jsonb("menu_ids").$type<number[] | null>(),
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("staff"),
  inviteToken: text("invite_token").unique(),
  inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  /** 給与：時給・指名1件あたりの指名料（最小単位）、担当した施術の売り上げに対する歩合（%） */
  hourlyWage: integer("hourly_wage").notNull().default(0),
  nominationFee: integer("nomination_fee").notNull().default(0),
  commissionPercent: integer("commission_percent").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 打刻で気になった点。予定から外れた分数など */
export type AttendanceFlag = { code: "no_plan" | "in_early" | "in_late" | "out_early" | "out_late" | "plan_changed"; minutes?: number };

/**
 * 勤務の予定（入り・上がり）。スタッフが打刻の前に決めておく。
 * changedOnDay は、その日になってから予定を変えたか（変えた日の打刻は「要確認」になる）
 */
export const shifts = pgTable(
  "shifts",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    staffId: integer("staff_id").notNull().references(() => staff.id),
    date: text("date").notNull(),
    planStart: text("plan_start").notNull(),
    planEnd: text("plan_end").notNull(),
    changedOnDay: boolean("changed_on_day").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ staffDate: uniqueIndex("shifts_staff_date").on(t.staffId, t.date) }),
);

/**
 * 打刻（出勤・退勤）。退勤していなければ clockOut が null。
 * - planStart / planEnd は打刻したときの予定の写し、flags は予定から外れた点（なければ「予定どおり」）
 * - オーナーが確認したら confirmedAt。時刻を直したら、元の時刻を originalIn / originalOut に残す
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    staffId: integer("staff_id").notNull().references(() => staff.id),
    clockIn: timestamp("clock_in", { withTimezone: true }).notNull(),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    shiftId: integer("shift_id"),
    planStart: text("plan_start"),
    planEnd: text("plan_end"),
    flags: jsonb("flags").$type<AttendanceFlag[]>().notNull().default([]),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    originalIn: timestamp("original_in", { withTimezone: true }),
    originalOut: timestamp("original_out", { withTimezone: true }),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
  },
  (t) => ({ staffIn: index("time_entries_staff_in").on(t.staffId, t.clockIn) }),
);

/**
 * 勤怠のお知らせ（打刻・予定の登録や変更・オーナーの修正）。1件ずつ残し、オーナーに伝えたら notifiedAt
 * kind: clock_in / clock_out / plan_set / plan_changed / corrected
 */
export const attendanceEvents = pgTable(
  "attendance_events",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    staffId: integer("staff_id").notNull().references(() => staff.id),
    entryId: integer("entry_id"),
    kind: text("kind").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => ({ ownerAt: index("attendance_events_owner_at").on(t.ownerId, t.at) }),
);

/**
 * ご予約ちゃんが会話で覚えたこと（オーナーの好み・決まりごと・お店の事情）。次の会話から使う。
 * 合言葉やカード番号などは覚えない。オーナーは管理画面で見て消せる
 */
export const ownerMemories = pgTable("owner_memories", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 券の種類（例：60分5回券 27,000円、90日有効）。設定で一度決めておけば、売るときは種類を選ぶだけ。
 * AI の相談役と相談して決めることもできる。kind / total / price は customerTickets と同じ意味、validDays は売った日からの有効日数
 */
export const ticketTypes = pgTable("ticket_types", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  menuId: integer("menu_id"),
  total: integer("total").notNull(),
  price: integer("price").notNull(),
  validDays: integer("valid_days"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 回数券・前払い。kind が count なら total / remaining は回数、credit なら金額（最小単位）。
 * 売ったときの金額 price を、売った日（soldDate）の売り上げにする。使った日は売り上げにしない（二重に数えない）
 * token は QR コードとお客さん向けのページ（/t/:token）に使う秘密の文字列。見せるだけでは使えず、使うのはオーナーの読み取りから
 */
export const customerTickets = pgTable("customer_tickets", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  menuId: integer("menu_id"),
  total: integer("total").notNull(),
  remaining: integer("remaining").notNull(),
  price: integer("price").notNull(),
  soldDate: text("sold_date").notNull(),
  expiresOn: text("expires_on"),
  active: boolean("active").notNull().default(true),
  token: text("token").unique(),
  /** どの種類から売ったか（自由に作った券なら null） */
  typeId: integer("type_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 経費の科目（確定申告の収支内訳書・青色申告決算書の科目に合わせる） */
export const EXPENSE_CATEGORIES = {
  supplies: { ja: "消耗品費", en: "Supplies" }, rent: { ja: "地代家賃", en: "Rent" }, utilities: { ja: "水道光熱費", en: "Utilities" },
  communication: { ja: "通信費", en: "Phone and internet" }, travel: { ja: "旅費交通費", en: "Travel" }, advertising: { ja: "広告宣伝費", en: "Advertising" },
  entertainment: { ja: "接待交際費", en: "Entertainment" }, outsourcing: { ja: "外注工賃", en: "Outsourcing" }, fees: { ja: "支払手数料", en: "Fees" },
  training: { ja: "研修費", en: "Training" }, repairs: { ja: "修繕費", en: "Repairs" }, insurance: { ja: "損害保険料", en: "Insurance" }, other: { ja: "雑費", en: "Other" },
} as const;
export type ExpenseCategory = keyof typeof EXPENSE_CATEGORIES;

/** 経費。date はオーナーの時間帯の日付、amount は最小単位の整数 */
export const expenses = pgTable(
  "expenses",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    category: text("category").notNull(),
    memo: text("memo").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ ownerDate: index("expenses_owner_date").on(t.ownerId, t.date) }),
);

/**
 * API キー。外の道具（会計・給与・自作のツールなど）から、この店のデータを読むための鍵。
 * キーそのものは発行したときに一度だけ見せ、ここにはハッシュと先頭の数文字だけを残す。読み取り専用
 */
export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** 店舗グループ。参加コードを知っている店が入れる。見せ合うのは集計だけ */
export const shopGroups = pgTable("shop_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  joinCode: text("join_code").notNull().unique(),
  createdBy: integer("created_by").notNull().references(() => owners.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** クーポン。kind が percent なら value は割引率（1〜100）、amount なら割引額（最小単位） */
export const coupons = pgTable(
  "coupons",
  {
    id: serial("id").primaryKey(),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    code: text("code").notNull(),
    kind: text("kind").notNull(),
    value: integer("value").notNull(),
    active: boolean("active").notNull().default(true),
    /** この日まで使える（オーナーの時間帯の YYYY-MM-DD）。なければ期限なし */
    expiresOn: text("expires_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ ownerCode: uniqueIndex("coupons_owner_code").on(t.ownerId, t.code) }),
);

export const blockedSlots = pgTable("blocked_slots", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  /** そのスタッフだけのお休み。null ならお店全体のお休み */
  staffId: integer("staff_id"),
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

/**
 * スマホへの通知（Web Push）の宛先。端末（ブラウザ）ごとに1件。通知を許可した端末だけが持つ。
 * 送れなくなった宛先（ブラウザが消した、許可を取り消した）は送ったときに消す
 */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => owners.id),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  /** どの端末か（「iPhone」「Android」など）。画面で見分けるため */
  device: text("device").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** サーバーが自分で作って持っておく鍵（環境変数がないときの Web Push の鍵など） */
export const serverKeys = pgTable("server_keys", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type Owner = typeof owners.$inferSelect;
export type InsertOwner = typeof owners.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type Menu = typeof menus.$inferSelect;
export type InsertMenu = typeof menus.$inferInsert;
export type Reservation = typeof reservations.$inferSelect;
export type InsertReservation = typeof reservations.$inferInsert;
export type BlockedSlot = typeof blockedSlots.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type Shift = typeof shifts.$inferSelect;
export type AttendanceEvent = typeof attendanceEvents.$inferSelect;
export type ShopGroup = typeof shopGroups.$inferSelect;
export type OwnerMemory = typeof ownerMemories.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type CustomerTicket = typeof customerTickets.$inferSelect;
export type TicketType = typeof ticketTypes.$inferSelect;
/** 画面やAIに渡すスタッフの情報（パスワードや招待の文字列を含まない） */
export type PublicStaff = Omit<Staff, "passwordHash" | "inviteToken"> & { canLogin: boolean; invited: boolean };
export type ChatMessage = typeof chatMessages.$inferSelect;
export type VoiceSession = typeof voiceSessions.$inferSelect;

/** 画面やAIに渡すオーナー情報（ハッシュを含まない） */
export type PublicOwner = Omit<Owner, "passwordHash" | "passphraseHash" | "deviceKeyHash"> & { hasPassphrase: boolean; hasPassword: boolean; registered: boolean };

export const insertMenuSchema = createInsertSchema(menus).omit({ id: true, ownerId: true, currency: true });

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
// 閉店は「24:00」まで書ける（24時間営業なら 00:00〜24:00）
const closeRe = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
export const dayHoursSchema = z.union([z.null(), z.object({ open: z.string().regex(timeRe), close: z.string().regex(closeRe) })]);
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
  reviewUrl: z.union([z.literal(""), z.string().url().max(500)]).optional(),
  businessType: z.string().max(40).optional(),
  hours: hoursSchema.optional(),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
  slotStepMinutes: z.number().int().min(5).max(120).optional(),
  maxDaysAhead: z.number().int().min(1).max(365).optional(),
  minHoursBefore: z.number().int().min(0).max(720).optional(),
  freeCancelHoursBefore: z.number().int().min(0).max(720).optional(),
  allowCardPayment: z.boolean().optional(),
  cardMinHoursBefore: z.number().int().min(0).max(720).optional(),
  allowNomination: z.boolean().optional(),
  clockToleranceMinutes: z.union([z.literal(15), z.literal(30)]).optional(),
  planHorizonDays: z.union([z.literal(7), z.literal(14), z.literal(31), z.literal(62)]).optional(),
  noticePrefs: z.object({ attendance: z.enum(["all", "checks", "off"]), attendanceEmail: z.boolean(), paymentEmail: z.boolean().optional() }).optional(),
  followupAfterDays: z.number().int().min(0).max(365).optional(),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
  onboardingDone: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
