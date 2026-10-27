/**
 * 光と振動の合図の設定（少し見える人向け）。使う人が自分で変えられる。
 * 変えた結果は待っている間は見えないので、「試しに光らせる」で流れを一通り見せる
 */
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { previewSignals, setSignalPrefs, useSignal, type SignalPrefs } from "@/lib/signal";
import { setTheme, useTheme, type Theme } from "@/lib/theme";

const THEMES: Theme[] = ["light", "dark", "system"];

export function SignalSettings() {
  const { t } = useI18n();
  const { prefs } = useSignal();
  const set = (patch: Partial<SignalPrefs>) => setSignalPrefs({ ...prefs, ...patch });
  const theme = useTheme();
  const themeLabel: Record<Theme, string> = { light: t("themeLight"), dark: t("themeDark"), system: t("themeSystem") };

  return (
    <details className="text-left" data-testid="signal-settings">
      <summary className="cursor-pointer font-semibold">{t("signalTitle")}</summary>
      <div className="mt-3 space-y-4">
        {/* 画面の明るさ。暗い地のほうが、ボタンの光が見分けやすい */}
        <div role="radiogroup" aria-label={t("themeTitle")} className="flex flex-wrap items-center gap-4">
          <span className="font-semibold">{t("themeTitle")}</span>
          {THEMES.map((v) => (
            <label key={v} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="theme" className="h-5 w-5" checked={theme === v} onChange={() => setTheme(v)} data-testid={`radio-theme-${v}`} />
              {themeLabel[v]}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="h-5 w-5" checked={prefs.light} onChange={(e) => set({ light: e.target.checked })} data-testid="checkbox-signal-light" />
          {t("signalLight")}
        </label>
        <fieldset disabled={!prefs.light} className="space-y-4 disabled:opacity-50">
          <div role="radiogroup" aria-label={t("signalColor")} className="flex flex-wrap items-center gap-4">
            <span className="font-semibold">{t("signalColor")}</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="signal-color" className="h-5 w-5" checked={prefs.color} onChange={() => set({ color: true })} data-testid="radio-signal-color-each" />
              {t("signalColorEach")}
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="signal-color" className="h-5 w-5" checked={!prefs.color} onChange={() => set({ color: false })} data-testid="radio-signal-color-mono" />
              {t("signalColorMono")}
            </label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="signal-thick">{t("signalThick")}</Label>
            <input id="signal-thick" type="range" min={6} max={32} step={2} value={prefs.thick} onChange={(e) => set({ thick: Number(e.target.value) })} className="w-full accent-primary" data-testid="range-signal-thick" />
          </div>
        </fieldset>
        {/* 明るさと動きは、ボタンの光とふちの光の両方に効く */}
        <div className="space-y-1">
          <Label htmlFor="signal-bright">{t("glowBright")}</Label>
          <input id="signal-bright" type="range" min={20} max={100} step={5} value={prefs.bright} onChange={(e) => set({ bright: Number(e.target.value) })} className="w-full accent-primary" data-testid="range-signal-bright" />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="h-5 w-5" checked={prefs.calm} onChange={(e) => set({ calm: e.target.checked })} data-testid="checkbox-signal-calm" />
          {t("signalCalm")}
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="h-5 w-5" checked={prefs.vibrate} onChange={(e) => set({ vibrate: e.target.checked })} data-testid="checkbox-signal-vibrate" />
          {t("signalVibrate")}
        </label>
        {prefs.light && prefs.calm && !prefs.color && <p className="text-sm rounded-md bg-secondary px-3 py-2">{t("signalCalmWarn")}</p>}
        <Button type="button" variant="outline" onClick={previewSignals} disabled={!prefs.light && !prefs.vibrate} data-testid="button-signal-preview">{t("signalPreview")}</Button>
      </div>
    </details>
  );
}
