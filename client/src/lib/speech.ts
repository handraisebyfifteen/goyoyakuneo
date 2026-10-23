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
/** 端末に入っている声の一覧。最初は空で返ってくるブラウザがあるので、揃うまで少し待つ */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported()) return Promise.resolve([]);
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const have = speechSynthesis.getVoices();
      if (have.length) return resolve(have);
      const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
      speechSynthesis.addEventListener("voiceschanged", () => { clearTimeout(timer); resolve(speechSynthesis.getVoices()); }, { once: true });
    });
    // 空のまま確定したら次回また調べる
    voicesReady.then((v) => { if (!v.length) voicesReady = null; });
  }
  return voicesReady;
}

// ---------- 声の設定（端末ごとに保存。声は端末に入っているものなので、アカウントではなく端末に紐づける） ----------
export type VoiceLang = "ja" | "en";
export type Gender = "female" | "male";
export type Rate = "slow" | "normal" | "fast";
export type VoicePref = { gender: Gender; voice: string | null; rate: Rate };
export type VoicePrefs = { ja: VoicePref; en: VoicePref; mute: boolean };

const PREFS_KEY = "voicePrefs";
const DEFAULT_PREFS: VoicePrefs = { ja: { gender: "female", voice: null, rate: "normal" }, en: { gender: "female", voice: null, rate: "normal" }, mute: false };
let prefsCache: VoicePrefs | null = null;

export function getVoicePrefs(): VoicePrefs {
  if (prefsCache) return prefsCache;
  let saved: Partial<VoicePrefs> = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"); } catch { /* 使えない環境 */ }
  prefsCache = { ja: { ...DEFAULT_PREFS.ja, ...saved.ja }, en: { ...DEFAULT_PREFS.en, ...saved.en }, mute: !!saved.mute };
  return prefsCache;
}

/** 声の設定を一度でも保存したか（初めて開いた人には、まず声の設定を案内する） */
export function hasVoicePrefs(): boolean {
  try { return localStorage.getItem(PREFS_KEY) !== null; } catch { return true; }
}

export function setVoicePrefs(next: VoicePrefs) {
  prefsCache = next;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* 無視 */ }
}

export const voiceLangOf = (lang: string): VoiceLang => (lang.toLowerCase().startsWith("ja") ? "ja" : "en");
const normLang = (l: string) => l.replace("_", "-").toLowerCase();

// Web Speech API は声の性別を教えてくれないので、名前から見当をつける
const FEMALE_NAMES = new Set(["female", "woman", "ayumi", "haruka", "sayaka", "nanami", "mayu", "aoi", "shiori", "kyoko", "oren", "o-ren",
  "samantha", "ava", "allison", "susan", "zoe", "karen", "moira", "tessa", "fiona", "victoria", "kate", "serena", "zira", "aria", "jenny", "michelle", "ana", "emma",
  "libby", "sonia", "natasha", "hazel", "nicky", "joelle", "kathy", "princess", "vicki", "agnes", "catherine", "hayley", "flo", "grandma", "sandy", "shelley",
  "olivia", "amber", "ashley", "cora", "elizabeth", "monica", "sara", "nancy", "jane", "clara", "molly", "mia", "maisie", "abbi", "bella", "hollie", "isla"]);
const MALE_NAMES = new Set(["male", "man", "ichiro", "keita", "naoki", "daichi", "otoya", "hattori",
  "alex", "daniel", "fred", "tom", "oliver", "arthur", "aaron", "david", "mark", "guy", "ryan", "christopher", "eric", "steffan", "thomas", "brian", "andrew", "roger",
  "george", "james", "william", "liam", "lee", "bruce", "junior", "ralph", "albert", "rishi", "gordon", "evan", "nathan", "eddy", "grandpa", "reed", "rocko",
  "jacob", "ethan", "noah", "ollie", "kai", "luke", "ian", "duncan", "jack", "neil", "kevin", "matthew", "connor", "elliot", "henry", "brandon", "jason", "oscar"]);
