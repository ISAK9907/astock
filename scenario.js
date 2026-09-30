// 「开盘跳空 · 历史情景参考」面板
//
// 数据来自 analyze-open-scenario.mjs 写的 open-scenario.json（16 年 × 4 指数）。
// 自变量是「跳空 ÷ 20日波动率」(z)，不是绝对跳空幅度 —— 因为 +2% 在低波环境是极端事件、
// 在高波环境只是噪音；实测绝对跳空各档的日内回落率都贴着基准，换成 z 才显出单调关系。
//
// 界面上必须同时露出三样东西，否则这张表会误导人：
//   样本量（极端档只有个位数）、显著性（二项检验 p 值）、分段稳健性（前/后 8 年方向是否一致）
(function () {
  const host = document.getElementById('scenTable');
  const tabs = document.getElementById('scenTabs');
  const S = window.SCENARIO;
  if (!host || !S) return;

  const keys = Object.keys(S.indices);
  let cur = keys.includes('sh') ? 'sh' : keys[0];

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const pct = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);

  function chips() {
    tabs.innerHTML = keys
      .map((k) => `<button class="pbtn${k === cur ? ' on' : ''}" data-k="${k}" type="button">${esc(S.indices[k].name)}</button>`)
      .join('');
    for (const b of tabs.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        cur = b.dataset.k;
        chips();
        table();
      });
    }
  }

  // 偏离基准越多 → 越暖（回落风险高）；低于基准 → 偏冷（日内偏强）
  const fadeColor = (fade, base) => {
    const d = fade - base;
    if (d >= 20) return '#ef4d5a';
    if (d >= 8) return '#ff7a86';
    if (d <= -8) return '#43d19a';
    return 'var(--dim)';
  };

  function table() {
    const v = S.indices[cur];
    const base = v.base.fade;
    const rows = v.buckets
      .map((b) => {
        if (!b.n) {
          return `<tr><td>${esc(b.label)}</td><td>0</td><td colspan="3" style="color:var(--dim)">样本过少</td></tr>`;
        }
        const badge = [];
        if (b.sig) badge.push(b.pVsBase < 0.01 ? '<b style="color:#ef4d5a">显著**</b>' : '<b style="color:#ff7a86">显著*</b>');
        if (b.stable) badge.push('<span style="color:#43d19a">稳健</span>');
        const mark = badge.length ? badge.join(' ') : '<span style="color:var(--dim)">—</span>';
        // 「实际平均跳空」放进档位标签而不是单独一列：窄屏放不下 6 列，
        // 而这一列正是「到底高开多少」的具体锚点，不能藏。
        return (
          `<tr><td>${esc(b.label)}<div class="tiny" style="color:var(--dim)">≈${pct(b.meanGap, 2)}</div></td>` +
          `<td>${b.n}</td>` +
          `<td style="color:${fadeColor(b.fade, base)};font-weight:600">${b.fade}%</td>` +
          `<td style="color:${b.meanIntra >= 0 ? '#ff7a86' : '#43d19a'}">${pct(b.meanIntra, 3)}</td>` +
          `<td>${mark}</td></tr>`
        );
      })
      .join('');

    host.innerHTML =
      `<table class="stbl scen"><tr><th>跳空÷σ20</th><th>样本</th><th>日内回落</th><th>平均日内</th><th>判定</th></tr>${rows}</table>` +
      `<div class="tiny" style="margin-top:5px">` +
      `档位下方的 <b>≈</b> 是该档的<b>实际平均跳空幅度</b>（σ20 归一化后的档位，落回绝对跳空看）。` +
      `<b>日内回落</b> = 收盘 &lt; 开盘（即「高开低走」）的比例。` +
      `<b>基准 ${base}%</b> 是 ${esc(v.name)} 全样本（${v.base.n} 天）的日内回落率 —— 只有明显偏离它才有意义。<br>` +
      `判定：<b>显著</b> = 与基准的二项检验 p&lt;0.05（<b>**</b> 为 p&lt;0.01）；<b>稳健</b> = 以 ${v.splitAt} 分界的前后两段方向一致。` +
      `<span style="color:var(--dim)">样本 &lt; 20 的档位请只当个案看。</span></div>`;
  }

  const ext = document.getElementById('scenExt');
  if (ext && S.extremeDays?.length) {
    ext.innerHTML =
      `<table class="stbl scen"><tr><th>日期</th><th>上证跳空</th><th>日内</th><th>全天</th><th>命中</th></tr>` +
      S.extremeDays
        .map(
          (g) =>
            `<tr><td>${esc(g.d.slice(2))}</td>` +
            `<td class="up">${pct(g.gap, 2)}</td>` +
            `<td style="color:${g.intra >= 0 ? '#ff7a86' : '#43d19a'};font-weight:600">${pct(g.intra, 2)}</td>` +
            `<td style="color:${g.full >= 0 ? '#ff7a86' : '#43d19a'}">${pct(g.full, 2)}</td>` +
            `<td>${g.n}/4</td></tr>`,
        )
        .join('') +
      `</table>`;
  }

  chips();
  table();
})();
