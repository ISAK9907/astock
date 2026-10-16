// 集中度纪律的**口径测试**：分母必须是账户总资产，不是持仓市值。
//
// 为什么单独锁这一条（用户 2026-10-16 反馈）：
//   按持仓市值算，同一只票的占比会被放大 —— 华特气体占持仓 40.8%，占账户只有 18.9%，
//   用市值口径会把一只没超限的票报成超限，进而推出「只许减」的错误结论。
//   这个错误 2026-10-13 已经犯过一次（用户报「必须逐条回答的东西算错」），所以两条口径都要有测试：
//   ① 给了账户总资产 → 按账户算；② 没给 → 明确标记 marketValue（页面会打出警告），不许悄悄按市值下判断。
//
// 跑法：node test-concentration-account.mjs
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.window = {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = {
  readyState: 'complete',
  getElementById: () => ({ innerHTML: '', addEventListener() {}, querySelectorAll: () => [], hidden: false, value: '' }),
  addEventListener() {},
  querySelectorAll: () => [],
};
globalThis.URL.createObjectURL = () => 'blob:x';
new Function(readFileSync('plan-holdings.js', 'utf8'))();
const { checkConcentration } = globalThis.window.HOLDINGS;

let fail = 0;
const t = (ok, m) => { console.log(`${ok ? '✓' : '✗'} ${m}`); if (!ok) fail++; };

// 真实持仓：比亚迪 82,720 / 总资产 536,794.79 = 15.4%
const snap = JSON.parse(readFileSync('pa7k3f.json', 'utf8'));
const LIMITS = { maxSingle: 20, maxSector: 40, maxSingleByName: { 比亚迪: 50 } };

console.log('=== 1. 分母：账户总资产 vs 持仓市值（真实持仓）===');
{
  const rows = snap.holdings;
  const A = snap.account.assets;
  const byAcct = checkConcentration(rows, LIMITS, A);
  const byMv = checkConcentration(rows, LIMITS);
  t(byAcct.basis === 'account', `传了账户总资产 → basis=account（实际 ${byAcct.basis}）`);
  t(byMv.basis === 'marketValue', `没传 → basis=marketValue，页面据此打警告（实际 ${byMv.basis}）`);
  t(byAcct.basisValue === A, `分母 = 账户总资产 ${A}（实际 ${byAcct.basisValue}）`);
  t(byAcct.value === snap.account.marketValue, `持仓市值仍单独返回（${byAcct.value}）`);

  const d = rows.find((r) => r.name === '比亚迪');
  const shareAcct = +(d.value / A * 100).toFixed(1);
  t(shareAcct === 15.4, `比亚迪占账户 ${shareAcct}%（期望 15.4）`);
  t(byAcct.violations.length === 0, `按账户算：无超限（实际 ${byAcct.violations.length} 项）`);
}

console.log('\n=== 2. 反向断言：真超限时必须报警（防止把判定改死）===');
{
  // ⚠️ 构造对照数据时，别让"陪跑"的那几只自己超限 —— 否则测的是它们，不是被测项。
  const mk = (x) => [{ name: 'X', sector: 's1', value: x, qty: 1, cost: 1 },
    ...[1, 2, 3, 4].map((i) => ({ name: 'P' + i, sector: 'p' + i, value: (100 - x) / 4, qty: 1, cost: 1 }))];
  const c = checkConcentration(mk(20.5), LIMITS, 100);
  const x = c.violations.find((v) => v.name === 'X');
  t(!!x && x.share === 20.5 && x.limit === 20, `20.5% > 20% 报警（实际 ${x ? x.share + '%' : '没报'}）`);
  const edge = checkConcentration(mk(20), LIMITS, 100);
  t(edge.violations.length === 0, `恰好 20% 不判超限（严格大于，实际 ${edge.violations.length} 项）`);
}

console.log('\n=== 3. 单只上限按名字区分（比亚迪 50% / 其余 20%）===');
{
  const mk = (first, share) => [{ name: first, sector: 'a', value: share, qty: 1, cost: 1 },
    ...[1, 2, 3, 4].map((i) => ({ name: 'P' + i, sector: 'p' + i, value: (100 - share) / 4, qty: 1, cost: 1 }))];
  // 注意：这里只断言「单一标的」这一项。45% 本身会踩到赛道 40% 的上限（单独一个赛道就是它自己），
  // 那是另一条规则，不属于本条要测的东西。
  t(!checkConcentration(mk('比亚迪', 45), LIMITS, 100).violations.some((v) => v.kind === 'single'), '比亚迪 45% 未超单只 50%');
  t(checkConcentration(mk('比亚迪', 55), LIMITS, 100).violations.some((v) => v.kind === 'single' && v.name === '比亚迪'), '比亚迪 55% 超 50% → 报警');
  const other = checkConcentration(mk('其他', 25), LIMITS, 100);
  t(other.violations.some((v) => v.kind === 'single' && v.name === '其他' && v.limit === 20), '非比亚迪 25% 超默认 20% → 报警');
}

console.log('\n=== 4. 没给账户时必须能看出来「口径降级了」===');
{
  const c = checkConcentration(snap.holdings, LIMITS);
  t(c.basis === 'marketValue' && c.basisValue === c.value, '降级时 basisValue 就是持仓市值（而不是编一个数）');
}

console.log(fail ? `\n集中度口径测试: FAIL (${fail})` : '\n集中度口径测试: PASS');
process.exit(fail ? 1 : 0);
