// 采集较长区间的日线（供无限制缩放：缩小要能看到更早历史，放大要能到单根）
import { writeFileSync } from 'node:fs';
import { loadWithFallback, tencent, sleep } from './sources.mjs';

const TTL = 6 * 3600 * 1000;
// 1000 根 → 2022-08 起，把回填出来的 37 个标记日**全部**圈进蜡烛图范围
// （500 根只到 2024-09-03，2024 上半年的 12 个标记日曲线存了却点不到）
const COUNT = 1000;
const INDICES = [
  { key: 'sh', name: '上证指数', code: 'sh000001' },
  { key: 'cyb', name: '创业板指', code: 'sz399006' },
  { key: 'kc50', name: '科创50', code: 'sh000688' },
];

const out = { generatedAt: new Date().toISOString(), source: 'tencent', period: 'day', series: [] };

for (const idx of INDICES) {
  const r = await loadWithFallback(
    // ⚠️ 缓存键必须带上 COUNT：否则改了根数也会命中旧缓存，静默拿回 500 根
    `candles-${idx.key}-day-${COUNT}`,
    [{ label: 'tencent', run: () => tencent.kline(idx.code, 'day', COUNT) }],
    { ttlMs: TTL, verbose: false },
  );
  const rows = r.value;
  const f = rows[0], l = rows.at(-1);
  console.log(
    `${idx.name.padEnd(8)} ${String(rows.length).padStart(4)} 根  ${f.d} → ${l.d}  ` +
      `${f.c} → ${l.c}  ${r.cached ? '[缓存]' : ''}`,
  );
  out.series.push({ key: idx.key, name: idx.name, code: idx.code, bars: rows });
  await sleep(700);
}

writeFileSync('candles.json', JSON.stringify(out), 'utf8');
console.log('\nwrote candles.json');
