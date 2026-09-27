// ④ 用「情绪/状态」给高开减仓效应做条件分解
//   两层样本：
//     (a) 16 年日线可算的恐慌代理（前日跌幅、5日跌幅、20日波动率分位、距 MA20）
//     (b) 真实的跌停情绪指标（dt-stats.json，300 天，口径精确但样本小）
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const DT = JSON.parse(readFileSync('dt-stats.json', 'utf8')).daily;
// 注意：dt-stats.json 的 daily 只有 dt（跌停家数），情绪值 sent 是 build-dashboard 才并入 DTDATA 的，
// 这里必须单独从 sentiment.json 取，否则 join 会全空。
const SENT = JSON.parse(readFileSync('sentiment.json', 'utf8')).daily ?? {};
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function build(key) {
  const bars = J.series[key].bars.filter((b) => b.d < TODAY);
  const rets = bars.map((b, i) => (i ? (b.c / bars[i - 1].c - 1) * 100 : 0));
  const out = [];
  let prevDt = null, prevSent = null;
  for (let i = 25; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    const r20 = rets.slice(i - 19, i + 1);
    const vol20 = sd(r20);
    const ma20 = bars.slice(i - 19, i + 1).reduce((s, x) => s + x.c, 0) / 20;
    // vol20 在过去 250 日的分位
    const hist = [];
    for (let k = Math.max(21, i - 250); k <= i; k++) hist.push(sd(rets.slice(k - 19, k + 1)));
    const pctile = hist.filter((v) => v < vol20).length / hist.length;
    const curDt = DT[b.d] ? DT[b.d].dt : null;
    const curSent = DT[b.d] ? (SENT[b.d]?.sent ?? null) : null;
    out.push({
      d: b.d, idx: J.series[key].name,
      gap: (b.o / p.c - 1) * 100,
      sellOpen: ((b.o - b.c) / b.o) * 100,
      day: (b.c / p.c - 1) * 100,
      prev1: rets[i - 1],
      prev5: ((p.c / bars[i - 5].c - 1) * 100),
      vol20, volPct: pctile,
      ma20dev: (p.c / ma20 - 1) * 100,
      sent: curSent,
      dt: curDt,
      // 滞后一日的状态：今日开盘时**已知**，才是可执行的
      lagDt: prevDt,
      lagSent: prevSent,
    });
    prevDt = curDt;
    prevSent = curSent;
  }
  return out;
}
const pool = Object.keys(J.series).flatMap(build);
const sig = pool.filter((r) => r.gap >= 1);
console.log(`样本：四指数池化 ${pool.length} 天（含 20 日预热）；高开≥1% 共 ${sig.length} 次`);
console.log(`无条件（全部日子）日内开→收 ${pct(mean(pool.map((r) => -r.sellOpen)))}\n`);

function line(name, s) {
  if (!s.length) { console.log(`  ${name.padEnd(22)} n=0`); return; }
  console.log(
    `  ${name.padEnd(22)} n=${String(s.length).padStart(4)}  低走率 ${(s.filter((r) => r.sellOpen > 0).length / s.length * 100).toFixed(1).padStart(5)}%  ` +
      `期望减仓 ${pct(mean(s.map((r) => r.sellOpen))).padStart(8)}  全天期望 ${pct(mean(s.map((r) => r.day))).padStart(8)}`,
  );
}

console.log('=== ④-A 高开≥1%，按「前一日涨跌」分条件 ===');
line('前一日跌 ≤-1%', sig.filter((r) => r.prev1 <= -1));
line('前一日 -1~0%', sig.filter((r) => r.prev1 > -1 && r.prev1 <= 0));
line('前一日 0~1%', sig.filter((r) => r.prev1 > 0 && r.prev1 <= 1));
line('前一日涨 >1%', sig.filter((r) => r.prev1 > 1));
console.log('  基准（高开≥1% 无条件）');
line('  全部', sig);

console.log('\n=== ④-B 高开≥1%，按「过去 5 日累计」分条件 ===');
line('5日跌 ≤-3%', sig.filter((r) => r.prev5 <= -3));
line('5日 -3~0%', sig.filter((r) => r.prev5 > -3 && r.prev5 <= 0));
line('5日 0~3%', sig.filter((r) => r.prev5 > 0 && r.prev5 <= 3));
line('5日涨 >3%', sig.filter((r) => r.prev5 > 3));

console.log('\n=== ④-C 高开≥1%，按「20 日波动率分位」分条件（低波 vs 高波）===');
line('波动率最低 1/3', sig.filter((r) => r.volPct < 1 / 3));
line('波动率中间 1/3', sig.filter((r) => r.volPct >= 1 / 3 && r.volPct < 2 / 3));
line('波动率最高 1/3', sig.filter((r) => r.volPct >= 2 / 3));

console.log('\n=== ④-D 高开≥1%，按「距 MA20 偏离」分条件（趋势位置）===');
line('低于 MA20 超 3%', sig.filter((r) => r.ma20dev <= -3));
line('MA20 附近 ±3%', sig.filter((r) => r.ma20dev > -3 && r.ma20dev < 3));
line('高于 MA20 超 3%', sig.filter((r) => r.ma20dev >= 3));

console.log('\n=== ④-E 用真实跌停情绪作条件（口径精确，但样本很小）===');
const withSent = pool.filter((r) => r.sent != null);
console.log(`  有情绪数据的日子 ${withSent.length} 天（${withSent[0]?.d} → ${withSent[withSent.length - 1]?.d}）`);
const sSig = withSent.filter((r) => r.gap >= 1);
console.log(`  其中高开≥1% 仅 ${sSig.length} 次 —— 样本不足以做条件分解`);
console.log('  → 改用「跌停家数」作当日状态（有情绪数据窗口内的全部日子）:');
line('跌停≥40家 当日', withSent.filter((r) => r.dt >= 40));
line('跌停10~40家 当日', withSent.filter((r) => r.dt >= 10 && r.dt < 40));
line('跌停<10家 当日', withSent.filter((r) => r.dt < 10));

