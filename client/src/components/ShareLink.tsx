/**
 * お客さん用の予約ページを渡す部品。
 * - スマホでは「送る」でスマホの共有画面を開く（LINE・メッセージ・メールから選べる。VoiceOver でもそのまま使える）
 * - パソコンではリンクのコピー
 * - QR コードを出して印刷できる（受付に置けば、お客さんが自分で読み取って予約できる）
 * 声で「リンクを送って」と頼まれたときは、共有画面は操作の中でしか開けないので、送るボタンにフォーカスを移して押してもらう。
 */
import { forwardRef, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

export const ShareLink = forwardRef<HTMLButtonElement, { url: string; shopName: string }>(function ShareLink({ url, shopName }, ref) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState("");
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    if (!showQr || qr) return;
    QRCode.toDataURL(url, { width: 480, margin: 2 }).then(setQr).catch(() => setQr(""));
  }, [showQr, qr, url]);

  async function share() {
    try { await navigator.share({ title: shopName, text: t("shareText", { shop: shopName }), url }); }
    catch { /* 閉じられたときも何もしない */ }
  }
  function copy() {
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div className="space-y-3">
      <a href={url} className="underline break-all" data-testid="link-booking-page">{url}</a>
      <div className="flex flex-wrap gap-3">
        {canShare()
          ? <Button ref={ref} size="lg" onClick={share} data-testid="button-share-link">{t("shareLink")}</Button>
          : <Button ref={ref} size="lg" variant="secondary" onClick={copy} data-testid="button-copy-link">{copied ? t("copied") : t("copyLink")}</Button>}
        <Button size="lg" variant="outline" aria-expanded={showQr} onClick={() => setShowQr((v) => !v)} data-testid="button-show-qr">{t(showQr ? "hideQr" : "showQr")}</Button>
      </div>
      <p role="status" className="sr-only">{copied ? t("copied") : ""}</p>
      {showQr && (
        <div id="qr-print" className="rounded-lg border-2 bg-white p-4 text-center text-black max-w-xs">
          <p className="font-bold text-lg">{shopName}</p>
          {qr ? <img src={qr} alt={t("qrAlt", { shop: shopName })} className="mx-auto w-full max-w-64" /> : <p>{t("loading")}</p>}
          <p className="text-sm">{t("qrHint")}</p>
          <Button className="mt-3 print:hidden" variant="outline" onClick={() => window.print()} data-testid="button-print-qr">{t("printQr")}</Button>
        </div>
      )}
    </div>
  );
});
