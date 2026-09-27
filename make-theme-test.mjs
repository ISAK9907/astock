// 主题切换浏览器测试页：mode=click 先记录再点击；mode=load 只记录（验证持久化）
import { readFileSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] || 'click';
const html = readFileSync('astock-dashboard.html', 'utf8');

const inject = `
<script>
window.__ERR__ = [];
window.addEventListener('error', function (e) { window.__ERR__.push(String(e.message)); });
function probe(tag, log) {
  var cs = getComputedStyle(document.body);
  log.push(tag + '.theme=' + document.documentElement.getAttribute('data-theme'));
  log.push(tag + '.bodyBg=' + cs.backgroundColor);
  log.push(tag + '.bodyFg=' + cs.color);
  var g = document.querySelector('#cdSh line[stroke="#252c39"]') || document.querySelector('#cdSh line');
  log.push(tag + '.gridStroke=' + (g ? getComputedStyle(g).stroke : 'n/a'));
  var ax = document.querySelector('#cdSh line[stroke="#39414f"]');
  log.push(tag + '.axisStroke=' + (ax ? getComputedStyle(ax).stroke : 'n/a'));
  var card = document.querySelector('.panel');
  log.push(tag + '.panelBg=' + (card ? getComputedStyle(card).backgroundColor : 'n/a'));
  var tip = document.querySelector('.chtip');
  log.push(tag + '.tipBg=' + (tip ? getComputedStyle(tip).backgroundColor : 'n/a'));
  log.push(tag + '.sunDisp=' + getComputedStyle(document.querySelector('.themebtn .i-sun')).display);
  log.push(tag + '.moonDisp=' + getComputedStyle(document.querySelector('.themebtn .i-moon')).display);
  log.push(tag + '.lbl=' + document.querySelector('.themebtn .lbl-dark').offsetParent === null ? '' : '');
  log.push(tag + '.lblDarkVisible=' + (getComputedStyle(document.querySelector('.themebtn .lbl-dark')).display !== 'none'));
  log.push(tag + '.lblLightVisible=' + (getComputedStyle(document.querySelector('.themebtn .lbl-light')).display !== 'none'));
  log.push(tag + '.stored=' + localStorage.getItem('astock.theme'));
}
window.addEventListener('load', function () {
  setTimeout(function () {
    var log = [];
    log.push('prefersLight=' + (window.matchMedia('(prefers-color-scheme: light)').matches));
    probe('before', log);
${mode === 'click' ? `    document.getElementById('themeBtn').click();
    probe('after', log);
    document.getElementById('themeBtn').click();
    probe('back', log);` : '    // 只读模式：验证上次选择是否被记住'}
    log.push('err=' + (window.__ERR__.length ? window.__ERR__.join(';').slice(0, 120) : 'none'));
    document.title = 'TH:' + log.join('|');
  }, 500);
});
</script>
`;
writeFileSync(`.shot/test-theme-${mode}.html`, html.replace('</body></html>', inject + '</body></html>'), 'utf8');
console.log(`wrote .shot/test-theme-${mode}.html`);
