/**
 * 設定を埋める。最初にまとめて聞かず、使い始めてから会話の中で聞くが、なるべく早いうちに決めてもらう。
 * - 聞く順番は SETUP_ITEMS の順。まず営業時間、次にお店の登録（登録していなければ）、それから残り
 * - 答えをもらったら、続けて次の項目を聞く（nextSetupQuestion。決めてもらえるうちに決めてもらう）
 * - 管理画面を開いたときは、まだ決まっていない項目を1つ聞く。同じ日に同じ項目は聞き直さない
 * - 「あとで」と言われたら、その日はもう聞かない。翌日開いたときにまた聞く
 * - 決まっていない項目は、決まるまで聞く（あきらめない）。「聞かないで」と言われた項目は、今のままで決めたものとして扱う
 * - お店の登録は「聞かないで」にできない（端末をなくすと記録が消えるため）。「あとで」と同じに扱う
 * - 「設定の話はもういい」と言われたら質問はやめ、開いたときに残りを1日1回だけ短く知らせる。「設定の続き」で再開
 * - 声で設定を変えたら、その項目は決まったことにする（executeTool から noteSetupProgress を呼ぶ）
 * - 以前の「最初の設定」を最後まで済ませた人には聞かない
 * - 「聞かないで」「このままでいい」「あとで」「登録する」「設定の話はもういい」「設定の続き」は決まった言い方なので、AI に任せずここで受ける（setupReply）
 */
import type { Owner, Language, SetupState } from "@shared/schema";
import { EMPTY_SETUP, WEEKDAY_KEYS } from "@shared/schema";
import { WEEKDAY_LABELS } from "@shared/i18n";
import * as storage from "../storage";
import { nowLocal } from "../lib/time";

export const SETUP_ITEMS = ["hours", "account", "menu", "contact", "info", "rules", "cancel", "notices", "followup"] as const;
export type SetupItem = (typeof SETUP_ITEMS)[number];

/** 声で変えたら決まったことにする項目 */
const TOOL_ITEMS: Record<string, SetupItem[]> = {
  set_business_hours: ["hours"], create_menu: ["menu"], set_followup: ["followup"],
};

function state(owner: Owner): SetupState {
  return { ...EMPTY_SETUP, ...(owner.setupState ?? {}) };
}

/** まだ決まっていない項目（聞かないでと言われたものは除く。「設定の話はもういい」のあとも、決まっていないものは返す） */
export async function pendingSetupItems(owner: Owner): Promise<SetupItem[]> {
  const s = state(owner);
  const hasMenu = (await storage.listMenus(owner.id, true)).length > 0;
  // お知らせの受け取り方は、ログインできるスタッフがいて、まだ決まっていないときだけ聞く
  const hasStaffLogin = (await storage.listStaff(owner.id)).some((m) => !m.isOwner && m.active && (m.passwordHash || m.inviteToken));
  // 次回の声かけは、メールのわかるお客さんができてから聞く
  const hasEmailCustomer = (await storage.listCustomers(owner.id)).some((c) => !!c.email);
  return SETUP_ITEMS.filter((item) => {
    if (item === "account") return !owner.email;
    if (s.done.includes(item) || s.skipped.includes(item)) return false;
    // 登録前のお店はメールを送らないので、次回の声かけは登録してから聞く
    if (item === "followup") return !!owner.email && hasEmailCustomer && !owner.followupAfterDays;
    if (item === "notices") return hasStaffLogin && !owner.noticePrefs;
    // 以前の「最初の設定」を済ませた人には、ほかの項目は聞かない
    if (owner.onboardingDone) return false;
    if (item === "menu" && hasMenu) return false;
    if (item === "contact" && (owner.address || owner.phone)) return false;
    if (item === "info" && owner.info) return false;
    return true;
  });
}

