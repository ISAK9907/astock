// 候选信号（低波动率 / 低成交量）的跨季度稳定性检验
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('dt-counts.json', 'utf8')).counts;
const sh = JSON.parse(readFileSync('candles.json', 'utf8')).series.find((s) => s.key === 'sh').bars;
const shIdx = new Map(sh.map((r, i) => [r.d, i]));

const dates = Object.keys(raw).sort().slice(-300);
const rows = [];
for (const d of dates) {
  const i = shIdx.get(d);
  if (i === undefined || i < 25) continue;
  const win = (k) => sh.slice(Math.max(0, i - k + 1), i + 1);
  const rets = win(20).slice(1).map((r, j) => (r.c / win(20)[j].c - 1) * 100);
  const vol20 = Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / rets.length);
  const volma20 = win(20).reduce((a, r) => a + r.v, 0) / 20;
  const ma20 = win(20).reduce((a, r) => a + r.c, 0) / 20;
  rows.push({
    d, i,
    vol20,
    volratio: volma20 ? sh[i].v / volma20 : 1,
    ma20dev: (sh[i].c / ma20 - 1) * 100,
    f5: i + 5 < sh.length ? (sh[i + 5].c / sh[i].c - 1) * 100 : null,
    f10: i + 10 < sh.length ? (sh[i + 10].c / sh[i].c - 1) * 100 : null,
  });
}
const labelled = rows.filter((r) => r.f5 !== null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const wr = (a, k) => (a.length ? (a.filter((r) => r[k] > 0).length / a.length) * 100 : NaN);
function binomP(k, n, p) {
  if (!n) return 1;
  const z = Math.abs(k - n * p) / (Math.sqrt(n * p * (1 - p)) || 1e-9);
  const t = 1 / (1 + 0.2316419 * z);
  return 2 * 0.3989423 * Math.exp((-z * z) / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}

// 用全样本分位定义信号（对历史有轻微前视，仅用于稳定性检验；实际部署需滚动分位）
const cut = (key, p) => [...labelled.map((r) => r[key])].sort((a, b) => a - b)[Math.floor(p * labelled.length)];
const volLow = cut('vol20', 0.3), volHigh = cut('vol20', 0.7);
const vrLow = cut('volratio', 0.3);

const SIGS = [
  ['低波动率(vol20最低30%)', (r) => r.vol20 <= volLow],
  ['高波动率(vol20最高30%)', (r) => r.vol20 >= volHigh],
  ['低成交量(量比最低30%)', (r) => r.volratio <= vrLow],
  ['低波动+低量(两者同时)', (r) => r.vol20 <= volLow && r.volratio <= vrLow],
];

const nQ = 4, q = Math.floor(labelled.length / nQ);
const base5 = wr(labelled, 'f5');
console.log(`全样本 5 日胜率基准 = ${base5.toFixed(1)}%  (n=${labelled.length})\n`);

console.log('=== 逐季度稳定性检验 ===');
for (const [name, f] of SIGS) {
  const g = labelled.filter(f);
  if (!g.length) continue;
  const k = g.filter((r) => r.f5 > 0).length;
  console.log(`\n${name}`);
  console.log(`  全样本: n=${g.length}  5日均值 ${mean(g.map((r) => r.f5)).toFixed(2)}%  胜率 ${wr(g, 'f5').toFixed(1)}%  p=${binomP(k, g.length, base5 / 100).toFixed(3)}`);
  const qs = [];
  for (let j = 0; j < nQ; j++) {
    const seg = labelled.slice(j * q, j === nQ - 1 ? labelled.length : (j + 1) * q);
    const gs = seg.filter(f);
    const w = gs.length ? wr(gs, 'f5') : null;
    qs.push(w);
    console.log(
      `  Q${j + 1}: n=${String(gs.length).padStart(3)}  5日均值 ${gs.length ? mean(gs.map((r) => r.f5)).toFixed(2).padStart(6) : '  -  '}%  ` +
        `胜率 ${w === null ? '  -  ' : w.toFixed(0).padStart(3)}%`,
    );
  }
  const valid = qs.filter((x) => x !== null);
  const above = valid.filter((x) => x > base5).length;
  console.log(`  → ${above}/${valid.length} 个季度跑赢基准  ${above === valid.length && valid.length >= 3 ? '★ 稳定' : above >= valid.length - 1 ? '○ 尚可' : '✗ 不稳定'}`);
}
