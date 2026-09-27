// 通用十字准线 + 跨图联动
// 依赖 build-dashboard.mjs 注入的 window.CHARTS（每张图数据点的像素坐标与数值标签）
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // 联动总线：按「MM-DD」日期标签广播，各图自行匹配
  const bus = (window.__LINK__ = window.__LINK__ || (() => {
    const subs = [];
    return {
      on(fn) { subs.push(fn); },
      emit(src, label) { for (const f of subs) { try { f(label, src); } catch (_) {} } },
    };
  })());

  const fmtY = (v, kind) => {
    if (kind === 'int') return Math.round(v).toString();
    if (kind === 'k') return (v / 1000).toFixed(2) + 'k';
    if (kind === 'pct') return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    return v.toFixed(2);
  };

  const mk = (tag, attrs, text) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  };

  for (const C of window.CHARTS || []) {
    const svg = document.getElementById(C.id);
    if (!svg || !C.xs || !C.xs.length) continue;

    const P = C.plot, x0 = P.l, x1 = C.w - P.r, y0 = P.t, y1 = C.h - P.b;

    // ---- 本图准线层 ----
    const g = mk('g', {});
    g.style.display = 'none';
    svg.appendChild(g);

    const vLine = mk('line', { stroke: '#8b96a8', 'stroke-dasharray': '3 3' });
    const hLine = mk('line', { stroke: '#8b96a8', 'stroke-dasharray': '3 3' });
    const tBg = mk('rect', { fill: '#2b3446', rx: '3' });
    const tTx = mk('text', { fill: '#dfe6f2', 'font-size': '10', 'text-anchor': 'middle' });
    const vBg = mk('rect', { fill: '#2b3446', rx: '3', stroke: '#4a5568' });
    const vTx = mk('text', { fill: '#dfe6f2', 'font-size': '10', 'text-anchor': 'end' });
    const dots = C.series.map((s) => mk('circle', { r: '3', fill: s.color, stroke: '#141821', 'stroke-width': '1' }));
    g.append(vLine, hLine, tBg, tTx, vBg, vTx, ...dots);

    // ---- 联动层：其他图广播过来的同日期竖线 ----
    const linkG = mk('g', {});
    linkG.style.display = 'none';
    const linkLine = mk('line', { stroke: '#5b8def', 'stroke-dasharray': '2 4', opacity: '0.7' });
    const linkTx = mk('text', { fill: '#5b8def', 'font-size': '9.5', 'text-anchor': 'middle' });
    linkG.append(linkLine, linkTx);
    svg.appendChild(linkG);

    // ---- 数值卡片 ----
    const tip = document.createElement('div');
    tip.className = 'chtip';
    tip.style.display = 'none';
    svg.parentElement.style.position = 'relative';
    svg.parentElement.appendChild(tip);

    const yticks = [...svg.querySelectorAll('.ytick')];

    const nearestIdx = (px) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < C.xs.length; i++) {
        const d = Math.abs(C.xs[i] - px);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };

    // 让准线数值标签落在纵轴交点处，并隐藏会被它遮住的那个刻度（避免重叠）
    function placeValueBadge(cy, txt) {
      vTx.textContent = txt;
      const w = txt.length * 6.2 + 10;
      vBg.setAttribute('x', x0 - w + 3);
      vBg.setAttribute('y', cy - 6.5);
      vBg.setAttribute('width', w);
      vBg.setAttribute('height', 13);
      vTx.setAttribute('x', x0 - 1);
      vTx.setAttribute('y', cy + 3.5);
      let near = null, nd = Infinity;
      for (const t of yticks) {
        const d = Math.abs(+t.dataset.py - cy);
        if (d < nd) { nd = d; near = t; }
      }
      for (const t of yticks) t.style.display = '';
      if (near && nd < 9) near.style.display = 'none';
    }

    function hide() {
      g.style.display = 'none';
      tip.style.display = 'none';
      for (const t of yticks) t.style.display = '';
      bus.emit(C.id, null);
    }

    function move(e) {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * C.w;
      const py = ((e.clientY - r.top) / r.height) * C.h;
      if (px < x0 - 4 || px > x1 + 4 || py < y0 - 4 || py > y1 + 4) return hide();

      const i = nearestIdx(px);
      const cx = C.xs[i];
      const cy = Math.min(Math.max(py, y0), y1);
      const label = C.xLabels[i];

      g.style.display = '';
      vLine.setAttribute('x1', cx); vLine.setAttribute('x2', cx);
      vLine.setAttribute('y1', y0); vLine.setAttribute('y2', y1);
      hLine.setAttribute('y1', cy); hLine.setAttribute('y2', cy);
      hLine.setAttribute('x1', x0); hLine.setAttribute('x2', x1);

      // 纵线落点 → 时间
      tTx.textContent = label;
      const tw = label.length * 6.2 + 10;
      tBg.setAttribute('x', cx - tw / 2); tBg.setAttribute('y', y1 + 2);
      tBg.setAttribute('width', tw); tBg.setAttribute('height', 13);
      tTx.setAttribute('x', cx); tTx.setAttribute('y', y1 + 12);

      // 横线落点 → 数值（贴纵轴，且不压住刻度）
      const val = C.yMin + ((y1 - cy) / (y1 - y0)) * (C.yMax - C.yMin);
      placeValueBadge(cy, fmtY(val, C.fmt));

      let rows = '';
      C.series.forEach((s, k) => {
        dots[k].setAttribute('cx', cx);
        dots[k].setAttribute('cy', s.ys[i]);
        dots[k].style.display = '';
        rows += `<div><i style="background:${s.color}"></i><span class="n">${s.name}</span><b>${s.labels[i]}</b></div>`;
      });
      tip.innerHTML = `<div class="h">${label}</div>${rows}`;
      tip.style.display = '';

      // 卡片跟随光标：优先贴在光标正上方；上方放不下时改放光标侧面，避免盖住光标与准线。
      const panelEl = svg.parentElement;
      const pr = panelEl.getBoundingClientRect();
      const tw2 = tip.offsetWidth, th2 = tip.offsetHeight;
      const mx = e.clientX - pr.left, my = e.clientY - pr.top;
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

    // 接收其他图的联动
    bus.on((label, src) => {
      if (src === C.id) return;
      if (!label) { linkG.style.display = 'none'; return; }
      const i = C.xLabels.indexOf(label);
      if (i < 0) { linkG.style.display = 'none'; return; }
      const cx = C.xs[i];
      linkG.style.display = '';
      linkLine.setAttribute('x1', cx); linkLine.setAttribute('x2', cx);
      linkLine.setAttribute('y1', y0); linkLine.setAttribute('y2', y1);
      linkTx.setAttribute('x', cx); linkTx.setAttribute('y', y0 + 9);
      linkTx.textContent = label;
    });

    svg.addEventListener('mousemove', move);
    svg.addEventListener('mouseleave', hide);
  }
})();
