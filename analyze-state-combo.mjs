// ②b 叠加检验：T 日涨跌幅 × T 日成交额（两个都 4/4 一致，但属不同维度）
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function build(key) {
  const bars = J.series[key].bars.filter((b) => b.d < TODAY);
  const out = [];
  for (let i = 21; i < bars.length; i++) {
    const tl = bars[i - 2], t = bars[i - 1], x = bars[i];
    const amt20 = bars.slice(i - 20, i).reduce((s, b) => s + (b.amt || 0), 0) / 20;
    out.push({
      d: x.d,
      retT: (t.c / tl.c - 1) * 100,
      amtRatio: amt20 > 0 && t.amt ? t.amt / amt20 : null,
      gap: (x.o / t.c - 1) * 100,
      intraday: (x.c / x.o - 1) * 100,
      sellOpen: ((x.o - x.c) / x.o) * 100,
    });
  }
  return out;
}
const pool = Object.keys(J.series).flatMap(build).filter((r) => r.amtRatio != null);
console.log(`样本 ${pool.length}\n`);

// 相关性：成交额比是否只是涨跌幅的代理
const n = pool.length;
const mx = mean(pool.map((r) => r.retT)), my = mean(pool.map((r) => r.amtRatio));
const cov = pool.reduce((s, r) => s + (r.retT - mx) * (r.amtRatio - my), 0);
const rho = cov / (n - 1) / (sd(pool.map((r) => r.retT)) * sd(pool.map((r) => r.amtRatio)));
console.log(`T日涨跌幅 与 T日成交额比 的相关系数 r = ${rho.toFixed(3)}（接近 0 说明是独立维度）\n`);

// 分档（用固定阈值，便于实盘使用）
const RS = [['跌≤-0.5%', (r) => r.retT <= -0.5], ['平-0.5~0.5%', (r) => r.retT > -0.5 && r.retT < 0.5], ['涨≥0.5%', (r) => r.retT >= 0.5]];
const AS = [['缩量<0.9', (r) => r.amtRatio < 0.9], ['平量0.9~1.15', (r) => r.amtRatio >= 0.9 && r.amtRatio < 1.15], ['放量≥1.15', (r) => r.amtRatio >= 1.15]];

const hi = (r) => r.gap > 1, lo = (r) => r.gap < -1;
console.log('=== 3×3 组合：T+1 高开>1% 时的 T+1 日内收益 ===');
console.log('  T日涨跌 \\ T日量能   ' + AS.map(([n]) => n.padStart(16)).join(''));
for (const [rn, rp] of RS) {
  const cells = AS.map(([, ap]) => {
    const s = pool.filter((r) => rp(r) && ap(r) && hi(r));
    return s.length >= 10 ? `${pct(mean(s.map((r) => r.intraday)))}(n=${s.length})`.padStart(16) : `样本少(n=${s.length})`.padStart(16);
  });
  console.log(`  ${rn.padEnd(18)}` + cells.join(''));
}

console.log('\n=== 同样组合：T+1 低开<-1% 时 ===');
console.log('  T日涨跌 \\ T日量能   ' + AS.map(([n]) => n.padStart(16)).join(''));
for (const [rn, rp] of RS) {
  const cells = AS.map(([, ap]) => {
    const s = pool.filter((r) => rp(r) && ap(r) && lo(r));
    return s.length >= 10 ? `${pct(mean(s.map((r) => r.intraday)))}(n=${s.length})`.padStart(16) : `样本少(n=${s.length})`.padStart(16);
  });
  console.log(`  ${rn.padEnd(18)}` + cells.join(''));
}

console.log('\n=== 最终候选信号（T+1 开盘减仓视角，含 0.12% 成本）===');
const CAND = [
  ['T跌≥0.5% + 放量 + T+1高开>1%  → 别减仓', (r) => r.retT >= 0.5 && r.amtRatio >= 1.15 && r.gap > 1],
  ['T跌≥0.5% + 放量  (不限跳空)  → 别减仓', (r) => r.retT >= 0.5 && r.amtRatio >= 1.15],
  ['T涨≤-0.5% + T+1高开>1%      → 减仓', (r) => r.retT <= -0.5 && r.gap > 1],
  ['T涨≤-0.5% + 缩量 + T+1高开>1% → 减仓', (r) => r.retT <= -0.5 && r.amtRatio < 0.9 && r.gap > 1],
  ['T跌≥0.5% + 放量 + T+1低开<-1% → 买入', (r) => r.retT >= 0.5 && r.amtRatio >= 1.15 && r.gap < -1],
  ['T涨≤-0.5% + T+1低开<-1%     → 买入', (r) => r.retT <= -0.5 && r.gap < -1],
];
console.log('  信号                                      n     日内期望   减仓期望   扣成本后   单指数次/年');
for (const [nm, pred] of CAND) {
  const s = pool.filter(pred);
  if (s.length < 8) { console.log(`  ${nm.padEnd(40)} n=${s.length} 样本过少`); continue; }
  const sell = mean(s.map((r) => r.sellOpen));
  console.log(
    `  ${nm.padEnd(40)} ${String(s.length).padStart(4)}  ${pct(mean(s.map((r) => r.intraday))).padStart(9)}  ${pct(sell).padStart(9)}  ` +
      `${pct(sell - 0.12).padStart(9)}  ${(s.length / 4 / 16).toFixed(1).padStart(6)}`,
  );
}

console.log('\n=== 分时代一致性（T日涨跌幅 单独，最简形式）===');
const ERAS = [['2010-2013', 2010, 2013], ['2014-2017', 2014, 2017], ['2018-2021', 2018, 2021], ['2022-2026', 2022, 2026]];
for (const [nm, pred] of [['T涨≤-0.5% + T+1高开>1%', (r) => r.retT <= -0.5 && r.gap > 1], ['T跌≥0.5% + T+1高开>1%', (r) => r.retT >= 0.5 && r.gap > 1]]) {
  const s = pool.filter(pred);
  const parts = ERAS.map(([en, a, b]) => {
    const c = s.filter((r) => { const y = +r.d.slice(0, 4); return y >= a && y <= b; });
    return c.length >= 5 ? `${en.slice(2, 4)}:${pct(mean(c.map((r) => r.intraday)))}(${c.length})` : `${en.slice(2, 4)}:样本少`;
  });
  console.log(`  ${nm.padEnd(26)} ${parts.join('  ')}`);
}
