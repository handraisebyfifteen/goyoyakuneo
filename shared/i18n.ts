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
  | "unknown_tool" | "owner_declined" | "passphrase_locked" | "passphrase_missing" | "passphrase_rejected" | "ai_unavailable" | "blocked_slot_not_found" | "cash_unreadable" | "cash_not_found"
  | "end_or_menu_required" | "card_needs_menu" | "customer_not_found" | "no_show_too_early" | "not_confirmed" | "reschedule_too_late"
  | "coupon_invalid" | "coupon_expired" | "coupon_exists" | "coupon_needs_menu"
  | "staff_not_found" | "staff_cannot_take" | "no_staff_for_menu" | "no_staff_available" | "staff_email_in_use" | "invite_invalid" | "forbidden" | "group_not_found" | "already_in_group" | "plan_too_far" | "ticket_unusable" | "billing_not_ready" | "already_subscribed" | "scan_unknown" | "ticket_type_not_found"
  | "registration_required" | "device_key_invalid" | "too_many_starts";

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
    end_or_menu_required: () => "終わりの時刻か、メニューを教えてください",
    customer_not_found: () => "そのお客さんは見つかりません",
    coupon_invalid: () => "そのクーポンは使えません",
    staff_not_found: () => "そのスタッフは見つかりません",
    staff_cannot_take: () => "そのスタッフは、この予約を受けられない設定です（指名を受けない、またはこのコースを担当しない）",
    no_staff_for_menu: () => "このコースを受けられるスタッフがいません",
    no_staff_available: () => "その時間は、受けられるスタッフが全員ふさがっています",
    staff_email_in_use: () => "そのメールアドレスはすでに使われています",
    invite_invalid: () => "招待のリンクが正しくないか、期限が切れています。お店の方にもう一度送ってもらってください",
    forbidden: () => "この操作をする権限がありません",
    group_not_found: () => "その参加コードのグループは見つかりません",
    already_in_group: () => "すでにグループに入っています。先にグループを抜けてください",
    plan_too_far: (p) => `勤務の予定は${p.days}日先まで入れられます`,
    ticket_unusable: () => "このお客さんの使える回数券・前払いがありません（残りがない、期限切れ、コースが違う、など）",
    billing_not_ready: () => "月額のお支払いの準備がまだできていません",
    scan_unknown: () => "このお店の回数券やクーポンの QR コードではありません",
    ticket_type_not_found: (p) => `その回数券の種類はありません${p.names ? `。今ある種類：${p.names}` : ""}`,
    registration_required: () => "これは、お店を登録すると使えます。「登録する」と言うか、画面の「お店を登録する」から登録できます",
    device_key_invalid: () => "この端末のお店が見つかりません。登録済みの方はログインしてください",
    too_many_starts: () => "短い間にたくさん始めようとしています。しばらくしてから、もう一度お試しください",
    already_subscribed: () => "すでにご契約中です",
    coupon_expired: () => "そのクーポンは期限が切れています",
    coupon_exists: (p) => `「${p.code}」というクーポンはすでにあります`,
    coupon_needs_menu: () => "クーポンはメニューのある予約にだけ使えます",
    reschedule_too_late: (p) => `日時の変更は、ご予約の${p.hours}時間前までです。お店に直接ご連絡ください`,
    no_show_too_early: () => "まだ予約の時間になっていないため、無断キャンセルにはできません",
    not_confirmed: () => "この予約はすでに取り消し済みか、記録済みです",
    card_needs_menu: () => "メニューのない予約は料金が決まっていないため、カード前払いにはできません。当日払いにしてください",
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
    end_or_menu_required: () => "Please give an end time or a menu.",
    customer_not_found: () => "That customer was not found.",
    coupon_invalid: () => "That coupon cannot be used.",
    staff_not_found: () => "That staff member was not found.",
    staff_cannot_take: () => "That staff member is set not to take this booking (no nominations, or not this service).",
    no_staff_for_menu: () => "No staff member can take this service.",
    no_staff_available: () => "Every staff member who can take this is busy at that time.",
    staff_email_in_use: () => "That email address is already in use.",
    invite_invalid: () => "This invitation link is not valid or has expired. Please ask the shop to send a new one.",
    forbidden: () => "You do not have permission to do this.",
    group_not_found: () => "No group was found with that code.",
    already_in_group: () => "This shop is already in a group. Leave it first.",
    plan_too_far: (p) => `Work plans can be set up to ${p.days} days ahead.`,
    ticket_unusable: () => "This customer has no usable ticket or prepaid balance (none left, expired, or a different service).",
    billing_not_ready: () => "Monthly billing is not set up yet.",
    scan_unknown: () => "This is not a ticket or coupon QR code from this shop.",
    ticket_type_not_found: (p) => `That ticket type does not exist.${p.names ? ` Current types: ${p.names}` : ""}`,
    registration_required: () => 'This is available once you register your shop. Say "register", or use "Register your shop" on the screen.',
    device_key_invalid: () => "The shop on this device was not found. If you have registered, please log in.",
    too_many_starts: () => "Too many new shops were started in a short time. Please try again later.",
    already_subscribed: () => "You already have a subscription.",
    coupon_expired: () => "That coupon has expired.",
    coupon_exists: (p) => `A coupon called "${p.code}" already exists.`,
    coupon_needs_menu: () => "Coupons only apply to bookings with a menu.",
    reschedule_too_late: (p) => `Bookings can be changed up to ${p.hours} hours before. Please contact the shop directly.`,
    no_show_too_early: () => "The booking time has not come yet, so it cannot be marked as a no-show.",
    not_confirmed: () => "This booking is already cancelled or closed.",
    card_needs_menu: () => "A booking without a menu has no set price, so it cannot be prepaid by card. Please use pay at the shop.",
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
