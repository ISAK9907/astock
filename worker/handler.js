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
