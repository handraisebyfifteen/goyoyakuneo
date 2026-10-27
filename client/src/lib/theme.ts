/**
 * 画面の明るさ（ライト / ダーク / 端末に合わせる）。端末ごとに保存し、<html data-theme> に反映する。
 * 色そのものは index.css（:root と [data-theme="dark"]）に書いてある
 */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "theme";
const listeners = new Set<() => void>();
let current: Theme = load();

function load(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

function apply(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

/** 起動時に一度呼ぶ。保存してある設定を画面に反映する */
export function initTheme() {
  apply(current);
}

export function setTheme(t: Theme) {
  current = t;
  try { localStorage.setItem(KEY, t); } catch { /* 無視 */ }
  apply(t);
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current, () => "system");
}
