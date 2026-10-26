/**
 * 「スマホに通知を出す」。アプリを閉じていても、画面がロックされていても、新しい予約やカード払いの知らせが届く。
 * - iPhone の Safari で開いているときは、ホーム画面に追加する手順を先に見せる（追加したアプリの中でしか通知を受けられない）
 * - 通知を断っていたら、端末の設定で許可し直す方法を伝える
 * - 始めたら、テストの通知を送って届くか確かめられる
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import { pushEnv, currentSubscription, enablePush, disablePush, isIos, type PushEnv } from "@/lib/push";
import type { PublicOwner } from "@shared/schema";

type PushInfo = { publicKey: string; devices: { id: number; device: string; endpoint: string; createdAt: string }[] };

export function PushCard({ owner }: { owner: PublicOwner }) {
  const { t } = useI18n();
  const q = useQuery<PushInfo>({ queryKey: ["/api/owner/push"] });
  const [env, setEnv] = useState<PushEnv>(() => (typeof window === "undefined" ? "unsupported" : pushEnv()));
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { currentSubscription().then((s) => setMine(s?.endpoint ?? null), () => setMine(null)); }, []);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/owner/push"] });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(""); setStatus("");
    try { await fn(); } catch (e) { setError(e instanceof ApiRequestError ? e.message : t("pushFailed")); } finally { setBusy(false); }
  };

  // 許可を聞くのは、押した処理の最初でないといけない（iPhone）。鍵は先に読み込んでおく
  const start = () => {
    const key = q.data?.publicKey;
    if (!key) return;
    void run(async () => {
      const r = await enablePush(key);
      if (r === "denied") { setEnv("denied"); return; }
      setMine((await currentSubscription())?.endpoint ?? null);
      await refresh();
      const sent = (await apiRequest<{ sent: number }>("POST", "/api/owner/push/test", {})).sent;
      setStatus(sent ? t("pushOnSent") : t("pushOnNotSent"));
    });
  };
  const stop = () => run(async () => { await disablePush(); setMine(null); await refresh(); setStatus(t("pushOff")); });
  const test = () => run(async () => {
    const sent = (await apiRequest<{ sent: number }>("POST", "/api/owner/push/test", {})).sent;
    setStatus(sent ? t("pushTestSent") : t("pushOnNotSent"));
  });
  const remove = (id: number) => run(async () => { await apiRequest("POST", "/api/owner/push/remove", { id }); await refresh(); setStatus(t("pushRemoved")); });

  const on = !!mine && !!q.data?.devices.some((d) => d.endpoint === mine);
  const others = q.data?.devices.filter((d) => d.endpoint !== mine) ?? [];

  return (
    <Card className="sm:col-span-2" data-section="push">
      <CardHeader><CardTitle>{t("pushTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p>{t("pushIntro")}</p>

        {env === "ios_home" && (
          !owner.registered ? (
            <>
              <p className="font-semibold">{t("pushIosNeedsRegister")}</p>
              <Button asChild><Link href="/signup">{t("registerShop")}</Link></Button>
            </>
          ) : (
            <section aria-labelledby="push-ios">
              <h3 id="push-ios" className="font-bold">{t("pushIosTitle")}</h3>
              <ol className="list-decimal pl-6 space-y-1">{t("pushIosSteps").split("|").map((x) => <li key={x}>{x}</li>)}</ol>
            </section>
          )
        )}
        {env === "unsupported" && <p className="font-semibold">{t("pushUnsupported")}</p>}
        {env === "denied" && <p className="font-semibold" role="alert">{t(isIos() ? "pushDeniedIos" : "pushDenied")}</p>}

        {env === "ok" && (on ? (
          <>
            <p className="font-semibold" data-testid="text-push-on">{t("pushOnHere")}</p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={test} disabled={busy} data-testid="button-push-test">{t("pushTest")}</Button>
              <Button variant="outline" onClick={stop} disabled={busy} data-testid="button-push-stop">{t("pushStop")}</Button>
            </div>
          </>
        ) : (
          <Button size="lg" onClick={start} disabled={busy || !q.data} data-testid="button-push-start">{t("pushStart")}</Button>
        ))}

        {others.length > 0 && (
          <section aria-labelledby="push-others">
            <h3 id="push-others" className="font-bold">{t("pushOthers")}</h3>
            <ul className="divide-y">
              {others.map((d) => (
                <li key={d.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <span>{d.device || t("pushUnknownDevice")} · {d.createdAt.slice(0, 10)}</span>
                  <Button variant="ghost" size="sm" onClick={() => remove(d.id)} disabled={busy}>{t("pushRemove")}</Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p role="status" className="text-sm" data-testid="text-push-status">{status}</p>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
