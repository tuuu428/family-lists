// 通知を受け取って出すための裏方（Service Worker）。画面を閉じていても動く。

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || '家族リスト', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // 同じスペースの通知は1つにまとめ、新しいものに差し替える。続けて5個足されても5回鳴らないように。
      tag: data.tag,
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
});

// 通知を押したら、開いている画面があればそれを使い、なければ新しく開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // 開くのはこのサイトの中だけ（通知の中身に別サイトの URL が入っていても開かない）
  let url = new URL(event.notification.data?.url || '/', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
  url = url.href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        return win.navigate(url);
      }
      return self.clients.openWindow(url);
    })(),
  );
});
