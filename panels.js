// 面板工具条：每个面板右上角注入「说明」与「×」
//   「说明」→ 就地展开该面板自己的数据口径/已知偏差（内容来自 window.PDESC）
//   「×」   → 隐藏该面板，并用 localStorage 记住；右下角出现「已隐藏的面板」可逐个或全部恢复
(function () {
  const DESC = window.PDESC || {};
  const KEY = 'astock.hiddenPanels.v1';
  const panels = [...document.querySelectorAll('[data-panel]')];
  if (!panels.length) return;

  const readHidden = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  };
  let hidden = readHidden();

  const bar = document.getElementById('prestore');
  const list = document.getElementById('prestoreList');

  const titleOf = (el) => {
    const id = el.dataset.panel;
    if (DESC[id]?.title) return DESC[id].title;
    const h2 = el.querySelector('h2');
    return h2 ? h2.textContent.trim().slice(0, 18) : id;
  };

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(hidden)); } catch { /* 隐私模式等，忽略 */ } };

  function setHidden(p, v) {
    const id = p.dataset.panel;
    if (v) { if (!hidden.includes(id)) hidden.push(id); }
    else hidden = hidden.filter((x) => x !== id);
    p.style.display = v ? 'none' : '';
    save();
    renderBar();
  }

  function renderBar() {
    if (!bar || !list) return;
    const items = panels.filter((p) => hidden.includes(p.dataset.panel));
    bar.hidden = items.length === 0;
    list.textContent = '';
    for (const p of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '↺ ' + titleOf(p);
      b.addEventListener('click', () => setHidden(p, false));
      list.appendChild(b);
    }
    if (items.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'all';
      all.textContent = '全部恢复';
      all.addEventListener('click', () => { for (const p of panels) setHidden(p, false); });
      list.appendChild(all);
    }
  }

  for (const p of panels) {
    const id = p.dataset.panel;
    const d = DESC[id];

    // 找到头部；没有就把直属的 h2 包进一个 .phead
    let head = p.querySelector(':scope > .phead');
    if (!head) {
      let h2 = p.querySelector(':scope > h2');
      if (!h2) {
        h2 = document.createElement('h2');
        h2.textContent = d?.title || id;
        p.insertBefore(h2, p.firstChild);
      }
      head = document.createElement('div');
      head.className = 'phead';
      p.insertBefore(head, h2);
      head.appendChild(h2);
    }

    const tools = document.createElement('span');
    tools.className = 'ptools';

    if (d) {
      const box = document.createElement('div');
      box.className = 'pdesc';
      box.hidden = true;
      box.innerHTML = d.html;

      const help = document.createElement('button');
      help.type = 'button';
      help.className = 'pbtn';
      help.textContent = '说明';
      help.title = '查看本面板的数据口径与已知偏差';
      help.setAttribute('aria-expanded', 'false');
      help.addEventListener('click', () => {
        box.hidden = !box.hidden;
        help.classList.toggle('on', !box.hidden);
        help.setAttribute('aria-expanded', String(!box.hidden));
      });
      tools.appendChild(help);
      head.after(box);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pbtn';
    close.textContent = '×';
    close.title = '隐藏此面板';
    close.addEventListener('click', () => setHidden(p, true));
    tools.appendChild(close);

    head.appendChild(tools);
  }

  for (const p of panels) if (hidden.includes(p.dataset.panel)) p.style.display = 'none';
  renderBar();
})();
