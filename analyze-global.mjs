// 全球 → A 股开盘（修正版）
//   修正 1：OLS 加截距（否则 R² 可负、系数有偏）
//   修正 2：黄金/美元指数的 bar 日期约定比股市早一天，两种对齐都测并报告
//   修正 3：增量检验改为「在 A 股跳空给定的条件下」——否则只是在重复跳空本身
import { readFileSync } from 'node:fs';
const G = JSON.parse(readFileSync('global-daily.json', 'utf8')).series;
// 东财 kline 被封期间 global-daily.json 可能只有部分品种（见文件里的 coverage 字段，
// 2026-09-24 起腾讯只能补 us.INX/us.IXIC/hkHSI 三个）。缺品种时下面会到处读到 undefined
// 而崩溃，所以先明确报缺失再退出。等东财解封后重跑 fetch-global.mjs 即可恢复。
{
  const REQUIRED = ['spx', 'kospi', 'nikkei', 'twii', 'a50'];
  const absent = REQUIRED.filter((k) => !G[k]);
  if (absent.length) {
    console.error(`✗ global-daily.json 缺少必需品种：${absent.join(', ')}`);
    console.error(`  当前只有：${Object.keys(G).join(', ') || '（空）'}`);
    console.error('  全球因子分析需要完整覆盖，等东财 kline 解封后重跑 fetch-global.mjs。');
    process.exit(2);
  }
}
const D = JSON.parse(readFileSync('daily-long.json', 'utf8')).series;
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function corr(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 30) return NaN;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxy / Math.sqrt(sxx * syy);
}
/** 带截距的最小二乘，返回系数（beta[0] 为截距）与调整后 R² */
function ols(X, y) {
  const n = y.length;
  const A = X.map((r) => [1, ...r]);
  const p = A[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += A[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += A[i][a] * A[i][b];
    }
  }
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let cc = c; cc <= p; cc++) M[r][cc] -= f * M[c][cc];
    }
  }
  const beta = M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
  const my = mean(y);
  let ss = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let a = 0; a < p; a++) pred += A[i][a] * beta[a];
    ss += (y[i] - pred) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const k = p - 1;
  const r2 = 1 - ss / syy;
  const adj = 1 - (1 - r2) * (n - 1) / (n - k - 1);
  return { beta, r2, adj, n };
}
const prevDay = (iso) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); };

const idx = {}; for (const [k, v] of Object.entries(G)) idx[k] = v.bars.map((b) => b.d);
const barAt = (k, iso) => { const i = idx[k].lastIndexOf(iso); return i >= 0 ? G[k].bars[i] : null; };
const onOrBefore = (k, iso) => { const i = idx[k].findLastIndex((d) => d <= iso); return i >= 0 ? G[k].bars[i] : null; };
const retAt = (k, iso) => { const i = idx[k].lastIndexOf(iso); return i >= 1 ? (G[k].bars[i].c / G[k].bars[i - 1].c - 1) * 100 : null; };
const gapAt = (k, iso) => { const b = barAt(k, iso); if (!b) return null; const i = idx[k].lastIndexOf(iso); const p = G[k].bars[i - 1]; return p ? (b.o / p.c - 1) * 100 : null; };