export function hoursText(owner: Owner, lang: Language): string {
  const ja = lang === "ja";
  const open = WEEKDAY_KEYS.map((k) => owner.hours[k]).find(Boolean);
  const closed = WEEKDAY_KEYS.filter((k) => !owner.hours[k]).map((k) => WEEKDAY_LABELS[lang][WEEKDAY_KEYS.indexOf(k)]);
  const range = open ? (ja ? `${Number(open.open.split(":")[0])}時から${Number(open.close.split(":")[0])}時まで` : `${open.open} to ${open.close}`) : "";
  const off = closed.length ? (ja ? `、お休みは${closed.join("と")}` : `, closed on ${closed.join(" and ")}`) : (ja ? "、お休みなし" : ", open every day");
  return range + off;
}

function questionFor(item: SetupItem, owner: Owner, lang: Language): string {
  const ja = lang === "ja";
  switch (item) {
    case "hours": return ja
      ? `営業時間はいつも何時から何時までですか？お休みの曜日も教えてください。今は仮に${hoursText(owner, lang)}にしてあります。`
      : `What are your usual opening hours, and which days are you closed? For now I have set ${hoursText(owner, lang)}.`;
    case "account": return ja
      ? "お店の記録は、今はこの端末にだけ結びついています。端末を替えたり、ブラウザの記録を消したりすると、元に戻せません。iPhone や iPad では、1週間ほど開かないと消えることがあり、ホーム画面に追加したアプリと Safari は別の端末として扱われます。お客さんに予約ページを渡したり、確認のメールを送ったりできるのも、登録してからです。店名とメール、ログインの方法を登録しておきませんか？"
      : "Right now your shop's records are tied to this device only. If you change devices or clear the browser's data, they cannot be recovered. On iPhone and iPad, they can also be lost if you don't open the app for about a week, and an app added to the Home Screen counts as a different device from Safari. Sharing the booking page with customers and sending confirmation emails also start once you register. Shall we register your shop name, email and how you log in?";
    case "menu": return ja
      ? "お客さんがネットからも予約できるように、メニューを一つ教えてもらえますか？たとえば「60分6000円」のように。"
      : 'So customers can also book online, could you tell me one of your services? For example, "60 minutes, 6000 yen".';
    case "contact": return ja
      ? "予約のページに載せる、お店の住所と電話番号を教えてもらえますか？"
      : "Could you tell me the shop's address and phone number for the booking page?";
    case "info": return ja
      ? "お客さんへの案内はありますか？駐車場や持ち物、着替えのことなどです。"
      : "Is there anything customers should know, such as parking, what to bring, or changing?";
    case "rules": return ja
      ? `施術と施術の間は、今${owner.bufferMinutes}分空けるようにしています。ネットからの予約は${owner.minHoursBefore}時間前まで受け付けます。このままでいいですか？`
      : `I leave ${owner.bufferMinutes} minutes between sessions, and online bookings close ${owner.minHoursBefore} hours before. Is that all right?`;
    case "cancel": return ja
      ? `キャンセルは今、${owner.freeCancelHoursBefore}時間前までなら無料にしています。このままでいいですか？`
      : `Right now cancellations are free up to ${owner.freeCancelHoursBefore} hours before. Is that all right?`;
    case "followup": return ja
      ? "前回の来店から間があいたお客さんに、「そろそろいかがですか」のメールを送りましょうか？送るなら、何日あいたら送るか教えてください。たとえば「45日」のように。"
      : "Shall I email customers who haven't been back for a while, suggesting a next visit? If so, after how many days? For example, 45.";
    case "notices": return ja
      ? "スタッフの打刻のお知らせは、予定どおりのものも毎回お伝えしますか？それとも確認が必要なものだけにしますか？確認が必要なものは、メールでもお知らせできます。"
      : "For staff clock records, should I tell you about every one, or only the ones that need checking? I can also email you the ones that need checking.";
  }
}

