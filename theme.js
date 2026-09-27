// 昼夜模式切换（右上角按钮）
//   主题在 <head> 的前置脚本里就已定好，这里只负责点击切换与持久化。
//   图表颜色由 CSS 属性选择器覆盖，因此切换时无需重绘任何 SVG。
(function () {
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  const KEY = 'astock.theme';
  const root = document.documentElement;
  const cur = () => (root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  btn.addEventListener('click', () => {
    const next = cur() === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch { /* 隐私模式等，忽略 */ }
    btn.blur();
  });

  // 首次访问跟随系统；此后若系统主题变化、且用户没手动选过，则跟随
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onSys = (e) => {
      let saved = null;
      try { saved = localStorage.getItem(KEY); } catch { /* 忽略 */ }
      if (saved === 'light' || saved === 'dark') return; // 用户已手动选过，不跟随
      root.setAttribute('data-theme', e.matches ? 'light' : 'dark');
    };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
})();
