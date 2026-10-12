// 工具二的分析层：估值档位 / 分歧 / 加减仓价格线 / 日历 → plan-data.json
//
// ==================== 三条口径决定（都值得单独说明） ====================
//
// ① 价格分位与 PE 分位必须用**同一个窗口**。
//    中证2000 的 PE 只从 2023 年才有（指数 2023-08 才发布）。若价格分位用 12 年、
//    PE 分位用 3 年，两者的「分位」含义不同，相减得到的「分歧」是纯粹的假象。
//    所以共同窗口 = 「PE 有值的区间」，两个分位都在它上面算。
//
// ② **档位由 PE 分位决定，价格分位只用于分歧提示。**
//    这是修掉的一个自相矛盾：早先的规则是「贵 = PE ≥ 70 或 价格 ≥ 85」，
//    于是中证红利被同时判成「偏贵」（价格分位 87%）和「健康上涨」（PE 分位只有 40%，
//    价格高是盈利驱动）—— 同一个工具两边打架。
//    根因是「价格高」被当成了贵的证据。**价格高但 PE 低不是贵，是盈利变好了。**
//    所以估值档只看 PE 分位；价格分位高只作为「分歧」提示，不参与贵贱判定。
//
// ③ 价格线用 **PE 口径换算**，不用历史价格分位点。
//    PE 口径隐含价 = 现价 × (目标分位的 PE / 当前 PE)。它随盈利变化：
//    盈利增长时同样的 PE 对应更高价格，所以线不会随时间变成一句废话。
//    历史价格分位点是固定的，三年后可能早就失效了。
import { readFileSync, writeFileSync } from 'node:fs';

const V = JSON.parse(readFileSync('valuation.json', 'utf8'));

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const CUR_MONTH = now.getMonth() + 1;

// 法定财报截止月。⚠️ 必须定义在任何使用它的地方之前 —— const 的暂时性死区这次会话踩了三次。
const EARNINGS = {
  4: '年报 + 一季报截止（4/30）',
  8: '中报截止（8/31）',
  10: '三季报截止（10/31）',
};

/** 规则阈值。**这些是可调的，不是真理** —— 工具只负责执行，不判断规则对不对。 */
const RULES = {
  // 档位标签只用 PE 分位（见文件头 ②）
  zoneCheap: 30,
  zoneRich: 70,
  // 加减仓价格线：按 PE 分位分档。**「线就是规则」** —— 触及哪一档就允许做哪一档的动作。
  // 第 1 档最浅（PE 分位 45，略低于中位），第 4 档最深。越跌越买，每档等额。
  // ⚠️ 早先把「允许加仓」的门槛设成 PE ≤ 30、而第 1 档线设在 40 —— 结果触及了档线却不给许可，
  //    工具自己跟自己矛盾。现在两者统一：触及档位 = 获得该档许可。
  addTiers: [45, 35, 25, 15],
  cutTiers: [75, 90], // 减仓档：PE 分位涨到 75 / 90
  nearPct: 3,         // 距现价 ±此百分比内算「临近」，在「明日操作」里提示
  divGap: 20,         // 价格分位与 PE 分位差多少算「分歧」
};

// ---------------- 工具函数 ----------------
/** 分位：严格小于的比例 + 相等的一半（并列值不偏向一侧） */
function pctOf(v, sorted) {
  if (v == null || !sorted.length) return null;
  let lo = 0, hi = 0;
  for (const x of sorted) { if (x < v) lo++; else if (x === v) hi++; }
  return +(((lo + hi / 2) / sorted.length) * 100).toFixed(1);
}
/** 线性插值分位数（比「取序号」在样本量小的时候更稳） */
function quantile(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}
const median = (a) => quantile(a, 0.5);

const out = { generatedAt: new Date().toISOString(), today, source: V.source, rules: RULES, indexes: [] };

