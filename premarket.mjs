// 盘前更新：北京时间 09:25 后跑一次
//   1) 全球背景：美股收盘、韩国/日经/台湾早盘、黄金 → 预判 A 股跳空
//   2) A 股集合竞价结果（09:25 出炉）→ 实际跳空
//   3) 结合前一交易日状态（signal-state.json）给出今日开盘应对
//   4) 推送手机 + 写 premarket.json
//
// 用法: node premarket.mjs [--no-push] [--force]
//   --force 忽略「今天是否交易日」的检查（用于盘中手动测试）
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { sinaQuote, sleep, emQuote } from './sources.mjs';
import { TH, decide } from './signal.mjs';
import { globalQuotes, forecastGap } from './global-quote.mjs';
import { push, loadConfig } from './push-bark.mjs';
import { appendPush } from './push-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const pad = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const SKIP_PUSH = process.argv.includes('--no-push');
const FORCE = process.argv.includes('--force');
const log = (s) => { console.log(s); try { appendFileSync('premarket.log', `${new Date().toISOString()}\t${s}\n`); } catch { /* 忽略 */ } };

log(`===== 盘前更新 ${new Date().toLocaleString('zh-CN')} =====`);

// ---------- 1. 前一交易日状态 ----------
let state = null;
if (existsSync('signal-state.json')) {
  try { state = JSON.parse(readFileSync('signal-state.json', 'utf8')); } catch { /* 忽略 */ }
}
if (!state?.states?.length) {
  log('✗ signal-state.json 缺失或无状态 —— 请先跑一次收盘日更（node daily-update.mjs）');
  process.exit(1);
}
log(`  前一交易日 T = ${state.T}（${state.states.length} 个指数）`);

// ---------- 2. 全球背景 ----------
let gq = null, fc = null;
try {
  gq = await globalQuotes();
  fc = forecastGap(gq);
  const bits = [];
  if (gq.spx) bits.push(`美股 ${pad(gq.spx.chg)}`);
  if (fc.asia != null) bits.push(`亚洲早盘均值 ${pad(fc.asia)}`);
  else {
    const na = ['kospi', 'nikkei', 'twii'].filter((k) => gq[k] && gq[k].date === localToday()).length;
    bits.push(`亚洲已开盘 ${na}/3`);
  }
  if (gq.gold) bits.push(`黄金 ${pad(gq.gold.chg)}`);
  log(`  全球：${bits.join(' · ')}`);
  log(`  预判跳空 ${fc.predicted == null ? '—' : pad(fc.predicted)}（${fc.basis}）`);
} catch (e) {
  log(`  ! 全球行情失败：${e.message}（继续，只出 A 股部分）`);
}

