// 采集近一周：涨停/跌停家数 + 两市成交额
//   主路径：东财 kline（一次拿全 7 天，含成交额）
//   降级：东财 kline 主机常被限流（UND_ERR_SOCKET），改用
//         日线收盘（新浪/腾讯）+ 最新一日成交额（新浪 hq）+ 涨跌停（东财股池，主机不同、通常可用）
//         并保留缓存里的历史若干天，只刷新最新一天
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fetchJson, fetchText, sleep, sinaQuote, emKline } from './sources.mjs';

const H = { Referer: 'https://quote.eastmoney.com/' };
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const N_DAYS = 7;

const compact = (d) => d.replace(/-/g, '');
const isoOf = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;

/** 指数日线（取成交额与交易日序列）—— 东财，走镜像轮换（机房 IP 下单台时通时断） */
async function kline(secid, lmt = 12) {
  const j = await emKline(
    { secid, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58', klt: '101', fqt: '1', lmt },
    { retries: 2, baseDelay: 1200, timeoutMs: 12000 },
  );
  const rows = (j?.data?.klines ?? []).map((s) => {
    const p = s.split(',');
    return { date: p[0], close: Number(p[2]), amount: Number(p[6]) };
  });
  if (!rows.length) throw new Error('东财 kline 返回空');
  return rows;
}

/** 涨停/跌停股池家数。注意：该接口现在必须显式传 date */
async function poolCount(kind, date) {
  const base = kind === 'zt' ? 'getTopicZTPool' : 'getTopicDTPool';
  const sort = kind === 'zt' ? 'fbt%3Aasc' : 'fund%3Aasc';
  const url = `https://push2ex.eastmoney.com/${base}?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=${sort}&date=${date}`;
  const j = await fetchJson(url, { headers: H, retries: 3, baseDelay: 1200 });
  if (!j?.data) return null;
  return j.data.tc ?? 0;
}

/** 主路径：东财一次取全 7 天 */
async function viaEastmoney() {
  const sh = await kline('1.000001');
  await sleep(600);
  const sz = await kline('0.399001');
  const szByDate = new Map(sz.map((r) => [r.date, r]));

  const rows = [];
  for (const r of sh.slice(-N_DAYS)) {
    const s = szByDate.get(r.date);
    if (!s) continue;
    const zt = await poolCount('zt', compact(r.date));
    await sleep(500);
    const dt = await poolCount('dt', compact(r.date));
    await sleep(500);
    rows.push({ date: r.date, zt, dt, amountYi: (r.amount + s.amount) / 1e8, shClose: r.close });
  }
  if (!rows.length) throw new Error('东财路径无有效行');
  return { rows, via: '东财 kline' };
}

/** 降级路径：只刷新最新交易日，历史沿用缓存 */
async function viaQuotes() {
  const prev = existsSync('market-data.json') ? JSON.parse(readFileSync('market-data.json', 'utf8')) : [];
  if (!prev.length) throw new Error('降级路径需要已有缓存作为历史');

  const sh = await sinaDaily('sh000001');
  await sleep(500);
  const sz = await sinaDaily('sz399001');
  const last = sh.at(-1);
  if (!last) throw new Error('新浪日线为空');
  const s = sz.find((b) => b.d === last.d);
  if (!s) throw new Error('沪深交易日不匹配');

  const iso = isoOf(last.d);
  const q = await sinaQuote(['sh000001', 'sz399001']); // amount 单位：元
  const amountYi = (q.sh000001.amount + q.sz399001.amount) / 1e8;
  if (!isFinite(amountYi) || amountYi <= 0) throw new Error('新浪 hq 成交额异常');

  const zt = await poolCount('zt', last.d);
  await sleep(500);
  const dt = await poolCount('dt', last.d);

  const rows = [...prev.filter((r) => r.date !== iso), { date: iso, zt, dt, amountYi, shClose: last.c }];
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows: rows.slice(-N_DAYS), via: '新浪日线+hq' };
}

/** 新浪日线（只取日期与收盘） */
async function sinaDaily(symbol, datalen = 10) {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${datalen}`;
  const text = await fetchText(url, { headers: { Referer: 'https://finance.sina.com.cn/' }, retries: 3 });
  const j = JSON.parse(text);
  if (!Array.isArray(j)) throw new Error('新浪日线非数组');
  return j.map((b) => ({ d: String(b.day).slice(0, 10).replace(/-/g, ''), c: +b.close }));
}

// ---------- 依次尝试 ----------
let out = null;
for (const [name, run] of [['东财', viaEastmoney], ['降级行情源', viaQuotes]]) {
  try {
    out = await run();
    console.log(`  ${name}路径成功（${out.rows.length} 天）`);
    break;
  } catch (e) {
    console.warn(`  ${name}路径失败: ${e.cause?.code ?? e.message}`);
    await sleep(800);
  }
}

if (!out) {
  if (existsSync('market-data.json')) {
    out = { rows: JSON.parse(readFileSync('market-data.json', 'utf8')), via: '陈旧缓存' };
    console.warn(`  全部源失败，沿用缓存（最后日期 ${out.rows.at(-1)?.date ?? '?'}）`);
  } else {
    console.error('  无任何数据可用');
    process.exit(1);
  }
}

const rows = out.rows;
writeFileSync('market-data.json', JSON.stringify(rows, null, 2), 'utf8');
console.log(`  最新 ${rows.at(-1).date}  涨停 ${rows.at(-1).zt} / 跌停 ${rows.at(-1).dt} / 成交 ${(rows.at(-1).amountYi / 10000).toFixed(2)} 万亿  ← ${out.via}`);
