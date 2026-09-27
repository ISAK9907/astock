# 实时信号接口（Cloudflare Worker）

看板的「明日开盘应对」面板需要在**服务端**抓实时行情（新浪集合竞价 + 东财全球行情）——
浏览器直接抓会被 CORS 挡。原来这份逻辑只存在于本机的 `serve-dashboard.mjs`，
于是「实时竞价」这件事就绑死在「你的电脑得开着、而且只能局域网访问」。

这个 Worker 把那一层搬到边缘，**不依赖任何本机进程**。

## 为什么不能只改前端

`/signal` 并不是简单转发：

- 要用 `signal-state.json`（T 日状态）和当日实时行情做一致性与新鲜度判断
- 要跑 `signal.mjs` 的判定规则（T 日状态 × 竞价跳空 → 建议）
- 要跑 `global-quote.mjs` 的全球背景与跳空预判

所以判定逻辑必须跟着上云。为了**不出现第二份实现**（这个项目已经因为「两处各写一份公式」
栽过一次），`build-worker.mjs` 直接从 `signal.mjs` / `global-quote.mjs` 生成，
Worker 里没有手抄的副本。

## 文件

| 文件 | 作用 |
|---|---|
| `handler.js` | Worker 入口（`/signal`、`/health`、CORS），手动维护 |
| `signal-worker.js` | **自动生成**，不要手改 |
| `wrangler.toml` | 部署配置 |

## 部署

```bash
# 1. 生成 Worker（会把当日 signal-state.json 内联进去）
node build-worker.mjs

# 2. 登录 Cloudflare（只需一次，浏览器里点授权）
cd worker && npx wrangler login

# 3. 部署
npx wrangler deploy
```

部署成功后会打印一个地址，形如：

```
https://astock-signal.<你的子域>.workers.dev
```

## 接到看板上

把这个地址（不带 `/signal`）写进项目根目录的 `worker-url.txt`：

```
https://astock-signal.xxxx.workers.dev
```

然后：

```bash
node build-dashboard.mjs     # 会把地址注入 window.SIGNAL_URL
node deploy-pages.mjs        # 重新部署看板
```

前端逻辑：`signal.js` 取 `window.SIGNAL_URL || '/signal'` ——
所以**本机跑 `serve-dashboard.mjs` 时仍然走同源 `/signal`**（不受影响），
只有在 GitHub Pages 上才回落到 Worker。`worker-url.txt` 留空则两边都用同源。

## 验证

```bash
# 本地回放测试（用真实抓下来的上游响应做夹具，覆盖 preopen/live/stale/上游失败/CORS 预检）
node .shot/test-worker.mjs

# 部署后线上自测
curl https://astock-signal.<你的子域>.workers.dev/health
curl https://astock-signal.<你的子域>.workers.dev/signal
```

## 注意

- Worker 内的 `signal-state.json` 是**构建时快照**。T 日状态每个交易日都会变，
  所以**日更后需要重新 `build-worker.mjs` + `wrangler deploy`**，否则 Worker 里的
  T 日状态会过期 —— 此时它会返回 `status: "stale"`（这是设计好的：前端会显示「状态文件过期」
  而不是拿旧状态硬算）。
- 免费额度 10 万请求/天，单次响应约 2 KB，体积上限 1 MB（当前约 16 KB）。
- 上游失败时返回 `200 + {error}`，前端按「拿不到实时数据」降级为静态条件清单。

## 让日更自动重建并部署

Worker 包内联了当日的 `signal-state.json`，所以日更后必须重建，否则 Worker 里的 T 日状态会过期。
`daily-update.mjs` 已经接好了这段，但**默认不部署** —— 需要你手动放一个开关文件：

```bash
# 1. 先手动跑通一次（授权 + 首次部署）
node build-worker.mjs
cd worker && npx wrangler login && npx wrangler deploy

# 2. 建开关，之后每次日更都会自动重建 + 部署
#    （Windows: type nul > worker\deploy.enabled）
touch worker/deploy.enabled
```

开关的作用是防止「还没登录 Cloudflare 就每天尝试部署、每天失败」。想临时关掉用 `node daily-update.mjs --no-worker`。
