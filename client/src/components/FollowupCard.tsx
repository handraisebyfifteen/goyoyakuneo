/**
 * 「次回の声かけ」。前回の来店から何日あいたら「そろそろいかがですか」のメールを送るか（送らない、も選べる）。
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { apiRequest, queryClient } from "@/lib/queryClient";

const CHOICES = [0, 30, 45, 60, 90];

export function FollowupCard({ days }: { days: number }) {
  const { t } = useI18n();
  const options = CHOICES.includes(days) ? CHOICES : [...CHOICES, days].sort((a, b) => a - b);
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("followupTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("followupHint")}</p>
        <Label htmlFor="followup">{t("followupTitle")}</Label>
        <select id="followup" className="flex min-h-12 w-full max-w-xs rounded-md border-2 border-input bg-card px-3 py-2" value={days} data-testid="select-followup"
          onChange={async (e) => { await apiRequest("PATCH", "/api/owner/settings", { followupAfterDays: Number(e.target.value) }); await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }); }}>
          {options.map((n) => <option key={n} value={n}>{n ? t("followupDays", { n }) : t("followupOff")}</option>)}
        </select>
      </CardContent>
    </Card>
  );
}
