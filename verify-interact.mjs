// 校验交互后的 DOM：每日归零模式 + 准线 + 跨图联动
// 注意：SVG 属性顺序随「创建顺序 + setAttribute 追加顺序」变化，故一律按属性名取值，不做顺序匹配。
import { readFileSync } from 'node:fs';
const dom = readFileSync('.shot/dom-interact.html', 'utf8');
const src = JSON.parse(readFileSync('trends30.json', 'utf8'));

const svgOf = (id) => {
  const i = dom.indexOf(`id="${id}"`);
  return i < 0 ? '' : dom.slice(dom.lastIndexOf('<svg', i), dom.indexOf('</svg>', i));
};
const tags = (s, name) =>
  [...s.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>|<${name}\\b[^>]*/>`, 'g'))].map((m) => ({
    ...Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]])),
    _text: m[1] ?? '',
  }));

let fail = 0;
const chk = (ok, m) => { console.log(`${ok ? '✓' : '✗'} ${m}`); if (!ok) fail++; };

const intra = svgOf('intraSvg');
console.log('TITLE:', (dom.match(/<title>([^<]*)<\/title>/) || [])[1], '\n');

console.log('--- 模式切换（每日归零） ---');
chk(/每日归零 · 滚轮缩放/.test(intra), '左上角已标为「每日归零」模式');
chk(/<button data-intra-mode="day" class="on">/.test(dom), '「每日归零」按钮已高亮 (.on)');
const yt = tags(intra, 'text').filter((t) => t.class === 'ytick');
chk(yt.length === 6 && new Set(yt.map((t) => t.y)).size === 6, `纵轴 6 刻度、位置按新模式重算`);
console.log(`     刻度值: ${yt.map((t) => t._text).join('  ')}`);

console.log('\n--- 分时图准线 ---');
const lines = tags(intra, 'line').filter((l) => l.stroke === '#8b96a8');
const v = lines.find((l) => l.y1 === '20');
const h = lines.find((l) => l.x1 === '50' && l.x2 === '984');
chk(!!v && Number.isFinite(+v.x1), `纵向准线 x=${v?.x1}`);
chk(!!h && Number.isFinite(+h.y1), `横向准线 y=${h?.y1}`);
const texts = tags(intra, 'text');
const timeBubble = texts.find((t) => t.fill === '#dfe6f2' && t['text-anchor'] === 'middle');
const pctBubble = texts.find((t) => t.fill === '#dfe6f2' && t['text-anchor'] === 'end');
chk(/^\d\d\/\d\d \d\d:\d\d$/.test(timeBubble?._text ?? ''), `时间气泡: ${timeBubble?._text ?? '缺失'}`);
chk(/^[+-]?[\d.]+%$/.test(pctBubble?._text ?? ''), `左轴百分比气泡: ${pctBubble?._text ?? '缺失'}`);
const dots = tags(intra, 'circle').filter((c) => c.stroke === '#141821');
chk(dots.length === 3 && dots.every((c) => c.cx === dots[0].cx), `准线三色圆点对齐同一 x=${dots[0]?.cx}`);
const hiddenTicks = tags(intra, 'text').filter((t) => t.class === 'ytick' && t.style === 'display: none;');
const nearestTickDist = Math.min(...tags(intra, 'text').filter((t) => t.class === 'ytick').map((t) => Math.abs(+t.y - +h.y1)));
chk(hiddenTicks.length <= 1, `刻度遮挡逻辑正常：最近刻度距气泡 ${nearestTickDist.toFixed(1)}px，${nearestTickDist < 9 ? '已隐藏 1 个刻度' : '> 9px 阈值故不隐藏'}（符合预期）`);

// 从时间气泡反推广播出去的日期，用于判断联动是否「应当」命中
const md = (timeBubble?._text ?? '').slice(0, 5).replace('/', '-');

console.log(`\n--- 跨图联动（分时图广播 ${md} → 静态图） ---`);
for (const id of ['chZtdt', 'chAmount']) {
  const s = svgOf(id);
  const link = tags(s, 'line').find((l) => l.stroke === '#5b8def');
  const inWindow = (s.match(/>(\d\d-\d\d)</g) || []).map((x) => x.slice(1, -1)).includes(md);
  const shown = !!(link && link.x1 !== undefined);
  const ok = inWindow ? shown : !shown; // 窗口内应显示；窗口外应保持隐藏
  chk(ok, `${id}: 该日期${inWindow ? '在' : '不在'}其 7 日窗口内 → 联动竖线${shown ? '已显示 x=' + link.x1 : '保持隐藏'} ✓`);
}

console.log('\n--- 反向联动（静态图 → 分时图） ---');
const band = tags(intra, 'rect').find((r) => r.fill === '#5b8def' && r.opacity === '0.09');
const bandHidden = /<g style="display: none;"><rect fill="#5b8def" opacity="0.09">/.test(intra);
chk(!!band && bandHidden, '分时图色带层存在且当前隐藏（本次只测了单向广播）');

console.log('\n--- 缩放后高低点标注实时重算 ---');
const ext = [...intra.matchAll(/fill="#(ff7a86|43d19a)" font-size="10" text-anchor="middle">([^<]*)</g)].map((m) => m[2]);
console.log(`   标注: ${ext.join('  |  ')}`);
chk(ext.length === 2, `缩放后仍有两个标注`);
chk(!/全部 30 日/.test(intra), '视野已收窄（不再是「全部 30 日」）');
const spanTxt = intra.match(/>(\d+\.\d 日) · /);
chk(!!spanTxt, `当前视野 ${spanTxt ? spanTxt[1] : '?'}`);
chk(!ext.some((t) => t.includes('3994.54')), '最高点已不再是全窗口的 3994.54 → 按新视野重算了');
const hiLo = ext.map((t) => +t.split(' ').pop());
chk(hiLo.length === 2 && hiLo[0] > hiLo[1], `高 ${hiLo[0]} > 低 ${hiLo[1]}（数值关系正确）`);
// 精确复刻 intraday-zoom.js 的滚轮缩放数学，求出测试脚本放大后的真实视野
const [rL, rT, rW, rH] = (dom.match(/rect=([\d,]+)/)?.[1] ?? '').split(',').map(Number);
const [W, PL, PR, IW, GP, TOTAL, MINSPAN] = [1040, 50, 56, 934, src.grid, src.days.length * src.grid, 12];
const vx = ((rL + rW * 0.88 - rL) / rW) * W;
const cxW = Math.min(Math.max(vx, PL), W - PR);
let xMin = 0, xMax = TOTAL;
for (let n = 0; n < 12; n++) {
  const anchor = xMin + ((cxW - PL) / IW) * (xMax - xMin);
  const f = Math.exp(-100 * 0.0015);
  let a = anchor - (anchor - xMin) * f, b = anchor + (xMax - anchor) * f;
  if (b - a < MINSPAN) break;
  if (a < 0) { b -= a; a = 0; }
  if (b > TOTAL) { a -= b - TOTAL; b = TOTAL; }
  xMin = Math.max(0, a); xMax = b;
}
console.log(`   复刻缩放数学 → 视野 [${xMin.toFixed(1)}, ${xMax.toFixed(1)}] 档 = 第 ${(xMin / GP).toFixed(2)} ~ ${(xMax / GP).toFixed(2)} 日`);
const sh = src.series.find((s) => s.key === 'sh').points;
const win = sh.filter(([gx]) => gx >= xMin && gx <= xMax).map(([, px]) => px);
const wHi = Math.max(...win), wLo = Math.min(...win);
chk(hiLo[0] === +wHi.toFixed(2) && hiLo[1] === +wLo.toFixed(2),
  `与数据一致：视野内真实高/低 = ${wHi} / ${wLo}（标注「${hiLo[0]} / ${hiLo[1]}」）`);

console.log(fail === 0 ? '\n✓ 交互校验全部通过' : `\n✗ ${fail} 项失败`);
