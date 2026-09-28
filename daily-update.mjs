// 盘后日更：更新全部数据 → 重算统计 → 生成看板 → 推送手机
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { push, loadConfig } from './push-bark.mjs';
import { decide } from './signal.mjs';
import { appendPush } from './push-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

const SKIP_PUSH = process.argv.includes('--no-push');
const SKIP_INTRADAY = process.argv.includes('--no-intraday');
// 云端（GitHub Actions）跑时用 --no-backup：backup.mjs 是给本机留历史快照的，
// 在 CI 里提交由 workflow 自己控制（提交信息、author、推送时机都不一样）。
const SKIP_BACKUP = process.argv.includes('--no-backup');
const steps = [
  ['45日5分钟线', 'fetch-trends-m5.mjs'],
  ['事件日历', 'fetch-events.mjs'],
  ['日线数据', 'fetch-candles.mjs'],
  ['涨跌停/成交额', 'market-data.mjs'],
  // ⚠️ 长历史日线必须排在「统计重算」之前。
  //    analyze-dt.mjs 用 daily-long.json 的索引取当日行情（idxOf.get(d)，取不到就 continue），
  //    sentiment-backtest.mjs 同理。原先它排在第 9 步（统计之后），导致日更当天
  //    daily-long 还停在前一交易日 → 当天整天被跳过 → 恐慌情绪/跌停统计**永远晚一个交易日**。
  //    2026-09-28 发现：dt-counts 已有当天（744 天），统计窗口却仍是 742 天、末日 09-24，
  //    还连带报出「与 sentiment.json 的 sent 有 27/742 天不一致」（两边窗口差一天）。
  ['长历史日线', 'fetch-daily-long.mjs'],
  ['跌停三维', 'update-dt-daily.mjs'],
  // 情绪/回测 必须排在 统计重算 之前：它写 sentiment.json，而 analyze-dt 的一致性自检
  // 就是拿自己算的 sent 去比 sentiment.json。反过来的话比的是上一版文件（窗口差一天），
  // 每天都报一堆假不一致。sentiment-backtest 只读 dt-counts + daily-long，不依赖 dt-stats，所以能安全前移。
  ['情绪/回测', 'sentiment-backtest.mjs'],
  ['统计重算', 'analyze-dt.mjs'],
  ['盘中跌停曲线', 'fetch-dt-intraday.mjs'],
  ['全球市场日线', 'fetch-global.mjs'],
  ['生成看板', 'build-dashboard.mjs'],
];

const results = [];
console.log(`===== 盘后日更 ${new Date().toLocaleString('zh-CN')} =====`);
// 盘中运行会写入未完成 bar（成交量/涨跌停数都偏小），提醒一下
{
  const n = new Date();
  const mins = n.getHours() * 60 + n.getMinutes();
  const wd = n.getDay();
  if (wd >= 1 && wd <= 5 && mins >= 9 * 60 + 30 && mins < 15 * 60) {
    console.warn('  ⚠️ 现在是 A 股交易时段，抓到的当日数据不完整。建议 15:10 之后再跑（计划任务设在 15:40）。');
  }
}
for (const [name, script] of steps) {
  // 「盘中跌停曲线」是增量的，但一旦积压就很重：它要先全市场扫一遍（约 5200 次调用）
  // 找出各标记日的跌停股，再按「天 × 跌停股数」取 5 分钟线。标记日从 15 涨到 37 之后
  // 积压 22 天 ≈ 1 万次调用 / 50~90 分钟。单步超时 40 分钟会在中途杀掉它，
  // 而 Python 只在最后才写文件 —— 那 40 分钟就白跑了。所以给它一个逃生出口。
  if (SKIP_INTRADAY && script === 'fetch-dt-intraday.mjs') {
    console.log(`  – ${name.padEnd(14)} 跳过（--no-intraday；清积压请单独跑 node fetch-dt-intraday.mjs）`);
    results.push({ name, ok: true, skipped: true, ms: 0 });
    continue;
  }
  const t0 = Date.now();
  try {
    // 必须用 inherit/ignore：沙箱下捕获子进程输出（stdio:'pipe'）会 EPERM
    execFileSync('node', [script], { stdio: 'inherit', timeout: 40 * 60 * 1000 });
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms });
    console.log(`  ✓ ${name.padEnd(14)} ${(ms / 1000).toFixed(1)}s`);
  } catch (e) {
    const ms = Date.now() - t0;
    const err = `exit=${e.status ?? '?'} ${e.signal ?? ''} ${String(e.message).slice(0, 80)}`;
    results.push({ name, ok: false, ms, err });
    console.log(`  ✗ ${name.padEnd(14)} ${(ms / 1000).toFixed(1)}s  ${err}`);
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n完成 ${results.length - failed.length}/${results.length}${failed.length ? `，失败: ${failed.map((f) => f.name).join(', ')}` : ''}`);

// ---------- 可选：部署到 GitHub Pages（配置了 token 才跑）----------
{
  let hasToken = !!(process.env.GITHUB_TOKEN || process.env.DSH_GH_TOKEN);
  if (!hasToken && existsSync('deploy-config.json')) {
    try { hasToken = !!JSON.parse(readFileSync('deploy-config.json', 'utf8')).token; } catch { /* 忽略 */ }
  }
  if (hasToken && !process.argv.includes('--no-deploy')) {
    const t0 = Date.now();
    try {
      execFileSync('node', ['deploy-pages.mjs'], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
      console.log(`  ✓ 部署到 GitHub Pages  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`  ✗ 部署失败  exit=${e.status ?? '?'}（看板本身不受影响）`);
      results.push({ name: '部署 Pages', ok: false, ms: Date.now() - t0 });
    }
  }
}

