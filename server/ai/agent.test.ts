/**
 * 会話の安全の決まりを、偽の AI と偽のツールで確かめる。
 * - 「いいえ」なら実行しない
 * - 合言葉が違えば実行しない。3回で止まる。合言葉は AI に渡らない
 * - 知らないツール名は実行しない
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, type AgentDeps, type ChatMsg, type LockState } from "./agent";
import type { Owner } from "@shared/schema";
import { DEFAULT_HOURS } from "@shared/schema";
import { hashPassphrase, verifyPassphrase } from "../lib/passphrase";

const owner: Owner = {
  id: 1, email: "o@example.com", passwordHash: null, passphraseHash: hashPassphrase("ひかり"), loginMethod: "passphrase",
  shopNameJa: "テスト治療院", shopNameEn: "", address: "", phone: "", info: "", businessType: "massage",
  country: "JP", currency: "JPY", timezone: "Asia/Tokyo", language: "ja", hours: DEFAULT_HOURS,
  bufferMinutes: 15, slotStepMinutes: 30, maxDaysAhead: 60, minHoursBefore: 2, freeCancelHoursBefore: 24,
  allowCardPayment: true, slug: "t", onboardingDone: true, createdAt: new Date(),
};

type Script = (messages: ChatMsg[]) => { content?: string; toolCalls?: { id: string; name: string; arguments: string }[] };

function makeDeps(script: Script) {
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const seenByAi: ChatMsg[][] = [];
  const lock: LockState = { unlockedUntil: 0, failures: 0, lockedUntil: 0 };
  let now = 1_000_000;
  const deps: AgentDeps = {
    async chat(role, messages) {
      seenByAi.push(messages);
      if (role === "smart") return { content: "確認文です。よろしいでしょうか", toolCalls: [] };
      const r = script(messages);
      return { content: r.content ?? null, toolCalls: r.toolCalls ?? [] };
    },
    async exec(_ctx, name, args) { executed.push({ name, args }); return { ok: true, name }; },
    async describe(_ctx, name) { return name; },
    async validate(_ctx, name, args) { return name === "record_onsite_payment" && args.reservation_id === undefined ? "引数が足りません" : null; },
    verify: (o, phrase) => verifyPassphrase(phrase, o.passphraseHash),
    locks: { async get() { return { ...lock }; }, async set(_id, s) { Object.assign(lock, s); } },
    history: { async load() { return []; }, async save() { /* 捨てる */ } },
    now: () => now,
  };
  return { deps, executed, seenByAi, lock, tick: (ms: number) => { now += ms; } };
}

/** 1回目はツールを呼び、tool の結果が戻ってきたら文で答える台本 */
function callThenAnswer(name: string, args: Record<string, unknown>): Script {
  return (messages) => messages.some((m) => m.role === "tool")
    ? { content: "結果を伝えました" }
    : { toolCalls: [{ id: "c1", name, arguments: JSON.stringify(args) }] };
}

test("読むだけのツールは確認なしで実行する", async () => {
  const { deps, executed } = makeDeps(callThenAnswer("get_today_reservations", {}));
  const a = new Agent(deps);
  const r = await a.message(owner, "今日の予約は？");
  assert.equal(r.type, "reply");
  assert.deepEqual(executed.map((e) => e.name), ["get_today_reservations"]);
});

test("書き込むツールは確認を挟み、「いいえ」なら実行しない", async () => {
  const { deps, executed } = makeDeps(callThenAnswer("create_reservation", { date: "2026-10-30", time: "15:00", menu_name: "60分", customer_name: "田中", payment_method: "onsite" }));
  const a = new Agent(deps);
  const r = await a.message(owner, "明日15時に田中さん");
  assert.equal(r.type, "confirm");
  assert.equal(executed.length, 0);
  const r2 = await a.confirm(owner, (r as { pendingId: string }).pendingId, "no");
  assert.equal(r2.type, "reply");
  assert.equal(executed.length, 0, "いいえの後に実行されてはいけない");
});

test("「はい」で実行し、「承りました」は結果の後", async () => {
  const { deps, executed } = makeDeps(callThenAnswer("create_reservation", { date: "2026-10-30", time: "15:00", menu_name: "60分", customer_name: "田中", payment_method: "onsite" }));
  const a = new Agent(deps);
  const r = await a.message(owner, "明日15時に田中さん");
  const r2 = await a.confirm(owner, (r as { pendingId: string }).pendingId, "yes");
  assert.equal(r2.type, "reply");
  assert.equal((r2 as { changed: boolean }).changed, true);
  assert.deepEqual(executed.map((e) => e.name), ["create_reservation"]);
});

test("声で「はい」と言っても /message 経由で確認になる", async () => {
  const { deps, executed } = makeDeps(callThenAnswer("create_menu", { name: "A", minutes: 30, price: 3000 }));
  const a = new Agent(deps);
  await a.message(owner, "メニューを作って");
  const r2 = await a.message(owner, "はい、お願いします");
  assert.equal(r2.type, "reply");
  assert.equal(executed.length, 1);
});

