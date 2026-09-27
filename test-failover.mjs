// 验证取数层的两个核心机制：多源降级、全挂回退过期缓存
import { loadWithFallback, tencent, eastmoney } from './sources.mjs';

console.log('--- 场景1：主源故障，应自动降级到备用源 ---');
const r1 = await loadWithFallback(
  'test-failover',
  [
    { label: '模拟故障主源', run: async () => { throw new Error('connection reset'); } },
    { label: 'tencent', run: () => tencent.daily('sh000001', null, null, 5) },
  ],
  { ttlMs: 0 },
);
console.log(`  → 采用源=${r1.source}  点数=${r1.value.length}  末值=${r1.value.at(-1).c}\n`);

console.log('--- 场景2：全部源故障，应回退过期缓存（而非抛错）---');
const r2 = await loadWithFallback(
  'test-failover',
  [
    { label: '坏源A', run: async () => { throw new Error('503'); } },
    { label: '坏源B', run: async () => { throw new Error('timeout'); } },
  ],
  { ttlMs: 0 },
);
console.log(`  → 采用源=${r2.source}  stale=${r2.stale}  点数=${r2.value.length}  缓存年龄=${Math.round(r2.ageMs / 1000)}s\n`);

console.log('--- 场景3：无缓存且全失败，应明确抛错 ---');
try {
  await loadWithFallback('test-no-cache-xyz', [{ label: '坏源', run: async () => { throw new Error('boom'); } }], { ttlMs: 0 });
  console.log('  → 意外成功（不符合预期）');
} catch (e) {
  console.log(`  → 正确抛错: ${e.message}\n`);
}

console.log('--- 场景4：东财限流时，涨停数据能否降级 ---');
try {
  const r4 = await loadWithFallback(
    'test-zt',
    [{ label: 'eastmoney', run: () => eastmoney.ztCount('20260917') }],
    { ttlMs: 0 },
  );
  console.log(`  → 涨停家数=${r4.value} (源=${r4.source})`);
} catch (e) {
  console.log(`  → 东财不可用且无缓存: ${e.message}`);
  console.log('    （这暴露了一个真实缺口：涨停/跌停家数目前只有东财一个来源）');
}