console.log('代码     名称       价格分位  PE分位  档位   最近加仓线(距)          最近减仓线(距)          分歧');
for (const [code, s] of Object.entries(V.series)) {
  const bars = s.bars;
  const closes = bars.map((b) => b.c);

  // ---- 共同窗口：PE 有值的区间 ----
  const peIdx = bars.map((b, i) => (b.peg != null ? i : -1)).filter((i) => i >= 0);
  if (!peIdx.length) { console.warn(`  ${s.name} 完全没有 PE，跳过`); continue; }
  const i0 = peIdx[0], i1 = peIdx[peIdx.length - 1];
  const common = bars.slice(i0, i1 + 1);
  const commonCloses = common.map((b) => b.c);
  const commonPes = common.filter((b) => b.peg != null).map((b) => b.peg);

  const sortedAllClose = [...closes].sort((a, b) => a - b);
  const sortedCommonClose = [...commonCloses].sort((a, b) => a - b);
  const sortedPe = [...commonPes].sort((a, b) => a - b);

  const last = bars.at(-1);
  const priceNow = last.c, peNow = last.peg;
  const pctPrice = pctOf(priceNow, sortedCommonClose);
  const pctPe = peNow != null ? pctOf(peNow, sortedPe) : null;
  const pctPriceFull = pctOf(priceNow, sortedAllClose);

  // ---- 档位：只看 PE 分位 ----
  const zone = pctPe == null ? 'unknown' : pctPe <= RULES.zoneCheap ? 'cheap' : pctPe >= RULES.zoneRich ? 'rich' : 'mid';

  // ---- 分歧：价格分位 vs PE 分位 ----
  let div = null;
  if (pctPe != null && pctPrice != null) {
    const gap = +(pctPrice - pctPe).toFixed(1);
    let kind, text;
    if (Math.abs(gap) < RULES.divGap) {
      kind = 'consistent';
      text = pctPe >= RULES.zoneRich ? '价格与估值一致偏贵' : pctPe <= RULES.zoneCheap ? '价格与估值一致偏便宜' : '价格与估值一致，都在中间区';
    } else if (gap > 0) {
      kind = 'priceHighPeLow';
      text = '价格分位高于估值分位 —— 涨的是盈利（分母变好），不是估值扩张。价格在高位但不算贵';
    } else {
      kind = 'priceLowPeHigh';
      text = '价格分位低于估值分位 —— 价格没跌但盈利在恶化，⚠️ 这是价值陷阱的典型形态';
    }
    div = { gap, kind, text };
  }

  // ---- 价格线：按 PE 分位分档，用 PE 口径换算成价格 ----
  // 隐含价 = 现价 × (目标分位的 PE / 当前 PE)
  // 含义：假设盈利不变，PE 回到历史上第 p 分位时的价格。盈利变化时这条线会自己移动。
  //
  // ⚠️ 「已触及」的方向两边相反，这一点搞错会让所有减仓档都显示成已触及（实测踩到）：
  //    加仓档（PE 分位 p）→ 当前 PE 分位 **跌到** p 以下才算触及；
  //    减仓档（PE 分位 p）→ 当前 PE 分位 **涨到** p 以上才算触及。
  const mkLine = (p, dir) => {
    if (peNow == null) return null;
    const targetPe = quantile(sortedPe, p / 100);
    const price = priceNow * (targetPe / peNow);
    const hit = pctPe != null && (dir === 'add' ? pctPe <= p : pctPe >= p);
    return {
      pePct: p,
      dir,
      tier: (dir === 'add' ? RULES.addTiers : RULES.cutTiers).indexOf(p) + 1,
      targetPe: +targetPe.toFixed(2),
      price: +price.toFixed(2),
      pct: +((price / priceNow - 1) * 100).toFixed(2),
      hit,
    };
  };
  const addLines = RULES.addTiers.map((p) => mkLine(p, 'add')).filter(Boolean);
  const cutLines = RULES.cutTiers.map((p) => mkLine(p, 'cut')).filter(Boolean);

  out.indexes.push({
    code, name: s.name, tag: s.tag,
    last: { d: last.d, c: priceNow, pe: peNow },
    peWindow: { start: bars[i0].d, end: bars[i1].d, n: commonPes.length, priceN: common.length },
    pct: { priceCommon: pctPrice, pe: pctPe, priceFull: pctPriceFull, fullN: closes.length },
    zone, div,
    peRange: { min: +sortedPe[0].toFixed(2), max: +sortedPe.at(-1).toFixed(2), med: +median(sortedPe).toFixed(2) },
    addLines, cutLines,
    series: (() => {
      const r = [];
      for (let i = i0; i <= i1; i++) if (i === i0 || i === i1 || i % 5 === 0) r.push([bars[i].d, +bars[i].c.toFixed(2), bars[i].peg == null ? null : +bars[i].peg.toFixed(2)]);
      return r;
    })(),
  });

  const a1 = addLines[0], c1 = cutLines[0];
  const fmt = (l) => (l ? `${l.price}(${l.pct >= 0 ? '+' : ''}${l.pct}%${l.hit ? ' 已触及' : ''})` : '—');
  console.log(
    `  ${code.padEnd(7)} ${s.name.padEnd(9)} ${String(pctPrice).padStart(5)}% ${String(pctPe).padStart(5)}%  ${zone.padEnd(5)} ` +
      `${fmt(a1)}`.padEnd(24) + `${fmt(c1)}`.padEnd(24) + (div ? `${div.gap >= 0 ? '+' : ''}${div.gap} ${div.kind}` : '—'),
  );
}

