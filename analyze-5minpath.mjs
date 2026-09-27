// ③-B 跳空日的真实日内路径（5 分钟口径）
//   数据：新浪 5 分钟（上证，约 42 天）+ 同花顺 5 分钟（全A，约 176 天，若未被限流）
//   口径：以当日**日线开盘价**为 0，画各 5 分钟档位的平均累积涨跌幅
import { readFileSync, writeFileSync } from 'node:fs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const get = async (u, ref) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: ref }, signal: c.signal });
    return { st: r.status, txt: await r.text() };
  } catch (e) { return { st: -1, txt: '', err: String(e.cause?.code || e.message) }; }
  finally { clearTimeout(t); }
};
const TODAY = new Date().toISOString().slice(0, 10);
const pct = (v, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const SLOTS = [];
for (let m = 575; m <= 690; m += 5) SLOTS.push(m);
for (let m = 785; m <= 900; m += 5) SLOTS.push(m);
const slotOf = (hhmm) => {
  const t = +hhmm.slice(0, 2) * 60 + +hhmm.slice(2, 4);
  if (t >= 575 && t <= 690) return (t - 575) / 5;
  if (t >= 785 && t <= 900) return 24 + (t - 785) / 5;
  return -1;
};
const slotTime = (i) => `${String(Math.floor(SLOTS[i] / 60)).padStart(2, '0')}:${String(SLOTS[i] % 60).padStart(2, '0')}`;

// ---------- 取 5 分钟数据 ----------
const D = JSON.parse(readFileSync('daily-long.json', 'utf8'));

async function fromSina(sym, key) {
  const bars = D.series[key].bars.filter((b) => b.d < TODAY);
  const openByDate = new Map(bars.map((b) => [b.d, b.o]));
  const prevByDate = new Map();
  for (let i = 1; i < bars.length; i++) prevByDate.set(bars[i].d, bars[i - 1].c);
  const r = await get(`https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=5&ma=no&datalen=1970`, 'https://finance.sina.com.cn/');
  const j = JSON.parse(r.txt);
  if (!Array.isArray(j)) return null;
  const byDay = new Map();
  for (const b of j) {
    const d = String(b.day).slice(0, 10);
    if (d >= TODAY) continue;
    const sl = slotOf(String(b.day).slice(11, 16).replace(':', ''));
    if (sl < 0 || !openByDate.has(d)) continue;
    if (!byDay.has(d)) byDay.set(d, new Array(48).fill(null));
    byDay.get(d)[sl] = +b.close;
  }
  return { label: sym, openByDate, prevByDate, byDay };
}

async function fromThs(code, year, dailyKey) {
  const r5 = await get(`https://d.10jqka.com.cn/v6/line/${code}/30/${year}.js`, 'https://q.10jqka.com.cn/');
  const m5 = r5.txt.match(/"data":"([^"]*)"/);
  if (!m5) return null;
  const rd = await get(`https://d.10jqka.com.cn/v6/line/${code}/01/${year}.js`, 'https://q.10jqka.com.cn/');
  const md = rd.txt.match(/"data":"([^"]*)"/);
  if (!md) return null;
  const openByDate = new Map(), prevByDate = new Map();
  const drows = md[1].split(';').filter(Boolean).map((s) => s.split(','));
  for (let i = 1; i < drows.length; i++) {
    const d = `${drows[i][0].slice(0, 4)}-${drows[i][0].slice(4, 6)}-${drows[i][0].slice(6, 8)}`;
    openByDate.set(d, +drows[i][1]);
    prevByDate.set(d, +drows[i - 1][4]);
  }
  const byDay = new Map();
  for (const row of m5[1].split(';').filter(Boolean)) {
    const p = row.split(',');
    const ts = p[0];
    const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    if (d >= TODAY || !openByDate.has(d)) continue;
    const sl = slotOf(ts.slice(8, 12));
    if (sl < 0) continue;
    if (!byDay.has(d)) byDay.set(d, new Array(48).fill(null));
    // 同花顺对当日滞后：只有 1 根时跳过该日
    byDay.get(d)[sl] = +p[4];
  }
  for (const [d, arr] of [...byDay]) if (arr.filter((v) => v != null).length < 40) byDay.delete(d);
  return { label: `${code}(${dailyKey})`, openByDate, prevByDate, byDay, fallbackOpen: D.series[dailyKey] ? new Map(D.series[dailyKey].bars.map((b) => [b.d, b.o])) : null };
}

