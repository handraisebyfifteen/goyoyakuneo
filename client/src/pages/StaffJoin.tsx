/**
 * スタッフへの招待のリンクから開く画面。本人がパスワードを決めて、そのままスタッフの画面へ。
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";

export default function StaffJoin() {
  const { t, lang } = useI18n();
  const [, navigate] = useLocation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const info = useQuery<{ name: string; email: string | null; shopName: string }>({ queryKey: [`/api/staff/invite?token=${encodeURIComponent(token)}&lang=${lang}`], retry: false });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await apiRequest("POST", "/api/staff/join", { token, password, lang }); navigate("/staff"); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
    finally { setBusy(false); }
  }

  return (
    <Layout title={t("joinTitle")}>
      {info.error ? <p role="alert" className="text-destructive font-semibold">{info.error instanceof ApiRequestError ? info.error.message : t("error")}</p>
        : !info.data ? <p>{t("loading")}</p> : (
        <form onSubmit={join} className="max-w-md space-y-4">
          <p>{t("joinIntro", { shop: info.data.shopName, name: info.data.name })}</p>
          {/* パスワードの保存で、メールアドレスと組にしてもらうため */}
          <input type="email" autoComplete="username" value={info.data.email ?? ""} readOnly hidden />
          <div>
            <Label htmlFor="new-password">{t("password")}（{t("passwordHint")}）</Label>
            <Input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-staff-password" />
          </div>
          {error && <p role="alert" className="text-destructive font-semibold">{error}</p>}
          <Button type="submit" size="lg" disabled={busy} data-testid="button-staff-join">{t("joinButton")}</Button>
        </form>
      )}
    </Layout>
  );
}
