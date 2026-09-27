// 1) 今日收盘 → 明日跳空，有没有可用的统计关系
// 2) 从价格数据里反推 A 股历史休市日，并统计休市前后的上证涨跌概率
import { readFileSync } from 'node:fs';
const sh = JSON.parse(readFileSync('daily-long.json', 'utf8')).series.sh.bars;
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const corr = (x, y) => { const m = Math.min(x.length, y.length); if (m < 30) return NaN; const a = mean(x), b = mean(y); let s = 0, sx = 0, sy = 0; for (let i = 0; i < m; i++) { const p = x[i] - a, q = y[i] - b; s += p * q; sx += p * p; sy += q * q; } return s / Math.sqrt(sx * sy); };

// ---------- 1. 收盘 → 次日跳空 ----------
const rows = [];
for (let i = 2; i < sh.length - 1; i++) {
  const p = sh[i - 1], t = sh[i], n = sh[i + 1];
  rows.push({
    d: n.d,
    retT: (t.c / p.c - 1) * 100,
    closePos: t.h > t.l ? (t.c - t.l) / (t.h - t.l) : 0.5,
    intradayT: (t.c / t.o - 1) * 100,
    gapNext: (n.o / t.c - 1) * 100,
    dayNext: (n.c / t.c - 1) * 100,
  });
}
console.log(`样本 ${rows.length}\n`);
console.log('=== 1. 今日收盘状态 → 明日开盘跳空 ===');
for (const [nm, f] of [['今日涨跌幅', 'retT'], ['今日收盘位置', 'closePos'], ['今日日内(开→收)', 'intradayT']]) {
  const s = rows.filter((r) => isFinite(r[f]));
  console.log(`  ${nm.padEnd(16)} 与明日跳空 r = ${corr(s.map((r) => r[f]), s.map((r) => r.gapNext)).toFixed(3)}`);
}
console.log('\n  按今日涨跌幅分桶 → 明日跳空:');
for (const [nm, p] of [['跌≤-2%', (r) => r.retT <= -2], ['-2~-1%', (r) => r.retT > -2 && r.retT <= -1], ['-1~0%', (r) => r.retT > -1 && r.retT < 0], ['0~1%', (r) => r.retT >= 0 && r.retT < 1], ['1~2%', (r) => r.retT >= 1 && r.retT < 2], ['涨≥2%', (r) => r.retT >= 2]]) {
  const s = rows.filter(p);
  if (!s.length) continue;
  const g = s.map((r) => r.gapNext);
  console.log(`   ${nm.padEnd(8)} n=${String(s.length).padStart(4)}  明日跳空均值 ${pct(mean(g)).padStart(8)}  中位 ${pct(med(g)).padStart(8)}  高开占比 ${(g.filter((v) => v > 0).length / g.length * 100).toFixed(0).padStart(3)}%`);
}
const allGap = rows.map((r) => r.gapNext);
console.log(`\n  基准（全部）: 隔夜跳空均值 ${pct(mean(allGap))}  中位 ${pct(med(allGap))}  高开占比 ${(allGap.filter((v) => v > 0).length / allGap.length * 100).toFixed(1)}%  sd=${sd(allGap).toFixed(3)}%`);

// ---------- 2. 从价格数据反推休市 ----------
console.log('\n=== 2. 从价格数据反推 A 股休市（工作日的缺口）===');
const have = new Set(sh.map((b) => b.d));
const holidays = [];
{
  const first = new Date(sh[0].d + 'T00:00:00');
  const last = new Date(sh.at(-1).d + 'T00:00:00');
  let cur = null;
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const wd = d.getDay();
    const closed = wd !== 0 && wd !== 6 && !have.has(iso); // 工作日却无行情 = 休市
    if (closed) {
      if (!cur) cur = { from: iso, to: iso };
      else cur.to = iso;
    } else if (cur) { holidays.push(cur); cur = null; }
  }
  if (cur) holidays.push(cur);
}
console.log(`  检出休市区间 ${holidays.length} 段（>=3 天的长假期 ${holidays.filter((h) => (new Date(h.to) - new Date(h.from)) / 864e5 >= 2).length} 段）`);

