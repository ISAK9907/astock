// 跳空（高开/低开）与日内低走/高走的统计验证
//   收益口径：T+1 下「今天买、今天卖」不可执行，但「卖出手上已有持仓、收盘再买回」可执行。
//   所以「减仓收益」= (开盘 - 收盘) / 开盘，为正表示开盘减仓、收盘补回是赚的。
import { readFileSync } from 'node:fs';

const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

// ---------- 统计工具 ----------
function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
const binomPmf = (k, n, p) =>
  Math.exp(lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + (k ? k * Math.log(p) : 0) + (n - k ? (n - k) * Math.log(1 - p) : 0));
/** 二项检验（双侧，精确） */
function binomTest2(k, n, p) {
  if (!n) return 1;
  const obs = binomPmf(k, n, p);
  let s = 0;
  for (let i = 0; i <= n; i++) { const v = binomPmf(i, n, p); if (v <= obs * (1 + 1e-9)) s += v; }
  return Math.min(1, s);
}

// ---------- 构造样本 ----------
function build(key, { from = '0000-00-00', to = '9999-99-99' } = {}) {
  const bars = J.series[key].bars.filter((b) => b.d >= from && b.d <= to && b.d < TODAY); // 剔除当日未完成 bar
  const rows = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    const gap = (b.o / p.c - 1) * 100;          // 跳空幅度 %
    const sellOpen = ((b.o - b.c) / b.o) * 100;  // 开盘减仓、收盘补回的收益
    const body = (b.c / b.o - 1) * 100;          // 日内（开→收）
    const day = (b.c / p.c - 1) * 100;           // 全天
    const filled = gap > 0 ? b.l <= p.c : b.h >= p.c; // 跳空是否被完全回补
    rows.push({ d: b.d, gap, sellOpen, body, day, filled, o: b.o, c: b.c, h: b.h, l: b.l, prevC: p.c });
  }
  return rows;
}

const BUCKETS = [
  ['≤-2%', (g) => g <= -2], ['-2~-1%', (g) => g > -2 && g <= -1], ['-1~-0.5%', (g) => g > -1 && g <= -0.5],
  ['-0.5~-0.2%', (g) => g > -0.5 && g <= -0.2], ['-0.2~0.2%', (g) => g > -0.2 && g < 0.2],
  ['0.2~0.5%', (g) => g >= 0.2 && g < 0.5], ['0.5~1%', (g) => g >= 0.5 && g < 1],
  ['1~2%', (g) => g >= 1 && g < 2], ['≥2%', (g) => g >= 2],
];

function stats(rows, pred) {
  const s = rows.filter((r) => pred(r.gap));
  const n = s.length;
  if (!n) return { n: 0 };
  const fade = s.filter((r) => r.body < 0).length;       // 低走（收<开）
  const fail = s.filter((r) => r.sellOpen > 0).length;   // 开盘减仓为正
  return {
    n,
    fadeRate: (fade / n) * 100,
    sellWin: (fail / n) * 100,
    eSellOpen: s.reduce((a, r) => a + r.sellOpen, 0) / n,
    eDay: s.reduce((a, r) => a + r.day, 0) / n,
    filledRate: (s.filter((r) => r.filled).length / n) * 100,
  };
}

// ---------- 主分析 ----------
const base = build('sh');
console.log(`样本：上证指数 ${base.length} 个交易日  ${base[0].d} → ${base.at(-1).d}`);
console.log(`（已剔除当日 ${TODAY} 的未完成 bar）\n`);

const all = stats(base, () => true);
console.log('=== 无条件基准（T+1 前提下的"天生容易低走"是否成立）===');
console.log(`  收盘 < 开盘（低走）      ${all.fadeRate.toFixed(1)}%   n=${all.n}`);
console.log(`  收盘 < 昨收（全天跌）     ${(base.filter((r) => r.day < 0).length / all.n * 100).toFixed(1)}%`);
console.log(`  开盘卖出/收盘买回 胜率    ${all.sellWin.toFixed(1)}%   期望收益 ${pct(all.eSellOpen)}%`);
console.log(`  日内平均(开→收)          ${pct(base.reduce((a, r) => a + r.body, 0) / all.n)}%`);

