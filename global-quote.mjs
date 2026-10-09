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

const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function getText(url, referer) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

/**
 * 东财 push2 被封时的兜底源。**覆盖不全，这是有意的** —— 拿不到的项就留 null，
 * 宁可少给一条依据，也不要用别的东西冒充。
 *   · 腾讯 qt.gtimg.cn `us.INX` —— 标普500，现价/昨收/今开/涨跌幅齐全（字段 3/4/5/32）
 *   · 新浪 hq.sinajs.cn `hf_GC` —— COMEX黄金，字段 [0]=现价 [7]=昨收
 *   · 新浪 `int_nikkei` —— 日经，只有现价+涨跌额，**推不出今开**，所以只用于展示，
 *     不参与跳空模型（模型吃的是「今开/昨收」，用现价冒充会静默改变输入口径）
 * 韩国 KOSPI、台湾加权在本地拿不到（Yahoo 家里 403），故兜底时 asia 会算不出来 →
 * forecastGap 自动退化成「仅美股」，那正是文档里写好的降级路径。
 */
async function fallbackQuotes() {
  const out = { spx: null, kospi: null, nikkei: null, twii: null, gold: null, dxy: null };
  try {
    const t = await getText('https://qt.gtimg.cn/q=us.INX', 'https://gu.qq.com/');
    const f = (/="([^"]*)"/.exec(t)?.[1] ?? '').split('~');
    const num = (v) => (v == null || v === '' || v === '-' ? null : +v);
    if (num(f[3])) {
      out.spx = { name: '标普500', price: num(f[3]), prevClose: num(f[4]), open: num(f[5]), chg: num(f[32]), date: '', asOf: '', src: '腾讯' };
    }
  } catch { /* 单个源失败不影响其他 */ }
  try {
    const t = await getText('https://hq.sinajs.cn/list=hf_GC', 'https://finance.sina.com.cn/');
    const f = (/="([^"]*)"/.exec(t)?.[1] ?? '').split(',');
    const price = +f[0], prev = +f[7];
    if (price > 0 && prev > 0) {
      out.gold = { name: 'COMEX黄金', price, prevClose: prev, open: null, chg: (price / prev - 1) * 100, date: f[12] ?? '', asOf: f[6] ?? '', src: '新浪' };
    }
  } catch { /* 同上 */ }
  try {
    const t = await getText('https://hq.sinajs.cn/list=int_nikkei', 'https://finance.sina.com.cn/');
    const f = (/="([^"]*)"/.exec(t)?.[1] ?? '').split(',');
    const price = +f[1], diff = +f[2];
    if (price > 0) {
      // 只有涨跌额 → 反推昨收；open 留 null（没有今开，不进模型）
      out.nikkei = { name: '日经225', price, prevClose: price - diff, open: null, chg: +f[3], date: localIso(new Date()), asOf: '', src: '新浪(无今开)' };
    }
  } catch { /* 同上 */ }
  if (!Object.values(out).some(Boolean)) throw new Error('兜底源也全部失败');
  return out;
}

/** 取全球实时行情。东财这些字段都是 ×100 的整数（指数点位 ×100，涨跌幅 ×100）
 *  注意：ulist 里「今开」是 f17（不是 f46，f46 只在单品种 stock/get 里返回） */
export async function globalQuotes() {
  const ids = Object.values(GLOBAL_SECIDS).map(([s]) => s).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f12,f14,f17,f18,f86,f124&ut=${UT}`;
  try {
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
        src: '东财 push2',
      };
    }
    if (!Object.values(out).some(Boolean)) throw new Error('东财全球行情返回空');
    return out;
  } catch (e) {
    // 东财 push2 会整段封（UND_ERR_SOCKET，一封几小时），封住时不能把「预判跳空」整段丢掉
    console.log(`  ! 东财 push2 全球行情不可用（${String(e.cause?.code ?? e.message).slice(0, 30)}），转兜底源`);
    const fb = await fallbackQuotes();
    const got = Object.entries(fb).filter(([, v]) => v).map(([k, v]) => `${k}(${v.src})`);
    console.log(`  ! 兜底只取到：${got.join(' ')} —— 韩国/台湾在本地拿不到，跳空预判会退化为「仅美股」`);
    return fb;
  }
}

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
    // ⚠️ 「亚洲未开盘」和「亚洲开盘价取不到」是两回事，不能都写成前者 ——
    //    兜底源（腾讯/新浪 int_*）拿不到今开，但那时亚洲明明已经开着了。
    const asiaSeen = ['kospi', 'nikkei', 'twii'].some((k) => q[k]);
    predicted = us < 0 ? us * 0.349 : us * 0.142;
    basis = asiaSeen ? '仅美股（亚洲开盘价取不到）' : '仅美股（亚洲未开盘）';
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
