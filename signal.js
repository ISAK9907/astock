// 盘前信号：开盘后从同源 /signal 拉取实时集合竞价跳空，更新卡片
// （用 file:// 直接打开时无法获取，会退化为静态条件清单）
(function () {
  const box = document.getElementById('sigDecision');
  if (!box) return;
  const stamp = document.getElementById('sigStamp');
  const foot = document.getElementById('sigFoot');
  const ACT = {
    cut: { label: '偏减仓', color: '#43d19a' },
    hold: { label: '持有别减', color: '#ff7a86' },
    buy: { label: '偏持有', color: '#5b8def' },
    watch: { label: '观望', color: '#7b8698' },
  };
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  function render(d) {
    if (!d || !Array.isArray(d.indices) || !d.indices.length) throw new Error('返回为空');
    // ---- 全球背景 + 跳空预判 ----
    const G = d.global && !d.global.error ? d.global : null;
    let globe = '';
    if (G) {
      const q = G.quotes || {}, f = G.forecast || {};
      const chip = (label, o) => {
        if (!o || o.chg == null) return '';
        const c = o.chg >= 0 ? '#ef4d5a' : '#3fa66b';
        return `<span class="gchip"><b>${label}</b><i style="color:${c}">${o.chg >= 0 ? '+' : ''}${o.chg.toFixed(2)}%</i><em>${o.asOf ? o.asOf.slice(5, 16) : ''}</em></span>`;
      };
      const asiaChip = (label, o) => {
        if (!o || !o.open || !o.prevClose) return '';
        const g = (o.open / o.prevClose - 1) * 100;
        // 只有「今天」的行情才算早盘；日韩台假期与大陆不同，否则会把几天前的旧开盘当成今日
        // （不能用 toISOString()——它转 UTC，UTC+8 下会错判一天）
        const stale = o.date !== localToday();
        const c = g >= 0 ? '#ef4d5a' : '#3fa66b';
        return `<span class="gchip"><b>${label}开盘</b><i style="color:${stale ? '#7b8698' : c}">${stale ? '未开盘' : (g >= 0 ? '+' : '') + g.toFixed(2) + '%'}</i><em>${o.asOf ? o.asOf.slice(5, 16) : ''}</em></span>`;
      };
      globe =
        `<div class="sect" style="margin-top:9px">全球背景 · 跳空预判</div>` +
        `<div class="globe">${chip('美股', q.spx)}${asiaChip('韩', q.kospi)}${asiaChip('日', q.nikkei)}${asiaChip('台', q.twii)}${chip('黄金', q.gold)}</div>` +
        (f.predicted != null
          ? `<div class="sigdet">预判今日 A 股跳空 <b style="color:${f.predicted >= 0 ? '#ef4d5a' : '#3fa66b'}">${f.predicted >= 0 ? '+' : ''}${f.predicted.toFixed(2)}%</b>（依据：${f.basis}${f.asia != null ? `，亚洲早盘均值 ${f.asia >= 0 ? '+' : ''}${f.asia.toFixed(2)}%` : ''}）</div>`
          : '');
      if (f.ref) globe += `<div class="sigdet">${f.ref}</div>`;
    }
    const rows = d.indices
      .map((x) => {
        const a = ACT[x.decision.action.key] || ACT.watch;
        const gapTxt = x.gap == null ? '无竞价数据' : `${x.gap >= 0 ? '+' : ''}${x.gap.toFixed(2)}%`;
        return (
          `<div><span class="sigact" style="background:${a.color}22;color:${a.color}">${a.label}</span>` +
          `<b>${x.name}</b> 竞价 ${gapTxt}` +
          (x.decision.expect == null ? '' : ` · 历史期望 <b>${x.decision.expect >= 0 ? '+' : ''}${x.decision.expect.toFixed(2)}%</b>（n=${x.decision.n}，${x.decision.era}）`) +
          `</div><div class="sigdet">${x.decision.why}</div>`
        );
      })
      .join('');
    box.className = 'sigbox';
    box.innerHTML = globe + rows;
    const st = d.status || (d.stale ? 'stale' : 'live');
    let t;
    if (st === 'preopen') t = `T 日 = ${d.T} · 行情 ${d.asOf} · 尚无次日竞价数据（开盘后自动更新）`;
    else if (st === 'stale') t = `⚠️ 状态文件与行情不匹配 —— 可能日更未跑，仅供参考`;
    else t = `T 日 = ${d.T} · 行情时间 ${d.asOf} · 每 60 秒刷新`;
    if (stamp) stamp.textContent = t;
    if (foot) {
      foot.innerHTML =
        `核心是<b>交互效应</b>：跳空本身几乎没信息（低开→高开跨度仅 −0.11%），叠加 T 日状态后：<b>弱市高开 −0.95%，强市高开 +0.97%</b>。` +
        `期望值均未扣成本（往返约 0.12%）；单指数约 1.5~3 次/年。<b>仅指数层面统计，不构成投资建议。</b>`;
    }
  }

  function blank(msg) {
    box.className = 'sigbox blank';
    box.textContent = msg;
  }

  async function load() {
    try {
      // 本机跑 serve-dashboard.mjs 时走同源 /signal；在 GitHub Pages 上没有这个接口，
      // 回落到 Cloudflare Worker（地址由 build-dashboard.mjs 从 worker-url.txt 注入）。
      const base = window.SIGNAL_URL || '';
      const r = await fetch(`${base}/signal`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      render(d);
    } catch (e) {
      // 区分「本机服务没跑」和「静态托管（GitHub Pages 等）下本来就没有这个接口」
      const host = location.hostname || '';
      const isLocal = !host || /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
      blank(
        isLocal
          ? `实时竞价不可用（${e.message}）—— 请确认本机看板服务在运行（node serve-dashboard.mjs），或直接看右侧条件清单。`
          : `实时竞价需要本机服务，静态托管下不可用（${e.message}）。左侧 T 日状态与右侧条件清单仍然有效。`,
      );
      if (stamp) stamp.textContent = isLocal ? '' : '静态快照';
    }
  }

  load();
  setInterval(load, 60000);
})();
