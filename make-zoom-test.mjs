// 双图联动测试：在「上」图滚轮缩放、在「下」图拖拽平移，检查两图视野是否始终一致
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('astock-dashboard.html', 'utf8');

const inject = `
<script>
window.__ERR__ = [];
window.addEventListener('error', function (e) { window.__ERR__.push(String(e.message)); });
function labelsX(id) {
  var svg = document.getElementById(id);
  return Array.prototype.map.call(svg.querySelectorAll('text'), function (t) {
    return (t.getAttribute('y') === '226' && /^\\d\\d\\/\\d\\d$/.test(t.textContent)) ? t.getAttribute('x') : null;
  }).filter(Boolean);
}
function head(id) {
  var svg = document.getElementById(id);
  var t = Array.prototype.find.call(svg.querySelectorAll('text'), function (x) { return x.getAttribute('x') === '50' && x.getAttribute('y') === '14'; });
  return t ? t.textContent : '';
}
window.addEventListener('load', function () {
  setTimeout(function () {
    var cum = document.getElementById('intraSvgCum');
    var day = document.getElementById('intraSvgDay');
    var log = [];
    log.push('initSame=' + (labelsX('intraSvgCum').join() === labelsX('intraSvgDay').join()));
    log.push('initHead=' + head('intraSvgCum').slice(-12));

    // 1) 在上图滚轮放大
    var r = cum.getBoundingClientRect();
    for (var i = 0; i < 12; i++) {
      cum.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -100,
        clientX: r.left + r.width * 0.85, clientY: r.top + r.height * 0.5,
      }));
    }
    log.push('afterZoomCumHead=' + head('intraSvgCum').slice(-14));
    log.push('afterZoomDayHead=' + head('intraSvgDay').slice(-14));
    log.push('afterZoomSame=' + (labelsX('intraSvgCum').join() === labelsX('intraSvgDay').join()));
    log.push('afterZoomN=' + labelsX('intraSvgCum').length);

    // 2) 在下图拖拽平移（必须真的改变视野，否则联动断言会假通过）
    var beforePan = labelsX('intraSvgCum').join();
    var r2 = day.getBoundingClientRect();
    var sx = r2.left + r2.width * 0.7, sy = r2.top + r2.height * 0.5;
    day.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy }));
    for (var k = 1; k <= 6; k++) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx - k * 25, clientY: sy }));
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    var afterPan = labelsX('intraSvgCum').join();
    log.push('panChanged=' + (beforePan !== afterPan));
    log.push('afterPanSame=' + (labelsX('intraSvgCum').join() === labelsX('intraSvgDay').join()));
    log.push('afterPanN=' + labelsX('intraSvgCum').length);
    log.push('err=' + (window.__ERR__.length ? window.__ERR__.join(';').slice(0, 140) : 'none'));

    // 3) 在上图悬停 → 两图都应出现同一时刻的竖线（共享准线）
    function vlineX(id) {
      var svg = document.getElementById(id);
      var l = Array.prototype.find.call(svg.querySelectorAll('line'), function (x) {
        return x.getAttribute('stroke') === '#8b96a8' && x.getAttribute('y1') === '20';
      });
      return l ? l.getAttribute('x1') : 'none';
    }
    var r3 = cum.getBoundingClientRect();
    cum.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r3.left + r3.width * 0.5, clientY: r3.top + r3.height * 0.5 }));
    var vc = vlineX('intraSvgCum'), vd = vlineX('intraSvgDay');
    log.push('crossX_cum=' + (vc ? (+vc).toFixed(1) : 'none'));
    log.push('crossX_day=' + (vd ? (+vd).toFixed(1) : 'none'));
    log.push('crossSame=' + (vc !== 'none' && vd !== 'none' && Math.abs(+vc - +vd) < 0.5));
    document.title = 'ZOOM:' + log.join('|');
  }, 400);
});
</script>
`;
writeFileSync('.shot/test-zoom.html', html.replace('</body></html>', inject + '</body></html>'), 'utf8');
console.log('wrote .shot/test-zoom.html');
