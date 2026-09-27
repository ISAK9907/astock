// 抓全球市场长历史日线（做「全球 → A 股开盘」的因子分析）→ global-daily.json
//
// ⚠️ 2026-09-24 事故：东财把 kline 路径整段封了（push2his 与 push2 都返回
//    UND_ERR_SOCKET、bytesRead=0；同一台 push2 上的 ulist 路径却正常），12 个品种
//    全部失败，而本脚本当时「无条件写文件」，直接把几年前攒下的历史清成了
//    {"series":{}}。已改为：逐品种 merge + 抓不到就保留旧数据 + 全失败拒绝写入。
//
// 三级源（逐品种独立降级，互不影响）：
//   1. 东财 kline（4000 根，权威）
//   2. 腾讯 fqkline（1000 根 ≈ 4 年）—— 只覆盖 3 个品种，代码映射见下表
//   3. 旧文件里已有的那一份（merge 而非替换，所以反复跑会逐步攒长历史）
//
// 东财解封后无需改代码：每天 15:40 的日更会照常先试东财，成功即用 4000 根覆盖腾讯那 1000 根。
//
// ⚠️ 腾讯代码必须按「同一指数」核对，不能照名字套。实测东财 `100.NDX` 名为「纳斯达克」
//    但数值对应腾讯 `us.IXIC`（26936.04），而腾讯 `us.NDX` 是 11.73 的另一个标的 ——
//    套错会静默写入差几千倍的脏数据。下表三组都用最新收盘价逐个核对过。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchJson, sleep, tencent, emKline } from './sources.mjs';

const H = { Referer: 'https://quote.eastmoney.com/' };
// tx=null 表示腾讯没有经核对可用的对应代码；yf=Yahoo Finance 代码；sf=新浪全球期货代码
const LIST = [
  { key: 'spx', em: '100.SPX', tx: 'us.INX', yf: '^GSPC', name: '标普500', txVerified: true },
  { key: 'ndx', em: '100.NDX', tx: 'us.IXIC', yf: '^IXIC', name: '纳斯达克', txVerified: true },
  { key: 'kospi', em: '100.KS11', tx: null, yf: '^KS11', name: '韩国KOSPI' },
  { key: 'nikkei', em: '100.N225', tx: null, yf: '^N225', name: '日经225' },
  { key: 'twii', em: '100.TWII', tx: null, yf: '^TWII', name: '台湾加权' },
  { key: 'hsi', em: '100.HSI', tx: 'hkHSI', yf: '^HSI', name: '恒生指数', txVerified: true },
  { key: 'gold', em: '101.GC00Y', tx: null, yf: 'GC=F', name: 'COMEX黄金' },
  { key: 'xau', em: '122.XAU', tx: null, yf: 'XAUUSD=X', name: '伦敦金现货' },
  { key: 'dxy', em: '100.UDI', tx: null, yf: 'DX-Y.NYB', name: '美元指数' },
  // ⚠️ a50 是「期指连续」，xin9 是「A50 指数」—— 两个不同标的。
  //    一开始两条都给了 Yahoo XIN9.FGI，结果近期区间变成同一条序列
  //    （实测云端 2026-09-24 两者都是 14310.03，而本机东财期指是 14271）。
  //    Yahoo 没有 A50 期指连续，改用新浪 GlobalFuturesService 的 CHA50CFD —— 本机与 runner 实测都通。
  { key: 'a50', em: '104.CN00Y', tx: null, yf: null, sf: 'CHA50CFD', name: '富时中国A50期指连续' },
  { key: 'xin9', em: '100.XIN9', tx: null, yf: 'XIN9.FGI', name: '富时中国A50指数' },
  { key: 'dax', em: '100.GDAXI', tx: null, yf: '^GDAXI', name: '德国DAX' },
];

// ---------------------------------------------------------------------------
// 第三条降级链：Yahoo Finance
//   为什么需要：东财 kline 从 GitHub Actions 的 Azure runner 上时通时断（甚至连续两次全挂），
//   而腾讯只覆盖 12 个品种里的 3 个（spx/ndx/hsi），新浪只有日经 —— 剩下 6 个
//   （KOSPI / 日经 / 台湾加权 / 富时A50指数 / 德国DAX / 美元指数）在云端会永久冻结。
//   实测：Yahoo 从 runner 上返回 200（本机是 403，所以**这段代码无法在本地验证**，
//   只能推上去跑云端看覆盖行 —— 见 .github/workflows/probe-sources.yml）。
//
// ⚠️ 错标的陷阱：腾讯的 us.UDI 是「股息收益ETF」、us.DAX 是「DAX德国指数ETF」，
//    代码存在但完全是另一个东西。Yahoo 代码同样可能指向 ETF 而非指数，而这里**无法本地校验**，
//    所以加了 saneAgainstOld()：只要旧数据里存在同一天的收盘价，新数据就必须在同量级，
//    否则整条丢弃并大声报错 —— 宁可留旧数据，也不能静默写进差几百倍的脏值。
// ---------------------------------------------------------------------------
const YF_H = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

