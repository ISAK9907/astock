// 校验「标记日 · 当日跌停家数随时间」曲线数据
import { readFileSync, existsSync } from 'node:fs';

if (!existsSync('dt-intraday.json')) {
  console.log('✗ dt-intraday.json 不存在，回填尚未完成');
  process.exit(1);
}
const J = JSON.parse(readFileSync('dt-intraday.json', 'utf8'));
const stats = JSON.parse(readFileSync('dt-stats.json', 'utf8'));
const marked = Object.entries(stats.daily).filter(([, v]) => v.sent >= (stats.tiers?.[0]?.sentLo ?? 74.7)).map(([d]) => d).sort();

let fail = 0;
const chk = (ok, m) => { console.log(`${ok ? '✓' : '✗'} ${m}`); if (!ok) fail++; };
const slotTime = (i) => {
  const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

chk(Object.keys(J.days).length >= marked.length, `曲线覆盖 ${Object.keys(J.days).length} 天 / 标记日 ${marked.length} 天`);

console.log('\n日期          统计  曲线收盘  峰值  峰值时刻  首触累计  有效/找到');
for (const d of marked) {
  const it = J.days[d];
  if (!it) { console.log(`${d}  ✗ 缺曲线`); fail++; continue; }
  const peak = Math.max(...it.curve);
  const peakAt = it.curve.indexOf(peak);
  console.log(
    `${d}  ${String(it.n).padStart(4)}  ${String(it.curve[it.curve.length - 1]).padStart(8)}  ${String(peak).padStart(4)}  ` +
      `${slotTime(peakAt).padStart(8)}  ${String(it.touch[it.touch.length - 1]).padStart(8)}  ${it.used}/${it.found}`,
  );
}

console.log('');
for (const d of marked) {
  const it = J.days[d];
  if (!it) continue;
  chk(it.curve.length === 48, `${d} curve 长度 ${it.curve.length} = 48`);
  chk(it.touch.length === 48, `${d} touch 长度 ${it.touch.length} = 48`);
  chk(it.used > 0, `${d} 有效个股 ${it.used} 只`);
  // 单调性：touch 必须单调不减
  let mono = true;
  for (let i = 1; i < it.touch.length; i++) if (it.touch[i] < it.touch[i - 1]) mono = false;
  chk(mono, `${d} touch 曲线单调不减`);
  // 收盘档应等于统计口径（允许小差异：停牌/失败/口径边界）
  const diff = Math.abs(it.curve[47] - it.n);
  chk(diff <= Math.max(8, it.n * 0.15), `${d} 收盘档 ${it.curve[47]} vs 统计 ${it.n}（差 ${diff}）`);
}

const peaks = marked.map((d) => Math.max(...J.days[d].curve));
console.log(`\n峰值分布：${Math.min(...peaks)} ~ ${Math.max(...peaks)}`);
console.log(fail === 0 ? '\n✓ 盘中曲线数据校验通过' : `\n✗ ${fail} 项失败`);
