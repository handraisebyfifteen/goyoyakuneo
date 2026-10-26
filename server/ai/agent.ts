/**
 * ご予約ちゃんの会話の流れ（コードで安全を守る部分）。
 *
 * - 日常モデル（fast）が発話を受け、ツールを選ぶ
 * - 書き込むツールは、確認文を読み上げて本人が「はい」と言うまで実行しない
 * - ★ のツールは、さらに合言葉が合うまで実行しない。合言葉は AI に渡さず、履歴にも残さない
 * - 「なぜ」「どうしたら」などの相談は、日常モデルが ask_advisor を呼び、相談モデル（smart、ツールなし）が答える
 * - AI が知らないツール名を言ってきたら実行しない
 * - 想定外のエラーでも会話を止めない（本人には短く、詳しくはログへ）
 *
 * HTTP 越しなので、確認待ちの状態（pending）をオーナーごとにメモリに持ち、
 * /message → /confirm → /passphrase の順に進める。
 */
import type OpenAI from "openai";
import type { Owner, Language } from "@shared/schema";
import { errorMessage, normalizeLang } from "@shared/i18n";
import { randomUUID } from "node:crypto";
import { MODELS, client, speakable, stripThinking } from "./llm";
import {
  TOOL_SPECS, READ_TOOLS, WRITE_TOOLS, GUARDED_TOOLS, QUIET_WRITE_TOOLS, ADVISOR_TOOL, ToolContext, executeTool, describeAction, validateToolArgs, clockFor, type ToolResult,
} from "./tools";
import * as storage from "../storage";
import { pendingSetupItems, setupReply } from "./setup";
import { memoriesForPrompt } from "./memory";
import { shopFigures } from "./figures";
import { money } from "@shared/money";
import { DEFAULT_NOTICE } from "@shared/schema";
import { verifyPassphrase } from "../lib/passphrase";
import { WEEKDAY_LABELS } from "@shared/i18n";
import { WEEKDAY_KEYS } from "@shared/schema";

export type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;
export type ToolCall = { id: string; name: string; arguments: string };

export type ChatResult = { content: string | null; toolCalls: ToolCall[] };
export type LockState = { unlockedUntil: number; failures: number; lockedUntil: number };