const FEMALE_PHRASES = /google us english|google 日本語|google にほんご|google japanese/i;
// 質の見当：自然な声（ネットワーク音声や高品質版）を上に、Mac の古い声や遊びの声を下に
const GOOD_QUALITY = /natural|neural|online|premium|enhanced|google|siri|wavenet|journey|studio/i;
const POOR_QUALITY = /bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|\b(albert|ralph|junior|princess|kathy|fred|bruce|agnes|vicki|victoria|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

export function guessGender(v: SpeechSynthesisVoice): Gender | null {
  if (FEMALE_PHRASES.test(v.name)) return "female";
  const tokens = v.name.toLowerCase().split(/[^a-z-]+/);
  if (tokens.some((x) => FEMALE_NAMES.has(x))) return "female";
  if (tokens.some((x) => MALE_NAMES.has(x))) return "male";
  return null;
}

/** その言語の声だけを、使いたい順に並べて返す。日本語の文を英語の声が読んだり、その逆は起こさない */
export function voicesFor(voices: SpeechSynthesisVoice[], lang: string, pref: VoicePref = getVoicePrefs()[voiceLangOf(lang)]): SpeechSynthesisVoice[] {
  const key = voiceLangOf(lang);
  const want = normLang(lang);
  const score = (v: SpeechSynthesisVoice) => {
    const g = guessGender(v);
    return (g === pref.gender ? 4 : g === null ? 1 : -4)
      + (GOOD_QUALITY.test(v.name) ? 2 : 0) - (POOR_QUALITY.test(v.name) ? 3 : 0)
      + (normLang(v.lang) === want ? 1 : 0) + (v.default ? 0.5 : 0);
  };
  return voices.filter((v) => normLang(v.lang).startsWith(key)).sort((a, b) => score(b) - score(a));
}

export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | undefined {
  const pref = getVoicePrefs()[voiceLangOf(lang)];
  const cands = voicesFor(voices, lang, pref);
  if (pref.voice) {
    const chosen = cands.find((v) => v.voiceURI === pref.voice || v.name === pref.voice);
    if (chosen) return chosen;
  }
  return cands[0];
}

const RATE: Record<Rate, number> = { slow: 0.85, normal: 1, fast: 1.2 };

export type SpeakOptions = { pitch?: number; rate?: number };

/** 読み上げる。終わったら resolve。ブラウザの自動再生制限なら SpeechNotAllowed で reject。
 *  「アプリの読み上げを止める」設定のときは何もしない（スクリーンリーダーに任せる） */
export async function speak(text: string, lang: string, opts: SpeakOptions = {}): Promise<void> {
  if (!ttsSupported() || !text) return;
  const prefs = getVoicePrefs();
  if (prefs.mute) return;
  speechSynthesis.cancel();
  const voices = await loadVoices();
  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    const key = voiceLangOf(lang);
    const v = pickVoice(voices, lang);
    // 声が見つかればその声の言語に合わせる（ja-JP の文を en-GB の声で読まない）
    u.lang = v ? v.lang : lang;
    if (v) u.voice = v;
    // 英語で声を低くすると威圧的に聞こえるので、高さの変化を半分にする
    const pitch = opts.pitch ?? 1;
    u.pitch = key === "en" ? 1 + (pitch - 1) / 2 : pitch;
    u.rate = opts.rate ?? RATE[prefs[key].rate] * (key === "en" ? 0.95 : 1);
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

const SAMPLE: Record<VoiceLang, string> = { ja: "こんにちは、ご予約ちゃんです。ご予約を承ります。", en: "Hello, this is GoYoyaku-chan. I can take your booking." };

/** 設定画面の試し聞き。保存前の設定で鳴らす。「読み上げを止める」設定でも鳴らす（声を選ぶためなので） */
export async function previewVoice(lang: VoiceLang, pref: VoicePref, text: string = SAMPLE[lang]): Promise<void> {
  if (!ttsSupported()) return;
  const saved = getVoicePrefs();
  prefsCache = { ...saved, [lang]: pref, mute: false };
  try { await speak(text, lang === "ja" ? "ja-JP" : "en-US"); }
  finally { prefsCache = saved; }
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
