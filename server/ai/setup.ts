/**
 * 設定を少しずつ埋める。最初にまとめて聞かず、管理画面を開いたときに1日1つだけ聞く。
 * - 聞く順番は SETUP_ITEMS の順。決まった項目・「聞かないで」と言われた項目は聞かない
 * - 3回聞いても答えがなければ、その項目はあきらめる（しつこくしない）
 * - 声で設定を変えたら、その項目は決まったことにする（executeTool から noteSetupProgress を呼ぶ）
 * - 以前の「最初の設定」を最後まで済ませた人には聞かない
 * - 「聞かないで」「このままでいい」「あとで」「設定の話はもういい」は決まった言い方なので、AI に任せずここで受ける（setupReply）
 */
import type { Owner, Language, SetupState } from "@shared/schema";
import { EMPTY_SETUP, WEEKDAY_KEYS } from "@shared/schema";
import { WEEKDAY_LABELS } from "@shared/i18n";
import * as storage from "../storage";
import { nowLocal } from "../lib/time";

export const SETUP_ITEMS = ["hours", "menu", "contact", "info", "rules", "cancel"] as const;
export type SetupItem = (typeof SETUP_ITEMS)[number];
const MAX_ASKS = 3;

/** 声で変えたら決まったことにする項目 */
const TOOL_ITEMS: Record<string, SetupItem[]> = {
  set_business_hours: ["hours"], create_menu: ["menu"],
};

function state(owner: Owner): SetupState {
  return { ...EMPTY_SETUP, ...(owner.setupState ?? {}) };
}

/** まだ決まっていない項目（聞かないでと言われたもの、あきらめたものは除く） */
export async function pendingSetupItems(owner: Owner): Promise<SetupItem[]> {
  const s = state(owner);
  if (owner.onboardingDone || s.skipped.includes("all")) return [];
  const hasMenu = (await storage.listMenus(owner.id, true)).length > 0;
  return SETUP_ITEMS.filter((item) => {
    if (s.done.includes(item) || s.skipped.includes(item) || (s.asks[item] ?? 0) >= MAX_ASKS) return false;
    if (item === "menu" && hasMenu) return false;
    if (item === "contact" && (owner.address || owner.phone)) return false;
    if (item === "info" && owner.info) return false;
    return true;
  });
}

function hoursText(owner: Owner, lang: Language): string {
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
  }
}

/**
 * 今日まだ聞いていなければ、次に聞く1項目の質問文を返して、聞いたことを記録する。
 * 文の終わりに「聞かないで」で止められることを添える
 */
export async function takeSetupQuestion(owner: Owner, lang: Language, today: string): Promise<string | null> {
  const s = state(owner);
  if (s.askedOn === today) return null;
  const [item] = await pendingSetupItems(owner);
  if (!item) return null;
  const ja = lang === "ja";
  await storage.updateOwner(owner.id, { setupState: { ...s, askedOn: today, lastAsked: item, asks: { ...s.asks, [item]: (s.asks[item] ?? 0) + 1 } } });
  return questionFor(item, owner, lang) + (ja ? "あとにしたいときは「あとで」、聞かれたくなければ「聞かないで」と言ってください。" : ' Say "later" to come back to it, or "don\'t ask" and I won\'t ask again.');
}

/** 項目を「決まった」か「聞かないで」にする（"all" なら設定の質問を全部やめる） */
export async function markSetupItem(owner: Owner, item: string, status: "done" | "skip"): Promise<Owner> {
  const s = state(owner);
  const key = status === "done" ? "done" : "skipped";
  const lastAsked = s.lastAsked === item || item === "all" ? undefined : s.lastAsked;
  if (s[key].includes(item) && lastAsked === s.lastAsked) return owner;
  return storage.updateOwner(owner.id, { setupState: { ...s, lastAsked, [key]: s[key].includes(item) ? s[key] : [...s[key], item] } });
}

const LABELS: Record<SetupItem, [string, string]> = {
  hours: ["営業時間", "opening hours"], menu: ["メニュー", "the menu"], contact: ["住所と電話番号", "the address and phone"],
  info: ["お客さんへの案内", "notes for customers"], rules: ["受付ルール", "booking rules"], cancel: ["キャンセルの決まり", "the cancellation policy"],
};
const clean = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[\s、。,.!?！？「」]/g, "");
const STOP_ALL = /設定.*(もういい|聞かないで|きかないで|いらない|やめて)|stopasking|nomoresetting|dontaskaboutsettings/;
const SKIP = /聞かないで|きかないで|いらない|結構です|けっこうです|聞かなくていい|don'?task|noneed|skip/;
const LATER = /^(あとで|後で|また今度|今度|今はいい|いまはいい|later|notnow|maybelater)/;
const KEEP = /^(このまま|そのまま|それでいい|それで大丈夫|大丈夫|だいじょうぶ|いいよ|いいです|はい|ok|okay|thatsfine|fine|keepit|yes)/;
/** 今の値のままでよいと答えられる項目（ほかは中身を答えてもらう） */
const KEEPABLE: string[] = ["hours", "rules", "cancel"];

/**
 * 設定の質問への決まった返事を受ける。受けたら返事の文、受けなければ null（AI に回す）。
 * 「設定の話はもういい」はいつでも受ける。ほかは、今日聞いたまま答えをもらっていない項目があるときだけ
 */
export async function setupReply(owner: Owner, text: string, lang: Language): Promise<{ reply: string; owner: Owner } | null> {
  const ja = lang === "ja";
  const t = clean(text);
  if (STOP_ALL.test(t)) {
    return { owner: await markSetupItem(owner, "all", "skip"), reply: ja
      ? "わかりました。設定のことは、もうこちらからは聞きません。変えたいときは、いつでも言ってください。"
      : "Okay. I won't ask about settings any more. Just tell me whenever you want to change something." };
  }
  const s0 = state(owner);
  const item = s0.askedOn === nowLocal(owner.timezone).date ? (s0.lastAsked as SetupItem | undefined) : undefined;
  if (!item || !(item in LABELS) || t.length > 16) return null;
  const label = LABELS[item][ja ? 0 : 1];
  if (SKIP.test(t)) return { owner: await markSetupItem(owner, item, "skip"), reply: ja ? `わかりました。${label}のことは、もう聞きません。` : `Okay, I won't ask about ${label} again.` };
  if (LATER.test(t)) {
    const s = state(owner);
    return { owner: await storage.updateOwner(owner.id, { setupState: { ...s, lastAsked: undefined } }), reply: ja ? "わかりました。また今度うかがいます。" : "Okay, I'll ask another time." };
  }
  if (KEEPABLE.includes(item) && KEEP.test(t)) return { owner: await markSetupItem(owner, item, "done"), reply: ja ? `わかりました。${label}は今のままにしておきます。` : `Okay, I'll keep ${label} as it is.` };
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
