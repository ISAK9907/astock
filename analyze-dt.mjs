// 跌停家数 × 市值 × 权重股 与上证指数的统计关系
// 综合严重度分 = max(家数/60, 市值占比%/1.0, 权重股跌停/12) —— 取「最严重的那个维度」
import { readFileSync, writeFileSync } from 'node:fs';
// score / sent / 档位的定义集中在 sentiment-map.mjs，与 sentiment-backtest.mjs 共用
import { makeSentOf, tiers as tierDefs } from './sentiment-map.mjs';

const raw = JSON.parse(readFileSync('dt-counts.json', 'utf8')).counts;
// 上证指数序列取 daily-long.json（4001 根，2010 起），不用 candles.json（只有 501 根）——
// 后者会把可用区间截到约两年，窗口设成 743 也只能切出 500 天。
const sh = JSON.parse(readFileSync('daily-long.json', 'utf8')).series.sh.bars;
const idxOf = new Map(sh.map((r, i) => [r.d, i]));

// ---------- 局部低点（曲线反转）----------
const W = 5;
const exactLow = new Set();
for (let i = 0; i < sh.length; i++) {
  let ok = true;
  for (let k = Math.max(0, i - W); k <= Math.min(sh.length - 1, i + W); k++) {
    if (sh[k].c < sh[i].c) { ok = false; break; }
  }
  if (ok) exactLow.add(sh[i].d);
}
const nearLow = (d) => {
  const i = idxOf.get(d);
  if (i === undefined) return false;
  for (let k = Math.max(0, i - 1); k <= Math.min(sh.length - 1, i + 1); k++) if (exactLow.has(sh[k].d)) return true;
  return false;
};

// ---------- 归一化基准 ----------
const N = { dt: 60, cap: 1.0, mem: 12 };

// 截取最近 N 个交易日（与请求的窗口一致）
const WINDOW = Number(process.env.DT_WINDOW ?? 743);
let allDates = Object.keys(raw).sort();
if (allDates.length > WINDOW) allDates = allDates.slice(-WINDOW);

const rows = [];
const skipped = [];
for (const d of allDates) {
  const i = idxOf.get(d);
  if (i === undefined || i < 1) { skipped.push(d); continue; }
  const v = raw[d];
  const cap = v.allCap ? (v.dtCap / v.allCap) * 100 : 0;
  const nDt = v.dt / N.dt, nCap = cap / N.cap, nMem = v.mem / N.mem;
  const dom = nDt >= nCap && nDt >= nMem ? '家数' : nCap >= nMem ? '市值' : '权重';
  // 恐慌类型：按跌停股的市值结构分类
  const sBig = v.dt ? v.big / v.dt : 0;
  const sSmall = v.dt ? v.small / v.dt : 0;
  const type = v.dt < 10 ? null : sSmall >= 0.65 ? '微盘踩踏' : sBig >= 0.5 ? '权重杀跌' : '全面抛售';
  const fwd = (n) => (i + n < sh.length ? (sh[i + n].c / sh[i].c - 1) * 100 : null);
  rows.push({
    d, dt: v.dt, cap: +cap.toFixed(2), mem: v.mem, big: v.big,
    mid: v.mid, small: v.small, memN: v.memN, nStock: v.n,
    score: +Math.max(nDt, nCap, nMem).toFixed(2), dom, type, sBig: +sBig.toFixed(2), sSmall: +sSmall.toFixed(2),
    // 情绪分必须用**未舍入**的 score 排名：上面 score 存的是 toFixed(2) 后的值，
    // 舍入会凭空造出/抹掉并列，而 makeSentOf 对并列是按日期顺序展开的 ——
    // 拿舍入值算会让 24/300 天的名次错位（实测），与 sentiment-backtest 对不上。
    scoreRaw: Math.max(nDt, nCap, nMem),
    ret: (sh[i].c / sh[i - 1].c - 1) * 100,
    f1: fwd(1), f3: fwd(3), f5: fwd(5), f10: fwd(10),
    low: nearLow(d),
  });
}

