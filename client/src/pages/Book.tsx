/**
 * お客さんの予約ページ：1画面に1つの質問、スマホで片手で押せる大きなボタン。
 * メニュー → 日付 → 時間 → 名前・電話・メール → 支払い方法 → 確認 → 完了
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";
import type { Money } from "@shared/money";
import type { BusinessHours } from "@shared/schema";

type Shop = { slug: string; name: string; address: string; phone: string; info: string; currency: string; hours: BusinessHours; allowCardPayment: boolean; cardMinHoursBefore: number; cardHoldMinutes: number; cancelPolicy: string; today: string; lastDate: string; language: string };
type MenuView = { id: number; name: string; description: string; minutes: number; price: Money };
type Created = { reservation: { number: string; date: string; time: string; menuName: string; price: Money; paymentUrl: string | null; paymentMethod: string }; paymentNote: string | null; emailNote?: string; shopName: string };

const ALL_STEPS = ["menu", "staff", "date", "time", "details", "payment", "confirm", "done"] as const;
type StepKey = (typeof ALL_STEPS)[number];
type StaffChoice = { id: number; name: string; menuIds: number[] | null };
const WD = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export default function Book({ slug }: { slug: string }) {
  const { t, lang } = useI18n();
  const [step, setStep] = useState<StepKey>("menu");
  const [menu, setMenu] = useState<MenuView | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [page, setPage] = useState(0);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [payment, setPayment] = useState<"card" | "onsite">("onsite");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [staffId, setStaffId] = useState<number | undefined>(undefined);
  // クーポンの QR（予約ページのリンク ?coupon=コード）から来たら、コードを入れておく
  const [couponInput, setCouponInput] = useState(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("coupon") ?? "" : ""));
  const [coupon, setCoupon] = useState<{ code: string; discount: Money; price: Money } | null>(null);
  const [couponError, setCouponError] = useState("");

  async function applyCoupon(e?: React.FormEvent) {
    e?.preventDefault();
    if (!menu || !couponInput.trim()) return;
    setCouponError("");
    try { setCoupon(await apiRequest<{ code: string; discount: Money; price: Money }>("GET", `/api/public/shop/${slug}/coupon?menuId=${menu.id}&code=${encodeURIComponent(couponInput)}&lang=${lang}`)); }
    catch (err) { setCoupon(null); setCouponError(err instanceof ApiRequestError ? err.message : t("error")); }
  }

  const shopQ = useQuery<{ shop: Shop; menus: MenuView[]; staff: StaffChoice[] }>({ queryKey: [`/api/public/shop/${slug}?lang=${lang}`] });
  const slotsQ = useQuery<{ slots: string[]; cardSlots?: string[]; closed: boolean }>({ queryKey: [`/api/public/shop/${slug}/slots?menuId=${menu?.id}&date=${date}&lang=${lang}${staffId ? `&staffId=${staffId}` : ""}`], enabled: !!menu && !!date });
  const shop = shopQ.data?.shop;
  const weekdays = t("weekdayShort").split(",");

  // カード払いは、店が受け付けていて、来店の締め切り（初期値24時間前）より先の時間だけ
  const cardOk = !!shop?.allowCardPayment && !!slotsQ.data?.cardSlots?.includes(time);
  useEffect(() => { if (!cardOk) setPayment("onsite"); }, [cardOk]);
  // メニューを選び直したら、クーポンの額は計算し直してもらう
  useEffect(() => { setCoupon(null); setCouponError(""); }, [menu]);
  // QR から来たクーポンは、確認の画面で自動で当てる
  useEffect(() => { if (step === "confirm" && menu && couponInput && !coupon && !couponError) void applyCoupon(); }, [step, menu]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.getElementById("main")?.focus(); }, [step]);

  const dates = useMemo(() => {
    if (!shop) return [];
    const out: { date: string; closed: boolean }[] = [];
    for (let i = page * 14; i < (page + 1) * 14; i++) {
      const d = addDays(shop.today, i);
      if (d > shop.lastDate) break;
      out.push({ date: d, closed: !shop.hours[WD[weekdayIndex(d)]] });
    }
    return out;
  }, [shop, page]);

  if (shopQ.isError) return <Layout forCustomers title={t("bookTitle")}><p role="alert">{t("error")}</p></Layout>;
  if (!shop) return <Layout forCustomers title={t("bookTitle")}><p>{t("loading")}</p></Layout>;

  // 指名できるスタッフ（そのコースを受けられる人）がいるときだけ「担当を選ぶ」を挟む
  const nominable = (shopQ.data?.staff ?? []).filter((s) => !menu || !s.menuIds || s.menuIds.includes(menu.id));
  const STEPS = ALL_STEPS.filter((k) => k !== "staff" || nominable.length > 0);
  const stepIndex = STEPS.indexOf(step);
  const back = () => setStep(STEPS[Math.max(0, stepIndex - 1)]);
  const fmtDate = (d: string) => `${d} (${weekdays[weekdayIndex(d)]})`;

  async function submit() {
    if (!menu) return;
    setBusy(true); setError("");
    try {
      const res = await apiRequest<Created>("POST", `/api/public/shop/${slug}/reservations`, { menuId: menu.id, date, time, name, phone, email: email || undefined, paymentMethod: payment, couponCode: coupon?.code, staffId, lang });
      setCreated(res);
      setStep("done");
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : t("error"));
    } finally { setBusy(false); }
  }

  return (
    <Layout forCustomers title={shop.name}>
      <div className="max-w-md mx-auto space-y-5">
        <p className="text-sm text-muted-foreground" aria-live="polite">{step !== "done" && `${stepIndex + 1} / ${STEPS.length - 1}`}</p>

        {step === "menu" && (
          <section aria-labelledby="h-menu">
            <h2 id="h-menu" className="text-xl font-bold mb-3">{t("chooseMenu")}</h2>
            <div className="flex flex-col gap-3">
              {shopQ.data!.menus.map((m) => (
                <Button key={m.id} size="lg" variant="outline" className="justify-between h-auto py-4 whitespace-normal text-left" onClick={() => {
                  setMenu(m); setStaffId(undefined);
                  const canNominate = (shopQ.data!.staff ?? []).some((s) => !s.menuIds || s.menuIds.includes(m.id));
                  setStep(canNominate ? "staff" : "date");
                }} data-testid={`button-menu-${m.id}`}>
                  <span><span className="block">{m.name}</span><span className="block text-sm font-normal text-muted-foreground">{t("minutesUnit", { n: m.minutes })}{m.description ? ` · ${m.description}` : ""}</span></span>
                  <span>{m.price.display}</span>
                </Button>
              ))}
            </div>
            {shop.info && <p className="mt-4 text-sm text-muted-foreground whitespace-pre-wrap">{shop.info}</p>}
          </section>
        )}

        {step === "staff" && (
          <section aria-labelledby="h-staff">
            <h2 id="h-staff" className="text-xl font-bold mb-3">{t("chooseStaff")}</h2>
            <div className="flex flex-col gap-3">
              <Button size="lg" variant={staffId === undefined ? "default" : "outline"} onClick={() => { setStaffId(undefined); setStep("date"); }} data-testid="button-staff-any">{t("anyStaff")}</Button>
              {nominable.map((s) => (
                <Button key={s.id} size="lg" variant={staffId === s.id ? "default" : "outline"} onClick={() => { setStaffId(s.id); setStep("date"); }} data-testid={`button-staff-${s.id}`}>{s.name}</Button>
              ))}
            </div>
          </section>
        )}

        {step === "date" && (
          <section aria-labelledby="h-date">
            <h2 id="h-date" className="text-xl font-bold mb-3">{t("chooseDate")}</h2>
            <div className="grid grid-cols-2 gap-3">
              {dates.map((d) => (
                <Button key={d.date} size="lg" variant={d.date === date ? "default" : "outline"} disabled={d.closed} onClick={() => { setDate(d.date); setTime(""); setStep("time"); }} data-testid={`button-date-${d.date}`}>
                  {fmtDate(d.date)}{d.closed ? ` · ${t("closed")}` : ""}
                </Button>
              ))}
            </div>
            <div className="flex justify-between mt-4">
              <Button variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>{t("earlierDays")}</Button>
              <Button variant="ghost" onClick={() => setPage((p) => p + 1)} disabled={addDays(shop.today, (page + 1) * 14) > shop.lastDate}>{t("laterDays")}</Button>
            </div>
          </section>
        )}

        {step === "time" && (
          <section aria-labelledby="h-time">
            <h2 id="h-time" className="text-xl font-bold mb-1">{t("chooseTime")}</h2>
            <p className="text-muted-foreground mb-3">{fmtDate(date)} · {menu?.name}</p>
            {slotsQ.isLoading ? <p>{t("loading")}</p> : slotsQ.data?.slots.length ? (
              <div className="grid grid-cols-3 gap-3">
                {slotsQ.data.slots.map((s) => (
                  <Button key={s} size="lg" variant={s === time ? "default" : "outline"} onClick={() => { setTime(s); setStep("details"); }} data-testid={`button-time-${s}`}>{s}</Button>
                ))}
              </div>
            ) : <p role="status">{t("noSlots")}</p>}
          </section>
        )}

        {step === "details" && (
          <form onSubmit={(e) => { e.preventDefault(); setStep("payment"); }} className="space-y-4" aria-labelledby="h-details">
            <h2 id="h-details" className="text-xl font-bold">{t("yourDetails")}</h2>
            <div><Label htmlFor="name">{t("name")} {t("required")}</Label><Input id="name" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-testid="input-name" /></div>
            <div><Label htmlFor="phone">{t("phone")} {t("required")}</Label><Input id="phone" type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" data-testid="input-phone" /></div>
            <div><Label htmlFor="email">{t("email")} {t("optional")}</Label><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" data-testid="input-email" /><p className="text-sm text-muted-foreground mt-1">{t("emailNote")}</p></div>
            <Button type="submit" size="lg" className="w-full" data-testid="button-details-next">{t("next")}</Button>
          </form>
        )}

        {step === "payment" && (
          <section aria-labelledby="h-pay">
            <h2 id="h-pay" className="text-xl font-bold mb-3">{t("choosePayment")}</h2>
            <div className="flex flex-col gap-3">
              {cardOk && <Button size="lg" variant="outline" onClick={() => { setPayment("card"); setStep("confirm"); }} aria-describedby="pay-card-note" data-testid="button-pay-card">{t("payCard")}</Button>}
              <Button size="lg" variant="outline" onClick={() => { setPayment("onsite"); setStep("confirm"); }} data-testid="button-pay-onsite">{t("payOnsite")}</Button>
            </div>
            {cardOk && <p id="pay-card-note" className="mt-3 text-sm">{t("cardHoldNote", { min: shop.cardHoldMinutes })}</p>}
            {shop.allowCardPayment && !cardOk && <p className="mt-3" data-testid="text-card-only-ahead">{t("cardOnlyAhead", { hours: shop.cardMinHoursBefore })}</p>}
          </section>
        )}

        {step === "confirm" && menu && (
          <section aria-labelledby="h-confirm" className="space-y-4">
            <h2 id="h-confirm" className="text-xl font-bold">{t("confirmBooking")}</h2>
            <dl className="rounded-lg border-2 p-4 space-y-2">
              <div className="flex justify-between"><dt>{t("confirmMenuLabel")}</dt><dd className="font-semibold">{menu.name} · {t("minutesUnit", { n: menu.minutes })}</dd></div>
              <div className="flex justify-between"><dt>{t("confirmWhenLabel")}</dt><dd className="font-semibold">{fmtDate(date)} {time}</dd></div>
              {nominable.length > 0 && <div className="flex justify-between"><dt>{t("staffLabel")}</dt><dd className="font-semibold">{nominable.find((x) => x.id === staffId)?.name ?? t("anyStaff")}</dd></div>}
              <div className="flex justify-between"><dt>{t("name")}</dt><dd className="font-semibold">{name}</dd></div>
              <div className="flex justify-between"><dt>{t("phone")}</dt><dd className="font-semibold">{phone}</dd></div>
              <div className="flex justify-between"><dt>{t("price")}</dt><dd className="font-semibold">{coupon ? <><s className="text-muted-foreground mr-2">{menu.price.display}</s>{coupon.price.display}</> : menu.price.display}</dd></div>
              <div className="flex justify-between"><dt>{t("choosePayment")}</dt><dd className="font-semibold">{payment === "card" ? t("payCard") : t("payOnsite")}</dd></div>
            </dl>
            {payment === "card" && <p className="font-semibold">{t("cardHoldNote", { min: shop.cardHoldMinutes })}</p>}
            {coupon ? (
              <div className="flex flex-wrap items-center gap-3" role="status">
                <span className="font-semibold">{t("couponApplied", { code: coupon.code, off: coupon.discount.display })}</span>
                <Button variant="ghost" size="sm" onClick={() => { setCoupon(null); setCouponInput(""); }}>{t("removeCoupon")}</Button>
              </div>
            ) : (
              <form onSubmit={applyCoupon} className="flex gap-2 items-end">
                <div className="flex-1"><Label htmlFor="coupon">{t("couponCode")}</Label><Input id="coupon" value={couponInput} onChange={(e) => setCouponInput(e.target.value)} autoCapitalize="characters" data-testid="input-coupon" /></div>
                <Button type="submit" variant="outline" data-testid="button-apply-coupon">{t("applyCoupon")}</Button>
              </form>
            )}
            {couponError && <p role="alert" className="text-destructive">{couponError}</p>}
            <div className="rounded-lg bg-accent text-accent-foreground p-4">
              <h3 className="font-bold mb-1">{t("cancelPolicy")}</h3>
              <p data-testid="text-cancel-policy">{shop.cancelPolicy}</p>
            </div>
            {error && <p role="alert" className="text-destructive font-semibold">{error}</p>}
            <Button size="lg" className="w-full" onClick={submit} disabled={busy} data-testid="button-confirm">{t("confirm")}</Button>
          </section>
        )}

        {step === "done" && created && (
          <section aria-labelledby="h-done" className="space-y-4" aria-live="polite">
            <h2 id="h-done" className="text-2xl font-bold">{t("bookingDone")}</h2>
            <p className="text-lg">{t("bookingNumber")}: <strong className="text-3xl tracking-widest" data-testid="text-booking-number">{created.reservation.number}</strong></p>
            <p>{t("keepNumber")}</p>
            <p>{fmtDate(created.reservation.date)} {created.reservation.time} · {created.reservation.menuName} · {created.reservation.price.display}</p>
            {created.reservation.paymentMethod === "card" && created.reservation.paymentUrl && (
              <p><span className="block font-semibold mb-2" data-testid="text-pay-within">{t("payWithin", { min: shop.cardHoldMinutes })}</span><Button size="lg" asChild><a href={created.reservation.paymentUrl} data-testid="link-pay">{t("payNow")}</a></Button>{created.paymentNote === "placeholder" && <span className="block text-sm text-muted-foreground mt-1">{t("payLinkPlaceholder")}</span>}</p>
            )}
            {created.emailNote && created.emailNote !== "no_email" && (
              <p className="text-sm" role="status" data-testid="text-email-note">{t(created.emailNote === "sent" ? "emailSent" : created.emailNote === "limit" ? "emailLimit" : created.emailNote === "failed" ? "emailFailed" : "emailLogged")}</p>
            )}
            {shop.address && <p className="text-muted-foreground">{shop.address}{shop.phone ? ` · ${shop.phone}` : ""}</p>}
          </section>
        )}

        {step !== "menu" && step !== "done" && <Button variant="ghost" onClick={back} data-testid="button-back">{t("back")}</Button>}
      </div>
    </Layout>
  );
}
