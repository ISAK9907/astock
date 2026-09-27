// PWA 注册 + 安装提示
//   Service Worker 只在 HTTPS / localhost 生效；局域网 http 下会静默跳过（浏览器硬限制）。
(function () {
  const isSecure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);

  if ('serviceWorker' in navigator && isSecure) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* 注册失败不影响使用 */ });
    });
  }

  // Android Chrome 的安装提示：先拦下，等用户点「安装到桌面」
  let deferred = null;
  const btn = document.getElementById('pwaBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (btn) btn.hidden = false;
  });
  if (btn) {
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch { /* 忽略 */ }
      deferred = null;
      btn.hidden = true;
    });
  }
  window.addEventListener('appinstalled', () => { if (btn) btn.hidden = true; });

  // iOS Safari 没有 beforeinstallprompt，给一句手动指引
  const tip = document.getElementById('pwaTip');
  if (tip && !isSecure) tip.hidden = false;
  else if (tip && /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone) tip.hidden = false;
})();