console.log('\n=== 按跳空幅度分桶（上证指数）===');
console.log('  区间          n    低走率   开盘减仓胜率  期望减仓收益  全天期望   跳空回补率');
const rows = [];
for (const [label, pred] of BUCKETS) {
  const st = stats(base, pred);
  if (!st.n) continue;
  const p = binomTest2(Math.round((st.fadeRate / 100) * st.n), st.n, all.fadeRate / 100);
  rows.push({ label, ...st, p });
  console.log(
    `  ${label.padEnd(11)} ${String(st.n).padStart(4)}  ${st.fadeRate.toFixed(1).padStart(5)}%  ${st.sellWin.toFixed(1).padStart(9)}%  ` +
      `${pct(st.eSellOpen).padStart(10)}%  ${pct(st.eDay).padStart(8)}%  ${st.filledRate.toFixed(1).padStart(7)}%  ${p < 0.05 ? `p=${p.toFixed(4)}` : ''}`,
  );
}
const minP = Math.min(...rows.map((r) => r.p));
console.log(`\n  最小 p = ${minP.toFixed(4)}；${rows.length} 个分桶多重比较的 Bonferroni 阈值 = 0.05/${rows.length} = ${(0.05 / rows.length).toFixed(4)}`);
console.log(`  → ${minP < 0.05 / rows.length ? '有分桶通过校正' : '★ 没有任何分桶通过 Bonferroni 校正'}`);

// ---------- 分时代稳定性 ----------
console.log('\n=== 分时代稳定性（若规律真实，应在各时段方向一致）===');
const ERAS = [['2010-2015', '2010-01-01', '2015-12-31'], ['2016-2020', '2016-01-01', '2020-12-31'], ['2021-2026', '2021-01-01', '2026-12-31']];
console.log('  时段        高开(>0.5%)低走率   期望减仓收益   低开(<-0.5%)高走率  期望(开盘-收盘)');
for (const [name, a, b] of ERAS) {
  const r = build('sh', { from: a, to: b });
  const up = stats(r, (g) => g >= 0.5);
  const dn = stats(r, (g) => g <= -0.5);
  console.log(
    `  ${name}   ${up.fadeRate.toFixed(1).padStart(9)}% (n=${String(up.n).padStart(3)})  ${pct(up.eSellOpen).padStart(9)}%  ` +
      `${(100 - dn.fadeRate).toFixed(1).padStart(10)}% (n=${String(dn.n).padStart(3)})  ${pct(-dn.eSellOpen).padStart(9)}%`,
  );
}

// ---------- 跨指数复现 ----------
console.log('\n=== 跨指数复现（同一规律是否在别的指数上成立）===');
console.log('  指数        高开(>0.5%)低走率  期望减仓收益   低开(<-0.5%)低走率  期望减仓收益');
for (const key of Object.keys(J.series)) {
  const r = build(key);
  const up = stats(r, (g) => g >= 0.5);
  const dn = stats(r, (g) => g <= -0.5);
  console.log(
    `  ${J.series[key].name.padEnd(8)}  ${up.fadeRate.toFixed(1).padStart(10)}% (n=${String(up.n).padStart(3)})  ${pct(up.eSellOpen).padStart(9)}%  ` +
      `${dn.fadeRate.toFixed(1).padStart(11)}% (n=${String(dn.n).padStart(3)})  ${pct(dn.eSellOpen).padStart(9)}%`,
  );
}

// ---------- 递减/递增趋势检验 ----------
console.log('\n=== 单调性检验：低走率是否随高开幅度递增 ===');
const upBuckets = rows.filter((r) => ['0.2~0.5%', '0.5~1%', '1~2%', '≥2%'].includes(r.label));
console.log('  ' + upBuckets.map((r) => `${r.label}=${r.fadeRate.toFixed(1)}%(n=${r.n})`).join('  '));
const xs = upBuckets.map((r) => parseFloat(r.label) || 2);
const ys = upBuckets.map((r) => r.fadeRate);
const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
const vx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
const vy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
console.log(`  加权相关 r = ${(cov / (vx * vy)).toFixed(3)}（仅 4 个点，参考意义有限）`);

// ---------- 极端高开 ----------
console.log('\n=== 极端高开（≥1%）的完整画像 ===');
const big = base.filter((r) => r.gap >= 1);
const veryBig = base.filter((r) => r.gap >= 2);
for (const [nm, s] of [['高开≥1%', big], ['高开≥2%', veryBig]]) {
  const n = s.length;
  if (!n) continue;
  const mean = (f) => s.reduce((a, r) => a + f(r), 0) / n;
  console.log(
    `  ${nm}: n=${n}  低走 ${(s.filter((r) => r.body < 0).length / n * 100).toFixed(1)}%  ` +
      `开盘减仓期望 ${pct(mean((r) => r.sellOpen))}%  中位 ${(() => { const a = s.map((r) => r.sellOpen).sort((x, y) => x - y); return a[Math.floor(n / 2)].toFixed(2); })()}%  ` +
      `全天期望 ${pct(mean((r) => r.day))}%  回补 ${(s.filter((r) => r.filled).length / n * 100).toFixed(1)}%`,
  );
}
