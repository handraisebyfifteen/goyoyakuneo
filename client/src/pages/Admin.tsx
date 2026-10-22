import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { VoicePanel } from "@/components/VoicePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Money } from "@shared/money";

type ReservationView = { id: number; number: string; date: string; time: string; endTime: string; customerName: string; menuName: string; minutes: number; price: Money; status: string; paymentMethod: string; paymentStatus: string };
type MenuView = { id: number; name: string; minutes: number; price: Money; active: boolean };
type Summary = { total: Money; cardTotal: Money; onsiteTotal: Money; waitingCount: number; waitingAmount: Money; cancelledCount: number; refundPendingCount: number; refundPendingAmount: Money; reservationCount: number; from: string; to: string };

const PAY_LABEL: Record<string, string> = { unpaid: "payUnpaid", paid: "payPaid", onsite_pending: "payOnsitePending", onsite_received: "payOnsiteReceived", refunded: "payRefunded" };

export default function Admin() {
  const { t, lang, setLang } = useI18n();
  const [, navigate] = useLocation();
  const { owner, isLoading } = useAuth();
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (!isLoading && !owner) navigate("/login"); }, [isLoading, owner, navigate]);
  useEffect(() => { if (owner && !owner.onboardingDone) navigate("/setup"); }, [owner, navigate]);
  useEffect(() => { if (owner) setLang(owner.language === "en" ? "en" : "ja"); }, [owner, setLang]);

  const today = useQuery<{ reservations: ReservationView[] }>({ queryKey: [`/api/owner/reservations?lang=${lang}`], enabled: !!owner });
  const menus = useQuery<{ menus: MenuView[] }>({ queryKey: [`/api/owner/menus?lang=${lang}`], enabled: !!owner });
  const summary = useQuery<Summary>({ queryKey: [`/api/owner/summary?lang=${lang}`], enabled: !!owner });

  if (!owner) return <Layout title={t("adminTitle")}><p>{t("loading")}</p></Layout>;
  const shopName = (lang === "ja" ? owner.shopNameJa || owner.shopNameEn : owner.shopNameEn || owner.shopNameJa) || t("appName");
  const bookingUrl = `${window.location.origin}/book/${owner.slug}`;

  async function logout() {
    await apiRequest("POST", "/api/auth/logout");
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    navigate("/");
  }

  return (
    <Layout title={shopName} right={<Button variant="ghost" size="sm" onClick={logout} data-testid="button-logout">{t("logout")}</Button>}>
      <div className="mb-6">
        <VoicePanel onChanged={() => { queryClient.invalidateQueries({ queryKey: [`/api/owner/reservations?lang=${lang}`] }); queryClient.invalidateQueries({ queryKey: [`/api/owner/menus?lang=${lang}`] }); queryClient.invalidateQueries({ queryKey: [`/api/owner/summary?lang=${lang}`] }); queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }); }} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card className="sm:col-span-2">
          <CardHeader><CardTitle>{t("todayReservations")}</CardTitle></CardHeader>
          <CardContent>
            {today.data?.reservations.length ? (
              <ul className="divide-y">
                {today.data.reservations.map((r) => (
                  <li key={r.id} className="py-3 flex flex-wrap justify-between gap-2" data-testid={`row-reservation-${r.id}`}>
                    <div><span className="font-bold text-lg">{r.time}</span> – {r.endTime} <span className="ml-2 font-semibold">{r.customerName}</span> <span className="text-muted-foreground">({r.menuName})</span></div>
                    <div className="text-sm">{r.price.display} · {t(PAY_LABEL[r.paymentStatus] ?? r.paymentStatus)}</div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-muted-foreground">{today.isLoading ? t("loading") : t("noReservations")}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("thisMonthSales")}</CardTitle></CardHeader>
          <CardContent>
            {summary.data ? (
              <dl className="space-y-1">
                <div className="flex justify-between"><dt>{t("total")}</dt><dd className="font-bold text-xl" data-testid="text-sales-total">{summary.data.total.display}</dd></div>
                <div className="flex justify-between"><dt>{t("card")}</dt><dd>{summary.data.cardTotal.display}</dd></div>
                <div className="flex justify-between"><dt>{t("onsite")}</dt><dd>{summary.data.onsiteTotal.display}</dd></div>
                <div className="flex justify-between"><dt>{t("waiting")}</dt><dd>{t("count", { n: summary.data.waitingCount })} · {summary.data.waitingAmount.display}</dd></div>
                <div className="flex justify-between"><dt>{t("cancelled")}</dt><dd>{t("count", { n: summary.data.cancelledCount })}</dd></div>
                {summary.data.refundPendingCount > 0 && <div className="flex justify-between"><dt>{t("refundPending")}</dt><dd>{t("count", { n: summary.data.refundPendingCount })} · {summary.data.refundPendingAmount.display}</dd></div>}
              </dl>
            ) : <p className="text-muted-foreground">{t("loading")}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("menus")}</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {menus.data?.menus.filter((m) => m.active).map((m) => (
                <li key={m.id} className="flex justify-between"><span>{m.name} · {t("minutesUnit", { n: m.minutes })}</span><span className="font-semibold">{m.price.display}</span></li>
              ))}
            </ul>
            <p className="mt-3"><Button variant="outline" size="sm" asChild><Link href="/setup">{t("settings")}</Link></Button></p>
          </CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardHeader><CardTitle>{t("bookingLink")}</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <a href={bookingUrl} className="underline break-all" data-testid="link-booking-page">{bookingUrl}</a>
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(bookingUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}>{copied ? t("copied") : t("copyLink")}</Button>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
