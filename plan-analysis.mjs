// 工具二的分析层：估值分位 / 分歧 / 阶段标签 / 日历 → plan-data.json
//
// ⚠️ 最关键的一条方法论：**价格分位和 PE 分位必须用同一个窗口**。
//    中证2000 的 PE 只从 2023 年才有（指数 2023-08 才发布），若价格分位用 12 年、
//    PE 分位用 3 年，两者的"分位"含义不同，相减得到的"分歧"是纯粹的假象。
//    所以共同窗口 = 「PE 有值的区间」，两个分位都在它上面算；
//    另外单独给一个「全历史价格分位」作为长期位置的参考，但**不拿它去和 PE 比**。
//
// 阶段标签带**迟滞**：原始状态中位只持续 3~5 天，而用户一周只看几次。
// 要求原始状态连续成立 ≥10 个交易日才改标签，否则标签变化速度会超过查看频率。
import { readFileSync, writeFileSync } from 'node:fs';

const V = JSON.parse(readFileSync('valuation.json', 'utf8'));
const HYST = 10;      // 标签迟滞（交易日）
const MA = 200;       // 均线
const SLOPE = 120;    // 均线斜率回看

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

/** 分位：严格小于的比例 + 相等的一半（并列值不偏向一侧） */
function pctOf(v, sorted) {
  if (v == null || !sorted.length) return null;
  let lo = 0, hi = 0;
  for (const x of sorted) { if (x < v) lo++; else if (x === v) hi++; }
  return +(((lo + hi / 2) / sorted.length) * 100).toFixed(1);
}
const median = (a) => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null);

const out = { generatedAt: new Date().toISOString(), today, hyst: HYST, source: V.source, indexes: [] };

console.log('代码     名称       全历史       PE 可得窗口                  价格分位(共同窗)  PE分位  分歧');
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
  const pctPriceFull = pctOf(last.c, sortedAllClose);
  const pctPriceCommon = pctOf(last.c, sortedCommonClose);
  const pctPe = last.peg != null ? pctOf(last.peg, sortedPe) : null;

  // ---- 分歧判定 ----
  let div = null;
  if (pctPe != null && pctPriceCommon != null) {
    const gap = +(pctPriceCommon - pctPe).toFixed(1);
    let kind, text;
    if (Math.abs(gap) < 20) {
      kind = 'consistent';
      text = pctPe >= 70 ? '价格与估值一致偏贵' : pctPe <= 30 ? '价格与估值一致偏便宜' : '价格与估值一致，处于中间区';
    } else if (gap > 0) {
      kind = 'priceHighPeLow';
      text = '价格分位高于估值分位 —— 涨的是盈利（分子变好），不是估值扩张，属于健康上涨';
    } else {
      kind = 'priceLowPeHigh';
      text = '价格分位低于估值分位 —— 价格没跌但盈利在恶化，⚠️ 这是价值陷阱的典型形态';
    }
    div = { gap, kind, text };
  }

  // ---- 阶段状态（原始）+ 迟滞标签 ----
  const states = [];
  for (let i = MA + SLOPE; i < bars.length; i++) {
    const ma = closes.slice(i - MA + 1, i + 1).reduce((a, b) => a + b, 0) / MA;
    const maPrev = closes.slice(i - MA + 1 - SLOPE, i + 1 - SLOPE).reduce((a, b) => a + b, 0) / MA;
    const up = ma > maPrev, above = closes[i] > ma;
    states.push({ i, d: bars[i].d, raw: above ? (up ? '上升趋势' : '反转初期') : up ? '支撑/筑底' : '弱势下跌' });
  }
  // 迟滞：只有原始状态连续成立 ≥HYST 天才确认
  let label = states[0]?.raw ?? '—';
  let labelSince = states[0]?.d ?? null;
  let runStart = 0;
  for (let k = 0; k < states.length; k++) {
    if (states[k].raw !== states[runStart].raw) runStart = k;
    if (k - runStart + 1 >= HYST && states[k].raw !== label) {
      label = states[k].raw;
      labelSince = states[runStart].d;
    }
  }
  const rawNow = states.at(-1)?.raw ?? '—';
  const labelDays = labelSince ? states.filter((x) => x.d >= labelSince).length : 0;

  // ---- 抽样序列（周频）供画图 ----
  const series = [];
  for (let i = i0; i <= i1; i++) {
    const b = bars[i];
    if (i === i0 || i === i1 || i % 5 === 0) series.push([b.d, +b.c.toFixed(2), b.peg == null ? null : +b.peg.toFixed(2)]);
  }

  out.indexes.push({
    code, name: s.name, tag: s.tag,
    last: { d: last.d, c: last.c, pe: last.peg },
    peWindow: { start: bars[i0].d, end: bars[i1].d, n: commonPes.length, priceN: common.length },
    pct: { priceCommon: pctPriceCommon, pe: pctPe, priceFull: pctPriceFull, fullN: closes.length },
    div,
    phase: { raw: rawNow, label, labelSince, labelDays },
    peRange: { min: sortedPe[0], max: sortedPe.at(-1), med: median(sortedPe) },
    priceRange: { min: sortedCommonClose[0], max: sortedCommonClose.at(-1) },
    series,
  });

  console.log(
    `  ${code.padEnd(7)} ${s.name.padEnd(9)} ${String(closes.length).padStart(4)}根  ` +
      `${bars[i0].d}~${bars[i1].d} PE n=${String(commonPes.length).padStart(4)}  ` +
      `${String(pctPriceCommon).padStart(5)}% ${String(pctPe ?? '—').padStart(6)}%  ${div ? (div.gap >= 0 ? '+' : '') + div.gap + ' ' + div.kind : '—'}`,
  );
}