// ---------- 3. A 股集合竞价结果 ----------
const SYM = { sh: 'sh000001', szcz: 'sz399001', cyb: 'sz399006', hs300: 'sh000300' };
// 中证2000（932000）是 CSI 独有指数，新浪 hq 取不到（sh932000 返回空），走东财 push2。
// 不补这一路的话，daily-long 里的第 5 个指数在盘前表里会有一列恒为「—」，看着像坏了。
// ⚠️ 但东财会整段封（UND_ERR_SOCKET，一封几小时），所以再挂一层**ETF 代理兜底**：
//    sh563300 是中证2000ETF华泰柏瑞，看板「45日5分钟线」里本来就用它代表中证2000（同一口径）。
//    代理的**价格量级与指数差 3 个数量级**，所以只取它自己的「开/昨收」算跳空，
//    绝不拿它去和指数收盘价比（那个 stale 检查对代理无意义，必须跳过，否则天天误报）。
const EM_SYM = { csi2000: '2.932000' };
const PROXY_SYM = { csi2000: 'sh563300' };
let q = null, qDate = '';
let emq = {};
for (let i = 1; i <= 5; i++) {
  try {
    q = await sinaQuote(Object.values(SYM));
    const any = q[SYM.sh] || q[SYM.szcz];
    qDate = any?.date || '';
    const opened = any && any.open > 0 && qDate === localToday();
    if (opened) break;
    log(`  …第 ${i} 次：竞价数据尚未就绪（日期=${qDate || '空'} 开=${any?.open ?? '-'}），20 秒后重试`);
    await sleep(20000);
  } catch (e) {
    log(`  …第 ${i} 次取 A 股行情失败：${e.message}`);
    await sleep(20000);
  }
}
try {
  emq = await emQuote(Object.values(EM_SYM));
} catch (e) {
  log(`  ! 东财实时行情不可用（${String(e.message).slice(0, 40)}），中证2000 改用 ETF 代理`);
}
// ETF 代理只在指数行情拿不到时才取，且复用同一次新浪调用
let proxyQ = {};
if (Object.keys(EM_SYM).some((k) => !emq[EM_SYM[k]])) {
  try {
    const pq = await sinaQuote(Object.values(PROXY_SYM));
    for (const sym of Object.values(PROXY_SYM)) if (pq[sym]?.open > 0) proxyQ[sym] = pq[sym];
    if (Object.keys(proxyQ).length) log(`  中证2000 用 ETF 代理 ${Object.values(PROXY_SYM).join(',')}（东财不可用）`);
  } catch (e) {
    log(`  ! ETF 代理行情也失败：${e.message}`);
  }
}
const shQ = q?.[SYM.sh];
const marketOpen = !!(shQ && shQ.open > 0 && qDate === localToday());
if (!marketOpen && !FORCE) {
  log(`✗ 今日（${localToday()}）A 股未开盘（行情日期=${qDate || '空'}），可能休市。跳过推送。`);
  writeFileSync('premarket.json', JSON.stringify({ generatedAt: new Date().toISOString(), date: localToday(), skipped: 'A股未开盘', quoteDate: qDate }, null, 1), 'utf8');
  process.exit(0);
}

// ---------- 4. 逐指数决策 ----------
// 报价统一按指数 key 索引：新浪的 4 个 + 中证2000（东财指数 → 新浪 ETF 代理），后面只认 key。
const QUOTES = {};
for (const [k, sym] of Object.entries(SYM)) if (q?.[sym]) QUOTES[k] = { ...q[sym], source: '新浪 hq' };
for (const [k, secid] of Object.entries(EM_SYM)) {
  const e = emq[secid];
  // 东财不给日期，用同一次运行里拿到的 A 股行情日期兜底（同一时刻取的数据）
  if (e && e.open > 0) QUOTES[k] = { ...e, date: qDate, source: '东财 push2' };
}
for (const [k, sym] of Object.entries(PROXY_SYM)) {
  if (QUOTES[k]) continue; // 已经有真实指数行情
  const px = proxyQ[sym];
  if (px && px.open > 0) QUOTES[k] = { ...px, source: 'ETF 代理(sh563300)', proxy: true };
}

const rows = [];
for (const s of state.states) {
  const qt = QUOTES[s.key];
  let gap = null, stale = false;
  if (qt && qt.open > 0 && qt.prevClose > 0) {
    gap = (qt.open / qt.prevClose - 1) * 100;
    // 代理的价格量级和指数不同，比不得；只有真实指数行情才做这个一致性检查
    if (!qt.proxy && s.close && Math.abs(qt.prevClose - s.close) / s.close > 0.002) stale = true;
  }
  const dec = decide(s, gap == null ? 0 : gap);
  rows.push({ key: s.key, name: s.name, retT: s.retT, amtRatio: s.amtRatio, gap, stale, decision: dec, source: qt?.source ?? '无实时源', proxy: !!qt?.proxy });
  log(`  ${s.name.padEnd(8)} T日 ${pad(s.retT)}  竞价 ${gap == null ? '—' : pad(gap)}  → ${dec.action.label}${qt?.proxy ? '   [ETF 代理]' : ''}`);
}

