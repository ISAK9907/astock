// ③-A 跳空日的「开盘后空间」——日线口径，16 年样本
//   日线拿不到最高/最低的"时刻"，但能拿到相对开盘的上下空间，足以判断
//   「开盘是不是当日的局部高点」这个更本质的问题。
import { readFileSync } from 'node:fs';
const J = JSON.parse(readFileSync('daily-long.json', 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function rows(key) {
  const bars = J.series[key].bars.filter((b) => b.d < TODAY);
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], b = bars[i];
    out.push({
      d: b.d, idx: J.series[key].name,
      gap: (b.o / p.c - 1) * 100,
      up: (b.h / b.o - 1) * 100,    // 开盘后最大上行
      dn: (b.l / b.o - 1) * 100,    // 开盘后最大下行（负）
      close: (b.c / b.o - 1) * 100,
      pc: p.c, o: b.o, h: b.h, l: b.l, c: b.c,
    });
  }
  return out;
}
const pool = Object.keys(J.series).flatMap(rows);
const sh = rows('sh');

const BUCKETS = [
  ['≤-2%', (g) => g <= -2], ['-2~-1%', (g) => g > -2 && g <= -1], ['-1~-0.5%', (g) => g > -1 && g <= -0.5],
  ['-0.5~0%', (g) => g > -0.5 && g < 0], ['0~0.5%', (g) => g >= 0 && g < 0.5], ['0.5~1%', (g) => g >= 0.5 && g < 1],
  ['1~1.5%', (g) => g >= 1 && g < 1.5], ['1.5~2%', (g) => g >= 1.5 && g < 2], ['≥2%', (g) => g >= 2],
];

console.log('=== ③-A 跳空日的「开盘后空间」（四指数池化，2010-2026，n=' + pool.length + '）===');
console.log('  区间        n     开盘后最高   开盘后最低   收盘-开盘  上/下空间比  开盘即高点*  开盘即低点**');
for (const [label, pred] of BUCKETS) {
  const s = pool.filter((r) => pred(r.gap));
  if (s.length < 10) continue;
  const up = mean(s.map((r) => r.up)), dn = mean(s.map((r) => r.dn));
  // 开盘即高点：全天没比开盘高出 0.1% 以上；开盘即低点：没比开盘低 0.1% 以上
  const hiAtOpen = s.filter((r) => r.up < 0.1).length / s.length * 100;
  const loAtOpen = s.filter((r) => r.dn > -0.1).length / s.length * 100;
  console.log(
    `  ${label.padEnd(9)} ${String(s.length).padStart(5)}  ${pct(up).padStart(9)}%  ${pct(dn).padStart(9)}%  ${pct(mean(s.map((r) => r.close))).padStart(9)}%  ` +
      `${(Math.abs(up / dn) || 0).toFixed(2).padStart(9)}  ${hiAtOpen.toFixed(1).padStart(9)}%  ${loAtOpen.toFixed(1).padStart(9)}%`,
  );
}
console.log('  * 全天从未比开盘高出 0.1% 以上    ** 全天从未比开盘低 0.1% 以上');

console.log('\n=== 关键对比：开盘后的"上下空间"落点（中位数，更抗极端值）===');
console.log('  区间        上行中位   下行中位   上行>下行占比');
for (const [label, pred] of BUCKETS) {
  const s = pool.filter((r) => pred(r.gap));
  if (s.length < 10) continue;
  console.log(
    `  ${label.padEnd(9)}  ${pct(med(s.map((r) => r.up))).padStart(8)}%  ${pct(med(s.map((r) => r.dn))).padStart(8)}%  ` +
      `${(s.filter((r) => r.up > -r.dn).length / s.length * 100).toFixed(1).padStart(9)}%`,
  );
}

console.log('\n=== 高开越大，开盘越像"当日高点"吗（上证单独，16 年）===');
for (const th of [0.5, 1, 1.5, 2]) {
  const s = sh.filter((r) => r.gap >= th);
  if (!s.length) continue;
  console.log(
    `  高开≥${th}%  n=${String(s.length).padStart(3)}  收盘<开盘 ${(s.filter((r) => r.close < 0).length / s.length * 100).toFixed(0)}%  ` +
      `从未上破开盘 ${(s.filter((r) => r.up < 0.1).length / s.length * 100).toFixed(0)}%  ` +
      `从未下破开盘 ${(s.filter((r) => r.dn > -0.1).length / s.length * 100).toFixed(0)}%  ` +
      `平均上行 ${pct(mean(s.map((r) => r.up)))}%  平均下行 ${pct(mean(s.map((r) => r.dn)))}%`,
  );
}

console.log('\n=== 隔日对比：跳空方向 vs 开盘后首先被触及的方向 ===');
console.log('  （日线无法定序，这里给出"上行/下行空间"的比值作为代理）');
for (const [nm, pred] of [['高开≥1%', (g) => g >= 1], ['高开0.5~1%', (g) => g >= 0.5 && g < 1], ['低开≤-1%', (g) => g <= -1], ['低开-0.5~-1%', (g) => g > -1 && g <= -0.5]]) {
  const s = pool.filter((r) => pred(r.gap));
  const rUp = s.filter((r) => r.up > -r.dn).length / s.length * 100;
  console.log(`  ${nm.padEnd(12)} n=${String(s.length).padStart(4)}  上行空间 > 下行空间 的比例 ${rUp.toFixed(1)}%  平均上行 ${pct(mean(s.map((r) => r.up)))}%  平均下行 ${pct(mean(s.map((r) => r.dn)))}%`);
}
