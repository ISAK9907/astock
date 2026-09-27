// 事件日历采集 → events.json
//
// 两类来源：
//   1) official —— FOMC 议息会议，抓 federalreserve.gov 官方日历页（真实解析，非硬编码）
//   2) habit    —— 国内会议/例行发布，官方不提前公布固定日期，按历年惯例推算下一次
// 每次运行都会「滚动到下一次」并丢弃已过期事件，所以日更后永远有未来事件可展示。
import { writeFileSync } from 'node:fs';
import { fetchText, loadWithFallback } from './sources.mjs';

/* ---------------- 1. FOMC：解析官方日历 ---------------- */
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

async function fetchFomc() {
  const html = await fetchText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', {
    headers: { Referer: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
    timeoutMs: 25000,
  });
  const out = [];
  // 每个 panel 对应一个年份
  for (const panel of html.split('<div class="panel panel-default">').slice(1)) {
    const y = panel.match(/<h4>\s*<a[^>]*>\s*(\d{4})\s*FOMC Meetings/i);
    if (!y) continue;
    const year = +y[1];
    const re = /fomc-meeting__month[^>]*>\s*(?:<strong>)?([A-Za-z]+)(?:<\/strong>)?\s*<\/div>\s*<div[^>]*fomc-meeting__date[^>]*>\s*([^<]+?)\s*<\/div>/g;
    for (const m of panel.matchAll(re)) {
      const mon = MONTHS[m[1].toLowerCase()];
      if (!mon) continue;
      const raw = m[2];
      const proj = raw.includes('*'); // * = 该次会议含经济预测/点阵图
      const nums = raw.replace(/[^\d-]/g, '').split('-').map(Number).filter((n) => !Number.isNaN(n));
      if (!nums.length) continue;
      const d1 = nums[0];
      let d2 = nums.length > 1 ? nums[1] : nums[0];
      let endMon = mon;
      if (d2 < d1) { endMon = mon === 12 ? 1 : mon + 1; } // 跨月（如 12/30-1/1）
      const endYear = endMon < mon ? year + 1 : year;
      out.push({
        date: ymd(endYear, endMon, Math.min(d2, daysInMonth(endYear, endMon))),
        span: `${mon}/${d1}-${endMon}/${d2}`,
        kind: '议息会',
        name: 'FOMC 议息会议',
        note: proj ? '含经济预测 + 点阵图' : '无点阵图',
        src: 'official',
      });
    }
  }
  if (!out.length) throw new Error('未解析到任何 FOMC 会议');
  return out;
}

/* ---------------- 2. 国内会议 / 例行发布：按惯例滚动下一次 ---------------- */
const today = new Date();
const TODAY = new Date(today.getFullYear(), today.getMonth(), today.getDate());

const nextWeekday = (d) => {
  const x = new Date(d);
  while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() + 1);
  return x;
};
/** 找到 >= 今天 的下一个「某月某日」 */
function nextInMonths(months, day, { weekday = false, note = '', kind, name } = {}) {
  for (let k = 0; k < 3; k++) {
    const y = TODAY.getFullYear() + k;
    for (const mo of months) {
      const d = new Date(y, mo - 1, Math.min(day, daysInMonth(y, mo)));
      if (d < TODAY) continue;
      const dd = weekday ? nextWeekday(d) : d;
      return { date: ymd(dd.getFullYear(), dd.getMonth() + 1, dd.getDate()), kind, name, note, src: 'habit' };
    }
  }
  return null;
}
/** 每月固定日（如 LPR 每月 20 日） */
function nextMonthly(day, opts) {
  const y = TODAY.getFullYear(), mo = TODAY.getMonth() + 1;
  const cands = [];
  for (const off of [0, 1]) {
    const m = mo + off, yy = m > 12 ? y + 1 : y, mm = m > 12 ? m - 12 : m;
    cands.push(new Date(yy, mm - 1, Math.min(day, daysInMonth(yy, mm))));
  }
  for (const d of cands) {
    if (d < TODAY) continue;
    const dd = opts.weekday ? nextWeekday(d) : d;
    return { date: ymd(dd.getFullYear(), dd.getMonth() + 1, dd.getDate()), kind: opts.kind, name: opts.name, note: opts.note, src: 'habit' };
  }
  return null;
}

const HABIT = [
  nextInMonths([4, 7, 10, 12], 28, { kind: '政治会议', name: '中央政治局会议', note: '按惯例：分析经济形势（4/7/10/12 月下旬）' }),
  nextInMonths([12], 15, { kind: '政治会议', name: '中央经济工作会议', note: '按惯例：定调次年经济' }),
  nextInMonths([3], 5, { kind: '政治会议', name: '全国两会', note: '按惯例：政府工作报告' }),
  nextInMonths([11], 5, { kind: '金融会议', name: '中国国际进口博览会', note: '按惯例：上海' }),
  nextMonthly(20, { kind: '金融会议', name: 'LPR 报价', note: '官方固定：每月 20 日（遇周末顺延）', weekday: true }),
  nextInMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 31, { kind: '金融会议', name: '官方制造业 PMI', note: '按惯例：每月最后一天 09:30' }),
].filter(Boolean);

