// 生成「持仓计划台」plan.html（单文件，含内联数据与脚本）
//
// 页面按**收盘后的使用顺序**排：明日操作 → 检查清单 → ETF 一览 → 持仓 → 执行记录 → 日历 → 规则。
// 和日更看板刻意分开：看板回答「今天发生了什么」，本页回答「我明天该不该动」。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PLAN = JSON.parse(readFileSync('plan-data.json', 'utf8'));
const planJs = readFileSync('plan.js', 'utf8');
const holdJs = readFileSync('plan-holdings.js', 'utf8');
const logJs = readFileSync('plan-log.js', 'utf8');
const gateJs = readFileSync('plan-gate.js', 'utf8');
// 个股闸门数据（analyze-stocks.mjs 生成）。缺失时整块不渲染，不让页面因此崩掉。
const GATE = existsSync('stock-gate.json') ? JSON.parse(readFileSync('stock-gate.json', 'utf8')) : null;
// 价格序列（画曲线+均线用）。**必须裁剪**：全量每只 ×1600 根会让页面涨近 300 KB，
// 而卡片里只看近期趋势，250 根（约一年）足够。按 [日期, 收盘] 的紧凑格式内联。
const CHART_BARS = 250;
const STOCKS = (() => {
  if (!existsSync('stocks.json')) return null;
  try {
    const raw = JSON.parse(readFileSync('stocks.json', 'utf8'));
    const o = {};
    for (const s of Object.values(raw.series)) o[s.name] = s.bars.slice(-CHART_BARS).map((b) => [b.d, b.c]);
    return o;
  } catch { return null; }
})();
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
body{margin:0;padding:14px 12px 48px;background:var(--bg);color:var(--fg);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:18px;margin:2px 0 2px}
h2{font-size:13.5px;margin:22px 0 8px;padding-left:8px;border-left:3px solid #5b8def;color:var(--fg);letter-spacing:.5px}
.topnav{font-size:12px;margin:2px 0 0}
.topnav a{color:#5b8def;text-decoration:none}

/* ① 明日操作 —— 全页最大，目的就是打开一眼看到就够 */
.perm{background:var(--card);border:2px solid;border-radius:12px;padding:14px 15px}
.permk{font-size:11.5px;letter-spacing:1.5px;opacity:.85}
.permt{font-size:27px;font-weight:800;line-height:1.25;margin:4px 0 8px;letter-spacing:.5px}
.permd{font-size:14px;line-height:1.7}
.permnote{margin-top:10px;padding-top:9px;border-top:1px solid var(--line);font-size:12px;color:var(--dim);line-height:1.7}

/* ② 检查清单 */
.chk{display:flex;gap:10px;align-items:flex-start;background:var(--card);border:1px solid var(--line);
  border-radius:9px;padding:11px 12px;margin-bottom:8px;font-size:15px;line-height:1.6}
.chki{flex:none;font-size:14px;width:18px;text-align:center;opacity:.9}
.chk.act{border-left:4px solid #2f9e6b}
.chk.wait{border-left:4px solid #5b8def}
.chk.check{border-left:4px solid #e0b23a}
.chk.warn{border-left:4px solid #e0803a;background:rgba(224,128,58,.10)}

/* 表格（明日操作的价格线表 + ETF 一览共用） */
table.etf{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
table.etf th{color:var(--dim);font-weight:500;text-align:left;padding:5px 4px;border-bottom:1px solid var(--line);font-size:11px}
table.etf td{padding:7px 4px;border-bottom:1px solid var(--line);vertical-align:top}
table.etf tr.etfr{cursor:pointer}
table.etf tr.etfr:active{background:rgba(91,141,239,.08)}
table.etf td.num{text-align:right;font-weight:600}
table.etf td.linec{font-size:11.5px;line-height:1.6}
table.etf .tag{font-size:10px;margin-left:4px}
.mb{position:relative;display:inline-block;width:30px;height:7px;border-radius:4px;overflow:hidden;
  background:linear-gradient(90deg,rgba(47,158,107,.30) 0 30%,rgba(91,141,239,.20) 30% 70%,rgba(224,128,58,.28) 70% 100%);
  vertical-align:middle;margin-right:4px}
.mb i{position:absolute;top:-2px;width:3px;height:11px;background:var(--fg);border-radius:2px;transform:translateX(-1px)}
.zb{font-size:11px;border:1px solid;border-radius:9px;padding:1px 7px;white-space:nowrap}
tr.etfd td{background:rgba(91,141,239,.05)}

/* 日历 */
.curmon{font-size:13px;margin-bottom:8px}
.star{color:#e0803a;margin-left:3px}
table.mtbl{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
table.mtbl th{color:var(--dim);font-weight:500;text-align:left;padding:4px 5px;border-bottom:1px solid var(--line)}
table.mtbl td{padding:4px 5px;border-bottom:1px solid var(--line)}
table.mtbl tr.cur{background:rgba(91,141,239,.10)}
table.mtbl tr.cur td:first-child{font-weight:700}
.mcells i{font-style:normal;display:inline-block;min-width:44px;text-align:right;padding-right:6px}
.pos{color:#e08a6a}.neg{color:#4fbf8f}
html[data-theme="light"] .pos{color:#c2410c}
html[data-theme="light"] .neg{color:#0f7a52}

/* 持仓 / 记录 */
.hbox{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:11px;margin-bottom:9px}
.hbox label.hlb{display:block;font-size:12.5px;margin-bottom:6px;color:var(--fg)}
input[type=file]{font-size:12.5px;color:var(--dim);width:100%}
#holdImg{max-width:100%;border-radius:8px;margin-top:9px;border:1px solid var(--line)}
textarea#holdText{width:100%;min-height:104px;background:var(--bg);color:var(--fg);border:1px solid var(--line);
  border-radius:7px;padding:8px;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;margin-top:8px}
.hbtn{margin-top:9px;background:var(--line);color:var(--fg);border:1px solid var(--line);border-radius:8px;
  padding:8px 14px;font-size:13.5px;font-family:inherit;cursor:pointer}
.hbtn.primary{background:#2f6fe0;border-color:#2f6fe0;color:#fff;font-weight:700;padding:11px 16px;font-size:15px}
.hrow{display:grid;gap:4px;align-items:center;margin-bottom:4px}
.hrow.hhead{font-size:10.5px;color:var(--dim);margin-bottom:2px}
.hrow span{font-size:12px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow input,select.logf{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:5px;
  padding:6px 5px;font-size:12.5px;font-family:inherit;font-variant-numeric:tabular-nums}
.hstat{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;margin-bottom:9px}
.hstat b{font-variant-numeric:tabular-nums}
.hsum{font-size:12px;color:var(--dim);margin:8px 0 4px}
.logform{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.hintbox{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sect);
  border-radius:8px;padding:9px 11px;font-size:12.5px;line-height:1.75}
details summary{cursor:pointer;font-size:12.5px;color:#5b8def;padding:6px 0}
.chkbox{border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.7;margin-bottom:9px}
.chkbox.good{background:rgba(47,158,107,.12);border-left:3px solid #2f9e6b}
.chkbox.bad{background:rgba(224,128,58,.14);border-left:3px solid #e0803a}
.warnbox{background:rgba(224,128,58,.10);border:1px solid var(--line);border-left:3px solid #e0803a}
/* ① 结论横幅的补充行 */
.permnote{margin-top:10px;padding-top:9px;border-top:1px solid var(--line);font-size:12px;color:var(--dim)}
/* 闸门状态灯：颜色就是结论 */
.grow{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-left:4px solid;border-radius:8px;padding:9px 11px;margin-bottom:6px}
.gdot{width:9px;height:9px;border-radius:5px;flex:none}
.gname{font-weight:700;font-size:14px;min-width:66px}
.gbig{font-weight:800;font-size:13px;min-width:44px}
.gtags{display:flex;gap:4px;flex-wrap:wrap}
.gtag{font-size:10.5px;color:var(--dim);border:1px solid var(--line);border-radius:8px;padding:1px 6px;white-space:nowrap}
.gnum{margin-left:auto;font-size:12.5px;font-variant-numeric:tabular-nums;color:var(--dim)}
/* 持仓大卡片 */
.hpcard{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin-bottom:8px}
.hptop{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.hpname{font-weight:700;font-size:15.5px}
.hpmv{font-weight:800;font-size:19px;font-variant-numeric:tabular-nums}
.hpmid{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--dim);margin-top:5px;font-variant-numeric:tabular-nums}
.hpmid b{color:var(--fg);font-size:12.5px}
.hppnl{display:flex;gap:12px;flex-wrap:wrap;font-size:13.5px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums;align-items:baseline}
.hppnl .dim{font-size:11px;font-weight:400}
.hpbar{height:3px;background:var(--line);border-radius:2px;margin-top:8px;overflow:hidden}
.hpbar i{display:block;height:100%;background:#5b8def}
.hphint{font-size:10.5px;color:var(--dim);margin-top:6px}
.hpdetail{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.hpadv{font-size:12.5px;line-height:1.6;padding:7px 9px;border-radius:7px;margin-bottom:8px}
.hpadv.ok{background:rgba(47,158,107,.12);border-left:3px solid #2f9e6b}
.hpadv.no{background:rgba(224,128,58,.13);border-left:3px solid #e0803a}
.hpprice{font-size:11.5px;color:var(--dim);margin-bottom:5px}
.hppr{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;font-variant-numeric:tabular-nums}
.hppr span{color:var(--dim)}
.hpsvg{width:100%;height:150px;display:block;margin-bottom:6px;background:rgba(255,255,255,.02);border-radius:6px}
.hplegend{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--dim);margin-bottom:9px;font-variant-numeric:tabular-nums}
.hplegend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}
.dim{color:var(--dim)}
code{background:var(--line);padding:1px 4px;border-radius:3px;font-size:11px}
</style></head><body>
<h1>持仓计划台</h1>
<div class="topnav"><a href="index.html">← 回到日更看板</a></div>

<h2>① 明日操作（收盘后看这一段就够）</h2>
<div id="pAction"></div>

<h2>② 必须逐条回答</h2>
<div id="pCheck"></div>

<h2>③ 大盘估值参照</h2>
<div class="hintbox" style="margin-bottom:9px;font-size:12px;line-height:1.75">
  ⚠️ <b>这一节不是你持有的标的</b>，是上证/沪深300/中证500/中证2000/科创50/中证红利这 6 个宽基指数的估值分位 ——
  只用来判断<b>大盘现在贵不贵</b>（你可以买指数 ETF，也可以只当背景看）。<br>
  <b>为什么你的个股不在这一节</b>：这几只是周期股（电子特气跟半导体资本开支、锂跟碳酸锂价格），
  它们的 PE 是<b>反的</b> —— 盈利崩塌时 PE 反而高、景气顶点 PE 反而低。拿「PE 分位越低越便宜」去套会把周期读反。
  所以个股只在 ④ 里做<b>集中度与纪律</b>，不做估值价格线。
</div>
<div id="pTable"></div>

<h2>④ 我的持仓</h2>
<div id="holdSync"></div>
<div class="hbox" id="holdSaved"></div>
<div class="hbox">
  <label class="hlb"><b>上传持仓截图</b>（图片只在你手机里本地预览，不会上传到任何服务器）</label>
  <input type="file" id="holdFile" accept="image/*">
  <img id="holdImg" hidden alt="持仓截图预览">
  <div class="dim" id="holdImgHint" hidden style="margin-top:8px;font-size:11.5px;line-height:1.7">
    上图仅供你对照阅读。<b>为什么不做自动 OCR</b>：iOS 实况文本 / 安卓相册文字识别是系统级的，对中文小字体比浏览器里能跑的 OCR 准得多。
    <b>做法</b>：在手机相册里对截图用「提取文字」，把结果贴到下面框里即可。
  </div>
  <textarea id="holdText" placeholder="把手机「提取文字」的结果贴到这里（支持表头列名 / Tab / 逗号 / 多空格分隔，也支持逐条分行的格式）"></textarea>
  <button class="hbtn" id="holdParse" type="button">解析</button>
  <button class="hbtn" id="holdAdd" type="button">手动加一行</button>
  <div class="dim" id="holdParseState" style="margin-top:8px;font-size:12px"></div>
</div>
<div class="hbox" id="holdDraft"></div>
<div class="dim" style="font-size:11.5px;line-height:1.8">
  ⚠️ 解析结果<b>必须逐行确认后再保存</b>。持仓是全部判断的地基，识别错一个数字不会报错，只会静默污染后面所有结论。<br>
  数据只存在<b>你这台设备的浏览器</b>里（<code>astock.holdings.v1</code>），仓库是公开的，持仓一个字节都不会上行。<br>
  截图里的「现价/盈亏」是<b>截图那一刻</b>的值，本页不假装它是实时行情。
</div>

<h2>⑤ 个股闸门（你定的加仓规则）</h2>
<div id="pGate"></div>

<h2>⑥ 执行记录（闭环）</h2>
<div class="hbox">
  <div class="logform">
    <select id="logTarget" class="logf"></select>
    <select id="logAction" class="logf">
      <option value="add">加仓</option>
      <option value="cut">减仓</option>
      <option value="hold">持有不动</option>
    </select>
    <input id="logPrice" class="logf" inputmode="decimal" placeholder="成交价">
    <input id="logQty" class="logf" inputmode="numeric" placeholder="数量">
  </div>
  <input id="logNote" class="logf" style="margin-top:6px" placeholder="备注（可不填）">
  <div id="logJudge" style="margin-top:8px;font-size:12px"></div>
  <button class="hbtn primary" id="logAdd" type="button">记一笔</button>
</div>
<div class="hbox" id="logBox"></div>
<div class="dim" style="font-size:11.5px;line-height:1.8">
  <b>这是整个工具里唯一可能真正改变行为的部分。</b>工具能做的只有两件事：让规则可见并带上日期、记录你有没有遵守。
  没有第五条，工具不知道你做过什么，也就没有任何反馈回路 —— 看完关掉，什么都不留下。<br>
  记录只在本机（<code>astock.exlog.v1</code>），<b>换设备或清缓存会丢，务必用下面的导出按钮备份</b>。
</div>

<h2>⑦ 日历过滤器</h2>
<div id="pCal"></div>

<h2>⑧ 规则说明</h2>
<div id="pWhy"></div>

<script>window.PLAN = ${JSON.stringify(PLAN)};</script>
<script>window.GATE = ${JSON.stringify(GATE)};</script>
<script>window.STOCKS = ${JSON.stringify(STOCKS)};</script>
<script>${planJs}</script>
<script>${holdJs}</script>
<script>${logJs}</script>
<script>${gateJs}</script>
<script>window.PLAN_BUILD = ${JSON.stringify(buildStamp)};</script>
</body></html>`;

writeFileSync('plan.html', html, 'utf8');
writeFileSync('version-plan.json', JSON.stringify({ generatedAt: buildStamp, kind: 'plan' }), 'utf8');
console.log(`wrote plan.html  ${(html.length / 1024).toFixed(1)} KB  标的 ${PLAN.indexes.length}  明日：${PLAN.action.todo.length ? '需要操作' : '不需要'}`);
