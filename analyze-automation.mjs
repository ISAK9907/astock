// 自动化健康度 → automation.json
//
// 起因：盘前更新任务从 2026-09-24 起就没再成功运行过（14 天），而看板、日志、
// 计划任务状态都没有任何提示 —— 这种静默失败只有主动去翻日志才发现。
// 这个脚本把「最后成功是什么时候」和「按日历本该跑几次」对上，差了多少一目了然。
//
// ⚠️ 它读的是**本机日志**（daily-update.log / premarket.log），而这两个文件被 .gitignore
//    排除（*.log），所以云端构建时读不到 —— 那时面板会明确写「本机日志不可用」，
//    而不是假装一切正常。
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { OFFICIAL, isTradingDay, lastTradingDayOnOrBefore, tradingDaysBetween } from './holidays.mjs';

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayDiff = (a, b) => Math.round((new Date(`${a}T00:00:00`) - new Date(`${b}T00:00:00`)) / 864e5);

// 交易日判定统一由 holidays.mjs 提供（此前这里有一份私有实现，容易和别处不一致）

/**
 * 结构化运行记录 runs.jsonl（由启动器调用 record-run.mjs 写入）。
 * 为什么不从日志里推断：启动器把 node 的 stdout 重定向到 daily-update.log，而
 * daily-update.mjs 又把汇总行 append 进同一个文件 —— 两个写者互相踩，
 * **计划任务的汇总行会被覆盖掉**（2026-10-05/06/07 三次都是完整跑完却查不到汇总行）。
 * 所以「这次是谁触发的、退出码多少」必须由启动器直接记下来，不能靠解析日志。
 */
function readRuns() {
  if (!existsSync('runs.jsonl')) return [];
  const out = [];
  for (const l of readFileSync('runs.jsonl', 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 从日志里找最后一条带 ISO 时间戳的记录 */
function lastStamp(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\t(.*)$/.exec(lines[i]);
    if (!m) continue;
    const dt = new Date(m[1]);
    if (isNaN(dt)) continue;
    // ⚠️ 不要自己加 8 小时：日志里存的是 UTC，但 getHours() 返回的是**本地时间**，
    //    而本机时区就是 Asia/Shanghai —— 再 +8h 等于加两次（12:20 会显示成 20:20）。
    const bj = dt;
    return {
      iso: m[1],
      bj: `${iso(bj)} ${pad(bj.getHours())}:${pad(bj.getMinutes())}`,
      date: iso(bj),
      failed: /:FAIL|✗/.test(m[2]),
      text: m[2].slice(0, 160),
      rawLine: lines[i], // lastWasScheduled 要靠它定位
    };
  }
  return null;
}

/**
 * 计划任务的「最近一次尝试」及其结局。
 * 为什么必须单独看这个：被打断的运行**不会写汇总行**，所以「最后成功时间」会一直
 * 停在更早的一次，看起来像没事 —— 10-05/06/07 三次就是这么被掩盖的
 * （日志里能看到 `exit=3221225786` = STATUS_CONTROL_C_EXIT 和 `^C`）。
 */
function lastAttempt(file, okRe) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  let start = -1, startedAt = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/scheduled run =====/.test(lines[i])) {
      // 取这行里的日期时间
      const m = /=====\s*(\S+\s+[\d/:]+\s+[\d:.]+)\s*scheduled run/.exec(lines[i]);
      startedAt = m ? m[1] : '';
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const tail = lines.slice(start);
  const okLine = tail.find((l) => okRe.test(l));
  const failLine = tail.find((l) => /FAILED rc=|gave up after/.test(l));
  // 明确的中断证据
  const interrupted = tail.some((l) => /3221225786|0xC000013A|\^C/.test(l)) || (!okLine && !failLine);
  return {
    startedAt,
    finished: !!okLine,
    failed: !!failLine && !okLine,
    interrupted: !okLine && !failLine,
    evidence: interrupted ? (tail.find((l) => /3221225786|0xC000013A|\^C/.test(l)) || '').trim().slice(0, 120) : '',
  };
}

/**
 * 最后一次成功是「计划任务跑出来的」还是「手动跑的」？
 * 为什么必须区分：手动补跑一次之后，「最后成功时间」马上变新，状态带就会显示正常 ——
 * 而计划任务其实还是坏的。这正是最容易自欺的地方。
 * 判据：日更/盘前的启动器会在 node 跑完后紧接着写一行 `attempt N OK` / `] OK`。
 * 所以「最后一条汇总行之后还有 OK 行」= 计划任务跑的；没有 = 手动跑的。
 */
function lastWasScheduled(file, sumLine, okRe) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const idx = lines.lastIndexOf(sumLine);
  if (idx < 0) return null;
  // 看汇总行之后的 6 行内有没有启动器写的 OK 标记
  return lines.slice(idx + 1, idx + 7).some((l) => okRe.test(l));
}

