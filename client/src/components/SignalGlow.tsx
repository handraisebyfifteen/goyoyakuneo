/**
 * 画面のふちの光（lib/signal.ts の合図を描く）。飾りなので読み上げ機能には見せない。
 * 光り方そのものは index.css の .sig-* に書いてある
 */
import type { CSSProperties } from "react";
import { useSignal } from "@/lib/signal";

export function SignalGlow() {
  const { state, flash, prefs } = useSignal();
  if (!prefs.light) return null;
  const style = { "--sig-t": `${prefs.thick}px`, "--sig-b": prefs.bright / 100 } as CSSProperties;
  return (
    <div aria-hidden className={`sig${prefs.color ? "" : " sig-mono"}${prefs.calm ? " sig-calm" : ""}`} style={style} data-testid="signal-glow">
      <div className="sig-layer" data-s={state}><div className="sig-ring" /></div>
      {flash && <div key={flash.n} className="sig-layer" data-s={flash.kind} />}
    </div>
  );
}
