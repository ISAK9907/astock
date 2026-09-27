// 交互测试：注入脚本模拟「点击每日归零」+「鼠标悬停」，再 dump DOM 校验
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('astock-dashboard.html', 'utf8');
const inject = `
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var svg = document.getElementById('intraSvg');
    var log = [];
    // 1) 切到每日归零
    document.querySelector('[data-intra-mode="day"]').click();
    // 2) 悬停在图中央（触发准线 + 联动广播）
    var r = svg.getBoundingClientRect();
    log.push('rect=' + [r.left, r.top, r.width, r.height].map(function (v) { return Math.round(v); }).join(','));
    svg.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: r.left + r.width * 0.90, clientY: r.top + r.height * 0.5,
    }));
    log.push('hoverGone=' + (svg.querySelector('polyline') ? 'no' : 'yes'));
    // 3) 滚轮放大到最近约 6 个交易日，验证高低点标注是否实时重算
    var cx = r.left + r.width * 0.88, cy = r.top + r.height * 0.5;
    for (var n = 0; n < 12; n++) {
      svg.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -100, clientX: cx, clientY: cy,
      }));
    }
    // 再悬停一次，让准线跟随新视野
    svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
    document.title = 'TEST:' + log.join('|');
  }, 200);
});
</script>
`;
writeFileSync('.shot/test-interact.html', html.replace('</body></html>', inject + '</body></html>'), 'utf8');
console.log('wrote .shot/test-interact.html');
