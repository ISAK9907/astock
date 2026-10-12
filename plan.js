// 「持仓计划台」渲染层。数据来自 build-plan.mjs 内联的 window.PLAN。
//
// 页面按**收盘后的使用顺序**排，不按信息量：
//   ① 明日操作 —— 打开就看这一段：要不要动、动就动在什么价位
//   ② 必须逐条回答的检查项
//   ③ ETF 一览（含加减仓价格线，一张表）
//   ④ 我的持仓（截图上传）
//   ⑤ 执行记录（我做了什么 → 记一笔，形成闭环）
//   ⑥ 日历 / 规则说明
//
// 设计原则：不回答「今天发生了什么」，只回答「我明天该不该动」。不给点位预测。
(function () {
  const P = window.PLAN;
  if (!P) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const D = P.discipline;
  const A = P.action;
  const m = P.currentMonth;
  const pctTxt = (v) => `${v >= 0 ? '+' : ''}${v}%`;

  // ---------------- ① 明日操作（最醒目） ----------------
  const todo = A.todo ?? [];
  const verdict = todo.length
    ? {
        color: '#2f9e6b',
        big: '明天需要操作',
        sub: todo.map((t) => (t.hitAdd > 0 ? `${t.name} 第 ${t.tier} 档加仓已触发` : `${t.name} 第 ${t.cutTier} 档减仓已触发`)).join('；'),
      }
    : {
        color: '#5b8def',
        big: '明天不需要操作',
        sub: A.closest
          ? `最近的一条加仓线还差 ${Math.abs(A.closest.pct)}%：${A.closest.name} @ ${A.closest.price}（第 ${A.closest.tier} 档）`
          : '没有可执行的线',
      };

  const lineCell = (a) => {
    // ⚠️ 字段名是 deepestHitTier / deepestHitCutTier。写成 tier 会渲染出「第 undefined 档」——
    //    这个 bug 在两个文件里各犯了一次（分析层和渲染层），测试是靠扫 undefined 抓到的。
    const add = a.hitAdd > 0
      ? `<b style="color:#2f9e6b">✓ 第 ${a.deepestHitTier} 档已触发</b>${a.nextAdd ? `<br><span class="dim">下档 @${a.nextAdd.price}（${pctTxt(a.nextAdd.pct)}）</span>` : ''}`
      : a.nextAdd
        ? `<span class="dim">第 ${a.nextAdd.tier} 档 @${a.nextAdd.price}</span><br><span class="dim">还差 ${pctTxt(a.nextAdd.pct)}</span>`
        : '—';
    const cut = a.hitCut > 0
      ? `<b style="color:#e0803a">✓ 第 ${a.deepestHitCutTier} 档已触发</b>`
      : a.nextCut
        ? `<span class="dim">@${a.nextCut.price}</span><br><span class="dim">${pctTxt(a.nextCut.pct)}</span>`
        : '—';
    return { add, cut };
  };

  $('pAction').innerHTML =
    `<div class="perm" style="border-color:${verdict.color}">` +
    `<div class="permk" style="color:${verdict.color}">收盘后看这里 · 数据截至 ${esc(P.today)}</div>` +
    `<div class="permt" style="color:${verdict.color}">${verdict.big}</div>` +
    `<div class="permd">${esc(verdict.sub)}</div>` +
    `<div class="permnote">${esc(D.permission.title)} —— ${esc(D.permission.detail)}</div>` +
    `</div>` +
    `<table class="etf" style="margin-top:12px"><tr><th>标的</th><th>现价</th><th>PE分位</th><th>加仓线</th><th>减仓线</th></tr>` +
    A.active
      .map((a) => {
        const c = lineCell(a);
        const z = a.pePct <= P.rules.zoneCheap ? '#2f9e6b' : a.pePct >= P.rules.zoneRich ? '#e0803a' : 'var(--fg)';
        return `<tr><td><b>${esc(a.name)}</b></td><td class="num">${a.price.toFixed(1)}</td><td class="num" style="color:${z}">${a.pePct}%</td><td class="linec">${c.add}</td><td class="linec">${c.cut}</td></tr>`;
      })
      .join('') +
    `</table>` +
    `<div class="dim" style="margin-top:6px;font-size:11px;line-height:1.75">
      <b>价格线怎么来的</b>：隐含价 = 现价 × (目标分位的 PE ÷ 当前 PE)。含义是「假设盈利不变，估值回到历史上第 N 分位时的价格」——
      所以它会随盈利变化自己移动，不会像固定价格那样过两年就失效。<br>
      加仓档 = PE 分位 ${P.rules.addTiers.join(' / ')}%（第 1 档最浅，越跌越买，每档等额）；减仓档 = PE 分位 ${P.rules.cutTiers.join(' / ')}%。<br>
      ⚠️ 档线是<b>触发价</b>：价格跌到它才执行。所以「已触发」的档，触发价往往<b>高于</b>现价 —— 那是已经跌穿的意思。
    </div>`;

  // ---------------- ② 检查清单 ----------------
  const icon = { act: '▶', wait: '■', check: '？', warn: '⚠' };
  $('pCheck').innerHTML =
    D.checklist.map((c) => `<div class="chk ${c.kind}"><span class="chki">${icon[c.kind] ?? '·'}</span><span>${esc(c.text)}</span></div>`).join('') +
    `<div class="dim" style="margin-top:8px;font-size:11.5px">清单来自你预先定下的规则；工具只负责执行和提醒，不判断规则对不对。</div>`;

  // ---------------- ③ ETF 估值一览（压缩） ----------------
  // 自相矛盾修掉的痕迹留在这里：档位只看 PE 分位，价格分位只用来提示分歧。
  const mini = (v) => {
    if (v == null) return '<span class="dim">—</span>';
    const c = v <= 30 ? '#2f9e6b' : v >= 70 ? '#e0803a' : '#5b8def';
    return `<span class="mb"><i style="left:${v}%"></i></span><b style="color:${c}">${v}</b>`;
  };
  const zname = { cheap: '便宜', mid: '中性', rich: '偏贵', unknown: '—' };
  const zcolor = { cheap: '#2f9e6b', mid: '#5b8def', rich: '#e0803a', unknown: '#5b6472' };
  $('pTable').innerHTML =
    `<table class="etf"><tr><th>标的</th><th>PE分位</th><th>价格分位</th><th>档位</th></tr>` +
    P.indexes
      .map((x, i) => {
        const z = x.zone ?? 'unknown';
        return (
          `<tr class="etfr" data-i="${i}"><td><b>${esc(x.name)}</b><span class="dim tag">${esc(x.tag)}</span></td>` +
          `<td class="pctc">${mini(x.pct.pe)}</td><td class="pctc">${mini(x.pct.priceCommon)}</td>` +
          `<td><span class="zb" style="color:${zcolor[z]};border-color:${zcolor[z]}">${zname[z]}</span></td></tr>` +
          `<tr class="etfd" data-d="${i}" hidden><td colspan="4"><div class="dim" style="line-height:1.85">` +
          `PE <b>${x.last.pe?.toFixed(2) ?? '—'}</b>（区间 ${x.peRange.min}~${x.peRange.max}，中位 ${x.peRange.med}）· 窗口 ${x.peWindow.start}~${x.peWindow.end}（PE 样本 ${x.peWindow.n} 天）<br>` +
          `全历史价格分位 <b>${x.pct.priceFull}%</b>（n=${x.pct.fullN}）` +
          (x.div ? `<br><span style="color:${x.div.kind === 'priceLowPeHigh' ? '#e0803a' : x.div.kind === 'priceHighPeLow' ? '#2f9e6b' : 'var(--dim)'}">${esc(x.div.text)}（差 ${x.div.gap > 0 ? '+' : ''}${x.div.gap}pp）</span>` : '') +
          `</div></td></tr>`
        );
      })
      .join('') +
    `</table>` +
    `<div class="dim" style="margin-top:6px;font-size:11px;line-height:1.75">
      <b>两个分位必须一起看</b>，但<b>只有一个决定贵贱</b>：档位只看 <b>PE 分位</b>。<br>
      价格分位高 + PE 分位低 = 涨的是盈利，<b>不是贵</b>（这正是下面「分歧」要说的）；
      价格分位低 + PE 分位高 = 盈利在恶化，⚠️ 价值陷阱。
    </div>`;

  for (const r of document.querySelectorAll('.etfr')) {
    r.addEventListener('click', () => {
      const d = document.querySelector(`.etfd[data-d="${r.dataset.i}"]`);
      if (d) d.hidden = !d.hidden;
    });
  }

  // ---------------- ⑥ 日历 ----------------
  const months = [];
  for (let mm = 1; mm <= 12; mm++) {
    const cells = P.indexes.map((x) => {
      const mo = P.seasonality[x.code]?.months?.[mm - 1];
      return mo?.n ? `<i class="${mo.med < 0 ? 'neg' : 'pos'}">${mo.med >= 0 ? '+' : ''}${mo.med}</i>` : '<i class="dim">—</i>';
    });
    months.push(`<tr class="${mm === m ? 'cur' : ''}"><td>${mm}${P.earnings?.[String(mm)] ? '<span class="star">★</span>' : ''}</td><td class="mcells">${cells.join('')}</td></tr>`);
  }
  $('pCal').innerHTML =
    `<div class="curmon">当前 <b>${m}</b> 月${P.earnings?.[String(m)] ? ` · <span class="star">★ ${esc(P.earnings[String(m)])}</span>` : ''}</div>` +
    `<table class="mtbl"><tr><th>月</th><th>${P.indexes.map((x) => x.name.replace('指数', '').replace('中证', '')).join(' / ')}</th></tr>${months.join('')}</table>` +
    `<div class="dim" style="margin-top:6px;font-size:11px;line-height:1.75">
      当月开→当月收的中位数（%）。★ = 法定财报截止月。<br>
      <b>指数层面看不出月末暴雷效应</b>（各月最后 5 个交易日：财报截止月 +0.15%、其他 9 个月 +0.04%，几乎没差别），
      但<b>个股的财报风险是不分散的</b> —— 日历对 ETF 只是背景倾向，对个股是硬提醒。<br>
      ⚠️ 同时看 12 个月存在多重比较（Bonferroni 门槛 p&lt;0.0036，月度数 n≈13~16 基本都到不了），<b>这张表不能当买卖信号</b>。
    </div>`;

  // ---------------- ⑦ 规则说明 ----------------
  $('pWhy').innerHTML =
    `<details><summary>规则阈值（可改）与口径</summary><div class="hintbox" style="margin-top:8px;line-height:1.85">` +
    `<b>档位</b>：PE 分位 ≤ ${P.rules.zoneCheap}% = 便宜；≥ ${P.rules.zoneRich}% = 偏贵；其余中性。<br>` +
    `<b>加仓档</b>：PE 分位 ${P.rules.addTiers.join(' / ')}%，每档等额，越跌越买。<br>` +
    `<b>减仓档</b>：PE 分位 ${P.rules.cutTiers.join(' / ')}%。<br>` +
    `<b>分歧阈值</b>：两个分位差 ≥ ${P.rules.divGap}pp 算分歧。<br>` +
    `<b>临近提示</b>：距现价 ${P.rules.nearPct}% 以内。<br>` +
    `<b>集中度纪律</b>（在「我的持仓」里算）：单一标的 ≤ 30%、单一赛道 ≤ 40%（占持仓市值）。<br><br>` +
    `<b>为什么个股只做集中度、不做估值价格线</b>：这几只是<b>周期股</b>（电子特气跟半导体资本开支、锂跟碳酸锂价格），` +
    `它们的 PE 是<b>反的</b> —— 盈利崩塌时 PE 反而高、景气顶点 PE 反而低。拿「PE 分位越低越便宜」去套会把周期读反。` +
    `而<b>集中度是纯算术</b>，不依赖任何估值口径，也不依赖预测。<br><br>` +
    `这些数是你自己定的纪律，不是我的判断。工具只负责执行和提醒 —— 临场改主意正是要防的东西。<br><br>` +
    `<b>⚠️ 一个已修掉的自相矛盾（留个记录）</b>：早先的规则是「贵 = PE ≥ 70 <b>或</b> 价格 ≥ 85」，
    结果中证红利被同时判成「偏贵」（价格分位 87%）和「健康上涨」（PE 分位 40%，价格高是盈利驱动）—— 同一页两边打架。
    根因是把「价格高」当成了贵的证据。<b>价格高但 PE 低不是贵，是盈利变好了。</b>现在档位只看 PE 分位。
    </div></details>`;
})();
