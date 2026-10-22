/**
 * 台本つきの会話で入力を集める部品（AI は使わない）。
 * 読み上げ → 聞き取り → 「〜ですね。よろしいですか？」→ はい/いいえ、の一本道。
 * 同じ台本を「フォーム」としても表示でき、キーボードだけでも最後まで進める。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { listen, speak, stopListening, stopSpeaking, sttSupported, ttsSupported, yesNo, parseSpokenEmail, parseSpokenPhone, parseSpokenNumber, parseSpokenTime, SpeechNotAllowed } from "@/lib/speech";

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
  when?: (values: Record<string, string>) => boolean;
};

export type Values = Record<string, string>;
type Mode = "voice" | "form";
type Status = "idle" | "speaking" | "listening" | "confirming" | "submitting" | "done";

type Props = {
  steps: Step[];
  intro?: string;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onComplete: (values: Values) => Promise<string | void>;
  pitch?: number;
  submitLabel?: string;
};

const NONE_WORDS = ["なし", "ない", "ありません", "none", "no", "nothing", "skip"];
const KEEP_WORDS = ["そのまま", "変えない", "かえない", "keep", "same", "default", "skip"];

export function VoiceConversation({ steps, intro, mode, onModeChange, onComplete, pitch = 1, submitLabel }: Props) {
  const { t, lang, speechLang } = useI18n();
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [shown, setShown] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const valuesRef = useRef<Values>({});
  const typedRef = useRef<string | null>(null);
  const runId = useRef(0);
  const liveRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const say = useCallback(async (text: string) => {
    setShown(text);
    if (!ttsSupported()) return;
    try { await speak(text, speechLang, { pitch }); setNeedsGesture(false); }
    catch (e) { if (e instanceof SpeechNotAllowed) setNeedsGesture(true); }
  }, [speechLang, pitch]);

  const activeSteps = useCallback(() => steps.filter((s) => !s.when || s.when(valuesRef.current)), [steps]);

  function parseAnswer(step: Step, raw: string, fromVoice: boolean): { value: string; display: string } | { error: string } {
    const text = raw.trim();
    const low = text.normalize("NFKC").toLowerCase().replace(/[\s、。，．,.!?！？]/g, "");
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
      setIndex(i); setError(""); setTyped(""); typedRef.current = null;
      setStatus("speaking");
      let prompt = step.prompt;
      if (step.type === "choice") prompt += " " + t("choose", { options: (step.choices ?? []).map((x) => x.label).join(lang === "ja" ? "、" : ", ") });
      if (step.defaultValue !== undefined && step.type !== "secret") prompt += lang === "ja" ? ` 今は「${step.defaultValue}」です。そのままなら「そのまま」と言ってください。` : ` Currently "${step.defaultValue}". Say "keep" to leave it.`;
      await say(prompt);
      if (!alive()) return;

      let committed = false;
      while (alive() && !committed) {
        let heard = "";
        let fromVoice = true;
        if (typedRef.current !== null) { heard = typedRef.current; typedRef.current = null; fromVoice = false; }
        else if (sttSupported()) {
          setStatus("listening");
          try { heard = await listen(speechLang); }
          catch {
            if (!alive()) return;
            if (typedRef.current !== null) { heard = typedRef.current; typedRef.current = null; fromVoice = false; }
            else { await say(t("notHeard")); continue; }
          }
        } else {
          // 音声認識がない：入力欄からの送信を待つ
          setStatus("idle");
          heard = await new Promise<string>((resolve) => { waitTyped.current = resolve; });
          fromVoice = false;
        }
        if (!alive()) return;
        const parsed = parseAnswer(step, heard, fromVoice);
        if ("error" in parsed) { setError(parsed.error); await say(parsed.error); continue; }
        const v = step.validate?.(parsed.value);
        if (v) { setError(v); await say(v); continue; }
        if (!fromVoice) { valuesRef.current[step.key] = parsed.value; committed = true; break; }
        setStatus("confirming");
        await say(step.type === "secret" ? t("heardSecret") : t("heardYou", { value: parsed.display }));
        if (!alive()) return;
        let answer: "yes" | "no" | null = null;
        if (typedRef.current !== null) { answer = typedRef.current === "yes" ? "yes" : "no"; typedRef.current = null; }
        else {
          setStatus("listening");
          try { answer = yesNo(await listen(speechLang), lang); } catch { answer = null; }
          if (typedRef.current !== null) { answer = typedRef.current === "yes" ? "yes" : typedRef.current === "no" ? "no" : answer; typedRef.current = null; }
        }
        if (!alive()) return;
        if (answer === "yes") { valuesRef.current[step.key] = parsed.value; committed = true; }
        else { await say(step.prompt); }
      }
      i += 1;
    }
  }, [activeSteps, finish, lang, say, speechLang, t]);

  const waitTyped = useRef<((v: string) => void) | null>(null);

  useEffect(() => {
    if (mode !== "voice") { runId.current++; stopSpeaking(); stopListening(); setStatus("idle"); return; }
    valuesRef.current = {};
    (async () => { if (intro) await say(intro); runFrom(0); })();
    return () => { runId.current++; stopSpeaking(); stopListening(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (!needsGesture) return;
    const retry = () => { setNeedsGesture(false); valuesRef.current = {}; runFrom(0); };
    window.addEventListener("keydown", retry, { once: true });
    window.addEventListener("pointerdown", retry, { once: true });
    return () => { window.removeEventListener("keydown", retry); window.removeEventListener("pointerdown", retry); };
  }, [needsGesture, runFrom]);

  function submitTyped(value: string) {
    if (waitTyped.current) { const r = waitTyped.current; waitTyped.current = null; r(value); return; }
    typedRef.current = value;
    stopSpeaking();
    stopListening();
  }

  const list = activeSteps();
  const step = list[Math.min(index, Math.max(list.length - 1, 0))];

  // ---------- フォーム表示 ----------
  if (mode === "form") {
    return <FormMode steps={steps} onSubmit={async (values) => { valuesRef.current = values; return finish(); }} onSwitch={() => onModeChange("voice")} submitLabel={submitLabel} />;
  }

  const busy = status === "submitting" || status === "done";
  return (
    <div className="space-y-5">
      <div className="rounded-lg border-2 bg-card p-5 min-h-28" aria-live="polite" ref={liveRef}>
        <p className="text-sm text-muted-foreground mb-1">
          {status === "listening" ? t("listening") : status === "speaking" ? t("speaking") : status === "submitting" ? t("processing") : ""}
        </p>
        <p className="text-xl font-semibold" data-testid="text-prompt">{shown}</p>
        {error && <p className="mt-2 text-destructive font-semibold" role="alert">{error}</p>}
        {needsGesture && <p className="mt-2 text-sm" role="status">{t("pressAnyKey")}</p>}
        {!sttSupported() && <p className="mt-2 text-sm text-muted-foreground">{t("noSpeech")}</p>}
      </div>

      {step && !busy && (
        <div className="space-y-3">
          {status === "confirming" ? (
            <div className="flex gap-3">
              <Button size="lg" onClick={() => submitTyped("yes")} data-testid="button-yes">{t("yes")}</Button>
              <Button size="lg" variant="outline" onClick={() => submitTyped("no")} data-testid="button-no">{t("no")}</Button>
            </div>
          ) : step.type === "choice" ? (
            <div className="flex flex-wrap gap-3" role="group" aria-label={step.label ?? step.prompt}>
              {(step.choices ?? []).map((c) => (
                <Button key={c.value} size="lg" variant="outline" onClick={() => submitTyped(c.value)} data-testid={`button-choice-${c.value}`}>{c.label}</Button>
              ))}
            </div>
          ) : step.type === "yesno" ? (
            <div className="flex gap-3">
              <Button size="lg" onClick={() => submitTyped("yes")}>{t("yes")}</Button>
              <Button size="lg" variant="outline" onClick={() => submitTyped("no")}>{t("no")}</Button>
            </div>
          ) : (
            <form className="flex flex-col sm:flex-row gap-3" onSubmit={(e) => { e.preventDefault(); submitTyped(typed); setTyped(""); }}>
              <div className="flex-1">
                <Label htmlFor="voice-typed">{step.label ?? t("typeAnswer")}</Label>
                <Input id="voice-typed" ref={inputRef} type={step.type === "secret" ? "password" : step.type === "email" ? "email" : step.type === "phone" ? "tel" : step.type === "number" ? "number" : "text"}
                  inputMode={step.type === "number" ? "decimal" : step.type === "phone" ? "tel" : undefined}
                  autoComplete={step.type === "secret" ? "off" : undefined}
                  value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={step.defaultValue} data-testid={`input-${step.key}`} />
              </div>
              <Button type="submit" size="lg" className="sm:self-end" data-testid="button-next">{t("next")}</Button>
            </form>
          )}
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

function FormMode({ steps, onSubmit, onSwitch, submitLabel }: { steps: Step[]; onSubmit: (v: Values) => Promise<boolean>; onSwitch: () => void; submitLabel?: string }) {
  const { t } = useI18n();
  const [values, setValues] = useState<Values>(() => Object.fromEntries(steps.map((s) => [s.key, s.defaultValue ?? (s.type === "yesno" ? "yes" : s.type === "choice" ? s.choices?.[0]?.value ?? "" : "")])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const visible = steps.filter((s) => !s.when || s.when(values));
  const set = (k: string, v: string) => setValues((o) => ({ ...o, [k]: v }));

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
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFormError("");
    const out: Values = {};
    for (const s of visible) out[s.key] = values[s.key] ?? "";
    const ok = await onSubmit(out);
    setBusy(false);
    if (!ok) setFormError(t("error"));
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {visible.map((s) => {
        const id = `f-${s.key}`;
        const label = `${s.label ?? s.prompt}${s.optional ? " " + t("optional") : ""}`;
        return (
          <div key={s.key}>
            <Label htmlFor={id}>{label}</Label>
            {s.type === "choice" || s.type === "yesno" ? (
              <select id={id} className="flex min-h-12 w-full rounded-md border-2 border-input bg-card px-3 py-2 text-base" value={values[s.key]} onChange={(e) => set(s.key, e.target.value)} data-testid={`select-${s.key}`}>
                {(s.type === "yesno" ? [{ value: "yes", label: t("yes") }, { value: "no", label: t("no") }] : s.choices ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            ) : (
              <Input id={id} type={s.type === "secret" ? "password" : s.type === "email" ? "email" : s.type === "phone" ? "tel" : s.type === "number" ? "number" : s.type === "time" ? "time" : "text"}
                value={values[s.key]} onChange={(e) => set(s.key, e.target.value)} aria-invalid={!!errors[s.key]} aria-describedby={errors[s.key] ? `${id}-err` : undefined}
                autoComplete={s.type === "secret" ? "new-password" : undefined} data-testid={`input-${s.key}`} />
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
