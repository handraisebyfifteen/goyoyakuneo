/**
 * お札・硬貨の読み取り（目のモデル）。二重確認の片方で、結果は「参考」。
 * - 合計はサーバーで計算し直す。モデルの合計と合わなければ「自信なし」にする
 * - ここでは数えるだけ。受け取りの記録は record_onsite_payment（確認つき）で別に行う
 * - 写真は保存しない（メモリ上で読み取って捨てる）
 */
import type { Language } from "@shared/schema";
import { money, toMinor } from "@shared/money";
import { MODELS, client, stripThinking } from "./llm";

export type CashItem = { value: number; count: number }; // value は最小単位の整数
export type CashReading =
  | { ok: true; items: CashItem[]; total: number; confident: boolean; note: string }
  | { ok: false; error: "unreadable" | "no_cash" };

function prompt(currency: string): string {
  return [
    `Count the money (banknotes and coins) in the photo. The currency is ${currency}.`,
    "Answer with JSON only, no explanation, in exactly this shape:",
    '{"items": [{"value": <face value as a plain number>, "count": <number of pieces>}], "total": <sum>, "confident": true or false, "note": "<anything you noticed>"}',
    "Write face values and the total as ordinary amounts (a 10,000 yen note is 10000; a 20 dollar bill is 20; a quarter is 0.25).",
    "If anything overlaps, is cut off, is dark, or looks unlike real money, set confident to false.",
    "If there is no money in the photo, return an empty items list.",
  ].join("\n");
}

/** モデルの返事から JSON を取り出し、合計を自分で計算し直す */
export function parseCashJson(text: string, currency: string): CashReading {
  const m = stripThinking(text).match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "unreadable" };
  let raw: { items?: unknown; total?: unknown; confident?: unknown; note?: unknown };
  try { raw = JSON.parse(m[0]); } catch { return { ok: false, error: "unreadable" }; }
  const items: CashItem[] = [];
  if (!Array.isArray(raw.items)) return { ok: false, error: "unreadable" };
  for (const it of raw.items as { value?: unknown; count?: unknown }[]) {
    const count = Number.parseInt(String(it?.count ?? 0), 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    let value: number;
    try { value = toMinor(String(it?.value ?? ""), currency); } catch { return { ok: false, error: "unreadable" }; }
    if (value <= 0) continue;
    const same = items.find((x) => x.value === value);
    if (same) same.count += count; else items.push({ value, count });
  }
  if (!items.length) return { ok: false, error: "no_cash" };
  const total = items.reduce((a, i) => a + i.value * i.count, 0);
  let modelTotal = -1;
  try { modelTotal = toMinor(String(raw.total ?? ""), currency); } catch { modelTotal = -1; }
  const confident = raw.confident === true && modelTotal === total;
  items.sort((a, b) => b.value - a.value);
  return { ok: true, items, total, confident, note: typeof raw.note === "string" ? raw.note.slice(0, 300) : "" };
}

/** 料金との差：おつり、または不足（最小単位） */
export function cashChange(due: number, received: number): { change: number; short: number } {
  const diff = received - due;
  return { change: Math.max(diff, 0), short: Math.max(-diff, 0) };
}

/** 読み上げる文。「一万円札が1枚、合計一万円です。料金は六千円なので、おつりは四千円です。…」 */
export function spokenCash(reading: Extract<CashReading, { ok: true }>, due: number, currency: string, lang: Language): string {
  const d = (n: number) => money(n, currency, lang).display;
  const { change, short } = cashChange(due, reading.total);
  if (lang === "ja") {
    const parts = reading.items.map((i) => `${d(i.value)}が${i.count}枚`).join("、");
    const diff = change > 0 ? `おつりは${d(change)}です。` : short > 0 ? `${d(short)}足りません。` : "ちょうどです。";
    return `${parts}、合計${d(reading.total)}です。料金は${d(due)}なので、${diff}` +
      (reading.confident ? "" : "読み取りに自信がありません。") + "読み取りは参考です。手触りでもご確認ください。まだ記録していません。";
  }
  const parts = reading.items.map((i) => `${i.count} of ${d(i.value)}`).join(", ");
  const diff = change > 0 ? `so the change is ${d(change)}.` : short > 0 ? `so ${d(short)} is still short.` : "so it is exact.";
  return `${parts}, total ${d(reading.total)}. The price is ${d(due)}, ${diff}` +
    (reading.confident ? "" : " I am not confident in this reading.") + " The reading is a reference only. Please also check by touch. Nothing has been recorded yet.";
}

/** 目のモデルに写真を送って数える。失敗は例外ではなく ok: false で返す */
export async function readCash(dataUrl: string, currency: string): Promise<CashReading> {
  const res = await client().chat.completions.create({
    model: MODELS.vision,
    temperature: 0,
    max_tokens: 600,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt(currency) },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
  });
  return parseCashJson(res.choices[0]?.message?.content ?? "", currency);
}
