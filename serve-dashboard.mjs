// 手机查看看板用的极简静态服务器（零依赖）
// 只暴露看板 HTML 本身，不开放工作区其他文件。
// 另提供：
//   /signal        开盘后返回实时集合竞价跳空 + 盘前信号（同源，浏览器可直接取）
//   POST /update   手机上按「更新」按钮 → 在本机跑一次日更
//   /update-status 轮询日更进度（状态 + 日志尾），跑完由前端自动刷新页面
import { createServer } from 'node:http';
import { readFileSync, existsSync, openSync, closeSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { TH, decide } from './signal.mjs';
import { globalQuotes, forecastGap } from './global-quote.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'astock-dashboard.html');
const STATE = join(HERE, 'signal-state.json');
const RUN_LOG = join(HERE, 'update-run.log');
const PORT = Number(process.env.PORT ?? 8848);
const HOST = '0.0.0.0';

const SYM = { sh: 'sh000001', szcz: 'sz399001', cyb: 'sz399006', hs300: 'sh000300' };

/** 新浪实时行情（只取最新一天的开盘价与昨收） */
async function quote(symbols) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`https://hq.sinajs.cn/list=${symbols.join(',')}`, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const out = {};
    for (const row of text.split('\n')) {
      const m = /hq_str_(\w+)="([^"]*)"/.exec(row);
      if (!m) continue;
      const f = m[2].split(',');
      if (f.length < 10) continue;
      out[m[1]] = { open: +f[1], prevClose: +f[2], price: +f[3], date: f[30] || '', time: f[31] || '' };
    }
    if (!Object.keys(out).length) throw new Error('新浪 hq 返回空');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

let cache = { at: 0, payload: null };

async function buildSignal() {
  if (Date.now() - cache.at < 30_000 && cache.payload) return cache.payload;
  if (!existsSync(STATE)) throw new Error('signal-state.json 不存在，请先运行 node build-dashboard.mjs');
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  const keys = st.states.map((s) => s.key).filter((k) => SYM[k]);
  const q = await quote(keys.map((k) => SYM[k]));
  const out = { T: st.T, asOf: '', status: 'live', stale: false, thresholds: TH, indices: [] };
  for (const s of st.states) {
    const sym = SYM[s.key];
    const qt = sym ? q[sym] : null;
    let gap = null, status = 'live';
    if (!qt || qt.open <= 0 || qt.prevClose <= 0) {
      status = 'preopen'; // 还没有竞价数据
    } else if (qt.date && qt.date <= st.T) {
      // 行情还停在 T 日当天：收盘后到次日开盘前的正常状态，不是数据错误
      status = 'preopen';
    } else if (s.close && Math.abs(qt.prevClose - s.close) / s.close > 0.002) {
      status = 'stale'; // 行情已是 T+1，但昨收对不上 T 日收盘 → 状态文件过期
    } else {
      gap = (qt.open / qt.prevClose - 1) * 100;
    }
    if (qt && qt.date) out.asOf = `${qt.date} ${qt.time}`;
    const dec = decide(s, gap == null ? 0 : gap);
    out.indices.push({ key: s.key, name: s.name, state: { retT: s.retT, amtRatio: s.amtRatio }, gap, status, decision: dec });
    if (status === 'stale') out.stale = true;
  }
  // 汇总：取上证（或第一个）作为主口径
  const main = out.indices.find((x) => x.key === 'sh') ?? out.indices[0];
  out.summary = main ? { name: main.name, action: main.decision.action.label, gap: main.gap } : null;
  // 顶层状态聚合：任一 stale 即 stale；全部 preopen 才 preopen；否则 live
  const sts = out.indices.map((x) => x.status);
  out.status = sts.includes('stale') ? 'stale' : sts.length && sts.every((x) => x === 'preopen') ? 'preopen' : 'live';
  out.stale = out.status === 'stale';

  // 全球背景 + 跳空预判（失败不影响主信号）
  try {
    const gq = await globalQuotes();
    out.global = { quotes: gq, forecast: forecastGap(gq) };
  } catch (e) {
    out.global = { error: String(e.message || e) };
  }

  cache = { at: Date.now(), payload: out };
  return out;
}

function lanIPs() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 手机触发更新
// ---------------------------------------------------------------------------
// 两个必要的限制：
//   1) 只接受**内网来源**。这个接口会在电脑上跑一条完整流水线（几十秒），
//      端口又绑在 0.0.0.0 上，所以必须挡住公网来源。判断依据是 TCP 对端地址，
//      不是 Host 头（Host 可以随便伪造）。
//   2) 必须带自定义头 X-Astock-Update。跨站表单/图片请求带不上自定义头，
//      而带自定义头的跨源 fetch 会触发 CORS 预检 —— 我们不应答预检，
//      浏览器就会拦掉。这样不用引入 token 也能防 CSRF。
const PRIVATE_RE = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
function isPrivate(addr) {
  if (!addr) return false;
  return PRIVATE_RE.test(addr.replace(/^::ffff:/, ''));
}

/** 是否处于 A 股连续竞价时段（用来提示「现在跑会拿到不完整的当日数据」） */
function inTradingHours(now = new Date()) {
  const wd = now.getDay();
  if (wd === 0 || wd === 6) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return (m >= 9 * 60 + 30 && m < 11 * 60 + 30) || (m >= 13 * 60 && m < 15 * 60);
}

