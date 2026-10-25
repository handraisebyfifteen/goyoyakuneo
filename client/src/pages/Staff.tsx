/**
 * スタッフ本人の画面：勤務の予定（入り・上がり）、出勤・退勤の打刻、予約の予定（staff は自分の分、manager は全員の分）。
 * 打刻の前に勤務の予定を決めておくと、その前後の打刻は「予定どおり」になる。外れた打刻もできるが、オーナーの確認に回る（そのことを先に伝える）。
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";

type Me = {
  staff: { name: string; role: string }; shopName: string; date: string;
  reservations: { id: number; time: string; endTime: string; customerName: string; menuName: string; staffName: string; status: string; notes: string | null }[];
  clockedInAt: string | null; clockedInTime: string | null; monthHours: number; monthDays: number;
  outlook: { next: "in" | "out"; planned: string | null; window: string | null; within: boolean; tolerance: number };
  today: string; plans: { date: string; planStart: string; planEnd: string }[];
};

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export default function Staff() {
  const { t, lang } = useI18n();
  const [, navigate] = useLocation();
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  const key = `/api/staff/me?lang=${lang}${date ? `&date=${date}` : ""}`;
  const me = useQuery<Me>({ queryKey: [key], retry: false });

  useEffect(() => {
    if (me.error instanceof ApiRequestError && me.error.status === 401) navigate("/login");
  }, [me.error, navigate]);

  async function clock(action: "in" | "out") {
    setError("");
    try { await apiRequest("POST", "/api/staff/clock", { action }); await queryClient.invalidateQueries({ queryKey: [key] }); }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : t("error")); }
  }
  async function savePlan(date: string, planStart: string, planEnd: string) {
    setError("");
    try { await apiRequest("PUT", "/api/staff/shifts", { date, planStart, planEnd, lang }); await queryClient.invalidateQueries({ queryKey: [key] }); }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : t("error")); }
  }
  async function logout() {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.clear();
    navigate("/");
  }

  const d = me.data;
  // 時刻はお店の時間帯で（サーバーが計算して渡す）
  const since = d?.clockedInTime ?? "";
  return (
    <Layout title={d ? `${d.shopName} · ${d.staff.name}` : t("staffHome")} right={<Button variant="ghost" size="sm" onClick={logout}>{t("logout")}</Button>}>
      {!d ? <p>{t("loading")}</p> : (
        <div className="space-y-6">
          <section className="rounded-xl border-2 p-5 text-center space-y-3" aria-labelledby="h-clock">
            <h2 id="h-clock" className="sr-only">{t("clockIn")}</h2>
            <p className="text-lg font-semibold" role="status" data-testid="text-clock-status">{d.clockedInAt ? t("clockedInSince", { time: since }) : t("notClockedIn")}</p>
            {d.clockedInAt
              ? <Button size="lg" variant="destructive" className="w-full max-w-xs h-16 text-xl" onClick={() => clock("out")} data-testid="button-clock-out">{t("clockOut")}</Button>
              : <Button size="lg" className="w-full max-w-xs h-16 text-xl" onClick={() => clock("in")} data-testid="button-clock-in">{t("clockIn")}</Button>}
            {d.outlook.planned
              ? <p>{t(d.outlook.next === "in" ? "plannedIn" : "plannedOut", { time: d.outlook.planned, window: d.outlook.window ?? "" })}</p>
              : d.outlook.next === "in" && <p className="font-semibold">{t("noPlanToday")}</p>}
            {d.outlook.planned && !d.outlook.within && <p className="font-semibold" data-testid="text-outside-window">{t("outsideWindow")}</p>}
            <p className="text-sm text-muted-foreground">{t("monthWork", { days: d.monthDays, hours: d.monthHours })}</p>
            {error && <p role="alert" className="text-destructive">{error}</p>}
          </section>

          <section aria-labelledby="h-plan" className="space-y-3">
            <h2 id="h-plan" className="text-xl font-bold">{t("planTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("planHint", { n: d.outlook.tolerance })}</p>
            <ul className="space-y-2">
              {Array.from({ length: 7 }, (_, i) => addDays(d.today, i)).map((date) => {
                const p = d.plans.find((x) => x.date === date);
                return <PlanRow key={`${date}-${p?.planStart}-${p?.planEnd}`} date={date} label={i18nDay(date, d.today, t)} plan={p} onSave={(planStart, planEnd) => savePlan(date, planStart, planEnd)} />;
              })}
            </ul>
          </section>

          <section aria-labelledby="h-schedule" className="space-y-3">
            <h2 id="h-schedule" className="text-xl font-bold">{d.staff.role === "manager" ? t("allSchedule") : t("mySchedule")} · {d.date}</h2>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDate(addDays(d.date, -1))}>{t("prevDay")}</Button>
              <Button variant="outline" onClick={() => setDate(addDays(d.date, 1))}>{t("nextDay")}</Button>
            </div>
            {d.reservations.length ? (
              <ul className="divide-y rounded-lg border-2">
                {d.reservations.map((r) => (
                  <li key={r.id} className="p-3">
                    <div><span className="font-bold text-lg">{r.time}</span> – {r.endTime} <span className="ml-2 font-semibold">{r.customerName}</span>{r.menuName && <span className="text-muted-foreground"> ({r.menuName})</span>}</div>
                    {d.staff.role === "manager" && r.staffName && <div className="text-sm">{t("staffLabel")}: {r.staffName}</div>}
                    {r.notes && <div className="text-sm whitespace-pre-wrap">{r.notes}</div>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-muted-foreground">{t("noReservations")}</p>}
          </section>
        </div>
      )}
    </Layout>
  );
}

function i18nDay(date: string, today: string, t: (k: string, p?: Record<string, string | number>) => string): string {
  return date === today ? `${t("todayLabel")}（${date.slice(5).replace("-", "/")}）` : date.slice(5).replace("-", "/");
}

function PlanRow({ date, label, plan, onSave }: { date: string; label: string; plan?: { planStart: string; planEnd: string }; onSave: (s: string, e: string) => void }) {
  const { t } = useI18n();
  const [start, setStart] = useState(plan?.planStart ?? "");
  const [end, setEnd] = useState(plan?.planEnd ?? "");
  const changed = start !== (plan?.planStart ?? "") || end !== (plan?.planEnd ?? "");
  return (
    <li>
      <form className="rounded-lg border-2 p-3 space-y-2" aria-label={t("planFor", { date: label })} onSubmit={(e) => { e.preventDefault(); if (start && end) onSave(start, end); }}>
        <p className="font-semibold">{label}</p>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
          <div><Label htmlFor={`ps-${date}`}>{t("planStart")}</Label><Input id={`ps-${date}`} type="time" step={300} value={start} onChange={(e) => setStart(e.target.value)} required className="w-full min-w-0 px-2" /></div>
          <div><Label htmlFor={`pe-${date}`}>{t("planEnd")}</Label><Input id={`pe-${date}`} type="time" step={300} value={end} onChange={(e) => setEnd(e.target.value)} required className="w-full min-w-0 px-2" /></div>
          <Button type="submit" variant={changed ? "default" : "outline"} disabled={!changed} data-testid={`button-plan-${date}`}>{t("save")}</Button>
        </div>
      </form>
    </li>
  );
}