const sets = [];
const sina = await fromSina('sh000001', 'sh');
if (sina) sets.push({ ...sina, name: '上证指数(5分钟)' });
console.log(`新浪 上证指数 5 分钟：${sina ? sina.byDay.size : 0} 天`);
const year = new Date().getFullYear();
for (const [code, dk] of [['bk_883957', 'sh']]) {
  const t = await fromThs(code, year, dk);
  if (t) { sets.push({ ...t, name: '同花顺全A(5分钟)' }); console.log(`同花顺 ${code} 5 分钟：${t.byDay.size} 天`); }
  else console.log(`同花顺 ${code} 不可用（可能被限流）`);
}

// ---------- 路径分析 ----------
for (const S of sets) {
  const rows = [];
  for (const [d, arr] of S.byDay) {
    const o = S.openByDate.get(d), pc = S.prevByDate.get(d);
    if (!o || !pc) continue;
    const gap = (o / pc - 1) * 100;
    // 相对开盘的累积路径（%），缺失档位前向填充
    const path = [];
    let last = 0;
    for (let i = 0; i < 48; i++) {
      const v = arr[i];
      if (v != null) last = (v / o - 1) * 100;
      path.push(last);
    }
    rows.push({ d, gap, path, close: (arr[47] != null ? arr[47] / o - 1 : NaN) * 100 });
  }
  if (!rows.length) continue;

  console.log(`\n=== ${S.name}：${rows.length} 个交易日  ${rows[0].d} → ${rows.at(-1).d} ===`);
  const groups = [
    ['全部', () => true],
    ['高开 ≥0.5%', (r) => r.gap >= 0.5],
    ['高开 ≥1%', (r) => r.gap >= 1],
    ['平开 ±0.2%', (r) => Math.abs(r.gap) < 0.2],
    ['低开 ≤-0.5%', (r) => r.gap <= -0.5],
    ['低开 ≤-1%', (r) => r.gap <= -1],
  ];
  console.log('  分组          n    09:35    10:00    10:30    11:30    13:30    14:30    15:00   收盘-开盘');
  for (const [nm, pred] of groups) {
    const s = rows.filter(pred);
    if (!s.length) continue;
    const at = (i) => mean(s.map((r) => r.path[i]));
    console.log(
      `  ${nm.padEnd(12)} ${String(s.length).padStart(3)}  ` +
        [0, 5, 11, 23, 35, 47].map((i) => pct(at(i)).padStart(8)).join('  ') +
        `  ${pct(mean(s.map((r) => r.close))).padStart(9)}`,
    );
  }
  // 极值时刻
  console.log('\n  分组          日内最高出现在  日内最低出现在   最高均值   最低均值');
  for (const [nm, pred] of groups) {
    const s = rows.filter(pred);
    if (!s.length) continue;
    const hiAt = mean(s.map((r) => r.path.indexOf(Math.max(...r.path))));
    const loAt = mean(s.map((r) => r.path.indexOf(Math.min(...r.path))));
    console.log(
      `  ${nm.padEnd(12)}  ${slotTime(Math.round(hiAt)).padStart(11)}  ${slotTime(Math.round(loAt)).padStart(12)}  ` +
        `${pct(mean(s.map((r) => Math.max(...r.path)))).padStart(9)}  ${pct(mean(s.map((r) => Math.min(...r.path)))).padStart(9)}`,
    );
  }
}

writeFileSync('.cache/m5path-dump.json', JSON.stringify(sets.map((s) => ({ name: s.name, days: [...s.byDay.keys()] }))), 'utf8');