/** 外部とつながる部分。テストでは偽物に差し替える */
export type AgentDeps = {
  chat(role: "fast" | "smart", messages: ChatMsg[], tools?: ToolSpec[]): Promise<ChatResult>;
  exec(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  describe(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string>;
  /** 書き込みの引数の検査。問題があれば本人向けの理由、なければ null */
  validate(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string | null>;
  verify(owner: Owner, phrase: string): boolean;
  locks: { get(ownerId: number): Promise<LockState>; set(ownerId: number, s: LockState): Promise<void> };
  history: { load(ownerId: number): Promise<{ role: "user" | "assistant"; content: string }[]>; save(ownerId: number, role: string, content: string, model?: string): Promise<void> };
  now(): number;
};

export type AgentReply =
  | { type: "reply"; text: string; model: "daily" | "consult"; changed: boolean; actions: Record<string, unknown>[] }
  | { type: "confirm"; text: string; pendingId: string; action: string; guarded: boolean }
  | { type: "passphrase"; text: string; pendingId: string; retry: boolean };

type LoopState = { messages: ChatMsg[]; toolCalls: ToolCall[]; index: number; hops: number; changed: boolean; actions: Record<string, unknown>[] };

type Pending = {
  id: string; ownerId: number; createdAt: number; stage: "confirm" | "passphrase";
  state: LoopState; call: ToolCall; name: string; args: Record<string, unknown>;
};

export const UNLOCK_MS = 10 * 60 * 1000;  // 一度合えば10分間は聞き直さない
export const MAX_FAILURES = 3;             // 3回間違えたら
export const LOCK_MS = 5 * 60 * 1000;      // 5分間お金の操作を止める
const PENDING_TTL_MS = 5 * 60 * 1000;      // 確認待ちは5分で消える
const MAX_HOPS = 6;                        // ツール呼び出しの往復は最大6回
const HISTORY_LIMIT = 20;

const T = {
  ja: {
    fallback: "すみません、もう一度おっしゃっていただけますか。",
    gaveUp: "すみません、うまく処理できませんでした。もう一度お願いします。",
    noPending: "確認待ちの操作はありません。",
    askPassphrase: "合言葉をお願いします。",
    wrongRetry: "合言葉が違います。もう一度お願いします。",
    declinedNote: "直前の操作は、ご本人が取り消したため実行していません。",
    advisorPrefix: "",
  },
  en: {
    fallback: "Sorry, could you say that again?",
    gaveUp: "Sorry, I could not complete that. Please try again.",
    noPending: "There is nothing waiting for confirmation.",
    askPassphrase: "Please say your passphrase.",
    wrongRetry: "That passphrase did not match. Please try again.",
    declinedNote: "The previous action was declined and was not carried out.",
    advisorPrefix: "",
  },
};

const YES: Record<Language, string[]> = {
  ja: ["はい", "うん", "そう", "ええ", "お願い", "おねがい", "いいです", "いいよ", "大丈夫", "だいじょうぶ", "オッケー", "ok", "yes", "正しい", "あってる", "合ってる", "そのとおり", "その通り", "実行して", "やって"],
  en: ["yes", "yeah", "yep", "yup", "correct", "right", "ok", "okay", "sure", "that's right", "confirm", "go ahead", "do it"],
};
const NO: Record<Language, string[]> = {
  ja: ["いいえ", "いや", "違う", "ちがう", "だめ", "やり直し", "やりなおし", "ノー", "no", "間違い", "まちがい", "キャンセル", "やめ", "待って", "まって"],
  en: ["no", "nope", "wrong", "incorrect", "again", "cancel", "not right", "redo", "nah", "wait", "stop"],
};

export function yesNo(text: string, lang: Language): "yes" | "no" | null {
  const t = text.normalize("NFKC").toLowerCase().replace(/[\s、。，．,.!?！？]/g, "");
  if (!t) return null;
  if (NO[lang].some((w) => t.includes(w.replace(/\s/g, "")))) return "no";
  if (YES[lang].some((w) => t.includes(w.replace(/\s/g, "")))) return "yes";
  return null;
}

function parseArgs(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

export class Agent {
  private pending = new Map<number, Pending>();
  constructor(private deps: AgentDeps) {}

  // ---------- 入口 ----------

  /** 本人の発話を受ける */
  async message(owner: Owner, text: string): Promise<AgentReply> {
    const lang = normalizeLang(owner.language);
    const ctx = new ToolContext(owner, lang);
    const p = this.livePending(owner.id);
    let note = "";
    if (p) {
      if (p.stage === "confirm") {
        const yn = yesNo(text, lang);
        if (yn) return this.confirm(owner, p.id, yn);
      }
      // 確認待ちのまま別の話をされた／合言葉待ちに普通の発話が来た → 取り消し扱い（発話は合言葉として扱わない）
      this.pending.delete(owner.id);
      note = T[lang].declinedNote;
    } else {
      // 設定の質問への「聞かないで」「このままでいい」「あとで」「登録する」などは、AI に任せずに受ける
      const r = await setupReply(owner, text, lang);
      if (r) {
        await this.deps.history.save(owner.id, "user", text);
        await this.deps.history.save(owner.id, "assistant", r.reply, MODELS.fast);
        return { type: "reply", text: r.reply, model: "daily", changed: false, actions: r.actions ?? [] };
      }
    }
    const history = await this.deps.history.load(owner.id);
    const messages: ChatMsg[] = [{ role: "system", content: await this.systemPrompt(ctx) }, ...history];
    if (note) messages.push({ role: "system", content: note });
    messages.push({ role: "user", content: text });
    await this.deps.history.save(owner.id, "user", text);
    return this.drive(ctx, { messages, toolCalls: [], index: 0, hops: 0, changed: false, actions: [] });
  }

  /** 確認文への「はい／いいえ」 */
  async confirm(owner: Owner, pendingId: string, answer: "yes" | "no"): Promise<AgentReply> {
    const lang = normalizeLang(owner.language);
    const ctx = new ToolContext(owner, lang);
    const p = this.livePending(owner.id);
    if (!p || p.id !== pendingId || p.stage !== "confirm") return this.plain(owner, T[lang].noPending);
    if (answer === "no") {
      this.pending.delete(owner.id);
      return this.resumeWith(ctx, p, { ok: false, error: errorMessage("owner_declined", lang) });
    }
    if (GUARDED_TOOLS.has(p.name)) {
      const gate = await this.gate(owner);
      if (gate === "ask") {
        p.stage = "passphrase";
        return { type: "passphrase", text: T[lang].askPassphrase, pendingId: p.id, retry: false };
      }
      if (gate !== "ok") {
        this.pending.delete(owner.id);
        return this.resumeWith(ctx, p, { ok: false, error: errorMessage(gate === "locked" ? "passphrase_locked" : "passphrase_missing", lang) });
      }
    }
    this.pending.delete(owner.id);
    return this.resumeWith(ctx, p, await this.run(ctx, p));
  }

  /** 合言葉（AI には渡さない。ここで直接照合する。呼び出し側もログに残さないこと） */
  async passphrase(owner: Owner, pendingId: string, phrase: string): Promise<AgentReply> {
    const lang = normalizeLang(owner.language);
    const ctx = new ToolContext(owner, lang);
    const p = this.livePending(owner.id);
    if (!p || p.id !== pendingId || p.stage !== "passphrase") return this.plain(owner, T[lang].noPending);
    const now = this.deps.now();
    const lock = await this.deps.locks.get(owner.id);
    if (lock.lockedUntil > now) {
      this.pending.delete(owner.id);
      return this.resumeWith(ctx, p, { ok: false, error: errorMessage("passphrase_locked", lang) });
    }
    if (this.deps.verify(owner, phrase)) {
      await this.deps.locks.set(owner.id, { unlockedUntil: now + UNLOCK_MS, failures: 0, lockedUntil: 0 });
      this.pending.delete(owner.id);
      return this.resumeWith(ctx, p, await this.run(ctx, p));
    }
    const failures = lock.failures + 1;
    if (failures >= MAX_FAILURES) {
      await this.deps.locks.set(owner.id, { unlockedUntil: 0, failures: 0, lockedUntil: now + LOCK_MS });
      this.pending.delete(owner.id);
      return this.resumeWith(ctx, p, { ok: false, error: errorMessage("passphrase_rejected", lang) + " " + errorMessage("passphrase_locked", lang) });
    }
    await this.deps.locks.set(owner.id, { ...lock, failures });
    return { type: "passphrase", text: T[lang].wrongRetry, pendingId: p.id, retry: true };
  }

  /** 確認待ちを捨てる（画面を閉じたときなど） */
  cancelPending(ownerId: number) {
    this.pending.delete(ownerId);
  }

  hasPending(ownerId: number): Pending["stage"] | null {
    return this.livePending(ownerId)?.stage ?? null;
  }

  // ---------- 中身 ----------

  private livePending(ownerId: number): Pending | undefined {
    const p = this.pending.get(ownerId);
    if (p && this.deps.now() - p.createdAt > PENDING_TTL_MS) { this.pending.delete(ownerId); return undefined; }
    return p;
  }

  private async plain(owner: Owner, text: string): Promise<AgentReply> {
    return { type: "reply", text, model: "daily", changed: false, actions: [] };
  }

  /** 合言葉の関門：ok（10分以内に合っている）/ ask（聞く）/ locked / missing */
  private async gate(owner: Owner): Promise<"ok" | "ask" | "locked" | "missing"> {
    const now = this.deps.now();
    const lock = await this.deps.locks.get(owner.id);
    if (lock.lockedUntil > now) return "locked";
    if (lock.unlockedUntil > now) return "ok";
    if (!owner.passphraseHash) return "missing";
    return "ask";
  }

  /** 確認済みのツールを実行する */
  private async run(ctx: ToolContext, p: Pending): Promise<ToolResult> {
    const result = await this.deps.exec(ctx, p.name, p.args);
    if (result.ok) p.state.changed = true;
    return result;
  }

  /** ツールの結果を会話に戻して続きを進める */
  private resumeWith(ctx: ToolContext, p: Pending, result: ToolResult): Promise<AgentReply> {
    const st = p.state;
    if (result.action) st.actions.push({ ...result });
    st.messages.push({ role: "tool", tool_call_id: p.call.id, content: JSON.stringify(result) });
    st.index += 1;
    return this.drive(ctx, st);
  }

  /** ツール呼び出しと返答の往復。書き込みツールに当たったら確認のために止まる */
  private async drive(ctx: ToolContext, st: LoopState): Promise<AgentReply> {
    const lang = ctx.lang;
    const ownerId = ctx.owner.id;
    while (st.hops < MAX_HOPS) {
      while (st.index < st.toolCalls.length) {
        const call = st.toolCalls[st.index];
        const name = call.name;
        const args = parseArgs(call.arguments);
        let result: ToolResult;
        if (name === ADVISOR_TOOL) {
          return this.consult(ctx, st, String(args.question ?? ""));
        } else if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
          result = { ok: false, error: errorMessage("unknown_tool", lang, { name }) };
        } else if (READ_TOOLS.has(name)) {
          result = await this.deps.exec(ctx, name, args);
          if (result.ok && QUIET_WRITE_TOOLS.has(name)) st.changed = true;
        } else {
          // 確認を聞く前に、引数が揃っているかをコードで確かめる（足りなければ AI に言い直させる）
          let problem: string | null = null;
          try { problem = await this.deps.validate(ctx, name, args); } catch (e) { console.error("[validate_error]", e); problem = errorMessage("server_error", lang); }
          if (problem) {
            st.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: problem }) });
            st.index += 1;
            continue;
          }
          const text = await this.confirmText(ctx, name, args);
          const p: Pending = { id: randomUUID(), ownerId, createdAt: this.deps.now(), stage: "confirm", state: st, call, name, args };
          this.pending.set(ownerId, p);
          await this.deps.history.save(ownerId, "assistant", text, MODELS.smart); // 確認文も履歴に残す（答えは confirm で受ける）
          return { type: "confirm", text, pendingId: p.id, action: name, guarded: GUARDED_TOOLS.has(name) };
        }
        if (result.action) st.actions.push({ ...result });
        st.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        st.index += 1;
      }

      let res: ChatResult;
      try {
        res = await this.deps.chat("fast", st.messages, TOOL_SPECS);
      } catch (e) {
        console.error("[llm_error:fast]", e);
        return this.finish(ownerId, st, T[lang].gaveUp, "daily");
      }
      st.hops += 1;
      if (!res.toolCalls.length) {
        const text = speakable(res.content) || T[lang].fallback;
        return this.finish(ownerId, st, text, "daily");
      }
      st.messages.push({
        role: "assistant", content: stripThinking(res.content) || null,
        tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments || "{}" } })),
      });
      st.toolCalls = res.toolCalls;
      st.index = 0;
    }
    return this.finish(ownerId, st, T[lang].gaveUp, "daily");
  }

  private async finish(ownerId: number, st: LoopState, text: string, model: "daily" | "consult"): Promise<AgentReply> {
    await this.deps.history.save(ownerId, "assistant", text, model === "daily" ? MODELS.fast : MODELS.smart);
    return { type: "reply", text, model, changed: st.changed, actions: st.actions };
  }

  /** 相談モデル：ツールなし。今日の予約と今月の数字だけを添えて渡す */
  private async consult(ctx: ToolContext, st: LoopState, question: string): Promise<AgentReply> {
    const lang = ctx.lang;
    const [today, sales] = await Promise.all([this.deps.exec(ctx, "get_today_reservations", {}), this.deps.exec(ctx, "get_sales_summary", {})]);
    // 値決めや回数券・クーポンの相談に答えられるよう、お店の数字も渡す（テストの偽物の依存では読まない）
    let shop: unknown = null;
    try { shop = await shopFigures(ctx.owner, lang); } catch (e) { console.error("[figures]", e); }
    const history = st.messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && !("tool_calls" in m)) as ChatMsg[];
    const messages: ChatMsg[] = [
      { role: "system", content: this.advisorPrompt(ctx) + "\n\n" + (lang === "ja" ? "参考の数字（JSON）: " : "Reference figures (JSON): ") + JSON.stringify({ today, thisMonth: sales, shop }) },
      ...history.slice(-HISTORY_LIMIT),
    ];
    if (question && !(history.at(-1)?.content === question)) messages.push({ role: "user", content: question });
    try {
      const res = await this.deps.chat("smart", messages);
      const text = speakable(res.content) || T[lang].fallback;
      return this.finish(ctx.owner.id, st, text, "consult");
    } catch (e) {
      console.error("[llm_error:smart]", e);
      return this.finish(ctx.owner.id, st, T[lang].gaveUp, "consult");
    }
  }

  /** 相談モデルに、本人へ読み上げる確認文を一文で作ってもらう。だめなら定型文 */
  private async confirmText(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
    const lang = ctx.lang;
    let summary = name;
    try { summary = await this.deps.describe(ctx, name, args); } catch (e) { console.error("[describe_error]", e); }
    const fallback = lang === "ja" ? `${summary}、でよろしいでしょうか。` : `Shall I ${summary}?`;
    try {
      const res = await this.deps.chat("smart", [
        { role: "system", content: lang === "ja"
          ? "目の不自由なマッサージ師に読み上げる確認文を、日本語で一文だけ書いてください。「〜でよろしいでしょうか」で終えてください。日付・時刻・金額の数字はそのまま算用数字で書く（漢数字にしない）。予約番号や id のような記号は入れない。まだ実行していないので「承りました」とは言わない。操作に書かれていないこと（メニューなど）を足したり、別のことを尋ねたりしない。説明や前置きは不要。文だけを返す。"
          : "Write exactly one short sentence in English, to be read aloud to a blind massage therapist, asking them to confirm the action below. End with a question. Do not include booking numbers or codes. Do not say it is done. Do not add anything not in the action (such as a menu) or ask about anything else. Return only the sentence." },
        { role: "user", content: lang === "ja" ? "操作: 10月30日（金曜日）11時に、山田さん、30分コース（¥3,500）、当日払いで予約を入れる" : "Action: book Yamada for 30 min (¥3,500) on Friday, October 30 at 11:00, paying at the shop" },
        { role: "assistant", content: lang === "ja" ? "10月30日金曜日の11時に、山田さんの30分コース、3,500円を当日払いでご予約でよろしいでしょうか。" : "Shall I book Yamada for the 30 minute course at 3,500 yen on Friday, October 30 at 11:00, paying at the shop?" },
        { role: "user", content: (lang === "ja" ? "操作: " : "Action: ") + summary },
      ]);
      const text = speakable(res.content).split("\n")[0].trim();
      // 「はい／いいえ」で答えられる確認で終わっていない（完了形や、別のことを尋ねる文）なら使わない
      const asksConfirmation = lang === "ja" ? /(よろしいでしょうか|よろしいですか)[。？?]?$/.test(text) : /\?$/.test(text);
      if (text && text.length < 300 && asksConfirmation) return text;
    } catch (e) {
      console.error("[llm_error:confirm]", e);
    }
    return fallback;
  }

  // ---------- 指示文 ----------

  private async systemPrompt(ctx: ToolContext): Promise<string> {
    const o = ctx.owner;
    const lang = ctx.lang;
    const c = clockFor(o);
    const weekday = WEEKDAY_LABELS[lang][WEEKDAY_KEYS.indexOf(c.weekday)];
    const shop = storage.shopName(o, lang) || (lang === "ja" ? "（店名は未登録）" : "(shop name not set)");
    const SETUP_LABELS: Record<string, [string, string]> = { hours: ["営業時間と定休日", "opening hours and closing days"], account: ["お店の登録", "registering the shop"], menu: ["メニュー", "menu"], contact: ["住所と電話番号", "address and phone"], info: ["お客さんへの案内", "notes for customers"], rules: ["受付ルール", "booking rules"], cancel: ["キャンセルの決まり", "cancellation policy"], notices: ["打刻のお知らせの受け取り方", "how to receive clock notices"], followup: ["次回の声かけのメール", "next-visit suggestion emails"] };
    const mems = await memoriesForPrompt(o);
    const memoryText = mems.length ? mems.map((m) => `[${m.id}] ${m.content}`).join("\n") : (lang === "ja" ? "まだありません" : "nothing yet");
    const np = o.noticePrefs ?? DEFAULT_NOTICE;
    const noticeText = lang === "ja"
      ? `打刻は${np.attendance === "all" ? "全部伝える" : np.attendance === "checks" ? "確認が必要なものだけ伝える" : "伝えない"}、メールは${np.attendanceEmail ? "送る" : "送らない"}${o.noticePrefs ? "" : "（まだ聞いていない）"}`
      : `clock notices: ${np.attendance}, email: ${np.attendanceEmail ? "yes" : "no"}${o.noticePrefs ? "" : " (not asked yet)"}`;
    const pendingSetup = (await pendingSetupItems(o)).map((k) => SETUP_LABELS[k]?.[lang === "ja" ? 0 : 1] ?? k).join(lang === "ja" ? "、" : ", ") || (lang === "ja" ? "なし" : "none");
    const team = (await storage.listStaff(o.id)).filter((s) => s.active).map((s) => s.name).join(lang === "ja" ? "、" : ", ") || (lang === "ja" ? "なし（オーナーひとり）" : "none (owner only)");
    const ticketTypes = (await storage.listTicketTypes(o.id, true)).map((t) => `${t.name}（${money(t.price, o.currency, lang).display}）`).join(lang === "ja" ? "、" : ", ") || (lang === "ja" ? "なし" : "none");
    const unconfirmed = (await storage.listUnconfirmedEntries(o.id)).filter((e) => e.clockOut);
    const attendance = lang === "ja"
      ? `${unconfirmed.length}件（うち要確認${unconfirmed.filter((e) => e.flags.length).length}件）`
      : `${unconfirmed.length} (${unconfirmed.filter((e) => e.flags.length).length} need a check)`;
    const menus = (await storage.listMenus(o.id, true)).map((m) => { const v = storage.menuView(m, lang); return `${v.name} ${v.minutes}${lang === "ja" ? "分" : " min"} ${v.price.display}`; }).join(lang === "ja" ? "、" : ", ") || (lang === "ja" ? "まだありません" : "none yet");
    if (lang === "ja") {
      return `あなたは「ご予約ちゃん」です。目の不自由なマッサージ師の方の右腕として、予約と売り上げの管理を声で手伝います。
お店: ${shop}
登録: ${o.email ? "済み" : "まだ（この端末だけのお店。予約ページ・メール・スタッフ・店舗グループ・APIキーは、登録してから使える）"}
現在は ${c.date} ${c.time}（${weekday}）、時間帯は ${o.timezone} です。今日は ${c.date}、明日は ${c.tomorrow}、今月は ${c.month.from} から ${c.month.to} までです。「明日」「来週の木曜」などはこの日付から計算してください。
国は ${o.country}、通貨は ${o.currency}、話す言語は日本語です。
メニュー: ${menus}
まだ決まっていない設定: ${pendingSetup}
スタッフ: ${team}
確認待ちの打刻: ${attendance}
回数券・前払いの種類: ${ticketTypes}
お知らせの受け取り方: ${noticeText}
覚えていること（[番号] 内容。新しい順）:
${memoryText}

守ること:
- 返事はすべて読み上げられます。短く、丁寧に、日本語で。記号・表・箇条書き・絵文字・マークダウンは使わない。
- 予約番号や id などの英数字は読み上げない。お客さんの名前と日時で話す。
- 金額はツールの結果にある display の形で読み上げる。
- 予約や金額は、必ずツールで調べてから答える。推測で答えない。覚えている内容ではなく、毎回ツールの結果で答える。
- 「何ができる？」「今できることは？」と聞かれたら get_capabilities を呼ぶ。登録・設定してあるからできること（ready）を先に、言い方の例（say）を添えて3つほど伝え、「ほかにも聞きますか」と添える。続きを聞かれたら残りと、いつでもできること（always）、設定するとできること（next）を伝える。
- 相談役が回数券・クーポンの案を出したあとで「それで作って」「それでいい」と言われたら、その案のとおりに create_ticket_type（回数券・前払いの種類）や create_coupon を呼ぶ。お客さんに売るときは sell_ticket に ticket_type を渡す。すでにある種類は作り直さない（「その回数券を売った」なら sell_ticket だけ）。
- 「打刻を確認して」と言われたら confirm_attendance（予定どおりのものだけ）。要確認のものは get_attendance で理由を伝え、直すなら correct_attendance、そのまま認めるなら only_ok=false で確認する。
- スタッフのいる店では、担当や指名を言われたときだけ staff_name を渡す。言われなければ省く（受けられる人に自動で割り当てる）。
- 予約はメニューがなくても入れられる。「田中さん、5日の2時から3時半」なら end_time を使う。メニューがないことを理由に断ったり、メニューを作るよう求めたりしない。
- お客さんのことを聞かれたら get_customer で調べる。「腰が悪い」「強めが好き」のような話が出たら、update_customer でメモに残すか一言たずねる。
- 予約の時間を過ぎても来なかったと言われたら、mark_no_show で無断キャンセルとして記録する。
- 予約を取り消す・変える・支払いを記録するときは、まず find_reservations_by_customer や get_today_reservations で予約の id を調べてからツールを呼ぶ。
- ツールの結果が ok: true のときだけ「承りました」と言う。失敗したら error の理由をそのまま短く伝える。
- 本人が取り消した操作は、実行されていないと伝える。
- 合言葉は、あなたは聞かない・知らない・言わない。必要なときはシステムが直接確かめる。
- カード番号などの支払い情報は、聞かない・言わない。
- 返金はあなたは行わない。返金の対象かどうかを伝えるだけで、返金はオーナーが Stripe で行う。
- 「お金を確認」「お金を数えて」「カメラ」と言われたら、履歴に以前の読み取りがあっても、必ず毎回 check_cash を呼んで新しく読み取る（まず get_today_reservations や find_reservations_by_customer で現地払い待ちの予約の id を調べる）。読み取りの結果はシステムが読み上げるので、あなたは check_cash の note を短く伝えるだけでよい。
- check_cash の読み取りは参考です。手触りでも確かめていただくよう必ず添える。記録は record_onsite_payment で別に行う（履歴に読み取り結果があれば、その合計を amount に使う）。
- 「なぜ」「どうしたら」「相談したい」、悩みや愚痴のときは ask_advisor を呼ぶ。
- 履歴に確認待ちの質問が残っていても、本人が改めて頼まない限り、その操作を勝手に再開しない。
- 設定の質問はシステムが聞く（管理画面を開いたときと、設定に答えてもらった直後に次の項目を）。あなたから設定の話を持ち出さない（本人に聞かれたときは答える）。
- 直前にシステムが設定のことを聞いていて本人が答えたら、その内容で設定のツールを呼ぶ。「このままでいい」なら set_setup_item で done、「聞かないで」なら skip。「あとで」なら何も呼ばずに「わかりました」と答える。
- 「設定の話はもういい」「設定のことは聞かないで」と言われたら、いつでも set_setup_item を item=all, status=skip で呼ぶ。呼ばずに「やめます」と言わない。
- 「登録したい」「お店を登録して」と言われたら open_registration を呼ぶ。メールアドレス・パスワード・合言葉は会話で聞かない（登録の画面で本人が入れる）。
- 登録前のお店で、予約ページを渡す・スタッフ・店舗グループ・次回の声かけなどを頼まれたら、登録すると使えることを一言伝え、「登録する」と言えば登録の画面に移れると添える。
- メニューの名前を言われなければ「60分コース」のように所要時間から名前をつける。
- ツールの結果に suggestion があれば、結果を伝えたあとに一度だけそのまま伝える。
- 覚えていることに従う。オーナーが好みや決まりごと、お店の事情を言ったら（「次から〜して」「〜はいらない」「いつも〜」「〜さんは〜」など）、remember で短い一文にして覚え、「覚えておきます」と一言添える。前に覚えたことと違えば replace_id で置き換え、「忘れて」と言われたら forget。合言葉・パスワード・カード番号は覚えない。
- お知らせの受け取り方を言われたら（「打刻は要確認だけでいい」「メールでも教えて」「打刻の話はいらない」など）、set_notice_preferences で決め、あわせて remember で覚える。
- 性格はオーナーの右腕。愚痴や悩みにはまず共感する。踏み込みすぎない。`;
    }
    return `You are "GoYoyaku-chan", the right hand of a blind massage therapist. You manage their bookings and sales by voice.
Shop: ${shop}
Registered: ${o.email ? "yes" : "not yet (this shop lives on this device only; the booking page, emails, staff, shop groups and API keys become available after registering)"}
It is now ${c.date} ${c.time} (${weekday}) in the ${o.timezone} time zone. Today is ${c.date}, tomorrow is ${c.tomorrow}, this month runs ${c.month.from} to ${c.month.to}. Compute "tomorrow", "next Thursday" and so on from these dates.
Country ${o.country}, currency ${o.currency}, language English.
Menus: ${menus}
Settings not decided yet: ${pendingSetup}
Staff: ${team}
Clock records waiting for confirmation: ${attendance}
Ticket and prepaid types: ${ticketTypes}
Notice preferences: ${noticeText}
Things you remember ([id] content, newest first):
${memoryText}

Rules:
- Everything you say is read aloud. Be short and polite, in English. No symbols, tables, bullet points, emoji or markdown.
- Never read out booking numbers or ids. Refer to bookings by the customer's name and the date and time.
- Read amounts exactly as the "display" field in tool results.
- Always look bookings and amounts up with tools before answering. Never guess or answer from memory.
- When asked "what can you do?" or "what can I do now?", call get_capabilities. Start with what is available because it is registered or set up (ready): about three items, each with its example phrase (say), then offer to tell more. If asked for more, give the rest, what is always available (always), and what setting something up would add (next).
- After the advisor proposes a ticket or coupon and the owner says "create it" or "that's fine", call create_ticket_type (for a ticket or prepaid type) or create_coupon with exactly that proposal. When selling to a customer, pass ticket_type to sell_ticket. Never recreate a type that already exists ("I sold that ticket" means sell_ticket only).
- "Confirm the clock records" means confirm_attendance (on-plan ones only). For ones needing a check, explain the reason from get_attendance, then correct_attendance to fix the time, or confirm_attendance with only_ok=false to accept them.
- In shops with staff, pass staff_name only when the owner names who should take it. Otherwise leave it out and the system assigns someone who can.
- A booking does not need a menu. For "Tanaka, the 5th from 2 to 3:30", use end_time. Never refuse a booking or demand a menu because none exists.
- When asked about a customer, look them up with get_customer. When the owner mentions something like "bad lower back" or "likes it firm", offer to save it with update_customer.
- If the owner says a customer did not show up after the booking time, record it with mark_no_show.
- Before cancelling, changing or recording payment for a booking, find its id with find_reservations_by_customer or get_today_reservations.
- Say "done" or "noted" only when a tool result has ok: true. If it fails, briefly relay the error reason as given.
- If the owner declines an action, tell them it was not carried out.
- You never ask for, know or say the passphrase. The system checks it directly when needed.
- Never ask for or say card numbers or other payment details.
- You never issue refunds. Only say whether a cancellation is eligible; the owner refunds in Stripe.
- When asked to check or count cash, or to open the camera, always call check_cash again even if an earlier reading is in the history (first find the id of the booking waiting for on-site payment with get_today_reservations or find_reservations_by_customer). The system reads the result aloud; you only relay the short note from check_cash.
- check_cash readings are a reference only. Always remind the owner to confirm by touch. Recording is a separate step with record_onsite_payment (use the total from the reading in the history as the amount).
- For "why", "how should I", requests for advice, worries or venting, call ask_advisor.
- If the history contains an unanswered confirmation question, do not restart that action unless the owner asks again.
- The system asks about settings (when the admin panel opens, and the next item right after the owner answers one). Do not bring up settings yourself (answer if the owner asks).
- If the system just asked about a setting and the owner answers, call the matching settings tool. "That's fine as is" means set_setup_item with done; "don't ask" means skip. For "later", call nothing and just say okay.
- Whenever the owner says to stop asking about settings, call set_setup_item with item all and status skip. Never say you will stop without calling it.
- When the owner wants to register the shop, call open_registration. Never ask for an email, password or passphrase in conversation (they enter it on the registration screen).
- If an unregistered shop asks to share the booking page, add staff, join a shop group, send next-visit emails and so on, say briefly that it becomes available after registering, and that saying "register" opens the registration screen.
- If no name is given for a menu, name it from its length, like "60-minute course".
- If a tool result has a suggestion, pass it on once, as given, after reporting the result.
- Follow what you remember. When the owner states a preference, a house rule or a fact about the shop ("from now on...", "I don't need...", "usually...", "Tanaka always..."), save it as one short sentence with remember and say you'll remember it. If it contradicts something remembered, use replace_id; if told to forget, use forget. Never remember passphrases, passwords or card numbers.
- When the owner says how they want notices ("only tell me clock records that need checking", "email me too", "don't tell me about clock records"), call set_notice_preferences and also remember it.
- You are the owner's right hand. Empathize first with worries or complaints. Do not pry.`;
  }

  private advisorPrompt(ctx: ToolContext): string {
    const o = ctx.owner;
    const c = clockFor(o);
    const shop = storage.shopName(o, ctx.lang);
    if (ctx.lang === "ja") {
      return `あなたは「ご予約ちゃん」の相談役です。目の不自由なマッサージ師（お店: ${shop || "未登録"}、通貨 ${o.currency}、今日は ${c.date}）の経営の相談や分析、悩みの聞き役を務めます。
返事はすべて読み上げられます。記号・表・箇条書き・絵文字・マークダウンは使わず、話し言葉で、3〜6文ほどにまとめてください。
まず共感し、それから具体的で小さな一歩を一つか二つ提案してください。数字は参考の数字から引用し、ないものは作らないでください。予約の操作やお金の記録はここでは行えません。踏み込みすぎず、押しつけないでください。
お店の様子を言うときは、参考の数字の shop.summary の文をそのまま使い、自分で数字を足し引きしないでください。
回数券・前払い・クーポン・値決めの相談なら、メニューの料金、来店の間隔（medianDaysBetweenVisits）、リピートの割合、今の券やクーポンの使われ方を見て、案を一つに絞って具体的に言ってください。回数券なら「どのコースを何回、いくら（何%引き）、何日有効」、クーポンなら「何%引きか何円引き、期限、だれに配るか」。データが少ないときは、そう伝えたうえで控えめな案にしてください。最後に「よければ『それで作って』と言ってください」と添えてください。`;
    }
    return `You are the advisor side of "GoYoyaku-chan". You help a blind massage therapist (shop: ${shop || "not set"}, currency ${o.currency}, today ${c.date}) with business questions, analysis and worries.
Everything you say is read aloud. No symbols, tables, bullet points, emoji or markdown. Speak naturally in three to six sentences.
Empathize first, then suggest one or two small concrete next steps. Quote only the reference figures; never invent numbers. You cannot change bookings or record money here. Do not pry or push.
When describing how the shop is doing, use the shop.summary sentence as written and do not do your own arithmetic.
For questions about multi-visit tickets, prepaid credit, coupons or pricing, look at menu prices, the time between visits (medianDaysBetweenVisits), the share of repeat customers and how current tickets and coupons are used, and give one concrete proposal: for a ticket, which service, how many visits, the price (and the discount), and how many days it is valid; for a coupon, the discount, the expiry and who to give it to. If there is little data, say so and keep the proposal modest. End with "If that works, say 'create it'".`;
  }
}

