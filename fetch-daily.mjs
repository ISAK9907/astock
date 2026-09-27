// 日线采集：中证官方优先，腾讯兜底，带缓存与降级
import { writeFileSync } from 'node:fs';
import { loadWithFallback, csindex, tencent, sleep } from './sources.mjs';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const now = new Date();
const start = ymd(new Date(now.getTime() - 90 * 86400000)); // 90 自然日 ≈ 60 交易日
const end = ymd(now);

// tencentCode: 腾讯侧的代码；中证独有指数在腾讯取不到，故为 null
const INDICES = [
  { key: 'sh', name: '上证指数', csi: '000001', tencent: 'sh000001' },
  { key: 'csi2000', name: '中证2000', csi: '932000', tencent: null },
  { key: 'sc50', name: '双创50', csi: '931643', tencent: null },
  { key: 'allA', name: '中证全指', csi: '000985', tencent: 'sh000985' },
  { key: 'kc50', name: '科创50', csi: '000688', tencent: 'sh000688' },
  { key: 'cyb', name: '创业板指', csi: null, tencent: 'sz399006' },
];

const TTL = 6 * 3600 * 1000; // 日线 6 小时内直接用缓存
const out = { generatedAt: new Date().toISOString(), window: [start, end], series: [] };

console.log(`区间 ${start} → ${end}\n`);

for (const idx of INDICES) {
  const providers = [];
  if (idx.csi) providers.push({ label: 'csindex(官方)', run: () => csindex.daily(idx.csi, start, end) });
  if (idx.tencent) providers.push({ label: 'tencent', run: () => tencent.daily(idx.tencent, start, end, 60) });

  try {
    const r = await loadWithFallback(`daily-${idx.key}`, providers, { ttlMs: TTL });
    const rows = r.value;
    const f = rows[0], l = rows.at(-1);
    const pct = ((l.c / f.c - 1) * 100).toFixed(1);
    console.log(
      `  ${idx.name.padEnd(9)} ${rows.length}根 ${f.d}→${l.d}  ${f.c}→${l.c} (${pct}%)` +
        `${r.cached ? '  [缓存]' : ''}${r.stale ? ' [过期缓存]' : ''}`,
    );
    out.series.push({ key: idx.key, name: idx.name, code: idx.csi ?? idx.tencent, source: r.source, stale: r.stale, rows });
  } catch (e) {
    console.log(`  ${idx.name.padEnd(9)} 失败: ${e.message}`);
  }
  await sleep(600);
}

writeFileSync('daily.json', JSON.stringify(out), 'utf8');
console.log('\nwrote daily.json  series=', out.series.map((s) => `${s.key}(${s.source})`).join(', '));
