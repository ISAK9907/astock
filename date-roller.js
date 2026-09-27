// 顶部日期滚轮：回看历史推送（收盘 + 盘前）
// 数据来自 window.PUSHLOG（build-dashboard 内联的 push-archive.json）
(function () {
  const LOG = window.PUSHLOG || [];
  const bar = document.getElementById('rollerBar');
  const strip = document.getElementById('rStrip');
  const panel = document.getElementById('pushPanel');
  const bodyEl = document.getElementById('pushBody');
  const headDate = document.getElementById('pushDate');
  const countEl = document.getElementById('rCount');
  if (!bar || !strip) return;
  if (!LOG.length) { bar.hidden = true; return; }

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const WD = ['日', '一', '二', '三', '四', '五', '六'];

  // 按日期归并
  const byDate = new Map();
  for (const e of LOG) {
    if (!byDate.has(e.date)) byDate.set(e.date, {});
    byDate.get(e.date)[e.kind] = e;
  }
  const dates = [...byDate.keys()].sort(); // 升序，最新的在右边
  let cur = dates[dates.length - 1];
  let shown = true;

  const chipOf = (d) => strip.querySelector(`[data-date="${d}"]`);

  function renderStrip() {
    strip.innerHTML = '';
    for (const d of dates) {
      const rec = byDate.get(d);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rchip' + (d === cur && shown ? ' on' : '');
      b.dataset.date = d;
      const wd = WD[new Date(d + 'T00:00:00').getDay()];
      b.innerHTML = `<b>${d.slice(5)}</b><em>周${wd}</em>` +
        (rec.premarket && rec.close ? '<i class="both"></i>' : rec.premarket ? '<i class="pm"></i>' : '');
      b.title = `${d} 周${wd}${rec.premarket ? ' · 盘前' : ''}${rec.close ? ' · 收盘' : ''}`;
      b.addEventListener('click', () => {
        if (d === cur && shown) { shown = false; renderStrip(); if (panel) panel.hidden = true; return; }
        select(d);
      });
      strip.appendChild(b);
    }
  }

  function select(d) {
    cur = d;
    shown = true;
    renderStrip();
    const rec = byDate.get(d);
    const kinds = [];
    if (rec.premarket) kinds.push('premarket');
    if (rec.close) kinds.push('close');
    if (headDate) headDate.textContent = `${d} 周${WD[new Date(d + 'T00:00:00').getDay()]} · ${kinds.map((k) => (k === 'premarket' ? '盘前' : '收盘')).join(' + ')}`;
    if (bodyEl) {
      bodyEl.innerHTML = kinds
        .map((k) => {
          const e = rec[k];
          return `<div class="pushcard ${k}"><div class="pc-h">${k === 'premarket' ? '盘前' : '收盘'}推送<span>${e.title}</span></div><pre>${esc(e.body)}</pre></div>`;
        })
        .join('');
    }
    if (panel) panel.hidden = false;
    const el = chipOf(d);
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); } catch { /* 忽略 */ } }
  }

  const step = (k) => {
    const i = dates.indexOf(cur);
    const j = i + k;
    if (j >= 0 && j < dates.length) select(dates[j]);
  };
  const prev = document.getElementById('rPrev');
  const next = document.getElementById('rNext');
  if (prev) prev.addEventListener('click', () => step(-1));
  if (next) next.addEventListener('click', () => step(1));
  if (countEl) countEl.textContent = `${dates.length} 天`;

  // 键盘左右键也能翻
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  renderStrip();
  select(cur); // 默认展示最近一天
})();
