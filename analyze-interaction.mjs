// 检验「T日状态 × T+1跳空」的**交互效应**是真的，还是两个一维效应叠加
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
/** Welch 双样本 t 检验 */
function welch(a, b) {
  if (a.length < 3 || b.length < 3) return { t: NaN, p: NaN };
  const ma = mean(a), mb = mean(b), va = sd(a) ** 2 / a.length, vb = sd(b) ** 2 / b.length;
  const t = (ma - mb) / Math.sqrt(va + vb);
  // 正态近似双侧 p
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)));
  return { t, p };
}
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911; const tt = 1 / (1 + p * x); const y = 1 - ((((a5 * tt + a4) * tt + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x); return s * y; }

function build(key) {
  const bars = J.series[key].bars.filter((b) => b.d < TODAY);
  const out = [];
  for (let i = 2; i < bars.length; i++) {
    const t = bars[i - 1], tl = bars[i - 2], x = bars[i];
    const rng = t.h - t.l;
    out.push({
      d: x.d, retT: (t.c / tl.c - 1) * 100,
      closePos: rng > 0 ? (t.c - t.l) / rng : 0.5,
      gap: (x.o / t.c - 1) * 100,
      intraday: (x.c / x.o - 1) * 100,
    });
  }
  return out;
}
const pool = Object.keys(J.series).flatMap(build);

const strong = (r) => r.retT >= 1.5, weak = (r) => r.retT <= -1.5, calm = (r) => r.retT > -0.3 && r.retT < 0.3;
const hiGap = (r) => r.gap > 1, loGap = (r) => r.gap < -1, midGap = (r) => r.gap >= -0.3 && r.gap <= 0.3;

console.log('=== 1. 两角对比：同样是「高开>1%」，T 日强弱决定方向 ===');
const a = pool.filter((r) => weak(r) && hiGap(r)).map((r) => r.intraday);
const b = pool.filter((r) => strong(r) && hiGap(r)).map((r) => r.intraday);
const w = welch(a, b);
console.log(`  T日恐慌(≤-1.5%) + 高开>1% : n=${a.length}  T+1日内 ${pct(mean(a))}`);
console.log(`  T日亢奋(≥+1.5%) + 高开>1% : n=${b.length}  T+1日内 ${pct(mean(b))}`);
console.log(`  差异 ${pct(mean(b) - mean(a))}  Welch t=${w.t.toFixed(2)}  p=${w.p.toFixed(4)}（未做多重比较校正）`);

console.log('\n=== 2. 一维 vs 二维：跳空的效应是否只在极端状态下才显现 ===');
console.log('  T 日状态          该状态下全部   低开<-1%     平开±0.3%    高开>1%    高开-低开跨度');
const STATES = [['T恐慌 ≤-1.5%', weak], ['T偏弱', (r) => r.retT > -1.5 && r.retT <= -0.3], ['T平稳', calm], ['T偏强', (r) => r.retT >= 0.3 && r.retT < 1.5], ['T亢奋 ≥+1.5%', strong]];
for (const [nm, sp] of STATES) {
  const s = pool.filter(sp);
  const g = (p) => mean(s.filter(p).map((r) => r.intraday));
  const all = mean(s.map((r) => r.intraday));
  console.log(
    `  ${nm.padEnd(16)} ${pct(all).padStart(9)}  ${pct(g(loGap)).padStart(9)}  ${pct(g(midGap)).padStart(10)}  ${pct(g(hiGap)).padStart(8)}  ${pct(g(hiGap) - g(loGap)).padStart(11)}`,
  );
}

console.log('\n=== 3. 反过来：同一跳空档位下，T 日状态的跨度 ===');
for (const [gn, gp] of [['低开<-1%', loGap], ['平开±0.3%', midGap], ['高开>1%', hiGap]]) {
  const s = pool.filter(gp);
  const vals = STATES.map(([, sp]) => mean(s.filter(sp).map((r) => r.intraday)));
  console.log(`  ${gn.padEnd(10)} 各状态 ${vals.map((v) => pct(v)).join('  ')}   跨度 ${pct(Math.max(...vals) - Math.min(...vals))}`);
}
console.log('  （若只有一维效应，各状态间跨度应在所有跳空档位下相同；实际相差数倍即为交互）');

console.log('\n=== 4. 基准对照：完全不看 T 日状态时，跳空本身的跨度 ===');
const g = (p) => mean(pool.filter(p).map((r) => r.intraday));
console.log(`  低开<-1% ${pct(g(loGap))}  →  高开>1% ${pct(g(hiGap))}   跨度 ${pct(g(hiGap) - g(loGap))}`);

console.log('\n=== 5. 稳健性：把「T日亢奋+高开>1%」逐年拆开 ===');
const cell = pool.filter((r) => strong(r) && hiGap(r));
const byYear = {};
for (const r of cell) (byYear[r.d.slice(0, 4)] ??= []).push(r.intraday);
let pos = 0, tot = 0;
const parts = [];
for (const y of Object.keys(byYear).sort()) {
  if (byYear[y].length < 3) continue;
  tot++; if (mean(byYear[y]) > 0) pos++;
  parts.push(`${y.slice(2)}:${mean(byYear[y]) > 0 ? '+' : ''}${mean(byYear[y]).toFixed(2)}`);
}
console.log('  ' + parts.join('  '));
console.log(`  → ${tot} 个年份中 ${pos} 年 T+1 日内为正（随机基准 50%）`);

console.log('\n=== 6. 期望值视角：这个交互能赚多少 ===');
console.log('  交易：T 日收盘后判断状态 → T+1 集合竞价跳空 → 开盘减仓、收盘买回');
for (const [nm, pred] of [
  ['T恐慌 + T+1高开>1% 减仓', (r) => weak(r) && hiGap(r)],
  ['T亢奋 + T+1高开>1% 增仓(反向)', (r) => strong(r) && hiGap(r)],
  ['T恐慌 + T+1低开<-1% 买入', (r) => weak(r) && loGap(r)],
]) {
  const s = pool.filter(pred);
  const v = s.map((r) => -r.intraday);
  console.log(`  ${nm.padEnd(30)} n=${String(s.length).padStart(4)}  毛期望 ${pct(mean(v))}  扣0.12% ${pct(mean(v) - 0.12)}  单指数 ${(s.length / 4 / 16).toFixed(1)} 次/年`);
}
