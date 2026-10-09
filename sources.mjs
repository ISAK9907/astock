// 统一取数层：多源降级 + 磁盘缓存 + 指数退避重试 + 超时
//
// 设计要点：
//  1. 稳定性不来自"找更好的源"，而来自「多源 + 缓存 + 限速」三件套。
//     AKShare / efinance 等库底层打的是同一批公开接口，会一起挂。
//  2. 上游全挂时回退到过期缓存，并标记 stale，让调用方决定是否展示。
//  3. 串行 + 间隔，避免像之前那样触发风控。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

export const BROWSER = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时、退避重试的 JSON 获取。429/5xx 视为可重试。 */
export async function fetchJson(url, opts = {}) {
  const { headers = {}, retries = 3, baseDelay = 700, timeoutMs = 15000 } = opts;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { ...BROWSER, ...headers }, signal: ac.signal });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await sleep(baseDelay * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 带超时、退避重试的文本获取（同花顺返回的是 JSONP 文本）。 */
export async function fetchText(url, opts = {}) {
  const { headers = {}, retries = 3, baseDelay = 700, timeoutMs = 15000 } = opts;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { ...BROWSER, ...headers }, signal: ac.signal });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await sleep(baseDelay * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 东财 kline：镜像主机轮换
// ---------------------------------------------------------------------------
// 2026-09-27 实测：从 GitHub Actions 的 Azure runner 上，东财 kline 表现为**间歇性可达** ——
// 同一批请求里 push2his / 1.push2his / push2delay 返回 200（带真实数据），
// 而 7/21/44/99.push2his 是连接层 000、push2 是 502。另一次探测里六台全 000。
// 本机（家宽）通常一次就通，所以这个问题只在机房 IP 上暴露，且**时通时断**。
//
// 结论：不是「东财封了机房 IP」这种一刀切，而是单台主机不稳定。
// 与其去找替代数据源（实测 KOSPI/日经/台湾/DAX/美元指数在腾讯没有对应代码，
// 新浪只有日经，Yahoo/stooq/investing 都是 403），不如把请求分散到多台镜像上重试 ——
// 六台里任意一台通就能拿到权威数据，且不影响本机现有的抓取行为。
//
// ⚠️ 只用**已实测返回同一份数据**的主机。带编号的镜像并非全都存在（7/21/44/99 是连接失败，
//    不是数据错误，所以放进去也只是浪费一次重试），这里按实测可用性排序。
export const EM_KLINE_HOSTS = ['push2his', '1.push2his', 'push2delay', '2.push2his', 'push2'];
// 'push2' 放最后：它实测返回 502（nginx 反代到上游失败），但结构相同，聊胜于无。

/**
 * 抓东财 kline。按镜像顺序逐个试，任一成功即返回。
 * @param {{secid:string, fields1:string, fields2:string, klt?:string, fqt?:string, lmt:number, end?:string}} p
 * @returns 该接口的 JSON（data.klines 为原始行数组）
 */
export async function emKline(p, opts = {}) {
  const { hosts = EM_KLINE_HOSTS, verbose = false, ...rest } = opts;
  const qs =
    `secid=${p.secid}&fields1=${p.fields1}&fields2=${p.fields2}` +
    `&klt=${p.klt ?? '101'}&fqt=${p.fqt ?? '0'}&end=${p.end ?? '20500101'}&lmt=${p.lmt}`;
  let lastErr;
  for (const h of hosts) {
    try {
      const j = await fetchJson(`https://${h}.eastmoney.com/api/qt/stock/kline/get?${qs}`, {
        headers: { Referer: 'https://quote.eastmoney.com/' },
        // 单台内部仍保留重试，但次数压低：跨主机轮换已经提供了冗余，
        // 在死掉的主机上耗太久会把整轮日更拖长（fetch-global 有 12 条序列）。
        retries: 2,
        baseDelay: 600,
        ...rest,
      });
      if (verbose && h !== hosts[0]) console.log(`     （东财 kline 第 ${hosts.indexOf(h) + 1} 台镜像 ${h} 成功）`);
      return j;
    } catch (e) {
      lastErr = e;
      if (verbose) console.log(`     东财 ${h} 失败：${e.message}`);
    }
  }
  throw new Error(`东财 kline 全部镜像失败（试了 ${hosts.length} 台）：${lastErr?.message}`);
}

const cachePath = (key) => join(CACHE_DIR, `${key.replace(/[^\w.-]/g, '_')}.json`);

export function readCache(key) {
  const p = cachePath(key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(key, payload) {
  writeFileSync(cachePath(key), JSON.stringify({ savedAt: Date.now(), payload }), 'utf8');
}

/**
 * 多源降级获取。
 * @param name     缓存键 / 日志名
 * @param providers [{ label, run: () => Promise<value> }]，按优先级排列
 * @param ttlMs    缓存新鲜期；命中则直接返回，不发请求
 * @returns { value, source, cached, stale, ageMs }
 */
export async function loadWithFallback(name, providers, { ttlMs = 0, verbose = true } = {}) {
  const hit = readCache(name);
  if (hit && ttlMs > 0 && Date.now() - hit.savedAt < ttlMs) {
    return { value: hit.payload, source: 'cache', cached: true, stale: false, ageMs: Date.now() - hit.savedAt };
  }

  const failures = [];
  for (const p of providers) {
    try {
      const value = await p.run();
      if (value == null || (Array.isArray(value) && value.length === 0)) {
        throw new Error('空结果');
      }
      writeCache(name, value);
      if (verbose) console.log(`  ✓ ${name} ← ${p.label}`);
      return { value, source: p.label, cached: false, stale: false, ageMs: 0 };
    } catch (e) {
      const msg = e.cause?.code ?? e.message;
      failures.push(`${p.label}(${msg})`);
      if (verbose) console.log(`  ✗ ${name} ← ${p.label}: ${msg}`);
      await sleep(500);
    }
  }

  // 全部失败 → 回退过期缓存
  if (hit) {
    if (verbose) console.log(`  ! ${name} 全部源失败，回退缓存（${Math.round((Date.now() - hit.savedAt) / 60000)} 分钟前）`);
    return { value: hit.payload, source: 'stale-cache', cached: true, stale: true, ageMs: Date.now() - hit.savedAt };
  }
  throw new Error(`${name} 获取失败且无缓存: ${failures.join(' | ')}`);
}

// ---------------- 数据源适配器 ----------------

/** 中证指数公司官方 —— 中证/上证系列日线，权威且无风控 */
export const csindex = {
  label: 'csindex(官方)',
  daily: async (code, startDate, endDate) => {
    const url = `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${code}&startDate=${startDate}&endDate=${endDate}`;
    const j = await fetchJson(url, { headers: { Referer: 'https://www.csindex.com.cn/' } });
    return (j?.data ?? []).map((r) => ({
      d: `${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6)}`,
      o: r.open,
      c: r.close,
      h: r.high,
      l: r.low,
      v: r.tradingVol,
      amt: r.tradingValue,
    }));
  },
};

/** 腾讯财经 —— 覆盖深证系与分时 */
export const tencent = {
  label: 'tencent',
  /** period: day | week | month */
  kline: async (code, period = 'day', count = 60) => {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`;
    const j = await fetchJson(url, { headers: { Referer: `https://gu.qq.com/${code}/gp` } });
    const node = j?.data?.[code];
    const rows = node?.[`qfq${period}`] ?? node?.[period] ?? [];
    return rows.map((r) => ({ d: r[0], o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] }));
  },
  daily: async (code, _s, _e, count = 60) => tencent.kline(code, 'day', count),
  intraday5d: async (code) => {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${code}`;
    const j = await fetchJson(url, { headers: { Referer: `https://gu.qq.com/${code}/gp` } });
    const node = j?.data?.[code];
    if (!node?.data?.length) return [];
    return [...node.data].reverse().flatMap((day) =>
      day.data.map((row) => {
        const [t, px] = row.split(' ');
        return { d: day.date, t, px: +px };
      }),
    );
  },
};

/** 同花顺 —— 板块/自编指数（bk_ 前缀）。5 分钟档对当日数据有滞后，需用 1 分钟分时补当天 */
export const ths = {
  label: 'ths(同花顺)',
  /** 5 分钟线整年文件，调用方自行截取区间 */
  line5m: async (code, year) => {
    const url = `https://d.10jqka.com.cn/v6/line/${code}/30/${year}.js`;
    const text = await fetchText(url, { headers: { Referer: 'https://q.10jqka.com.cn/' } });
    const data = text.match(/"data":"([^"]*)"/)?.[1] ?? '';
    return data
      .split(';')
      .filter(Boolean)
      .map((row) => {
        const p = row.split(',');
        const ts = p[0]; // YYYYMMDDHHMM
        return {
          d: ts.slice(0, 8), // 统一为 YYYYMMDD
          t: ts.slice(8, 12),
          px: +p[4], // close
        };
      });
  },
  /**
   * 日线整年文件（官方 EOD 记录）。用于给当日 1 分钟分时「定标」——
   * 实测同花顺的 1 分钟分时与日线档在收盘价上会差 ~0.12%（如 883957 在 2026-09-23：
   * 1 分钟档 1912.910 vs 日线档 1915.192），日线档才是权威值。
   */
  lineDay: async (code, year) => {
    const url = `https://d.10jqka.com.cn/v6/line/${code}/01/${year}.js`;
    const text = await fetchText(url, { headers: { Referer: 'https://q.10jqka.com.cn/' } });
    const data = text.match(/"data":"([^"]*)"/)?.[1] ?? '';
    return data
      .split(';')
      .filter(Boolean)
      .map((row) => {
        const p = row.split(',');
        return { d: p[0], o: +p[1], h: +p[2], l: +p[3], c: +p[4] };
      });
  },
  /** 当日 1 分钟分时 */
  minuteToday: async (code) => {
    const url = `https://d.10jqka.com.cn/v6/time/${code}/last.js`;
    const text = await fetchText(url, { headers: { Referer: 'https://q.10jqka.com.cn/' } });
    const date = text.match(/"date":"([^"]*)"/)?.[1];
    const data = text.match(/"data":"([^"]*)"/)?.[1] ?? '';
    if (!date || !data) return [];
    return data
      .split(';')
      .filter(Boolean)
      .map((row) => {
        const p = row.split(',');
        return { d: date, t: p[0], px: +p[1] }; // date 已是 YYYYMMDD
      });
  },
};

