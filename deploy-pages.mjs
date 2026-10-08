// 把看板部署到 GitHub Pages（只用 REST API，不需要 git，token 不落盘到 .git/config）
//
// 配置来源（按优先级）：
//   1. 环境变量 GITHUB_TOKEN / DSH_GH_TOKEN
//   2. deploy-config.json  { "token": "...", "repo": "astock", "user": "可选" }
//
// 用法: node deploy-pages.mjs [--check]
import { readFileSync, existsSync } from 'node:fs';

const REPO_FILE = 'deploy-config.json';
const cfg = existsSync(REPO_FILE) ? JSON.parse(readFileSync(REPO_FILE, 'utf8')) : {};
const TOKEN = process.env.GITHUB_TOKEN || process.env.DSH_GH_TOKEN || cfg.token || '';
const REPO = cfg.repo || 'astock';
const CHECK_ONLY = process.argv.includes('--check');

if (!TOKEN) {
  console.error('✗ 未配置 GitHub token。');
  console.error('  请把 token 写入 deploy-config.json 的 "token" 字段，或设置环境变量 GITHUB_TOKEN。');
  process.exit(2);
}

const API = 'https://api.github.com';
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': process.env.USERNAME || 'dsh-dashboard',
};

async function api(path, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(API + path, { ...init, headers: { ...H, ...(init.headers || {}) }, signal: ac.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: r.status, ok: r.ok, json, text };
  } finally { clearTimeout(t); }
}

// ---------- 1. 校验 token ----------
const me = await api('/user');
if (!me.ok) {
  console.error(`✗ token 校验失败：HTTP ${me.status} ${me.json?.message ?? me.text.slice(0, 120)}`);
  console.error('  请确认 token 未过期，且勾选了 repo 权限（细粒度 token 需要 Contents: Read and write + Pages: Read and write）。');
  process.exit(1);
}
const USER = cfg.user || me.json.login;
console.log(`✓ token 有效，账号 ${USER}`);

// ---------- 2. 检查 / 创建仓库 ----------
let repoInfo = await api(`/repos/${USER}/${REPO}`);
if (repoInfo.status === 404) {
  console.log(`  仓库 ${USER}/${REPO} 不存在，创建中…`);
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({ name: REPO, private: false, auto_init: false, description: 'A股情绪与事件看板（自动日更）' }),
  });
  if (!created.ok) {
    console.error(`✗ 创建仓库失败：HTTP ${created.status} ${created.json?.message ?? ''}`);
    process.exit(1);
  }
  repoInfo = created;
  console.log(`  ✓ 已创建（公开仓库，Pages 免费版需要公开）`);
} else if (!repoInfo.ok) {
  console.error(`✗ 读取仓库失败：HTTP ${repoInfo.status} ${repoInfo.json?.message ?? ''}`);
  process.exit(1);
} else {
  console.log(`  仓库已存在：${USER}/${REPO}`);
}
const BRANCH = repoInfo.json?.default_branch || 'main';

if (CHECK_ONLY) {
  console.log(`\n(--check) 目标地址将是 https://${USER}.github.io/${REPO}/`);
  process.exit(0);
}

// ---------- 3. 上传看板 + PWA 资源 ----------
// ⚠️ 必须**一次提交推完所有文件**，不能一个文件一次 PUT。
//    踩过的坑：老写法对 7 个文件各调一次 contents/PUT，等于 10 秒内创建 7 个提交，
//    GitHub Pages 会为每个提交排队构建、并把前一个 cancel —— 2026-10-08 就把最后一次
//    构建挤成了 failure，Pages 状态变成 errored，站点一直发旧版本（仓库里其实已是新的）。
//    改走 Git Data API：blobs → tree(base_tree) → commit → PATCH ref，只产生 1 次构建。
const FILES = [
  ['astock-dashboard.html', 'index.html'],
  // version.json：手机端靠轮询它发现自己看到的是旧版本 → 自动刷新。
  // 必须一并上传，否则线上页面永远等不到版本变化。
  ['version.json', 'version.json'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['sw.js', 'sw.js'],
  ['icon-192.png', 'icon-192.png'],
  ['icon-512.png', 'icon-512.png'],
  ['icon-maskable-512.png', 'icon-maskable-512.png'],
];

async function apiOrThrow(path, init, what) {
  const r = await api(path, init);
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${r.json?.message ?? r.text.slice(0, 120)}`);
  return r.json;
}

async function pushAll() {
  const present = FILES.filter(([local]) => existsSync(local));
  for (const [local, remote] of FILES) if (!existsSync(local)) console.warn(`  ! 跳过 ${remote}（本地无 ${local}，先跑 node make-icons.mjs）`);
  if (!present.length) throw new Error('没有任何可上传的文件');

  const ref = await apiOrThrow(`/repos/${USER}/${REPO}/git/ref/heads/${BRANCH}`, {}, '读取分支');
  const baseSha = ref.object.sha;
  const baseCommit = await apiOrThrow(`/repos/${USER}/${REPO}/git/commits/${baseSha}`, {}, '读取当前提交');

  // 并发创建 blobs（每个文件一个 blob，但**只提交一次**）
  const entries = await Promise.all(
    present.map(async ([local, remote]) => {
      const buf = readFileSync(local);
      const b = await apiOrThrow(
        `/repos/${USER}/${REPO}/git/blobs`,
        { method: 'POST', body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }) },
        `blob ${remote}`,
      );
      console.log(`  ✓ ${remote.padEnd(24)} ${(buf.length / 1024).toFixed(1).padStart(6)} KB`);
      return { path: remote, mode: '100644', type: 'blob', sha: b.sha };
    }),
  );

  // base_tree 保证没列到的文件（README、源码、workflow…）原样保留，不会被这次提交删掉
  const tree = await apiOrThrow(
    `/repos/${USER}/${REPO}/git/trees`,
    { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }) },
    '建树',
  );
  const commit = await apiOrThrow(
    `/repos/${USER}/${REPO}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: `看板自动部署 ${new Date().toLocaleString('zh-CN')}`,
        tree: tree.sha,
        parents: [baseSha],
      }),
    },
    '创建提交',
  );
  await apiOrThrow(
    `/repos/${USER}/${REPO}/git/refs/heads/${BRANCH}`,
    { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) },
    '更新分支',
  );
  console.log(`  已推送 1 个提交 ${commit.sha.slice(0, 8)}（含 ${entries.length} 个文件，只触发 1 次 Pages 构建）`);
  return commit.sha;
}

