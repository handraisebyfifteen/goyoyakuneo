import { useEffect, useState } from "react";
import { speak, SpeechNotAllowed, stopSpeaking } from "@/lib/speech";

/** ページを開いたら、何のページかを声で案内する。自動再生が止められたら、次の操作で読み上げる */
export function useAnnounce(text: string, lang: string, enabled = true) {
  const [needsGesture, setNeedsGesture] = useState(false);
  useEffect(() => {
    if (!enabled || !text) return;
    let cancelled = false;
    const tryOnce = () => speak(text, lang).then(() => { if (!cancelled) setNeedsGesture(false); }).catch((e) => {
      if (e instanceof SpeechNotAllowed && !cancelled) setNeedsGesture(true);
    });
    tryOnce();
    const onGesture = () => { tryOnce(); window.removeEventListener("keydown", onGesture); window.removeEventListener("pointerdown", onGesture); };
    window.addEventListener("keydown", onGesture);
    window.addEventListener("pointerdown", onGesture);
    return () => {
      cancelled = true;
      stopSpeaking();
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("pointerdown", onGesture);
    };
  }, [text, lang, enabled]);
  return needsGesture;
}
