// 追加一条结构化的「运行记录」→ runs.jsonl
//
// 为什么需要它：原来的做法是让 daily-update.mjs 把汇总行 append 进 daily-update.log，
// 而启动器 run-daily.cmd 又把 node 的 stdout 重定向到**同一个文件**。
// 两个写者互相踩，结果是**计划任务的汇总行被覆盖掉**（2026-10-05/06/07 三次都是这样：
// 日志里能看到它完整跑完并提交了备份，却找不到那条汇总行）。
// 于是任何「按日志判断定时任务是否成功」的逻辑都会得出错误结论。
//
// 这个文件只有一个写者（启动器调用本脚本），并且直接记录**是谁触发的**（source），
// 不需要再从日志里猜。
//
// 用法（由 run-daily.cmd / run-premarket.cmd 调用）：
//   node record-run.mjs <daily|premarket> <退出码>
// 环境变量 DSH_RUN_SOURCE 由启动器设为 scheduled；手动运行时不设，记为 manual。
import { appendFileSync } from 'node:fs';

const KIND = process.argv[2] ?? 'unknown';
const RC = Number(process.argv[3] ?? 0);
const SOURCE = process.env.DSH_RUN_SOURCE === 'scheduled' ? 'scheduled' : 'manual';

const rec = {
  at: new Date().toISOString(),
  kind: KIND,
  rc: RC,
  ok: RC === 0,
  source: SOURCE,
};

try {
  appendFileSync('runs.jsonl', JSON.stringify(rec) + '\n', 'utf8');
  console.log(`  [runs.jsonl] 记录一次 ${KIND} 运行：source=${SOURCE} rc=${RC} ${rec.ok ? 'ok' : 'FAILED'}`);
} catch (e) {
  console.log(`  ! runs.jsonl 写入失败: ${e.message}（不影响主流程）`);
}