/** 新浪财经 —— 分钟级 K 线，可回溯历史（scale=5 上限约 1800 根 ≈ 38 个交易日） */
export const sina = {
  label: 'sina(新浪)',
  /**
   * 分钟 K 线。scale 为分钟数（1/5/15/30/60），datalen 为返回根数（实测 >1800 会返回 null）。
   * 返回 { d:YYYYMMDD, t:HHMM, o,h,l,c, px(=c) }，t 为该 K 线的**结束**时刻。
   */
  klineMin: async (symbol, scale = 5, datalen = 1500) => {
    const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=${scale}&ma=no&datalen=${datalen}`;
    const text = await fetchText(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
    const j = JSON.parse(text);
    if (!Array.isArray(j)) throw new Error('新浪返回非数组（datalen 超限或代码不存在）');
    return j.map((b) => {
      const [date, time] = String(b.day).split(' ');
      return {
        d: date.replace(/-/g, ''),
        t: time.slice(0, 5).replace(':', ''),
        o: +b.open,
        h: +b.high,
        l: +b.low,
        c: +b.close,
        px: +b.close,
      };
    });
  },
};

/**
 * 新浪实时行情（hq.sinajs.cn）—— 只给「最新一天」，但含成交额，且几乎从不被封。
 * 用于在东财 kline 主机被限流时，补出最新交易日的成交额。
 * 注意：返回的字符串是 GBK 编码，名称字段会乱码，故只取数值。
 */
export async function sinaQuote(symbols) {
  const text = await fetchText(`https://hq.sinajs.cn/list=${symbols.join(',')}`, {
    headers: { Referer: 'https://finance.sina.com.cn/' },
    retries: 3,
  });
  const out = {};
  for (const row of text.split('\n')) {
    const m = /hq_str_(\w+)="([^"]*)"/.exec(row);
    if (!m) continue;
    const f = m[2].split(',');
    if (f.length < 10) continue;
    out[m[1]] = {
      open: +f[1], prevClose: +f[2], price: +f[3], high: +f[4], low: +f[5],
      date: f[30] ?? '', volume: +f[8], amount: +f[9], // amount 单位：元
    };
  }
  if (!Object.keys(out).length) throw new Error('新浪 hq 返回空');
  return out;
}

