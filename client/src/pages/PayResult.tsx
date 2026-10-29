/**
 * Stripe Checkout から戻ってきたページ。支払い済みかをサーバー経由で確かめて、声と画面で伝える。
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { useAnnounce } from "@/hooks/useAnnounce";
import { apiRequest } from "@/lib/queryClient";
import type { Money } from "@shared/money";

type Confirm = { paid: boolean; reservation: { number: string; date: string; time: string; menuName: string; price: Money }; shopName: string };

export default function PayResult() {
  const { t, lang, speechLang } = useI18n();
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const sessionId = params.get("session_id");
  const [state, setState] = useState<"checking" | "paid" | "pending" | "cancelled" | "error">(status === "cancel" ? "cancelled" : "checking");
  const [info, setInfo] = useState<Confirm | null>(null);

  useEffect(() => {
    if (status !== "success" || !sessionId) { if (status !== "cancel") setState("error"); return; }
    let cancelled = false;
    apiRequest<Confirm>("GET", `/api/public/pay/confirm?session_id=${encodeURIComponent(sessionId)}&lang=${lang}`)
      .then((r) => { if (cancelled) return; setInfo(r); setState(r.paid ? "paid" : "pending"); })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [status, sessionId, lang]);

  const message = state === "checking" ? t("payChecking") : state === "paid" ? t("paySuccess") : state === "pending" ? t("payPending") : state === "cancelled" ? t("payCancelled") : t("error");
  const needsGesture = useAnnounce(state === "checking" ? "" : message, speechLang);

  return (
    <Layout forCustomers title={t("payResultTitle")}>
      <section aria-live="polite" className="space-y-4">
        <p className="text-xl font-semibold" role="status" data-testid="text-pay-result">{message}</p>
        {state === "paid" && <p className="text-sm text-muted-foreground">{t("payReceiptNote")}</p>}
        {info && (
          <p>
            {t("bookingNumber")}: <strong className="text-2xl tracking-widest" data-testid="text-booking-number">{info.reservation.number}</strong>
            <span className="block">{info.reservation.date} {info.reservation.time} · {info.reservation.menuName} · {info.reservation.price.display}</span>
          </p>
        )}
        {needsGesture && <p className="text-sm">{t("pressAnyKey")}</p>}
        <p><Button asChild size="lg"><Link href="/lookup">{t("customerLookup")}</Link></Button></p>
      </section>
    </Layout>
  );
}
