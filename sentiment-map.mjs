// 恐慌评分映射：绝对严重度分 score → 0~100 情绪分 sent，以及档位定义。
// 被 analyze-dt.mjs 与 sentiment-backtest.mjs 共用，确保两边算出来的 sent 逐位一致
// （此前两处各写一份公式，改动时极易漂移）。
//
//   score = max(跌停家数/60, 跌停市值占比%/1.0, 权重股跌停数/12)   —— 绝对强度，无上界
//   sent  = 把 score 在窗口内的名次换算成经验分位 p，再过标准正态分位 Φ⁻¹，
//           按 N(50,15²) 映射：sent = 50 + 15·Φ⁻¹(p)，并列值按日期顺序展开
//
// 为什么档位挂在 sent 而不是 score：
//   score 无上界且重尾。实测三年窗口里最惨的一天（2025-04-07，2815 家跌停、市值占比 33.4%）
//   score = 46.92，而写死的橙档门槛是 3.0 —— 同一个橙色里塞进了相差 15.6 倍的事件。
//   sent 是排名映射，天然有界（0~100），且与面板上的刻度条是同一个量纲。
export const NORM = { dt: 60, cap: 1.0, mem: 12 };

export const scoreOf = (v) =>
  Math.max(v.dt / NORM.dt, (v.allCap ? (v.dtCap / v.allCap) * 100 : 0) / NORM.cap, v.mem / NORM.mem);

/** Acklam 逆正态近似，相对误差 < 1.15e-9 */
export function normInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -38;
  if (p >= 1) return 38;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** 传入按日期升序的 score 数组，返回同顺序的 sent 数组 */
export function makeSentOf(scores) {
  const order = scores
    .map((v, i) => [v, i])
    .filter(([v]) => isFinite(v))
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]); // 并列按日期顺序展开，否则同分日会挤成一个读数
  const N = order.length;
  const out = new Array(scores.length).fill(50);
  if (!N) return out;
  for (let k = 0; k < N; k++) {
    const p = Math.min(Math.max((k + 0.5) / N, 1e-4), 1 - 1e-4);
    out[order[k][1]] = Math.min(100, Math.max(0, 50 + 15 * normInv(p)));
  }
  return out;
}

/** 由「日期 → 原始计数」得到「日期 → {score, sent}」，窗口取最后 window 天（window<=0 表示全部） */
export function buildSeries(counts, window = 0) {
  let dates = Object.keys(counts).sort();
  if (window > 0 && dates.length > window) dates = dates.slice(-window);
  const sc = dates.map((d) => scoreOf(counts[d]));
  const sent = makeSentOf(sc);
  const map = new Map();
  dates.forEach((d, i) => map.set(d, { d, score: +sc[i].toFixed(2), sent: +sent[i].toFixed(1) }));
  return { dates, map };
}

// ---------------------------------------------------------------------------
// 档位：按情绪分（本质是分位）切三档，对应窗口内最严重的 5% / 3% / 1%。
// 用 Φ⁻¹ 反推固定阈值，所以**与窗口长度无关**，样本从 300 天拉到 3 年也不用重标：
//   前 5% → Φ⁻¹(0.95) = 1.6449 → sent = 50 + 15×1.6449 = 74.7
//   前 3% → Φ⁻¹(0.97) = 1.8808 → sent = 78.2
//   前 1% → Φ⁻¹(0.99) = 2.3263 → sent = 84.9
// 之前用写死的 score（1.25 / 2 / 3），在短窗口里勉强能用，但样本一长就被极端事件撑爆。
// ---------------------------------------------------------------------------
export const TIER_PCT = [
  { name: '粉', label: '警觉', pct: 0.05, sentLo: 74.7, color: '#ec4899' },
  { name: '紫', label: '强恐慌', pct: 0.03, sentLo: 78.2, color: '#a855f7' },
  { name: '橙', label: '极端', pct: 0.01, sentLo: 84.9, color: '#f59e0b' },
];

/** 生成带上下界的档位（与 TIER_PCT 同序：由宽到严） */
export function tiers() {
  return TIER_PCT.map((t, i) => ({
    ...t,
    sentHi: i + 1 < TIER_PCT.length ? TIER_PCT[i + 1].sentLo : Infinity,
  }));
}

// ---------------------------------------------------------------------------
// 乐观侧镜像档位：乐观指数 = 100 − 情绪分。
//   高斯性自动继承 —— sent ~ N(50,15²) 是构造出来的（50 + 15·Φ⁻¹(p)），
//   关于 50 镜像后仍是 N(50,15²)，均值/标准差/偏度/峰度逐项相同，不需要重新拟合。
//   ⚠️ 门槛与恐慌侧**同一组数字**（74.7 / 78.2 / 84.9），因为两者在同一个 0~100 刻度上：
//     「最乐观的前 5%」= 乐观指数 ≥ 74.7 ⟺ 情绪分 ≤ 25.3。
//   一开始写成「门槛 = 100 − sentLo = 25.3」，方向搞反了 —— 那样最宽的一档会把 95% 的点
//   全吞进去（乐观指数 ≥ 25.3 覆盖了绝大多数日子），等于没分档。
//   配色用冷色系（青/碧/绿）与恐慌侧（粉/紫/橙）对称：两侧同一分位、不同色相，
//   避免"极度乐观"和"极度恐慌"撞色。
// ---------------------------------------------------------------------------
export const TIER_PCT_OPT = [
  { name: '青', label: '回暖', color: '#22d3ee' },
  { name: '碧', label: '乐观', color: '#2dd4bf' },
  { name: '绿', label: '强乐观', color: '#22c55e' },
];

/** 乐观侧档位（与 tiers() 同序：由宽到严），门槛与恐慌侧同值（同一刻度上的前 5%/3%/1%） */
export function tiersOpt() {
  return TIER_PCT.map((t, i) => ({
    name: TIER_PCT_OPT[i].name,
    label: TIER_PCT_OPT[i].label,
    color: TIER_PCT_OPT[i].color,
    pct: t.pct,
    minOptimism: t.sentLo,
    // 等价写法（情绪分侧），便于核对与展示
    maxSent: +(100 - t.sentLo).toFixed(1),
  }));
}
