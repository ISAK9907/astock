// 二维条件：T 日状态（含极端行情）× T+1 集合竞价跳空 → T+1 日内走势
//   关键：两个条件在 T+1 开盘那一刻**都已观测到**，所以是可执行的。
//   T 日状态用日线可算的代理（涨跌、收盘在当日区间的位置、振幅），另用真实跌停家数做小样本补充。
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const DT = JSON.parse(readFileSync('dt-stats.json', 'utf8')).daily;
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tStat = (a) => (a.length < 5 ? NaN : mean(a) / (sd(a) / Math.sqrt(a.length)));

function build(key) {
  const bars = J.series[key].bars.filter((b) => b.d < TODAY);
  const out = [];
  for (let i = 2; i < bars.length; i++) {
    const t = bars[i - 1], tl = bars[i - 2], x = bars[i]; // T-1, T, T+1
    const retT = (t.c / tl.c - 1) * 100;
    const rng = t.h - t.l;
    const closePos = rng > 0 ? (t.c - t.l) / rng : 0.5;      // 收盘在当日区间的位置：0=最低 1=最高
    const dropFromHigh = rng > 0 ? (t.h - t.c) / t.h * 100 : 0; // 从当日最高回落多少（"冲高回落"强度）
    const gap = (x.o / t.c - 1) * 100;                        // T+1 集合竞价跳空
    out.push({
      d: x.d, idx: J.series[key].name,
      retT, closePos, dropFromHigh, rng: (rng / tl.c) * 100,
      dtT: DT[t.d] ? DT[t.d].dt : null,                       // T 日跌停家数（收盘后已知）
      gap,
      intraday: (x.c / x.o - 1) * 100,                        // T+1 日内（开→收）
      sellOpen: ((x.o - x.c) / x.o) * 100,                    // T+1 开盘减仓收益
      up: (x.h / x.o - 1) * 100, dn: (x.l / x.o - 1) * 100,
      day: (x.c / t.c - 1) * 100,
    });
  }
  return out;
}
const pool = Object.keys(J.series).flatMap(build);
console.log(`样本：四指数池化 ${pool.length} 个 (T, T+1) 对，2010-2026`);
console.log(`无条件：T+1 日内(开→收) ${pct(mean(pool.map((r) => r.intraday)))}，开盘减仓 ${pct(mean(pool.map((r) => r.sellOpen)))}（基准均值为负，说明日内漂移为正）\n`);

const GAPS = [
  ['低开<-1%', (g) => g < -1], ['低开-1~-0.3%', (g) => g >= -1 && g < -0.3],
  ['平开±0.3%', (g) => g >= -0.3 && g <= 0.3], ['高开0.3~1%', (g) => g > 0.3 && g <= 1],
  ['高开>1%', (g) => g > 1],
];
const STATES = [
  ['T日恐慌(≤-1.5%)', (r) => r.retT <= -1.5], ['T日偏弱(-1.5~-0.3%)', (r) => r.retT > -1.5 && r.retT <= -0.3],
  ['T日平稳', (r) => r.retT > -0.3 && r.retT < 0.3], ['T日偏强(0.3~1.5%)', (r) => r.retT >= 0.3 && r.retT < 1.5],
  ['T日亢奋(≥1.5%)', (r) => r.retT >= 1.5],
];

console.log('=== 矩阵一：T 日涨跌 × T+1 跳空 → T+1 日内（开→收）均值 ===');
console.log('  （正数=T+1 开盘后继续涨；负数=T+1 开盘后回落，"减仓"赚的是它的相反数）\n');
console.log('  T日状态 \\ T+1跳空    ' + GAPS.map(([n]) => n.padStart(15)).join(''));
for (const [sn, sp] of STATES) {
  const cells = GAPS.map(([, gp]) => {
    const s = pool.filter((r) => sp(r) && gp(r.gap));
    return s.length >= 15 ? `${mean(s.map((r) => r.intraday)).toFixed(2).padStart(7)}%(n=${String(s.length).padStart(3)})` : `${'样本少'.padStart(7)}(n=${String(s.length).padStart(3)})`;
  });
  console.log(`  ${sn.padEnd(20)}` + cells.map((c) => c.padStart(15)).join(''));
}

console.log('\n=== 矩阵二：T 日「收盘强度」(收盘在当日高低区间的位置) × T+1 跳空 ===');
const CPS = [['T收盘在最低1/3', (r) => r.closePos < 1 / 3], ['T收盘居中', (r) => r.closePos >= 1 / 3 && r.closePos < 2 / 3], ['T收盘在最高1/3', (r) => r.closePos >= 2 / 3]];
console.log('  T收盘强度 \\ T+1跳空   ' + GAPS.map(([n]) => n.padStart(15)).join(''));
for (const [sn, sp] of CPS) {
  const cells = GAPS.map(([, gp]) => {
    const s = pool.filter((r) => sp(r) && gp(r.gap));
    return s.length >= 15 ? `${mean(s.map((r) => r.intraday)).toFixed(2).padStart(7)}%(n=${String(s.length).padStart(3)})` : `${'样本少'.padStart(7)}(n=${String(s.length).padStart(3)})`;
  });
  console.log(`  ${sn.padEnd(20)}` + cells.map((c) => c.padStart(15)).join(''));
}

