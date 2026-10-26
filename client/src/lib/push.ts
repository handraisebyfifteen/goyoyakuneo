/**
 * スマホへの通知（Web Push）の受け取りを、この端末で始める・止める。
 * - 許可を聞くのは、ボタンを押したときだけ（iPhone はそうでないと聞けない）
 * - iPhone は、ホーム画面に追加したアプリの中でしか通知を受けられない（Safari のままでは使えない）
 */
import { apiRequest } from "@/lib/queryClient";

/** ok：使える。ios_home：iPhone の Safari で開いている（ホーム画面に追加が要る）。denied：通知を断った。unsupported：このブラウザでは使えない */
export type PushEnv = "ok" | "ios_home" | "denied" | "unsupported";

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushEnv(): PushEnv {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIos() && !isStandalone()) return "ios_home";
  if (!supported) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "ok";
}

/** この端末が今受け取っている宛先（なければ null） */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 通知を始める。断られたら "denied"。ボタンを押した処理の中から、最初に呼ぶこと */
export async function enablePush(publicKey: string): Promise<"ok" | "denied"> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // サーバーの鍵が変わっていたら、作り直す
  const old = sub?.options.applicationServerKey;
  if (sub && old && !sameBytes(new Uint8Array(old), keyBytes(publicKey))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await apiRequest("POST", "/api/owner/push", sub.toJSON());
  return "ok";
}

/** この端末で通知を止める */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await apiRequest("POST", "/api/owner/push/remove", { endpoint: sub.endpoint });
  await sub.unsubscribe();
}
