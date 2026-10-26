/**
 * 管理画面のスタッフ欄。登録・権限（施術する・指名・フリー・受けられるコース・役割）・招待・在籍、勤務時間。
 * 声でも同じことができる（エージェントの create_staff / update_staff）。ここは画面で確かめたり直したりする場所。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import type { PublicStaff } from "@shared/schema";
import { toMajor } from "@shared/money";

type Row = PublicStaff & { working: boolean };
type MenuLite = { id: number; name: string; active: boolean };
type Sheet = { staffId: number; name: string; hours: number; days: number; working: boolean };

export function StaffCard({ menus, allowNomination, currency }: { menus: MenuLite[]; allowNomination: boolean; currency: string }) {
  const { t, lang } = useI18n();
  const list = useQuery<{ staff: Row[]; seats: number }>({ queryKey: ["/api/owner/staff"] });
  const sheet = useQuery<{ staff: Sheet[] }>({ queryKey: ["/api/owner/timesheet"] });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [editing, setEditing] = useState<number | null>(null);

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["/api/owner/staff"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/owner/timesheet"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }),
  ]);
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : t("error")); }
  };

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await run(async () => {
      const r = await apiRequest<{ invite: { path: string } | null }>("POST", "/api/owner/staff", { name, email: email || null, lang });
      setInviteUrl(r.invite ? window.location.origin + r.invite.path : "");
      setName(""); setEmail("");
    });
  }
  const patch = (id: number, body: Record<string, unknown>) => run(() => apiRequest("PATCH", `/api/owner/staff/${id}`, { ...body, lang }));
  const invite = (id: number) => run(async () => {
    const r = await apiRequest<{ path: string }>("POST", `/api/owner/staff/${id}/invite`, { lang });
    setInviteUrl(window.location.origin + r.path);
  });

  const activeMenus = menus.filter((m) => m.active);
  const hours = (id: number) => sheet.data?.staff.find((x) => x.staffId === id);

  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("staffTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 h-5 w-5" checked={allowNomination} data-testid="checkbox-allow-nomination"
            onChange={(e) => run(() => apiRequest("PATCH", "/api/owner/settings", { allowNomination: e.target.checked }))} />
          <span>{t("allowNomination")}</span>
        </label>
        {list.data && <p className="text-sm text-muted-foreground" data-testid="text-seats">{t("seats", { n: list.data.seats })}</p>}

        {list.data?.staff.length ? (
          <ul className="divide-y">
            {list.data.staff.map((s) => {
              const h = hours(s.id);
              return (
                <li key={s.id} className="py-3 space-y-2" data-testid={`row-staff-${s.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold">{s.name}</span>
                      {s.isOwner && <span className="text-sm text-muted-foreground">（{t("ownerSelf")}）</span>}
                      <span className="text-sm ml-2">
                        {[!s.active && t("inactive"), s.working && t("working"), s.canLogin && t("canLogin"), s.invited && t("invited")].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {h && <span className="text-sm">{t("hoursDays", { days: h.days, hours: h.hours })}</span>}
                  </div>
                  <Button variant="outline" size="sm" aria-expanded={editing === s.id} onClick={() => setEditing(editing === s.id ? null : s.id)}>{t("editStaff", { name: s.name })}</Button>
                  {editing === s.id && (
                    <fieldset className="rounded-lg border-2 p-3 space-y-2">
                      <legend className="px-1 font-semibold">{t("editStaff", { name: s.name })}</legend>
                      <TextField id={`name-${s.id}`} label={t("staffName")} value={s.name} onSave={(v) => v && patch(s.id, { name: v })} />
                      {([["treats", "treats"], ["acceptNominated", "acceptNominated"], ["acceptFree", "acceptFree"]] as const).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-3">
                          <input type="checkbox" className="h-5 w-5" checked={s[key]} onChange={(e) => patch(s.id, { [key]: e.target.checked })} />
                          <span>{t(label)}</span>
                        </label>
                      ))}
                      <fieldset className="space-y-1">
                        <legend className="text-sm font-semibold">{t("menusAllowed")}</legend>
                        <label className="flex items-center gap-3">
                          <input type="checkbox" className="h-5 w-5" checked={!s.menuIds} onChange={(e) => patch(s.id, { menuIds: e.target.checked ? null : activeMenus.map((m) => m.id) })} />
                          <span>{t("allMenus")}</span>
                        </label>
                        {s.menuIds && activeMenus.map((m) => (
                          <label key={m.id} className="flex items-center gap-3 ml-6">
                            <input type="checkbox" className="h-5 w-5" checked={s.menuIds!.includes(m.id)}
                              onChange={(e) => patch(s.id, { menuIds: e.target.checked ? [...s.menuIds!, m.id] : s.menuIds!.filter((x) => x !== m.id) })} />
                            <span>{m.name}</span>
                          </label>
                        ))}
                      </fieldset>
                      {!s.isOwner && (
                        <>
                          <div>
                            <Label htmlFor={`role-${s.id}`}>{t("role")}</Label>
                            <select id={`role-${s.id}`} className="flex min-h-11 w-full rounded-md border-2 border-input bg-card px-3 py-2" value={s.role} onChange={(e) => patch(s.id, { role: e.target.value })}>
                              <option value="staff">{t("roleStaff")}</option>
                              <option value="manager">{t("roleManager")}</option>
                            </select>
                          </div>
                          <TextField id={`email-${s.id}`} type="email" label={t("staffEmail")} value={s.email ?? ""} onSave={(v) => patch(s.id, { email: v || null })} />
                          <PayFields id={s.id} currency={currency} staff={s} onSave={(body) => patch(s.id, body)} />
                          <div className="flex flex-wrap gap-2">
                            {s.email && s.active && !s.canLogin && <Button size="sm" onClick={() => invite(s.id)} data-testid={`button-invite-${s.id}`}>{t("sendInvite")}</Button>}
                            <Button size="sm" variant={s.active ? "destructive" : "outline"} onClick={() => patch(s.id, { active: !s.active })}>{t(s.active ? "removeStaff" : "restoreStaff")}</Button>
                          </div>
                        </>
                      )}
                    </fieldset>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {inviteUrl && (
          <div className="rounded-lg bg-accent text-accent-foreground p-3 space-y-1" role="status">
            <p>{t("inviteMade")}</p>
            <p className="break-all text-sm" data-testid="text-invite-url">{inviteUrl}</p>
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(inviteUrl)}>{t("copyUrl")}</Button>
          </div>
        )}

        <form onSubmit={add} className="space-y-2 rounded-lg border-2 p-3">
          <p className="font-semibold">{t("addStaff")}</p>
          <div><Label htmlFor="staff-name">{t("staffName")}</Label><Input id="staff-name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="input-staff-name" /></div>
          <div><Label htmlFor="staff-email">{t("staffEmail")}</Label><Input id="staff-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-staff-email" /></div>
          <Button type="submit" data-testid="button-add-staff">{t("addStaff")}</Button>
        </form>
        {error && <p role="alert" className="text-destructive font-semibold">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** 給与の設定（時給・指名料・歩合）。金額は普通の金額で入れる */
