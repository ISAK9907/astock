// 盘后日更：更新全部数据 → 重算统计 → 生成看板 → 推送手机
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { push, loadConfig } from './push-bark.mjs';
import { decide } from './signal.mjs';
import { appendPush } from './push-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

// ---------- 单实例锁 ----------
// 手机网页上的「更新」按钮会触发一次日更，而 15:40 的计划任务也可能同时开跑。
// 两个日更并行会同时改同一批 JSON（candles/daily-long/dt-counts/看板），
// 互相覆盖出半新半旧的混合状态 —— 这种损坏很难事后辨认。
// 所以谁先拿到锁谁跑，后来的立刻退出（退出码 3，调用方据此提示「已在更新中」）。
const LOCK = join(HERE, '.daily-update.lock');
function lockHolder() {
  try {
    const t = JSON.parse(readFileSync(LOCK, 'utf8'));
    if (!t?.pid) return null;
    process.kill(t.pid, 0); // 进程不存在会抛错 → 说明是上次崩溃留下的僵尸锁
    return t;
  } catch {
    return null;
  }
}
{
  const h = lockHolder();
  if (h) {
    console.error(`✗ 已有日更在运行（pid ${h.pid}，启动于 ${h.at}），本次退出，避免并发改同一批文件。`);
    process.exit(3);
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
  const release = () => { try { unlinkSync(LOCK); } catch { /* 已删 */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
}

const SKIP_PUSH = process.argv.includes('--no-push');
const SKIP_INTRADAY = process.argv.includes('--no-intraday');
// 云端（GitHub Actions）跑时用 --no-backup：backup.mjs 是给本机留历史快照的，
// 在 CI 里提交由 workflow 自己控制（提交信息、author、推送时机都不一样）。
const SKIP_BACKUP = process.argv.includes('--no-backup');
// 收盘推送归档是否已写（见步骤循环：在「生成看板」之前写，保证当天就上页面）
let pushArchived = false;
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
  // 开盘跳空情景统计：只依赖 daily-long，排在它之后、生成看板之前即可
  // 自动化健康度：读本机日志判断两个定时任务是否落后/被中断。
  // 必须排在生成看板之前（看板顶部那条状态带要用它）。
  // 注意它读的本步日志里还没有「本次运行」的记录 —— 显示的是上一次的状态，这是有意的。
  ['自动化健康', 'analyze-automation.mjs'],
  ['全球市场日线', 'fetch-global.mjs'],
  // ---- 工具二：持仓计划台 ----
  // 用中证官方一个源同时拿价格+市盈率（绕开东财 push2 的整段封禁）。
  // 必须排在生成看板之前 —— 看板顶部有跳转入口，计划台文件不存在时会指向空页。
  ['估值数据', 'fetch-valuation.mjs'],
  // 用户实际持仓的 5 只个股日线 —— 计划台判「企稳」要用它自己的价格序列，
  // 宽基指数的日线判不了个股。必须排在计划台分析之前。
  ['持仓个股日线', 'fetch-stocks.mjs'],
  // 个股闸门：企稳判定（用户定的加仓前置条件）。必须排在计划台生成之前，
  // 因为企稳等级要一起内联进 plan.html 给「明日操作」用。
  ['个股闸门', 'analyze-stocks.mjs'],
  ['计划台分析', 'plan-analysis.mjs'],
  ['计划台生成', 'build-plan.mjs'],
  ['生成看板', 'build-dashboard.mjs'],
  // ---- 兜底性质的长任务：必须排在**最后** ----
  // ⚠️ 2026-10-13 挪到这里，原因是它把一整天的产出都拖掉了：
  //    这一步是增量回填「标记日·当日跌停家数随时间」曲线。它本身设计成"所有标记日都有曲线就立刻退出"，
  //    但只要有一天待回填，就要重新扫**全市场 5220 只**（实测 40 分钟，日志自报"剩余约 19.8 分钟"）。
  //    它原来排在第 12 步、**在生成看板和发布之前** —— 于是今天 15:40 那次跑到 23.7 分钟被杀（0xC000013A），
  //    后面所有步骤（估值/计划台/生成看板/发布）全部没跑，用户看到的还是早上 09:26 盘前那版。
  //    这和 2026-10-09 丢盘后是同一类事故：**长任务排在关键路径前面**。
  //    挪到最后之后，即使它被杀，当天的看板也已经生成并发布了；曲线明天再补。
  //    代价：新标记日的曲线晚一天上图 —— 这个面板本来就是历史回看用的，可以接受。
  //    （它现在已经不在这个数组里了：挪到「发布之后」执行，见下方同名注释块。）
];

// ⚠️ 这个函数**之前根本不存在**，而备份重试逻辑里写着 `await sleep(5000)`（第 349 行）。
//    后果：备份第一次失败时不是重试，而是抛 ReferenceError: sleep is not defined 把整个日更进程干掉 ——
//    实测 2026-10-13 就是这样崩在备份那一步的。而抛出的位置在 catch 块里，
//    所以日志上看起来像"备份失败"，很容易误判成备份本身的问题。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // ⚠️ 收盘推送必须在「生成看板」**之前**写好归档。
  //    原来这段代码在步骤循环之后（生成看板 → 部署 → 才写归档），后果是：
  //    当天收盘推送要**等到下一次构建**（次日 09:26 盘前）才会出现在页面上 ——
  //    晚上打开看板回看当天推送是空的。2026-10-09 就是这么被误认为「没有推送盘后」。
  if (script === 'build-dashboard.mjs' && !pushArchived) {
    pushArchived = true;
    await buildAndArchivePush();
  }
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

// ---------- 兜底性质的长任务：发布完成之后才跑 ----------
// ⚠️ 2026-10-13 从步骤数组里挪出来放这里，原因是它把一整天的产出拖掉了：
//    这一步增量回填「标记日·当日跌停家数随时间」曲线，设计上是"所有标记日都有曲线就立刻退出"，
//    但只要有一天待回填，就要重新扫**全市场 5220 只**（实测 40 分钟）。
//    它原来排在步骤数组里、**在生成看板和发布之前** —— 今天 15:40 那次跑到 23.7 分钟被杀
//    （exit=0xC000013A，日志里能看到 ^C），后面所有步骤全没跑，用户看到的还是早上 09:26 那版。
//    和 2026-10-09 丢盘后是同一类事故：**长任务排在关键路径前面**。
//    现在它排在「生成看板 → 发布」**之后**：即使被杀，当天的页面也已经上线；曲线明天再补。
//    代价：新标记日的曲线晚一天上图 —— 那个面板是历史回看用的，可以接受。
if (!process.argv.includes('--no-intraday')) {
  const t0 = Date.now();
  try {
    execFileSync('node', ['fetch-dt-intraday.mjs'], { stdio: 'inherit', timeout: 60 * 60 * 1000 });
    console.log(`  ✓ 盘中跌停曲线回填  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    // 故意不记为失败：它是可选的增量回填，跑不完不该让整次日更算"未跑成"
    console.log(`  ⚠️ 盘中跌停曲线未完成 exit=${e.status ?? '?'}（页面已发布，曲线下次再补）`);
  }
}

// ---------- 汇总推送内容 ----------
// 抽成函数：必须能在「生成看板」之前被调用（见步骤循环里的说明），
// 否则收盘推送要等下一次构建才上页面。
async function buildAndArchivePush() {
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
  // 2026-10-13 改口径：sent 现在是**经验分位**（0~100，50 = 中位），不再是 50+15·Φ⁻¹(p)。
      // 旧口径下这个数看起来像一把「恐慌刻度尺」，其实是把排名过了一遍正态变换 —— 分布的正态是造出来的。
      // 现在它可以直接读成「今天在近 N 个交易日里排第几」。
      lines.push(`恐慌分位 ${srec.sent ?? '—'}%（近 ${senti?.window?.n ?? '—'} 个交易日，50 = 中位）${drec.type ? ` · ${drec.type}` : ''}`);
  lines.push(`跌停市值占比 ${num(drec.cap, 2)}% · 权重股 ${drec.mem ?? '—'} 只`);
}
// ⚠️ 这里**不能**用外层那个 `failed`：本函数在步骤循环里、构建之前就被调用，
//    而外层的 `const failed = results.filter(...)` 定义在循环之后 ——
//    引用它会抛暂时性死区 ReferenceError（踩过一次，整个日更直接崩掉）。
//    就地按当前 results 算：此刻正好是「除生成看板之外」的完成情况。
const failedNow = results.filter((r) => !r.ok);
if (failedNow.length) lines.push(`⚠️ 失败 ${failedNow.length} 项: ${failedNow.map((f) => f.name).join('、')}`);

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

// ---------- 明日开盘预判 + 明日操作 ----------
const sig = read('signal-state.json', null);
if (sig?.states?.length) {
  const s0 = sig.states.find((s) => s.key === 'sh') ?? sig.states[0];
  lines.push('—— 明日开盘预判 ——');
  // 只用今日收盘：回归 16 年数据得 明日跳空 ≈ -0.135% + 0.09 × 今日涨跌幅（r=0.142，分桶单调）
  // 这只是「无条件基准 + 收盘动量」的一阶估；真正的跳空要看隔夜美股与亚洲早盘，明早 09:26 更新
  const fc = -0.135 + 0.09 * s0.retT;
  lines.push(`仅用今日收盘：明日开盘约 ${fc >= 0 ? '+' : ''}${fc.toFixed(2)}%（今日 ${s0.retT >= 0 ? '+' : ''}${s0.retT.toFixed(2)}%）`);
  lines.push(`明早 09:26 会用美股 + 亚洲早盘 + 集合竞价更新`);
  // ⚠️ open-forecast.json 必须继续写：premarket.mjs 读它来对比「下午预判 vs 清晨预判」。
  //    删「明日开盘应对」那一节时顺手删过这个写入，是错的 —— 它跟那一节无关。
  try {
    writeFileSync('open-forecast.json', JSON.stringify({ generatedAt: new Date().toISOString(), T: sig.T, retT: s0.retT, predicted: +fc.toFixed(3), base: sig.states.map((s) => ({ key: s.key, close: s.close })) }, null, 1), 'utf8');
  } catch { /* 忽略 */ }
}
  // ---------- 明日操作 ----------
  // 这一节**替代**了原来的「明日开盘应对」（若明日高开>1% → 怎样）。
  // 那套条件规则只覆盖 2.6% 的交易日，对应面板已删；改成报告「价格线有没有被触发」——
  // 这是可以直接执行的，而且和持仓计划台的第一屏是同一份数据、同一套口径。
  // ⚠️ plan-data.json 由 plan-analysis.mjs 生成，排在「生成看板」之前，所以这里一定读得到。
  const plan = read('plan-data.json', null);
  if (plan?.action) {
    const A = plan.action;
    lines.push('—— 明日操作 ——');
    if (A.todo?.length) {
      for (const t of A.todo) {
        const a = (A.active ?? []).find((x) => x.name === t.name);
        if (t.hitAdd > 0) {
          lines.push(`⚠️ ${t.name} 第 ${t.hitAdd} 档加仓已触发（PE 分位 ${a?.pePct ?? '—'}%）`);
          if (a?.nextAdd) lines.push(`    下档 @${a.nextAdd.price}（${a.nextAdd.pct >= 0 ? '+' : ''}${a.nextAdd.pct}%）`);
        }
        if (t.hitCut > 0) lines.push(`⚠️ ${t.name} 第 ${t.cutTier} 档减仓已触发`);
      }
    } else {
      lines.push('明天不需要操作');
      if (A.closest) lines.push(`最近加仓线：${A.closest.name} @${A.closest.price}（还差 ${A.closest.pct}%）`);
    }
    if (plan.discipline?.permission) lines.push(`规则判定：${plan.discipline.permission.title}`);
  }

const title = `${today ?? '无数据'} A股盘后`;
const body = lines.join('\n');

console.log(`\n--- 推送内容 ---\n${title}\n${body}\n---------------`);

// 归档到 push-archive.json，供看板顶部的日期滚轮回看（不论是否真的推送都存）
try { appendPush('close', title, body, today); } catch (e) { console.log(`  ! 推送归档失败: ${e.message}`); }

// 推送：默认**没有配置就静默跳过**，不再打印成 ✗ 失败。
// 原因：每天都红一句「未配置 Bark 地址」，会让人对日志里的红色麻木 ——
// 到真出问题时反而看不见。用户明确表示不需要推送，所以这里只留一行中性说明。
if (SKIP_PUSH) {
  console.log('  – 推送手机           跳过（--no-push）');
  results.push({ name: '推送手机', ok: true, skipped: true, ms: 0 });
} else {
  const cfg = loadConfig();
  const target = cfg.barkUrl || cfg.webhook?.url;
  if (!target) {
    console.log('  – 推送手机           未配置（不需要推送就保持这样；要开启见 push-config.json）');
    results.push({ name: '推送手机', ok: true, skipped: true, ms: 0 });
  } else {
    const t0 = Date.now();
    const r = await push(title, body);
    console.log(r.ok ? '✓ 已推送到手机' : `✗ 推送失败: ${r.message}`);
    results.push({ name: '推送手机', ok: !!r.ok, ms: Date.now() - t0, err: r.ok ? undefined : r.message });
  }
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
    // 备份是纯本地 git 操作（实测带改动约 0.3s），但 2026-10-10 那次跑满 2 分钟超时被杀、
    // 子进程一句输出都没有 —— 属偶发卡死。所以：超时放宽 + 失败重试一次 + 打出 signal，
    // 免得「历史快照」这种不可再生的东西因为一次抖动就丢掉。
    let backupErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // ⚠️ 这里原来写的是 `日更 ${today ?? ''}`，而 today 是 buildAndArchivePush() 的**函数局部变量**，
        //    在这个作用域里根本不存在 → 抛 ReferenceError（被下面的 catch 吞掉，只显示"备份失败"）。
        //    改成就地取最近交易日，不再依赖别处的变量。
        const backupDay = (() => {
          try { return JSON.parse(readFileSync('market-data.json', 'utf8')).at(-1)?.date ?? ''; } catch { return ''; }
        })();
        execFileSync('node', ['backup.mjs', `日更 ${backupDay}`.trim()], { stdio: 'inherit', timeout: 5 * 60 * 1000 });
        results.push({ name: '历史备份', ok: true, ms: Date.now() - t0 });
        backupErr = null;
        break;
      } catch (e) {
        backupErr = e;
        console.log(
          `  ! 历史备份第 ${attempt} 次失败 status=${e.status ?? '?'} signal=${e.signal ?? '-'} code=${e.code ?? '-'}（${String(e.message).slice(0, 70)}）`,
        );
        if (attempt < 2) await sleep(5000);
      }
    }
    if (backupErr) results.push({ name: '历史备份', ok: false, ms: Date.now() - t0 });
  }
}

const logLine = `${new Date().toISOString()}\t${results.map((r) => `${r.name}:${r.ok ? 'ok' : 'FAIL'}`).join(' ')}\n`;
try { appendFileSync('daily-update.log', logLine); } catch { /* 忽略 */ }
process.exit(failed.length ? 1 : 0);

