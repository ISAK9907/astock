// 把 signal.mjs + global-quote.mjs + signal-state.json + worker/handler.js
// 拼成一个自包含的 Cloudflare Worker（worker/signal-worker.js）。
//
// 为什么要这个脚本：项目没有 bundler，而 Workers 没有文件系统 —— signal-state.json 必须内联。
// 又不想把 signal 的判定逻辑在 Worker 里再抄一份（这个项目已经因为「两处各写一份公式」
// 栽过一次：analyze-dt 与 sentiment-backtest 的 sent 算法漂移）。所以从同一份源码生成。
//
// 前提（已验证）：signal.mjs 与 global-quote.mjs 都**没有自己的 import**，只有顶层 export，
// 因此「去掉 export 前缀后顺序拼接」是可靠的。脚本会检查这个前提，不满足就直接报错退出。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const strip = (file) => {
  const src = readFileSync(file, 'utf8');
  // 前提校验：不能有 import（拼接后会失效），也不能有 export default
  const bad = src.match(/^\s*import\s/m);
  if (bad) throw new Error(`${file} 含有 import，不能直接拼接 —— 需要先改打包方式`);
  if (/^\s*export\s+default\s/m.test(src)) throw new Error(`${file} 含有 export default，无法拼接`);
  // 去掉顶层 export 前缀（export const / export function / export async function）
  return src.replace(/^(\s*)export\s+(const|let|var|function|async function|class)\s/gm, '$1$2 ');
};

const statePath = 'signal-state.json';
if (!existsSync(statePath)) {
  console.error(`✗ 缺少 ${statePath}，先运行 node build-dashboard.mjs`);
  process.exit(1);
}
const state = JSON.parse(readFileSync(statePath, 'utf8'));

const parts = [
  '// ⚠️ 本文件由 build-worker.mjs 自动生成，请勿直接编辑。',
  '// 改判定逻辑请改 signal.mjs / global-quote.mjs；改 Worker 入口请改 worker/handler.js。',
  `// 生成时间：${new Date().toISOString()}`,
  `// 内联的状态文件：T=${state.T}（generatedAt=${state.generatedAt ?? '—'}）`,
  '',
  '// ===== signal.mjs =====',
  strip('signal.mjs'),
  '',
  '// ===== global-quote.mjs =====',
  strip('global-quote.mjs'),
  '',
  '// ===== signal-state.json（内联）=====',
  `const STATE = ${JSON.stringify(state)};`,
  '',
  '// ===== worker/handler.js =====',
  readFileSync('worker/handler.js', 'utf8'),
].join('\n');

if (!existsSync('worker')) mkdirSync('worker');
writeFileSync('worker/signal-worker.js', parts, 'utf8');

const kb = (Buffer.byteLength(parts, 'utf8') / 1024).toFixed(1);
console.log(`wrote worker/signal-worker.js  ${kb} KB  （T=${state.T}，${state.states.length} 个指数）`);
console.log(`  压缩后体积上限 1 MB（免费版），当前远低于。`);
