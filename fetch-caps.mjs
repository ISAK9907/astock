// 拉取全市场当前市值表（东财 clist 分页），作为历史市值估算的锚点
import { writeFileSync } from 'node:fs';

const H = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

const all = new Map();
let page = 1;
let total = Infinity;

while (all.size < total && page <= 80) {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12` +
    `&fs=${encodeURIComponent(FS)}&fields=f12,f14,f2,f20,f21`;
  try {
    const res = await fetch(url, { headers: H });
    const j = await res.json();
    const diff = j?.data?.diff ?? [];
    total = j?.data?.total ?? 0;
    if (!diff.length) break;
    for (const d of diff) {
      if (!d.f12) continue;
      const cap = typeof d.f21 === 'number' && d.f21 > 0 ? d.f21 : d.f20;
      if (typeof cap === 'number' && cap > 0) all.set(d.f12, { code: d.f12, name: d.f14, px: d.f2, cap });
    }
  } catch (e) {
    console.log(`  page ${page} 失败: ${e.cause?.code ?? e.message}`);
  }
  if (page % 10 === 0) console.log(`  ${all.size}/${total} ...`);
  page++;
  await sleep(120);
}

const caps = [...all.values()];
const sorted = caps.map((c) => c.cap).sort((a, b) => a - b);
const q = (p) => sorted[Math.floor(p * sorted.length)];
console.log(`\n取得 ${caps.length} 只（目标 ${total}）`);
console.log(`流通市值分位(亿): p10=${(q(0.1) / 1e8).toFixed(1)} p25=${(q(0.25) / 1e8).toFixed(1)} p50=${(q(0.5) / 1e8).toFixed(1)} p75=${(q(0.75) / 1e8).toFixed(1)} p90=${(q(0.9) / 1e8).toFixed(1)}`);
console.log(`合计流通市值: ${(sorted.reduce((a, b) => a + b, 0) / 1e12).toFixed(2)} 万亿`);
writeFileSync('caps.json', JSON.stringify({ generatedAt: new Date().toISOString(), count: caps.length, caps }), 'utf8');
console.log('wrote caps.json');
