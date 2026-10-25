/**
 * 台本つきの会話で入力を集める部品（AI は使わない）。
 * 読み上げ → 聞き取り → 「〜ですね。よろしいですか？」→ はい/いいえ、の一本道。
 * 同じ台本を「フォーム」としても表示でき、キーボードだけでも最後まで進める。
 *
 * 目が見えない人への配慮：
 * - 各ステップで、答えるための部品（入力欄・はい/いいえ・選択肢）にフォーカスを移す
 * - マイクが使えないときや二度聞き取れなかったときは、声で待ち続けず入力欄に切り替える
 * - 「はい/いいえ」のボタンは聞き取り中も消さない
 * - 状態表示（聞いています…）はスクリーンリーダーに逐一読ませない。読ませるのは質問と結果だけ
 * - 「アプリの読み上げを止める」設定なら自動では聞き取らず、「話す」ボタンか入力欄で進める
 * - いつでも「English」「日本語」と言えば言語が切り替わる
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n, type Lang } from "@/lib/i18n";
import { listen, speak, stopListening, stopSpeaking, sttSupported, ttsSupported, yesNo, parseSpokenEmail, parseSpokenPhone, parseSpokenNumber, parseSpokenTime, getVoicePrefs, takeSpeakError, unlockSpeech, SpeechNotAllowed } from "@/lib/speech";

export type Choice = { value: string; label: string; aliases?: string[] };
export type Step = {
  key: string;
  prompt: string;
  label?: string;
  type: "text" | "secret" | "email" | "phone" | "number" | "time" | "choice" | "yesno";
  choices?: Choice[];
  optional?: boolean;
  defaultValue?: string;
  validate?: (value: string) => string | null;
  /** 入力欄の autocomplete（ログインなら "current-password" など） */
  autoComplete?: string;
  when?: (values: Record<string, string>) => boolean;
  /** 質問の前に鳴らすもの（声の見本など） */
  before?: () => Promise<void>;
};

/** 最初の案内。別の言語で一言添えたいとき（"For English, say English." など）は配列で渡す */
export type IntroPart = { text: string; lang?: string };

export type Values = Record<string, string>;
type Mode = "voice" | "form";
type Status = "idle" | "speaking" | "listening" | "submitting" | "done";
type Answer = { text: string; fromVoice: boolean };

type Props = {
  steps: Step[];
  intro?: string | IntroPart[];
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onComplete: (values: Values) => Promise<string | void>;
  pitch?: number;
  submitLabel?: string;
};

const NONE_WORDS = ["なし", "ない", "ありません", "none", "no", "nothing", "skip"];
const KEEP_WORDS = ["そのまま", "変えない", "かえない", "keep", "same", "default", "skip"];
const LANG_WORDS: Record<Lang, string[]> = { ja: ["日本語", "にほんご", "japanese"], en: ["english", "英語", "えいご", "イングリッシュ"] };
// マイクそのものが使えないときの音声認識のエラー。これが出たら以後は声で聞かない
const MIC_ERRORS = ["not-allowed", "audio-capture", "service-not-allowed"];
// 「話す」ボタンが押されたことを入力待ちに伝える印
const TALK_AGAIN = "\u0000talk";

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s、。，．,.!?！？]/g, "");