// ---------- 汇总推送内容 ----------
const read = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const md = read('market-data.json', []);
const last = md.at(-1), prev = md.at(-2);
const stats = read('dt-stats.json');
const senti = read('sentiment.json');
const daily = stats?.daily ?? {};
const sdaily = senti?.daily ?? {};
const today = last?.date;
const drec = daily[today] ?? {};
const srec = sdaily[today] ?? {};

const pct = (a, b) => (a != null && b != null ? `${a - b >= 0 ? '+' : ''}${((a / b - 1) * 100).toFixed(2)}%` : '—');
const num = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));

const lines = [];
lines.push(`上证 ${num(last?.shClose, 2)} ${pct(last?.shClose, prev?.shClose)}`);
lines.push(`成交 ${last ? (last.amountYi / 10000).toFixed(2) + ' 万亿' : '—'} ${last && prev ? ((last.amountYi - prev.amountYi >= 0 ? '+' : '') + (last.amountYi - prev.amountYi).toFixed(0) + ' 亿') : ''}`);
lines.push(`涨停 ${last?.zt ?? '—'} / 跌停 ${last?.dt ?? '—'}`);
if (today && daily[today]) {
  lines.push(`恐慌情绪 ${srec.sent ?? '—'}/100${drec.type ? ` · ${drec.type}` : ''}`);
  lines.push(`跌停市值占比 ${num(drec.cap, 2)}% · 权重股 ${drec.mem ?? '—'} 只`);
}
if (failed.length) lines.push(`⚠️ 失败 ${failed.length} 项: ${failed.map((f) => f.name).join('、')}`);

// ---------- 最新事件提醒 ----------
const evs = read('events.json', {})?.events ?? [];
const dayTo = (d) => Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);
const upcoming = evs
  .map((e) => ({ ...e, days: dayTo(e.date), endDays: dayTo(e.endDate ?? e.date) }))
  .filter((e) => e.endDays >= 0)
  .sort((a, b) => a.days - b.days)
  .slice(0, 3);
if (upcoming.length) {
  lines.push('—— 临近事件 ——');
  for (const e of upcoming) {
    const when = e.days <= 0 ? `进行中(剩${e.endDays}天)` : e.days === 0 ? '今天' : `${e.days}天后`;
    const tag = e.src === 'habit' ? '（惯例）' : '';
    lines.push(`${when} · ${e.name}${tag}`);
  }
}

// ---------- 明日开盘应对（盘前信号）----------
const sig = read('signal-state.json', null);
if (sig?.states?.length) {
  const s0 = sig.states.find((s) => s.key === 'sh') ?? sig.states[0];
  const tier = s0.retT <= -0.5 ? '弱' : s0.retT >= 0.5 ? '强' : '中性';
  const vol = s0.amtRatio == null ? '—' : s0.amtRatio < 0.9 ? '缩量' : s0.amtRatio >= 1.15 ? '放量' : '平量';
  lines.push('—— 明日开盘预判 ——');
  // 只用今日收盘：回归 16 年数据得 明日跳空 ≈ -0.135% + 0.09 × 今日涨跌幅（r=0.142，分桶单调）
  // 这只是「无条件基准 + 收盘动量」的一阶估；真正的跳空要看隔夜美股与亚洲早盘，明早 09:26 更新
  const fc = -0.135 + 0.09 * s0.retT;
  lines.push(`仅用今日收盘：明日开盘约 ${fc >= 0 ? '+' : ''}${fc.toFixed(2)}%（今日 ${s0.retT >= 0 ? '+' : ''}${s0.retT.toFixed(2)}%）`);
  lines.push(`明早 09:26 会用美股 + 亚洲早盘 + 集合竞价更新`);
  lines.push('');
  lines.push('—— 明日开盘应对 ——');
  lines.push(`T日(${sig.T}) 上证 ${s0.retT >= 0 ? '+' : ''}${s0.retT.toFixed(2)}%（${tier}）· 量能 ${s0.amtRatio?.toFixed(2)}×（${vol}）`);
  const gapHi = decide(s0, 1.2);
  lines.push(`若明日高开>1% → ${gapHi.action.label}${gapHi.expect == null ? '' : `（期望 ${gapHi.expect >= 0 ? '+' : ''}${gapHi.expect.toFixed(2)}%）`}`);
  const gapLo = decide(s0, -1.2);
  lines.push(`若明日低开<-1% → ${gapLo.action.label}${gapLo.expect == null ? '' : `（期望 ${gapLo.expect >= 0 ? '+' : ''}${gapLo.expect.toFixed(2)}%）`}`);
  // 供明早盘前脚本对比「下午预判 vs 清晨预判」
  try {
    writeFileSync('open-forecast.json', JSON.stringify({ generatedAt: new Date().toISOString(), T: sig.T, retT: s0.retT, predicted: +fc.toFixed(3), base: sig.states.map((s) => ({ key: s.key, close: s.close })) }, null, 1), 'utf8');
  } catch { /* 忽略 */ }
}

