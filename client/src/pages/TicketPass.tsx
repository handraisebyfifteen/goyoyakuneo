/**
 * お客さん向けの回数券・前払いのページ。お会計のときにこの QR コードを見せる。残りと期限も見られる。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Layout } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import type { Money } from "@shared/money";

type Pass = { shopName: string; customerName: string; url: string; ticket: { kind: string; name: string; remaining: number | Money; expiresOn: string | null; usable: boolean } };

export default function TicketPass({ token }: { token: string }) {
  const { t, lang } = useI18n();
  const q = useQuery<Pass>({ queryKey: [`/api/public/tickets/${token}?lang=${lang}`] });
  const [qr, setQr] = useState("");
  useEffect(() => { if (q.data) QRCode.toDataURL(q.data.url, { width: 560, margin: 2 }).then(setQr).catch(() => setQr("")); }, [q.data]);
  const d = q.data;
  const left = d ? (typeof d.ticket.remaining === "number" ? t("passLeftCount", { n: d.ticket.remaining }) : t("passLeftAmount", { amount: d.ticket.remaining.display })) : "";
  return (
    <Layout title={d ? d.shopName : t("ticketsTitle")}>
      {q.error ? <p role="alert" className="text-destructive font-semibold">{t("passNotFound")}</p> : !d ? <p>{t("loading")}</p> : (
        <div className="max-w-sm mx-auto text-center space-y-3 rounded-xl border-2 bg-white p-5 text-black">
          <p className="text-lg font-bold">{d.ticket.name}</p>
          <p>{d.customerName}{lang === "ja" ? " 様" : ""}</p>
          {qr ? <img src={qr} alt={t("passQrAlt", { name: d.ticket.name })} className="mx-auto w-full max-w-72" data-testid="img-pass-qr" /> : <p>{t("loading")}</p>}
          <p className="text-2xl font-bold" data-testid="text-pass-left">{left}</p>
          {d.ticket.expiresOn && <p>{t("passExpires", { date: d.ticket.expiresOn })}</p>}
          {!d.ticket.usable && <p className="font-semibold">{t("passUnusable")}</p>}
          <p className="text-sm">{t("passHint")}</p>
        </div>
      )}
    </Layout>
  );
}