function PayFields({ id, currency, staff, onSave }: { id: number; currency: string; staff: PublicStaff; onSave: (b: Record<string, number>) => void }) {
  const { t } = useI18n();
  const [hourly, setHourly] = useState(String(toMajor(staff.hourlyWage, currency)));
  const [nom, setNom] = useState(String(toMajor(staff.nominationFee, currency)));
  const [com, setCom] = useState(String(staff.commissionPercent));
  return (
    <form className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] items-end" onSubmit={(e) => { e.preventDefault(); onSave({ hourlyWage: Number(hourly) || 0, nominationFee: Number(nom) || 0, commissionPercent: Number(com) || 0 }); }}>
      <div><Label htmlFor={`hw-${id}`}>{t("payHourly")}</Label><Input id={`hw-${id}`} type="number" min="0" step="any" value={hourly} onChange={(e) => setHourly(e.target.value)} /></div>
      <div><Label htmlFor={`nf-${id}`}>{t("payNomination")}</Label><Input id={`nf-${id}`} type="number" min="0" step="any" value={nom} onChange={(e) => setNom(e.target.value)} /></div>
      <div><Label htmlFor={`cp-${id}`}>{t("payCommission")}</Label><Input id={`cp-${id}`} type="number" min="0" max="100" value={com} onChange={(e) => setCom(e.target.value)} /></div>
      <Button type="submit" variant="outline" size="sm">{t("paySave")}</Button>
    </form>
  );
}

function TextField({ id, label, value, type = "text", onSave }: { id: string; label: string; value: string; type?: string; onSave: (v: string) => void }) {
  const { t } = useI18n();
  const [v, setV] = useState(value);
  return (
    <form className="flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); }}>
      <div className="flex-1"><Label htmlFor={id}>{label}</Label><Input id={id} type={type} value={v} onChange={(e) => setV(e.target.value)} /></div>
      <Button type="submit" variant="outline" size="sm">{t("save")}</Button>
    </form>
  );
}
