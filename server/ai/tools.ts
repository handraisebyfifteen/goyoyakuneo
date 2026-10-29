/**
 * 日常モデルに渡すツール。仕様（名前・引数）と、実行（services / storage を呼ぶ）をここにまとめる。
 *
 * - 読むだけのツールは確認なしで実行する（設定の質問を「聞かないで」にする set_setup_item、会話で覚える remember / forget、
 *   お知らせの受け取り方 set_notice_preferences も、予約やお金に関わらないので確認なし）
 * - 書き込むツールは、本人が「はい」と言うまで実行しない（判定は agent.ts がコードで行う）
 * - ★ GUARDED のツールは、さらに合言葉が合うまで実行しない。合言葉そのものは AI に渡らない
 * - すべての金額は { amount, display } の形で返す。AI は display を読み上げる
 */
import type OpenAI from "openai";
import type { Owner, Language, WeekdayKey, BusinessHours, Staff, NoticePrefs } from "@shared/schema";
import { DEFAULT_NOTICE, EXPENSE_CATEGORIES, ONSITE_METHODS, type OnsiteMethod } from "@shared/schema";
import { WEEKDAY_KEYS, settingsPatchSchema } from "@shared/schema";
import { cancelPolicyText, errorMessage, WEEKDAY_LABELS } from "@shared/i18n";
import { money, toMinor } from "@shared/money";
import * as storage from "../storage";
import { ApiError } from "../errors";
import { BookingError, availableSlots } from "../lib/booking";
import { isValidDate, isValidTime, isValidCloseTime, isValidTimeZone, nowLocal, weekdayOf, addDays, monthRange, fromLocal, toLocal } from "../lib/time";
import {
  bookingSettings, busyAround, slotsFor, createReservationFor, cancelReservationFor, updateReservationFor,
  recordOnsitePaymentFor, salesSummaryFor, addBlockedSlotFor, reservationsOutsideHours, todayFor,
} from "../services";
import { createPaymentLink, cardPayable } from "../payments";
import { SETUP_ITEMS, markSetupItem, noteSetupProgress, menuSuggestion, nextSetupQuestion } from "./setup";
import { normalizeCode } from "../lib/coupon";
import { seatsFor, timesheetFor, createStaffFor, updateStaffFor, inviteStaff, payrollFor } from "../staff";
import { groupSummaryFor, createGroupFor, joinGroupFor } from "../groups";
import { attendanceOverview, confirmEntriesFor, correctEntryFor, entryView } from "../attendance";
import { rememberFor } from "./memory";
import { addExpenseFor, profitFor, categoryLabel } from "../books";
import { guessCategory } from "../lib/expense";
import { sellTicketFor, sellFromType, useTicketFor, ticketView, ticketTypeView } from "../tickets";
import { billingStatus } from "../billing";
import { capabilitiesFor, type Ability } from "../capabilities";

export const READ_TOOLS = new Set([
  "get_settings", "get_today_reservations", "get_reservations_by_date", "find_reservations_by_customer",
  "get_available_slots", "get_menus", "get_sales_summary", "get_cancel_policy", "check_cash", "get_customer",
  "set_setup_item", "share_booking_link", "get_coupons", "get_staff", "get_timesheet", "get_group_summary", "get_attendance",
  "remember", "forget", "set_notice_preferences", "get_payroll", "get_books", "get_billing", "get_ticket_types", "open_registration", "get_capabilities",
]);
export const WRITE_TOOLS = new Set([
  "update_settings", "update_business_info", "set_business_hours", "update_booking_rules",
  "create_menu", "update_menu", "create_reservation", "update_reservation", "cancel_reservation",
  "add_blocked_slot", "delete_blocked_slot", "create_payment_link", "record_onsite_payment",
  "update_customer", "mark_no_show", "create_recurring_reservations",
  "create_coupon", "stop_coupon", "create_staff", "update_staff", "create_shop_group", "join_shop_group",
  "confirm_attendance", "correct_attendance", "add_expense", "delete_expense", "sell_ticket", "use_ticket", "set_followup", "create_ticket_type", "stop_ticket_type",
]);
/** 外に出るもの（お客さん・スタッフ・ほかの店・メール）。登録前のお店では使えない */
const REGISTERED_TOOLS = new Set(["share_booking_link", "create_payment_link", "create_staff", "update_staff", "create_shop_group", "join_shop_group", "set_followup"]);
/** 確認なしで実行するが、記録は変わるもの（画面を読み直してもらう） */
export const QUIET_WRITE_TOOLS = new Set(["set_setup_item", "remember", "forget", "set_notice_preferences"]);
/** お金や決まりに関わるもの → 合言葉も必要 */
// 現地払いの受け取りの記録は「はい」の確認だけ（記録は残り、あとから見直せる）。合言葉までは求めない
export const GUARDED_TOOLS = new Set(["update_settings", "update_booking_rules", "cancel_reservation", "correct_attendance"]);
/** 相談モデルへの切り替え（日常モデルが判定して呼ぶ） */
export const ADVISOR_TOOL = "ask_advisor";

type Spec = OpenAI.Chat.Completions.ChatCompletionTool;
type Props = Record<string, Record<string, unknown>>;

function fn(name: string, description: string, properties: Props = {}, required: string[] = []): Spec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const DATE = { type: "string", description: "日付 YYYY-MM-DD / date YYYY-MM-DD" };
const TIME = { type: "string", description: "時刻 HH:MM（24時間）/ time HH:MM (24h)" };
const RID = { type: "integer", description: "予約の id（get_today_reservations などの結果にある id）/ reservation id from a listing" };
const STR = { type: "string" };
const INT = { type: "integer" };
/** 現地払いの受け取り方法。わからない値や省いたときは現金 */
const onsiteMethod = (v: unknown): OnsiteMethod => (ONSITE_METHODS as readonly string[]).includes(String(v)) ? (v as OnsiteMethod) : "cash";
const ONSITE_METHOD_LABELS: Record<Language, Record<OnsiteMethod, string>> = {
  ja: { cash: "現金", card: "カード", qr: "QR決済", emoney: "電子マネー", other: "その他の方法" },
  en: { cash: "cash", card: "card", qr: "QR payment", emoney: "e-money", other: "another method" },
};
const MONEY = { type: "number", description: "設定した通貨での普通の金額（5000円なら5000、49.99ドルなら49.99）/ amount in major units" };

