/**
 * 経費と帳簿。一人のお店の確定申告に要るところだけ。
 * - 経費は声（「タオル代3000円」）でも画面でも記録する。科目は確定申告の科目に合わせる
 * - 利益 = 売り上げ（受け取った額）− 経費 − スタッフの給与（計算）
 * - 帳簿は年ごとに CSV で書き出す（Excel で開けるよう BOM つき）。売り上げ・経費・給与を日付順に1行ずつ
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Owner, Language, ExpenseCategory } from "@shared/schema";
import { EXPENSE_CATEGORIES } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import { money, toMajor, toMinor } from "@shared/money";
import * as storage from "./storage";
import { requireOwner, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { salesSummaryFor, todayFor } from "./services";
import { payrollFor } from "./staff";
import { isValidDate, monthRange } from "./lib/time";
import { guessCategory } from "./lib/expense";

export const categoryLabel = (c: string, lang: Language) => (EXPENSE_CATEGORIES[c as ExpenseCategory] ?? EXPENSE_CATEGORIES.other)[lang];

export async function addExpenseFor(owner: Owner, input: { date?: string; amountMinor: number; category?: string; memo?: string }) {
  const date = input.date || todayFor(owner);
  if (!isValidDate(date)) throw new ApiError("invalid_date");
  if (!(input.amountMinor > 0)) throw new ApiError("validation");
  // 科目を言われなければ、内容のことばから当てる（タオル代→消耗品費 など）
  const category = input.category && input.category in EXPENSE_CATEGORIES ? input.category : guessCategory(input.memo ?? "");
  return storage.createExpense({ ownerId: owner.id, date, amount: input.amountMinor, category, memo: (input.memo ?? "").trim().slice(0, 200) });
}

/** 期間の月（YYYY-MM）の並び */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}

/** 期間の利益：売り上げ − 経費（科目ごと）− 給与 */
export async function profitFor(owner: Owner, from: string, to: string, lang: Language) {
  const cur = owner.currency;
  const sales = await salesSummaryFor(owner, from, to, lang);
  const list = await storage.listExpenses(owner.id, from, to);
  const byCat = new Map<string, number>();
  for (const e of list) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount);
  const expenseTotal = list.reduce((a, e) => a + e.amount, 0);
  let payroll = 0;
  for (const month of monthsBetween(from, to)) payroll += (await payrollFor(owner, month, lang)).totalMinor;
  const salesMinor = toMinor(sales.total.amount, cur);
  return {
    from, to, sales: sales.total, expenses: money(expenseTotal, cur, lang), payroll: money(payroll, cur, lang),
    profit: money(salesMinor - expenseTotal - payroll, cur, lang),
    byCategory: Array.from(byCat.entries()).map(([c, n]) => ({ category: c, label: categoryLabel(c, lang), total: money(n, cur, lang) })),
  };
}

/** 帳簿の行（日付順）。収入は受け取った売り上げ、支出は経費と給与 */
export async function ledgerFor(owner: Owner, year: number, lang: Language) {
  const ja = lang === "ja";
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const rows: { date: string; kind: "income" | "expense"; account: string; memo: string; amount: number }[] = [];
  for (const r of await storage.listReservationsByDates(owner.id, owner.timezone, from, to, true)) {
    if (!(r.paymentStatus === "paid" || r.paymentStatus === "onsite_received") || r.status === "cancelled" || !r.amountReceived) continue;
    const v = storage.reservationView(r, owner.timezone, lang);
    rows.push({ date: v.date, kind: "income", account: ja ? "売上" : "Sales", memo: `${v.customerName}${ja ? "様" : ""}${v.menuName ? ` ${v.menuName}` : ""}${r.paymentStatus === "paid" ? (ja ? "（カード）" : " (card)") : ""}`, amount: r.amountReceived });
  }
  for (const t of await storage.listTicketsSold(owner.id, from, to)) {
    if (!t.price) continue;
    const c = await storage.getCustomer(owner.id, t.customerId);
    rows.push({ date: t.soldDate, kind: "income", account: ja ? "売上" : "Sales", memo: `${c?.name ?? ""}${ja ? "様" : ""} ${t.name}${ja ? "（回数券・前払いの販売）" : " (ticket / prepaid sale)"}`, amount: t.price });
  }
  for (const e of await storage.listExpenses(owner.id, from, to)) rows.push({ date: e.date, kind: "expense", account: categoryLabel(e.category, lang), memo: e.memo, amount: e.amount });
  const today = todayFor(owner);
  for (const month of monthsBetween(from, to < today ? to : today)) {
    const p = await payrollFor(owner, month, lang);
    for (const s of p.staff) if (s.totalMinor > 0) rows.push({ date: monthRange(`${month}-01`).to, kind: "expense", account: ja ? "給料賃金" : "Wages", memo: ja ? `${s.name}さん ${month.replace("-", "年")}月分（計算）` : `${s.name}, ${month} (calculated)`, amount: s.totalMinor });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "income" ? -1 : 1));
}

