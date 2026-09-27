// 变量搜索：以「跨子区间稳定性」而非样本内拟合度作为筛选标准
// 所有特征只用当日及之前数据（无前视）
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('dt-counts.json', 'utf8')).counts;
const sh = JSON.parse(readFileSync('candles.json', 'utf8')).series.find((s) => s.key === 'sh').bars;
const shIdx = new Map(sh.map((r, i) => [r.d, i]));

const scoreOf = (v) => Math.max(v.dt / 60, (v.allCap ? (v.dtCap / v.allCap) * 100 : 0) / 1.0, v.mem / 12);
const sentOf = (s) => 100 * (1 - Math.exp(-s / 2.5));

const dates = Object.keys(raw).sort().slice(-300);
const rows = [];
for (const d of dates) {
  const i = shIdx.get(d);
  if (i === undefined || i < 25) continue;
  const win = (k) => sh.slice(Math.max(0, i - k + 1), i + 1);
  const rets = win(20).slice(1).map((r, j) => (r.c / win(20)[j].c - 1) * 100);
  const vol20 = Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / rets.length);
  const rets5 = win(5).slice(1).map((r, j) => (r.c / win(5)[j].c - 1) * 100);
  const vol5 = Math.sqrt(rets5.reduce((a, b) => a + b * b, 0) / rets5.length);
  const vols = win(20).map((r) => r.v);
  const volma20 = vols.reduce((a, b) => a + b, 0) / vols.length;
  const ma20 = win(20).reduce((a, r) => a + r.c, 0) / 20;
  const hi20 = Math.max(...win(20).map((r) => r.h));
  let consec = 0;
  for (let j = i; j > 0 && sh[j].c < sh[j - 1].c; j--) consec++;

  const v = raw[d];
  rows.push({
    d, i,
    sent: sentOf(scoreOf(v)),
    vol20, volspike: vol20 ? vol5 / vol20 : 1,
    volratio: volma20 ? sh[i].v / volma20 : 1,
    ma20dev: (sh[i].c / ma20 - 1) * 100,
    dd20: (sh[i].c / hi20 - 1) * 100,
    consec,
    ret5: (sh[i].c / sh[Math.max(0, i - 5)].c - 1) * 100,
    amp: (sh[i].h - sh[i].l) / sh[i - 1].c * 100,
    f1: i + 1 < sh.length ? (sh[i + 1].c / sh[i].c - 1) * 100 : null,
    f5: i + 5 < sh.length ? (sh[i + 5].c / sh[i].c - 1) * 100 : null,
  });
}

const FEATURES = [
  ['sent', '恐慌情绪'],
  ['vol20', '20日波动率'],
  ['volspike', '波动率突增(5/20)'],
  ['volratio', '成交量比(20日)'],
  ['ma20dev', '偏离MA20'],
  ['dd20', '20日回撤'],
  ['consec', '连跌天数'],
  ['ret5', '过去5日收益'],
  ['amp', '当日振幅'],
];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function corr(a, b) {
  const n = a.length, ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
}

const labelled = rows.filter((r) => r.f1 !== null && r.f5 !== null);
const nQ = 4, q = Math.floor(labelled.length / nQ);

console.log(`样本 ${labelled.length} 天 (${labelled[0].d} → ${labelled.at(-1).d})\n`);
console.log('=== 各变量与未来 5 日收益的相关系数：按季度 ===');
console.log('变量                    全样本    Q1      Q2      Q3      Q4    符号一致  最小|r|');
const results = [];
for (const [key, name] of FEATURES) {
  const all = corr(labelled.map((r) => r[key]), labelled.map((r) => r.f5));
  const qs = [];
  for (let k = 0; k < nQ; k++) {
    const g = labelled.slice(k * q, k === nQ - 1 ? labelled.length : (k + 1) * q);
    qs.push(corr(g.map((r) => r[key]), g.map((r) => r.f5)));
  }
  const signAll = Math.sign(all);
  const agree = qs.filter((r) => Math.sign(r) === signAll).length;
  const minAbs = Math.min(...qs.map(Math.abs));
  results.push({ key, name, all, qs, agree, minAbs });
  console.log(
    `${name.padEnd(20)} ${all.toFixed(3).padStart(7)}  ` +
      qs.map((r) => r.toFixed(3).padStart(7)).join(' ') +
      `  ${String(agree).padStart(6)}/4  ${minAbs.toFixed(3).padStart(7)}`,
  );
}

