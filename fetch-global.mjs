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
// tx=null 表示腾讯没有经核对可用的对应代码
const LIST = [
  { key: 'spx', em: '100.SPX', tx: 'us.INX', name: '标普500', txVerified: true },
  { key: 'ndx', em: '100.NDX', tx: 'us.IXIC', name: '纳斯达克', txVerified: true },
  { key: 'kospi', em: '100.KS11', tx: null, name: '韩国KOSPI' },
  { key: 'nikkei', em: '100.N225', tx: null, name: '日经225' },
  { key: 'twii', em: '100.TWII', tx: null, name: '台湾加权' },
  { key: 'hsi', em: '100.HSI', tx: 'hkHSI', name: '恒生指数', txVerified: true },
  { key: 'gold', em: '101.GC00Y', tx: null, name: 'COMEX黄金' },
  { key: 'xau', em: '122.XAU', tx: null, name: '伦敦金现货' },
  { key: 'dxy', em: '100.UDI', tx: null, name: '美元指数' },
  { key: 'a50', em: '104.CN00Y', tx: null, name: '富时中国A50期指连续' },
  { key: 'xin9', em: '100.XIN9', tx: null, name: '富时中国A50指数' },
  { key: 'dax', em: '100.GDAXI', tx: null, name: '德国DAX' },
];

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
let fromEm = 0, fromTx = 0, fromPrev = 0;

for (const it of LIST) {
  const { key, em, tx, name } = it;
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
    // ---- 3. 旧文件 ----
    if (!bars && old.length) { bars = old.map((b) => ({ ...b })); src = '旧数据'; fromPrev++; }
    if (!bars) missing.push(name);
  }

  if (!bars?.length) { console.warn(`  ✗ ${name} 无任何数据`); continue; }
  out.series[key] = { name, em, tx, bars, src };
  const tag = src.startsWith('东财') ? '✓' : src.startsWith('腾讯') ? '◐' : '↺';
  console.log(`  ${tag} ${name.padEnd(18)} ${src.padEnd(14)} ${String(bars.length).padStart(4)} 根  ${bars[0].d} → ${bars.at(-1).d}`);
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
  bySource: { eastmoney: fromEm, tencent: fromTx, previous: fromPrev },
};
writeFileSync('global-daily.json', JSON.stringify(out), 'utf8');

const total = LIST.length;
const got = Object.keys(out.series).length;
console.log(`\nwrote global-daily.json：覆盖 ${got}/${total} 个品种（东财 ${fromEm} · 腾讯 ${fromTx} · 沿用旧数据 ${fromPrev}）`);
if (missing.length) {
  console.warn(`  ⚠️ 仍缺 ${missing.length} 个：${missing.join('、')}`);
  console.warn(`     这 ${missing.length} 个只有东财 kline 有；等它解封后每天 15:40 的日更会自动补上（无需改代码）。`);
  console.warn('     分析脚本 analyze-global*.mjs 请自行判断样本覆盖，不要假定 12 个品种都在。');
}
