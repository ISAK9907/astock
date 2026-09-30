// 生成紧凑版看板：45 日 5 分钟线 + 近一周情绪指标 + 事件倒计时
import { readFileSync, writeFileSync } from 'node:fs';
import { TH, ACTIONS, stateOf, decide, playbook } from './signal.mjs';
import { tiersOpt } from './sentiment-map.mjs';

const data = JSON.parse(readFileSync('market-data.json', 'utf8'));
const tr = JSON.parse(readFileSync('trends-m5.json', 'utf8'));
const NOW = new Date();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const days = (d) => {
  const a = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  return Math.round((new Date(`${d}T00:00:00`) - a) / 86400000);
};

// ---------- 45 日 5 分钟网格 ----------
// 归一化改由前端做（支持「累加 / 每日归零」切换），这里只算图例用的区间涨跌幅。
const GP = tr.grid; // 每日 48 档（09:35-11:30 + 13:05-15:00）

const COLORS = { sh: '#5b8def', csi2000: '#e0b96a', leader: '#c471ed' };
const plotted = tr.series.map((s) => {
  const win = s.points[0][1];
  const total = (s.points.at(-1)[1] / win - 1) * 100;
  const lastD = tr.days.length - 1;
  // 当日涨跌幅 = 末日收盘 vs **前一交易日收盘**（常规口径）。
  // 原来算的是日内 09:35→15:00，且无数据时静默返回 0 —— 于是数据缺失会被显示成看似正常的
  // 「+0.00%」，把问题掩盖掉（2026-09-24 同花顺全A 缺整天时正是如此）。
  // 现在缺数据一律返回 null，界面显示「—」并给出告警，绝不伪造数字。
  const dayClose = (di) => {
    const a = s.points.filter(([gx]) => Math.floor(gx / GP) === di);
    return a.length ? a.at(-1)[1] : null;
  };
  const c1 = dayClose(lastD);
  const c0 = dayClose(lastD - 1);
  const day = c1 != null && c0 != null && c0 !== 0 ? (c1 / c0 - 1) * 100 : null;
  const dayN = s.points.filter(([gx]) => Math.floor(gx / GP) === lastD).length;
  return { ...s, total, day, dayN };
});
// 任何一条序列末日档位不足就显式告警，避免图表尾端悄悄失真
for (const s of plotted) {
  if (s.day == null || s.dayN < GP * 0.8) {
    console.warn(`! ${s.name} 末日(${tr.days.at(-1)}) 仅 ${s.dayN}/${GP} 档，当日涨跌幅无法可靠计算 —— 界面会显示「—」`);
  }
}

// ---------- 事件（由 fetch-events.mjs 采集：FOMC 抓官方日历，国内会议按惯例滚动下一次） ----------
let EVENTS = [];
try {
  EVENTS = JSON.parse(readFileSync('events.json', 'utf8')).events ?? [];
} catch {
  console.log('! events.json 缺失或损坏，事件面板将为空（运行 node fetch-events.mjs 生成）');
}
const fomcCount = EVENTS.filter((e) => e.src === 'official' && e.kind === '议息会').length;
EVENTS = EVENTS.map((e) => ({ ...e, days: days(e.date), endDays: days(e.endDate ?? e.date) }))
  .filter((e) => e.endDays >= 0) // 含「进行中」：已开始但未结束
  .sort((a, b) => a.days - b.days);

// ---------- 休市日历 + 节假日效应（holidays.mjs） ----------
// 日历是上交所官方公告，不是推算；效应统计从 16 年指数日线反推历史假期后计算
const _today = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(NOW.getDate()).padStart(2, '0')}`;
let HOL = null;
let HOLSTAT = null;
try {
  const m = await import('./holidays.mjs');
  const nh = m.nextHoliday(_today);
  HOLSTAT = m.holidayStats('daily-long.json');
  // 把「下一个休市」和「下下个休市」作为倒计时卡片并入事件流
  const ups = m.OFFICIAL.filter((h) => h.to > _today).slice(0, 2);
  for (const h of ups) {
    const inHol = _today >= h.from;
    const d = inHol ? -1 : days(h.from);
    EVENTS.push({
      name: `${h.name}休市`,
      kind: '休市',
      date: h.from,
      endDate: h.reopen,
      span: `${h.from} → ${h.reopen} 开市`,
      // note / days 在下面 87-94 行按 _hol 统一重算，这里只需占位
      note: inHol ? `休市中，${h.reopen} 开市` : `→ ${h.reopen} 开市`,
      source: '上交所 2026 年休市安排',
      src: 'official',
      days: d,
      endDays: days(h.reopen),
      _hol: { from: h.from, to: h.to, reopen: h.reopen, inHol },
    });
  }
  EVENTS.sort((a, b) => a.days - b.days);
  // 休市卡片文案稍作修正（上面 note 用的是占位算法）
  for (const e of EVENTS) {
    if (!e._hol) continue;
    const { from, reopen, inHol } = e._hol;
    e.note = inHol
      ? `休市中 · ${reopen} 恢复交易`
      : `${days(from)} 个自然日后休市 · 共 ${Math.max(1, days(reopen) - days(from))} 天`;
    e.days = inHol ? 0 : days(from);
  }
  HOL = { next: nh, list: ups };
} catch (err) {
  console.log(`! holidays.mjs 加载失败，休市面板将为空: ${err.message}`);
}

// ---------- SVG 工具 ----------
function axes(W, H, P, maxV, minV, ticks, yFmt, xLabels) {
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const yOf = (v) => P.t + ih - ((v - minV) / (maxV - minV || 1)) * ih;
  let g = '';
  for (let k = 0; k <= ticks; k++) {
    const v = minV + ((maxV - minV) / ticks) * k;
    const y = yOf(v);
    g += `<line x1="${P.l}" y1="${y.toFixed(1)}" x2="${W - P.r}" y2="${y.toFixed(1)}" stroke="#252c39"/>`;
    g += `<text class="ytick" data-py="${y.toFixed(1)}" x="${P.l - 7}" y="${(y + 3.5).toFixed(1)}" fill="#7b8698" font-size="10" text-anchor="end">${yFmt(v)}</text>`;
  }
  g += `<line x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#39414f"/>`;
  g += xLabels(W, P, iw, H, ih);
  return { g, yOf };
}

// 45 日 5 分钟叠加 —— 数据交给前端，由 JS 重绘以支持滚轮缩放与归一化切换
function intradayChart() {
  const legend = plotted
    .map(
      (s2) =>
        `<span><i class="dot" style="background:${COLORS[s2.key]}"></i>${esc(s2.name)}` +
        `${s2.proxy ? `<em class="px">${esc(s2.proxy)}</em>` : ''}` +
        (s2.day == null
          ? `<em class="chg" title="末日数据缺失，无法计算">当日 —</em>`
          : `<em class="chg ${s2.day >= 0 ? 'up' : 'down'}">当日 ${s2.day >= 0 ? '+' : ''}${s2.day.toFixed(2)}%</em>`) +
        `<em class="chg ${s2.total >= 0 ? 'up' : 'down'}">${tr.days.length}日 ${s2.total >= 0 ? '+' : ''}${s2.total.toFixed(2)}%</em></span>`,
    )
    .join('');
  const payload = {
    days: tr.days,
    grid: GP,
    slotTimes: tr.slotTimes,
    series: plotted.map((s) => ({
      key: s.key,
      name: s.name,
      color: COLORS[s.key],
      points: s.points, // [gx, 原始价]；归一化在前端
      markExtremes: s.key === 'sh', // 上证指数标注视野内最高/最低绝对点
    })),
  };
  return { legend, payload };
}

// 近一周：涨停/跌停分组
function barsChart() {
  const W = 500, H = 190, P = { t: 14, r: 10, b: 30, l: 34 };
  const n = data.length, iw = W - P.l - P.r, ih = H - P.t - P.b;
  const max = Math.ceil((Math.max(...data.map((d) => Math.max(d.zt, d.dt))) * 1.18) / 10) * 10;
  const { g, yOf } = axes(W, H, P, max, 0, 3, (v) => v.toFixed(0), (W, P, iw, H) => {
    return data.map((d, i) => `<text x="${(P.l + (iw / n) * (i + 0.5)).toFixed(1)}" y="${H - P.b + 18}" fill="#7b8698" font-size="9.5" text-anchor="middle">${d.date.slice(5)}</text>`).join('');
  });
  const step = iw / n, bw = Math.min(16, step * 0.3);
  let s = g;
  data.forEach((d, i) => {
    const cx = P.l + step * (i + 0.5);
    for (const [v, col, off] of [[d.zt, '#ef4d5a', -1], [d.dt, '#3fa66b', 1]]) {
      const y = yOf(v);
      s += `<rect x="${(cx + off * 1.5 - (off < 0 ? bw : 0)).toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${(P.t + ih - y).toFixed(1)}" fill="${col}" rx="1.5"/>`;
      s += `<text x="${(cx + off * 1.5 - (off < 0 ? bw / 2 : -bw / 2)).toFixed(1)}" y="${(y - 3).toFixed(1)}" fill="${col}" font-size="9" text-anchor="middle">${v}</text>`;
    }
  });
  return {
    svg: s,
    desc: {
      id: 'chZtdt', w: W, h: H, plot: P,
      yMin: 0, yMax: max, fmt: 'int',
      xs: data.map((_, i) => +(P.l + step * (i + 0.5)).toFixed(1)),
      xLabels: data.map((d) => d.date.slice(5)),
      series: [
        { name: '涨停', color: '#ef4d5a', ys: data.map((d) => +yOf(d.zt).toFixed(1)), labels: data.map((d) => String(d.zt)) },
        { name: '跌停', color: '#3fa66b', ys: data.map((d) => +yOf(d.dt).toFixed(1)), labels: data.map((d) => String(d.dt)) },
      ],
    },
  };
}

// 近一周：折线
function lineChart(key, color, unit, fmt, opts = {}) {
  const W = opts.w ?? 500, H = opts.h ?? 190;
  const P = { t: 18, r: 10, b: 30, l: 46 };
  const n = data.length, iw = W - P.l - P.r, ih = H - P.t - P.b;
  const vals = data.map((d) => d[key]);
  const lo = Math.min(...vals), hi = Math.max(...vals), padv = (hi - lo || 1) * 0.22;
  const { g, yOf } = axes(W, H, P, hi + padv, lo - padv, 3, fmt, (W, P, iw, H) =>
    data.map((d, i) => `<text x="${(P.l + (iw / n) * (i + 0.5)).toFixed(1)}" y="${H - P.b + 18}" fill="#7b8698" font-size="9.5" text-anchor="middle">${d.date.slice(5)}</text>`).join(''),
  );
  const pts = vals.map((v, i) => `${(P.l + (iw / n) * (i + 0.5)).toFixed(1)},${yOf(v).toFixed(1)}`);
  let s = g;
  s += `<polygon points="${P.l},${P.t + ih} ${pts.join(' ')} ${W - P.r},${P.t + ih}" fill="${color}" opacity="0.1"/>`;
  s += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
  vals.forEach((v, i) => {
    s += `<circle cx="${(P.l + (iw / n) * (i + 0.5)).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="2.6" fill="${color}"/>`;
  });
  const xs = vals.map((_, i) => +(P.l + (iw / n) * (i + 0.5)).toFixed(1));
  return {
    svg: `<text x="${P.l}" y="11" fill="#7b8698" font-size="10">${unit}</text>${s}`,
    desc: {
      id: opts.id, w: W, h: H, plot: P,
      yMin: +(lo - padv).toFixed(2), yMax: +(hi + padv).toFixed(2), fmt: opts.fmt,
      xs,
      xLabels: data.map((d) => d.date.slice(5)),
      series: [{ name: opts.name, color, ys: vals.map((v) => +yOf(v).toFixed(1)), labels: vals.map(opts.label) }],
    },
  };
}