const baseLow = (rows.filter((r) => r.low).length / rows.length) * 100;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const rate = (a, k, th = 0) => (a.length ? (a.filter((r) => r[k] !== null && r[k] > th).length / a.length) * 100 : NaN);
function pearson(a, b) {
  const n = a.length, ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
}
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p = 0.3989423 * Math.exp((-z * z) / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function corrTest(a, b) {
  const n = a.length, r = pearson(a, b);
  const t = r * Math.sqrt((n - 2) / (1 - r * r || 1e-9));
  return { r, t, p: 2 * (1 - normCdf(Math.abs(t))), n };
}

// ---------- 分档：改挂在「情绪分 sent」上 ----------
// 原来用写死的绝对严重度分（1.25 / 2 / 3）。短窗口勉强能用，样本一长就被极端事件撑爆：
// 三年窗口里 2025-04-07（2815 家跌停、市值占比 33.4%）score = 46.92，而橙档门槛只有 3.0，
// 同一个橙色里塞进了相差 15.6 倍的事件。sent 是排名映射、天然有界 0~100，
// 且与面板刻度条同一量纲。门槛由分位反推（前 5% / 3% / 1%），与窗口长度无关。
const TIERS = tierDefs();
// 先给每个交易日补上 sent（与 sentiment-backtest.mjs 共用 sentiment-map.mjs 的同一份实现）
{
  const sentArr = makeSentOf(rows.map((r) => r.scoreRaw));
  rows.forEach((r, i) => { r.sent = +sentArr[i].toFixed(1); });
  // 一致性自检：若 sentiment.json 存在，两边同一天的 sent 必须一致
  try {
    const sj = JSON.parse(readFileSync('sentiment.json', 'utf8'));
    let bad = 0, cmp = 0;
    for (const r of rows) {
      const o = sj.daily?.[r.d]?.sent;
      if (o == null) continue;
      cmp++;
      if (Math.abs(o - r.sent) > 0.15) bad++;
    }
    if (cmp && bad) console.warn(`  ⚠️ 与 sentiment.json 的 sent 有 ${bad}/${cmp} 天不一致（可能两处窗口/样本集不同）`);
    else if (cmp) console.log(`  sent 与 sentiment.json 一致（比对 ${cmp} 天）`);
  } catch { /* 没有 sentiment.json 就跳过 */ }
}

console.log(`样本 ${rows.length} 天 (${rows[0].d} → ${rows.at(-1).d}) | 基准反转命中率 ${baseLow.toFixed(1)}%\n`);

// ⚠️ 静默漏掉最新交易日是最危险的失败模式：面板照常渲染、作业报绿，只是「今天」永远缺席。
//   成因是步骤顺序 —— daily-long.json 若在统计之后才更新，当天的行情索引就取不到。
if (skipped.length) {
  const newest = allDates.at(-1);
  if (skipped.includes(newest)) {
    console.error(
      `\n✗ 最新交易日 ${newest} 在 dt-counts.json 里，但 daily-long.json 里没有它的行情 —— 当天被整段跳过。\n` +
        `  统计会停在 ${rows.at(-1).d}，也就是永远晚一个交易日。\n` +
        `  检查 daily-update.mjs 的步骤顺序：fetch-daily-long.mjs 必须在 analyze-dt.mjs 之前。\n`,
    );
    process.exitCode = 1;
  } else {
    console.warn(`  ⚠️ 有 ${skipped.length} 天在 dt-counts 里但不在 daily-long 里，已跳过：${skipped.slice(0, 6).join(' ')}${skipped.length > 6 ? ' …' : ''}`);
  }
}

console.log('=== 四个指标 vs 上证指数（相关性）===');
console.log('指标            与当日      p       与未来1日    p       与未来5日    p');
const corrs = {};
for (const [key, label] of [['dt', '跌停家数'], ['cap', '跌停市值占比'], ['big', '大盘跌停数'], ['mem', '权重股跌停数'], ['score', '综合严重度分']]) {
  const s = rows.filter((r) => r.f1 !== null);
  const cR = corrTest(rows.map((r) => r[key]), rows.map((r) => r.ret));
  const c1 = corrTest(s.map((r) => r[key]), s.map((r) => r.f1));
  const s5 = rows.filter((r) => r.f5 !== null);
  const c5 = corrTest(s5.map((r) => r[key]), s5.map((r) => r.f5));
  corrs[key] = { ret: cR, f1: c1, f5: c5 };
  const st = (p) => (p < 0.01 ? '**' : p < 0.05 ? '*' : ' ');
  console.log(
    `${label.padEnd(13)} ${cR.r.toFixed(3).padStart(7)}${st(cR.p).padEnd(2)} ${cR.p.toFixed(4).padStart(8)}  ` +
      `${c1.r.toFixed(3).padStart(7)}${st(c1.p).padEnd(2)} ${c1.p.toFixed(4).padStart(8)}  ` +
      `${c5.r.toFixed(3).padStart(7)}${st(c5.p).padEnd(2)} ${c5.p.toFixed(4).padStart(8)}`,
  );
}

console.log('\n=== 分层统计（按情绪分 sent 分档）===');
console.log('档          情绪分      天数  占比   反转命中  lift    当日     次日     5日     5日胜率  10日    对应 score 区间');
const tierOut = [];
for (const t of TIERS) {
  const g = rows.filter((r) => r.sent >= t.sentLo && r.sent < t.sentHi);
  if (!g.length) continue;
  const hit = (g.filter((r) => r.low).length / g.length) * 100;
  const doms = {};
  for (const r of g) doms[r.dom] = (doms[r.dom] ?? 0) + 1;
  const scs = g.map((r) => r.score);
  const o = {
    name: t.name, label: t.label, color: t.color, pct: t.pct,
    sentLo: t.sentLo, sentHi: t.sentHi === Infinity ? null : t.sentHi,
    // 该档在本窗口实际覆盖的绝对严重度分区间 —— 只作参考，不参与判定
    scoreLo: Math.min(...scs), scoreHi: Math.max(...scs),
    n: g.length, share: +((g.length / rows.length) * 100).toFixed(1),
    lowHit: hit, lift: hit / baseLow,
    sameDay: mean(g.map((r) => r.ret)),
    nextDay: mean(g.filter((r) => r.f1 !== null).map((r) => r.f1)),
    f5: mean(g.filter((r) => r.f5 !== null).map((r) => r.f5)),
    f5Win: rate(g, 'f5'),
    f10: mean(g.filter((r) => r.f10 !== null).map((r) => r.f10)),
    doms,
  };
  tierOut.push(o);
  console.log(
    `${t.name}·${t.label}`.padEnd(11) + ` ${String(`≥${t.sentLo}`).padEnd(10)} ${String(o.n).padStart(4)}  ${String(o.share + '%').padStart(5)}  ` +
      `${hit.toFixed(0).padStart(6)}%  ${(hit / baseLow).toFixed(2).padStart(5)}x  ${o.sameDay.toFixed(2).padStart(6)}%  ` +
      `${o.nextDay.toFixed(2).padStart(6)}%  ${o.f5.toFixed(2).padStart(6)}%  ${o.f5Win.toFixed(0).padStart(6)}%  ` +
      `${o.f10.toFixed(2).padStart(6)}%  ${o.scoreLo.toFixed(2)}~${o.scoreHi.toFixed(2)}`,
  );
}
const marked = rows.filter((r) => r.sent >= TIERS[0].sentLo);
console.log(`\n合计标记 ${marked.length}/${rows.length} = ${((marked.length / rows.length) * 100).toFixed(1)}%（门槛 = 情绪分 ≥ ${TIERS[0].sentLo}，即窗口内前 ${TIERS[0].pct * 100}%）`);

console.log('\n=== 被标记的交易日明细 ===');
for (const r of marked.sort((a, b) => b.sent - a.sent)) {
  console.log(
    `  ${r.d}  情绪分${String(r.sent).padStart(5)}  严重度${String(r.score).padStart(5)}  家数${String(r.dt).padStart(4)}  市值${String(r.cap).padStart(5)}%  ` +
      `大${String(r.big).padStart(3)}/中${String(r.mid).padStart(3)}/小${String(r.small).padStart(3)}  权重${String(r.mem).padStart(3)}  ` +
      `主导:${r.dom}  ${r.low ? '★' : ' '}`,
  );
}

writeFileSync(
  'dt-stats.json',
  JSON.stringify(
    {
      window: { start: rows[0].d, end: rows.at(-1).d, n: rows.length },
      norm: N,
      baseLow,
      marked: marked.length,
      // 档位挂在情绪分上；scoreLo/scoreHi 只是本窗口该档实际覆盖的绝对分区间，仅作展示
      tierBasis: 'sent',
      tiers: tierOut,
      corrs,
      daily: Object.fromEntries(rows.map((r) => [r.d, { dt: r.dt, cap: r.cap, mem: r.mem, big: r.big, score: r.score, sent: r.sent, dom: r.dom, type: r.type }])),
      typeCount: Object.fromEntries(
        ['微盘踩踏', '权重杀跌', '全面抛售'].map((t) => [t, rows.filter((r) => r.type === t).length]),
      ),
    },
    null,
    1,
  ),
  'utf8',
);
console.log('\nwrote dt-stats.json');
