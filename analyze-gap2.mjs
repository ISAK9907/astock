// 跳空策略的延伸验证：收益来源分解 / 极端样本稳定性 / 交互 / 成本 / 逐年前瞻
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

function build(key, from = '0000-00-00', to = '9999-99-99') {
  const bars = J.series[key].bars.filter((b) => b.d >= from && b.d <= to && b.d < TODAY);
  const rows = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    rows.push({
      d: b.d,
      gap: (b.o / p.c - 1) * 100,
      overnight: (b.o / p.c - 1) * 100,
      intraday: (b.c / b.o - 1) * 100,
      sellOpen: ((b.o - b.c) / b.o) * 100,
      day: (b.c / p.c - 1) * 100,
      prevDay: (p.c / (bars[i - 2]?.c ?? p.o) - 1) * 100,
      filled: b.l <= p.c,
      hi: (b.h / p.c - 1) * 100,
      lo: (b.l / p.c - 1) * 100,
    });
  }
  return rows;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
/** 自助法均值置信区间（百分位法） */
function bootCI(a, iters = 4000) {
  if (a.length < 5) return null;
  const ms = [];
  for (let k = 0; k < iters; k++) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[(Math.random() * a.length) | 0];
    ms.push(s / a.length);
  }
  ms.sort((x, y) => x - y);
  return [ms[Math.floor(iters * 0.025)], ms[Math.floor(iters * 0.975)]];
}

const sh = build('sh');

// ---------- A. 收益来源分解 ----------
console.log('=== A. 收益来源分解：A股的收益到底来自隔夜还是日内（上证 16 年）===');
const on = sh.map((r) => r.overnight), inn = sh.map((r) => r.intraday);
console.log(`  隔夜 (昨收→今开)   平均 ${pct(mean(on))}%   为正 ${(on.filter((v) => v > 0).length / on.length * 100).toFixed(1)}%`);
console.log(`  日内 (今开→今收)   平均 ${pct(mean(inn))}%   为正 ${(inn.filter((v) => v > 0).length / inn.length * 100).toFixed(1)}%`);
console.log(`  → 日内漂移为正 ${pct(mean(inn))}%/天，这就是「开盘卖、收盘买」天然逆风的原因（16年 ≈ ${(mean(inn) * 250).toFixed(1)}%/年）`);

// ---------- B. 极端高开：多指数汇总 + 自助法 ----------
console.log('\n=== B. 极端高开：四个指数汇总（单指数样本太小）===');
const pool = Object.keys(J.series).flatMap((k) => build(k).map((r) => ({ ...r, idx: J.series[k].name })));
console.log('  阈值       n    低走率   期望减仓收益        95%自助区间        开盘减仓对全天  回补率');
for (const th of [0.5, 1, 1.5, 2]) {
  const s = pool.filter((r) => r.gap >= th);
  const v = s.map((r) => r.sellOpen);
  const ci = th >= 1 ? bootCI(v) : null;
  console.log(
    `  ≥${th}%  ${String(s.length).padStart(5)}  ${(v.filter((x) => x > 0).length / s.length * 100).toFixed(1).padStart(5)}%  ` +
      `${pct(mean(v)).padStart(9)}%  ${ci ? `[${pct(ci[0])}%, ${pct(ci[1])}%]`.padStart(20) : ' '.repeat(20)}  ` +
      `${pct(mean(s.map((r) => r.day))).padStart(9)}%  ${(s.filter((r) => r.filled).length / s.length * 100).toFixed(1).padStart(5)}%`,
  );
}

