// 发散检验：A 股跳空「相对亚洲早盘预判的偏离（残差）」是否有预测力
//   如果 A 股开得比亚洲早盘暗示的更弱，是继续弱（信息）还是均值回复（噪音）？
import { readFileSync } from 'node:fs';
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
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
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const corr = (x, y) => { const m = Math.min(x.length, y.length); const a = mean(x), b = mean(y); let s = 0, sx = 0, sy = 0; for (let i = 0; i < m; i++) { const p = x[i] - a, q = y[i] - b; s += p * q; sx += p * p; sy += q * q; } return s / Math.sqrt(sx * sy); };

const idx = {}; for (const [k, v] of Object.entries(G)) idx[k] = v.bars.map((b) => b.d);
const gapAt = (k, iso) => { const i = idx[k].lastIndexOf(iso); return i >= 1 ? (G[k].bars[i].o / G[k].bars[i - 1].c - 1) * 100 : null; };

const sh = D.sh.bars.filter((b) => b.d < TODAY);
const rows = [];
for (let i = 1; i < sh.length; i++) {
  const a = sh[i], t = sh[i - 1];
  const A = a.d;
  const kg = gapAt('kospi', A), ng = gapAt('nikkei', A), tg = gapAt('twii', A);
  const v = [kg, ng, tg].filter((x) => x != null && isFinite(x));
  rows.push({
    A, retT: i >= 2 ? (t.c / sh[i - 2].c - 1) * 100 : null,
    gap: (a.o / t.c - 1) * 100, intraday: (a.c / a.o - 1) * 100, sellOpen: ((a.o - a.c) / a.o) * 100,
    day: (a.c / t.c - 1) * 100, asia: v.length === 3 ? v.reduce((x, y) => x + y, 0) / 3 : null,
  });
}
const ok = rows.filter((r) => isFinite(r.gap) && r.asia != null && r.retT != null);
console.log(`样本 ${ok.length}\n`);

// 用前 60% 拟合 β，后 40% 检验（避免用全样本拟合再检验自己）
const cut = Math.floor(ok.length * 0.6);
const fitSet = ok.slice(0, cut);
const mx = mean(fitSet.map((r) => r.asia)), my = mean(fitSet.map((r) => r.gap));
const beta = corr(fitSet.map((r) => r.asia), fitSet.map((r) => r.gap)) * (sd(fitSet.map((r) => r.gap)) / sd(fitSet.map((r) => r.asia)));
const alpha = my - beta * mx;
console.log(`=== 用前 60%（${fitSet[0].A} → ${fitSet.at(-1).A}）拟合：A股跳空 = ${alpha.toFixed(3)} + ${beta.toFixed(3)} × 亚洲早盘 ===`);
const resid = (r) => r.gap - (alpha + beta * r.asia);

console.log('\n=== 残差（A股实际跳空 − 亚洲早盘预判）是否有预测力 ===');
console.log('  残差分组                         n    日内均值   减仓(扣0.12%)   全天均值');
const groups = [
  ['残差 ≥ +0.5%（比亚洲早盘强很多）', (r) => resid(r) >= 0.5],
  ['残差 +0.2~0.5%', (r) => resid(r) >= 0.2 && resid(r) < 0.5],
  ['残差 −0.2~+0.2%（吻合）', (r) => resid(r) > -0.2 && resid(r) < 0.2],
  ['残差 −0.5~−0.2%', (r) => resid(r) <= -0.2 && resid(r) > -0.5],
  ['残差 ≤ −0.5%（比亚洲早盘弱很多）', (r) => resid(r) <= -0.5],
];
for (const [nm, p] of groups) {
  const s = ok.filter(p);
  if (s.length < 30) { console.log(`  ${nm.padEnd(32)} n=${s.length} 样本少`); continue; }
  console.log(
    `  ${nm.padEnd(32)} ${String(s.length).padStart(4)}  ${pct(mean(s.map((r) => r.intraday))).padStart(8)}  ` +
      `${pct(mean(s.map((r) => r.sellOpen)) - 0.12).padStart(12)}  ${pct(mean(s.map((r) => r.day))).padStart(8)}`,
  );
}
console.log(`  残差与日内收益的相关性 r = ${corr(ok.map(resid), ok.map((r) => r.intraday)).toFixed(3)}`);

console.log('\n=== 样本外（后 40%）单独验证 ===');
const oos = ok.slice(cut);
for (const [nm, p] of [['残差 ≥ +0.3%', (r) => resid(r) >= 0.3], ['残差 ≤ −0.3%', (r) => resid(r) <= -0.3]]) {
  const s = oos.filter(p);
  if (s.length < 20) { console.log(`  ${nm} n=${s.length} 样本少`); continue; }
  console.log(`  ${nm.padEnd(14)} n=${String(s.length).padStart(4)}  日内 ${pct(mean(s.map((r) => r.intraday)))}  减仓(扣费) ${pct(mean(s.map((r) => r.sellOpen)) - 0.12)}`);
}

console.log('\n=== 对照：现有信号的格子（同样用最新对齐重算）===');
const cell = (nm, s) => { if (s.length < 20) { console.log(`  ${nm.padEnd(30)} n=${s.length} 少`); return; } console.log(`  ${nm.padEnd(30)} n=${String(s.length).padStart(4)}  日内 ${pct(mean(s.map((r) => r.intraday))).padStart(8)}  减仓(扣费) ${pct(mean(s.map((r) => r.sellOpen)) - 0.12).padStart(8)}`); };
cell('弱(T跌≤-0.5%) + 高开>1%', ok.filter((r) => r.retT <= -0.5 && r.gap > 1));
cell('弱 + 低开<-1%', ok.filter((r) => r.retT <= -0.5 && r.gap < -1));
cell('强(T涨≥1%) + 高开>1%', ok.filter((r) => r.retT >= 1 && r.gap > 1));
cell('基准（全部）', ok);
