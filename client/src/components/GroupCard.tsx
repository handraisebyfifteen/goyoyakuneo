/**
 * 管理画面の店舗グループ欄。グループを作る・参加コードで入る・抜ける、グループの店ごとの集計（売り上げと件数だけ）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import type { Money } from "@shared/money";

type GroupData = { group: { name: string; joinCode: string } | null; shops: { shopName: string; me: boolean; total: Money; reservationCount: number; cancelledCount: number; noShowCount: number }[] };

export function GroupCard() {
  const { t, lang } = useI18n();
  const q = useQuery<GroupData>({ queryKey: [`/api/owner/group?lang=${lang}`] });
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); await queryClient.invalidateQueries({ queryKey: [`/api/owner/group?lang=${lang}`] }); }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : t("error")); }
  };

  const g = q.data?.group;
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("groupTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("groupIntro")}</p>
        {g ? (
          <>
            <p className="font-semibold">{g.name}</p>
            <p>{t("joinCode")}: <strong className="tracking-widest" data-testid="text-join-code">{g.joinCode}</strong></p>
            <p className="text-sm text-muted-foreground">{t("groupCodeHint")}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead><tr><th className="py-1 pr-3">{t("shopName")}</th><th className="py-1 pr-3">{t("total")}</th><th className="py-1 pr-3">{t("reservationsCol")}</th><th className="py-1 pr-3">{t("cancelled")}</th><th className="py-1">{t("noShows")}</th></tr></thead>
                <tbody>
                  {q.data!.shops.map((s, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-1 pr-3">{s.shopName}{s.me ? t("thisShop") : ""}</td>
                      <td className="py-1 pr-3 font-semibold">{s.total.display}</td>
                      <td className="py-1 pr-3">{t("bookingsN", { n: s.reservationCount })}</td>
                      <td className="py-1 pr-3">{t("bookingsN", { n: s.cancelledCount })}</td>
                      <td className="py-1">{t("bookingsN", { n: s.noShowCount })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button variant="outline" onClick={() => run(() => apiRequest("POST", "/api/owner/group/leave"))} data-testid="button-leave-group">{t("leaveGroup")}</Button>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(() => apiRequest("POST", "/api/owner/group", { name })); }}>
              <Label htmlFor="group-name">{t("groupName")}</Label>
              <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" data-testid="button-create-group">{t("createGroup")}</Button>
            </form>
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) run(() => apiRequest("POST", "/api/owner/group/join", { code })); }}>
              <Label htmlFor="group-code">{t("joinCode")}</Label>
              <Input id="group-code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" required />
              <Button type="submit" variant="outline" data-testid="button-join-group">{t("joinGroup")}</Button>
            </form>
          </div>
        )}
        {error && <p role="alert" className="text-destructive font-semibold">{error}</p>}
      </CardContent>
    </Card>
  );
}
