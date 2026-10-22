import { useState } from "react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { useAnnounce } from "@/hooks/useAnnounce";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";
import type { Money } from "@shared/money";

type Found = { reservation: { id: number; number: string; date: string; time: string; endTime: string; menuName: string; price: Money; status: string; paymentMethod: string; paymentStatus: string; customerName: string }; shop: { name: string; address: string; phone: string; cancelPolicy: string } };

export default function Lookup() {
  const { t, lang, speechLang } = useI18n();
  useAnnounce(t("lookupSpeech"), speechLang);
  const [number, setNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ refundEligible: boolean | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setFound(null); setResult(null);
    try { setFound(await apiRequest<Found>("POST", "/api/public/lookup", { number, phone, lang })); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
    finally { setBusy(false); }
  }

  async function cancel() {
    setBusy(true); setError("");
    try {
      const r = await apiRequest<{ refundEligible: boolean | null; reservation: Found["reservation"] }>("POST", "/api/public/lookup/cancel", { number, phone, lang });
      setResult({ refundEligible: r.refundEligible });
      setFound((f) => (f ? { ...f, reservation: r.reservation } : f));
      setConfirming(false);
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
    finally { setBusy(false); }
  }

  const r = found?.reservation;
  return (
    <Layout title={t("lookupTitle")}>
      <form onSubmit={lookup} className="max-w-md space-y-4">
        <div><Label htmlFor="number">{t("bookingNumber")}</Label><Input id="number" inputMode="numeric" pattern="\d{4}" maxLength={4} required value={number} onChange={(e) => setNumber(e.target.value)} data-testid="input-number" /></div>
        <div><Label htmlFor="phone">{t("phone")}</Label><Input id="phone" type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-phone" /></div>
        <Button type="submit" size="lg" disabled={busy} data-testid="button-lookup">{t("lookup")}</Button>
      </form>
      {error && <p role="alert" className="mt-4 text-destructive font-semibold">{error}</p>}
      {r && (
        <section className="mt-6 max-w-md rounded-lg border-2 p-5 space-y-3" aria-live="polite">
          <h2 className="text-xl font-bold">{found!.shop.name}</h2>
          <p className="text-lg">{r.date} {r.time} – {r.endTime}</p>
          <p>{r.menuName} · {r.price.display} · {r.customerName}</p>
          <p className="font-semibold" data-testid="text-status">{t(r.status === "cancelled" ? "statusCancelled" : r.status === "completed" ? "statusCompleted" : r.status === "no_show" ? "statusNoShow" : "statusConfirmed")}</p>
          {result && (
            <div className="rounded-lg bg-accent text-accent-foreground p-4" role="status">
              <p className="font-bold">{t("cancelled_done")}</p>
              {result.refundEligible !== null && <p>{result.refundEligible ? t("refundYes") : t("refundNo")}</p>}
            </div>
          )}
          {r.status === "confirmed" && !result && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{found!.shop.cancelPolicy}</p>
              {confirming ? (
                <div className="flex gap-3">
                  <Button variant="destructive" size="lg" onClick={cancel} disabled={busy} data-testid="button-cancel-yes">{t("yes")}</Button>
                  <Button variant="outline" size="lg" onClick={() => setConfirming(false)}>{t("no")}</Button>
                  <span className="self-center">{t("reallyCancel")}</span>
                </div>
              ) : <Button variant="destructive" onClick={() => setConfirming(true)} data-testid="button-cancel">{t("cancelBooking")}</Button>}
            </div>
          )}
        </section>
      )}
    </Layout>
  );
}