const intra = intradayChart();
const zoomJs = readFileSync('intraday-zoom.js', 'utf8');
const crosshairJs = readFileSync('crosshair.js', 'utf8');
const last = data.at(-1), prev = data.at(-2);
const dlt = (a, b, dec = 0) => {
  const d = a - b;
  return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d.toFixed(dec)}</span>`;
};
const chg = (s) => s.grid.at(-1)[1];

const kpis = [
  ['涨停家数', `<span class="up">${last.zt}</span>`, `较前日 ${dlt(last.zt, prev.zt)}`],
  ['跌停家数', `<span class="down">${last.dt}</span>`, `较前日 ${dlt(last.dt, prev.dt)}`],
  ['两市成交额', `${(last.amountYi / 10000).toFixed(2)}<span class="u">万亿</span>`, `较前日 ${dlt(last.amountYi, prev.amountYi)} 亿`],
  ['上证指数', last.shClose.toFixed(2), `较前日 ${dlt(last.shClose, prev.shClose, 2)}`],
].map(([l, v, d]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');

const cards = EVENTS.map((e) => {
  const live = e.days <= 0 && e.endDays >= 0; // 已开始但未结束
  const badge = live
    ? `<div class="ev-days live"><b>进行中</b><span>${e.endDays === 0 ? '今日结束' : '剩 ' + e.endDays + ' 天'}</span></div>`
    : `<div class="ev-days"><b>${e.days}</b><span>天</span></div>`;
  const kindCls = e.kind === '中美互动' ? 'kind us' : e.kind === '休市' ? 'kind hol' : 'kind';
  // 有来源的标注来源，方便回溯核实
  const srcNote = e.source ? ` · 来源：${esc(e.source)}` : '';
  return `<div class="ev${live || e.days <= 14 ? ' urgent' : ''}">
    ${badge}
    <div><div class="ev-name">${esc(e.name)}<em class="${kindCls}">${esc(e.kind)}</em>${e.src === 'habit' ? '<em class="habit">惯例推算</em>' : ''}</div>
    <div class="ev-meta">${e.span ? esc(e.span) + ' · ' : ''}${esc(e.date)}${e.note ? ' · ' + esc(e.note) : ''}</div>
    ${srcNote ? `<div class="ev-meta">${srcNote.slice(3)}</div>` : ''}</div></div>`;
}).join('');

// 节假日效应表：长假前 5 日 / 节后首日 / 节后 5 日的上证表现（16 年样本）
const pct = (v) => `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
const holHtml = HOLSTAT
  ? `<div class="holbox">
  <div class="holhead">长假前后上证表现（历史 ${HOLSTAT.count} 个长假 · ${esc(HOLSTAT.span)}）</div>
  <table class="hol">
    <thead><tr><th>假期</th><th>n</th><th>节前5日</th><th>胜率</th><th>节后首日</th><th>胜率</th><th>节后5日</th><th>胜率</th></tr></thead>
    <tbody>
      <tr class="all"><td>全部长假</td><td>${HOLSTAT.total.n}</td>
        <td>${pct(HOLSTAT.total.before)}</td><td>${HOLSTAT.total.beforeWin.toFixed(0)}%</td>
        <td>${pct(HOLSTAT.total.after1)}</td><td>${HOLSTAT.total.after1Win.toFixed(0)}%</td>
        <td>${pct(HOLSTAT.total.after5)}</td><td>${HOLSTAT.total.after5Win.toFixed(0)}%</td></tr>
      ${HOLSTAT.byName.filter((r) => r.n >= 3).map((r) => `<tr><td>${esc(r.name)}</td><td>${r.n}</td>
        <td>${pct(r.before)}</td><td>${r.beforeWin.toFixed(0)}%</td>
        <td>${pct(r.after1)}</td><td>${r.after1Win.toFixed(0)}%</td>
        <td>${pct(r.after5)}</td><td>${r.after5Win.toFixed(0)}%</td></tr>`).join('')}
    </tbody>
  </table>
  <div class="holnote"><b>对照基准（同期任意交易日）</b>：单日 ${pct(HOLSTAT.base1.mean)} / 上涨占比 ${HOLSTAT.base1.win.toFixed(0)}%（n=${HOLSTAT.base1.n}）；任意 5 日 ${pct(HOLSTAT.base5.mean)} / 上涨占比 ${HOLSTAT.base5.win.toFixed(0)}%（n=${HOLSTAT.base5.n}）。把长假数字和这一行比，差值才是「假期效应」本身。<br>
  样本 n 偏小（同名假期仅 3~16 次），且 2008/2015/2020 等特殊年份会放大结果，<b>只作为日历背景参考，不构成任何操作依据</b>。</div>
</div>`
  : '';

// ---------- 盘前信号：T 日状态 × T+1 集合竞价跳空 ----------
// ⚠️ T 日必须是**已完成**的交易日。若在盘中运行日更，market-data.json 的最后一天会是
//    当天未收盘的不完整数据，直接拿它当 T 会造成
//      → 信号状态用错日期 → serve-dashboard 的 /signal 把实时行情判成 stale
//    所以盘中运行时自动回退到前一个交易日
const LONG = (() => {
  try {
    return JSON.parse(readFileSync('daily-long.json', 'utf8'));
  } catch {
    console.warn('警告: daily-long.json 不可读，盘前信号面板将省略（运行 node fetch-daily-long.mjs）');
    return null;
  }
})();
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NOW2 = new Date();
const MARKET_CLOSED = NOW2.getHours() * 60 + NOW2.getMinutes() >= 15 * 60;
let T_DATE = last.date;
if (T_DATE === localIso(NOW2) && !MARKET_CLOSED && data.length >= 2) {
  console.warn(`  ! 盘中运行 ${T_DATE} 尚未收盘，信号状态回退到 ${data.at(-2).date}`);
  T_DATE = data.at(-2).date;
}
const SIG = [];
// ⚠️ market-data 与 daily-long 可能差一天：盘中跑日更时，market-data 的降级路径（新浪日线）
//    会写入当天「未完成」的 bar，而 daily-long 不会。此前要求两者日期完全相等，
//    一旦不等就整块信号面板被省略 —— 改为取两者中较早者（即最后一个已完成交易日）
if (LONG) {
  const dlLast = Object.values(LONG.series).map((s) => s.bars.at(-1)?.d).filter(Boolean).sort().at(-1);
  if (dlLast && T_DATE > dlLast) {
    console.warn(`  ! market-data(${T_DATE}) 领先 daily-long(${dlLast})，信号状态回退到 ${dlLast}`);
    T_DATE = dlLast;
  }
}
if (LONG) {
  for (const [key, s] of Object.entries(LONG.series)) {
    const upto = s.bars.filter((b) => b.d <= T_DATE);
    if (upto.length < 25 || upto.at(-1).d !== T_DATE) continue;
    SIG.push({ key, name: s.name, ...stateOf(upto) });
  }
}
if (LONG && !SIG.length) console.warn(`警告: daily-long.json 中找不到 ${T_DATE}，信号面板将省略`);

// ---------- 应对复盘：把「理论应对」和「实际」并排 ----------
// 只用 T+1 已经**完整收盘**的样本（i+1 <= T_DATE），否则会拿当日未完成的 bar 当结果。
// 触发条件很严（跳空 >±1% 且 T 日涨跌超阈值），16 年 3978 个交易日只有 105 次触发（2.6%），
// 所以「前 5 个交易日」大多全是观望 —— 再补一张「最近 5 次触发」表，否则这块永远是空的。
const sigReview = (() => {
  const bars = LONG?.series?.sh?.bars;
  if (!bars) return null;
  const lastIdx = bars.findIndex((b) => b.d === T_DATE);
  if (lastIdx < 23) return null;
  const evalAt = (i) => {
    const st = stateOf(bars.slice(0, i + 1));
    const gap = (bars[i + 1].o / bars[i].c - 1) * 100;
    const intra = (bars[i + 1].c / bars[i + 1].o - 1) * 100;
    const d = decide(st, gap);
    const acted = d.action.key !== 'watch';
    return {
      date: st.date,
      next: bars[i + 1].d,
      retT: st.retT,
      gap,
      intra,
      act: d.action,
      expect: d.expect,
      acted,
      // 偏减仓赚的是「开盘卖、收盘买回」→ 取日内涨跌的反向；持有/偏持有就是日内本身
      real: !acted ? null : d.action.key === 'cut' ? -intra : intra,
    };
  };
  const recent = [];
  for (let i = Math.max(22, lastIdx - 5); i < lastIdx; i++) recent.push(evalAt(i));
  const triggers = [];
  for (let i = lastIdx - 1; i >= 22 && triggers.length < 5; i--) {
    const r = evalAt(i);
    if (r.acted) triggers.push(r);
  }
  if (!recent.length || !triggers.length) return null;
  return { recent, triggers, sinceLast: lastIdx - bars.findIndex((b) => b.d === triggers[0].date) };
})();

const sigReviewHtml = !sigReview
  ? ''
  : (() => {
      const pctc = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      const col = (v) => (v == null ? '#7b8698' : v >= 0 ? '#ff7a86' : '#43d19a');
      const row = (r, withExpect) => {
        // 触发表可能横跨一年，「近年份」+ 月日才不歧义
        const cells =
          `<td>${withExpect ? r.date.slice(2) : r.date.slice(5)}</td>` +
          (withExpect ? '' : `<td class="${r.retT >= 0 ? 'up' : 'down'}">${pctc(r.retT)}</td>`) +
          `<td class="${r.gap >= 0 ? 'up' : 'down'}">${pctc(r.gap)}</td>` +
          `<td style="color:${r.act.color}">${r.act.label}</td>` +
          (withExpect ? `<td>${r.expect == null ? '—' : pctc(r.expect)}</td>` : '') +
          `<td style="color:${col(r.real)}">${r.real == null ? '—' : pctc(r.real)}</td>`;
        return `<tr>${cells}</tr>`;
      };
      const hit = sigReview.triggers.filter((r) => r.real != null);
      const win = hit.filter((r) => r.real > 0).length;
      const sum = hit.reduce((s, r) => s + r.real, 0);
      return `
      <div class="sect" style="margin-top:10px">前 5 个交易日：理论应对 vs 实际</div>
      <table class="stbl">
        <tr><th>日期</th><th>T日涨跌</th><th>次日跳空</th><th>理论应对</th><th>实际</th></tr>
        ${sigReview.recent.map((r) => row(r, false)).join('')}
      </table>
      <div class="sect" style="margin-top:10px">最近 5 次触发（含历史期望）</div>
      <table class="stbl">
        <tr><th>日期</th><th>次日跳空</th><th>理论应对</th><th>期望</th><th>实际</th></tr>
        ${sigReview.triggers.map((r) => row(r, true)).join('')}
      </table>
      <div class="tiny" style="margin-top:6px;line-height:1.6">
        <b>实际</b>口径：偏减仓＝开盘卖、收盘买回（−日内涨跌）；偏持有/持有别减＝日内 开→收。均未扣成本（往返约 0.12%）。
        观望＝不操作，无实际收益。<br>
        最近 ${sigReview.sinceLast} 个交易日未触发；最近 5 次触发累计 <b style="color:${col(sum)}">${pctc(sum)}</b>，
        命中 <b>${win}/${hit.length}</b>（样本极少，只作口径核对，不构成任何操作依据）。
      </div>`;
    })();