/**
 * 东方财富 push2 实时行情（单只，返回昨收/开/最新）。
 * 为什么需要它：**中证2000（932000）这类 CSI 独有指数新浪 hq 取不到**（`sh932000` 返回空），
 * 但东财 push2 有真实行情（kline 那条路径常被封，quote 这条稳定得多）。
 * ⚠️ f43/f46/f60 是**按标的缩放的整数**，小数位数在 f59 里（中证2000 是 2 位、ETF 是 3 位），
 *    不除这个因子就会得到 306400 这种值。
 */
export async function emQuote(secids) {
  const out = {};
  for (const secid of secids) {
    const url =
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}` +
      `&fields=f43,f46,f57,f58,f59,f60&ut=fa5fd1943c7b386f172d6893dbfba10b`;
    try {
      const j = await fetchJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, retries: 2 });
      const d = j?.data;
      if (!d || d.f43 == null) continue;
      const k = Math.pow(10, d.f59 ?? 2);
      out[secid] = {
        name: d.f58 ?? '',
        code: String(d.f57 ?? ''),
        prevClose: d.f60 == null ? null : d.f60 / k,
        open: d.f46 == null ? null : d.f46 / k,
        price: d.f43 == null ? null : d.f43 / k,
      };
    } catch {
      /* 单个失败不影响其他 */
    }
  }
  if (!Object.keys(out).length) throw new Error('东财 push2 实时行情返回空');
  return out;
}

/** 东方财富 —— 涨停/跌停股池等独有数据（易限流） */
export const eastmoney = {
  label: 'eastmoney',
  ztCount: async (date) => {
    const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${date}`;
    const j = await fetchJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
    return j?.data ? (j.data.tc ?? 0) : null;
  },
  dtCount: async (date) => {
    const url = `https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund%3Aasc&date=${date}`;
    const j = await fetchJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
    return j?.data ? (j.data.tc ?? 0) : null;
  },
};