// ==================== 明日操作 ====================
// 使用者收盘后打开这个页面，只需要看这一段：明天要不要动、动的话在什么价位。
//
// ⚠️ 呈现口径（改过一次，值得说明）：档线是**触发价**，价格跌到它才执行。
//    所以「已触及」的档，它的触发价往往**高于**现价（价格已经跌穿了它）。
//    直接把触发价和现价并排显示会读成「还没到」，因此这里只报两件事：
//      ① 已触发了几档 —— 这是**现在就能做的动作**；
//      ② 下一档的触发价 —— 这是**明天要盯的价位**。
const active = [];
for (const x of out.indexes) {
  const hitAdd = x.addLines.filter((l) => l.hit);
  const nextAdd = x.addLines.find((l) => !l.hit) ?? null;
  const hitCut = x.cutLines.filter((l) => l.hit);
  const nextCut = x.cutLines.find((l) => !l.hit) ?? null;
  active.push({
    name: x.name, code: x.code,
    pePct: x.pct.pe, price: x.last.c,
    hitAdd: hitAdd.length,
    deepestHitTier: hitAdd.length ? hitAdd.at(-1).tier : 0,
    nextAdd: nextAdd ? { tier: nextAdd.tier, price: nextAdd.price, pct: nextAdd.pct, pePct: nextAdd.pePct } : null,
    hitCut: hitCut.length,
    deepestHitCutTier: hitCut.length ? hitCut.at(-1).tier : 0,
    nextCut: nextCut ? { tier: nextCut.tier, price: nextCut.price, pct: nextCut.pct, pePct: nextCut.pePct } : null,
  });
}
const todo = active.filter((a) => a.hitAdd > 0 || a.hitCut > 0);
const near = [];
for (const a of active) {
  if (a.nextAdd && Math.abs(a.nextAdd.pct) <= RULES.nearPct) near.push({ name: a.name, kind: 'add', ...a.nextAdd });
  if (a.nextCut && Math.abs(a.nextCut.pct) <= RULES.nearPct) near.push({ name: a.name, kind: 'cut', ...a.nextCut });
}
const closest = active
  .filter((a) => a.nextAdd)
  .map((a) => ({ name: a.name, ...a.nextAdd }))
  .sort((p, q2) => Math.abs(p.pct) - Math.abs(q2.pct));

out.action = {
  todo: todo.map((a) => ({ name: a.name, hitAdd: a.hitAdd, tier: a.deepestHitTier, hitCut: a.hitCut, cutTier: a.deepestHitCutTier })),
  near,
  active,
  closest: closest[0] ?? null,
};
const hits = out.action.todo; // ⚠️ 必须用映射后的那张表（字段是 tier/cutTier）；
                              //    直接用原始 active 对象会读到 undefined —— 原始字段叫 deepestHitTier。实测踩到。

// ==================== 许可 ====================
// **许可直接由「哪条线被触及」推导**，不再另设一套门槛 ——
// 否则就会出现「碰了档线却不给许可」的自相矛盾（早先就是这样）。
const nCheap = out.indexes.filter((x) => x.zone === 'cheap');
const nRich = out.indexes.filter((x) => x.zone === 'rich');

let permission;
if (hits.length) {
  const adds = hits.filter((h) => h.hitAdd > 0);
  const cuts = hits.filter((h) => h.hitCut > 0);
  if (adds.length && !cuts.length) {
    permission = {
      level: 'allow', color: '#2f9e6b', title: '允许加仓',
      detail: `${adds.map((h) => `${h.name} 第 ${h.tier} 档（PE 分位 ${active.find((a) => a.name === h.name).pePct}%）`).join('、')} 已触发。按档等额买入，收盘后到页面底部记一笔。`,
    };
  } else if (cuts.length && !adds.length) {
    permission = {
      level: 'reduce', color: '#e0803a', title: '考虑减仓',
      detail: `${cuts.map((h) => `${h.name} 第 ${h.cutTier} 档`).join('、')} 减仓档已触发。按档减仓，收盘后记一笔。`,
    };
  } else {
    permission = {
      level: 'both', color: '#c06fd6', title: '同时有加仓与减仓档被触发',
      detail: `加仓：${adds.map((h) => h.name).join('、')}；减仓：${cuts.map((h) => h.name).join('、')}。各自按档执行，别互相抵消。`,
    };
  }
} else {
  const closeOnes = out.indexes.filter((x) => x.pct.pe != null && x.pct.pe < RULES.addTiers[0] + 10).map((x) => `${x.name}(PE 分位 ${x.pct.pe}%)`);
  permission = {
    level: 'hold', color: '#5b8def', title: '观望，不新增仓位',
    detail: `没有任何加仓档被触发（最浅一档 = PE 分位 ${RULES.addTiers[0]}%），也没有减仓档被触发。` +
      (closeOnes.length ? `最接近的是 ${closeOnes.join('、')}。` : '') +
      (out.action.closest ? ` 最近的一条加仓线还差 ${Math.abs(out.action.closest.pct)}%：${out.action.closest.name} @ ${out.action.closest.price}。` : ''),
  };
}

