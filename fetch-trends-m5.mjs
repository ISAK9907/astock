// 45 日 5 分钟线采集（上证指数 / 中证2000ETF / 同花顺全A）
//
// 取数策略：
//   新浪 getKLineData 是最有效的一次性历史分钟源。实测其上限制约在 1950~1990 根之间：
//     scale=5  datalen=1950 → 41 个交易日
//     scale=15 datalen=900  → 50 个交易日
//   所以用「5 分钟打底 + 15 分钟补更早的几天」拼满 45 日，无需本地归档，每次都能自愈。
//   （腾讯 minute/query、day/query 均忽略 date 参数；东财 kline 本轮 UND_ERR_SOCKET；
//     同花顺 line/sh_* 对沪市代码 502，故只用于 bk_ 板块代码。）
import { writeFileSync } from 'node:fs';
import { loadWithFallback, sina, ths, tencent, sleep } from './sources.mjs';

const TTL = 3 * 3600 * 1000; // 3 小时内命中缓存
const WANT_DAYS = 45;        // 滚动窗口上限
const LEADER_CODE = 'bk_883957';

// ---------- 5 分钟档位网格：09:35-11:30 (24) + 13:05-15:00 (24) = 48 ----------
const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
const SLOT_TIMES = [];
for (let m = 575; m <= 690; m += 5) SLOT_TIMES.push(pad(m));
for (let m = 785; m <= 900; m += 5) SLOT_TIMES.push(pad(m));
const GRID = SLOT_TIMES.length;

/** 把任意粒度的点位映射到 48 档网格：每档取「时间 <= 档位」的最后一个点（15 分钟线会被阶梯式铺满） */
function toGrid(points) {
  const byDay = new Map();
  for (const p of points) {
    if (p.t < '0935' || p.t > '1500') continue; // 集合竞价 / 盘后
    if (!byDay.has(p.d)) byDay.set(p.d, []);
    byDay.get(p.d).push(p);
  }
  const out = new Map();
  for (const [d, arr] of byDay) {
    arr.sort((a, b) => a.t.localeCompare(b.t)); // 稳定排序：t 相同时 5 分钟点在后，取用时胜出
    const row = new Array(GRID).fill(null);
    let j = 0;
    for (let s = 0; s < GRID; s++) {
      while (j + 1 < arr.length && arr[j + 1].t <= SLOT_TIMES[s]) j++;
      if (arr[j].t <= SLOT_TIMES[s]) row[s] = arr[j].px;
    }
    out.set(d, row);
  }
  return out;
}

const raw = {};
const SPECS = [
  { key: 'sh', name: '上证指数', code: 'sh000001', proxy: null },
  { key: 'csi2000', name: '中证2000', code: 'sh563300', proxy: '中证2000ETF华泰柏瑞' },
];
for (const s of SPECS) {
  const r5 = await loadWithFallback(
    `m5-${s.code}`,
    [
      { label: 'sina(5分钟)', run: () => sina.klineMin(s.code, 5, 1950) },
      { label: 'tencent', run: () => tencent.intraday5d(s.code) }, // 降级：只有 5 天
    ],
    { ttlMs: TTL },
  );
  await sleep(700);
  const r15 = await loadWithFallback(
    `m15-${s.code}`,
    [{ label: 'sina(15分钟)', run: () => sina.klineMin(s.code, 15, 900) }],
    { ttlMs: TTL },
  );
  await sleep(700);
  const d5 = new Set(r5.value.map((p) => p.d)).size;
  const onlyOld = [...new Set(r15.value.map((p) => p.d))].filter((d) => !new Set(r5.value.map((p) => p.d)).has(d)).length;
  raw[s.key] = { ...s, points: [...r15.value, ...r5.value], source: r5.source, stale: r5.stale, d5, d15: Math.max(0, onlyOld) };
  console.log(`${s.name.padEnd(10)} 5分钟 ${d5} 天 + 15分钟补 ${onlyOld} 天  ← ${r5.source} + ${r15.source}`);
}

