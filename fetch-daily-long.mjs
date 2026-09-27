// 拉取长历史指数日线（跳空分析 + 盘前信号的 T 日状态）→ daily-long.json
//
// 三级数据源，按可靠性依次降级：
//   1. 东财 kline klt=101 fqt=0 —— 4000 根全字段（含 amount），但 push2his/push2 的
//      kline 路径会被整段封（UND_ERR_SOCKET、bytesRead=0），一封就是几小时。
//   2. 同花顺 d.10jqka.com.cn v6/line/{code}/01/{year}.js —— 一整年的 o/h/l/c，
//      几乎从不限流。**没有成交额**，且部分指数（深证成指、沪深300）会比新浪滞后一天，
//      所以只用来补「旧文件末日 → 今天」之间的缺口。
//   3. 新浪 hq.sinajs.cn —— 只有最新一天，但含成交额，用来覆盖末日，
//      保证 T 日一定带上 amount（signal.mjs 算量能比要用）。
//
// 两条铁律（之前就是栽在这上面）：
//   · 任何一个指数失败都不能让脚本整体抛错 —— 否则 daily-long.json 一直不更新，
//     而 build-dashboard.mjs 的 T_DATE = min(market-data, daily-long) 会把整个
//     盘前信号面板的 T 日状态一直钉在昨天。
//   · 抓不到就把旧历史原样写回，绝不因为一次失败丢数据；新数据比旧文件还旧则拒绝写入。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchJson, sleep, sinaQuote, ths, emKline } from './sources.mjs';

const H = { Referer: 'https://quote.eastmoney.com/' };
// 新浪对沪市指数给「手」、对深市指数给「股」，东财一律是「手」；用 amount/volume 比值
// 核过：上证 1786 vs 1787（同口径）、深证 16.5 vs 1590（差约 100 倍）。
const IDX = [
  { key: 'sh', name: '上证指数', em: '1.000001', sina: 'sh000001', ths: 'sh_1A0001', vDiv: 1 },
  { key: 'szcz', name: '深证成指', em: '0.399001', sina: 'sz399001', ths: 'sz_399001', vDiv: 100 },
  { key: 'cyb', name: '创业板指', em: '0.399006', sina: 'sz399006', ths: 'sz_399006', vDiv: 100 },
  { key: 'hs300', name: '沪深300', em: '1.000300', sina: 'sh000300', ths: 'sh_1B0300', vDiv: 1 },
];

const iso = (d8) => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
const pad2 = (n) => String(n).padStart(2, '0');
const todayIso = () => {
  const n = new Date();
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
};
// 同花顺偶尔会返回 o/h/l 全为 0 的残缺 bar（实测 sz_399300 最新一天就是），必须挡掉
const saneBar = (b) =>
  b && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0 &&
  b.h >= Math.max(b.o, b.c) * 0.999 && b.l <= Math.min(b.o, b.c) * 1.001;

const prev = existsSync('daily-long.json') ? JSON.parse(readFileSync('daily-long.json', 'utf8')) : null;
const out = { generatedAt: new Date().toISOString(), series: {} };
const today = todayIso();
const used = { em: 0, ths: 0, sina: 0 };

// ---------- 新浪兜底（一次取齐，成功就用）----------
let sina = null;
try {
  sina = await sinaQuote(IDX.map((x) => x.sina));
  console.log(`  新浪 hq：最新交易日 ${[...new Set(Object.values(sina).map((v) => v.date))].join('/')}`);
} catch (e) {
  console.warn(`  ! 新浪 hq 不可用：${e.message}`);
}