// ---------- C. 交互：高开发生在连涨之后 vs 连跌之后 ----------
console.log('\n=== C. 高开(\u22650.5%)与「前一日涨跌」的交互（上证）===');
for (const [nm, pred] of [['前一日上涨', (r) => r.prevDay > 0], ['前一日下跌', (r) => r.prevDay <= 0]]) {
  const s = sh.filter((r) => r.gap >= 0.5 && pred(r));
  if (!s.length) continue;
  console.log(`  ${nm}: n=${String(s.length).padStart(3)}  低走率 ${(s.filter((r) => r.sellOpen > 0).length / s.length * 100).toFixed(1)}%  期望减仓收益 ${pct(mean(s.map((r) => r.sellOpen)))}%  全天期望 ${pct(mean(s.map((r) => r.day)))}%`);
}
console.log('\n=== C2. 低开(\u2264-0.5%)的对称性（上证）===');
const dn = sh.filter((r) => r.gap <= -0.5);
console.log(`  n=${dn.length}  高走率(收>开) ${(dn.filter((r) => r.intraday > 0).length / dn.length * 100).toFixed(1)}%  开盘买入收盘卖出期望 ${pct(mean(dn.map((r) => r.intraday)))}%  （同样含 ${pct(mean(sh.map((r) => r.intraday)))}% 日内基准）`);
const dnAdj = mean(dn.map((r) => r.intraday)) - mean(sh.map((r) => r.intraday));
console.log(`  扣除日内基准后的超额：${pct(dnAdj)}%  → ${dnAdj > 0 ? '低开确实略微高走' : '低开并未高走'}`);

// ---------- D. 交易成本 ----------
console.log('\n=== D. 交易成本（决定这个策略能不能活）===');
console.log('  卖出印花税 0.05% + 双边佣金约 0.05% + 滑点（集合竞价挂单约 0.02~0.05%）≈ 单次往返 0.10~0.15%');
console.log('  对比：高开≥1% 的期望减仓收益 +' + mean(pool.filter((r) => r.gap >= 1).map((r) => r.sellOpen)).toFixed(2) + '%');
console.log('  对比：高开≥2% 的期望减仓收益 +' + mean(pool.filter((r) => r.gap >= 2).map((r) => r.sellOpen)).toFixed(2) + '%');

// ---------- E. 逐年前瞻：极端高开策略是否年年有效 ----------
console.log('\n=== E. 逐年前瞻：高开≥1%（四指数汇总）的期望减仓收益 ===');
const years = [...new Set(pool.map((r) => r.d.slice(0, 4)))].sort();
let window = [];
console.log('  年份   n   低走率   期望减仓收益');
for (const y of years) {
  const s = pool.filter((r) => r.d.startsWith(y) && r.gap >= 1);
  if (!s.length) continue;
  window.push(s);
  console.log(`  ${y}  ${String(s.length).padStart(3)}  ${(s.filter((r) => r.sellOpen > 0).length / s.length * 100).toFixed(1).padStart(5)}%  ${pct(mean(s.map((r) => r.sellOpen))).padStart(9)}%`);
}
const posYears = years.filter((y) => {
  const s = pool.filter((r) => r.d.startsWith(y) && r.gap >= 1);
  return s.length >= 3 && mean(s.map((r) => r.sellOpen)) > 0;
}).length;
const usedYears = years.filter((y) => pool.filter((r) => r.d.startsWith(y) && r.gap >= 1).length >= 3).length;
console.log(`  → ${usedYears} 个有足够样本的年份中，${posYears} 个年份期望为正（${(posYears / usedYears * 100).toFixed(0)}%），随机基准 50%`);

// ---------- F. 缺口方向不对称 ----------
console.log('\n=== F. 跳空幅度 vs 后续 5 日累计收益（是否只是短期现象）===');
console.log('  阈值       n     当日      次日      后5日');
for (const th of [0.5, 1, 2]) {
  const s = pool.filter((r) => r.gap >= th);
  const fwd = (r, k) => {
    const bars = J.series[Object.keys(J.series).find((x) => J.series[x].name === r.idx)].bars;
    const i = bars.findIndex((b) => b.d === r.d);
    if (i < 0 || i + k >= bars.length) return null;
    return (bars[i + k].c / bars[i].c - 1) * 100;
  };
  const f1 = s.map((r) => fwd(r, 1)).filter((v) => v != null);
  const f5 = s.map((r) => fwd(r, 5)).filter((v) => v != null);
  console.log(`  ≥${th}%  ${String(s.length).padStart(5)}  ${pct(mean(s.map((r) => r.day))).padStart(7)}%  ${pct(mean(f1)).padStart(7)}%  ${pct(mean(f5)).padStart(7)}%`);
}
