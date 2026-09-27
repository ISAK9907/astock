// 情绪指标 + 反弹概率预测 + 走查式（walk-forward）样本外回测
//
// 设计原则：
//  1. 所有特征只用「当日及之前」的数据，绝不使用未来信息（无前视）
//  2. 不用 15 个跌停事件建模（样本太小必过拟合），用全部交易日
//  3. 回测采用扩展窗口 walk-forward，预测全部为样本外
//  4. 始终与「无条件基准概率」对比，并做二项检验
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('dt-counts.json', 'utf8')).counts;
// 上证指数序列取 daily-long.json（4001 根，2010 起），不用 candles.json（只有 501 根）——
// 后者会把可用区间截到约两年，窗口设成 743 也只能切出 500 天。
const sh = JSON.parse(readFileSync('daily-long.json', 'utf8')).series.sh.bars;

const WINDOW = Number(process.env.DT_WINDOW ?? 743);
const shIdx = new Map(sh.map((r, i) => [r.d, i]));

// ---------- 情绪指标 ----------
// score / sent / 档位的定义全部集中在 sentiment-map.mjs，与 analyze-dt.mjs 共用同一份实现，
// 避免两处各写一份公式后悄悄漂移（这个项目已经栽过一次同类问题）。
import { scoreOf, makeSentOf, tiers as tierDefs } from './sentiment-map.mjs';

const dates = Object.keys(raw).sort();
const windowDates = dates.slice(-WINDOW);

const rows = [];
// 第一遍：只收集 score —— 正态映射需要整段样本的经验分位，所以必须先扫一遍
const sentMap = new Map();
{
  const scoreRows = [];
  for (const d of windowDates) {
    const i = shIdx.get(d);
    if (i === undefined || i < 25) continue;
    scoreRows.push({ d, score: scoreOf(raw[d]) });
  }
  const sentArr = makeSentOf(scoreRows.map((r) => r.score));
  scoreRows.forEach((r, i) => sentMap.set(r.d, sentArr[i]));
}

for (let k = 0; k < windowDates.length; k++) {
  const d = windowDates[k];
  const i = shIdx.get(d);
  if (i === undefined || i < 25) continue;
  const v = raw[d];
  const closes = sh.slice(Math.max(0, i - 19), i + 1).map((r) => r.c);
  const ma20 = closes.reduce((a, b) => a + b, 0) / closes.length;
  const hi20 = Math.max(...sh.slice(Math.max(0, i - 19), i + 1).map((r) => r.h));

  // 连续下跌天数（只用历史）
  let consec = 0;
  for (let j = i; j > 0 && sh[j].c < sh[j - 1].c; j--) consec++;

  const cap = v.allCap ? (v.dtCap / v.allCap) * 100 : 0;
  const score = scoreOf(v);

  rows.push({
    d, i,
    sent: +(sentMap.get(d) ?? 50).toFixed(1),
    score: +score.toFixed(2),
    dt: v.dt, cap: +cap.toFixed(2), mem: v.mem,
    // 特征（均无前视）
    f_sent: sentMap.get(d) ?? 50,
    f_ma20dev: (sh[i].c / ma20 - 1) * 100,
    f_dd20: (sh[i].c / hi20 - 1) * 100,
    f_consec: consec,
    // 标签（用未来数据，仅作评估）
    ret1: i + 1 < sh.length ? (sh[i + 1].c / sh[i].c - 1) * 100 : null,
    ret5: i + 5 < sh.length ? (sh[i + 5].c / sh[i].c - 1) * 100 : null,
    ret10: i + 10 < sh.length ? (sh[i + 10].c / sh[i].c - 1) * 100 : null,
  });
}

console.log(`样本 ${rows.length} 个交易日 (${rows[0].d} → ${rows.at(-1).d})\n`);

// ---------- 工具 ----------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function binomP(k, n, p) {
  // 双尾二项检验（正态近似）
  if (n === 0) return 1;
  const mu = n * p, sd = Math.sqrt(n * p * (1 - p)) || 1e-9;
  const z = Math.abs(k - mu) / sd;
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 2 * tail;
}
function fitLogistic(X, y, { lr = 0.3, epochs = 800, l2 = 0.02 } = {}) {
  const n = X.length, d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = 1 / (1 + Math.exp(-z)) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}