const todayIso = iso(now);
const mins = now.getHours() * 60 + now.getMinutes();
const nowTrading = isTradingDay(todayIso);
const runs = readRuns();

// 日更 15:40 跑；15:30 之前「今天该不该有数据」要算到上一个交易日
const dailyExpected = nowTrading && mins >= 15 * 60 + 30 ? todayIso : lastTradingDayOnOrBefore(iso(new Date(now.getTime() - 864e5)));
// 盘前 09:26 跑；09:30 之前算到上一个交易日
const preExpected = nowTrading && mins >= 9 * 60 + 30 ? todayIso : lastTradingDayOnOrBefore(iso(new Date(now.getTime() - 864e5)));

function health(file, expected, schedule, label, okRe, kind, runs) {
  const last = lastStamp(file);
  const myRuns = runs.filter((r) => r.kind === kind);
  const lastRecord = myRuns.at(-1) ?? null;
  const lastScheduledOk = [...myRuns].reverse().find((r) => r.source === 'scheduled' && r.ok) ?? null;
  const lastManualOk = [...myRuns].reverse().find((r) => r.source !== 'scheduled' && r.ok) ?? null;
  if (!last && !myRuns.length) {
    return { label, schedule, available: false, note: existsSync(file) ? '日志里还没有成功记录' : '本机日志不可用（云端构建时读不到）' };
  }
  // 「数据是否新鲜」看任意来源的最后成功；「自动化是否健康」只看计划任务的最后成功
  const bj = (isoStr) => {
    const d = new Date(isoStr);
    return `${iso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const freshAt = lastRecord?.ok ? bj(lastRecord.at) : (last?.bj ?? null);
  const freshDate = lastRecord?.ok ? iso(new Date(lastRecord.at)) : (last?.date ?? null);
  const behind = freshDate && freshDate < expected ? tradingDaysBetween(freshDate, expected) : freshDate ? 0 : null;

  // 计划任务维度：最后一次「计划任务触发的成功」是否已经不落后了
  const schDate = lastScheduledOk ? iso(new Date(lastScheduledOk.at)) : null;
  const schBehind = schDate && schDate < expected ? tradingDaysBetween(schDate, expected) : schDate ? 0 : null;

  // 关键判断：数据是新的，但新数据来自手动补跑 → 计划任务仍然是坏的
  const manualOnly = !lastScheduledOk || (lastRecord?.ok && lastRecord.source !== 'scheduled');

  const att = lastRecord
    ? { startedAt: bj(lastRecord.at), finished: true, failed: !lastRecord.ok, interrupted: false, evidence: `rc=${lastRecord.rc} source=${lastRecord.source}` }
    : null;

  const ok = behind === 0 && !manualOnly;
  return {
    label,
    schedule,
    available: true,
    lastOk: freshAt,
    lastDate: freshDate,
    expected,
    behind: behind ?? 0,
    lastScheduledOk: lastScheduledOk ? bj(lastScheduledOk.at) : null,
    lastScheduledBehind: schBehind,
    lastManualOk: lastManualOk ? bj(lastManualOk.at) : null,
    lastRecord,
    manualOnly,
    lastAttempt: att,
    ok,
    note: last?.text ?? '',
  };
}

const out = {
  generatedAt: now.toISOString(),
  now: `${todayIso} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  isTradingDay: nowTrading,
  daily: health('daily-update.log', dailyExpected, '工作日 15:40（本机）', '盘后日更', /attempt \d+ OK/, 'daily', runs),
  premarket: health('premarket.log', preExpected, '工作日 09:26（本机）', '盘前更新', /\] OK\b/, 'premarket', runs),
  cloud: { label: '云端兜底', schedule: '工作日 15:50（GitHub Actions）', note: '本机没跑成时由它接手' },
};
// 注意：「看板数据是否落后」这条**不在这里算**。
// 本脚本在 build-dashboard 之前跑，这时 version.json 还是**上一次发布**的，
// 拿它判断会把「正在生成的这次更新」误判成落后。那条判断放在 build-dashboard.mjs 里，
// 用这次构建自己的数据日期（last.date）算，才准确。
writeFileSync('automation.json', JSON.stringify(out, null, 1), 'utf8');

const line = (h) => {
  if (!h.available) return `${h.label}: ${h.note}`;
  const w =
    h.behind > 0
      ? `⚠️ 计划任务未跑成（落后 ${h.behind} 个交易日）`
      : h.manualOnly
        ? `⚠️ 数据是新的，但来自手动补跑；计划任务最后一次成功 ${h.lastScheduledOk ?? '（没有记录）'}`
        : '✓ 正常';
  return `${h.label}: 最后成功 ${h.lastOk ?? '（无）'}  ${w}  （${h.schedule}）`;
};
console.log(`自动化健康度（当前 ${out.now}${nowTrading ? '，交易日' : '，非交易日'}）`);
console.log('  ' + line(out.daily));
console.log('  ' + line(out.premarket));
console.log(`  ${out.cloud.label}: ${out.cloud.schedule}`);
