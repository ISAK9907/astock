// 生成「持仓计划台」plan.html（单文件，含内联数据与脚本）
//
// 和日更看板的关系：**刻意分开**。看板回答「今天发生了什么」，本页回答「我现在该不该动」。
// 前者的信息密度是特征，后者必须极简 —— 因为使用者不能盯盘，页面上的每一个数字
// 都应该能被独立复算，且不要求他在特定时刻打开。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PLAN = JSON.parse(readFileSync('plan-data.json', 'utf8'));
const planJs = readFileSync('plan.js', 'utf8');
const buildStamp = new Date().toISOString();

const html = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>持仓计划台</title>
<link rel="manifest" href="manifest-plan.webmanifest">
<meta name="theme-color" content="#141821">
<style>
:root{--bg:#0f131a;--card:#171c25;--line:#252c39;--fg:#e6eaf2;--dim:#7b8698;--sect:#39414f}
html[data-theme="light"]{--bg:#f4f6fa;--card:#fff;--line:#e2e7ef;--fg:#1b2330;--dim:#6b7688;--sect:#c9d2e0}
*{box-sizing:border-box}
body{margin:0;padding:12px 12px 40px;background:var(--bg);color:var(--fg);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:17px;margin:4px 0 2px}
h2{font-size:13px;margin:22px 0 8px;padding-left:8px;border-left:3px solid #5b8def;color:var(--fg)}
.tkline{color:var(--dim);font-size:11.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 11px;margin-bottom:9px}
.chead{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;margin-bottom:8px}
.cname{font-weight:700;font-size:14.5px}
.ctag{font-size:10.5px;color:var(--dim);border:1px solid var(--line);border-radius:9px;padding:1px 7px}
.cnum{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600}
.cpe{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}
.barrow{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.bl{font-size:11px;color:var(--dim);width:52px;flex:none}
.bar{position:relative;flex:1;height:9px;border-radius:5px;overflow:hidden}
.bar.empty{background:var(--line)}
.bar.empty i{font-style:normal;font-size:9px;color:var(--dim);padding-left:6px;line-height:9px}
.bar .z{position:absolute;top:0;bottom:0}
.bar .z1{left:0;width:30%;background:rgba(47,158,107,.24)}
.bar .z2{left:30%;width:40%;background:rgba(91,141,239,.16)}
.bar .z3{left:70%;width:30%;background:rgba(224,128,58,.22)}
.curl{position:absolute;top:-2px;width:4px;height:13px;border-radius:2px;transform:translateX(-2px)}
.bv{font-size:11.5px;font-variant-numeric:tabular-nums;width:42px;text-align:right;flex:none;font-weight:600}
.barnote{font-size:10px;color:var(--dim);margin:0 0 6px 59px}
.div{margin-top:7px;font-size:12px;padding:6px 8px;border-radius:7px;line-height:1.55}
.div.good{background:rgba(47,158,107,.12);border-left:2px solid #2f9e6b}
.div.warn{background:rgba(224,128,58,.14);border-left:2px solid #e0803a}
.div.flat{background:rgba(91,141,239,.10);border-left:2px solid #5b8def}
.cfoot{margin-top:7px;font-size:10.5px;color:var(--dim)}
.hintbox{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sect);
  border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.75;color:var(--fg)}
.hintbox b{color:var(--fg)}
.dim{color:var(--dim)}
.curmon{font-size:13px;margin-bottom:7px}
.star{color:#e0803a}
table.mtbl{width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums}
table.mtbl th{color:var(--dim);font-weight:500;text-align:left;padding:4px 5px;border-bottom:1px solid var(--line);font-size:11px}
table.mtbl td{padding:4px 5px;border-bottom:1px solid var(--line)}
table.mtbl tr.cur{background:rgba(91,141,239,.10)}
table.mtbl tr.cur td:first-child{font-weight:700}
.pos{color:#e08a6a}
.neg{color:#4fbf8f}
html[data-theme="light"] .pos{color:#c2410c}
html[data-theme="light"] .neg{color:#0f7a52}
code{background:var(--line);padding:1px 4px;border-radius:3px;font-size:11px}
.topnav{display:flex;gap:8px;margin:6px 0 0;font-size:12px}
.topnav a{color:#5b8def;text-decoration:none}
</style></head><body>
<h1>持仓计划台</h1>
<div class="topnav"><a href="index.html">← 回到日更看板</a></div>
<div id="ptop" class="tkline" style="margin-top:6px"></div>

<h2>估值区间</h2>
<div id="pval"></div>

<h2>阶段标签怎么用（先读这段）</h2>
<div id="pphase"></div>

<h2>日历过滤器</h2>
<div id="pcal"></div>

<h2>持仓（预留）</h2>
<div id="phold"></div>

<script>window.PLAN = ${JSON.stringify(PLAN)};</script>
<script>${planJs}</script>
<script>window.PLAN_BUILD = ${JSON.stringify(buildStamp)};</script>
</body></html>`;

writeFileSync('plan.html', html, 'utf8');
writeFileSync('version-plan.json', JSON.stringify({ generatedAt: buildStamp, kind: 'plan' }), 'utf8');
console.log(`wrote plan.html  ${(html.length / 1024).toFixed(1)} KB  标的 ${PLAN.indexes.length} 个  数据截至 ${PLAN.today}`);
if (!existsSync('manifest-plan.webmanifest')) console.log('  （未找到 manifest-plan.webmanifest，先不影响）');
