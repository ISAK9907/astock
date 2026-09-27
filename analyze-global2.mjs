// 全球 → A 股开盘（非线性 / 非对称版）
//   修正线性相关的盲区：美股对 A 股的影响是**非对称**的（跌传导 >> 涨传导），
//   线性相关系数会被大量小波动日淹没。改用「方向一致率 + 分桶条件均值 + 非对称系数」。
import { readFileSync } from 'node:fs';
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const prevDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const G = JSON.parse(readFileSync('global-daily.json', 'utf8')).series;
// 缺品种时提前明确报错，避免后面读到 undefined 崩掉（详见 fetch-global.mjs 的说明）
{
  const REQUIRED = ['spx', 'kospi', 'nikkei', 'twii', 'a50'];
  const absent = REQUIRED.filter((k) => !G[k]);
  if (absent.length) {
    console.error(`✗ global-daily.json 缺少必需品种：${absent.join(', ')}（当前只有 ${Object.keys(G).join(', ') || '空'}）`);
    console.error('  等东财 kline 解封后重跑 fetch-global.mjs。');
    process.exit(2);
  }
}
const D = JSON.parse(readFileSync('daily-long.json', 'utf8')).series;
const TODAY = localToday();
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

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
    A, gap: (a.o / t.c - 1) * 100, intraday: (a.c / a.o - 1) * 100, day: (a.c / t.c - 1) * 100,
    spx: retAt('spx', onOrBefore('spx', A1)?.d),
    dax: retAt('dax', onOrBefore('dax', A1)?.d),
    hsi: retAt('hsi', onOrBefore('hsi', A1)?.d),
    gold: retAt('gold', onOrBefore('gold', A)?.d),
    xau: retAt('xau', onOrBefore('xau', A)?.d),
    dxy: retAt('dxy', onOrBefore('dxy', A)?.d),
    a50: retAt('a50', onOrBefore('a50', A1)?.d),
    kgap: gapAt('kospi', A), ngap: gapAt('nikkei', A), tgap: gapAt('twii', A), agap: gapAt('a50', A),
  };
  const v = [r.kgap, r.ngap, r.tgap].filter((x) => x != null && isFinite(x));
  r.asia = v.length === 3 ? v.reduce((x, y) => x + y, 0) / 3 : null;
  rows.push(r);
}
const ok = rows.filter((r) => isFinite(r.gap));
console.log(`样本 ${ok.length} 个交易日  ${ok[0].A} → ${ok.at(-1).A}\n`);

/** 方向一致率：因子与跳空同号的比例（剔除因子≈0 的噪音日） */
function agreeRate(s, f, thr = 0.05) {
  const q = s.filter((r) => r[f] != null && Math.abs(r[f]) > thr);
  if (!q.length) return { n: 0, rate: NaN };
  return { n: q.length, rate: (q.filter((r) => Math.sign(r[f]) === Math.sign(r.gap)).length / q.length) * 100 };
}

console.log('=== 1. 方向一致率（比线性相关更能抓非对称关系）===');
console.log('  因子              全部样本            因子|>1%| 的大波动日      A股跳空|>1.5%| 时');
const FACTORS = [
  ['美股隔夜·标普500', 'spx'], ['欧股·德国DAX', 'dax'], ['恒生前收', 'hsi'], ['A50期指前夜', 'a50'],
  ['COMEX黄金隔夜', 'gold'], ['伦敦金隔夜', 'xau'], ['美元指数隔夜', 'dxy'],
  ['★韩国KOSPI当日开盘', 'kgap'], ['★日经当日开盘', 'ngap'], ['★台湾加权当日开盘', 'tgap'],
  ['★亚洲早盘复合', 'asia'], ['★A50期指当日开盘', 'agap'],
];
for (const [label, f] of FACTORS) {
  const a = agreeRate(ok, f, 0.05);
  const b = agreeRate(ok, f, 1.0);
  const s = ok.filter((r) => r[f] != null && Math.abs(r.gap) >= 1.5);
  const c = s.length ? { n: s.length, rate: (s.filter((r) => Math.sign(r[f]) === Math.sign(r.gap)).length / s.length) * 100 } : { n: 0, rate: NaN };
  console.log(
    `  ${label.padEnd(20)} ${a.rate.toFixed(1).padStart(6)}% (n=${String(a.n).padStart(4)})   ` +
      `${b.rate.toFixed(1).padStart(6)}% (n=${String(b.n).padStart(3)})   ${c.rate.toFixed(1).padStart(6)}% (n=${String(c.n).padStart(3)})`,
  );
}
console.log('  （随机基准 50%）');

console.log('\n=== 2. 分桶条件均值：美股隔夜 → A 股跳空 ===');
const BUCKETS = [
  ['≤-3%', (x) => x <= -3], ['-3~-2%', (x) => x > -3 && x <= -2], ['-2~-1%', (x) => x > -2 && x <= -1],
  ['-1~-0.3%', (x) => x > -1 && x <= -0.3], ['-0.3~0.3%', (x) => x > -0.3 && x < 0.3],
  ['0.3~1%', (x) => x >= 0.3 && x < 1], ['1~2%', (x) => x >= 1 && x < 2], ['≥2%', (x) => x >= 2],
];
console.log('  美股区间      n    A股跳空均值   中位    跳空<-0.5%占比   A股全天均值');
for (const [label, p] of BUCKETS) {
  const s = ok.filter((r) => r.spx != null && p(r.spx));
  if (s.length < 10) { console.log(`  ${label.padEnd(11)} ${String(s.length).padStart(4)}  样本少`); continue; }
  const g = s.map((r) => r.gap);
  console.log(
    `  ${label.padEnd(11)} ${String(s.length).padStart(4)}   ${pct(mean(g)).padStart(9)}   ${pct(med(g)).padStart(8)}   ` +
      `${(g.filter((v) => v < -0.5).length / g.length * 100).toFixed(1).padStart(11)}%   ${pct(mean(s.map((r) => r.day))).padStart(9)}`,
  );
}