const sigState = SIG.find((s) => s.key === 'sh') ?? SIG[0] ?? null;
const sigPanelHtml = !sigState
  ? ''
  : `<div class="panel" data-panel="signal"><div class="phead"><h2>明日开盘应对<span class="hint">T 日状态 × T+1 集合竞价跳空 · 开盘后自动更新</span></h2>
    <span class="hint" id="sigStamp">等待竞价…</span></div>
  <div class="sgrid">
    <div>
      <div class="sect">T 日状态（${T_DATE} 收盘）</div>
      <table class="stbl">
        <tr><th>指数</th><th>T 日涨跌</th><th>量能(÷20日均)</th><th>档位</th></tr>
        ${SIG.map((s) => {
          const tier = s.retT <= TH.retWeak ? ['弱', '#43d19a'] : s.retT >= TH.retStrong ? ['强', '#ff7a86'] : ['不够极端', '#7b8698'];
          const vol = s.amtRatio == null ? '—' : s.amtRatio < TH.amtLow ? '缩量' : s.amtRatio >= TH.amtHigh ? '放量' : '平量';
          return `<tr><td>${esc(s.name)}</td><td class="${s.retT >= 0 ? 'up' : 'down'}">${s.retT >= 0 ? '+' : ''}${s.retT.toFixed(2)}%</td>` +
            `<td>${s.amtRatio == null ? '—' : s.amtRatio.toFixed(2) + '×'} <span class="tiny">${vol}</span></td>` +
            `<td style="color:${tier[1]}">${tier[0]}</td></tr>`;
        }).join('')}
      </table>
      <div class="sect" style="margin-top:8px">竞价跳空后的建议（上证口径）</div>
      <div id="sigDecision" class="sigbox">竞价数据将在开盘后自动获取；下方是条件清单。</div>
    </div>
    <div>
      <div class="sect">条件清单（按 T 日状态预演）</div>
      <table class="stbl" id="sigPlaybook">
        <tr><th>情形</th><th>建议</th><th>历史期望</th><th>时段一致</th></tr>
        ${playbook(sigState)
          .map(
            (r) =>
              `<tr><td>${esc(r.cond)}</td><td style="color:${r.act.color}">${esc(r.act.label)}</td>` +
              `<td>${r.expect == null ? '—' : `${r.expect >= 0 ? '+' : ''}${r.expect.toFixed(2)}%`}</td><td>${r.era}</td></tr>`,
          )
          .join('')}
      </table>
      <div class="tiny" style="margin-top:6px;line-height:1.6">
        期望值口径：<b>偏减仓</b>为「开盘卖出、收盘买回」的收益；<b>持有/偏持有</b>为日内（开→收）收益。均未扣成本（往返约 0.12%）。
      </div>${sigReviewHtml}
    </div>
  </div>
  <div class="foot" id="sigFoot">读秒中…</div>
</div>`;

// 给服务端 /signal 用的轻量状态文件（只含 T 日状态，不含 1.6MB 历史）
if (SIG.length) {
  writeFileSync(
    'signal-state.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), T: T_DATE, thresholds: TH, states: SIG }, null, 1),
    'utf8',
  );
}

const ztdt = barsChart();
const amount = lineChart('amountYi', '#5b8def', '单位：亿元', (v) => (v / 1000).toFixed(1) + 'k', {
  id: 'chAmount', name: '成交额', fmt: 'k', label: (v) => `${Math.round(v)} 亿`,
});
const chartDescs = [ztdt.desc, amount.desc];
const candlesData = JSON.parse(readFileSync('candles.json', 'utf8'));
const candlesJs = readFileSync('candles.js', 'utf8');

// 跌停统计（由 analyze-dt.mjs 生成：每日综合严重度分 + 分档 + 相关性）
let dtStats = null;
try {
  dtStats = JSON.parse(readFileSync('dt-stats.json', 'utf8'));
} catch {
  console.warn('警告: dt-stats.json 不存在，跌停标注与统计面板将省略');
}
const dtDaily = dtStats?.daily ?? {};
// analyze-dt.mjs 的 daily 记录只保留了 big，丢失 mid/small；悬停卡片要显示「大/中/小」分布，
// 所以从原始 dt-counts.json 把这两个字段补回来（同一天同一口径，直接按日期合并）
const dtRaw = (() => {
  try {
    const j = JSON.parse(readFileSync('dt-counts.json', 'utf8'));
    return j.counts ?? j;
  } catch {
    console.warn('警告: dt-counts.json 不可读，悬停卡片的「大/中/小」分布将缺失');
    return {};
  }
})();
let dtMissing = 0;
for (const [d, v] of Object.entries(dtDaily)) {
  const raw = dtRaw[d];
  if (!raw) { dtMissing++; continue; }
  if (v.mid == null) v.mid = raw.mid;
  if (v.small == null) v.small = raw.small;
}
if (dtMissing) console.warn(`警告: ${dtMissing} 个交易日在 dt-counts.json 中无对应记录`);
// 三档门槛现在挂在**情绪分 sent** 上（前 5% / 3% / 1%），与面板刻度同一量纲，
// 且不随窗口长度重标。字段名用 minSent 以免和绝对严重度分混淆。
const DT_TIERS = (dtStats?.tiers ?? [])
  .map((t) => ({ minSent: t.sentLo, maxSent: t.sentHi, color: t.color, name: t.name }))
  .sort((a, b) => b.minSent - a.minSent);
// 乐观侧镜像档位（门槛 = 100 − 恐慌侧 sentLo，在 sentiment-map.mjs 里推导，不写死）。
// 散点图右轴读乐观指数，低恐慌那端按这套冷色标出来。
const DT_TIERS_OPT = tiersOpt().sort((a, b) => b.minOptimism - a.minOptimism);
if (dtStats?.tiers?.length) {
  console.log(
    `跌停标注: 覆盖 ${Object.keys(dtDaily).length} 个交易日，分档 ` +
      [...(dtStats.tiers ?? [])].reverse().map((t) => `${t.name}≥${t.sentLo}=${t.n}天`).join(' / ') +
      `，合计标记 ${dtStats.marked} 天（门槛 = 情绪分，与窗口长度无关）`,
  );
}

// 统计结论面板
const METRIC_ROWS = [
  ['dt', '跌停家数', 'A 广度'],
  ['cap', '跌停市值占比', 'A 深度'],
  ['mem', '权重股跌停数', 'F 权重'],
  ['big', '大盘股跌停数', 'B 分层'],
  ['score', '综合严重度分', 'A+B+F'],
];
// 情绪指标（由 sentiment-backtest.mjs 生成）—— 必须早于 markedDays，
// 因为标记日现在按情绪分筛，而不是按绝对严重度分。
let senti = null;
try {
  senti = JSON.parse(readFileSync('sentiment.json', 'utf8'));
} catch {
  console.warn('警告: sentiment.json 不存在，情绪面板将省略');
}

const markedDays = Object.entries(dtDaily)
  .map(([d, v]) => ({ d, ...v, sent: senti?.daily?.[d]?.sent ?? null }))
  .filter((v) => v.sent != null && v.sent >= (dtStats?.tiers?.[0]?.sentLo ?? 74.7))
  .sort((a, b) => b.sent - a.sent);
const countMissed = markedDays.filter((v) => v.dt < 60);   // 纯家数阈值会漏掉

// 情绪分阈值 → 次日上涨率。样本拉长后中档阈值（≥60）的边际会塌掉，这类行整行标红。
const thHtml = senti?.thresholds?.length
  ? `<div class="sect" style="margin-top:12px">情绪分阈值 → 次日上证上涨率 <span class="hint">样本 ${senti.window.n} 天</span></div>
      <table class="stbl">
        <tr><th>阈值</th><th>天数</th><th>次日上涨</th><th>边际</th><th>p 值</th></tr>
        ${senti.thresholds
          .map(
            (t) => `<tr class="${t.valid ? '' : 'stale'}">
          <td>情绪分 ≥ ${t.T}</td><td>${t.n}</td><td>${t.wr}%</td>
          <td>${t.edge >= 0 ? '+' : ''}${t.edge}pp</td><td>${t.p}</td></tr>`,
          )
          .join('')}
      </table>
      <div class="tiny" style="margin-top:5px"><span class="staleTxt">红色行</span> = 该阈值在<b>本窗口下已不具备区分度</b>（边际 &lt; 3pp 或 p ≥ 0.1，判定标准见「说明」）。基准＝窗口内无条件次日上涨率 ${senti.base1}%。<b>不是阈值越高越灵</b>：中间档在长样本里会塌掉，只有极端档站得住 —— 而极端档本身是多重比较的幸存者。</div>`
  : '';

const bigCapLeaders = markedDays.filter((v) => v.cap >= 2.5 && v.dt < 60); // 数量少但市值重

// 当前状态（最新交易日）—— Object.entries 返回 [日期, 对象] 二元组，取值必须走 [1]
const lastState = Object.entries(dtDaily).sort((a, b) => (a[0] < b[0] ? 1 : -1))[0];
const lsDate = lastState?.[0] ?? null;
const ls = lastState?.[1] ?? null;
// 0~100 刻度上的情绪分（和上方刻度同一个量）。必须与绝对严重度分 score 区分开：
// 标记日是**按 score ≥ 1.25 挑的**，表里如果直接摆 score，读起来会和刻度数字混为一谈。
const sentStr = (d) => (senti?.daily?.[d]?.sent != null ? senti.daily[d].sent.toFixed(1) : '—');
const typeColor = { 微盘踩踏: '#3fa66b', 权重杀跌: '#ef4d5a', 全面抛售: '#f59e0b' };
const statePanel = senti
  ? `<div class="panel" data-panel="state"><h2>恐慌情绪状态描述器
      <span class="hint">只做状态刻画，不输出预测概率</span></h2>
  <div class="sgrid">
    <div>
      <div class="sect">恐惧–贪婪刻度（0 = 平静，100 = 极端恐慌）</div>
      <div class="gauge">
        <div class="gbar">${[0, 20, 40, 60, 80].map((v, i) => `<div class="gseg" style="left:${v}%;width:20%;background:${['#2f3b52', '#3b4a66', '#5b4a7a', '#8a4a8a', '#c25a3a'][i]}"></div>`).join('')}
          <div class="gmark" style="left:${Math.min(99, lastState ? senti.daily[lastState[0]]?.sent ?? 0 : 0)}%"></div>
        </div>
        <div class="gscale">${[0, 20, 40, 60, 80, 100].map((v) => `<span style="left:${v}%">${v}</span>`).join('')}</div>
      </div>
      <div class="bignum">当前恐慌情绪 <b>${senti?.daily?.[lsDate]?.sent != null ? senti.daily[lsDate].sent.toFixed(1) : '—'}</b>
        <span class="tiny">（${lsDate ?? '—'}）</span></div>
      <table class="stbl" style="margin-top:8px">
        <tr><th>指标</th><th>数值</th></tr>
        <tr><td>跌停家数</td><td>${ls?.dt ?? '—'}</td></tr>
        <tr><td>跌停市值占比</td><td>${ls?.cap != null ? ls.cap.toFixed(2) + '%' : '—'}</td></tr>
        <tr><td>权重股跌停</td><td>${ls?.mem ?? '—'}</td></tr>
        <tr><td>大/中/小盘跌停</td><td>${ls ? `${ls.big}/${ls.mid}/${ls.small}` : '—'}</td></tr>
        <tr><td>主导维度</td><td>${ls?.dom ? esc(ls.dom) : '—'}</td></tr>
        <tr><td>综合严重度分</td><td>${ls?.score != null ? ls.score.toFixed(2) : '—'}</td></tr>
      </table>
      <div class="sect" style="margin-top:14px">恐慌情绪 · 每日散点</div>
      <div id="sentChart"></div>
      <div class="tiny" style="margin-top:4px">左轴 = <b>情绪分</b>（0~100，与上方刻度同一量纲，越高越恐慌），右轴 = <b>乐观指数</b>（= 100 − 情绪分，镜像，越高越乐观），横轴 = 交易日；两侧是同一个分布（都是 N(50, 15²)）的两种读法，共用网格线。滚轮缩放 · 拖拽平移 · 双击复位；悬停看该日跌停家数。<br>
        彩点：<i class="mk" style="background:#ec4899"></i><i class="mk" style="background:#a855f7"></i><i class="mk" style="background:#f59e0b"></i>恐慌侧（粉/紫/橙，情绪分前 5%/3%/1%）；
        <i class="mk" style="background:#22d3ee"></i><i class="mk" style="background:#2dd4bf"></i><i class="mk" style="background:#22c55e"></i>乐观侧（青/碧/绿，乐观指数前 5%/3%/1%，即情绪分最<b>低</b>的那部分）。两侧同一分位、不同色相，一个点只会命中一侧。</div>
    </div>
    <div>
      <div class="sect">恐慌类型（按跌停股市值结构，仅家数≥10 时判定）</div>
      <table class="stbl">
        <tr><th>类型</th><th>特征</th><th>全样本天数</th><th>标记日</th></tr>
        ${['微盘踩踏', '权重杀跌', '全面抛售']
          .map((t) => {
            const n = Object.values(dtDaily).filter((v) => v.type === t).length;
            const mk = markedDays.filter((v) => v.type === t).length;
            const desc = t === '微盘踩踏' ? '小盘占比 ≥65%' : t === '权重杀跌' ? '大盘占比 ≥50%' : '介于两者之间';
            return `<tr><td><i class="mk" style="background:${typeColor[t]}"></i>${t}</td><td class="tiny">${desc}</td><td>${n}</td><td>${mk}</td></tr>`;
          })
          .join('')}
      </table>
      <div class="sect" style="margin-top:10px">标记日的类型归属（说明"跌停潮"是三种不同事件）</div>
      <div class="tblscroll"><table class="stbl">
        <tr><th>日期</th><th>情绪分<em class="tag">0-100</em></th><th>类型</th><th>大/中/小</th><th>市值占比</th></tr>
        ${markedDays
          .map(
            (r) => `<tr><td>${r.d}</td><td>${sentStr(r.d)}<span class="tiny"> 严重度 ${r.score}</span></td>
          <td><i class="mk" style="background:${typeColor[r.type] ?? '#555'}"></i>${r.type ?? '—'}</td>
          <td>${r.big}/${r.mid}/${r.small}</td><td>${r.cap.toFixed(2)}%</td></tr>`,
          )
          .join('')}
      </table></div>
      <div class="tiny" style="margin-top:5px">「情绪分」是 0~100 刻度上的读数（与上方刻度同一个量，算法见「说明」）；「严重度」是绝对强度分 = max(跌停家数/60, 跌停市值占比/1.0, 权重股跌停数/12)。<b>标记日按情绪分筛（门槛 ${dtStats?.tiers?.[0]?.sentLo ?? 74.7}）</b>，共 ${markedDays.length} 天，列表可滚动。</div>
    </div>
  </div>
  <div class="foot">
    <b>定位</b>：本面板是<b>状态描述器</b>——回答"现在恐慌到什么程度、属于哪种结构"，<b>不回答"该不该买"</b>。极端情绪之后的反弹倾向在样本内存在，但跨期不稳定，因此不输出预测概率。
  </div></div>`
  : '';

