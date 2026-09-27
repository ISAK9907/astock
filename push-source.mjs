// 把本机「已被 git 跟踪的看板源文件」推到 GitHub 仓库，作为云端日更的输入。
//
// 为什么用 Git Data API 而不是 git push：
//   1) 本地 git 是给用户留历史快照的（backup.mjs），不该掺进跟远端的合并/变基；
//   2) 远端现在只有 6 个构建产物、没有源码，两个历史是无关的；
//   3) 走 API 的话 token 不出现在命令行里，也不会写进 .git/config。
//
// base_tree = 远端当前提交的 tree，只覆盖/新增我们带的文件，其余原样保留。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const cfg = JSON.parse(readFileSync('deploy-config.json', 'utf8'));
const { repo, token } = cfg;
const API = 'https://api.github.com';
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-push',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(path, init = {}) {
  const r = await fetch(API + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status} ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// ---- 待推文件清单：就用本地 git 跟踪的那批（已经过 .gitignore 筛选，不含密钥）----
const TMP = join(tmpdir(), `lsfiles-${process.pid}.txt`);
const fd = openSync(TMP, 'w');
try { execFileSync('git', ['ls-files', '-z'], { stdio: ['ignore', fd, 'ignore'] }); } finally { closeSync(fd); }
const files = readFileSync(TMP, 'utf8').split('\0').filter(Boolean);
try { unlinkSync(TMP); } catch { /* 忽略 */ }
console.log(`待推文件 ${files.length} 个`);
if (files.some((f) => f === 'deploy-config.json')) { console.error('✗ deploy-config.json 在清单里，拒绝推送'); process.exit(2); }

const owner = (await api('/user')).login;
console.log(`目标仓库 ${owner}/${repo}`);

// ---- 远端当前 HEAD ----
const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/main`);
const baseSha = ref.object.sha;
const baseCommit = await api(`/repos/${owner}/${repo}/git/commits/${baseSha}`);
console.log(`远端 HEAD = ${baseSha.slice(0, 8)}  tree = ${baseCommit.tree.sha.slice(0, 8)}`);

// ---- 并发创建 blobs ----
const entries = [];
let done = 0, failed = 0;
const CONC = 6;
let cursor = 0;
async function worker() {
  while (cursor < files.length) {
    const f = files[cursor++];
    if (!existsSync(f)) { console.log(`  ! 本地缺失，跳过 ${f}`); continue; }
    try {
      const content = readFileSync(f);
      const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
      });
      entries.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
      done++;
      if (done % 25 === 0) console.log(`  已上传 ${done}/${files.length}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${f}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`blob 上传完成：成功 ${entries.length}，失败 ${failed}`);
if (failed) { console.error('✗ 有文件上传失败，中止（避免推一个残缺的树）'); process.exit(3); }

// ---- 建树（基于 base_tree，只覆盖我们带的路径）----
const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }),
});
console.log(`新 tree = ${tree.sha.slice(0, 8)}  条目 ${tree.tree?.length ?? '?'}`);

// ---- 提交 ----
const msg =
  `接入云端日更：加入看板源码 + GitHub Actions workflow\n\n` +
  `原本日更跑在本地 Windows（计划任务 15:40 / 09:26），现在改由 GitHub runner 执行。\n` +
  `共 ${entries.length} 个源文件（构建脚本、抓取脚本、数据快照、两个 workflow）。\n` +
  `index.html 等构建产物保持在根目录，Pages 仍从 main/ 发布。`;
const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message: msg, tree: tree.sha, parents: [baseSha] }),
});
console.log(`新提交 = ${commit.sha.slice(0, 8)}`);

// ---- 移动 main ----
await api(`/repos/${owner}/${repo}/git/refs/heads/main`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
});
console.log(`✓ main 已指向 ${commit.sha.slice(0, 8)}`);
console.log(`  https://github.com/${owner}/${repo}/commit/${commit.sha}`);
