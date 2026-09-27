// 日更跌停三维：东财股池优先（秒级），失败降级到 baostock 全市场扫描（约 25 分钟）
// 结果并入 dt-counts.json（与 baostock 历史回填同一结构）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetchJson, sleep } from './sources.mjs';

const UT = '7eea3edcaed734bea9cbfc24409ed989';
const BIG = 3e10, MID = 5e9;
const NUM = ['dt', 'n', 'dtCap', 'allCap', 'big', 'mid', 'small', 'mBig', 'mMid', 'mSmall', 'mem', 'memN', 'noCap'];

const loadJson = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const caps = loadJson('caps.json', { caps: [] });
const members = (() => {
  const j = loadJson('constituents.json', {});
  const s = new Set();
  for (const k of ['hs300', 'zz500']) for (const m of j[k] ?? []) s.add(m.code.split('.')[-1] ?? m.code.split('.').pop());
  return s;
})();

async function pool(kind, date, pagesize = 800) {
  const base = kind === 'zt' ? 'getTopicZTPool' : 'getTopicDTPool';
  const sort = kind === 'zt' ? 'fbt%3Aasc' : 'fund%3Aasc';
  // 注意：该接口现在必须显式传 date，缺省会返回 rc=102 / data=null
  const url =
    `https://push2ex.eastmoney.com/${base}?ut=${UT}&dpt=wz.ztzt&Pageindex=0` +
    `&pagesize=${pagesize}&sort=${sort}&date=${date}`;
  return (await fetchJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, retries: 3, baseDelay: 1500 }))?.data ?? null;
}

/** 目标交易日：优先取行情数据里最新的那根日线（只会是交易日） */
function latestTradingDate() {
  const c = loadJson('candles.json', null);
  const bars = c?.series?.find((s) => s.key === 'sh')?.bars ?? [];
  if (bars.length) return bars[bars.length - 1].d;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 东财路径：一次拿到跌停明细（含 ltsz 流通市值） */
async function viaEastmoney() {
  const iso = latestTradingDate();
  const compact = iso.replace(/-/g, '');
  console.log(`  目标交易日 ${iso}`);

  const dt = await pool('dt', compact);
  if (!dt || !dt.pool) throw new Error(`跌停股池无数据 (date=${compact})`);

  // 分母：全市场流通市值用 caps.json 合计（每日刷新一次，失败沿用旧值）
  const totalCap = caps.caps.reduce((a, c) => a + (c.cap || 0), 0);
  if (!totalCap) throw new Error('caps.json 无市值数据');

  const rec = Object.fromEntries(NUM.map((k) => [k, 0]));
  for (const x of dt.pool) {
    const cap = typeof x.ltsz === 'number' && x.ltsz > 0 ? x.ltsz : 0;
    rec.dt++;
    if (cap) {
      rec.dtCap += cap;
      if (cap >= BIG) rec.big++;
      else if (cap >= MID) rec.mid++;
      else rec.small++;
    }
    if (members.has(x.c)) rec.mem++;
  }
  // 全市场样本数与总市值近似：用 caps.json 覆盖的股票
  rec.n = caps.caps.length;
  rec.allCap = totalCap;
  rec.memN = members.size;
  rec.noCap = 0;

  // 涨停家数（用于情绪参考）
  try {
    const zt = await pool('zt', compact);
    rec.zt = zt ? (zt.tc ?? 0) : 0;
  } catch {
    rec.zt = 0;
  }

  return { date: iso, rec, source: 'eastmoney' };
}

/** baostock 路径：全市场扫描（慢但可靠） */
function viaBaostock() {
  console.log('  降级到 baostock 全市场扫描（约 25 分钟）...');
  execFileSync('python', ['run-dtcounts.py'], { stdio: 'inherit', cwd: process.cwd() });
  return { date: null, rec: null, source: 'baostock' };
}

const mode = process.argv[2] ?? 'auto';
let result;
if (mode === 'baostock') {
  result = viaBaostock();
} else {
  try {
    result = await viaEastmoney();
    console.log(`  东财路径成功: ${result.date}  跌停 ${result.rec.dt} 家 / 市值占比 ${((result.rec.dtCap / result.rec.allCap) * 100).toFixed(2)}%`);
  } catch (e) {
    console.warn(`  东财路径失败: ${e.cause?.code ?? e.message}`);
    if (mode === 'eastmoney') process.exit(1);
    result = viaBaostock();
  }
}

if (result.source === 'baostock') {
  console.log('  baostock 已直接写入 dt-counts.json，无需合并');
  process.exit(0);
}

// 并入 dt-counts.json
const file = 'dt-counts.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
const before = data.counts[result.date];
data.counts[result.date] = result.rec;
data.counts = Object.fromEntries(Object.entries(data.counts).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
console.log(`  已写入 ${result.date}（${before ? '覆盖旧值' : '新增'}）`);
