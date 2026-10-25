/**
 * 最初の設定を会話で進める：国と通貨 → 店舗情報 → 営業時間と受付ルール → キャンセルの決まり → 合言葉 → メニュー
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { VoiceConversation, type Step, type Values } from "@/components/VoiceConversation";
import { Button } from "@/components/ui/button";
import { useI18n, type Lang } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { speak, voiceConversationUsable } from "@/lib/speech";
import type { BusinessHours, PublicOwner, WeekdayKey } from "@shared/schema";

type Preset = { country: string; currency: string; timezone: string; label: { ja: string; en: string }; aliases: string[] };
const PRESETS: Preset[] = [
  { country: "JP", currency: "JPY", timezone: "Asia/Tokyo", label: { ja: "日本", en: "Japan" }, aliases: ["日本", "にほん", "にっぽん", "japan"] },
  { country: "US", currency: "USD", timezone: "America/New_York", label: { ja: "アメリカ", en: "United States" }, aliases: ["アメリカ", "米国", "america", "united states", "usa", "us"] },
  { country: "GB", currency: "GBP", timezone: "Europe/London", label: { ja: "イギリス", en: "United Kingdom" }, aliases: ["イギリス", "英国", "uk", "united kingdom", "britain", "england"] },
  { country: "AU", currency: "AUD", timezone: "Australia/Sydney", label: { ja: "オーストラリア", en: "Australia" }, aliases: ["オーストラリア", "australia"] },
  { country: "SG", currency: "SGD", timezone: "Asia/Singapore", label: { ja: "シンガポール", en: "Singapore" }, aliases: ["シンガポール", "singapore"] },
  { country: "DE", currency: "EUR", timezone: "Europe/Berlin", label: { ja: "ドイツ", en: "Germany" }, aliases: ["ドイツ", "germany"] },
  { country: "FR", currency: "EUR", timezone: "Europe/Paris", label: { ja: "フランス", en: "France" }, aliases: ["フランス", "france"] },
  { country: "CA", currency: "CAD", timezone: "America/Toronto", label: { ja: "カナダ", en: "Canada" }, aliases: ["カナダ", "canada"] },
];
const CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "SGD", "CAD", "KRW"];
const TIMEZONES = ["Asia/Tokyo", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Singapore", "Asia/Seoul", "Australia/Sydney"];
const WEEKDAYS: { key: WeekdayKey; ja: string[]; en: string[] }[] = [
  { key: "mon", ja: ["月"], en: ["mon"] }, { key: "tue", ja: ["火"], en: ["tue"] }, { key: "wed", ja: ["水"], en: ["wed"] },
  { key: "thu", ja: ["木"], en: ["thu"] }, { key: "fri", ja: ["金"], en: ["fri"] }, { key: "sat", ja: ["土"], en: ["sat"] }, { key: "sun", ja: ["日"], en: ["sun"] },
];

function parseClosedDays(text: string): WeekdayKey[] {
  const t = text.normalize("NFKC").toLowerCase();
  if (!t || /^(なし|ない|ありません|none|no|nothing)$/.test(t.replace(/\s/g, ""))) return [];
  return WEEKDAYS.filter((w) => w.ja.some((a) => t.includes(a + "曜") || t === a) || w.en.some((a) => t.includes(a))).map((w) => w.key);
}

const SECTION_KEYS = ["region", "shop", "hours", "cancel", "passphrase", "menus"] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

export default function Setup() {
  const { t, lang, setLang } = useI18n();
  const [, navigate] = useLocation();
  const { owner, isLoading } = useAuth();
  const [mode, setMode] = useState<"voice" | "form">(() => (voiceConversationUsable() ? "voice" : "form"));
  const [section, setSection] = useState<SectionKey>("region");
  const [menuCount, setMenuCount] = useState(0);
  const [menuRound, setMenuRound] = useState(0);

  useEffect(() => { if (!isLoading && !owner) navigate("/login"); }, [isLoading, owner, navigate]);

  const sections = useMemo(() => owner ? buildSections(owner, lang, t) : null, [owner, lang, t]);
  if (!owner || !sections) return <Layout title={t("setupTitle")}><p>{t("loading")}</p></Layout>;

  const current = sections[section];
  const sectionIndex = SECTION_KEYS.indexOf(section);

  async function patch(body: Record<string, unknown>) {
    await apiRequest("PATCH", "/api/owner/settings", body);
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  }

  async function complete(v: Values): Promise<string | void> {
    try {
      if (section === "region") {
        const preset = PRESETS.find((p) => p.country === v.country) ?? PRESETS[0];
        const body = { country: preset.country, language: v.language, currency: v.currency || preset.currency, timezone: v.timezone || preset.timezone };
        await patch(body);
        setLang(body.language as Lang);
      } else if (section === "shop") {
        const name = v.shopName ? (lang === "ja" ? { shopNameJa: v.shopName } : { shopNameEn: v.shopName }) : {};
        await patch({ ...name, address: v.address, phone: v.phone, info: v.info });
      } else if (section === "hours") {
        const closed = parseClosedDays(v.closedDays);
        const hours = {} as BusinessHours;
        for (const w of WEEKDAYS) hours[w.key] = closed.includes(w.key) ? null : { open: v.open, close: v.close };
        if (v.open >= v.close) return lang === "ja" ? "閉店時間は開店時間より後にしてください" : "Closing time must be after opening time.";
        await patch({ hours, bufferMinutes: +v.buffer, slotStepMinutes: +v.step, maxDaysAhead: +v.maxDays, minHoursBefore: +v.minHours });
      } else if (section === "cancel") {
        await patch({ freeCancelHoursBefore: +v.cancelHours, allowCardPayment: v.allowCard === "yes" });
      } else if (section === "passphrase") {
        const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s、。，．,.!?！？・ー\-_]/g, "");
        if (norm(v.passphrase) !== norm(v.passphrase2)) return t("passphraseMismatch");
        await apiRequest("POST", "/api/owner/passphrase", { passphrase: v.passphrase });
        await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      } else if (section === "menus") {
        await apiRequest("POST", "/api/owner/menus", lang === "ja"
          ? { nameJa: v.name, minutes: +v.minutes, price: v.price }
          : { nameEn: v.name, minutes: +v.minutes, price: v.price });
        setMenuCount((n) => n + 1);
        if (v.more === "yes") { setMenuRound((r) => r + 1); return; }
        await patch({ onboardingDone: true });
        await speak(t("setupDone"), lang === "ja" ? "ja-JP" : "en-US").catch(() => undefined);
        navigate("/admin");
        return;
      }
      // 次のセクションへ（合言葉は設定済みなら飛ばす）
      let next = SECTION_KEYS[sectionIndex + 1];
      if (next === "passphrase" && owner?.hasPassphrase) next = "menus";
      setSection(next);
    } catch (e) {
      return e instanceof ApiRequestError ? e.message : t("error");
    }
  }

  return (
    <Layout title={t("setupTitle")}>
      <ol className="flex flex-wrap gap-2 mb-5 text-sm" aria-label="steps">
        {SECTION_KEYS.map((k, i) => (
          <li key={k} aria-current={k === section ? "step" : undefined} className={`px-3 py-1 rounded-full border-2 ${k === section ? "bg-primary text-primary-foreground border-primary" : i < sectionIndex ? "bg-accent text-accent-foreground" : ""}`}>
            {i + 1}. {t(sections[k].title)}
          </li>
        ))}
      </ol>
      <h2 className="text-xl font-bold mb-4">{t(current.title)}{section === "menus" && menuCount > 0 ? ` (${menuCount + 1})` : ""}</h2>
      <VoiceConversation key={`${section}-${menuRound}-${lang}`} steps={current.steps} intro={sectionIndex === 0 ? t("setupSpeech") : undefined}
        mode={mode} onModeChange={setMode} onComplete={complete} submitLabel={t("save")} />
      {section === "menus" && menuCount > 0 && (
        <p className="mt-4"><Button variant="outline" onClick={async () => { await patch({ onboardingDone: true }); navigate("/admin"); }}>{t("done")}</Button></p>
      )}
    </Layout>
  );
}

function buildSections(owner: PublicOwner, lang: Lang, t: (k: string, p?: Record<string, string | number>) => string): Record<SectionKey, { title: string; steps: Step[] }> {
  const ja = lang === "ja";
  const open = owner.hours.mon?.open ?? "10:00";
  const close = owner.hours.mon?.close ?? "19:00";
  const closedNow = (Object.keys(owner.hours) as WeekdayKey[]).filter((k) => !owner.hours[k]);
  const closedLabel = closedNow.map((k) => WEEKDAYS.find((w) => w.key === k)![ja ? "ja" : "en"][0] + (ja ? "曜日" : "")).join(ja ? "、" : ", ");
  const num = (v: string) => (/^\d+$/.test(v) ? null : (ja ? "数字で入力してください" : "Please enter a number."));
  return {
    region: { title: "stepRegion", steps: [
      { key: "country", prompt: t("askCountry"), label: t("country"), type: "choice", defaultValue: owner.country, choices: PRESETS.map((p) => ({ value: p.country, label: p.label[lang], aliases: p.aliases })) },
      { key: "language", prompt: t("askLanguage"), label: t("language"), type: "choice", defaultValue: owner.language, choices: [
        { value: "ja", label: "日本語", aliases: ["日本語", "にほんご", "japanese"] }, { value: "en", label: "English", aliases: ["英語", "えいご", "english"] }] },
      { key: "currency", prompt: t("askCurrency"), label: t("currency"), type: "choice", defaultValue: owner.currency, choices: CURRENCIES.map((c) => ({ value: c, label: c, aliases: [c.toLowerCase(), ...(c === "JPY" ? ["円", "えん", "yen"] : c === "USD" ? ["ドル", "dollar"] : c === "EUR" ? ["ユーロ", "euro"] : c === "GBP" ? ["ポンド", "pound"] : [])] })) },
      { key: "timezone", prompt: t("askTimezone"), label: t("timezone"), type: "choice", defaultValue: owner.timezone, choices: TIMEZONES.map((z) => ({ value: z, label: z, aliases: [z.split("/")[1].replace("_", " ").toLowerCase(), ...(z === "Asia/Tokyo" ? ["東京", "日本"] : [])] })) },
    ] },
    // 店名は登録のときに聞いている。今の言語での店名がまだ無いときだけ聞く
    shop: { title: "stepShop", steps: [
      ...((ja ? owner.shopNameJa : owner.shopNameEn) ? [] : [{ key: "shopName", prompt: t("askShopName"), label: t("shopName"), type: "text" } as Step]),
      { key: "address", prompt: t("askAddress"), label: t("address"), type: "text", optional: true, defaultValue: owner.address || undefined },
      { key: "phone", prompt: t("askPhone"), label: t("phone"), type: "phone", optional: true, defaultValue: owner.phone || undefined },
      { key: "info", prompt: t("askInfo"), label: t("info"), type: "text", optional: true, defaultValue: owner.info || undefined },
    ] },
    hours: { title: "stepHours", steps: [
      { key: "open", prompt: t("askOpen"), label: t("open"), type: "time", defaultValue: open },
      { key: "close", prompt: t("askClose"), label: t("close"), type: "time", defaultValue: close },
      { key: "closedDays", prompt: t("askClosedDays"), label: t("closedDays"), type: "text", optional: true, defaultValue: closedLabel || undefined },
      { key: "buffer", prompt: t("askBuffer"), label: t("bufferMinutes"), type: "number", defaultValue: String(owner.bufferMinutes), validate: num },
      { key: "step", prompt: t("askStep"), label: t("slotStep"), type: "number", defaultValue: String(owner.slotStepMinutes), validate: num },
      { key: "maxDays", prompt: t("askMaxDays"), label: t("maxDaysAhead"), type: "number", defaultValue: String(owner.maxDaysAhead), validate: num },
      { key: "minHours", prompt: t("askMinHours"), label: t("minHoursBefore"), type: "number", defaultValue: String(owner.minHoursBefore), validate: num },
    ] },
    cancel: { title: "stepCancel", steps: [
      { key: "cancelHours", prompt: t("askCancelHours"), label: t("freeCancelHours"), type: "number", defaultValue: String(owner.freeCancelHoursBefore), validate: num },
      { key: "allowCard", prompt: t("askAllowCard"), label: t("allowCard"), type: "yesno", defaultValue: owner.allowCardPayment ? "yes" : "no" },
    ] },
    passphrase: { title: "stepPassphrase", steps: [
      { key: "passphrase", prompt: t("askPassphrase"), label: t("passphrase"), type: "secret" },
      { key: "passphrase2", prompt: t("askPassphraseAgain"), label: `${t("passphrase")} (2)`, type: "secret" },
    ] },
    menus: { title: "stepMenus", steps: [
      { key: "name", prompt: t("askMenuName"), label: t("menuName"), type: "text" },
      { key: "minutes", prompt: t("askMenuMinutes"), label: t("minutes"), type: "number", validate: num },
      { key: "price", prompt: t("askMenuPrice"), label: `${t("price")} (${owner.currency})`, type: "number" },
      { key: "more", prompt: t("askMoreMenu"), label: t("addMenu"), type: "yesno", defaultValue: "no" },
    ] },
  };
}