const csvCell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function ledgerCsv(owner: Owner, year: number, lang: Language): Promise<string> {
  const ja = lang === "ja";
  const head = ja ? ["日付", "区分", "科目", "摘要", "収入", "支出"] : ["Date", "Type", "Account", "Memo", "Income", "Expense"];
  const rows = await ledgerFor(owner, year, lang);
  const amt = (n: number) => String(toMajor(n, owner.currency));
  const lines = [head, ...rows.map((r) => [r.date, r.kind === "income" ? (ja ? "収入" : "Income") : (ja ? "支出" : "Expense"), r.account, r.memo, r.kind === "income" ? amt(r.amount) : "", r.kind === "expense" ? amt(r.amount) : ""])];
  return "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------- 画面の API ----------

function handle(fn: (req: Request, res: Response, owner: Owner, lang: Language) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(req.query.lang ?? req.body?.lang ?? owner.language);
    try { await fn(req, res, owner, lang); }
    catch (e) { sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e); }
  };
}

function period(owner: Owner, q: Record<string, unknown>) {
  const m = monthRange(todayFor(owner));
  const from = String(q.from ?? m.from), to = String(q.to ?? m.to);
  if (!isValidDate(from) || !isValidDate(to) || from > to) throw new ApiError("invalid_date");
  return { from, to };
}

export function registerBooksRoutes(app: Express) {
  app.get("/api/owner/expenses", requireOwner, handle(async (req, res, owner, lang) => {
    const { from, to } = period(owner, req.query);
    const list = await storage.listExpenses(owner.id, from, to);
    res.json({ ok: true, from, to, expenses: list.map((e) => ({ id: e.id, date: e.date, amount: money(e.amount, owner.currency, lang), category: e.category, label: categoryLabel(e.category, lang), memo: e.memo })), profit: await profitFor(owner, from, to, lang) });
  }));
  app.post("/api/owner/expenses", requireOwner, handle(async (req, res, owner) => {
    const b = z.object({ date: z.string().optional(), amount: z.number().positive(), category: z.string().optional(), memo: z.string().max(200).optional() }).parse(req.body);
    const e = await addExpenseFor(owner, { date: b.date, amountMinor: toMinor(b.amount, owner.currency), category: b.category, memo: b.memo });
    res.status(201).json({ ok: true, id: e.id });
  }));
  app.delete("/api/owner/expenses/:id", requireOwner, handle(async (req, res, owner) => {
    if (!(await storage.deleteExpense(owner.id, Number(req.params.id)))) throw new ApiError("not_found", 404);
    res.json({ ok: true });
  }));
  app.get("/api/owner/ledger.csv", requireOwner, handle(async (req, res, owner, lang) => {
    const year = Number(req.query.year ?? todayFor(owner).slice(0, 4));
    if (!(year >= 2000 && year <= 2100)) throw new ApiError("validation");
    res.type("text/csv; charset=utf-8").setHeader("Content-Disposition", `attachment; filename="ledger-${year}.csv"`);
    res.send(await ledgerCsv(owner, year, lang));
  }));
}
