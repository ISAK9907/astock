// 执行记录（反馈闭环）。存本机 localStorage。
//
// 为什么这是整个工具里唯一可能真正影响行为的机制：
//   工具能做的事情只有两件 —— ① 让规则可见并带上日期；② 记录你有没有遵守。
//   第二件以前完全没做。没有它，工具不知道你做过什么，也就无法形成任何反馈回路；
//   你看到的永远只是一份「今天该怎样」的建议，看完关掉，没有任何东西留下来。
//
// 数据只在本机浏览器里（astock.exlog.v1）。仓库是公开的，一条记录都不会上行。
// ⚠️ 所以必须能导出 —— 换设备或清缓存会丢。
//
// 合规判定：记录时拿**当时**的规则状态去比。加仓只有在对应档位已触发时才算照规则；
// 否则记「规则未触发」并在统计里体现。工具不评价对错，只如实记录。
(function () {
  const KEY = 'astock.exlog.v1';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const save = (rows) => localStorage.setItem(KEY, JSON.stringify(rows));

  /** 按当前计划表判断某个动作是否照规则。 */
  function judge(target, action) {
    const A = window.PLAN?.action;
    const active = A?.active?.find((a) => a.name === target);
    if (!active) return { ok: null, why: '该标的不在计划表中，无法核对' };
    if (action === 'add') {
      return active.hitAdd > 0
        ? { ok: true, why: `第 ${active.tier} 档已触发` }
        : { ok: false, why: `加仓档未触发（最近一档 ${active.nextAdd ? `@${active.nextAdd.price}  还差 ${active.nextAdd.pct}%` : '无'}）` };
    }
    if (action === 'cut') {
      return active.hitCut > 0 ? { ok: true, why: `第 ${active.cutTier} 档已触发` } : { ok: false, why: '减仓档未触发' };
    }
    return { ok: true, why: '不操作 —— 与规则一致' };
  }

  function render() {
    const box = $('logBox');
    if (!box) return;
    const rows = load();
    const sel = $('logTarget');
    const act = $('logAction');
    const target = sel?.value ?? '';
    const action = act?.value ?? 'add';
    const j = target ? judge(target, action) : null;
    const hint = $('logJudge');
    if (hint) {
      hint.innerHTML = j
        ? `<span style="color:${j.ok === true ? '#2f9e6b' : j.ok === false ? '#e0803a' : 'var(--dim)'}">${j.ok === true ? '✓ 与规则一致' : j.ok === false ? '⚠️ 与规则不一致' : '—'}：${esc(j.why)}</span>`
        : '';
    }

    if (!rows.length) { box.innerHTML = '<div class="dim">还没有执行记录</div>'; return; }
    const followed = rows.filter((r) => r.judged === true).length;
    const broke = rows.filter((r) => r.judged === false).length;
    const acts = rows.filter((r) => r.action !== 'hold').length;
    box.innerHTML =
      `<div class="hstat"><span>共 <b>${rows.length}</b> 笔</span><span>动过 <b>${acts}</b> 次</span>` +
      `<span class="pos">照规则 <b>${followed}</b></span><span class="${broke ? 'neg' : ''}">未照规则 <b>${broke}</b></span>` +
      `<span>合规率 <b>${acts ? ((followed / Math.max(1, followed + broke)) * 100).toFixed(0) : '—'}%</b></span></div>` +
      `<div class="hrow hhead" style="grid-template-columns:74px 1fr 52px 62px 54px"><span>日期</span><span>标的 / 动作</span><span>价格</span><span>数量</span><span>合规</span></div>` +
      rows.slice().reverse().slice(0, 40)
        .map((r) => {
          const an = r.action === 'add' ? '加仓' : r.action === 'cut' ? '减仓' : '不动';
          const col = r.judged === true ? '#2f9e6b' : r.judged === false ? '#e0803a' : 'var(--dim)';
          const mark = r.judged === true ? '✓' : r.judged === false ? '⚠' : '—';
          return `<div class="hrow" style="grid-template-columns:74px 1fr 52px 62px 54px">` +
            `<span>${esc(r.at.slice(5, 10))}</span><span>${esc(r.target)} ${an}</span>` +
            `<span>${r.price ?? ''}</span><span>${r.qty ?? ''}</span>` +
            `<span style="color:${col}" title="${esc(r.why ?? '')}">${mark}</span></div>`;
        })
        .join('') +
      `<button class="hbtn" id="logExport" type="button">导出 JSON（换设备/清缓存前务必备份）</button>` +
      `<button class="hbtn" id="logClear" type="button">清空</button>`;

    const ex = $('logExport');
    if (ex) ex.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `astock-exlog-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    });
    const cl = $('logClear');
    if (cl) cl.addEventListener('click', () => { if (confirm('确定清空全部执行记录？建议先导出。')) { localStorage.removeItem(KEY); render(); } });
  }

  function wire() {
    // 标的下拉：用计划表里的标的
    const sel = $('logTarget');
    if (sel && window.PLAN) {
      sel.innerHTML = window.PLAN.indexes.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('');
    }
    const act = $('logAction');
    sel?.addEventListener('change', render);
    act?.addEventListener('change', render);
    $('logAdd')?.addEventListener('click', () => {
      const target = sel?.value ?? '';
      if (!target) return;
      const action = act?.value ?? 'add';
      const j = judge(target, action);
      const rows = load();
      rows.push({
        at: new Date().toISOString(),
        target,
        action,
        price: Number($('logPrice')?.value) || null,
        qty: Number($('logQty')?.value) || null,
        note: ($('logNote')?.value ?? '').slice(0, 60),
        judged: j.ok,
        why: j.why,
      });
      save(rows);
      if ($('logPrice')) $('logPrice').value = '';
      if ($('logQty')) $('logQty').value = '';
      if ($('logNote')) $('logNote').value = '';
      render();
    });
    render();
  }

  window.EXLOG = { load, save, judge, KEY };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
