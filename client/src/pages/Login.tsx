import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { VoiceConversation, type Step } from "@/components/VoiceConversation";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import type { PublicOwner } from "@shared/schema";

export default function Login() {
  const { t, setLang } = useI18n();
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<"voice" | "form">("voice");
  const steps = useMemo<Step[]>(() => [
    { key: "email", prompt: t("askEmail"), label: t("email"), type: "email" },
    { key: "secret", prompt: t("askSecret"), label: t("secret"), type: "secret" },
  ], [t]);

  async function complete(v: Record<string, string>) {
    try {
      const res = await apiRequest<{ owner: PublicOwner }>("POST", "/api/auth/login", { email: v.email, secret: v.secret });
      setLang(res.owner.language === "en" ? "en" : "ja");
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate(res.owner.onboardingDone ? "/admin" : "/setup");
    } catch (e) {
      return e instanceof ApiRequestError ? e.message : t("error");
    }
  }

  return (
    <Layout title={t("loginTitle")}>
      <VoiceConversation steps={steps} intro={t("loginSpeech")} mode={mode} onModeChange={setMode} onComplete={complete} submitLabel={t("ownerLogin")} />
      <p className="mt-6"><Button variant="link" asChild><Link href="/signup">{t("noAccount")}</Link></Button></p>
    </Layout>
  );
}
