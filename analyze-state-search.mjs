// ② 状态变量搜索：哪个「T 日状态」代理能把 T+1 高开后的方向拉得最开
//   评价口径：在同一 T+1 跳空条件下，状态高档与低档之间的 T+1 日内收益跨度。
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };

function build(key) {
  const bars = J.series[key].bars.filter((b) => b.d < TODAY);
  const rets = bars.map((b, i) => (i ? (b.c / bars[i - 1].c - 1) * 100 : 0));
  const out = [];
  for (let i = 21; i < bars.length; i++) {
    const tl = bars[i - 2], t = bars[i - 1], x = bars[i];
    const rng = t.h - t.l;
    const ma20 = bars.slice(i - 20, i).reduce((s, b) => s + b.c, 0) / 20;   // 不含 T 日
    const amt20 = bars.slice(i - 20, i).reduce((s, b) => s + (b.amt || 0), 0) / 20;
    const vol20 = sd(rets.slice(i - 19, i));
    // 连涨/连跌天数（T 日结束时的连续同向天数，带符号）
    let streak = 0;
    for (let k = i - 1; k > 0; k--) {
      const r = bars[k].c / bars[k - 1].c - 1;
      if (streak === 0) streak = r >= 0 ? 1 : -1;
      else if (r >= 0 && streak > 0) streak++;
      else if (r < 0 && streak < 0) streak--;
      else break;
    }
    out.push({
      d: x.d,
      gap: (x.o / t.c - 1) * 100,
      intraday: (x.c / x.o - 1) * 100,
      // ---- T 日（收盘后全部可知）----
      retT: (t.c / tl.c - 1) * 100,
      closePos: rng > 0 ? (t.c - t.l) / rng : 0.5,
      rangeT: (rng / tl.c) * 100,
      amtRatio: amt20 > 0 && t.amt ? t.amt / amt20 : null,     // 成交额 / 20日均值
      streak,
      ma20dev: (t.c / ma20 - 1) * 100,
      vol20,
      overnightT: (t.o / tl.c - 1) * 100,
      intradayT: (t.c / t.o - 1) * 100,
      dropFromHigh: rng > 0 ? ((t.h - t.c) / t.h) * 100 : 0,
      // 2 日累计
      ret2T: (t.c / bars[i - 3].c - 1) * 100,
    });
  }
  return out;
}
const pool = Object.keys(J.series).flatMap(build);
console.log(`样本 ${pool.length} 个 (T, T+1) 对，2010-2026，四指数池化\n`);

const VARS = [
  ['T日涨跌幅', (r) => r.retT], ['T日收盘位置', (r) => r.closePos], ['T日振幅', (r) => r.rangeT],
  ['T日成交额/20日均值', (r) => r.amtRatio], ['连涨连跌天数', (r) => r.streak], ['距MA20偏离', (r) => r.ma20dev],
  ['20日波动率', (r) => r.vol20], ['T日隔夜', (r) => r.overnightT], ['T日日内(开→收)', (r) => r.intradayT],
  ['T日自高点回落', (r) => r.dropFromHigh], ['T+2日累计', (r) => r.ret2T],
];
const hi = (r) => r.gap > 1, lo = (r) => r.gap < -1;

const ERAS = [[2010, 2013], [2014, 2017], [2018, 2021], [2022, 2026]];

