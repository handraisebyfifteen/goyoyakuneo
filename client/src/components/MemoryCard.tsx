/**
 * 「ご予約ちゃんが覚えていること」。会話で覚えたお店の決まりごとや好みを見て、違っていれば消す。
 */
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, queryClient } from "@/lib/queryClient";

export function MemoryCard() {
  const { t } = useI18n();
  const q = useQuery<{ memories: { id: number; content: string }[] }>({ queryKey: ["/api/owner/memories"] });
  const forget = async (id: number) => {
    await apiRequest("DELETE", `/api/owner/memories/${id}`);
    await queryClient.invalidateQueries({ queryKey: ["/api/owner/memories"] });
  };
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("memoryTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("memoryHint")}</p>
        {q.data?.memories.length ? (
          <ul className="divide-y">
            {q.data.memories.map((m) => (
              <li key={m.id} className="py-2 flex items-center justify-between gap-3">
                <span>{m.content}</span>
                <Button size="sm" variant="outline" onClick={() => forget(m.id)} aria-label={`${t("forget")}: ${m.content}`}>{t("forget")}</Button>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">{q.isLoading ? t("loading") : t("memoryEmpty")}</p>}
      </CardContent>
    </Card>
  );
}
