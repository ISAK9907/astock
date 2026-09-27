// 校验：撤销完整性 + 无限制缩放的数据条件
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('astock-dashboard.html', 'utf8');
const cd = JSON.parse(html.match(/window\.CANDLES = (\{.*?\});<\/script>/s)[1]);
const charts = JSON.parse(html.match(/window\.CHARTS = (\[.*?\]);<\/script>/s)[1]);

console.log('=== 撤销检查（应全为 false）===');
for (const p of ['画射线', 'ctools', 'window.MULTI', 'data-p=', '射线']) {
  console.log(`  ${p.padEnd(14)} 残留=${html.includes(p)}`);
}

console.log('\n=== 日线数据量（决定能缩放到多远）===');
for (const s of cd.series) {
  const b = s.bars;
  const bad = b.filter((r) => !(r.l <= Math.min(r.o, r.c) && r.h >= Math.max(r.o, r.c))).length;
  console.log(`  ${s.name.padEnd(8)} ${String(b.length).padStart(4)} 根  ${b[0].d} → ${b.at(-1).d}  非法OHLC=${bad}`);
}

console.log('\n=== 容器与脚本 ===');
for (const id of ['cdSh', 'cdCyb', 'cdKc50']) {
  const m = html.match(new RegExp(`<svg id="${id}"[^>]*>([\\s\\S]*?)</svg>`));
  console.log(`  ${id}: ${m && m[1].trim() === '' ? '空容器 ✓' : '✗'}`);
}
console.log(`  静态图 window.CHARTS: ${charts.map((c) => c.id).join(', ')}`);
console.log(`  分时图 window.INTRA: ${html.includes('window.INTRA') ? '✓' : '✗'}`);

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
scripts.forEach((s, i) => writeFileSync(`.cache/_z${i}.js`, s, 'utf8'));
console.log(`\n内联脚本数: ${scripts.length}`);
