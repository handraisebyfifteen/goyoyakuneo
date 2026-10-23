/**
 * 画面の文言（日本語 / 英語）。オーナーの設定か、お客さんの切り替えで決まる。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "ja" | "en";
type Dict = Record<string, string>;

const ja: Dict = {
  appName: "ご予約ちゃん Neo",
  tagline: "声だけで、予約とお金を管理する",
  welcomeSpeech: "ご予約ちゃんへようこそ。オーナーの方は、ログインか新規登録を選んでください。お客様は、予約の確認を選んでください。",
  ownerLogin: "ログイン", ownerSignup: "新規登録", customerLookup: "予約の確認", bookingPage: "予約ページ",
  pressAnyKey: "音声を再生するには、どこかのキーを押すか画面に触れてください",
  switchToForm: "フォームで入力する", switchToVoice: "会話で入力する",
  listening: "聞いています…", speaking: "話しています…", processing: "処理中…",
  yes: "はい", no: "いいえ", next: "次へ", back: "戻る", retry: "もう一度", cancel: "やめる", confirm: "確定する", save: "保存する", done: "完了",
  typeAnswer: "ここに入力することもできます", repeatQuestion: "質問をもう一度聞く",
  heardYou: "{value} ですね。よろしいですか？", heardSecret: "聞き取りました。これでよろしいですか？",
  noSpeech: "音声の入力はこのブラウザでは使えません。入力欄をお使いください。",
  notHeard: "うまく聞き取れませんでした。もう一度お願いします。",
  choose: "選んでください：{options}",
  email: "メールアドレス", password: "パスワード", passphrase: "合言葉", shopName: "店名", phone: "電話番号", name: "お名前", address: "住所", info: "お客様への案内",
  loginMethod: "ログインの方法", loginPassword: "パスワード", loginPassphrase: "合言葉", loginBoth: "両方",
  secret: "合言葉またはパスワード",
  signupTitle: "オーナー登録", loginTitle: "ログイン", logout: "ログアウト",
  signupSpeech: "オーナー登録をします。いくつか質問しますので、声でお答えください。",
  loginSpeech: "ログインします。メールアドレスと、合言葉かパスワードを教えてください。",
  askShopName: "お店の名前を教えてください。", askEmail: "メールアドレスを教えてください。", askLoginMethod: "ログインの方法を選んでください。合言葉、パスワード、両方、のどれにしますか。",
  askPassphrase: "お金に関わる操作に使う合言葉を決めてください。4文字以上でお願いします。", askPassphraseAgain: "確認のため、もう一度合言葉を言ってください。",
  askPassword: "パスワードを決めてください。8文字以上です。声に出すと周りに聞こえますので、入力欄に打ち込むこともできます。",
  askSecret: "合言葉、またはパスワードを教えてください。",
  passphraseMismatch: "合言葉が一致しませんでした。もう一度お願いします。",
  haveAccount: "登録済みの方はこちら", noAccount: "はじめての方はこちら",
  setupTitle: "最初の設定", setupSpeech: "最初の設定をします。あとから声で変えることもできます。",
  stepRegion: "国と通貨", stepShop: "店舗情報", stepHours: "営業時間と受付ルール", stepCancel: "キャンセルの決まり", stepPassphrase: "合言葉", stepMenus: "メニュー",
  askCountry: "お店のある国を選んでください。", askLanguage: "言語は日本語と英語のどちらにしますか。", askCurrency: "通貨を選んでください。", askTimezone: "時間帯を選んでください。",
  country: "国", language: "言語", currency: "通貨", timezone: "時間帯",
  askAddress: "お店の住所を教えてください。なければ「なし」と言ってください。", askPhone: "お店の電話番号を教えてください。なければ「なし」と言ってください。",
  askInfo: "お客様への案内があれば教えてください。駐車場や持ち物などです。なければ「なし」と言ってください。",
  askOpen: "開店時間は何時ですか。例えば、10時、のように言ってください。", askClose: "閉店時間は何時ですか。",
  askClosedDays: "定休日の曜日を教えてください。複数あれば続けて言ってください。なければ「なし」と言ってください。",
  askBuffer: "施術と施術の間に、何分の空き時間を取りますか。", askStep: "空き時間は何分刻みで案内しますか。",
  askMaxDays: "お客様は何日先まで予約できるようにしますか。", askMinHours: "お客様の予約は、何時間前まで受け付けますか。",
  askCancelHours: "ご予約の何時間前までのキャンセルなら全額返金にしますか。0と言えばいつでも返金になります。",
  askAllowCard: "予約のときにカードで先に払ってもらうことを許可しますか。",
  open: "開店", close: "閉店", closedDays: "定休日", bufferMinutes: "施術間の空き時間（分）", slotStep: "案内の刻み（分）", maxDaysAhead: "何日先まで", minHoursBefore: "何時間前まで",
  freeCancelHours: "全額返金の期限（時間前）", allowCard: "カード前払いを許可",
  askMenuName: "メニューの名前を教えてください。", askMenuMinutes: "所要時間は何分ですか。", askMenuPrice: "料金はいくらですか。", askMoreMenu: "もう一つメニューを追加しますか。",
  menuName: "メニュー名", minutes: "所要時間（分）", price: "料金", addMenu: "メニューを追加", menus: "メニュー",
  setupDone: "設定が終わりました。管理画面に移ります。",
  adminTitle: "管理画面", todayReservations: "今日の予約", thisMonthSales: "今月の売り上げ", noReservations: "予約はありません",
  voiceTitle: "声で操作する", voiceWelcome: "管理画面です。マイクボタンか、スペースキーを押してから話しかけてください。",
  micStart: "マイクを押して話す", micStop: "聞き取りを止める", micHint: "マイクボタンかスペースキーを押して話してください",
  thinking: "考えています…", waitingYesNo: "はい、か、いいえ、でお答えください", sayYesOrNo: "はい、か、いいえ、でお答えください。",
  passphraseListening: "合言葉を聞いています。画面には表示されません。", passphraseHidden: "（合言葉。表示されません）", passphraseTyped: "合言葉（表示されません）",
  typeHere: "文字で話しかけることもできます", send: "送る", continuousMode: "連続モード（読み上げの後、自動で聞き取る）", spaceHint: "スペースキーでもマイクを押せます",
  transcript: "会話の記録", you: "あなた", assistantLabel: "ご予約ちゃん", advisorLabel: "ご予約ちゃん（相談）", voiceEmpty: "ここに返事が表示されます。",
  aiNotConfigured: "AIの接続（NEBIUS_API_KEY）が設定されていないため、声の操作は使えません。",
  cameraTitle: "お金の読み取り", cameraOpen: "カメラで撮る（{name}さんのお支払い）", cameraHint: "カメラのボタンを押して、受け取ったお金を写してください", cameraReading: "お金を読み取っています…",
  bookingLink: "お客様用の予約ページ", copyLink: "リンクをコピー", copied: "コピーしました", settings: "設定",
  total: "合計", card: "カード", onsite: "現地払い", waiting: "未払い", cancelled: "取り消し", refundPending: "返金待ち（Stripe で返金）", count: "{n}件",
  statusConfirmed: "確定", statusCancelled: "取り消し", statusCompleted: "完了", statusNoShow: "来店なし",
  payUnpaid: "カード未払い", payPaid: "カード支払い済み", payOnsitePending: "現地払い予定", payOnsiteReceived: "現地で受け取り済み", payRefunded: "返金済み",
  bookTitle: "ご予約", chooseMenu: "メニューを選んでください", chooseDate: "日付を選んでください", chooseTime: "時間を選んでください", yourDetails: "お客様の情報", choosePayment: "お支払い方法", confirmBooking: "ご予約の確認",
  payCard: "カードで先に払う", payOnsite: "当日店舗で払う", cancelPolicy: "キャンセルの決まり", noSlots: "この日は空きがありません", closed: "定休日", laterDays: "もっと先の日付", earlierDays: "前の日付",
  bookingDone: "ご予約を承りました", bookingNumber: "予約番号", keepNumber: "予約の確認や取り消しには、この番号と電話番号が必要です。", payNow: "お支払いに進む", payLinkPlaceholder: "（テスト用の仮の支払いリンクです）",
  emailSent: "確認メールをお送りしました。", emailLogged: "（テスト環境のため、確認メールは送信せず記録のみです）", emailLimit: "本日のメール送信の上限に達したため、確認メールは送られていません。", emailFailed: "確認メールを送れませんでした。予約は成立しています。",
  payResultTitle: "お支払いの結果", payChecking: "お支払いの状態を確認しています…", paySuccess: "お支払いが完了しました。ありがとうございます。", payPending: "お支払いはまだ確認できていません。しばらくしてから予約の確認ページでご覧ください。", payCancelled: "お支払いは完了していません。確認メールのリンクから、あとでお支払いいただけます。", payReceiptNote: "領収書は Stripe からメールでお送りします。",
  lookupTitle: "予約の確認", lookupSpeech: "予約の確認です。予約番号と電話番号を入力してください。", lookup: "照会する", cancelBooking: "この予約を取り消す", reallyCancel: "本当に取り消しますか？", cancelled_done: "ご予約を取り消しました",
  refundYes: "キャンセルの決まりにより全額返金の対象です。返金は店舗から行われます。", refundNo: "キャンセルの期限を過ぎているため、返金の対象外です。",
  weekdayShort: "月,火,水,木,金,土,日", optional: "（任意）", required: "（必須）", error: "エラー", loading: "読み込み中…",
  emailNote: "確認メールをお送りします", minutesUnit: "{n}分", none: "なし", skip: "そのまま",
  voiceSettings: "声の設定", voiceSettingsSpeech: "声の設定です。日本語と英語それぞれで、女性の声か男性の声かを選べます。設定はこの端末に保存されます。",
  voiceForJa: "日本語の声", voiceForEn: "英語の声", voiceGender: "声の種類", female: "女性", male: "男性",
  voicePick: "使う声", voiceAuto: "自動（おすすめ）", rate: "速さ", rateSlow: "ゆっくり", rateNormal: "ふつう", rateFast: "はやい", preview: "試しに聞く",
  noVoicesFor: "この端末には{lang}の声が入っていません。端末の設定から音声を追加してください。", ttsUnsupported: "このブラウザは読み上げに対応していません。",
  muteApp: "アプリの読み上げを止める（スクリーンリーダーをお使いの方向け）", muteNote: "止めると、質問は画面の文字だけになり、マイクは「話す」ボタンを押したときだけ聞き取ります。",
  saved: "保存しました", talk: "話す", langNameJa: "日本語", langNameEn: "英語", srHeading: "スクリーンリーダーをお使いの方へ",
  micBlocked: "マイクが使えないため、声では聞き取れません。入力欄に打ち込んでください。",
  typeOrTalk: "聞き取れませんでした。入力欄に打ち込むか、「話す」ボタンを押してもう一度お話しください。",
  langSwitchHint: "いつでも「English」と言えば英語に切り替わります。",
};

const en: Dict = {
  appName: "GoYoyaku-chan Neo",
  tagline: "Manage bookings and money by voice alone",
  welcomeSpeech: "Welcome to GoYoyaku-chan. Owners, choose log in or sign up. Customers, choose look up a booking.",
  ownerLogin: "Log in", ownerSignup: "Sign up", customerLookup: "Look up a booking", bookingPage: "Booking page",
  pressAnyKey: "Press any key or tap the screen to enable voice",
  switchToForm: "Use a form instead", switchToVoice: "Use voice instead",
  listening: "Listening…", speaking: "Speaking…", processing: "Working…",
  yes: "Yes", no: "No", next: "Next", back: "Back", retry: "Try again", cancel: "Cancel", confirm: "Confirm", save: "Save", done: "Done",
  typeAnswer: "You can also type here", repeatQuestion: "Repeat the question",
  heardYou: "I heard {value}. Is that right?", heardSecret: "Got it. Is that right?",
  noSpeech: "Voice input is not available in this browser. Please use the text field.",
  notHeard: "I could not catch that. Please try again.",
  choose: "Choose one: {options}",
  email: "Email", password: "Password", passphrase: "Passphrase", shopName: "Shop name", phone: "Phone", name: "Name", address: "Address", info: "Notes for customers",
  loginMethod: "Login method", loginPassword: "Password", loginPassphrase: "Passphrase", loginBoth: "Both",
  secret: "Passphrase or password",
  signupTitle: "Owner sign up", loginTitle: "Log in", logout: "Log out",
  signupSpeech: "Let's create your owner account. I will ask a few questions. Please answer by voice.",
  loginSpeech: "Let's log in. Tell me your email, then your passphrase or password.",
  askShopName: "What is the name of your shop?", askEmail: "What is your email address?", askLoginMethod: "How would you like to log in? Passphrase, password, or both?",
  askPassphrase: "Choose a passphrase for money-related actions. At least four characters.", askPassphraseAgain: "Please say the passphrase once more to confirm.",
  askPassword: "Choose a password of at least eight characters. Saying it aloud can be overheard, so you may type it instead.",
  askSecret: "Please say your passphrase or password.",
  passphraseMismatch: "The passphrases did not match. Let's try again.",
  haveAccount: "Already registered? Log in", noAccount: "New here? Sign up",
  setupTitle: "Initial setup", setupSpeech: "Let's set up your shop. You can change anything later by voice.",
  stepRegion: "Country and currency", stepShop: "Shop details", stepHours: "Hours and booking rules", stepCancel: "Cancellation policy", stepPassphrase: "Passphrase", stepMenus: "Menus",
  askCountry: "Which country is your shop in?", askLanguage: "Which language, Japanese or English?", askCurrency: "Which currency?", askTimezone: "Which time zone?",
  country: "Country", language: "Language", currency: "Currency", timezone: "Time zone",
  askAddress: "What is the shop address? Say none if you prefer not to.", askPhone: "What is the shop phone number? Say none if you prefer not to.",
  askInfo: "Any notes for customers, such as parking or what to bring? Say none if not.",
  askOpen: "What time do you open? For example, ten a.m.", askClose: "What time do you close?",
  askClosedDays: "Which days are you closed? Say the weekdays, or none.",
  askBuffer: "How many minutes between sessions?", askStep: "In what minute steps should open times be offered?",
  askMaxDays: "How many days ahead can customers book?", askMinHours: "How many hours before the start must customers book?",
  askCancelHours: "Up to how many hours before the appointment is a cancellation fully refunded? Say zero for always.",
  askAllowCard: "Allow customers to pay by card in advance when booking?",
  open: "Opens", close: "Closes", closedDays: "Closed on", bufferMinutes: "Gap between sessions (min)", slotStep: "Time step (min)", maxDaysAhead: "Days ahead", minHoursBefore: "Hours before",
  freeCancelHours: "Full refund until (hours before)", allowCard: "Allow card prepayment",
  askMenuName: "What is the menu called?", askMenuMinutes: "How many minutes does it take?", askMenuPrice: "What is the price?", askMoreMenu: "Add another menu?",
  menuName: "Menu name", minutes: "Duration (min)", price: "Price", addMenu: "Add menu", menus: "Menus",
  setupDone: "Setup is complete. Opening the admin panel.",
  adminTitle: "Admin", todayReservations: "Today's bookings", thisMonthSales: "This month's sales", noReservations: "No bookings",
  voiceTitle: "Talk to GoYoyaku-chan", voiceWelcome: "This is the admin panel. Press the microphone button or the space bar, then speak.",
  micStart: "Press to talk", micStop: "Stop listening", micHint: "Press the microphone button or the space bar, then speak",
  thinking: "Thinking…", waitingYesNo: "Please answer yes or no", sayYesOrNo: "Please answer yes or no.",
  passphraseListening: "Listening for your passphrase. It will not be shown.", passphraseHidden: "(passphrase, not shown)", passphraseTyped: "Passphrase (not shown)",
  typeHere: "You can also type here", send: "Send", continuousMode: "Hands-free (listen again after each reply)", spaceHint: "The space bar also presses the microphone",
  transcript: "Conversation log", you: "You", assistantLabel: "GoYoyaku-chan", advisorLabel: "GoYoyaku-chan (advisor)", voiceEmpty: "Replies appear here.",
  aiNotConfigured: "Voice control is unavailable because the AI connection (NEBIUS_API_KEY) is not configured.",
  cameraTitle: "Cash reading", cameraOpen: "Take a photo ({name}'s payment)", cameraHint: "Press the camera button and photograph the cash you received", cameraReading: "Reading the cash…",
  bookingLink: "Booking page for customers", copyLink: "Copy link", copied: "Copied", settings: "Settings",
  total: "Total", card: "Card", onsite: "On site", waiting: "Unpaid", cancelled: "Cancelled", refundPending: "Refund pending (refund in Stripe)", count: "{n}",
  statusConfirmed: "Confirmed", statusCancelled: "Cancelled", statusCompleted: "Completed", statusNoShow: "No show",
  payUnpaid: "Card, unpaid", payPaid: "Paid by card", payOnsitePending: "Pay on site", payOnsiteReceived: "Received on site", payRefunded: "Refunded",
  bookTitle: "Book", chooseMenu: "Choose a menu", chooseDate: "Choose a date", chooseTime: "Choose a time", yourDetails: "Your details", choosePayment: "Payment method", confirmBooking: "Confirm your booking",
  payCard: "Pay by card now", payOnsite: "Pay at the shop", cancelPolicy: "Cancellation policy", noSlots: "No openings on this day", closed: "Closed", laterDays: "Later dates", earlierDays: "Earlier dates",
  bookingDone: "Your booking is confirmed", bookingNumber: "Booking number", keepNumber: "You need this number and your phone number to look up or cancel.", payNow: "Go to payment", payLinkPlaceholder: "(test placeholder payment link)",
  emailSent: "A confirmation email has been sent.", emailLogged: "(Test environment: the confirmation email was logged, not sent.)", emailLimit: "Today's email limit was reached, so no confirmation email was sent.", emailFailed: "The confirmation email could not be sent. Your booking is still confirmed.",
  payResultTitle: "Payment result", payChecking: "Checking your payment…", paySuccess: "Your payment is complete. Thank you.", payPending: "Your payment has not been confirmed yet. Please check the booking lookup page a little later.", payCancelled: "The payment was not completed. You can pay later using the link in your confirmation email.", payReceiptNote: "Stripe will email you a receipt.",
  lookupTitle: "Look up a booking", lookupSpeech: "Look up a booking. Enter your booking number and phone number.", lookup: "Look up", cancelBooking: "Cancel this booking", reallyCancel: "Really cancel?", cancelled_done: "Your booking has been cancelled",
  refundYes: "Under the cancellation policy this is eligible for a full refund. The shop will issue it.", refundNo: "The cancellation deadline has passed, so this is not refundable.",
  weekdayShort: "Mon,Tue,Wed,Thu,Fri,Sat,Sun", optional: "(optional)", required: "(required)", error: "Error", loading: "Loading…",
  emailNote: "We will send a confirmation email", minutesUnit: "{n} min", none: "None", skip: "Keep",
  voiceSettings: "Voice settings", voiceSettingsSpeech: "Voice settings. For Japanese and English, choose a female or male voice. Settings are saved on this device.",
  voiceForJa: "Japanese voice", voiceForEn: "English voice", voiceGender: "Voice type", female: "Female", male: "Male",
  voicePick: "Voice", voiceAuto: "Automatic (recommended)", rate: "Speed", rateSlow: "Slow", rateNormal: "Normal", rateFast: "Fast", preview: "Preview",
  noVoicesFor: "This device has no {lang} voices installed. Add one in your device settings.", ttsUnsupported: "This browser does not support speech output.",
  muteApp: "Turn off the app's own speech (for screen reader users)", muteNote: "When off, questions appear as text only and the microphone listens only when you press Talk.",
  saved: "Saved", talk: "Talk", langNameJa: "Japanese", langNameEn: "English", srHeading: "For screen reader users",
  micBlocked: "The microphone is not available, so I cannot listen. Please type your answer.",
  typeOrTalk: "I could not catch that. Please type your answer, or press Talk and say it again.",
  langSwitchHint: "Say Japanese at any time to switch to Japanese.",
};

const DICT: Record<Lang, Dict> = { ja, en };

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, params?: Record<string, string | number>) => string; speechLang: string };
const I18nContext = createContext<Ctx | null>(null);

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "ja" || saved === "en") return saved;
  } catch { /* 使えない環境 */ }
  return navigator.language?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem("lang", l); } catch { /* 無視 */ }
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const value = useMemo<Ctx>(() => ({
    lang, setLang, speechLang: lang === "ja" ? "ja-JP" : "en-US",
    t: (key, params) => {
      let s = DICT[lang][key] ?? DICT.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
  }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("I18nProvider missing");
  return ctx;
}
