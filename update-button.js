// 右下角「更新」按钮：在手机上按一下 → 让主机跑一次日更 → 跑完自动刷新页面。
//
// 前提（很重要，所以要在界面上说清楚）：
//   这个按钮是**向当前页面的同源主机**发请求，所以只有从主机本身打开的页面才有效，
//   也就是 http://192.168.x.x:8848/ 这种局域网地址。
//   从 GitHub Pages（https://...）打开的页面请求不到家里的 http 主机 ——
//   既有混合内容拦截，不在家时也没有到那台主机的路由。
//   非局域网场景下按钮仍然显示，但点下去只会给出解释，不发请求。
(function () {
  const btn = document.getElementById('updBtn');
  const panel = document.getElementById('updPanel');
  if (!btn || !panel) return;

  const host = location.hostname;
  const isLan =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  const el = (id) => document.getElementById(id);
  const label = el('updLabel');
  const title = el('updTitle');
  const body = el('updBody');
  const log = el('updLog');

  let timer = null;
  let reloading = false;

  const fmtElapsed = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  function setState(kind, text) {
    btn.className = 'updbtn' + (kind ? ' ' + kind : '');
    label.textContent = text;
  }
  function show(html, logHtml) {
    panel.hidden = false;
    body.innerHTML = html;
    if (logHtml != null) log.innerHTML = logHtml;
  }

  function offLan() {
    setState('', '更新');
    show(
      '<div class="u-h">这个按钮只在局域网里有效</div>' +
        '它向<b>当前页面的主机</b>发请求。你现在打开的是 <code>' +
        esc(location.host) +
        '</code>，请求到不了运行日更的那台电脑。<br>' +
        '请在手机浏览器打开主机地址：<br><code>http://192.168.110.159:8848/</code><br>' +
        '<span class="u-dim">（需与电脑同一 Wi-Fi）</span>',
      '',
    );
  }

  async function getStatus() {
    const r = await fetch('/update-status', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function postUpdate() {
    const r = await fetch('/update', { method: 'POST', headers: { 'X-Astock-Update': '1' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  function renderLog(tail) {
    if (!tail?.length) return '';
    return tail.map(esc).join('\n');
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  async function poll() {
    stop();
    let s;
    try {
      s = await getStatus();
    } catch (e) {
      setState('err', '更新');
      show('<div class="u-h">取不到状态</div>' + esc(e.message), '');
      return;
    }
    const steps = s.stepsTotal
      ? ` · ${s.stepsDone}/${s.stepsTotal} 步${s.stepsFailed ? `（${s.stepsFailed} 步失败）` : ''}`
      : '';

    if (s.state === 'running') {
      setState('busy', `更新中 ${fmtElapsed(s.elapsedMs)}`);
      show(
        `<div class="u-h">正在更新（${fmtElapsed(s.elapsedMs)}${steps}）</div>` +
          esc(s.current || '已启动…') +
          '<br><span class="u-dim">跑完会自动刷新页面，不用管它。</span>',
        renderLog(s.tail),
      );
      timer = setTimeout(poll, 2000);
      return;
    }
    if (s.state === 'done') {
      setState('ok', '完成');
      show('<div class="u-h">更新完成</div>正在刷新页面…', renderLog(s.tail));
      if (!reloading) {
        reloading = true;
        setTimeout(() => location.reload(), 1200);
      }
      return;
    }
    if (s.state === 'busy-elsewhere') {
      setState('', '主机在忙');
      show(
        '<div class="u-h">主机上已经有一次日更在跑</div>' +
          '多半是每日 15:40 的自动更新正在执行。日更做了单实例保护，不会两个同时改数据。<br>' +
          '<span class="u-dim">等它跑完（通常 1~2 分钟）再按一次即可。</span>',
        renderLog(s.tail),
      );
      return;
    }
    if (s.state === 'failed') {
      setState('err', '更新失败');
      show(
        `<div class="u-h">更新失败${s.exitCode != null ? `（退出码 ${s.exitCode}）` : ''}</div>` +
          esc(s.error || s.current || '') +
          '<br><span class="u-dim">数据文件可能只更新了一部分，再点一次可以重试。</span>',
        renderLog(s.tail),
      );
      return;
    }
    // idle
    setState('', '更新');
    show(
      '<div class="u-h">数据更新</div>让主机抓取最新行情并重算看板，约 1~2 分钟。<br>' +
        '<span class="u-dim">按右下角按钮开始。日更每日 15:40 自动跑一次，这里是手动触发。</span>',
      '',
    );
  }

  async function start(force) {
    setState('busy', '启动中…');
    show('<div class="u-h">正在启动…</div>', '');
    try {
      const j = await postUpdate();
      if (!j.started) {
        // 已在跑 / 刚跑完，都直接进入轮询看真实状态
        console.log('[update]', j.reason);
      }
    } catch (e) {
      setState('err', '启动失败');
      show('<div class="u-h">没能启动</div>' + esc(e.message), '');
      return;
    }
    poll();
  }

  btn.addEventListener('click', async () => {
    if (!isLan) { offLan(); return; }
    let s = null;
    try { s = await getStatus(); } catch { /* 拿不到状态就按 idle 处理 */ }
    if (s?.state === 'running') { panel.hidden = false; poll(); return; }
    if (s?.tradingHours) {
      const go = confirm(
        '现在是 A 股交易时段（09:30-11:30 / 13:00-15:00）。\n' +
          '此时抓到的当日行情是不完整的（成交量、涨跌停家数都偏小），看板会出现半截数据。\n\n' +
          '确定要现在更新吗？',
      );
      if (!go) return;
    }
    start();
  });

  el('updClose')?.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = true; });

  // 打开页面时先看一次：可能上一次更新还在跑（比如刚刷新过）
  if (isLan) {
    poll().catch(() => {});
  } else {
    setState('', '更新');
  }
})();
