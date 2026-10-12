// 「持仓计划台」渲染层。数据来自 build-plan.mjs 内联的 window.PLAN。
//
// 页面结构是**按纪律优先级排的**，不是按信息量：
//   ① 现在允许做什么（最大字号，一眼看到就够）
//   ② 必须逐条回答的检查项（大号）
//   ③ ETF 一览（**压缩成一张表**，一行一个标的，点开才看细节）
//   ④ 我的持仓（图片上传）
//   ⑤ 日历（紧凑）
//   ⑥ 为什么这套规则这么定（小字，可折叠）
//
// 设计原则（和日更看板刻意相反）：不回答「今天发生了什么」，只回答「我现在该不该动」。
// 不给点位预测、不给买卖信号，只执行预先定好的规则并强制检查。
(function () {
  const P = window.PLAN;
  if (!P) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const D = P.discipline;
  const m = P.currentMonth;

  // ---------------- ① 许可横幅（最大） ----------------
  $('pPerm').innerHTML =
    `<div class="perm" style="border-color:${D.permission.color}">` +
    `<div class="permk" style="color:${D.permission.color}">现在允许做什么</div>` +
    `<div class="permt" style="color:${D.permission.color}">${esc(D.permission.title)}</div>` +
    `<div class="permd">${esc(D.permission.detail)}</div>` +
    `</div>`;

  // ---------------- ② 纪律清单（大号） ----------------
  const icon = { act: '▶', wait: '■', check: '？', warn: '⚠' };
  $('pCheck').innerHTML =
    D.checklist
      .map((c) => `<div class="chk ${c.kind}"><span class="chki">${icon[c.kind] ?? '·'}</span><span>${esc(c.text)}</span></div>`)
      .join('') +
    `<div class="dim" style="margin-top:8px;font-size:11.5px">以上清单来自你预先定下的规则；工具只负责执行和提醒，不判断规则对不对。</div>`;

  // ---------------- ③ ETF 一览（压缩表，点行展开） ----------------
  const zname = { cheap: '便宜', mid: '中性', rich: '偏贵', unknown: '—' };
  const zcolor = { cheap: '#2f9e6b', mid: '#5b8def', rich: '#e0803a', unknown: '#5b6472' };
  const mini = (v) => {
    if (v == null) return '<span class="dim">—</span>';
    const c = v <= 30 ? '#2f9e6b' : v >= 70 ? '#e0803a' : '#5b8def';
    return `<span class="mb"><i style="left:${v}%"></i></span><b style="color:${c}">${v}</b>`;
  };
  $('pTable').innerHTML =
    `<table class="etf"><tr><th>标的</th><th>点位</th><th>价格</th><th>估值</th><th>区间</th></tr>` +
    P.indexes
      .map((x, i) => {
        const z = x.zone ?? 'unknown';
        return (
          `<tr class="etfr" data-i="${i}"><td><b>${esc(x.name)}</b><span class="dim tag">${esc(x.tag)}</span></td>` +
          `<td class="num">${x.last.c.toFixed(1)}</td><td class="pctc">${mini(x.pct.priceCommon)}</td><td class="pctc">${mini(x.pct.pe)}</td>` +
          `<td><span class="zb" style="color:${zcolor[z]};border-color:${zcolor[z]}">${zname[z]}</span></td></tr>` +
          `<tr class="etfd" data-d="${i}" hidden><td colspan="5">` +
          `<div class="dim" style="line-height:1.8">PE <b>${x.last.pe?.toFixed(2) ?? '—'}</b>（区间 ${x.peRange.min}~${x.peRange.max}，中位 ${x.peRange.med}）· 窗口 ${x.peWindow.start}~${x.peWindow.end}（PE 样本 ${x.peWindow.n} 天）<br>` +
          `全历史价格分位 <b>${x.pct.priceFull}%</b>（n=${x.pct.fullN}）· 阶段 <b>${esc(x.phase.label)}</b> 已持续 ${x.phase.labelDays} 天<br>` +
          (x.div ? `<span style="color:${x.div.kind === 'priceLowPeHigh' ? '#e0803a' : x.div.kind === 'priceHighPeLow' ? '#2f9e6b' : 'var(--dim)'}">${esc(x.div.text)}（差 ${x.div.gap > 0 ? '+' : ''}${x.div.gap}pp）</span>` : '') +
          `</div></td></tr>`
        );
      })
      .join('') +
    `</table>` +
    `<div class="dim" style="margin-top:6px;font-size:11px">点任意一行展开细节。分位窗口 = 该指数 PE 可得的区间（两个分位用同一窗口，否则「分歧」是假象）。</div>`;

  for (const r of document.querySelectorAll('.etfr')) {
    r.addEventListener('click', () => {
      const d = document.querySelector(`.etfd[data-d="${r.dataset.i}"]`);
      if (d) d.hidden = !d.hidden;
    });
  }

  // ---------------- ⑤ 日历（紧凑） ----------------
  const months = [];
  for (let mm = 1; mm <= 12; mm++) {
    const cells = P.indexes.map((x) => {
      const mo = P.seasonality[x.code]?.months?.[mm - 1];
      return mo?.n ? `<i class="${mo.med < 0 ? 'neg' : 'pos'}">${mo.med >= 0 ? '+' : ''}${mo.med}</i>` : '<i class="dim">—</i>';
    });
    months.push(
      `<tr class="${mm === m ? 'cur' : ''}"><td>${mm}${P.earnings?.[String(mm)] ? '<span class="star">★</span>' : ''}</td><td class="mcells">${cells.join('')}</td></tr>`,
    );
  }
  $('pCal').innerHTML =
    `<div class="curmon">当前 <b>${m}</b> 月${P.earnings?.[String(m)] ? ` · <span class="star">★ ${esc(P.earnings[String(m)])}</span>` : ''}</div>` +
    `<table class="mtbl"><tr><th>月</th><th>${P.indexes.map((x) => x.name.replace('指数', '').replace('中证', '')).join(' / ')}</th></tr>${months.join('')}</table>` +
    `<div class="dim" style="margin-top:6px;font-size:11px">当月开→当月收的中位数（%）。★ = 法定财报截止月。<b>指数层面看不出月末暴雷效应（已实测），但个股的财报风险是不分散的</b> —— 日历对 ETF 只是背景倾向，对个股是硬提醒。同时看 12 个月存在多重比较，这张表不能当买卖信号。</div>`;

  // ---------------- ⑥ 说明（可折叠） ----------------
  $('pWhy').innerHTML =
    `<details><summary>为什么阶段标签只当「标签」用，不当信号</summary>` +
    `<div class="hintbox" style="margin-top:8px">` +
    `我用 16 年数据检验过「弱势下跌 / 支撑 / 反转 / 上升」这套划分，<b>它没有稳定的预测能力</b>：` +
    `上证与中证2000 给出相反答案（上证「支撑」最差、中证2000「支撑」最好），而且几乎每一格在前半段/后半段之间翻号。` +
    `原始状态中位只持续 3~5 天、每年切换 9 次 —— 你一周看几次，看到的永远是已经过期的状态。` +
    `所以现在它带 <b>${P.hyst} 个交易日迟滞</b>，且只用来触发一次<b>不需要预测的检查</b>：` +
    `处于「弱势下跌」时加仓前先回答「当初买它的理由还成立吗」。` +
    `<br><br><b>规则阈值（可改）</b>：便宜 = PE 与价格分位都 ≤ ${D.rules.cheapPe}%；贵 = PE ≥ ${D.rules.richPe}% 或价格 ≥ ${D.rules.richPrice}%；` +
    `有 ${D.rules.stopCount} 个标的算贵就整体停止加仓。两边都取保守：便宜要两个条件同时满足，贵只要一个条件满足。` +
    `</div></details>`;

  $('pTop').innerHTML = `数据截至 <b>${esc(P.today)}</b> · 标的 ${P.indexes.length} 个 · 分位窗口见各标的细节`;
})();
