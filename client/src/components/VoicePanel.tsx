/**
 * 声で操作するパネル（/admin の主役）。
 * 動線は一本道：話す → 確認を聞く → 「はい」と言う → 結果を聞く。
 * - 大きなマイクボタン1つ。スペースキーでも押せる
 * - 連続モード：読み上げが終わったら自動で聞き取りを再開する
 * - 合言葉を聞くときは、画面にも履歴にも出さない（サーバーへ直接送る）
 * - 日常モデルと相談モデルで声の高さを変える
 * - スクリーンリーダーに任せているとき（スマホ、または「アプリの読み上げを止める」設定）は、こちらから聞き取りを始めない。
 *   読み上げの声をマイクが拾い、合言葉の間違いや勝手な返事になるため。答えははい/いいえのボタンや入力欄にフォーカスを移して受ける
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mic, Square, Loader2, Volume2, Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";
import { listen, speak, stopListening, stopSpeaking, sttSupported, ttsSupported, yesNo, unlockSpeech, SpeechNotAllowed, isTouchDevice, getVoicePrefs } from "@/lib/speech";
import { flashSignal, setSignal, type SignalState } from "@/lib/signal";
import { SignalSettings } from "@/components/SignalSettings";
import { useSignal } from "@/lib/signal";

type Model = "daily" | "consult";
type Msg = { id: number; role: "user" | "assistant"; text: string; model?: Model; kind?: "confirm" | "passphrase" };
type Phase = "idle" | "listening" | "thinking" | "speaking" | "confirm" | "passphrase" | "camera" | "reading";
type Reply =
  | { type: "reply"; text: string; model: Model; changed: boolean; actions: Record<string, unknown>[] }
  | { type: "confirm"; text: string; pendingId: string; action: string; guarded: boolean }
  | { type: "passphrase"; text: string; pendingId: string; retry: boolean };

const PITCH: Record<Model, number> = { daily: 1.05, consult: 0.8 };
const MAX_SHOWN = 14;
/** 開いている間に、新しい知らせを聞きに行く間隔 */
const LIVE_MS = 20_000;

