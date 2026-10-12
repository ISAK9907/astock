// 持仓模块：手机截图上传 → 解析 → **逐行确认** → 存本机 localStorage
//
// 为什么不用浏览器内 OCR：
//   iOS 实况文本 / 安卓相册文字识别是系统级 OCR，对中文小字体的准确率明显高于
//   浏览器里能跑的 Tesseract.js，而且不用往 PWA 里塞十几 MB 的语言包。
//   所以流程是「把截图放大显示 → 你照着读或直接贴系统提取出的文字 → 我来解析」。
//
// ⚠️ 无论走哪条路，解析结果都必须**逐行确认后才写入**。
//    持仓是整个工具的地基（占比上限、已投档位、加减仓判断全靠它），
//    识别错一个数字不会报错，只会静默污染后面所有结论 —— 这正是最难发现的那类错。
//
// 数据只存在本机浏览器的 localStorage，仓库里没有、也不会有（仓库是公开的）。
(function () {
  const KEY = 'astock.holdings.v1';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------------- 解析 ----------------
  // 两种模式，按文本特征自动选：
  //   ① 表头模式：出现「代码/名称/数量/持仓/成本/现价/市值/盈亏」这类列名且有分隔符
  //   ② 扫描模式：没有表头，就找 6 位代码，再从它附近抓数字
  // 两者都**宁可少识别也不要猜错**：凑不齐「数量 + 成本」的行不输出，交给人工补。
  const COLS = [
    { key: 'code', re: /(代码|证券代码|股票代码)/ },
    { key: 'name', re: /(名称|证券名称|股票名称)/ },
    { key: 'qty', re: /(持仓|股票余额|证券数量|数量|持股数)/ },
    { key: 'avail', re: /(可用|可用余额|可卖)/ },
    { key: 'cost', re: /(成本价|成本|摊薄成本)/ },
    { key: 'price', re: /(现价|市价|最新价|当前价)/ },
    { key: 'value', re: /(市值|参考市值|最新市值)/ },
    { key: 'pnl', re: /(浮动盈亏|参考盈亏|盈亏|浮盈)/ },
    { key: 'pnlpct', re: /(盈亏比例|收益率|盈亏率)/ },
  ];

  const num = (s) => {
    if (s == null) return null;
    const t = String(s).replace(/[,\s¥￥%]/g, '').replace(/[（(]([^)）]*)[)）]/g, '');
    const m = /-?\d+(?:\.\d+)?/.exec(t);
    return m ? parseFloat(m[0]) : null;
  };
  const numSigned = (s) => {
    if (s == null) return null;
    const t = String(s).replace(/[,\s¥￥]/g, '');
    const m = /[-+]?\d+(?:\.\d+)?/.exec(t);
    return m ? parseFloat(m[0]) : null;
  };

  // ==================== 专用识别器：券商「文字化」持仓页 ====================
  // 为什么需要单独一条路：2026-10-13 拿到真实数据一试，通用表头模式**识别出 6 条但每个字段都是错的**
  //   （名字变成「华特气体 102」、市值 420.0018、数量成本全 null）。
  // 比"一条都没识别"更危险 —— 用户看到「识别 6 条」就可能直接保存，垃圾变成了地基。
  // 这个格式有三个通用模式处理不了的特征：
  //   ① 没有股票代码，只有名称
  //   ② 「持仓/可用」「成本/现价」是**斜杠挤在一个单元格**里
  //   ③ 账户总览（总资产/仓位/可用）与持仓明细是两段，总览没有列名
  const ROW_RE = /^(.+?)\s+([\d,]+\.\d+)\s+([\d.]+)%\s+(-?[\d,]+\.\d+)\s*\((-?[\d.]+)%\)\s+([\d,]+)\s*\/\s*([\d,]+)\s+([\d.]+)\s*\/\s*([\d.]+)\s*(.*)$/;

  /** 把 `900 / 900` 这类斜杠对压成一个 token，防止按空格切列时被拆散 */
  const mergeSlashPairs = (line) => line.replace(/(\S+)\s*\/\s*(\S+)/g, '$1§$2');

  function parseBroker(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const m = ROW_RE.exec(line);
      if (!m) continue;
      const [, name, value, posPct, pnl, pnlPct, qty, avail, cost, price, rest] = m;
      // 名称里不该有数字；有的话说明这一行匹配歪了
      if (/\d/.test(name)) continue;
      const day = /([+-][\d,]+\.\d+)\s*\((-?[\d.]+)%\)/.exec(rest ?? '');
      rows.push({
        code: null,
        name: name.trim(),
        qty: +qty.replace(/,/g, ''),
        avail: +avail.replace(/,/g, ''),
        cost: parseFloat(cost),
        price: parseFloat(price),
        value: parseFloat(value.replace(/,/g, '')),
        posPct: parseFloat(posPct),
        pnl: parseFloat(pnl.replace(/,/g, '')),
        pnlpct: parseFloat(pnlPct),
        dayPnl: day ? parseFloat(day[1].replace(/,/g, '')) : null,
        raw: line,
      });
    }
    return rows.length ? { mode: 'broker', rows } : null;
  }

  /** 账户总览（总资产 / 仓位 / 总市值 / 浮动盈亏 / 可用）。这些是后面仓位判断的基数。 */
  function parseAccount(text) {
    const pick = (re) => { const m = re.exec(text); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
    const acct = {
      assets: pick(/总资产[：:]\s*([\d,]+\.?\d*)/),
      marketValue: pick(/总市值[：:]\s*([\d,]+\.?\d*)/),
      pnl: pick(/浮动盈亏[：:]\s*(-?[\d,]+\.?\d*)/),
      cash: pick(/可用[：:]\s*([\d,]+\.?\d*)\(?/),
      posPct: pick(/仓位[：:]\s*([\d.]+)%/),
    };
    return Object.values(acct).some((v) => v != null) ? acct : null;
  }

  /**
   * 自校验：这个数据里有**冗余** —— 各股(市值|盈亏)之和必须等于总市值/浮动盈亏。
   * 这是唯一能自动发现「解析歪了」的手段：字段错了不会报错，但和对不上的概率很高。
   * 误差超过 0.5% 或 1 元就报警，由用户决定是否保存。
   */
  function crossCheck(rows, acct) {
    if (!rows?.length || !acct) return null;
    const sumV = rows.reduce((a, r) => a + (r.value ?? 0), 0);
    const sumP = rows.reduce((a, r) => a + (r.pnl ?? 0), 0);
    const out = [];
    if (acct.marketValue) {
      const d = Math.abs(sumV - acct.marketValue);
      out.push({ field: '市值合计', got: +sumV.toFixed(2), want: acct.marketValue, ok: d <= Math.max(1, acct.marketValue * 0.005) });
    }
    if (acct.pnl != null) {
      const d = Math.abs(sumP - acct.pnl);
      out.push({ field: '盈亏合计', got: +sumP.toFixed(2), want: acct.pnl, ok: d <= Math.max(1, Math.abs(acct.pnl) * 0.005) });
    }
    return out.length ? out : null;
  }

  /** 表头模式：把表头行的列名映射到列序号，再逐行取值 */
  function parseTable(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // 找表头行：命中 ≥2 个列名，**且本身几乎不含数字**。
    // ⚠️ 后面这个条件不能省：无表头的逐条格式里有 `成本价 1500.00  现价 1600.00` 这种行，
    //    它同样命中 2 个列名，会被误判成表头，把整段数据按错误的列序解析（实测踩到）。
    //    真实表头是纯文字（「成本价」而不是「成本价 1500.00」）。
    let hi = -1, map = null;
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const cells = splitCells(lines[i]);
      const nums = (lines[i].match(/\d+(?:\.\d+)?/g) || []).length;
      if (nums > 1) continue; // 带数字的是数据行，不是表头
      const hit = {};
      cells.forEach((c, k) => {
        for (const col of COLS) if (!(col.key in hit) && col.re.test(c)) hit[col.key] = k;
      });
      if (Object.keys(hit).length >= 2) { hi = i; map = hit; break; }
    }
    if (hi < 0) return null;

    const rows = [];
    for (let i = hi + 1; i < lines.length; i++) {
      const cells = splitCells(lines[i]);
      if (cells.length < 2) continue;
      const g = (k) => (map[k] != null ? cells[map[k]] : null);
      const code = /(\d{6})/.exec(g('code') ?? cells.join(' '))?.[1] ?? null;
      const nameCell = g('name');
      const row = {
        code,
        name: nameCell ? nameCell.replace(/[（(].*?[)）]/g, '').trim() : null,
        qty: num(g('qty')),
        cost: num(g('cost')),
        price: num(g('price')),
        value: num(g('value')),
        pnl: numSigned(g('pnl')),
        pnlpct: numSigned(g('pnlpct')),
        raw: lines[i],
      };
      if (!row.code && !row.name) continue;
      if (row.qty == null && row.cost == null && row.value == null) continue;
      rows.push(row);
    }
    return rows.length ? { mode: 'table', rows } : null;
  }

  /** 扫描模式：找 6 位代码，从该行/相邻行抓数字 */
  function parseScan(text) {
    const lines = text.split(/\r?\n/);
    const rows = [];
    const codeRe = /\b(\d{6})\b/;
    for (let i = 0; i < lines.length; i++) {
      const m = codeRe.exec(lines[i]);
      if (!m) continue;
      const code = m[1];
      // 该行 + 后两行作为「这一条」的文本范围
      const block = [lines[i], lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ').replace(/\s+/g, ' ');
      const name = /([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{1,10})/.exec(lines[i].replace(code, ''))?.[1] ?? null;

      const pick = (re) => {
        const x = re.exec(block);
        return x ? num(x[1]) : null;
      };
      const qty = pick(/(?:持仓|余额|数量|持有)\D{0,6}(\d{2,7})/) ?? (() => {
        // 没有关键词时：取一个像股数的整数（通常 ≥100 且是 100 的倍数）
        const c = [...block.matchAll(/(?<![\d.])(\d{3,7})(?![\d.])/g)].map((x) => +x[1]).filter((v) => v >= 100 && v % 100 === 0);
        return c.length ? c[0] : null;
      })();
      const cost = pick(/(?:成本价|成本|摊薄)\D{0,6}(\d+(?:\.\d+)?)/);
      const price = pick(/(?:现价|市价|最新价|当前价)\D{0,6}(\d+(?:\.\d+)?)/);
      const pnl = (() => {
        const x = /(?:浮动盈亏|参考盈亏|盈亏|浮盈)\D{0,6}([-+]?\d+(?:\.\d+)?)/.exec(block);
        return x ? parseFloat(x[1]) : null;
      })();
      if (qty == null && cost == null) continue; // 凑不齐就不输出
      rows.push({ code, name, qty, cost, price, value: null, pnl, pnlpct: null, raw: block.slice(0, 120) });
    }
    // 同一代码可能被多行重复命中，去重
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.code)) seen.set(r.code, r);
    return seen.size ? { mode: 'scan', rows: [...seen.values()] } : null;
  }

  function splitCells(line) {
    if (line.includes('\t')) return line.split('\t').map((s) => s.trim());
    if (line.includes(',')) return line.split(',').map((s) => s.trim());
    if (/\s{2,}/.test(line)) return line.split(/\s{2,}/).map((s) => s.trim());
    return line.split(/\s+/).map((s) => s.trim());
  }

  function parse(text) {
    if (!text || !text.trim()) return { mode: 'none', rows: [], account: null, checks: null };
    // 顺序很重要：**专用识别器优先**。通用表头模式在真实券商格式上会「识别出条目但字段全错」，
    // 比识别不出更危险，所以不能让它在前面。
    const broker = parseBroker(text);
    const account = parseAccount(text);
    if (broker) {
      const checks = crossCheck(broker.rows, account);
      return { mode: 'broker', rows: broker.rows, account, checks };
    }
    const generic = parseTable(text) ?? parseScan(text) ?? { mode: 'none', rows: [] };
    return { ...generic, account, checks: crossCheck(generic.rows, account) };
  }

  // ---------------- 存储 ----------------
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const save = (rows) => localStorage.setItem(KEY, JSON.stringify(rows));

  // ---------------- 渲染 ----------------
  let draft = [];
  let draft_checks = null;   // 自校验结果（各股合计 vs 账户总览）
  let draft_account = null;  // 账户总览（总资产/仓位/可用），保存时一并存档
  const ACCT_KEY = 'astock.acct.v1';

  function renderDraft() {
    const box = $('holdDraft');
    if (!box) return;
    if (!draft.length) { box.innerHTML = '<div class="dim">还没有解析结果</div>'; return; }
    const sum = draft.reduce((a, r) => a + (r.value ?? (r.qty ?? 0) * (r.price ?? 0)), 0);
    // 自校验结果放在最上面：这是唯一能自动发现「解析歪了」的手段。
    // 字段错了不会报错，但「各股市值之和 = 总市值」这条冗余对不上就说明有问题。
    // 2026-10-13 那次通用解析器「识别 6 条、字段全错」，靠的就是这种冗余才看得出来。
    let checkHtml = '';
    if (draft_checks?.length) {
      const bad = draft_checks.filter((c) => !c.ok);
      checkHtml =
        `<div class="chkbox ${bad.length ? 'bad' : 'good'}">` +
        (bad.length ? `⚠️ <b>自校验未通过</b>，解析可能不准，请逐行核对：` : `✓ <b>自校验通过</b>：`) +
        draft_checks.map((c) => `${esc(c.field)} ${c.got.toLocaleString('zh-CN')} vs 总览 ${c.want.toLocaleString('zh-CN')}${c.ok ? '' : ' ✗'}`).join(' · ') +
        `</div>`;
    }
    box.innerHTML =
      checkHtml +
      `<div class="hrow hhead"><span>代码</span><span>名称</span><span>数量</span><span>成本</span><span>现价</span><span></span></div>` +
      draft
        .map(
          (r, i) =>
            `<div class="hrow"><input data-i="${i}" data-f="code" value="${esc(r.code ?? '')}" placeholder="代码">` +
            `<input data-i="${i}" data-f="name" value="${esc(r.name ?? '')}" placeholder="名称">` +
            `<input data-i="${i}" data-f="qty" value="${esc(r.qty ?? '')}" inputmode="numeric" placeholder="数量">` +
            `<input data-i="${i}" data-f="cost" value="${esc(r.cost ?? '')}" inputmode="decimal" placeholder="成本">` +
            `<input data-i="${i}" data-f="price" value="${esc(r.price ?? '')}" inputmode="decimal" placeholder="现价">` +
            `<button class="hdel" data-del="${i}" type="button">×</button></div>`,
        )
        .join('') +
      `<div class="hsum">识别 ${draft.length} 条 · 合计市值约 ${sum.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</div>` +
      `<button class="hbtn primary" id="holdSave" type="button">确认无误，保存到本机</button>` +
      `<div class="dim" style="margin-top:6px">⚠️ 请逐行核对后再保存。识别错一个数字不会报错，只会让后面所有判断建立在错数上。</div>`;

    box.querySelectorAll('input').forEach((el) =>
      el.addEventListener('input', () => {
        const r = draft[+el.dataset.i];
        if (!r) return;
        const f = el.dataset.f;
        r[f] = f === 'name' || f === 'code' ? el.value.trim() : num(el.value);
      }),
    );
    box.querySelectorAll('[data-del]').forEach((el) =>
      el.addEventListener('click', () => { draft.splice(+el.dataset.del, 1); renderDraft(); }),
    );
    const sb = $('holdSave');
    if (sb) sb.addEventListener('click', () => {
      save(draft.filter((r) => r.code || r.name));
      if (draft_account) localStorage.setItem(ACCT_KEY, JSON.stringify(draft_account));
      renderSaved();
      draft = [];
      draft_checks = null;
      renderDraft();
    });
  }

  function renderSaved() {
    const box = $('holdSaved');
    if (!box) return;
    const rows = load();
    if (!rows.length) { box.innerHTML = '<div class="dim">本机还没有持仓数据</div>'; return; }
    let acct = null;
    try { acct = JSON.parse(localStorage.getItem(ACCT_KEY) || 'null'); } catch { /* 忽略 */ }
    let cost = 0, value = 0;
    for (const r of rows) {
      const c = (r.cost ?? 0) * (r.qty ?? 0);
      const v = r.value ?? (r.price ?? r.cost ?? 0) * (r.qty ?? 0);
      cost += c; value += v;
    }
    const pnl = value - cost;
    // 账户层面：这才是「实际损失多大」的正确口径。
    // 个股亏 23% 听着吓人，但仓位只有 45.8%，组合层面相对总资产只亏 11.2%。
    let acctHtml = '';
    if (acct?.assets) {
      const mv = acct.marketValue ?? value;
      acctHtml =
        `<div class="hstat" style="border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:8px">` +
        `<span>总资产 <b>${acct.assets.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b></span>` +
        `<span>仓位 <b>${acct.posPct ?? ((mv / acct.assets) * 100).toFixed(1)}%</b></span>` +
        (acct.cash ? `<span>可用 <b>${acct.cash.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b>（${((acct.cash / acct.assets) * 100).toFixed(1)}%）</span>` : '') +
        (acct.pnl != null ? `<span class="neg">相对总资产 <b>${((acct.pnl / acct.assets) * 100).toFixed(2)}%</b></span>` : '') +
        `</div>`;
    }
    // 行业聚类提示：按「几只股票」数会低估集中度，按业务归类才看得出来。
    // ⚠️ 这里只做事实归类，不给买卖建议。
    const SECT = { 电子特气: ['华特气体', '中船特气'], 锂资源: ['融捷股份', '中矿资源'] };
    let conc = '';
    for (const [sec, names] of Object.entries(SECT)) {
      const rs = rows.filter((r) => names.includes(r.name));
      if (rs.length < 2) continue;
      const v = rs.reduce((s, r) => s + (r.value ?? (r.price ?? 0) * (r.qty ?? 0)), 0);
      conc += `${sec}（${rs.map((r) => r.name).join('+')}）占持仓 <b>${((v / value) * 100).toFixed(1)}%</b>　`;
    }
    if (conc) conc = `<div class="chkbox warnbox">⚠️ <b>按业务归类</b>：${conc}<br><span class="dim">同一赛道的两只股票是<b>同一笔交易</b>，按「几只股票」数会低估集中度。</span></div>`;

    box.innerHTML =
      acctHtml + conc +
      `<div class="hstat"><span>市值 <b>${value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b></span>` +
      `<span>成本 <b>${cost.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b></span>` +
      `<span class="${pnl >= 0 ? 'pos' : 'neg'}">浮动 <b>${pnl >= 0 ? '+' : ''}${pnl.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b>` +
      `（${cost ? ((pnl / cost) * 100).toFixed(2) : '—'}%）</span></div>` +
      `<div class="hrow hhead"><span>代码</span><span>名称</span><span>数量</span><span>成本</span><span>现价</span><span>占比</span></div>` +
      rows
        .map((r) => {
          const v = r.value ?? (r.price ?? r.cost ?? 0) * (r.qty ?? 0);
          const share = value ? ((v / value) * 100).toFixed(1) : '—';
          return `<div class="hrow"><span>${esc(r.code ?? '')}</span><span>${esc(r.name ?? '')}</span><span>${r.qty ?? ''}</span><span>${r.cost ?? ''}</span><span>${r.price ?? ''}</span><span>${share}%</span></div>`;
        })
        .join('') +
      `<button class="hbtn" id="holdClear" type="button">清空本机持仓</button>`;
    const cb = $('holdClear');
    if (cb) cb.addEventListener('click', () => { if (confirm('确定清空本机保存的持仓？')) { localStorage.removeItem(KEY); localStorage.removeItem(ACCT_KEY); renderSaved(); } });
  }

  function wire() {
    const file = $('holdFile');
    const img = $('holdImg');
    if (file && img) {
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        if (!f) return;
        const u = URL.createObjectURL(f);
        img.src = u;
        img.hidden = false;
        const hint = $('holdImgHint');
        if (hint) hint.hidden = false;
      });
    }
    const btn = $('holdParse');
    if (btn) {
      btn.addEventListener('click', () => {
        const ta = $('holdText');
        const r = parse(ta?.value ?? '');
        draft = r.rows;
        draft_checks = r.checks ?? null;
        draft_account = r.account ?? null;
        const modeName = { broker: '券商持仓页（专用识别）', table: '表格列名', scan: '代码扫描', none: '未识别' }[r.mode] ?? r.mode;
        const st = $('holdParseState');
        if (st) st.textContent = r.rows.length ? `解析模式：${modeName} · 识别 ${r.rows.length} 条${draft_account ? ` · 含账户总览（仓位 ${draft_account.posPct}%）` : ''}` : '没有识别到条目 —— 请检查粘贴的文字，或直接用下面的表格手动录入';
        if (!r.rows.length) draft = [{ code: '', name: '', qty: null, cost: null, price: null }];
        renderDraft();
      });
    }
    const add = $('holdAdd');
    if (add) add.addEventListener('click', () => { draft.push({ code: '', name: '', qty: null, cost: null, price: null }); renderDraft(); });
    renderDraft();
    renderSaved();
  }

  // 供测试调用：解析器必须能被单独验证，不能只靠"页面上看着对"
  window.HOLDINGS = { parse, splitCells, KEY, parseAccount, crossCheck, parseBroker };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
