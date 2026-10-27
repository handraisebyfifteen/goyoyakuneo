import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { VoicePanel } from "@/components/VoicePanel";
import { ShareLink } from "@/components/ShareLink";
import { StaffCard } from "@/components/StaffCard";
import { GroupCard } from "@/components/GroupCard";
import { AttendanceCard } from "@/components/AttendanceCard";
import { MemoryCard } from "@/components/MemoryCard";
import { ApiKeyCard } from "@/components/ApiKeyCard";
import { BooksCard } from "@/components/BooksCard";
import { PayrollCard } from "@/components/PayrollCard";
import { TicketCard } from "@/components/TicketCard";
import { FollowupCard } from "@/components/FollowupCard";
import { BillingCard } from "@/components/BillingCard";
import { CardPayCard } from "@/components/CardPayCard";
import { PushCard } from "@/components/PushCard";
import { CouponCard } from "@/components/CouponCard";
import { ScanPanel } from "@/components/ScanPanel";
import { CanDoCard } from "@/components/CanDoCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { deviceKey, resumeShop } from "@/lib/device";
import type { Money } from "@shared/money";

type ReservationView = { id: number; number: string; date: string; time: string; endTime: string; customerName: string; menuName: string; staffName: string; nominated: boolean; minutes: number; price: Money | null; status: string; paymentMethod: string; paymentStatus: string };
type MenuView = { id: number; name: string; minutes: number; price: Money; active: boolean };
type Summary = { total: Money; cardTotal: Money; onsiteTotal: Money; ticketTotal: Money; waitingCount: number; waitingAmount: Money; cancelledCount: number; refundPendingCount: number; refundPendingAmount: Money; reservationCount: number; from: string; to: string };

const PAY_LABEL: Record<string, string> = { unpaid: "payUnpaid", paid: "payPaid", onsite_pending: "payOnsitePending", onsite_received: "payOnsiteReceived", refunded: "payRefunded", ticket: "payTicket" };