// 同花顺全A：5 分钟整年文件，历史充足
const year = new Date().getFullYear();
const rLead = await loadWithFallback(
  `ths-5m-${LEADER_CODE}-${year}`,
  [{ label: 'ths(同花顺)', run: () => ths.line5m(LEADER_CODE, year) }],
  { ttlMs: TTL },
);

// ⚠️ 同花顺 5 分钟年度文件对「当日」有滞后：实测当天可能只写 1 根（09:35），也可能一根都没有。
//    若不补，全A 当日线缺数据 → 涨跌幅被算成 0.00%、收盘价也不对。
//    当日 1 分钟分时接口是完整的（241 点 / 09:30-15:00），用它补齐。
//
// ⚠️⚠️ 判断「该不该补」必须用**外部交易日历**（这里用上证），不能拿同花顺自己的最后一天：
//    15:40 跑日更时它的年度文件常常连当天的第一根都还没写，于是「它自己的最后一天」退回到昨天、
//    看着是满的，检查直接通过 —— 当日线就空着。这个漏洞此前一直存在。
let leadPts = rLead.value;
const shDaysRef = [...new Set(raw.sh.points.map((p) => p.d))].sort();
const expectDay = shDaysRef.at(-1); // 该有数据的最近交易日，来自上证
const leadByDay = new Map();
for (const p of leadPts) leadByDay.set(p.d, (leadByDay.get(p.d) || 0) + 1);
const haveCount = leadByDay.get(expectDay) ?? 0;
const INCOMPLETE = GRID * 0.8; // 低于 80% 视为不完整
let patchNote = `${expectDay} 已有 ${haveCount}/${GRID} 档，无需补`;

if (haveCount < INCOMPLETE) {
  // 先把日线档取到手：它既是收盘价的权威来源，也是 1 分钟源不可用时的兜底
  let dayRow = null;
  try {
    const rD = await loadWithFallback(
      `ths-day-${LEADER_CODE}-${year}`,
      [{ label: 'ths(日线)', run: () => ths.lineDay(LEADER_CODE, year) }],
      { ttlMs: 3600 * 1000 },
    );
    dayRow = rD.value.find((b) => b.d === expectDay) ?? null;
  } catch (e) {
    console.warn(`  ! 同花顺日线档不可用（${e.message}）`);
  }

  const r1 = await loadWithFallback(
    `ths-1m-${LEADER_CODE}`,
    [{ label: 'ths(1分钟当日)', run: () => ths.minuteToday(LEADER_CODE) }],
    { ttlMs: 0 }, // 当日分时不缓存，每次取最新
  );
  // 1 分钟源也可能滞后（返回的是更早的日期），必须核对日期
  const sameDay = r1.value.filter((p) => p.d === expectDay);

  if (sameDay.length >= INCOMPLETE) {
    leadPts = [...leadPts.filter((p) => p.d !== expectDay), ...sameDay];
    patchNote = `${expectDay} 仅 ${haveCount}/${GRID} 档 → 用 1 分钟补 ${sameDay.length} 点`;

    // 同花顺的 1 分钟分时与日线档在收盘价上会不一致（实测 883957 在 2026-09-23 差 0.12%），
    // 日线档是官方 EOD 记录，用它给当日最后一个档位定标；差异超过 0.05% 时告警。
    if (dayRow && isFinite(dayRow.c)) {
      const cur = sameDay.at(-1).px;
      const diffPct = Math.abs(cur / dayRow.c - 1) * 100;
      if (diffPct > 0.05) {
        console.log(
          `  ! 同花顺全A 当日收盘：1 分钟档 ${cur} vs 日线档 ${dayRow.c}（差 ${diffPct.toFixed(3)}%）` +
            ` → 采用日线档。这是同花顺自身两个接口不一致。`,
        );
      }
      const sorted = sameDay.slice().sort((a, b) => a.t.localeCompare(b.t));
      const lastT = sorted.at(-1).t;
      leadPts = leadPts.map((p) => (p.d === expectDay && p.t === lastT ? { ...p, px: dayRow.c } : p));
    }
  } else if (dayRow && isFinite(dayRow.c)) {
    // 1 分钟源也不可用 —— 至少用日线收盘补一个 15:00 的点，
    // 保证当日涨跌幅与收盘价正确（线是短的，但不再是 0.00% 那种错）。
    leadPts = [
      ...leadPts.filter((p) => p.d !== expectDay),
      { d: expectDay, t: '1500', px: dayRow.c },
    ];
    patchNote = `${expectDay} 5分钟 ${haveCount}/${GRID} 档、1 分钟源不可用（${sameDay.length} 点）→ 回退日线收盘定标`;
    console.warn(`  ! ${patchNote}`);
  } else {
    patchNote = `${expectDay} 缺数据，且 1 分钟与日线档都不可用 —— 当日线不完整`;
    console.warn(`  ! ${patchNote}`);
  }
}

