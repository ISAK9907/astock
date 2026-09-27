// 评估「把情绪分窗口从 300 天扩到近三年」对现有评分模型的影响。
// 不修改任何现有文件，只读 dt-counts.json（现状）与 dt-counts-3y.json（三年扫描）做对照。
//
// 复现口径与 analyze-dt.mjs / sentiment-backtest.mjs 完全一致：
//   score = max(跌停家数/60, 跌停市值占比%/1.0, 权重股跌停数/12)
//   sent  = 把 score 在窗口内的名次换算成经验分位，再过 Φ⁻¹，按 N(50,15²) 映射（并列按日期展开）
import { readFileSync, existsSync } from 'node:fs';

const NORM = { dt: 60, cap: 1.0, mem: 12 };
const scoreOf = (v) =>
  Math.max(v.dt / NORM.dt, (v.allCap ? (v.dtCap / v.allCap) * 100 : 0) / NORM.cap, v.mem / NORM.mem);

function normInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -38;
  if (p >= 1) return 38;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function makeSentOf(scores) {
  const order = scores.map((v, i) => [v, i]).filter(([v]) => isFinite(v)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const N = order.length;
  const out = new Array(scores.length).fill(50);
  if (!N) return out;
  for (let k = 0; k < N; k++) {
    const p = Math.min(Math.max((k + 0.5) / N, 1e-4), 1 - 1e-4);
    out[order[k][1]] = Math.min(100, Math.max(0, 50 + 15 * normInv(p)));
  }
  return out;
}

/** 在给定窗口下算出逐日 score / sent */
function series(counts, window) {
  let dates = Object.keys(counts).sort();
  if (window && dates.length > window) dates = dates.slice(-window);
  const sc = dates.map((d) => scoreOf(counts[d]));
  const sent = makeSentOf(sc);
  const map = new Map();
  dates.forEach((d, i) => map.set(d, { d, score: +sc[i].toFixed(2), sent: +sent[i].toFixed(1) }));
  return { dates, map };
}

const stat = (v) => {
  const n = v.length, m = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const g = v.map((x) => (x - m) / sd);
  return { n, m, sd, skew: g.reduce((a, b) => a + b ** 3, 0) / n, kurt: g.reduce((a, b) => a + b ** 4, 0) / n - 3 };
};
const spearman = (xs, ys) => {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => (r[i] = k)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
};

// ---------------- 载入 ----------------
const cur = JSON.parse(readFileSync('dt-counts.json', 'utf8')).counts;
if (!existsSync('dt-counts-3y.json')) {
  console.error('✗ 还没有 dt-counts-3y.json，先跑三年扫描');
  process.exit(1);
}
const big = JSON.parse(readFileSync('dt-counts-3y.json', 'utf8')).counts;

const A = series(big, Number(process.env.DT_WINDOW ?? 300)); // 候选：同一份三年数据，只取最后 300 天
const B = series(big, 0);                                    // 候选：整段（近三年）
const sa = stat([...A.map.values()].map((x) => x.sent));
const sb = stat([...B.map.values()].map((x) => x.sent));

console.log('=== 窗口对比');
console.log('  两份序列取自**同一份** dt-counts-3y.json，只有窗口长度不同 ——');
console.log('  这样 A→B 的差异才纯粹是「窗口效应」，不掺数据源差异。');
console.log(`  现状 A   ${A.dates[0]} → ${A.dates.at(-1)}   ${sa.n} 个交易日`);
console.log(`  候选 B   ${B.dates[0]} → ${B.dates.at(-1)}   ${sb.n} 个交易日`);

// 顺带报一下现有 dt-counts.json 与本扫描的口径差（不是窗口问题，是数据源问题）
{
  const shared = Object.keys(cur).filter((d) => big[d]);
  const dts = shared.map((d) => big[d].dt - cur[d].dt);
  const ns = shared.map((d) => big[d].n - cur[d].n);
  const avg = (x) => x.reduce((p, q) => p + q, 0) / x.length;
  console.log(`\n  ⚠️ 口径提示：现有 dt-counts.json 与本次扫描在 ${shared.length} 个重叠日上`);
  console.log(`     跌停家数平均差 ${avg(dts).toFixed(2)} 家（最大 ${Math.max(...dts.map(Math.abs))} 家）`);
  console.log(`     每日样本数平均差 ${avg(ns).toFixed(0)} 只 —— 现有文件近期走东财路径(n≈5571)，本扫描是纯 baostock(n≈4944)`);
  console.log('     这是数据源差异，不是窗口差异；所以下面全部改用同源对照。');
}
console.log('\n  情绪分分布');
console.log('               均值    标准差   偏度     超峰度    值域');
for (const [k, s, m] of [['A 300天', sa, A], ['B 三年 ', sb, B]]) {
  const vals = [...m.map.values()].map((x) => x.sent);
  console.log(`  ${k}   ${s.m.toFixed(1).padStart(6)}  ${s.sd.toFixed(1).padStart(6)}  ${s.skew.toFixed(3).padStart(7)}  ${s.kurt.toFixed(3).padStart(7)}   ${Math.min(...vals)} ~ ${Math.max(...vals)}`);
}

// ---------------- 重叠区间的读数变化 ----------------
const overlap = A.dates.filter((d) => B.map.has(d));
const da = overlap.map((d) => A.map.get(d).sent);
const db = overlap.map((d) => B.map.get(d).sent);
const diffs = overlap.map((d, i) => db[i] - da[i]);
const abs = diffs.map(Math.abs).sort((x, y) => x - y);
console.log(`\n=== 重叠 ${overlap.length} 天：同一天的读数变了多少`);
console.log(`  平均 |Δsent| = ${(abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(1)} 分`);
console.log(`  中位 |Δsent| = ${abs[Math.floor(abs.length / 2)].toFixed(1)} 分`);
console.log(`  最大 |Δsent| = ${abs.at(-1).toFixed(1)} 分`);
console.log(`  秩相关（Spearman）= ${spearman(da, db).toFixed(4)}   ← 越接近 1 说明只是整体平移，排序不变`);
console.log(`  完全不变的交易日：${diffs.filter((x) => Math.abs(x) < 0.05).length} 天`);
console.log(`  读数下降的：${diffs.filter((x) => x < -0.05).length} 天   上升的：${diffs.filter((x) => x > 0.05).length} 天`);

const today = A.dates.at(-1);
const rankA = [...A.map.values()].filter((x) => x.sent > A.map.get(today).sent).length + 1;
const rankB = [...B.map.values()].filter((x) => x.sent > B.map.get(today).sent).length + 1;
console.log(`\n=== 今天 ${today}`);
console.log(`  A(300天)：score ${A.map.get(today).score}  sent ${A.map.get(today).sent}  排名 ${rankA}/${sa.n}`);
console.log(`  B(三年 )：score ${B.map.get(today).score}  sent ${B.map.get(today).sent}  排名 ${rankB}/${sb.n}`);
console.log(`  作为分位看：A 前 ${((rankA / sa.n) * 100).toFixed(1)}%  ←→  B 前 ${((rankB / sb.n) * 100).toFixed(1)}%`);

// ---------------- 极端日 ----------------
console.log('\n=== 历史最严重的 15 天（按 score，与窗口无关）');
const top = B.dates.slice().sort((x, y) => B.map.get(y).score - B.map.get(x).score).slice(0, 15);
console.log('  日期         score  跌停   A读数   B读数   Δ');
for (const d of top) {
  const x = A.map.get(d), y = B.map.get(d);
  const dd = x ? (y.sent - x.sent).toFixed(1) : '—';
  console.log(`  ${d}  ${String(y.score).padStart(5)}  ${String(big[d].dt).padStart(4)}   ${x ? String(x.sent).padStart(5) : '  —  '}   ${String(y.sent).padStart(5)}   ${String(dd).padStart(5)}`);
}

// ---------------- 下游影响 ----------------
// 档位现已挂在情绪分上（前 5%/3%/1%），门槛固定，所以天数只随窗口长度线性增长，
// 不再像旧的绝对 score 门槛那样在短窗口里畸高、长窗口里畸低。
import { tiers as tierDefs } from './sentiment-map.mjs';
const TIERS = tierDefs();
console.log('\n=== 下游影响（档位门槛 = 情绪分，固定值）');
for (const [k, m] of [['A 300天', A], ['B 三年 ', B]]) {
  const vals = [...m.map.values()];
  const per = TIERS.map((t) => vals.filter((x) => x.sent >= t.sentLo).length);
  const ge60 = vals.filter((x) => x.sent >= 60).length;
  const ge80 = vals.filter((x) => x.sent >= 80).length;
  console.log(`  ${k}: 粉≥${TIERS[0].sentLo} ${per[0]} 天 · 紫≥${TIERS[1].sentLo} ${per[1]} 天 · 橙≥${TIERS[2].sentLo} ${per[2]} 天 · sent≥60 ${ge60} 天 · sent≥80 ${ge80} 天`);
}
console.log('\n  各档占比（应恒为 5% / 3% / 1%，与窗口长度无关）:');
for (const [k, m] of [['A 300天', A], ['B 三年 ', B]]) {
  const vals = [...m.map.values()];
  const n = vals.length;
  console.log(`  ${k}: ` + TIERS.map((t) => `${t.name} ${((vals.filter((x) => x.sent >= t.sentLo).length / n) * 100).toFixed(1)}%`).join(' · '));
}

// ---------------- 评分模型本身：sent 阈值 → 次日胜率 ----------------
// 这是面板里 bins / thresholds 那一类统计的核心形式。扩窗后门槛的含义变了，
// 同一个「sent≥60」在三年窗口里对应的严格程度不同，胜率自然也会变。
let sh = null;
try {
  const s = JSON.parse(readFileSync('daily-long.json', 'utf8')).series.sh;
  sh = (s.bars ?? s).map((b) => ({ d: b.d, c: b.c }));
} catch { /* 没有就不跑这段 */ }

if (sh) {
  const idx = new Map(sh.map((r, i) => [r.d, i]));
  const nextRet = (d) => {
    const i = idx.get(d);
    return i === undefined || i + 1 >= sh.length ? null : (sh[i + 1].c / sh[i].c - 1) * 100;
  };
  console.log('\n=== 评分模型：sent ≥ 阈值 → 次日上证涨跌（这才是扩窗真正动到的东西）');
  console.log('  阈值      A(300天) n/胜率         B(三年) n/胜率');
  const base = (M) => {
    const r = M.dates.map(nextRet).filter((x) => x != null);
    return { n: r.length, wr: (r.filter((x) => x > 0).length / r.length) * 100 };
  };
  const ba = base(A), bb = base(B);
  console.log(`  基准(全部)  ${String(ba.n).padStart(3)} 天 / ${ba.wr.toFixed(1)}%        ${String(bb.n).padStart(3)} 天 / ${bb.wr.toFixed(1)}%`);
  for (const T of [40, 50, 60, 70, 80]) {
    const cell = (M) => {
      const rs = M.dates.filter((d) => M.map.get(d).sent >= T).map(nextRet).filter((x) => x != null);
      if (!rs.length) return '   — 天 /   — %';
      return `${String(rs.length).padStart(4)} 天 / ${((rs.filter((x) => x > 0).length / rs.length) * 100).toFixed(1)}%`;
    };
    console.log(`  sent≥${String(T).padEnd(3)}  ${cell(A)}        ${cell(B)}`);
  }
  console.log('\n  注：胜率是「次日上证收涨」的占比，未扣成本、未做样本外切分，只用于看扩窗带来的位移。');
} else {
  console.log('\n（缺 daily-long.json，跳过 sent 阈值 → 次日胜率 这段）');
}

