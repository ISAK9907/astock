// 悬停卡片定位测试：可指定 日期 / 纵向位置 / 目标图
import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = process.argv[2] || '2026-07-17';
const YFRAC = Number(process.argv[3] ?? 0.45);
const CHART = process.argv[4] || 'cdSh';

let px, W = 500, PL = 48, PR = 50;
if (CHART === 'cdSh') {
  const C = JSON.parse(readFileSync('candles.json', 'utf8'));
  const sh = C.series.find((s) => s.key === 'sh').bars;
  const idx = sh.findIndex((b) => b.d === TARGET);
  if (idx < 0) { console.error('找不到日期', TARGET); process.exit(1); }
  px = PL + (idx / sh.length) * (W - PL - PR);
} else {
  // 静态图（chZtdt / chAmount）：x 轴是最近 7 个交易日，直接按比例取位置
  px = Number(process.argv[5] ?? 400);
}
console.log(`${CHART} ${TARGET} y=${YFRAC} → px=${px.toFixed(1)}`);

const html = readFileSync('astock-dashboard.html', 'utf8');
const inject = `
<script>
window.__ERR__ = [];
window.addEventListener('error', function (e) { window.__ERR__.push(String(e.message)); });
window.addEventListener('load', function () {
  setTimeout(function () {
    var svg = document.getElementById(${JSON.stringify(CHART)});
    var r = svg.getBoundingClientRect();
    var px = ${px.toFixed(2)};
    var cx = r.left + (px / 500) * r.width;
    var cy = r.top + ${YFRAC} * r.height;
    svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
    var tip = svg.parentElement.querySelector('.chtip');
    var pr = svg.parentElement.getBoundingClientRect();
    var tl = tip ? parseFloat(tip.style.left) : NaN;
    var tt = tip ? parseFloat(tip.style.top) : NaN;
    var mx = cx - pr.left, my = cy - pr.top;
    var tw = tip ? tip.offsetWidth : 0, th = tip ? tip.offsetHeight : 0;
    var covers = tw > 0 && mx >= tl - 6 && mx <= tl + tw + 6 && my >= tt - 6 && my <= tt + th + 6;
    var dx = Math.max(tl - mx, mx - (tl + tw), 0);
    var dy = Math.max(tt - my, my - (tt + th), 0);
    document.title = 'TIP:' + [
      'shown=' + (tip ? (tip.style.display || 'shown') : 'null'),
      'len=' + (tip ? tip.innerHTML.length : 0),
      'wide=' + (tip ? tip.classList.contains('wide') : '?'),
      'cursor=' + Math.round(mx) + ',' + Math.round(my),
      'box=' + Math.round(tl) + ',' + Math.round(tt) + ',' + tw + 'x' + th,
      'panel=' + Math.round(pr.width) + 'x' + Math.round(pr.height),
      'covers=' + covers,
      'gap=' + Math.round(Math.hypot(dx, dy)),
      'above=' + (th > 0 && tt + th <= my + 1),
      'err=' + (window.__ERR__.length ? window.__ERR__.join(';').slice(0, 100) : 'none'),
    ].join('|');
  }, 300);
});
</script>
`;
writeFileSync('.shot/test-pos.html', html.replace('</body></html>', inject + '</body></html>', ), 'utf8');