console.log(`${'同花顺全A(沪深京)'.padEnd(18)} ${leadPts.length} 根 / ${[...new Set(leadPts.map((p) => p.d))].length} 天  ← ${rLead.source}  [${patchNote}]`);

raw.leader = { key: 'leader', name: '同花顺全A(沪深京)', code: LEADER_CODE, proxy: null, points: leadPts, source: rLead.source, stale: rLead.stale };

// ---------- 对齐交易日：以上证为日历，取最近 WANT_DAYS 天 ----------
const shDays = [...new Set(raw.sh.points.map((p) => p.d))].sort();
const days = shDays.slice(-WANT_DAYS);
const shGrid = toGrid(raw.sh.points);

const series = [];
const warnings = [];
for (const key of ['sh', 'csi2000', 'leader']) {
  const s = raw[key];
  const g = key === 'sh' ? shGrid : toGrid(s.points);
  const pts = [];
  let missing = 0;
  days.forEach((d, i) => {
    const row = g.get(d);
    if (!row) { missing += GRID; return; }
    row.forEach((px, sl) => {
      if (px == null) { missing++; return; }
      pts.push([i * GRID + sl, Math.round(px * 10000) / 10000]);
    });
  });
  const cov = ((days.length * GRID - missing) / (days.length * GRID)) * 100;
  series.push({ ...s, points: pts });
  console.log(`  ${s.name.padEnd(18)} 网格 ${String(pts.length).padStart(4)}/${days.length * GRID}  覆盖 ${cov.toFixed(1)}%  区间 ${((pts.at(-1)[1] / pts[0][1] - 1) * 100).toFixed(2)}%`);

  // 当日档位完整性自查 —— 低覆盖通常意味着该数据源对「当日」有滞后
  const lastIdx = days.length - 1;
  const lastRows = pts.filter(([gx]) => Math.floor(gx / GRID) === lastIdx);
  const lastClose = lastRows.at(-1)?.[1];
  const okLast = lastRows.length >= GRID * 0.8;
  if (!okLast) warnings.push(`${s.name} 当日档位仅 ${lastRows.length}/${GRID}`);
  console.log(
    `     当日 ${days[lastIdx]}  ${String(lastRows.length).padStart(2)}/${GRID} 档  收盘 ${lastClose ?? '—'}  ${okLast ? '✓' : '⚠️ 不完整'}`,
  );
}

if (warnings.length) {
  console.log(`\n⚠️  以下序列当日数据不完整，图表尾端会失真：\n   - ${warnings.join('\n   - ')}`);
} else {
  console.log('\n✓ 三条序列当日档位均完整');
}

writeFileSync(
  'trends-m5.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), grid: GRID, slotTimes: SLOT_TIMES, days, series }),
  'utf8',
);
console.log(`\n区间 ${days[0]} → ${days.at(-1)}  ${days.length} 个交易日  已写 trends-m5.json`);
for (const s of series) if (s.stale) console.log(`  ! ${s.name} 使用了过期缓存`);
