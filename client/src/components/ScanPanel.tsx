/**
 * お会計で、お客さんの回数券・クーポンの QR を読み取って使う。
 * 読み取った結果は読み上げ（スマホでは VoiceOver が画面の知らせを読む）、今日の当日払いの予約に「使う」ボタンで当てる。
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { QrScanner } from "@/components/QrScanner";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import { speak } from "@/lib/speech";
import type { Money } from "@shared/money";

type Res = { id: number; time: string; customerName: string; menuName: string; price: Money | null };
type Scan =
  | { kind: "ticket"; ticketId: number; customerName: string; speech: string; reservations: Res[]; ticket: { usable: boolean } }
  | { kind: "coupon"; code: string; speech: string; usable: boolean; reservations: Res[] };

export function ScanPanel({ onDone }: { onDone: () => void }) {
  const { t, lang, speechLang } = useI18n();
  const [scanning, setScanning] = useState(true);
  const [scan, setScan] = useState<Scan | null>(null);
  const [message, setMessage] = useState("");
  const say = (text: string) => { setMessage(text); speak(text, speechLang).catch(() => undefined); };

  async function read(text: string) {
    setScanning(false);
    try {
      const r = await apiRequest<Scan>("POST", "/api/owner/scan", { text, lang });
      setScan(r); say(r.speech);
    } catch (e) { setScan(null); say(e instanceof ApiRequestError ? e.message : t("error")); }
  }
  async function use(res: Res) {
    if (!scan) return;
    try {
      if (scan.kind === "ticket") await apiRequest("POST", `/api/owner/reservations/${res.id}/use-ticket`, { ticketId: scan.ticketId });
      else await apiRequest("POST", `/api/owner/reservations/${res.id}/apply-coupon`, { code: scan.code });
      ["/api/owner/reservations", "/api/owner/tickets", "/api/owner/summary"].forEach((k) => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(k) }));
      say(scan.kind === "ticket" ? t("scanUsedTicket", { time: res.time, name: res.customerName }) : t("scanUsedCoupon", { time: res.time, name: res.customerName, code: scan.code }));
      setScan(null);
    } catch (e) { say(e instanceof ApiRequestError ? e.message : t("error")); }
  }

  const usable = scan ? (scan.kind === "ticket" ? scan.ticket.usable : scan.usable) : false;
  return (
    <div className="space-y-3">
      {scanning && <QrScanner onResult={read} onClose={onDone} />}
      <p role="status" aria-live="assertive" className="text-lg font-semibold" data-testid="text-scan-result">{message}</p>
      {scan && usable && scan.reservations.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("scanUseFor")}>
          {scan.reservations.map((r) => (
            <Button key={r.id} size="lg" onClick={() => use(r)} data-testid={`button-scan-use-${r.id}`}>
              {t("scanUseOn", { time: r.time, name: r.customerName })}
            </Button>
          ))}
        </div>
      )}
      {!scanning && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { setScan(null); setMessage(""); setScanning(true); }} data-testid="button-scan-again">{t("scanAgain")}</Button>
          <Button variant="ghost" onClick={onDone}>{t("closePanel")}</Button>
        </div>
      )}
    </div>
  );
}
