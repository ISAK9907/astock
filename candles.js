// 日线蜡烛图：价格主图 + 成交量副图；无限制缩放 + 拖拽平移 + 双击复位 + 十字准线 + 跨图联动
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const bus = (window.__LINK__ = window.__LINK__ || (() => {
    const subs = [];
    return {
      on(fn) { subs.push(fn); },
      emit(src, label) { for (const f of subs) { try { f(label, src); } catch (_) {} } },
    };
  })());

  const DATA = window.CANDLES;
  if (!DATA) return;
  const byKey = Object.fromEntries(DATA.series.map((s) => [s.key, s]));
  const INTRA = window.DTINTRA || {}; // 标记日的「当日跌停家数随时间」曲线

  // 跌停分档：必须放在外层作用域 —— render() 画底纹/标记条要看它，
  // drawCross() 生成悬停卡片时也要看它。此前它们被定义在 render() 内部，
  // 导致 drawCross() 一旦真的悬停就抛 ReferenceError（准线画了但卡片不出现、联动也发不出去）。
  const DT = window.DTDATA || {};
  const TIERS = window.DTTIERS || [];
  // 档位门槛挂在**情绪分 sent** 上（前 5%/3%/1%），不是绝对严重度分 score ——
  // score 无上界，三年窗口里最惨的一天能到 46.9，会把档位撑变形。
  const daySent = (d) => (DT[d] && DT[d].sent != null ? DT[d].sent : null);
  const tierColor = (s) => {
    if (s == null) return null;
    for (const t of TIERS) if (s >= t.minSent) return t.color;
    return null;
  };

  // 48 档 → 时刻（09:35-11:30 / 13:05-15:00）
  const slotTime = (i) => {
    const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  /** 当日跌停家数走势迷你图（标记日才有） */
  function miniCurve(d, color) {
    const it = INTRA[d];
    if (!it || !Array.isArray(it.curve) || !it.curve.length) return '';
    const c = it.curve;
    const tc = it.touch || c;
    const W2 = 168, H2 = 46, pad = { t: 6, r: 3, b: 11, l: 3 };
    const iw2 = W2 - pad.l - pad.r, ih2 = H2 - pad.t - pad.b;
    const max = Math.max(...c, 1);
    const xOf = (i) => pad.l + (i / (c.length - 1)) * iw2;
    const yOf = (v) => pad.t + ih2 - (v / max) * ih2;
    const pts = c.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
    const total = c[c.length - 1];
    // 半数封板时刻：累计首触首次达到一半的档位 —— 反映恐慌扩散速度
    // （不标"峰值"是因为所有触及跌停的股票最终都收在跌停，峰值恒等于收盘值、恒在 15:00）
    const halfSlot = tc.findIndex((v) => v >= total / 2);
    const lunchX = xOf(24).toFixed(1);
    const hx = halfSlot >= 0 ? xOf(halfSlot) : null;
    return (
      `<div class="mini"><div class="mini-h">当日跌停家数走势 · 每 5 分钟` +
      `<b>收盘 ${total} 家</b></div>` +
      `<svg viewBox="0 0 ${W2} ${H2}" class="minisvg">` +
      `<line x1="${pad.l}" y1="${(pad.t + ih2).toFixed(1)}" x2="${(W2 - pad.r).toFixed(1)}" y2="${(pad.t + ih2).toFixed(1)}" stroke="#39414f"/>` +
      `<line x1="${lunchX}" y1="${pad.t}" x2="${lunchX}" y2="${(pad.t + ih2).toFixed(1)}" stroke="#39414f" stroke-dasharray="2 2" opacity="0.7"/>` +
      `<polygon points="${pad.l},${(pad.t + ih2).toFixed(1)} ${pts} ${(W2 - pad.r).toFixed(1)},${(pad.t + ih2).toFixed(1)}" fill="${color}" opacity="0.14"/>` +
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>` +
      (hx != null
        ? `<line x1="${hx.toFixed(1)}" y1="${pad.t}" x2="${hx.toFixed(1)}" y2="${(pad.t + ih2).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.75"/>` +
          `<circle cx="${hx.toFixed(1)}" cy="${yOf(tc[halfSlot]).toFixed(1)}" r="2.2" fill="${color}"/>`
        : '') +
      `<text x="${pad.l}" y="${H2 - 2}" fill="#7b8698" font-size="8">09:35</text>` +
      `<text x="${(W2 - pad.r).toFixed(1)}" y="${H2 - 2}" fill="#7b8698" font-size="8" text-anchor="end">15:00</text>` +
      `</svg>` +
      `<div class="mini-f">${halfSlot >= 0 ? `半数在 <b>${slotTime(halfSlot)}</b> 前封板 · ` : ''}` +
      `累计曾触及 <b>${tc[tc.length - 1]}</b> 家` +
      `${it.n && it.n !== total ? `<span class="tiny">统计口径 ${it.n} 家</span>` : ''}</div>` +
      `</div>`
    );
  }

  const CFG = [
    { id: 'cdSh', key: 'sh', H: 280, t: 16, b: 24, fs: 9.5 },
    { id: 'cdCyb', key: 'cyb', H: 140, t: 6, b: 16, fs: 8.5 },
    { id: 'cdKc50', key: 'kc50', H: 140, t: 6, b: 16, fs: 8.5 },
  ];

  const mk = (tag, attrs, text) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  };
  const fmtP = (v) => (v >= 1000 ? v.toFixed(0) : v.toFixed(2));
  const fmtV = (v) => (v >= 1e8 ? (v / 1e8).toFixed(2) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : Math.round(v));
  const mmdd = (d) => d.slice(5);

  for (const C of CFG) {
    const svg = document.getElementById(C.id);
    if (!svg || !byKey[C.key]) continue;
    const B = byKey[C.key].bars;
    const N = B.length;
    const H = C.H, P = { t: C.t, r: 50, b: C.b, l: 48 };
    // W 随容器宽度自适应：手机上固定 500 会被缩小到 ~0.7 倍，字变小且蜡烛挤在一起
    let W = 500;
    let iw = W - P.l - P.r;
    const ih = H - P.t - P.b;
    const clampW = (v) => Math.max(280, Math.min(760, Math.round(v) || 500));
    const GAP = 7;
    const priceH = Math.round((ih - GAP) * 0.73);
    const volTop = P.t + priceH + GAP;
    const volH = ih - priceH - GAP;
    const clipId = `cp_${C.id}`;
    const MIN_SPAN = 3;

    let i0 = 0, i1 = N;
    // 历史有 1000 根，默认全览会把蜡烛压成一条线（手机上尤其）。初始只显示最近一段，
    // 每根约 2.6px —— 宽屏约 160 根、手机约 85 根。双击/双击手势复位成全部历史。
    let inited = false;
    const initSpan = () => Math.max(60, Math.min(N, Math.round(iw / 2.6)));
    let view = null, g = null, yticks = [];
    let linkG = null, linkLabel = null;
    let hover = null;
    let dragging = false, lastPx = 0;

    let tip = document.createElement('div');
    tip.className = 'chtip';
    tip.style.display = 'none';
    svg.parentElement.style.position = 'relative';
    svg.parentElement.appendChild(tip);

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
      // 每次渲染都按容器宽度重算（折叠屏展开/折叠、转屏后宽度会变）
      const nw = clampW(svg.clientWidth);
      if (nw !== W) { W = nw; iw = W - P.l - P.r; }
      // 首帧才知道容器宽度，所以初始区间在这里定
      if (!inited) { i1 = N; i0 = Math.max(0, N - initSpan()); inited = true; }
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      clampRange();
      const a = Math.max(0, Math.floor(i0) - 1);
      const b = Math.min(N - 1, Math.ceil(i1) + 1);
      const vis = B.slice(a, b + 1);
      if (!vis.length) return;

      const hi = Math.max(...vis.map((r) => r.h));
      const lo = Math.min(...vis.map((r) => r.l));
      const padv = (hi - lo) * 0.05 || 1;
      const minV = lo - padv, maxV = hi + padv;
      const maxVol = Math.max(...vis.map((r) => r.v)) || 1;
      const span = i1 - i0;
      const xOf = (i) => P.l + ((i - i0) / span) * iw;
      const yOf = (v) => P.t + priceH - ((v - minV) / (maxV - minV)) * priceH;
      const vOf = (v) => volTop + volH - (v / maxVol) * volH;
      const step = iw / span;
      const bw = Math.max(0.8, Math.min(step * 0.62, 18));
      view = { xOf, yOf, vOf, minV, maxV, maxVol, step, span, bw, priceH };

      const chgEl = document.querySelector(`[data-chg="${C.id}"]`);
      if (chgEl) {
        const fa = B[Math.max(0, Math.round(i0))], fb = B[Math.min(N - 1, Math.round(i1) - 1)];
        if (fa && fb) {
          const pct = (fb.c / fa.c - 1) * 100;
          chgEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
          chgEl.className = `chg ${pct >= 0 ? 'up' : 'down'}`;
        }
      }

      let s = `<defs><clipPath id="${clipId}"><rect x="${P.l}" y="${P.t}" width="${iw}" height="${ih}"/></clipPath></defs>`;

      // 价格刻度
      for (let k = 0; k <= 4; k++) {
        const v = minV + ((maxV - minV) / 4) * k, y = yOf(v);
        s += `<line x1="${P.l}" y1="${y.toFixed(1)}" x2="${W - P.r}" y2="${y.toFixed(1)}" stroke="#252c39"/>`;
        s += `<text class="ytick" data-py="${y.toFixed(1)}" x="${P.l - 6}" y="${(y + 3.5).toFixed(1)}" fill="#7b8698" font-size="${C.fs}" text-anchor="end">${fmtP(v)}</text>`;
      }
      const lastC = B[N - 1].c;
      if (lastC >= minV && lastC <= maxV) {
        s += `<line x1="${P.l}" y1="${yOf(lastC).toFixed(1)}" x2="${W - P.r}" y2="${yOf(lastC).toFixed(1)}" stroke="#6a748a" stroke-dasharray="3 3" opacity="0.6"/>`;
        s += `<text x="${W - P.r + 5}" y="${(yOf(lastC) + 3.5).toFixed(1)}" fill="#c3ccdb" font-size="${C.fs}">${fmtP(lastC)}</text>`;
      }

      // 极端跌停日底纹（在蜡烛之下）：按综合严重度分三档 粉/紫/橙
      // DT / TIERS / daySent / tierColor 定义在外层作用域（drawCross 也要用）
      let bands = '';
      for (let i = a; i <= b; i++) {
        const col = tierColor(daySent(B[i].d));
        if (!col) continue;
        const cx = xOf(i), w = Math.max(bw, 2.5);
        bands += `<rect x="${(cx - w / 2).toFixed(1)}" y="${P.t}" width="${w.toFixed(1)}" height="${priceH}" fill="${col}" opacity="0.13"/>`;
      }
      s += `<g clip-path="url(#${clipId})">${bands}</g>`;

      // 蜡烛
      let body = '';
      for (let i = a; i <= b; i++) {
        const r = B[i], cx = xOf(i);
        if (cx < P.l - 2 || cx > W - P.r + 2) continue;
        const up = r.c >= r.o, col = up ? '#ef4d5a' : '#3fa66b';
        body += `<line x1="${cx.toFixed(1)}" y1="${yOf(r.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yOf(r.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
        if (bw >= 1.6) {
          const yT = yOf(Math.max(r.o, r.c)), yB = yOf(Math.min(r.o, r.c));
          body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, yB - yT).toFixed(1)}" fill="${col}"/>`;
        }
      }
      s += `<g clip-path="url(#${clipId})">${body}</g>`;

      // 极端跌停日标记条（在蜡烛之上，贴价格窗格底部）
      let marks = '';
      for (let i = a; i <= b; i++) {
        const col = tierColor(daySent(B[i].d));
        if (!col) continue;
        const cx = xOf(i), w = Math.max(bw, 2.5);
        marks += `<rect x="${(cx - w / 2).toFixed(1)}" y="${(P.t + priceH - 4.5).toFixed(1)}" width="${w.toFixed(1)}" height="4.5" fill="${col}"/>`;
      }
      s += `<g clip-path="url(#${clipId})">${marks}</g>`;

      // 成交量副图
      s += `<line x1="${P.l}" y1="${volTop.toFixed(1)}" x2="${W - P.r}" y2="${volTop.toFixed(1)}" stroke="#2f3747"/>`;
      let volBar = '';
      for (let i = a; i <= b; i++) {
        const r = B[i], cx = xOf(i);
        if (cx < P.l - 2 || cx > W - P.r + 2) continue;
        const col = r.c >= r.o ? '#ef4d5a' : '#3fa66b';
        const yT = vOf(r.v);
        volBar += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${Math.max(0.8, bw).toFixed(1)}" height="${Math.max(0.6, volTop + volH - yT).toFixed(1)}" fill="${col}" opacity="0.72"/>`;
      }
      s += `<g clip-path="url(#${clipId})">${volBar}</g>`;
      s += `<text class="vtick" data-py="${volTop.toFixed(1)}" x="${P.l - 6}" y="${(volTop + 8).toFixed(1)}" fill="#7b8698" font-size="${C.fs}" text-anchor="end">${fmtV(maxVol)}</text>`;
      s += `<text x="${P.l}" y="${(volTop - 2).toFixed(1)}" fill="#5b6478" font-size="9">成交量</text>`;

      const ticks = Math.max(2, Math.min(6, Math.floor(span / 12)));
      // ⚠️ k=ticks 时 i = i1 = N 会被 `i >= N` 过滤掉 —— 于是最右边的日期刻度永远不画，
      //    初始视图收在「今天」却看不到今天的日期。夹到 N-1，并去重（区间极窄时刻度会重叠）
      const seenTick = new Set();
      for (let k = 0; k <= ticks; k++) {
        const i = Math.min(N - 1, Math.round(i0 + ((i1 - i0) / ticks) * k));
        if (i < 0 || seenTick.has(i)) continue;
        seenTick.add(i);
        s += `<text x="${xOf(i).toFixed(1)}" y="${H - P.b + (C.H > 200 ? 14 : 12)}" fill="#7b8698" font-size="${C.fs}" text-anchor="middle">${mmdd(B[i].d)}</text>`;
      }
      s += `<line x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#39414f"/>`;
      s += `<text x="${P.l}" y="${P.t - 4}" fill="#5b6478" font-size="9.5">${span >= N - 0.5 ? `全部 ${N} 根` : `${span.toFixed(0)} 根`} · 滚轮缩放 · 拖拽平移 · 双击复位</text>`;

      svg.innerHTML = s;

      linkG = mk('g', {}); linkG.style.display = 'none';
      linkG.append(mk('rect', { fill: '#5b8def', opacity: '0.1' }), mk('text', { fill: '#5b8def', 'font-size': '9.5', 'text-anchor': 'middle' }));
      svg.appendChild(linkG);

      const gg = mk('g', {}); gg.style.display = 'none';
      const vLine = mk('line', { stroke: '#8b96a8', 'stroke-dasharray': '3 3' });
      const hLine = mk('line', { stroke: '#8b96a8', 'stroke-dasharray': '3 3' });
      const tBg = mk('rect', { fill: '#2b3446', rx: '3' });
      const tTx = mk('text', { fill: '#dfe6f2', 'font-size': '10', 'text-anchor': 'middle' });
      const vBg = mk('rect', { fill: '#2b3446', rx: '3', stroke: '#4a5568' });
      const vTx = mk('text', { fill: '#dfe6f2', 'font-size': '10', 'text-anchor': 'end' });
      const markHi = mk('rect', { fill: 'none', 'stroke-width': '1.6', rx: '1' }); // 悬停标记日时高亮底部标记条
      gg.append(vLine, hLine, tBg, tTx, vBg, vTx, markHi);
      svg.appendChild(gg);
      g = { gg, vLine, hLine, tBg, tTx, vBg, vTx, markHi };
      yticks = [...svg.querySelectorAll('.ytick'), ...svg.querySelectorAll('.vtick')];
      drawCross();
      drawLink();
    }

    function drawCross() {
      for (const t of yticks) t.style.display = '';
      if (!hover) { g.gg.style.display = 'none'; tip.style.display = 'none'; return; }
      const { i, py } = hover;
      const r = B[i];
      const inVol = py > volTop;
      const cx = view.xOf(i);
      const cy = inVol
        ? Math.min(Math.max(py, volTop), volTop + volH)
        : Math.min(Math.max(py, P.t), P.t + priceH);
      g.gg.style.display = '';
      g.vLine.setAttribute('x1', cx); g.vLine.setAttribute('x2', cx);
      g.vLine.setAttribute('y1', P.t); g.vLine.setAttribute('y2', P.t + ih);
      g.hLine.setAttribute('y1', cy); g.hLine.setAttribute('y2', cy);
      g.hLine.setAttribute('x1', P.l); g.hLine.setAttribute('x2', W - P.r);

      const label = mmdd(r.d);
      g.tTx.textContent = label;
      const tw = label.length * 6.2 + 10;
      g.tBg.setAttribute('x', cx - tw / 2); g.tBg.setAttribute('y', P.t + ih + 2);
      g.tBg.setAttribute('width', tw); g.tBg.setAttribute('height', 13);
      g.tTx.setAttribute('x', cx); g.tTx.setAttribute('y', P.t + ih + 12);

      // 光标在成交量区就标成交量，否则标价格
      const vtxt = inVol
        ? fmtV(view.maxVol * (1 - (cy - volTop) / volH))
        : fmtP(view.minV + ((P.t + priceH - cy) / priceH) * (view.maxV - view.minV));
      g.vTx.textContent = vtxt;
      const vw = vtxt.length * 6.2 + 10;
      g.vBg.setAttribute('x', P.l - vw + 3); g.vBg.setAttribute('y', cy - 6.5);
      g.vBg.setAttribute('width', vw); g.vBg.setAttribute('height', 13);
      g.vTx.setAttribute('x', P.l - 1); g.vTx.setAttribute('y', cy + 3.5);
      let near = null, nd = Infinity;
      for (const t of yticks) {
        const d2 = Math.abs(+t.dataset.py - cy);
        if (d2 < nd) { nd = d2; near = t; }
      }
      if (near && nd < 9) near.style.display = 'none';

      const up = r.c >= r.o;
      const dv = DT[r.d];
      const col2 = tierColor(dv && dv.sent != null ? dv.sent : null);

      // 悬停到粉/紫/橙标记日时，把底部那条标记加粗高亮，提示"这里可以看详情"
      if (col2) {
        const w = Math.max(view.bw, 2.5);
        g.markHi.style.display = '';
        g.markHi.setAttribute('x', (cx - w / 2 - 1.5).toFixed(1));
        g.markHi.setAttribute('y', (P.t + view.priceH - 6).toFixed(1));
        g.markHi.setAttribute('width', (w + 3).toFixed(1));
        g.markHi.setAttribute('height', '7');
        g.markHi.setAttribute('stroke', col2);
      } else {
        g.markHi.style.display = 'none';
      }

      tip.innerHTML =
        `<div class="h">${label}</div>` +
        `<div><i style="background:${up ? '#ef4d5a' : '#3fa66b'}"></i><span class="n">开/高</span><b>${fmtP(r.o)} / ${fmtP(r.h)}</b></div>` +
        `<div><i style="background:${up ? '#ef4d5a' : '#3fa66b'}"></i><span class="n">低/收</span><b>${fmtP(r.l)} / ${fmtP(r.c)}</b></div>` +
        `<div><i style="background:#5b8def"></i><span class="n">成交量</span><b>${fmtV(r.v)}</b></div>` +
        (dv
          ? `<div class="sep"></div>` +
            `<div><i style="background:${col2}"></i><span class="n">恐慌情绪</span><b>${dv.sent == null ? dv.score : dv.sent}</b></div>` +
            `<div><i style="background:${col2}"></i><span class="n">跌停家数</span><b>${dv.dt}</b></div>` +
            `<div><i style="background:${col2}"></i><span class="n">市值占比</span><b>${dv.cap.toFixed(2)}%</b></div>` +
            `<div><i style="background:${col2}"></i><span class="n">权重股跌停</span><b>${dv.mem}</b></div>` +
            `<div><i style="background:${col2}"></i><span class="n">大/中/小</span><b>${dv.big}/${dv.mid}/${dv.small}</b></div>`
          : '') +
        // 粉/紫/橙标记日：附加当日跌停家数的时间曲线
        (col2 && INTRA[r.d] ? miniCurve(r.d, col2) : '');
      tip.style.display = '';
      tip.classList.toggle('wide', !!(col2 && INTRA[r.d]));

      // 卡片跟随光标：优先贴在光标正上方；上方放不下时改放光标侧面
      // （不能简单往下夹——标记日卡片近 300px 高，往下夹会正好盖住光标与准线）。
      const panelEl = svg.parentElement;
      const pr = panelEl.getBoundingClientRect();
      const tw2 = tip.offsetWidth, th2 = tip.offsetHeight;
      const mx = hover.ex - pr.left, my = hover.ey - pr.top;
      const GAP = 14;
      let left, top;
      if (my - th2 - 12 >= 4) {
        top = my - th2 - 12;
        left = mx + 16;
      } else {
        top = Math.min(Math.max(4, my - th2 / 2), Math.max(4, pr.height - th2 - 4));
        left = pr.width - (mx + GAP) >= tw2 + 4 ? mx + GAP : mx - tw2 - GAP;
      }
      left = Math.min(Math.max(4, left), Math.max(4, pr.width - tw2 - 4));
      top = Math.min(Math.max(4, top), Math.max(4, pr.height - th2 - 4));
      tip.style.left = `${left.toFixed(0)}px`;
      tip.style.top = `${top.toFixed(0)}px`;

      bus.emit(C.id, label);
    }

    function drawLink() {
      if (!linkG) return;
      if (!linkLabel) { linkG.style.display = 'none'; return; }
      const i = B.findIndex((r) => mmdd(r.d) === linkLabel);
      if (i < 0) { linkG.style.display = 'none'; return; }
      const half = Math.max(view.step / 2, 0.6);
      const xa = Math.max(view.xOf(i) - half, P.l), xb = Math.min(view.xOf(i) + half, W - P.r);
      if (xb <= xa) { linkG.style.display = 'none'; return; }
      linkG.style.display = '';
      linkG.firstElementChild.setAttribute('x', xa);
      linkG.firstElementChild.setAttribute('y', P.t);
      linkG.firstElementChild.setAttribute('width', Math.max(1.5, xb - xa));
      linkG.firstElementChild.setAttribute('height', ih);
      linkG.lastElementChild.textContent = linkLabel;
      linkG.lastElementChild.setAttribute('x', (xa + xb) / 2);
      linkG.lastElementChild.setAttribute('y', P.t + 10);
    }

    const coords = (e) => {
      const r = svg.getBoundingClientRect();
      return { px: ((e.clientX - r.left) / r.width) * W, py: ((e.clientY - r.top) / r.height) * H };
    };
    const idxAt = (px) => Math.min(Math.max(Math.round(i0 + ((px - P.l) / iw) * (i1 - i0)), 0), N - 1);

    svg.addEventListener('mousemove', (e) => {
      if (dragging) return;
      const { px, py } = coords(e);
      const inside = px >= P.l - 4 && px <= W - P.r + 4 && py >= P.t - 4 && py <= P.t + ih + 4;
      // 记录光标屏幕坐标，供悬停卡片定位（卡片跟随鼠标，不再钉在面板顶部）
      hover = inside ? { i: idxAt(px), py, ex: e.clientX, ey: e.clientY } : null;
      drawCross();
      if (!inside) bus.emit(C.id, null);
    });
    svg.addEventListener('mouseleave', () => { hover = null; drawCross(); bus.emit(C.id, null); });

    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { px } = coords(e);
        const cx = Math.min(Math.max(px, P.l), W - P.r);
        const anchor = i0 + ((cx - P.l) / iw) * (i1 - i0);
        const f = Math.exp(e.deltaY * 0.0015);
        const a2 = anchor - (anchor - i0) * f;
        const b2 = anchor + (i1 - anchor) * f;
        if (b2 - a2 < MIN_SPAN) return;
        i0 = a2; i1 = b2;
        render();
      },
      { passive: false },
    );

    svg.addEventListener('mousedown', (e) => {
      dragging = true;
      lastPx = e.clientX;
      svg.style.cursor = 'grabbing';
      e.preventDefault();
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; svg.style.cursor = ''; }
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = svg.getBoundingClientRect();
      const dx = ((e.clientX - lastPx) / r.width) * W;
      lastPx = e.clientX;
      const dIdx = (-dx / iw) * (i1 - i0);
      i0 += dIdx; i1 += dIdx;
      render();
    });
    svg.addEventListener('dblclick', () => { i0 = 0; i1 = N; render(); });

    // ---------------- 触屏手势 ----------------
    if (window.dzTouch) {
      window.dzTouch(svg, {
        onPan(dx) {
          const r = svg.getBoundingClientRect();
          const dIdx = (-((dx / r.width) * W) / iw) * (i1 - i0);
          i0 += dIdx; i1 += dIdx;
          render();
        },
        onPinch(ratio, cx) {
          const r = svg.getBoundingClientRect();
          const px = ((cx - r.left) / r.width) * W;
          const anchor = i0 + ((Math.min(Math.max(px, P.l), W - P.r) - P.l) / iw) * (i1 - i0);
          const f = 1 / ratio;
          let a = anchor - (anchor - i0) * f;
          let b = anchor + (i1 - anchor) * f;
          if (b - a < MIN_SPAN) return;
          i0 = a; i1 = b;
          render();
        },
        onTap(cx, cy) {
          const r = svg.getBoundingClientRect();
          const px = ((cx - r.left) / r.width) * W;
          const py = ((cy - r.top) / r.height) * H;
          const inside = px >= P.l - 4 && px <= W - P.r + 4 && py >= P.t - 4 && py <= P.t + ih + 4;
          if (!inside || hover) hover = null;
          else hover = { i: idxAt(px), py };
          drawCross();
          if (!inside) bus.emit(C.id, null);
        },
        onDoubleTap() { i0 = 0; i1 = N; render(); },
      });
    }

    bus.on((label, src) => {
      if (src === C.id) return;
      linkLabel = label;
      drawLink();
    });

    // 折叠屏展开/折叠、转屏 → 按新宽度重绘
    let rzTimer = null;
    window.addEventListener('resize', () => { clearTimeout(rzTimer); rzTimer = setTimeout(() => render(), 180); });
    window.addEventListener('orientationchange', () => { clearTimeout(rzTimer); rzTimer = setTimeout(() => render(), 180); });

    render();
  }
})();
