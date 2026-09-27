// 校验盘前信号面板 + 阈值敏感性证据是否都在页面里
import { readFileSync } from 'node:fs';
const dom = readFileSync('.shot/dom.html', 'utf8');
const state = JSON.parse(readFileSync('signal-state.json', 'utf8'));
let fail = 0;
const chk = (ok, m) => { console.log(`${ok ? '✓' : '✗'} ${m}`); if (!ok) fail++; };

console.log('=== 信号面板 ===');
chk(dom.includes('data-panel="signal"'), '面板已渲染');
chk(dom.includes(`T 日状态（${state.T} 收盘）`), `T 日 = ${state.T}（已完成交易日）`);
for (const s of state.states) {
  chk(dom.includes(s.name), `含 ${s.name}`);
}
// 注：signal.js 会在加载后替换占位文案；用 file:// 打开时 fetch 失败，显示降级提示
chk(
  dom.includes('等待竞价') || dom.includes('竞价数据将在开盘后自动获取') || dom.includes('实时竞价不可用'),
  '竞价占位文案存在（或已降级为提示）',
);
chk(dom.includes('若高开 &gt; +1%') || dom.includes('若高开 > +1%'), '条件清单含「若高开 > +1%」');
chk(dom.includes('若低开'), '条件清单含低开行');
chk(dom.includes('每 60 秒刷新'), 'signal.js 已内联（轮询文案存在）');

console.log('\n=== 说明按钮（可回溯依据）===');
chk(dom.includes('明日开盘应对（盘前信号）'), '说明条目标题存在');
chk(dom.includes('弱市高开跨度'), '含交互效应说明');
chk(dom.includes('阈值不是拟合出来的'), '含阈值敏感性证据');
chk(dom.includes('−0.2% 到 −1.5% 全程单调'), '含弱势阈值敏感性区间');
chk(dom.includes('+1.0% 才 4/4'), '含强势阈值为何取 +1.0%');

console.log('\n=== 面板工具条也已覆盖新面板 ===');
const seg = dom.slice(dom.indexOf('data-panel="signal"'), dom.indexOf('data-panel="signal"') + 1500);
chk(seg.includes('class="ptools"'), '信号面板有「说明 / ×」按钮');

console.log(fail === 0 ? '\n✓ 信号面板校验通过' : `\n✗ ${fail} 项失败`);
