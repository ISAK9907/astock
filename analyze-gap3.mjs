// 第三轮：稳定性检验 + 策略回测（含成本）+ 寻找更稳健的替代规律
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function build(key, from = '0000-00-00', to = '9999-99-99') {
  const bars = J.series[key].bars.filter((b) => b.d >= from && b.d <= to && b.d < TODAY);
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    out.push({
      d: b.d,
      gap: (b.o / p.c - 1) * 100,
      overnight: (b.o / p.c - 1) * 100,
      intraday: (b.c / b.o - 1) * 100,
      sellOpen: ((b.o - b.c) / b.o) * 100,
      day: (b.c / p.c - 1) * 100,
      idx: J.series[key].name,
      key,
    });
  }
  return out;
}

// ---------- 1. 隔夜/日内分解的稳健性 ----------
console.log('=== 1. 「隔夜跌、日内涨」是否在所有指数、所有时段都成立 ===');
console.log('  指数          隔夜均值   日内均值    隔夜为正%  日内为正%');
for (const k of Object.keys(J.series)) {
  const r = build(k);
  console.log(
    `  ${J.series[k].name.padEnd(10)}  ${pct(mean(r.map((x) => x.overnight))).padStart(8)}%  ${pct(mean(r.map((x) => x.intraday))).padStart(8)}%  ` +
      `${(r.filter((x) => x.overnight > 0).length / r.length * 100).toFixed(1).padStart(8)}%  ${(r.filter((x) => x.intraday > 0).length / r.length * 100).toFixed(1).padStart(8)}%`,
  );
}
console.log('\n  按年（上证）：');
const sh = build('sh');
const years = [...new Set(sh.map((r) => r.d.slice(0, 4)))].sort();
let posOn = 0, posIn = 0, cnt = 0;
const line = [];
for (const y of years) {
  const s = sh.filter((r) => r.d.startsWith(y));
  if (s.length < 100) continue;
  const a = mean(s.map((x) => x.overnight)), b = mean(s.map((x) => x.intraday));
  if (a > 0) posOn++;
  if (b > 0) posIn++;
  cnt++;
  line.push(`${y.slice(2)}:${b >= 0 ? '+' : ''}${b.toFixed(2)}`);
}
console.log('  日内均值逐年: ' + line.join('  '));
console.log(`  → ${cnt} 年中，隔夜为正 ${posOn} 年（${(posOn / cnt * 100).toFixed(0)}%），日内为正 ${posIn} 年（${(posIn / cnt * 100).toFixed(0)}%）`);

// ---------- 2. 「高开减仓」策略回测（含成本） ----------
console.log('\n=== 2. 策略回测：高开≥阈值 → 开盘减仓、收盘买回（含往返成本）===');
console.log('  阈值    信号数  毛期望   净期望(0.12%成本)  累计净收益   年化    同期买入持有');
for (const th of [0.5, 1, 1.5, 2]) {
  for (const key of ['sh']) {
    const r = build(key);
    const sig = r.filter((x) => x.gap >= th);
    const gross = mean(sig.map((x) => x.sellOpen));
    const net = gross - 0.12;
    const cum = sig.reduce((a, x) => a + (x.sellOpen - 0.12) / 100, 0);
    const yrs = (new Date(r.at(-1).d) - new Date(r[0].d)) / (365.25 * 864e5);
    const bh = r.reduce((a, x) => a + x.day / 100, 0);
    console.log(
      `  ≥${th}%  ${String(sig.length).padStart(6)}  ${pct(gross).padStart(7)}%  ${pct(net).padStart(12)}%  ` +
        `${pct(cum * 100, 1).padStart(10)}%  ${pct((cum / yrs) * 100, 2).padStart(6)}%  ${pct(bh * 100, 0).padStart(10)}%`,
    );
  }
}
console.log('  （注：策略只在信号日持仓，其余时间空仓；"累计净收益"是每次交易收益的简单加总，未复利）');

// ---------- 3. 滚动 3 年稳定性 ----------
console.log('\n=== 3. 滚动 3 年窗口：高开≥1.5%（四指数汇总）的期望减仓收益 ===');
const pool = Object.keys(J.series).flatMap((k) => build(k));
const startY = 2010;
for (let y = startY; y <= 2024; y += 3) {
  const s = pool.filter((r) => {
    const yy = +r.d.slice(0, 4);
    return yy >= y && yy < y + 3 && r.gap >= 1.5;
  });
  if (!s.length) continue;
  const m = mean(s.map((r) => r.sellOpen));
  console.log(`  ${y}-${y + 2}: n=${String(s.length).padStart(3)}  期望 ${pct(m).padStart(7)}%  低走率 ${(s.filter((r) => r.sellOpen > 0).length / s.length * 100).toFixed(1)}%  ${m > 0 ? '✓' : '✗'}`);
}

// ---------- 4. 更稳健的替代：日内漂移的可利用性 ----------
console.log('\n=== 4. 发散：既然日内漂移为正，有没有更稳的用法 ===');
console.log('  (a) 「收盘买、次日收盘卖」= 完整持有 → 见买入持有');
console.log('  (b) 「开盘买、收盘卖」→ T+1 违规，不可执行');
console.log('  (c) 「收盘卖、次日开盘买」（只避开隔夜）→ 合法：卖出手上持仓，次日开盘买回');
for (const k of Object.keys(J.series)) {
  const r = build(k);
  const cum = r.reduce((a, x) => a + (-x.overnight - 0.12) / 100, 0); // 避开隔夜 = 赚 -隔夜，但要付一次往返成本
  const yrs = (new Date(r.at(-1).d) - new Date(r[0].d)) / (365.25 * 864e5);
  console.log(`     ${J.series[k].name.padEnd(8)} 累计 ${pct(cum * 100, 0).padStart(8)}%  年化 ${pct((cum / yrs) * 100, 2).padStart(6)}%  (避开隔夜毛收益 ${pct(mean(r.map((x) => -x.overnight)))}%/天，扣成本后 ${pct(mean(r.map((x) => -x.overnight)) - 0.12)}%/天)`);
}

// ---------- 5. 极端高开当天的路径画像 ----------
console.log('\n=== 5. 高开≥1.5% 当天的路径画像（上证+沪深300）===');
for (const k of ['sh', 'hs300']) {
  const bars = J.series[k].bars.filter((b) => b.d < TODAY);
  const s = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    const gap = (b.o / p.c - 1) * 100;
    if (gap >= 1.5) s.push({ gap, o: b.o, h: b.h, l: b.l, c: b.c, pc: p.c });
  }
  const n = s.length;
  if (!n) continue;
  console.log(
    `  ${J.series[k].name}: n=${n}  最高相对开盘 ${pct(mean(s.map((r) => (r.h / r.o - 1) * 100)))}%  ` +
      `最低相对开盘 ${pct(mean(s.map((r) => (r.l / r.o - 1) * 100)))}%  ` +
      `触及昨收(回补) ${(s.filter((r) => r.l <= r.pc).length / n * 100).toFixed(0)}%  ` +
      `收盘仍在开盘上方 ${(s.filter((r) => r.c > r.o).length / n * 100).toFixed(0)}%`,
  );
}
