/**
 * 管理画面の「API キー」。外の道具（会計・給与・自作のツールなど）からこの店のデータを読むための鍵を発行・取り消しする。
 * キーは発行したときに一度だけ表示する（あとからは見られない）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";

type Key = { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revoked: boolean };

export function ApiKeyCard() {
  const { t, lang } = useI18n();
  const q = useQuery<{ keys: Key[] }>({ queryKey: ["/api/owner/api-keys"] });
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(lang === "ja" ? "ja-JP" : "en-US", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t("never"));

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setCopied(false);
    try {
      const r = await apiRequest<{ key: string }>("POST", "/api/owner/api-keys", { name });
      setFresh(r.key); setName("");
      await queryClient.invalidateQueries({ queryKey: ["/api/owner/api-keys"] });
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
  }
  async function revoke(id: number) {
    await apiRequest("DELETE", `/api/owner/api-keys/${id}`);
    await queryClient.invalidateQueries({ queryKey: ["/api/owner/api-keys"] });
  }

  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("apiTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("apiHint")}</p>
        {fresh && (
          <div className="rounded-lg bg-accent text-accent-foreground p-3 space-y-2" role="status">
            <p className="font-semibold">{t("apiShownOnce")}</p>
            <p className="break-all font-mono text-sm" data-testid="text-api-key">{fresh}</p>
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(fresh).then(() => setCopied(true))}>{copied ? t("copied") : t("copyUrl")}</Button>
          </div>
        )}
        {q.data?.keys.length ? (
          <ul className="divide-y">
            {q.data.keys.map((k) => (
              <li key={k.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-semibold">{k.name}</span> <span className="font-mono text-sm">{k.prefix}…</span>
                  <span className="block text-sm text-muted-foreground">{t("apiUsed", { at: fmt(k.lastUsedAt) })}{k.revoked ? ` · ${t("apiRevoked")}` : ""}</span>
                </span>
                {!k.revoked && <Button size="sm" variant="outline" onClick={() => revoke(k.id)} aria-label={`${t("apiRevoke")}: ${k.name}`}>{t("apiRevoke")}</Button>}
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={issue} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-48"><Label htmlFor="api-name">{t("apiName")}</Label><Input id="api-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <Button type="submit" data-testid="button-issue-key">{t("apiIssue")}</Button>
        </form>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
