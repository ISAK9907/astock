// 阈值敏感性：±0.5% 是拍出来的，必须检验信号是否只在某个特定阈值下成立
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function build(key) {
  const bars = J.series[key].bars.filter((b) => b.d < TODAY);
  const out = [];
  for (let i = 21; i < bars.length; i++) {
    const tl = bars[i - 2], t = bars[i - 1], x = bars[i];
    const amt20 = bars.slice(i - 20, i).reduce((s, b) => s + (b.amt || 0), 0) / 20;
    out.push({
      d: x.d, retT: (t.c / tl.c - 1) * 100, amtRatio: amt20 > 0 && t.amt ? t.amt / amt20 : null,
      gap: (x.o / t.c - 1) * 100, intraday: (x.c / x.o - 1) * 100,
    });
  }
  return out;
}
const pool = Object.keys(J.series).flatMap(build).filter((r) => r.amtRatio != null);
const ERAS = [[2010, 2013], [2014, 2017], [2018, 2021], [2022, 2026]];
const eraAgree = (s, sign) => {
  const segs = ERAS.map(([a, b]) => {
    const c = s.filter((r) => { const y = +r.d.slice(0, 4); return y >= a && y <= b; });
    return c.length >= 5 ? mean(c.map((r) => r.intraday)) : null;
  }).filter((v) => v != null);
  return `${segs.filter((v) => Math.sign(v) === sign).length}/${segs.length}`;
};

console.log('=== 弱势阈值敏感性（条件：T日涨跌 ≤ -X% 且 T+1 高开>1%）===');
console.log('  阈值X     n     日内均值    减仓期望(扣0.12%)   分时代同向');
for (const X of [0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5]) {
  const s = pool.filter((r) => r.retT <= -X && r.gap > 1);
  if (s.length < 30) { console.log(`  -${X}%   n=${s.length} 样本不足`); continue; }
  const m = mean(s.map((r) => r.intraday));
  console.log(`  -${X.toFixed(1)}%  ${String(s.length).padStart(5)}  ${pct(m).padStart(9)}   ${pct(-m - 0.12).padStart(14)}   ${eraAgree(s, Math.sign(m))}`);
}

console.log('\n=== 强势阈值敏感性（条件：T日涨跌 ≥ +X% 且 T+1 高开>1%）===');
console.log('  阈值X     n     日内均值    分时代同向');
for (const X of [0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5]) {
  const s = pool.filter((r) => r.retT >= X && r.gap > 1);
  if (s.length < 30) { console.log(`  +${X}%   n=${s.length} 样本不足`); continue; }
  const m = mean(s.map((r) => r.intraday));
  console.log(`  +${X.toFixed(1)}%  ${String(s.length).padStart(5)}  ${pct(m).padStart(9)}   ${eraAgree(s, Math.sign(m))}`);
}

console.log('\n=== 跳空阈值敏感性（条件：T日涨跌 ≤ -0.5% 且 T+1 跳空 > +Y%）===');
console.log('  阈值Y     n     日内均值    分时代同向');
for (const Y of [0.3, 0.5, 0.8, 1.0, 1.5, 2.0]) {
  const s = pool.filter((r) => r.retT <= -0.5 && r.gap > Y);
  if (s.length < 30) { console.log(`  +${Y}%   n=${s.length} 样本不足`); continue; }
  const m = mean(s.map((r) => r.intraday));
  console.log(`  +${Y.toFixed(1)}%  ${String(s.length).padStart(5)}  ${pct(m).padStart(9)}   ${eraAgree(s, Math.sign(m))}`);
}

console.log('\n=== 量能阈值敏感性（条件：T日跌 ≤ -0.5%、T+1 高开>1%、T日量能 < Z）===');
console.log('  阈值Z     n     日内均值    分时代同向');
for (const Z of [0.8, 0.9, 1.0, 1.1, 1.3]) {
  const s = pool.filter((r) => r.retT <= -0.5 && r.gap > 1 && r.amtRatio < Z);
  if (s.length < 20) { console.log(`  <${Z}   n=${s.length} 样本不足`); continue; }
  const m = mean(s.map((r) => r.intraday));
  console.log(`  <${Z.toFixed(1)}  ${String(s.length).padStart(5)}  ${pct(m).padStart(9)}   ${eraAgree(s, Math.sign(m))}`);
}
