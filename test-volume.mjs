// 量价 + 止跌五件事的测试（视频《不破不立》，用户 2026-10-17 确认的口径）：
//   · 地量 = 5日均量 ≤ 近一年 10% 分位；天量 ≥ 90% 分位
//   · 放量 = 当日量 ≥ 近20日均量 × 1.5
//   · 跌破前低按收盘价算
//   · 「止跌五件事」= ①绿柱变短 ②缩到地量 ③底背离(跌破前低时才必需) ④金叉 ⑤放量站回前高
//   · 没有成交量数据时，② 必须判"没达成"（不能把 0 值误判成地量）
//
// 跑法：node test-volume.mjs
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ✓ ${m}`); else { console.log(`  ✗ ${m}`); fail++; } };

// ---------- 造数据 ----------
const DAY = 86400000;
const dayStr = (i) => new Date(Date.UTC(2025, 0, 1) + i * DAY).toISOString().slice(0, 10);
/** bars: [{c, v}] → [[日期, 收盘, 量]] */
const mk = (bars) => bars.map((b, i) => [dayStr(i), b.c, b.v ?? 0]);

// 场景 A：末尾 5 日均量缩到近一年最低（地量）
function shrinkVol(n = 250) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = 10 + Math.sin(i / 12) * 0.5;                 // 价格来回晃，避免趋势干扰
    const v = i < n - 6 ? 1000 + ((i * 37) % 200) : 120;    // 最后几步量塌到 120
    out.push({ c: +c.toFixed(3), v });
  }
  return out;
}
// 场景 B：完全没有量数据（老 stocks.json 格式）
function noVol(n = 250) {
  return Array.from({ length: n }, (_, i) => ({ c: +(10 + Math.sin(i / 12) * 0.5).toFixed(3), v: 0 }));
}
// 场景 C：连跌 4 天且量逐日缩小（跌停卖不出）
function fallingShrink(n = 250) {
  const b = Array.from({ length: n }, (_, i) => ({ c: +(10 + Math.sin(i / 15) * 0.3).toFixed(3), v: 1000 }));
  for (let k = 0; k < 4; k++) {                    // 最后 4 根：跌 + 量缩
    const i = n - 4 + k;
    b[i] = { c: +(b[i - 1].c * 0.96).toFixed(3), v: b[i - 1].v * 0.7 };
  }
  return b;
}
// 场景 D：价涨量增（近5日）
function upWithVol(n = 250) {
  const b = Array.from({ length: n }, (_, i) => ({ c: 10, v: 1000 }));
  for (let k = 1; k <= 12; k++) {                   // 最后 12 根：稳步涨 + 量放大
    const i = n - 12 + k;
    b[i] = { c: +(b[i - 1].c * 1.012).toFixed(3), v: 1000 + k * 220 };
  }
  return b;
}
// 场景 E：先做出一个前高，再跌下去，最后放量站回它
function breakout(n = 250, crossVol) {
  const b = [];
  for (let i = 0; i < n; i++) b.push({ c: 10, v: 1000 });
  const top = n - 60;                                // 前高在这一根
  for (let i = top - 10; i <= top; i++) b[i] = { c: +(10 + (i - (top - 10)) * 0.1).toFixed(3), v: 1000 }; // 涨到 11
  for (let i = top + 1; i <= top + 20; i++) b[i] = { c: +(11 - (i - top) * 0.1).toFixed(3), v: 1000 };     // 跌回 9
  for (let i = top + 21; i < n - 3; i++) b[i] = { c: 9.6, v: 1000 };                                        // 横着
  // 最后一根才是"站回"的那天（前一根还在前高下方），它的量 = crossVol
  b[n - 2] = { c: 10.6, v: 900 };
  b[n - 1] = { c: 11.2, v: crossVol };
  return b;
}

const STOCKS = {
  地量: mk(shrinkVol()),
  无量: mk(noVol()),
  跌停缩量: mk(fallingShrink()),
  价涨量增: mk(upWithVol()),
  放量站回: mk(breakout(250, 2200)),      // 站回那天量 2200 = 2.2 倍
  没放量站回: mk(breakout(250, 700)),     // 站回那天量 700 = 0.7 倍
};

// ---------- DOM / 环境桩（与 test-gate-cash.mjs 同一套） ----------
const store = {}, els = {}, listeners = [];
const fakeEl = () => ({
  _h: '', hidden: false, value: '', files: [], dataset: {}, textContent: '',
  set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
  addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
});
const documentStub = {
  readyState: 'complete',
  getElementById: (id) => (els[id] ??= fakeEl()),
  createElement: () => fakeEl(),
  addEventListener: (t, f) => listeners.push(f),
  dispatchEvent: (e) => listeners.forEach((f) => f(e)),
  querySelectorAll: () => [],
};
globalThis.window = { GATE: JSON.parse(readFileSync('stock-gate.json', 'utf8')), STOCKS };
globalThis.document = documentStub;
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

new Function('window', 'document', 'localStorage',
  readFileSync('plan-gate.js', 'utf8'))(globalThis.window, documentStub, globalThis.localStorage);

const { GATE_STEPS, GATE_VOL } = globalThis.window;
ok(typeof GATE_STEPS === 'function', '五件事接口导出（window.GATE_STEPS）');
ok(typeof GATE_VOL === 'function', '量能体检接口导出（window.GATE_VOL）');

// ---------- 断言 ----------
console.log('\n(1) 地量判定（5日均量 ≤ 近一年10%分位）');
const A = GATE_VOL(STOCKS.地量);
console.log('    5日均量', Math.round(A.v5), '| 分位', A.pct + '%', '| 地量线', Math.round(A.p10));
ok(A.hasData, '有力数据');
ok(A.isLow === true, '末尾缩量 → 判为地量');
const A5 = GATE_STEPS('地量');
ok(A5.steps.length === 5, '止跌信号共 5 项（原来是 4 项）');
ok(A5.steps[1].ok === true, '② 缩到地量：达成');

console.log('\n(2) 没有成交量数据时**不能**误判成地量');
const B = GATE_VOL(STOCKS.无量);
const B5 = GATE_STEPS('无量');
console.log('    hasData:', B.hasData, '| ② ok:', B5.steps[1].ok, '|', B5.steps[1].value);
ok(B.hasData === false, '识别出没有量数据');
ok(B5.steps[1].ok === false, '② 判为未达成（不是 0≤0 的假达成）');
ok(/重跑|fetch-stocks/.test(B5.steps[1].value), '文案提示重抓成交量');

console.log('\n(3) 急跌缩量 = 可能跌停卖不出');
const C = GATE_VOL(STOCKS.跌停缩量);
console.log('    连跌', C.downDays, '日 | fallingShrink', C.fallingShrink);
ok(C.fallingShrink === true, '连跌≥3日且量缩 → 标记出来');

console.log('\n(4) 量价四组合');
const D = GATE_VOL(STOCKS.价涨量增);
console.log('    组合:', D.combo);
ok(D.combo === '价涨量增', '价涨 + 量增 → 价涨量增');

console.log('\n(5) ⑤ 放量站回前高：放量才算数');
const E = GATE_STEPS('放量站回');
const E5 = E.steps[4];
console.log('    放量版:', E5.ok, '|', E5.value);
ok(E5.ok === true, '站回那天量 2.2 倍 → 通过');
const N = GATE_STEPS('没放量站回');
const N5 = N.steps[4];
console.log('    没放量版:', N5.ok, '|', N5.value);
ok(N5.ok === false, '站回那天量 0.7 倍 → 不通过（差在"放量"）');
ok(E.ok === false, '只过第⑤项、其余未过 → 整体仍不放行（⑤是必要条件不是充分条件）');
ok(N.ok === false, '没放量版：整体不放行');

console.log('\n(6) 真实数据体检（stocks.json：末根是否都有量）');
const raw = JSON.parse(readFileSync('stocks.json', 'utf8'));
let all = true;
for (const s of Object.values(raw.series)) {
  const last = s.bars.at(-1);
  const hasV = Number(last.v) > 0;
  all = all && hasV;
  console.log(`    ${s.name}: ${last.d} 收 ${last.c} 量 ${last.v} ${hasV ? '✓' : '✗'}`);
}
ok(all, '五只都有成交量');

console.log(fail === 0 ? '\n量价 / 止跌五件事测试: PASS' : `\n量价 / 止跌五件事测试: FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
