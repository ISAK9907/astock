// 盘前信号核心逻辑（被 build-dashboard / serve-dashboard / daily-update 共用）
//
// 依据：16 年 × 4 指数 × 15876 个 (T, T+1) 对
//   两个条件在 T+1 集合竞价结束时都已观测到，因此可执行（T+1 下「卖出手上已有持仓、
//   收盘再买回」合法，赚的是 开盘→收盘 的回落）。
//
//   核心是**交互**：跳空本身没有信息（低开→高开的跨度只有 -0.11%），
//   必须叠加 T 日状态才有信息：弱市高开的跨度 -0.95%，强市高开的跨度 +0.97%。
export const TH = {
  // 弱势侧：阈值敏感性检验显示 -0.2% ~ -1.5% 全程 4/4 时段一致、且单调，取中间值
  retWeak: -0.5,
  // 强势侧：+0.5% 只有 3/4 时段一致，+1.0% 起才 4/4，故取更严的阈值
  retStrong: 1.0,
  // 量能：<1.0 给 4/4（n=136），<0.9 只有 3/3（n=96），取 1.0
  amtLow: 1.0,
  amtHigh: 1.15,
  gap: 1.0,
};

export const ACTIONS = {
  CUT: { key: 'cut', label: '偏减仓', color: '#43d19a', sign: 1 },
  HOLD: { key: 'hold', label: '持有别减', color: '#ff7a86', sign: 1 },
  BUY: { key: 'buy', label: '偏持有', color: '#5b8def', sign: 1 },
  WATCH: { key: 'watch', label: '观望', color: '#7b8698', sign: 0 },
};

/** 从日线序列（按日期升序，最后一个必须是 T）提取 T 日状态 */
export function stateOf(bars) {
  const t = bars.at(-1);
  const tl = bars.at(-2);
  const win = bars.slice(-21, -1); // 不含 T 日的 20 日
  // 只用「确实带成交额」的那几日求均值。同花顺兜底补出来的 bar 没有 amt，
  // 若把 null 当 0 累加却仍除以 20，amt20 会被系统性低估、amtRatio 被高估，
  // 进而把「缩量」误判成「放量」。
  const withAmt = win.filter((b) => b.amt > 0);
  const amt20 = withAmt.length ? withAmt.reduce((s, b) => s + b.amt, 0) / withAmt.length : 0;
  return {
    date: t.d,
    retT: (t.c / tl.c - 1) * 100,
    // 有效样本不足 15/20 就不给量能判断，宁可不判也不用残缺样本下结论
    amtRatio: withAmt.length >= 15 && amt20 > 0 && t.amt ? t.amt / amt20 : null,
    close: t.c,
  };
}

/**
 * 决策：T 日状态 + T+1 集合竞价跳空 → 建议
 * @returns { action, expect, n, era, why }  expect 单位 %，是**该动作**的期望收益
 */
export function decide(state, gap) {
  const { retT, amtRatio } = state;
  const weak = retT <= TH.retWeak;
  const strong = retT >= TH.retStrong;
  const lowVol = amtRatio != null && amtRatio < TH.amtLow;
  const highVol = amtRatio != null && amtRatio >= TH.amtHigh;
  const fmt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  if (gap > TH.gap) {
    if (weak && lowVol)
      return { action: ACTIONS.CUT, expect: 0.59, n: 136, era: '4/4', why: `前一日跌 ${fmt(retT)} 且量能仅 ${amtRatio.toFixed(2)}×20日均值，高开 ${fmt(gap)} → 日内倾向回落，开盘减仓、收盘补回` };
    if (weak)
      return { action: ACTIONS.CUT, expect: 0.42, n: 192, era: '4/4', why: `前一日跌 ${fmt(retT)}，高开 ${fmt(gap)} → 日内倾向回落，开盘减仓、收盘补回` };
    if (strong && highVol)
      return { action: ACTIONS.HOLD, expect: 0.78, n: 71, era: '3/3', why: `前一日涨 ${fmt(retT)} 且放量（${amtRatio.toFixed(2)}×），高开 ${fmt(gap)} → 日内倾向续涨，不要减仓` };
    if (strong)
      return { action: ACTIONS.HOLD, expect: 0.63, n: 144, era: '4/4', why: `前一日涨 ${fmt(retT)}，高开 ${fmt(gap)} → 日内倾向续涨，不要减仓` };
    return { action: ACTIONS.WATCH, expect: null, n: 0, era: '—', why: `前一日 ${fmt(retT)} 不够极端（需 ≤${TH.retWeak}% 或 ≥+${TH.retStrong}%），高开在历史上没有边缘 —— 各时段方向不一致，视为噪音` };
  }
  if (gap < -TH.gap) {
    if (weak)
      return { action: ACTIONS.BUY, expect: 0.28, n: 327, era: '4/4', why: `前一日跌 ${fmt(retT)}，低开 ${fmt(gap)} → 日内倾向反弹，可继续持有` };
    if (strong)
      return { action: ACTIONS.WATCH, expect: -0.09, n: 201, era: '3/4', why: `前一日涨 ${fmt(retT)}，低开 ${fmt(gap)} → 方向不稳，不加不减` };
    return { action: ACTIONS.WATCH, expect: null, n: 0, era: '—', why: `前一日 ${fmt(retT)} 不够极端，低开无边缘` };
  }
  return { action: ACTIONS.WATCH, expect: null, n: 0, era: '—', why: `跳空未达 ±${TH.gap}% 阈值，历史上无边缘` };
}

/** 还没拿到竞价时的条件清单（用于盘前展示） */
export function playbook(state) {
  const { retT, amtRatio } = state;
  const fmt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const weak = retT <= TH.retWeak, strong = retT >= TH.retStrong;
  const tag = weak ? '前一日弱' : strong ? '前一日强' : '前一日不够极端';
  return [
    { cond: '若高开 > +1%', act: decide(state, 1.2).action, expect: decide(state, 1.2).expect, era: decide(state, 1.2).era },
    { cond: '若低开 < -1%', act: decide(state, -1.2).action, expect: decide(state, -1.2).expect, era: decide(state, -1.2).era },
    { cond: '若平开 ±1% 内', act: decide(state, 0).action, expect: null, era: '—' },
  ].map((r) => ({ ...r, state: `${tag} ${fmt(retT)}${amtRatio != null ? ` · 量能 ${amtRatio.toFixed(2)}×` : ''}` }));
}
