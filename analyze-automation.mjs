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
import { OFFICIAL } from './holidays.mjs';

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayDiff = (a, b) => Math.round((new Date(`${a}T00:00:00`) - new Date(`${b}T00:00:00`)) / 864e5);

/** 是否交易日：非周末，且不在官方休市区间 [from, to) 内 */
function isTradingDay(dIso) {
  const d = new Date(`${dIso}T00:00:00`);
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  for (const h of OFFICIAL) if (dIso >= h.from && dIso < h.to) return false;
  return true;
}
/** 往前找最近一个交易日（含当天） */
function lastTradingDayOnOrBefore(dIso) {
  let d = new Date(`${dIso}T00:00:00`);
  for (let i = 0; i < 30; i++) {
    const s = iso(d);
    if (isTradingDay(s)) return s;
    d.setDate(d.getDate() - 1);
  }
  return null;
}
/** 统计 (from, to] 之间有多少个交易日 —— 即「本该跑几次」 */
function tradingDaysBetween(fromIso, toIso) {
  let n = 0;
  const d = new Date(`${fromIso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  while (iso(d) <= toIso) {
    if (isTradingDay(iso(d))) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
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

const todayIso = iso(now);
const mins = now.getHours() * 60 + now.getMinutes();
const nowTrading = isTradingDay(todayIso);

// 日更 15:40 跑；15:30 之前「今天该不该有数据」要算到上一个交易日
const dailyExpected = nowTrading && mins >= 15 * 60 + 30 ? todayIso : lastTradingDayOnOrBefore(iso(new Date(now.getTime() - 864e5)));
// 盘前 09:26 跑；09:30 之前算到上一个交易日
const preExpected = nowTrading && mins >= 9 * 60 + 30 ? todayIso : lastTradingDayOnOrBefore(iso(new Date(now.getTime() - 864e5)));

function health(file, expected, schedule, label, okRe) {
  const last = lastStamp(file);
  const attempt = lastAttempt(file, okRe);
  if (!last && !attempt) {
    return { label, schedule, available: false, note: existsSync(file) ? '日志里还没有成功记录' : '本机日志不可用（云端构建时读不到）' };
  }
  const lastDate = last?.date ?? null;
  const behind = lastDate && lastDate < expected ? tradingDaysBetween(lastDate, expected) : lastDate ? 0 : null;
  const att = attempt
    ? { startedAt: attempt.startedAt, finished: attempt.finished, failed: attempt.failed, interrupted: attempt.interrupted, evidence: attempt.evidence }
    : null;
  // ⚠️ 「被打断」要单独算不健康：它不写汇总行，所以 lastOk 会停在更早一次而看着正常
  const ok = behind === 0 && !att?.interrupted;
  return {
    label,
    schedule,
    available: true,
    lastOk: last?.bj ?? null,
    lastDate,
    lastFailed: last?.failed ?? false,
    expected,
    behind: behind ?? 0,
    lastAttempt: att,
    ok,
    note: last?.text ?? '',
  };
}

const out = {
  generatedAt: now.toISOString(),
  now: `${todayIso} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  isTradingDay: nowTrading,
  daily: health('daily-update.log', dailyExpected, '工作日 15:40（本机）', '盘后日更', /attempt \d+ OK/),
  premarket: health('premarket.log', preExpected, '工作日 09:26（本机）', '盘前更新', /\] OK\b/),
  cloud: { label: '云端兜底', schedule: '工作日 15:50（GitHub Actions）', note: '本机没跑成时由它接手' },
};
writeFileSync('automation.json', JSON.stringify(out, null, 1), 'utf8');

const line = (h) => {
  if (!h.available) return `${h.label}: ${h.note}`;
  const w = h.behind > 0 ? `⚠️ 落后 ${h.behind} 个交易日` : h.lastAttempt?.interrupted ? '⚠️ 上次尝试被中断' : '✓ 正常';
  const att = h.lastAttempt?.interrupted ? `  最后一次尝试 ${h.lastAttempt.startedAt} 未跑完` : '';
  return `${h.label}: 最后成功 ${h.lastOk ?? '（无）'}  ${w}  （${h.schedule}）${att}`;
};
console.log(`自动化健康度（当前 ${out.now}${nowTrading ? '，交易日' : '，非交易日'}）`);
console.log('  ' + line(out.daily));
console.log('  ' + line(out.premarket));
console.log(`  ${out.cloud.label}: ${out.cloud.schedule}`);
