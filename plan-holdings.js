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
  // 公开的持仓快照文件名（不显眼命名，但仓库里可见 —— 见 deploy-pages.mjs 的说明）
  const PUB_FILE = 'pa7k3f.json';
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
    // ⚠️ 分隔符要容忍两种：券商 App 用「总资产：547,957.91」，而手机「提取文字」常给成
    //    「总资产 547,957.91」（标签和数字之间只剩空格）。只认冒号会整块读不到 —— 实测踩到。
    const pick = (re) => { const m = re.exec(text); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
    const SEP = '[：:]\\s*|\\s+';
    const acct = {
      assets: pick(new RegExp('总资产(?:' + SEP + ')([\\d,]+\\.?\\d*)')),
      marketValue: pick(new RegExp('总市值(?:' + SEP + ')([\\d,]+\\.?\\d*)')),
      pnl: pick(new RegExp('浮动盈亏(?:' + SEP + ')(-?[\\d,]+\\.?\\d*)')),
      cash: pick(new RegExp('可用(?:' + SEP + ')([\\d,]+\\.?\\d*)')),
      posPct: pick(new RegExp('仓位(?:' + SEP + ')([\\d.]+)%')),
    };
    return Object.values(acct).some((v) => v != null) ? acct : null;
  }

  // ==================== 顺序模式：两行一只 / 按列纵向 ====================
  // 为什么需要：银河证券持仓页是**一只股票占两行**的版式（名称+市值同一列上下两行，
  // 持仓/可用、成本/现价也各占上下两行）。手机「提取文字」会按它自己的顺序把单元格吐出来，
  // 常见有两种：① 按视觉行（两行一只）② 按列纵向（每格一行）。两者**数字顺序不同**。
  //
  // 与其赌用户手机上跑的是哪种，不如**用数据自身的冗余去反推**：
  //   各股市值之和必须等于账户总市值，各股盈亏之和必须等于浮动盈亏。
  // 把两种候选顺序都试一遍，谁对得上就用谁。对不上就按最可能的那种输出并**明确报警**，
  // 让用户在确认表里改 —— 绝不静默选一个。
  //
  // ⚠️ 这两个模板是**银河证券持仓页**的字段顺序，写死在这里。换券商要重录。
  const TEMPLATES = {
    // ① 按视觉行（一行是「名称 盈亏 持仓 成本 当日盈亏 天数」，下一行是「市值 仓位% 盈亏% 可用 现价 当日%」）
    视觉行: ['pnl', 'qty', 'cost', 'dayPnl', 'days', 'value', 'posPct', 'pnlpct', 'avail', 'price', 'dayPct'],
    // ② 按列纵向（名称之后依次是：市值 仓位% 盈亏 盈亏% 持仓 可用 成本 现价 当日盈亏 当日% 天数）
    列纵向: ['value', 'posPct', 'pnl', 'pnlpct', 'qty', 'avail', 'cost', 'price', 'dayPnl', 'dayPct', 'days'],
  };

  /** 一行里抽出所有数字（带千分位/百分号/正负号），返回原始字符串数组 */
  const tokens = (line) => (line.match(/-?[\d,]+(?:\.\d+)?%?/g) ?? []).filter((x) => /\d/.test(x));
  const toNum = (s) => parseFloat(String(s).replace(/[%,]/g, ''));

  function parseStacked(text, account) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // 用「含中文且不含数字」的行当切分点 —— 那是股票名（如「华特气体」）
    // 切分点 = 「行首是名字」的那一行。
    // ⚠️ 不能用「整行不含数字」当条件：截图版式里名字和数字在**同一行**
    //    （「华特气体 -29,667.85 900 147.874 999.00 41」），那样一条都切不出来 —— 实测踩到。
    //    改成：取行首那个不含数字的 token 当股票名，行内其余数字归入本块。
    const nameOf = (l) => {
      const first = l.split(/\s+/)[0] ?? '';
      return first.length >= 2 && first.length <= 12 && !/\d/.test(first) && /[\u4e00-\u9fa5A-Za-z]/.test(first) ? first : null;
    };
    const blocks = [];
    let cur = null;
    for (const l of lines) {
      const nm = nameOf(l);
      if (nm) { if (cur) blocks.push(cur); cur = { name: nm, nums: tokens(l.slice(nm.length)) }; continue; }
      if (cur) cur.nums.push(...tokens(l));
    }
    if (cur) blocks.push(cur);
    // 只保留「数字个数刚好够一个模板」的块（多退少补都会错位）
    const need = Object.values(TEMPLATES)[0].length;
    const usable = blocks.filter((b) => b.nums.length === need);
    if (!usable.length) return null;

    // 用账户总览的冗余挑模板：谁算出来的合计对得上就用谁
    const fits = (tpl) => {
      let sv = 0, sp = 0;
      for (const b of usable) {
        const o = {};
        tpl.forEach((k, i) => { o[k] = toNum(b.nums[i]); });
        sv += o.value ?? 0;
        sp += o.pnl ?? 0;
      }
      const okV = account?.marketValue ? Math.abs(sv - account.marketValue) <= Math.max(1, account.marketValue * 0.005) : null;
      const okP = account?.pnl != null ? Math.abs(sp - account.pnl) <= Math.max(1, Math.abs(account.pnl) * 0.005) : null;
      return { okV, okP, score: (okV === true ? 1 : 0) + (okP === true ? 1 : 0), sv, sp };
    };
    const scored = Object.entries(TEMPLATES).map(([name, tpl]) => ({ name, tpl, fit: fits(tpl) }));
    const best = scored.sort((a, b) => b.fit.score - a.fit.score)[0];
    const rows = usable.map((b) => {
      const o = {};
      best.tpl.forEach((k, i) => { o[k] = toNum(b.nums[i]); });
      return {
        code: null, name: b.name,
        qty: o.qty ?? null, avail: o.avail ?? null,
        cost: o.cost ?? null, price: o.price ?? null,
        value: o.value ?? null, posPct: o.posPct ?? null,
        pnl: o.pnl ?? null, pnlpct: o.pnlpct ?? null,
        dayPnl: o.dayPnl ?? null, dayPct: o.dayPct ?? null,
        raw: b.nums.join(' '),
      };
    });
    return { rows, templateUsed: best.name, allFits: scored.map((s) => ({ name: s.name, ...s.fit })) };
  }

  /**
   * 集中度纪律检查。抽成独立函数是为了**能单独测试** ——
   * 这是页面上少数不依赖估值假设、纯算术的判断，必须算准。
   *
   * 为什么个股这块只做集中度、不做估值价格线：
   *   这几只是周期股（电子特气跟半导体资本开支、锂跟碳酸锂价格），它们的 PE 是反的 ——
   *   盈利崩塌时 PE 反而高、景气顶点 PE 反而低。拿「PE 分位越低越便宜」去套会把周期读反。
   *   而集中度是纯算术，不依赖任何估值口径，也不依赖预测。
   */
  function checkConcentration(rows, limits) {
    const L = { maxSingle: 30, maxSector: 40, ...(limits ?? {}) };
    const val = (r) => r.value ?? (r.price ?? r.cost ?? 0) * (r.qty ?? 0);
    const value = rows.reduce((s, r) => s + val(r), 0);
    const violations = [];
    for (const r of rows) {
      const share = value ? (val(r) / value) * 100 : 0;
      if (share > L.maxSingle) violations.push({ kind: 'single', name: r.name, share: +share.toFixed(1), limit: L.maxSingle });
    }
    const bySector = new Map();
    for (const r of rows) {
      const sec = String(r.sector ?? '').trim();
      if (!sec) continue;
      if (!bySector.has(sec)) bySector.set(sec, { v: 0, names: [] });
      const o = bySector.get(sec);
      o.v += val(r);
      o.names.push(r.name);
    }
    const sectors = [...bySector.entries()]
      .map(([sec, o]) => ({ sector: sec, names: o.names, value: +o.v.toFixed(2), share: value ? +((o.v / value) * 100).toFixed(1) : 0 }))
      .sort((a, b) => b.share - a.share);
    for (const s of sectors) if (s.share > L.maxSector) violations.push({ kind: 'sector', name: s.sector, names: s.names, share: s.share, limit: L.maxSector });
    return { value: +value.toFixed(2), violations, sectors, untagged: rows.filter((r) => !String(r.sector ?? '').trim()).length, limits: L };
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
    // 顺序模式排在通用表头模式**之前**：截图版式下通用模式一条都认不出来，
    // 而顺序模式能，且带自校验与模板判定。
    const stacked = parseStacked(text, account);
    if (stacked) {
      return { mode: 'stacked', rows: stacked.rows, account, checks: crossCheck(stacked.rows, account), templateUsed: stacked.templateUsed, allFits: stacked.allFits };
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
      `<div class="hrow hhead" style="grid-template-columns:1fr 62px 52px 56px 56px 24px"><span>名称</span><span>赛道</span><span>数量</span><span>成本</span><span>现价</span><span></span></div>` +
      draft
        .map(
          (r, i) =>
            `<div class="hrow" style="grid-template-columns:1fr 62px 52px 56px 56px 24px">` +
            `<input data-i="${i}" data-f="name" value="${esc(r.name ?? '')}" placeholder="名称">` +
            `<input data-i="${i}" data-f="sector" value="${esc(r.sector ?? '')}" placeholder="赛道">` +
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
        r[f] = f === 'name' || f === 'code' || f === 'sector' ? el.value.trim() : num(el.value);
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
      document.dispatchEvent(new CustomEvent('astock:changed'));
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
    // ---------------- 集中度纪律 ----------------
    // 为什么这个比个股价格线更重要：对这几只周期股，PE（甚至 PB）分位都不可靠 ——
    // 周期股的盈利和净资产都在剧烈波动，「和自己的历史比」会把周期底部读成贵、顶部读成便宜。
    // 但**集中度是纯算术**，不依赖任何估值假设，也不依赖预测。所以个股这块只做集中度与纪律。
    //
    // 阈值是**你的纪律，可改**。默认值是我给的起点，不是我的判断。
    const C = checkConcentration(rows);
    const CONC = C.limits;
    const violations = C.violations.map((v) =>
      v.kind === 'single'
        ? `单一标的 <b>${esc(v.name)}</b> 占持仓 ${v.share}% > 上限 ${v.limit}%`
        : `赛道 <b>${esc(v.name)}</b>（${v.names.map(esc).join('+')}）占持仓 ${v.share}% > 上限 ${v.limit}%`,
    );
    const sectorRows = C.sectors.map((s) => [s.sector, { v: s.value, names: s.names }]);
    const untagged = C.untagged;

    let concHtml = '';
    if (violations.length) {
      concHtml =
        `<div class="chkbox bad"><b>⚠️ 集中度纪律：${violations.length} 项超限</b><br>` +
        violations.join('<br>') +
        `<br><span class="dim">这是纯算术，不依赖任何估值判断或预测。上限是可改的规则（单一标的 ${CONC.maxSingle}% / 单一赛道 ${CONC.maxSector}%）。</span></div>`;
    } else if (sectorRows.length) {
      concHtml = `<div class="chkbox good">✓ 集中度纪律：没有超限项</div>`;
    }
    if (untagged) {
      concHtml +=
        `<div class="chkbox warnbox">有 <b>${untagged}</b> 只标的没填赛道 —— <b>赛道集中度算不出来</b>。<br>` +
        `<span class="dim">同一赛道的两只股票其实是<b>同一笔交易</b>，按「几只股票」数会系统性低估集中度。` +
        `点上面「解析」重新贴一次，或手动给每只在「赛道」列填一个名字（如「电子特气」「锂资源」）。</span></div>`;
    }
    if (sectorRows.length) {
      concHtml += `<div class="hstat" style="font-size:11.5px">按赛道：` +
        sectorRows.map(([sec, o]) => `${esc(sec)} <b>${((o.v / value) * 100).toFixed(1)}%</b>`).join('　') + `</div>`;
    }

    box.innerHTML =
      acctHtml + concHtml +
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

  // 「从电脑同步」：手机连家里 WiFi、且从局域网地址打开时，拉电脑上的 holdings.local.json。
  // ⚠️ 为什么走局域网而不是云端：这个仓库是**公开**的，持仓上去就等于公开仓位。
  //    代价：从公网（GitHub Pages）打开时同步不了 —— 所以下面 catch 里要把这句话说清楚，
  //    而不是静默失败（用户上一次的感受就是「没同步，也没告诉我为什么」）。
  async function tryLanSync() {
    const box = $('holdSync');
    if (!box) return;
    try {
      // 先试公网那份（用户已同意公开），再退回局域网那份（本机私有版）。
      // 两份内容一样；公网那份随页面发布，所以任何网络下都能同步。
      let r = await fetch(PUB_FILE, { cache: 'no-store' });
      if (!r.ok) r = await fetch('holdings.local.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j?.holdings?.length) throw new Error('文件里没有持仓');
      box.innerHTML =
        `<button class="hbtn primary" id="holdSyncBtn" type="button">同步持仓 ${j.holdings.length} 条</button>` +
        `<div class="dim" style="margin-top:6px;font-size:11.5px">快照：${esc(j.source ?? '电脑')} · 更新于 ${esc(String(j.updatedAt ?? '').slice(0, 16).replace('T', ' '))} · 会覆盖本机已存的持仓</div>`;
      const btn = $('holdSyncBtn');
      if (btn) btn.addEventListener('click', () => {
        save(j.holdings);
        if (j.account) localStorage.setItem(ACCT_KEY, JSON.stringify(j.account));
        renderSaved();
        box.innerHTML = `<div class="chkbox good">✓ 已同步 ${j.holdings.length} 条持仓（快照日 ${esc(String(j.updatedAt ?? '').slice(0, 10))}）</div>`;
      });
    } catch {
      box.innerHTML =
        '<div class="dim" style="font-size:11.5px;line-height:1.75">' +
        '取不到持仓快照 —— 可能是电脑上的局域网服务没开、或该文件还没发布。<br>' +
        '你也可以在下面直接粘贴持仓文字来导入。' +
        '</div>';
    }
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
    tryLanSync();
  }

  // 供测试调用：解析器必须能被单独验证，不能只靠"页面上看着对"
  window.HOLDINGS = { parse, splitCells, KEY, parseAccount, crossCheck, parseBroker, checkConcentration, parseStacked, TEMPLATES };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