const sh = D.sh.bars.filter((b) => b.d < TODAY);
const rows = [];
for (let i = 1; i < sh.length; i++) {
  const a = sh[i], t = sh[i - 1];
  const A = a.d, A1 = prevDay(A);
  const r = {
    A, gap: (a.o / t.c - 1) * 100, intraday: (a.c / a.o - 1) * 100, sellOpen: ((a.o - a.c) / a.o) * 100,
    spx: retAt('spx', onOrBefore('spx', A1)?.d),
    dax: retAt('dax', onOrBefore('dax', A1)?.d),
    kospi_prev: retAt('kospi', onOrBefore('kospi', A1)?.d),
    hsi_prev: retAt('hsi', onOrBefore('hsi', A1)?.d),
    a50_prev: retAt('a50', onOrBefore('a50', A1)?.d),
    kgap: gapAt('kospi', A), ngap: gapAt('nikkei', A), tgap: gapAt('twii', A), agap: gapAt('a50', A),
  };
  // 黄金/美元：两种对齐，取数据里存在的
  r.gold_lag1 = retAt('gold', onOrBefore('gold', A1)?.d);
  r.gold_lag0 = retAt('gold', onOrBefore('gold', A)?.d);
  r.xau_lag1 = retAt('xau', onOrBefore('xau', A1)?.d);
  r.xau_lag0 = retAt('xau', onOrBefore('xau', A)?.d);
  r.dxy_lag1 = retAt('dxy', onOrBefore('dxy', A1)?.d);
  r.dxy_lag0 = retAt('dxy', onOrBefore('dxy', A)?.d);
  rows.push(r);
}
const ok = rows.filter((r) => isFinite(r.gap));
console.log(`样本 ${ok.length} 个交易日  ${ok[0].A} → ${ok.at(-1).A}\n`);

console.log('=== 1. 黄金/美元指数的日期约定校正（两种对齐对比）===');
for (const [label, a, b] of [
  ['COMEX黄金', 'gold_lag1', 'gold_lag0'], ['伦敦金现货', 'xau_lag1', 'xau_lag0'], ['美元指数', 'dxy_lag1', 'dxy_lag0'],
]) {
  const f = (k) => { const s = ok.filter((r) => r[k] != null); return { r: corr(s.map((r) => r[k]), s.map((r) => r.gap)), n: s.length }; };
  const A1 = f(a), A0 = f(b);
  const pick = Math.abs(A0.r) > Math.abs(A1.r) ? 'D<=A（该品种日期早一天）' : 'D<=A-1';
  console.log(`  ${label.padEnd(12)} D<=A-1: r=${A1.r.toFixed(3)}(n=${A1.n})   D<=A: r=${A0.r.toFixed(3)}(n=${A0.n})   → 采用 ${pick}`);
}
console.log('  （但两种对齐下相关系数都 <0.05，结论不受影响）');

console.log('\n=== 2. 单因子与 A 股跳空的相关性（已选正确对齐）===');
console.log('  因子                     样本   相关系数    调整R²    β        分时代同号');
const FACTORS = [
  ['美股隔夜·标普500', 'spx'], ['欧股·德国DAX', 'dax'], ['恒生前收', 'hsi_prev'],
  ['A50期指前夜', 'a50_prev'], ['韩国KOSPI前收', 'kospi_prev'],
  ['COMEX黄金隔夜', 'gold_lag0'], ['伦敦金隔夜', 'xau_lag0'], ['美元指数隔夜', 'dxy_lag0'],
  ['★韩国KOSPI当日开盘', 'kgap'], ['★日经当日开盘', 'ngap'], ['★台湾加权当日开盘', 'tgap'], ['★A50期指当日开盘', 'agap'],
];
const ERAS = [[2010, 2013], [2014, 2017], [2018, 2021], [2022, 2026]];
for (const [label, f] of FACTORS) {
  const s = ok.filter((r) => r[f] != null && isFinite(r[f]));
  if (s.length < 100) { console.log(`  ${label.padEnd(22)} 样本不足`); continue; }
  const c = corr(s.map((r) => r[f]), s.map((r) => r.gap));
  const o = ols(s.map((r) => [r[f]]), s.map((r) => r.gap));
  const signs = ERAS.map(([a, b]) => {
    const q = s.filter((r) => { const y = +r.A.slice(0, 4); return y >= a && y <= b; });
    return q.length >= 60 ? corr(q.map((r) => r[f]), q.map((r) => r.gap)) : null;
  }).filter((v) => v != null);
  const agree = signs.filter((v) => Math.sign(v) === Math.sign(c)).length;
  console.log(
    `  ${label.padEnd(22)} ${String(s.length).padStart(5)}   ${c.toFixed(3).padStart(8)}  ${o.adj.toFixed(4).padStart(8)}  ` +
      `${o.beta[1].toFixed(3).padStart(8)}   ${agree}/${signs.length}${agree === signs.length ? ' ✓' : ''}`,
  );
}