export const TOOL_SPECS: Spec[] = [
  fn("get_settings", "国・通貨・時間帯・言語、店舗情報、営業時間、受付ルール、キャンセルの決まりを見る。"),
  fn("get_today_reservations", "今日の予約を見る。"),
  fn("get_reservations_by_date", "指定した日の予約を見る。", { date: DATE }, ["date"]),
  fn("find_reservations_by_customer", "お客さんの名前で今後の予約を探す。取り消しや変更の前に id を調べるのに使う。", { customer_name: STR }, ["customer_name"]),
  fn("get_available_slots", "その日に予約できる時間を調べる。メニュー名か、所要時間（分）のどちらかを渡す。スタッフを言われたら、その人の空きだけ。", { date: DATE, menu_name: STR, minutes: INT, staff_name: { type: "string", description: "担当・指名のスタッフの名前（スタッフのいる店で、言われたときだけ）" } }, ["date"]),
  fn("get_menus", "メニューの一覧（所要時間と料金）を見る。"),
  fn("get_sales_summary", "期間の売り上げを集計する。カード・現地払いの内訳、未払い、取り消し件数を返す。", { start_date: DATE, end_date: DATE }, ["start_date", "end_date"]),
  fn("get_cancel_policy", "キャンセルの決まりを見る。"),
  fn("check_cash", "現地払いで受け取ったお金をカメラで数え、おつりを計算する。記録はしない。", { reservation_id: RID }, ["reservation_id"]),
  fn("set_setup_item", "設定の質問への答えを記録する。「このままでいい」なら status=done、「聞かないで」なら status=skip。設定の質問を全部やめてほしいと言われたら item=all, status=skip。「あとで」のときは呼ばない。", {
    item: { type: "string", enum: [...SETUP_ITEMS.filter((k) => k !== "account"), "all"] }, status: { type: "string", enum: ["done", "skip"] },
  }, ["item", "status"]),
  fn("open_registration", "お店の登録（店名・メール・ログインの方法）の画面へ移る。「登録したい」「お店を登録して」と言われたときに呼ぶ。メールやパスワード・合言葉は会話で聞かない（画面で本人が入れる）。"),
  fn("get_coupons", "クーポンの一覧（コード、割引、期限、使えるか）を見る。"),
  fn("get_staff", "スタッフの一覧と権限（施術する・指名・フリー・受けられるコース・ログインできるか・出勤中か）、料金の人数を見る。"),
  fn("get_timesheet", "スタッフの勤務時間（打刻の合計）を月ごとに見る。", { month: { type: "string", description: "YYYY-MM（省けば今月）" } }),
  fn("remember", "オーナーの好み・決まりごと・お店の事情を覚える（次の会話から使う）。「覚えて」と言われたときだけでなく、「次から〜して」「〜はいらない」「いつも〜」「〜さんは〜」のように、これからも役立つことを言われたら短い一文で呼ぶ。前に覚えたことを直すなら replace_id にその番号。合言葉・パスワード・カード番号は覚えない。", {
    content: { type: "string", description: "覚えること（短い一文。例: 予定どおりの打刻はいちいち伝えなくていい）" },
    replace_id: { type: "integer", description: "置き換える前の記憶の番号（覚えていることの一覧にある）" },
  }, ["content"]),
  fn("forget", "覚えていることを忘れる。「それは忘れて」「もう違う」と言われたとき。", { id: { type: "integer", description: "記憶の番号" } }, ["id"]),
  fn("set_notice_preferences", "お知らせの受け取り方を決める。attendance: 打刻のお知らせ（all=全部、checks=確認が必要なものと予定の変更だけ、off=伝えない）。attendance_email: 確認が必要な打刻を、その場でメールでも知らせるか。payment_email: カード払いが済んだとき・払われずに取り消したときに、メールでも知らせるか（画面を開いている間は、その場で声でも伝える）。言われた項目だけ渡す。", {
    attendance: { type: "string", enum: ["all", "checks", "off"] }, attendance_email: { type: "boolean" }, payment_email: { type: "boolean" },
  }),
  fn("get_books", "経費の一覧と、期間の利益（売り上げ − 経費 − 給与）を見る。経費を消す前に id を調べるのにも使う。", { start_date: DATE, end_date: DATE }),
  fn("get_ticket_types", "回数券・前払いの種類（名前、回数か金額、料金、有効日数、売れた数）を見る。"),
  fn("get_capabilities", "今できることの一覧を見る。ready は登録・設定してあるからできること、always はいつでもできること、next は設定するとできること。say は話しかけるときの言い方の例（null は自動で動くもの）。「何ができる？」「今できることは？」と聞かれたときに使う。"),
  fn("get_billing", "このアプリの月額の契約の状態と、今の人数での月額の目安を見る。"),
  fn("get_payroll", "スタッフの月の給与（勤務時間×時給＋指名料＋歩合）を計算して見る。確認していない打刻があれば件数も返す。", { month: { type: "string", description: "YYYY-MM（省けば今月）" } }),
  fn("get_attendance", "スタッフの打刻で、オーナーがまだ確認していないもの（予定どおりか、要確認ならその理由）と、最近のお知らせ（打刻・予定の変更）を見る。"),
  fn("get_group_summary", "店舗グループのほかの店も含めた集計（売り上げ・件数・取り消し・無断キャンセル）を見る。", { start_date: DATE, end_date: DATE }),
  fn("share_booking_link", "お客さん用の予約ページのリンクを送る・渡す・QRコードを出すと頼まれたときに呼ぶ。画面の送るボタンにフォーカスを移す。"),
  fn("get_customer", "お客さんの記録を名前で調べる。メモ、来店回数、前回と次回、最近の来店、無断キャンセルの回数、電話番号を返す。", { customer_name: STR }, ["customer_name"]),

  fn("update_settings", "国・通貨・時間帯・言語を変える。", {
    country: { type: "string", description: "国コード2文字（例: JP, US）" },
    currency: { type: "string", description: "通貨コード3文字（例: JPY, USD）" },
    timezone: { type: "string", description: "時間帯（例: Asia/Tokyo, America/New_York）" },
    language: { type: "string", enum: ["ja", "en"] },
  }),
  fn("update_business_info", "店舗の情報（店名、住所、電話、お客さんへの案内、業種、口コミのページ）を登録・変更する。言われた項目だけ渡す。", {
    shop_name: STR, address: STR, phone: STR, info: { type: "string", description: "お客さんへの案内（駐車場、持ち物など）" }, business_type: STR,
    review_url: { type: "string", description: "口コミのページの URL（Google など）。来店のお礼メールに添える。空にすると送らない" },
  }),
  fn("set_business_hours", "営業時間や定休日を決める。「10時から8時、水曜休み」なら day=all, open, close に closed_days=[wed] を添えて一度で呼ぶ。24時間営業なら open=00:00, close=24:00。", {
    day: { type: "string", enum: [...WEEKDAY_KEYS, "weekdays", "weekend", "all"] },
    open: TIME, close: { type: "string", description: "閉店 HH:MM（24時なら 24:00）/ closing time, 24:00 allowed" }, closed: { type: "boolean", description: "day を定休日にするなら true" },
    closed_days: { type: "array", items: { type: "string", enum: [...WEEKDAY_KEYS] }, description: "あわせて定休日にする曜日" },
  }, ["day"]),
  fn("update_booking_rules", "受付ルールとキャンセルの決まりを変える。言われた項目だけ渡す。", {
    buffer_minutes: { type: "integer", description: "施術と施術の間の空き時間（分）" },
    slot_step_minutes: { type: "integer", description: "空き時間を案内する刻み（分）" },
    max_days_ahead: { type: "integer", description: "お客さんが何日先まで予約できるか" },
    clock_tolerance_minutes: { type: "integer", enum: [15, 30], description: "スタッフの打刻が予定どおりとみなせる幅（予定の前後、15分か30分）" },
    plan_horizon_days: { type: "integer", enum: [7, 14, 31, 62], description: "スタッフが勤務の予定を何日先まで入れられるか（1週間=7、2週間=14、1ヶ月=31、2ヶ月=62）" },
    min_hours_before: { type: "integer", description: "お客さんの予約は何時間前までか" },
    free_cancel_hours_before: { type: "integer", description: "何時間前までのキャンセルなら全額返金か" },
    allow_card_payment: { type: "boolean", description: "予約時のカード前払いを許可するか" },
    card_min_hours_before: { type: "integer", description: "ネットのカード払いは来店の何時間前の予約までか（いたずらの予約対策。初期値24。0なら当日もカード払いできる）" },
    allow_nomination: { type: "boolean", description: "お客さんがネットの予約でスタッフを指名できるか" },
  }),
  fn("create_menu", "メニューを作る。", { name: STR, minutes: INT, price: MONEY, description: STR }, ["name", "minutes", "price"]),
  fn("update_menu", "メニューの名前・所要時間・料金を変える、または提供をやめる（active=false）。", {
    menu_name: STR, new_name: STR, minutes: INT, price: MONEY, active: { type: "boolean" },
  }, ["menu_name"]),
  fn("create_reservation", "予約を入れる。メニュー名か終わりの時刻（end_time）のどちらかを渡す。「田中さん、5日の2時から3時半」のようにメニューなしでも入れられる。カード前払いはメニューがあるときだけで、支払いリンクが自動で用意される。", {
    date: DATE, time: TIME, end_time: { ...TIME, description: "終わりの時刻 HH:MM（メニューなしのとき）/ end time HH:MM" }, menu_name: STR, customer_name: STR,
    payment_method: { type: "string", enum: ["card", "onsite"], description: "card=カード前払い, onsite=当日店舗で払う（省略したら onsite）" },
    customer_phone: { type: "string", description: "お客さんの電話番号（わかれば）" },
    customer_email: { type: "string", description: "お客さんのメールアドレス（わかれば）" },
    staff_name: { type: "string", description: "担当・指名のスタッフの名前（スタッフのいる店で、言われたときだけ）" },
  }, ["date", "time", "customer_name"]),
  fn("create_recurring_reservations", "毎週（または隔週など）同じ曜日・同じ時間の予約を、まとめて入れる。first_date から count 回。空いていない日は飛ばして、結果で知らせる。支払いは当日払い。", {
    first_date: DATE, time: TIME, end_time: { ...TIME, description: "終わりの時刻（メニューなしのとき）" }, menu_name: STR, customer_name: STR,
    customer_phone: STR, count: { type: "integer", description: "何回分入れるか（2〜12）" }, every_weeks: { type: "integer", description: "何週ごとか（毎週なら1、隔週なら2）" },
    staff_name: { type: "string", description: "担当・指名のスタッフの名前（スタッフのいる店で、言われたときだけ）" },
  }, ["first_date", "time", "customer_name", "count"]),
  fn("update_reservation", "予約の日時・終わりの時刻・メニュー・担当のスタッフを変える。開始だけ変えたら長さはそのまま。", { reservation_id: RID, date: DATE, time: TIME, end_time: TIME, menu_name: STR, staff_name: { type: "string", description: "担当・指名のスタッフの名前（スタッフのいる店で、言われたときだけ）" } }, ["reservation_id"]),
  fn("cancel_reservation", "予約を取り消す。カード支払い済みなら、返金の対象かどうかも返す（返金そのものは行わない）。", { reservation_id: RID }, ["reservation_id"]),
  fn("add_blocked_slot", "臨時休業や休憩の枠を入れる。start と end を省けば終日。staff_name を渡せば、そのスタッフだけのお休み。", { date: DATE, start: TIME, end: TIME, reason: STR, staff_name: { type: "string", description: "担当・指名のスタッフの名前（スタッフのいる店で、言われたときだけ）" } }, ["date"]),
  fn("delete_blocked_slot", "臨時休業や休憩の枠を取り消す。", { blocked_slot_id: { type: "integer" } }, ["blocked_slot_id"]),
  fn("create_payment_link", "カード前払いの予約に、支払いリンクを作り直す。", { reservation_id: RID }, ["reservation_id"]),
  fn("record_onsite_payment", "現地払いでお金を受け取ったことを記録する。method は受け取った方法：現金 cash、お店の端末でのカード card、PayPay などの QR 決済 qr、交通系などの電子マネー emoney、それ以外 other。方法を言われなければ cash。", {
    reservation_id: RID, amount: MONEY, method: { type: "string", enum: [...ONSITE_METHODS] },
  }, ["reservation_id", "amount"]),
  fn("update_customer", "お客さんの記録を変える。メモを書き足す（add_note）、電話番号・メールアドレス・名前を直す。言われた項目だけ渡す。", {
    customer_id: { type: "integer", description: "お客さんの id（get_customer の結果にある id）/ customer id from get_customer" },
    add_note: { type: "string", description: "書き足すメモ（例: 腰が悪い、強めが好み）" }, phone: STR, email: STR, name: STR,
  }, ["customer_id"]),
  fn("create_coupon", "お客さんがネットの予約で使えるクーポンを作る。percent_off（割引率）か amount_off（割引額）のどちらかを渡す。コードはお客さんが打ち込む文字（例: SPRING10）。", {
    code: STR, percent_off: { type: "integer", description: "割引率（1〜100）" }, amount_off: MONEY,
    expires_on: { ...DATE, description: "この日まで使える（省けば期限なし）" },
  }, ["code"]),
  fn("stop_coupon", "クーポンを使えなくする。", { code: STR }, ["code"]),
  fn("create_staff", "スタッフを登録する。email を渡すと、ログインの招待を送る（ログインできる人の数で料金が決まる）。言われなかった権限は省く（施術する・指名を受ける・フリーを受ける・全コース）。", {
    name: STR, email: STR, treats: { type: "boolean", description: "施術する（予約を受ける）か" },
    accept_nominated: { type: "boolean", description: "指名を受けるか（フリーのみなら false）" }, accept_free: { type: "boolean", description: "指名なし（フリー）の予約を受けるか" },
    menu_names: { type: "array", items: { type: "string" }, description: "受けられるコースを限るとき（例: Aコースのみ）。全部なら省く" },
    role: { type: "string", enum: ["staff", "manager"], description: "ログインしたとき：staff は自分の予定と打刻、manager は全員の予定も見られる" },
  }, ["name"]),
  fn("update_staff", "スタッフの名前・メール・権限を変える、招待を送り直す、在籍をやめる（active=false）。言われた項目だけ渡す。", {
    staff_name: STR, new_name: STR, email: STR, treats: { type: "boolean" }, accept_nominated: { type: "boolean" }, accept_free: { type: "boolean" },
    menu_names: { type: "array", items: { type: "string" }, description: "受けられるコース。全コースに戻すなら [\"all\"]" },
    role: { type: "string", enum: ["staff", "manager"] }, active: { type: "boolean" }, send_invite: { type: "boolean", description: "ログインの招待を送り直す" },
    hourly_wage: { ...MONEY, description: "時給（普通の金額）" }, nomination_fee: { ...MONEY, description: "指名1件あたりの指名料" },
    commission_percent: { type: "integer", description: "担当した施術の売り上げに対する歩合（%）" },
  }, ["staff_name"]),
  fn("confirm_attendance", "スタッフの打刻を確認済みにする。「打刻を確認して」なら only_ok=true（予定どおりのものだけ）。要確認のものは、本人が「それも確認」「全部確認」と言ったときだけ only_ok=false で。staff_name でその人の分だけにできる。", {
    staff_name: STR, only_ok: { type: "boolean", description: "予定どおりのものだけ確認するなら true（省けば true）" },
  }),
  fn("correct_attendance", "スタッフの打刻の時刻を直す（元の時刻は残り、確認済みになる）。date はその打刻の日。", {
    staff_name: STR, date: DATE, clock_in: TIME, clock_out: { type: "string", description: "退勤 HH:MM（24:00 も可）" },
  }, ["staff_name", "date"]),
  fn("add_expense", "経費を記録する。「タオル代3000円」なら amount=3000, category=supplies, memo=タオル代。日付を言われなければ今日。科目は内容から選ぶ（消耗品・備品=supplies、家賃=rent、電気水道ガス=utilities、電話・ネット=communication、交通費=travel、広告=advertising、接待=entertainment、外注=outsourcing、手数料=fees、研修・講習=training、修理=repairs、保険=insurance）。わからなければ category は省く（内容から自動で決まる）。", {
    amount: MONEY, category: { type: "string", enum: Object.keys(EXPENSE_CATEGORIES) }, memo: STR, date: DATE,
  }, ["amount", "memo"]),
  fn("create_ticket_type", "回数券・前払いの種類を決める（売るときは種類を選ぶだけになる）。相談役と相談して決めた案を登録するときにも使う。回数券は kind=count と count、前払いは kind=credit と amount。price は売る値段。valid_days は売った日から何日使えるか（省けば期限なし）。", {
    name: { type: "string", description: "種類の名前（例: 60分5回券）" }, kind: { type: "string", enum: ["count", "credit"] }, count: INT,
    amount: { ...MONEY, description: "前払いで使える金額" }, price: { ...MONEY, description: "売る値段" }, menu_name: STR, valid_days: INT,
  }, ["name", "kind", "price"]),
  fn("stop_ticket_type", "回数券・前払いの種類の販売をやめる（もう売った券はそのまま使える）。", { name: STR }, ["name"]),
  fn("sell_ticket", "回数券か前払いを売る。決めてある種類なら ticket_type にその名前だけ渡す（回数・値段・期限は種類のとおり）。種類を使わないときは、回数券は kind=count と count、前払いは kind=credit と amount、price は実際に受け取った金額。", {
    customer_name: STR, ticket_type: { type: "string", description: "決めてある種類の名前（例: 60分5回券）" },
    kind: { type: "string", enum: ["count", "credit"] }, name: { type: "string", description: "券の名前（例: 60分コース5回券）" },
    count: INT, amount: { ...MONEY, description: "前払いで使える金額" }, price: { ...MONEY, description: "受け取った金額" }, menu_name: STR,
    expires_on: { ...DATE, description: "使える期限（省けば期限なし）" },
  }, ["customer_name"]),
  fn("set_followup", "次回の声かけ：前回の来店から何日あいたお客さんに「そろそろいかがですか」のメールを送るか決める。0 なら送らない。メールのあるお客さんに一度だけ送り、配信を止めるリンクも入る。", {
    days: { type: "integer", description: "何日あいたら送るか（例: 30、45、60）。やめるなら 0" },
  }, ["days"]),
  fn("use_ticket", "現地払い待ちの予約の支払いに、そのお客さんの回数券か前払いを使う。メニューなしの予約を前払いで払うなら amount。", {
    reservation_id: RID, amount: { ...MONEY, description: "前払いから引く金額（メニューなしの予約のとき）" },
  }, ["reservation_id"]),
  fn("delete_expense", "記録した経費を消す（get_books の id）。", { expense_id: { type: "integer" } }, ["expense_id"]),
  fn("create_shop_group", "ほかの店舗と集計を見せ合うグループを作る。参加コードを返す（ほかの店に伝える）。", { name: STR }),
  fn("join_shop_group", "ほかの店舗のグループに、参加コードで入る。入ると集計（売り上げと件数）だけを見せ合う。", { code: STR }, ["code"]),
  fn("mark_no_show", "連絡なしで来なかった予約を、無断キャンセルとして記録する。予約の時間を過ぎてから使う。", { reservation_id: RID }, ["reservation_id"]),

  fn(ADVISOR_TOOL, "経営の相談、分析、悩みや愚痴、「なぜ」「どうしたら」といった考える必要のある質問のときに呼ぶ。相談役のモデルが答える。予約や金額の操作には使わない。", {
    question: { type: "string", description: "本人の相談の内容（そのまま）" },
  }, ["question"]),
];

