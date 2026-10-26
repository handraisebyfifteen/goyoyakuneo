/**
 * 「ご利用料金」。基本料金＋ログインできるスタッフの人数分。契約の手続きとカードの変更・解約は Stripe の画面で。
 * 料金の設定（Stripe の価格）がなければ「準備中」と人数だけを見せる。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";
import type { Money } from "@shared/money";

type Billing = { configured: boolean; status: string | null; seats: number; staffSeats: number; base: Money | null; perSeat: Money | null; estimate: Money | null };

export function BillingCard() {
  const { t, lang } = useI18n();
  // Stripe の画面から戻ってきたら、契約の状態を Stripe に聞き直す
  const back = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("billing") === "success";
  const q = useQuery<Billing>({ queryKey: [`/api/owner/billing?lang=${lang}${back ? "&refresh=1" : ""}`] });
  const [error, setError] = useState("");
  useEffect(() => { if (back) document.getElementById("billing-card")?.scrollIntoView(); }, [back]);
  const go = async (path: string) => {
    setError("");
    try { window.location.href = (await apiRequest<{ url: string }>("POST", path)).url; }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : t("error")); }
  };
  const b = q.data;
  const live = b?.status === "active" || b?.status === "trialing" || b?.status === "past_due";
  const statusText = !b?.status ? t("billingNone") : b.status === "active" || b.status === "trialing" ? t("billingActive") : b.status === "past_due" ? t("billingPastDue") : b.status === "canceled" ? t("billingCanceled") : b.status;
  return (
    <Card className="sm:col-span-2" id="billing-card">
      <CardHeader><CardTitle>{t("billingTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {!b ? <p>{t("loading")}</p> : (
          <>
            <p data-testid="text-billing-seats">{t("billingSeats", { n: b.seats, staff: b.staffSeats })}</p>
            {!b.configured ? <p className="text-muted-foreground">{t("billingNotReady")}</p> : (
              <>
                {b.estimate && b.base && <p className="font-semibold">{t("billingEstimate", { total: b.estimate.display, base: b.base.display, staff: b.staffSeats, seat: b.perSeat?.display ?? "-" })}</p>}
                <p>{t("billingStatus", { status: statusText })}</p>
                {live
                  ? <Button variant="outline" onClick={() => go("/api/owner/billing/portal")}>{t("billingManage")}</Button>
                  : <Button onClick={() => go("/api/owner/billing/checkout")} data-testid="button-billing-start">{t("billingStart")}</Button>}
              </>
            )}
          </>
        )}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