// ---------- 5. 推送正文 ----------
const main = rows.find((r) => r.key === 'sh') ?? rows[0];
const lines = [];
if (fc && fc.predicted != null) lines.push(`预判跳空 ${pad(fc.predicted)}（${fc.basis}）`);
if (gq) {
  const g = [];
  if (gq.spx) g.push(`美股 ${pad(gq.spx.chg)}`);
  for (const [k, nm] of [['kospi', '韩'], ['nikkei', '日'], ['twii', '台']]) {
    const x = gq[k];
    if (x && x.date === localToday() && x.open > 0 && x.prevClose > 0) g.push(`${nm}开盘 ${pad((x.open / x.prevClose - 1) * 100)}`);
  }
  if (gq.gold) g.push(`黄金 ${pad(gq.gold.chg)}`);
  if (g.length) lines.push(g.join(' · '));
}
lines.push(`竞价 上证 ${main.gap == null ? '—' : pad(main.gap)} · 深证 ${rows.find((r) => r.key === 'szcz')?.gap != null ? pad(rows.find((r) => r.key === 'szcz').gap) : '—'} · 创业板 ${rows.find((r) => r.key === 'cyb')?.gap != null ? pad(rows.find((r) => r.key === 'cyb').gap) : '—'}`);
lines.push(`T日(${state.T}) 上证 ${pad(main.retT)} · 量能 ${main.amtRatio?.toFixed(2)}×`);
lines.push(`—— 今日开盘应对 ——`);
lines.push(`${main.name}：${main.decision.action.label}${main.decision.expect == null ? '' : `（历史期望 ${pad(main.decision.expect)}）`}`);
if (main.decision.n) lines.push(`样本 n=${main.decision.n}，时段一致 ${main.decision.era}`);
if (main.decision.why) lines.push(main.decision.why);
// 若实际跳空明显偏离预判，本身就是信息
if (fc && fc.predicted != null && main.gap != null) {
  const dev = main.gap - fc.predicted;
  if (Math.abs(dev) >= 0.5) lines.push(`⚠️ 实际开盘比全球背景${dev > 0 ? '强' : '弱'} ${Math.abs(dev).toFixed(2)}pp`);
}
// 两阶段对比：昨天下午只用收盘动量的预判 → 今晨加入隔夜全球后的修正 → 实际开盘
try {
  const pf = existsSync('open-forecast.json') ? JSON.parse(readFileSync('open-forecast.json', 'utf8')) : null;
  if (pf && pf.T === state.T && pf.predicted != null) {
    const shift = fc && fc.predicted != null ? fc.predicted - pf.predicted : null;
    lines.push(`—— 预判两阶段 ——`);
    lines.push(`昨日收盘推：${pad(pf.predicted)}（仅用 T日 ${pad(pf.retT)}）`);
    if (shift != null) lines.push(`隔夜全球修正：${shift >= 0 ? '+' : ''}${shift.toFixed(2)}pp → 今晨预判 ${pad(fc.predicted)}`);
    if (main.gap != null) lines.push(`实际开盘 ${pad(main.gap)}，偏差 ${main.gap - (fc?.predicted ?? pf.predicted) >= 0 ? '+' : ''}${(main.gap - (fc?.predicted ?? pf.predicted)).toFixed(2)}pp`);
  }
} catch { /* 忽略 */ }

const dateStr = localToday();
const title = `${dateStr} 盘前`;
const body = lines.filter(Boolean).join('\n');
log(`\n--- 推送内容 ---\n${title}\n${body}\n---------------`);
try { appendPush('premarket', title, body, dateStr); } catch (e) { log(`  ! 推送归档失败: ${e.message}`); }

writeFileSync(
  'premarket.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), date: dateStr, T: state.T, global: gq ? { quotes: gq, forecast: fc } : null, rows }, null, 1),
  'utf8',
);

if (SKIP_PUSH) {
  log('  – 推送手机           跳过（--no-push）');
} else {
  const cfg = loadConfig();
  // 和 daily-update.mjs 保持一致：没配置就是中性说明，不打印成 ✗ 失败 ——
  // 天天红一句会让人对日志里的红色麻木，真出问题反而看不见。
  if (!cfg.barkUrl && !cfg.webhook?.url) log('  – 推送手机           未配置（不需要推送就保持这样）');
  else {
    const r = await push(title, body);
    log(r.ok ? '✓ 已推送到手机' : `✗ 推送失败: ${r.message}`);
  }
}
