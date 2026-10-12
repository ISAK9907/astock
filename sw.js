// PWA Service Worker
//   策略：
//     · /signal、/premarket 等实时接口 → 永不缓存（网络优先，失败即失败）
//     · 导航请求（HTML） → 网络优先（**且绕过 HTTP 缓存**），断网时回退缓存
//     · 图标 / manifest → 缓存优先
//   注意：Service Worker 只在安全上下文生效（HTTPS 或 localhost）。
//   通过局域网 http://192.168.x.x 访问时不会注册，这是浏览器的硬性限制，不是 bug。
//
// ⚠️ 为什么导航必须加 {cache:'no-cache'}：GitHub Pages 给 HTML 发的响应头是
//    `Cache-Control: max-age=600`。"网络优先"里的 fetch(req) **仍然会命中 HTTP 缓存** ——
//    于是部署完新版本后，reload 拿到的可能还是十分钟内的旧副本。
//    症状：手机上的自动同步发现 version.json 变了 → 触发 reload → 但 reload 又拿到旧页面
//    → 防抖保护判定"刷新过了还是旧的"→ 停止自动刷新，只剩手动点刷新，用户就卡在旧版本上。
//    no-cache 是**带条件请求去服务端确认**（有 ETag 就走 304，很便宜），不是 no-store，
//    所以既不放弃校验、也不重复下载未变化的内容。
//    VERSION 一并升到 v2：activate 时会删掉上一版缓存，让卡住的旧副本彻底清掉。
const VERSION = 'astock-v2';
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
  // version.json 也绝不缓存：手机端靠轮询它发现自己看到的页面是旧版本 → 自动刷新。
  // 它一旦进了 Cache Storage，轮询就永远读到同一个值，自动同步会**静默失效**。
  if (url.pathname.endsWith('/version.json')) return;

  // 导航：网络优先（绕过 HTTP 缓存），断网回退
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
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
