/**
 * カメラで QR コードを読み取る部品。
 * - 開いている間ずっと読み続け、見つかったら振動して知らせる（狙いを定めにくい人のため、枠に入れなくても全体から探す）
 * - カメラが使えない・狙いにくいときは「写真を撮って読み取る」でも読める
 * - iPhone の Safari には QR を読む標準の仕組みがないので jsQR で読む（あれば BarcodeDetector を先に使う）
 */
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

function decodeCanvas(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState(t("scanLooking"));
  const done = useRef(false);

  const found = (text: string) => {
    if (done.current) return;
    done.current = true;
    try { navigator.vibrate?.(120); } catch { /* 振動できない端末 */ }
    onResult(text);
  };

  useEffect(() => {
    // 開き直したとき（開発中は React が二度走らせる）に、前の「読み取り済み」を残さない
    done.current = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    const W = window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector };
    const detector = W.BarcodeDetector ? new W.BarcodeDetector({ formats: ["qr_code"] }) : null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (done.current) return;
          const c = canvas.current!;
          if (v.videoWidth) {
            c.width = v.videoWidth; c.height = v.videoHeight;
            c.getContext("2d")!.drawImage(v, 0, 0);
            let text: string | null = null;
            if (detector) { try { text = (await detector.detect(c))[0]?.rawValue ?? null; } catch { /* jsQR に任せる */ } }
            text ??= decodeCanvas(c);
            if (text) return found(text);
          }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      } catch {
        setStatus(t("scanNoCamera"));
      }
    })();
    return () => { done.current = true; window.clearTimeout(timer); stream?.getTracks().forEach((tr) => tr.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 写真から読む（カメラの枠を合わせにくいとき）
  async function fromPhoto(f: File) {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const c = canvas.current!;
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      c.width = img.width * scale; c.height = img.height * scale;
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const text = decodeCanvas(c);
      if (text) found(text); else setStatus(t("scanNotFound"));
    };
    img.src = url;
  }

  return (
    <div className="rounded-xl border-2 p-4 space-y-3" role="group" aria-label={t("scanTitle")}>
      <p role="status" aria-live="polite" className="font-semibold">{status}</p>
      <video ref={video} className="w-full max-w-sm rounded-lg bg-black" muted playsInline aria-hidden="true" />
      <canvas ref={canvas} hidden />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => file.current?.click()}>{t("scanPhoto")}</Button>
        <Button variant="ghost" onClick={onClose} data-testid="button-scan-close">{t("scanStop")}</Button>
      </div>
      <input ref={file} type="file" accept="image/*" capture="environment" hidden data-testid="input-scan-photo" onChange={(e) => { const f = e.target.files?.[0]; if (f) fromPhoto(f); e.target.value = ""; }} />
    </div>
  );
}