// ==================== 纪律检查清单 ====================
const checklist = [];
if (hits.length) {
  for (const h of hits) {
    if (h.hitAdd > 0) checklist.push({ kind: 'act', text: `${h.name} 第 ${h.tier} 档已触发，现在按第 ${h.tier} 档买入` });
    if (h.hitCut > 0) checklist.push({ kind: 'act', text: `${h.name} 第 ${h.cutTier} 档减仓已触发` });
  }
} else {
  checklist.push({ kind: 'wait', text: '没有任何价格线被触发，明天不需要操作' });
}
if (near.length) checklist.push({ kind: 'check', text: `临近：${near.map((h) => `${h.name} ${h.kind === 'add' ? '加仓' : '减仓'}档 @ ${h.price}（${h.pct >= 0 ? '+' : ''}${h.pct}%）`).join('、')}` });
else if (out.action.closest) checklist.push({ kind: 'check', text: `最近的一条加仓线还差 ${Math.abs(out.action.closest.pct)}%：${out.action.closest.name} @ ${out.action.closest.price}（第 ${out.action.closest.tier} 档）` });

const traps = out.indexes.filter((x) => x.div?.kind === 'priceLowPeHigh');
if (traps.length) checklist.push({ kind: 'warn', text: `⚠️ ${traps.map((x) => x.name).join('、')} 出现「价格低但估值高」—— 盈利在恶化，这是价值陷阱的典型形态` });
const hp = out.indexes.filter((x) => x.div?.kind === 'priceHighPeLow');
if (hp.length) checklist.push({ kind: 'check', text: `${hp.length} 个标的「价格在高位但估值不高」（${hp.map((x) => x.name).join('、')}）：涨的是盈利，别因为价格新高就当它贵` });
if (EARNINGS[CUR_MONTH]) checklist.push({ kind: 'check', text: `${CUR_MONTH} 月是${EARNINGS[CUR_MONTH]}：个股不加新仓，留意持仓个股的预约披露日` });
if ([12, 1].includes(CUR_MONTH)) checklist.push({ kind: 'warn', text: '12–1 月小盘显著弱（中证2000 十二月胜率 33%）：持有小盘别在这个窗口加仓' });

out.discipline = { permission, checklist };

// ==================== 日历 ====================
const seasonality = {};
for (const [code, s] of Object.entries(V.series)) {
  const byYm = new Map();
  for (const b of s.bars) {
    const ym = b.d.slice(0, 7);
    if (!byYm.has(ym)) byYm.set(ym, []);
    byYm.get(ym).push(b);
  }
  const rows = [];
  for (const [ym, arr] of [...byYm.entries()].sort()) if (arr.length >= 5) rows.push({ m: +ym.slice(5), r: (arr.at(-1).c / arr[0].c - 1) * 100 });
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const xs = rows.filter((r) => r.m === m).map((r) => r.r).sort((a, b) => a - b);
    if (!xs.length) { months.push({ m, n: 0 }); continue; }
    months.push({ m, n: xs.length, med: +median(xs).toFixed(2), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), win: +((xs.filter((v) => v > 0).length / xs.length) * 100).toFixed(0) });
  }
  const all = rows.map((r) => r.r).sort((a, b) => a - b);
  seasonality[code] = { name: s.name, months, base: { med: +median(all).toFixed(2), n: all.length } };
}

out.seasonality = seasonality;
out.earnings = EARNINGS;
out.currentMonth = CUR_MONTH;

writeFileSync('plan-data.json', JSON.stringify(out), 'utf8');
console.log(`\nwrote plan-data.json（${(JSON.stringify(out).length / 1024).toFixed(0)} KB）  标的 ${out.indexes.length} 个`);
console.log(`许可：${permission.title}`);
console.log(`明日：${hits.length ? `有 ${hits.length} 条线已触及` : '不需要操作'}${near.length ? ` · ${near.length} 条临近` : ''}`);