/** 文の終わりに添える、答え方の案内 */
function howToAnswer(item: SetupItem, lang: Language): string {
  const ja = lang === "ja";
  if (item === "account") return ja ? "登録するなら「登録する」、あとにしたいときは「あとで」と言ってください。" : ' Say "register" to do it now, or "later".';
  return ja ? "あとにしたいときは「あとで」、聞かれたくなければ「聞かないで」と言ってください。" : ' Say "later" to come back to it, or "don\'t ask" and I won\'t ask again.';
}

/**
 * 次に聞く1項目の質問文を返して、聞いたことを記録する。聞くことがなければ null。
 * - 「あとで」と言われた日は聞かない。同じ日に一度聞いた項目は聞き直さない
 * - 「設定の話はもういい」のあとは、開いたとき（chained でないとき）に残りを1日1回だけ短く知らせる
 */
export async function takeSetupQuestion(owner: Owner, lang: Language, today: string, chained = false): Promise<string | null> {
  const s = state(owner);
  if (s.postponedOn === today) return null;
  const pending = await pendingSetupItems(owner);
  if (!pending.length) return null;
  const askedToday = s.askedOn === today ? (s.askedToday ?? []) : [];
  const ja = lang === "ja";
  if (s.skipped.includes("all")) {
    if (chained || s.askedOn === today) return null;
    await storage.updateOwner(owner.id, { setupState: { ...s, askedOn: today, askedToday: [], lastAsked: undefined } });
    const names = pending.map((k) => LABELS[k][ja ? 0 : 1]).join(ja ? "、" : ", ");
    return ja
      ? `まだ決まっていない設定が${pending.length}つあります。${names}です。決めるときは「設定の続き」と言ってください。`
      : `${pending.length} setting${pending.length > 1 ? "s are" : " is"} still not decided: ${names}. Say "continue setup" when you want to decide.`;
  }
  const item = pending.find((k) => !askedToday.includes(k));
  if (!item) return null;
  await storage.updateOwner(owner.id, { setupState: { ...s, askedOn: today, askedToday: [...askedToday, item], lastAsked: item, asks: { ...s.asks, [item]: (s.asks[item] ?? 0) + 1 } } });
  return questionFor(item, owner, lang) + howToAnswer(item, lang);
}

/** 設定の質問に答えてもらった直後に、続けて次の項目を聞く（なければ null） */
export async function nextSetupQuestion(owner: Owner, lang: Language): Promise<string | null> {
  const fresh = (await storage.getOwner(owner.id)) ?? owner;
  return takeSetupQuestion(fresh, lang, nowLocal(fresh.timezone).date, true);
}

/** 項目を「決まった」か「聞かないで」にする（"all" なら設定の質問を全部やめる） */
export async function markSetupItem(owner: Owner, item: string, status: "done" | "skip"): Promise<Owner> {
  // お店の登録は、登録の画面で済ませたときだけ決まる（声で「済み」にはできない）
  if (item === "account") return owner;
  const s = state(owner);
  const key = status === "done" ? "done" : "skipped";
  const lastAsked = s.lastAsked === item || item === "all" ? undefined : s.lastAsked;
  if (s[key].includes(item) && lastAsked === s.lastAsked) return owner;
  return storage.updateOwner(owner.id, { setupState: { ...s, lastAsked, [key]: s[key].includes(item) ? s[key] : [...s[key], item] } });
}