async function yahooDaily(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1d`;
  const r = await fetch(url, { headers: YF_H, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const o = await r.json();
  const res = o?.chart?.result?.[0];
  const ts = res?.timestamp ?? [];
  const q = res?.indicators?.quote?.[0] ?? {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null) continue; // Yahoo 会给出 null 占位（停牌/无数据）
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    rows.push({ d, o: q.open?.[i] ?? c, c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, v: q.volume?.[i] ?? 0 });
  }
  if (!rows.length) throw new Error('无有效日线');
  return rows;
}

/**
 * 新浪全球期货日线（JSONP）。用于 a50 期指连续 —— Yahoo 只有 A50 指数，没有期指连续。
 * 返回体形如：   var _=([{"date":"2016-09-27","open":"1342.000",...}])
 */
async function sinaGlobalFutures(sym) {
  const url =
    `https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/` +
    `GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${encodeURIComponent(sym)}`;
  const r = await fetch(url, { headers: { ...YF_H, Referer: 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  const m = /var _=\((\[.*\]|null)\)/s.exec(txt);
  if (!m || m[1] === 'null') throw new Error('无数据');
  const arr = JSON.parse(m[1]);
  const rows = arr
    .map((x) => ({ d: x.date, o: +x.open, c: +x.close, h: +x.high, l: +x.low, v: +x.volume || 0 }))
    .filter((b) => b.d && isFinite(b.c) && b.c > 0);
  if (!rows.length) throw new Error('无有效日线');
  return rows.sort((a, b) => (a.d < b.d ? -1 : 1));
}

/**
 * 与旧数据核对量级：找最近一个两边都有的日期，比收盘价。
 * 差得太远说明抓错了标的（ETF/期货/另一个指数），直接拒绝。
 */
function saneAgainstOld(old, rows, name) {
  if (!old.length || !rows.length) return true;
  const oldMap = new Map(old.map((b) => [b.d, b.c]));
  for (let i = rows.length - 1; i >= 0 && i > rows.length - 30; i--) {
    const oc = oldMap.get(rows[i].d);
    if (oc > 0) {
      const dev = rows[i].c / oc - 1;
      if (Math.abs(dev) > 0.15) {
        console.warn(`  ✗ ${name} 标的核对失败：${rows[i].d} 新值 ${rows[i].c} vs 旧值 ${oc}（偏差 ${(dev * 100).toFixed(1)}%）—— 丢弃这条新数据，保留旧数据`);
        return false;
      }
      return true;
    }
  }
  return true; // 没有重叠日期就无法核对，放行（首次抓取时属于这种情况）
}


const prev = existsSync('global-daily.json') ? JSON.parse(readFileSync('global-daily.json', 'utf8')) : null;
const prevSeries = prev?.series ?? {};
// 合并策略：**新抓到的区间内以新数据为准**，旧数据只用来补更早的历史。
// 不能简单地「新的覆盖旧的」——否则上一轮误存的半截 bar 会永远留在文件里。
const mergeBars = (oldBars = [], newBars = []) => {
  if (!newBars.length) return oldBars;
  const cutoff = newBars[0].d;
  const older = oldBars.filter((b) => b.d < cutoff);
  const m = new Map([...older, ...newBars].map((b) => [b.d, b]));
  return [...m.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
};

// 丢掉「还没收盘」的半截 bar。数据源对当日盘中会给出一根进行中的 bar，成交量只有正常值的零头。
// 实测 2026-09-24 21:30（北京时间）：标普当日量仅前一日的 2.8%、纳指 15%，而恒生已收盘为 87%。
// 用「最近 20 个完整交易日的成交量中位数」作基准，低于一半即判定为半截 bar 并丢弃，
// 次日拿到完整数据后会自然补上。没有成交量字段时不做判断（宁可留着也不误删）。
const dropPartial = (bars) => {
  if (bars.length < 8) return bars;
  const last = bars.at(-1);
  if (!(last.v > 0)) return bars;
  const recent = bars.slice(-21, -1).map((b) => b.v).filter((v) => v > 0);
  if (recent.length < 5) return bars;
  const med = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
  if (last.v < med * 0.5) {
    console.log(`     丢弃未收盘的半截 bar ${last.d}（量 ${last.v} = 20日中位数的 ${((last.v / med) * 100).toFixed(1)}%）`);
    return bars.slice(0, -1);
  }
  return bars;
};

const out = { generatedAt: new Date().toISOString(), series: {} };
const missing = [];
let fromEm = 0, fromTx = 0, fromSf = 0, fromYf = 0, fromPrev = 0;

for (const it of LIST) {
  const { key, em, tx, yf, sf, name } = it;
  const old = prevSeries[key]?.bars ?? [];
  let bars = null, src = '';

  // ---- 1. 东财（镜像轮换：机房 IP 下单台时通时断，见 sources.mjs 的 emKline）----
  try {
    const j = await emKline(
      { secid: em, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58', klt: '101', fqt: '0', lmt: 4000 },
      { retries: 2, baseDelay: 1500, verbose: true },
    );
    const k = j?.data?.klines ?? [];
    if (!k.length) throw new Error('返回空');
    const rows = k.map((s) => {
      const p = s.split(',');
      return { d: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] };
    });
    bars = mergeBars(old, dropPartial(rows)); // 东财只给 4000 根，合并可留住更早的
    src = '东财';
    fromEm++;
  } catch (e) {
    // ---- 2. 腾讯 ----
    if (tx) {
      try {
        const rows = await tencent.kline(tx, 'day', 1000);
        if (rows.length) {
          bars = mergeBars(old, dropPartial(rows));
          src = `腾讯(${tx})`;
          fromTx++;
        }
      } catch (e2) {
        console.warn(`  ! ${name} 腾讯也失败：${String(e2.message).slice(0, 40)}`);
      }
    }
    // ---- 3. 新浪全球期货（用于 a50 期指连续；两端实测都通）----
    if (!bars && sf) {
      try {
        const rows = await sinaGlobalFutures(sf);
        if (saneAgainstOld(old, rows, name)) {
          bars = mergeBars(old, dropPartial(rows));
          src = `新浪(${sf})`;
          fromSf++;
        }
      } catch (e3) {
        console.warn(`  ! ${name} 新浪期货也失败：${String(e3.message).slice(0, 40)}`);
      }
    }
    // ---- 4. Yahoo（云端可达；本机 403，所以只在上面几级都失败时才会走到）----
    if (!bars && yf) {
      try {
        const rows = await yahooDaily(yf);
        if (saneAgainstOld(old, rows, name)) {
          bars = mergeBars(old, dropPartial(rows));
          src = `Yahoo(${yf})`;
          fromYf++;
        }
      } catch (e4) {
        console.warn(`  ! ${name} Yahoo 也失败：${String(e4.message).slice(0, 40)}`);
      }
    }
    // ---- 5. 旧文件 ----
    if (!bars && old.length) { bars = old.map((b) => ({ ...b })); src = '旧数据'; fromPrev++; }
    if (!bars) missing.push(name);
  }

  if (!bars?.length) { console.warn(`  ✗ ${name} 无任何数据`); continue; }
  out.series[key] = { name, em, tx, yf, sf, bars, src };
  const tag = src.startsWith('东财') ? '✓' : src.startsWith('腾讯') ? '◐' : src.startsWith('新浪') ? '◆' : src.startsWith('Yahoo') ? '◑' : '↺';
  console.log(`  ${tag} ${name.padEnd(18)} ${src.padEnd(16)} ${String(bars.length).padStart(4)} 根  ${bars[0].d} → ${bars.at(-1).d}`);
  await sleep(700);
}

// ---------- 防覆盖 ----------
if (!Object.keys(out.series).length) {
  console.error('\n✗ 一个品种都没抓到，拒绝写入 global-daily.json（保留原文件）');
  process.exit(1);
}
// 把覆盖度写进文件，分析脚本据此自行判断样本是否够用
out.coverage = {
  got: Object.keys(out.series).length,
  total: LIST.length,
  missing: missing.map((n) => LIST.find((x) => x.name === n)?.key).filter(Boolean),
  bySource: { eastmoney: fromEm, tencent: fromTx, sina: fromSf, yahoo: fromYf, previous: fromPrev },
  // 静默冻结是这套降级链最危险的失败模式（作业报绿、数据却停更），
  // 所以把「哪些品种在沿用旧数据、旧到哪天」直接写进文件，让看板能显式提示。
  stale: Object.entries(out.series)
    .filter(([, v]) => v.src === '旧数据')
    .map(([k, v]) => ({ key: k, name: v.name, last: v.bars.at(-1)?.d ?? null })),
};
writeFileSync('global-daily.json', JSON.stringify(out), 'utf8');

const total = LIST.length;
const got = Object.keys(out.series).length;
console.log(`\nwrote global-daily.json：覆盖 ${got}/${total} 个品种（东财 ${fromEm} · 腾讯 ${fromTx} · 新浪 ${fromSf} · Yahoo ${fromYf} · 沿用旧数据 ${fromPrev}）`);
if (out.coverage.stale.length) {
  console.warn(`  ⚠️ 沿用旧数据的 ${out.coverage.stale.length} 个：${out.coverage.stale.map((s) => `${s.name}(至${s.last})`).join('、')}`);
  console.warn('     它们只有东财 kline 有完整历史；东财恢复后会自动补上（无需改代码）。');
}
if (missing.length) {
  console.warn(`  ⚠️ 仍缺 ${missing.length} 个：${missing.join('、')}`);
  console.warn('     分析脚本 analyze-global*.mjs 请自行判断样本覆盖，不要假定 12 个品种都在。');
}
