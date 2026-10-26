/**
 * 「経費と利益」。今月の売り上げ・経費・給与・利益と、経費の記録。帳簿（CSV）の書き出し。
 * 声で「タオル代3000円」と言っても記録できる（エージェントの add_expense）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";
import { EXPENSE_CATEGORIES } from "@shared/schema";
import type { Money } from "@shared/money";

type Data = {
  expenses: { id: number; date: string; amount: Money; label: string; memo: string }[];
  profit: { sales: Money; expenses: Money; payroll: Money; profit: Money };
};

export function BooksCard({ today, hasStaff }: { today: string; hasStaff: boolean }) {
  const { t, lang } = useI18n();
  const key = `/api/owner/expenses?lang=${lang}`;
  const q = useQuery<Data>({ queryKey: [key] });
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("supplies");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: [key] });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await apiRequest("POST", "/api/owner/expenses", { date, amount: Number(amount), category, memo });
      setAmount(""); setMemo(""); await refresh();
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : t("error")); }
  }
  const p = q.data?.profit;
  const year = today.slice(0, 4);
  return (
    <Card className="sm:col-span-2">
      <CardHeader><CardTitle>{t("booksTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {p && (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div><dt className="text-sm">{t("salesLabel")}</dt><dd className="font-semibold">{p.sales.display}</dd></div>
            <div><dt className="text-sm">{t("expensesLabel")}</dt><dd className="font-semibold">{p.expenses.display}</dd></div>
            {hasStaff && <div><dt className="text-sm">{t("payrollLabel")}</dt><dd className="font-semibold">{p.payroll.display}</dd></div>}
            <div><dt className="text-sm">{t("profitLabel")}</dt><dd className="font-bold text-xl" data-testid="text-profit">{p.profit.display}</dd></div>
          </dl>
        )}
        <p className="text-sm text-muted-foreground">{t("booksHint")}</p>
        <form onSubmit={add} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[10rem_8rem_10rem_minmax(10rem,1fr)_auto] items-end">
          <div><Label htmlFor="ex-date">{t("expenseDate")}</Label><Input id="ex-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
          <div><Label htmlFor="ex-amount">{t("expenseAmount")}</Label><Input id="ex-amount" type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} required data-testid="input-expense-amount" /></div>
          <div>
            <Label htmlFor="ex-cat">{t("expenseCategory")}</Label>
            <select id="ex-cat" className="flex min-h-12 w-full rounded-md border-2 border-input bg-card px-3 py-2" value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(EXPENSE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v[lang]}</option>)}
            </select>
          </div>
          <div><Label htmlFor="ex-memo">{t("expenseMemo")}</Label><Input id="ex-memo" value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-expense-memo" /></div>
          <Button type="submit" data-testid="button-add-expense">{t("addExpense")}</Button>
        </form>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {q.data?.expenses.length ? (
          <ul className="divide-y">
            {q.data.expenses.slice().reverse().map((e) => (
              <li key={e.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span>{e.date} · {e.label}{e.memo ? ` · ${e.memo}` : ""}</span>
                <span className="flex items-center gap-2"><span className="font-semibold">{e.amount.display}</span>
                  <Button size="sm" variant="ghost" aria-label={`${t("deleteExpense")}: ${e.memo || e.label} ${e.amount.display}`} onClick={async () => { await apiRequest("DELETE", `/api/owner/expenses/${e.id}`); await refresh(); }}>{t("deleteExpense")}</Button></span>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">{q.isLoading ? t("loading") : t("noExpenses")}</p>}
        <p><a className="underline" href={`/api/owner/ledger.csv?year=${year}&lang=${lang}`} data-testid="link-ledger">{t("ledgerCsv", { year })}</a></p>
      </CardContent>
    </Card>
  );
}