// 归类：按起始月份命名
const nameOf = (h) => {
  const m = +h.from.slice(5, 7), d = +h.from.slice(8, 10);
  if (m === 1 && d <= 5) return '元旦';
  if (m === 2 || (m === 1 && d >= 20)) return '春节';
  if (m === 4) return '清明';
  if (m === 5) return '劳动节';
  if (m === 6) return '端午';
  if (m === 9 || (m === 10 && d <= 3)) return '中秋/国庆';
  if (m === 10) return '国庆';
  return `${m}月`;
};

console.log('\n=== 3. 长假（≥3 个自然日）前后的上证表现 ===');
const shIdx = new Map(sh.map((b, i) => [b.d, i]));
const stat = [];
for (const h of holidays) {
  if ((new Date(h.to) - new Date(h.from)) / 864e5 < 2) continue;
  const iAfter = sh.findIndex((b) => b.d > h.to);
  if (iAfter < 6 || iAfter > sh.length - 6) continue;
  const before = ((sh[iAfter - 1].c / sh[iAfter - 6].c - 1) * 100); // 节前 5 日
  const after1 = ((sh[iAfter].c / sh[iAfter - 1].c - 1) * 100);     // 节后首日
  const after5 = ((sh[iAfter + 4].c / sh[iAfter - 1].c - 1) * 100); // 节后 5 日
  stat.push({ name: nameOf(h), from: h.from, to: h.to, before, after1, after5, gap: (sh[iAfter].o / sh[iAfter - 1].c - 1) * 100 });
}
const byName = new Map();
for (const s of stat) { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(s); }
console.log('  假期        次数  节前5日均值  节前5日胜率  节后首日均值  节后首日胜率  节后5日均值  节后5日胜率');
for (const [n, list] of [...byName.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (list.length < 3) continue;
  const w = (f) => (list.filter((x) => x[f] > 0).length / list.length * 100).toFixed(0) + '%';
  console.log(`  ${n.padEnd(11)} ${String(list.length).padStart(4)}  ${pct(mean(list.map((x) => x.before))).padStart(11)}  ${w('before').padStart(11)}  ${pct(mean(list.map((x) => x.after1))).padStart(12)}  ${w('after1').padStart(12)}  ${pct(mean(list.map((x) => x.after5))).padStart(11)}  ${w('after5').padStart(11)}`);
}
console.log(`  ${'全部长假'.padEnd(11)} ${String(stat.length).padStart(4)}  ${pct(mean(stat.map((x) => x.before))).padStart(11)}  ${(stat.filter((x) => x.before > 0).length / stat.length * 100).toFixed(0).padStart(10)}%  ${pct(mean(stat.map((x) => x.after1))).padStart(12)}  ${(stat.filter((x) => x.after1 > 0).length / stat.length * 100).toFixed(0).padStart(11)}%  ${pct(mean(stat.map((x) => x.after5))).padStart(11)}  ${(stat.filter((x) => x.after5 > 0).length / stat.length * 100).toFixed(0).padStart(10)}%`);
console.log(`\n  基准（任意 5 日）: ${pct(mean(rows.map((r) => r.retT)))} / 日，胜率 ${(rows.filter((r) => r.retT > 0).length / rows.length * 100).toFixed(0)}%`);

console.log('\n=== 4. 最近 6 段长假明细 ===');
for (const s of stat.slice(-6)) {
  console.log(`  ${s.from} ~ ${s.to} ${s.name.padEnd(8)} 节前5日 ${pct(s.before).padStart(8)}  节后首日跳空 ${pct(s.gap).padStart(8)} 收 ${pct(s.after1).padStart(8)}  节后5日 ${pct(s.after5).padStart(8)}`);
}