export type ToolResult = Record<string, unknown> & { ok: boolean; error?: string };

export class ToolContext {
  constructor(public owner: Owner, public lang: Language) {}
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v).trim());
const int = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number.parseInt(String(v), 10));
const bool = (v: unknown) => (v === undefined || v === null ? undefined : v === true || v === "true");

function weekdayLabel(date: string, lang: Language): string {
  return WEEKDAY_LABELS[lang][WEEKDAY_KEYS.indexOf(weekdayOf(date))];
}

async function requireMenu(ctx: ToolContext, name: unknown) {
  const n = str(name);
  const menu = n ? await storage.findMenuByName(ctx.owner.id, n) : undefined;
  if (!menu) {
    const all = await storage.listMenus(ctx.owner.id, true);
    const names = all.map((m) => storage.menuView(m, ctx.lang).name).join(ctx.lang === "ja" ? "、" : ", ");
    throw new ApiError("menu_not_found", 404, { names });
  }
  return menu;
}

/** クーポンの割引を読み上げ向けに（「10%引き」「¥1,000引き」） */
function couponOff(ctx: ToolContext, c: { kind: string; value: number }): string {
  const ja = ctx.lang === "ja";
  if (c.kind === "percent") return ja ? `${c.value}%引き` : `${c.value}% off`;
  const m = money(c.value, ctx.owner.currency, ctx.lang).display;
  return ja ? `${m}引き` : `${m} off`;
}

function closedDays(v: unknown): WeekdayKey[] {
  return (Array.isArray(v) ? v : []).map(String).filter((d): d is WeekdayKey => WEEKDAY_KEYS.includes(d as WeekdayKey));
}

/** 名前で言われたスタッフ（言われなければ undefined） */
async function optionalStaff(ctx: ToolContext, name: unknown): Promise<Staff | undefined> {
  const n = str(name);
  if (!n) return undefined;
  const member = await storage.findStaffByName(ctx.owner.id, n);
  if (!member) throw new ApiError("staff_not_found", 404);
  return member;
}

/** コース名の並びを id に（["all"] や空なら全コース = null） */
async function menuIdsFrom(ctx: ToolContext, v: unknown): Promise<number[] | null | undefined> {
  if (v === undefined || v === null) return undefined;
  const names = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
  if (!names.length || names.some((n) => /^(all|全部|すべて|全コース)$/i.test(n))) return null;
  const ids: number[] = [];
  for (const n of names) ids.push((await requireMenu(ctx, n)).id);
  return ids;
}

async function staffView(ctx: ToolContext, s: Staff) {
  const menus = await storage.listMenus(ctx.owner.id);
  const names = s.menuIds ? s.menuIds.map((id) => menus.find((m) => m.id === id)).filter(Boolean).map((m) => storage.menuView(m!, ctx.lang).name) : null;
  const p = storage.publicStaff(s);
  return { name: s.name, isOwner: s.isOwner, treats: s.treats, acceptNominated: s.acceptNominated, acceptFree: s.acceptFree,
    menus: names ?? (ctx.lang === "ja" ? "全コース" : "all services"), role: s.role, active: s.active, canLogin: p.canLogin, invited: p.invited, email: s.email };
}

/** その人のその日の打刻（その日に複数あれば、まだ確認していないもの → 最後のもの） */
async function findEntry(ctx: ToolContext, staffId: number, date: string) {
  const tz = ctx.owner.timezone;
  const list = await storage.listTimeEntries(ctx.owner.id, fromLocal(date, "00:00", tz), fromLocal(addDays(date, 1), "00:00", tz), staffId);
  const entry = list.find((e) => !e.confirmedAt) ?? list[list.length - 1];
  if (!entry) throw new ApiError("not_found", 404);
  return entry;
}

async function requireTicketType(ctx: ToolContext, name: unknown) {
  const t = await storage.findTicketTypeByName(ctx.owner.id, str(name) ?? "");
  if (!t) {
    const names = (await storage.listTicketTypes(ctx.owner.id, true)).map((x) => x.name).join(ctx.lang === "ja" ? "、" : ", ");
    throw new ApiError("ticket_type_not_found", 404, { names });
  }
  return t;
}

async function requireCustomer(ctx: ToolContext, id: unknown) {
  const n = int(id);
  const c = n ? await storage.getCustomer(ctx.owner.id, n) : undefined;
  if (!c) throw new ApiError("customer_not_found", 404);
  return c;
}

/** お客さんの記録で使う、予約の短い形 */
function visitBrief(ctx: ToolContext, r: storage.ReservationRow) {
  const v = storage.reservationView(r, ctx.owner.timezone, ctx.lang);
  return { id: v.id, date: v.date, weekday: weekdayLabel(v.date, ctx.lang), time: v.time, endTime: v.endTime, menuName: v.menuName || null };
}

async function requireReservation(ctx: ToolContext, id: unknown) {
  const n = int(id);
  const row = n ? await storage.getReservation(ctx.owner.id, n) : undefined;
  if (!row) throw new ApiError("reservation_not_found", 404);
  return row;
}

function view(ctx: ToolContext, r: storage.ReservationRow) {
  const v = storage.reservationView(r, ctx.owner.timezone, ctx.lang);
  // 読み上げ向けに曜日を足す。予約番号は AI に読ませないので渡さない
  const { number: _n, startAt: _s, endAt: _e, paymentUrl: _p, ...rest } = v;
  return { ...rest, weekday: weekdayLabel(v.date, ctx.lang), hasPaymentLink: !!v.paymentUrl };
}

/** ツールを1つ実行する。ApiError / BookingError は本人向けの文に、それ以外はログにだけ残す */
export async function executeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const impl = IMPL[name];
    if (!impl) return { ok: false, error: errorMessage("unknown_tool", ctx.lang, { name }) };
    if (!ctx.owner.email && REGISTERED_TOOLS.has(name)) throw new ApiError("registration_required", 403);
    const asked = ctx.owner.setupState?.lastAsked;
    const result = await impl(ctx, args ?? {});
    // 声で設定を変えたら、その設定の質問は済んだことにする
    if (result.ok && WRITE_TOOLS.has(name)) ctx.owner = await noteSetupProgress(ctx.owner, name, args ?? {});
    // 聞いていた設定に答えてもらえたら、続けて次の項目を聞く（使い始めのうちに決めてもらう）
    if (result.ok && asked && ctx.owner.setupState?.lastAsked !== asked) {
      const next = await nextSetupQuestion(ctx.owner, ctx.lang);
      if (next) return { ...result, suggestion: [result.suggestion, next].filter(Boolean).join(ctx.lang === "ja" ? "" : " ") };
    }
    return result;
  } catch (e) {
    if (e instanceof ApiError || e instanceof BookingError) return { ok: false, error: errorMessage(e.code, ctx.lang, e.params) };
    if (e instanceof Error && /invalid amount/.test(e.message)) return { ok: false, error: errorMessage("validation", ctx.lang) };
    console.error(`[tool_error] ${name}`, e);
    return { ok: false, error: errorMessage("server_error", ctx.lang) };
  }
}

type Impl = (ctx: ToolContext, a: Record<string, unknown>) => Promise<ToolResult>;

