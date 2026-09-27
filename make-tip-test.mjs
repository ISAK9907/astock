// 生成 tooltip 交互测试页：在 cdSh 图上悬停到指定的标记日
import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = process.argv[2] || '2026-07-17';
const C = JSON.parse(readFileSync('candles.json', 'utf8'));
const sh = C.series.find((s) => s.key === 'sh').bars;
const idx = sh.findIndex((b) => b.d === TARGET);
if (idx < 0) { console.error('找不到日期', TARGET); process.exit(1); }

// 复刻 candles.js 的初始视野：i0=0, i1=N，W=500, P.l=48, P.r=50
const N = sh.length, W = 500, PL = 48, PR = 50, iw = W - PL - PR;
const px = PL + (idx / (N - 0)) * iw;
console.log(`${TARGET} 在 sh 序列中索引 ${idx}/${N} → 目标 px=${px.toFixed(1)}`);

const html = readFileSync('astock-dashboard.html', 'utf8');
const inject = `
<script>
window.__ERR__ = [];
window.addEventListener('error', function (e) { window.__ERR__.push(String(e.message)); });
window.addEventListener('load', function () {
  setTimeout(function () {
    var svg = document.getElementById('cdSh');
    var r = svg.getBoundingClientRect();
    var px = ${px.toFixed(2)};
    var cx = r.left + (px / 500) * r.width;
    var cy = r.top + 0.45 * r.height;
    // 自己挂一个监听器，确认事件坐标是否真的传进去了
    var seen = 'none';
    svg.addEventListener('mousemove', function (ev) { seen = Math.round(ev.clientX) + ',' + Math.round(ev.clientY); });
    svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
    var tip = svg.parentElement.querySelector('.chtip');
    var pr = svg.parentElement.getBoundingClientRect();
    var tl = tip ? parseFloat(tip.style.left) : NaN;
    var tt = tip ? parseFloat(tip.style.top) : NaN;
    var mx = cx - pr.left, my = cy - pr.top;
    var tw = tip ? tip.offsetWidth : 0, th = tip ? tip.offsetHeight : 0;
    // 光标是否被卡片盖住（带上 6px 容差）
    var covers = tw > 0 && mx >= tl - 6 && mx <= tl + tw + 6 && my >= tt - 6 && my <= tt + th + 6;
    // 卡片到光标的最近距离
    var dx = Math.max(tl - mx, mx - (tl + tw), 0);
    var dy = Math.max(tt - my, my - (tt + th), 0);
    document.title = 'TIP:' + [
      'tip=' + (tip ? (tip.style.display || 'shown') + '/' + tip.innerHTML.length : 'null'),
      'wide=' + (tip ? tip.classList.contains('wide') : '?'),
      'cursor=' + Math.round(mx) + ',' + Math.round(my),
      'box=' + Math.round(tl) + ',' + Math.round(tt) + ',' + tw + 'x' + th,
      'panel=' + Math.round(pr.width) + 'x' + Math.round(pr.height),
      'covers=' + covers,
      'gap=' + Math.round(Math.hypot(dx, dy)),
      'err=' + (window.__ERR__.length ? window.__ERR__.join(';').slice(0, 120) : 'none'),
    ].join('|');
  }, 300);
});
</script>
`;
writeFileSync('.shot/test-tip.html', html.replace('</body></html>', inject + '</body></html>'), 'utf8');
console.log('wrote .shot/test-tip.html');
