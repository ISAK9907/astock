// 工具二的数据源：中证官方指数历史（**价格 + 市盈率一次取到**）→ valuation.json
//
// 为什么用中证官方而不是东财：
//   ① 东财 push2 会整段封（UND_ERR_SOCKET，一封几小时），而这个看板天天要更新；
//   ② 中证官方的 index-perf 一次调用同时返回 OHLC 和 peg（市盈率），
//      不用「价格取一处、估值取另一处」再对齐日期 —— 少一个出错点；
//   ③ 官方数据是**指数编制方自己发的**，口径最正。
//
// ⚠️ 字段名 `peg` 是它 API 的命名，但值就是**市盈率**（沪深300 ≈ 13，中证2000 ≈ 39），
//    不是 PEG。别被名字骗了 —— 这一点是靠量级核对确认的。
//
// ⚠️ 中证2000 这类指数会在基日前返回一行 close=1000、open=null 的**基日占位行**，
//    必须滤掉，否则「价格分位」会被一个假数据点污染。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  Referer: 'https://www.csindex.com.cn/',
};
const START = '20110101';

/**
 * 「专注几个标的」——这条配置就是工具二的全部标的范围。
 * 选这 6 个是覆盖风格：大盘 / 中盘 / 小盘 / 成长 / 红利 / 综合基准。
 * 想再聚焦就删到 2~3 个，其余代码不用改。
 */
const INDEXES = [
  { code: '000001', name: '上证指数', tag: '综合基准' },
  { code: '000300', name: '沪深300', tag: '大盘' },
  { code: '000905', name: '中证500', tag: '中盘' },
  { code: '932000', name: '中证2000', tag: '小盘' },
  { code: '000688', name: '科创50', tag: '成长' },
  { code: '930599', name: '中证红利', tag: '红利/价值' },
];

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const ymd = today.replace(/-/g, '');

async function fetchIndex(code) {
  const url = `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${code}&startDate=${START}&endDate=${ymd}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(url, { headers: H, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return j?.data ?? [];
  } finally { clearTimeout(t); }
}

// 旧文件打底：任何一个指数失败都不能让整体丢数据（和 fetch-daily-long 同一条铁律）
const prev = existsSync('valuation.json') ? JSON.parse(readFileSync('valuation.json', 'utf8')) : null;
const out = { generatedAt: new Date().toISOString(), source: '中证指数官网 index-perf（价格+市盈率）', window: { start: START, end: ymd }, series: {} };
let okN = 0, reuseN = 0;

console.log(`区间 ${START} → ${ymd}\n`);
for (const idx of INDEXES) {
  let rows = [];
  try {
    rows = await fetchIndex(idx.code);
  } catch (e) {
    console.warn(`  ! ${idx.name.padEnd(8)} 抓取失败：${String(e.message).slice(0, 50)}`);
  }
  // 只保留「有真实开盘价」的行 —— 滤掉基日占位行与停牌空行
  const bars = rows
    .filter((r) => r.open > 0 && r.close > 0)
    .map((r) => ({
      d: `${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6, 8)}`,
      c: +r.close,
      peg: r.peg == null ? null : +r.peg, // 市盈率
    }));

  if (bars.length >= 100) {
    // 新鲜度守卫：新数据末日不能比旧文件还旧（否则保留旧的）
    const oldLast = prev?.series?.[idx.code]?.bars?.at(-1)?.d ?? '';
    if (oldLast && bars.at(-1).d < oldLast) {
      console.warn(`  ! ${idx.name.padEnd(8)} 新数据(${bars.at(-1).d})比旧文件(${oldLast})还旧，保留旧数据`);
      out.series[idx.code] = prev.series[idx.code];
      reuseN++;
      continue;
    }
    const withPe = bars.filter((b) => b.peg != null).length;
    out.series[idx.code] = { name: idx.name, tag: idx.tag, bars };
    okN++;
    console.log(
      `  ✓ ${idx.name.padEnd(8)} ${String(bars.length).padStart(5)} 根  ${bars[0].d} → ${bars.at(-1).d}   ` +
        `PE ${String(bars.at(-1).peg ?? '—').padStart(6)}   有 PE 的行 ${withPe}（${((withPe / bars.length) * 100).toFixed(0)}%）`,
    );
  } else {
    const old = prev?.series?.[idx.code];
    if (old?.bars?.length) {
      out.series[idx.code] = old;
      reuseN++;
      console.warn(`  ↺ ${idx.name.padEnd(8)} 本次只拿到 ${bars.length} 行，沿用旧数据（${old.bars.length} 根）`);
    } else {
      console.warn(`  ✗ ${idx.name.padEnd(8)} 无可用数据（${bars.length} 行），跳过`);
    }
  }
  await new Promise((s) => setTimeout(s, 600)); // 别把官网打急
}

if (!Object.keys(out.series).length) {
  console.error('✗ 一个指数都没拿到，保留原文件');
  process.exit(1);
}
writeFileSync('valuation.json', JSON.stringify(out, null, 0), 'utf8');
console.log(`\nwrote valuation.json  成功 ${okN} / 沿用旧数据 ${reuseN} / 共 ${INDEXES.length}`);