// ---- 日历：月度季节性强弱（用全历史价格，和上面无关）----
const seasonality = {};
for (const [code, s] of Object.entries(V.series)) {
  const byYm = new Map();
  for (const b of s.bars) {
    const ym = b.d.slice(0, 7);
    if (!byYm.has(ym)) byYm.set(ym, []);
    byYm.get(ym).push(b);
  }
  const rows = [];
  for (const [ym, arr] of [...byYm.entries()].sort()) {
    if (arr.length < 5) continue;
    rows.push({ m: +ym.slice(5), r: (arr.at(-1).c / arr[0].c - 1) * 100 });
  }
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const xs = rows.filter((r) => r.m === m).map((r) => r.r).sort((a, b) => a - b);
    if (!xs.length) { months.push({ m, n: 0 }); continue; }
    months.push({
      m, n: xs.length,
      med: +median(xs).toFixed(2),
      mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2),
      win: +((xs.filter((v) => v > 0).length / xs.length) * 100).toFixed(0),
    });
  }
  const all = rows.map((r) => r.r).sort((a, b) => a - b);
  seasonality[code] = { name: s.name, months, base: { med: +median(all).toFixed(2), n: all.length } };
}

// ==================== 纪律层 ====================
// 工具的首要目的是**执行纪律**，不是提供信息。所以这里把市场数据翻译成
// 「现在允许做什么 / 必须先回答什么」，而不是再堆一层数字。
//
// ⚠️ 下面的阈值是**可调规则**，不是真理。工具只负责按规则执行和提醒，
//    不判断这套规则对不对 —— 那必须由使用者自己预先定好，否则临场改主意正是要防的东西。
// 法定财报截止月：年报+一季报 4/30、中报 8/31、三季报 10/31。
// ⚠️ 必须定义在纪律层**之前**：它是 const，在后面定义再引用会抛暂时性死区（这个坑这次会话踩了三次）。
const EARNINGS = {
  4: '年报 + 一季报截止（4/30）',
  8: '中报截止（8/31）',
  10: '三季报截止（10/31）',
};
const CUR_MONTH = now.getMonth() + 1;

const RULES = {
  cheapPe: 30, cheapPrice: 30,      // 「便宜」要两个分位都 ≤ 阈值（保守）
  richPe: 70, richPrice: 85,        // 「贵」只要任一分位够高就算（保守）
  stopCount: 3,                     // 有几个标的算贵就整体停止加仓
};

