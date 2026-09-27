// A 股休市日历 + 节假日效应统计
//   日历来源：上交所《2026年休市安排》官方公告（2025-12-22），并非推算。
//   历史效应：从指数日线里反推工作日的缺口得到历史假期，再统计前后表现（见 analyze-holiday.mjs）。
import { readFileSync, existsSync } from 'node:fs';

/**
 * 官方公布的休市区间，约定为 **[from, to)**：
 *   · from   = 第一个休市日
 *   · to     = 开市日（**不含**），即 to === reopen
 *   · reopen = 恢复交易日，也是界面上展示的「→ XX 开市」那个日期
 * 选择逻辑用 `todayIso < h.to` 判断假期是否已过去，所以 to 必须等于 reopen ——
 * 元旦原本写成 to:'2026-01-04'（reopen 是 01-05），导致 01-04 当天这张卡片提前消失。
 */
export const OFFICIAL = [
  { name: '元旦', from: '2026-01-01', to: '2026-01-05', reopen: '2026-01-05' },
  { name: '春节', from: '2026-02-15', to: '2026-02-24', reopen: '2026-02-24' },
  { name: '清明', from: '2026-04-04', to: '2026-04-07', reopen: '2026-04-07' },
  { name: '劳动节', from: '2026-05-01', to: '2026-05-06', reopen: '2026-05-06' },
  { name: '端午', from: '2026-06-19', to: '2026-06-22', reopen: '2026-06-22' },
  { name: '中秋', from: '2026-09-25', to: '2026-09-28', reopen: '2026-09-28' },
  { name: '国庆', from: '2026-10-01', to: '2026-10-08', reopen: '2026-10-08' },
  // 2027 年安排通常在前一年 12 月公告，公布后补进来即可
];

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const diffDays = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 864e5);

/** 今天之后的下一个休市（含「正在休市中」） */
export function nextHoliday(todayIso) {
  for (const h of OFFICIAL) {
    if (todayIso < h.to) return { ...h, days: diffDays(h.from, todayIso), inHoliday: todayIso >= h.from, reopenIn: diffDays(h.reopen, todayIso) };
  }
  return null;
}

/** 从指数日线反推历史休市区间（工作日却无行情 = 休市） */
export function deriveHistorical(bars) {
  const have = new Set(bars.map((b) => b.d));
  const out = [];
  let cur = null;
  const first = new Date(bars[0].d + 'T00:00:00');
  const last = new Date(bars[bars.length - 1].d + 'T00:00:00');
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const s = iso(d);
    const wd = d.getDay();
    const closed = wd !== 0 && wd !== 6 && !have.has(s);
    if (closed) { if (!cur) cur = { from: s, to: s }; else cur.to = s; }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  // 合并被 1~2 个交易日隔开的相邻区间（例如国庆与中秋相邻时会分成两段）
  const merged = [];
  for (const h of out) {
    const prev = merged[merged.length - 1];
    if (prev && diffDays(h.from, prev.to) <= 4) prev.to = h.to;
    else merged.push({ ...h });
  }
  return merged;
}

const nameOf = (h) => {
  const m = +h.from.slice(5, 7), d = +h.from.slice(8, 10);
  if (m === 1 && d <= 5) return '元旦';
  if (m === 2 || (m === 1 && d >= 20)) return '春节';
  if (m === 4) return '清明';
  if (m === 5) return '劳动节';
  if (m === 6) return '端午';
  if (m === 9) return '中秋';
  if (m === 10) return '国庆';
  return `${m}月`;
};

/** 长假（≥3 个自然日）前后的上证表现统计 */
export function holidayStats(dailyLongPath = 'daily-long.json') {
  if (!existsSync(dailyLongPath)) return null;
  const sh = JSON.parse(readFileSync(dailyLongPath, 'utf8')).series.sh.bars;
  const holidays = deriveHistorical(sh);
  const stat = [];
  for (const h of holidays) {
    if (diffDays(h.to, h.from) < 2) continue;
    const i = sh.findIndex((b) => b.d > h.to);
    if (i < 6 || i > sh.length - 6) continue;
    stat.push({
      name: nameOf(h), from: h.from, to: h.to,
      before: (sh[i - 1].c / sh[i - 6].c - 1) * 100,
      gap: (sh[i].o / sh[i - 1].c - 1) * 100,
      after1: (sh[i].c / sh[i - 1].c - 1) * 100,
      after5: (sh[i + 4].c / sh[i - 1].c - 1) * 100,
    });
  }
  const byName = new Map();
  for (const s of stat) { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(s); }
  const agg = (list) => ({
    n: list.length,
    before: list.reduce((a, x) => a + x.before, 0) / list.length,
    beforeWin: (list.filter((x) => x.before > 0).length / list.length) * 100,
    after1: list.reduce((a, x) => a + x.after1, 0) / list.length,
    after1Win: (list.filter((x) => x.after1 > 0).length / list.length) * 100,
    after5: list.reduce((a, x) => a + x.after5, 0) / list.length,
    after5Win: (list.filter((x) => x.after5 > 0).length / list.length) * 100,
  });
  return {
    total: agg(stat),
    recent: stat.slice(-8).reverse(),
    byName: [...byName.entries()].map(([name, list]) => ({ name, ...agg(list) })).sort((a, b) => b.n - a.n),
    count: stat.length,
    span: stat.length ? `${stat[0].from} → ${stat[stat.length - 1].to}` : '',
    // 无条件基准：同期「任意一个交易日」的日收益 / 「任意 5 个交易日」的收益，用于判断假期效应是否只是正漂移
    base1: (() => {
      const r = [];
      for (let i = 1; i < sh.length; i++) r.push((sh[i].c / sh[i - 1].c - 1) * 100);
      return { n: r.length, mean: r.reduce((a, x) => a + x, 0) / r.length, win: (r.filter((x) => x > 0).length / r.length) * 100 };
    })(),
    base5: (() => {
      const r = [];
      for (let i = 5; i < sh.length; i++) r.push((sh[i].c / sh[i - 5].c - 1) * 100);
      return { n: r.length, mean: r.reduce((a, x) => a + x, 0) / r.length, win: (r.filter((x) => x > 0).length / r.length) * 100 };
    })(),
  };
}
