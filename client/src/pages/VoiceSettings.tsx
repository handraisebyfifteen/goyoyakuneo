/**
 * 声の設定。初めて開いた人はここから始まる（ようこそ画面より先）。
 * 上：会話で設定する。女性/男性の声を実際に聞かせてから選んでもらい、次に速さを選ぶ。
 * 下：詳しい設定。日本語・英語それぞれで具体的な声や速さを選ぶ、読み上げを止める。
 * 声は端末に入っているものなので、設定も端末（localStorage）に保存する。
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { VoiceConversation, type Step, type IntroPart } from "@/components/VoiceConversation";
import { useI18n } from "@/lib/i18n";
import { getVoicePrefs, setVoicePrefs, loadVoices, voicesFor, guessGender, previewVoice, speak, ttsSupported, type VoiceLang, type VoicePref, type VoicePrefs, type Gender, type Rate } from "@/lib/speech";

const selectClass = "flex min-h-12 w-full rounded-md border-2 border-input bg-card px-3 py-2 text-base";

export default function VoiceSettings() {
  const { t, lang, speechLang } = useI18n();
  const [, navigate] = useLocation();
  const firstRun = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("first") === "1";
  const [prefs, setPrefs] = useState<VoicePrefs>(getVoicePrefs);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [savedMsg, setSavedMsg] = useState("");
  const [mode, setMode] = useState<"voice" | "form">("voice");
  const current: VoiceLang = lang;

  useEffect(() => {
    let alive = true;
    const refresh = () => { loadVoices().then((v) => { if (alive) setVoices(v); }); };
    refresh();
    if (ttsSupported()) speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => { alive = false; if (ttsSupported()) speechSynthesis.removeEventListener("voiceschanged", refresh); };
  }, []);

  function save(next: VoicePrefs) {
    setPrefs(next);
    setVoicePrefs(next);
    setSavedMsg("");
    // 同じ文言でも毎回読まれるように、一度空にしてから入れる
    setTimeout(() => setSavedMsg(t("saved")), 50);
  }
  const update = (l: VoiceLang, patch: Partial<VoicePref>) => save({ ...prefs, [l]: { ...prefs[l], ...patch } });

  // ---------- 会話で設定する ----------
  const intro = useMemo<IntroPart[]>(() => firstRun
    ? [{ text: t("firstRunIntro") }, { text: t("firstRunOther"), lang: lang === "ja" ? "en-US" : "ja-JP" }]
    : [{ text: t("voiceSetupIntro") }], [firstRun, lang, t]);

  const steps = useMemo<Step[]>(() => {
    const base = getVoicePrefs()[current];
    const sample = async (gender: Gender, label: string) => {
      await previewVoice(current, { ...base, gender, voice: null }, label);
      await previewVoice(current, { ...base, gender, voice: null });
    };
    return [
      { key: "gender", prompt: t("askGender"), label: t("voiceGender"), type: "choice",
        before: async () => { await sample("female", t("sampleFemale")); await sample("male", t("sampleMale")); },
        choices: [
          { value: "female", label: t("female"), aliases: ["女性", "じょせい", "女", "おんな", "female", "woman", "lady", "最初", "さいしょ", "一つ目", "ひとつめ", "first"] },
          { value: "male", label: t("male"), aliases: ["男性", "だんせい", "男", "おとこ", "male", "man", "二つ目", "ふたつめ", "次", "つぎ", "second"] },
        ] },
      { key: "rate", prompt: t("askRate"), label: t("rate"), type: "choice", choices: [
        { value: "slow", label: t("rateSlow"), aliases: ["ゆっくり", "遅", "おそ", "slow"] },
        { value: "normal", label: t("rateNormal"), aliases: ["ふつう", "普通", "そのまま", "normal", "same", "keep"] },
        { value: "fast", label: t("rateFast"), aliases: ["はやい", "速", "早", "fast", "quick"] },
      ] },
    ];
  }, [current, t]);

  async function complete(v: Record<string, string>) {
    const next: VoicePrefs = { ...getVoicePrefs(), [current]: { gender: v.gender as Gender, voice: null, rate: v.rate as Rate } };
    save(next);
    await speak(firstRun ? t("voiceSavedGo") : t("voiceSaved"), speechLang).catch(() => undefined);
    if (firstRun) navigate("/", { replace: true });
  }

  function later() {
    setVoicePrefs(getVoicePrefs());
    navigate("/", { replace: true });
  }

  return (
    <Layout title={t("voiceSettings")}>
      <div className="space-y-8">
        {!ttsSupported() && <p role="alert" className="text-destructive font-semibold">{t("ttsUnsupported")}</p>}

        <section aria-labelledby="voice-by-voice" className="space-y-4">
          <h2 id="voice-by-voice" className="text-xl font-bold">{t("byVoice")}</h2>
          <VoiceConversation steps={steps} intro={intro} mode={mode} onModeChange={setMode} onComplete={complete} submitLabel={t("save")} />
          {firstRun && <p><Button variant="link" onClick={later} data-testid="button-later">{t("later")}</Button></p>}
          {!firstRun && <p><Button variant="link" asChild><Link href="/">{t("back")}</Link></Button></p>}
        </section>

        <section aria-labelledby="voice-detail" className="space-y-6">
          <h2 id="voice-detail" className="text-xl font-bold">{t("detailedSettings")}</h2>
          {(["ja", "en"] as VoiceLang[]).map((l) => (
            <LangSection key={l} lang={l} pref={prefs[l]} voices={voices} onChange={(patch) => update(l, patch)} />
          ))}

          <section aria-labelledby="mute-heading" className="rounded-xl border-2 bg-card p-5 space-y-3">
            <h3 id="mute-heading" className="text-lg font-bold">{t("srHeading")}</h3>
            <div className="flex items-start gap-3">
              <input id="mute" type="checkbox" className="mt-1 h-6 w-6" checked={prefs.mute} aria-describedby="mute-note" onChange={(e) => save({ ...prefs, mute: e.target.checked })} data-testid="checkbox-mute" />
              <div>
                <Label htmlFor="mute" className="text-base">{t("muteApp")}</Label>
                <p id="mute-note" className="text-sm text-muted-foreground mt-1">{t("muteNote")}</p>
              </div>
            </div>
          </section>
        </section>

        <p><Button variant="link" asChild><Link href="/voice-check" data-testid="link-voice-check">{t("voiceCheck")}</Link></Button></p>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground min-h-5">{savedMsg}</p>
      </div>
    </Layout>
  );
}

function LangSection({ lang, pref, voices, onChange }: { lang: VoiceLang; pref: VoicePref; voices: SpeechSynthesisVoice[]; onChange: (p: Partial<VoicePref>) => void }) {
  const { t } = useI18n();
  const [playing, setPlaying] = useState(false);
  const title = lang === "ja" ? t("voiceForJa") : t("voiceForEn");
  const list = voicesFor(voices, lang === "ja" ? "ja-JP" : "en-US", pref);
  const genderLabel = (v: SpeechSynthesisVoice) => { const g = guessGender(v); return g ? ` (${t(g)})` : ""; };

  async function preview() {
    setPlaying(true);
    try { await previewVoice(lang, pref); } finally { setPlaying(false); }
  }

  return (
    <section aria-labelledby={`voice-${lang}`} className="rounded-xl border-2 bg-card p-5 space-y-4">
      <h3 id={`voice-${lang}`} className="text-lg font-bold">{title}</h3>

      <fieldset>
        <legend className="font-semibold mb-2">{t("voiceGender")}</legend>
        <div className="flex gap-3" role="radiogroup">
          {(["female", "male"] as Gender[]).map((g) => (
            <label key={g} className={`flex-1 cursor-pointer rounded-md border-2 px-4 py-3 text-center text-lg font-semibold ${pref.gender === g ? "bg-primary text-primary-foreground border-primary" : "bg-card"}`}>
              <input type="radio" name={`gender-${lang}`} value={g} className="sr-only" checked={pref.gender === g} onChange={() => onChange({ gender: g, voice: null })} data-testid={`radio-${lang}-${g}`} />
              {t(g)}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <Label htmlFor={`voice-pick-${lang}`}>{t("voicePick")}</Label>
        <select id={`voice-pick-${lang}`} className={selectClass} value={pref.voice ?? ""} onChange={(e) => onChange({ voice: e.target.value || null })} disabled={!list.length} data-testid={`select-voice-${lang}`}>
          <option value="">{t("voiceAuto")}{list[0] ? ` — ${list[0].name}` : ""}</option>
          {list.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}{genderLabel(v)}</option>)}
        </select>
        {!list.length && ttsSupported() && <p className="text-sm text-destructive mt-1" role="status">{t("noVoicesFor", { lang: lang === "ja" ? t("langNameJa") : t("langNameEn") })}</p>}
      </div>

      <div>
        <Label htmlFor={`rate-${lang}`}>{t("rate")}</Label>
        <select id={`rate-${lang}`} className={selectClass} value={pref.rate} onChange={(e) => onChange({ rate: e.target.value as Rate })} data-testid={`select-rate-${lang}`}>
          <option value="slow">{t("rateSlow")}</option>
          <option value="normal">{t("rateNormal")}</option>
          <option value="fast">{t("rateFast")}</option>
        </select>
      </div>

      <Button size="lg" onClick={preview} disabled={playing || !list.length} data-testid={`button-preview-${lang}`}>{playing ? t("speaking") : t("preview")}</Button>
    </section>
  );
}
