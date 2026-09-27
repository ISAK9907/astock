// ⚠️ 本文件由 build-worker.mjs 自动生成，请勿直接编辑。
// 改判定逻辑请改 signal.mjs / global-quote.mjs；改 Worker 入口请改 worker/handler.js。
// 生成时间：2026-09-27T15:24:45.328Z
// 内联的状态文件：T=2026-09-24（generatedAt=2026-09-27T15:24:45.250Z）

// ===== signal.mjs =====
// 盘前信号核心逻辑（被 build-dashboard / serve-dashboard / daily-update 共用）
//
// 依据：16 年 × 4 指数 × 15876 个 (T, T+1) 对
//   两个条件在 T+1 集合竞价结束时都已观测到，因此可执行（T+1 下「卖出手上已有持仓、
//   收盘再买回」合法，赚的是 开盘→收盘 的回落）。
//
//   核心是**交互**：跳空本身没有信息（低开→高开的跨度只有 -0.11%），
//   必须叠加 T 日状态才有信息：弱市高开的跨度 -0.95%，强市高开的跨度 +0.97%。
const TH = {
  // 弱势侧：阈值敏感性检验显示 -0.2% ~ -1.5% 全程 4/4 时段一致、且单调，取中间值
  retWeak: -0.5,
  // 强势侧：+0.5% 只有 3/4 时段一致，+1.0% 起才 4/4，故取更严的阈值
  retStrong: 1.0,
  // 量能：<1.0 给 4/4（n=136），<0.9 只有 3/3（n=96），取 1.0
  amtLow: 1.0,
  amtHigh: 1.15,
  gap: 1.0,
};

const ACTIONS = {
  CUT: { key: 'cut', label: '偏减仓', color: '#43d19a', sign: 1 },
  HOLD: { key: 'hold', label: '持有别减', color: '#ff7a86', sign: 1 },
  BUY: { key: 'buy', label: '偏持有', color: '#5b8def', sign: 1 },
  WATCH: { key: 'watch', label: '观望', color: '#7b8698', sign: 0 },
};

