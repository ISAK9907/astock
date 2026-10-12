// 「持仓计划台」渲染层。数据来自 build-plan.mjs 内联的 window.PLAN（plan-analysis.mjs 产出）。
//
// 设计原则（和日更看板刻意相反）：
//   · 不回答「今天发生了什么」，只回答「我现在该不该动」
//   · 不给点位预测、不给买卖信号，只给**区间位置**和**流程检查项**
//   · 阶段标签是**描述**不是信号：它带 10 个交易日迟滞，变化速度匹配「一周看几次」
//   · 页面所有数字都可以被独立复算（分位/区间），没有黑箱评分
(function () {
  const P = window.PLAN;
  if (!P) return;
  const byId = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** 分位 → 颜色：<30 便宜（冷绿）· 30~70 中性 · >70 贵（暖橙） */
  const bandColor = (v) => (v == null ? '#5b6472' : v <= 30 ? '#2f9e6b' : v >= 70 ? '#e0803a' : '#5b8def');
  const bandName = (v) => (v == null ? '无数据' : v <= 30 ? '便宜区' : v >= 70 ? '偏贵区' : '中性区');

  /** 分位条：三段底色 + 当前位置游标 */
  function pctBar(label, v, note) {
    if (v == null) return `<div class="barrow"><span class="bl">${esc(label)}</span><div class="bar empty"><i>无数据</i></div><span class="bv">—</span></div>`;
    const c = bandColor(v);
    return (
      `<div class="barrow"><span class="bl">${esc(label)}</span>` +
      `<div class="bar"><span class="z z1"></span><span class="z z2"></span><span class="z z3"></span>` +
      `<span class="curl" style="left:${v}%;background:${c}"></span></div>` +
      `<span class="bv" style="color:${c}">${v}%</span></div>` +
      (note ? `<div class="barnote">${esc(note)}</div>` : '')
    );
  }

  // ---------------- 顶部总览 ----------------
  const m = P.currentMonth;
  const earn = P.earnings?.[String(m)];
  byId('ptop').innerHTML =
    `<div class="tkline">数据截至 <b>${esc(P.today)}</b> · 标的 ${P.indexes.length} 个 · 分位窗口为各指数 PE 可得区间</div>`;

  // ---------------- 估值区间 ----------------
  byId('pval').innerHTML = P.indexes
    .map((x) => {
      const d = x.div;
      const divCls = !d ? '' : d.kind === 'priceLowPeHigh' ? 'warn' : d.kind === 'priceHighPeLow' ? 'good' : 'flat';
      const divIcon = !d ? '' : d.kind === 'priceLowPeHigh' ? '⚠️' : d.kind === 'priceHighPeLow' ? '✓' : '＝';
      return (
        `<div class="card">` +
        `<div class="chead"><span class="cname">${esc(x.name)}</span><span class="ctag">${esc(x.tag)}</span>` +
        `<span class="cnum">${x.last.c.toFixed(2)}</span>` +
        `<span class="cpe">PE ${x.last.pe == null ? '—' : x.last.pe.toFixed(2)}</span></div>` +
        pctBar('价格分位', x.pct.priceCommon, `窗口 ${x.peWindow.start} ~ ${x.peWindow.end}（${x.peWindow.priceN} 天）`) +
        pctBar('估值分位', x.pct.pe, `PE 区间 ${x.peRange.min} ~ ${x.peRange.max}，中位 ${x.peRange.med}（n=${x.peWindow.n}）`) +
        (d ? `<div class="div ${divCls}">${divIcon} ${esc(d.text)}（差 ${d.gap > 0 ? '+' : ''}${d.gap}pp）</div>` : '') +
        `<div class="cfoot">长期位置：全历史价格分位 <b>${x.pct.priceFull}%</b>（n=${x.pct.fullN}） · ` +
        `阶段 <b>${esc(x.phase.label)}</b> 已持续 ${x.phase.labelDays} 天` +
        (x.phase.raw !== x.phase.label ? `（原始状态已变为「${esc(x.phase.raw)}」，未满 ${P.hyst} 天未确认）` : '') +
        `</div></div>`
      );
    })
    .join('');

  // ---------------- 阶段标签说明 ----------------
  byId('pphase').innerHTML =
    `<div class="hintbox">` +
    `<b>先看这条再读上面的标签</b>：我用 16 年数据检验过「弱势下跌 / 支撑 / 反转 / 上升」这套划分，` +
    `<b>它没有稳定的预测能力</b> —— 上证与中证2000 给出相反答案（上证「支撑」最差、中证2000「支撑」最好），` +
    `而且几乎每一格在前半段/后半段之间翻号。所以它是<b>标签，不是信号</b>。<br>` +
    `它的唯一用途是触发一次<b>不需要预测的检查</b>：处于「弱势下跌」时按档位加仓之前，先回答「当初买它的理由还成立吗」。` +
    `这是防止「机械补仓补到基本面已经坏掉的东西上」——你提的季报暴雷真正伤人的方式。<br>` +
    `<span class="dim">标签要求原始状态连续成立 ≥ ${P.hyst} 个交易日才切换：原始状态中位只持续 3~5 天，` +
    `若不迟滞，你一周看几次，看到的永远是已经过期的状态。</span></div>`;

  // ---------------- 日历 ----------------
  const cur = P.indexes[0] ? P.seasonality[P.indexes[0].code] : null;
  const monthRows = [];
  for (let mm = 1; mm <= 12; mm++) {
    const cell = [];
    let anyN = 0;
    for (const x of P.indexes) {
      const mo = P.seasonality[x.code]?.months?.[mm - 1];
      if (!mo?.n) { cell.push('—'); continue; }
      anyN = Math.max(anyN, mo.n);
      const neg = mo.med < 0;
      cell.push(`<span class="${neg ? 'neg' : 'pos'}">${mo.med >= 0 ? '+' : ''}${mo.med}%</span>`);
    }
    monthRows.push(
      `<tr class="${mm === m ? 'cur' : ''}"><td>${mm} 月${P.earnings?.[String(mm)] ? ' <span class="star">★</span>' : ''}</td><td>${cell.join(' / ')}</td><td>${anyN ? anyN + ' 年' : '—'}</td></tr>`,
    );
  }
  byId('pcal').innerHTML =
    `<div class="curmon">当前 ${m} 月${earn ? ` · <b class="star">★ ${esc(earn)}</b>` : ''}</div>` +
    `<table class="mtbl"><tr><th>月份</th><th>各标的中位数（当月开→当月收）</th><th>样本</th></tr>${monthRows.join('')}</table>` +
    `<div class="hintbox">` +
    `<b>★ = 法定财报截止月</b>（4/30 年报+一季报、8/31 中报、10/31 三季报）。` +
    `但要先说清楚：<b>「暴雷集中在截止日」在指数层面不成立</b> —— 我测过各月最后 5 个交易日，` +
    `财报截止月 +0.15%、其他 9 个月 +0.04%，几乎没差别。指数有几千只股票互相分散。<br>` +
    `<b>⚠️ 但如果你拿的是个股，这个数据对你完全不适用</b>：少数几只股票的财报风险是<b>不分散的</b>。` +
    `所以日历对 ETF 是背景倾向，<b>对个股是硬提醒</b>。<br>` +
    `<span class="dim">另注意 12 月–1 月：中证2000 的 12 月胜率只有 33%、中位数 −3.13%，而同期上证 +0.31% ——` +
    `这不是季节性，是<b>风格切换</b>（年末机构排名/估值切换，大盘稳、小盘杀）。如果你的标的偏小盘，这个比 4 月危险。<br>` +
    `还有多重比较问题：这里同时看了 12 个月，按 Bonferroni 要 p&lt;0.0036 才算得住，月度数 n≈13~16 基本都到不了。` +
    `<b>所以整张表只能当背景倾向，不能当买卖信号。</b></span></div>`;

  // ---------------- 持仓（预留） ----------------
  byId('phold').innerHTML =
    `<div class="hintbox">` +
    `<b>这一区先留空</b>。按你的选择，持仓数据还没接。<br>` +
    `定好的方案是：<b>不存「你现在持有什么」，而存「你买了什么」</b> —— ` +
    `导入交割单 CSV，由成交记录算出持仓与成本。理由：成交记录是原始凭证、可以和券商对账单逐笔核对；` +
    `持仓是它的函数、可复算。手填一个持仓数一旦哪天改错，后面所有判断都建立在一个错数字上，而你自己发现不了。<br>` +
    `<b>⚠️ 数据隔离</b>：这个页面部署在<b>公开仓库</b>上，所以持仓<b>只会存在你这台设备的浏览器里</b>` +
    `（localStorage，键名 <code>astock.holdings.v1</code>），仓库里只有工具代码，一个字节的持仓都不会上行。` +
    `代价是换设备/清缓存会丢，需要导出备份 —— 这个导出功能会和持仓一起做。` +
    `</div>`;
})();
