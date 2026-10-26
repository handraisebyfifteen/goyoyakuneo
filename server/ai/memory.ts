/**
 * ご予約ちゃんが会話で覚えること。オーナーの好み・決まりごと・お店の事情を短い一文で残し、次の会話の指示文に入れる。
 * - 覚えるのは AI（remember）。オーナーが「覚えて」と言ったときだけでなく、「次から〜して」「〜はいらない」「いつも〜」のような言い方でも覚える
 * - 合言葉・パスワード・カード番号のような秘密は覚えない（ここでもはじく）
 * - 似た内容があれば置き換える。多くなりすぎたら古いものから使わない（指示文には新しい順に MAX_IN_PROMPT 件）
 */
import type { Owner } from "@shared/schema";
import * as storage from "../storage";

export const MAX_MEMORIES = 100;
const MAX_IN_PROMPT = 30;
const SECRET = /(合言葉|あいことば|パスワード|password|passphrase|暗証|カード番号|card number|\b\d{12,19}\b)/i;

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s、。，．,.!?！？「」]/g, "");

/** 覚える。秘密らしいものは断る。ほぼ同じ内容がすでにあれば置き換える */
export async function rememberFor(owner: Owner, content: string, replaceId?: number): Promise<{ ok: true; id: number } | { ok: false; reason: "secret" | "empty" }> {
  const text = content.trim().slice(0, 300);
  if (!text) return { ok: false, reason: "empty" };
  if (SECRET.test(text)) return { ok: false, reason: "secret" };
  const all = await storage.listMemories(owner.id);
  const same = all.find((m) => m.id === replaceId) ?? all.find((m) => norm(m.content) === norm(text));
  if (same) await storage.deleteMemory(owner.id, same.id);
  // 多くなりすぎたら、いちばん古いものを消す
  if (all.length - (same ? 1 : 0) >= MAX_MEMORIES) await storage.deleteMemory(owner.id, all.find((m) => m.id !== same?.id)!.id);
  const m = await storage.addMemory(owner.id, text);
  return { ok: true, id: m.id };
}

/** 指示文に入れる「覚えていること」（新しい順） */
export async function memoriesForPrompt(owner: Owner): Promise<{ id: number; content: string }[]> {
  const all = await storage.listMemories(owner.id);
  return all.slice(-MAX_IN_PROMPT).reverse().map((m) => ({ id: m.id, content: m.content }));
}