const dtPanel = dtStats
  ? `<div class="panel" data-panel="dtstat"><h2>跌停家数 × 市值 × 权重股 · 统计关系
      <span class="hint">${dtStats.window.start} ~ ${dtStats.window.end} · ${dtStats.window.n} 个交易日 · 全市场本地计算</span></h2>
  <div class="sgrid">
    <div>
      <table class="stbl">
        <tr><th>指标</th><th>vs 当日</th><th>vs 未来1日</th><th>vs 未来5日</th></tr>
        ${METRIC_ROWS.map(([k, label, tag]) => {
          const c = dtStats.corrs[k];
          const f = (o, signed) => {
            const star = o.p < 0.01 ? '**' : o.p < 0.05 ? '*' : '';
            return `<td class="${o.r >= 0 ? 'up' : 'down'}">${signed && o.r >= 0 ? '+' : ''}${o.r.toFixed(3)}${star}</td>`;
          };
          return `<tr><td>${label} <em class="tag">${tag}</em></td>${f(c.ret, false)}${f(c.f1, true)}${f(c.f5, true)}</tr>`;
        }).join('')}
      </table>
      <div class="tiny">** p&lt;0.01 · * p&lt;0.05 — 综合严重度分 = max(家数/60, 市值占比/1.0, 权重股/12)</div>
      <table class="stbl" style="margin-top:10px">
        <tr><th>档</th><th>情绪分门槛</th><th>天数</th><th>占比</th><th>反转命中</th><th>lift</th><th>5日胜率</th><th>本窗口 score 区间</th></tr>
        ${dtStats.tiers
          .map(
            (t) => `<tr>
          <td><i class="mk" style="background:${t.color}"></i>${t.name}·${t.label}</td>
          <td>≥ ${t.sentLo}<span class="tiny">（前 ${(t.pct * 100).toFixed(0)}%）</span></td>
          <td>${t.n}</td>
          <td>${t.share}%</td>
          <td>${t.lowHit.toFixed(0)}%</td>
          <td class="up">${t.lift.toFixed(2)}x</td>
          <td>${t.f5Win.toFixed(0)}%</td>
          <td class="tiny">${t.scoreLo != null ? `${t.scoreLo.toFixed(2)}~${t.scoreHi.toFixed(2)}` : '—'}</td>
        </tr>`,
          )
          .join('')}
      </table>
      <div class="tiny" style="margin-top:5px">档位按<b>情绪分</b>切（窗口内最严重的前 3~5% / 1~3% / 1%），<b>与窗口长度无关</b> —— 样本从 300 天拉到三年也不会重标。最右列只是各档在本窗口实际覆盖的绝对严重度分，随窗口变化，不参与判定。</div>
    </div>
    <div>
      <div class="tblscroll"><table class="stbl">
        <tr><th>日期</th><th>情绪分<em class="tag">0-100</em></th><th>严重度</th><th>家数</th><th>市值占比</th><th>大/中/小</th><th>权重</th><th>主导</th></tr>
        ${markedDays
          .map(
            (r) => `<tr>
          <td>${r.d}</td>
          <td class="up"><b>${sentStr(r.d)}</b></td>
          <td>${r.score}</td>
          <td>${r.dt}</td>
          <td>${r.cap.toFixed(2)}%</td>
          <td>${r.big}/${r.mid}/${r.small}</td>
          <td>${r.mem}</td>
          <td>${r.dom}</td>
        </tr>`,
          )
          .join('')}
      </table></div>
      ${thHtml}
    </div>
  </div>
  <div class="foot">
    <b>为什么不能只看家数</b>：同样叫"跌停潮"，结构可以完全相反 —— <b>03-23</b> 家数 133 但市值占比仅 0.92%（大盘只有 2 只、小盘 90 只，纯微盘踩踏）；<b>07-02</b> 家数仅 39 但市值占比 2.75%（大盘 22 只，权重股杀跌）。<b>按家数排序会把这两个性质相反的事件排反</b>。<br>
    <b>综合严重度分</b> = max(家数/60, 市值占比/1.0, 权重股/12)，含义是"最严重的那个维度达到几倍门槛"，两类极值都能捕获。<b>但它无上界</b>，不能直接拿来分档；本面板的粉/紫/橙改挂在<b>情绪分</b>上（窗口内最严重的前 5% / 3% / 1%），与窗口长度无关。本次 ${markedDays.length} 个标记日中，<b>${countMissed.length} 天是纯家数阈值（跌停 < 60 家）会完全漏掉的</b>${countMissed.length ? `（${countMissed.map((v) => `${v.d.slice(5)}/${v.dt}家`).join('、')}）` : ''}。<br>
    <b>⚠️ 窗口长度对结论影响极大 —— 而且这次是往「显著」的方向翻</b>：153 天窗口下「跌停家数 → 未来 1 日收益」是 <b>+0.216（p=0.007，显著）</b>；缩到 300 天降到 <b>+0.110（p=0.056，不显著）</b>，当时据此判过「结论不稳健」；现在扩到 <b>${dtStats?.window?.n ?? 743} 天（近三年）又回到 +0.136（p=0.0002，显著）</b>。三段点估计方向一致、都落在 +0.11~+0.22，说明信号本身存在，只是<b>中等样本量下信噪比不足</b>。教训：任何「某窗口下不显著」的判断都不该当成结论。<br>
    <b>档位表现（本窗口）</b>：橙档（前 1%，${dtStats?.tiers?.[2]?.n ?? 0} 天）反转 lift 最高 ${(dtStats?.tiers?.[2]?.lift ?? 0).toFixed(2)}x、5 日胜率 ${(dtStats?.tiers?.[2]?.f5Win ?? 0).toFixed(0)}%、5 日均值 ${(dtStats?.tiers?.[2]?.f5 ?? 0).toFixed(2)}%；紫档（前 3%）lift ${(dtStats?.tiers?.[1]?.lift ?? 0).toFixed(2)}x、胜率 ${(dtStats?.tiers?.[1]?.f5Win ?? 0).toFixed(0)}%；粉档（3~5%）lift ${(dtStats?.tiers?.[0]?.lift ?? 0).toFixed(2)}x、胜率 ${(dtStats?.tiers?.[0]?.f5Win ?? 0).toFixed(0)}%。单档样本只有个位数到十几，<b>不足以据此下单</b>。<br>
    <b>口径与偏差</b>：历史市值 = 当前流通市值 × 收盘比（假设股本不变，跨越 15 个月误差大于短窗口）；权重股名单为当前沪深300+中证500，存在成分变更前视偏差；失败个股 ${Object.keys(dtDaily).length ? '' : ''}约 3%，会小幅低估。<b>以上为统计描述，不是预测模型，不足以作为交易依据。</b>
  </div></div>`
  : '';