/* ---------------- 3. 中美互动 ---------------- */
// 双边磋商是临时安排的，没有固定日程，只能人工核实后写死并标注来源与核对日期。
// 多边场合（APEC/G20/联大/达沃斯/博鳌）是每年固定举办，中美元首/经贸团队通常在此期间接触：
//   有官方公布日期 → src='official'；过了一年官方日期公布前 → 按惯例月份滚动，src='habit'。
const BILATERAL_ASOF = '2026-09-21'; // 最后一次核对双边安排信息的日期
const MULTILATERAL = [
  {
    name: 'APEC 领导人非正式会议',
    note: '中美元首通常在此期间场边会晤',
    official: { 2026: { start: '2026-11-18', end: '2026-11-19', where: '深圳', source: '人民网/深圳市政府' } },
    habit: { month: 11, day: 18, where: '轮值主办地' },
  },
  {
    name: 'G20 领导人峰会',
    note: '中美元首通常出席',
    official: { 2026: { start: '2026-12-14', end: '2026-12-15', where: '美国佛州', source: '美财政部（Yonhap 报道）' } },
    habit: { month: 11, day: 20, where: '轮值主办国' },
  },
  { name: '联合国大会一般性辩论', note: '每年 9 月于纽约；中美元首可能场边会晤', habit: { month: 9, day: 22, where: '纽约' } },
  { name: '世界经济论坛年会（达沃斯）', note: '每年 1 月于瑞士', habit: { month: 1, day: 20, where: '达沃斯' } },
  { name: '博鳌亚洲论坛年会', note: '每年 3–4 月于海南', habit: { month: 3, day: 27, where: '海南博鳌' } },
];
// 已宣布的双边安排（人工核实，过期自动消失）
const BILATERAL = [
  {
    start: '2026-09-19', end: '2026-09-23',
    name: '中美经贸磋商（何立峰率团赴美）',
    note: '商务部：经双方商定，就彼此关心的经贸问题开展磋商',
    where: '美国', source: '商务部新闻办公室 2026-09-19',
  },
];

const mmdd = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
function multilateralEvents() {
  const out = [];
  for (const m of MULTILATERAL) {
    const y = TODAY.getFullYear();
    let off = m.official?.[y];
    // 官方日期已过 → 看下一年有没有官方日期，没有就按惯例滚动
    if (off && new Date(`${off.end}T00:00:00`) < TODAY) off = m.official?.[y + 1];
    if (off) {
      out.push({
        date: off.start, endDate: off.end, span: `${mmdd(off.start)}-${mmdd(off.end)}`,
        kind: '中美互动', name: m.name, note: `${m.note}${off.where ? ' · ' + off.where : ''}`,
        src: 'official', source: off.source,
      });
    } else {
      const yy = y + (new Date(y, m.habit.month - 1, m.habit.day) < TODAY ? 1 : 0);
      const d = ymd(yy, m.habit.month, Math.min(m.habit.day, daysInMonth(yy, m.habit.month)));
      out.push({
        date: d, span: `约 ${m.habit.month} 月`, kind: '中美互动', name: m.name,
        note: `${m.note} · ${m.habit.where || ''} · 官方尚未公布具体日期，按惯例月份推算`,
        src: 'habit',
      });
    }
  }
  return out;
}

const bilateralEvents = BILATERAL.filter((b) => new Date(`${b.end ?? b.start}T00:00:00`) >= TODAY).map((b) => ({
  date: b.start,
  endDate: b.end,
  span: b.end && b.end !== b.start ? `${mmdd(b.start)}-${mmdd(b.end)}` : mmdd(b.start),
  kind: '中美互动',
  name: b.name,
  note: `${b.note}${b.where ? ' · ' + b.where : ''}`,
  src: 'official',
  source: b.source,
}));

/* ---------------- 4. 合并 ---------------- */
const r = await loadWithFallback('fomc-calendar', [{ label: 'federalreserve.gov', run: fetchFomc }], { ttlMs: 12 * 3600 * 1000 });
const all = [...r.value, ...HABIT, ...bilateralEvents, ...multilateralEvents()];

const dayDiff = (d) => Math.round((new Date(`${d}T00:00:00`) - TODAY) / 86400000);
const events = all
  .map((e) => ({ ...e, days: dayDiff(e.date), endDays: dayDiff(e.endDate ?? e.date) }))
  .filter((e) => e.endDays >= 0) // 含「进行中」：已开始但未结束
  .sort((a, b) => a.days - b.days)
  .slice(0, 16);

console.log(`FOMC 解析到 ${r.value.length} 场（来源 ${r.source}），惯例事件 ${HABIT.length} 条，中美互动 ${bilateralEvents.length + MULTILATERAL.length} 条`);
for (const e of events.slice(0, 10)) {
  const tag = e.src === 'official' ? '官方' : '惯例';
  const live = e.days <= 0 && e.endDays >= 0 ? '【进行中】' : '';
  console.log(`  ${e.date} ${String(e.days).padStart(4)} 天后 ${live} [${tag}] ${e.kind} · ${e.name}`);
}

writeFileSync('events.json', JSON.stringify({ generatedAt: new Date().toISOString(), bilateralAsOf: BILATERAL_ASOF, events }, null, 1), 'utf8');
console.log(`\nwrote events.json（${events.length} 条未结束事件）`);