console.log('=== 各状态变量在「T+1 高开>1%」条件下的高低档跨度 ===');
console.log('  状态变量                 低档 n   低档日内   高档 n   高档日内   跨度     分时代方向一致');
const results = [];
for (const [nm, f] of VARS) {
  const vals = pool.map(f).filter((v) => v != null && isFinite(v));
  if (vals.length < pool.length * 0.8) { console.log(`  ${nm.padEnd(22)} 数据缺失过多`); continue; }
  const t1 = q(vals, 1 / 3), t2 = q(vals, 2 / 3);
  const hiPool = pool.filter((r) => hi(r) && f(r) != null);
  const low = hiPool.filter((r) => f(r) <= t1), high = hiPool.filter((r) => f(r) >= t2);
  if (low.length < 20 || high.length < 20) { console.log(`  ${nm.padEnd(22)} 高档/低档样本不足`); continue; }
  const ml = mean(low.map((r) => r.intraday)), mh = mean(high.map((r) => r.intraday));
  const spread = mh - ml;
  // 分时代一致性：每段内高档-低档的符号
  const signs = ERAS.map(([a, b]) => {
    const seg = (arr) => arr.filter((r) => { const y = +r.d.slice(0, 4); return y >= a && y <= b; });
    const L = seg(low), H = seg(high);
    if (L.length < 5 || H.length < 5) return null;
    return mean(H.map((r) => r.intraday)) - mean(L.map((r) => r.intraday));
  }).filter((v) => v != null);
  const agree = signs.filter((v) => Math.sign(v) === Math.sign(spread)).length;
  results.push({ nm, spread, low: ml, high: mh, nl: low.length, nh: high.length, agree, tot: signs.length });
  console.log(
    `  ${nm.padEnd(22)} ${String(low.length).padStart(5)}  ${pct(ml).padStart(9)}  ${String(high.length).padStart(6)}  ${pct(mh).padStart(9)}  ` +
      `${pct(spread).padStart(8)}   ${agree}/${signs.length} ${agree === signs.length && signs.length ? '✓' : ''}`,
  );
}

console.log('\n=== 同口径下的「T+1 低开<-1%」条件（看是否只是同一变量的镜像）===');
console.log('  状态变量                 低档日内    高档日内    跨度(高-低)');
for (const [nm, f] of VARS) {
  const vals = pool.map(f).filter((v) => v != null && isFinite(v));
  if (vals.length < pool.length * 0.8) continue;
  const t1 = q(vals, 1 / 3), t2 = q(vals, 2 / 3);
  const loPool = pool.filter((r) => lo(r) && f(r) != null);
  const low = loPool.filter((r) => f(r) <= t1), high = loPool.filter((r) => f(r) >= t2);
  if (low.length < 20 || high.length < 20) continue;
  console.log(`  ${nm.padEnd(22)} ${pct(mean(low.map((r) => r.intraday))).padStart(9)}  ${pct(mean(high.map((r) => r.intraday))).padStart(10)}  ${pct(mean(high.map((r) => r.intraday)) - mean(low.map((r) => r.intraday))).padStart(11)}`);
}

console.log('\n=== 排序：按 |跨度| × 分时代一致性 ===');
results.sort((a, b) => Math.abs(b.spread) * (b.agree / Math.max(1, b.tot)) - Math.abs(a.spread) * (a.agree / Math.max(1, a.tot)));
for (const r of results) {
  console.log(`  ${r.nm.padEnd(22)} 跨度 ${pct(r.spread).padStart(8)}  一致性 ${r.agree}/${r.tot}  综合分 ${(Math.abs(r.spread) * (r.agree / Math.max(1, r.tot))).toFixed(2)}`);
}

console.log('\n=== 最优变量的分档明细（含中档，看是否单调）===');
const best = results[0];
const bf = VARS.find(([n]) => n === best.nm)[1];
const bvals = pool.map(bf).filter((v) => v != null && isFinite(v));
const [b1, b2] = [q(bvals, 1 / 3), q(bvals, 2 / 3)];
console.log(`  ${best.nm}  分档阈值：低 ≤ ${b1.toFixed(3)}，高 ≥ ${b2.toFixed(3)}`);
for (const [gn, gp] of [['高开>1%', hi], ['平开±0.3%', (r) => r.gap >= -0.3 && r.gap <= 0.3], ['低开<-1%', lo]]) {
  const s = pool.filter((r) => gp(r) && bf(r) != null);
  const cell = (p) => { const c = s.filter(p); return c.length >= 15 ? `${pct(mean(c.map((r) => r.intraday)))}(n=${c.length})` : `样本少(n=${c.length})`; };
  console.log(`  ${gn.padEnd(10)} 低档 ${cell((r) => bf(r) <= b1).padStart(16)}  中档 ${cell((r) => bf(r) > b1 && bf(r) < b2).padStart(16)}  高档 ${cell((r) => bf(r) >= b2).padStart(16)}`);
}