console.log('\n=== 3. 非对称性：跌传导 vs 涨传导 ===');
const asym = [];
for (const [label, f] of [['美股标普500', 'spx'], ['COMEX黄金', 'gold'], ['美元指数', 'dxy'], ['亚洲早盘复合', 'asia']]) {
  const s = ok.filter((r) => r[f] != null);
  const dn = s.filter((r) => r[f] <= -1), up = s.filter((r) => r[f] >= 1);
  if (dn.length < 10 || up.length < 10) continue;
  const bd = mean(dn.map((r) => r.gap)) / mean(dn.map((r) => r[f]));
  const bu = mean(up.map((r) => r.gap)) / mean(up.map((r) => r[f]));
  asym.push({ label, bd, bu, nd: dn.length, nu: up.length });
  console.log(
    `  ${label.padEnd(14)} 跌1%→A股 ${pct(bd * 1, 3).padStart(8)} (n=${String(dn.length).padStart(3)})   ` +
      `涨1%→A股 ${pct(bu * 1, 3).padStart(8)} (n=${String(up.length).padStart(3)})   非对称比 ${(bd / bu).toFixed(2)}x`,
  );
}

console.log('\n=== 4. 关键：拆出「亚洲早盘」后，美股是否还有独立信息 ===');
// 用残差法：先回归掉亚洲早盘，再看美股（分段哑变量）对残差的解释
function ols(X, y) {
  const n = y.length, A = X.map((r) => [1, ...r]), p = A[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0)), Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { Xty[a] += A[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += A[i][a] * A[i][b]; }
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let cc = c; cc <= p; cc++) M[r][cc] -= f * M[c][cc]; }
  }
  const beta = M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
  const my = mean(y); let ss = 0, syy = 0;
  for (let i = 0; i < n; i++) { let pr = 0; for (let a = 0; a < p; a++) pr += A[i][a] * beta[a]; ss += (y[i] - pr) ** 2; syy += (y[i] - my) ** 2; }
  return { beta, adj: 1 - (1 - (1 - ss / syy)) * (n - 1) / (n - p), r2: 1 - ss / syy };
}
const s4 = ok.filter((r) => r.asia != null && r.spx != null);
const y = s4.map((r) => r.gap);
const asiaFit = ols(s4.map((r) => [r.asia]), y);
const resid = y.map((v, i) => v - (asiaFit.beta[0] + asiaFit.beta[1] * s4[i].asia));
console.log(`  基准：仅亚洲早盘  调整R²=${asiaFit.adj.toFixed(4)}  n=${s4.length}`);
// 加入美股分段哑变量
const mkDummies = (s, f) => s.map((r) => [r[f] <= -2 ? 1 : 0, r[f] > -2 && r[f] <= -1 ? 1 : 0, r[f] >= 2 ? 1 : 0, r[f] >= 1 && r[f] < 2 ? 1 : 0]);
const addSpx = ols(s4.map((r, i) => [r.asia, ...mkDummies(s4, 'spx')[i]]), y);
console.log(`  亚洲早盘 + 美股分段哑变量  调整R²=${addSpx.adj.toFixed(4)}  → 增量 ${((addSpx.adj - asiaFit.adj) * 100).toFixed(2)} 个百分点`);
const addAll = ols(s4.map((r, i) => [r.asia, ...mkDummies(s4, 'spx')[i], ...mkDummies(s4, 'gold')[i]]), y);
console.log(`  再加黄金分段哑变量        调整R²=${addAll.adj.toFixed(4)}  → 增量 ${((addAll.adj - addSpx.adj) * 100).toFixed(2)} 个百分点`);

console.log('\n=== 5. 用「美股大跌」作为独立预警（不依赖亚洲早盘）===');
for (const [nm, p] of [
  ['美股跌 ≤-2%', (r) => r.spx != null && r.spx <= -2],
  ['美股跌 ≤-3%', (r) => r.spx != null && r.spx <= -3],
  ['美股涨 ≥+2%', (r) => r.spx != null && r.spx >= 2],
  ['黄金涨 ≥+2%', (r) => r.gold != null && r.gold >= 2],
  ['黄金跌 ≤-2%', (r) => r.gold != null && r.gold <= -2],
  ['美元涨 ≥+1%', (r) => r.dxy != null && r.dxy >= 1],
]) {
  const s = ok.filter(p);
  if (s.length < 8) { console.log(`  ${nm.padEnd(14)} n=${s.length} 样本少`); continue; }
  const g = s.map((r) => r.gap);
  console.log(
    `  ${nm.padEnd(14)} n=${String(s.length).padStart(3)}  A股跳空均值 ${pct(mean(g)).padStart(8)}  中位 ${pct(med(g)).padStart(8)}  ` +
      `低开占比 ${(g.filter((v) => v < 0).length / g.length * 100).toFixed(0).padStart(3)}%  A股全天 ${pct(mean(s.map((r) => r.day))).padStart(8)}`,
  );
}
