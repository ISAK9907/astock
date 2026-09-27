// 全球因子对「现有信号」的增量：在 T日状态 × A股跳空 之外，全球背景还有用吗
import { readFileSync } from 'node:fs';
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const prevDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const G = JSON.parse(readFileSync('global-daily.json', 'utf8')).series;
// 缺品种时提前明确报错，避免后面读到 undefined 崩掉（详见 fetch-global.mjs 的说明）
{
  const REQUIRED = ['spx', 'kospi', 'nikkei', 'twii', 'a50'];
  const absent = REQUIRED.filter((k) => !G[k]);
  if (absent.length) {
    console.error(`✗ global-daily.json 缺少必需品种：${absent.join(', ')}（当前只有 ${Object.keys(G).join(', ') || '空'}）`);
    console.error('  等东财 kline 解封后重跑 fetch-global.mjs。');
    process.exit(2);
  }
}
const D = JSON.parse(readFileSync('daily-long.json', 'utf8')).series;
const TODAY = localToday();
const pct = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const idx = {}; for (const [k, v] of Object.entries(G)) idx[k] = v.bars.map((b) => b.d);
const onOrBefore = (k, iso) => { const i = idx[k].findLastIndex((d) => d <= iso); return i >= 0 ? G[k].bars[i] : null; };
const retAt = (k, iso) => { const i = idx[k].lastIndexOf(iso); return i >= 1 ? (G[k].bars[i].c / G[k].bars[i - 1].c - 1) * 100 : null; };
const gapAt = (k, iso) => { const i = idx[k].lastIndexOf(iso); if (i < 1) return null; return (G[k].bars[i].o / G[k].bars[i - 1].c - 1) * 100; };

const sh = D.sh.bars.filter((b) => b.d < TODAY);
const rows = [];
for (let i = 2; i < sh.length; i++) {
  const a = sh[i], t = sh[i - 1], tl = sh[i - 2];
  const A = a.d, A1 = prevDay(A);
  const r = {
    A, retT: (t.c / tl.c - 1) * 100,
    gap: (a.o / t.c - 1) * 100, intraday: (a.c / a.o - 1) * 100, sellOpen: ((a.o - a.c) / a.o) * 100, day: (a.c / t.c - 1) * 100,
    spx: retAt('spx', onOrBefore('spx', A1)?.d),
    gold: retAt('gold', onOrBefore('gold', A)?.d),
    kgap: gapAt('kospi', A), ngap: gapAt('nikkei', A), tgap: gapAt('twii', A),
  };
  const v = [r.kgap, r.ngap, r.tgap].filter((x) => x != null && isFinite(x));
  r.asia = v.length === 3 ? v.reduce((x, y) => x + y, 0) / 3 : null;
  rows.push(r);
}
const ok = rows.filter((r) => isFinite(r.gap) && r.spx != null);

const weak = (r) => r.retT <= -0.5, strong = (r) => r.retT >= 1.0;
const cell = (nm, s) => {
  if (s.length < 20) { console.log(`  ${nm.padEnd(38)} n=${s.length} 样本少`); return; }
  console.log(
    `  ${nm.padEnd(38)} n=${String(s.length).padStart(4)}  日内 ${pct(mean(s.map((r) => r.intraday))).padStart(8)}  ` +
      `减仓(扣0.12%) ${pct(mean(s.map((r) => r.sellOpen)) - 0.12).padStart(8)}  全天 ${pct(mean(s.map((r) => r.day))).padStart(8)}`,
  );
};

console.log('=== 现有信号的可执行格子内部，再按全球背景分层 ===');
console.log('\n【弱(T跌≤-0.5%) + A股高开>1%】基准是「偏减仓」');
const base = ok.filter((r) => weak(r) && r.gap > 1);
cell('  基准（全部）', base);
cell('  + 美股隔夜跌', base.filter((r) => r.spx < 0));
cell('  + 美股隔夜涨', base.filter((r) => r.spx >= 0));
cell('  + 美股跌>1%', base.filter((r) => r.spx < -1));
cell('  + 美股涨>1%', base.filter((r) => r.spx > 1));
cell('  + 亚洲早盘弱', base.filter((r) => r.asia != null && r.asia < 0));
cell('  + 亚洲早盘强', base.filter((r) => r.asia != null && r.asia >= 0));

console.log('\n【强(T涨≥1%) + A股高开>1%】基准是「持有别减」');
const b2 = ok.filter((r) => strong(r) && r.gap > 1);
cell('  基准（全部）', b2);
cell('  + 美股隔夜涨', b2.filter((r) => r.spx >= 0));
cell('  + 美股隔夜跌', b2.filter((r) => r.spx < 0));
cell('  + 黄金隔夜涨', b2.filter((r) => r.gold != null && r.gold >= 0));
cell('  + 黄金隔夜跌', b2.filter((r) => r.gold != null && r.gold < 0));

console.log('\n=== 「美股大跌」单独作为预警（不依赖当日竞价）===');
for (const [nm, p] of [
  ['美股跌≤-2%', (r) => r.spx <= -2], ['美股跌≤-3%', (r) => r.spx <= -3], ['美股涨≥+2%', (r) => r.spx >= 2],
]) {
  const s = ok.filter(p);
  if (s.length < 15) { console.log(`  ${nm.padEnd(14)} n=${s.length} 样本少`); continue; }
  console.log(
    `  ${nm.padEnd(14)} n=${String(s.length).padStart(3)}  A股跳空 ${pct(mean(s.map((r) => r.gap))).padStart(8)}  ` +
      `其中低开>1% 占比 ${(s.filter((r) => r.gap < -1).length / s.length * 100).toFixed(0).padStart(3)}%  ` +
      `A股日内 ${pct(mean(s.map((r) => r.intraday))).padStart(8)}  A股全天 ${pct(mean(s.map((r) => r.day))).padStart(8)}`,
  );
}

console.log('\n=== 顺带确认：韩国/日经「当日开盘」能提前多久知道 ===');
console.log('  韩国 09:00 KST = 北京 08:00，日经 09:00 JST = 北京 08:00（夏令时）');
console.log('  A 股集合竞价 09:15~09:25 → 亚洲早盘比 A 股竞价早 1 小时以上，可用');
console.log('  美股收盘 04:00/05:00（北京）→ 更早，可用');
