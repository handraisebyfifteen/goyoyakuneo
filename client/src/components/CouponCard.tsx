/**
 * 「クーポン」。作る・止める、と QR コード。QR はクーポン入りの予約ページのリンクなので、
 * チラシやお店の入口に貼ればお客さんが読んでそのまま予約でき、店頭で見せてもらえばオーナーが読み取って当てられる。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";

type Coupon = { id: number; code: string; kind: string; off: string; expiresOn: string | null; active: boolean; usable: boolean; url: string };

export function CouponCard() {
  const { t, lang } = useI18n();
  const key = `/api/owner/coupons?lang=${lang}`;
  const q = useQuery<{ coupons: Coupon[] }>({ queryKey: [key] });
  const [f, setF] = useState({ code: "", kind: "percent", value: "10", expiresOn: "" });
  const [error, setError] = useState("");
  const [qr, setQr] = useState<{ id: number; src: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [key] });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await apiRequest("POST", "/api/owner/coupons", { code: f.code, percentOff: f.kind === "percent" ? Number(f.value) : undefined, amountOff: f.kind === "amount" ? Number(f.value) : undefined, expiresOn: f.expiresOn || null });
      setF((o) => ({ ...o, code: "" })); await refresh();
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
  }
  async function showQr(c: Coupon) {
    if (qr?.id === c.id) return setQr(null);
    setQr({ id: c.id, src: await QRCode.toDataURL(c.url, { width: 480, margin: 2 }) });
  }
  async function share(c: Coupon) {
    if (typeof navigator.share === "function") { try { await navigator.share({ title: c.code, text: t("couponShareText", { code: c.code, off: c.off }), url: c.url }); } catch { /* 閉じられた */ } }
    else navigator.clipboard?.writeText(c.url);
  }
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("couponsTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("couponsHint")}</p>
        {q.data?.coupons.length ? (
          <ul className="divide-y">
            {q.data.coupons.map((c) => (
              <li key={c.id} className={`py-2 space-y-2 ${c.usable ? "" : "text-muted-foreground"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><span className="font-semibold tracking-wider">{c.code}</span> · {t("couponOff", { off: c.off })}{c.expiresOn ? ` · 〜${c.expiresOn}` : ""}{!c.usable ? ` · ${t("couponStopped")}` : ""}</span>
                  {c.usable && (
                    <span className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" aria-expanded={qr?.id === c.id} onClick={() => showQr(c)}>{t("showQr")}</Button>
                      <Button size="sm" variant="outline" onClick={() => share(c)}>{t("shareLink")}</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { await apiRequest("POST", `/api/owner/coupons/${c.id}/stop`); await refresh(); }}>{t("couponStop")}</Button>
                    </span>
                  )}
                </div>
                {qr?.id === c.id && (
                  <div id="qr-print" className="rounded-lg border-2 bg-white p-3 text-center text-black max-w-xs">
                    <p className="font-bold">{c.code} · {t("couponOff", { off: c.off })}</p>
                    <img src={qr.src} alt={t("couponQrAlt", { code: c.code })} className="mx-auto w-full max-w-56" />
                    <Button className="mt-2 print:hidden" size="sm" variant="outline" onClick={() => window.print()}>{t("printQr")}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">{q.isLoading ? t("loading") : t("noTickets")}</p>}
        <form onSubmit={create} className="grid gap-2 sm:grid-cols-[1fr_auto_8rem_auto_auto] items-end">
          <div><Label htmlFor="cp-code">{t("couponCodeLabel")}</Label><Input id="cp-code" value={f.code} onChange={(e) => setF((o) => ({ ...o, code: e.target.value }))} required autoCapitalize="characters" /></div>
          <div>
            <Label htmlFor="cp-kind">{t("couponKind")}</Label>
            <select id="cp-kind" className="flex min-h-12 rounded-md border-2 border-input bg-card px-3 py-2" value={f.kind} onChange={(e) => setF((o) => ({ ...o, kind: e.target.value }))}>
              <option value="percent">%</option><option value="amount">{t("couponAmount")}</option>
            </select>
          </div>
          <div><Label htmlFor="cp-value">{t("couponValue")}</Label><Input id="cp-value" type="number" min="1" step="any" value={f.value} onChange={(e) => setF((o) => ({ ...o, value: e.target.value }))} required /></div>
          <div><Label htmlFor="cp-exp">{t("ticketExpires")}</Label><Input id="cp-exp" type="date" value={f.expiresOn} onChange={(e) => setF((o) => ({ ...o, expiresOn: e.target.value }))} /></div>
          <Button type="submit" data-testid="button-create-coupon">{t("couponCreate")}</Button>
        </form>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
