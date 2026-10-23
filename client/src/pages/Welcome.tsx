import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useAuth } from "@/hooks/useAuth";
import { hasVoicePrefs } from "@/lib/speech";

export default function Welcome() {
  const { t, speechLang } = useI18n();
  const { owner } = useAuth();
  const [, navigate] = useLocation();
  // 初めて開いた人は、まず声の設定へ（声で進められる）
  const firstRun = !hasVoicePrefs();
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
        <div className="flex flex-col gap-4 max-w-sm mx-auto">
          {owner ? (
            <Button size="lg" asChild><Link href="/admin" data-testid="link-admin">{t("adminTitle")}</Link></Button>
          ) : (
            <>
              <Button size="lg" asChild><Link href="/login" data-testid="link-login">{t("ownerLogin")}</Link></Button>
              <Button size="lg" variant="outline" asChild><Link href="/signup" data-testid="link-signup">{t("ownerSignup")}</Link></Button>
            </>
          )}
          <Button size="lg" variant="secondary" asChild><Link href="/lookup" data-testid="link-lookup">{t("customerLookup")}</Link></Button>
        </div>
      </div>
    </Layout>
  );
}
