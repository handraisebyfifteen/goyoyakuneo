/**
 * 少し見える人のための「合図」：画面のふちの光と振動で、いまの状態を知らせる。
 * - 光り方のリズムと振動の回数で区別できるようにし、色は補助にとどめる
 * - 点滅は1秒に3回まで（速い点滅は発作を起こすことがある）
 * - 光も振動も読み上げ機能には伝えない。全盲の人の操作は変わらない
 * - 振動は Android だけ（iPhone のブラウザには振動の仕組みがない）
 */
import { useSyncExternalStore } from "react";

/** 続く状態。声の画面が今どこにいるかをそのまま渡す */
export type SignalState = "idle" | "listen" | "think" | "speak" | "confirm";
/** 一度だけ光る合図 */
export type SignalFlash = "ok" | "ng";

export type SignalPrefs = { light: boolean; color: boolean; bright: number; thick: number; vibrate: boolean; calm: boolean };

// 振動は「こちらが動く場面」だけ。考え中・話し中は鳴らさない
const BUZZ: Partial<Record<SignalState | SignalFlash, number[]>> = {
  listen: [70],
  confirm: [70, 110, 70],
  ok: [320],
  ng: [90, 70, 90, 70, 90],
};
const FLASH_MS: Record<SignalFlash, number> = { ok: 1600, ng: 2400 };

const PREFS_KEY = "signalPrefs";
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const DEFAULT_PREFS: SignalPrefs = { light: true, color: true, bright: 100, thick: 14, vibrate: true, calm: false };

function loadPrefs(): SignalPrefs {
  let saved: Partial<SignalPrefs> = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"); } catch { /* 使えない環境 */ }
  // 端末で「視差効果を減らす」がオンなら、最初から動きを減らしておく
  return { ...DEFAULT_PREFS, calm: reducedMotion(), ...saved };
}

type Snapshot = { state: SignalState; flash: { kind: SignalFlash; n: number } | null; prefs: SignalPrefs };

let snap: Snapshot = { state: "idle", flash: null, prefs: typeof window === "undefined" ? DEFAULT_PREFS : loadPrefs() };
const listeners = new Set<() => void>();
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let flashSeq = 0;
let previewTimers: ReturnType<typeof setTimeout>[] = [];

function emit(next: Partial<Snapshot>) {
  snap = { ...snap, ...next };
  listeners.forEach((l) => l());
}

function buzz(kind: SignalState | SignalFlash) {
  const pattern = BUZZ[kind];
  if (!pattern || !snap.prefs.vibrate) return;
  try { navigator.vibrate?.(pattern); } catch { /* 振動できない端末 */ }
}

function show(state: SignalState) {
  if (snap.state === state) return;
  emit({ state });
  buzz(state);
}

function stopPreview() {
  previewTimers.forEach(clearTimeout);
  previewTimers = [];
}

export function setSignal(state: SignalState) {
  stopPreview();
  show(state);
}

export function flashSignal(kind: SignalFlash) {
  clearTimeout(flashTimer);
  emit({ flash: { kind, n: ++flashSeq } });
  buzz(kind);
  flashTimer = setTimeout(() => emit({ flash: null }), FLASH_MS[kind]);
}

/** 設定を変えたときに、ひと通りの流れを光らせて見せる。終わったら元の状態に戻す */
export function previewSignals() {
  stopPreview();
  const back = snap.state;
  const flow: [SignalState, number][] = [["listen", 3000], ["think", 2500], ["speak", 3000], ["confirm", 3600]];
  let t = 0;
  for (const [state, ms] of flow) {
    previewTimers.push(setTimeout(() => show(state), t));
    t += ms;
  }
  previewTimers.push(setTimeout(() => { show("idle"); flashSignal("ok"); }, t));
  previewTimers.push(setTimeout(() => { previewTimers = []; show(back); }, t + FLASH_MS.ok));
}

export function setSignalPrefs(prefs: SignalPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 無視 */ }
  emit({ prefs });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useSignal() {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}
