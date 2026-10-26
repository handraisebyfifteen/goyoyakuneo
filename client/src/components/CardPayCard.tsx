/**
 * 「カード払い」。入金先（お店の Stripe アカウント）の登録と、ネットのカード払いの決まり。
 * - 登録の前に、何が要るか・どれくらいかかるか・手数料・流れを先に見せる（Stripe の画面に移る前に心づもりができるように）
 * - 登録の途中・確認中・止まっているときは、今どこにいて次に何をすればいいかを1文で伝える
 * - Stripe の画面から戻ってきたら、この欄の見出しへ移り、今の状態を読み上げてもらう
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import { DEFAULT_NOTICE, type PublicOwner } from "@shared/schema";

type CardState = "off" | "unregistered" | "none" | "incomplete" | "reviewing" | "ready" | "restricted";
type CardPay = { state: CardState; due: number; holdMinutes: number; allowCardPayment: boolean; cardMinHoursBefore: number; minHoursBefore: number; paymentEmail: boolean; dashboardUrl: string | null };

const CUTOFFS = [24, 48, 12, 3, 0];
const STATE_TEXT: Record<CardState, string> = {
  off: "cardpayStateOff", unregistered: "cardpayStateUnregistered", none: "cardpayIntro", incomplete: "cardpayStateIncomplete",
  reviewing: "cardpayStateReviewing", ready: "cardpayStateReady", restricted: "cardpayStateRestricted",
};

export function CardPayCard({ owner }: { owner: PublicOwner }) {
  const { t } = useI18n();
  const param = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("cardpay") : null;
  const q = useQuery<CardPay>({ queryKey: ["/api/owner/cardpay"] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function start() {
    setBusy(true); setError(""); setStatus(t("cardpayLeaving"));
    try { window.location.href = (await apiRequest<{ url: string }>("POST", "/api/owner/cardpay/start")).url; }
    catch (e) { setStatus(""); setError(e instanceof ApiRequestError ? e.message : t("error")); setBusy(false); }
  }

  // Stripe の画面から戻ってきたら、この欄へ移って状態を伝える。リンクの期限が切れて戻ってきたら、そのまま続きへ
  useEffect(() => {
    if (!param) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (param === "refresh") { void start(); return; }
    setStatus(t("cardpayBack"));
    const h = headingRef.current;
    if (h) { h.scrollIntoView({ block: "start" }); h.focus({ preventScroll: true }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setting = async (body: Record<string, unknown>) => {
    setError(""); setStatus("");
    try {
      await apiRequest("PATCH", "/api/owner/settings", body);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["/api/owner/cardpay"] }), queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] })]);
      setStatus(t("saved"));
    } catch (e) { setError(e instanceof ApiRequestError ? e.message : t("error")); }
  };

  const d = q.data;
  const notice = owner.noticePrefs ?? DEFAULT_NOTICE;
  const selectCls = "flex min-h-11 w-full rounded-md border-2 border-input bg-card px-3 py-2";
  const usable = d && (d.state === "ready" || d.state === "off");
  const resumable = d && (d.state === "incomplete" || d.state === "restricted");

  return (
    <Card className="sm:col-span-2" data-section="cardpay">
      <CardHeader><CardTitle ref={headingRef} tabIndex={-1}>{t("cardpayTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {!d ? <p>{q.isError ? t("error") : t("loading")}</p> : (
          <>
            <p className="font-semibold" data-testid="text-cardpay-state">{t(STATE_TEXT[d.state], { n: d.due })}</p>

            {d.state === "unregistered" && <Button asChild><Link href="/signup">{t("registerShop")}</Link></Button>}

            {d.state === "none" && (
              <>
                <section aria-labelledby="cardpay-need">
                  <h3 id="cardpay-need" className="font-bold">{t("cardpayNeedTitle")}</h3>
                  <ul className="list-disc pl-6">{t("cardpayNeed").split("|").map((x) => <li key={x}>{x}</li>)}</ul>
                  <p className="mt-1">{t("cardpayTime")}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t("cardpayFee")}</p>
                </section>
                <section aria-labelledby="cardpay-steps">
                  <h3 id="cardpay-steps" className="font-bold">{t("cardpayStepsTitle")}</h3>
                  <ol className="list-decimal pl-6">{t("cardpaySteps").split("|").map((x) => <li key={x}>{x}</li>)}</ol>
                </section>
                <Button size="lg" onClick={start} disabled={busy} data-testid="button-cardpay-start">{t("cardpayStart")}</Button>
              </>
            )}

            {resumable && <Button size="lg" onClick={start} disabled={busy} data-testid="button-cardpay-continue">{t("cardpayContinue")}</Button>}
            {d.state === "reviewing" && <Button variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/owner/cardpay"] })}>{t("cardpayRecheck")}</Button>}

            {usable && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-3 min-h-11 sm:col-span-2">
                  <input type="checkbox" className="h-5 w-5" checked={d.allowCardPayment} onChange={(e) => setting({ allowCardPayment: e.target.checked })} data-testid="checkbox-cardpay-accept" />
                  <span>{t("cardpayAccept")}</span>
                </label>
                <div className="sm:col-span-2">
                  <Label htmlFor="cardpay-cutoff">{t("cardpayCutoff")}</Label>
                  <select id="cardpay-cutoff" className={selectCls} value={d.cardMinHoursBefore} onChange={(e) => setting({ cardMinHoursBefore: Number(e.target.value) })} aria-describedby="cardpay-cutoff-hint" data-testid="select-cardpay-cutoff">
                    {(CUTOFFS.includes(d.cardMinHoursBefore) ? CUTOFFS : [...CUTOFFS, d.cardMinHoursBefore]).map((n) => (
                      <option key={n} value={n}>{n === 24 ? t("cardpayCutoffRec") : n === 0 ? t("cardpayCutoffSameDay", { n: d.minHoursBefore }) : t("cardpayCutoffOpt", { n })}</option>
                    ))}
                  </select>
                  <p id="cardpay-cutoff-hint" className="mt-1 text-sm text-muted-foreground">{t("cardpayCutoffHint", { min: d.holdMinutes })}</p>
                </div>
                <label className="flex items-center gap-3 min-h-11 sm:col-span-2">
                  <input type="checkbox" className="h-5 w-5" checked={notice.paymentEmail ?? true} onChange={(e) => setting({ noticePrefs: { ...notice, paymentEmail: e.target.checked } })} data-testid="checkbox-cardpay-email" />
                  <span>{t("cardpayEmail")}</span>
                </label>
                <p className="text-sm text-muted-foreground sm:col-span-2">{t("cardpayLiveHint")}</p>
              </div>
            )}

            {d.dashboardUrl && d.state !== "none" && (
              <p><a className="underline underline-offset-4" href={d.dashboardUrl} target="_blank" rel="noreferrer">{t("cardpayDashboard")}</a></p>
            )}
          </>
        )}
        <p role="status" className="text-sm" data-testid="text-cardpay-status">{status}</p>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