export default function Admin() {
  const { t, lang, setLang } = useI18n();
  const [, navigate] = useLocation();
  const { owner, isLoading } = useAuth();
  const shareRef = useRef<HTMLButtonElement>(null);
  const [calCopied, setCalCopied] = useState(false);

  // ログインが切れていても、この端末で始めたお店なら端末の鍵で入り直す
  const resumed = useRef(false);
  useEffect(() => {
    if (isLoading || owner) return;
    if (resumed.current || !deviceKey()) { navigate("/login"); return; }
    resumed.current = true;
    resumeShop().then((ok) => { if (!ok) navigate("/login"); }, () => navigate("/login"));
  }, [isLoading, owner, navigate]);
  useEffect(() => { if (owner) setLang(owner.language === "en" ? "en" : "ja"); }, [owner, setLang]);

  const today = useQuery<{ reservations: ReservationView[] }>({ queryKey: [`/api/owner/reservations?lang=${lang}`], enabled: !!owner });
  const menus = useQuery<{ menus: MenuView[] }>({ queryKey: [`/api/owner/menus?lang=${lang}`], enabled: !!owner });
  // 一人のお店にはいらないものは「お店を広げる・設定」にしまう。スタッフや回数券を使い始めたら表に出す
  const staffQ = useQuery<{ staff: { isOwner: boolean; active: boolean }[] }>({ queryKey: ["/api/owner/staff"], enabled: !!owner });
  const ticketsQ = useQuery<{ tickets: unknown[] }>({ queryKey: [`/api/owner/tickets?lang=${lang}`], enabled: !!owner });
  const hasStaff = !!staffQ.data?.staff.some((s) => !s.isOwner && s.active);
  const hasTickets = !!ticketsQ.data?.tickets.length;
  const couponsQ = useQuery<{ coupons: { usable: boolean }[] }>({ queryKey: [`/api/owner/coupons?lang=${lang}`], enabled: !!owner });
  const hasCoupons = !!couponsQ.data?.coupons.some((c) => c.usable);
  const [scanOpen, setScanOpen] = useState(false);
  const [growOpen, setGrowOpen] = useState(() => typeof window !== "undefined" && ["billing", "cardpay"].some((k) => new URLSearchParams(window.location.search).has(k)));
  // 画面はマイクボタンだけにして、予約・売り上げ・設定などは「その他」にしまう
  const [moreOpen, setMoreOpen] = useState(growOpen);
  const calendar = useQuery<{ path: string }>({ queryKey: ["/api/owner/calendar-link"], enabled: !!owner?.registered && growOpen });
  const summary = useQuery<Summary>({ queryKey: [`/api/owner/summary?lang=${lang}`], enabled: !!owner });

  if (!owner) return <Layout title={t("adminTitle")}><p>{t("loading")}</p></Layout>;
  const shopName = (lang === "ja" ? owner.shopNameJa || owner.shopNameEn : owner.shopNameEn || owner.shopNameJa) || t("appName");
  const bookingUrl = `${window.location.origin}/book/${owner.slug}`;

  // 「今できること」の「開く」：その欄の見出しへ移る。「お店を広げる・設定」の中なら開いてから（中の欄は開いてから読み込むものもあるので、出てくるまで待つ）
  function openSection(section: string) {
    if (section === "register") { navigate("/signup"); return; }
    let tries = 30;
    const go = () => {
      const h = document.querySelector<HTMLElement>(`[data-section="${section}"] h2`);
      if (!h || h.closest("details:not([open])")) { setMoreOpen(true); setGrowOpen(true); if (tries-- > 0) setTimeout(go, 100); return; }
      h.tabIndex = -1;
      h.scrollIntoView({ block: "start" });
      h.focus({ preventScroll: true });
    };
    go();
  }

  async function logout() {
    await apiRequest("POST", "/api/auth/logout");
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    navigate("/");
  }

  return (
    // 店名がまだなければ、ヘッダーのアプリ名と同じ見出しを二度出さない
    <Layout title={shopName === t("appName") ? undefined : shopName}>
      {shopName === t("appName") && <h1 className="sr-only">{t("adminTitle")}</h1>}
      <div>
        <VoicePanel onRegister={() => navigate("/signup")} onShareLink={() => { setMoreOpen(true); setTimeout(() => { shareRef.current?.scrollIntoView({ block: "center" }); shareRef.current?.focus(); }, 0); }} onChanged={() => { queryClient.invalidateQueries({ queryKey: [`/api/owner/reservations?lang=${lang}`] }); queryClient.invalidateQueries({ queryKey: [`/api/owner/menus?lang=${lang}`] }); queryClient.invalidateQueries({ queryKey: [`/api/owner/summary?lang=${lang}`] }); queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }); queryClient.invalidateQueries({ queryKey: ["/api/owner/memories"] }); ["/api/owner/staff", "/api/owner/payroll", `/api/owner/expenses?lang=${lang}`, `/api/owner/tickets?lang=${lang}`, `/api/owner/attendance?lang=${lang}`].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] })); }} />
      </div>

      <details className="mt-4 rounded-xl border-2 bg-card p-4" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)} data-testid="details-more">
      <summary className="cursor-pointer text-lg font-bold">{t("moreTitle")}</summary>
      <div className="mt-4">
      {/* 登録前は、この端末だけに保存されていることと、登録の入口を出す（ログアウトは出さない。出ると戻れなくなる） */}
      {!owner.registered && (
        <Card className="mb-6 border-primary" data-testid="card-register">
          <CardHeader><CardTitle>{t("guestTitle")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p>{t("guestHint")}</p>
            <Button asChild><Link href="/signup" data-testid="link-register">{t("registerShop")}</Link></Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <Card className="sm:col-span-2" data-section="today">
          <CardHeader><CardTitle>{t("todayReservations")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/* お会計で、お客さんの回数券・クーポンの QR を読み取る（どちらかを使い始めたら出す） */}
            {(hasTickets || hasCoupons) && (scanOpen
              ? <ScanPanel onDone={() => setScanOpen(false)} />
              : <Button variant="outline" onClick={() => setScanOpen(true)} data-testid="button-scan">{t("scanButton")}</Button>)}
            {today.data?.reservations.length ? (
              <ul className="divide-y">
                {today.data.reservations.map((r) => (
                  <li key={r.id} className="py-3 flex flex-wrap justify-between gap-2" data-testid={`row-reservation-${r.id}`}>
                    <div><span className="font-bold text-lg">{r.time}</span> – {r.endTime} <span className="ml-2 font-semibold">{r.customerName}</span>{r.menuName && <span className="text-muted-foreground"> ({r.menuName})</span>}{r.staffName && <span className="ml-2 text-sm">{t("staffLabel")}: {r.staffName}{r.nominated ? t("nominatedMark") : ""}</span>}</div>
                    <div className="text-sm">{[r.price?.display, t(PAY_LABEL[r.paymentStatus] ?? r.paymentStatus)].filter(Boolean).join(" · ")}</div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-muted-foreground">{today.isLoading ? t("loading") : t("noReservations")}</p>}
          </CardContent>
        </Card>

        <CanDoCard onOpen={openSection} />

        <Card data-section="sales">
          <CardHeader><CardTitle>{t("thisMonthSales")}</CardTitle></CardHeader>
          <CardContent>
            {summary.data ? (
              <dl className="space-y-1">
                <div className="flex justify-between"><dt>{t("total")}</dt><dd className="font-bold text-xl" data-testid="text-sales-total">{summary.data.total.display}</dd></div>
                <div className="flex justify-between"><dt>{t("card")}</dt><dd>{summary.data.cardTotal.display}</dd></div>
                <div className="flex justify-between"><dt>{t("onsite")}</dt><dd>{summary.data.onsiteTotal.display}</dd></div>
                {summary.data.ticketTotal?.amount > 0 && <div className="flex justify-between"><dt>{t("ticketSales")}</dt><dd>{summary.data.ticketTotal.display}</dd></div>}
                <div className="flex justify-between"><dt>{t("waiting")}</dt><dd>{t("count", { n: summary.data.waitingCount })} · {summary.data.waitingAmount.display}</dd></div>
                <div className="flex justify-between"><dt>{t("cancelled")}</dt><dd>{t("count", { n: summary.data.cancelledCount })}</dd></div>
                {summary.data.refundPendingCount > 0 && <div className="flex justify-between"><dt>{t("refundPending")}</dt><dd>{t("count", { n: summary.data.refundPendingCount })} · {summary.data.refundPendingAmount.display}</dd></div>}
              </dl>
            ) : <p className="text-muted-foreground">{t("loading")}</p>}
          </CardContent>
        </Card>

        <Card data-section="menus">
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

        <Card className="sm:col-span-2" data-section="share">
          <CardHeader><CardTitle>{t("bookingLink")}</CardTitle></CardHeader>
          <CardContent>
            {owner.registered ? <ShareLink ref={shareRef} url={bookingUrl} shopName={shopName} /> : <p className="text-muted-foreground">{t("bookingLinkAfterRegister")}</p>}
          </CardContent>
        </Card>

        <div className="contents" data-section="books"><BooksCard today={owner ? new Date().toLocaleDateString("sv-SE", { timeZone: owner.timezone }) : ""} hasStaff={hasStaff} /></div>

        {hasStaff && (
          <>
            <div className="contents" data-section="staff"><StaffCard menus={menus.data?.menus ?? []} allowNomination={owner.allowNomination} currency={owner.currency} /></div>
            <AttendanceCard owner={owner} />
            <PayrollCard />
          </>
        )}
        {hasTickets && <div className="contents" data-section="tickets"><TicketCard menus={menus.data?.menus ?? []} /></div>}
        {hasCoupons && <div className="contents" data-section="coupons"><CouponCard /></div>}
      </div>

      <details className="mt-6 rounded-xl border-2 bg-card p-4" open={growOpen} onToggle={(e) => setGrowOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-lg font-bold">{t("growTitle")}</summary>
        <p className="mt-2 text-sm text-muted-foreground">{t("growHint")}</p>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
        {!owner.registered && <p className="sm:col-span-2" data-testid="text-guest-grow">{t("guestGrowHint")}</p>}
        <PushCard owner={owner} />
        <CardPayCard owner={owner} />
        {owner.registered && !hasStaff && <div className="contents" data-section="staff"><StaffCard menus={menus.data?.menus ?? []} allowNomination={owner.allowNomination} currency={owner.currency} /></div>}
        {!hasTickets && <div className="contents" data-section="tickets"><TicketCard menus={menus.data?.menus ?? []} /></div>}
        {!hasCoupons && <div className="contents" data-section="coupons"><CouponCard /></div>}
        {owner.registered && <div className="contents" data-section="followup"><FollowupCard days={owner.followupAfterDays} /></div>}
        <div className="contents" data-section="memory"><MemoryCard /></div>
        {owner.registered && (
          <>
            <div className="contents" data-section="group"><GroupCard /></div>
            <div className="contents" data-section="api"><ApiKeyCard /></div>
            <BillingCard />
          </>
        )}

        {calendar.data && (
          <Card className="sm:col-span-2" data-section="calendar">
            <CardHeader><CardTitle>{t("calendarTitle")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("calendarHint")}</p>
              <p className="break-all text-sm" data-testid="text-calendar-url">{window.location.origin + calendar.data.path}</p>
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(window.location.origin + calendar.data!.path).then(() => { setCalCopied(true); setTimeout(() => setCalCopied(false), 2000); })} data-testid="button-copy-calendar">{calCopied ? t("copied") : t("copyUrl")}</Button>
                <span role="status" className="sr-only">{calCopied ? t("copied") : ""}</span>
                <Button variant="outline" asChild><a href={`webcal://${window.location.host}${calendar.data.path}`}>{t("calendarIphone")}</a></Button>
              </div>
            </CardContent>
          </Card>
        )}
        </div>
      </details>
      {owner.registered && <p className="mt-4"><Button variant="outline" onClick={logout} data-testid="button-logout">{t("logout")}</Button></p>}
      </div>
      </details>
    </Layout>
  );
}