const IMPL: Record<string, Impl> = {
  // ---------- 読むだけ ----------
  async get_settings(ctx) {
    const o = ctx.owner;
    return {
      ok: true,
      settings: { country: o.country, currency: o.currency, timezone: o.timezone, language: o.language },
      business: { shopName: storage.shopName(o, ctx.lang), address: o.address, phone: o.phone, info: o.info, businessType: o.businessType },
      hours: o.hours,
      rules: { bufferMinutes: o.bufferMinutes, slotStepMinutes: o.slotStepMinutes, maxDaysAhead: o.maxDaysAhead, minHoursBefore: o.minHoursBefore, freeCancelHoursBefore: o.freeCancelHoursBefore, allowCardPayment: o.allowCardPayment,
        cardMinHoursBefore: o.cardMinHoursBefore, cardPayoutReady: cardPayable(o) },
      cancelPolicy: cancelPolicyText(o.freeCancelHoursBefore, ctx.lang),
      hasPassphrase: !!o.passphraseHash,
      bookingPath: `/book/${o.slug}`,
    };
  },
  async get_today_reservations(ctx) {
    const date = todayFor(ctx.owner);
    const rows = await storage.listReservationsByDates(ctx.owner.id, ctx.owner.timezone, date, date);
    return { ok: true, date, weekday: weekdayLabel(date, ctx.lang), count: rows.length, reservations: rows.map((r) => view(ctx, r)) };
  },
  async get_reservations_by_date(ctx, a) {
    const date = str(a.date) ?? "";
    if (!isValidDate(date)) throw new ApiError("invalid_date");
    const rows = await storage.listReservationsByDates(ctx.owner.id, ctx.owner.timezone, date, date);
    const tz = ctx.owner.timezone;
    const blocked = await storage.listBlockedSlots(ctx.owner.id, fromLocal(date, "00:00", tz), fromLocal(addDays(date, 1), "00:00", tz));
    return { ok: true, date, weekday: weekdayLabel(date, ctx.lang), count: rows.length, reservations: rows.map((r) => view(ctx, r)),
      blockedSlots: blocked.map((b) => ({ id: b.id, reason: b.reason, start: toLocal(b.startAt, tz).time, end: toLocal(b.endAt, tz).time })) };
  },
  async find_reservations_by_customer(ctx, a) {
    const name = str(a.customer_name) ?? "";
    if (!name) throw new ApiError("name_required");
    const rows = (await storage.listReservationsByCustomer(ctx.owner.id, name)).filter((r) => r.endAt.getTime() > Date.now() - 86400000 * 7);
    return { ok: true, count: rows.length, reservations: rows.map((r) => view(ctx, r)) };
  },
  async get_available_slots(ctx, a) {
    const date = str(a.date) ?? "";
    if (!isValidDate(date)) throw new ApiError("invalid_date");
    const minutes = int(a.minutes);
    const menu = a.menu_name || !minutes ? await requireMenu(ctx, a.menu_name) : undefined;
    const member = await optionalStaff(ctx, a.staff_name);
    const r = await slotsFor(ctx.owner, { date, minutes: menu?.minutes ?? minutes!, menuId: menu?.id ?? null, source: "owner", staffId: member?.id });
    return { ok: true, date, weekday: weekdayLabel(date, ctx.lang), menuName: menu ? storage.menuView(menu, ctx.lang).name : null, minutes: menu?.minutes ?? minutes, staffName: member?.name ?? null, closed: r.closed, slots: r.slots };
  },
  async get_menus(ctx) {
    const all = await storage.listMenus(ctx.owner.id);
    return { ok: true, menus: all.map((m) => { const v = storage.menuView(m, ctx.lang); return { id: v.id, name: v.name, minutes: v.minutes, price: v.price, active: v.active, description: v.description }; }) };
  },
  async get_sales_summary(ctx, a) {
    const today = todayFor(ctx.owner);
    const from = str(a.start_date) || monthRange(today).from;
    const to = str(a.end_date) || monthRange(today).to;
    if (!isValidDate(from) || !isValidDate(to)) throw new ApiError("invalid_date");
    return { ok: true, ...(await salesSummaryFor(ctx.owner, from, to, ctx.lang)) };
  },
  async get_cancel_policy(ctx) {
    return { ok: true, freeCancelHoursBefore: ctx.owner.freeCancelHoursBefore, cancelPolicy: cancelPolicyText(ctx.owner.freeCancelHoursBefore, ctx.lang) };
  },
  async check_cash(ctx, a) {
    // 写真を撮るのは画面側。ここでは予約が現地払い待ちかを確かめ、画面にカメラを開くよう伝える（読み取りはフェーズ4）
    const row = await requireReservation(ctx, a.reservation_id);
    if (row.paymentStatus !== "onsite_pending") throw new ApiError("not_onsite_pending");
    return { ok: true, action: "open_camera", reservationId: row.id, customerName: row.customer.name, due: row.menuId === null ? null : money(row.price, row.currency, ctx.lang),
      note: ctx.lang === "ja" ? "カメラを開きます。カメラのボタンを押して、受け取ったお金を写してください。読み取りの結果は別に読み上げます。" : "Opening the camera. Press the camera button and photograph the cash you received. The reading will be read out separately." };
  },

  async open_registration(ctx) {
    if (ctx.owner.email) return { ok: false, error: ctx.lang === "ja" ? "このお店は、もう登録してあります" : "This shop is already registered." };
    return { ok: true, action: "open_signup",
      note: ctx.lang === "ja" ? "登録の画面に移ります。店名、メール、ログインの方法の順に聞きます。今の予約や設定は、そのまま引き継ぎます。" : "Opening the registration screen. It asks for the shop name, email and how you log in. Bookings and settings carry over." };
  },
  async set_setup_item(ctx, a) {
    const item = str(a.item) ?? "";
    const status = str(a.status);
    if (item === "account" || ![...SETUP_ITEMS, "all"].includes(item as never) || (status !== "done" && status !== "skip")) throw new ApiError("validation");
    ctx.owner = await markSetupItem(ctx.owner, item, status);
    return { ok: true, item, status };
  },
  async get_coupons(ctx) {
    const today = todayFor(ctx.owner);
    const all = await storage.listCoupons(ctx.owner.id);
    return { ok: true, coupons: all.map((c) => ({ code: c.code, off: couponOff(ctx, c), expiresOn: c.expiresOn, usable: c.active && (!c.expiresOn || today <= c.expiresOn) })) };
  },
  async get_staff(ctx) {
    const all = await storage.listStaff(ctx.owner.id);
    const staffList = await Promise.all(all.map(async (s) => ({ ...(await staffView(ctx, s)), working: !!(await storage.openTimeEntry(s.id)) })));
    return { ok: true, staff: staffList, allowNomination: ctx.owner.allowNomination, ...(await seatsFor(ctx.owner.id)),
      note: ctx.lang === "ja" ? "料金の人数は、オーナーとログインできる（招待中を含む）スタッフの合計です。" : "Billing counts the owner plus staff who can log in (including pending invitations)." };
  },
  async get_timesheet(ctx, a) {
    const month = str(a.month) || todayFor(ctx.owner).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError("validation");
    return { ok: true, month, staff: await timesheetFor(ctx.owner, month) };
  },
  async remember(ctx, a) {
    const r = await rememberFor(ctx.owner, str(a.content) ?? "", int(a.replace_id));
    if (!r.ok) return { ok: false, error: r.reason === "secret"
      ? (ctx.lang === "ja" ? "合言葉やパスワード、カード番号のような秘密は覚えません" : "I do not keep secrets such as passphrases, passwords or card numbers.")
      : errorMessage("validation", ctx.lang) };
    return { ok: true, remembered: str(a.content) };
  },
  async forget(ctx, a) {
    const ok = await storage.deleteMemory(ctx.owner.id, int(a.id) ?? 0);
    if (!ok) throw new ApiError("not_found", 404);
    return { ok: true };
  },
  async set_notice_preferences(ctx, a) {
    const cur = ctx.owner.noticePrefs ?? DEFAULT_NOTICE;
    const att = str(a.attendance);
    const next: NoticePrefs = {
      attendance: att === "all" || att === "checks" || att === "off" ? att : cur.attendance,
      attendanceEmail: bool(a.attendance_email) ?? cur.attendanceEmail,
      paymentEmail: bool(a.payment_email) ?? cur.paymentEmail ?? true,
    };
    ctx.owner = await markSetupItem(await storage.updateOwner(ctx.owner.id, { noticePrefs: next }), "notices", "done");
    return { ok: true, notice: next };
  },
  async get_books(ctx, a) {
    const today = todayFor(ctx.owner);
    const from = str(a.start_date) || monthRange(today).from, to = str(a.end_date) || monthRange(today).to;
    if (!isValidDate(from) || !isValidDate(to)) throw new ApiError("invalid_date");
    const list = await storage.listExpenses(ctx.owner.id, from, to);
    return { ok: true, profit: await profitFor(ctx.owner, from, to, ctx.lang),
      expenses: list.slice(-30).map((e) => ({ id: e.id, date: e.date, amount: money(e.amount, ctx.owner.currency, ctx.lang), category: categoryLabel(e.category, ctx.lang), memo: e.memo })) };
  },
  async get_billing(ctx) {
    const b = await billingStatus(ctx.owner, ctx.lang);
    return { ok: true, ...b, note: b.configured ? "" : (ctx.lang === "ja" ? "月額のお支払いは、まだ準備中です。" : "Monthly billing is not set up yet.") };
  },
  async get_payroll(ctx, a) {
    const month = str(a.month) || todayFor(ctx.owner).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError("validation");
    const r = await payrollFor(ctx.owner, month, ctx.lang);
    return { ok: true, month, total: r.total, staff: r.staff.map(({ staffId: _i, totalMinor: _t, minutes: _m, ...rest }) => rest),
      note: r.staff.some((s) => s.unconfirmed) ? (ctx.lang === "ja" ? "確認していない打刻があります。確認してから確定してください。" : "Some clock records are not confirmed yet. Confirm them before finalising.") : "" };
  },
  async get_attendance(ctx) {
    const r = await attendanceOverview(ctx.owner, ctx.lang);
    return { ok: true, tolerance: r.tolerance, pending: r.pending.map(({ id: _i, staffId: _s, ...rest }) => rest), recent: r.events.slice(0, 10).map((e) => e.text) };
  },
  async get_group_summary(ctx, a) {
    const r = await groupSummaryFor(ctx.owner, ctx.lang, str(a.start_date) || undefined, str(a.end_date) || undefined);
    if (!r) return { ok: true, inGroup: false, note: ctx.lang === "ja" ? "どのグループにも入っていません。" : "This shop is not in a group." };
    return { ok: true, inGroup: true, group: r.group.name, shops: r.shops };
  },
  async share_booking_link(ctx) {
    return { ok: true, action: "share_link", bookingPath: `/book/${ctx.owner.slug}`,
      note: ctx.lang === "ja"
        ? "画面の「予約ページを送る」ボタンを押すと、LINEやメッセージ、メールで送れます。パソコンでは「リンクをコピー」です。その下の「QRコードを出す」で、印刷用のQRコードも出せます。"
        : 'Press "Send booking page" on the screen to send it by LINE, messages or email. On a computer it is "Copy link". "Show QR code" below gives a printable QR code.' };
  },
  async get_customer(ctx, a) {
    const name = str(a.customer_name) ?? "";
    if (!name) throw new ApiError("name_required");
    const found = await storage.findCustomersByName(ctx.owner.id, name);
    const now = Date.now();
    const customers = await Promise.all(found.slice(0, 5).map(async (c) => {
      const rows = await storage.listReservationsOfCustomer(ctx.owner.id, c.id);
      const visits = rows.filter((r) => (r.status === "confirmed" || r.status === "completed") && r.endAt.getTime() <= now);
      const upcoming = rows.filter((r) => r.status === "confirmed" && r.endAt.getTime() > now);
      const today = todayFor(ctx.owner);
      const tickets = (await storage.listTickets(ctx.owner.id, c.id)).map((t) => ticketView(t, ctx.owner, ctx.lang, today)).filter((t) => t.usable).map(({ id: _i, customerId: _c, menuId: _m, ...t }) => t);
      return {
        id: c.id, name: c.name, phone: c.phone || null, email: c.email, notes: c.notes || null, tickets,
        visitCount: visits.length, noShowCount: rows.filter((r) => r.status === "no_show").length,
        cancelCount: rows.filter((r) => r.status === "cancelled").length,
        lastVisit: visits.length ? visitBrief(ctx, visits[visits.length - 1]) : null,
        nextBooking: upcoming.length ? visitBrief(ctx, upcoming[0]) : null,
        recentVisits: visits.slice(-5).reverse().map((r) => visitBrief(ctx, r)),
      };
    }));
    return { ok: true, count: found.length, customers };
  },

  // ---------- 書き込む（確認あり） ----------
  async update_settings(ctx, a) {
    const patch = settingsPatchSchema.pick({ country: true, currency: true, timezone: true, language: true }).parse({
      country: str(a.country) || undefined, currency: str(a.currency) || undefined, timezone: str(a.timezone) || undefined, language: str(a.language) || undefined,
    });
    if (patch.country) patch.country = patch.country.toUpperCase();
    if (patch.currency) {
      patch.currency = patch.currency.toUpperCase();
      if (patch.currency !== ctx.owner.currency && (await storage.ownerHasMenusOrReservations(ctx.owner.id))) throw new ApiError("currency_locked");
    }
    if (patch.timezone && !isValidTimeZone(patch.timezone)) throw new ApiError("invalid_timezone");
    const o = await storage.updateOwner(ctx.owner.id, patch);
    ctx.owner = o;
    return { ok: true, settings: { country: o.country, currency: o.currency, timezone: o.timezone, language: o.language } };
  },
  async update_business_info(ctx, a) {
    const patch: Record<string, string> = {};
    const name = str(a.shop_name);
    if (name) { if (ctx.lang === "ja") patch.shopNameJa = name; else patch.shopNameEn = name; }
    for (const [from, to] of [["address", "address"], ["phone", "phone"], ["info", "info"], ["business_type", "businessType"], ["review_url", "reviewUrl"]] as const) {
      const v = str(a[from]);
      if (v !== undefined) patch[to] = v;
    }
    const o = await storage.updateOwner(ctx.owner.id, settingsPatchSchema.parse(patch));
    ctx.owner = o;
    return { ok: true, business: { shopName: storage.shopName(o, ctx.lang), address: o.address, phone: o.phone, info: o.info, businessType: o.businessType, reviewUrl: o.reviewUrl || null } };
  },
  async set_business_hours(ctx, a) {
    const day = str(a.day) ?? "";
    const groups: Record<string, readonly WeekdayKey[]> = { all: WEEKDAY_KEYS, weekdays: WEEKDAY_KEYS.slice(0, 5), weekend: WEEKDAY_KEYS.slice(5) };
    const days = groups[day] ?? (WEEKDAY_KEYS.includes(day as WeekdayKey) ? [day as WeekdayKey] : null);
    if (!days) throw new ApiError("validation");
    const closed = bool(a.closed) ?? false;
    const open = str(a.open), close = str(a.close);
    if (!closed && (!open || !close || !isValidTime(open) || !isValidCloseTime(close) || open >= close)) throw new ApiError("invalid_time");
    const hours: BusinessHours = { ...ctx.owner.hours };
    for (const d of days) hours[d] = closed ? null : { open: open!, close: close! };
    for (const d of closedDays(a.closed_days)) hours[d] = null;
    const o = await storage.updateOwner(ctx.owner.id, { hours });
    ctx.owner = o;
    const outside = await reservationsOutsideHours(o, ctx.lang);
    return { ok: true, hours, reservationsNowOutsideHours: outside };
  },
  async update_booking_rules(ctx, a) {
    const patch = settingsPatchSchema.pick({ bufferMinutes: true, slotStepMinutes: true, maxDaysAhead: true, minHoursBefore: true, freeCancelHoursBefore: true, allowCardPayment: true, cardMinHoursBefore: true }).parse({
      bufferMinutes: int(a.buffer_minutes), slotStepMinutes: int(a.slot_step_minutes), maxDaysAhead: int(a.max_days_ahead),
      minHoursBefore: int(a.min_hours_before), freeCancelHoursBefore: int(a.free_cancel_hours_before), allowCardPayment: bool(a.allow_card_payment),
      cardMinHoursBefore: int(a.card_min_hours_before),
    });
    const tol = int(a.clock_tolerance_minutes);
    if (tol !== undefined) Object.assign(patch, settingsPatchSchema.pick({ clockToleranceMinutes: true }).parse({ clockToleranceMinutes: tol }));
    const horizon = int(a.plan_horizon_days);
    if (horizon !== undefined) Object.assign(patch, settingsPatchSchema.pick({ planHorizonDays: true }).parse({ planHorizonDays: horizon }));
    const nomination = bool(a.allow_nomination);
    if (nomination !== undefined) Object.assign(patch, { allowNomination: nomination });
    const o = await storage.updateOwner(ctx.owner.id, patch);
    ctx.owner = o;
    return { ok: true, rules: { bufferMinutes: o.bufferMinutes, slotStepMinutes: o.slotStepMinutes, maxDaysAhead: o.maxDaysAhead, minHoursBefore: o.minHoursBefore, freeCancelHoursBefore: o.freeCancelHoursBefore, allowCardPayment: o.allowCardPayment, cardMinHoursBefore: o.cardMinHoursBefore, allowNomination: o.allowNomination, clockToleranceMinutes: o.clockToleranceMinutes, planHorizonDays: o.planHorizonDays },
      cancelPolicy: cancelPolicyText(o.freeCancelHoursBefore, ctx.lang) };
  },
  async create_menu(ctx, a) {
    const name = str(a.name) ?? "";
    const minutes = int(a.minutes) ?? 0;
    if (!name || minutes <= 0) throw new ApiError("validation");
    const price = toMinor(a.price as number, ctx.owner.currency);
    if (price < 0) throw new ApiError("validation");
    if (await storage.findMenuByName(ctx.owner.id, name)) return { ok: false, error: ctx.lang === "ja" ? `「${name}」というメニューはすでにあります` : `A menu called "${name}" already exists.` };
    const all = await storage.listMenus(ctx.owner.id);
    const desc = str(a.description) ?? "";
    const m = await storage.createMenu({ ownerId: ctx.owner.id, nameJa: name, nameEn: name, minutes, price, currency: ctx.owner.currency,
      descriptionJa: desc, descriptionEn: desc, active: true, sortOrder: all.length });
    const v = storage.menuView(m, ctx.lang);
    return { ok: true, menu: { id: v.id, name: v.name, minutes: v.minutes, price: v.price } };
  },
  async update_menu(ctx, a) {
    const menu = await requireMenu(ctx, a.menu_name);
    const patch: Record<string, unknown> = {};
    const nn = str(a.new_name);
    if (nn) { patch.nameJa = nn; patch.nameEn = nn; }
    if (a.minutes !== undefined) { const m = int(a.minutes) ?? 0; if (m <= 0) throw new ApiError("validation"); patch.minutes = m; }
    if (a.price !== undefined) { const p = toMinor(a.price as number, ctx.owner.currency); if (p < 0) throw new ApiError("validation"); patch.price = p; }
    if (a.active !== undefined) patch.active = bool(a.active);
    const m = await storage.updateMenu(ctx.owner.id, menu.id, patch);
    const v = storage.menuView(m ?? menu, ctx.lang);
    return { ok: true, menu: { id: v.id, name: v.name, minutes: v.minutes, price: v.price, active: v.active } };
  },
  async create_reservation(ctx, a) {
    const menu = a.menu_name ? await requireMenu(ctx, a.menu_name) : undefined;
    const pm = str(a.payment_method) || "onsite";
    if (pm !== "card" && pm !== "onsite") throw new ApiError("validation");
    const member = await optionalStaff(ctx, a.staff_name);
    const r = await createReservationFor(ctx.owner, {
      menu, date: str(a.date) ?? "", time: str(a.time) ?? "", endTime: str(a.end_time) || undefined, customerName: str(a.customer_name) ?? "",
      customerPhone: str(a.customer_phone), customerEmail: str(a.customer_email), paymentMethod: pm, source: "owner", lang: ctx.lang, staffId: member?.id,
    });
    const row = await storage.getReservation(ctx.owner.id, r.reservation.id);
    // メニューなしの予約が同じ長さで続いていたら、メニューへの登録を一度だけ勧める
    const s = menu ? null : await menuSuggestion(ctx.owner, r.reservation.minutes, ctx.lang);
    if (s) ctx.owner = s.owner;
    const suggestion = s?.text;
    return { ok: true, reservation: row ? view(ctx, row) : r.reservation, ...(suggestion ? { suggestion } : {}),
      paymentLink: pm === "card" ? (r.paymentNote === "failed" ? "failed" : r.paymentNote === "placeholder" ? "placeholder_created" : "created") : null,
      email: r.emailNote,
      note: [
        pm === "card" ? (ctx.lang === "ja" ? "支払いリンクを用意しました。" : "A payment link has been prepared.") : "",
        r.emailNote === "sent" ? (ctx.lang === "ja" ? "確認メールを送りました。" : "A confirmation email was sent.")
          : r.emailNote === "logged" ? (ctx.lang === "ja" ? "メールの設定がないため、確認メールは送らずに記録だけしました。" : "Email is not configured, so the confirmation was only logged.")
          : r.emailNote === "limit" ? (ctx.lang === "ja" ? "本日のメール送信の上限に達したため、確認メールは送っていません。" : "Today's email limit was reached, so no confirmation email was sent.")
          : r.emailNote === "failed" ? (ctx.lang === "ja" ? "確認メールを送れませんでした。" : "The confirmation email could not be sent.")
          : r.emailNote === "unregistered" ? (ctx.lang === "ja" ? "お店を登録していないため、確認メールは送っていません。登録すると送れるようになります。" : "The shop is not registered yet, so no confirmation email was sent. Registering turns emails on.") : "",
      ].filter(Boolean).join(" ") };
  },
  async create_recurring_reservations(ctx, a) {
    const menu = a.menu_name ? await requireMenu(ctx, a.menu_name) : undefined;
    const first = str(a.first_date) ?? "";
    if (!isValidDate(first)) throw new ApiError("invalid_date");
    const count = Math.min(Math.max(int(a.count) ?? 0, 1), 12);
    const every = Math.min(Math.max(int(a.every_weeks) ?? 1, 1), 4);
    const member = await optionalStaff(ctx, a.staff_name);
    const made: { date: string; weekday: string; time: string }[] = [];
    const skipped: { date: string; reason: string }[] = [];
    for (let i = 0; i < count; i++) {
      const date = addDays(first, 7 * every * i);
      try {
        const r = await createReservationFor(ctx.owner, {
          menu, date, time: str(a.time) ?? "", endTime: str(a.end_time) || undefined, customerName: str(a.customer_name) ?? "",
          customerPhone: str(a.customer_phone), paymentMethod: "onsite", source: "owner", lang: ctx.lang, sendEmail: made.length === 0, staffId: member?.id,
        });
        made.push({ date, weekday: weekdayLabel(date, ctx.lang), time: r.reservation.time });
      } catch (e) {
        if (!(e instanceof ApiError || e instanceof BookingError)) throw e;
        // 名前がない・時刻の形が違うなど、全部に効く間違いはそこで止める
        if (["name_required", "invalid_time", "end_or_menu_required"].includes(e.code)) throw e;
        skipped.push({ date, reason: errorMessage(e.code, ctx.lang, e.params) });
      }
    }
    return { ok: made.length > 0, created: made, skipped, ...(made.length ? {} : { error: skipped[0]?.reason ?? errorMessage("validation", ctx.lang) }) };
  },
  async update_reservation(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    const menu = a.menu_name ? await requireMenu(ctx, a.menu_name) : undefined;
    const date = str(a.date), time = str(a.time), endTime = str(a.end_time) || undefined;
    if (date && !isValidDate(date)) throw new ApiError("invalid_date");
    if (time && !isValidTime(time)) throw new ApiError("invalid_time");
    const member = await optionalStaff(ctx, a.staff_name);
    const r = await updateReservationFor(ctx.owner, row, { date, time, endTime, menu, lang: ctx.lang, staffId: member?.id });
    const updated = await storage.getReservation(ctx.owner.id, row.id);
    return { ok: true, reservation: updated ? view(ctx, updated) : r.reservation };
  },
  async cancel_reservation(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    const r = await cancelReservationFor(ctx.owner, row, ctx.lang);
    const updated = await storage.getReservation(ctx.owner.id, row.id);
    const note = !r.wasPaid ? "" : r.refundEligible
      ? (ctx.lang === "ja" ? "キャンセルの決まりでは全額返金の対象です。返金はオーナーご本人が Stripe で行ってください。" : "Under the cancellation policy this is eligible for a full refund. Please issue it yourself in Stripe.")
      : (ctx.lang === "ja" ? "キャンセルの期限を過ぎているため、決まりでは返金の対象外です。" : "The cancellation deadline has passed, so this is not refundable under the policy.");
    return { ok: true, reservation: updated ? view(ctx, updated) : r.reservation, wasPaid: r.wasPaid, refundEligible: r.refundEligible, note };
  },
  async add_blocked_slot(ctx, a) {
    const member = await optionalStaff(ctx, a.staff_name);
    const b = await addBlockedSlotFor(ctx.owner, { date: str(a.date) ?? "", start: str(a.start) || undefined, end: str(a.end) || undefined, reason: str(a.reason), staffId: member?.id });
    return { ok: true, blockedSlot: { id: b.id, date: str(a.date), start: str(a.start) ?? null, end: str(a.end) ?? null, reason: b.reason, staffName: member?.name ?? null } };
  },
  async delete_blocked_slot(ctx, a) {
    const ok = await storage.deleteBlockedSlot(ctx.owner.id, int(a.blocked_slot_id) ?? 0);
    if (!ok) throw new ApiError("blocked_slot_not_found", 404);
    return { ok: true };
  },
  async create_payment_link(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    if (row.paymentMethod !== "card" || row.paymentStatus !== "unpaid") throw new ApiError("not_card_unpaid");
    const link = await createPaymentLink(ctx.owner, row);
    await storage.updateReservation(ctx.owner.id, row.id, { paymentUrl: link.url, stripeSessionId: link.sessionId });
    return { ok: true, placeholder: link.placeholder, note: link.placeholder
      ? (ctx.lang === "ja" ? "Stripe のキーが未設定のため仮のリンクです。" : "Stripe is not configured, so this is a placeholder link.") : "" };
  },
  async update_customer(ctx, a) {
    const c = await requireCustomer(ctx, a.customer_id);
    const patch: Partial<Pick<typeof c, "name" | "phone" | "email" | "notes">> = {};
    const note = str(a.add_note);
    // メモは消さずに日付つきで書き足す（古いものから消えるよう、長くなりすぎたら頭を切る）
    if (note) patch.notes = [c.notes, `${todayFor(ctx.owner)} ${note}`].filter(Boolean).join("\n").slice(-2000);
    const phone = str(a.phone);
    if (phone !== undefined) patch.phone = storage.cleanPhone(phone);
    const email = str(a.email);
    if (email !== undefined) {
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError("invalid_email");
      patch.email = email || null;
    }
    const name = str(a.name);
    if (name) patch.name = storage.cleanName(name);
    if (!Object.keys(patch).length) throw new ApiError("validation");
    const u = (await storage.updateCustomer(ctx.owner.id, c.id, patch)) ?? c;
    return { ok: true, customer: { id: u.id, name: u.name, phone: u.phone || null, email: u.email, notes: u.notes || null } };
  },
  async create_coupon(ctx, a) {
    const code = normalizeCode(str(a.code) ?? "");
    if (!code || code.length > 40) throw new ApiError("validation");
    const percent = int(a.percent_off);
    const amount = a.amount_off !== undefined && a.amount_off !== null && a.amount_off !== "" ? toMinor(a.amount_off as number, ctx.owner.currency) : undefined;
    if ((percent === undefined) === (amount === undefined)) throw new ApiError("validation");
    if (percent !== undefined && (percent < 1 || percent > 100)) throw new ApiError("validation");
    if (amount !== undefined && amount <= 0) throw new ApiError("validation");
    const expiresOn = str(a.expires_on) || null;
    if (expiresOn && !isValidDate(expiresOn)) throw new ApiError("invalid_date");
    if (await storage.getCouponByCode(ctx.owner.id, code)) throw new ApiError("coupon_exists", 409, { code });
    const c = await storage.createCoupon({ ownerId: ctx.owner.id, code, kind: percent !== undefined ? "percent" : "amount", value: percent ?? amount!, expiresOn });
    return { ok: true, coupon: { code: c.code, off: couponOff(ctx, c), expiresOn: c.expiresOn } };
  },
  async stop_coupon(ctx, a) {
    const c = await storage.getCouponByCode(ctx.owner.id, normalizeCode(str(a.code) ?? ""));
    if (!c) throw new ApiError("coupon_invalid");
    await storage.updateCoupon(ctx.owner.id, c.id, { active: false });
    return { ok: true, code: c.code };
  },
  async create_staff(ctx, a) {
    const r = await createStaffFor(ctx.owner, {
      name: str(a.name), email: str(a.email) || null, treats: bool(a.treats), acceptNominated: bool(a.accept_nominated), acceptFree: bool(a.accept_free),
      menuIds: (await menuIdsFrom(ctx, a.menu_names)) ?? null, role: str(a.role) === "manager" ? "manager" : "staff",
    }, ctx.lang);
    const member = (await storage.getStaff(ctx.owner.id, r.staff.id))!;
    return { ok: true, staff: await staffView(ctx, member), invite: r.invite ? r.invite.email : null, ...(await seatsFor(ctx.owner.id)) };
  },
  async update_staff(ctx, a) {
    const member = await storage.findStaffByName(ctx.owner.id, str(a.staff_name) ?? "")
      ?? (await storage.listStaff(ctx.owner.id)).find((s) => s.name === storage.cleanName(str(a.staff_name) ?? "")); // 在籍をやめた人も直せるように
    if (!member) throw new ApiError("staff_not_found", 404);
    const role = str(a.role);
    const updated = await updateStaffFor(ctx.owner, member, {
      name: str(a.new_name) || undefined, email: a.email !== undefined ? str(a.email) || null : undefined,
      treats: bool(a.treats), acceptNominated: bool(a.accept_nominated), acceptFree: bool(a.accept_free), active: bool(a.active),
      menuIds: await menuIdsFrom(ctx, a.menu_names), role: role === "manager" || role === "staff" ? role : undefined,
      hourlyWage: a.hourly_wage !== undefined ? toMinor(a.hourly_wage as number, ctx.owner.currency) : undefined,
      nominationFee: a.nomination_fee !== undefined ? toMinor(a.nomination_fee as number, ctx.owner.currency) : undefined,
      commissionPercent: int(a.commission_percent),
    });
    let invite: string | null = null;
    const fresh = (await storage.getStaff(ctx.owner.id, member.id))!;
    if (bool(a.send_invite) || (a.email && !fresh.passwordHash)) invite = (await inviteStaff(ctx.owner, fresh)).email;
    return { ok: true, staff: await staffView(ctx, (await storage.getStaff(ctx.owner.id, updated.id)) ?? fresh), invite, ...(await seatsFor(ctx.owner.id)) };
  },
  async confirm_attendance(ctx, a) {
    const member = await optionalStaff(ctx, a.staff_name);
    const onlyOk = bool(a.only_ok) ?? true;
    const r = await confirmEntriesFor(ctx.owner, { staffId: member?.id, onlyOk });
    return { ok: true, confirmed: r.confirmed, stillNeedsCheck: r.leftToCheck,
      note: r.leftToCheck ? (ctx.lang === "ja" ? `確認が必要な打刻が${r.leftToCheck}件残っています。時刻を直すか、「それも確認して」と言ってください。` : `${r.leftToCheck} record(s) still need checking. Correct the times, or say to confirm them too.`) : "" };
  },
  async correct_attendance(ctx, a) {
    const member = await optionalStaff(ctx, a.staff_name);
    const date = str(a.date) ?? "";
    if (!member || !isValidDate(date)) throw new ApiError("validation");
    const entry = await findEntry(ctx, member.id, date);
    const e = await correctEntryFor(ctx.owner, entry, { clockIn: str(a.clock_in) || undefined, clockOut: str(a.clock_out) || undefined });
    const { id: _i, staffId: _s, ...v } = entryView(ctx.owner, e, member.name, ctx.lang);
    return { ok: true, entry: v };
  },
  async add_expense(ctx, a) {
    const e = await addExpenseFor(ctx.owner, { date: str(a.date) || undefined, amountMinor: toMinor(a.amount as number, ctx.owner.currency), category: str(a.category), memo: str(a.memo) });
    return { ok: true, expense: { id: e.id, date: e.date, amount: money(e.amount, ctx.owner.currency, ctx.lang), category: categoryLabel(e.category, ctx.lang), memo: e.memo } };
  },
  async sell_ticket(ctx, a) {
    const name = storage.cleanName(str(a.customer_name) ?? "");
    if (!name) throw new ApiError("name_required");
    const found = await storage.findCustomersByName(ctx.owner.id, name);
    const exact = found.filter((c) => c.name === name);
    const customer = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : found.length === 0 ? await storage.upsertCustomer(ctx.owner.id, name, "") : null;
    if (!customer) return { ok: false, error: ctx.lang === "ja" ? `「${name}」さんが${found.length}人います。電話番号などで、どの方か教えてください` : `There are ${found.length} customers named ${name}. Which one?` };
    if (a.ticket_type) {
      const type = await requireTicketType(ctx, a.ticket_type);
      const t = await sellFromType(ctx.owner, customer.id, type);
      const { id: _i, customerId: _c, menuId: _m, ...v } = ticketView(t, ctx.owner, ctx.lang, todayFor(ctx.owner));
      return { ok: true, customer: customer.name, ticket: v };
    }
    const kind = str(a.kind) === "credit" ? "credit" : "count";
    const menu = a.menu_name ? await requireMenu(ctx, a.menu_name) : undefined;
    const total = kind === "count" ? int(a.count) ?? 0 : toMinor(a.amount as number, ctx.owner.currency);
    const t = await sellTicketFor(ctx.owner, { customerId: customer.id, kind, name: str(a.name) ?? "", total, priceMinor: toMinor(a.price as number, ctx.owner.currency), menuId: menu?.id ?? null, expiresOn: str(a.expires_on) || null });
    const { id: _i, customerId: _c, menuId: _m, ...v } = ticketView(t, ctx.owner, ctx.lang, todayFor(ctx.owner));
    return { ok: true, customer: customer.name, ticket: v };
  },
  async set_followup(ctx, a) {
    const days = int(a.days);
    if (days === undefined || days < 0 || days > 365) throw new ApiError("validation");
    ctx.owner = await storage.updateOwner(ctx.owner.id, { followupAfterDays: days });
    return { ok: true, followupAfterDays: days };
  },
  async get_capabilities(ctx) {
    const strip = (xs: Ability[]) => xs.map(({ title, detail, say }) => ({ title, detail, say }));
    const c = await capabilitiesFor(ctx.owner, ctx.lang);
    return { ok: true, ready: strip(c.ready), always: strip(c.always), next: strip(c.next) };
  },
  async get_ticket_types(ctx) {
    const menus = await storage.listMenus(ctx.owner.id);
    const tickets = await storage.listTickets(ctx.owner.id);
    return { ok: true, types: (await storage.listTicketTypes(ctx.owner.id)).map((t) => {
      const { id: _i, ...v } = ticketTypeView(t, ctx.owner, ctx.lang, t.menuId ? storage.menuView(menus.find((m) => m.id === t.menuId) ?? menus[0], ctx.lang).name : null);
      return { ...v, sold: tickets.filter((x) => x.typeId === t.id).length };
    }) };
  },
  async create_ticket_type(ctx, a) {
    const name = (str(a.name) ?? "").slice(0, 60);
    const kind = str(a.kind) === "credit" ? "credit" : "count";
    const total = kind === "count" ? int(a.count) ?? 0 : a.amount !== undefined ? toMinor(a.amount as number, ctx.owner.currency) : 0;
    const price = toMinor(a.price as number, ctx.owner.currency);
    const validDays = int(a.valid_days);
    if (!name || !(total > 0) || !(price >= 0) || (validDays !== undefined && !(validDays > 0 && validDays <= 3650))) throw new ApiError("validation");
    if (await storage.findTicketTypeByName(ctx.owner.id, name).then((t) => t?.name === name)) return { ok: false, error: ctx.lang === "ja" ? `「${name}」という種類はすでにあります` : `A type called "${name}" already exists.` };
    const menu = a.menu_name ? await requireMenu(ctx, a.menu_name) : undefined;
    const t = await storage.createTicketType({ ownerId: ctx.owner.id, name, kind, total, price, menuId: menu?.id ?? null, validDays: validDays ?? null });
    const { id: _i, ...v } = ticketTypeView(t, ctx.owner, ctx.lang, menu ? storage.menuView(menu, ctx.lang).name : null);
    return { ok: true, type: v };
  },
  async stop_ticket_type(ctx, a) {
    const t = await requireTicketType(ctx, a.name);
    await storage.updateTicketType(ctx.owner.id, t.id, { active: false });
    return { ok: true, name: t.name };
  },
  async use_ticket(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    const r = await useTicketFor(ctx.owner, row, undefined, a.amount !== undefined ? toMinor(a.amount as number, ctx.owner.currency) : undefined);
    const { id: _i, customerId: _c, menuId: _m, ...t } = ticketView(r.ticket, ctx.owner, ctx.lang, todayFor(ctx.owner));
    return { ok: true, reservation: view(ctx, r.reservation), ticket: t };
  },
  async delete_expense(ctx, a) {
    if (!(await storage.deleteExpense(ctx.owner.id, int(a.expense_id) ?? 0))) throw new ApiError("not_found", 404);
    return { ok: true };
  },
  async create_shop_group(ctx, a) {
    const g = await createGroupFor(ctx.owner, str(a.name) ?? "");
    return { ok: true, group: g.name, joinCode: g.joinCode, note: ctx.lang === "ja" ? "参加コードをほかの店のオーナーに伝えてください。" : "Give the join code to the other shop owners." };
  },
  async join_shop_group(ctx, a) {
    const g = await joinGroupFor(ctx.owner, str(a.code) ?? "");
    return { ok: true, group: g.name };
  },
  async mark_no_show(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    if (row.status !== "confirmed") throw new ApiError("not_confirmed");
    if (row.startAt.getTime() > Date.now()) throw new ApiError("no_show_too_early");
    const updated = await storage.updateReservation(ctx.owner.id, row.id, { status: "no_show" });
    return { ok: true, reservation: updated ? view(ctx, updated) : view(ctx, row) };
  },
  async record_onsite_payment(ctx, a) {
    const row = await requireReservation(ctx, a.reservation_id);
    const amount = toMinor(a.amount as number, row.currency);
    const r = await recordOnsitePaymentFor(ctx.owner, row, amount, ctx.lang, onsiteMethod(a.method));
    const note = r.differs ? (ctx.lang === "ja"
      ? `料金${money(row.price, row.currency, ctx.lang).display}と受け取り額${money(amount, row.currency, ctx.lang).display}が違います`
      : `The price ${money(row.price, row.currency, ctx.lang).display} and the amount received ${money(amount, row.currency, ctx.lang).display} differ.`) : "";
    const updated = await storage.getReservation(ctx.owner.id, row.id);
    return { ok: true, reservation: updated ? view(ctx, updated) : r.reservation, note };
  },
};

