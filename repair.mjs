// 应用 .shot/repair-pairs.txt 里的对照表，修复 .shot/recovered.mjs 的编码损坏
import { readFileSync, writeFileSync } from 'node:fs';

const dec = (s) => s.replace(/\\uFFFD/g, '\uFFFD').replace(/\\n/g, '\n');
const raw = ['.shot/repair-pairs.txt', '.shot/repair-pairs2.txt', '.shot/repair-pairs3.txt']
  .flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/))
  .map((l) => l.replace(/^\uFEFF/, '')) // 某些编辑器写文件会带 BOM
  .filter((l) => l && !l.startsWith('#'));
const pairs = raw.map((l) => {
  const i = l.indexOf('\t');
  if (i < 0) throw new Error(`缺少制表符: ${l.slice(0, 60)}`);
  return [dec(l.slice(0, i)), dec(l.slice(i + 1))];
});

// 基底 .shot/recovered.mjs 由 PowerShell 用 .NET 的 GBK 解码器反向还原生成
// （Node 自带的 gbk 解码器行为与 .NET 不同，会多出近百个错误字符）
let t = readFileSync('.shot/recovered.mjs', 'utf8');
let bad = 0;
pairs.forEach(([a, b], k) => {
  const n = t.split(a).length - 1;
  if (n < 1) { console.log(`✗ #${k + 1} 未命中: ${JSON.stringify(a.slice(0, 60))}`); bad++; return; }
  t = t.split(a).join(b);
});
// 收尾：个别点位用「汉字+分隔符」重组后仍残留，直接按已知语义定点替换
t = t.split('5 \uFFFD?${pct(HOLSTAT.base5').join('5 日 ${pct(HOLSTAT.base5');

// 第三轮：与损坏前 reference.html 逐词对照后，修正当初凭上下文猜错的地方
const fixes = [
  ['>等待竞价数据</span>', '>等待竞价…</span>'],
  ['下方是条件清单：</div>', '下方是条件清单。</div>'],
  ['收盘买回」的收益，<b>持有/偏持有</b>', '收盘买回」的收益；<b>持有/偏持有</b>'],
  ['键盘 ← → 也可以</span>', '键盘 ← → 也可翻</span>'],
  ['<h2>双创 <span class="hint">创业板指 + 科创50 · 日线', '<h2>双创 <span class="hint">创业板 + 科创板 · 日线'],
  ['事件排在一起</b>', '事件排反</b>'],
  ['家数 39 但市值占比', '家数仅 39 但市值占比'],
  ['小盘 190 只', '小盘 90 只'],
  ['纯家数阈值（60）会完全漏掉</b>', '纯家数阈值（≥60）会完全漏掉的</b>'],
  ['不足以作为交易依据</b>', '不足以作为交易依据。</b>'],
  ['（说明「跌停日」是三种不同事件）', '（说明"跌停潮"是三种不同事件）'],
  ['个交易日 · ${tr.days.length} 日用 5 分钟档', '个交易日 · 近 ${tr.days.length} 日用 5 分钟档'],
  ['（当日首点为基准）。两图缩放与拖动联动', '（当日首点为基准）· 两图缩放与拖动联动'],
];
for (const [a, b] of fixes) t = t.split(a).join(b);

writeFileSync('.shot/recovered.mjs', t, 'utf8');
console.log(`\n应用 ${pairs.length - bad}/${pairs.length}，未命中 ${bad}`);
console.log(`剩余损坏点: ${(t.match(/\uFFFD/g) ?? []).length}`);
