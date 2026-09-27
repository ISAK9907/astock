// 手机查看看板用的极简静态服务器（零依赖）
// 只暴露看板 HTML 本身，不开放工作区其他文件。
// 另提供 /signal：开盘后返回实时集合竞价跳空 + 盘前信号（同源，浏览器可直接取）。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { TH, decide } from './signal.mjs';
import { globalQuotes, forecastGap } from './global-quote.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'astock-dashboard.html');
const STATE = join(HERE, 'signal-state.json');
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

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
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
