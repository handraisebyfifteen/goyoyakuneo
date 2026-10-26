import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { VoiceConversation, type Step } from "@/components/VoiceConversation";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { voiceConversationUsable } from "@/lib/speech";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { forgetDeviceKey } from "@/lib/device";

export default function Signup() {
  const { t, lang } = useI18n();
  const [, navigate] = useLocation();
  // 登録なしで使っていたお店なら、そのお店に登録する（サーバーが同じお店に引き継ぐ）
  const { owner, isLoading } = useAuth();
  const upgrading = !!owner && !owner.registered;
  const [mode, setMode] = useState<"voice" | "form">(() => (voiceConversationUsable() ? "voice" : "form"));

  const steps = useMemo<Step[]>(() => [
    { key: "shopName", prompt: t("askShopName"), label: t("shopName"), type: "text" },
    { key: "email", prompt: t("askEmail"), label: t("email"), type: "email", autoComplete: "username" },
    { key: "loginMethod", prompt: t("askLoginMethod"), label: t("loginMethod"), type: "choice", choices: [
      { value: "passphrase", label: t("loginPassphrase"), aliases: ["合言葉", "あいことば", "passphrase", "phrase"] },
      { value: "password", label: t("loginPassword"), aliases: ["パスワード", "password"] },
      { value: "both", label: t("loginBoth"), aliases: ["両方", "りょうほう", "both", "どちらも"] },
    ] },
    { key: "passphrase", prompt: t("askPassphrase"), label: t("passphrase"), type: "secret", when: (v) => v.loginMethod !== "password",
      validate: (v) => v.replace(/[\s、。，．,.!?！？・ー\-_]/g, "").length >= 4 ? null : (lang === "ja" ? "合言葉は4文字以上にしてください" : "At least 4 characters, please.") },
    { key: "passphrase2", prompt: t("askPassphraseAgain"), label: `${t("passphrase")} (2)`, type: "secret", when: (v) => v.loginMethod !== "password" },
    { key: "password", prompt: t("askPassword"), label: t("password"), type: "secret", when: (v) => v.loginMethod !== "passphrase",
      validate: (v) => v.length >= 8 ? null : (lang === "ja" ? "パスワードは8文字以上にしてください" : "At least 8 characters, please.") },
  ], [t, lang]);

  async function complete(v: Record<string, string>) {
    const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s、。，．,.!?！？・ー\-_]/g, "");
    if (v.loginMethod !== "password" && norm(v.passphrase) !== norm(v.passphrase2)) return t("passphraseMismatch");
    try {
      await apiRequest("POST", "/api/auth/signup", {
        shopName: v.shopName, email: v.email, loginMethod: v.loginMethod, language: lang,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        passphrase: v.loginMethod !== "password" ? v.passphrase : undefined,
        password: v.loginMethod !== "passphrase" ? v.password : undefined,
      });
      // 登録したら、端末の鍵はもういらない（これからはメールと合言葉・パスワードで入る）
      forgetDeviceKey();
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      // 設定の画面には寄らず、すぐ使い始める。必要な設定はパートナー（声のパネル）が少しずつ聞く
      navigate("/admin");
    } catch (e) {
      return e instanceof ApiRequestError ? e.message : t("error");
    }
  }

  return (
    <Layout title={upgrading ? t("registerShop") : t("signupTitle")}>
      {isLoading ? <p>{t("loading")}</p> : <VoiceConversation key={upgrading ? "upgrade" : "new"} steps={steps} intro={upgrading ? t("registerSpeech") : t("signupSpeech")} mode={mode} onModeChange={setMode} onComplete={complete} submitLabel={upgrading ? t("registerShop") : t("ownerSignup")} />}
      <p className="mt-6"><Button variant="link" asChild><Link href="/login">{t("haveAccount")}</Link></Button></p>
    </Layout>
  );
}
