// 用真实数据跑一遍「量能体检 + 止跌五件事」，把每只持仓的五项状态打出来（人工核对用）。
// 跑法：node show-volume.mjs
import { readFileSync } from 'node:fs';

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
const raw = JSON.parse(readFileSync('stocks.json', 'utf8'));
const series = {};
for (const s of Object.values(raw.series)) series[s.name] = s.bars.slice(-250).map((b) => [b.d, b.c, b.v || 0]);

globalThis.window = { GATE: JSON.parse(readFileSync('stock-gate.json', 'utf8')), STOCKS: series };
globalThis.document = documentStub;
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: () => {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
new Function('window', 'document', 'localStorage', readFileSync('plan-gate.js', 'utf8'))(
  globalThis.window, documentStub, globalThis.localStorage);

const { GATE_STEPS, GATE_VOL } = globalThis.window;
const fmt = (x) => (x == null ? '—' : x >= 1e8 ? (x / 1e8).toFixed(2) + '亿' : x >= 1e4 ? (x / 1e4).toFixed(0) + '万' : Math.round(x) + '');

for (const name of Object.keys(series)) {
  const S = series[name];
  const V = GATE_VOL(S);
  const R = GATE_STEPS(name);
  console.log('\n' + '='.repeat(64));
  console.log(`${name}   收盘 ${S.at(-1)[1]}   ${S.at(-1)[0]}`);
  console.log(`  量能：5日均量 ${fmt(V.v5)}（近一年 ${V.pct}% 分位，地量线 ${fmt(V.p10)}，天量线 ${fmt(V.p90)}）`);
  console.log(`        当日量 ${fmt(V.last)} = 20日均量 ×${V.volRatio ? V.volRatio.toFixed(2) : '—'}` +
              `${V.hot ? '  【放量】' : ''}${V.isLow ? '  【地量】' : ''}${V.isHigh ? '  【天量】' : ''}`);
  console.log(`        量价：${V.combo || '—'}${V.fallingShrink ? `   ⚠ 连跌${V.downDays}日+缩量（可能跌停卖不出）` : ''}`);
  R.steps.forEach((st, i) => {
    console.log(`  ${st.ok ? '✓' : '·'} ${['①', '②', '③', '④', '⑤'][i]} ${st.key}  [${st.on}]`);
    console.log(`      ${st.value}`);
  });
  console.log(`  → ${R.n}/5  ${R.ok ? '五件事全过（可放行）' : '未全过（不放行）'}`);
}
