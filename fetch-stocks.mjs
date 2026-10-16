// 取用户实际持仓的日线（个股 + ETF）→ stocks.json
//
// 为什么需要：计划台要判「企稳迹象」，就必须有这几只自己的价格序列。
//   宽基指数的日线（daily-long.json）判不了个股；而个股/ETF 的均线·新低关系必须用它自己的数据算。
//
// ⚠️ 关于"这算不算泄露"：持仓本身用户已确认公开（见 deploy-pages.mjs 的 pa7k3f.json），
//    而历史价格是公开行情数据，所以 stocks.json 可以入库。
//
// 数据源选新浪：东财 push2his 会整段封（UND_ERR_SOCKET，一封几小时），
//    而这个脚本每天都要跑，不能靠一个会长时间不可用的源。
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

/** 用户实际持仓（与 holdings.local.json / pa7k3f.json 保持一致）。只放代码，不放数量/成本 —— 那些在持仓文件里。
 *  2026-10-16 持仓变动：华特气体(sh688268)、中船特气(sh688146) 已清仓，从名单移除。
 *  同一天用户要求「ETF 也要做企稳判定」，于是把两只 ETF 加进来 —— 加之前先用
 *  新浪联想接口按名称反查、并**用收盘价与持仓截图对账**确认代码没认错：
 *    科创200ETF(sh589780) 收盘 1.032 ＝ 截图市值 9,804 ÷ 9500 份
 *    港股互联(sh513770)   收盘 0.331 ＝ 截图市值 4,931.90 ÷ 14900 份 */
const SYMS = [
  ['融捷股份', 'sz002192'],
  ['中矿资源', 'sz002738'],
  ['比亚迪', 'sz002594'],
  ['科创200ETF', 'sh589780'],
  ['港股互联', 'sh513770'],
];

async function kline(sym, n) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${n}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const txt = await r.text();
    // 新浪返回的是**不带引号的键**（近似 JSON），要补引号才能 parse
    const j = JSON.parse(txt.replace(/([{,]\s*)([a-zA-Z_]+)\s*:/g, '$1"$2":'));
    return j.map((x) => ({ d: x.day, c: +x.close })).filter((b) => b.d && isFinite(b.c));
  } finally { clearTimeout(t); }
}

const prev = existsSync('stocks.json') ? JSON.parse(readFileSync('stocks.json', 'utf8')) : null;
const out = { generatedAt: new Date().toISOString(), source: '新浪财经日线（前复权口径按新浪默认）', series: {} };
let ok = 0, reused = 0;

console.log('  名称        代码        根数   区间                      最新');
for (const [name, sym] of SYMS) {
  let bars = [];
  try { bars = await kline(sym, 1600); } catch (e) { console.warn(`  ! ${name} 抓取失败：${String(e.message).slice(0, 40)}`); }
  const old = prev?.series?.[sym];
  // 新鲜度守卫：新数据末日不能比旧的还旧，否则保留旧的（和 fetch-valuation 同一条铁律）
  if (bars.length >= 200 && (!old || bars.at(-1).d >= old.bars.at(-1).d)) {
    out.series[sym] = { name, bars };
    ok++;
    console.log(`  ✓ ${name.padEnd(9)} ${sym.padEnd(11)} ${String(bars.length).padStart(5)}  ${bars[0].d}~${bars.at(-1).d}  ${bars.at(-1).c}`);
  } else if (old) {
    out.series[sym] = old;
    reused++;
    console.log(`  ↺ ${name.padEnd(9)} ${sym.padEnd(11)} 沿用旧数据（${old.bars.length} 根，末日 ${old.bars.at(-1).d}）`);
  } else {
    console.warn(`  ✗ ${name.padEnd(9)} ${sym.padEnd(11)} 无可用数据`);
  }
  await new Promise((s) => setTimeout(s, 500)); // 别把新浪打急
}

if (!Object.keys(out.series).length) { console.error('✗ 一只都没拿到，保留原文件'); process.exit(1); }
writeFileSync('stocks.json', JSON.stringify(out), 'utf8');
console.log(`\nwrote stocks.json  成功 ${ok} / 沿用 ${reused} / 共 ${SYMS.length}`);
