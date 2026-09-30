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
const FILES = [
  ['astock-dashboard.html', 'index.html', 'text/html'],
  // version.json：手机端靠轮询它发现自己看到的是旧版本 → 自动刷新。
  // 必须一并上传，否则线上页面永远等不到版本变化。
  ['version.json', 'version.json', 'application/json'],
  ['manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json'],
  ['sw.js', 'sw.js', 'application/javascript'],
  ['icon-192.png', 'icon-192.png', 'image/png'],
  ['icon-512.png', 'icon-512.png', 'image/png'],
  ['icon-maskable-512.png', 'icon-maskable-512.png', 'image/png'],
];

async function putFile(local, remote) {
  const buf = readFileSync(local);
  let sha = null;
  const cur = await api(`/repos/${USER}/${REPO}/contents/${remote}?ref=${BRANCH}`);
  if (cur.ok && cur.json?.sha) sha = cur.json.sha;
  const put = await api(`/repos/${USER}/${REPO}/contents/${remote}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${remote} 自动更新 ${new Date().toLocaleString('zh-CN')}`,
      content: buf.toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) throw new Error(`${remote}: HTTP ${put.status} ${put.json?.message ?? ''}`);
  return { remote, kb: buf.length / 1024, updated: !!sha };
}

for (const [local, remote] of FILES) {
  if (!existsSync(local)) { console.warn(`  ! 跳过 ${remote}（本地无 ${local}，先跑 node make-icons.mjs）`); continue; }
  const r = await putFile(local, remote);
  console.log(`  ✓ ${r.remote.padEnd(24)} ${r.kb.toFixed(1).padStart(6)} KB  ${r.updated ? '更新' : '新建'}`);
}

// ---------- 4. 开启 Pages（已开则忽略） ----------
const pages = await api(`/repos/${USER}/${REPO}/pages`);
if (pages.ok) {
  console.log(`  Pages 已开启，来源 ${pages.json.source?.branch}/${pages.json.source?.path}`);
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

// ---------- 5. 轮询可达性 ----------
if (!cfg.skipWait) {
  for (let i = 1; i <= 12; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 12000);
      const r = await fetch(`${URL}?t=${Date.now()}`, { signal: ac.signal, headers: { 'User-Agent': 'dsh' } });
      clearTimeout(t);
      const body = await r.text();
      if (r.ok && body.includes('themeBtn')) {
        console.log(`✓ 已可访问（第 ${i} 次探测，HTTP ${r.status}，${(body.length / 1024).toFixed(1)} KB）`);
        process.exit(0);
      }
      console.log(`  …第 ${i} 次探测 HTTP ${r.status}（尚未就绪）`);
    } catch (e) {
      console.log(`  …第 ${i} 次探测失败：${e.message}`);
    }
  }
  console.log('⚠️ 轮询超时，但文件已推送。稍等一两分钟再打开上面的地址试试。');
}
