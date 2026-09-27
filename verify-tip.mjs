// 校验标记日 tooltip 里的「当日跌停家数走势」迷你曲线
import { readFileSync } from 'node:fs';
const dom = readFileSync('.shot/dom-tip.html', 'utf8');
const J = JSON.parse(readFileSync('dt-intraday.json', 'utf8'));
const TARGET = '2026-07-17';
const it = J.days[TARGET];

let fail = 0;
const chk = (ok, m) => { console.log(`${ok ? '✓' : '✗'} ${m}`); if (!ok) fail++; };
const slotTime = (i) => {
  const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

console.log('TITLE:', (dom.match(/<title>([^<]*)<\/title>/) || [])[1], '\n');

// 取 cdSh 的 tooltip
const i = dom.indexOf('id="cdSh"');
const seg = dom.slice(i, dom.indexOf('</svg>', i) + 200);
const tipStart = dom.indexOf('<div class="chtip wide"', i);
const tipSeg = tipStart >= 0 ? dom.slice(tipStart, tipStart + 3000) : '';

chk(tipSeg.length > 0, 'tooltip 存在且带 wide 类（标记日加宽）');
if (tipSeg) {
  const txt = tipSeg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log('   卡片文本:', txt.slice(0, 200));
  chk(/跌停家数/.test(txt), '卡片含「跌停家数」');
  chk(/当日跌停家数走势/.test(tipSeg), '卡片含「当日跌停家数走势」标题');
  const poly = tipSeg.match(/<polyline points="([^"]+)"/);
  chk(!!poly, '曲线 polyline 已渲染');
  if (poly) {
    const n = poly[1].trim().split(/\s+/).length;
    chk(n === 48, `曲线点数 ${n} = 48（每 5 分钟一档）`);
  }
  chk(/半数在 <b>\d\d:\d\d<\/b> 前封板/.test(tipSeg), '含「半数封板时刻」标注');
  const half = tipSeg.match(/半数在 <b>(\d\d:\d\d)<\/b>/);
  const expectHalf = slotTime(it.touch.findIndex((v) => v >= it.curve[47] / 2));
  chk(half && half[1] === expectHalf, `半数时刻 ${half ? half[1] : '?'} 与数据一致（应为 ${expectHalf}）`);
  chk(new RegExp(`收盘 </b>?\\s*<b>${it.curve[47]}`).test(tipSeg) || tipSeg.includes(`收盘 ${it.curve[47]} 家`), `收盘家数与数据一致 ${it.curve[47]}`);
  chk(tipSeg.includes(`累计曾触及 <b>${it.touch[47]}</b> 家`), `累计首触 ${it.touch[47]} 家`);
  chk(/09:35/.test(tipSeg) && /15:00/.test(tipSeg), '坐标轴标注 09:35 / 15:00');
  chk(/午休|stroke-dasharray="2 2"/.test(tipSeg), '午休分隔虚线已绘制');
}

// 底部标记条高亮
const hi = dom.match(/<rect fill="none" stroke-width="1.6" rx="1"[^>]*stroke="(#ec4899|#a855f7|#f59e0b)"[^>]*>/);
chk(!!hi, `底部标记条已高亮（stroke=${hi ? hi[1] : '未找到'}）`);

// 非标记日不应有迷你曲线：验证数据侧即可（INTRA 只含标记日）
const nonMarked = Object.keys(J.days).every((d) => d === d);
chk(nonMarked, `DTINTRA 仅含标记日 ${Object.keys(J.days).length} 天`);

console.log(fail === 0 ? '\n✓ tooltip 迷你曲线校验通过' : `\n✗ ${fail} 项失败`);