const predict = (m, x) => {
  let z = m.b;
  for (let j = 0; j < x.length; j++) z += m.w[j] * x[j];
  return 1 / (1 + Math.exp(-z));
};

// ---------- 1. 情绪指标分档 → 无条件反弹概率 ----------
console.log('=== 情绪指标分档 → 次日反弹概率（样本内，仅作描述）===');
console.log('情绪区间      天数   P(次日涨)   P(5日涨)   P(10日涨)   次日均值    5日均值');
const BINS = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];
for (const [lo, hi] of BINS) {
  const g = rows.filter((r) => r.sent >= lo && r.sent < hi);
  if (!g.length) continue;
  const p1 = (g.filter((r) => r.ret1 !== null && r.ret1 > 0).length / g.filter((r) => r.ret1 !== null).length) * 100;
  const p5 = (g.filter((r) => r.ret5 !== null && r.ret5 > 0).length / g.filter((r) => r.ret5 !== null).length) * 100;
  const p10 = (g.filter((r) => r.ret10 !== null && r.ret10 > 0).length / g.filter((r) => r.ret10 !== null).length) * 100;
  console.log(
    `${String(lo).padStart(3)}-${String(hi === 101 ? 100 : hi).padStart(3)}    ${String(g.length).padStart(4)}  ` +
      `${p1.toFixed(1).padStart(8)}%  ${p5.toFixed(1).padStart(8)}%  ${p10.toFixed(1).padStart(9)}%  ` +
      `${mean(g.filter((r) => r.ret1 !== null).map((r) => r.ret1)).toFixed(2).padStart(8)}%  ` +
      `${mean(g.filter((r) => r.ret5 !== null).map((r) => r.ret5)).toFixed(2).padStart(8)}%`,
  );
}
const all1 = rows.filter((r) => r.ret1 !== null);
const base1 = (all1.filter((r) => r.ret1 > 0).length / all1.length) * 100;
console.log(`\n无条件基准 P(次日涨) = ${base1.toFixed(1)}%  (n=${all1.length})`);

// ---------- 2. 走查式样本外回测 ----------
const FEATS = [
  { name: '情绪', get: (r) => r.f_sent },
  { name: '偏离MA20', get: (r) => r.f_ma20dev },
  { name: '20日回撤', get: (r) => r.f_dd20 },
  { name: '连跌天数', get: (r) => r.f_consec },
];
const FEATSETS = [
  { label: '仅情绪', idx: [0] },
  { label: '情绪+偏离MA20', idx: [0, 1] },
  { label: '情绪+偏离MA20+回撤', idx: [0, 1, 2] },
  { label: '全部4个特征', idx: [0, 1, 2, 3] },
];

const labeled = rows.filter((r) => r.ret1 !== null);
const y = labeled.map((r) => (r.ret1 > 0 ? 1 : 0));

function walkForward(featIdx, { minTrain = 100, step = 5 } = {}) {
  const X = labeled.map((r) => featIdx.map((j) => FEATS[j].get(r)));
  const preds = [];
  for (let t = minTrain; t < X.length; t += step) {
    const trainX = X.slice(0, t), trainY = y.slice(0, t);
    // 标准化（用训练集统计）
    const mu = trainX[0].map((_, j) => mean(trainX.map((r) => r[j])));
    const sd = trainX[0].map((_, j) => {
      const v = trainX.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / trainX.length;
      return Math.sqrt(v) || 1;
    });
    const Z = (x) => x.map((v, j) => (v - mu[j]) / sd[j]);
    const model = fitLogistic(trainX.map(Z), trainY);
    for (let k = t; k < Math.min(t + step, X.length); k++) {
      preds.push({ i: k, p: predict(model, Z(X[k])), actual: y[k], d: labeled[k].d });
    }
  }
  return preds;
}