// ---------- 本物の依存をつないだ既定の Agent ----------

export const realDeps: AgentDeps = {
  async chat(role, messages, tools) {
    // 相談・確認文（smart）は推論を切って短く速く答えさせる。日常（fast）は推論を残し、途中で切れないよう余裕を持たせる
    const res = await client().chat.completions.create({
      model: role === "fast" ? MODELS.fast : MODELS.smart,
      messages, ...(tools ? { tools } : {}), temperature: 0.2, max_tokens: role === "fast" ? 1500 : 1000,
      ...(role === "smart" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const m = res.choices[0]?.message;
    if (!m?.content && !m?.tool_calls?.length) console.warn(`[llm_empty:${role}] finish_reason=${res.choices[0]?.finish_reason}`);
    return {
      content: m?.content ?? null,
      toolCalls: (m?.tool_calls ?? []).filter((c): c is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } => c.type === "function")
        .map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    };
  },
  exec: executeTool,
  describe: describeAction,
  validate: validateToolArgs,
  verify: (owner, phrase) => verifyPassphrase(phrase, owner.passphraseHash),
  locks: {
    async get(ownerId) {
      const v = await storage.getVoiceSession(ownerId);
      return { unlockedUntil: v.unlockedUntil?.getTime() ?? 0, failures: v.failures, lockedUntil: v.lockedUntil?.getTime() ?? 0 };
    },
    async set(ownerId, s) {
      await storage.getVoiceSession(ownerId);
      await storage.updateVoiceSession(ownerId, { unlockedUntil: s.unlockedUntil ? new Date(s.unlockedUntil) : null, failures: s.failures, lockedUntil: s.lockedUntil ? new Date(s.lockedUntil) : null });
    },
  },
  history: {
    async load(ownerId) {
      const rows = await storage.listChatMessages(ownerId, HISTORY_LIMIT);
      return rows.filter((r) => r.role === "user" || r.role === "assistant").map((r) => ({ role: r.role as "user" | "assistant", content: r.content.slice(0, 2000) }));
    },
    async save(ownerId, role, content, model) { await storage.addChatMessage(ownerId, role, content, model); },
  },
  now: () => Date.now(),
};

export const agent = new Agent(realDeps);
