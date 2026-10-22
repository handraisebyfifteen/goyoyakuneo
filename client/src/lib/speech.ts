/**
 * ブラウザ内蔵の Web Speech API（読み上げと音声認識）。外部の音声サービスは使わない。
 */
type SR = { new (): SpeechRecognitionLike };
type SpeechRecognitionLike = {
  lang: string; interimResults: boolean; maxAlternatives: number; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};

function recognitionCtor(): SR | null {
  const w = window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;
export const sttSupported = () => typeof window !== "undefined" && recognitionCtor() !== null;

export class SpeechNotAllowed extends Error {}

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const have = speechSynthesis.getVoices();
      if (have.length) return resolve(have);
      const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
      speechSynthesis.onvoiceschanged = () => { clearTimeout(timer); resolve(speechSynthesis.getVoices()); };
    });
  }
  return voicesReady;
}

export type SpeakOptions = { pitch?: number; rate?: number };

/** 読み上げる。終わったら resolve。ブラウザの自動再生制限なら SpeechNotAllowed で reject */
export async function speak(text: string, lang: string, opts: SpeakOptions = {}): Promise<void> {
  if (!ttsSupported() || !text) return;
  speechSynthesis.cancel();
  const voices = await loadVoices();
  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.pitch = opts.pitch ?? 1;
    u.rate = opts.rate ?? 1;
    const v = voices.find((x) => x.lang.replace("_", "-").toLowerCase() === lang.toLowerCase()) ?? voices.find((x) => x.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    if (v) u.voice = v;
    let settled = false;
    u.onend = () => { if (!settled) { settled = true; resolve(); } };
    u.onerror = (e) => {
      if (settled) return;
      settled = true;
      if (e.error === "not-allowed") reject(new SpeechNotAllowed("not-allowed"));
      else if (e.error === "interrupted" || e.error === "canceled") resolve();
      else resolve();
    };
    speechSynthesis.speak(u);
    // 一部のブラウザは onend を落とすので、長さに応じた保険
    setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2000 + text.length * 180);
  });
}

export function stopSpeaking() {
  if (ttsSupported()) speechSynthesis.cancel();
}

let current: SpeechRecognitionLike | null = null;

/** 一回分の発話を聞き取る。聞き取れなければ "no-speech" で reject */
export function listen(lang: string, timeoutMs = 12000): Promise<string> {
  const Ctor = recognitionCtor();
  if (!Ctor) return Promise.reject(new Error("unsupported"));
  stopListening();
  return new Promise((resolve, reject) => {
    const r = new Ctor();
    current = r;
    r.lang = lang;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.continuous = false;
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); current = null; fn(); } };
    const timer = setTimeout(() => { try { r.stop(); } catch { /* 無視 */ } finish(() => reject(new Error("no-speech"))); }, timeoutMs);
    r.onresult = (e) => finish(() => resolve(String(e.results[0][0].transcript ?? "").trim()));
    r.onerror = (e) => finish(() => reject(new Error(e.error || "error")));
    r.onend = () => finish(() => reject(new Error("no-speech")));
    try { r.start(); } catch (e) { finish(() => reject(e as Error)); }
  });
}

export function stopListening() {
  if (current) { try { current.abort(); } catch { /* 無視 */ } current = null; }
}

const YES: Record<string, string[]> = {
  ja: ["はい", "うん", "そう", "ええ", "お願い", "おねがい", "いいです", "いいよ", "大丈夫", "だいじょうぶ", "オッケー", "ok", "yes", "正しい", "あってる", "合ってる", "そのとおり", "その通り"],
  en: ["yes", "yeah", "yep", "yup", "correct", "right", "ok", "okay", "sure", "that's right", "confirm", "go ahead"],
};
const NO: Record<string, string[]> = {
  ja: ["いいえ", "いや", "違う", "ちがう", "だめ", "やり直し", "やりなおし", "ノー", "no", "間違い", "まちがい", "キャンセル", "やめ"],
  en: ["no", "nope", "wrong", "incorrect", "again", "cancel", "not right", "redo", "nah"],
};

export function yesNo(text: string, lang: string): "yes" | "no" | null {
  const t = text.normalize("NFKC").toLowerCase().replace(/[\s、。，．,.!?！？]/g, "");
  const key = lang.startsWith("ja") ? "ja" : "en";
  if (NO[key].some((w) => t.includes(w.replace(/\s/g, "")))) return "no";
  if (YES[key].some((w) => t.includes(w.replace(/\s/g, "")))) return "yes";
  return null;
}

/** 読み上げられた文字列をメールアドレスの形に直す */
export function parseSpokenEmail(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/\s*(アットマーク|アット|at sign|at)\s*/g, "@")
    .replace(/\s*(ドット|dot|ピリオド|period)\s*/g, ".")
    .replace(/\s*(ハイフン|hyphen|dash)\s*/g, "-")
    .replace(/\s*(アンダーバー|アンダースコア|underscore)\s*/g, "_")
    .replace(/\s+/g, "");
}

export function parseSpokenPhone(s: string): string {
  return s.normalize("NFKC").replace(/[^\d+]/g, "");
}

const JA_NUM: Record<string, number> = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "百": 100, "千": 1000, "万": 10000 };

/** 「一万五千」「5,000」「fifty」などを数に直す（音声認識は普通は数字で返す） */
export function parseSpokenNumber(s: string): number | null {
  const t = s.normalize("NFKC").replace(/[,，\s]/g, "");
  const m = t.match(/-?\d+(\.\d+)?/);
  if (m) {
    let n = parseFloat(m[0]);
    const after = t.slice(t.indexOf(m[0]) + m[0].length);
    if (after.startsWith("万")) n *= 10000;
    else if (after.startsWith("千")) n *= 1000;
    else if (after.startsWith("百")) n *= 100;
    return n;
  }
  if (/^[〇零一二三四五六七八九十百千万]+$/.test(t)) {
    let total = 0, section = 0, digit = 0;
    for (const ch of t) {
      const v = JA_NUM[ch];
      if (v < 10) digit = v;
      else if (v < 10000) { section += (digit || 1) * v; digit = 0; }
      else { total += (section + digit) * v; section = 0; digit = 0; }
    }
    return total + section + digit;
  }
  const EN: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
  const words = s.toLowerCase().split(/[\s-]+/).filter((w) => w in EN);
  if (!words.length) return null;
  let total = 0, cur = 0;
  for (const w of words) {
    const v = EN[w];
    if (v === 100) cur = (cur || 1) * 100;
    else if (v === 1000) { total += (cur || 1) * 1000; cur = 0; }
    else cur += v;
  }
  return total + cur;
}

/** 「10時」「10時半」「午後3時」「3 pm」「19:30」→ "HH:MM" */
export function parseSpokenTime(s: string): string | null {
  const t = s.normalize("NFKC").toLowerCase().replace(/\s/g, "");
  let m = t.match(/(\d{1,2}):(\d{2})/);
  let h: number, min: number;
  if (m) { h = +m[1]; min = +m[2]; }
  else {
    m = t.match(/(\d{1,2})時(半|(\d{1,2})分)?/) ?? t.match(/(\d{1,2})(半|(\d{1,2}))?(am|pm|a\.m\.|p\.m\.|o'clock)?/);
    if (!m) return null;
    h = +m[1];
    min = m[2] === "半" ? 30 : m[3] ? +m[3] : 0;
  }
  if (/午後|pm|p\.m\./.test(t) && h < 12) h += 12;
  if (/午前|am|a\.m\./.test(t) && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