const LABELS: Record<SetupItem, [string, string]> = {
  hours: ["営業時間", "opening hours"], account: ["お店の登録", "registering the shop"], menu: ["メニュー", "the menu"], contact: ["住所と電話番号", "the address and phone"],
  info: ["お客さんへの案内", "notes for customers"], rules: ["受付ルール", "booking rules"], cancel: ["キャンセルの決まり", "the cancellation policy"],
  notices: ["打刻のお知らせ", "clock notices"], followup: ["次回の声かけ", "next-visit suggestions"],
};
const clean = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[\s、。,.!?！？「」]/g, "");
const STOP_ALL = /設定.*(もういい|聞かないで|きかないで|いらない|やめて)|stopasking|nomoresetting|dontaskaboutsettings/;
const RESUME = /設定(の|を)?(続き|つづき|続け|つづけ|再開)|continuesetup|resumesetup/;
const REGISTER = /^(お店を|おみせを)?(登録|とうろく)(する|します|して|したい|お願い)?$|^register/;
/** 登録を聞いたあとの「はい」も登録として受ける */
const REGISTER_YES = /^(はい|うん|お願い|おねがい|する|します|やる|やります|yes|ok|okay|sure|please)/;
const SKIP = /聞かないで|きかないで|いらない|結構です|けっこうです|聞かなくていい|don'?task|noneed|skip/;
const LATER = /^(あとで|後で|また今度|今度|今はいい|いまはいい|later|notnow|maybelater)/;
const KEEP = /^(このまま|そのまま|それでいい|それで大丈夫|大丈夫|だいじょうぶ|いいよ|いいです|はい|ok|okay|thatsfine|fine|keepit|yes)/;
/** 今の値のままでよいと答えられる項目（ほかは中身を答えてもらう） */
const KEEPABLE: string[] = ["hours", "rules", "cancel", "notices"];

export type SetupReply = { reply: string; owner: Owner; actions?: Record<string, unknown>[] };

/** 登録の画面へ移る（画面側が open_signup を受けて移る） */
function openSignup(owner: Owner, lang: Language): SetupReply {
  return { owner, actions: [{ action: "open_signup" }], reply: lang === "ja"
    ? "登録の画面に移ります。店名、メール、ログインの方法の順にうかがいます。今の予約や設定は、そのまま引き継ぎます。"
    : "Opening the registration screen. I'll ask for the shop name, email and how you log in. Your bookings and settings carry over." };
}

/** 答えのあとに、続けて次の質問を添える */
async function withNext(r: SetupReply, lang: Language): Promise<SetupReply> {
  const next = await nextSetupQuestion(r.owner, lang);
  if (!next) return r;
  return { ...r, reply: lang === "ja" ? `${r.reply}続けて、${next}` : `${r.reply} Next, ${next.charAt(0).toLowerCase()}${next.slice(1)}` };
}

/**
 * 設定の質問への決まった返事を受ける。受けたら返事の文、受けなければ null（AI に回す）。
 * 「設定の話はもういい」「設定の続き」と、登録前のお店の「登録する」はいつでも受ける。
 * ほかは、今日聞いたまま答えをもらっていない項目があるときだけ
 */
