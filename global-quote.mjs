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

export const GLOBAL_SECIDS = {
  spx: ['100.SPX', '标普500'],
  kospi: ['100.KS11', '韩国KOSPI'],
  nikkei: ['100.N225', '日经225'],
  twii: ['100.TWII', '台湾加权'],
  gold: ['101.GC00Y', 'COMEX黄金'],
  dxy: ['100.UDI', '美元指数'],
};

/** 回归系数（16 年全样本）：A股跳空 = INTERCEPT + BETA × 亚洲早盘均值 */
export const GAP_MODEL = { INTERCEPT: -0.116, BETA: 0.43 };

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
export async function globalQuotes() {
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
export function forecastGap(q) {
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
