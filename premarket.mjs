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
import { sinaQuote, sleep } from './sources.mjs';
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
let q = null, qDate = '';
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
const shQ = q?.[SYM.sh];
const marketOpen = !!(shQ && shQ.open > 0 && qDate === localToday());
if (!marketOpen && !FORCE) {
  log(`✗ 今日（${localToday()}）A 股未开盘（行情日期=${qDate || '空'}），可能休市。跳过推送。`);
  writeFileSync('premarket.json', JSON.stringify({ generatedAt: new Date().toISOString(), date: localToday(), skipped: 'A股未开盘', quoteDate: qDate }, null, 1), 'utf8');
  process.exit(0);
}

// ---------- 4. 逐指数决策 ----------
const rows = [];
for (const s of state.states) {
  const sym = SYM[s.key];
  const qt = sym ? q[sym] : null;
  let gap = null, stale = false;
  if (qt && qt.open > 0 && qt.prevClose > 0) {
    gap = (qt.open / qt.prevClose - 1) * 100;
    if (s.close && Math.abs(qt.prevClose - s.close) / s.close > 0.002) stale = true;
  }
  const dec = decide(s, gap == null ? 0 : gap);
  rows.push({ key: s.key, name: s.name, retT: s.retT, amtRatio: s.amtRatio, gap, stale, decision: dec });
  log(`  ${s.name.padEnd(8)} T日 ${pad(s.retT)}  竞价 ${gap == null ? '—' : pad(gap)}  → ${dec.action.label}`);
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
  log('(--no-push) 跳过推送');
} else {
  const cfg = loadConfig();
  if (!cfg.barkUrl && !cfg.webhook?.url) log('✗ 未配置推送地址（push-config.json）');
  else {
    const r = await push(title, body);
    log(r.ok ? '✓ 已推送到手机' : `✗ 推送失败: ${r.message}`);
  }
}
