/**
 * 画面と API のメッセージ（日本語 / 英語）。画面とサーバーの両方から使う。
 */
import type { Language } from "./schema";

export const WEEKDAY_LABELS: Record<Language, string[]> = {
  ja: ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日"],
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
};

export type ErrorCode =
  | "past_time" | "day_off" | "closed_day" | "outside_hours" | "too_soon" | "too_far"
  | "overlap" | "menu_not_found" | "reservation_not_found" | "already_cancelled"
  | "invalid_date" | "invalid_time" | "name_required" | "phone_required" | "invalid_email"
  | "currency_locked" | "invalid_timezone" | "card_not_allowed" | "email_in_use" | "slug_in_use"
  | "login_failed" | "passphrase_short" | "passphrase_wrong" | "unauthorized" | "validation"
  | "not_found" | "server_error" | "paid_menu_locked" | "not_onsite_pending" | "not_card_unpaid"
  | "unknown_tool" | "owner_declined" | "passphrase_locked" | "passphrase_missing" | "passphrase_rejected" | "ai_unavailable" | "blocked_slot_not_found" | "cash_unreadable" | "cash_not_found";

type P = Record<string, string | number>;
const M: Record<Language, Record<ErrorCode, (p: P) => string>> = {
  ja: {
    past_time: () => "過ぎた時間には予約を入れられません",
    day_off: (p) => `${p.date}はお休みの日です`,
    closed_day: (p) => `${p.date}（${p.weekday}）は定休日です`,
    outside_hours: (p) => `${p.weekday}の営業時間は${p.open}から${p.close}までです`,
    too_soon: (p) => `ご予約は${p.hours}時間前までにお願いしています`,
    too_far: (p) => `ご予約は${p.days}日先まで受け付けています`,
    overlap: (p) => `${p.time}からの${p.name}様の予約と近すぎます（前後${p.buffer}分の空きが必要です）`,
    menu_not_found: () => "そのメニューはありません",
    reservation_not_found: () => "その予約は見つかりません",
    already_cancelled: () => "この予約はすでに取り消されています",
    invalid_date: () => "日付の形が正しくありません",
    invalid_time: () => "時刻の形が正しくありません",
    name_required: () => "お名前が必要です",
    phone_required: () => "電話番号が必要です",
    invalid_email: () => "メールアドレスの形が正しくありません",
    currency_locked: () => "メニューや予約がある状態では、通貨は変えられません",
    invalid_timezone: () => "時間帯の名前が正しくありません",
    card_not_allowed: () => "この店舗ではカード払いを受け付けていません",
    email_in_use: () => "このメールアドレスはすでに登録されています",
    slug_in_use: () => "この予約ページのアドレスはすでに使われています",
    login_failed: () => "メールアドレス、またはパスワード・合言葉が違います",
    passphrase_short: () => "合言葉は4文字以上にしてください",
    passphrase_wrong: () => "今の合言葉が違います",
    unauthorized: () => "ログインが必要です",
    validation: () => "入力の内容が正しくありません",
    not_found: () => "見つかりません",
    server_error: () => "保存に失敗しました",
    paid_menu_locked: () => "支払い済みの予約は、料金の違うメニューに変更できません",
    not_onsite_pending: () => "この予約は現地払い待ちの状態ではありません",
    not_card_unpaid: () => "この予約はカード払いの未払いの状態ではありません",
    unknown_tool: (p) => `${p.name} という操作はありません`,
    owner_declined: () => "ご本人が取り消したため、実行していません",
    passphrase_locked: () => "合言葉を続けて間違えたため、しばらくお金に関わる操作を止めています。数分後にお試しください",
    passphrase_missing: () => "合言葉がまだ設定されていないため、この操作はできません。設定画面で合言葉を決めてください",
    passphrase_rejected: () => "合言葉が違うため、実行していません",
    ai_unavailable: () => "AIの接続が設定されていないため、声の操作は使えません",
    blocked_slot_not_found: () => "そのお休みの枠は見つかりません",
    cash_unreadable: () => "お金を読み取れませんでした。もう一度撮ってください",
    cash_not_found: () => "お金が写っていないようです。もう一度撮ってください",
  },
  en: {
    past_time: () => "That time has already passed.",
    day_off: (p) => `${p.date} is a day off.`,
    closed_day: (p) => `${p.date} (${p.weekday}) is a regular closing day.`,
    outside_hours: (p) => `Opening hours on ${p.weekday} are ${p.open} to ${p.close}.`,
    too_soon: (p) => `Bookings must be made at least ${p.hours} hours in advance.`,
    too_far: (p) => `Bookings can be made up to ${p.days} days ahead.`,
    overlap: (p) => `Too close to ${p.name}'s booking at ${p.time} (${p.buffer} minutes are needed between sessions).`,
    menu_not_found: () => "That menu does not exist.",
    reservation_not_found: () => "That booking was not found.",
    already_cancelled: () => "This booking has already been cancelled.",
    invalid_date: () => "The date format is not valid.",
    invalid_time: () => "The time format is not valid.",
    name_required: () => "A name is required.",
    phone_required: () => "A phone number is required.",
    invalid_email: () => "The email address is not valid.",
    currency_locked: () => "The currency cannot be changed once menus or bookings exist.",
    invalid_timezone: () => "The time zone name is not valid.",
    card_not_allowed: () => "This shop does not accept card payment.",
    email_in_use: () => "This email address is already registered.",
    slug_in_use: () => "This booking page address is already taken.",
    login_failed: () => "The email, password, or passphrase is incorrect.",
    passphrase_short: () => "The passphrase must be at least 4 characters.",
    passphrase_wrong: () => "The current passphrase is incorrect.",
    unauthorized: () => "Please log in.",
    validation: () => "Some of the input is not valid.",
    not_found: () => "Not found.",
    server_error: () => "Saving failed.",
    paid_menu_locked: () => "A paid booking cannot be changed to a menu with a different price.",
    not_onsite_pending: () => "This booking is not waiting for on-site payment.",
    not_card_unpaid: () => "This booking is not an unpaid card booking.",
    unknown_tool: (p) => `There is no action called ${p.name}.`,
    owner_declined: () => "You declined, so nothing was done.",
    passphrase_locked: () => "Money-related actions are paused for a few minutes after repeated wrong passphrases.",
    passphrase_missing: () => "No passphrase is set yet, so this action is not available. Please set one in settings.",
    passphrase_rejected: () => "The passphrase did not match, so nothing was done.",
    ai_unavailable: () => "The AI connection is not configured, so voice control is unavailable.",
    blocked_slot_not_found: () => "That time-off slot was not found.",
    cash_unreadable: () => "I could not read the money. Please take the photo again.",
    cash_not_found: () => "There does not seem to be any money in the photo. Please take it again.",
  },
};

export function errorMessage(code: ErrorCode, lang: Language, params: P = {}): string {
  const fn = M[lang]?.[code] ?? M.en[code];
  return fn ? fn(params) : code;
}

export function cancelPolicyText(hours: number, lang: Language): string {
  if (lang === "ja") {
    return hours === 0
      ? "キャンセルはいつでも全額返金いたします。"
      : `ご予約の${hours}時間前までのキャンセルは全額返金いたします。それ以降のキャンセルは返金できません。`;
  }
  return hours === 0
    ? "You may cancel at any time for a full refund."
    : `Cancellations made at least ${hours} hours before your appointment are fully refunded. Later cancellations are not refundable.`;
}

export function normalizeLang(v: unknown): Language {
  return String(v ?? "").toLowerCase().startsWith("en") ? "en" : "ja";
}
