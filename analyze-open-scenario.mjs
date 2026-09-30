// 开盘跳空情景统计 → open-scenario.json
//
// 目的：把「跳空到什么程度 → 日内回落/反弹的概率」做成**可查的历史情景参考**，
// 而不是每天跟踪的信号。跳空每天都有，所以每一档都有样本 ——
// 不像原来那套「T日状态 × 跳空阈值」规则，16 年只触发 105 次（2.6%），查无可查。
//
// ⚠️ 关键做法：自变量用「跳空 ÷ 20日已实现波动率」（记作 z），不用绝对跳空幅度。
//    原因：+2% 在低波环境是极端事件，在高波环境只是噪音。
//    实测绝对跳空几乎测不出方向（各档日内回落率都贴着基准 45~48%），
//    换成 z 之后单调关系立刻显现：z 越大，日内回落概率越高、日内收益越低。
//
// ⚠️ 三个必须一并交代的诚实性问题（不写出来就是误导）：
//   1) 极端档样本极少（z≥2 全样本只有 10 个交易日），点估计不可靠 → 一并给样本量、二项检验 p 值。
//   2) 四个指数**高度相关**（同一天一起跳空），合并**不会**增加独立样本，属伪重复。
//      所以逐指数单独算，其他指数只用于交叉验证方向是否一致。
//   3) 16 年市场结构变过，故给出前/后段分段结果；只有两段方向一致才算「稳健」。
import { readFileSync, writeFileSync } from 'node:fs';

const L = JSON.parse(readFileSync('daily-long.json', 'utf8'));

// 分档：中间粗、顶部细 —— 顶部正是信号所在，要看清单调性
const ZB = [
  { lo: -Infinity, hi: -2, label: '≤ −2', side: 'low' },
  { lo: -2, hi: -1, label: '−2 ~ −1', side: 'low' },
  { lo: -1, hi: -0.5, label: '−1 ~ −0.5', side: 'low' },
  { lo: -0.5, hi: 0, label: '−0.5 ~ 0', side: 'mid' },
  { lo: 0, hi: 0.5, label: '0 ~ 0.5', side: 'mid' },
  { lo: 0.5, hi: 1, label: '0.5 ~ 1', side: 'high' },
  { lo: 1, hi: 1.5, label: '1 ~ 1.5', side: 'high' },
  { lo: 1.5, hi: 2, label: '1.5 ~ 2', side: 'high' },
  { lo: 2, hi: 2.5, label: '2 ~ 2.5', side: 'high' },
  { lo: 2.5, hi: Infinity, label: '≥ 2.5', side: 'high' },
];

/** 正态近似的二项检验（与 sentiment-backtest.mjs 同口径），双侧 p */
function binomP(k, n, p0) {
  if (!n) return 1;
  const p = k / n;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  if (!se) return 1;
  const z = (p - p0) / se;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const cdf = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * (1 - (z > 0 ? cdf : 1 - cdf)));
}

function buildSeries(bars) {
  const rets = [];
  const rows = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c, o = bars[i].o, c = bars[i].c;
    if (!(prev > 0 && o > 0 && c > 0)) { rets.push(0); continue; }
    rets.push((c / prev - 1) * 100);
    rows.push({
      d: bars[i].d,
      i,
      gap: (o / prev - 1) * 100,
      intra: (c / o - 1) * 100,
      full: (c / prev - 1) * 100,
    });
  }
  for (const x of rows) {
    const w = rets.slice(Math.max(0, x.i - 20), x.i);
    x.sd = w.length >= 10 ? Math.sqrt(w.reduce((a, v) => a + v * v, 0) / w.length) : null;
    x.z = x.sd ? x.gap / x.sd : null;
  }
  return rows.filter((x) => x.z != null);
}

const agg = (rows, base) => {
  const n = rows.length;
  if (!n) return null;
  const fadeK = rows.filter((r) => r.intra < 0).length;
  const meanIntra = rows.reduce((a, r) => a + r.intra, 0) / n;
  const meanFull = rows.reduce((a, r) => a + r.full, 0) / n;
  return {
    n,
    fade: +((fadeK / n) * 100).toFixed(1),
    fadeK,
    meanIntra: +meanIntra.toFixed(3),
    meanFull: +meanFull.toFixed(3),
    meanGap: +(rows.reduce((a, r) => a + r.gap, 0) / n).toFixed(3),
    pVsBase: base ? +binomP(fadeK, n, base / 100).toFixed(4) : null,
    edge: base ? +(((fadeK / n) * 100) - base).toFixed(1) : null,
  };
};

const out = { generatedAt: new Date().toISOString(), source: 'daily-long.json（东财日线，2010 起 4000 根）', zAxis: true, indices: {}, extremes: [] };

