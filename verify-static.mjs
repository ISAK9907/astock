// 无浏览器静态验证：① 所有内联 <script> 能否被 JS 解析 ② 关键面板/数据标记是否齐全
// 本机沙箱禁止 Chrome 启动（platform_channel.cc 命名管道被拒），故用解析级校验替代 DOM 渲染校验。
import { readFileSync } from 'node:fs';

const html = readFileSync('astock-dashboard.html', 'utf8');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log(`  ✗ ${m}`); fail++; } else console.log(`  ✓ ${m}`); };

// 1. 标签配平（div 级别）
const open = (html.match(/<div\b/g) ?? []).length;
const close = (html.match(/<\/div>/g) ?? []).length;
ok(open === close, `<div> 配平 ${open}/${close}`);

// 2. 每个内联 script 块必须能被解析（不执行）
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scripts.length > 0, `内联脚本 ${scripts.length} 段`);
scripts.forEach((s, i) => {
  try { new Function(s); } catch (e) { console.log(`  ✗ 脚本 #${i} 解析失败: ${e.message}`); fail++; }
});
if (fail === 0) console.log(`  ✓ 全部内联脚本语法通过`);

// 3. 关键内容标记
const need = [
  ['window.INTRA', '5 分钟线数据'],
  ['window.CANDLES', '日K 数据'],
  ['window.DTDATA', '跌停数据'],
  ['window.PUSHLOG', '推送归档'],
  ['holbox', '休市/假期统计表'],
  ['kind hol', '休市倒计时卡片'],
  ['长假前后上证表现', '假期效应表头'],
  ['对照基准（同期任意交易日）', '无条件基准行'],
  ['data-panel="events"', '事件面板'],
  ['data-panel="signal"', '盘前信号面板'],
  ['dzTouch', '触摸交互'],
  ['manifest.webmanifest', 'PWA manifest'],
];
for (const [k, label] of need) ok(html.includes(k), `${label}（${k}）`);

// 4. 数据占位符没漏出去
for (const bad of ['undefined</', 'NaN%', '[object Object]']) ok(!html.includes(bad), `无 ${bad}`);

// 5. 假期表数值可解析
const m = html.match(/<tr class="all"><td>全部长假<\/td><td>(\d+)<\/td>([\s\S]*?)<\/tr>/);
if (m) {
  const cells = [...m[2].matchAll(/>([+-]?\d+\.\d+%)<\/span>|>(\d+%)<\/td>/g)].map((x) => x[1] ?? x[2]);
  ok(cells.length === 6, `长假汇总行 6 项数值齐全: ${cells.join(' ')}`);
} else { console.log('  ✗ 未找到长假汇总行'); fail++; }

console.log(fail === 0 ? '\nSTATIC VERIFY: PASS' : `\nSTATIC VERIFY: FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
