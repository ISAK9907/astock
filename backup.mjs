// 把当前工作区快照提交进本地 git —— 这就是「历史版本备份」。
//
// 为什么需要它：这个项目没有远端仓库，而源文件是手改的（曾经用 PowerShell 的文本管道
// 把 build-dashboard.mjs 的中文全部写坏过一次，当时没有任何可回退的版本）。
// 每次日更后自动提交一次，任何时候都能 `git diff` / `git checkout` 回到任一交易日。
//
// 用法：
//   node backup.mjs                  # 自动生成提交信息
//   node backup.mjs "改了档位口径"    # 追加自定义说明
//
// ⚠️ 沙箱禁止 piped stdio（spawnSync git EPERM），所以**不能**用 execFileSync 捕获输出。
//    这里改成把 git 的 stdout 写到一个临时文件的文件描述符上 —— 文件是允许的。
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const note = process.argv[2] ?? '';
const TMP = join(tmpdir(), `astock-gitout-${process.pid}.txt`);

/** 运行 git 并把 stdout 收进文件描述符（避开管道限制）。失败时抛出，附带 .status */
function git(args) {
  const fd = openSync(TMP, 'w');
  try {
    execFileSync('git', args, { stdio: ['ignore', fd, 'ignore'] });
  } finally {
    try { closeSync(fd); } catch { /* 已关 */ }
  }
  const out = readFileSync(TMP, 'utf8');
  try { unlinkSync(TMP); } catch { /* 忽略 */ }
  return out.trim();
}
/** 只关心退出码的场景（如 check-ignore -q / diff --quiet） */
function gitCode(args) {
  try {
    const fd = openSync(TMP, 'w');
    try { execFileSync('git', args, { stdio: ['ignore', fd, 'ignore'] }); } finally { closeSync(fd); }
    try { unlinkSync(TMP); } catch { /* 忽略 */ }
    return 0;
  } catch (e) {
    try { unlinkSync(TMP); } catch { /* 忽略 */ }
    return e.status ?? -1;
  }
}

// ---- 前置检查 ----
if (!existsSync('.git')) {
  console.error('✗ 当前目录不是 git 仓库（先运行 git init）');
  process.exit(2);
}

// ⚠️ 保险：deploy-config.json 里是 GitHub token。提交前必须确认它被忽略，
//    否则一次误提交就会把密钥写进历史（很难彻底清除）。
if (gitCode(['check-ignore', '-q', 'deploy-config.json']) !== 0) {
  console.error('✗ deploy-config.json 没有被 .gitignore 排除 —— 拒绝提交，先修 .gitignore');
  process.exit(3);
}

// ---- 暂存并判断有无改动 ----
git(['add', '-A']);
if (gitCode(['diff', '--cached', '--quiet']) === 0) {
  console.log('  备份：无改动，跳过提交');
  process.exit(0);
}
const files = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const stat = git(['diff', '--cached', '--shortstat']);

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const msg = [`快照 ${stamp}`, note, `${files.length} 个文件${stat ? '，' + stat : ''}`].filter(Boolean).join('\n');

// 用户身份可能没配（新机器上），缺了就临时用命令行的身份，避免提交失败
git(['-c', 'user.name=DSH Dashboard', '-c', 'user.email=dsh@localhost', 'commit', '-q', '-m', msg]);
const hash = git(['rev-parse', '--short', 'HEAD']);

console.log(`  备份：已提交 ${hash}  ${files.length} 个文件${stat ? '，' + stat : ''}`);
console.log(`        信息：快照 ${stamp}${note ? ' · ' + note : ''}`);
console.log(`        查看 git show ${hash}   ·   回退 git checkout ${hash} -- <文件>`);
if (files.length <= 8) for (const f of files) console.log(`          · ${f}`);
else console.log(`          · ${files.slice(0, 6).join('、')} 等 ${files.length} 个`);