for (const [key, s] of Object.entries(L.series)) {
  const rows = buildSeries(s.bars);
  const base = agg(rows, null);
  const half = Math.floor(rows.length / 2);
  const splitDate = rows[half]?.d ?? null;

  const buckets = ZB.map((b) => {
    const r = rows.filter((x) => x.z >= b.lo && x.z < b.hi);
    const st = agg(r, base.fade);
    if (!st) return { ...b, n: 0 };
    // 分段：两段方向是否都偏向同一边（与基准比）
    const r1 = r.filter((x) => x.d < splitDate);
    const r2 = r.filter((x) => x.d >= splitDate);
    const s1 = agg(r1, base.fade), s2 = agg(r2, base.fade);
    const dir = (v) => (v == null ? 0 : v > base.fade + 1 ? 1 : v < base.fade - 1 ? -1 : 0);
    const d1 = dir(s1?.fade), d2 = dir(s2?.fade);
    return {
      ...b,
      ...st,
      h1: s1 ? { n: s1.n, fade: s1.fade } : { n: 0, fade: null },
      h2: s2 ? { n: s2.n, fade: s2.fade } : { n: 0, fade: null },
      stable: d1 !== 0 && d1 === d2,
      sig: st.pVsBase < 0.05,
    };
  });

  out.indices[key] = { name: s.name, from: s.bars[0].d, to: s.bars.at(-1).d, base, splitAt: splitDate, buckets };

  // 极端高开（z≥2）的逐日明细：这是「典型情景」最有说服力的部分
  for (const x of rows.filter((r) => r.z >= 2)) {
    out.extremes.push({
      d: x.d,
      key,
      name: s.name,
      gap: +x.gap.toFixed(2),
      z: +x.z.toFixed(2),
      intra: +x.intra.toFixed(2),
      full: +x.full.toFixed(2),
    });
  }
}

// 按日期归并：同一天四个指数一起跳空，展示时合并成一行
const byDate = new Map();
for (const e of out.extremes) {
  if (!byDate.has(e.d)) byDate.set(e.d, { d: e.d, n: 0, maxZ: 0, items: [] });
  const g = byDate.get(e.d);
  g.n++;
  g.maxZ = Math.max(g.maxZ, e.z);
  g.items.push(e);
}
out.extremeDays = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : 1)).map((g) => {
  const sh = g.items.find((x) => x.key === 'sh') ?? g.items[0];
  return { d: g.d, n: g.n, maxZ: +g.maxZ.toFixed(2), gap: sh.gap, intra: sh.intra, full: sh.full, ref: sh.name };
});
out.extremes = undefined; // 逐指数明细并进 extremeDays，避免重复体积

writeFileSync('open-scenario.json', JSON.stringify(out, null, 1), 'utf8');

// 人眼核对
for (const [key, v] of Object.entries(out.indices)) {
  console.log(`\n===== ${v.name}  ${v.from} → ${v.to}  基准日内回落 ${v.base.fade}%  n=${v.base.n} =====`);
  console.log('  z 档        样本  P(日内回落)  与基准   平均跳空   平均日内   显著性   分段一致');
  for (const b of v.buckets) {
    if (!b.n) { console.log(`  ${b.label.padEnd(11)} ${'0'.padStart(5)}      —`); continue; }
    const sig = b.sig ? (b.pVsBase < 0.01 ? '**' : '*') : ' ';
    console.log(
      `  ${b.label.padEnd(11)} ${String(b.n).padStart(5)}  ${String(b.fade).padStart(7)}%  ${((b.edge >= 0 ? '+' : '') + b.edge.toFixed(1)).padStart(6)}pp  ` +
        `${((b.meanGap >= 0 ? '+' : '') + b.meanGap.toFixed(2)).padStart(7)}%  ${((b.meanIntra >= 0 ? '+' : '') + b.meanIntra.toFixed(3)).padStart(9)}%   ` +
        `p=${b.pVsBase.toFixed(3)}${sig}  ${b.stable ? '✓' : '✗'} (${b.h1.fade ?? '-'}%/${b.h2.fade ?? '-'}%)`,
    );
  }
}
console.log(`\n极端高开（z≥2）共 ${out.extremeDays.length} 个交易日：`);
for (const g of out.extremeDays) {
  console.log(`  ${g.d}  上证跳空${g.gap >= 0 ? '+' : ''}${g.gap}%  日内${g.intra >= 0 ? '+' : ''}${g.intra}%  全天${g.full >= 0 ? '+' : ''}${g.full}%  当日命中指数 ${g.n}/4`);
}
console.log('\nwrote open-scenario.json');