export function VoiceConversation({ steps, intro, mode, onModeChange, onComplete, pitch = 1, submitLabel }: Props) {
  const { t, lang, setLang, speechLang } = useI18n();
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [confirming, setConfirming] = useState(false);
  const [shown, setShown] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const [waitingTyped, setWaitingTyped] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  const [speakError, setSpeakError] = useState("");
  const valuesRef = useRef<Values>({});
  const typedRef = useRef<string | null>(null);
  const waitTyped = useRef<((v: string) => void) | null>(null);
  const micBlockedRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const runId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  statusRef.current = status;

  const say = useCallback(async (text: string) => {
    setShown(text);
    if (!ttsSupported()) return;
    try { await speak(text, speechLang, { pitch }); setNeedsGesture(false); setSpeakError(takeSpeakError() ?? ""); }
    catch (e) { if (e instanceof SpeechNotAllowed) setNeedsGesture(true); }
  }, [speechLang, pitch]);

  const sayIntro = useCallback(async (parts: string | IntroPart[]) => {
    if (typeof parts === "string") return say(parts);
    setShown(parts.map((p) => p.text).join(" "));
    if (!ttsSupported()) return;
    for (const p of parts) {
      try { await speak(p.text, p.lang ?? speechLang, { pitch }); setNeedsGesture(false); }
      catch (e) { if (e instanceof SpeechNotAllowed) { setNeedsGesture(true); return; } }
    }
  }, [say, speechLang, pitch]);

  // 質問の前の見本（声の聞き比べなど）。読み上げがまだ許可されていなければ、質問と同じく「キーを押して」の案内にする
  const runBefore = useCallback(async (step: Step) => {
    if (!step.before) return;
    setShown(step.prompt);
    try { await step.before(); setNeedsGesture(false); }
    catch (e) { if (e instanceof SpeechNotAllowed) setNeedsGesture(true); }
  }, []);

  const activeSteps = useCallback(() => steps.filter((s) => !s.when || s.when(valuesRef.current)), [steps]);

  // 声で自動的に聞いてよいか：音声認識があり、マイクが拒否されておらず、読み上げを止める設定でもない
  const canAutoListen = () => sttSupported() && !micBlockedRef.current && !getVoicePrefs().mute;

  function waitForTyped(): Promise<string> {
    setStatus("idle");
    setWaitingTyped(true);
    return new Promise<string>((resolve) => { waitTyped.current = resolve; }).finally(() => setWaitingTyped(false));
  }

  /** 一回分の答えを受け取る。声で聞けなければ入力欄で待つ。流れが止められたら null */
  const getAnswer = useCallback(async (alive: () => boolean): Promise<Answer | null> => {
    let misses = 0;
    let talkOnce = false;
    while (alive()) {
      if (typedRef.current !== null) { const v = typedRef.current; typedRef.current = null; return { text: v, fromVoice: false }; }
      if (talkOnce || canAutoListen()) {
        talkOnce = false;
        setStatus("listening");
        try { return { text: await listen(speechLang), fromVoice: true }; }
        catch (e) {
          if (!alive()) return null;
          if (typedRef.current !== null) continue;
          const code = e instanceof Error ? e.message : "";
          if (MIC_ERRORS.includes(code)) {
            micBlockedRef.current = true; setMicBlocked(true);
            await say(t("micBlocked"));
          } else {
            misses += 1;
            if (misses < 2) { await say(t("notHeard")); continue; }
            await say(t("typeOrTalk"));
          }
          if (!alive()) return null;
        }
      }
      const v = await waitForTyped();
      if (!alive()) return null;
      if (v === TALK_AGAIN) { misses = 0; talkOnce = true; continue; }
      return { text: v, fromVoice: false };
    }
    return null;
  }, [say, speechLang, t]);

  function languageSwitch(text: string): Lang | null {
    const low = normalize(text);
    for (const l of Object.keys(LANG_WORDS) as Lang[]) if (l !== lang && LANG_WORDS[l].some((w) => normalize(w) === low)) return l;
    return null;
  }

  function parseAnswer(step: Step, raw: string, fromVoice: boolean): { value: string; display: string } | { error: string } {
    const text = raw.trim();
    const low = normalize(text);
    if (step.defaultValue !== undefined && KEEP_WORDS.includes(low)) return { value: step.defaultValue, display: step.defaultValue };
    if (step.optional && (low === "" || NONE_WORDS.includes(low))) return { value: "", display: t("none") };
    switch (step.type) {
      case "choice": {
        const c = (step.choices ?? []).find((x) => x.value.toLowerCase() === low || x.label.toLowerCase().replace(/\s/g, "") === low
          || (x.aliases ?? []).some((a) => low.includes(a.toLowerCase().replace(/\s/g, ""))) || low.includes(x.label.toLowerCase().replace(/\s/g, "")));
        if (!c) return { error: t("choose", { options: (step.choices ?? []).map((x) => x.label).join(lang === "ja" ? "、" : ", ") }) };
        return { value: c.value, display: c.label };
      }
      case "yesno": {
        const yn = yesNo(text, lang);
        if (!yn) return { error: t("choose", { options: `${t("yes")}${lang === "ja" ? "、" : ", "}${t("no")}` }) };
        return { value: yn, display: t(yn) };
      }
      case "email": {
        const v = fromVoice ? parseSpokenEmail(text) : text.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return { error: lang === "ja" ? "メールアドレスの形が正しくありません" : "That does not look like an email address." };
        return { value: v, display: v.split("").join(" ") };
      }
      case "phone": {
        const v = parseSpokenPhone(text);
        if (v.length < 6) return { error: lang === "ja" ? "電話番号を数字で教えてください" : "Please give the phone number in digits." };
        return { value: v, display: v.split("").join(" ") };
      }
      case "number": {
        const n = parseSpokenNumber(text);
        if (n === null || Number.isNaN(n)) return { error: lang === "ja" ? "数字で教えてください" : "Please give a number." };
        return { value: String(n), display: String(n) };
      }
      case "time": {
        const v = parseSpokenTime(text);
        if (!v) return { error: lang === "ja" ? "時刻がわかりませんでした。例えば「10時」のように言ってください" : "I could not understand the time. Say, for example, ten a.m." };
        return { value: v, display: v };
      }
      case "secret":
      case "text":
      default: {
        if (!text && !step.optional) return { error: t("notHeard") };
        return { value: text, display: text };
      }
    }
  }

  const finish = useCallback(async () => {
    setStatus("submitting");
    const err = await onComplete({ ...valuesRef.current });
    if (err) {
      setError(err);
      await say(err);
      return false;
    }
    setStatus("done");
    return true;
  }, [onComplete, say]);

  // 声の流れ（台本を順に進める）
  const runFrom = useCallback(async (startIndex: number) => {
    const id = ++runId.current;
    const alive = () => runId.current === id;
    let i = startIndex;
    while (alive()) {
      const list = activeSteps();
      if (i >= list.length) {
        const ok = await finish();
        if (!ok && alive()) { valuesRef.current = {}; i = 0; continue; }
        return;
      }
      const step = list[i];
      setIndex(i); setError(""); setTyped(""); setConfirming(false); typedRef.current = null;
      setStatus("speaking");
      let prompt = step.prompt;
      if (step.type === "choice") prompt += " " + t("choose", { options: (step.choices ?? []).map((x) => x.label).join(lang === "ja" ? "、" : ", ") });
      if (step.defaultValue !== undefined && step.type !== "secret") prompt += lang === "ja" ? ` 今は「${step.defaultValue}」です。そのままなら「そのまま」と言ってください。` : ` Currently "${step.defaultValue}". Say "keep" to leave it.`;
      await runBefore(step);
      if (!alive()) return;
      await say(prompt);
      if (!alive()) return;

      let committed = false;
      while (alive() && !committed) {
        const ans = await getAnswer(alive);
        if (!ans) return;
        // 「English」「日本語」で言語を切り替える（言語を選ぶ質問のときは答えとして扱う）
        const sw = step.type === "choice" ? null : languageSwitch(ans.text);
        if (sw) { setLang(sw); return; }
        const parsed = parseAnswer(step, ans.text, ans.fromVoice);
        if ("error" in parsed) { setError(parsed.error); await say(parsed.error); continue; }
        const v = step.validate?.(parsed.value);
        if (v) { setError(v); await say(v); continue; }
        if (!ans.fromVoice) { valuesRef.current[step.key] = parsed.value; committed = true; break; }

        // 声で答えたときだけ、聞き間違いがないか確認する
        setConfirming(true);
        setStatus("speaking");
        await say(step.type === "secret" ? t("heardSecret") : t("heardYou", { value: parsed.display }));
        if (!alive()) return;
        let answer: "yes" | "no" | null = null;
        let tries = 0;
        while (alive() && answer === null) {
          const a = await getAnswer(alive);
          if (!a) return;
          answer = a.text === "yes" || a.text === "no" ? a.text : yesNo(a.text, lang);
          if (answer === null) {
            tries += 1;
            if (tries >= 2) { answer = "no"; break; }
            await say(t("sayYesOrNo"));
          }
        }
        if (!alive()) return;
        setConfirming(false);
        if (answer === "yes") { valuesRef.current[step.key] = parsed.value; committed = true; }
        else { setError(""); setStatus("speaking"); await runBefore(step); if (!alive()) return; await say(step.prompt); }
      }
      i += 1;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSteps, finish, getAnswer, lang, runBefore, say, setLang, t]);

  // 会話の開始。言語が変わったら最初からやり直す（送信中・完了後は何もしない）
  useEffect(() => {
    if (mode !== "voice") { runId.current++; stopSpeaking(); stopListening(); setStatus("idle"); setConfirming(false); return; }
    if (statusRef.current === "submitting" || statusRef.current === "done") return;
    valuesRef.current = {};
    (async () => { if (intro) await sayIntro(intro); runFrom(0); })();
    return () => { runId.current++; stopSpeaking(); stopListening(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, lang]);

  // 音を出す許可がまだなら、ページ内の操作（キー、タップ）で最初からやり直す。
  // ただしボタン・リンク・入力欄の操作は、それぞれの働きを優先して音の解放だけにする
  // （やり直すと配置がずれて押したボタンに届かない、打った文字が消える、などが起きるため）
  const startVoice = useCallback(() => { unlockSpeech(); setNeedsGesture(false); valuesRef.current = {}; runFrom(0); }, [runFrom]);
  useEffect(() => {
    if (!needsGesture) return;
    const onGesture = (e: Event) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("button, a, input, select, textarea, label, [role=button]")) { unlockSpeech(); return; }
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("pointerdown", onGesture);
      startVoice();
    };
    window.addEventListener("keydown", onGesture);
    window.addEventListener("pointerdown", onGesture);
    return () => { window.removeEventListener("keydown", onGesture); window.removeEventListener("pointerdown", onGesture); };
  }, [needsGesture, startVoice]);

  function submitTyped(value: string) {
    if (waitTyped.current) { const r = waitTyped.current; waitTyped.current = null; r(value); return; }
    typedRef.current = value;
    stopSpeaking();
    stopListening();
  }

  const list = activeSteps();
  const step = list[Math.min(index, Math.max(list.length - 1, 0))];
  const busy = status === "submitting" || status === "done";
  const buttonsStep = step?.type === "choice" || step?.type === "yesno";

  // ステップが変わるたびに、答えるための部品へフォーカスを移す
  useEffect(() => {
    if (mode !== "voice" || busy) return;
    const el = confirming ? yesRef.current : buttonsStep ? groupRef.current : inputRef.current;
    el?.focus({ preventScroll: false });
  }, [mode, busy, confirming, buttonsStep, index, waitingTyped]);

  // ---------- フォーム表示 ----------
  if (mode === "form") {
    return <FormMode steps={steps} onSubmit={async (values) => { valuesRef.current = values; return onComplete({ ...values }); }} onSwitch={() => onModeChange("voice")} submitLabel={submitLabel} />;
  }

  const statusLabel = status === "listening" ? t("listening") : status === "speaking" ? t("speaking") : status === "submitting" ? t("processing") : "";
  const showTalk = waitingTyped && sttSupported() && !micBlocked;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border-2 bg-card p-5 min-h-28">
        {/* 状態はスクリーンリーダーに読ませない（質問と重なってうるさいため）。質問と結果だけ読ませる */}
        <p className="text-sm text-muted-foreground mb-1" aria-hidden="true">{statusLabel}</p>
        <div aria-live="polite" aria-atomic="true">
          <p className="text-xl font-semibold" data-testid="text-prompt">{shown}</p>
          {error && <p className="mt-2 text-destructive font-semibold" role="alert">{error}</p>}
        </div>
        {needsGesture && (
          <div className="mt-3" role="status">
            <Button size="lg" onClick={startVoice} data-testid="button-start-voice">{t("startVoice")}</Button>
            <p className="mt-1 text-sm text-muted-foreground">{t("pressAnyKey")}</p>
          </div>
        )}
        {speakError && <p className="mt-2 text-sm text-destructive" role="status">{t("speakFailed", { reason: speakError })}</p>}
        {!sttSupported() && <p className="mt-2 text-sm text-muted-foreground">{t("noSpeech")}</p>}
        {micBlocked && <p className="mt-2 text-sm text-muted-foreground">{t("micBlocked")}</p>}
      </div>

      {step && !busy && (
        <div className="space-y-3">
          {confirming ? (
            <div className="flex gap-3" role="group" aria-label={t("waitingYesNo")}>
              <Button ref={yesRef} size="lg" onClick={() => submitTyped("yes")} data-testid="button-yes">{t("yes")}</Button>
              <Button size="lg" variant="outline" onClick={() => submitTyped("no")} data-testid="button-no">{t("no")}</Button>
            </div>
          ) : step.type === "choice" ? (
            <div ref={groupRef} tabIndex={-1} className="flex flex-wrap gap-3 outline-none" role="group" aria-label={step.label ?? step.prompt}>
              {(step.choices ?? []).map((c) => (
                <Button key={c.value} size="lg" variant="outline" onClick={() => submitTyped(c.value)} data-testid={`button-choice-${c.value}`}>{c.label}</Button>
              ))}
            </div>
          ) : step.type === "yesno" ? (
            <div ref={groupRef} tabIndex={-1} className="flex gap-3 outline-none" role="group" aria-label={step.label ?? step.prompt}>
              <Button size="lg" onClick={() => submitTyped("yes")}>{t("yes")}</Button>
              <Button size="lg" variant="outline" onClick={() => submitTyped("no")}>{t("no")}</Button>
            </div>
          ) : (
            <form className="flex flex-col sm:flex-row gap-3" onSubmit={(e) => { e.preventDefault(); submitTyped(typed); setTyped(""); }}>
              <div className="flex-1">
                <Label htmlFor="voice-typed">{step.label ?? t("typeAnswer")}</Label>
                <Input id="voice-typed" ref={inputRef} type={step.type === "secret" ? "password" : step.type === "email" ? "email" : step.type === "phone" ? "tel" : step.type === "number" ? "number" : "text"}
                  inputMode={step.type === "number" ? "decimal" : step.type === "phone" ? "tel" : undefined}
                  autoComplete={step.autoComplete ?? (step.type === "secret" ? "off" : undefined)}
                  value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={step.defaultValue} data-testid={`input-${step.key}`} />
              </div>
              <Button type="submit" size="lg" className="sm:self-end" data-testid="button-next">{t("next")}</Button>
            </form>
          )}
          {showTalk && <Button size="lg" variant="outline" onClick={() => submitTyped(TALK_AGAIN)} data-testid="button-talk">{t("talk")}</Button>}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Button variant="ghost" onClick={() => { valuesRef.current = {}; runFrom(0); }} disabled={busy}>{t("retry")}</Button>
        <Button variant="ghost" onClick={() => say(shown)} disabled={busy}>{t("repeatQuestion")}</Button>
        <Button variant="secondary" onClick={() => onModeChange("form")} data-testid="button-switch-form">{t("switchToForm")}</Button>
      </div>
    </div>
  );
}

function FormMode({ steps, onSubmit, onSwitch, submitLabel }: { steps: Step[]; onSubmit: (v: Values) => Promise<string | void>; onSwitch: () => void; submitLabel?: string }) {
  const { t } = useI18n();
  const [values, setValues] = useState<Values>(() => Object.fromEntries(steps.map((s) => [s.key, s.defaultValue ?? (s.type === "yesno" ? "yes" : s.type === "choice" ? s.choices?.[0]?.value ?? "" : "")])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const visible = steps.filter((s) => !s.when || s.when(values));
  const set = (k: string, v: string) => setValues((o) => ({ ...o, [k]: v }));

  // フォームに切り替えたら最初の項目にフォーカスを置く
  useEffect(() => { firstRef.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const s of visible) {
      const v = values[s.key] ?? "";
      if (!v && !s.optional) errs[s.key] = t("required");
      else if (v && s.validate) { const m = s.validate(v); if (m) errs[s.key] = m; }
      if (s.type === "email" && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errs[s.key] = t("error");
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      // 最初の間違いの項目へフォーカスを移す
      const firstKey = visible.find((s) => errs[s.key])?.key;
      if (firstKey) document.getElementById(`f-${firstKey}`)?.focus();
      return;
    }
    setBusy(true);
    setFormError("");
    const out: Values = {};
    for (const s of visible) out[s.key] = values[s.key] ?? "";
    // 失敗したら理由をそのまま出す（読み上げはスクリーンリーダーの role="alert" に任せる）
    const err = await onSubmit(out);
    setBusy(false);
    if (err) setFormError(err);
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {visible.map((s, i) => {
        const id = `f-${s.key}`;
        const label = `${s.label ?? s.prompt}${s.optional ? " " + t("optional") : ""}`;
        return (
          <div key={s.key}>
            <Label htmlFor={id}>{label}</Label>
            {s.type === "choice" || s.type === "yesno" ? (
              <select id={id} ref={i === 0 ? (firstRef as React.RefObject<HTMLSelectElement>) : undefined} className="flex min-h-12 w-full rounded-md border-2 border-input bg-card px-3 py-2 text-base" value={values[s.key]} onChange={(e) => set(s.key, e.target.value)} data-testid={`select-${s.key}`}>
                {(s.type === "yesno" ? [{ value: "yes", label: t("yes") }, { value: "no", label: t("no") }] : s.choices ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            ) : (
              <Input id={id} ref={i === 0 ? (firstRef as React.RefObject<HTMLInputElement>) : undefined} type={s.type === "secret" ? "password" : s.type === "email" ? "email" : s.type === "phone" ? "tel" : s.type === "number" ? "number" : s.type === "time" ? "time" : "text"}
                value={values[s.key]} onChange={(e) => set(s.key, e.target.value)} aria-invalid={!!errors[s.key]} aria-describedby={errors[s.key] ? `${id}-err` : undefined}
                autoComplete={s.autoComplete ?? (s.type === "secret" ? "new-password" : undefined)} data-testid={`input-${s.key}`} />
            )}
            {errors[s.key] && <p id={`${id}-err`} className="text-destructive mt-1" role="alert">{errors[s.key]}</p>}
          </div>
        );
      })}
      {formError && <p className="text-destructive font-semibold" role="alert">{formError}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={busy} data-testid="button-submit">{submitLabel ?? t("next")}</Button>
        <Button type="button" variant="secondary" onClick={onSwitch}>{t("switchToVoice")}</Button>
      </div>
    </form>
  );
}
