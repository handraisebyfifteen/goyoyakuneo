/**
 * 管理画面の「打刻の確認」。確認待ちの打刻（予定どおり／要確認と理由）と、最近のお知らせ。
 * 予定どおりのものはまとめて確認。要確認のものは1件ずつ確認するか、時刻を直す（元の時刻は残る）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";

type Entry = { id: number; staffName: string; date: string; clockIn: string; clockOut: string | null; planStart: string | null; planEnd: string | null; onPlan: boolean; issues: string[]; corrected: boolean; original: { in: string; out: string | null } | null };
type Data = { pending: Entry[]; events: { id: number; at: string; text: string }[]; tolerance: number };

export function AttendanceCard() {
  const { t, lang } = useI18n();
  const key = `/api/owner/attendance?lang=${lang}`;
  const q = useQuery<Data>({ queryKey: [key] });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<number | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(""); setStatus("");
    try { await fn(); await queryClient.invalidateQueries({ queryKey: [key] }); await queryClient.invalidateQueries({ queryKey: ["/api/owner/timesheet"] }); }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : t("error")); }
  };
  const confirm = (body: Record<string, unknown>) => run(async () => {
    const r = await apiRequest<{ confirmed: number }>("POST", "/api/owner/attendance/confirm", body);
    setStatus(t("confirmedN", { n: r.confirmed }));
  });

  const d = q.data;
  const closedOk = d?.pending.filter((e) => e.clockOut && e.onPlan).length ?? 0;
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("attendanceTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {d && <p className="text-sm text-muted-foreground">{t("attendanceHint", { n: d.tolerance })}</p>}
        {d?.pending.length ? (
          <ul className="divide-y">
            {d.pending.map((e) => (
              <li key={e.id} className="py-3 space-y-2" data-testid={`row-attendance-${e.id}`}>
                <div className="flex flex-wrap justify-between gap-2">
                  <span><span className="font-semibold">{e.staffName}</span> {e.date} {t("clockInLabel")} {e.clockIn} – {t("clockOutLabel")} {e.clockOut ?? t("notOutYet")}</span>
                  <span className={e.onPlan ? "" : "font-bold text-destructive"}>{e.onPlan ? t("onPlan") : t("needsCheck")}</span>
                </div>
                {(e.planStart || e.planEnd) && <p className="text-sm">{t("planLabel")}: {e.planStart ?? "-"} – {e.planEnd ?? "-"}</p>}
                {!e.onPlan && <p className="text-sm">{e.issues.join(lang === "ja" ? "、" : ", ")}</p>}
                {e.clockOut && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => confirm({ ids: [e.id] })} data-testid={`button-confirm-${e.id}`}>{t("confirmOne")}</Button>
                    <Button size="sm" variant="outline" aria-expanded={editing === e.id} onClick={() => setEditing(editing === e.id ? null : e.id)}>{t("correctTime")}</Button>
                  </div>
                )}
                {editing === e.id && <Correct entry={e} onSave={(body) => run(async () => { await apiRequest("PATCH", `/api/owner/attendance/${e.id}`, body); setEditing(null); })} />}
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">{q.isLoading ? t("loading") : t("noPending")}</p>}
        {closedOk > 0 && <Button onClick={() => confirm({ onlyOk: true })} data-testid="button-confirm-ok">{t("confirmOk")}</Button>}
        {status && <p role="status">{status}</p>}
        {error && <p role="alert" className="text-destructive font-semibold">{error}</p>}
        {d?.events.length ? (
          <details>
            <summary className="cursor-pointer font-semibold">{t("recentEvents")}</summary>
            <ul className="mt-2 space-y-1 text-sm">
              {d.events.map((ev) => <li key={ev.id}>{new Date(ev.at).toLocaleString(lang === "ja" ? "ja-JP" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} {ev.text}</li>)}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Correct({ entry, onSave }: { entry: Entry; onSave: (b: { clockIn: string; clockOut: string }) => void }) {
  const { t } = useI18n();
  const [inT, setIn] = useState(entry.clockIn);
  const [outT, setOut] = useState(entry.clockOut ?? "");
  return (
    <form className="flex flex-wrap items-end gap-3 rounded-lg border-2 p-3" onSubmit={(e) => { e.preventDefault(); onSave({ clockIn: inT, clockOut: outT }); }}>
      <div><Label htmlFor={`in-${entry.id}`}>{t("clockInLabel")}</Label><Input id={`in-${entry.id}`} type="time" value={inT} onChange={(e) => setIn(e.target.value)} required /></div>
      <div><Label htmlFor={`out-${entry.id}`}>{t("clockOutLabel")}</Label><Input id={`out-${entry.id}`} type="time" value={outT} onChange={(e) => setOut(e.target.value)} required /></div>
      <Button type="submit" size="sm">{t("saveCorrection")}</Button>
    </form>
  );
}