console.log('\n=== ④-E2 ⚠️ 可执行性检验：改用「昨日跌停家数」（今日开盘时已知）===');
const lagged = pool.filter((r) => r.lagDt != null);
console.log(`  可用样本 ${lagged.length} 天`);
line('昨日跌停≥40家', lagged.filter((r) => r.lagDt >= 40));
line('昨日跌停10~40家', lagged.filter((r) => r.lagDt >= 10 && r.lagDt < 40));
line('昨日跌停<10家', lagged.filter((r) => r.lagDt < 10));
const lagHi = lagged.filter((r) => r.lagDt >= 40);
console.log(
  `  对比：当日跌停≥40 期望减仓 ${pct(mean(withSent.filter((r) => r.dt >= 40).map((r) => r.sellOpen)))}` +
    `  →  昨日跌停≥40 期望减仓 ${pct(mean(lagHi.map((r) => r.sellOpen)))}`,
);
console.log(`  → ${mean(lagHi.map((r) => r.sellOpen)) > 0.3 ? '滞后信号仍然有效' : '★ 滞后后效应大幅衰减 —— 该信号在开盘时不可执行'}`);

console.log('\n=== ④-G 关键条件的分时代稳定性（「前日跌≤-1%」vs「前日涨>1%」）===');
const ERAS = [['2010-2013', 2010, 2013], ['2014-2017', 2014, 2017], ['2018-2021', 2018, 2021], ['2022-2026', 2022, 2026]];
console.log('  时段         弱后高开 n   期望减仓    强后高开 n   期望减仓    方向是否一致');
for (const [nm, a, b] of ERAS) {
  const inEra = sig.filter((r) => { const y = +r.d.slice(0, 4); return y >= a && y <= b; });
  const weak = inEra.filter((r) => r.prev1 <= -1), strong = inEra.filter((r) => r.prev1 > 1);
  const mw = weak.length ? mean(weak.map((r) => r.sellOpen)) : NaN;
  const ms = strong.length ? mean(strong.map((r) => r.sellOpen)) : NaN;
  const ok = weak.length >= 5 && strong.length >= 5 ? mw > ms : null;
  console.log(
    `  ${nm}  ${String(weak.length).padStart(8)}  ${pct(mw).padStart(9)}  ${String(strong.length).padStart(9)}  ${pct(ms).padStart(9)}  ` +
      `${ok === null ? '样本不足' : ok ? '✓ 一致' : '✗ 反转'}`,
  );
}

console.log('\n=== ④-H 找一个"可执行"的联合条件（高开≥1% 且 前日跌≤-1%）===');
const best = sig.filter((r) => r.prev1 <= -1);
console.log(`  信号数 ${best.length}（四指数 16 年）→ 单指数约 ${(best.length / 4 / 16).toFixed(1)} 次/年`);
console.log(`  期望减仓 ${pct(mean(best.map((r) => r.sellOpen)))}  扣 0.12% 成本后 ${pct(mean(best.map((r) => r.sellOpen)) - 0.12)}`);
console.log(`  低走率 ${(best.filter((r) => r.sellOpen > 0).length / best.length * 100).toFixed(1)}%`);
console.log(`  同期这些日子的全天期望 ${pct(mean(best.map((r) => r.day)))}（说明你减仓的是"涨的日子"，但日内确有回落）`);
const sorted = best.map((r) => r.sellOpen).sort((x, y) => x - y);
console.log(`  减仓收益分布：最差 ${pct(sorted[0])}  25% ${pct(sorted[Math.floor(sorted.length * 0.25)])}  中位 ${pct(sorted[Math.floor(sorted.length / 2)])}  75% ${pct(sorted[Math.floor(sorted.length * 0.75)])}  最好 ${pct(sorted.at(-1))}`);

console.log('\n=== ④-F 汇总：哪个条件真正把效应拉开了 ===');
const conds = [
  ['前一日跌≤-1%', (r) => r.prev1 <= -1], ['前一日涨>1%', (r) => r.prev1 > 1],
  ['5日跌≤-3%', (r) => r.prev5 <= -3], ['5日涨>3%', (r) => r.prev5 > 3],
  ['低波动 1/3', (r) => r.volPct < 1 / 3], ['高波动 1/3', (r) => r.volPct >= 2 / 3],
  ['低于MA20>3%', (r) => r.ma20dev <= -3], ['高于MA20>3%', (r) => r.ma20dev >= 3],
];
const base = mean(sig.map((r) => r.sellOpen));
console.log(`  （高开≥1% 基准期望减仓 ${pct(base)}）`);
console.log('  条件                  n    期望减仓   与基准差    低走率');
for (const [nm, pred] of conds) {
  const s = sig.filter(pred);
  if (s.length < 15) { console.log(`  ${nm.padEnd(20)} n=${s.length} 样本过少`); continue; }
  const m = mean(s.map((r) => r.sellOpen));
  console.log(
    `  ${nm.padEnd(20)} ${String(s.length).padStart(4)}  ${pct(m).padStart(9)}  ${pct(m - base).padStart(9)}  ` +
      `${(s.filter((r) => r.sellOpen > 0).length / s.length * 100).toFixed(1).padStart(6)}%`,
  );
}