console.log('\n=== 按「稳定性」排序（符号一致数 → 最小|r|）===');
const ranked = [...results].sort((a, b) => b.agree - a.agree || b.minAbs - a.minAbs);
for (const r of ranked) {
  const verdict = r.agree === 4 && r.minAbs > 0.15 ? '★ 稳健' : r.agree >= 3 && r.minAbs > 0.1 ? '○ 尚可' : '✗ 不稳定';
  console.log(`  ${r.name.padEnd(20)} 一致 ${r.agree}/4  最小|r| ${r.minAbs.toFixed(3)}  全样本 ${r.all >= 0 ? '+' : ''}${r.all.toFixed(3)}   ${verdict}`);
}

// ---------- 波动率均值回复：经典稳健现象，单独检验 ----------
console.log('\n=== 波动率分层：20日波动率 → 未来收益 ===');
const vols = labelled.map((r) => r.vol20).sort((a, b) => a - b);
const qq = (p) => vols[Math.min(vols.length - 1, Math.max(0, Math.floor(p * vols.length)))];
console.log(`波动率分层        天数   未来5日均值   5日胜率   未来1日均值`);
for (const [lo, hi, label] of [[0, 0.25, '低(最低25%)'], [0.25, 0.5, '偏低'], [0.5, 0.75, '偏高'], [0.75, 1.01, '高(最高25%)']]) {
  const a = qq(lo), b = qq(hi);
  const last = hi > 1;
  const g = labelled.filter((r) => r.vol20 >= a && (last ? r.vol20 <= b : r.vol20 < b));
  if (!g.length) continue;
  const wr = (g.filter((r) => r.f5 > 0).length / g.length) * 100;
  console.log(
    `${label.padEnd(16)} ${String(g.length).padStart(4)}  ${mean(g.map((r) => r.f5)).toFixed(2).padStart(11)}%  ` +
      `${wr.toFixed(1).padStart(7)}%  ${mean(g.map((r) => r.f1)).toFixed(2).padStart(11)}%`,
  );
}

// ---------- 满分位分层：对符号一致的变量做极值组检验 ----------
console.log('\n=== 分位极值组对比（最高20% vs 最低20%）===');
const consistent = results.filter((r) => r.agree === 4);
for (const f of consistent) {
  const vals = labelled.map((r) => r[f.key]).sort((a, b) => a - b);
  const loCut = vals[Math.floor(0.2 * vals.length)], hiCut = vals[Math.floor(0.8 * vals.length)];
  const loG = labelled.filter((r) => r[f.key] <= loCut), hiG = labelled.filter((r) => r[f.key] >= hiCut);
  const h1 = hiG.filter((r) => r.f5 !== null), l1 = loG.filter((r) => r.f5 !== null);
  console.log(
    `  ${f.name}  (r=${f.all.toFixed(3)})\n` +
      `    最低20%: n=${l1.length}  5日均值 ${mean(l1.map((r) => r.f5)).toFixed(2)}%  胜率 ${((l1.filter((r) => r.f5 > 0).length / l1.length) * 100).toFixed(0)}%\n` +
      `    最高20%: n=${h1.length}  5日均值 ${mean(h1.map((r) => r.f5)).toFixed(2)}%  胜率 ${((h1.filter((r) => r.f5 > 0).length / h1.length) * 100).toFixed(0)}%`,
  );
}

writeFileSync(
  'features.json',
  JSON.stringify({ ranked: ranked.map((r) => ({ name: r.name, all: +r.all.toFixed(3), qs: r.qs.map((x) => +x.toFixed(3)), agree: r.agree, minAbs: +r.minAbs.toFixed(3) })) }, null, 1),
  'utf8',
);
console.log('\nwrote features.json');
