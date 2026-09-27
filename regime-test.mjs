// 结构性断点检验：情绪→反弹 的关系在样本内部是否稳定？
import { readFileSync } from 'node:fs';

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
  const v = raw[d];
  const ret = i > 0 ? (sh[i].c / sh[i - 1].c - 1) * 100 : null;
  const f1 = i + 1 < sh.length ? (sh[i + 1].c / sh[i].c - 1) * 100 : null;
  const f5 = i + 5 < sh.length ? (sh[i + 5].c / sh[i].c - 1) * 100 : null;
  rows.push({ d, i, sent: +sentOf(scoreOf(v)).toFixed(1), ret, f1, f5 });
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
function corr(a, b) {
  const n = a.length, ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
}
function binomP(k, n, p) {
  if (!n) return 1;
  const z = Math.abs(k - n * p) / (Math.sqrt(n * p * (1 - p)) || 1e-9);
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  return 2 * d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}

const labelled = rows.filter((r) => r.f1 !== null);
console.log(`样本 ${rows.length} 天 (${rows[0].d} → ${rows.at(-1).d})\n`);

// ---------- 分段比较 ----------
function period(label, g) {
  const g1 = g.filter((r) => r.f1 !== null);
  if (!g1.length) return;
  const up = g1.filter((r) => r.f1 > 0).length;
  const hi = g1.filter((r) => r.sent >= 50);
  const hiUp = hi.filter((r) => r.f1 > 0).length;
  console.log(
    `${label.padEnd(18)} n=${String(g1.length).padStart(3)}  基准P(涨)=${((up / g1.length) * 100).toFixed(1).padStart(5)}%  ` +
      `corr(情绪,次日)=${corr(g1.map((r) => r.sent), g1.map((r) => r.f1)).toFixed(3).padStart(7)}  ` +
      `日波动率=${sd(g1.map((r) => r.ret)).toFixed(2)}%  ` +
      `情绪≥50: ${String(hi.length).padStart(2)}天/${hiUp}涨` +
      (hi.length ? ` (${((hiUp / hi.length) * 100).toFixed(0)}%, p=${binomP(hiUp, hi.length, up / g1.length).toFixed(3)})` : ''),
  );
}

console.log('=== 分段检验 ===');
const n = labelled.length;
period('前半段', labelled.slice(0, Math.floor(n / 2)));
period('后半段', labelled.slice(Math.floor(n / 2)));

console.log('');
const q = Math.floor(n / 4);
for (let k = 0; k < 4; k++) {
  period(`第 ${k + 1} 季度`, labelled.slice(k * q, k === 3 ? n : (k + 1) * q));
}

// ---------- 滚动相关 ----------
console.log('\n=== 滚动相关（窗口 60 天）：corr(情绪, 次日收益) ===');
const rolls = [];
for (let s = 0; s + 60 <= labelled.length; s += 10) {
  const w = labelled.slice(s, s + 60);
  rolls.push({ d: w[0].d, r: corr(w.map((x) => x.sent), w.map((x) => x.f1)) });
}
for (const r of rolls) console.log(`  ${r.d}  ${r.r >= 0 ? '+' : ''}${r.r.toFixed(3)}`);
const rs = rolls.map((r) => r.r);
console.log(`\n  均值 ${mean(rs).toFixed(3)}  标准差 ${sd(rs).toFixed(3)}  最小 ${Math.min(...rs).toFixed(3)}  最大 ${Math.max(...rs).toFixed(3)}`);
console.log(`  正相关窗口 ${rs.filter((r) => r > 0).length}/${rs.length}  符号翻转 ${rs.filter((r, i) => i > 0 && Math.sign(r) !== Math.sign(rs[i - 1])).length} 次`);

// ---------- 波动率/结构突变 ----------
console.log('\n=== 市场状态（滚动20日波动率）===');
const vol = [];
for (let k = 20; k < rows.length; k++) {
  vol.push({ d: rows[k].d, v: sd(rows.slice(k - 20, k).map((r) => r.ret)) });
}
const half = Math.floor(vol.length / 2);
console.log(`  前半段平均波动率 ${mean(vol.slice(0, half).map((x) => x.v)).toFixed(2)}%   后半段 ${mean(vol.slice(half).map((x) => x.v)).toFixed(2)}%`);
const vmax = vol.reduce((a, b) => (b.v > a.v ? b : a));
const vmin = vol.reduce((a, b) => (b.v < a.v ? b : a));
console.log(`  最高 ${vmax.d} ${vmax.v.toFixed(2)}%   最低 ${vmin.d} ${vmin.v.toFixed(2)}%   比值 ${(vmax.v / vmin.v).toFixed(1)}x`);

// ---------- 极端日的年度分布 ----------
console.log('\n=== 情绪≥50 的极端日按时间分布 ===');
const ex = labelled.filter((r) => r.sent >= 50);
const byMonth = {};
for (const r of ex) { const m = r.d.slice(0, 7); byMonth[m] = (byMonth[m] ?? 0) + 1; }
console.log('  ' + Object.entries(byMonth).map(([k, v]) => `${k}: ${v}天`).join('  |  '));
console.log(`  合计 ${ex.length} 天，分布在 ${Object.keys(byMonth).length} 个月份`);
