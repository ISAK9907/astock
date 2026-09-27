import { readFileSync, existsSync } from 'node:fs';
const R = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);

const md = R('market-data.json', []);
const dt = R('dt-counts.json', {}).counts ?? {};
const stats = R('dt-stats.json', {});
const senti = R('sentiment.json', {});
const tr = R('trends.json', {});
const cd = R('candles.json', { series: [] });

const today = md.at(-1)?.date;
const prev = md.at(-2);
console.log(`数据日期: ${today}   (前一日 ${prev?.date})\n`);

console.log('=== 大盘 ===');
console.log(`  上证指数   ${md.at(-1).shClose}   ${(((md.at(-1).shClose / prev.shClose) - 1) * 100).toFixed(2)}%`);
console.log(`  两市成交   ${(md.at(-1).amountYi / 10000).toFixed(2)} 万亿   ${((md.at(-1).amountYi - prev.amountYi) >= 0 ? '+' : '') + (md.at(-1).amountYi - prev.amountYi).toFixed(0)} 亿`);

console.log('\n=== 情绪（涨跌停）===');
for (const r of md) {
  const flag = r.date === today ? ' ← 今日' : '';
  console.log(`  ${r.date}  涨停 ${String(r.zt).padStart(3)}  跌停 ${String(r.dt).padStart(2)}  成交 ${(r.amountYi / 10000).toFixed(2)}万亿${flag}`);
}

console.log('\n=== 跌停三维（今日）===');
const d = dt[today];
if (d) {
  console.log(`  跌停家数      ${d.dt}`);
  console.log(`  跌停市值占比  ${((d.dtCap / d.allCap) * 100).toFixed(3)}%`);
  console.log(`  大/中/小盘    ${d.big} / ${d.mid} / ${d.small}`);
  console.log(`  权重股跌停    ${d.mem} 只`);
  console.log(`  全市场样本    ${d.n} 只   合计流通市值 ${(d.allCap / 1e12).toFixed(2)} 万亿`);
} else console.log('  （无记录）');

console.log('\n=== 恐慌情绪 ===');
const s = senti.daily?.[today];
const st = stats.daily?.[today];
console.log(`  情绪分        ${s?.sent ?? '—'} / 100`);
console.log(`  综合严重度分  ${s?.score ?? '—'}`);
console.log(`  恐慌类型      ${st?.type ?? '（家数不足10，不判定）'}`);
console.log(`  对照：300日基准 P(次日涨) = ${senti.base1 ?? '—'}%`);

console.log('\n=== 五日分时（今日收盘相对各自当日开盘）===');
for (const ser of tr.series ?? []) {
  const pts = ser.points.filter((p) => p.d === today.replace(/-/g, ''));
  if (!pts.length) { console.log(`  ${ser.name.padEnd(18)} （无今日数据）`); continue; }
  const first = pts[0].px, last = pts[pts.length - 1].px;
  console.log(`  ${ser.name.padEnd(18)} ${first} → ${last}   ${(((last / first) - 1) * 100).toFixed(2)}%   (${pts.length} 点)`);
}

console.log('\n=== 指数日线（近 5 根）===');
for (const ser of cd.series ?? []) {
  const b = ser.bars.slice(-5);
  console.log(`  ${ser.name}`);
  for (const r of b) {
    const c = r.c >= r.o ? '红' : '绿';
    console.log(`    ${r.d}  开${r.o} 高${r.h} 低${r.l} 收${r.c} ${c}  ${(((r.c / r.o) - 1) * 100).toFixed(2)}%`);
  }
}