/**
 * 確認文のもとになる、人が読める要約。参照（メニュー名・予約 id）を実物に解決してから作る。
 * 相談モデルはこれを一文に整える。モデルが使えないときは、この文をそのまま読み上げる。
 */
export async function describeAction(ctx: ToolContext, name: string, a: Record<string, unknown>): Promise<string> {
  const ja = ctx.lang === "ja";
  const o = ctx.owner;
  const when = (date?: string, time?: string) => date ? spokenWhen(date, time, ctx.lang) : "";
  const menuLine = async (n: unknown) => { const m = n ? await storage.findMenuByName(o.id, String(n)) : undefined; return m ? `${storage.menuView(m, ctx.lang).name}（${storage.menuView(m, ctx.lang).price.display}）` : String(n ?? ""); };
  const resLine = async (id: unknown) => { const n = int(id); const r = n ? await storage.getReservation(o.id, n) : undefined; if (!r) return ja ? "見つからない予約" : "an unknown booking"; const v = storage.reservationView(r, o.timezone, ctx.lang); return `${when(v.date, v.time)} ${v.customerName}${ja ? "さん" : ""}${v.menuName ? ` ${v.menuName}` : ""}`; };
  const until = (end: unknown) => end ? (ja ? `から${spokenTime(String(end))}まで` : ` to ${end}`) : "";
  const fmt = (v: unknown) => { try { return money(toMinor(v as number, o.currency), o.currency, ctx.lang).display; } catch { return String(v); } };
  switch (name) {
    case "create_reservation": {
      const who = storage.cleanName(str(a.customer_name) ?? "");
      const menu = a.menu_name ? await menuLine(a.menu_name) : "";
      const card = a.payment_method === "card";
      return ja
        ? `${when(str(a.date), str(a.time))}${until(a.end_time)}、${who}さん${menu ? `、${menu}` : ""}${a.staff_name ? `、担当は${a.staff_name}さん` : ""}、${card ? "カード前払い" : "当日払い"}で予約を入れる`
        : `book ${who}${menu ? ` for ${menu}` : ""}${a.staff_name ? ` with ${a.staff_name}` : ""} on ${when(str(a.date), str(a.time))}${until(a.end_time)}, paying ${card ? "by card in advance" : "at the shop"}`;
    }
    case "create_recurring_reservations": {
      const who = storage.cleanName(str(a.customer_name) ?? "");
      const first = str(a.first_date) ?? "";
      const every = int(a.every_weeks) ?? 1;
      const wd = isValidDate(first) ? weekdayLabel(first, ctx.lang) : "";
      const span = ja ? (every === 1 ? "毎週" : `${every}週ごとの`) : every === 1 ? "every" : `every ${every} weeks on`;
      return ja
        ? `${span}${wd}${until(a.end_time) ? `、${spokenTime(str(a.time) ?? "")}${until(a.end_time)}` : `の${spokenTime(str(a.time) ?? "")}から`}、${who}さんの予約を、${when(first)}から${a.count}回分入れる`
        : `book ${who} ${span} ${wd} at ${a.time}${until(a.end_time)}, ${a.count} times starting ${when(first)}`;
    }
    case "update_reservation": {
      const cur = int(a.reservation_id) ? await storage.getReservation(o.id, int(a.reservation_id)!) : undefined;
      const curDate = cur ? storage.reservationView(cur, o.timezone, ctx.lang).date : "";
      const parts = [a.date || a.time ? when(str(a.date) ?? curDate, str(a.time)) + until(a.end_time) : a.end_time ? (ja ? `終わりを${spokenTime(String(a.end_time))}` : `ending at ${a.end_time}`) : "", a.menu_name ? await menuLine(a.menu_name) : "",
        a.staff_name ? (ja ? `担当を${a.staff_name}さん` : `staff ${a.staff_name}`) : ""].filter(Boolean).join(ja ? "、" : ", ");
      return ja ? `${await resLine(a.reservation_id)}の予約を、${parts}に変更する` : `change the booking for ${await resLine(a.reservation_id)} to ${parts}`;
    }
    case "cancel_reservation": return ja ? `${await resLine(a.reservation_id)}の予約を取り消す` : `cancel the booking for ${await resLine(a.reservation_id)}`;
    case "record_onsite_payment": {
      const how = ONSITE_METHOD_LABELS[ctx.lang][onsiteMethod(a.method)];
      return ja ? `${await resLine(a.reservation_id)}の現地払いとして、${how}で${fmt(a.amount)}を受け取ったと記録する` : `record ${fmt(a.amount)} received on site by ${how} for ${await resLine(a.reservation_id)}`;
    }
    case "create_payment_link": return ja ? `${await resLine(a.reservation_id)}の支払いリンクを作り直す` : `recreate the payment link for ${await resLine(a.reservation_id)}`;
    case "create_menu": return ja ? `メニュー「${a.name}」を${a.minutes}分、${fmt(a.price)}で作る` : `create the menu "${a.name}", ${a.minutes} minutes, ${fmt(a.price)}`;
    case "update_menu": {
      const ch = [a.new_name ? (ja ? `名前を「${a.new_name}」に` : `rename to "${a.new_name}"`) : "", a.minutes !== undefined ? (ja ? `所要時間を${a.minutes}分に` : `${a.minutes} minutes`) : "",
        a.price !== undefined ? (ja ? `料金を${fmt(a.price)}に` : `price ${fmt(a.price)}`) : "", a.active !== undefined ? (bool(a.active) ? (ja ? "提供を再開" : "make active") : (ja ? "提供をやめる" : "make inactive")) : ""].filter(Boolean).join(ja ? "、" : ", ");
      return ja ? `メニュー「${a.menu_name}」を${ch}変更する` : `change the menu "${a.menu_name}": ${ch}`;
    }
    case "add_blocked_slot": {
      const who = a.staff_name ? (ja ? `${a.staff_name}さんを` : `${a.staff_name} `) : "";
      return ja ? `${when(str(a.date), str(a.start))}${a.end ? `から${a.end}まで` : "は終日"}${who}お休みにする${a.reason ? `（${a.reason}）` : ""}` : `block ${who}${when(str(a.date), str(a.start))}${a.end ? ` to ${a.end}` : " all day"}${a.reason ? ` (${a.reason})` : ""}`;
    }
    case "delete_blocked_slot": return ja ? "お休みの枠を取り消す" : "remove the time-off slot";
    case "create_coupon": {
      const off = a.percent_off !== undefined ? (ja ? `${a.percent_off}%引き` : `${a.percent_off}% off`) : (ja ? `${fmt(a.amount_off)}引き` : `${fmt(a.amount_off)} off`);
      const until2 = a.expires_on ? (ja ? `、${when(str(a.expires_on))}まで` : `, until ${when(str(a.expires_on))}`) : "";
      return ja ? `クーポン「${normalizeCode(String(a.code))}」を${off}${until2}で作る` : `create the coupon "${normalizeCode(String(a.code))}", ${off}${until2}`;
    }
    case "stop_coupon": return ja ? `クーポン「${normalizeCode(String(a.code))}」を使えなくする` : `stop the coupon "${normalizeCode(String(a.code))}"`;
    case "create_staff": {
      const limits = [bool(a.treats) === false ? (ja ? "施術はしない" : "does not treat") : "",
        bool(a.accept_nominated) === false ? (ja ? "指名は受けない" : "no nominations") : "", bool(a.accept_free) === false ? (ja ? "フリーは受けない" : "no free bookings") : "",
        Array.isArray(a.menu_names) && a.menu_names.length ? (ja ? `${(a.menu_names as string[]).join("と")}のみ` : `only ${(a.menu_names as string[]).join(", ")}`) : "",
        a.role === "manager" ? (ja ? "マネージャー" : "manager") : ""].filter(Boolean).join(ja ? "、" : ", ");
      const invite = a.email ? (ja ? `、${a.email}にログインの招待を送る` : `, and send a login invitation to ${a.email}`) : "";
      return ja ? `スタッフ「${a.name}」を登録する${limits ? `（${limits}）` : ""}${invite}` : `add staff "${a.name}"${limits ? ` (${limits})` : ""}${invite}`;
    }
    case "update_staff": {
      const ch = [a.new_name ? (ja ? `名前を${a.new_name}に` : `rename to ${a.new_name}`) : "", a.email !== undefined ? (ja ? `メールを${a.email}に` : `email ${a.email}`) : "",
        a.treats !== undefined ? (bool(a.treats) ? (ja ? "施術する" : "treats") : (ja ? "施術しない" : "does not treat")) : "",
        a.accept_nominated !== undefined ? (bool(a.accept_nominated) ? (ja ? "指名を受ける" : "takes nominations") : (ja ? "指名は受けない" : "no nominations")) : "",
        a.accept_free !== undefined ? (bool(a.accept_free) ? (ja ? "フリーを受ける" : "takes free bookings") : (ja ? "フリーは受けない" : "no free bookings")) : "",
        Array.isArray(a.menu_names) ? (ja ? `受けるコースを${(a.menu_names as string[]).join("と")}に` : `services: ${(a.menu_names as string[]).join(", ")}`) : "",
        a.role ? (ja ? `役割を${a.role === "manager" ? "マネージャー" : "スタッフ"}に` : `role ${a.role}`) : "",
        a.active === false || a.active === "false" ? (ja ? "在籍をやめる（ログインもできなくなる）" : "remove from the team (login stops)") : a.active !== undefined ? (ja ? "在籍に戻す" : "bring back to the team") : "",
        bool(a.send_invite) ? (ja ? "ログインの招待を送り直す" : "resend the login invitation") : "",
        a.hourly_wage !== undefined ? (ja ? `時給を${fmt(a.hourly_wage)}に` : `hourly wage ${fmt(a.hourly_wage)}`) : "",
        a.nomination_fee !== undefined ? (ja ? `指名料を${fmt(a.nomination_fee)}に` : `nomination fee ${fmt(a.nomination_fee)}`) : "",
        a.commission_percent !== undefined ? (ja ? `歩合を${a.commission_percent}%に` : `commission ${a.commission_percent}%`) : ""].filter(Boolean).join(ja ? "、" : ", ");
      return ja ? `スタッフ「${a.staff_name}」を、${ch}` : `for staff "${a.staff_name}": ${ch}`;
    }
    case "confirm_attendance": {
      const who = a.staff_name ? (ja ? `${a.staff_name}さんの` : `${a.staff_name}'s `) : "";
      return bool(a.only_ok) === false
        ? (ja ? `${who}確認待ちの打刻を、要確認のものも含めてすべて確認済みにする` : `confirm all of ${who}pending clock records, including those needing a check`)
        : (ja ? `${who}予定どおりの打刻を確認済みにする` : `confirm ${who}clock records that are on plan`);
    }
    case "correct_attendance": {
      const ch = [a.clock_in ? (ja ? `出勤を${a.clock_in}` : `in ${a.clock_in}`) : "", a.clock_out ? (ja ? `退勤を${a.clock_out}` : `out ${a.clock_out}`) : ""].filter(Boolean).join(ja ? "、" : ", ");
      return ja ? `${when(str(a.date))}の${a.staff_name}さんの打刻を、${ch}に直す` : `correct ${a.staff_name}'s clock record on ${when(str(a.date))}: ${ch}`;
    }
    case "create_ticket_type": {
      const size = a.kind === "credit" ? (ja ? `${fmt(a.amount)}分の前払い` : `prepaid credit of ${fmt(a.amount)}`) : (ja ? `${a.menu_name ? `${a.menu_name}を` : ""}${a.count}回` : `${a.count} visits${a.menu_name ? ` of ${a.menu_name}` : ""}`);
      const valid = a.valid_days ? (ja ? `、売った日から${a.valid_days}日有効` : `, valid ${a.valid_days} days`) : (ja ? "、期限なし" : ", no expiry");
      return ja ? `回数券の種類「${a.name}」（${size}、${fmt(a.price)}${valid}）を作る` : `create the ticket type "${a.name}" (${size}, ${fmt(a.price)}${valid})`;
    }
    case "stop_ticket_type": return ja ? `回数券の種類「${a.name}」の販売をやめる` : `stop selling the ticket type "${a.name}"`;
    case "sell_ticket": {
      if (a.ticket_type) {
        const tt = await storage.findTicketTypeByName(o.id, String(a.ticket_type));
        const who = storage.cleanName(str(a.customer_name) ?? "");
        if (tt) return ja ? `${who}さんに、${tt.name}を${money(tt.price, o.currency, ctx.lang).display}で売ったと記録する${tt.validDays ? `（${tt.validDays}日有効）` : ""}` : `record selling ${tt.name} to ${who} for ${money(tt.price, o.currency, ctx.lang).display}`;
      }
      const what = a.kind === "credit" ? (ja ? `前払い${fmt(a.amount)}分` : `prepaid credit of ${fmt(a.amount)}`) : (ja ? `${a.name || `${a.count}回券`}（${a.count}回）` : `${a.name || `${a.count}-visit ticket`} (${a.count} visits)`);
      return ja ? `${storage.cleanName(str(a.customer_name) ?? "")}さんに、${what}を${fmt(a.price)}で売ったと記録する${a.expires_on ? `（期限は${when(str(a.expires_on))}）` : ""}` : `record selling ${what} to ${a.customer_name} for ${fmt(a.price)}`;
    }
    case "set_followup": return Number(a.days) > 0
      ? (ja ? `前回の来店から${a.days}日あいたお客さんに、「そろそろいかがですか」のメールを送るようにする` : `email customers "time for your next visit?" ${a.days} days after their last visit`)
      : (ja ? "次回の声かけのメールを送らないようにする" : "stop next-visit suggestion emails");
    case "use_ticket": return ja ? `${await resLine(a.reservation_id)}の支払いに、回数券か前払いを使う` : `pay for ${await resLine(a.reservation_id)} with a ticket or prepaid credit`;
    case "add_expense": {
      const c = str(a.category);
      const cat = categoryLabel(c ? c : guessCategory(str(a.memo) ?? ""), ctx.lang);
      return ja ? `${when(str(a.date) || todayFor(o))}に、${cat}「${a.memo}」${fmt(a.amount)}を経費として記録する` : `record an expense on ${when(str(a.date) || todayFor(o))}: ${cat}, "${a.memo}", ${fmt(a.amount)}`;
    }
    case "delete_expense": {
      const e = int(a.expense_id) ? await storage.getExpense(o.id, int(a.expense_id)!) : undefined;
      return e ? (ja ? `${when(e.date)}の経費「${e.memo || categoryLabel(e.category, ctx.lang)}」${money(e.amount, o.currency, ctx.lang).display}を消す` : `delete the expense "${e.memo}" (${money(e.amount, o.currency, ctx.lang).display}) on ${when(e.date)}`) : (ja ? "経費を消す" : "delete an expense");
    }
    case "create_shop_group": return ja ? `集計を見せ合う店舗グループ${a.name ? `「${a.name}」` : ""}を作る` : `create a shop group${a.name ? ` "${a.name}"` : ""} for sharing totals`;
    case "join_shop_group": return ja ? `参加コード${String(a.code).toUpperCase()}の店舗グループに入り、売り上げと件数を見せ合う` : `join the shop group with code ${String(a.code).toUpperCase()} and share totals`;
    case "mark_no_show": return ja ? `${await resLine(a.reservation_id)}の予約を、無断キャンセルとして記録する` : `record the booking for ${await resLine(a.reservation_id)} as a no-show`;
    case "update_customer": {
      const n = int(a.customer_id);
      const c = n ? await storage.getCustomer(o.id, n) : undefined;
      const who = c ? (ja ? `${c.name}さん` : c.name) : (ja ? "お客さん" : "the customer");
      const ch = [a.add_note ? (ja ? `メモに「${a.add_note}」を書き足す` : `add the note "${a.add_note}"`) : "",
        a.phone !== undefined ? (ja ? `電話番号を${a.phone}にする` : `set the phone to ${a.phone}`) : "",
        a.email !== undefined ? (ja ? `メールアドレスを${a.email}にする` : `set the email to ${a.email}`) : "",
        a.name ? (ja ? `名前を${a.name}にする` : `rename to ${a.name}`) : ""].filter(Boolean).join(ja ? "、" : ", ");
      return ja ? `${who}の記録で、${ch}` : `for ${who}: ${ch}`;
    }
    case "set_business_hours": {
      const d = String(a.day);
      const label = d === "all" ? (ja ? "毎日" : "every day") : d === "weekdays" ? (ja ? "平日" : "weekdays") : d === "weekend" ? (ja ? "土日" : "weekends") : WEEKDAY_LABELS[ctx.lang][WEEKDAY_KEYS.indexOf(d as WeekdayKey)] ?? d;
      const off = closedDays(a.closed_days).map((k) => WEEKDAY_LABELS[ctx.lang][WEEKDAY_KEYS.indexOf(k)]);
      const offText = off.length ? (ja ? `、${off.join("と")}を定休日にする` : `, closed on ${off.join(" and ")}`) : "";
      return (bool(a.closed) ? (ja ? `${label}を定休日にする` : `make ${label} a closing day`) : (ja ? `${label}の営業時間を${a.open}から${a.close}までにする` : `set ${label} hours to ${a.open}–${a.close}`)) + offText;
    }
    case "update_booking_rules": {
      const L: Record<string, [string, string, string, string]> = {
        buffer_minutes: ["施術間の空き時間", "gap between sessions", "分", " minutes"], slot_step_minutes: ["案内の刻み", "time step", "分", " minutes"],
        max_days_ahead: ["お客さんが予約できる先", "booking window", "日先まで", " days ahead"], min_hours_before: ["お客さんの予約の締め切り", "booking cutoff", "時間前まで", " hours before"],
        free_cancel_hours_before: ["全額返金の期限", "full-refund deadline", "時間前まで", " hours before"], allow_card_payment: ["カード前払いの許可", "card prepayment", "", ""],
        allow_nomination: ["お客さんの指名", "customer nominations", "", ""], clock_tolerance_minutes: ["打刻が予定どおりとみなせる幅", "on-plan clock window", "分", " minutes"],
        plan_horizon_days: ["勤務の予定を入れられる先", "work plan horizon", "日先まで", " days ahead"],
      };
      const ch = Object.entries(a).filter(([k, v]) => k in L && v !== undefined && v !== null).map(([k, v]) => `${L[k][ja ? 0 : 1]}${ja ? "を" : ": "}${typeof v === "boolean" ? (v ? (ja ? "あり" : "allowed") : (ja ? "なし" : "not allowed")) : `${v}${L[k][ja ? 2 : 3]}`}${ja ? "に" : ""}`).join(ja ? "、" : ", ");
      return ja ? `受付ルールを${ch}変更する` : `change booking rules: ${ch}`;
    }
    case "update_settings": {
      const ch = Object.entries(a).filter(([, v]) => v).map(([k, v]) => `${({ country: ja ? "国" : "country", currency: ja ? "通貨" : "currency", timezone: ja ? "時間帯" : "time zone", language: ja ? "言語" : "language" } as Record<string, string>)[k] ?? k}${ja ? "を" : ": "}${v}${ja ? "に" : ""}`).join(ja ? "、" : ", ");
      return ja ? `設定を${ch}変更する` : `change settings: ${ch}`;
    }
    case "update_business_info": {
      const ch = Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${({ shop_name: ja ? "店名" : "shop name", address: ja ? "住所" : "address", phone: ja ? "電話番号" : "phone", info: ja ? "案内" : "notes", business_type: ja ? "業種" : "business type", review_url: ja ? "口コミのページ" : "review page" } as Record<string, string>)[k] ?? k}${ja ? "を「" : ": "}${v}${ja ? "」に" : ""}`).join(ja ? "、" : ", ");
      return ja ? `店舗情報を${ch}変更する` : `change shop details: ${ch}`;
    }
    default: return ja ? `${name} を実行する` : `run ${name}`;
  }
}

/**
 * 書き込むツールの引数を、確認文を作る前に検査する。足りなければ理由を返し、AI に言い直させる
 * （「undefined を記録しますか」のような確認を本人に読み上げないため）
 */
export async function validateToolArgs(ctx: ToolContext, name: string, a: Record<string, unknown>): Promise<string | null> {
  const spec = TOOL_SPECS.find((t) => t.function.name === name);
  const required = (spec?.function.parameters?.required as string[] | undefined) ?? [];
  // 登録前のお店では、確認を聞く前に断る（「はい」と言ったあとに断らない）
  if (!ctx.owner.email && REGISTERED_TOOLS.has(name)) return errorMessage("registration_required", ctx.lang);
  const missing = required.filter((k) => a[k] === undefined || a[k] === null || String(a[k]).trim() === "");
  if (missing.length) return ctx.lang === "ja" ? `引数が足りません: ${missing.join(", ")}。履歴やツールで調べてから、もう一度呼んでください` : `Missing arguments: ${missing.join(", ")}. Look them up (history or tools) and call again.`;
  try {
    if ("reservation_id" in a) await requireReservation(ctx, a.reservation_id);
    if ("customer_id" in a) await requireCustomer(ctx, a.customer_id);
    if (a.staff_name && name !== "update_staff") await optionalStaff(ctx, a.staff_name);
    if (name === "update_menu" || (["create_reservation", "update_reservation", "create_recurring_reservations"].includes(name) && a.menu_name)) await requireMenu(ctx, a.menu_name);
    if (name === "sell_ticket") {
      if (a.ticket_type) await requireTicketType(ctx, a.ticket_type);
      else if (!a.kind || a.price === undefined) return ctx.lang === "ja" ? "種類（ticket_type）か、kind と price を渡してください" : "Pass ticket_type, or kind and price.";
    }
    if (name === "create_recurring_reservations") {
      if (!a.menu_name && !a.end_time) return errorMessage("end_or_menu_required", ctx.lang);
      if (!isValidDate(String(a.first_date))) return errorMessage("invalid_date", ctx.lang);
    }
    if (name === "create_reservation") {
      if (!a.menu_name && !a.end_time) return errorMessage("end_or_menu_required", ctx.lang);
      if (a.payment_method === "card" && !a.menu_name) return errorMessage("card_needs_menu", ctx.lang);
    }
    if (name === "record_onsite_payment" || name === "create_menu" || (name === "update_menu" && a.price !== undefined)) {
      const key = name === "record_onsite_payment" ? "amount" : "price";
      if (a[key] !== undefined && !(Number(a[key]) >= 0) ) return errorMessage("validation", ctx.lang);
      if (name === "record_onsite_payment" && !(Number(a.amount) > 0)) return errorMessage("validation", ctx.lang);
    }
    if (["create_reservation", "update_reservation", "add_blocked_slot", "create_recurring_reservations"].includes(name)) {
      if (a.date !== undefined && !isValidDate(String(a.date))) return errorMessage("invalid_date", ctx.lang);
      for (const k of ["time", "end_time", "start", "end"]) {
        const ok = k === "end_time" || k === "end" ? isValidCloseTime : isValidTime;
        if (a[k] !== undefined && a[k] !== "" && !ok(String(a[k]))) return errorMessage("invalid_time", ctx.lang);
      }
    }
  } catch (e) {
    if (e instanceof ApiError) return errorMessage(e.code, ctx.lang, e.params);
    throw e;
  }
  return null;
}

/** 読み上げ向けの時刻：「15時」「15時30分」（英語はそのまま） */
export function spokenTime(time: string): string {
  const [hh, mm] = time.split(":");
  return mm === undefined ? time : `${Number(hh)}時${mm === "00" ? "" : `${Number(mm)}分`}`;
}

/** 読み上げ向けの日時：「10月24日（土曜日）15時00分」/ "Saturday, October 24 at 15:00" */
export function spokenWhen(date: string, time: string | undefined, lang: Language): string {
  if (!isValidDate(date)) return `${date}${time ? ` ${time}` : ""}`;
  const [y, m, d] = date.split("-").map(Number);
  const wd = weekdayLabel(date, lang);
  if (lang === "ja") {
    const [hh, mm] = (time ?? "").split(":");
    const t = time ? `${Number(hh)}時${mm === "00" ? "" : `${Number(mm)}分`}` : "";
    return `${m}月${d}日（${wd}）${t}`;
  }
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${wd}, ${month} ${d}${time ? ` at ${time}` : ""}`;
}

/** 今日の日付などを AI に伝えるための、オーナーの時間帯での時計 */
export function clockFor(owner: Owner) {
  const now = nowLocal(owner.timezone);
  return { ...now, tomorrow: addDays(now.date, 1), month: monthRange(now.date) };
}
