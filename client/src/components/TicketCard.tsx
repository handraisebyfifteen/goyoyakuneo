/**
 * 「回数券・前払い」。券の種類（一度決めておけば売るときは選ぶだけ。AI の相談役と相談して決めてもよい）、
 * 売った券の一覧（残り）、売ったことの記録。使うのは声か、お会計で QR を読み取って。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import type { Money } from "@shared/money";

type TicketType = { id: number; name: string; kind: string; menuName: string | null; size: number | Money; price: Money; validDays: number | null; active: boolean };
type Ticket = { id: number; customerName: string; kind: string; name: string; remaining: number | Money; price: Money; soldDate: string; expiresOn: string | null; usable: boolean };

export function TicketCard({ menus }: { menus: { id: number; name: string; active: boolean }[] }) {
  const { t, lang } = useI18n();
  const key = `/api/owner/tickets?lang=${lang}`;
  const q = useQuery<{ tickets: Ticket[] }>({ queryKey: [key] });
  const typesKey = `/api/owner/ticket-types?lang=${lang}`;
  const types = useQuery<{ types: TicketType[] }>({ queryKey: [typesKey] });
  const activeTypes = types.data?.types.filter((x) => x.active) ?? [];
  const [typeId, setTypeId] = useState("");
  useEffect(() => { if (!typeId && activeTypes.length) setTypeId(String(activeTypes[0].id)); }, [types.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nt, setNt] = useState({ name: "", kind: "count", count: "5", amount: "", price: "", menuId: "", validDays: "" });
  const [f, setF] = useState({ customerName: "", customerPhone: "", kind: "count", name: "", count: "5", amount: "", price: "", menuId: "", expiresOn: "" });
  const [error, setError] = useState("");
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));

  async function addType(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await apiRequest("POST", "/api/owner/ticket-types", {
        name: nt.name, kind: nt.kind, count: nt.kind === "count" ? Number(nt.count) : undefined, amount: nt.kind === "credit" ? Number(nt.amount) : undefined,
        price: Number(nt.price), menuId: nt.menuId ? Number(nt.menuId) : null, validDays: nt.validDays ? Number(nt.validDays) : null,
      });
      setNt((o) => ({ ...o, name: "", price: "", amount: "" }));
      await queryClient.invalidateQueries({ queryKey: [typesKey] });
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
  }

  async function sell(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (typeId) {
        await apiRequest("POST", "/api/owner/tickets", { customerName: f.customerName, customerPhone: f.customerPhone || undefined, typeId: Number(typeId) });
        setF((o) => ({ ...o, customerName: "", customerPhone: "" }));
        await queryClient.invalidateQueries({ queryKey: [key] });
        return;
      }
      await apiRequest("POST", "/api/owner/tickets", {
        customerName: f.customerName, customerPhone: f.customerPhone || undefined, kind: f.kind, name: f.name,
        count: f.kind === "count" ? Number(f.count) : undefined, amount: f.kind === "credit" ? Number(f.amount) : undefined,
        price: Number(f.price), menuId: f.menuId ? Number(f.menuId) : null, expiresOn: f.expiresOn || null,
      });
      setF((o) => ({ ...o, customerName: "", customerPhone: "", name: "", price: "", amount: "" }));
      await queryClient.invalidateQueries({ queryKey: [key] });
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
  }
  // 券の QR コードのページを、共有画面（LINE・メッセージなど）でお客さんに送る。共有できない端末ではコピー
  async function sendPass(x: Ticket) {
    const { url } = await apiRequest<{ url: string }>("POST", `/api/owner/tickets/${x.id}/pass`);
    if (typeof navigator.share === "function") { try { await navigator.share({ title: x.name, text: t("passHint"), url }); } catch { /* 閉じられた */ } }
    else navigator.clipboard?.writeText(url);
  }
  const left = (x: Ticket) => (typeof x.remaining === "number" ? `${x.remaining}` : x.remaining.display);
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("ticketsTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("ticketsHint")}</p>
        <section aria-labelledby="h-ttypes" className="space-y-2">
          <h3 id="h-ttypes" className="font-bold">{t("ticketTypesTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("ticketTypesHint")}</p>
          {types.data?.types.length ? (
            <ul className="divide-y">
              {types.data.types.map((x) => (
                <li key={x.id} className={`py-2 flex flex-wrap items-center justify-between gap-2 ${x.active ? "" : "text-muted-foreground"}`}>
                  <span><span className="font-semibold">{x.name}</span> · {typeof x.size === "number" ? t("typeCount", { n: x.size }) : x.size.display}{x.menuName ? ` · ${x.menuName}` : ""} · {x.price.display}{x.validDays ? ` · ${t("typeValid", { n: x.validDays })}` : ""}{x.active ? "" : ` · ${t("couponStopped")}`}</span>
                  {x.active && <Button size="sm" variant="ghost" onClick={async () => { await apiRequest("POST", `/api/owner/ticket-types/${x.id}/stop`); await queryClient.invalidateQueries({ queryKey: [typesKey] }); }}>{t("typeStop")}</Button>}
                </li>
              ))}
            </ul>
          ) : null}
          <details>
            <summary className="cursor-pointer">{t("typeAdd")}</summary>
            <form onSubmit={addType} className="mt-2 grid gap-2 sm:grid-cols-2">
              <div><Label htmlFor="tt-name">{t("typeName")}</Label><Input id="tt-name" value={nt.name} onChange={(e) => setNt((o) => ({ ...o, name: e.target.value }))} required /></div>
              <fieldset className="flex items-end gap-4">
                {(["count", "credit"] as const).map((k) => (
                  <label key={k} className="flex items-center gap-2"><input type="radio" name="tt-kind" className="h-5 w-5" checked={nt.kind === k} onChange={() => setNt((o) => ({ ...o, kind: k }))} />{t(k === "count" ? "ticketKindCount" : "ticketKindCredit")}</label>
                ))}
              </fieldset>
              {nt.kind === "count"
                ? <div><Label htmlFor="tt-count">{t("ticketCount")}</Label><Input id="tt-count" type="number" min="1" value={nt.count} onChange={(e) => setNt((o) => ({ ...o, count: e.target.value }))} required /></div>
                : <div><Label htmlFor="tt-amount">{t("ticketAmount")}</Label><Input id="tt-amount" type="number" min="0" step="any" value={nt.amount} onChange={(e) => setNt((o) => ({ ...o, amount: e.target.value }))} required /></div>}
              <div><Label htmlFor="tt-price">{t("typePrice")}</Label><Input id="tt-price" type="number" min="0" step="any" value={nt.price} onChange={(e) => setNt((o) => ({ ...o, price: e.target.value }))} required /></div>
              {nt.kind === "count" && (
                <div>
                  <Label htmlFor="tt-menu">{t("menus")}</Label>
                  <select id="tt-menu" className="flex min-h-12 w-full rounded-md border-2 border-input bg-card px-3 py-2" value={nt.menuId} onChange={(e) => setNt((o) => ({ ...o, menuId: e.target.value }))}>
                    <option value="">{t("allMenus")}</option>
                    {menus.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              )}
              <div><Label htmlFor="tt-valid">{t("typeValidDays")}</Label><Input id="tt-valid" type="number" min="1" value={nt.validDays} onChange={(e) => setNt((o) => ({ ...o, validDays: e.target.value }))} /></div>
              <div className="sm:col-span-2"><Button type="submit" data-testid="button-add-type">{t("typeCreate")}</Button></div>
            </form>
          </details>
        </section>
        {q.data?.tickets.length ? (
          <ul className="divide-y">
            {q.data.tickets.map((x) => (
              <li key={x.id} className={`py-2 flex flex-wrap justify-between gap-2 ${x.usable ? "" : "text-muted-foreground"}`}>
                <span><span className="font-semibold">{x.customerName}</span> · {x.name}{x.expiresOn ? ` · 〜${x.expiresOn}` : ""}</span>
                <span className="flex flex-wrap items-center gap-2">{t("ticketLeft", { left: left(x) })} · {x.price.display}
                  {x.usable && <Button size="sm" variant="outline" onClick={() => sendPass(x)} aria-label={`${t("ticketPass")}: ${x.customerName} ${x.name}`}>{t("ticketPass")}</Button>}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">{q.isLoading ? t("loading") : t("noTickets")}</p>}
        <form onSubmit={sell} className="grid gap-2 sm:grid-cols-2 rounded-lg border-2 p-3">
          <div><Label htmlFor="tk-name">{t("ticketCustomer")}</Label><Input id="tk-name" value={f.customerName} onChange={(e) => set("customerName", e.target.value)} required /></div>
          <div><Label htmlFor="tk-phone">{t("ticketPhone")}</Label><Input id="tk-phone" type="tel" value={f.customerPhone} onChange={(e) => set("customerPhone", e.target.value)} /></div>
          {activeTypes.length > 0 && (
            <div className="sm:col-span-2">
              <Label htmlFor="tk-type">{t("typeChoose")}</Label>
              <select id="tk-type" className="flex min-h-12 w-full rounded-md border-2 border-input bg-card px-3 py-2" value={typeId} onChange={(e) => setTypeId(e.target.value)} data-testid="select-ticket-type">
                {activeTypes.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.price.display}</option>)}
                <option value="">{t("typeFree")}</option>
              </select>
            </div>
          )}
          {!typeId && <>
          <fieldset className="sm:col-span-2 flex gap-4">
            {(["count", "credit"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2"><input type="radio" name="tk-kind" className="h-5 w-5" checked={f.kind === k} onChange={() => set("kind", k)} />{t(k === "count" ? "ticketKindCount" : "ticketKindCredit")}</label>
            ))}
          </fieldset>
          <div><Label htmlFor="tk-title">{t("ticketName")}</Label><Input id="tk-title" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
          {f.kind === "count"
            ? <div><Label htmlFor="tk-count">{t("ticketCount")}</Label><Input id="tk-count" type="number" min="1" value={f.count} onChange={(e) => set("count", e.target.value)} required /></div>
            : <div><Label htmlFor="tk-amount">{t("ticketAmount")}</Label><Input id="tk-amount" type="number" min="0" step="any" value={f.amount} onChange={(e) => set("amount", e.target.value)} required /></div>}
          <div><Label htmlFor="tk-price">{t("ticketPrice")}</Label><Input id="tk-price" type="number" min="0" step="any" value={f.price} onChange={(e) => set("price", e.target.value)} required /></div>
          {f.kind === "count" && (
            <div>
              <Label htmlFor="tk-menu">{t("menus")}</Label>
              <select id="tk-menu" className="flex min-h-12 w-full rounded-md border-2 border-input bg-card px-3 py-2" value={f.menuId} onChange={(e) => set("menuId", e.target.value)}>
                <option value="">{t("allMenus")}</option>
                {menus.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}
          <div><Label htmlFor="tk-exp">{t("ticketExpires")}</Label><Input id="tk-exp" type="date" value={f.expiresOn} onChange={(e) => set("expiresOn", e.target.value)} /></div>
          </>}
          <div className="sm:col-span-2"><Button type="submit" data-testid="button-sell-ticket">{t("sellTicket")}</Button></div>
        </form>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
