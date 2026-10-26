/**
 * 登録前のお店に入るための鍵。この端末にだけ保存する（なくすとお店に戻れないので、登録を勧める）。
 * 保存できない環境（プライベートブラウズなど）でも止めない。そのときは今のログインの間だけ使える。
 */
import { apiRequest, ApiRequestError, queryClient } from "@/lib/queryClient";

const KEY = "goyoyaku.deviceShop";

export function deviceKey(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function forgetDeviceKey() {
  try { localStorage.removeItem(KEY); } catch { /* 無視 */ }
}

/** 登録なしで始める（この端末だけのお店を作る） */
export async function startShop(lang: string): Promise<void> {
  const res = await apiRequest<{ deviceKey: string }>("POST", "/api/auth/start", { language: lang, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  try { localStorage.setItem(KEY, res.deviceKey); } catch { /* 保存できなくても、今のログインの間は使える */ }
  await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
}

/** 端末の鍵で入り直す。お店が見つからなければ false（使えない鍵は捨てる）。通信の失敗などはそのまま投げる */
export async function resumeShop(): Promise<boolean> {
  const key = deviceKey();
  if (!key) return false;
  try {
    await apiRequest("POST", "/api/auth/device", { key });
  } catch (e) {
    if (!(e instanceof ApiRequestError && e.status === 404)) throw e;
    forgetDeviceKey();
    return false;
  }
  await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  return true;
}