/** 从日线序列（按日期升序，最后一个必须是 T）提取 T 日状态 */
function stateOf(bars) {
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
function decide(state, gap) {
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
function playbook(state) {
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


// ===== global-quote.mjs =====
// 全球市场实时行情 + A 股跳空预判
//
// 依据（16 年 3999 个交易日实证，见 analyze-global*.mjs）：
//   · 美股隔夜与 A 股跳空方向一致率 65%，|美股|>1% 时 82.7%；分桶完全单调
//     （美股≤-3% → A股跳空 -1.67%、87.5% 低开；美股≥+2% → +0.57%）
//   · 非对称：美股跌 1% → A股跳空 0.349%；美股涨 1% → 0.142%（跌幅传导 2.46 倍）
//   · 亚洲早盘（韩/日/台当日开盘）最有效：一致率 67.6%，|因子|>1% 时 89.4%
//     复合因子对跳空的调整 R² = 21.5%，回归 A股跳空 = -0.116 + 0.430 × 亚洲早盘
//   · 黄金、美元指数**无效**（一致率 49.8% / 48.2%，等于抛硬币）
//   · 对「日内」没有增量：现有信号格子内样本不足，残差因子 r=-0.056 亦无效
//     → 所以本模块只用于**预判开盘跳空**，不改动日内应对逻辑
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';

const GLOBAL_SECIDS = {
  spx: ['100.SPX', '标普500'],
  kospi: ['100.KS11', '韩国KOSPI'],
  nikkei: ['100.N225', '日经225'],
  twii: ['100.TWII', '台湾加权'],
  gold: ['101.GC00Y', 'COMEX黄金'],
  dxy: ['100.UDI', '美元指数'],
};

/** 回归系数（16 年全样本）：A股跳空 = INTERCEPT + BETA × 亚洲早盘均值 */
const GAP_MODEL = { INTERCEPT: -0.116, BETA: 0.43 };

async function getJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, { headers: H, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** 取全球实时行情。东财这些字段都是 ×100 的整数（指数点位 ×100，涨跌幅 ×100）
 *  注意：ulist 里「今开」是 f17（不是 f46，f46 只在单品种 stock/get 里返回） */
async function globalQuotes() {
  const ids = Object.values(GLOBAL_SECIDS).map(([s]) => s).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f12,f14,f17,f18,f86,f124&ut=${UT}`;
  const j = await getJson(url);
  const out = {};
  for (const [key, [secid, name]] of Object.entries(GLOBAL_SECIDS)) {
    const d = (j?.data?.diff ?? []).find((x) => String(x.f12) === secid.split('.')[1]);
    if (!d) { out[key] = null; continue; }
    const px = (v) => (v == null || v === '-' ? null : v / 100);
    const ts = d.f124 || d.f86 || 0;
    out[key] = {
      name,
      price: px(d.f2),
      chg: d.f3 == null || d.f3 === '-' ? null : d.f3 / 100, // 当日涨跌幅 %
      prevClose: px(d.f18),
      open: px(d.f17),
      asOf: ts ? new Date(ts * 1000).toLocaleString('zh-CN') : '',
      date: ts ? localIso(new Date(ts * 1000)) : '',
    };
  }
  if (!Object.values(out).some(Boolean)) throw new Error('东财全球行情返回空');
  return out;
}

const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 由全球行情推算 A 股跳空预判（无未来信息：美股已收盘、亚洲已开盘） */
function forecastGap(q) {
  const TODAY = localIso(new Date());
  const g = ['kospi', 'nikkei', 'twii'].map((k) => {
    const x = q[k];
    if (!x || !x.open || !x.prevClose || x.open <= 0 || x.prevClose <= 0) return null;
    // ⚠️ 必须确认这条行情是「今天」的：韩国/日本/台湾假期与大陆不同，
    //    否则会把几天前的旧开盘价当成今日早盘（实测日经曾停在 9/18）。
    if (x.date !== TODAY) return null;
    return (x.open / x.prevClose - 1) * 100;
  });
  const have = g.filter((v) => v != null && isFinite(v));
  // 有几家用几家（此前要求三家齐全，导致只到两家时就白白退化成"仅美股"）
  const asia = have.length ? have.reduce((a, b) => a + b, 0) / have.length : null;
  const asiaN = have.length;
  const us = q.spx?.chg ?? null;
  const gold = q.gold?.chg ?? null;

  let predicted = null, basis = '';
  if (asia != null) {
    predicted = GAP_MODEL.INTERCEPT + GAP_MODEL.BETA * asia;
    basis = `亚洲早盘${asiaN < 3 ? `（${asiaN}/3 家已开盘）` : ''}`;
  } else if (us != null) {
    // 亚洲未开盘时，退化为只用美股（分桶经验：跌1%→A股约-0.35%，涨1%→约+0.14%）
    predicted = us < 0 ? us * 0.349 : us * 0.142;
    basis = '仅美股（亚洲未开盘）';
  }

  // 方向读数：基于一致率
  const usRead = us == null ? null : us <= -2 ? '强利空' : us <= -1 ? '偏空' : us < -0.3 ? '略偏空' : us >= 2 ? '强利多' : us >= 1 ? '偏多' : us > 0.3 ? '略偏多' : '中性';
  const asiaRead = asia == null ? null : asia <= -1 ? '偏空' : asia <= -0.3 ? '略偏空' : asia >= 1 ? '偏多' : asia > 0.3 ? '略偏多' : '中性';

  return {
    predicted: predicted == null ? null : +predicted.toFixed(3),
    basis,
    asia: asia == null ? null : +asia.toFixed(3),
    asiaN,
    us, gold,
    usRead, asiaRead,
    // 经验参照：美股大跌/大涨时 A 股跳空的分布
    ref: us == null ? null
      : us <= -3 ? '历史上美股跌≥3% 时，A 股平均跳空 -1.67%，87.5% 低开（n=40）'
      : us <= -2 ? '历史上美股跌≥2% 时，A 股平均跳空 -1.06%，94% 低开（n=123）'
      : us >= 2 ? '历史上美股涨≥2% 时，A 股平均跳空 +0.57%，89% 高开（n=89）'
      : null,
  };
}


// ===== signal-state.json（内联）=====
const STATE = {"generatedAt":"2026-09-27T15:24:45.250Z","T":"2026-09-24","thresholds":{"retWeak":-0.5,"retStrong":1,"amtLow":1,"amtHigh":1.15,"gap":1},"states":[{"key":"sh","name":"上证指数","date":"2026-09-24","retT":-1.2230599615904447,"amtRatio":0.8695190042738526,"close":3888.374},{"key":"szcz","name":"深证成指","date":"2026-09-24","retT":-2.340124390678555,"amtRatio":0.859300587501923,"close":13316.969},{"key":"cyb","name":"创业板指","date":"2026-09-24","retT":-2.682617225064443,"amtRatio":0.8644180409714137,"close":3288.948},{"key":"hs300","name":"沪深300","date":"2026-09-24","retT":-1.7297134558849514,"amtRatio":0.7723746150161087,"close":4439.144}]};

// ===== worker/handler.js =====
// Cloudflare Worker 的 /signal 处理器 —— 从 serve-dashboard.mjs 原样搬过来。
// 本文件是「片段」，由 build-worker.mjs 与 signal.mjs / global-quote.mjs / signal-state.json
// 拼成一个自包含的 Worker。所以这里不要写 import。
//
// 为什么要搬到 Worker：/signal 需要**服务端**去抓新浪行情和东财全球行情（浏览器直接抓会被 CORS 挡）。
// 原来只能由本机的 serve-dashboard.mjs 提供，于是「实时竞价」这件事绑死在「你的电脑得开着」。
// Worker 在边缘跑，不依赖任何本机进程。

const SYM = { sh: 'sh000001', szcz: 'sz399001', cyb: 'sz399006', hs300: 'sh000300' };

/** 新浪实时行情（只取开盘价与昨收；返回串是 GBK，但这里只用数字字段） */
async function quote(symbols) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`https://hq.sinajs.cn/list=${symbols.join(',')}`, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const out = {};
    for (const row of text.split('\n')) {
      const m = /hq_str_(\w+)="([^"]*)"/.exec(row);
      if (!m) continue;
      const f = m[2].split(',');
      if (f.length < 10) continue;
      out[m[1]] = { open: +f[1], prevClose: +f[2], price: +f[3], date: f[30] || '', time: f[31] || '' };
    }
    if (!Object.keys(out).length) throw new Error('新浪 hq 返回空');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// isolate 内的短缓存：边缘节点会被复用，30 秒内不重复打上游
let mem = { at: 0, payload: null };

async function buildSignal() {
  if (Date.now() - mem.at < 30_000 && mem.payload) return mem.payload;
  const st = STATE;
  const keys = st.states.map((s) => s.key).filter((k) => SYM[k]);
  const q = await quote(keys.map((k) => SYM[k]));
  const out = { T: st.T, asOf: '', status: 'live', stale: false, thresholds: TH, indices: [] };
  for (const s of st.states) {
    const sym = SYM[s.key];
    const qt = sym ? q[sym] : null;
    let gap = null;
    let status = 'live';
    if (!qt || qt.open <= 0 || qt.prevClose <= 0) {
      status = 'preopen'; // 还没有竞价数据
    } else if (qt.date && qt.date <= st.T) {
      // 行情还停在 T 日当天：收盘后到次日开盘前的正常状态，不是数据错误
      status = 'preopen';
    } else if (s.close && Math.abs(qt.prevClose - s.close) / s.close > 0.002) {
      status = 'stale'; // 行情已是 T+1，但昨收对不上 T 日收盘 → 状态文件过期
    } else {
      gap = (qt.open / qt.prevClose - 1) * 100;
    }
    if (qt && qt.date) out.asOf = `${qt.date} ${qt.time}`;
    const dec = decide(s, gap == null ? 0 : gap);
    out.indices.push({ key: s.key, name: s.name, state: { retT: s.retT, amtRatio: s.amtRatio }, gap, status, decision: dec });
    if (status === 'stale') out.stale = true;
  }
  const main = out.indices.find((x) => x.key === 'sh') ?? out.indices[0];
  out.summary = main ? { name: main.name, action: main.decision.action.label, gap: main.gap } : null;
  const sts = out.indices.map((x) => x.status);
  out.status = sts.includes('stale') ? 'stale' : sts.length && sts.every((x) => x === 'preopen') ? 'preopen' : 'live';
  out.stale = out.status === 'stale';

  // 全球背景 + 跳空预判（失败不影响主信号）
  try {
    const gq = await globalQuotes();
    out.global = { quotes: gq, forecast: forecastGap(gq) };
  } catch (e) {
    out.global = { error: String((e && e.message) || e) };
  }

  // 顺带把状态文件的生成时间透出去，便于前端判断新鲜度
  out.stateGeneratedAt = st.generatedAt ?? null;
  mem = { at: Date.now(), payload: out };
  return out;
}

/** 允许看板页（GitHub Pages 域名）跨域调用 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, cache = 'no-store') =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, ...CORS },
  });

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
    }

    if (url.pathname === '/signal' || url.pathname === '/') {
      try {
        return json(await buildSignal());
      } catch (e) {
        // 与本地服务一致：出错也返回 200 + error 字段，前端按「拿不到实时数据」降级
        return json({ error: String((e && e.message) || e) });
      }
    }

    return new Response('not found', { status: 404, headers: CORS });
  },
};
