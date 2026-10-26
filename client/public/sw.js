/*
 * スマホへの通知を受け取る（Web Push）。アプリを閉じていても、ここが起きて通知を出す。
 * 通知を押したら、開いている画面があればそこへ、なければ管理画面を開く。
 * 画面の読み込みの横取り（オフライン対応）はしない。いつも最新の画面を出すため
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data ? event.data.text() : "" }; }
  const title = data.title || "ご予約ちゃん";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/admin" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/admin";
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).pathname === url && "focus" in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});