const pushedSha = await pushAll();

// ---------- 4. 开启 Pages（已开则忽略） ----------
let pages = await api(`/repos/${USER}/${REPO}/pages`);
if (pages.ok && pages.json.status === 'errored') {
  // 之前被并发提交挤坏过的话，这里主动请求一次重建，否则会一直发旧版本
  console.log(`  Pages 状态为 errored，请求重建…`);
  const rb = await api(`/repos/${USER}/${REPO}/pages/builds`, { method: 'POST' });
  console.log(rb.ok || rb.status === 201 ? '  ✓ 已请求重建' : `  ! 重建请求返回 HTTP ${rb.status}`);
  pages = await api(`/repos/${USER}/${REPO}/pages`);
}
if (pages.ok) {
  console.log(`  Pages 来源 ${pages.json.source?.branch}/${pages.json.source?.path}（状态 ${pages.json.status}）`);
} else {
  console.log('  开启 Pages…');
  const on = await api(`/repos/${USER}/${REPO}/pages`, {
    method: 'POST',
    body: JSON.stringify({ source: { branch: BRANCH, path: '/' } }),
  });
  if (!on.ok && on.status !== 409) {
    console.error(`✗ 开启 Pages 失败：HTTP ${on.status} ${on.json?.message ?? ''}`);
    console.error('  可手动到仓库 Settings → Pages 里选 main 分支 /(root) 保存。');
    process.exit(1);
  }
  console.log('  ✓ 已请求开启（首次构建约需 30~90 秒）');
}

const URL = `https://${USER}.github.io/${REPO}/`;
console.log(`\n目标地址：${URL}`);

// ---------- 5. 轮询：必须**内容真的换成新版**才算完成 ----------
// 老写法只检查页面里有没有 themeBtn —— 旧版本同样通过，所以它报「✓ 已可访问」时
// 站点其实还在发旧内容（2026-10-08 就是这样误判了 10 分钟）。这里改成比哈希 + 比 version.json。
if (!cfg.skipWait) {
  const { createHash } = await import('node:crypto');
  const localHtml = readFileSync('astock-dashboard.html', 'utf8');
  const wantHash = createHash('sha256').update(localHtml).digest('hex').slice(0, 16);
  const wantVer = JSON.parse(readFileSync('version.json', 'utf8')).generatedAt;
  console.log(`  期望线上 hash ${wantHash} · version.json ${wantVer}`);
  let last = '';
  for (let i = 1; i <= 18; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const r = await fetch(`${URL}index.html?cb=${Date.now()}`, { headers: { 'User-Agent': 'dsh' } });
      const body = await r.text();
      const h = createHash('sha256').update(body).digest('hex').slice(0, 16);
      const v = await (await fetch(`${URL}version.json?cb=${Date.now()}`, { headers: { 'User-Agent': 'dsh' } })).json().catch(() => null);
      if (h === wantHash && v?.generatedAt === wantVer) {
        console.log(`✓ 已上线（第 ${i} 次探测，hash ${h}，${(body.length / 1024).toFixed(1)} KB）`);
        process.exit(0);
      }
      last = `hash=${h} version=${v?.generatedAt ?? '?'}`;
      console.log(`  …第 ${i} 次探测：线上仍是 ${last}（尚未切换）`);
    } catch (e) {
      console.log(`  …第 ${i} 次探测失败：${e.message}`);
    }
  }
  console.log(`⚠️ 轮询超时：仍未切换到新版（线上 ${last}）。`);
  console.log('  文件已经推上去了，多半是 GitHub Pages 的 CDN 还在发缓存；也可能构建失败了 ——');
  console.log('  查 https://github.com/' + USER + '/' + REPO + '/actions 里的 "pages build and deployment"。');
  process.exitCode = 5;
}
