/**
 * 声が出ないときの確認ページ。ブラウザの状態と、読み上げの結果（開始・終了・失敗の理由）をそのまま画面に出す。
 * 設定の声を通さず、ブラウザの素の読み上げも試せるようにして、どこで止まっているかを切り分ける。
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { getVoicePrefs, isTouchDevice, loadVoices, pickVoice, speak, sttSupported, ttsSupported, unlockSpeech, userActivated, voicesFor } from "@/lib/speech";

export default function VoiceCheck() {
  const { t } = useI18n();
  const [log, setLog] = useState<string[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [tick, setTick] = useState(0);
  const add = (m: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${m}`]);

  useEffect(() => {
    let alive = true;
    const refresh = () => { loadVoices().then((v) => { if (alive) setVoices(v); }); };
    refresh();
    if (ttsSupported()) speechSynthesis.addEventListener("voiceschanged", refresh);
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { alive = false; clearInterval(timer); if (ttsSupported()) speechSynthesis.removeEventListener("voiceschanged", refresh); };
  }, []);

  const prefs = getVoicePrefs();
  const ja = voicesFor(voices, "ja-JP");
  const en = voicesFor(voices, "en-US");
  const chosenJa = pickVoice(voices, "ja-JP");
  const chosenEn = pickVoice(voices, "en-US");

  /** 設定を通さない、ブラウザそのままの読み上げ。ボタンを押した瞬間に同期的に呼ぶ */
  function rawTest(lang: "ja-JP" | "en-US") {
    if (!ttsSupported()) { add("この ブラウザには speechSynthesis がありません"); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(lang === "ja-JP" ? "テストです。聞こえていますか。" : "This is a test. Can you hear me?");
      u.lang = lang;
      u.onstart = () => add(`[素の読み上げ ${lang}] 開始`);
      u.onend = () => add(`[素の読み上げ ${lang}] 終了`);
      u.onerror = (e) => add(`[素の読み上げ ${lang}] 失敗: ${e.error}`);
      speechSynthesis.speak(u);
      add(`[素の読み上げ ${lang}] speak() を呼びました（speaking=${speechSynthesis.speaking} pending=${speechSynthesis.pending} paused=${speechSynthesis.paused}）`);
    } catch (e) {
      add(`[素の読み上げ ${lang}] 例外: ${String(e)}`);
    }
  }

  /** アプリと同じ経路（設定の声を使う）での読み上げ */
  async function appTest(lang: "ja-JP" | "en-US") {
    unlockSpeech();
    add(`[アプリの読み上げ ${lang}] 開始を頼みました`);
    try {
      await speak(lang === "ja-JP" ? "こんにちは、ご予約ちゃんです。" : "Hello, this is GoYoyaku-chan.", lang);
      add(`[アプリの読み上げ ${lang}] 終わりました（鳴らなかったなら、終了まで待たずに戻った可能性）`);
    } catch (e) {
      add(`[アプリの読み上げ ${lang}] 失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const rows: [string, string][] = [
    ["ブラウザ", navigator.userAgent],
    ["読み上げ（speechSynthesis）", ttsSupported() ? "あり" : "なし"],
    ["音声認識（SpeechRecognition）", sttSupported() ? "あり" : "なし"],
    ["ページ内を操作済み（音を出せる状態）", userActivated() ? "はい" : "いいえ（まだ何も押していません）"],
    ["埋め込み枠の中か", window.self !== window.top ? "はい（Replit のプレビュー枠など。別タブで開いてください）" : "いいえ"],
    ["スマホ・タブレットとして判定", isTouchDevice() ? "はい（アプリは声を出しません。VoiceOver などに任せます）" : "いいえ"],
    ["読み上げを止める設定", prefs.mute ? "オン（鳴りません。声の設定で切ってください）" : "オフ"],
    ["端末の声の数", `全体 ${voices.length} / 日本語 ${ja.length} / 英語 ${en.length}`],
    ["日本語で使う声", chosenJa ? `${chosenJa.name} (${chosenJa.lang})` : "なし"],
    ["英語で使う声", chosenEn ? `${chosenEn.name} (${chosenEn.lang})` : "なし"],
    ["いまの状態", ttsSupported() ? `speaking=${speechSynthesis.speaking} pending=${speechSynthesis.pending} paused=${speechSynthesis.paused}` : "-"],
  ];
  void tick;

  return (
    <Layout title={t("voiceCheck")}>
      <div className="space-y-6">
        <p className="text-muted-foreground">下のボタンを押して、何が起きたかを「記録」に出します。鳴らないときは、この画面をそのまま撮って送ってください。</p>

        <div className="flex flex-wrap gap-3">
          <Button size="lg" onClick={() => rawTest("ja-JP")} data-testid="button-raw-ja">① 素の読み上げ（日本語）</Button>
          <Button size="lg" onClick={() => rawTest("en-US")} data-testid="button-raw-en">① 素の読み上げ（英語）</Button>
          <Button size="lg" variant="outline" onClick={() => appTest("ja-JP")} data-testid="button-app-ja">② アプリの読み上げ（日本語）</Button>
          <Button size="lg" variant="outline" onClick={() => appTest("en-US")} data-testid="button-app-en">② アプリの読み上げ（英語）</Button>
        </div>

        <section aria-labelledby="vc-info">
          <h2 id="vc-info" className="text-lg font-bold mb-2">この端末の状態</h2>
          <dl className="rounded-lg border-2 bg-card divide-y-2">
            {rows.map(([k, v]) => (
              <div key={k} className="grid grid-cols-1 sm:grid-cols-3 gap-1 px-4 py-2">
                <dt className="font-semibold">{k}</dt>
                <dd className="sm:col-span-2 break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="vc-log">
          <h2 id="vc-log" className="text-lg font-bold mb-2">記録</h2>
          <pre className="rounded-lg border-2 bg-card p-4 text-sm whitespace-pre-wrap min-h-24" aria-live="polite" data-testid="text-log">{log.length ? log.join("\n") : "（まだ何も押していません）"}</pre>
        </section>

        <p><Button variant="link" asChild><Link href="/voice">{t("voiceSettings")}</Link></Button></p>
      </div>
    </Layout>
  );
}
