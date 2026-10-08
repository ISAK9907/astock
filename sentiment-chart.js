// 恐慌情绪散点图：左轴 = 情绪分（0~100），右轴 = 乐观指数（= 100 − 情绪分，镜像）。
//   为什么右轴不用重新拟合：情绪分是 50 + 15·Φ⁻¹(p) 构造出来的，天然 N(50,15²)；
//   关于 50 镜像后仍是 N(50,15²)，均值/标准差/偏度/峰度逐项相同，所以两个刻度是同一个分布
//   的两种读法，网格线共用，只是左右读数互为镜像。
//
// 叠加的两条指数线（上证 / 中证2000）为什么用「分位」而不是价格：
//   这张图的纵轴是 0~100 的**位置量**（情绪分本身就是分位映射出来的）。
//   指数是 3800、3000 这样的价格量纲，直接画上去会同时犯两个错：
//   ① 纵轴刻度变成假的（0~100 的网格线读不出价格的任何含义）；
//   ② 两个不同的价格量级（上证 ~3800 / 中证2000 ~3000）之间也没法共用一根轴。
//   所以把每个指数也映射成它在**本窗口内的分位**（0~100），三个量才是同一种东西：
//   「在近三年里处于什么位置」。分位数与价格单调同向，涨跌形状完整保留。
//   代价是：价格的分位曲线在两端会变平（高位横着走），这是分位映射的固有特性，不是 bug。
//   真实价格在悬停卡片和图例里给出，所以读数不受影响。
//
// 交互与 K 线图保持一致：滚轮缩放（以光标为锚点）、拖拽平移、双击复位；触屏用 dzTouch。
// 悬停显示该日的跌停家数（用户明确要求的），另附情绪分、乐观指数与严重度分。
(function () {
  const host = document.getElementById('sentChart');
  if (!host) return;

  const DT = window.DTDATA || {};
  // 只取有情绪分的交易日；DTDATA 的插入顺序就是日期序，但仍显式排序一遍稳妥
  const B = Object.entries(DT)
    .filter(([, v]) => v && v.sent != null)
    .map(([d, v]) => ({ d, sent: v.sent, dt: v.dt ?? 0, score: v.score ?? 0 }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  const N = B.length;
  if (!N) {
    host.innerHTML = '<div class="tiny">暂无情绪数据</div>';
    return;
  }

  // ---------------- 叠加的指数线 ----------------
  // 每条线两个数组：raw = 真实收盘价（悬停/图例用），pos = 窗口内分位（画图用）。
  // 分位用「严格小于的比例 + 相等的一半」算，遇到并列值不会偏向一侧。
  const LINES = (() => {
    const S = window.SENTIDX;
    if (!S?.dates?.length) return [];
    // 日期 → 下标，便于把散点图的日期映射到指数序列上
    const at = new Map(S.dates.map((d, i) => [d, i]));
    const defs = [
      { key: 'sh', name: '上证指数', color: '#f0a24b' },
      { key: 'csi2000', name: '中证2000', color: '#7c8cf8' },
    ];
    const out = [];
    for (const def of defs) {
      const src = S[def.key];
      if (!src) continue;
      const raw = B.map((r) => {
        const i = at.get(r.d);
        return i == null || src[i] == null ? null : src[i];
      });
      if (raw.every((v) => v == null)) continue;
      // 分位：在**整个窗口**的有效样本上算，与缩放无关 —— 缩放时只裁剪不重标
      const valid = raw.filter((v) => v != null);
      const sorted = [...valid].sort((a, b) => a - b);
      const pos = raw.map((v) => {
        if (v == null) return null;
        let lo = 0, hi = 0;
        for (const x of sorted) { if (x < v) lo++; else if (x === v) hi++; }
        return ((lo + hi / 2) / sorted.length) * 100;
      });
      out.push({ ...def, raw, pos });
    }
    return out;
  })();
  const hasLines = LINES.length > 0;
  // 有叠加线时底部要多留一行放图例，否则图例会压住横轴月份
  const LEG = hasLines ? 15 : 0;

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (t, a) => {
    const e = document.createElementNS(NS, t);
    for (const k in a) e.setAttribute(k, a[k]);
    return e;
  };

  const svg = mk('svg', { viewBox: '0 0 500 150' });
  host.appendChild(svg);
  host.style.position = 'relative';
  const tip = document.createElement('div');
  tip.className = 'chtip';
  tip.style.display = 'none';
  host.appendChild(tip);

  const H = hasLines ? 168 : 150;
  // 左右各留 30px 放刻度：左边读恐慌、右边读乐观
  const P = { t: 16, r: 30, b: hasLines ? 36 : 20, l: 30 };
  let W = 500;
  let iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  // 宽度随容器自适应（折叠屏展开/转屏后要重算）
  const clampW = (v) => Math.max(240, Math.min(760, Math.round(v) || 500));
  const MIN_SPAN = 5;

  // 标记日用档位色，和蜡烛图上的标记一致；其余用中性蓝。
  // 门槛挂在**情绪分**上（window.DTTIERS[].minSent，前 5%/3%/1%），不是绝对严重度分。
  const TIERS = window.DTTIERS || [];
  const tierColor = (sent) => {
    if (sent == null) return null;
    for (const t of TIERS) if (sent >= t.minSent) return t.color;
    return null;
  };
  // 乐观侧镜像档位：门槛挂在**乐观指数**上（window.DTTIERS_OPT[].minOptimism）。
  // 与恐慌侧同一分位、不同色相 —— 两侧互斥，先判恐慌再判乐观，一个点只会有一个颜色。
  const TIERS_OPT = window.DTTIERS_OPT || [];
  const optColor = (opt) => {
    if (opt == null) return null;
    for (const t of TIERS_OPT) if (opt >= t.minOptimism) return t.color;
    return null;
  };
  /** 当日颜色：恐慌档 > 乐观档 > 中性蓝 */
  const dotColor = (sent) => tierColor(sent) || optColor(100 - sent) || '#5b8def';

  let i0 = 0;
  let i1 = N;
  let hover = -1;
  let mouse = null;
  let dragging = false;
  let lastPx = 0;

  // 每个分组打上 data-g 标记：测试与后续维护都按标记找，不靠下标 ——
  // 之前加了「指数线」分组，下标整体后移，靠下标的测试立刻读错分组。
  const gGrid = mk('g', { 'data-g': 'grid' });
  const gLines = mk('g', { 'data-g': 'lines' }); // 指数线画在散点**下面**，免得盖住标记日的高亮
  const gDots = mk('g', { 'data-g': 'dots' });
  const gHover = mk('g', { 'data-g': 'hover' });
  const gX = mk('g', { 'data-g': 'xaxis' });
  const gLeg = mk('g', { 'data-g': 'legend' });
  svg.appendChild(gGrid);
  svg.appendChild(gLines);
  svg.appendChild(gDots);
  svg.appendChild(gHover);
  svg.appendChild(gX);
  svg.appendChild(gLeg);

  const yOf = (v) => P.t + ih - (v / 100) * ih;
  const xOf = (i, span) => P.l + ((i - i0) / span) * iw;

  function clampRange() {
    if (i0 < 0) { i1 -= i0; i0 = 0; }
    if (i1 > N) { i0 -= i1 - N; i1 = N; }
    if (i0 < 0) i0 = 0;
    if (i1 - i0 < MIN_SPAN) {
      const mid = (i0 + i1) / 2;
      i0 = mid - MIN_SPAN / 2;
      i1 = mid + MIN_SPAN / 2;
      if (i0 < 0) { i1 -= i0; i0 = 0; }
      if (i1 > N) { i0 -= i1 - N; i1 = N; }
    }
  }

  function render() {
    const nw = clampW(svg.clientWidth);
    if (nw !== W) { W = nw; iw = W - P.l - P.r; }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    clampRange();
    const span = i1 - i0;
    const a = Math.max(0, Math.floor(i0));
    const b = Math.min(N - 1, Math.ceil(i1));

    // ---- 网格与纵轴刻度（0~100 固定，与刻度条同一量纲）----
    // 左轴读「情绪分」，右轴读「乐观指数 = 100 − 情绪分」，共用同一批网格线（互为镜像）。
    gGrid.textContent = '';
    for (const v of [0, 25, 50, 75, 100]) {
      const y = yOf(v);
      gGrid.appendChild(mk('line', {
        x1: P.l, x2: W - P.r, y1: y, y2: y,
        stroke: v === 50 ? '#39414f' : '#2a3140', 'stroke-width': v === 50 ? 0.8 : 0.5,
        'stroke-dasharray': v === 50 ? 'none' : '2 3',
      }));
      const tx = mk('text', { x: P.l - 4, y: y + 3, fill: '#7b8698', 'font-size': '8.5', 'text-anchor': 'end' });
      tx.textContent = v;
      gGrid.appendChild(tx);
      // 右轴：同一个 y 上的镜像读数
      const rx = mk('text', { x: W - P.r + 4, y: y + 3, fill: '#4fb3c8', 'font-size': '8.5', 'text-anchor': 'start' });
      rx.textContent = 100 - v;
      gGrid.appendChild(rx);
    }
    // 轴名：不写的话两个数字列容易看混（左侧数字越大越恐慌，右侧越大越乐观）
    const capL = mk('text', { x: P.l, y: P.t - 6, fill: '#7b8698', 'font-size': '8.5', 'text-anchor': 'start' });
    capL.textContent = '恐慌情绪';
    gGrid.appendChild(capL);
    const capR = mk('text', { x: W - P.r, y: P.t - 6, fill: '#4fb3c8', 'font-size': '8.5', 'text-anchor': 'end' });
    capR.textContent = '乐观指数';
    gGrid.appendChild(capR);

    // ---- 指数线（画在散点之下）----
    // 只画可见区间；分位是在整个窗口上算好的，所以缩放时线只被裁剪、不会被重新拉伸，
    // 不会出现「放大后噪声被放大成剧烈波动」的错觉。
    gLines.textContent = '';
    if (hasLines) {
      for (const L of LINES) {
        let seg = [];
        const flush = () => {
          if (seg.length > 1) {
            gLines.appendChild(mk('polyline', {
              points: seg.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
              fill: 'none', stroke: L.color, 'stroke-width': 1.15,
              'stroke-linejoin': 'round', opacity: 0.9,
            }));
          }
          seg = [];
        };
        for (let i = a; i <= b; i++) {
          const p = L.pos[i];
          if (p == null) { flush(); continue; } // 缺数据的日期断开，不要连成假线
          seg.push([xOf(i, span), yOf(p)]);
        }
        flush();
        // 末日一个小端点，方便一眼看出线画到哪
        const lastI = (() => { for (let i = b; i >= a; i--) if (L.pos[i] != null) return i; return -1; })();
        if (lastI >= 0) {
          gLines.appendChild(mk('circle', { cx: +xOf(lastI, span).toFixed(2), cy: +yOf(L.pos[lastI]).toFixed(2), r: 2, fill: L.color }));
        }
      }
    }

    // ---- 散点 ----
    gDots.textContent = '';
    for (let i = a; i <= b; i++) {
      const r = B[i];
      const c = dotColor(r.sent);
      const hit = c !== '#5b8def';
      gDots.appendChild(mk('circle', {
        cx: +xOf(i, span).toFixed(2), cy: +yOf(r.sent).toFixed(2),
        r: hit ? 2.8 : 1.7, fill: c, opacity: hit ? 1 : 0.7,
      }));
    }

    // ---- 横轴：按自然月标注，1 月显示年份后两位 ----
    // 不能按索引均匀取点：那会落在月中，三年里可能一次都碰不到 1 月，年份就没法读。
    // 改成落在每个月的首个交易日上，并让 1 月优先占位（它承担年份信息），其余月份在空隙够时补。
    gX.textContent = '';
    const a0 = Math.max(0, Math.ceil(i0));
    const a1 = Math.min(N - 1, Math.floor(i1));
    const monthIdx = [];
    let lastYm = '';
    for (let i = a0; i <= a1; i++) {
      const ym = B[i].d.slice(0, 7);
      if (ym !== lastYm) { lastYm = ym; monthIdx.push(i); }
    }
    const labelOf = (d) => (d.slice(5, 7) === '01' ? d.slice(2, 4) : d.slice(5, 7)); // 1 月→年份后两位
    const minGap = 22; // 标签最小间距（像素），太挤就跳过该月
    const jan = monthIdx.filter((i) => B[i].d.slice(5, 7) === '01');
    const rest = monthIdx.filter((i) => B[i].d.slice(5, 7) !== '01');
    const chosen = [...jan];
    for (const i of rest) {
      const x = xOf(i, span);
      if (chosen.every((j) => Math.abs(xOf(j, span) - x) >= minGap)) chosen.push(i);
    }
    chosen.sort((p, q) => p - q);
    chosen.forEach((i, k) => {
      const d = B[i].d;
      const x = xOf(i, span);
      const isJan = d.slice(5, 7) === '01';
      const attrs = {
        x: +x.toFixed(1), y: H - LEG - 5, 'font-size': '8.5',
        'text-anchor': k === 0 ? 'start' : k === chosen.length - 1 ? 'end' : 'middle',
      };
      // 年份标签走 CSS 类（标红加粗），这样亮色主题能另配一套颜色；
      // SVG 的表现属性优先级低于 CSS 规则，所以主题覆盖放在 CSS 里。
      if (isJan) attrs.class = 'xyear';
      else { attrs.fill = '#7b8698'; attrs['font-weight'] = '400'; }
      const tx = mk('text', attrs);
      tx.textContent = labelOf(d);
      gX.appendChild(tx);
    });

    // ---- 图例：指数线的颜色 / 名称 / 最后一次可见的收盘价与分位 ----
    // 读数跟着可见区间走（缩放后看到的就是那一段末值），真实价格始终给出，
    // 所以分位映射没有牺牲可读性。
    gLeg.textContent = '';
    if (hasLines) {
      const compact = W < 400; // 窄屏只留色块和数值，省掉指数名
      const ly = H - 4;
      let lx = P.l;
      for (const L of LINES) {
        let li = -1;
        for (let i = b; i >= a; i--) if (L.pos[i] != null) { li = i; break; }
        if (li < 0) continue;
        gLeg.appendChild(mk('line', { x1: lx, x2: lx + 10, y1: ly - 3, y2: ly - 3, stroke: L.color, 'stroke-width': 1.8 }));
        const label = `${compact ? '' : L.name + ' '}${Math.round(L.raw[li])}（分位 ${Math.round(L.pos[li])}）`;
        const t = mk('text', { x: lx + 13, y: ly, 'font-size': '8.5', fill: '#9aa4b2' });
        t.textContent = label;
        gLeg.appendChild(t);
        // 中文按全宽、其余按半宽估宽（SVG 里取不到 textWidth，只能估）
        let wpx = 0;
        for (const ch of label) wpx += ch.charCodeAt(0) > 255 ? 8.6 : 4.7;
        lx += 13 + wpx + 12;
      }
    }
    drawHover();
  }

  function drawHover() {
    gHover.textContent = '';
    if (hover < 0 || hover >= N) { tip.style.display = 'none'; return; }
    const r = B[hover];
    const span = i1 - i0;
    const x = xOf(hover, span);
    const y = yOf(r.sent);
    const c = dotColor(r.sent);
    const opt = 100 - r.sent;
    const cOpt = optColor(opt);
    gHover.appendChild(mk('line', { x1: x, x2: x, y1: P.t, y2: P.t + ih, stroke: c, 'stroke-width': 0.8, 'stroke-dasharray': '2 3', opacity: 0.85 }));
    gHover.appendChild(mk('circle', { cx: x, cy: y, r: 4.2, fill: 'none', stroke: '#fff', 'stroke-width': 1.3 }));

    tip.innerHTML =
      `<div class="h">${r.d}</div>` +
      `<div><i style="background:${c}"></i><span class="n">情绪分</span><b>${r.sent.toFixed(1)}</b></div>` +
      `<div><i style="background:${cOpt || '#4fb3c8'}"></i><span class="n">乐观指数</span><b>${opt.toFixed(1)}</b></div>` +
      `<div><i style="background:#ef4d5a"></i><span class="n">跌停家数</span><b>${r.dt}</b></div>` +
      `<div><i style="background:#39414f"></i><span class="n">严重度分</span><b>${r.score}</b></div>` +
      // 叠加的指数：给出真实收盘价 + 窗口内分位（分位才是图上那条线的纵坐标）
      LINES.map((L) => {
        const v = L.raw[hover];
        return v == null
          ? ''
          : `<div><i style="background:${L.color}"></i><span class="n">${L.name}</span><b>${v.toFixed(2)}</b>` +
            `<span class="n" style="margin-left:4px">分位 ${Math.round(L.pos[hover])}</span></div>`;
      }).join('');
    tip.style.display = '';
    tip.style.left = '0px';
    tip.style.top = '0px';

    // 跟随鼠标：优先放在光标右上方，越界就翻到另一侧，始终不压住点
    if (mouse) {
      const hr = host.getBoundingClientRect();
      const mx = mouse.ex - hr.left;
      const my = mouse.ey - hr.top;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let left = mx + 14;
      if (left + tw > hr.width - 2) left = mx - tw - 14;
      if (left < 2) left = 2;
      let top = my - th - 12;
      if (top < 2) top = my + 16;
      if (top + th > hr.height - 2) top = Math.max(2, hr.height - th - 2);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }
  }

  // ---------------- 鼠标 ----------------
  const coords = (e) => {
    const r = svg.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * W, py: ((e.clientY - r.top) / r.height) * H };
  };
  const idxAt = (px) => {
    const span = i1 - i0;
    return Math.min(Math.max(Math.round(i0 + ((px - P.l) / iw) * span), 0), N - 1);
  };

  svg.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const { px, py } = coords(e);
    const inside = px >= P.l - 6 && px <= W - P.r + 6 && py >= P.t - 6 && py <= P.t + ih + 6;
    if (inside) {
      // 同一 x 上取纵向最近的点，避免点多时选错
      const guess = idxAt(px);
      let best = guess;
      let bestD = Math.abs(yOf(B[guess].sent) - py);
      for (const j of [guess - 1, guess + 1]) {
        if (j < 0 || j >= N) continue;
        const d = Math.abs(yOf(B[j].sent) - py);
        if (d < bestD) { bestD = d; best = j; }
      }
      hover = best;
      mouse = { ex: e.clientX, ey: e.clientY };
    } else {
      hover = -1;
    }
    drawHover();
  });
  svg.addEventListener('mouseleave', () => { hover = -1; mouse = null; drawHover(); });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { px } = coords(e);
    const cx = Math.min(Math.max(px, P.l), W - P.r);
    const span = i1 - i0;
    const anchor = i0 + ((cx - P.l) / iw) * span;
    const f = Math.exp(e.deltaY * 0.0015);
    const a2 = anchor - (anchor - i0) * f;
    const b2 = anchor + (i1 - anchor) * f;
    if (b2 - a2 < MIN_SPAN) return;
    i0 = a2; i1 = b2;
    render();
  }, { passive: false });

  svg.addEventListener('mousedown', (e) => {
    dragging = true;
    lastPx = e.clientX;
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; svg.style.cursor = ''; } });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const r = svg.getBoundingClientRect();
    const dx = ((e.clientX - lastPx) / r.width) * W;
    lastPx = e.clientX;
    const span = i1 - i0;
    const dIdx = (-dx / iw) * span;
    i0 += dIdx; i1 += dIdx;
    render();
  });
  svg.addEventListener('dblclick', () => { i0 = 0; i1 = N; render(); });

  // ---------------- 触屏 ----------------
  if (window.dzTouch) {
    window.dzTouch(svg, {
      onPan(dx) {
        const r = svg.getBoundingClientRect();
        const span = i1 - i0;
        const dIdx = (-((dx / r.width) * W) / iw) * span;
        i0 += dIdx; i1 += dIdx;
        render();
      },
      onPinch(ratio, cx) {
        const r = svg.getBoundingClientRect();
        const px = ((cx - r.left) / r.width) * W;
        const span = i1 - i0;
        const anchor = i0 + ((Math.min(Math.max(px, P.l), W - P.r) - P.l) / iw) * span;
        const f = 1 / ratio;
        let a = anchor - (anchor - i0) * f;
        let b = anchor + (i1 - anchor) * f;
        if (b - a < MIN_SPAN) return;
        i0 = a; i1 = b;
        clampRange();
        render();
      },
      onDoubleTap() { i0 = 0; i1 = N; render(); },
    });
  }

  let rz = null;
  const later = () => { clearTimeout(rz); rz = setTimeout(render, 180); };
  window.addEventListener('resize', later);
  window.addEventListener('orientationchange', later);
  // 面板可被隐藏/显示（panels.js），隐藏期间 clientWidth 为 0，显示后要重算宽度
  if (window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver(() => {
      if (host.clientWidth !== lastW) { lastW = host.clientWidth; later(); }
    }).observe(host);
  }

  render();
})();