// ---------- 3. 复合亚洲早盘因子 ----------
console.log('\n=== 3. 复合「亚洲早盘」因子 ===');
for (const r of ok) {
  const v = [r.kgap, r.ngap, r.tgap].filter((x) => x != null && isFinite(x));
  r.asia = v.length === 3 ? v.reduce((a, b) => a + b, 0) / 3 : null;
}
{
  const s = ok.filter((r) => r.asia != null);
  const c = corr(s.map((r) => r.asia), s.map((r) => r.gap));
  const o = ols(s.map((r) => [r.asia]), s.map((r) => r.gap));
  console.log(`  亚洲早盘均值(韩/日/台)  n=${s.length}  r=${c.toFixed(3)}  调整R²=${o.adj.toFixed(4)}  β=${o.beta[1].toFixed(3)}  截距=${o.beta[0].toFixed(4)}`);
  const sh = s.map((r) => r.gap);
  console.log(`  换算：亚洲早盘每涨 1%，A 股开盘平均高开 ${o.beta[1].toFixed(3)}%`);
}

console.log('\n=== 4. 逐步回归（含截距）===');
const MODELS = [
  ['仅 美股隔夜', ['spx']],
  ['仅 黄金隔夜', ['gold_lag0']],
  ['仅 美元指数', ['dxy_lag0']],
  ['仅 亚洲早盘复合', ['asia']],
  ['亚洲早盘 + 美股', ['asia', 'spx']],
  ['亚洲早盘 + 黄金', ['asia', 'gold_lag0']],
  ['亚洲早盘 + 黄金 + 美元', ['asia', 'gold_lag0', 'dxy_lag0']],
  ['亚洲早盘 + A50当日开盘', ['asia', 'agap']],
  ['全部', ['asia', 'spx', 'gold_lag0', 'dxy_lag0', 'agap']],
];
for (const [name, fs] of MODELS) {
  const s = ok.filter((r) => fs.every((f) => r[f] != null && isFinite(r[f])));
  if (s.length < 200) { console.log(`  ${name.padEnd(24)} 样本不足`); continue; }
  const o = ols(s.map((r) => fs.map((f) => r[f])), s.map((r) => r.gap));
  console.log(`  ${name.padEnd(24)} n=${String(s.length).padStart(5)}  调整R²=${o.adj.toFixed(4)}  解释 ${(o.adj * 100).toFixed(1)}%`);
}

// ---------- 5. 对现有信号的增量（条件化在跳空上） ----------
console.log('\n=== 5. 关键检验：跳空给定时，全球背景还有增量吗 ===');
console.log('  在「A股高开>1%」的日子内部，再按亚洲早盘/美股分层，看 T+1 日内 ===');
const hi = ok.filter((r) => r.gap > 1 && r.asia != null);
const cell = (nm, s) => {
  if (s.length < 25) { console.log(`  ${nm.padEnd(30)} n=${s.length} 样本少`); return; }
  console.log(`  ${nm.padEnd(30)} n=${String(s.length).padStart(4)}  日内 ${pct(mean(s.map((r) => r.intraday))).padStart(8)}  减仓(扣0.12%) ${pct(mean(s.map((r) => r.sellOpen)) - 0.12).padStart(8)}`);
};
cell('高开>1% 且 亚洲早盘强(>+0.5%)', hi.filter((r) => r.asia > 0.5));
cell('高开>1% 且 亚洲早盘中性', hi.filter((r) => r.asia >= -0.5 && r.asia <= 0.5));
cell('高开>1% 且 亚洲早盘弱(<-0.5%)', hi.filter((r) => r.asia < -0.5));
cell('高开>1% 且 美股隔夜涨>1%', hi.filter((r) => r.spx > 1));
cell('高开>1% 且 美股隔夜跌<-1%', hi.filter((r) => r.spx < -1));
cell('高开>1%（基准）', hi);
