// 三大指数：累计涨跌幅 + 每日归零，两张上下并列的图，共享缩放 / 拖动 / 准线
// 由 build-dashboard.mjs 内联进生成的 HTML；依赖全局 window.INTRA
//   window.INTRA = { days, grid, slotTimes, series:[{key,name,color,points:[[gx, rawPx]]}] }
// 归一化在前端做：累计 = 相对窗口首点；每日归零 = 相对当日首个有效点。
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // 联动总线（crosshair.js 复用同一个）
  const bus = (window.__LINK__ = window.__LINK__ || (() => {
    const subs = [];
    return {
      on(fn) { subs.push(fn); },
      emit(src, label) { for (const f of subs) { try { f(label, src); } catch (_) {} } },
    };
  })());
  const SELF = 'intraday';

  const D = window.INTRA;
  if (!D) return;

  // ⚠️ W 必须随容器宽度自适应：固定 1040 在手机内屏（~380px）上会被整体缩到 0.37 倍，
  //    10px 的字变成 3.7px 根本没法看。让 1 viewBox 单位 ≈ 1 CSS 像素，字号才是标称大小。
  let W = 1040;
  const H = 240, P = { t: 20, r: 56, b: 34, l: 50 };
  let iw = W - P.l - P.r, ih = H - P.t - P.b;
  const clampW = (v) => Math.max(300, Math.min(1040, Math.round(v) || 1040));
  const GP = D.grid;
  const TOTAL = D.days.length * GP;
  const MIN_SPAN = 12;

  const maps = D.series.map((s) => new Map(s.points));
  const baseWin = D.series.map((s) => s.points[0][1]);
  const baseDay = D.series.map((s) => {
    const m = new Map();
    for (const [gx, px] of s.points) {
      const d = Math.floor(gx / GP);
      if (!m.has(d)) m.set(d, px);
    }
    return m;
  });

  const dayOf = (gx) => Math.floor(gx / GP);
  const dayLabel = (i) => {
    const d = D.days[i];
    return d ? `${d.slice(4, 6)}-${d.slice(6)}` : null;
  };
  function slotLabel(gx) {
    const day = dayOf(gx);
    const slot = gx - day * GP;
    const t = D.slotTimes[slot] ?? '';
    const d = D.days[day] ?? '';
    return `${d.slice(4, 6)}/${d.slice(6)} ${t.slice(0, 2)}:${t.slice(2)}`;
  }
  const mk = (tag, attrs, text) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  };

  /** 原始价 → 显示值（%），mode: 'cum' 累计 | 'day' 每日归零 */
  function norm(si, gx, px, mode) {
    const base = mode === 'day' ? baseDay[si].get(dayOf(gx)) : baseWin[si];
    if (!base) return null;
    return (px / base - 1) * 100;
  }
  function valAt(si, gx, mode) {
    const m = maps[si];
    let x = gx, px = m.get(x);
    if (px === undefined) {
      for (let d = 1; d <= 6; d++) {
        if (m.has(x - d)) { px = m.get(x - d); x = x - d; break; }
        if (m.has(x + d)) { px = m.get(x + d); x = x + d; break; }
      }
    }
    return px === undefined ? null : norm(si, x, px, mode);
  }

  // ---------------- 两张图共享的状态 ----------------
  let xMin = 0, xMax = TOTAL;
  let hover = null;     // { gx, py, inst }
  let linkLabel = null; // 其他图广播过来的日期
  let dragging = false, lastX = 0;
  const insts = [];

  const CFG = [
    { id: 'intraSvgCum', mode: 'cum', title: '累计涨跌幅', from: D.days[0], to: D.days.at(-1), extremes: true },
    { id: 'intraSvgDay', mode: 'day', title: '每日归零', from: null, to: null, extremes: false },
  ];

  function renderAll() {
    // 先按容器宽度重算视图宽度（折叠屏展开/折叠后会变）
    const ref = insts[0]?.svg;
    if (ref) {
      const cw = ref.clientWidth;
      const nw = clampW(cw);
      if (nw !== W) { W = nw; iw = W - P.l - P.r; }
      for (const it of insts) it.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    for (const it of insts) it.render();
  }

  for (const cfg of CFG) {
    const svg = document.getElementById(cfg.id);
    if (!svg) continue;
    const inst = {
      svg,
      mode: cfg.mode,
      cfg,
      view: null,
      cross: null,
      linkG: null,
      hovering: false, // 鼠标是否正压在本图上（决定横线与数值气泡画在哪张）
    };
    insts.push(inst);

    inst.buildCross = function () {
      const g = document.createElementNS(NS, 'g');
      const vLine = mk('line', { stroke: '#8b96a8', 'stroke-dasharray': '3 3' });
      const hLine = mk('line', { stroke: '#8b96a8', 'stroke-dasharray': '3 3' });
      const tBg = mk('rect', { fill: '#2b3446', rx: '3' });
      const tTx = mk('text', { fill: '#dfe6f2', 'font-size': '10', 'text-anchor': 'middle' });
      const vBg = mk('rect', { fill: '#2b3446', rx: '3', stroke: '#4a5568' });
      const vTx = mk('text', { fill: '#dfe6f2', 'font-size': '10', 'text-anchor': 'end' });
      const dots = D.series.map((s) => mk('circle', { r: '3', fill: s.color, stroke: '#141821', 'stroke-width': '1' }));
      g.append(vLine, hLine, tBg, tTx, vBg, vTx, ...dots);
      g.style.display = 'none';
      return { g, vLine, hLine, tBg, tTx, vBg, vTx, dots, yticks: [...svg.querySelectorAll('.ytick')] };
    };

    inst.drawCross = function () {
      const cross = inst.cross, view = inst.view;
      if (!cross || !view) return;
      const { g, vLine, hLine, tBg, tTx, vBg, vTx, dots, yticks } = cross;
      for (const t of yticks) t.style.display = '';
      if (!hover) { g.style.display = 'none'; return; }
      const { xOf, yOf, minV, maxV } = view;
      const { gx, py } = hover;

      const cx = xOf(gx);
      g.style.display = '';
      // 竖线 + 时间气泡：两张图都画（共享同一时刻）
      vLine.setAttribute('x1', cx); vLine.setAttribute('x2', cx);
      vLine.setAttribute('y1', P.t); vLine.setAttribute('y2', P.t + ih);
      const label = slotLabel(gx);
      tTx.textContent = label;
      const tw = label.length * 6.2 + 10;
      tBg.setAttribute('x', cx - tw / 2); tBg.setAttribute('y', P.t + ih + 2);
      tBg.setAttribute('width', tw); tBg.setAttribute('height', 13);
      tTx.setAttribute('x', cx); tTx.setAttribute('y', P.t + ih + 12);

      // 横线 + 左轴数值气泡 + 圆点：只画在鼠标所在的那张图（纵坐标是各图自己的）
      const onThis = hover.inst === inst;
      hLine.style.display = onThis ? '' : 'none';
      vBg.style.display = onThis ? '' : 'none';
      vTx.style.display = onThis ? '' : 'none';
      if (onThis) {
        const cy = Math.min(Math.max(py, P.t), P.t + ih);
        hLine.setAttribute('y1', cy); hLine.setAttribute('y2', cy);
        hLine.setAttribute('x1', P.l); hLine.setAttribute('x2', W - P.r);
        const val = minV + ((P.t + ih - cy) / ih) * (maxV - minV);
        const vtxt = `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
        vTx.textContent = vtxt;
        const vw = vtxt.length * 6.2 + 10;
        vBg.setAttribute('x', P.l - vw + 3); vBg.setAttribute('y', cy - 6.5);
        vBg.setAttribute('width', vw); vBg.setAttribute('height', 13);
        vTx.setAttribute('x', P.l - 1); vTx.setAttribute('y', cy + 3.5);
        let near = null, nd = Infinity;
        for (const t of yticks) {
          const d = Math.abs(+t.dataset.py - cy);
          if (d < nd) { nd = d; near = t; }
        }
        if (near && nd < 9) near.style.display = 'none';
      } else {
        for (const t of yticks) t.style.display = '';
      }

      D.series.forEach((s, k) => {
        const y = valAt(k, gx, inst.mode);
        if (y == null) { dots[k].style.display = 'none'; return; }
        dots[k].style.display = '';
        dots[k].setAttribute('cx', xOf(gx));
        dots[k].setAttribute('cy', yOf(y));
      });
    };

    inst.drawLink = function () {
      if (!inst.linkG) return;
      const i = linkLabel ? D.days.findIndex((d) => `${d.slice(4, 6)}-${d.slice(6)}` === linkLabel) : -1;
      if (i < 0 || !inst.view) { inst.linkG.style.display = 'none'; return; }
      const a = i * GP, b = a + GP;
      const xa = Math.max(inst.view.xOf(a), P.l), xb = Math.min(inst.view.xOf(b), W - P.r);
      if (xb <= xa) { inst.linkG.style.display = 'none'; return; }
      inst.linkG.style.display = '';
      inst.linkG.firstElementChild.setAttribute('x', xa);
      inst.linkG.firstElementChild.setAttribute('width', xb - xa);
      inst.linkG.firstElementChild.setAttribute('y', P.t);
      inst.linkG.firstElementChild.setAttribute('height', ih);
      inst.linkG.lastElementChild.textContent = linkLabel;
      inst.linkG.lastElementChild.setAttribute('x', (xa + xb) / 2);
      inst.linkG.lastElementChild.setAttribute('y', P.t + 10);
    };

    inst.render = function () {
      const span = xMax - xMin;
      const xOf = (x) => P.l + ((x - xMin) / span) * iw;

      let lo = Infinity, hi = -Infinity;
      D.series.forEach((s, k) => {
        for (const [gx, px] of s.points) {
          if (gx < xMin || gx > xMax) continue;
          const v = norm(k, gx, px, inst.mode);
          if (v == null) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      });
      if (!isFinite(lo)) { lo = -1; hi = 1; }
      const pad = Math.max(0.08, (hi - lo) * 0.12);
      const minV = lo - pad, maxV = hi + pad;
      const yOf = (v) => P.t + ih - ((v - minV) / (maxV - minV)) * ih;
      inst.view = { xOf, yOf, minV, maxV };

      let out = '';
      for (let k = 0; k <= 5; k++) {
        const v = minV + ((maxV - minV) / 5) * k;
        const y = yOf(v);
        out += `<line x1="${P.l}" y1="${y.toFixed(1)}" x2="${W - P.r}" y2="${y.toFixed(1)}" stroke="#252c39"/>`;
        out += `<text class="ytick" data-py="${y.toFixed(1)}" x="${P.l - 7}" y="${(y + 3.5).toFixed(1)}" fill="#7b8698" font-size="10" text-anchor="end">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</text>`;
      }
      if (minV <= 0 && maxV >= 0) {
        const y0 = yOf(0);
        out += `<line x1="${P.l}" y1="${y0.toFixed(1)}" x2="${W - P.r}" y2="${y0.toFixed(1)}" stroke="#6a748a" stroke-dasharray="3 3"/>`;
      }
      // 日分隔线 + 日期标签（按像素间距抽稀）
      let lastLabX = -1e9;
      for (let i = 0; i < D.days.length; i++) {
        const a = i * GP, b = a + GP;
        if (b <= xMin || a >= xMax) continue;
        if (i > 0 && a > xMin) {
          const x = xOf(a);
          out += `<line x1="${x.toFixed(1)}" y1="${P.t}" x2="${x.toFixed(1)}" y2="${P.t + ih}" stroke="#252c39"/>`;
        }
        const ca = Math.max(a, xMin), cb = Math.min(b, xMax);
        const cx = xOf((ca + cb) / 2);
        const d = D.days[i];
        if (cx - lastLabX >= 36) {
          out += `<text x="${cx.toFixed(1)}" y="${H - P.b + 20}" fill="#7b8698" font-size="10" text-anchor="middle">${d.slice(4, 6)}/${d.slice(6)}</text>`;
          lastLabX = cx;
        }
      }
      D.series.forEach((s, k) => {
        const pts = [];
        for (const [gx, px] of s.points) {
          if (gx < xMin - 2 || gx > xMax + 2) continue;
          const v = norm(k, gx, px, inst.mode);
          if (v == null) continue;
          pts.push(`${xOf(gx).toFixed(1)},${yOf(v).toFixed(1)}`);
        }
        if (pts.length > 1) {
          out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-linejoin="round"/>`;
        }
        const lastPx = [...s.points].reverse().find(([gx]) => gx >= xMin && gx <= xMax);
        if (lastPx) {
          const v = norm(k, lastPx[0], lastPx[1], inst.mode);
          if (v != null) {
            out += `<circle cx="${xOf(lastPx[0]).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3" fill="${s.color}"/>`;
            out += `<text x="${(W - P.r + 6).toFixed(1)}" y="${(yOf(v) + 3.5).toFixed(1)}" fill="${s.color}" font-size="11">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</text>`;
          }
        }
      });
      out += `<line x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#39414f"/>`;

      // 上证指数视野内最高 / 最低点（仅累计图；每日归零图各日基准不同，标注无意义）
      if (cfg.extremes) {
        const si = D.series.findIndex((s) => s.markExtremes);
        if (si >= 0) {
          let hiP = null, loP = null;
          for (const [gx, px] of D.series[si].points) {
            if (gx < xMin || gx > xMax) continue;
            if (!hiP || px > hiP[1]) hiP = [gx, px];
            if (!loP || px < loP[1]) loP = [gx, px];
          }
          for (const [pt, kind, col, up] of [[hiP, '高', '#ff7a86', 1], [loP, '低', '#43d19a', -1]]) {
            if (!pt) continue;
            const v = norm(si, pt[0], pt[1], inst.mode);
            if (v == null) continue;
            const x = xOf(pt[0]), y0 = yOf(v);
            const d = D.days[dayOf(pt[0])] ?? '';
            const txt = `${d.slice(4, 6)}/${d.slice(6)} ${kind} ${pt[1].toFixed(2)}`;
            const tw = txt.length * 5.95 + 10;
            const lx = Math.min(Math.max(x, P.l + tw / 2), W - P.r - tw / 2);
            const ly = Math.min(Math.max(y0 - up * 17, P.t + 10), P.t + ih - 8);
            out += `<line x1="${P.l}" y1="${y0.toFixed(1)}" x2="${W - P.r}" y2="${y0.toFixed(1)}" stroke="${col}" stroke-width="1" stroke-dasharray="5 4" opacity="0.42"/>`;
            out += `<circle cx="${x.toFixed(1)}" cy="${y0.toFixed(1)}" r="3.2" fill="none" stroke="${col}" stroke-width="1.4"/>`;
            out += `<line x1="${x.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${(ly + up * 8).toFixed(1)}" stroke="${col}" stroke-width="0.8" opacity="0.5"/>`;
            out += `<rect x="${(lx - tw / 2).toFixed(1)}" y="${(ly - 9).toFixed(1)}" width="${tw.toFixed(1)}" height="14" rx="3" fill="#1b2130" stroke="${col}" stroke-opacity="0.55"/>`;
            out += `<text x="${lx.toFixed(1)}" y="${(ly + 1.5).toFixed(1)}" fill="${col}" font-size="10" text-anchor="middle">${txt}</text>`;
          }
        }
      }

      const daysSpan = span / GP;
      const zoomTxt = daysSpan >= D.days.length - 0.05 ? `全部 ${D.days.length} 日` : `${daysSpan.toFixed(1)} 日`;
      const rangeTxt = cfg.from ? ` · ${cfg.from.slice(4, 6)}/${cfg.from.slice(6)} → ${cfg.to.slice(4, 6)}/${cfg.to.slice(6)}` : '';
      out += `<text x="${P.l}" y="${P.t - 6}" fill="#5b6478" font-size="10">${cfg.title}${rangeTxt} · ${zoomTxt}${cfg.extremes ? ' · 滚轮缩放 / 拖拽平移 / 双击复位（两图联动）' : ''}</text>`;

      svg.innerHTML = out;

      inst.linkG = document.createElementNS(NS, 'g');
      const band = mk('rect', { fill: '#5b8def', opacity: '0.09' });
      const bandTx = mk('text', { fill: '#5b8def', 'font-size': '9.5', 'text-anchor': 'middle' });
      inst.linkG.append(band, bandTx);
      inst.linkG.style.display = 'none';
      svg.appendChild(inst.linkG);

      inst.cross = inst.buildCross();
      svg.appendChild(inst.cross.g);
      inst.drawLink();
      inst.drawCross();
    };

    // ---------------- 交互（改共享视野 → 两图一起重绘） ----------------
    const toData = (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      const vy = ((e.clientY - r.top) / r.height) * H;
      return { vx, vy, dataX: xMin + ((vx - P.l) / iw) * (xMax - xMin) };
    };

    svg.addEventListener('mousemove', (e) => {
      if (dragging) return;
      const { vx, vy, dataX } = toData(e);
      const inside = vx >= P.l - 4 && vx <= W - P.r + 4 && vy >= P.t - 4 && vy <= P.t + ih + 4;
      for (const it of insts) it.hovering = false;
      inst.hovering = inside;
      hover = inside ? { gx: Math.round(dataX), py: vy, inst } : null;
      for (const it of insts) it.drawCross();
      bus.emit(SELF, inside ? dayLabel(dayOf(Math.round(dataX))) : null);
    });
    svg.addEventListener('mouseleave', () => {
      inst.hovering = false;
      if (hover && hover.inst === inst) hover = null;
      for (const it of insts) it.drawCross();
      bus.emit(SELF, null);
    });

    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { vx } = toData(e);
        const cx = Math.min(Math.max(vx, P.l), W - P.r);
        const anchor = xMin + ((cx - P.l) / iw) * (xMax - xMin);
        const f = Math.exp(e.deltaY * 0.0015);
        let a = anchor - (anchor - xMin) * f;
        let b = anchor + (xMax - anchor) * f;
        if (b - a < MIN_SPAN) return;
        if (a < 0) { b -= a; a = 0; }
        if (b > TOTAL) { a -= b - TOTAL; b = TOTAL; }
        xMin = Math.max(0, a);
        xMax = b;
        renderAll();
      },
      { passive: false },
    );

    svg.addEventListener('mousedown', (e) => {
      dragging = true;
      lastX = e.clientX;
      svg.style.cursor = 'grabbing';
      e.preventDefault();
    });

    svg.addEventListener('dblclick', () => { xMin = 0; xMax = TOTAL; renderAll(); });

    // ---------------- 触屏手势（捏合缩放 / 单指拖动 / 点按准线 / 双击复位） ----------------
    if (window.dzTouch) {
      window.dzTouch(svg, {
        onPan(dx) {
          const r = svg.getBoundingClientRect();
          const dData = (-((dx / r.width) * W) / iw) * (xMax - xMin);
          let a = xMin + dData, b = xMax + dData;
          if (a < 0) { b -= a; a = 0; }
          if (b > TOTAL) { a -= b - TOTAL; b = TOTAL; }
          xMin = Math.max(0, a);
          xMax = b;
          renderAll();
        },
        onPinch(ratio, cx) {
          const r = svg.getBoundingClientRect();
          const vx = ((cx - r.left) / r.width) * W;
          const c = Math.min(Math.max(vx, P.l), W - P.r);
          const anchor = xMin + ((c - P.l) / iw) * (xMax - xMin);
          const f = 1 / ratio; // 捏开(ratio>1) → f<1 → 放大
          let a = anchor - (anchor - xMin) * f;
          let b = anchor + (xMax - anchor) * f;
          if (b - a < MIN_SPAN) return;
          if (a < 0) { b -= a; a = 0; }
          if (b > TOTAL) { a -= b - TOTAL; b = TOTAL; }
          xMin = Math.max(0, a);
          xMax = b;
          renderAll();
        },
        onTap(cx, cy) {
          const r = svg.getBoundingClientRect();
          const vx = ((cx - r.left) / r.width) * W;
          const vy = ((cy - r.top) / r.height) * H;
          const inside = vx >= P.l - 4 && vx <= W - P.r + 4 && vy >= P.t - 4 && vy <= P.t + ih + 4;
          for (const it of insts) it.hovering = false;
          if (!inside || (hover && hover.inst === inst)) {
            hover = null;
          } else {
            inst.hovering = true;
            hover = { gx: Math.round(xMin + ((vx - P.l) / iw) * (xMax - xMin)), py: vy, inst };
          }
          for (const it of insts) it.drawCross();
          bus.emit(SELF, hover ? dayLabel(dayOf(hover.gx)) : null);
        },
        onDoubleTap() { xMin = 0; xMax = TOTAL; renderAll(); },
      });
    }
  }

  // 折叠屏展开/折叠、横竖屏切换 → 重新按新宽度渲染
  let rzTimer = null;
  const onResize = () => { clearTimeout(rzTimer); rzTimer = setTimeout(() => renderAll(), 180); };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // 拖动是全局的（指针可能移出 svg），只挂一次
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    for (const it of insts) it.svg.style.cursor = 'crosshair';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const ref = insts[0];
    if (!ref) return;
    const r = ref.svg.getBoundingClientRect();
    const dx = ((e.clientX - lastX) / r.width) * W;
    lastX = e.clientX;
    const dData = (-dx / iw) * (xMax - xMin);
    let a = xMin + dData, b = xMax + dData;
    if (a < 0) { b -= a; a = 0; }
    if (b > TOTAL) { a -= b - TOTAL; b = TOTAL; }
    xMin = Math.max(0, a);
    xMax = b;
    renderAll();
  });

  // 接收其他图的联动
  bus.on((label, src) => {
    if (src === SELF) return;
    linkLabel = label;
    for (const it of insts) it.drawLink();
  });

  renderAll();
})();
