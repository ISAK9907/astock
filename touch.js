// 触屏手势统一封装（供 intraday-zoom.js / candles.js 复用）
//   单指横向拖拽 → 平移（纵向留给页面滚动，避免在长页面上被图表"卡住"）
//   双指捏合     → 缩放（增量比例）
//   单指点按     → 准线
//   双击         → 复位
// 依赖 CSS: touch-action: pan-y（这样纵向滚动仍归浏览器，横向手势归我们）
(function () {
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  window.dzTouch = function (svg, h) {
    let mode = null, lastX = 0, lastY = 0, lastDist = 0, moved = 0, startX = 0, startY = 0;
    let lastTap = 0, tapTimer = null;

    const endTapTimer = () => { if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; } };

    svg.addEventListener('touchstart', (e) => {
      const t = e.touches;
      if (t.length === 1) {
        mode = 'pan';
        lastX = startX = t[0].clientX;
        lastY = startY = t[0].clientY;
        moved = 0;
      } else if (t.length >= 2) {
        mode = 'pinch';
        lastDist = dist(t[0], t[1]);
      }
    }, { passive: true });

    svg.addEventListener('touchmove', (e) => {
      const t = e.touches;
      if (mode === 'pan' && t.length === 1) {
        const x = t[0].clientX, y = t[0].clientY;
        const dx = x - lastX, dy = y - lastY;
        moved += Math.hypot(dx, dy);
        // 横向位移大于纵向才接管，否则让页面正常上下滚
        if (Math.abs(x - startX) > Math.abs(y - startY)) {
          if (e.cancelable) e.preventDefault();
          if (h.onPan) h.onPan(dx, dy, x, y);
        }
        lastX = x; lastY = y;
      } else if (mode === 'pinch' && t.length >= 2) {
        if (e.cancelable) e.preventDefault();
        const d = dist(t[0], t[1]);
        if (lastDist > 0 && d > 0) h.onPinch && h.onPinch(d / lastDist, (t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
        lastDist = d;
      }
    }, { passive: false });

    const finish = (e) => {
      if (mode === 'pan' && moved < 10) {
        const now = Date.now();
        if (now - lastTap < 320) {
          endTapTimer();
          lastTap = 0;
          if (h.onDoubleTap) h.onDoubleTap();
        } else {
          lastTap = now;
          endTapTimer();
          tapTimer = setTimeout(() => { tapTimer = null; }, 340);
          if (h.onTap) h.onTap(startX, startY);
        }
      }
      if (!e.touches || e.touches.length === 0) mode = null;
    };
    svg.addEventListener('touchend', finish);
    svg.addEventListener('touchcancel', () => { mode = null; });

    // 双指捏合期间浏览器可能触发 gesturestart（Safari），一并屏蔽
    svg.addEventListener('gesturestart', (e) => e.preventDefault());
  };
})();