console.log('\n=== 矩阵三：T 日「冲高回落」幅度 × T+1 跳空 ===');
const DFS = [['T自高点回落<1%', (r) => r.dropFromHigh < 1], ['T回落1~3%', (r) => r.dropFromHigh >= 1 && r.dropFromHigh < 3], ['T回落≥3%', (r) => r.dropFromHigh >= 3]];
console.log('  T回落幅度 \\ T+1跳空   ' + GAPS.map(([n]) => n.padStart(15)).join(''));
for (const [sn, sp] of DFS) {
  const cells = GAPS.map(([, gp]) => {
    const s = pool.filter((r) => sp(r) && gp(r.gap));
    return s.length >= 15 ? `${mean(s.map((r) => r.intraday)).toFixed(2).padStart(7)}%(n=${String(s.length).padStart(3)})` : `${'样本少'.padStart(7)}(n=${String(s.length).padStart(3)})`;
  });
  console.log(`  ${sn.padEnd(20)}` + cells.map((c) => c.padStart(15)).join(''));
}

// ---------- 真实跌停家数（300 天窗口）----------
console.log('\n=== 矩阵四：T 日跌停家数（真实情绪） × T+1 跳空（样本窗口 2025-07 起）===');
const withDt = pool.filter((r) => r.dtT != null);
console.log(`  可用样本 ${withDt.length} 天`);
const DTS = [['T跌停≥40家', (r) => r.dtT >= 40], ['T跌停10~40家', (r) => r.dtT >= 10 && r.dtT < 40], ['T跌停<10家', (r) => r.dtT < 10]];
console.log('  T跌停家数 \\ T+1跳空  ' + GAPS.map(([n]) => n.padStart(15)).join(''));
for (const [sn, sp] of DTS) {
  const cells = GAPS.map(([, gp]) => {
    const s = withDt.filter((r) => sp(r) && gp(r.gap));
    return s.length >= 8 ? `${mean(s.map((r) => r.intraday)).toFixed(2).padStart(7)}%(n=${String(s.length).padStart(3)})` : `${'样本少'.padStart(7)}(n=${String(s.length).padStart(3)})`;
  });
  console.log(`  ${sn.padEnd(20)}` + cells.map((c) => c.padStart(15)).join(''));
}

// ---------- 最有希望的格子做完整画像 ----------
console.log('\n=== 候选格子的完整画像（T+1 开盘减仓视角）===');
const CAND = [
  ['T恐慌 + T+1高开>1%', (r) => r.retT <= -1.5 && r.gap > 1],
  ['T恐慌 + T+1低开<-1%', (r) => r.retT <= -1.5 && r.gap < -1],
  ['T亢奋 + T+1高开>1%', (r) => r.retT >= 1.5 && r.gap > 1],
  ['T收盘最低1/3 + T+1高开>0.3%', (r) => r.closePos < 1 / 3 && r.gap > 0.3],
  ['T收盘最高1/3 + T+1高开>0.3%', (r) => r.closePos >= 2 / 3 && r.gap > 0.3],
  ['T回落≥3% + T+1高开>0.3%', (r) => r.dropFromHigh >= 3 && r.gap > 0.3],
  ['T跌停≥40 + T+1高开>0%', (r) => r.dtT >= 40 && r.gap > 0],
  ['T跌停≥40 + T+1低开<0%', (r) => r.dtT >= 40 && r.gap < 0],
];
console.log('  条件                              n    减仓期望   t值    低走率   上行空间  下行空间');
for (const [nm, pred] of CAND) {
  const s = pool.filter(pred);
  if (s.length < 8) { console.log(`  ${nm.padEnd(32)} n=${s.length} 样本过少`); continue; }
  const v = s.map((r) => r.sellOpen);
  const t = tStat(v);
  console.log(
    `  ${nm.padEnd(32)} ${String(s.length).padStart(4)}  ${pct(mean(v)).padStart(8)}  ${(isNaN(t) ? '—' : t.toFixed(2)).padStart(6)}  ` +
      `${(s.filter((r) => r.sellOpen > 0).length / s.length * 100).toFixed(1).padStart(5)}%  ` +
      `${pct(mean(s.map((r) => r.up))).padStart(8)}  ${pct(mean(s.map((r) => r.dn))).padStart(8)}`,
  );
}

// ---------- 分时代稳定性 ----------
console.log('\n=== 分时代稳定性（只测候选里样本够的）===');
const ERAS = [['2010-2013', 2010, 2013], ['2014-2017', 2014, 2017], ['2018-2021', 2018, 2021], ['2022-2026', 2022, 2026]];
for (const [nm, pred] of CAND) {
  const s = pool.filter(pred);
  if (s.length < 30) continue;
  const parts = ERAS.map(([en, a, b]) => {
    const q = s.filter((r) => { const y = +r.d.slice(0, 4); return y >= a && y <= b; });
    return q.length >= 5 ? { en, n: q.length, m: mean(q.map((r) => r.sellOpen)) } : null;
  }).filter(Boolean);
  const pos = parts.filter((p) => p.m > 0).length;
  console.log(`  ${nm.padEnd(32)} ${parts.map((p) => `${p.en}:${pct(p.m, 2)}(${p.n})`).join(' ')}  → ${pos}/${parts.length} 为正`);
}
