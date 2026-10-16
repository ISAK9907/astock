// 持仓闸门（客户端）：把用户定的规则变成"点加仓时能不能通过"的判定 + 渲染
//
// 数据来源三个，都是**客户端**的（持仓和交易记录只在手机上，不能上行）：
//   window.GATE        ← stock-gate.json（服务端算好的企稳等级），build-plan.mjs 内联
//   astock.holdings.v1 ← 持仓（同步来的或手输的）
//   astock.exlog.v1    ← 执行记录（每笔加仓的日期与价格，用于判"时空"）
//
// 2026-10-16：企稳判定从「只有个股」扩到「ETF 也算」（用户要求）。规则不变 ——
//   同一套 MA20/不创新低，只回答"能不能在自由落体里补仓"，不预测涨跌。
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

  // 赛道归类：用来判「同一赛道 ≤ 40%」这条硬约束。名字必须与持仓里的 name 完全一致。
  // 2026-10-16 新增 科创200ETF；华特气体/中船特气 已清仓，但条目保留 —— 万一再买回来，
  // 缺条目会让赛道硬约束**静默跳过**（checkAdd 里 `if (sec && ...)`），比多一条危险得多。
  const SECTOR = { 华特气体: '电子特气', 中船特气: '电子特气', 融捷股份: '锂资源', 中矿资源: '锂资源', 比亚迪: '新能源汽车', 科创200ETF: '科创板宽基', 港股互联: '港股互联' };
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

    // ---- 价格确认：视频「见底四件事」的最后一步，用户定为放行的必要条件 ----
    // 前三条（绿柱变短／底背离／金叉柱翻红）只是黄灯，不拦；只有"收盘站回前一个反弹高点"才放行。
    const fs = fourSteps(name);
    if (fs && !fs.steps[3].ok) blocked.push('价格未确认：' + fs.steps[3].value);

    const ok = blocked.length === 0 && soft.length === 0;
    const steps = fourSteps(name);
    return { ok, blocked: [...blocked, ...soft], steps, info: { level: g?.level ?? '—', needDays: g?.needDays, needGap: g?.needGap, usedTranches, mv, A, thisV, secV, sec } };
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
      `我拿 MA60 分档验过（华特是均值回归、融捷/中矿是动量，方向相反），均线当不了预测。<br>` +
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
        '<div class="permd">在 ④ 里点「同步持仓」，闸门才知道你有多少仓位、能不能加。</div></div>';
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
    const big = allow.length ? allow.length + ' 只可以加' : res.length + ' 只都不许加';
    const sub = allow.length
      ? allow.map((x) => x.g.name).join('、') + ' 满足加仓条件'
      : block.slice(0, 3).map((x) => x.g.name + '（' + shortReason(x.r.blocked[0] || '') + '）').join('、') + (block.length > 3 ? ' 等 ' + block.length + ' 只' : '');
    box.innerHTML =
      '<div class="perm" style="border-color:' + color + '">' +
      '<div class="permk" style="color:' + color + '">明天做什么 · 只看你的 ' + res.length + ' 只持仓</div>' +
      '<div class="permt" style="color:' + color + '">' + esc(big) + '</div>' +
      '<div class="permd">' + esc(sub) + '</div>' +
      '<div class="permnote">可加空间 ' + Math.max(0, Math.round(A * R.maxTotalPos - mv)).toLocaleString('zh-CN') +
      ' ÷ ' + R.tranches + ' 档 = 每档约 ' + tranche.toLocaleString('zh-CN') + '　·　已用 ' + used + '/' + R.tranches + ' 档</div>' +
      '</div>';
  }

  /**
   * 单只的可执行价格。**全部由已定的规则推导，没有一个是预测。**
   * 这是用户要的"计划操作价格"——他之前否掉了估值价格线（周期股 PE 是反的），
   * 所以这里给的是**流程价格**：要达到什么价才满足条件、以及止损在哪。
   */
  function planPrices(name, holdings, acct, log) {
    const g = Object.values(G.stocks).find((s) => s.name === name);
    if (!g) return [];
    const out = [];
    if (g.level !== '无') out.push(['站上 MA20（企稳前提）', '≥ ' + g.ma20.toFixed(2), g.last >= g.ma20]);
    else out.push(['站上 MA20（企稳前提）', '≥ ' + g.ma20.toFixed(2) + '（现 ' + g.last + '）', false]);
    out.push(['连续不创 20 日新低', g.streakNoLow + ' / ' + R.stability.弱.minNoLow + ' 天', g.streakNoLow >= R.stability.弱.minNoLow]);
    const lastAdd = log.filter((r) => r.action === 'add' && r.target === name).slice(-1)[0];
    const needGap = g.needGap ?? R.stability.弱.gap;
    if (lastAdd?.price) {
      out.push(['距上次加仓的空间', '≤ ' + (lastAdd.price * (1 - needGap / 100)).toFixed(2) + '（上次 ' + lastAdd.price + '，要求 ≥ ' + needGap + '%）', g.last <= lastAdd.price * (1 - needGap / 100)]);
    } else {
      out.push(['距上次加仓的空间', '本机还没有加仓记录', true]);
    }
    return out;
  }

  /**
   * MACD 背离（顶背离 / 底背离）—— 来自用户 2026-10-16 发的教学视频《看懂 MACD 背离》：
   *   ① 两条线 DIF(快)/DEA(慢)  ② 一排柱子（速度在变快还是变慢）
   *   ③ 背离：价格和速度不同步  ④ 实战
   * 视频只讲了"背离是什么"，没给判定标准，所以这里的口径**必须写死且可复核**：
   *   · MACD(12,26,9)，和卡片上图里画的是同一组数（同一窗口，绝不用另一套参数）
   *   · 摆动点 = 前后各 K 根的局部最高/最低（K=5）
   *   · 顶背离：后一个高点价格更高、但它的 DIF 更低   → 价格在涨、速度没跟上
   *   · 底背离：后一个低点价格更低、但它的 DIF 更高   → 价格在跌、跌速在放慢
   *   · 两个摆动点至少隔 MIN_GAP 根、后一个距今不超过 MAX_AGE 根（太久的不算）
   * ⚠️ 它是**提示**，不是预测：会不会转向由市场决定。所以默认不参与加仓的硬判定，
   *    只把事实和两个点的日期/价格/DIF 摆出来，由用户决定怎么用（见文件末尾的开关说明）。
   */
  const DIV = { K: 5, MIN_GAP: 8, MAX_AGE: 30, PRICE_EPS: 0.005 };

  function macdOf(S) {
    const closes = S.map((x) => x[1]);
    const ema = (arr, n) => { const k = 2 / (n + 1); const out = []; let p = null; for (const v of arr) { p = p == null ? v : v * k + p * (1 - k); out.push(p); } return out; };
    const e12 = ema(closes, 12), e26 = ema(closes, 26);
    const dif = e12.map((v, i) => v - e26[i]);
    const dea = ema(dif, 9);
    return { closes, dif, dea, hist: dif.map((v, i) => (v - dea[i]) * 2) };
  }

  function swings(vals, k) {
    const highs = [], lows = [];
    for (let i = k; i < vals.length - k; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (vals[j] >= vals[i]) isHigh = false;
        if (vals[j] <= vals[i]) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) highs.push(i);
      if (isLow) lows.push(i);
    }
    return { highs, lows };
  }

  /** 返回 {type:'顶'|'底'|null, ...}；type=null 表示当前窗口里没有可判定的背离 */
  function divergence(name) {
    const S = window.STOCKS?.[name];
    if (!S || S.length < 60) return { type: null, why: '数据不足' };
    const { closes, dif } = macdOf(S);
    const n = closes.length;
    const { highs, lows } = swings(closes, DIV.K);
    const build = (idx, kind) => ({
      kind, idxA: idx[0], idxB: idx[1],
      dateA: S[idx[0]][0], priceA: +closes[idx[0]].toFixed(3), difA: +dif[idx[0]].toFixed(4),
      dateB: S[idx[1]][0], priceB: +closes[idx[1]].toFixed(3), difB: +dif[idx[1]].toFixed(4),
      gapBars: idx[1] - idx[0], ageBars: n - 1 - idx[1],
    });
    const lastPair = (arr, test) => {
      for (let i = arr.length - 1; i >= 1; i--) {
        const b = arr[i], a = arr[i - 1];
        if (b - a < DIV.MIN_GAP) continue;
        if (n - 1 - b > DIV.MAX_AGE) return null; // 最新的摆动点都太旧 → 当前没有背离
        if (test(a, b)) return build([a, b], arr === highs ? 'top' : 'bottom');
        return null; // 只判最近一对摆动点，避免"翻旧账"翻出一年前的背离
      }
      return null;
    };
    const top = lastPair(highs, (a, b) => closes[b] > closes[a] * (1 + DIV.PRICE_EPS) && dif[b] < dif[a]);
    if (top) return { type: '顶', ...top };
    const bottom = lastPair(lows, (a, b) => closes[b] < closes[a] * (1 - DIV.PRICE_EPS) && dif[b] > dif[a]);
    if (bottom) return { type: '底', ...bottom };
    return { type: null, why: '最近两个同类摆动点没有出现"价格与速度不同步"' };
  }

  /**
   * 视频的「见底四件事」（半导体材料实战那段）—— **每件事分别看哪个对象，必须钉死**，
   * 否则同一个词会在 K线与 MACD线之间漂移，算出来的状态没人能复核：
   *   ① 绿柱开始变短   → 看 **MACD 柱**：绿柱的**绝对值**在缩短（下跌在减速）；柱已翻红也算过
   *   ② 底背离         → 看**两个主体**：K线收盘的低点更低，且**同一天**的 DIF 低点更高
   *   ③ 金叉、柱子翻红 → 看 **MACD 两条线**：DIF 上穿 DEA（不是均线、不是K线）
   *   ④ 收盘站回前一个反弹高点 → **只看 K 线收盘价**，与前一个"已确认"的摆动高点比
   * 只有 ④ 是放行的必要条件（用户 2026-10-16 定的）；①②③ 是黄灯式的进度提示。
   */
  function fourSteps(name) {
    const S = window.STOCKS?.[name];
    if (!S || S.length < 60) return null;
    const { closes, dif, dea, hist } = macdOf(S);
    const n = closes.length;
    const last = closes[n - 1];
    const f3 = (v) => (v >= 0 ? '+' : '') + v.toFixed(3);

    // ① MACD 柱：绿柱连续缩短（比的是 |柱|）。柱若已翻红，这一步视为已过。
    let shrink = 0;
    for (let i = n - 1; i > 0 && hist[i] < 0; i--) {
      if (Math.abs(hist[i]) < Math.abs(hist[i - 1])) shrink++;
      else break;
    }
    const green = hist[n - 1] < 0;
    const step1 = {
      key: '绿柱开始变短', on: 'MACD柱',
      ok: !green || shrink >= 2,
      value: green ? `绿柱已连续 ${shrink} 根缩短（|柱| ${Math.abs(hist[n - 1]).toFixed(3)}）` : `柱子已翻红（${f3(hist[n - 1])}）`,
    };

    // ② 底背离：K线低点更低 + 同日 DIF 更高
    const d = divergence(name);
    const step2 = {
      key: '底背离', on: 'K线低点 + 同日DIF',
      ok: d.type === '底',
      value: d.type === '底'
        ? `K线 ${d.priceA} → ${d.priceB}（更低），同日 DIF ${d.difA} → ${d.difB}（更高）`
        : (d.type === '顶' ? '当前是顶背离（反方向），不是见底信号' : '未出现底背离'),
    };

    // ③ 金叉、柱子翻红：DIF 上穿 DEA
    let crossAt = -1;
    for (let i = n - 1; i > 0; i--) if (dif[i] > dea[i] && dif[i - 1] <= dea[i - 1]) { crossAt = i; break; }
    const red = dif[n - 1] > dea[n - 1];
    const ago = crossAt < 0 ? null : n - 1 - crossAt;
    const step3 = {
      key: '金叉、柱翻红', on: 'DIF/DEA',
      ok: red,
      value: red ? (ago == null ? '柱为红（DIF 在 DEA 上方）' : `${ago} 根前金叉，柱已翻红`) : '柱为绿（DIF 在 DEA 下方），还没金叉',
    };

    // ④ 价格确认：只看收盘价 vs 前一个已确认的反弹高点
    const { highs } = swings(closes, DIV.K);
    let prevHigh = null, prevDate = null;
    for (let i = highs.length - 1; i >= 0; i--) {
      const h = highs[i];
      if (n - 1 - h < DIV.K + 1) continue; // 右边还没走够根数，不算"已确认"的前高
      prevHigh = closes[h]; prevDate = S[h][0]; break;
    }
    const step4 = {
      key: '收盘站回前一个反弹高点', on: 'K线收盘价',
      ok: prevHigh != null && last >= prevHigh,
      value: prevHigh == null ? '找不到可用的前一个反弹高点'
        : `收盘 ${last} 元 ${last >= prevHigh ? '≥' : '<'} 前高 ${prevHigh.toFixed(3)}（${prevDate}）`,
    };

    const steps = [step1, step2, step3, step4];
    return { steps, n: steps.filter((s) => s.ok).length, ok: steps.every((s) => s.ok) };
  }

  /**
   * 价格曲线 + 均线（SVG，无依赖）。
   * 为什么这张图值得放进卡片：企稳判定用的是 MA20 和「不创新低」，光看数字很难判断
   * "离站上还有多远""是在走平还是继续下坠"。图上把 MA20 画成高亮线，一眼就能看出来。
   * 2026-10-16 加了 MACD 子图（用户要求）。
   * ⚠️ 仅作图，不做任何预测 —— 均线的预测力我在这几只上验过，是反的（华特均值回归、融捷动量）。
   */
  function renderChart(name) {
    const S = window.STOCKS?.[name];
    if (!S || S.length < 30) return '';
    const W = 500, Hh = 150, P = { t: 8, r: 6, b: 16, l: 6 };
    const closes = S.map((x) => x[1]);
    const ma = (n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += closes[k]; return s / n; };
    const m5 = closes.map((_, i) => ma(5, i)), m20 = closes.map((_, i) => ma(20, i)), m60 = closes.map((_, i) => ma(60, i));
    const all = [...closes, ...m20.filter((v) => v != null), ...m60.filter((v) => v != null)].filter((v) => v != null);
    const lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.06 || 1;
    const X = (i) => P.l + (i / (S.length - 1)) * (W - P.l - P.r);
    const Y = (v) => P.t + (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (Hh - P.t - P.b);
    const path = (arr) => {
      let d = '', open = false;
      arr.forEach((v, i) => { if (v == null) { open = false; return; } d += (open ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); open = true; });
      return d;
    };
    const lastC = closes.at(-1), lastMA20 = m20.at(-1), lastMA60 = m60.at(-1);
    const up = lastC >= (lastMA20 ?? lastC);
    // x 轴只标首末日期，避免手机上糊成一团
    const d0 = S[0][0].slice(5), d1 = S.at(-1)[0].slice(5);
    // 「前低」画成一条虚线（视频里的做法）：主体是 **K线收盘价** —— 收盘跌破它 ＋ 死叉才是转弱确认
    const lowsIdx = swings(closes, DIV.K).lows;
    let prevLow = null, prevLowDate = null;
    for (let i = lowsIdx.length - 1; i >= 0; i--) {
      const k = lowsIdx[i];
      if (S.length - 1 - k < DIV.K + 1) continue;
      prevLow = closes[k]; prevLowDate = S[k][0]; break;
    }
    const lowLine = prevLow == null ? '' :
      '<line x1="' + P.l + '" y1="' + Y(prevLow).toFixed(1) + '" x2="' + (W - P.r) + '" y2="' + Y(prevLow).toFixed(1) +
      '" stroke="rgba(224,128,58,.55)" stroke-width="1" stroke-dasharray="4 3"/>' +
      '<text x="' + (P.l + 3) + '" y="' + (Y(prevLow) - 3).toFixed(1) + '" fill="rgba(224,128,58,.9)" font-size="9">前低 ' +
      prevLow.toFixed(2) + '（' + prevLowDate.slice(5) + '）</text>';
    const priceSvg = '<svg class="hpsvg" viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none">' +
      '<path d="' + path(closes) + '" fill="none" stroke="' + (up ? '#e08a6a' : '#4fbf8f') + '" stroke-width="1.4"/>' +
      '<path d="' + path(m5) + '" fill="none" stroke="rgba(150,160,180,.5)" stroke-width="1" stroke-dasharray="3 2"/>' +
      // MA20 是企稳判定的那条线，画粗、高亮
      '<path d="' + path(m20) + '" fill="none" stroke="#5b8def" stroke-width="1.8"/>' +
      '<path d="' + path(m60) + '" fill="none" stroke="rgba(224,128,58,.75)" stroke-width="1.2"/>' +
      lowLine +
      '<text x="' + P.l + '" y="' + (Hh - 4) + '" fill="#7b8698" font-size="9">' + d0 + '</text>' +
      '<text x="' + (W - P.r) + '" y="' + (Hh - 4) + '" fill="#7b8698" font-size="9" text-anchor="end">' + d1 + '</text>' +
      '</svg>' +
      '<div class="hplegend">' +
      '<span><i style="background:' + (up ? '#e08a6a' : '#4fbf8f') + '"></i>收盘 ' + lastC.toFixed(2) + '</span>' +
      '<span><i style="background:#5b8def"></i>MA20 ' + (lastMA20 == null ? '—' : lastMA20.toFixed(2)) + (up ? '（已在上方）' : '（还在下方）') + '</span>' +
      '<span><i style="background:rgba(224,128,58,.75)"></i>MA60 ' + (lastMA60 == null ? '—' : lastMA60.toFixed(2)) + '</span>' +
      '<span><i style="background:rgba(150,160,180,.5)"></i>MA5</span>' +
      '</div>';

    // ---------------- MACD（12,26,9） ----------------
    // 用户 2026-10-16 要求：卡片点开后除了日K曲线，再加 MACD。
    // ⚠️ 同样**只作图、不下结论** —— 不写"金叉可买"这类话。理由和均线一样：
    //    我在这几只用 MA60 分档实测过，方向是反的（华特均值回归、融捷/中矿是动量），
    //    所以图表只负责把状态画出来，判定仍然只走「企稳」那一套可复核的条件。
    // 窗口就是页面内联的 250 根（约一年）：EMA 起点略早于窗口，前几十根会有一点收敛过程，
    // 看图足够；要精确复算请用完整日线。
    const ema = (arr, n) => {
      const k = 2 / (n + 1);
      const out = [];
      let prev = null;
      for (const v of arr) { prev = prev == null ? v : v * k + prev * (1 - k); out.push(prev); }
      return out;
    };
    const e12 = ema(closes, 12), e26 = ema(closes, 26);
    const dif = e12.map((v, i) => v - e26[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((v, i) => (v - dea[i]) * 2); // 国内习惯：柱 = (DIF−DEA)×2
    const MH = 96, MP = { t: 6, r: 6, b: 10, l: 6 };
    const amp = Math.max(...dif.map(Math.abs), ...dea.map(Math.abs), ...hist.map(Math.abs)) || 1;
    const MY = (v) => MP.t + (1 - (v + amp) / (2 * amp)) * (MH - MP.t - MP.b);
    const mpath = (arr) => {
      let d = '', open = false;
      arr.forEach((v, i) => { d += (open ? 'L' : 'M') + X(i).toFixed(1) + ' ' + MY(v).toFixed(1); open = true; });
      return d;
    };
    const bw = Math.max(1, ((W - MP.l - MP.r) / Math.max(1, S.length - 1)) * 0.62);
    const zeroY = MY(0);
    // 背离的两个 DIF 点直接标出来并连线（视频里的画法）：主体是 **DIF**，且取的是价格摆动点当天的值
    const dv = divergence(name);
    const dvMark = dv.type ? (
      '<circle cx="' + X(dv.idxA).toFixed(1) + '" cy="' + MY(dv.difA).toFixed(1) + '" r="3" fill="#e0a23a"/>' +
      '<circle cx="' + X(dv.idxB).toFixed(1) + '" cy="' + MY(dv.difB).toFixed(1) + '" r="3" fill="#e0a23a"/>' +
      '<line x1="' + X(dv.idxA).toFixed(1) + '" y1="' + MY(dv.difA).toFixed(1) + '" x2="' + X(dv.idxB).toFixed(1) +
      '" y2="' + MY(dv.difB).toFixed(1) + '" stroke="rgba(224,162,58,.85)" stroke-width="1" stroke-dasharray="3 2"/>'
    ) : '';
    const bars = hist.map((v, i) => {
      const y1 = MY(v);
      const top = Math.min(zeroY, y1), h = Math.max(0.6, Math.abs(y1 - zeroY));
      return '<rect x="' + (X(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(2) +
        '" height="' + h.toFixed(1) + '" fill="' + (v >= 0 ? 'rgba(224,106,106,.55)' : 'rgba(79,191,143,.5)') + '"/>';
    }).join('');
    const macdSvg = '<svg class="hpsvg" viewBox="0 0 ' + W + ' ' + MH + '" preserveAspectRatio="none" style="margin-top:1px">' +
      '<line x1="' + MP.l + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - MP.r) + '" y2="' + zeroY.toFixed(1) + '" stroke="#2b3341" stroke-width="1"/>' +
      bars +
      '<path d="' + mpath(dif) + '" fill="none" stroke="#5b8def" stroke-width="1.4"/>' +
      '<path d="' + mpath(dea) + '" fill="none" stroke="rgba(224,128,58,.9)" stroke-width="1.2"/>' +
      dvMark +
      '</svg>' +
      '<div class="hplegend">' +
      '<span><i style="background:#5b8def"></i>DIF ' + dif.at(-1).toFixed(3) + '</span>' +
      '<span><i style="background:rgba(224,128,58,.9)"></i>DEA ' + dea.at(-1).toFixed(3) + '</span>' +
      '<span><i style="background:' + (hist.at(-1) >= 0 ? 'rgba(224,106,106,.7)' : 'rgba(79,191,143,.7)') + '"></i>MACD柱 ' +
        (hist.at(-1) >= 0 ? '+' : '') + hist.at(-1).toFixed(3) + '</span>' +
      '<span class="dim">MACD(12,26,9) · 仅作图</span>' +
      '</div>' +
      // ② 一排柱子 = 速度在变快还是变慢（视频里的说法）。只看最近 3 根，避免过度解读。
      (() => {
        const h = hist.slice(-3);
        if (h.length < 3) return '';
        const pos = h[2] >= 0;
        const shrinking = Math.abs(h[2]) < Math.abs(h[0]);
        const word = pos ? '红柱' : '绿柱';
        const speed = shrinking ? '在缩短 → 速度变慢' : '在放大 → 速度变快';
        return '<div class="hplegend"><span><i style="background:' + (pos ? 'rgba(224,106,106,.7)' : 'rgba(79,191,143,.7)') + '"></i>' +
          word + ' 近 3 根' + speed + '</span></div>';
      })() +
      // ③ 背离：价格和速度不同步
      (() => {
        const d = divergence(name);
        if (!d.type) return '';
        const top = d.type === '顶';
        return '<div class="hpadv ' + (top ? 'no' : 'ok') + '">' +
          (top ? '⚠️ MACD 顶背离' : '● MACD 底背离') + '：' +
          d.dateA + ' 收 ' + d.priceA + ' → ' + d.dateB + ' 收 ' + d.priceB +
          '，DIF ' + d.difA + ' → ' + d.difB +
          '（' + (top ? '价格更高、速度没跟上' : '价格更低、跌速在放慢') +
          ' · 隔 ' + d.gapBars + ' 根 · 距今 ' + d.ageBars + ' 根）</div>';
      })();

    return priceSvg + macdSvg;
  }

  window.GATE_ADD = checkAdd;
  window.GATE_PRICES = planPrices;
  window.GATE_CHART = renderChart;
  window.GATE_DIVERGENCE = divergence;
  window.GATE_STEPS = fourSteps;
  /**
   * ② 必须逐条回答 —— 改成**只讲你的持仓**。
   * ⚠️ 原来这节由 plan.js 用服务端数据渲染，内容是「价值陷阱 / 价格在高位但估值不高 / 12–1 月小盘弱」
   *    —— 全部在讲那 6 个宽基指数，用户一只都没持有。用户原话："逐条回答还是有不需要的东西"。
   *    现在改成持仓口径：只列**你的持仓**里需要回答的问题，没有就明说"没有"。
   */
  function renderChecklist() {
    const box = $('pCheck');
    if (!box) return;
    const holdings = rd(HKEY, []);
    const acct = rd(AKEY, null);
    if (!holdings.length) { box.innerHTML = '<div class="chk wait"><span class="chki">■</span><span>先在 ④ 导入持仓</span></div>'; return; }
    const A = assets(holdings, acct);
    const val = (h) => h.value ?? (h.price ?? h.cost ?? 0) * (h.qty ?? 0);
    const items = [];
    // ① 单只超限（只针对真超了的）
    for (const h of holdings) {
      // ⚠️ 量纲必须一致：share 是**百分数**（18.87），capOf 返回**小数**（0.20）。
      //    原来写 share > cap：18.87 > 0.20 恒真 → 6 只全部被误报"已超过上限，只许减"。
      //    用户反馈"逐条回答的东西算错"就是这个。分母（总资产）一直是对的，错的是比较。
      const cap = capOf(h.name), share = val(h) / A * 100;
      if (share > cap * 100) items.push({ k: 'warn', t: h.name + ' 占账户 ' + share.toFixed(1) + '%，已超过你设的 ' + (cap * 100).toFixed(0) + '% 上限 —— 只许减' });
    }
    // ② 赛道超限
    const sec = {};
    for (const h of holdings) { const s = SECTOR[h.name] || '其他'; sec[s] = (sec[s] || 0) + val(h); }
    for (const [s, v] of Object.entries(sec)) {
      if (v / A * 100 > R.maxSector * 100) items.push({ k: 'warn', t: s + ' 赛道占账户 ' + (v / A * 100).toFixed(1) + '%，超过 ' + (R.maxSector * 100).toFixed(0) + '% 上限' });
    }
    // ③ 深亏的：要求回答"当初买它的理由还成立吗"
    const deep = holdings.filter((h) => {
      const cost = (h.cost ?? 0) * (h.qty ?? 0);
      return cost > 0 && (val(h) - cost) / cost <= -0.20;
    });
    if (deep.length) items.push({ k: 'check', t: deep.map((h) => h.name).join('、') + '：亏损已超 20%，加仓前先回答「当初买它的理由还成立吗」' });
    // ④ 企稳：今天有几只具备加仓前提
    const g0 = window.GATE;
    if (g0) {
      const lv = Object.values(g0.stocks);
      const none = lv.filter((s) => s.level === '无').length;
      if (none) items.push({ k: 'wait', t: none + ' 只仍在创新低 / 站不上 MA20 —— 按规则今天不许加仓' });
    }
    // ⑤ 日历（只在与个股有关时出现）
    const m = new Date().getMonth() + 1;
    if ([4, 8, 10].includes(m)) items.push({ k: 'check', t: m + ' 月是财报截止月：个股不加新仓，留意持仓个股的预约披露日' });
    // ⑥ MACD 背离（用户 2026-10-16 发的视频《看懂 MACD 背离》：价格和速度不同步）
    //    ⚠️ 只提示、不参与加仓的硬判定 —— 视频讲的是"背离是什么"，没给可执行的阈值；
    //       要不要拿它当加减仓的条件，得用户自己定（工具不替他改规则）。
    if (typeof divergence === 'function') {
      const tops = [], bots = [];
      for (const h of holdings) {
        const d = divergence(h.name);
        if (d.type === '顶') tops.push(h.name + '（' + d.dateB + ' 价格更高、DIF 更低）');
        else if (d.type === '底') bots.push(h.name + '（' + d.dateB + ' 价格更低、DIF 更高）');
      }
      if (tops.length) items.push({ k: 'warn', t: 'MACD 顶背离 ' + tops.join('、') + ' —— 价格在涨、速度没跟上' });
      if (bots.length) items.push({ k: 'check', t: 'MACD 底背离 ' + bots.join('、') + ' —— 价格在跌、跌速在放慢' });
    }
    // ⑦ 见底四件事（视频）：只报进度；**放行的只有第 ④ 项（收盘站回前高，看 K 线收盘价）**
    if (typeof fourSteps === 'function') {
      const fsr = holdings.map((h) => ({ name: h.name, s: fourSteps(h.name) })).filter((r) => r.s);
      if (fsr.length) {
        const done = fsr.filter((r) => r.s.steps[3].ok);
        items.push({
          k: done.length ? 'act' : 'wait',
          t: '见底四件事：' + fsr.map((r) => r.name + ' ' + r.s.n + '/4').join('、') +
            (done.length ? '　已过第④项（收盘站回前高）：' + done.map((r) => r.name).join('、')
                         : '　还没有一只过第④项（收盘站回前高）—— 按新规则，一只都不放行'),
        });
      }
    }
    if (!items.length) items.push({ k: 'act', t: '没有需要回答的问题 —— 持仓在约束内，也没有可执行的加仓' });
    const icon = { act: '▶', wait: '■', check: '？', warn: '⚠' };
    // 口径说明：这一节的百分比分母是**账户总资产**（用户 2026-10-16 明确要求，
    // 不是持仓市值）；顺带把本机持仓快照的时间打出来，免得看的是旧数据还不知道。
    const snapAt = (() => { try { return localStorage.getItem('astock.holdings.appliedAt') || ''; } catch { return ''; } })();
    const snapTxt = snapAt ? snapAt.slice(0, 16).replace('T', ' ') : '未知';
    const basisHtml = acct?.assets
      ? '<div class="dim" style="margin-top:8px;font-size:11.5px">口径：分母 = <b>账户总资产</b> ' + (acct.assets / 10000).toFixed(2) +
        ' 万（不是持仓市值）· 持仓快照 ' + esc(snapTxt) + ' · 每次打开页面自动跟最新快照对齐。</div>'
      : '<div class="chkbox warnbox" style="margin-top:8px">⚠️ 还没同步账户总资产 —— 现在只能用<b>持仓市值</b>当分母，比例会系统性偏大。' +
        '到 ④ 点「同步持仓」把账户总览一起拉下来。</div>';
    box.innerHTML = items.map((c) => '<div class="chk ' + c.k + '"><span class="chki">' + (icon[c.k] || '·') + '</span><span>' + esc(c.t) + '</span></div>').join('') +
      basisHtml +
      '<div class="dim" style="margin-top:8px;font-size:11.5px">这一节只列<b>你的持仓</b>里需要回答的问题。大盘估值那部分在 ③。</div>';
  }

  const boot = () => { renderVerdict(); renderChecklist(); render(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // 持仓或记录变化后重算（plan-holdings.js / plan-log.js 保存时会派发这个事件）
  document.addEventListener('astock:changed', () => { renderVerdict(); renderChecklist(); render(); });
})();