let job = null; // { startedAt, endedAt, code, err }

function tailOf(file, n) {
  try {
    const t = readFileSync(file, 'utf8');
    return t.split('\n').filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
}

function startUpdate() {
  if (job && !job.endedAt) return { started: false, reason: 'running' };
  if (job?.endedAt && Date.now() - job.endedAt < 3000) {
    // 刚跑完，防抖：避免连点两次又立刻重跑
    return { started: false, reason: 'just-finished' };
  }
  // stdio 用文件描述符而不是 'pipe'：一来日更耗时几十秒，管道缓冲区会把它挂住；
  // 二来这个进程在受限沙箱里跑时，spawn 管道会 EPERM。写文件最稳，还能让前端 tail 进度。
  let fd;
  try {
    fd = openSync(RUN_LOG, 'w');
  } catch (e) {
    return { started: false, reason: 'log-open-failed', error: String(e.message) };
  }
  let proc;
  try {
    // UPDATE_SCRIPT 是留给测试的接缝：默认跑真正的日更；测试时指向一个假脚本，
    // 免得只为验证接口就在交易时段真跑一遍流水线（那会写出半截的当日数据）。
    const script = process.env.UPDATE_SCRIPT || 'daily-update.mjs';
    proc = spawn(process.execPath, [script], {
      cwd: HERE,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
  } finally {
    closeSync(fd); // 子进程已经继承，父进程这份要关掉
  }
  const j = { startedAt: Date.now(), endedAt: null, code: null, pid: proc.pid };
  job = j;
  proc.on('exit', (code) => { j.endedAt = Date.now(); j.code = code; });
  proc.on('error', (e) => { j.endedAt = Date.now(); j.code = -1; j.err = String(e.message); });
  console.log(`[update] 已启动日更 pid=${proc.pid}`);
  return { started: true, pid: proc.pid };
}

function updateStatus() {
  const j = job;
  // 没有 job 就不回日志：update-run.log 是上一次的残留，进程刚重启时读它会把
  // 上一回的进度显示成当前进度（状态是 idle、日志却是旧内容）。
  const tail = j ? tailOf(RUN_LOG, 14) : [];
  // 进度按「已报告的步骤行」计数（✓ 和 ✗ 都算）——失败的那步也是走完了才知道失败。
  // 但要单独暴露失败数，否则失败时进度条看着像正常推进。
  const stepLines = tail.filter((l) => /^  [✓✗–] /.test(l));
  const done = stepLines.length;
  const failedSteps = stepLines.filter((l) => /^  ✗ /.test(l)).length;
  const last = tail.filter((l) => l.trim()).at(-1) ?? '';
  return {
    state: !j ? 'idle' : j.endedAt ? (j.code === 0 ? 'done' : 'failed') : 'running',
    startedAt: j?.startedAt ?? null,
    endedAt: j?.endedAt ?? null,
    elapsedMs: j ? (j.endedAt ?? Date.now()) - j.startedAt : 0,
    exitCode: j?.code ?? null,
    error: j?.err ?? null,
    tradingHours: inTradingHours(),
    stepsDone: done,
    stepsFailed: failedSteps,
    stepsTotal: 11,
    current: last.replace(/^\s+/, '').slice(0, 120),
    tail,
  };
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const remote = req.socket.remoteAddress ?? '';

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (url === '/update-status') {
    if (!isPrivate(remote)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '仅限内网访问' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(updateStatus()));
    return;
  }

  if (url === '/update') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请用 POST' }));
      return;
    }
    if (!isPrivate(remote)) {
      console.log(`[update] 拒绝非内网来源 ${remote}`);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '仅限内网访问' }));
      return;
    }
    if (req.headers['x-astock-update'] !== '1') {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '缺少 X-Astock-Update 头（防跨站触发）' }));
      return;
    }
    const r = startUpdate();
    res.writeHead(r.started ? 202 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...r, status: updateStatus() }));
    return;
  }

  if (url === '/signal') {
    buildSignal()
      .then((payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      })
      .catch((e) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      });
    return;
  }

  // 只允许白名单路径（看板本体 + PWA 资源）
  const PWA = {
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
    '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  };
  if (PWA[url]) {
    const [name, type] = PWA[url];
    const p = join(HERE, name);
    if (!existsSync(p)) { res.writeHead(404); res.end('404'); return; }
    const buf = readFileSync(p);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'Content-Length': buf.length, 'Service-Worker-Allowed': '/' });
    res.end(buf);
    return;
  }
  if (url !== '/' && url !== '/astock-dashboard.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }

  if (!existsSync(FILE)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('看板尚未生成，请先运行 node daily-update.mjs');
    return;
  }

  try {
    const html = readFileSync(FILE);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', // 日更后刷新即见最新
      'Content-Length': html.length,
    });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`读取失败: ${e.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`看板服务已启动（绑 ${HOST}:${PORT}）`);
  console.log('手机访问地址（需与电脑同一 Wi-Fi）:');
  for (const ip of lanIPs()) console.log(`  http://${ip}:${PORT}/`);
  console.log(`本机自测: http://127.0.0.1:${PORT}/`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
