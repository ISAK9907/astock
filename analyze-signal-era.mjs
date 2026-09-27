// 补充：候选信号的分时代检查（低开侧 + 组合侧）
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
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
const ERAS = [['10-13', 2010, 2013], ['14-17', 2014, 2017], ['18-21', 2018, 2021], ['22-26', 2022, 2026]];

const CAND = [
  ['弱(T跌≤-0.5%) + 高开>1%', (r) => r.retT <= -0.5 && r.gap > 1],
  ['弱 + 缩量 + 高开>1%', (r) => r.retT <= -0.5 && r.amtRatio < 0.9 && r.gap > 1],
  ['弱 + 高开>1% 且 放量', (r) => r.retT <= -0.5 && r.amtRatio >= 1.15 && r.gap > 1],
  ['强(T涨≥0.5%) + 高开>1%', (r) => r.retT >= 0.5 && r.gap > 1],
  ['强 + 放量 + 高开>1%', (r) => r.retT >= 0.5 && r.amtRatio >= 1.15 && r.gap > 1],
  ['弱 + 低开<-1%', (r) => r.retT <= -0.5 && r.gap < -1],
  ['强 + 低开<-1%', (r) => r.retT >= 0.5 && r.gap < -1],
  ['中性(|retT|<0.5%) + 高开>1%', (r) => Math.abs(r.retT) < 0.5 && r.gap > 1],
];
console.log('  信号                           n    日内均值   分时代(日内均值/样本)                         符号一致');
for (const [nm, pred] of CAND) {
  const s = pool.filter(pred);
  if (s.length < 20) { console.log(`  ${nm.padEnd(28)} n=${s.length} 样本不足`); continue; }
  const m = mean(s.map((r) => r.intraday));
  const segs = ERAS.map(([en, a, b]) => {
    const c = s.filter((r) => { const y = +r.d.slice(0, 4); return y >= a && y <= b; });
    return c.length >= 5 ? { en, m: mean(c.map((r) => r.intraday)), n: c.length } : null;
  }).filter(Boolean);
  const agree = segs.filter((x) => Math.sign(x.m) === Math.sign(m)).length;
  console.log(
    `  ${nm.padEnd(28)} ${String(s.length).padStart(4)}  ${pct(m).padStart(8)}%   ` +
      segs.map((x) => `${x.en}:${pct(x.m)}%(${x.n})`).join(' ').padEnd(52) +
      `  ${agree}/${segs.length}${agree === segs.length ? ' ✓' : ''}`,
  );
}
