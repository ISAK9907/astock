// 校验面板工具条：注入是否成功、说明能否展开、× 是否隐藏、刷新后是否记住
import { readFileSync } from 'node:fs';
const d1 = readFileSync('.shot/dom-panels1.html', 'utf8');
const d2 = readFileSync('.shot/dom-panels2.html', 'utf8');

let fail = 0;
const chk = (ok, m) => { console.log(`${ok ? '✓' : '✗'} ${m}`); if (!ok) fail++; };
const title = (d) => (d.match(/<title>([^<]*)<\/title>/) || [])[1];

const panelIds = ['intra', 'candles', 'cyb', 'dtstat', 'state', 'ztdt', 'amount', 'events'];
const styleOf = (d, id) => {
  const i = d.indexOf(`data-panel="${id}"`);
  if (i < 0) return '';
  return (d.slice(i, i + 220).match(/style="([^"]*)"/) || [])[1] || '';
};
const isHidden = (d, id) => styleOf(d, id).includes('display: none');

console.log('=== run1：注入与交互 ===');
console.log('TITLE:', title(d1), '\n');
for (const id of panelIds) {
  const i = d1.indexOf(`data-panel="${id}"`);
  const has = i >= 0;
  if (!has) { chk(false, `${id} 面板不存在`); continue; }
  // 在该面板内找 .ptools
  const seg = d1.slice(i, i + 1400);
  chk(seg.includes('class="ptools"'), `${id} 已注入工具栏`);
}
const toolCount = (d1.match(/class="ptools"/g) || []).length;
chk(toolCount === panelIds.length, `工具栏数量 ${toolCount} = 面板数 ${panelIds.length}`);

console.log('\n=== 「说明」展开 ===');
const t = title(d1) || '';
chk(/descHidden=false/.test(t), '点击后说明区已展开（hidden=false）');
const dm = t.match(/descLen=(\d+)/);
chk(dm && +dm[1] > 50, `说明正文长度 ${dm ? dm[1] : '?'} 字`);
const intraSeg = d1.slice(d1.indexOf('data-panel="intra"'));
const descHtml = (intraSeg.match(/<div class="pdesc"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
chk(/getKLineData/.test(descHtml), '说明内容含数据源细节（getKLineData）');
chk(/中证2000ETF华泰柏瑞/.test(descHtml), '说明内容含代理口径（ETF 代理）');

console.log('\n=== 「×」关闭面板 ===');
chk(/amtDisplay=none/.test(t), '成交额面板已隐藏（display:none）');
chk(/barHidden=false/.test(t), '右下角恢复栏已出现');
const bi = t.match(/barItems=(\d+)/);
chk(bi && +bi[1] === 1, `恢复栏列出 ${bi ? bi[1] : '?'} 个已隐藏面板`);
const ls = t.match(/ls=([^|]*)/);
chk(ls && /amount/.test(ls[1]), `localStorage 已记录: ${ls ? ls[1] : '?'}`);
const amtIdx = d1.indexOf('data-panel="amount"');
chk(isHidden(d1, 'amount'), `成交额面板在 DOM 中隐藏（style="${styleOf(d1, 'amount')}"）`);

console.log('\n=== run2：刷新后是否记住（同一浏览器 profile）===');
chk(isHidden(d2, 'amount'), `重新载入后成交额面板仍隐藏（style="${styleOf(d2, 'amount')}"）`);
chk(/<div class="prestore" id="prestore">/.test(d2) || !/id="prestore" hidden/.test(d2), '恢复栏在重新载入后仍可见');
const d2bar = d2.match(/<div id="prestoreList">([\s\S]{0,200})/);
chk(/amount|成交额/.test(d2bar ? d2bar[1] : '') || /↺/.test(d2bar ? d2bar[1] : ''), `恢复栏内容: ${(d2bar ? d2bar[1] : '').replace(/<[^>]*>/g, '').trim().slice(0, 40)}`);
// 未隐藏的面板不应被影响
for (const id of ['intra', 'candles', 'events']) {
  chk(!isHidden(d2, id), `${id} 未被误隐藏`);
}

console.log(fail === 0 ? '\n✓ 面板工具条校验全部通过' : `\n✗ ${fail} 项失败`);
