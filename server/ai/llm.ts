/**
 * Nebius Token Factory への接続と、使うモデルの名前（ここだけで管理する）。
 * AI は NVIDIA Nemotron だけを使う。キーは Secrets（NEBIUS_API_KEY）から読む。
 */
import OpenAI from "openai";

export const MODELS = {
  /**
   * 日常：毎回の発話を受けて、ツールを呼んで予約や売り上げを操作する。
   * 指示書では Lightning（nvidia/Nemotron-3_5-Lightning）だが、実際の会話では
   * ツールを呼ばずに「予約しました」と作り話をした（2026-10-22 の試験で再現。試作でも同じ）。
   * そのため Super を使う。Lightning に戻すときは GOYOYAKU_FAST_MODEL で切り替えられる。
   */
  fast: process.env.GOYOYAKU_FAST_MODEL || "nvidia/nemotron-3-super-120b-a12b",
  /** 相談：経営の相談・分析・確認文づくり。ツールは渡さない */
  smart: process.env.GOYOYAKU_SMART_MODEL || "nvidia/nemotron-3-super-120b-a12b",
  /** 目：受け取ったお札・硬貨の写真を数える */
  vision: process.env.GOYOYAKU_VISION_MODEL || "nvidia/Nemotron-3.5-Super-VL",
} as const;

export type ModelRole = keyof typeof MODELS;

let _client: OpenAI | null = null;

/** 必要になったときに初めて接続する（キーがなくてもテストや起動は通るように） */
export function client(): OpenAI {
  if (!_client) {
    const apiKey = process.env.NEBIUS_API_KEY;
    if (!apiKey) throw new Error("NEBIUS_API_KEY is not set");
    _client = new OpenAI({ baseURL: "https://api.tokenfactory.nebius.com/v1/", apiKey, timeout: 60_000, maxRetries: 1 });
  }
  return _client;
}

export function aiConfigured(): boolean {
  return !!process.env.NEBIUS_API_KEY;
}

/** 推論モデルが返す <think>…</think> を取り除く（途中で切れた <think> も落とす） */
export function stripThinking(text: string | null | undefined): string {
  return (text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "").trim();
}

/** 読み上げ向けに、記号・箇条書き・絵文字の飾りを落とす */
export function speakable(text: string | null | undefined): string {
  return stripThinking(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|]+/g, "")
    .replace(/^\s*[-•・]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[\u2600-\u27BF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDEFF]|\uD83E[\uDD00-\uDEFF]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