/** 区间：便宜要有两个条件都满足，贵只要一个条件满足 —— 两边都取保守 */
function zoneOf(x) {
  const pe = x.pct.pe, pr = x.pct.priceCommon;
  if (pe == null || pr == null) return 'unknown';
  if (pe <= RULES.cheapPe && pr <= RULES.cheapPrice) return 'cheap';
  if (pe >= RULES.richPe || pr >= RULES.richPrice) return 'rich';
  return 'mid';
}

const zones = out.indexes.map((x) => ({ code: x.code, name: x.name, zone: zoneOf(x), pe: x.pct.pe, price: x.pct.priceCommon }));
for (const x of out.indexes) x.zone = zones.find((z) => z.code === x.code).zone;

const nCheap = zones.filter((z) => z.zone === 'cheap').length;
const nRich = zones.filter((z) => z.zone === 'rich').length;
const cheapNames = zones.filter((z) => z.zone === 'cheap').map((z) => z.name);
const richNames = zones.filter((z) => z.zone === 'rich').map((z) => z.name);

let permission;
if (nCheap > 0) {
  permission = {
    level: 'allow', color: '#2f9e6b', title: '允许加仓（仅限便宜区）',
    detail: `${cheapNames.join('、')} 落在便宜区（PE 与价格分位都 ≤ ${RULES.cheapPe}%）。只对这几个标的按档位加，其余标的仍不许加。`,
  };
} else if (nRich >= RULES.stopCount) {
  permission = {
    level: 'stop', color: '#e0803a', title: '禁止加仓',
    detail: `没有标的落在便宜区，而有 ${nRich} 个已进入偏贵区（${richNames.join('、')}）。这段时间只持有，不加新仓 —— 想加也必须等到有标的回到中性区。`,
  };
} else {
  permission = {
    level: 'hold', color: '#5b8def', title: '观望，不新增仓位',
    detail: `便宜区 0 个、偏贵区 ${nRich} 个。没有值得下手的区间，也没有必须撤退的理由。`,
  };
}

// 纪律检查清单：每一条都必须是「不需要预测」就能回答的问题
const checklist = [];
if (permission.level === 'allow') checklist.push({ kind: 'act', text: `只加「${cheapNames.join('、')}」，不加其他标的` });
else checklist.push({ kind: 'wait', text: '今天不买入（规则不允许），持仓不动即可' });

const weak = out.indexes.filter((x) => x.phase.label === '弱势下跌');
if (weak.length) checklist.push({ kind: 'check', text: `${weak.map((x) => x.name).join('、')} 处于「弱势下跌」：加仓前先回答「当初买它的理由还成立吗」` });

const traps = out.indexes.filter((x) => x.div?.kind === 'priceLowPeHigh');
if (traps.length) checklist.push({ kind: 'warn', text: `⚠️ ${traps.map((x) => x.name).join('、')} 出现「价格低但估值高」—— 盈利在恶化，这是价值陷阱的典型形态` });

if (EARNINGS[CUR_MONTH]) checklist.push({ kind: 'check', text: `${CUR_MONTH} 月是${EARNINGS[CUR_MONTH]}：个股不加新仓，留意持仓个股的预约披露日` });
if ([12, 1].includes(CUR_MONTH)) checklist.push({ kind: 'warn', text: '12–1 月小盘显著弱（中证2000 十二月胜率 33%）：持有小盘的话别在这个窗口加仓' });

out.discipline = { permission, checklist, zones, rules: RULES };
out.seasonality = seasonality;

out.earnings = EARNINGS;
out.currentMonth = CUR_MONTH;

writeFileSync('plan-data.json', JSON.stringify(out), 'utf8');
const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`\nwrote plan-data.json（${kb} KB）  标的 ${out.indexes.length} 个`);
console.log(`当前月份 ${out.currentMonth} 月${EARNINGS[out.currentMonth] ? ' —— ⚠️ ' + EARNINGS[out.currentMonth] : ''}`);
