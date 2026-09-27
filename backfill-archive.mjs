// 从 daily-update.log / premarket.log 回填历史推送归档
import { readFileSync, existsSync } from 'node:fs';
import { appendPush, readArchive } from './push-archive.mjs';

function parseLog(file, kind) {
  if (!existsSync(file)) return 0;
  const txt = readFileSync(file, 'utf8');
  // 形如：  --- 推送内容 ---\n<title>\n<body>\n---------------
  const re = /--- 推送内容 ---\r?\n([\s\S]*?)\r?\n---------------/g;
  let m, n = 0;
  while ((m = re.exec(txt))) {
    const block = m[1].trim();
    const lines = block.split(/\r?\n/);
    const title = (lines.shift() || '').trim();
    const body = lines.join('\n').trim();
    const d = title.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!d || !body) continue;
    appendPush(kind, title, body, d[1]);
    n++;
  }
  return n;
}

const a = parseLog('daily-update.log', 'close');
const b = parseLog('premarket.log', 'premarket');
const list = readArchive();
const dates = [...new Set(list.map((e) => e.date))].sort();
console.log(`回填：收盘 ${a} 条、盘前 ${b} 条 → 归档共 ${list.length} 条 / ${dates.length} 天`);
console.log(`区间 ${dates[0] ?? '—'} → ${dates.at(-1) ?? '—'}`);
console.log('最近 6 天:');
for (const d of dates.slice(-6)) {
  const r = list.filter((e) => e.date === d).map((e) => (e.kind === 'premarket' ? '盘前' : '收盘'));
  console.log(`  ${d}  ${r.join(' + ')}`);
}
