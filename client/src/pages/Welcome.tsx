import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useAuth } from "@/hooks/useAuth";
import { hasVoicePrefs, isTouchDevice } from "@/lib/speech";
import { deviceKey, resumeShop, startShop } from "@/lib/device";
import { ApiRequestError } from "@/lib/queryClient";

export default function Welcome() {
  const { t, lang, speechLang } = useI18n();
  const { owner } = useAuth();
  const [, navigate] = useLocation();
  // 登録しなくても始められる。この端末で始めたお店があれば、そのお店を開く
  const [hasDeviceShop, setHasDeviceShop] = useState(() => !!deviceKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function begin() {
    setBusy(true);
    setError("");
    try {
      if (hasDeviceShop) {
        if (await resumeShop()) return navigate("/admin");
        // 鍵が使えなければ捨ててあるので、次に押したときは新しく始める
        setHasDeviceShop(false);
        setError(t("deviceShopMissing"));
        return;
      }
      await startShop(lang);
      navigate("/admin");
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : t("error"));
    } finally {
      setBusy(false);
    }
  }
  // 初めて開いた人は、まず声の設定へ（声で進められる）。スマホはアプリが声を出さないので案内しない
  const firstRun = !hasVoicePrefs() && !isTouchDevice();
  useEffect(() => { if (firstRun) navigate("/voice?first=1", { replace: true }); }, [firstRun, navigate]);
  const needsGesture = useAnnounce(t("welcomeSpeech"), speechLang, !firstRun);
  return (
    <Layout>
      <div className="text-center space-y-8 py-8">
        <div>
          <h1 className="text-3xl font-bold">{t("appName")}</h1>
          <p className="text-muted-foreground mt-2 text-lg">{t("tagline")}</p>
          {needsGesture && <p className="mt-3" role="status">{t("pressAnyKey")}</p>}
        </div>
        <div className="flex flex-col items-center gap-4 max-w-sm mx-auto">
          {/* ボタンは一つだけ。この端末のお店があれば開き、なければ新しく始める */}
          {owner ? (
            <Button size="lg" className="h-16 w-full text-xl" asChild><Link href="/admin" data-testid="link-admin">{t("startSimple")}</Link></Button>
          ) : (
            <>
              <Button size="lg" className="h-16 w-full text-xl" onClick={begin} disabled={busy} data-testid="button-start">{t("startSimple")}</Button>
              {error && <p role="alert" className="text-destructive">{error}</p>}
              <Button variant="link" asChild><Link href="/login" data-testid="link-login">{t("ownerLogin")}</Link></Button>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