export function VoicePanel({ onChanged, onShareLink, onRegister }: { onChanged?: () => void; onShareLink?: () => void; onRegister?: () => void }) {
  const { t, lang, speechLang } = useI18n();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  // スクリーンリーダーに任せている状態。連続モードは最初は切っておく（読み終わりを待たずに聞き始めないため）
  const srMode = isTouchDevice() || getVoicePrefs().mute;
  const [continuous, setContinuous] = useState(() => !srMode);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const pendingRef = useRef<{ id: string; stage: "confirm" | "passphrase" } | null>(null);
  const continuousRef = useRef(continuous);
  const runId = useRef(0);
  const nextId = useRef(1);
  const announced = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cameraFor, setCameraFor] = useState<{ reservationId: number; customerName: string } | null>(null);
  continuousRef.current = continuous;
  // 確認と合言葉で、こちらから聞き取りを始めてよいか。スクリーンリーダーに任せているときは、連続モードを自分で入れた人だけ
  const canAutoListen = () => sttSupported() && (!srMode || continuousRef.current);

  const status = useQuery<{ aiConfigured: boolean; hasPassphrase: boolean }>({ queryKey: ["/api/voice/status"] });
  // ボタンの光の明るさと「動きを減らす」は、ふちの光と同じ設定
  const { prefs: sigPrefs } = useSignal();
  const history = useQuery<{ messages: { id: number; role: string; content: string; model: Model }[] }>({ queryKey: ["/api/voice/history"], staleTime: Infinity });
  useEffect(() => {
    if (history.data && messages.length === 0) {
      setMessages(history.data.messages.slice(-MAX_SHOWN).map((m) => ({ id: m.id, role: m.role === "user" ? "user" : "assistant", text: m.content, model: m.model })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data]);

  const push = useCallback((m: Omit<Msg, "id">) => {
    setMessages((list) => [...list, { ...m, id: 10_000_000 + nextId.current++ }].slice(-MAX_SHOWN));
  }, []);

  const say = useCallback(async (text: string, model: Model = "daily") => {
    if (!ttsSupported()) return;
    setPhase("speaking");
    try { await speak(text, speechLang, { pitch: PITCH[model] }); setNeedsGesture(false); }
    catch (e) { if (e instanceof SpeechNotAllowed) setNeedsGesture(true); }
  }, [speechLang]);

  // ---------- サーバーとのやり取り ----------

  const handleReply = useCallback(async (reply: Reply, id: number) => {
    const alive = () => runId.current === id;
    if (reply.type === "reply") {
      pendingRef.current = null;
      push({ role: "assistant", text: reply.text, model: reply.model });
      if (reply.changed) { onChanged?.(); flashSignal("ok"); }
      const cam = (reply.actions ?? []).find((a) => a.action === "open_camera");
      const share = (reply.actions ?? []).some((a) => a.action === "share_link");
      const register = (reply.actions ?? []).some((a) => a.action === "open_signup");
      await say(reply.text, reply.model);
      if (!alive()) return;
      if (register) {
        // 「登録する」→ 読み終わったら登録の画面へ
        setPhase("idle");
        onRegister?.();
        return;
      }
      if (share) {
        // 共有画面は操作の中でしか開けないので、送るボタンへフォーカスを移して押してもらう
        setPhase("idle");
        onShareLink?.();
        return;
      }
      if (cam) {
        // 「お金を確認」→ カメラを開く。読み取りが終わるまで聞き取りはしない
        setCameraFor({ reservationId: Number(cam.reservationId), customerName: String(cam.customerName ?? "") });
        setPhase("camera");
        try { fileRef.current?.click(); } catch { /* ユーザー操作が要るブラウザではボタンを押してもらう */ }
        return;
      }
      if (continuousRef.current && sttSupported()) void listenForMessage();
      else setPhase("idle");
      return;
    }
    if (reply.type === "confirm") {
      pendingRef.current = { id: reply.pendingId, stage: "confirm" };
      push({ role: "assistant", text: reply.text, kind: "confirm" });
      await say(reply.text, "daily");
      if (!alive()) return;
      setPhase("confirm");
      if (canAutoListen()) void listenForYesNo(0);
      return;
    }
    // 合言葉：質問は表示するが、答えは表示も記録もしない
    pendingRef.current = { id: reply.pendingId, stage: "passphrase" };
    push({ role: "assistant", text: reply.text, kind: "passphrase" });
    await say(reply.text, "daily");
    if (!alive()) return;
    setPhase("passphrase");
    if (canAutoListen()) void listenForPassphrase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, say, onChanged, onRegister]);

  const post = useCallback(async (url: string, body: unknown) => {
    const id = ++runId.current;
    setPhase("thinking");
    setError("");
    try {
      const reply = await apiRequest<Reply>("POST", url, body);
      if (runId.current !== id) return;
      await handleReply(reply, id);
    } catch (e) {
      if (runId.current !== id) return;
      const msg = e instanceof ApiRequestError ? e.message : t("error");
      setError(msg);
      flashSignal("ng");
      push({ role: "assistant", text: msg });
      await say(msg);
      setPhase("idle");
    }
  }, [handleReply, push, say, t]);

  const sendMessage = useCallback((text: string) => {
    const v = text.trim();
    if (!v) return;
    push({ role: "user", text: v });
    return post("/api/voice/message", { text: v });
  }, [post, push]);

  const sendConfirm = useCallback((answer: "yes" | "no") => {
    const p = pendingRef.current;
    if (!p) return;
    push({ role: "user", text: t(answer) });
    return post("/api/voice/confirm", { pendingId: p.id, answer });
  }, [post, push, t]);

  const sendPassphrase = useCallback((phrase: string) => {
    const p = pendingRef.current;
    if (!p || !phrase.trim()) return;
    push({ role: "user", text: t("passphraseHidden") });
    return post("/api/voice/passphrase", { pendingId: p.id, passphrase: phrase });
  }, [post, push, t]);

  // ---------- 聞き取り ----------

  const listenForMessage = useCallback(async () => {
    const id = ++runId.current;
    setPhase("listening");
    try {
      const heard = await listen(speechLang, 10000);
      if (runId.current !== id) return;
      if (heard) await sendMessage(heard);
      else setPhase("idle");
    } catch {
      if (runId.current === id) setPhase("idle");
    }
  }, [sendMessage, speechLang]);

  const listenForYesNo = useCallback(async (attempt: number) => {
    const id = ++runId.current;
    setPhase("listening");
    let heard = "";
    try { heard = await listen(speechLang, 10000); } catch { heard = ""; }
    if (runId.current !== id) return;
    const yn = yesNo(heard, lang);
    if (yn) { await sendConfirm(yn); return; }
    if (attempt < 1) {
      await say(t("sayYesOrNo"));
      if (runId.current !== id) return;
      void listenForYesNo(attempt + 1);
      return;
    }
    setPhase("confirm");
  }, [lang, say, sendConfirm, speechLang, t]);

  const listenForPassphrase = useCallback(async () => {
    const id = ++runId.current;
    setPhase("listening");
    let heard = "";
    try { heard = await listen(speechLang, 10000); } catch { heard = ""; }
    if (runId.current !== id) return;
    if (heard) await sendPassphrase(heard);
    else setPhase("passphrase");
  }, [sendPassphrase, speechLang]);

  // ---------- カメラ（お札・硬貨の読み取り。写真は送るだけで保存しない） ----------

  const onPhoto = useCallback(async (file: File | undefined) => {
    const target = cameraFor;
    if (!file || !target) return;
    const id = ++runId.current;
    setPhase("reading");
    setError("");
    try {
      const image = await shrinkImage(file, 1280);
      const r = await apiRequest<{ text: string; total: { display: string }; change: { display: string } }>("POST", "/api/voice/cash", { reservationId: target.reservationId, image });
      if (runId.current !== id) return;
      setCameraFor(null);
      push({ role: "assistant", text: r.text });
      await say(r.text, "daily");
      if (runId.current !== id) return;
      if (continuousRef.current && sttSupported()) void listenForMessage(); else setPhase("idle");
    } catch (e) {
      if (runId.current !== id) return;
      const msg = e instanceof ApiRequestError ? e.message : t("error");
      setError(msg);
      flashSignal("ng");
      push({ role: "assistant", text: msg });
      await say(msg);
      setPhase("camera");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [cameraFor, listenForMessage, push, say, t]);

  const closeCamera = useCallback(() => { setCameraFor(null); setPhase("idle"); }, []);

  // ---------- マイクボタン・スペースキー ----------

  const onMic = useCallback(() => {
    if (phase === "listening") { runId.current++; stopListening(); setPhase(pendingRef.current?.stage ?? "idle"); return; }
    if (phase === "thinking" || phase === "reading") return;
    runId.current++;
    stopSpeaking();
    if (cameraFor) setCameraFor(null);
    const stage = pendingRef.current?.stage;
    if (stage === "confirm") void listenForYesNo(0);
    else if (stage === "passphrase") void listenForPassphrase();
    else void listenForMessage();
  }, [cameraFor, listenForMessage, listenForPassphrase, listenForYesNo, phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.code !== "Space" || !el) return;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(el.tagName) || el.isContentEditable) return;
      e.preventDefault();
      onMic();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onMic]);

  // 開いたら、新しい予約・取り消しと今日の予定を伝える（初めてならあいさつ）。履歴を読み込んでから足す。
  // 自動再生が止められたら、次の操作で読み上げる
  const welcomeRef = useRef("");
  useEffect(() => {
    if (announced.current || !history.data) return;
    announced.current = true;
    const sayWelcome = (text: string) => { welcomeRef.current = text; speak(text, speechLang).catch((e) => { if (e instanceof SpeechNotAllowed) setNeedsGesture(true); }); };
    apiRequest<{ text: string }>("POST", "/api/voice/briefing")
      .then((b) => { push({ role: "assistant", text: b.text }); sayWelcome(b.text); })
      .catch(() => sayWelcome(t("voiceWelcome")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data]);

  // 開いている間に起きたこと（ネットの予約、カード払いが済んだ・払われずに取り消した、など）を、その場で伝える。
  // 会話の途中には割り込まない（何もしていないときだけ聞きに行く。伝えそびれたものは次に回る）。画面が隠れている間は聞かない
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    if (!history.data) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || !announced.current || phaseRef.current !== "idle" || document.visibilityState !== "visible") return;
      try {
        const r = await apiRequest<{ text: string }>("POST", "/api/voice/live");
        if (stopped || !r.text) return;
        push({ role: "assistant", text: r.text });
        flashSignal("ok");
        onChanged?.();
        if (phaseRef.current !== "idle") return;
        await say(r.text);
        setPhase((p) => (p === "speaking" ? "idle" : p));
      } catch { /* 次の回に聞き直す */ }
    };
    const timer = setInterval(() => void tick(), LIVE_MS);
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data, say, push]);

  useEffect(() => {
    if (!needsGesture) return;
    const retry = () => { unlockSpeech(); setNeedsGesture(false); speak(welcomeRef.current || t("voiceWelcome"), speechLang).catch(() => { /* 無視 */ }); };
    window.addEventListener("keydown", retry, { once: true });
    window.addEventListener("pointerdown", retry, { once: true });
    return () => { window.removeEventListener("keydown", retry); window.removeEventListener("pointerdown", retry); };
  }, [needsGesture, speechLang, t]);

  useEffect(() => () => { runId.current++; stopSpeaking(); stopListening(); setSignal("idle"); }, []);

  // 聞き取りを始めずに答えを待つときは、答える部品へフォーカスを移す（はい/いいえ、合言葉の入力欄）。
  // 質問の読み上げが途中で切れても、部品の説明（aria-describedby）として聞き直せる
  useEffect(() => {
    if (canAutoListen()) return;
    if (phase === "confirm") yesRef.current?.focus();
    else if (phase === "passphrase") inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 少し見える人への合図（画面のふちの光と振動）。はい/いいえを聞いている間は「確認待ち」として知らせる
  useEffect(() => {
    const stage = pendingRef.current?.stage;
    const s: SignalState = phase === "listening" ? (stage === "confirm" ? "confirm" : "listen")
      : phase === "thinking" || phase === "reading" ? "think"
      : phase === "speaking" ? "speak"
      : phase === "confirm" ? "confirm"
      : "idle";
    setSignal(s);
  }, [phase]);

  function submitTyped(e: React.FormEvent) {
    e.preventDefault();
    const v = typed;
    setTyped("");
    if (!v.trim()) return;
    runId.current++;
    stopSpeaking(); stopListening();
    const stage = pendingRef.current?.stage;
    if (stage === "passphrase") { void sendPassphrase(v); return; }
    if (stage === "confirm") { const yn = yesNo(v, lang); if (yn) { void sendConfirm(yn); return; } }
    void sendMessage(v);
  }

  const aiOff = status.data && !status.data.aiConfigured;
  const busy = phase === "thinking" || phase === "reading";
  const phaseLabel = phase === "listening" ? t("listening") : phase === "thinking" ? t("thinking") : phase === "speaking" ? t("speaking")
    : phase === "confirm" ? t("waitingYesNo") : phase === "passphrase" ? t("passphraseListening") : phase === "camera" ? t("cameraHint") : phase === "reading" ? t("cameraReading") : t("micHint");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lanternState = phase === "listening" || phase === "passphrase" ? "listen" : busy ? "think" : phase === "speaking" ? "speak" : phase === "confirm" ? "confirm" : "idle";
  const showTypedOpen = phase === "passphrase" || !sttSupported() || !!aiOff;
  const typedForm = (
    <form onSubmit={submitTyped} className="flex flex-col sm:flex-row gap-3 text-left">
      <div className="flex-1">
        <Label htmlFor="voice-typed">{phase === "passphrase" ? t("passphraseTyped") : t("typeHere")}</Label>
        <Input id="voice-typed" ref={inputRef} type={phase === "passphrase" ? "password" : "text"} aria-describedby={phase === "passphrase" ? "voice-last" : undefined} autoComplete="off" value={typed}
          onChange={(e) => setTyped(e.target.value)} disabled={busy || !!aiOff} data-testid="input-voice-text" />
      </div>
      <Button type="submit" size="lg" className="sm:self-end" disabled={busy || !!aiOff} data-testid="button-voice-send">{t("send")}</Button>
    </form>
  );

  return (
    <section aria-labelledby="voice-heading" className={`lantern-stage py-6 sm:py-10 text-center space-y-6${sigPrefs.calm ? " lantern-calm" : ""}`} data-s={lanternState} style={{ "--lt-b": sigPrefs.bright / 100 } as React.CSSProperties} data-testid="voice-panel">
      <h2 id="voice-heading" className="sr-only">{t("voiceTitle")}</h2>
      <div className="lantern-wash" aria-hidden />

      {aiOff ? <p role="alert" className="text-destructive font-semibold">{t("aiNotConfigured")}</p> : null}

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onMic}
          disabled={!!aiOff}
          aria-disabled={busy || undefined}
          aria-pressed={phase === "listening"}
          aria-label={phase === "listening" ? t("micStop") : t("micStart")}
          data-testid="button-mic"
          data-s={lanternState}
          className="lantern h-40 w-40 sm:h-48 sm:w-48 flex items-center justify-center focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
        >
          {busy ? <Loader2 className="h-16 w-16 animate-spin" aria-hidden /> : phase === "listening" ? <Square className="h-16 w-16" aria-hidden /> : phase === "speaking" ? <Volume2 className="h-16 w-16" aria-hidden /> : <Mic className="h-20 w-20" aria-hidden />}
        </button>
        {/* 状態はスクリーンリーダーに読ませない（聞き取り中に読まれると、その声をマイクが拾う）。マイクボタンの aria-pressed で足りる */}
        <p className="text-base font-medium text-muted-foreground" aria-hidden="true" data-testid="text-phase">{phaseLabel}</p>
        {needsGesture && <p className="text-sm" role="status">{t("pressAnyKey")}</p>}
        {!sttSupported() && <p className="text-sm text-muted-foreground">{t("noSpeech")}</p>}
      </div>

      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void onPhoto(e.target.files?.[0])} data-testid="input-cash-photo" />
      {cameraFor && phase !== "reading" && (
        <div className="flex flex-col items-center gap-3" role="group" aria-label={t("cameraTitle")}>
          <Button size="lg" onClick={() => fileRef.current?.click()} data-testid="button-camera"><Camera className="h-7 w-7" aria-hidden />{t("cameraOpen", { name: cameraFor.customerName })}</Button>
          <Button variant="ghost" onClick={closeCamera} data-testid="button-camera-cancel">{t("cancel")}</Button>
        </div>
      )}

      {phase === "confirm" && (
        <div className="flex justify-center gap-4" role="group" aria-label={t("waitingYesNo")}>
          <Button ref={yesRef} size="lg" aria-describedby="voice-last" onClick={() => { runId.current++; stopListening(); void sendConfirm("yes"); }} data-testid="button-confirm-yes">{t("yes")}</Button>
          <Button size="lg" variant="outline" aria-describedby="voice-last" onClick={() => { runId.current++; stopListening(); void sendConfirm("no"); }} data-testid="button-confirm-no">{t("no")}</Button>
        </div>
      )}

      <div className="mx-auto max-w-xl min-h-16 text-left" aria-live="polite" aria-atomic="true" data-testid="text-assistant-live">
        <p className="sr-only">{lastAssistant?.model === "consult" ? t("advisorLabel") : t("assistantLabel")}</p>
        <p id="voice-last" className="text-lg font-semibold whitespace-pre-wrap">{lastAssistant?.text ?? ""}</p>
        {error && <p className="mt-2 text-destructive font-semibold" role="alert">{error}</p>}
      </div>

      {/* 声が使えないときと合言葉のときは、文字の入力を表に出す。それ以外はたたんでおく */}
      {showTypedOpen && typedForm}
      <details className="text-left mx-auto max-w-xl" data-testid="details-voice-more">
        <summary className="cursor-pointer text-sm text-muted-foreground">{t("voiceMore")}</summary>
        <div className="mt-4 space-y-5">
          {!showTypedOpen && typedForm}
          <div className="flex flex-wrap items-center justify-center gap-4 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="h-5 w-5" checked={continuous} onChange={(e) => setContinuous(e.target.checked)} data-testid="checkbox-continuous" />
              {t("continuousMode")}
            </label>
            <span className="text-muted-foreground">{t("spaceHint")}</span>
          </div>

          <SignalSettings />

          <h3 className="font-semibold">{t("transcript")}</h3>
          <ol className="mt-3 space-y-2" aria-label={t("transcript")}>
            {messages.map((m) => (
              <li key={m.id} className={`rounded-md px-3 py-2 ${m.role === "user" ? "bg-secondary" : m.model === "consult" ? "bg-accent text-accent-foreground" : "border-2"}`} data-testid={`msg-${m.role}`}>
                <span className="text-xs text-muted-foreground block">{m.role === "user" ? t("you") : m.model === "consult" ? t("advisorLabel") : t("assistantLabel")}</span>
                {m.text}
              </li>
            ))}
          </ol>
        </div>
      </details>
    </section>
  );
}

/** 写真を縮めて JPEG の data URL にする（送る量を減らす。保存はしない） */
function shrinkImage(file: File, maxSide: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });
}
