// 个股闸门：企稳判定 + 硬约束参数 → stock-gate.json
//
// 用户 2026-10-13 定的规则（原话）：
//   「比亚迪可以调用账户一半的资金，其余的最多20%/止损20%，除非企稳迹象明确/要拉开时间和空间/减仓可能也要多方面分析」
//   「留30%现金 / B（止损只对新买入）/ 他们应该是有机结合互相影响而不是两个必要条件 / 分4档」
//   「C」（分配方式：谁先满足条件谁拿，先到先得）
//
// ==================== 为什么「企稳」要写成可核对的条件 ====================
// 我在这 5 只上验过 MA60 分档：华特气体是**均值回归**（深跌后 60 日中位 +5.0%、胜率 72%），
// 融捷股份是**动量**（深跌后 −8.4%、胜率 23%；反而"远高于均线"时 +15.3%），中矿资源单调递增。
// 同一套均线规则给出三种相反答案 ——**均线不能当预测**。
//
// 所以这里的企稳条件**不预测涨跌**，它只做一件事：**阻止在自由落体里补仓**。
// 这是风险管理，不是预测。因此它必须机器可判、且判定结果能事后复核（所以把每个子条件的
// 实测值都写进输出，而不是只给一个等级）。
//
// ==================== 「有机结合」怎么落地 ====================
// 企稳强度与「时间/空间」要求**互相换算**，不是两个独立的必要条件：
//   企稳强 → 可以用「短时间 + 小价差」换；企稳弱 → 必须用「长时间 + 大价差」补。
// 但**仓位硬约束不参与交换**（总仓位/单只/赛道/档数），任何企稳等级都不放行。
import { readFileSync, writeFileSync } from 'node:fs';

const RULES = {
  maxTotalPos: 0.70,   // 总仓位上限（留 30% 现金）
  // 用户 2026-10-16 的**大前提**：「我得留 20% 的现金应对极端行情」。
  // 这条必须单独存在，不能只靠 maxTotalPos 隐含 —— 因为单只/赛道上限是**各自**判的，
  // 几只票分别"没超限"加起来仍可能把现金吃光。这里是最后一道账户级闸门：任何加仓之后
  // 现金占账户不得低于 minCash。注：当前 maxTotalPos=0.70 更严（现金 ≥30%），
  // 所以它是兜底；哪天放宽总仓位，这条就会立刻变成真正的约束。
  minCash: 0.20,
  maxSingle: { 比亚迪: 0.50, default: 0.20 }, // 占**账户总资产**
  // ⚠️ 单位是「占账户总资产」，不是我早先用的「占持仓市值」——
  //    后者把华特气体（占持仓 40.0%）误判成超限，而它占账户只有 18.9%。
  maxSector: 0.40,
  tranches: 4,         // **账户级** 4 档，先到先得（不是每只 4 档）
  stopLoss: 0.20,      // 只对「新买入」逐笔生效；已有持仓不追溯
  autoStopJustification: {
    为什么逐笔: '已有 4 只已经 -22%~-29%，按 20% 追溯止损等于在最大跌幅处清仓。逐笔记账后，每笔新加仓独立止损，不会和旧仓混在一起算不清。',
    已有持仓: '不追溯，不受 20% 约束',
  },
  stability: {
    强: { minNoLow: 8, aboveMA20: true, ma20Rising: true, days: 8, gap: 5 },
    中: { minNoLow: 5, aboveMA20: true, ma20Rising: false, days: 20, gap: 10 },
    弱: { minNoLow: 5, aboveMA20: false, ma20Rising: false, days: 40, gap: 20 },
    无: null, // 只许减，不许加
  },
};

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function stability(bars) {
  const c = bars.map((b) => b.c);
  const n = c.length;
  if (n < 30) return { level: '数据不足', note: '只有 ' + n + ' 根日线' };
  // ① 连续不创 20 日新低的天数（从最后一天往前数）
  let streak = 0;
  for (let i = n - 1; i >= 20; i--) {
    let prevMin = Infinity;
    for (let k = i - 20; k < i; k++) if (c[k] < prevMin) prevMin = c[k];
    if (c[i] > prevMin) streak++; else break;
  }
  // ② 是否站上 MA20
  const ma20 = avg(c.slice(-20));
  const above = c[n - 1] > ma20;
  // ③ MA20 近 5 日是否上行
  const ma20Prev = avg(c.slice(-25, -5));
  const rising = ma20 >= ma20Prev;
  // ④ 距 60 日高点的回撤（背景信息，不参与等级判定）
  const hi60 = Math.max(...c.slice(-60));
  const dd = ((c[n - 1] / hi60 - 1) * 100).toFixed(1);

  let level = '无';
  for (const name of ['强', '中', '弱']) {
    const r = RULES.stability[name];
    if (streak >= r.minNoLow && above === r.aboveMA20 && (!r.ma20Rising || rising)) { level = name; break; }
  }
  const req = RULES.stability[level];
  return {
    level,
    streakNoLow: streak,
    aboveMA20: above,
    ma20Rising: rising,
    ma20: +ma20.toFixed(3),
    last: c[n - 1],
    dd60: +dd,
    needDays: req ? req.days : null,
    needGap: req ? req.gap : null,
  };
}

const S = JSON.parse(readFileSync('stocks.json', 'utf8'));
const out = { generatedAt: new Date().toISOString(), rules: RULES, stocks: {} };
for (const [sym, s] of Object.entries(S.series)) {
  out.stocks[sym] = { name: s.name, ...stability(s.bars), bars: s.bars.length, lastDate: s.bars.at(-1).d };
}
writeFileSync('stock-gate.json', JSON.stringify(out), 'utf8');

console.log('个股闸门 · 企稳判定（数据截至 ' + Object.values(out.stocks)[0].lastDate + '）\n');
console.log('  名称        收盘      企稳   不创20日新低  站上MA20  MA20上行  距60日高   该等级要求');
for (const v of Object.values(out.stocks)) {
  const req = v.level === '无' ? '只许减，不许加' : v.needDays + ' 个交易日 / ' + v.needGap + '%';
  console.log(
    '  ' + v.name.padEnd(9) + String(v.last).padStart(8) + '  ' + v.level.padEnd(4) +
    String(v.streakNoLow).padStart(8) + ' 天   ' + (v.aboveMA20 ? '是' : '否').padEnd(7) +
    (v.ma20Rising ? '是' : '否').padEnd(8) + (v.dd60 + '%').padStart(8) + '   ' + req,
  );
}
console.log('\n  硬约束（任何企稳等级都不放行）：总仓位 ≤ 70% · 单只 比亚迪50%/其余20% · 赛道 ≤ 40% · 账户级 4 档');
console.log('  止损：只对新买入逐笔 -20%，已有持仓不追溯');
console.log(`\nwrote stock-gate.json（${Object.keys(out.stocks).length} 只）`);