console.log('\n=== 走查式样本外回测（扩展窗口，起始训练 100 天，每 5 天重拟合）===');
console.log('特征集                    样本外n  预测准确率   基准准确率   提升      Brier');
const results = [];
for (const fs of FEATSETS) {
  const preds = walkForward(fs.idx);
  const acc = (preds.filter((p) => (p.p >= 0.5 ? 1 : 0) === p.actual).length / preds.length) * 100;
  const baseAcc = (preds.filter((p) => 1 === p.actual).length / preds.length) * 100; // 恒预测「涨」
  const brier = mean(preds.map((p) => (p.p - p.actual) ** 2));
  results.push({ label: fs.label, preds, acc, brier });
  console.log(
    `${fs.label.padEnd(24)} ${String(preds.length).padStart(6)}  ${acc.toFixed(1).padStart(9)}%  ` +
      `${baseAcc.toFixed(1).padStart(10)}%  ${(acc - baseAcc >= 0 ? '+' : '') + (acc - baseAcc).toFixed(1)}%  ${brier.toFixed(4)}`,
  );
}

// ---------- 3. 按预测概率分层看胜率 ----------
const best = results.reduce((a, b) => (b.brier < a.brier ? b : a));
console.log(`\n=== 最优特征集（按 Brier）= ${best.label} ===`);
console.log('预测概率区间      样本   实际次日涨概率   均值次日收益   与基准差   二项p值');
for (const [lo, hi] of [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1.01]]) {
  const g = best.preds.filter((p) => p.p >= lo && p.p < hi);
  if (g.length < 3) { console.log(`${lo.toFixed(2)}-${hi.toFixed(2)}          ${String(g.length).padStart(4)}  (样本过少)`); continue; }
  const k = g.filter((p) => p.actual === 1).length;
  const actual = (k / g.length) * 100;
  const mret = mean(g.map((p) => labeled[p.i].ret1));
  const pv = binomP(k, g.length, base1 / 100);
  console.log(
    `${lo.toFixed(2)}-${hi.toFixed(2)}          ${String(g.length).padStart(4)}  ${actual.toFixed(1).padStart(13)}%  ` +
      `${mret.toFixed(2).padStart(11)}%  ${(actual - base1 >= 0 ? '+' : '') + (actual - base1).toFixed(1)}%  ${pv.toFixed(3)}`,
  );
}

// ---------- 4. 高置信信号的实际表现 ----------
console.log('\n=== 高置信度信号（模型概率 ≥ 0.6）的实际结果 ===');
const hi = best.preds.filter((p) => p.p >= 0.6);
if (hi.length) {
  const k = hi.filter((p) => p.actual === 1).length;
  console.log(`  触发 ${hi.length} 次，次日上涨 ${k} 次 = ${((k / hi.length) * 100).toFixed(1)}%  (基准 ${base1.toFixed(1)}%, p=${binomP(k, hi.length, base1 / 100).toFixed(3)})`);
  console.log(`  平均次日收益 ${mean(hi.map((p) => labeled[p.i].ret1)).toFixed(2)}%  平均5日收益 ${mean(hi.map((p) => labeled[p.i].ret5).filter(Number.isFinite)).toFixed(2)}%`);
  console.log(`  触发日: ${hi.map((p) => p.d.slice(5)).join(' ')}`);
} else {
  console.log('  无触发');
}

// ---------- 输出 ----------
// ---------- 5. 阈值敏感性：极端情绪日的条件概率 ----------
console.log('\n=== 阈值敏感性：情绪 ≥ T 的次日反弹概率 ===');
console.log('阈值T   触发   次日涨   胜率      基准   差     二项p值   5日胜率   10日胜率');
const thRows = [];
for (const T of [20, 30, 40, 50, 60, 70, 80]) {
  const g = rows.filter((r) => r.sent >= T && r.ret1 !== null);
  if (!g.length) { console.log(`${String(T).padStart(5)}      0`); continue; }
  const k = g.filter((r) => r.ret1 > 0).length;
  const wr = (k / g.length) * 100;
  const pv = binomP(k, g.length, base1 / 100);
  const g5 = g.filter((r) => r.ret5 !== null), g10 = g.filter((r) => r.ret10 !== null);
  const wr5 = g5.length ? (g5.filter((r) => r.ret5 > 0).length / g5.length) * 100 : NaN;
  const wr10 = g10.length ? (g10.filter((r) => r.ret10 > 0).length / g10.length) * 100 : NaN;
  // edge = 相对无条件基准的领先幅度。样本一拉长，中档阈值（如 ≥60）的 edge 会塌到接近 0，
  // 面板里要把这类阈值标红，提示「在这个窗口下已不具备区分度」。
  const edge = wr - base1;
  // 判定标准：单侧二项检验 p < 0.10 且领先幅度 ≥ 3pp，才认为该阈值仍有区分度。
  const valid = pv < 0.1 && edge >= 3;
  thRows.push({ T, n: g.length, k, wr: +wr.toFixed(1), p: +pv.toFixed(3), edge: +edge.toFixed(1), valid });
  console.log(
    `${String(T).padStart(5)}  ${String(g.length).padStart(5)}  ${String(k).padStart(6)}  ${wr.toFixed(1).padStart(6)}%  ` +
      `${base1.toFixed(1).padStart(5)}%  ${((edge >= 0 ? '+' : '') + edge.toFixed(1)).padStart(6)}%  ` +
      `${pv.toFixed(3).padStart(7)}  ${wr5.toFixed(1).padStart(7)}%  ${wr10.toFixed(1).padStart(8)}%  ` +
      `${valid ? '' : '← 失效'}`,
  );
}
console.log('\n  注：7 个阈值中取最显著者属于多重比较，需用 Bonferroni 校正（阈值 0.05/7 ≈ 0.007）。');