export async function setupReply(owner: Owner, text: string, lang: Language): Promise<SetupReply | null> {
  const ja = lang === "ja";
  const t = clean(text);
  const today = nowLocal(owner.timezone).date;
  if (STOP_ALL.test(t)) {
    return { owner: await markSetupItem(owner, "all", "skip"), reply: ja
      ? "わかりました。設定のことは、もうこちらからは聞きません。まだ決まっていないものがあるときは、開いたときに一言だけお知らせします。また聞いてほしいときは「設定の続き」と言ってください。"
      : 'Okay. I won\'t ask about settings any more. If something is still undecided, I\'ll mention it briefly when you open the app. Say "continue setup" whenever you want me to ask again.' };
  }
  if (RESUME.test(t) && t.length <= 16) {
    const s = state(owner);
    const resumed = await storage.updateOwner(owner.id, { setupState: { ...s, skipped: s.skipped.filter((k) => k !== "all"), postponedOn: undefined, askedToday: [] } });
    const next = await takeSetupQuestion(resumed, lang, today, true);
    return { owner: resumed, reply: next ?? (ja ? "まだ決まっていない設定はありません。" : "There are no settings left to decide.") };
  }
  if (!owner.email && REGISTER.test(t)) return openSignup(owner, lang);
  const s0 = state(owner);
  const item = s0.askedOn === today ? (s0.lastAsked as SetupItem | undefined) : undefined;
  if (!item || !(item in LABELS) || t.length > 16) return null;
  const label = LABELS[item][ja ? 0 : 1];
  const postpone = async (reply: string): Promise<SetupReply> => {
    const s = state(owner);
    return { owner: await storage.updateOwner(owner.id, { setupState: { ...s, lastAsked: undefined, postponedOn: today } }), reply };
  };
  if (item === "account") {
    if (REGISTER_YES.test(t)) return openSignup(owner, lang);
    // 登録は「聞かないで」にできない。端末をなくすと記録が消えるので、明日また聞く
    if (SKIP.test(t)) return postpone(ja
      ? "わかりました。今日はもう聞きません。登録しないままだと、端末を替えたときに記録を戻せないので、また明日うかがいます。"
      : "Okay, not today. Without registering, the records can't be recovered on another device, so I'll ask again tomorrow.");
  }
  if (LATER.test(t)) return postpone(ja ? "わかりました。今日はもう聞きません。また明日うかがいます。" : "Okay, no more today. I'll ask again tomorrow.");
  if (item === "account") return null;
  if (SKIP.test(t)) return withNext({ owner: await markSetupItem(owner, item, "skip"), reply: ja ? `わかりました。${label}のことは、もう聞きません。` : `Okay, I won't ask about ${label} again.` }, lang);
  if (KEEPABLE.includes(item) && KEEP.test(t)) return withNext({ owner: await markSetupItem(owner, item, "done"), reply: ja ? `わかりました。${label}は今のままにしておきます。` : `Okay, I'll keep ${label} as it is.` }, lang);
  return null;
}

/** 声で設定を変えたら、その項目を決まったことにする */
export async function noteSetupProgress(owner: Owner, tool: string, args: Record<string, unknown>): Promise<Owner> {
  let items = TOOL_ITEMS[tool] ?? [];
  if (tool === "update_business_info") items = [...(args.address || args.phone ? ["contact" as const] : []), ...(args.info ? ["info" as const] : [])];
  if (tool === "update_booking_rules") {
    items = [...(args.buffer_minutes !== undefined || args.min_hours_before !== undefined || args.max_days_ahead !== undefined || args.slot_step_minutes !== undefined ? ["rules" as const] : []),
      ...(args.free_cancel_hours_before !== undefined || args.allow_card_payment !== undefined ? ["cancel" as const] : [])];
  }
  for (const item of items) owner = await markSetupItem(owner, item, "done");
  return owner;
}

/** よく入れる長さの予約に、まだメニューがなければ一度だけ登録を勧める（同じ長さでは二度勧めない） */
export async function menuSuggestion(owner: Owner, minutes: number, lang: Language): Promise<{ text: string; owner: Owner } | null> {
  const s = state(owner);
  if (s.skipped.includes("all") || s.skipped.includes("menu") || (s.menuSuggested ?? []).includes(minutes)) return null;
  const menus = await storage.listMenus(owner.id, true);
  if (menus.some((m) => m.minutes === minutes)) return null;
  const since = new Date(Date.now() - 60 * 86400000);
  const rows = await storage.listReservationsBetween(owner.id, since, new Date(Date.now() + 365 * 86400000));
  const same = rows.filter((r) => r.menuId === null && r.minutes === minutes).length;
  if (same < 3) return null;
  const updated = await storage.updateOwner(owner.id, { setupState: { ...s, menuSuggested: [...(s.menuSuggested ?? []), minutes] } });
  return { owner: updated, text: lang === "ja"
    ? `${minutes}分の予約をよく入れていますね。${minutes}分のコースとしてメニューに登録しておくと、お客さんがネットでも予約できます。料金はいくらにしますか？`
    : `You often book ${minutes} minutes. If you add a ${minutes}-minute service to your menu, customers can book it online too. What price should it be?` };
}
