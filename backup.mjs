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

// ---- 中文损坏防线 ----
// 为什么需要：这个项目已经两次把源文件的中文写坏（都是 PowerShell 的 Get-Content|Set-Content
// 按系统 GBK 读、再按 UTF-8 写）。坏出来的**不是 U+FFFD**，而是合法 UTF-8 的乱码，
// 所以 node --check 和常见的编码检查都发现不了，往往等下次打开文件才看出来 ——
// 那时可能已经提交了好几轮。
// 判定用「乱码特征字」计数：这些字在正常中文里几乎不会出现。
// ⚠️ 特征字表必须写成 \u 转义，不能写字面量 —— 否则这个文件自己就会被判为乱码（真踩过）。
const MOJI = '\u9225\u951b\u9428\u6d93\u93c4\u935c\u6d63\u9366\u93c3\u93c2\u9359\u6769\u7ee0\u941e\u9286\u922b\u9472\u93b4\u9429\u93cd\u935d\u942b\u95ab\u93c7\u7487\u93cb\u74d2\u9351\u59f9\u9410\u95b2\u7f01\u941c\u934f'.split('');
const TEXT_EXT = ['.mjs', '.js', '.json', '.md', '.html', '.yml', '.yaml', '.cmd', '.txt', '.css'];
const suspects = [];
for (const f of files) {
  if (!TEXT_EXT.some((e) => f.endsWith(e))) continue;
  let raw;
  try { raw = readFileSync(f, 'utf8'); } catch { continue; }
  const hits = MOJI.reduce((n, ch) => n + (raw.split(ch).length - 1), 0);
  const fffd = raw.split('\uFFFD').length - 1;
  if (hits >= 5 || fffd > 0) suspects.push({ f, hits, fffd });
}
if (suspects.length && !process.argv.includes('--allow-mojibake')) {
  console.error('\n✗ 检测到中文损坏的文件，拒绝提交：');
  for (const s of suspects) console.error(`    ${s.f}  （乱码特征字 ${s.hits} 个，替换字符 ${s.fffd} 个）`);
  console.error('\n  这通常是把 UTF-8 文件用 PowerShell 的 Get-Content|Set-Content 改过（按 GBK 读、按 UTF-8 写）。');
  console.error('  修法：git checkout <上一个好提交> -- <文件>，再用 edit 类工具重做改动。');
  console.error('  确认是误判就加 --allow-mojibake 重来一次。');
  process.exit(4);
}

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
