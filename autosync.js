// 自动同步：手机/电脑上的页面自己发现「服务端已经有新版本」，然后刷新。
//
// 为什么需要：日更在 15:40 跑完，但页面上不会自己变 —— 不说手动下拉刷新，
// 就算一直开着也还是昨天那一版。这里让页面主动去问。
//
// 做法：构建时把 BUILD_STAMP 写进页面，同时写一份极小的 version.json。
// 页面每隔一段时间去取 version.json（带时间戳绕开 HTTP 缓存），值变了就刷新。
//
// 两个必须注意的点：
//   1) sw.js 里把 version.json 排除在 Service Worker 缓存之外 ——
//      否则轮询永远读到缓存里的同一个值，这个功能会静默失效（不报错，只是永远不刷新）。
//   2) 请求带 ?t=Date.now() —— GitHub Pages 的 CDN 对静态文件有缓存，
//      靠唯一 query 才能拿到真正的最新版本。
(function () {
  const mine = window.BUILD_STAMP;
  if (!mine) return;

  const EVERY = 60_000; // 轮询间隔：日更一天一次，60 秒足够灵敏也不费流量
  const LOOP_GUARD = 30_000; // 30 秒内已经因版本变化刷过一次，就不再自动刷
  let timer = null;
  let cooldownUntil = 0;

  // 防无限刷新。什么情况下会版本对不上？
  //   · 部署只完成一半（index.html 已更新、version.json 还没）—— 实际上是安全方向（见下），
  //     但反过来的顺序（version.json 先更新）就会让旧页面以为要刷新；
  //   · 更危险的是 Service Worker 缓存了旧的 index.html 而 version.json 是新的：
  //     刷新后拿到的还是旧页面 → 再判定为新版本 → 再刷新 → 死循环。
  // 所以凡是「刚刷过又立刻发现版本不一致」，就停手改成手动按钮。
  const lastReload = Number(sessionStorage.getItem('astock.lastAutoReload') || 0);

  async function check() {
    if (Date.now() < cooldownUntil) return;
    if (document.visibilityState === 'hidden') return; // 页面在后台就别查了
    let v;
    try {
      const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      v = await r.json();
    } catch {
      return; // 断网/离线：静默跳过，绝不打扰
    }
    if (!v?.generatedAt || v.generatedAt === mine) return;

    cooldownUntil = Date.now() + 60_000;

    if (Date.now() - lastReload < LOOP_GUARD) {
      // 刚刷过还是对不上 → 不再自动刷，交给用户点
      showManual(v);
      return;
    }
    sessionStorage.setItem('astock.lastAutoReload', String(Date.now()));

    // 有更新了。先提示再刷新，避免用户正在看的时候页面毫无征兆地跳掉。
    showToast(v);
    setTimeout(() => location.reload(), 2200);
  }

  function box() {
    let el = document.getElementById('syncToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'syncToast';
      el.className = 'synctoast';
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(v) {
    const d = v.date ? `${v.date} 收盘` : '新版本';
    const el = box();
    el.innerHTML = `<b>数据已更新（${d}）</b><span>正在刷新…</span>`;
    el.classList.add('on');
  }

  // 自刷新兜住了就不再自动刷，改成一个能点的提示
  function showManual(v) {
    const d = v.date ? `${v.date} 收盘` : '新版本';
    const el = box();
    el.innerHTML = `<b>有新数据（${d}）</b><span class="synclink">点这里刷新</span>`;
    el.classList.add('on', 'manual');
    const link = el.querySelector('.synclink');
    if (link) link.onclick = () => location.reload();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await check();
      schedule();
    }, EVERY);
  }

  // 从后台切回来时立刻查一次：用户掏出手机的那一刻最希望看到最新数据
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });

  schedule();
  // 首屏先等一会儿再查，别和图表渲染抢带宽
  setTimeout(check, 8000);
})();
