// 校验渲染后的 DOM：三大指数双图（累计 + 每日归零）+ 极值标注 + 其他图 + 事件
import { readFileSync } from 'node:fs';
const dom = readFileSync('.shot/dom.html', 'utf8');
const src = JSON.parse(readFileSync('trends-m5.json', 'utf8'));
const NDAYS = src.days.length;

function section(id) {
  const i = dom.indexOf(`id="${id}"`);
  if (i < 0) return null;
  return dom.slice(dom.lastIndexOf('<svg', i), dom.indexOf('</svg>', i));
}
let fail = 0;
const chk = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fail++; };

// ---------------- 双图 ----------------
const cum = section('intraSvgCum');
const day = section('intraSvgDay');
chk(!!cum, 'intraSvgCum 存在');
chk(!!day, 'intraSvgDay 存在');
chk(!section('intraSvg'), '旧的单图 intraSvg 已移除');
chk(!dom.includes('data-intra-mode'), '旧的模式切换按钮已移除');

for (const [name, svg, expectTitle] of [['累计图', cum, '累计涨跌幅'], ['每日归零图', day, '每日归零']]) {
  if (!svg) { chk(false, `${name} 缺失`); continue; }
  console.log(`\n--- ${name} ---`);
  const polys = [...svg.matchAll(/<polyline points="([^"]*)"/g)];
  const yticks = [...svg.matchAll(/class="ytick"/g)];
  const dayLabels = [...svg.matchAll(/<text x="[\d.]+" y="226"[^>]*>(\d\d\/\d\d)<\/text>/g)];
  chk(polys.length === 3, `折线 3 条（实际 ${polys.length}）`);
  chk(yticks.length === 6, `纵轴刻度 6 个（实际 ${yticks.length}）`);
  chk(dayLabels.length >= 8, `日期标签 ${dayLabels.length} 个`);
  for (const p of polys) {
    const n = p[1].trim().split(/\s+/).length;
    chk(n > 2000 && n <= NDAYS * src.grid, `折线点数 ${n}`);
  }
  const ends = [...svg.matchAll(/font-size="11">([+-][\d.]+)%<\/text>/g)].map((m) => m[1]);
  chk(ends.length === 3, `线尾百分比: ${ends.join('  ')}`);
  chk(svg.includes(`全部 ${NDAYS} 日`), `范围文字含「全部 ${NDAYS} 日」`);
  chk(new RegExp(expectTitle).test(svg), `标题含「${expectTitle}」`);
  const xs = dayLabels.map((m) => +m[0].match(/x="([\d.]+)"/)[1]);
  const gaps = xs.slice(1).map((v, i) => v - xs[i]);
  if (gaps.length) chk(Math.min(...gaps) >= 36, `最小标签间距 ${Math.min(...gaps).toFixed(1)}px ≥ 36`);
}

// 两图必须共享同一横向视野：同一天标签的 x 坐标应完全一致
if (cum && day) {
  const xsOf = (svg) => [...svg.matchAll(/<text x="([\d.]+)" y="226"/g)].map((m) => +m[1]).join(',');
  chk(xsOf(cum) === xsOf(day), '两张图的日期标签 x 坐标完全一致（共享横向视野）');
}

// ---------------- 极值标注（只在累计图） ----------------
console.log('\n--- 上证指数 最高 / 最低点标注 ---');
console.log('   累计图:', [...cum.matchAll(/fill="#(ff7a86|43d19a)" font-size="10" text-anchor="middle">([^<]*)</g)].map((m) => m[2]).join('  |  '));
const ext = [...cum.matchAll(/fill="#(ff7a86|43d19a)" font-size="10" text-anchor="middle">([^<]*)</g)].map((m) => ({ col: m[1], txt: m[2] }));
chk(ext.length === 2, `累计图有高/低两个标注（实际 ${ext.length}）`);
const sh = src.series.find((s) => s.key === 'sh').points.map(([, px]) => px);
chk((ext.find((e) => e.col === 'ff7a86')?.txt ?? '').endsWith(Math.max(...sh).toFixed(2)), `最高值 = ${Math.max(...sh).toFixed(2)}`);
chk((ext.find((e) => e.col === '43d19a')?.txt ?? '').endsWith(Math.min(...sh).toFixed(2)), `最低值 = ${Math.min(...sh).toFixed(2)}`);
const refLines = [...cum.matchAll(/<line x1="50" y1="([\d.]+)" x2="984" y2="[\d.]+" stroke="#(ff7a86|43d19a)"[^>]*stroke-dasharray="5 4"/g)];
chk(refLines.length === 2, `极值水平参考线 ${refLines.length} 条`);
chk(!day.includes('stroke-dasharray="5 4"'), '每日归零图不含极值参考线（各日基准不同，标注无意义）');

// ---------------- 当日档位完整性 ----------------
console.log('\n--- 当日档位完整性（防止「全A 未更新」回归）---');
for (const s of src.series) {
  const lastIdx = NDAYS - 1;
  const rows = s.points.filter(([gx]) => Math.floor(gx / src.grid) === lastIdx);
  const uniq = new Set(rows.map(([, px]) => px)).size;
  chk(rows.length === src.grid, `${s.name} 当日 ${rows.length}/${src.grid} 档`);
  chk(uniq >= 6, `${s.name} 当日有 ${uniq} 个不同价位`);
  if (s.key === 'leader') {
    // 与同花顺**日线**交叉核对（权威收盘价）。
    // 不要用 .cache 里的 5 分钟原始文件 —— 那是盘中快照，最后价并非收盘价。
    const got = rows.at(-1)?.[1];
    let raw = null;
    try {
      const r = await fetch('https://d.10jqka.com.cn/v6/line/bk_883957/01/2026.js', {
        headers: { Referer: 'https://q.10jqka.com.cn/', 'User-Agent': 'Mozilla/5.0' },
      });
      const m = (await r.text()).match(/"data":"([^"]*)"/);
      if (m) raw = +m[1].split(';').filter(Boolean).at(-1).split(',')[4];
    } catch { /* 网络不可用则跳过 */ }
    if (raw == null || !isFinite(raw)) chk(got > 0, `全A 当日收盘 ${got}（同花顺日线不可用，跳过交叉核对）`);
    else chk(Math.abs(got - raw) < 0.01, `全A 当日收盘 ${got} 与同花顺日线 ${raw} 一致`);
  }
}

// ---------------- 其他面板 ----------------
console.log('\n--- 其他图 ---');
for (const id of ['cdSh', 'cdCyb', 'cdKc50', 'chZtdt', 'chAmount']) {
  const s = section(id);
  chk(!!s && s.length > 400, `${id} 已渲染（${s ? s.length : 0} 字节）`);
}
console.log('\n--- 事件 / 中美互动 ---');
const evNames = [...dom.matchAll(/class="ev-name">([^<]*)/g)].map((m) => m[1]);
chk(evNames.length > 0, `事件卡片 ${evNames.length} 张`);
chk(dom.includes('中美经贸磋商'), '含中美经贸磋商');
chk(/class="ev-days live"/.test(dom), '「进行中」徽标已渲染');
chk(dom.includes('实时解析 federalreserve.gov'), '事件来源说明如实');

console.log(fail === 0 ? '\n✓ 渲染校验全部通过' : `\n✗ ${fail} 项失败`);
