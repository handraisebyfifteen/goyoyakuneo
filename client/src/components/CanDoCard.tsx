/**
 * 今できること（server/capabilities.ts）。登録・設定してあるからできることを先に、言い方の例を添えて並べる。
 * 設定するとできることは3つまで。いつでもできることは、たたんでおく（何もできるものがないうちは開いておく）。
 * 「開く」で、その欄の見出しへ移る。言い方の例がないものは、欄があれば画面で使うもの、なければ自動で動くもの。
 */
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";

type Ability = { key: string; title: string; detail: string; say: string | null; section: string | null };
type Abilities = { ready: Ability[]; always: Ability[]; next: Ability[] };

export function CanDoCard({ onOpen }: { onOpen: (section: string) => void }) {
  const { t, lang } = useI18n();
  const q = useQuery<Abilities>({ queryKey: [`/api/owner/capabilities?lang=${lang}`] });

  const row = (a: Ability) => (
    <li key={a.key} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4" data-testid={`row-cando-${a.key}`}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-semibold">{a.title}</p>
        <p className="text-sm text-muted-foreground">{a.detail}</p>
        <p className="text-sm">{a.say ? t("canDoSay", { say: a.say }) : a.section ? t("canDoScreen") : t("canDoAuto")}</p>
      </div>
      {a.section && <Button variant="outline" size="sm" className="self-start" onClick={() => onOpen(a.section!)} aria-label={t("canDoOpenLabel", { title: a.title })} data-testid={`button-cando-${a.key}`}>{t("canDoOpen")}</Button>}
    </li>
  );

  return (
    <Card className="sm:col-span-2" data-testid="card-cando">
      <CardHeader><CardTitle>{t("canDoTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        {!q.data ? <p className="text-muted-foreground">{t("loading")}</p> : (
          <>
            <section>
              <h3 className="font-bold">{t("canDoReady")}</h3>
              {q.data.ready.length ? <ul className="divide-y">{q.data.ready.map(row)}</ul> : <p className="mt-1 text-sm text-muted-foreground">{t("canDoReadyNone")}</p>}
            </section>
            {q.data.next.length > 0 && (
              <section>
                <h3 className="font-bold">{t("canDoNext")}</h3>
                <ul className="divide-y">{q.data.next.map(row)}</ul>
              </section>
            )}
            <details open={!q.data.ready.length || undefined}>
              <summary className="cursor-pointer font-bold">{t("canDoAlways", { n: q.data.always.length })}</summary>
              <ul className="divide-y">{q.data.always.map(row)}</ul>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
