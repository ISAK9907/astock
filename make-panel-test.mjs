// 生成面板工具条的交互测试页：点开「说明」+ 关闭一个面板
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('astock-dashboard.html', 'utf8');
const inject = `
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var log = [];
    // 1) 展开「三大指数 45 日」面板的说明
    var intra = document.querySelector('[data-panel="intra"]');
    var help = intra.querySelector('.ptools .pbtn');
    help.click();
    log.push('descHidden=' + intra.querySelector('.pdesc').hidden);
    log.push('descLen=' + intra.querySelector('.pdesc').textContent.trim().length);
    // 2) 关闭「两市成交额」面板
    var amt = document.querySelector('[data-panel="amount"]');
    var btns = amt.querySelectorAll('.ptools .pbtn');
    log.push('amtBtns=' + btns.length);
    btns[btns.length - 1].click();
    log.push('amtDisplay=' + amt.style.display);
    log.push('barHidden=' + document.getElementById('prestore').hidden);
    log.push('barItems=' + document.getElementById('prestoreList').children.length);
    log.push('ls=' + (localStorage.getItem('astock.hiddenPanels.v1') || 'null'));
    document.title = 'TEST:' + log.join('|');
  }, 250);
});
</script>
`;
writeFileSync('.shot/test-panels.html', html.replace('</body></html>', inject + '</body></html>'), 'utf8');
console.log('wrote .shot/test-panels.html');