// ---------- 6. 事件簇化：触发日是否互相独立？ ----------
function episodes(list, gapDays = 10) {
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.i - last[last.length - 1].i <= gapDays) last.push(r);
    else out.push([r]);
  }
  return out;
}
console.log('\n=== 事件簇化：极端情绪日是否互相独立 ===');
const episodeOut = [];
for (const T of [40, 50, 60]) {
  const g = rows.filter((r) => r.sent >= T && r.ret1 !== null);
  const eps = episodes(g, 10);
  const epWin = eps.filter((e) => e.some((r) => r.ret1 > 0)).length;
  const pv = binomP(epWin, eps.length, base1 / 100);
  episodeOut.push({
    T, days: g.length, episodes: eps.length, epWin,
    epRate: +((epWin / eps.length) * 100).toFixed(0),
    p: +pv.toFixed(3),
    detail: eps.map((e) => e.map((r) => r.d)),
  });
  console.log(
    `  情绪≥${T}: 命中 ${g.length} 天，归并为 ${eps.length} 个独立事件簇 → 事件级胜率 ${epWin}/${eps.length} = ` +
      `${((epWin / eps.length) * 100).toFixed(0)}%  (p=${pv.toFixed(3)})`,
  );
  for (const e of eps) {
    if (T === 50) console.log(`      簇: ${e.map((r) => r.d.slice(5)).join(' ')}`);
  }
}

const daily = Object.fromEntries(rows.map((r) => [r.d, { sent: r.sent, score: r.score, dt: r.dt, cap: r.cap, mem: r.mem }]));
writeFileSync(
  'sentiment.json',
  JSON.stringify(
    {
      window: { start: rows[0].d, end: rows.at(-1).d, n: rows.length },
      base1: +base1.toFixed(2),
      // 档位定义（按情绪分切，与窗口长度无关），供看板/蜡烛图/散点图统一取色
      tiers: tierDefs(),
      daily,
      bins: BINS.map(([lo, hi]) => {
        const g = rows.filter((r) => r.sent >= lo && r.sent < hi);
        const g1 = g.filter((r) => r.ret1 !== null);
        const g5 = g.filter((r) => r.ret5 !== null);
        return {
          lo, hi: hi === 101 ? 100 : hi, n: g.length,
          p1: g1.length ? (g1.filter((r) => r.ret1 > 0).length / g1.length) * 100 : null,
          p5: g5.length ? (g5.filter((r) => r.ret5 > 0).length / g5.length) * 100 : null,
          m1: g1.length ? mean(g1.map((r) => r.ret1)) : null,
          m5: g5.length ? mean(g5.map((r) => r.ret5)) : null,
        };
      }),
      backtest: results.map((r) => ({ label: r.label, n: r.preds.length, acc: +r.acc.toFixed(1), brier: +r.brier.toFixed(4) })),
      bestLabel: best.label,
      thresholds: thRows,
      episodes: episodeOut,
      highConf: hi.length
        ? { n: hi.length, win: +((hi.filter((p) => p.actual === 1).length / hi.length) * 100).toFixed(1), days: hi.map((p) => p.d) }
        : null,
    },
    null,
    1,
  ),
  'utf8',
);
console.log('\nwrote sentiment.json');