const title = `${today ?? '无数据'} A股盘后`;
const body = lines.join('\n');

console.log(`\n--- 推送内容 ---\n${title}\n${body}\n---------------`);

// 归档到 push-archive.json，供看板顶部的日期滚轮回看（不论是否真的推送都存）
try { appendPush('close', title, body, today); } catch (e) { console.log(`  ! 推送归档失败: ${e.message}`); }

if (SKIP_PUSH) {
  console.log('(--no-push) 跳过推送');
} else {
  const cfg = loadConfig();
  if (!cfg.barkUrl) {
    console.log('✗ 未配置 Bark 地址：请编辑 push-config.json 的 barkUrl，或设置环境变量 BARK_URL');
  } else {
    const r = await push(title, body);
    console.log(r.ok ? '✓ 已推送到 iPhone' : `✗ 推送失败: ${r.message}`);
  }
}

// ---------- 重建实时信号 Worker ----------
// 日更重写了 signal-state.json，而 Worker 把它内联在包里 —— 不重建的话，
// 第二天 Worker 里的 T 日状态就过期了，它会一直返回 status="stale"（设计如此，但实时层就白搭了）。
{
  try {
    execFileSync('node', ['build-worker.mjs'], { stdio: 'inherit', timeout: 60 * 1000 });
  } catch (e) {
    console.log(`  ✗ 重建 Worker 包失败 exit=${e.status ?? '?'}（不影响看板）`);
  }
  // 首次要先手动跑一次 `cd worker && npx wrangler login && npx wrangler deploy`；
  // 成功后建一个 worker/deploy.enabled 标记，日更才会替你自动部署（见 worker/README.md）。
  if (existsSync('worker/deploy.enabled') && !process.argv.includes('--no-worker')) {
    const t0 = Date.now();
    try {
      // npx 在 Windows 上是 npx.cmd，必须走 shell；stdio 用 inherit 避免沙箱的管道限制
      execFileSync('npx', ['wrangler', 'deploy'], { cwd: 'worker', stdio: 'inherit', shell: true, timeout: 5 * 60 * 1000 });
      console.log(`  ✓ 部署实时 Worker  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`  ✗ 部署实时 Worker 失败 exit=${e.status ?? '?'}（看板与备份不受影响）`);
      results.push({ name: '部署 Worker', ok: false, ms: Date.now() - t0 });
    }
  } else {
    console.log('  (未启用 Worker 自动部署 —— 建 worker/deploy.enabled 后开启，见 worker/README.md)');
  }
}

// ---------- 历史版本备份 ----------
// 把工作区快照提交进本地 git。这是唯一的回退手段（源文件是手改的，出过事）。
// 放在最后，好把 open-forecast.json / push-archive.json 这些本轮产物一起纳入。
{
  const t0 = Date.now();
  if (SKIP_BACKUP) {
    console.log('  – 历史备份      跳过（--no-backup，由 CI 自行提交）');
    results.push({ name: '历史备份', ok: true, skipped: true, ms: 0 });
  } else {
    try {
      execFileSync('node', ['backup.mjs', `日更 ${today ?? ''}`.trim()], { stdio: 'inherit', timeout: 2 * 60 * 1000 });
      results.push({ name: '历史备份', ok: true, ms: Date.now() - t0 });
    } catch (e) {
      console.log(`  ! 历史备份失败 exit=${e.status ?? '?'}（不影响日更，但请留意）`);
      results.push({ name: '历史备份', ok: false, ms: Date.now() - t0 });
    }
  }
}

const logLine = `${new Date().toISOString()}\t${results.map((r) => `${r.name}:${r.ok ? 'ok' : 'FAIL'}`).join(' ')}\n`;
try { appendFileSync('daily-update.log', logLine); } catch { /* 忽略 */ }
process.exit(failed.length ? 1 : 0);

