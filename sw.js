// PWA Service Worker
//   策略：
//     · /signal、/premarket 等实时接口 → 永不缓存（网络优先，失败即失败）
//     · 导航请求（HTML） → 网络优先，断网时回退缓存（看板本来每天只更新一次，离线可用）
//     · 图标 / manifest → 缓存优先
//   注意：Service Worker 只在安全上下文生效（HTTPS 或 localhost）。
//   通过局域网 http://192.168.x.x 访问时不会注册，这是浏览器的硬性限制，不是 bug。
const VERSION = 'astock-v1';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 实时接口绝不缓存
  if (/\/(signal|health|premarket)(\?|$)/.test(url.pathname)) return;

  // 导航：网络优先，断网回退
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const cp = r.clone();
          caches.open(VERSION).then((c) => c.put('./', cp)).catch(() => {});
          return r;
        })
        .catch(() => caches.match('./').then((m) => m || caches.match(req))),
    );
    return;
  }

  // 其他同源资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((r) => {
          if (r && r.ok) {
            const cp = r.clone();
            caches.open(VERSION).then((c) => c.put(req, cp)).catch(() => {});
          }
          return r;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
