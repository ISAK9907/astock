// 阈值寻优：以「局部低点（曲线反转）」为客观目标，评估各跌停家数阈值的信噪比
import { readFileSync } from 'node:fs';

const dtRaw = JSON.parse(readFileSync('dt-counts.json', 'utf8')).counts;
const sh = JSON.parse(readFileSync('candles.json', 'utf8')).series.find((s) => s.key === 'sh').bars;
const idxOf = new Map(sh.map((r, i) => [r.d, i]));

const W = 5; // 局部低点判定窗口
const rows = [];
for (const d of Object.keys(dtRaw).sort()) {
  const i = idxOf.get(d);
  if (i === undefined || i < 1) continue;
  const cur = sh[i], prev = sh[i - 1];
  const fwd = (n) => (i + n < sh.length ? (sh[i + n].c / cur.c - 1) * 100 : null);

  // 局部低点：前后各 W 日内的最低收盘
  let isLow = true;
  for (let k = Math.max(0, i - W); k <= Math.min(sh.length - 1, i + W); k++) {
    if (sh[k].c < cur.c) { isLow = false; break; }
  }
  // 距最近局部低点的天数（用来看是否「贴着底」）
  rows.push({
    d,
    i,
    dt: dtRaw[d].dt,
    ret: (cur.c / prev.c - 1) * 100,
    f1: fwd(1), f3: fwd(3), f5: fwd(5), f10: fwd(10),
    isLow,
  });
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const rate = (a, k, th = 0) => (a.length ? (a.filter((r) => r[k] !== null && r[k] > th).length / a.length) * 100 : NaN);

const lows = rows.filter((r) => r.isLow);
const baseLow = (lows.length / rows.length) * 100;
const baseF5 = rate(rows, 'f5');
const baseF10 = rate(rows, 'f10', 2);

console.log(`样本 ${rows.length} 天 | 局部低点 ${lows.length} 天（基准率 ${baseLow.toFixed(1)}%）`);
console.log(`基准: 5日胜率 ${baseF5.toFixed(1)}% | 10日涨>2% 概率 ${baseF10.toFixed(1)}%\n`);

console.log('阈值  命中   占全部   是局部低点   低点命中率(lift)   5日均值   5日胜率   10日均值  10日>2%');
for (const T of [20, 25, 30, 40, 50, 60, 75, 90, 100, 120, 135, 150, 180]) {
  const g = rows.filter((r) => r.dt >= T);
  if (!g.length) { console.log(`${String(T).padStart(4)}      0`); continue; }
  const gLow = g.filter((r) => r.isLow).length;
  const hitRate = (gLow / g.length) * 100;
  const lift = hitRate / baseLow;
  console.log(
    `${String(T).padStart(4)}  ${String(g.length).padStart(5)}  ${((g.length / rows.length) * 100).toFixed(0).padStart(5)}%  ` +
      `${String(gLow).padStart(9)} (${hitRate.toFixed(0).padStart(3)}%)  ${lift.toFixed(2).padStart(12)}x  ` +
      `${mean(g.map((r) => r.f5 ?? NaN).filter(Number.isFinite)).toFixed(2).padStart(8)}%  ` +
      `${rate(g, 'f5').toFixed(0).padStart(6)}%  ` +
      `${mean(g.map((r) => r.f10 ?? NaN).filter(Number.isFinite)).toFixed(2).padStart(8)}%  ` +
      `${rate(g, 'f10', 2).toFixed(0).padStart(7)}%`,
  );
}

console.log('\n=== 局部低点当天的跌停家数分布 ===');
const lowDt = lows.map((r) => r.dt).sort((a, b) => b - a);
console.log('  低点跌停家数:', lowDt.join(', '));
const q = (p) => lowDt[Math.min(lowDt.length - 1, Math.floor(p * lowDt.length))];
console.log(`  低点中位数 ${q(0.5)}  上四分位 ${q(0.25)}  最高 ${lowDt[0]}`);

console.log('\n=== 哪些局部低点没有被覆盖（漏报）===');
const missed = lows.filter((r) => r.dt < 50).map((r) => `${r.d}(${r.dt}家)`);
console.log('  跌停<50 的低点:', missed.length, '天 →', missed.join(' '));