for (const idx of IDX) {
  const { key, name, em, sina: sinaSym, ths: thsCode, vDiv } = idx;
  let bars = null;
  let src = '';

  // ---- 一级：东财（镜像轮换：机房 IP 下单台时通时断，见 sources.mjs 的 emKline）----
  try {
    const j = await emKline(
      { secid: em, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58', klt: '101', fqt: '0', lmt: 4000 },
      { retries: 2, baseDelay: 2000, timeoutMs: 20000 },
    );
    const k = j?.data?.klines ?? [];
    if (k.length) {
      bars = k.map((s) => {
        const p = s.split(',');
        return { d: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5], amt: +p[6] };
      });
      src = '东财';
      used.em++;
      console.log(`  ✓ ${name.padEnd(8)} 东财  ${String(bars.length).padStart(4)} 根  ${bars[0].d} → ${bars.at(-1).d}`);
    }
  } catch (e) {
    console.warn(`  ! ${name.padEnd(8)} 东财失败（${e.cause?.code ?? e.name}）`);
  }

  if (!bars) {
    // ---- 降级：旧历史打底 ----
    const old = prev?.series?.[key]?.bars ?? [];
    bars = old.map((b) => ({ ...b }));
    const from = bars.at(-1)?.d ?? null;
    let gapFilled = 0;

    // ---- 二级：同花顺补缺口 ----
    if (from) {
      const y0 = +from.slice(0, 4);
      const y1 = +today.slice(0, 4);
      for (let y = y0; y <= y1; y++) {
        let rows = [];
        try {
          rows = await ths.lineDay(thsCode, y);
        } catch (e) {
          console.warn(`     同花顺 ${thsCode}/${y} 失败：${String(e.message).slice(0, 40)}`);
        }
        for (const r of rows) {
          const d = iso(String(r.d));
          if (d <= from || d > today) continue;      // 只补旧文件之后的
          if (!saneBar(r)) continue;                 // 挡掉 o/h/l=0 的残缺 bar
          const i = bars.findIndex((b) => b.d === d);
          // 同花顺没有 v/amt：已有该日就保留原值，新补的日子置 null
          const row = { d, o: r.o, c: r.c, h: r.h, l: r.l, v: i >= 0 ? bars[i].v : null, amt: i >= 0 ? bars[i].amt : null };
          if (i >= 0) bars[i] = row; else bars.push(row);
          gapFilled++;
        }
        await sleep(400);
      }
      bars.sort((a, b) => (a.d < b.d ? -1 : 1));
      if (gapFilled) { used.ths++; console.log(`     同花顺补了 ${gapFilled} 个交易日（无成交额）`); }
    }

    // ---- 三级：新浪覆盖末日（带成交额）----
    const q = sina?.[sinaSym];
    if (q && q.date && q.price > 0) {
      const row = {
        d: q.date, o: +q.open.toFixed(3), c: +q.price.toFixed(3),
        h: +q.high.toFixed(3), l: +q.low.toFixed(3),
        v: Math.round(q.volume / vDiv), amt: +q.amount.toFixed(1),
      };
      if (saneBar(row) && row.d <= today) {
        const i = bars.findIndex((b) => b.d === row.d);
        if (i >= 0) bars[i] = row; else if (!bars.length || row.d > bars.at(-1).d) bars.push(row);
        used.sina++;
        console.log(`     新浪覆盖末日 ${row.d} 收 ${row.c}（含成交额）`);
      } else {
        console.warn(`     新浪明末日数据不合法，已跳过`);
      }
    }

    src = gapFilled && used.sina ? '同花顺+新浪' : gapFilled ? '同花顺' : '新浪';
    console.log(`  ↺ ${name.padEnd(8)} ${src.padEnd(9)} ${String(bars.length).padStart(4)} 根  ${bars[0]?.d ?? '-'} → ${bars.at(-1)?.d ?? '-'}`);
  }

  if (!bars.length) { console.warn(`  ✗ ${name} 无任何可用数据，跳过`); continue; }
  out.series[key] = { name, bars, src };
}

// ---------- 自检 ----------
const lastDates = Object.values(out.series).map((s) => s.bars.at(-1)?.d).filter(Boolean);
const uniq = [...new Set(lastDates)];
const prevLast = prev ? Object.values(prev.series).map((s) => s.bars.at(-1)?.d).sort().at(-1) : null;
if (uniq.length > 1) console.warn(`  ⚠️ 各指数末日不一致：${uniq.join(', ')}`);
if (prevLast && uniq.some((d) => d < prevLast)) {
  console.error(`  ✗ 新数据(${uniq.join(',')})比旧文件(${prevLast})还旧，拒绝覆盖，保留原文件`);
  process.exit(1);
}
if (!Object.keys(out.series).length) {
  console.error('  ✗ 一个指数都没抓到，保留原文件');
  process.exit(1);
}
out.source = used.em === IDX.length
  ? 'eastmoney kline klt=101 fqt=0（不复权）'
  : `eastmoney 为主；东财不可用部分：同花顺 v6/line（o/h/l/c，无成交额）补缺口 + 新浪 hq（含成交额）覆盖末日`;

writeFileSync('daily-long.json', JSON.stringify(out), 'utf8');
const missingAmt = Object.values(out.series).reduce((s, x) => s + x.bars.filter((b) => !b.amt).length, 0);
console.log(`\nwrote daily-long.json（东财 ${used.em} / 同花顺 ${used.ths} / 新浪 ${used.sina}，末日 ${uniq.join(',')}）`);
if (missingAmt) console.warn(`  ⚠️ 有 ${missingAmt} 根 bar 缺成交额（同花顺补的日子）；signal.mjs 会按有效样本数判断，不足 15/20 时不输出量能比`);