// ---------- 每个面板自己的「说明」内容（原全局长脚注拆解到各面板） ----------
const PDESC = {
  signal: {
    title: '明日开盘应对（盘前信号）',
    html: `<b>逻辑</b>：T 日状态 × T+1 集合竞价跳空 → T+1 开盘应对。两个条件在 <b>T+1 集合竞价结束（9:25）时都已观测到</b>，所以可执行；T+1 下「卖出手上已有持仓、收盘再买回」合法，赚的是<b>开盘→收盘</b>的回落。<br>
<b>依据</b>：16 年 × 4 指数 × 15876 对 (T, T+1) 对。核心是<b>交互效应</b>——跳空本身几乎没有信息（低开→高开的跨度只有 −0.11%），必须叠加 T 日状态才显现。<b>弱市高开跨度 −0.95%，强市高开跨度 +0.97%</b>。中间状态（中性）历史上无边缘（各时段方向 2/4 一致）。<br>
<b>T 日状态用两个维度</b>（相关系数 0.22，基本独立）：涨跌幅（±0.5% 分档）与成交量 ÷ 20 日均值（0.9 / 1.15 分档）。<br>
<b>分时代一致性</b>：弱+高开 4/4、弱+缩量+高开 4/4、强(≥1%)+高开 4/4、强+放量+高开 3/3、弱+低开 4/4 时段方向一致。作为对照，早先那个「无条件高开低走」效应在 2019-2021 直接翻负。<br>
<b>阈值不是拟合出来的</b>：弱势阈值从 −0.2% 到 −1.5% 全程单调且几乎全 4/4（−0.2%: −0.37%、−0.5%: −0.42%、−1.0%: −0.48%）；跳空阈值也是干净的量效关系（+0.8%: −0.17% → +1.5%: −0.91% → +2.0%: −1.84%）。但强势侧 +0.5% 只有 3/4、+1.0% 才 4/4，故强弱阈值取不对称（−0.5% / +1.0%）。<br>
<b>⚠️ 局限</b>：① 频率低，单指数约 1.5~3 次/年；② 期望值未扣成本（往返约 0.12%）；③ 强市侧只有 3/4 时段一致，弱市侧更可靠；④ 样本是指数层面，个股会被平均掉。`,
  },
  intra: {
    title: '三大指数 45 日 5 分钟线',
    html: `<b>数据源</b>：新浪 <code>getKLineData</code>。该接口一次请求上限约 1950~1990 根 —— <code>scale=5&datalen=1950</code> 覆盖 41 个交易日，更早的几天用 <code>scale=15&datalen=900</code>（50 个交易日）补齐，所以窗口最老那几天是 15 分钟粒度，图上呈阶梯状。<br>
<b>为什么不用别的</b>：腾讯 <code>minute/query</code> 与 <code>day/query</code> <b>都会忽略 date 参数</b>，只返回最近 1 天 / 5 天；同花顺 5 分钟档对 <code>sh_</code>（沪市）代码返回 502；东财 kline 常被限流（有降级路径）。<br>
<b>口径</b>：日切为 09:35-11:30 / 13:05-15:00 共 48 档，每档取「时间 ≤ 档位」的末值。<b>「中证2000」用中证2000ETF华泰柏瑞(sh563300)代理</b>，存在小幅跟踪误差与折溢价；<b>「同花顺全A(沪深京)」</b>取同花顺自编指数 883957 —— 该接口对<b>当日有滞后（只写 1 根）</b>，已用当日 1 分钟分时（241 点）自动补齐。<br>
<b>极值标注</b>取上证指数在<b>当前视野</b>内的最高/最低<b>5 分钟收盘价</b>，并在该价位<b>横贯全图画出水平虚线</b>作为参考线；随缩放平移实时重算。注意是 5 分钟收盘价而非分笔瞬时高低，与行情软件的「最高价」可能差几分钱。<br>
<b>交互</b>：<b>上下两张图共享同一横向视野</b> —— 滚轮缩放（鼠标位置为锚点）、拖拽平移、双击复位在任一图上操作，另一张同步变化；十字准线的竖线同时出现在两张图上（横线与左轴数值只画在鼠标所在的那张），并与其他面板按日期联动。<br>
上图=累计涨跌幅（以区间首点为 0）；下图=每日归零（以当日首个有效点为 0），便于逐日比较日内形态。`,
  },
  candles: {
    title: '上证指数日K',
    html: `<b>数据源</b>：腾讯 <code>fqkline</code>，400 根前复权日线（2024-08-28 起）。<br>
<b>底部标记</b>按<b>情绪分</b>分档（不是绝对严重度分）：<i class="mk" style="background:#ec4899"></i>警觉（粉，情绪分 ≥ ${dtStats?.tiers?.[0]?.sentLo ?? 74.7}）<i class="mk" style="background:#a855f7"></i>强恐慌（紫，≥ ${dtStats?.tiers?.[1]?.sentLo ?? 78.2}）<i class="mk" style="background:#f59e0b"></i>极端（橙，≥ ${dtStats?.tiers?.[2]?.sentLo ?? 84.9}），即窗口内最严重的前 5% / 3% / 1%。<b>为什么不用绝对严重度分</b>：它无上界，三年窗口里最惨的一天（2025-04-07，2815 家跌停）能到 46.9，而写死的门槛只有 3.0，同一个颜色里会塞进相差十几倍的事件；情绪分是排名映射、天然有界，换个窗口长度也不用重标。<br>
<b>悬停</b>显示当日恐慌情绪 / 跌停家数 / 市值占比 / 权重股跌停 / 大/中/小盘分布。<br>
<b>粉/紫/橙标记日</b>的悬停卡片里还会多一张<b>「当日跌停家数走势」迷你曲线</b>（每 5 分钟一档），同时底部那条标记会被高亮。曲线由 <b>baostock 5 分钟线还原</b>：对当日每只跌停股，逐根 5 分钟 bar 判定「收盘价是否等于跌停价」，统计该时点封死跌停的家数，并给出累计曾触及家数。<br>
<b>为什么不用东财跌停池</b>：该接口只保留最近约 7 个交易日，且只有「最后封板时间」而非「首次触及」——例如北方铜业当日 09:40 就触及跌停、14:56 才最终封死，用最后封板时间画曲线会系统性滞后。<br>
<b>口径与偏差</b>：历史市值为估算（当前流通市值 × 当日收盘比，假设股本不变）；权重股名单为当前沪深300+中证500，存在成分变更的前视偏差。曲线按 5 分钟收盘价判定，与分笔口径可能有微小差异。`,
  },
  cyb: {
    title: '双创（创业板指 + 科创50）',
    html: `<b>数据源</b>：腾讯日线，创业板指 <code>sz399006</code>、科创50 <code>sh000688</code>。<br>
中证科创创业50 指数 <code>931643</code> 在腾讯无数据，故未采用。`,
  },
  dtstat: {
    title: '跌停家数 × 市值 × 权重股 · 统计关系',
    html: `<b>样本</b>：${dtStats?.window?.n ?? 0} 个交易日（${dtStats?.window?.start ?? '—'} 起，近三年）。<br>
<b>⚠️ 窗口长度对结论影响极大 —— 而且这次是往「显著」的方向翻</b>：153 天窗口下「跌停家数 → 未来 1 日收益」相关系数是 <b>+0.216（p=0.007，显著）</b>；缩到 300 天降到 <b>+0.110（p=0.056，不显著）</b>，当时据此判过「结论不稳健」；现在扩到 <b>${dtStats?.window?.n ?? 743} 天又回到 +0.136（p=0.0002，显著）</b>。三段点估计方向一致、都落在 +0.11~+0.22，说明信号本身存在，只是<b>中等样本量下信噪比不足</b>。教训：任何「某窗口下不显著」的判断都不该当成结论。<br>
<b>档位表现（本窗口）</b>：橙档（前 1%，${dtStats?.tiers?.[2]?.n ?? 0} 天）反转 lift 最高 ${(dtStats?.tiers?.[2]?.lift ?? 0).toFixed(2)}x、5 日胜率 ${(dtStats?.tiers?.[2]?.f5Win ?? 0).toFixed(0)}%；紫档（前 3%）lift ${(dtStats?.tiers?.[1]?.lift ?? 0).toFixed(2)}x、胜率 ${(dtStats?.tiers?.[1]?.f5Win ?? 0).toFixed(0)}%；粉档（3~5%）lift ${(dtStats?.tiers?.[0]?.lift ?? 0).toFixed(2)}x、胜率 ${(dtStats?.tiers?.[0]?.f5Win ?? 0).toFixed(0)}%。单档样本只有个位数到十几，<b>不足以据此下单</b>。<br>
<b>口径与偏差</b>：历史市值 = 当前流通市值 × 收盘比（跨越 15 个月误差较大）；权重股名单存在前视偏差；失败个股约 3%，会小幅低估。<b>以上为统计描述，不是预测模型，不足以作为交易依据。</b>`,
  },
  state: {
    title: '恐慌情绪状态描述器',
    html: `<b>只做状态刻画，不输出预测概率</b><br>
恐慌情绪拆成两个量，别混：<br>
① <code>score = max(跌停家数/60, 跌停市值占比%/1.0, 权重股跌停数/12)</code> —— <b>取最严重的那一维</b>，是<b>绝对强度</b>，1.0 表示某一维刚好达到阈值。上面那张表的数值是它。<br>
② <code>sent</code>（刻度上那个大数字）—— 把 score 在<b>最近 ${senti?.window?.n ?? 743} 个交易日（近三年）里的名次</b>换算成经验分位 p，再过标准正态分位得 <code>sent = 50 + 15·Φ⁻¹(p)</code>，即固定 <b>N(50, 15²)</b>。并列的 score 按日期顺序展开成不同名次（否则同分的日子会挤成同一个读数，直方图低端鼓包）。实测 均值 50.0 · 标准差 15.0 · 偏度 0.000 · 超峰度 −0.09。<br>
③ <code>乐观指数 = 100 − sent</code> —— <b>不是第三个量，是②的镜像读数</b>。散点图右轴就是它：同一个点左读恐慌、右读乐观，共用网格线。<b>高斯性自动继承</b>（关于 50 镜像不改变 N(50,15²)：均值 50.00 / 标准差 14.99 / 偏度 0.000 / 超峰度 −0.04），<b>不需要也无法单独拟合</b>。档位门槛与恐慌侧<b>同一组数字</b>（74.7 / 78.2 / 84.9），因为两者在同一个 0~100 刻度上：「最乐观的前 5%」= 乐观指数 ≥ 74.7 ⟺ 情绪分 ≤ 25.3。配色用冷色系（青/碧/绿）与恐慌侧（粉/紫/橙）对称，两侧同一分位、不同色相，避免「极度乐观」和「极度恐慌」撞色。<br>
<b>⚠️ 两端到不了 0 和 100</b>：分位公式的 p 最大只有 (N−0.5)/N，N=743 时上限约 94.9，实际读数落在 <b>1.9 ~ 98.1</b>。这是固定刻度的代价，换来的好处是<b>刻度不随样本重标</b> —— 曾试过把 z 线性拉伸到满量程、让最极端日 = 100，但那样刻度端点会绑死在「样本内极值」上：样本一变（出现新的极值日）整条历史读数都要重算，跨时间就不可比了。<br>
<b>为什么从指数式改成分位式</b>：更早用的是 <code>sent = 100×(1 − exp(−score/2.5))</code>，饱和指数曲线，实测 <b>82% 的日子挤在 0~20</b>，既不像高斯、也没法跨时间横向比较。<br>
<b>⚠️ 代价（重要）</b>：<code>sent</code> 是<b>相对读数</b> —— 同一个绝对 score 在不同窗口里会得到不同的 sent；<code>sent = 80</code> 的含义是「在当前窗口内严重程度排前 20%」，<b>既不是 80% 的概率，也不是绝对强度</b>。要看绝对强度请读 <code>score</code> 或上面那张表。窗口长度由 <code>DT_WINDOW</code> 控制，当前 <b>${senti?.window?.n ?? 743} 个交易日（约三年）</b>。<br>
<b>阈值表的红色行</b>：判定标准是「边际 ≥ 3pp 且二项检验 p &lt; 0.1」，二者缺一即标红。<b>注意多重比较</b>：同时看 7 个阈值再挑最显著的，等价于多重检验，需按 Bonferroni 把门槛压到 0.05/7 ≈ 0.007 —— 当前只有「情绪分 ≥ 80」过得了这一关。<br>
恐慌类型按跌停股的市值结构划分，<b>仅在家数 ≥ 10 时判定</b>：微盘踩踏（小盘 ≥65%）、权重杀跌（大盘 ≥50%）、全面抛售。<br>
此前做过的「情绪分 → 反弹概率」机器学习式预测因样本外表现不敌基准，已从面板移除。右下角那张表是<b>更朴素的条件概率</b>（不建模、不挑变量，直接把情绪分阈值与次日涨跌对上），留作背景参考 —— 里面标红的阈值在当前窗口下已无区分度，<b>不要把整张表当作可用信号</b>。`,
  },
  update: {
    title: '右下角「更新」按钮',
    html: `<b>作用</b>：按一下就让运行看板的那台电脑<b>立即抓一次最新行情并重算</b>，跑完页面会自动刷新。相当于手动触发一次日更（平时每日 15:40 自动跑）。<br>
<b>⚠️ 只在局域网里有效</b>：按钮是向「当前页面的主机」发请求。所以要用形如 <code>http://192.168.110.159:8848/</code> 的地址打开看板，且手机与电脑在同一 Wi-Fi。<br>
从 GitHub Pages（<code>https://...</code>）打开的页面<b>按不动</b> —— 一是 https 页面请求家里的 http 主机会被浏览器按混合内容拦掉，二是不在家时根本没有到那台电脑的路由。这时点按只会给出提示，不会发请求。<br>
<b>交易时段会先确认</b>：09:30-11:30 / 13:00-15:00 之间抓到的当日行情是不完整的（成交量、涨跌停家数都偏小），会先弹确认框。跑完的数据下一次正常日更会覆盖修正。<br>
<b>安全性</b>：这个接口只接受<b>内网来源</b>（按 TCP 对端地址判断，不信 Host 头），并要求带自定义请求头 <code>X-Astock-Update</code> —— 跨站请求带不上自定义头、带了又会触发 CORS 预检（本服务不应答预检），所以不用 token 也能挡住网页被诱导触发的 CSRF。<br>
<b>并发保护</b>：日更有单实例锁。若 15:40 的计划任务正在跑，手机再按按钮会被拒绝并提示「已在更新中」，不会两个日更同时改同一批文件。`,
  },
  ztdt: {
    title: '涨停 / 跌停家数',
    html: `<b>数据源</b>：东方财富涨跌停股池（<code>getTopicZTPool</code> / <code>getTopicDTPool</code>），显示最近 7 个交易日。<br>
该接口<b>必须显式传 <code>date</code> 参数</b>，否则会返回最新一天的数据；返回的 <code>qdate</code> 字段具有误导性，不可用于判断日期。`,
  },
  amount: {
    title: '两市成交额',
    html: `<b>数据源</b>：腾讯日线，沪深两市合计成交额，单位亿元，显示最近 7 个交易日。`,
  },
  events: {
    title: '后续重要事件倒计时',
    html: `<b>FOMC 议息会议</b>：每次运行都<b>实时解析 federalreserve.gov 官方日历页</b>（当前解析到 ${fomcCount} 场），日期取<b>决议日</b>即会议最后一天，而非首日。<br>
<b>中美互动</b>：分两类 —— ① <b>双边磋商/访问</b>是临时安排的，没有固定日程，只能人工核实后录入（每条都带来源，见卡片下方）；② <b>多边场合</b>（APEC、G20、联合国大会、达沃斯、博鳌）每年固定举办，中美元首与经贸团队通常在此期间接触；有官方公布日期时标「官方」，官方未公布前按惯例月份滚动并标注。<b>本表最后一次核对双边安排信息：${JSON.parse(readFileSync('events.json', 'utf8')).bilateralAsOf ?? '—'}</b>。<br>
<b>国内会议与例行发布为按历年惯例推算</b>（标「惯例推算」）—— 官方不提前公布固定日期，仅供参考。含中央政治局会议、中央经济工作会议、全国两会、进博会、LPR 报价（每月 20 日，遇周末顺延）、官方制造业 PMI。<br>
所有事件每次都会<b>滚动到下一次</b>并丢弃已结束的；已开始但未结束的显示为<b>「进行中」</b>。<br>
<b>休市（橙色「休市」标签）</b>：日期直接取<b>上交所《2026 年休市安排》官方公告</b>（2025-12-22 发布），<b>不是推算</b>；只列最近的两次，2027 年安排公布后会补进来。<br>
<b>长假前后表现表</b>：官方只公布未来日历，历史假期无法直接获得，因此从 16 年上证日线里<b>反推</b>——凡「工作日却没有行情」的连续区间即休市，相邻区间间隔 ≤ 4 天则合并（国庆与中秋相邻时会分成两段）。再看每次长假<b>节前 5 个交易日、节后首日、节后 5 个交易日</b>的上证涨跌幅与上涨天数占比。<br>
<b>⚠️ 关于这张表</b>：① 同名假期样本极少（春节 16 次、其余多在 3~8 次），<b>不具备统计显著性</b>；② 结果被 2008 / 2015 / 2020 等极端年份主导，换一段样本区间结论会变；③ 「节后上涨」很大程度只是 A 股长期的正漂移，所以表下给出了<b>同期任意交易日的基准</b>作对照——要和基准比，差值才是假期效应。所以它<b>只作为日历背景</b>，不要当成择时信号。`,
  },
};

