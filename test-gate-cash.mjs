// 现金底线的测试：用户 2026-10-16 的大前提「留 20% 现金应对极端行情」必须能被**强制拦住**，
// 而不能只是靠"总仓位≤70%"隐含（单只/赛道各判各的，几只票分别没超限照样能把现金吃光）。
//
// 跑法：node test-gate-cash.mjs
import { readFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync('pa7k3f.json', 'utf8'));
const series = (() => { const raw = JSON.parse(readFileSync('stocks.json', 'utf8')); const o = {}; for (const s of Object.values(raw.series)) o[s.name] = s.bars.slice(-250).map((b) => [b.d, b.c]); return o; })();

const store = {}, els = {}, listeners = [];
const fakeEl = () => ({ _h: '', hidden: false, value: '', files: [], dataset: {}, textContent: '', set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null });
const documentStub = { readyState: 'complete', getElementById: (id) => (els[id] ??= fakeEl()), createElement: () => fakeEl(), addEventListener: (t, f) => listeners.push(f), dispatchEvent: (e) => listeners.forEach((f) => f(e)) };
globalThis.window = { GATE: JSON.parse(readFileSync('stock-gate.json', 'utf8')), STOCKS: series };
globalThis.document = documentStub;
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => snap });
store['astock.holdings.v1'] = JSON.stringify(snap.holdings);
store['astock.acct.v1'] = JSON.stringify(snap.account);

new Function('window', 'document', 'localStorage', readFileSync('plan-gate.js', 'utf8'))(globalThis.window, documentStub, globalThis.localStorage);
const { GATE_ADD, GATE } = globalThis.window;
const R = GATE.rules;

let fail = 0;
const t = (ok, m) => { console.log(`${ok ? '✓' : '✗'} ${m}`); if (!ok) fail++; };
const cashHit = (r) => r.blocked.some((s) => /现金底线/.test(s));

const A = snap.account.assets;
const cash = snap.account.cash;
const holdings = snap.holdings;
const acct = snap.account;

console.log('=== 1. 规则里真的有这条 ===');
t(R.minCash === 0.20, `RULES.minCash = ${R.minCash}（期望 0.2）`);
t(Math.abs(cash / A * 100 - 74.8) < 0.2, `当前现金占账户 ${(cash / A * 100).toFixed(1)}%`);

console.log('\n=== 2. 小金额：不该被现金底线拦 ===');
{
  const small = Math.round(cash - R.minCash * A) - 1000;   // 留出余量
  const r = GATE_ADD('港股互联', small, holdings, acct, []);
  t(!cashHit(r), `加 ${small.toLocaleString()} 元后不触发现金底线（其他原因：${r.blocked.filter((s) => !/现金底线/.test(s)).length} 条）`);
}

console.log('\n=== 3. 大金额：必须被现金底线拦住（反向断言）===');
{
  const big = Math.round(cash - R.minCash * A) + 5000;     // 越线 5000
  const r = GATE_ADD('港股互联', big, holdings, acct, []);
  t(cashHit(r), `加 ${big.toLocaleString()} 元后撞现金底线 → 拦下`);
  console.log('   理由：' + (r.blocked.find((s) => /现金底线/.test(s)) || '（没有）'));
}

console.log('\n=== 4. 边界：正好卡在 20% 不拦，超出 1 元要拦 ===');
{
  // ⚠️ 用 floor 而不是 round：round 会把 293907.93 进位成 293908，反而越线 0.07 元（测试自己踩的坑）
  const exact = Math.floor(cash - R.minCash * A);
  t(!cashHit(GATE_ADD('港股互联', exact, holdings, acct, [])), `正好留 ${R.minCash * 100}% 现金（${exact.toLocaleString()} 元）→ 不拦`);
  t(cashHit(GATE_ADD('港股互联', exact + 1, holdings, acct, [])), '多花 1 元 → 拦');
}

console.log('\n=== 5. 没有账户总资产时不能崩 ===');
{
  const r = GATE_ADD('港股互联', 1000, holdings, null, []);
  t(Array.isArray(r.blocked), 'acct=null 仍返回 blocked 列表（用 A-mv 兜底现金）');
}

console.log(fail ? `\n现金底线测试: FAIL (${fail})` : '\n现金底线测试: PASS');
process.exit(fail ? 1 : 0);