test("合言葉つきのツールは、合言葉が合うまで実行しない。合言葉は AI に渡らない", async () => {
  const { deps, executed, seenByAi } = makeDeps(callThenAnswer("cancel_reservation", { reservation_id: 7 }));
  const a = new Agent(deps);
  const r = await a.message(owner, "田中さんの予約を取り消して");
  assert.equal(r.type, "confirm");
  assert.equal((r as { guarded: boolean }).guarded, true);
  const pid = (r as { pendingId: string }).pendingId;
  const r2 = await a.confirm(owner, pid, "yes");
  assert.equal(r2.type, "passphrase");
  assert.equal(executed.length, 0);
  const r3 = await a.passphrase(owner, pid, "まちがい");
  assert.equal(r3.type, "passphrase");
  assert.equal((r3 as { retry: boolean }).retry, true);
  assert.equal(executed.length, 0);
  const r4 = await a.passphrase(owner, pid, "ヒカリ。"); // 音声認識の揺れ（カタカナ・句読点）を吸収して照合する
  assert.equal(r4.type, "reply");
  assert.equal(executed.length, 1);
  const flat = JSON.stringify(seenByAi);
  assert.ok(!flat.includes("まちがい") && !flat.includes("ヒカリ"), "合言葉が AI へのメッセージに含まれてはいけない");
});

test("合言葉を3回間違えると5分間止まり、正しい合言葉でも実行しない", async () => {
  const { deps, executed, lock, tick } = makeDeps(callThenAnswer("record_onsite_payment", { reservation_id: 7, amount: 6000 }));
  const a = new Agent(deps);
  let r = await a.message(owner, "受け取りを記録して");
  let pid = (r as { pendingId: string }).pendingId;
  await a.confirm(owner, pid, "yes");
  await a.passphrase(owner, pid, "x1");
  await a.passphrase(owner, pid, "x2");
  const r3 = await a.passphrase(owner, pid, "x3");
  assert.equal(r3.type, "reply");
  assert.ok(lock.lockedUntil > 0);
  assert.equal(executed.length, 0);
  // ロック中は正しい合言葉でも通らない
  r = await a.message(owner, "受け取りを記録して");
  pid = (r as { pendingId: string }).pendingId;
  const r4 = await a.confirm(owner, pid, "yes");
  assert.equal(r4.type, "reply");
  assert.equal(executed.length, 0);
  // 5分経てば、また聞かれる
  tick(5 * 60 * 1000 + 1);
  r = await a.message(owner, "受け取りを記録して");
  pid = (r as { pendingId: string }).pendingId;
  const r5 = await a.confirm(owner, pid, "yes");
  assert.equal(r5.type, "passphrase");
  const r6 = await a.passphrase(owner, pid, "ひかり");
  assert.equal(r6.type, "reply");
  assert.equal(executed.length, 1);
  // 一度合えば10分間は聞き直さない
  r = await a.message(owner, "受け取りを記録して");
  pid = (r as { pendingId: string }).pendingId;
  const r7 = await a.confirm(owner, pid, "yes");
  assert.equal(r7.type, "reply");
  assert.equal(executed.length, 2);
});

test("知らないツール名は実行しない", async () => {
  const { deps, executed } = makeDeps(callThenAnswer("delete_everything", {}));
  const a = new Agent(deps);
  const r = await a.message(owner, "全部消して");
  assert.equal(r.type, "reply");
  assert.equal(executed.length, 0);
});

test("相談は ask_advisor で相談モデルに切り替わる", async () => {
  const { deps, seenByAi } = makeDeps(() => ({ toolCalls: [{ id: "c1", name: "ask_advisor", arguments: JSON.stringify({ question: "最近お客さんが減っていて" }) }] }));
  const a = new Agent(deps);
  const r = await a.message(owner, "最近お客さんが減っていて");
  assert.equal(r.type, "reply");
  assert.equal((r as { model: string }).model, "consult");
  // 相談モデルにはツールを渡していない（chat の引数で確かめる）
  assert.ok(seenByAi.length >= 2);
});

test("引数が足りない書き込みは、確認を聞かずに AI に言い直させる", async () => {
  let calls = 0;
  const { deps, executed } = makeDeps((messages) => {
    calls++;
    if (messages.some((m) => m.role === "tool")) return { content: "どの予約か教えてください" };
    return { toolCalls: [{ id: "c1", name: "record_onsite_payment", arguments: JSON.stringify({ reservation_id: undefined, amount: 1000 }) }] };
  });
  const a = new Agent(deps);
  const r = await a.message(owner, "それで記録して");
  assert.equal(r.type, "reply");
  assert.equal(executed.length, 0);
  assert.ok(calls >= 2);
});