const panelsJs = readFileSync('panels.js', 'utf8');
const signalJs = readFileSync('signal.js', 'utf8');
const themeJs = readFileSync('theme.js', 'utf8');
const pwaJs = readFileSync('pwa.js', 'utf8');
const rollerJs = readFileSync('date-roller.js', 'utf8');
const updateJs = readFileSync('update-button.js', 'utf8'); // 右下角「更新」按钮（局域网内可用）
const touchJs = readFileSync('touch.js', 'utf8');
const sentChartJs = readFileSync('sentiment-chart.js', 'utf8'); // 恐慌情绪散点图（面板左下方）
// 实时信号接口地址：留空 = 用同源 /signal（本机 serve-dashboard.mjs）；
// 填了 Cloudflare Worker 的地址，则在 Pages 上也能拿到实时竞价数据（见 worker/README.md）
const SIGNAL_URL = (() => {
  let raw = '';
  try { raw = readFileSync('worker-url.txt', 'utf8'); } catch { return ''; }
  // 该文件自带说明注释，必须把 # 开头的行和空行滤掉，否则会把整段说明当成地址
  const line = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0] ?? '';
  if (!line) return '';
  if (!/^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(line)) {
    console.warn(`警告: worker-url.txt 里的地址看起来不合法（"${line}"），已忽略，前端将使用同源 /signal`);
    return '';
  }
  return line.replace(/\/+$/, '');
})();
if (SIGNAL_URL) console.log(`实时信号接口：${SIGNAL_URL}/signal（Pages 上也会用这个）`);
else console.log('实时信号接口：同源 /signal（仅本机 serve-dashboard.mjs 可用）');
// 历史推送归档（供顶部日期滚轮回看）
const PUSHLOG = (() => {
  try { const a = JSON.parse(readFileSync('push-archive.json', 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
})();
const pushDates = [...new Set(PUSHLOG.map((e) => e.date))].sort();
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>A股看板 · ${last.date}</title>
<link rel="manifest" href="./manifest.webmanifest">
<meta name="theme-color" content="#141821">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="A股看板">
<link rel="apple-touch-icon" href="./icon-192.png">
<link rel="icon" href="./icon-192.png">
<script>/* 首屏前置：在有样式之前定好主题，避免刷新闪白/闪黑 */
(function(){var t=null;try{t=localStorage.getItem('astock.theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'}
document.documentElement.setAttribute('data-theme',t)})();</script>
<style>
:root{--bg:#141821;--card:#1b2130;--line:#2a3140;--fg:#e6ebf5;--dim:#7b8698}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;padding:16px 20px;font-size:13px}
h1{font-size:17px;margin:0 0 2px}
.sub{color:var(--dim);font-size:11px;margin-bottom:12px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 12px}
.kpi .l{color:var(--dim);font-size:11px}
.kpi .v{font-size:21px;font-weight:600;line-height:1.25}
.kpi .v .u{font-size:12px;color:var(--dim);margin-left:2px}
.kpi .d{font-size:11px;color:var(--dim);margin-top:2px}
.up{color:#ef4d5a}.down{color:#3fa66b}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:11px 14px;margin-bottom:10px}
.panel h2{font-size:12.5px;margin:0 0 7px;font-weight:600;color:#c3ccdb}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.row .panel{margin-bottom:0}
.legend{display:flex;gap:14px;font-size:11px;color:var(--dim);margin-bottom:4px;flex-wrap:wrap}
.ptools{display:flex;gap:5px;flex:0 0 auto;margin-left:auto}
.pbtn{background:#232b3c;border:1px solid #39414f;color:#8b96a8;font-size:10.5px;line-height:1;padding:3px 7px;border-radius:5px;cursor:pointer;font-family:inherit}
.pbtn:hover{color:#e6ebf5;border-color:#5b8def}
.pbtn.on{background:#2f4a7a;border-color:#5b8def;color:#dbe6ff}
.pdesc{background:#161c29;border:1px solid var(--line);border-left:2px solid #5b8def;border-radius:6px;padding:8px 11px;font-size:11px;line-height:1.75;color:#aeb8c8;margin:6px 0 9px}
.pdesc[hidden]{display:none}
.pdesc code{background:#232b3c;padding:0 4px;border-radius:3px;color:#8fb4ff;font-size:10.5px}
.pdesc .mk{display:inline-block;width:9px;height:9px;border-radius:2px;margin:0 2px 0 1px}
.prestore{position:fixed;right:14px;bottom:14px;z-index:20;background:#1b2130;border:1px solid var(--line);border-radius:8px;padding:9px 10px;font-size:11px;box-shadow:0 6px 22px rgba(0,0,0,.55);max-width:300px}
.prestore[hidden]{display:none}
.prestore b{display:block;color:var(--dim);font-weight:500;font-size:10.5px;margin-bottom:6px}
.prestore button{display:block;width:100%;text-align:left;background:#232b3c;border:1px solid #39414f;color:#c3ccdb;font-size:10.5px;padding:4px 8px;border-radius:5px;cursor:pointer;font-family:inherit;margin-bottom:4px}
.prestore button:hover{border-color:#5b8def;color:#fff}
.prestore button.all{color:#8fb4ff;text-align:center;margin-bottom:0}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}
.px{background:#3a3320;color:#e0b96a;font-size:10px;padding:0 4px;border-radius:3px;margin-left:4px}
.chg{font-size:11.5px;font-weight:600;margin-left:6px}
.hint{font-size:10.5px;color:var(--dim);font-weight:400;margin-left:5px}
.sub2{font-size:11px;color:#c3ccdb;margin:2px 0 1px}
.phead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px;flex-wrap:wrap}
.phead h2{margin:0}
.mk{display:inline-block;width:8px;height:8px;border-radius:2px;margin:0 3px 0 6px;vertical-align:middle}
.tiny{font-size:10px;color:#5b6478;margin-left:6px}
.tag{font-style:normal;font-size:9.5px;background:#26324a;color:#8fb4ff;padding:0 4px;border-radius:3px;margin-left:4px}
.sect{font-size:11px;color:#c3ccdb;margin:0 0 5px;font-weight:600}
.gauge{margin:6px 0 18px;position:relative}
.gbar{position:relative;height:16px;border-radius:4px;overflow:hidden;background:#1a2030}
.gseg{position:absolute;top:0;height:16px}
.gmark{position:absolute;top:-3px;width:3px;height:22px;background:#fff;border-radius:2px;box-shadow:0 0 6px rgba(255,255,255,.8)}
.gscale{position:relative;height:12px}
.gscale span{position:absolute;transform:translateX(-50%);font-size:9.5px;color:var(--dim)}
.bignum{font-size:12px;color:var(--dim);margin:2px 0 6px}
.bignum b{font-size:19px;color:#e6ebf5;font-weight:700}
.sgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.stbl{width:100%;border-collapse:collapse;font-size:11.5px}
.stbl th{text-align:left;color:var(--dim);font-weight:500;font-size:10.5px;padding:3px 6px;border-bottom:1px solid var(--line)}
.stbl td{padding:3.5px 6px;border-bottom:1px solid #232b3a}
.stbl tr:last-child td{border-bottom:0}
.stbl td:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
/* 失效行：边际 < 3pp 或 p ≥ 0.1，说明该阈值在当前窗口下没有区分度 */
.stbl tr.stale td{color:#d4574f}
.stbl tr.stale td:first-child{border-left:2px solid #d4574f;padding-left:7px}
.staleTxt{color:#d4574f;font-weight:600}
/* 标记日明细：窗口切到三年后行数从 15 涨到 37，加滚动容器免得面板被撑得过长 */
.tblscroll{max-height:340px;overflow-y:auto;border-bottom:1px solid var(--line)}
.tblscroll .stbl tr:last-child td{border-bottom:1px solid #232b3a}
.tblscroll::-webkit-scrollbar{width:7px}
.tblscroll::-webkit-scrollbar-thumb{background:#39414f;border-radius:4px}
/* 散点图横轴的年份标签（1 月）：标红加粗，便于扫读年份分界 */
#sentChart .xyear{fill:#ef4d5a;font-weight:700}
html[data-theme="light"] #sentChart .xyear{fill:#d92b3a}
svg{width:100%;height:auto;display:block}
.ev{display:flex;gap:11px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}
.ev:last-of-type{border-bottom:0}
.ev-days{min-width:54px;text-align:center;background:#232b3c;border-radius:6px;padding:4px 0}
.ev-days b{font-size:16px}.ev-days span{font-size:10px;color:var(--dim)}
.ev.urgent .ev-days{background:#5a2230;color:#ff8b96}
.ev-name{font-size:12.5px}.ev-meta{font-size:10.5px;color:var(--dim);margin-top:1px}
em{font-style:normal;font-size:10px;padding:0 5px;border-radius:3px;margin-left:5px}
.kind{background:#26324a;color:#8fb4ff}.habit{background:#3a3320;color:#e0b96a}
.kind.us{background:#1f3a3f;color:#5fd6d6}
.ev-days.live{background:#123236;min-width:62px}
.ev-days.live b{font-size:11px;color:#5fd6d6;line-height:1.5}
.ev-days.live span{font-size:9.5px}
.kind.hol{background:#3a2a12;color:#e8b06a}
.holbox{margin-top:13px;border-top:1px solid var(--line);padding-top:10px}
.holhead{font-size:11.5px;color:var(--dim);margin-bottom:6px}
table.hol{width:100%;border-collapse:collapse;font-size:11.5px}
table.hol th{color:var(--dim);font-weight:400;text-align:right;padding:3px 5px;border-bottom:1px solid var(--line);white-space:nowrap}
table.hol th:first-child,table.hol td:first-child{text-align:left}
table.hol td{padding:3px 5px;text-align:right;border-bottom:1px solid rgba(255,255,255,.04);white-space:nowrap}
table.hol tr.all td{font-weight:600;background:rgba(255,255,255,.03)}
.holnote{color:var(--dim);font-size:10.5px;line-height:1.65;margin-top:7px}
html[data-theme="light"] table.hol tr.all td{background:rgba(0,0,0,.035)}
html[data-theme="light"] .kind.hol{background:#fdeed7;color:#a5610c}
.foot{color:var(--dim);font-size:10.5px;line-height:1.7;margin-top:7px;border-top:1px solid var(--line);padding-top:7px}
.chtip{position:absolute;background:#232b3c;border:1px solid #39414f;border-radius:6px;padding:6px 9px;font-size:11px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.45);z-index:5;min-width:132px}
.chtip .h{color:#c3ccdb;font-size:11px;font-weight:600;margin-bottom:4px}
.chtip>div{display:flex;align-items:center;gap:6px;line-height:1.7}
.chtip i{width:7px;height:7px;border-radius:2px;flex:0 0 auto}
.chtip .n{color:var(--dim);flex:1 1 auto;white-space:nowrap}
.chtip b{color:#e6ebf5;font-weight:600;white-space:nowrap}
.chtip .sep{height:1px;background:var(--line);margin:4px 0 3px}
.chtip.wide{min-width:196px}
.chtip>.mini{display:block}
.mini{margin-top:5px;border-top:1px solid var(--line);padding-top:5px}
.mini-h{color:#c3ccdb;font-size:10.5px;font-weight:600;margin-bottom:2px;white-space:nowrap}
.mini-h b{color:#e6ebf5;font-weight:600;margin-left:6px}
.minisvg{width:168px;height:44px;display:block}
.mini-f{color:var(--dim);font-size:10px;margin-top:2px;white-space:nowrap}
.mini-f b{color:#e6ebf5}
.mini .tiny{color:#5b6478;font-size:9.5px;margin-left:4px}
.sigbox{background:#161c29;border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:11.5px;line-height:1.7;color:#aeb8c8}
.sigbox .sigact{display:inline-block;font-weight:600;padding:1px 7px;border-radius:4px;margin-right:6px}
.sigbox .sigdet{color:var(--dim);font-size:10.5px;margin-top:3px}
.sigbox.blank{color:#5b6478}
.globe{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px}
.gchip{display:inline-flex;align-items:baseline;gap:4px;background:var(--chip,#232b3c);border:1px solid var(--line);border-radius:5px;padding:2px 6px;font-size:10.5px}
.gchip b{color:var(--dim);font-weight:500}
.gchip i{font-style:normal;font-weight:600}
.gchip em{font-style:normal;color:#5b6478;font-size:9px}
html[data-theme="light"] .gchip{background:#eef1f7}

/* ==================== 昼夜主题 ==================== */
html[data-theme="light"]{--bg:#eef1f6;--card:#ffffff;--line:#e1e6ee;--fg:#1b2130;--dim:#6b7688}
/* 右上角切换按钮 */
.themebtn{position:fixed;top:12px;right:16px;z-index:30;display:flex;align-items:center;gap:5px;
  background:var(--card);border:1px solid var(--line);color:var(--dim);border-radius:8px;
  padding:5px 10px;font-size:11px;cursor:pointer;font-family:inherit;line-height:1;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.themebtn:hover{color:var(--fg);border-color:#5b8def}
.themebtn svg{width:13px;height:13px;display:block}
.themebtn .i-moon,.themebtn .i-sun,.themebtn .lbl-dark,.themebtn .lbl-light{display:none}
html[data-theme="dark"] .themebtn .i-moon{display:block}
html[data-theme="dark"] .themebtn .lbl-dark{display:inline}
html[data-theme="light"] .themebtn .i-sun{display:block}
html[data-theme="light"] .themebtn .lbl-light{display:inline}
h1{margin-right:96px}
.pwabtn{font-weight:600}
.pwatip{position:fixed;top:12px;right:16px;z-index:29;max-width:260px;background:var(--card);border:1px solid var(--line);
  border-radius:8px;padding:6px 10px;font-size:11px;color:var(--dim);box-shadow:0 2px 10px rgba(0,0,0,.3)}
.pwatip[hidden]{display:none}
/* ==================== 右下角「更新」按钮 ==================== */
/* 放右下而不是挤右上那堆按钮里：手机上拇指够得着，且不遮挡标题 */
.updbtn{position:fixed;right:16px;bottom:16px;z-index:31;display:flex;align-items:center;gap:6px;
  background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:22px;
  padding:9px 15px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;line-height:1;
  box-shadow:0 3px 14px rgba(0,0,0,.42)}
.updbtn:hover{border-color:#5b8def}
.updbtn:disabled{opacity:.6;cursor:default}
.updbtn.busy{border-color:#f59e0b;color:#f59e0b}
.updbtn.ok{border-color:#43d19a;color:#43d19a}
.updbtn.err{border-color:#ef4d5a;color:#ef4d5a}
@keyframes updspin{to{transform:rotate(360deg)}}
.updbtn.busy .upd-ico{animation:updspin 1.1s linear infinite}
.updbtn .upd-ico{display:block;width:13px;height:13px}
.updpanel{position:fixed;right:16px;bottom:64px;z-index:31;width:min(330px,calc(100vw - 32px));
  background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;
  font-size:11px;color:var(--dim);box-shadow:0 6px 22px rgba(0,0,0,.45);line-height:1.7}
.updpanel[hidden]{display:none}
.updpanel .u-h{color:var(--fg);font-weight:600;margin-bottom:4px}
.updpanel .u-dim{color:var(--dim);opacity:.85}
.updpanel code{background:rgba(120,140,180,.16);padding:1px 4px;border-radius:3px;font-size:10px}
.updpanel .u-x{float:right;cursor:pointer;color:var(--dim);font-size:14px;line-height:1;padding:0 2px}
.updpanel .u-x:hover{color:var(--fg)}
.updpanel .u-log{max-height:120px;overflow:auto;margin-top:6px;padding-top:5px;border-top:1px solid var(--line);
  font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:10px;white-space:pre-wrap;word-break:break-all;color:var(--dim)}
html[data-theme="light"] .updpanel code{background:#e8edf6;color:#1d4ed8}

/* ==================== 顶部日期滚轮 ==================== */
.rollerbar{display:flex;align-items:stretch;gap:6px;margin:0 0 10px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 6px}
.rollerbar[hidden]{display:none}
.rnav{flex:0 0 auto;width:26px;border:1px solid var(--line);background:var(--bg);color:var(--dim);border-radius:6px;cursor:pointer;font-size:14px;line-height:1;font-family:inherit}
.rnav:hover{color:var(--fg);border-color:#5b8def}
.rstrip{flex:1 1 auto;display:flex;gap:5px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;padding:1px}
.rstrip::-webkit-scrollbar{height:5px}
.rstrip::-webkit-scrollbar-thumb{background:#39414f;border-radius:3px}
.rchip{flex:0 0 auto;position:relative;display:flex;flex-direction:column;align-items:center;gap:0;min-width:52px;
  background:#232b3c;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:3px 8px;cursor:pointer;font-family:inherit}
.rchip b{font-size:11.5px;font-weight:600;color:var(--fg);line-height:1.25}
.rchip em{font-style:normal;font-size:9px;color:#5b6478}
.rchip:hover{border-color:#5b8def}
.rchip.on{background:#2f4a7a;border-color:#5b8def}
.rchip.on b,.rchip.on em{color:#dbe6ff}
.rchip i{position:absolute;top:3px;right:4px;width:5px;height:5px;border-radius:50%}
.rchip i.pm{background:#f59e0b}
.rchip i.both{background:#5b8def}
.rcount{flex:0 0 auto;align-self:center;font-size:10px;color:#5b6478;padding:0 4px}
/* ==================== 触屏 / 折叠屏适配 ==================== */
/* 纵向滚动归浏览器、横向手势归图表 —— 否则长页面上手指放在图上就滚不动了 */
#intraSvgCum,#intraSvgDay,#cdSh,#cdCyb,#cdKc50{touch-action:pan-y;-webkit-user-select:none;user-select:none}
/* 窄屏（折叠屏内屏 / 手机竖屏）：双列变单列，避免图表被压到 ~180px 以下 */
@media (max-width:860px){
  body{padding:12px 14px}
  .kpis{grid-template-columns:repeat(2,1fr)}
  .row{grid-template-columns:1fr!important}
  .sgrid{grid-template-columns:1fr!important}
}
@media (max-width:560px){
  .kpis{grid-template-columns:1fr 1fr;gap:8px}
  .panel{padding:10px 11px}
  .themebtn{top:10px;right:10px;padding:4px 8px;font-size:10px}
  .pwabtn{top:42px!important}
  .pwatip{top:10px;right:10px;max-width:200px;font-size:10px}
  h1{margin-right:84px;font-size:15px}
  .rchip{min-width:46px;padding:3px 6px}
  .pushcard pre{font-size:11px}
}
.pushcard{background:var(--inset,#161c29);border:1px solid var(--line);border-left:2px solid #5b8def;border-radius:6px;padding:7px 10px;margin-bottom:7px}
.pushcard.premarket{border-left-color:#f59e0b}
.pushcard .pc-h{font-size:11px;font-weight:600;color:#c3ccdb;margin-bottom:4px;display:flex;gap:8px;align-items:baseline}
.pushcard .pc-h span{font-weight:400;color:#5b6478;font-size:10px}
.pushcard pre{margin:0;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;font-size:11.5px;line-height:1.75;color:#aeb8c8;white-space:pre-wrap;word-break:break-word}
html[data-theme="light"] .rchip{background:#eef1f7}
html[data-theme="light"] .rchip.on{background:#dbe6ff;border-color:#5b8def}
html[data-theme="light"] .rchip.on b,html[data-theme="light"] .rchip.on em{color:#1d4ed8}
html[data-theme="light"] .pushcard{background:#f7f9fc}
html[data-theme="light"] .pushcard .pc-h{color:#2b3446}
html[data-theme="light"] .pushcard pre{color:#3d4757}
/* 控件与文本的日间配色（数据色 --up/--down/--blue 及各档位色两套主题保持一致） */
html[data-theme="light"] .panel h2,
html[data-theme="light"] .sub2,
html[data-theme="light"] .sect,
html[data-theme="light"] .chtip .h,
html[data-theme="light"] .mini-h{color:#2b3446}
html[data-theme="light"] .pbtn,
html[data-theme="light"] .prestore button,
html[data-theme="light"] .ev-days{background:#eef1f7;border-color:#ccd4e0;color:#5b6478}
html[data-theme="light"] .pbtn:hover,
html[data-theme="light"] .prestore button:hover{color:#1b2130;border-color:#5b8def}
html[data-theme="light"] .pbtn.on{background:#dbe6ff;border-color:#5b8def;color:#1d4ed8}
html[data-theme="light"] .pdesc,
html[data-theme="light"] .sigbox{background:#f7f9fc;color:#3d4757}
html[data-theme="light"] .pdesc code{background:#e8edf6;color:#1d4ed8}
html[data-theme="light"] .prestore{background:#fff;box-shadow:0 6px 20px rgba(20,30,50,.16)}
html[data-theme="light"] .prestore button.all{color:#1d4ed8}
html[data-theme="light"] .px,
html[data-theme="light"] .habit{background:#fdf3dd;color:#8a6a12}
html[data-theme="light"] .tiny,
html[data-theme="light"] .sigbox.blank,
html[data-theme="light"] .mini .tiny{color:#8b96a8}
html[data-theme="light"] .tag,
html[data-theme="light"] .kind{background:#e3ecff;color:#1d4ed8}
html[data-theme="light"] .kind.us,
html[data-theme="light"] .ev-days.live{background:#d9f2f2}
html[data-theme="light"] .kind.us,
html[data-theme="light"] .ev-days.live b{color:#0b6b6b}
html[data-theme="light"] .ev.urgent .ev-days{background:#fde8ec;color:#c2263a}
html[data-theme="light"] .gbar{background:#e6ebf3}
html[data-theme="light"] .gmark{background:#1b2130;box-shadow:0 0 6px rgba(27,33,48,.45)}
html[data-theme="light"] .bignum b,
html[data-theme="light"] .chtip b,
html[data-theme="light"] .mini-h b,
html[data-theme="light"] .mini-f b{color:#1b2130}
html[data-theme="light"] .stbl td{border-bottom-color:#eef1f6}
html[data-theme="light"] .chtip{background:#fff;border-color:#ccd4e0;box-shadow:0 4px 14px rgba(20,30,50,.18)}
html[data-theme="light"] .sigbox .sigact{filter:saturate(1.1) brightness(.82)}
/* 图表由 JS 生成、颜色写死在 SVG 属性里 —— CSS 规则优先级高于表现属性，故可在此覆盖中性色 */
html[data-theme="light"] [fill="#141821"]{fill:#eef1f6}
html[data-theme="light"] [fill="#232b3c"]{fill:#eef1f7}
html[data-theme="light"] [fill="#161c29"]{fill:#f7f9fc}
html[data-theme="light"] [fill="#1b2130"]{fill:#ffffff}
html[data-theme="light"] [fill="#2b3446"]{fill:#ffffff}
html[data-theme="light"] [fill="#e6ebf5"]{fill:#1b2130}
html[data-theme="light"] [fill="#dfe6f2"]{fill:#1b2130}
html[data-theme="light"] [fill="#c3ccdb"]{fill:#3d4757}
html[data-theme="light"] [fill="#aeb8c8"]{fill:#3d4757}
html[data-theme="light"] [fill="#7b8698"]{fill:#6b7688}
html[data-theme="light"] [fill="#5b6478"]{fill:#8b96a8}
html[data-theme="light"] [stroke="#252c39"]{stroke:#e9edf4}
html[data-theme="light"] [stroke="#39414f"]{stroke:#cbd3e0}
html[data-theme="light"] [stroke="#2f3747"]{stroke:#dde3ec}
html[data-theme="light"] [stroke="#2a3140"]{stroke:#e1e6ee}
html[data-theme="light"] [stroke="#4a5568"]{stroke:#cbd3e0}
html[data-theme="light"] [stroke="#141821"]{stroke:#ffffff}
</style></head><body>
<div class="rollerbar" id="rollerBar"${pushDates.length ? '' : ' hidden'}>
  <button class="rnav" id="rPrev" type="button" title="前一天">‹</button>
  <div class="rstrip" id="rStrip"></div>
  <button class="rnav" id="rNext" type="button" title="后一天">›</button>
  <span class="rcount" id="rCount"></span>
</div>
<div class="panel" data-panel="pushlog" id="pushPanel" hidden>
  <div class="phead"><h2>历史推送 <span class="hint" id="pushDate"></span></h2>
    <span class="hint">点上方日期切换 · 再点一次收起 · 键盘 ← → 也可翻</span></div>
  <div id="pushBody"></div>
</div>
<h1>A股情绪与事件看板</h1>
<button class="themebtn" id="themeBtn" type="button" title="切换昼夜模式" aria-label="切换昼夜模式">
  <svg class="i-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
  <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
  <span class="lbl-dark">夜间</span><span class="lbl-light">日间</span>
</button>
<button class="themebtn pwabtn" id="pwaBtn" type="button" title="安装到桌面" hidden style="top:46px">⤓ 安装</button>
<div class="pwatip" id="pwaTip" hidden>iPhone/iPad：点「分享」→「添加到主屏幕」，可全屏离线查看</div>
<div class="updpanel" id="updPanel" hidden><span class="u-x" id="updClose" title="收起">×</span><div id="updBody"></div><div class="u-log" id="updLog"></div></div>
<button class="updbtn" id="updBtn" type="button" title="让主机抓取最新数据">
  <svg class="upd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
  <span id="updLabel">更新</span>
</button>
<div class="sub">数据截至 ${last.date} 收盘 · 生成于 ${NOW.toLocaleString('zh-CN')}</div>
<div class="kpis">${kpis}</div>

${sigPanelHtml}

<div class="panel" data-panel="intra"><div class="phead"><h2>三大指数 ${tr.days.length} 日 5 分钟线<span class="hint">${tr.days[0].slice(4, 6)}/${tr.days[0].slice(6)} ~ ${tr.days.at(-1).slice(4, 6)}/${tr.days.at(-1).slice(6)} · ${tr.days.length} 个交易日 · 近 ${tr.days.length} 日用 5 分钟档，更早的几天由 15 分钟档补齐</span></h2>
    <span class="hint">上：累计涨跌幅（区间首点为基准）· 下：每日归零（当日首点为基准）· 两图缩放与拖动联动</span></div>
  <div class="legend">${intra.legend}</div>
  <svg id="intraSvgCum" viewBox="0 0 1040 240" style="cursor:crosshair"></svg>
  <svg id="intraSvgDay" viewBox="0 0 1040 240" style="cursor:crosshair;margin-top:6px"></svg>
</div>
<script>window.INTRA = ${JSON.stringify(intra.payload)};</script>
<script>${touchJs}</script>
<script>${zoomJs}</script>

<div class="row">
  <div class="panel" data-panel="candles"><div class="phead"><h2>上证指数 <span class="chg" data-chg="cdSh"></span></h2>
      <span class="hint">日线 · 滚轮缩放 / 拖拽平移 / 双击复位 ·
        <i class="mk" style="background:#ec4899"></i>警觉
        <i class="mk" style="background:#a855f7"></i>强恐慌        <i class="mk" style="background:#f59e0b"></i>极端<span class="tiny">（档位按情绪分切：前 5% / 3% / 1%）</span></span></div>
    <svg id="cdSh" viewBox="0 0 500 280"></svg>
  </div>
  <div class="panel" data-panel="cyb"><div class="phead"><h2>双创 <span class="hint">创业板 + 科创板 · 日线</span></h2></div>
    <div class="phead"><h2 class="sub2">创业板指 <span class="chg" data-chg="cdCyb"></span></h2></div>
    <svg id="cdCyb" viewBox="0 0 500 140"></svg>
    <div class="phead" style="margin-top:4px"><h2 class="sub2">科创50 <span class="chg" data-chg="cdKc50"></span></h2></div>
    <svg id="cdKc50" viewBox="0 0 500 140"></svg>
  </div>
</div>
<script>window.CANDLES = ${JSON.stringify(candlesData)};</script>
<script>window.DTDATA = ${JSON.stringify(
    Object.fromEntries(Object.entries(dtDaily).map(([d, v]) => [d, { ...v, sent: senti?.daily?.[d]?.sent ?? null }])),
  )};</script>
<script>window.DTTIERS = ${JSON.stringify(DT_TIERS)};</script>
<script>window.DTTIERS_OPT = ${JSON.stringify(DT_TIERS_OPT)};</script>
<script>window.DTINTRA = ${JSON.stringify(
    (() => {
      try {
        return JSON.parse(readFileSync('dt-intraday.json', 'utf8')).days ?? {};
      } catch {
        console.log('! dt-intraday.json 缺失（运行 python fetch-dt-intraday.py 生成盘中跌停曲线）');
        return {};
      }
    })(),
  )};</script>
<script>${candlesJs}</script>

${dtPanel}
${statePanel}

<div class="row">
  <div class="panel" data-panel="ztdt"><h2>涨停 / 跌停家数</h2>
    <div class="legend"><span><i class="dot" style="background:#ef4d5a"></i>涨停</span><span><i class="dot" style="background:#3fa66b"></i>跌停</span></div>
    <svg id="chZtdt" viewBox="0 0 500 190">${ztdt.svg}</svg>
  </div>
  <div class="panel" data-panel="amount"><h2>两市成交额</h2>
    <svg id="chAmount" viewBox="0 0 500 190">${amount.svg}</svg>
  </div>
</div>
<script>window.CHARTS = ${JSON.stringify(chartDescs)};</script>
<script>${crosshairJs}</script>

<div class="panel" data-panel="events"><h2>后续重要事件倒计时</h2>${cards}${holHtml}
  <div class="foot">
    数据源：腾讯财经、东方财富、同花顺、中证指数公司、新浪财经、federalreserve.gov。仅呈现公开市场数据，不构成投资建议。<br>
    点各面板右上角「说明」可查看该面板的数据口径与已知偏差；「×」可隐藏面板（本机浏览器记住该选择）。
  </div>
</div>
<div class="prestore" id="prestore" hidden><b>已隐藏的面板</b><div id="prestoreList"></div></div>
<script>window.PDESC = ${JSON.stringify(PDESC)};</script>
<script>window.SIGNAL_URL = ${JSON.stringify(SIGNAL_URL)};</script>
<script>window.PUSHLOG = ${JSON.stringify(PUSHLOG)};</script>
<script>${rollerJs}</script>
<script>${signalJs}</script>
<script>${themeJs}</script>
<script>${pwaJs}</script>
<script>${panelsJs}</script>
<script>${sentChartJs}</script>
<script>${updateJs}</script>
</body></html>`;

writeFileSync('astock-dashboard.html', html, 'utf8');
console.log('wrote astock-dashboard.html');
console.log(
  `区间 ${tr.days[0]} ~ ${tr.days.at(-1)}（${tr.days.length} 日）:`,
  plotted.map((s) => `${s.name} ${s.total >= 0 ? '+' : ''}${s.total.toFixed(2)}%`).join('  '),
);
for (const s of plotted) {
  console.log(`  ${s.name.padEnd(18)} 点数 ${String(s.points.length).padStart(4)}  当日 ${s.day == null ? '—（末日缺数据）' : (s.day >= 0 ? '+' : '') + s.day.toFixed(2) + '%'}  末日档位 ${s.dayN}/${GP}  ← ${s.source}`);
}

