// 个股闸门（客户端）：把用户定的规则变成"点加仓时能不能通过"的判定 + 渲染
//
// 数据来源三个，都是**客户端**的（持仓和交易记录只在手机上，不能上行）：
//   window.GATE        ← stock-gate.json（服务端算好的企稳等级），build-plan.mjs 内联
//   astock.holdings.v1 ← 持仓（同步来的或手输的）
//   astock.exlog.v1    ← 执行记录（每笔加仓的日期与价格，用于判"时空"）
//
// 规则全部来自用户 2026-10-13 的原话，见 analyze-stocks.mjs 的注释。这里只负责执行，不解释对错。
(function () {
  const G = window.GATE;
  if (!G) return;
  const R = G.rules;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const HKEY = 'astock.holdings.v1', AKEY = 'astock.acct.v1', LKEY = 'astock.exlog.v1';
  const rd = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || JSON.stringify(d)); } catch { return d; } };

  const SECTOR = { 华特气体: '电子特气', 中船特气: '电子特气', 融捷股份: '锂资源', 中矿资源: '锂资源', 比亚迪: '新能源汽车', 港股互联: '港股互联' };
  const capOf = (name) => (R.maxSingle[name] ?? R.maxSingle.default);

  /** 总资产：优先用账户总览，否则用持仓市值兜底 */
  function assets(holdings, acct) {
    if (acct?.assets) return acct.assets;
    return holdings.reduce((s, h) => s + (h.value ?? (h.price ?? 0) * (h.qty ?? 0)), 0);
  }

  /**
   * 判一次加仓能不能执行。
   * @returns {{ok:boolean, blocked:string[], info:object}}
   * 硬约束（任何企稳等级都不放行）与软条件（企稳/时空）分开列，便于告知"卡在哪一条"。
   */
  function checkAdd(name, amount, holdings, acct, log) {
    const A = assets(holdings, acct);
    const val = (h) => h.value ?? (h.price ?? h.cost ?? 0) * (h.qty ?? 0);
    const mv = holdings.reduce((s, h) => s + val(h), 0);
    const thisV = holdings.filter((h) => h.name === name).reduce((s, h) => s + val(h), 0);
    const sec = SECTOR[name];
    const secV = holdings.filter((h) => SECTOR[h.name] === sec).reduce((s, h) => s + val(h), 0);
    const usedTranches = log.filter((r) => r.action === 'add').length;
    const g = Object.values(G.stocks).find((s) => s.name === name);
    const blocked = [];

    // ---- 硬约束：不参与交换 ----
    if (mv + amount > R.maxTotalPos * A) blocked.push(`总仓位会超过 ${(R.maxTotalPos * 100).toFixed(0)}%（现 ` + (mv / A * 100).toFixed(1) + '%）');
    if (thisV + amount > capOf(name) * A) blocked.push(`${name} 会超过单只上限 ${(capOf(name) * 100).toFixed(0)}%（现 ` + (thisV / A * 100).toFixed(1) + '%）');
    if (sec && secV + amount > R.maxSector * A) blocked.push(`${sec} 赛道会超过 ${(R.maxSector * 100).toFixed(0)}%（现 ` + (secV / A * 100).toFixed(1) + '%）');
    if (usedTranches >= R.tranches) blocked.push(`账户级 ${R.tranches} 档已用完（已执行 ${usedTranches} 次加仓）`);

    // ---- 企稳：无企稳直接不许加 ----
    const soft = [];
    if (!g) blocked.push('没有该标的的闸门数据（stocks.json 里没有）');
    else if (g.level === '无') blocked.push(`企稳「无」—— 仍在创新低或站不上 MA20（已 ${g.streakNoLow} 天不创 20 日新低，需 ${R.stability.弱.minNoLow} 天）`);
    else {
      // 只有企稳等级成立时才谈时空（互相换算：等级决定要求）
      const lastAdd = log.filter((r) => r.action === 'add' && r.target === name).slice(-1)[0];
      const needDays = g.needDays, needGap = g.needGap;
      if (lastAdd) {
        const days = Math.floor((Date.now() - new Date(lastAdd.at).getTime()) / 86400000);
        if (days < needDays) soft.push(`距上次加仓只有 ${days} 天（企稳「${g.level}」要求 ≥ ${needDays} 个自然日的近似值）`);
        const cur = g.last;
        const gap = Math.abs((cur / lastAdd.price - 1) * 100);
        if (gap < needGap) soft.push(`距上次加仓价只差 ${gap.toFixed(1)}%（要求 ≥ ${needGap}%）`);
      }
    }

    const ok = blocked.length === 0 && soft.length === 0;
    return { ok, blocked: [...blocked, ...soft], info: { level: g?.level ?? '—', needDays: g?.needDays, needGap: g?.needGap, usedTranches, mv, A, thisV, secV, sec } };
  }

  /** 把一条拒绝理由压成一个短标签（人眼扫的是颜色+短语，不是整句） */
  function shortReason(s) {
    if (/企稳「无」/.test(s)) return '仍在创新低';
    if (/总仓位/.test(s)) return '总仓位满';
    if (/单只上限/.test(s)) return '单只满';
    if (/赛道/.test(s)) return '赛道满';
    if (/档已用完/.test(s)) return '4档用完';
    if (/距上次加仓只有/.test(s)) return '时间不够';
    if (/距上次加仓价/.test(s)) return '空间不够';
    return s.slice(0, 10);
  }

  function render() {
    const box = $('pGate');
    if (!box) return;
    const holdings = rd(HKEY, []);
    const acct = rd(AKEY, null);
    const log = rd(LKEY, []);
    const A = assets(holdings, acct);
    const tranche = Math.round((A * R.maxTotalPos - (acct?.marketValue ?? holdings.reduce((s, h) => s + (h.value ?? 0), 0))) / R.tranches);
    const used = log.filter((r) => r.action === 'add').length;

    let head =
      `<div class="hintbox" style="margin-bottom:9px;line-height:1.8;font-size:12px">` +
      `<b>加仓闸门</b>（你定的规则，工具只执行）：总仓位 ≤ ${(R.maxTotalPos * 100).toFixed(0)}% · 单只 比亚迪 ${(R.maxSingle.比亚迪 * 100).toFixed(0)}%/其余 ${(R.maxSingle.default * 100).toFixed(0)}% · 赛道 ≤ ${(R.maxSector * 100).toFixed(0)}% · 账户级 ${R.tranches} 档 · 止损只对新买入逐笔 −${(R.stopLoss * 100).toFixed(0)}%<br>` +
      (holdings.length
        ? `可用空间 <b>${Math.max(0, Math.round(A * R.maxTotalPos - (acct?.marketValue ?? holdings.reduce((s, h) => s + (h.value ?? 0), 0)))).toLocaleString('zh-CN')}</b> ÷ ${R.tranches} 档 = <b>每档约 ${tranche.toLocaleString('zh-CN')}</b>　·　已用 <b>${used}/${R.tranches}</b> 档`
        : `<span class="dim">本机还没有持仓 —— 先在下面 ④ 同步或导入，闸门才能算仓位空间</span>`) +
      `</div>`;

    if (!holdings.length) { box.innerHTML = head; return; }

    // 状态灯一行一只：颜色就是结论，短语就是原因。细节折叠，不占视线。
    const rows = Object.values(G.stocks).map((g) => {
      const r = checkAdd(g.name, tranche, holdings, acct, log);
      const ok = r.ok;
      const dot = ok ? '#2f9e6b' : '#e0803a';
      const tags = r.blocked.map(shortReason).map((s) => `<span class="gtag">${esc(s)}</span>`).join('');
      return (
        `<div class="grow" style="border-left-color:${dot}">` +
        `<span class="gdot" style="background:${dot}"></span>` +
        `<span class="gname">${esc(g.name)}</span>` +
        `<span class="gbig" style="color:${ok ? '#2f9e6b' : '#e0803a'}">${ok ? '可加' : '不可加'}</span>` +
        `<span class="gtags">${tags}</span>` +
        `<span class="gnum">${g.last}</span>` +
        `</div>`
      );
    });

    box.innerHTML = head + rows.join('') +
      `<div class="dim" style="font-size:11px;line-height:1.8;margin-top:-2px">` +
      `「企稳」只回答一个问题：<b>能不能在自由落体里补仓</b>。它不预测涨跌 —— ` +
      `我用 MA60 分档验过你这 5 只，华特是均值回归、融捷/中矿是动量，方向相反，均线当不了预测。<br>` +
      `层级换算是「有机结合」的落地方式：企稳强 → 短时间小价差也能加；企稳弱 → 必须拉得更开。` +
      `<b>但仓位硬约束不参与交换</b>。</div>`;
  }

  /**
   * ① 明日操作 —— **必须是关于你持仓的**。
   * ⚠️ 改过一次：原来这一节由 plan.js 用服务端数据渲染，讲的是上证/沪深300 等 6 个宽基指数的价格线，
   *    而用户一只都没持有。用户原话："明日操作里就没有我的持仓"。所以改到客户端渲染，
   *    数据只用持仓 + 闸门，指数那部分降级到 ③ 并正名为"大盘估值参照"。
   */
  function renderVerdict() {
    const box = $('pAction');
    if (!box) return;
    const holdings = rd(HKEY, []);
    const acct = rd(AKEY, null);
    const log = rd(LKEY, []);
    if (!holdings.length) {
      box.innerHTML = '<div class="perm" style="border-color:#5b8def"><div class="permk">明天做什么</div>' +
        '<div class="permt" style="color:#5b8def">先导入持仓</div>' +
        '<div class="permd">在 ④ 里点「同步持仓 6 条」，闸门才知道你有多少仓位、能不能加。</div></div>';
      return;
    }
    const A = assets(holdings, acct);
    const mv = holdings.reduce((s, h) => s + (h.value ?? (h.price ?? 0) * (h.qty ?? 0)), 0);
    const tranche = Math.max(0, Math.round((A * R.maxTotalPos - mv) / R.tranches));
    const used = log.filter((r) => r.action === 'add').length;
    const res = Object.values(G.stocks).map((g) => ({ g, r: checkAdd(g.name, tranche, holdings, acct, log) }));
    const allow = res.filter((x) => x.r.ok);
    const block = res.filter((x) => !x.r.ok);
    const color = allow.length ? '#2f9e6b' : '#e0803a';
    const big = allow.length ? allow.length + ' 只可以加' : '5 只都不许加';
    const sub = allow.length
      ? allow.map((x) => x.g.name).join('、') + ' 满足加仓条件'
      : block.slice(0, 3).map((x) => x.g.name + '（' + shortReason(x.r.blocked[0] || '') + '）').join('、') + (block.length > 3 ? ' 等 ' + block.length + ' 只' : '');
    box.innerHTML =
      '<div class="perm" style="border-color:' + color + '">' +
      '<div class="permk" style="color:' + color + '">明天做什么 · 只看你的 5 只持仓</div>' +
      '<div class="permt" style="color:' + color + '">' + esc(big) + '</div>' +
      '<div class="permd">' + esc(sub) + '</div>' +
      '<div class="permnote">可加空间 ' + Math.max(0, Math.round(A * R.maxTotalPos - mv)).toLocaleString('zh-CN') +
      ' ÷ ' + R.tranches + ' 档 = 每档约 ' + tranche.toLocaleString('zh-CN') + '　·　已用 ' + used + '/' + R.tranches + ' 档</div>' +
      '</div>';
  }

  window.GATE_ADD = checkAdd;
  const boot = () => { renderVerdict(); render(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // 持仓或记录变化后重算（plan-holdings.js / plan-log.js 保存时会派发这个事件）
  document.addEventListener('astock:changed', () => { renderVerdict(); render(); });
})();
