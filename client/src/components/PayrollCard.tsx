/**
 * 「今月の給与」。スタッフごとに 勤務時間×時給＋指名料＋歩合。確認していない打刻があれば知らせる。
 * 時給・指名料・歩合はスタッフ欄の設定で決める。
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import type { Money } from "@shared/money";

type Row = { staffId: number; name: string; hours: number; nominations: number; sales: Money; base: Money; nominationPay: Money; commission: Money; total: Money; unconfirmed: number };

export function PayrollCard() {
  const { t, lang } = useI18n();
  const q = useQuery<{ staff: Row[]; total: Money }>({ queryKey: [`/api/owner/payroll?lang=${lang}`] });
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("payrollTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {q.data?.staff.length ? (
          <ul className="divide-y">
            {q.data.staff.map((s) => (
              <li key={s.staffId} className="py-2">
                <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{s.name}</span><span className="font-bold">{s.total.display}</span></div>
                <p className="text-sm">{t("payRow", { hours: s.hours, n: s.nominations, sales: s.sales.display })}</p>
                <p className="text-sm text-muted-foreground">{t("payBreakdown", { base: s.base.display, nom: s.nominationPay.display, com: s.commission.display })}</p>
                {s.unconfirmed > 0 && <p className="text-sm font-semibold">{t("payUnconfirmed", { n: s.unconfirmed })}</p>}
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">{q.isLoading ? t("loading") : t("noPending")}</p>}
        {q.data && q.data.staff.length > 0 && <p className="font-semibold" data-testid="text-payroll-total">{t("payTotal", { total: q.data.total.display })}</p>}
      </CardContent>
    </Card>
  );
}
