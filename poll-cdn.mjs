// 轮询直到线上文件的 sha256 与本地完全一致
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const local = readFileSync('astock-dashboard.html');
const lh = createHash('sha256').update(local).digest('hex');
console.log(`本地 sha256=${lh.slice(0, 16)}  ${(local.length / 1024).toFixed(1)} KB`);
for (let i = 1; i <= 30; i++) {
  const r = await fetch(`https://ISAK9907.github.io/astock/?cb=${Math.random().toString(36).slice(2)}`, {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  const live = Buffer.from(await r.arrayBuffer());
  const rh = createHash('sha256').update(live).digest('hex');
  console.log(`try ${i}: ${(live.length / 1024).toFixed(1)} KB  sha=${rh.slice(0, 16)}  ${rh === lh ? 'MATCH ✓' : ''}`);
  if (rh === lh) { console.log('CDN 已同步 ✓'); process.exit(0); }
  await new Promise((s) => setTimeout(s, 20000));
}
console.log('TIMEOUT：CDN 仍未同步到本地版本');
process.exit(1);
